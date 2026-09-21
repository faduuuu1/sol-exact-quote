/**
 * build.mjs — one swap instruction for any supported venue, plus the helpers a
 * simulation needs. Used by tools/verify.mjs to hold every quote against the chain.
 *
 * Nothing here signs or sends. Simulation runs with sigVerify off, so the "owner"
 * of a leg only needs to HOLD the input token — findSigner() finds such an address.
 */
import { PublicKey, VersionedTransaction, TransactionMessage,
  ComputeBudgetProgram, TransactionInstruction } from '@solana/web3.js';
import { buildDlmmSwapIx, createAtaIdempotentIx, ataFor, bitmapPda } from './swap-ix.mjs';

export { createAtaIdempotentIx, ataFor };
import { buildClmmSwapIx } from './swap-ix-clmm.mjs';
import { buildCpSwapIx } from './swap-ix-cp.mjs';
import { buildWhirlpoolSwapIx } from './swap-ix-whirlpool.mjs';
import { buildRayV4SwapIx } from './swap-ix-rayv4.mjs';
import { buildDamm2SwapIx } from './swap-ix-damm2.mjs';
import { buildPumpLegIx } from './pump-swap-ix.mjs';

const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ATA_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');

/** Cache mint -> owning token program; a mint's program never changes. */
const progCache = new Map();
export async function tokenProgramOf(conn, mint) {
  const k = String(mint);
  if (progCache.has(k)) return progCache.get(k);
  let p = TOKEN_PROGRAM;
  try { const i = await conn.getAccountInfo(new PublicKey(mint), 'confirmed'); if (i) p = i.owner; }
  catch { /* default */ }
  progCache.set(k, p);
  return p;
}

/** Cache pool -> whether its DLMM bitmap extension exists. */
const bitmapCache = new Map();
async function hasBitmap(conn, pool) {
  const k = String(pool);
  if (bitmapCache.has(k)) return bitmapCache.get(k);
  let has = false;
  try { has = Boolean(await conn.getAccountInfo(bitmapPda(new PublicKey(pool)), 'confirmed')); }
  catch { /* assume none */ }
  bitmapCache.set(k, has);
  return has;
}

/**
 * Build ONE leg for any venue we have a builder for.
 *
 * Each builder needs the mints' real token programs: ATA address is
 * f(owner, TOKEN PROGRAM, mint), so defaulting to classic SPL on a Token-2022
 * mint derives an address that can never exist and fails as 3012.
 */
export async function buildLeg(conn, cache, addr, inputMint, amountIn, owner, minOut = 0n) {
  const meta = cache.pools.get(addr);
  const data = cache.data.get(addr);
  if (!meta || !data) throw new Error('pool not cached');
  /**
   * minOut IS THE SLIPPAGE GUARD, AND IT DEFAULTS TO ZERO FOR A REASON.
   *
   * Zero is correct while SIMULATING: the point of a simulation is to learn
   * what the chain produces, and a floor would turn a measurement into a
   * refusal. It is the wrong value the moment anything is sent, because a leg
   * with no floor fills at any price.
   */
  const common = { poolData: data, pool: new PublicKey(addr), owner,
    inputMint, amountIn, minOut };

  if (meta.venue === 'Meteora DLMM') {
    const arrays = meta.arrays.filter((x) => cache.data.has(x)).map((x) => new PublicKey(x));
    const mx = new PublicKey(data.subarray(88, 120)).toBase58();
    const my = new PublicKey(data.subarray(120, 152)).toBase58();
    return buildDlmmSwapIx({ ...common, binArrays: arrays, opt: {
      hasBitmapExt: await hasBitmap(conn, addr),
      tokenProgramX: await tokenProgramOf(conn, mx),
      tokenProgramY: await tokenProgramOf(conn, my) } });
  }
  if (meta.venue === 'Raydium CLMM') {
    const m0 = new PublicKey(data.subarray(73, 105)).toBase58();
    const m1 = new PublicKey(data.subarray(105, 137)).toBase58();
    const z = m0 === inputMint;
    return buildClmmSwapIx({ ...common, opt: {
      tokenProgramIn: await tokenProgramOf(conn, z ? m0 : m1),
      tokenProgramOut: await tokenProgramOf(conn, z ? m1 : m0) } });
  }
  if (meta.venue === 'Raydium CP') {
    const m0 = new PublicKey(data.subarray(168, 200)).toBase58();
    const m1 = new PublicKey(data.subarray(200, 232)).toBase58();
    const z = m0 === inputMint;
    return buildCpSwapIx({ ...common, opt: {
      tokenProgramIn: await tokenProgramOf(conn, z ? m0 : m1),
      tokenProgramOut: await tokenProgramOf(conn, z ? m1 : m0) } });
  }
  /**
   * PumpSwap's leg comes from the SDK, stripped to the one program instruction.
   *
   * slippagePercent 0 is deliberate: the caller's minOut, applied below, is the
   * only guard, so the SDK must not add a looser one of its own.
   */
  if (meta.venue === 'Pump.fun Amm') {
    if (!cache.pumpConfigs) throw new Error('pump configs not loaded');
    const quoteMint = new PublicKey(data.subarray(75, 107)).toBase58();
    const leg = await buildPumpLegIx(conn, { poolKey: addr, user: owner, amountIn,
      inputIsQuote: inputMint === quoteMint, slippagePercent: 0,
      globalConfig: cache.pumpConfigs.globalConfig,
      feeConfig: cache.pumpConfigs.feeConfig });
    /**
     * THE CALLER'S minOut MUST REACH PUMPSWAP'S OWN MINIMUM-OUTPUT FIELD.
     *
     * The SDK's instruction carries its own predicted minimum, which can sit
     * BELOW the caller's. Both shapes this builder emits keep the minimum at
     * offset 16 (pump_amm IDL):
     *   sell                 base_amount_in u64 | min_quote_amount_out u64
     *   buy_exact_quote_in   spendable_quote_in u64 | min_base_amount_out u64
     * The field is only ever RAISED to the floor, never lowered.
     */
    if (minOut > 0n) {
      const disc = leg.ix.data.subarray(0, 8).toString('hex');
      if (disc !== '33e685a4017f83ad' && disc !== 'c62e1552b4d9e870') {
        throw new Error('pump: unexpected instruction ' + disc + ', cannot apply floor');
      }
      if (leg.ix.data.readBigUInt64LE(16) < minOut) {
        const d = Buffer.from(leg.ix.data);
        d.writeBigUInt64LE(minOut, 16);
        leg.ix = new TransactionInstruction({ programId: leg.ix.programId, keys: leg.ix.keys, data: d });
      }
    }
    return leg;
  }
  if (meta.venue === 'Whirlpool') {
    const a = new PublicKey(data.subarray(101, 133)).toBase58();
    const b = new PublicKey(data.subarray(181, 213)).toBase58();
    return buildWhirlpoolSwapIx({ ...common, opt: {
      tokenProgramA: await tokenProgramOf(conn, a),
      tokenProgramB: await tokenProgramOf(conn, b) } });
  }
  /**
   * Raydium v4 and Meteora DAMM v2. A venue that can be priced but not built
   * cannot be simulated, so its quotes could never be checked against the chain.
   */
  if (meta.venue === 'Raydium v4') {
    const coin = new PublicKey(data.subarray(400, 432)).toBase58();
    const pc = new PublicKey(data.subarray(432, 464)).toBase58();
    const z = coin === inputMint;
    return buildRayV4SwapIx({ ...common, opt: {
      tokenProgramIn: await tokenProgramOf(conn, z ? coin : pc),
      tokenProgramOut: await tokenProgramOf(conn, z ? pc : coin) } });
  }
  if (meta.venue === 'Meteora DAMM v2') {
    return buildDamm2SwapIx(conn, { poolData: data, pool: addr, owner, inputMint, amountIn, minOut });
  }
  throw new Error('no builder for ' + meta.venue);
}

/** buildLeg under its library name. */
export const buildSwapIx = buildLeg;

/**
 * Find an address holding `mint` in its CANONICAL ATA, with enough SOL to pay
 * simulated rent. The builders derive ATAs, so a large token account that is not
 * an ATA is unusable.
 *
 * The holder list is built once per mint and every later size is answered from
 * memory. An EMPTY list is not cached for long: getTokenLargestAccounts is refused
 * by some providers (and for WSOL by others), and caching one refusal would make
 * a whole run read "no signer" for a token with no shortage of large holders.
 */
const holderCache = new Map();      // mint|program -> {list, at}
const EMPTY_RETRY_MS = 30000;
export async function findSigner(conn, mint, minAmount, tokenProgram = TOKEN_PROGRAM) {
  const key = String(mint) + '|' + String(tokenProgram);
  const cached = holderCache.get(key);
  let list = cached && (cached.list.length || Date.now() - cached.at < EMPTY_RETRY_MS)
    ? cached.list : null;
  if (!list) {
    /**
     * RETRY ACROSS PROVIDERS, AND CACHE ONLY WHAT WAS ACTUALLY FETCHED.
     *
     * Measured 2026-09-17: some providers refuse getTokenLargestAccounts outright, and
     * some refuse it for WSOL ("Too many accounts requested"). A single refusal must
     * not become a cached "no signer" answer, so a failed fetch is retried and only
     * a real result is cached.
     */
    let fetched = false;
    for (let attempt = 0; attempt < 4 && !fetched; attempt++) {
    list = [];
    try {
      const big = await conn.getTokenLargestAccounts(new PublicKey(mint));
      const rows = (big.value ?? []).slice(0, 20);
      if (rows.length) {
        const infos = await conn.getMultipleAccountsInfo(rows.map((r) => r.address), 'confirmed');
        const owners = [];
        rows.forEach((r, i) => {
          const inf = infos[i];
          if (!inf || inf.data.length < 72) return;
          const owner = new PublicKey(inf.data.subarray(32, 64));
          /**
           * The ATA address is f(owner, TOKEN PROGRAM, mint), so a Token-2022
           * mint checked against the classic program derives an address that
           * can never match and every holder is rejected.
           */
          const ata = PublicKey.findProgramAddressSync(
            [owner.toBuffer(), tokenProgram.toBuffer(), new PublicKey(mint).toBuffer()],
            ATA_PROGRAM)[0];
          if (!ata.equals(r.address)) return;
          owners.push({ owner, amount: BigInt(r.amount) });
        });
        if (owners.length) {
          // One batched lamport check: simulation still charges the signer rent.
          const bals = await conn.getMultipleAccountsInfo(owners.map((o) => o.owner), 'confirmed');
          owners.forEach((o, i) => { if ((bals[i]?.lamports ?? 0) >= 30_000_000) list.push(o); });
          list.sort((a, b) => (b.amount > a.amount ? 1 : b.amount < a.amount ? -1 : 0));
        }
      }
      fetched = true;
    } catch { /* this provider refused; the pool rotates, so the next attempt goes elsewhere */ }
    }
    if (fetched) holderCache.set(key, { list, at: Date.now() });
  }
  const hit = list.find((o) => o.amount >= minAmount);
  return hit ? hit.owner : null;
}
