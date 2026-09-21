/**
 * dlmm-fee.mjs — pin down DLMM's price convention and fee, empirically.
 *
 * WHY BEFORE TRAVERSAL
 * --------------------
 * A bin walk is worthless if the per-bin price or the fee is wrong. Reading
 * Raydium's fee at byte 43 (the protocol's 12% CUT) instead of byte 47 (the
 * 0.02% trade fee) once made a 1% pool look like +0.36% profit. So both are
 * settled here, against Jupiter, before any traversal is written.
 *
 * THE TEST
 * --------
 * For a swap small enough to stay inside the ACTIVE bin, impact is nil and
 *
 *     out_raw = in_raw * price_raw * (1 - fee)
 *
 * so `out/in` divided by the computed price yields (1 - fee) directly. Two
 * independent things are checked against that single number:
 *
 *   PRICE   (1 + bin_step/10000)^active_id, computed in Q64.64
 *   FEE     base_factor * bin_step * 10 / 1e9, plus the variable component
 *
 * If the price convention were wrong, the implied fee would come out absurd
 * (negative, or tens of percent) rather than landing near the formula — so this
 * one measurement constrains both.
 *
 *   (self-check: tools/verify.mjs on a DLMM pool)
 */
import { PublicKey } from '@solana/web3.js';
import { decodeLbPair, decodeBinArray, binArrayIndexOf, binArrayAddress,
  BINS_PER_ARRAY } from './dlmm-binarray.mjs';

const DLMM_PROGRAM = new PublicKey('LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo');
const WSOL = 'So11111111111111111111111111111111111111112';

/**
 * StaticParameters live at offset 8, VariableParameters at 40.
 * Verified below by checking every value is in a plausible range on real pools.
 */
export function decodeParams(d) {
  return {
    baseFactor: d.readUInt16LE(8),
    filterPeriod: d.readUInt16LE(10),
    decayPeriod: d.readUInt16LE(12),
    reductionFactor: d.readUInt16LE(14),
    variableFeeControl: d.readUInt32LE(16),
    maxVolatilityAccumulator: d.readUInt32LE(20),
    minBinId: d.readInt32LE(24),
    maxBinId: d.readInt32LE(28),
    protocolShare: d.readUInt16LE(32),
    baseFeePowerFactor: d.readUInt8(34),
    volatilityAccumulator: d.readUInt32LE(40),
    volatilityReference: d.readUInt32LE(44),
    indexReference: d.readInt32LE(48),
    lastUpdateTimestamp: Number(d.readBigInt64LE(56)),
  };
}

/** Meteora fee precision: rates are expressed in 1e9ths. */
export const FEE_PRECISION = 1_000_000_000n;
export const MAX_FEE_RATE = 100_000_000n;          // 10%

export function baseFeeRate(binStep, baseFactor, powerFactor = 0) {
  return BigInt(binStep) * BigInt(baseFactor) * 10n * (10n ** BigInt(powerFactor));
}

export function variableFeeRate(binStep, volatilityAccumulator, variableFeeControl) {
  if (!variableFeeControl) return 0n;
  const va = BigInt(volatilityAccumulator) * BigInt(binStep);
  // (va^2 * control) scaled down by 1e11, rounded UP (Meteora rounds against you)
  return (va * va * BigInt(variableFeeControl) + 99_999_999_999n) / 100_000_000_000n;
}

/**
 * The volatility accumulator DECAYS, and the stored value is stale.
 *
 * Meteora refreshes it lazily: the number sitting in the account is whatever
 * it was at `last_update_timestamp`, and the program recomputes it at swap
 * time. Using the stored value directly over-charges — measured as a
 * perfectly CONSTANT -1.177 bps on a 125-step pool across four sizes with
 * zero bins crossed, exactly the size of the variable component.
 *
 *   elapsed >= filter_period -> reference resets to the active bin, and
 *   elapsed >= decay_period  -> volatility_reference collapses to 0
 *                               else it is scaled by reduction_factor
 */
export function decayedReferences(p, activeId, nowSec) {
  const elapsed = nowSec - p.lastUpdateTimestamp;
  if (elapsed >= p.filterPeriod) {
    return {
      indexReference: activeId,
      volatilityReference: elapsed < p.decayPeriod
        ? Math.floor(p.volatilityAccumulator * p.reductionFactor / 10000)
        : 0,
    };
  }
  return { indexReference: p.indexReference,
    volatilityReference: p.volatilityReference };
}

/**
 * The accumulator also moves DURING a swap: every bin crossed pushes the
 * active id further from the reference, so the fee RISES as the trade eats
 * through liquidity. Holding it fixed under-charges and made local output
 * drift +0.74 bps by 11 bins — in the direction that invents profit.
 */
export function accumulatorAt(binId, refs, p) {
  const va = refs.volatilityReference
    + Math.abs(binId - refs.indexReference) * 10000;
  return Math.min(va, p.maxVolatilityAccumulator || va);
}

/** Fee rate at one bin, given decayed references. */
export function feeRateAt(binStep, binId, refs, p) {
  const base = baseFeeRate(binStep, p.baseFactor, p.baseFeePowerFactor);
  const va = accumulatorAt(binId, refs, p);
  const t = base + variableFeeRate(binStep, va, p.variableFeeControl);
  return t > MAX_FEE_RATE ? MAX_FEE_RATE : t;
}

export function totalFeeRate(binStep, p) {
  const t = baseFeeRate(binStep, p.baseFactor, p.baseFeePowerFactor)
    + variableFeeRate(binStep, p.volatilityAccumulator, p.variableFeeControl);
  return t > MAX_FEE_RATE ? MAX_FEE_RATE : t;
}

/** price(id) = (1 + bin_step/1e4)^id, as Q64.64. Exponent by squaring. */
export const Q64 = 1n << 64n;
/**
 * Smallest price we will act on. Below this the Q64.64 representation has
 * lost so much precision that the swap math stops meaning anything.
 *
 * priceFromId returns 0n once (1+binStep/1e4)^id < 2^-64 — e.g. binStep 20 at
 * id -22695, or binStep 100 at id -5000, both of which occur on real pools.
 * Nothing downstream checked for it, and the two directions failed differently:
 *
 *   swapForY  (maxOut * Q64 + price - 1n) / price  -> RangeError, division by
 *             zero, which unwound the whole localRoundTrip and lost every
 *             other pool pair for that mint
 *   !swapForY maxIn rounds to 0, so `amountInLeft >= maxInWithFee` is
 *             trivially true and the walk harvests a FULL BIN FOR FREE, bin
 *             after bin — measured 5e8-to-1 output returned as ok:true with
 *             no truncation flag
 *
 * A price this small is not a trade, it is a decode that has run out of range.
 * Refuse rather than return a number.
 */
export const MIN_USABLE_PRICE = 1024n;

export function priceFromId(binStep, id) {
  // base = 1 + binStep/10000 in Q64.64
  let base = Q64 + (BigInt(binStep) * Q64) / 10_000n;
  let n = BigInt(Math.abs(id));
  let result = Q64;
  while (n > 0n) {
    if (n & 1n) result = (result * base) >> 64n;
    base = (base * base) >> 64n;
    n >>= 1n;
  }
  if (id < 0) result = (Q64 * Q64) / result;      // invert for negative ids
  return result;
}
