/**
 * quoter.mjs — ExactQuoter: pre-fetch every account a quote needs, then price from memory.
 *
 * Seven Solana venues, priced to the exact integer the program would produce:
 * Meteora DLMM, Meteora DAMM v2, Raydium CLMM, Raydium CP, Raydium v4, Orca
 * Whirlpool and PumpSwap. See docs/VALIDATION.md for the chain comparisons.
 *
 * WHY PRE-FETCH
 * -------------
 * The math takes microseconds; the network does not. A quote that fetches its
 * own pool, then its config, then its tick or bin arrays costs three sequential
 * round trips per pool (measured ~1.3-1.8 s). So fetching is amortised instead.
 * One batched `getMultipleAccountsInfo` covers 100 accounts, so N
 * pools cost the same 1-2 round trips as one pool. Pricing afterwards is pure
 * synchronous computation over buffers already in memory:
 *
 *     refresh()   2 round trips, independent of pool count
 *     quote()     microseconds, ZERO network
 *
 * Two phases because tick and bin array addresses depend on the pool's CURRENT
 * tick/bin, which is only known after the pool account is read:
 *
 *     phase A   pools + static aux (amm_config, vaults) + last cycle's arrays
 *     phase B   only arrays whose address changed since last cycle
 *
 * In steady state the active tick rarely leaves the loaded window, so phase B is
 * usually empty and a refresh costs ONE round trip.
 *
 * A quote whose accounts are missing or stale returns {ok:false} rather than
 * guessing. Every silent fallback in this project has eventually manufactured a
 * fake edge.
 */
import { PublicKey } from '@solana/web3.js';
import { decodePool, decodeTickArray, tickArrayAddress, arrayStartIndex,
  toSwapState } from '../dist/clmm-pool.js';
import { swapExactIn as clmmSwap, isSwapError } from '../dist/clmm-math.js';
import { decodeLbPair, decodeBinArray, binArrayIndexOf, binArrayAddress,
  BINS_PER_ARRAY } from './dlmm-binarray.mjs';
import { decodeParams, totalFeeRate, decayedReferences } from './dlmm-fee.mjs';
import { swapExactIn as dlmmSwap } from './dlmm-swap.mjs';
import { cpExactIn, cpCreatorTerms, cpExactInCreator, VENUE_BY_OWNER, WSOL } from './cp.mjs';
import { decodePumpPool, decodeRawMint, quotePump } from './pump-quote.mjs';
import { decodeDamm2, damm2Live, quoteDamm2 } from './damm2-local.mjs';
import { decodeDynamicTickArray, isDynamicTickArray, isFixedTickArray } from './whirlpool-dynamic-ticks.mjs';
import { tickArrayAddr58, whirlOracleAddr58 } from './pda-cache.mjs';

export { WSOL };

/** How far around the active tick/bin to keep loaded. */
const TICK_RADIUS = 3;
const BIN_SPREAD = 140;

/**
 * WHIRLPOOL HAS TWO TICK-ARRAY LAYOUTS, AND WE DECODE ONE.
 *
 * Measured 2026-09-15 on the 7 arrays around
 * the current tick of 37 harvested Whirlpools: 109 fixed TickArray accounts
 * (9,988 B, discriminator 4561bdbe6e0742bb), 113 DynamicTickArray accounts
 * (148-9,892 B, 11d8f68ee1c7da38), 37 uninitialised. decodeTickArray reads the
 * FIXED layout only: handed a dynamic array it reads ticks from the wrong
 * offsets, and invented ticks invent depth. A dynamic array is therefore
 * refused wherever the executable window needs it, and never decoded.
 */
const isOrcaFixedTickArray = (td) => isFixedTickArray(td);
/**
 * Both layouts are now decoded — the dynamic one by whirlpool-dynamic-ticks.mjs,
 * which validates itself against its own bitmap and account size and THROWS
 * rather than return ticks it is not sure of. An array of neither shape is still
 * refused: pricing bytes we do not understand is how invented depth happens.
 */
const isOrcaKnownTickArray = (td) => isFixedTickArray(td) || isDynamicTickArray(td);

/**
 * RAYDIUM CLMM'S DYNAMIC FEE, AND THE TWO FIELDS WE READ AT THE WRONG PLACE.
 *
 * The program charges `base_fee_rate + dynamic_fee_rate` where the dynamic part is
 * quadratic in a volatility accumulator. Pricing with the base rate alone
 * UNDERCHARGES, and undercharging invents edges: measured -6.23 bps at every size
 * on tqeNC7AN, on state re-read immediately before each simulation.
 *
 * PoolState offsets verified by summing the struct in raydium-clmm states/pool.rs —
 * the fields total exactly the 1,544-byte account:
 *   tick_spacing u16 @235   status u8 @389   fee_on u8 @390   dynamic_fee_info @1096
 * (our `status` check used to read byte 285, which lands inside fee_growth_global_0.)
 *
 * DynamicFeeInfo @1096: filter u16 | decay u16 | reduction u16 | control u32 |
 *   maxVolatilityAccumulator u32 | tickSpacingIndexReference i32 |
 *   volatilityReference u32 | volatilityAccumulator u32 | lastUpdateTimestamp u64
 *
 * update_reference decays the reference by wall-clock time before the swap, exactly
 * as Meteora DLMM does, so it is applied here where the clock lives.
 */
const CLMM_STATUS = 389, CLMM_FEE_ON = 390, CLMM_DYN = 1096;
function clmmDynamicFee(d, tickSpacing, tickCurrent, nowSec, enabled) {
  if (d.length < CLMM_DYN + 34) return { fee: null };
  /**
   * fee_on: 0 = FromInput (what our math models). 1 or 2 take the fee from token0
   * or token1 ONLY, which changes which side of the swap shrinks — refuse rather
   * than price a shape we do not implement.
   */
  if (d[CLMM_FEE_ON] !== 0) return { refuse: 'CLMM fee_on ' + d[CLMM_FEE_ON] + ' (fee not taken from input) — not modelled' };
  const o = CLMM_DYN;
  const control = d.readUInt32LE(o + 6);
  if (control === 0) return { fee: null };                     // dynamic fee disabled
  /* dynamicFees: false prices base-only, so an A/B against the chain can be run on ONE state. */
  if (!enabled) return { fee: null };
  const filterPeriod = d.readUInt16LE(o), decayPeriod = d.readUInt16LE(o + 2);
  const reductionFactor = d.readUInt16LE(o + 4);
  const maxVolatilityAccumulator = d.readUInt32LE(o + 10);
  let indexReference = d.readInt32LE(o + 14);
  let volatilityReference = d.readUInt32LE(o + 18);
  const volatilityAccumulator = d.readUInt32LE(o + 22);
  const lastUpdate = Number(d.readBigUInt64LE(o + 26));
  const spacingIndex = (tickCurrent % tickSpacing === 0 || tickCurrent >= 0)
    ? Math.trunc(tickCurrent / tickSpacing) : Math.trunc(tickCurrent / tickSpacing) - 1;
  const elapsed = nowSec - lastUpdate;
  if (elapsed >= filterPeriod) {
    indexReference = spacingIndex;
    volatilityReference = elapsed < decayPeriod
      ? Math.floor(volatilityAccumulator * reductionFactor / 10000)
      : 0;
  }
  /* The accumulator is DERIVED from the references, never the stored field — see clmm-math.ts. */
  return { fee: { control, volatilityReference, indexReference, maxVolatilityAccumulator, groupSize: tickSpacing } };
}

/**
 * ORCA WHIRLPOOL ADAPTIVE FEE — the same bug class, on half of our Whirlpools.
 *
 * 18 of 37 harvested Whirlpools have an oracle PDA ["oracle", whirlpool] carrying an
 * adaptive fee. The program charges static fee_rate + compute_adaptive_fee_rate
 * (orca-so/whirlpools manager/fee_rate_manager.rs), which is exactly Raydium's
 * formula with tick_group_size in place of tick_spacing — Raydium copied it.
 *
 * Oracle (repr(C, packed), 254 B, state/oracle.rs):
 *   whirlpool @8 | trade_enable_timestamp u64 @40
 *   constants @48: filter u16 | decay u16 | reduction u16 | control u32 @54 |
 *                  maxVolatilityAccumulator u32 @58 | tickGroupSize u16 @62 | majorSwapThreshold u16 @64
 *   variables @82: lastReferenceUpdate u64 | lastMajorSwap u64 @90 | volatilityReference u32 @98 |
 *                  tickGroupIndexReference i32 @102 | volatilityAccumulator u32 @106
 *
 * update_reference differs from Raydium's in two ways, both followed here: a
 * reference older than MAX_REFERENCE_AGE (3,600 s) resets to zero, and filter/decay
 * are timed from the LATER of the last reference update and the last major swap.
 *
 * FAIL CLOSED: an oracle neither loaded nor confirmed absent means the fee is
 * unknown, and an unknown fee priced as zero is how edges get invented.
 */
function whirlAdaptiveFee(cache, addr, tickCurrent) {
  const oa = whirlOracleAddr58(addr);
  const od = cache.data.get(oa);
  if (!od) return cache.missing.has(oa) ? { fee: null }
    : { refuse: 'whirlpool oracle not loaded — adaptive fee unknown' };
  /* The program treats the pool as adaptive only if this is a real Oracle account (254 B).
     An address holding NO data (seen live: lamports sent to the PDA) is not an oracle, and
     the pool charges its static fee — so that is static, not unreadable. */
  if (od.length === 0) return { fee: null };
  if (od.length !== 254) return { refuse: 'whirlpool oracle unreadable (' + od.length + ' B)' };
  const now = cache.nowSec();
  const tradeEnable = Number(od.readBigUInt64LE(40));
  if (tradeEnable && now < tradeEnable) return { refuse: 'whirlpool trading not enabled until ' + tradeEnable };
  /* dynamicFees: false prices static-only, for an A/B against the chain on ONE state. */
  if (!cache.opts.dynamicFees) return { fee: null };
  const filter = od.readUInt16LE(48), decay = od.readUInt16LE(50), reduction = od.readUInt16LE(52);
  const control = od.readUInt32LE(54), maxVa = od.readUInt32LE(58), group = od.readUInt16LE(62);
  if (!control || !group) return { fee: null };
  const lastRef = Number(od.readBigUInt64LE(82)), lastMajor = Number(od.readBigUInt64LE(90));
  let vref = od.readUInt32LE(98), iref = od.readInt32LE(102);
  const va = od.readUInt32LE(106);
  const groupIndex = Math.floor(tickCurrent / group);            // floor_division
  const latest = Math.max(lastRef, lastMajor);
  if (now >= latest) {                                             // the program rejects now < latest outright
    if (now - lastRef > 3600) { iref = groupIndex; vref = 0; }
    else {
      const elapsed = now - latest;
      if (elapsed >= filter) {
        iref = groupIndex;
        vref = elapsed < decay ? Math.floor(va * reduction / 10000) : 0;
      }
    }
  }
  return { fee: { control, volatilityReference: vref, indexReference: iref,
    maxVolatilityAccumulator: maxVa, groupSize: group } };
}

const RESERVE_LAYOUT = {
  'Raydium CP': { v0: 72, v1: 104, m0: 168, m1: 200,
    pf0: 341, pf1: 349, ff0: 357, ff1: 365, cfg: 8, cfgFeeOff: 12 },
  /**
   * Raydium v4 (AmmInfo, 752B) — the original OpenBook-linked AMM, and the
   * third most common venue among landed arbs we could not price.
   *
   * Offsets VERIFIED on the live SOL/USDC pool 58oQChx4:
   * both vaults genuinely hold the two mints decoded here, and reserves net of
   * needTakePnl imply spot. That second check matters because this AMM can park
   * funds in an OpenBook open-orders account that vault balances cannot see;
   * a price on spot says it does not, materially.
   *
   * needTakePnl is owed OUT of the vaults, so it rides the same pf subtraction
   * as Raydium CP's fees. There is no second (ff) component, and the fee is per
   * pool at 176/184 rather than in a shared config.
   */
  'Raydium v4': { v0: 336, v1: 368, m0: 400, m1: 432,
    pf0: 192, pf1: 200, feeNumOff: 176, feeDenOff: 184 },
  /**
   * PumpSwap no longer goes through the constant-product path at all.
   *
   * Its fee is market-cap tiered (0.30% to 2.27% measured) and some pools carry
   * VIRTUAL quote reserves the vault balance does not show — one such pool made
   * a generic CP quote overstate the output by 3.31x. Both are handled by the
   * protocol's own math in pump-quote.mjs, which needs the base MINT as well as
   * the two vaults, so this entry only says which accounts to load.
   */
  'Pump.fun Amm': { v0: 139, v1: 171, m0: 43, m1: 75, needsBaseMint: true },
};
/**
 * Expected POOL account size per venue.
 *
 * Owning program is NOT enough to identify a pool: these programs also own
 * amm_configs (117B), tick/bin arrays (10136/10240B), oracles and observation
 * accounts. Registering an arbitrary venue-owned account and then decoding it
 * as a pool read offset 235 of a 115-byte config and threw ERR_OUT_OF_RANGE,
 * killing the whole refresh. Size is the same discriminator the enumeration
 * already relies on.
 */
const POOL_SIZE = { 'Meteora DLMM': [904], Whirlpool: [653],
  'Raydium CLMM': [1544], 'Raydium CP': [637], 'Raydium v4': [752],
  /**
   * Meteora DAMM v2 — the single most common venue among landed arbs we could
   * not price (17 of 39 blocked legs). Priced by the protocol's own SDK, which
   * was already validated EXACT against Jupiter; hand-derivation failed because
   * liquidity is Q64-scaled and there are two pool types.
   */
  'Meteora DAMM v2': [1112],
  /**
   * 301 ONLY, not [300, 301].
   *
   * The 300-byte layout predates the fields at 243-260 — is_mayhem_mode,
   * is_cashback_coin and virtualQuoteReserves — so reading offset 245 on one
   * would invent a virtual reserve out of whatever bytes live there. Those
   * pools also need an `extendAccount` instruction before a swap, which is a
   * second instruction our single-instruction leg does not carry.
   */
  'Pump.fun Amm': [301] };

/**
 * u128 little-endian. Combined as BigInt from the start: reading the two halves
 * as Numbers and adding silently mangles the value whenever the high word is 0,
 * which is most pools most of the time — it looks correct until it is not.
 */
const readU128LE = (b, o) => b.readBigUInt64LE(o) | (b.readBigUInt64LE(o + 8) << 64n);

/**
 * Where each venue stores its two mint pubkeys, for the Token-2022 guard.
 * PumpSwap is absent because pump-quote.mjs already enforces it there.
 */
const MINTS_AT = {
  'Meteora DLMM': [88, 120], 'Raydium CLMM': [73, 105],
  Whirlpool: [101, 181], 'Raydium CP': [168, 200],
  'Raydium v4': [400, 432],
  /**
   * Located empirically: decode with the SDK, then
   * search the raw account for those pubkeys. 168/200 on all 6 pools sampled,
   * and the only offsets common to every one.
   */
  'Meteora DAMM v2': [168, 200],
};

/**
 * A TOKEN-2022 TRANSFER FEE IS NOT AN AMM FEE, ON ANY VENUE.
 *
 * `mintNeedsCare` was wired into the PumpSwap path only, where a mint taking a
 * cut the AMM cannot see produced quotes 20,000 bps out. Nothing guarded DLMM,
 * CLMM, CP or Whirlpool — the same mint on those venues priced as a phantom
 * edge, and mints carrying TransferFeeConfig do turn up on them
 * (HcRLc9VDgjLeK1, extension type 1, seen on a live candidate).
 *
 * ONLY TransferFeeConfig IS REFUSED HERE, not TransferHook. A hook can do
 * anything in principle, but the one hooked mint we measured (pumpCmXqMfrsAk)
 * simulated EXACT four times out of four. Refusing on a hypothesis is how a
 * blanket Token-2022 ban once threw away 53 of 59 pools; the simulation gate is
 * the backstop if a hook ever does bite.
 */
const EXT_TRANSFER_FEE_CONFIG = 1;
/**
 * The owner is no longer consulted. It used to be required, and a mint whose data
 * had arrived before its owner read as "no fee" — and the memo below then cached
 * that answer against the buffer for good. The bytes alone decide it: a classic
 * SPL mint is exactly 82 bytes, and anything longer is a Token-2022 mint whose
 * extensions start after the account-type byte at 165.
 */
function hasTransferFee(mintData) {
  if (!mintData) return false;
  if (mintData.length <= 82) return false;
  let o = 166;
  while (o + 4 <= mintData.length) {
    const type = mintData.readUInt16LE(o);
    const len = mintData.readUInt16LE(o + 2);
    if (type === EXT_TRANSFER_FEE_CONFIG) return true;
    if (len === 0 && type === 0) break;
    o += 4 + len;
  }
  return false;
}

/**
 * DECODE ONCE PER BUFFER.
 *
 * A size search prices each pool ~80 times, and every quote re-decoded the
 * same bin arrays, tick arrays and pool headers from the same bytes. Profiled
 * live with 7 venues: evaluation was 59% of all CPU — decodeBinArray 14.2%,
 * decodeTickArray 8.0%, decodeDamm2 5.1%, and 14% of self time in base58, much
 * of it the Token-2022 mint check.
 *
 * A decode is a pure function of the bytes, so caching it cannot change a
 * result. The key is the BUFFER OBJECT: every account update stores a fresh
 * Buffer, so a changed account is automatically a cache miss, and a WeakMap
 * lets the old buffer and its decode be collected together. The one account
 * a stream consumer may write IN PLACE is a vault balance (amount @64), and no
 * decoder here takes a vault buffer.
 *
 * A decode that THROWS is not cached and throws again, exactly as before.
 */
const decodeMemo = new WeakMap();
function memo(buf, key, make) {
  let m = decodeMemo.get(buf);
  if (!m) { m = new Map(); decodeMemo.set(buf, m); }
  if (m.has(key)) return m.get(key);
  const v = make();
  m.set(key, v);
  return v;
}
const mLbPair = (d) => memo(d, 'lbPair', () => decodeLbPair(d));
const mParams = (d) => memo(d, 'params', () => decodeParams(d));
const mBinArray = (b) => memo(b, 'bin', () => decodeBinArray(b));
const mTickArray = (v, td, ts) => memo(td, 'tick|' + v + '|' + ts, () => decodeTickArray(v, td, ts));
/** Raydium, or Orca in either layout. A throw here refuses the array, never prices it. */
const mOrcaOrRayTicks = (v, td, ts) => (v !== 'orca' || isFixedTickArray(td)
  ? mTickArray(v, td, ts)
  : memo(td, 'dyntick|' + ts, () => decodeDynamicTickArray(td, ts)));
const mPool = (addr, v, d) => memo(d, 'pool|' + v, () => decodePool(addr, v, d));
const mDamm2 = (d) => memo(d, 'damm2', () => decodeDamm2(d));
const mMints = (d, venue, offs) => memo(d, 'mints|' + venue, () => offs.map((o) => {
  try { return new PublicKey(d.subarray(o, o + 32)).toBase58(); } catch { return null; }
}));
/**
 * The owner is NOT part of the key: String(owner) base58-encodes a PublicKey on
 * every quote, which the profile put at ~10% of CPU. An account's owning program
 * can only change when its bytes are re-fetched, and that stores a NEW Buffer —
 * the key this memo already uses.
 */
const mTransferFee = (mintData) => (mintData
  ? memo(mintData, 'tfee', () => hasTransferFee(mintData))
  : false);
/**
 * Mints known to be classic SPL, so a quote need not wait for their account.
 * Every other mint must be LOADED before it can be priced: two TransferFeeConfig
 * mints (60 bps each) were fired on DLMM and DAMM v2 because a missing mint
 * account read as "no fee", and both came in exactly 60 bps short.
 */
const KNOWN_CLASSIC_MINTS = new Set([WSOL,
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',       // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB']);     // USDT

const tokenAmount = (d) => (d && d.length >= 72) ? d.readBigUInt64LE(64) : null;
const chunk = (a, n) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };

/**
 * Options:
 *   maxAgeMs          refuse quotes from a polled cache older than this (default 3000; 0 disables)
 *   live              true when a subscription keeps the cache current (disables the age check)
 *   clock             fixed unix time in SECONDS for every time-dependent fee, or null for the
 *                     wall clock. Fixtures set it so a replay reproduces the recorded quote.
 *   dynamicFees       false prices Raydium CLMM and Whirlpool without their volatility fee
 *                     (for A/B checks against the chain; default true)
 *   execTickArrays    tick arrays a swap instruction carries (default 3, both CLMM venues)
 *   fetchConcurrency  parallel getMultipleAccountsInfo calls in refresh() (default 8)
 *   commitment        commitment for refresh() reads (default 'processed')
 */
export class ExactQuoter {
  constructor(opts = {}) {
    this.opts = { maxAgeMs: 3000, live: false, clock: null, dynamicFees: true,
      execTickArrays: 3, fetchConcurrency: 8, commitment: 'processed', ...opts };
    this.pools = new Map();      // addr -> { venue, aux:[], arrays:[] }
    this.data = new Map();       // addr -> Buffer
    /**
     * addr -> owning program.
     *
     * Only mints need this, and only to tell classic SPL from Token-2022 — the
     * two have different rules and an ATA derived under the wrong one is an
     * address that cannot exist.
     */
    this.owners = new Map();
    /**
     * PumpSwap's GlobalConfig and FeeConfig, set once by the caller.
     *
     * They are Anchor-decoded singletons that change almost never, and quote()
     * is synchronous with no network, so they cannot be fetched here. Absent,
     * PumpSwap quotes refuse rather than fall back to a fee guess.
     */
    this.pumpConfigs = null;
    this.lastRefresh = 0;
    this.maxAgeMs = this.opts.maxAgeMs;
    /** Set when a subscription feeds the cache: freshness comes from the feed, not the clock. */
    this.pushFed = !!this.opts.live;
    /** Current slot, needed only by DAMM v2 pools whose fee schedule is keyed on slots. */
    this.slot = this.opts.slot ?? null;
    /**
     * Addresses confirmed NOT to exist on chain.
     *
     * Tick and bin arrays are derived addresses and many are simply never
     * initialised — a pool with liquidity in a narrow band has empty arrays
     * either side. Without this the cache deleted them on every miss and
     * re-requested them on every cycle, so phase B never emptied and a
     * "steady" refresh cost MORE than the first one (4,117 ms vs 826 ms
     * measured). They are re-checked when the derived set changes, which is
     * when the active tick has actually moved.
     */
    this.missing = new Set();
    /**
     * Which refresh cycle each address was last READ in.
     *
     * Without this the cache served unboundedly stale arrays: phase A only
     * re-fetched the PREVIOUS cycle`s array list, and phase B skipped
     * anything already in `data`. An array that left the window and came
     * back was therefore never re-read — and that happens exactly when the
     * price is MOVING, which is the only time a probe matters. The walk
     * would start at the new activeId and read bin amounts from seconds
     * earlier, when those bins were still full. Overstated output, phantom
     * edge, money-losing direction.
     */
    this.fetchedCycle = new Map();
    this.cycle = 0;
    this.stats = { rpcCalls: 0, accounts: 0, phaseB: 0, refetched: 0 };
  }

  /** Supply PumpSwap's config singletons; see the field's note above. */
  setPumpConfigs(cfg) { this.pumpConfigs = cfg ?? null; }

  /** Unix seconds used by every time-dependent fee: the fixed clock if set, else the wall clock. */
  nowSec() { return this.opts.clock ?? Math.floor(Date.now() / 1000); }

  /** Store one fetched account, and identify a registered pool by owner AND size. */
  #store(a, data, owner) {
    const o = owner == null ? null : (typeof owner === 'string' ? new PublicKey(owner) : owner);
    this.data.set(a, data); this.missing.delete(a);
    if (o) this.owners.set(a, o);
    this.fetchedCycle.set(a, this.cycle);
    if (o && this.pools.has(a)) {
      const v = VENUE_BY_OWNER[o.toBase58()] ?? null;
      const sizes = v ? POOL_SIZE[v] : null;
      this.pools.get(a).venue = (sizes && sizes.includes(data.length)) ? v : null;
    }
  }

  /** Derive each pool's aux and array addresses from its current state. Returns what is not yet read this cycle. */
  #derive() {
    const need = [];
    for (const [addr, meta] of this.pools) {
      const d = this.data.get(addr);
      if (!d || !meta.venue) continue;
      let want;
      try { want = this.#auxFor(addr, meta.venue, d); }
      catch { meta.venue = null; continue; }   // unparseable: drop, do not crash
      meta.aux = want.aux; meta.arrays = want.arrays; meta.dead = !!want.dead;
      // Re-fetch anything not READ THIS CYCLE, not merely anything absent.
      // "Already in data" is not the same as "current".
      for (const a of [...want.aux, ...want.arrays]) {
        if (this.missing.has(a)) continue;
        if (this.fetchedCycle.get(a) !== this.cycle) {
          need.push(a);
          if (this.data.has(a)) this.stats.refetched++;
        }
      }
    }
    return need;
  }

  /**
   * OFFLINE: load account bytes instead of fetching them.
   *
   * `accounts` maps address -> { data: Buffer, owner: base58 | PublicKey }; `missing`
   * lists addresses confirmed NOT to exist on chain (an uninitialised tick array, an
   * absent Whirlpool oracle). A derived address in neither list makes a quote REFUSE
   * rather than guess. Returns the derived addresses that were not supplied.
   */
  loadAccounts(accounts, missing = []) {
    this.cycle++;
    const entries = accounts instanceof Map ? [...accounts] : Object.entries(accounts);
    for (const [a, acc] of entries) this.#store(a, acc.data, acc.owner);
    for (const a of missing) { this.data.delete(a); this.missing.add(a); }
    const unsupplied = this.#derive().filter((a) => !this.data.has(a));
    this.lastRefresh = Date.now();
    return unsupplied;
  }

  /**
   * Every account the registered pools depend on, as loadAccounts() takes them —
   * base64 so it serialises to JSON. This is what a fixture records.
   */
  snapshot() {
    const accounts = {}, missing = [];
    for (const [addr, meta] of this.pools) {
      for (const a of [addr, ...meta.aux, ...meta.arrays]) {
        if (this.data.has(a)) {
          accounts[a] = { data: this.data.get(a).toString('base64'), owner: this.owners.get(a)?.toBase58() ?? null };
        } else if (this.missing.has(a)) missing.push(a);
      }
    }
    return { accounts, missing: [...new Set(missing)] };
  }

  register(addr) { if (!this.pools.has(addr)) this.pools.set(addr, { venue: null, aux: [], arrays: [] }); }
  registerAll(addrs) { for (const a of addrs) this.register(a); }

  /**
   * Chunks go out CONCURRENTLY, not one after another.
   *
   * With a single throttled endpoint, serial chunks cost nothing — the limiter
   * was the ceiling either way. With the hybrid pool the ceiling moved to ~12
   * req/s and this loop became the bottleneck: a 60-call refresh ran at 2.2
   * req/s, using about a sixth of the available budget. The pool still paces
   * and fails over underneath, so the only job here is to stop leaving it idle.
   *
   * Concurrency is bounded because an unbounded fan-out just converts the
   * headroom into 429s, and every refusal costs a retry round.
   */
  async #fetch(conn, addrs) {
    if (!addrs.length) return;
    const parts = chunk([...new Set(addrs)], 100);
    const width = Math.min(this.opts.fetchConcurrency, parts.length);
    let cursor = 0;
    const runOne = async (part) => {
      const infos = await conn.getMultipleAccountsInfo(part.map((a) => new PublicKey(a)), this.opts.commitment);
      this.stats.rpcCalls++; this.stats.accounts += part.length;
      part.forEach((a, i) => {
        if (infos[i]?.data) this.#store(a, infos[i].data, infos[i].owner ?? null);
        else { this.data.delete(a); this.missing.add(a); }
      });
    };
    const worker = async () => { while (cursor < parts.length) await runOne(parts[cursor++]); };
    await Promise.all(Array.from({ length: width }, worker));
  }

  /**
   * Fetch ONLY what a push feed has never delivered.
   *
   * A subscription sends accounts that CHANGE. An array that has not traded
   * since we subscribed is never sent, and nothing back-fills it — so a
   * stream-fed cache holds whatever happened to move, not the state of a pool.
   *
   * Measured over 180 s of a live account subscription:
   *
   *     arrays the pricer needs       4,913
   *     arrays the stream sent        1,911   (38.9%)
   *     pools with a COMPLETE set     70 of 819   (8.5%)
   *
   * Contents were not the problem — accounts older than one slot matched chain
   * bytes 8,984 times out of 8,984. The cache was not wrong about what it held;
   * it was missing three fifths of what it needed, and priced the remainder as
   * if that were the whole pool.
   *
   * This is deliberately not `refresh()`: refreshing re-reads everything, which
   * on 1,500 streamed pools costs far more than it is worth when the stream is
   * already keeping the moving parts current. Only the gaps are fetched.
   */
  async backfill(conn, limit = 4000) {
    const want = [];
    for (const [addr, meta] of this.pools) {
      if (!this.data.has(addr) && !this.missing.has(addr)) want.push(addr);
      for (const a of [...meta.aux, ...meta.arrays]) {
        if (!this.data.has(a) && !this.missing.has(a)) want.push(a);
      }
    }
    if (!want.length) return { fetched: 0, remaining: 0 };
    const slice = [...new Set(want)].slice(0, limit);
    await this.#fetch(conn, slice);
    return { fetched: slice.length, remaining: Math.max(0, want.length - slice.length) };
  }

  /** Two batched phases. Round trips do not scale with pool count. */
  async refresh(conn) {
    this.cycle++;
    /**
     * Retry `missing` periodically. The docstring claimed these were
     * re-checked when the derived set changed; they never were, because both
     * phases skipped them and the only `missing.delete` sat inside a fetch
     * that was never issued. So a bin array initialised after start-up was
     * invisible forever, and one transient RPC null on a vault or amm_config
     * poisoned that pool for the whole run.
     */
    if (this.cycle % 20 === 0) this.missing.clear();
    const poolAddrs = [...this.pools.keys()];
    const phaseA = [...poolAddrs];
    for (const p of this.pools.values()) {
      for (const a of [...p.aux, ...p.arrays]) if (!this.missing.has(a)) phaseA.push(a);
    }
    await this.#fetch(conn, phaseA);

    // Derive the aux/array addresses from the state we just read.
    const phaseB = this.#derive();
    if (phaseB.length) { this.stats.phaseB++; await this.#fetch(conn, phaseB); }
    this.lastRefresh = Date.now();
    return { pools: poolAddrs.length, phaseB: phaseB.length };
  }

  /** Which extra accounts this pool needs, given its current state. */
  #auxFor(addr, venue, d) {
    const aux = [], arrays = [];
    /**
     * DEAD POOLS GET NO ARRAYS.
     *
     * A concentrated-liquidity pool with liquidity == 0 has no initialised
     * ticks to swap against; its vaults still hold dust and uncollected fees,
     * which is exactly why a "vault balance is non-zero" check called 13 of 20
     * of these live and sent me hunting a cache bug that was not there. Of 57
     * CLMM pools rejected for missing arrays, 55 read liquidity 0 with
     * initialized_tick_count 0 on every array — correct refusals.
     *
     * Deriving 7 array addresses for each costs 7 account fetches to learn
     * nothing, and parks them in `missing`. Skipping early is both cheaper and
     * more honest about the reason.
     */
    if (venue === 'Raydium CLMM' && d.length >= 253 && readU128LE(d, 237) === 0n) {
      return { aux: [new PublicKey(d.subarray(9, 41)).toBase58()], arrays: [], dead: true };
    }
    if (venue === 'Whirlpool' && d.length >= 65 && readU128LE(d, 49) === 0n) {
      return { aux: [], arrays: [], dead: true };
    }
    if (venue === 'Meteora DLMM') {
      const pair = mLbPair(d);
      const lo = binArrayIndexOf(pair.activeId - BIN_SPREAD);
      const hi = binArrayIndexOf(pair.activeId + BIN_SPREAD);
      const pk = new PublicKey(addr);
      for (let i = lo; i <= hi; i++) arrays.push(binArrayAddress(pk, i).toBase58());
    } else if (venue === 'Whirlpool' || venue === 'Raydium CLMM') {
      const isRay = venue === 'Raydium CLMM';
      if (isRay) aux.push(new PublicKey(d.subarray(9, 41)).toBase58());   // amm_config
      else aux.push(whirlOracleAddr58(addr));                             // adaptive-fee oracle (may not exist)
      const v = isRay ? 'ray' : 'orca';
      const tickSpacing = isRay ? d.readUInt16LE(235) : d.readUInt16LE(41);
      const tickCurrent = isRay ? d.readInt32LE(237 + 32) : d.readInt32LE(81);
      // Use the library's own decode for correctness rather than trusting the
      // offsets above; they are only a fallback if decode fails.
      let tc = tickCurrent, ts = tickSpacing;
      try { const dp = decodePool(addr, v, d); tc = dp.tickCurrent; ts = dp.tickSpacing; } catch { /* fallback */ }
      /**
       * SPAN IS A CONSTANT PER VENUE, NOT A DIFFERENCE.
       *
       * This used to compute it as
       *   arrayStartIndex(v, tc, ts) - arrayStartIndex(v, tc - 1, ts) || 1
       * but tc and tc-1 sit in the SAME array except exactly on a boundary,
       * so the subtraction was 0 and `|| 1` silently made span = 1. The cache
       * then derived 7 addresses spaced 1 tick apart: 6 of them do not exist,
       * get parked in `missing`, and are never retried. Measured on 4 live
       * CLMM pools: correct span loads 7 of 7 tick arrays, the buggy span
       * loads 1 of 7, and every CLMM quote then failed with "swap exceeds
       * loaded tick range (crossed 0)".
       *
       * It failed CLOSED — clmm-math refuses rather than returning a partial
       * fill — so it never mispriced. But warm-path CLMM pricing simply did
       * not work, and pool-cache-bench printed "WARM PATH IS CORRECT AND
       * FAST" on the two venues that happened to survive.
       *
       * arraySpan() is module-private in dist/clmm-pool.js, which is why this
       * file reimplemented it. The constants: 60 ticks/array on Raydium, 88 on
       * Orca, each multiplied by tickSpacing.
       */
      const span = (isRay ? 60 : 88) * ts;
      const start = arrayStartIndex(v, tc, ts);
      const pk = new PublicKey(addr);
      for (let k = -TICK_RADIUS; k <= TICK_RADIUS; k++) {
        arrays.push(tickArrayAddress(v, pk, start + k * span).toBase58());
      }
    } else {
      const L = RESERVE_LAYOUT[venue];
      if (L) {
        aux.push(new PublicKey(d.subarray(L.v0, L.v0 + 32)).toBase58());
        aux.push(new PublicKey(d.subarray(L.v1, L.v1 + 32)).toBase58());
        if (L.cfg !== undefined) aux.push(new PublicKey(d.subarray(L.cfg, L.cfg + 32)).toBase58());
        // PumpSwap's fee tier is a function of the mint's SUPPLY, and its
        // Token-2022 extensions decide whether the pool is priceable at all.
        if (L.needsBaseMint) aux.push(new PublicKey(d.subarray(L.m0, L.m0 + 32)).toBase58());
      }
    }
    /**
     * Both mints join aux so the back-fill fetches them and records their
     * owning program. They are static and tiny, so this costs one fetch per
     * pool for the life of the run.
     */
    const mo = MINTS_AT[venue];
    if (mo) {
      for (const off of mo) {
        try { aux.push(new PublicKey(d.subarray(off, off + 32)).toBase58()); }
        catch { /* unreadable pool; the venue check below will refuse it */ }
      }
    }
    return { aux, arrays };
  }

  /**
   * SYNCHRONOUS. No network. Returns {ok,out,venue} or {ok:false,reason}.
   *
   * IT MUST NEVER THROW.
   *
   * A single CLMM pool carrying a nonsense tick (-2,894,848) threw out of the
   * math and killed a 120-pair scan at pair 41. A quoter that can abort the
   * caller is not a quoter with a refusal path; the refusal path just does not
   * cover the cases nobody predicted. One bad account among thousands is
   * ordinary, and it should cost that one pool, not the run.
   */
  quote(addr, inputMint, amountIn) {
    try { return this.#quote(addr, inputMint, amountIn); }
    catch (e) { return { ok: false, reason: 'quote threw: ' + String(e.message).slice(0, 50) }; }
  }

  #quote(addr, inputMint, amountIn) {
    const meta = this.pools.get(addr);
    const d = this.data.get(addr);
    if (!meta || !d) return { ok: false, reason: 'pool not cached' };
    const venue = meta.venue;
    if (!venue) return { ok: false, reason: 'unsupported venue' };
    // The module docstring promised this and it did not exist: a quote built
    // from state older than one poll cycle is not a quote, it is a guess.
    /**
     * A PUSH-FED CACHE DOES NOT AGE.
     *
     * This gate exists because a POLLED cache goes stale the moment it stops
     * polling. Under a subscription the opposite holds: an account nobody
     * touched is still exactly correct, and we would have been told if it
     * changed. Applying the poll rule to a pushed cache silently refused every
     * quote 3 seconds after start — a 180s watch measured 3 seconds of it and
     * reported the rest as if nothing had happened.
     *
     * Set  only while a subscription is actually live; the
     * per-address freshness still comes from fetchedCycle and the feed itself,
     * and coverage gaps are the caller's job to track.
     */
    if (!this.pushFed && this.maxAgeMs && Date.now() - this.lastRefresh > this.maxAgeMs) {
      return { ok: false, reason: 'cache stale by '
        + (Date.now() - this.lastRefresh) + 'ms' };
    }
    const amt = BigInt(amountIn);

    /**
     * Refuse before pricing, on every venue that has a mint pair. A quote that
     * ignores a mint-level fee does not fail loudly, it invents an edge.
     */
    const mintOffs = MINTS_AT[venue];
    if (mintOffs) {
      for (const ma of mMints(d, venue, mintOffs)) {
        if (ma === null) continue;
        const md = this.data.get(ma);
        /* FAIL CLOSED: an unloaded mint cannot be shown to be fee-free. */
        if (!md && !KNOWN_CLASSIC_MINTS.has(ma)) {
          return { ok: false, reason: 'mint ' + ma.slice(0, 8) + ' not loaded — cannot rule out a token-2022 transfer fee' };
        }
        if (mTransferFee(md)) {
          return { ok: false, reason: 'token-2022 transfer fee on ' + ma.slice(0, 8)
            + ' — the mint takes a cut the AMM cannot see' };
        }
      }
    }

    /**
     * Meteora DAMM v2, priced by the protocol's own math.
     *
     * `currentPoint` is a UNIX TIMESTAMP when activationType is 1 and a SLOT
     * when it is 0 — the fee schedulers read it, so passing the wrong one
     * silently returns a fee from the wrong point on the schedule. Every pool
     * sampled reads 1, and a timestamp costs no RPC. A slot-keyed pool is
     * REFUSED rather than priced against a fabricated slot; a caller that has a
     * real slot can set `cache.slot`.
     *
     * Decimals are deliberately not plumbed through: they provably do not
     * change the output here (5 of 5 pools identical with defaults vs real
     * decimals), so carrying them would be complexity
     * that buys nothing.
     */
    if (venue === 'Meteora DAMM v2') {
      /**
       * VALIDATED: 25 of 25 EXACT, worst 0.0000 bps, against cp.getQuote on the
       * SAME pool.
       *
       * This branch was briefly gated off on a bad measurement worth recording:
       * a validator compared our quote for ONE pool against a Jupiter quote
       * carrying `dexes=Meteora DAMM v2`, which lets Jupiter pick the BEST DAMM
       * v2 pool for the pair — a different pool entirely (ammKey GW27NDmF vs the
       * 3ZvnY7 we priced). Quoting a thin pool against someone else's deep pool
       * manufactures a large, one-sided, per-pool-varying gap that looks exactly
       * like a broken pricer. A venue comparison must pin the SAME pool on both
       * sides, or it measures liquidity rather than correctness.
       *
       * The related "decimals do not change the output" result also stands but
       * proves only invariance: decimals sit at SDK positions 7/8 and genuinely
       * do not affect the raw outputAmount.
       */
      if (!damm2Live(d)) return { ok: false, reason: 'damm2: pool not live' };
      let ps;
      try { ps = mDamm2(d); }
      catch (e) { return { ok: false, reason: 'damm2 decode: ' + String(e.message).slice(0, 40) }; }
      if (Number(ps.activationType ?? 0) === 0 && !this.slot) {
        return { ok: false, reason: 'damm2: slot-keyed fee schedule and no slot set' };
      }
      const r = quoteDamm2({ poolState: ps, inputMint, amountIn: amt,
        slot: this.slot ?? 0, time: this.nowSec() });
      return r.ok ? { ok: true, venue, out: r.out, crossed: 0 } : r;
    }

    if (venue === 'Meteora DLMM') {
      const pair = mLbPair(d);
      const par = mParams(d);
      const refs = decayedReferences(par, pair.activeId, this.nowSec());
      const bins = new Map();
      for (const a of meta.arrays) {
        const bd = this.data.get(a);
        if (!bd) continue;
        const dec = mBinArray(bd);
        dec.bins.forEach((b, k) => bins.set(dec.index * BINS_PER_ARRAY + k,
          { amountX: b.amountX, amountY: b.amountY }));
      }
      /**
       * No bin array exists within +-140 bins of the active bin. That is an
       * economic fact, not a loading failure: a pool whose nearest liquidity
       * sits 1,120 bins away (~25% in price at binStep 2, measured on
       * 4E7kn5rA) cannot be traded against at anything like the current price.
       * Its vaults still show a balance, which is why a reserves-are-non-zero
       * check wrongly flagged 5 of 30 of these as missed opportunities.
       */
      if (!bins.size) return { ok: false, reason: 'no liquidity within +-140 bins of active' };
      const swapForY = pair.mintX === inputMint;
      if (!swapForY && pair.mintY !== inputMint) return { ok: false, reason: 'mint not in pool' };
      const r = dlmmSwap({ activeId: pair.activeId, binStep: pair.binStep, bins,
        amountIn: amt, swapForY, rate: totalFeeRate(pair.binStep, par),
        params: par, refs });
      if (r.truncated) return { ok: false, reason: 'dlmm: ' + r.reason };
      return { ok: true, venue, out: r.out, crossed: r.crossed };
    }

    if (venue === 'Whirlpool' || venue === 'Raydium CLMM') {
      const isRay = venue === 'Raydium CLMM';
      if (isRay && d.length > CLMM_STATUS && d[CLMM_STATUS] !== 0) {
        // status is byte 389 in the current PoolState (byte 285 is inside fee_growth_global_0);
        // non-zero means swaps are disabled and the program rejects at execution time.
        return { ok: false, reason: 'CLMM status ' + d[CLMM_STATUS] + ' (disabled)' };
      }
      const v = isRay ? 'ray' : 'orca';
      let fee;
      if (isRay) {
        const cfg = this.data.get(meta.aux[0]);
        if (!cfg || cfg.length < 51) return { ok: false, reason: 'amm_config not cached' };
        fee = cfg.readUInt32LE(47) / 1_000_000;
      }
      let pool;
      try { pool = mPool(addr, v, d); } catch (e) { return { ok: false, reason: 'decode: ' + e.message }; }
      if (isRay) pool = { ...pool, feeRate: fee };
      /**
       * PRICE ONLY WHAT THE INSTRUCTION CAN SUPPLY.
       *
       * The cache loads TICK_RADIUS arrays either side (7 total) so the window
       * survives price movement. But a swap instruction carries a FIXED number
       * of tick arrays — three on both Whirlpool and Raydium CLMM — so pricing
       * across all seven predicts liquidity the transaction cannot reach.
       *
       * Measured: a Whirlpool pool predicted 9,360,435 and delivered 9,352,700,
       * an 8.27 bps OVERPREDICTION, because the pricer crossed into an array the
       * instruction never passed. Overprediction is the dangerous direction — it
       * turns a losing trade into an apparent edge.
       *
       * So the walk is capped to the executable window: the current array plus
       * two in the direction the price will move.
       */
      const EXEC_ARRAYS = this.opts.execTickArrays;
      const mint0 = isRay ? new PublicKey(d.subarray(73, 105)).toBase58()
        : new PublicKey(d.subarray(101, 133)).toBase58();
      const sellingToken0 = inputMint === mint0;
      const span = (isRay ? 60 : 88) * pool.tickSpacing;
      const startNow = arrayStartIndex(v, pool.tickCurrent, pool.tickSpacing);
      const reachable = new Set(Array.from({ length: EXEC_ARRAYS },
        (_, k) => startNow + (sellingToken0 ? -k : k) * span));

      if (!isRay) {
        for (const st of reachable) {
          let ta;
          try { ta = tickArrayAddr58(v, addr, st); } catch { continue; }
          const td = this.data.get(ta);
          if (td && !isOrcaKnownTickArray(td)) {
            return { ok: false, reason: 'whirlpool tick array at ' + st
              + ' — unknown layout, refusing to price it' };
          }
        }
      }

      /**
       * THE ARRAY HOLDING THE CURRENT TICK MUST EXIST.
       *
       * Raydium CLMM refuses a swap with error 6023 NotEnoughTickArrayAccount
       * when the tick array containing tickCurrent is uninitialised — the
       * program cannot start the walk without it, regardless of how many other
       * arrays are supplied.
       *
       * Our pricer had no such requirement: a swap that stays inside the
       * current tick's liquidity never touches an array, so it quoted happily.
       * Measured on CXyJPPfpUeUE (tickCurrent 29,634, start 28,800): the array
       * at 28,800 does not exist while 21,600 and 14,400 do, and the pool
       * produced repeated phantom edges of +19 to +588 bps — thirteen of
       * twenty-seven simulation failures in one run, all the same pool.
       *
       * A pool whose swap cannot begin is not a cheap pool, it is a pool that
       * cannot be traded.
       */
      const currentArray = meta.arrays.find((a) => {
        const td = this.data.get(a);
        if (!td) return false;
        if (!isRay && !isOrcaKnownTickArray(td)) return false;
        try { return (isRay ? td.readInt32LE(40) : td.readInt32LE(8)) === startNow; }
        catch { return false; }
      });
      if (!currentArray) {
        return { ok: false, reason: 'tick array at ' + startNow
          + ' (holds the current tick) is not initialised' };
      }

      /**
       * MISSING FROM CACHE IS NOT THE SAME AS ABSENT FROM CHAIN.
       *
       * `toSwapState` passes only a flat `ticks` list to the math — it drops
       * `arraysLoaded`, so the swap cannot distinguish "no tick boundary here"
       * from "we never loaded the array that would contain one". An unloaded
       * array therefore reads as CONTINUOUS LIQUIDITY across its whole range,
       * which always makes the pool look deeper than it is.
       *
       * That is the shape of every false positive this project has chased:
       * one-sided optimism, varying run to run with whichever arrays the feed
       * happened to deliver. Array coverage was measured at 58-62%.
       *
       * An array confirmed NOT to exist on chain is different — it genuinely
       * holds no ticks, and walking past it is correct. `this.missing` records
       * exactly that, which is why the two cases can be told apart here and
       * nowhere downstream.
       */
      const poolPk = new PublicKey(addr);
      for (const st of reachable) {
        let ta;
        try { ta = tickArrayAddr58(v, addr, st); } catch { continue; }
        if (this.data.has(ta) || this.missing.has(ta)) continue;
        return { ok: false, reason: 'tick array ' + st + ' not loaded — unknown '
          + 'whether it holds ticks, and assuming none overstates depth' };
      }

      const ticks = [];
      for (const a of meta.arrays) {
        const td = this.data.get(a);
        if (!td) continue;
        // The array's own start index is stored in its header: ray @40, orca @8.
        let st;
        if (!isRay && !isOrcaKnownTickArray(td)) continue;
        try { st = isRay ? td.readInt32LE(40) : td.readInt32LE(8); } catch { continue; }
        if (!reachable.has(st)) continue;
        try { ticks.push(...mOrcaOrRayTicks(v, td, pool.tickSpacing)); } catch { /* skip */ }
      }
      // Distinguish 'dead pool' from 'we failed to load its arrays'. Reporting
      // both as the same thing hid a 96%-correct refusal behind what looked
      // like a coverage bug, and cost a long hunt for a cache fault.
      if (!ticks.length) {
        return { ok: false, reason: meta.dead ? 'pool liquidity 0 (dead)'
          : (meta.arrays.some((x) => this.data.has(x))
            ? 'tick arrays hold no initialised ticks'
            : 'no tick arrays cached') };
      }
      const mintA = isRay ? new PublicKey(d.subarray(73, 105)).toBase58()
        : new PublicKey(d.subarray(101, 133)).toBase58();
      const mintB = isRay ? new PublicKey(d.subarray(105, 137)).toBase58()
        : new PublicKey(d.subarray(181, 213)).toBase58();
      if (inputMint !== mintA && inputMint !== mintB) return { ok: false, reason: 'mint not in pool' };
      const state = toSwapState({ ...pool, ticks, arraysLoaded: meta.arrays.length });
      const dyn = isRay ? clmmDynamicFee(d, pool.tickSpacing, pool.tickCurrent, this.nowSec(), this.opts.dynamicFees)
        : whirlAdaptiveFee(this, addr, pool.tickCurrent);
      if (dyn.refuse) return { ok: false, reason: dyn.refuse };
      if (dyn.fee) state.dynamicFee = dyn.fee;
      const res = clmmSwap(state, amt, inputMint === mintA);
      if (isSwapError(res)) return { ok: false, reason: res.error ?? 'swap error' };
      return { ok: true, venue, out: res.amountOut, crossed: res.ticksCrossed };
    }

    const L = RESERVE_LAYOUT[venue];
    if (!L) return { ok: false, reason: 'no pricer for ' + venue };
    if (L.unresolvedFee) return { ok: false, reason: venue + ' fee unresolved' };

    /**
     * PUMPSWAP USES THE PROTOCOL'S OWN MATH.
     *
     * Not a fee constant on a constant-product curve: the fee is tiered by
     * market cap, the creator fee depends on coinCreator, and some pools price
     * against virtual quote reserves that no vault balance reveals. All three
     * were separately capable of inventing an edge here, and one of them did.
     */
    if (L.needsBaseMint) {
      if (!this.pumpConfigs) return { ok: false, reason: 'pump configs not loaded' };
      const mintAddr = meta.aux[2];
      const mintData = this.data.get(mintAddr);
      const mintOwner = this.owners.get(mintAddr);
      if (!mintData || !mintOwner) return { ok: false, reason: 'pump base mint not cached' };
      const bv = tokenAmount(this.data.get(meta.aux[0]));
      const qv = tokenAmount(this.data.get(meta.aux[1]));
      if (bv === null || qv === null) return { ok: false, reason: 'vaults not cached' };
      const pool = decodePumpPool(d);
      const inputIsQuote = inputMint === pool.quoteMint.toBase58();
      if (!inputIsQuote && inputMint !== pool.baseMint.toBase58()) {
        return { ok: false, reason: 'mint not in pool' };
      }
      const r = quotePump({ pool, baseMintAccount: decodeRawMint(mintData),
        baseMintData: mintData, baseMintOwner: mintOwner,
        baseReserve: bv, quoteReserve: qv,
        globalConfig: this.pumpConfigs.globalConfig,
        feeConfig: this.pumpConfigs.feeConfig, amountIn: amt, inputIsQuote });
      return r.ok ? { ok: true, venue, out: r.out, crossed: 0 } : r;
    }

    const m0 = new PublicKey(d.subarray(L.m0, L.m0 + 32)).toBase58();
    const m1 = new PublicKey(d.subarray(L.m1, L.m1 + 32)).toBase58();
    if (inputMint !== m0 && inputMint !== m1) return { ok: false, reason: 'mint not in pool' };
    let r0 = tokenAmount(this.data.get(meta.aux[0]));
    let r1 = tokenAmount(this.data.get(meta.aux[1]));
    if (r0 === null || r1 === null) return { ok: false, reason: 'vaults not cached' };
    if (L.pf0 !== undefined) {
      // ff is a SECOND owed-out component that only Raydium CP has; Raydium v4
      // carries needTakePnl alone, and reading an absent offset would throw.
      r0 -= d.readBigUInt64LE(L.pf0)
        + (L.ff0 === undefined ? 0n : d.readBigUInt64LE(L.ff0));
      r1 -= d.readBigUInt64LE(L.pf1)
        + (L.ff1 === undefined ? 0n : d.readBigUInt64LE(L.ff1));
    }
    if (r0 <= 0n || r1 <= 0n) return { ok: false, reason: 'empty reserves' };
    let micro = L.fixedMicro;
    if (micro === undefined && L.feeNumOff !== undefined) {
      // Fee stored on the POOL as numerator/denominator, not in a config account.
      const den = d.readBigUInt64LE(L.feeDenOff);
      if (den === 0n) return { ok: false, reason: venue + ': zero fee denominator' };
      micro = d.readBigUInt64LE(L.feeNumOff) * 1_000_000n / den;
    }
    if (micro === undefined) {
      const cfg = this.data.get(meta.aux[2]);
      if (!cfg || cfg.length < L.cfgFeeOff + 8) return { ok: false, reason: 'cp config not cached' };
      micro = cfg.readBigUInt64LE(L.cfgFeeOff);
    }
    const inIs0 = inputMint === m0;
    /* Raydium CP's creator fee and accrued creator fees — see cpCreatorTerms in local-quote.mjs. */
    if (venue === 'Raydium CP') {
      const t = cpCreatorTerms(d, this.data.get(meta.aux[2]), inIs0);
      if (t.invalid) return { ok: false, reason: 'cp: creator fee fields unreadable' };
      r0 -= t.cf0; r1 -= t.cf1;
      if (r0 <= 0n || r1 <= 0n) return { ok: false, reason: 'empty reserves' };
      return { ok: true, venue, crossed: 0,
        out: cpExactInCreator(inIs0 ? r0 : r1, inIs0 ? r1 : r0, amt, micro, t.creatorMicro, t.onInput) };
    }
    return { ok: true, venue, out: cpExactIn(inIs0 ? r0 : r1, inIs0 ? r1 : r0, amt, micro), crossed: 0 };
  }
}

/** Earlier name of ExactQuoter, kept as an alias. */
export { ExactQuoter as PoolCache };
