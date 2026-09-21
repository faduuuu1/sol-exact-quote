/**
 * dlmm-swap.mjs — exact local swap math for Meteora DLMM (Liquidity Book).
 *
 * WHAT THIS COMPLETES
 * -------------------
 * mids.mjs gives a DLMM MID price; it cannot price a trade, because DLMM
 * liquidity sits in discrete bins held in separate BinArray accounts. Without
 * this, DLMM — the highest-movement venue we watch, and one of the two venues
 * the actual winners trade — had to go through a ~600ms Jupiter round trip while
 * every other decision could be local.
 *
 * WHAT IS ESTABLISHED, AND HOW
 * ----------------------------
 * Nothing here is fitted to a price. Each piece was pinned separately first:
 *
 *   layout   dlmm-binarray.mjs — four independent anchors (PDA exists, lb_pair
 *            back-reference, index == floor(active/70) signed, exact byte
 *            length) passing on 4 pools including 3 negative active_ids
 *   price    dlmm-fee.mjs — (1 + bin_step/1e4)^id in Q64.64, confirmed because
 *            the implied fees it produces land in the plausible 0.02-0.25% band
 *   fee      base_factor * bin_step * 10 / 1e9, confirmed EXACTLY on a 125-step
 *            pool (0.250000% implied vs 0.250000% computed)
 *
 * THE BIN WALK
 * ------------
 * Selling X for Y moves DOWN in bin id (price falls); selling Y for X moves UP.
 * Each bin holds only the asset it is waiting to sell, which is why bins below
 * active hold Y and bins above hold X — a pattern a wrong layout would not
 * reproduce. Fees are charged on the INPUT and rounded UP, against us, matching
 * the on-chain program: rounding the other way invents profit, which is the
 * failure mode this project keeps hitting.
 */
import { PublicKey } from '@solana/web3.js';
import { decodeLbPair, decodeBinArray, binArrayIndexOf, binArrayAddress,
  BINS_PER_ARRAY } from './dlmm-binarray.mjs';
import { decodeParams, totalFeeRate, priceFromId, FEE_PRECISION, Q64,
  decayedReferences, feeRateAt, MIN_USABLE_PRICE } from './dlmm-fee.mjs';

export const DLMM_PROGRAM = new PublicKey('LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo');

/** Fee charged on an input amount, rounded UP (against us, as on chain). */
export function feeOn(amount, rate) {
  if (rate <= 0n) return 0n;
  return (amount * rate + FEE_PRECISION - 1n) / FEE_PRECISION;
}

/**
 * Swap within ONE bin.
 * @param swapForY true = paying X, receiving Y (id decreases)
 * @returns {consumed, out, binExhausted}
 */
export function swapBin(bin, price, swapForY, amountInLeft, rate) {
  const maxOut = swapForY ? bin.amountY : bin.amountX;
  if (maxOut === 0n) return { consumed: 0n, out: 0n, binExhausted: true };

  // Input required to drain this bin entirely, before fee.
  const maxIn = swapForY
    ? (maxOut * Q64 + price - 1n) / price          // Y out -> X in, round up
    : (maxOut * price + Q64 - 1n) / Q64;           // X out -> Y in, round up
  /**
   * FEE ON THE GROSS, NOT ON THE NET.
   *
   * `maxIn` is the input needed to drain the bin BEFORE fee, so the fee sits
   * ON TOP of it: gross = maxIn / (1 - rate). Writing `maxIn + fee(maxIn)`
   * charges rate x NET, which is rate/(1+rate) of gross — an under-charge of
   * roughly fee^2/(1-fee) across the whole leg, doubled on a round trip:
   *
   *     0.10% pool  0.010 bps      1.00% pool   1.010 bps
   *     0.25% pool  0.063 bps     10.00% pool   111 bps
   *
   * At the 1-2% fees typical of memecoin DLMM pools that is 2-8 bps of pure
   * invented profit against a 5 bps gate. Meteora uses the (PRECISION - rate)
   * denominator for exactly this branch.
   *
   * Validation missed it because it is EXACTLY ZERO for a swap that stays
   * inside the active bin, and dlmm-fee.mjs deliberately probes at 0.002 SOL
   * to stay in-bin.
   */
  const grossIn = (maxIn * FEE_PRECISION + (FEE_PRECISION - rate) - 1n)
    / (FEE_PRECISION - rate);
  const maxInWithFee = grossIn;

  if (amountInLeft >= maxInWithFee) {
    return { consumed: maxInWithFee, out: maxOut, binExhausted: true };
  }
  // Partial fill: fee comes out of what we bring, remainder buys output.
  const fee = feeOn(amountInLeft, rate);
  const net = amountInLeft - fee;
  const out = swapForY ? (net * price) >> 64n : (net * Q64) / price;
  return { consumed: amountInLeft, out: out > maxOut ? maxOut : out, binExhausted: false };
}

/**
 * Exact-in swap across bins.
 *
 * `bins` maps bin id -> {amountX, amountY}. The caller supplies it from the
 * BinArrays it already fetched; running out of supplied bins is reported rather
 * than silently truncating the walk, because a truncated walk understates impact
 * and therefore INVENTS profit.
 */
export function swapExactIn({ activeId, binStep, bins, amountIn, swapForY, rate,
  params, refs, maxBins = 200 }) {
  let id = activeId;
  let left = BigInt(amountIn);
  let out = 0n;
  let crossed = 0;

  while (left > 0n && crossed < maxBins) {
    const bin = bins.get(id);
    if (bin === undefined) {
      return { out, consumed: BigInt(amountIn) - left, crossed,
        truncated: true, reason: 'no bin data at id ' + id };
    }
    const price = priceFromId(binStep, id);
    // Underflowed out of Q64.64 range — see MIN_USABLE_PRICE. Refusing here
    // is what stops a division by zero on one side and free bins on the other.
    if (price < MIN_USABLE_PRICE) {
      return { out, consumed: BigInt(amountIn) - left, crossed,
        truncated: true, reason: 'price underflow at bin ' + id };
    }
    // Fee is recomputed AT THIS BIN: the volatility accumulator grows as the
    // swap walks away from the reference bin, so a deep trade pays more than
    // a shallow one. A fixed rate under-charges and overstates output.
    const binRate = (params && refs) ? feeRateAt(binStep, id, refs, params) : rate;
    const r = swapBin(bin, price, swapForY, left, binRate);
    left -= r.consumed;
    out += r.out;
    if (!r.binExhausted) break;             // input exhausted inside this bin
    id += swapForY ? -1 : 1;
    crossed++;
  }
  return { out, consumed: BigInt(amountIn) - left, crossed,
    truncated: left > 0n, endBinId: id,
    reason: left > 0n ? 'ran out of liquidity within ' + maxBins + ' bins' : null };
}

/**
 * Fetch a pool and enough BinArrays around the active bin to price `spread`
 * bins in each direction. One batched getMultipleAccountsInfo.
 */
export async function loadPool(conn, poolAddr, spread = 140) {
  const pk = new PublicKey(poolAddr);
  const info = await conn.getAccountInfo(pk, 'processed');
  if (!info || !info.owner.equals(DLMM_PROGRAM)) return null;
  const pair = decodeLbPair(info.data);
  const par = decodeParams(info.data);
  const rate = totalFeeRate(pair.binStep, par);
  // Decay the stored accumulator to NOW before pricing anything.
  const refs = decayedReferences(par, pair.activeId, Math.floor(Date.now() / 1000));

  const lo = binArrayIndexOf(pair.activeId - spread);
  const hi = binArrayIndexOf(pair.activeId + spread);
  const idxs = [];
  for (let i = lo; i <= hi; i++) idxs.push(i);
  const addrs = idxs.map((i) => binArrayAddress(pk, i));
  const infos = await conn.getMultipleAccountsInfo(addrs, 'processed');

  const bins = new Map();
  infos.forEach((ai, n) => {
    if (!ai || !ai.owner.equals(DLMM_PROGRAM)) return;   // array may not exist yet
    const dec = decodeBinArray(ai.data);
    dec.bins.forEach((b, k) => {
      bins.set(idxs[n] * BINS_PER_ARRAY + k, { amountX: b.amountX, amountY: b.amountY });
    });
  });
  return { ...pair, params: par, rate, refs, bins, arraysLoaded: infos.filter(Boolean).length };
}

/** Convenience: price WSOL->mint or mint->WSOL on a loaded pool. */
export function quoteLocal(pool, inputMint, amountIn) {
  const swapForY = pool.mintX === inputMint;
  if (!swapForY && pool.mintY !== inputMint) return null;   // mint not in pool
  return swapExactIn({
    activeId: pool.activeId, binStep: pool.binStep, bins: pool.bins,
    amountIn, swapForY, rate: pool.rate,
    params: pool.params, refs: pool.refs,
  });
}
