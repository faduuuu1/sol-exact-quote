/**
 * pump-quote.mjs — price PumpSwap with the protocol's own math.
 *
 * WHY A GENERIC QUOTE GETS IT WRONG
 * ---------------------------------
 * The fee is not a constant: measured 0.2990%, 0.2992% and 3.2956% across three
 * pools, with NO field in the pool account matching. It is composed of
 * lp + protocol + creator basis points and selected by a MARKET-CAP TIER, so a
 * fixed constant is guaranteed wrong somewhere — and one previously invented 18
 * fake edges at up to +138 bps.
 *
 * THE SDK HAS THE REAL MATH
 * -------------------------
 * `@pump-fun/pump-swap-sdk` exports STANDALONE quote functions that take plain
 * data and compute the tiered fee internally. Note there are two things with the
 * same name: the PumpAmmSdk CLASS METHOD returns TransactionInstruction[], while
 * the standalone export returns a quote. We want the standalone one.
 *
 * Same discipline that made DAMM v2 priceable: use the protocol's own
 * implementation, never a re-derivation.
 *
 * Nothing here signs or sends.
 */
import { Connection, PublicKey } from '@solana/web3.js';
import BN from 'bn.js';
import * as pump from '@pump-fun/pump-swap-sdk';

export const PUMP_AMM = new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');
/** Pool layout, previously validated against landed transactions. */
export const PUMP_OFF = { creator: 8, baseMint: 43, quoteMint: 75,
  baseVault: 139, quoteVault: 171 };
/** Pools come in two sizes; <300 needs extendAccount before a swap. */
export const PUMP_POOL_SIZES = [300, 301];

/**
 * GlobalConfig and FeeConfig are singletons that change almost never, so they
 * are fetched once and reused. Refusing to cache them would put two RPC calls
 * in front of every quote.
 */
let cachedConfigs = null;
export async function loadPumpConfigs(conn) {
  if (cachedConfigs) return cachedConfigs;
  const program = pump.getPumpAmmProgram(conn);
  const [globalConfig, feeConfig] = await Promise.all([
    program.account.globalConfig.fetch(pump.GLOBAL_CONFIG_PDA),
    program.account.feeConfig.fetch(pump.PUMP_AMM_FEE_CONFIG_PDA).catch(() => null),
  ]);
  cachedConfigs = { globalConfig, feeConfig };
  return cachedConfigs;
}

/** The two config singletons by address, for a fixture or a custom fetcher. */
export const PUMP_CONFIG_ACCOUNTS = {
  globalConfig: pump.GLOBAL_CONFIG_PDA.toBase58(),
  feeConfig: pump.PUMP_AMM_FEE_CONFIG_PDA.toBase58(),
};

/**
 * OFFLINE: decode the config singletons from raw account bytes, exactly as
 * loadPumpConfigs() would after fetching them. `feeData` may be null (no fee config).
 * The program object is used for its Anchor coder only and never connects.
 */
export function decodePumpConfigs(globalData, feeData) {
  const program = pump.getPumpAmmProgram(new Connection('http://127.0.0.1:1'));
  return {
    globalConfig: program.coder.accounts.decode('globalConfig', globalData),
    feeConfig: feeData ? program.coder.accounts.decode('feeConfig', feeData) : null,
  };
}

/** The raw bytes behind loadPumpConfigs(), for recording a fixture. */
export async function loadPumpConfigBytes(conn) {
  const [g, f] = await conn.getMultipleAccountsInfo(
    [pump.GLOBAL_CONFIG_PDA, pump.PUMP_AMM_FEE_CONFIG_PDA], 'confirmed');
  if (!g) throw new Error('pump globalConfig not found');
  return { globalConfig: g.data, feeConfig: f?.data ?? null };
}

/** SPL Mint layout: supply u64 @36, decimals u8 @44, and the option flags. */
export function decodeRawMint(d) {
  return {
    mintAuthorityOption: d.readUInt32LE(0),
    mintAuthority: new PublicKey(d.subarray(4, 36)),
    supply: BigInt(d.readBigUInt64LE(36)),
    decimals: d[44],
    isInitialized: Boolean(d[45]),
    freezeAuthorityOption: d.readUInt32LE(46),
    freezeAuthority: new PublicKey(d.subarray(50, 82)),
  };
}

/** i128 little-endian: low u64 then a SIGNED high u64. */
function readI128LE(d, o) {
  return (BigInt(d.readBigInt64LE(o + 8)) << 64n) | BigInt(d.readBigUInt64LE(o));
}

/**
 * Full Pool layout, derived from the VALIDATED anchors (baseMint@43,
 * quoteMint@75, baseVault@139, quoteVault@171) rather than from the struct
 * order alone — the struct implies 41/73/137/169, two bytes lower, so there is
 * a u16 `index` between the bump and poolCreator:
 *
 *     @8   bump u8
 *     @9   index u16
 *     @11  poolCreator      @43  baseMint    @75  quoteMint
 *     @107 lpMint           @139 baseVault   @171 quoteVault
 *     @203 lpSupply u64     @211 coinCreator
 *     @243 isMayhemMode bool  @244 isCashbackCoin bool
 *     @245 virtualQuoteReserves i128        (account is 301, rest reserved)
 *
 * coinCreator matters: it selects the CREATOR FEE component. Guessing it from
 * the end of the account made every quote overestimate by a near-constant
 * 94.6 bps — a constant offset across pools with different total fees is the
 * signature of a missing fee component, not a broken tier model.
 *
 * VIRTUAL QUOTE RESERVES ARE NOT OPTIONAL.
 *
 * One pool quoted 3.31x what the chain delivered. It was not a fee and not a
 * Token-2022 extension: the pool carries 17.58 SOL of VIRTUAL quote liquidity
 * that the program adds to the real vault balance before pricing. Its real
 * vault held 7.58 SOL, so pricing against the vault alone made the pool look
 * more than three times shallower than it is, and every quote came out
 * correspondingly large.
 *
 * It is also not rare — 3 of the first 12 WSOL pools carry it — and the sign is
 * i128, so it must be read as signed rather than assumed positive.
 */
export function decodePumpPool(d) {
  const at = (o) => new PublicKey(d.subarray(o, o + 32));
  return {
    creator: at(11),
    baseMint: at(PUMP_OFF.baseMint),
    quoteMint: at(PUMP_OFF.quoteMint),
    lpMint: at(107),
    baseVault: at(PUMP_OFF.baseVault),
    quoteVault: at(PUMP_OFF.quoteVault),
    lpSupply: d.length >= 211 ? d.readBigUInt64LE(203) : 0n,
    // Present only in the extended layout; older pools have no separate creator.
    coinCreator: d.length >= 243 ? at(211) : at(11),
    isMayhemMode: d.length > 243 ? Boolean(d[243]) : false,
    isCashbackCoin: d.length > 244 ? Boolean(d[244]) : false,
    virtualQuoteReserves: d.length >= 261 ? readI128LE(d, 245) : 0n,
  };
}

/**
 * Exact-in quote. `inputIsQuote` true means spending the quote token (usually
 * WSOL) to buy base; false means selling base for quote.
 *
 * Returns {ok, out} or {ok:false, reason} — never a guess. A venue we cannot
 * price correctly must refuse, because a plausible wrong number here is exactly
 * what produced 18 phantom edges before.
 */
/**
 * TOKEN-2022 TRANSFER FEES ARE NOT AMM FEES.
 *
 * Two pools quoted 20,000+ bps above Jupiter — an implied 67% "fee". That is
 * not a fee tier; it is a Token-2022 TransferFee extension taking a cut of the
 * transfer itself, which the AMM math never sees. Six other pools matched
 * EXACTLY, so the model is right and these are a different animal.
 *
 * A classic SPL mint is exactly 82 bytes. Token-2022 mints carry extensions
 * past that, so anything longer needs checking before we trust a quote.
 * Refusing is the safe half of the trade-off: a venue we cannot price
 * correctly must decline, because a plausible wrong number is what produced
 * 18 phantom edges here before.
 */
const SPL_MINT_LEN = 82;
/** Token-2022 TLV extension types we must refuse; others are harmless here. */
const EXT_TRANSFER_FEE_CONFIG = 1;
const EXT_TRANSFER_HOOK = 14;

/**
 * REFUSE THE FEE, NOT THE STANDARD.
 *
 * The first version rejected ANY Token-2022 mint carrying extensions, which
 * threw away 53 of 59 pools — nearly the whole venue. Most pump.fun tokens have
 * a MetadataPointer or TokenMetadata extension that takes nothing; only
 * TransferFeeConfig (and a TransferHook, which can do anything) actually change
 * what the swap delivers.
 *
 * Layout: the 82-byte base mint, padding to 165, an account-type byte at 165,
 * then TLV entries of {type u16, len u16, value}. Walking the TLV is the
 * difference between a guard and a blanket ban.
 */
export function mintNeedsCare(mintData, owner) {
  const isT22 = String(owner) === 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
  if (!isT22) return null;
  if (mintData.length <= SPL_MINT_LEN) return null;
  let o = 166;                       // 165 is the account-type discriminator
  while (o + 4 <= mintData.length) {
    const type = mintData.readUInt16LE(o);
    const len = mintData.readUInt16LE(o + 2);
    if (type === EXT_TRANSFER_FEE_CONFIG) {
      return 'token-2022 TransferFeeConfig — the mint takes a cut the AMM cannot see';
    }
    if (type === EXT_TRANSFER_HOOK) {
      return 'token-2022 TransferHook — transfer behaviour is program-defined';
    }
    if (len === 0 && type === 0) break;   // end of TLV
    o += 4 + len;
  }
  return null;
}

export function quotePump({ pool, baseMintAccount, baseMintData, baseMintOwner,
  baseReserve, quoteReserve, globalConfig, feeConfig, amountIn, inputIsQuote,
  slippage = 0 }) {
  if (!(baseReserve > 0n && quoteReserve > 0n)) return { ok: false, reason: 'empty pool' };
  if (!globalConfig) return { ok: false, reason: 'global config not loaded' };
  /**
   * The transfer-fee check enforces ITSELF rather than trusting the caller to
   * set a flag. When it depended on `pool.baseMintCare`, a pool whose caller
   * forgot to set it quoted +13,947 bps — an implied 58.83% "fee" that is a
   * Token-2022 transfer fee, not an AMM fee. A guard that can be skipped by
   * omission is not a guard.
   */
  const care = (baseMintData && baseMintOwner)
    ? mintNeedsCare(baseMintData, baseMintOwner)
    : (pool.baseMintCare ?? null);
  if (care) return { ok: false, reason: care };
  /**
   * The program prices against quoteReserve + virtualQuoteReserves, and passes
   * that same sum to the fee-tier calculation, so omitting it gets BOTH the
   * curve and the fee band wrong. Defaulting to 0 here would silently restore
   * the 3.31x error on any caller that decoded a pool some other way.
   */
  const virtual = pool.virtualQuoteReserves ?? 0n;
  const common = {
    slippage,
    baseReserve: new BN(baseReserve.toString()),
    quoteReserve: new BN(quoteReserve.toString()),
    virtualQuoteReserves: new BN(virtual.toString()),
    globalConfig,
    baseMintAccount,
    baseMint: pool.baseMint,
    coinCreator: pool.coinCreator,
    creator: pool.creator,
    feeConfig: feeConfig ?? null,
  };
  try {
    if (inputIsQuote) {
      // Spending quote to receive base.
      const r = pump.buyQuoteInput({ ...common, quote: new BN(amountIn.toString()) });
      const out = r?.base ?? r?.baseAmountOut ?? r?.uiBase;
      return out ? { ok: true, out: BigInt(out.toString()) }
        : { ok: false, reason: 'no base amount in result' };
    }
    // Selling base to receive quote.
    const r = pump.sellBaseInput({ ...common, base: new BN(amountIn.toString()) });
    const out = r?.quote ?? r?.quoteAmountOut ?? r?.uiQuote;
    return out ? { ok: true, out: BigInt(out.toString()) }
      : { ok: false, reason: 'no quote amount in result' };
  } catch (e) {
    return { ok: false, reason: 'pump sdk: ' + String(e.message).slice(0, 50) };
  }
}
