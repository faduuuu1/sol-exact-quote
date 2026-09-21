/**
 * clmm-math.ts — exact concentrated-liquidity swap math, in integer arithmetic.
 *
 * WHY THIS EXISTS
 * ---------------
 * Detection currently costs ~2,500 ms because both quote legs go through
 * Jupiter at one call per second. Measured gaps have a ~2 second half-life, so
 * the edge is usually gone before the transaction is even built. Pool state
 * arrives over RPC in ~120 ms; the only reason to wait on an API is that we
 * could not price a swap ourselves. This file removes that reason.
 *
 * EXACT, NOT APPROXIMATE — THE WHOLE POINT
 * ----------------------------------------
 * Every cheap approximation tried in this project has produced a false profit:
 *
 *   - mid-price "depth" reported +0.1785% on trades that really lost 14-75%
 *   - V3 virtual reserves (x = L/sqrtP) overstated output at EVERY impact cap,
 *     turning a real -$1.24 into a claimed +$89.74
 *   - assuming a fee tier instead of reading it made a 1% pool's no-arb band
 *     look like +0.36% profit for 25 consecutive slots
 *
 * The common thread: each treated the pool as a single smooth curve. A
 * concentrated-liquidity pool is a PIECEWISE curve — liquidity changes at every
 * initialized tick — and the error is always in the optimistic direction.
 *
 * So this implements the real thing: integer Q64.64 arithmetic, tick-by-tick
 * traversal, liquidity updated at each crossing, fees taken from the input.
 * It is the same algorithm the on-chain programs run, which is the only
 * standard that matters, because they are what actually executes the trade.
 *
 * REFUSAL BEATS APPROXIMATION
 * ---------------------------
 * If a swap runs past the tick data we loaded, `swapExactIn` returns an error
 * rather than extrapolating. A missing quote costs one skipped opportunity. A
 * wrong quote costs a real transaction, and this project has paid that price
 * often enough to prefer the former.
 *
 * Conventions: token0/token1 are the pool's mintA/mintB. `aToB` (Uniswap's
 * zeroForOne) means selling token0 for token1, which moves the price DOWN.
 */

const Q64 = 1n << 64n;

/** Tick bounds — identical on Raydium CLMM and Orca Whirlpool. */
export const MIN_TICK = -443636;
export const MAX_TICK = 443636;

function mulDivCeil(a: bigint, b: bigint, d: bigint): bigint {
  if (d === 0n) throw new Error('division by zero');
  const p = a * b;
  return p / d + (p % d === 0n ? 0n : 1n);
}
function mulDivFloor(a: bigint, b: bigint, d: bigint): bigint {
  if (d === 0n) throw new Error('division by zero');
  return (a * b) / d;
}

/**
 * sqrt(1.0001^tick) in Q64.64.
 *
 * The standard bit-decomposition: 1.0001^(2^i) is precomputed for each bit of
 * |tick| in Q128, multiplied together, then shifted down. Floating point is NOT
 * used — Math.pow drifts, and a tick boundary that is off by one unit silently
 * changes how much input is consumed before a crossing.
 */
export function tickToSqrtPriceX64(tick: number): bigint {
  if (!Number.isInteger(tick) || tick < MIN_TICK || tick > MAX_TICK) {
    throw new Error(`tick ${tick} out of range`);
  }
  const abs = BigInt(Math.abs(tick));
  let ratio: bigint =
    (abs & 0x1n) !== 0n
      ? 0xfffcb933bd6fad37aa2d162d1a594001n
      : 0x100000000000000000000000000000000n;

  const FACTORS: Array<[bigint, bigint]> = [
    [0x2n, 0xfff97272373d413259a46990580e213an],
    [0x4n, 0xfff2e50f5f656932ef12357cf3c7fdccn],
    [0x8n, 0xffe5caca7e10e4e61c3624eaa0941cd0n],
    [0x10n, 0xffcb9843d60f6159c9db58835c926644n],
    [0x20n, 0xff973b41fa98c081472e6896dfb254c0n],
    [0x40n, 0xff2ea16466c96a3843ec78b326b52861n],
    [0x80n, 0xfe5dee046a99a2a811c461f1969c3053n],
    [0x100n, 0xfcbe86c7900a88aedcffc83b479aa3a4n],
    [0x200n, 0xf987a7253ac413176f2b074cf7815e54n],
    [0x400n, 0xf3392b0822b70005940c7a398e4b70f3n],
    [0x800n, 0xe7159475a2c29b7443b29c7fa6e889d9n],
    [0x1000n, 0xd097f3bdfd2022b8845ad8f792aa5825n],
    [0x2000n, 0xa9f746462d870fdf8a65dc1f90e061e5n],
    [0x4000n, 0x70d869a156d2a1b890bb3df62baf32f7n],
    [0x8000n, 0x31be135f97d08fd981231505542fcfa6n],
    [0x10000n, 0x9aa508b5b7a84e1c677de54f3e99bc9n],
    [0x20000n, 0x5d6af8dedb81196699c329225ee604n],
    [0x40000n, 0x2216e584f5fa1ea926041bedfe98n],
    [0x80000n, 0x48a170391f7dc42444e8fa2n],
  ];
  for (const [bit, mul] of FACTORS) {
    if ((abs & bit) !== 0n) ratio = (ratio * mul) >> 128n;
  }
  if (tick > 0) ratio = ((1n << 256n) - 1n) / ratio;

  // Q128 -> Q64, rounding up so a boundary is never understated.
  const shifted = ratio >> 64n;
  return shifted + ((ratio & ((1n << 64n) - 1n)) === 0n ? 0n : 1n);
}

/** Amount of token0 between two sqrt prices: L * (sb - sa) * 2^64 / (sb * sa). */
export function amount0Delta(
  sqrtA: bigint, sqrtB: bigint, liquidity: bigint, roundUp: boolean,
): bigint {
  const [lo, hi] = sqrtA <= sqrtB ? [sqrtA, sqrtB] : [sqrtB, sqrtA];
  if (lo <= 0n) throw new Error('sqrt price must be positive');
  const numerator = (liquidity << 64n) * (hi - lo);
  const denominator = hi * lo;
  return roundUp
    ? numerator / denominator + (numerator % denominator === 0n ? 0n : 1n)
    : numerator / denominator;
}

/** Amount of token1 between two sqrt prices: L * (sb - sa) / 2^64. */
export function amount1Delta(
  sqrtA: bigint, sqrtB: bigint, liquidity: bigint, roundUp: boolean,
): bigint {
  const [lo, hi] = sqrtA <= sqrtB ? [sqrtA, sqrtB] : [sqrtB, sqrtA];
  return roundUp ? mulDivCeil(liquidity, hi - lo, Q64) : mulDivFloor(liquidity, hi - lo, Q64);
}

/** Next sqrt price after adding `amount` of token0 (price falls). */
export function nextSqrtPriceFromAmount0(
  sqrtP: bigint, liquidity: bigint, amount: bigint,
): bigint {
  if (amount === 0n) return sqrtP;
  const numerator = liquidity << 64n;
  const denominator = numerator + amount * sqrtP;
  return mulDivCeil(numerator, sqrtP, denominator);
}

/** Next sqrt price after adding `amount` of token1 (price rises). */
export function nextSqrtPriceFromAmount1(
  sqrtP: bigint, liquidity: bigint, amount: bigint,
): bigint {
  if (amount === 0n) return sqrtP;
  return sqrtP + mulDivFloor(amount, Q64, liquidity);
}

/** One initialized tick: the price boundary and how liquidity changes across it. */
export interface InitializedTick {
  index: number;
  /** Signed change in liquidity when crossing upward. */
  liquidityNet: bigint;
}

export interface SwapPoolState {
  sqrtPriceX64: bigint;
  liquidity: bigint;
  tickCurrent: number;
  /** Fee as a FRACTION of input, e.g. 0.0025. Normalise before calling —
   *  Raydium reports a fraction, Orca reports millionths. */
  feeRate: number;
  /** Ascending by index, covering the range the swap may traverse. */
  ticks: InitializedTick[];
  /**
   * Raydium CLMM's DYNAMIC FEE, when the pool has one. Absent means the pool
   * charges `feeRate` alone.
   *
   * The program charges `base_fee_rate + dynamic_fee_rate` (capped at 10%), where
   * the dynamic part is quadratic in a volatility accumulator that DECAYS with time
   * and RISES as a swap crosses tick-spacing groups — the same shape as Meteora
   * DLMM's variable fee. Ignoring it undercharges the fee and overstates the
   * output, which is the direction that invents edges: measured -6.23 bps on
   * tqeNC7AN at every size, constant, on freshly read state.
   *
   * The caller supplies the state AFTER applying the time decay (update_reference),
   * because that needs the chain clock rather than anything in this module.
   */
  dynamicFee?: DynamicFee;
}

export interface DynamicFee {
  /** dynamic_fee_control, over DYNAMIC_FEE_CONTROL_DENOMINATOR (100,000). */
  control: number;
  /**
   * volatility_reference and tick_spacing_index_reference, AFTER the time decay.
   *
   * The accumulator is always derived from these, never taken from the stored
   * field: measured on tqeNC7AN in one A/B against the chain, pricing off the
   * stored accumulator overcharged by 1.20 bps while the decayed reference — half
   * of it, the pool's reduction_factor being 5000 — matched.
   */
  volatilityReference: number;
  indexReference: number;
  maxVolatilityAccumulator: number;
  /**
   * The GROUP the accumulator counts in, and the multiplier in the fee formula:
   * Raydium CLMM uses the pool's tick_spacing, Orca Whirlpool its oracle's
   * tick_group_size. Both programs recompute the fee at every group boundary.
   */
  groupSize: number;
}

const VOLATILITY_ACCUMULATOR_SCALE = 10_000n;
const DYNAMIC_FEE_CONTROL_DENOMINATOR = 100_000n;
const MAX_FEE_RATE_NUMERATOR = 100_000n;

/** pool_fee.rs: negative ticks that are not on a boundary round AWAY from zero. */
export function tickSpacingIndexFromTick(tick: number, spacing: number): number {
  const q = Math.trunc(tick / spacing);
  return (tick % spacing === 0 || tick >= 0) ? q : q - 1;
}

/** Raydium compute_dynamic_fee_rate / Orca compute_adaptive_fee_rate: ceil(control * (va * group)^2 / 1e13). */
function dynamicFeeMicro(dyn: DynamicFee, volatilityAccumulator: number): bigint {
  const crossed = BigInt(volatilityAccumulator) * BigInt(dyn.groupSize);
  const squared = crossed * crossed;
  const denom = DYNAMIC_FEE_CONTROL_DENOMINATOR
    * VOLATILITY_ACCUMULATOR_SCALE * VOLATILITY_ACCUMULATOR_SCALE;
  const rate = (BigInt(dyn.control) * squared + denom - 1n) / denom;
  return rate > MAX_FEE_RATE_NUMERATOR ? MAX_FEE_RATE_NUMERATOR : rate;
}

export interface SwapResult {
  amountIn: bigint;
  amountOut: bigint;
  sqrtPriceAfter: bigint;
  tickAfter: number;
  ticksCrossed: number;
  feePaid: bigint;
}

export interface SwapError {
  error: string;
}

/**
 * Exact-input swap with full tick traversal.
 *
 * Returns an error when the swap would move beyond the supplied tick data — the
 * caller must widen the loaded range and retry rather than trusting a partial
 * fill. Silently returning the partial result would understate price impact,
 * which is the exact direction that manufactures phantom arbitrage.
 */
export function swapExactIn(
  pool: SwapPoolState,
  amountIn: bigint,
  aToB: boolean,
): SwapResult | SwapError {
  if (amountIn <= 0n) return { error: 'amountIn must be positive' };
  if (pool.liquidity <= 0n) return { error: 'pool has zero liquidity at current tick' };
  if (!(pool.feeRate >= 0 && pool.feeRate < 1)) {
    return { error: `implausible feeRate ${pool.feeRate}` };
  }

  // Fee is charged on input, held in millionths to stay in integers.
  const baseFeeMicro = BigInt(Math.round(pool.feeRate * 1_000_000));
  const dyn = pool.dynamicFee;
  /**
   * The rate for THIS step. Before any group is crossed the program charges the
   * stored accumulator; after that it recomputes it from the (decayed) reference
   * and how far the price has walked, so a deep swap pays more than a shallow one.
   */
  const feeMicroAt = (currentTick: number): bigint => {
    if (!dyn || dyn.control === 0) return baseFeeMicro;
    const va = Math.min(
      dyn.volatilityReference
        + Math.abs(dyn.indexReference - tickSpacingIndexFromTick(currentTick, dyn.groupSize))
          * Number(VOLATILITY_ACCUMULATOR_SCALE),
      dyn.maxVolatilityAccumulator,
    );
    const total = baseFeeMicro + dynamicFeeMicro(dyn, va);
    return total > MAX_FEE_RATE_NUMERATOR ? MAX_FEE_RATE_NUMERATOR : total;
  };
  let remaining = amountIn;
  let sqrtP = pool.sqrtPriceX64;
  let liquidity = pool.liquidity;
  let tick = pool.tickCurrent;
  let out = 0n;
  let feePaid = 0n;
  let crossed = 0;

  // Candidate boundaries in the direction of travel.
  const sorted = [...pool.ticks].sort((x, y) => x.index - y.index);
  let path = aToB
    ? sorted.filter((t) => t.index <= tick).reverse() // descending
    : sorted.filter((t) => t.index > tick);           // ascending

  /**
   * GROUP BOUNDARIES ARE FEE BOUNDARIES.
   *
   * Both programs bound each swap step at the next tick GROUP boundary while the
   * accumulator can still rise (Orca get_bounded_sqrt_price_target, Raydium
   * get_spacing_bounded_price), and recompute the fee there. Stepping only at
   * initialized ticks would hold the start-of-range fee across the whole range —
   * undercharging a deep swap, the direction that invents edges. So the group
   * boundaries go in as extra steps with no liquidity change, only inside the
   * range where the accumulator is below its cap (beyond it the fee is constant)
   * and never past the farthest LOADED tick, so they cannot extend coverage.
   */
  if (dyn && dyn.control !== 0 && dyn.groupSize > 0 && path.length) {
    const G = dyn.groupSize;
    const maxDelta = Math.ceil(Math.max(0, dyn.maxVolatilityAccumulator - dyn.volatilityReference)
      / Number(VOLATILITY_ACCUMULATOR_SCALE));
    const coreLo = (dyn.indexReference - maxDelta) * G;
    const coreHi = (dyn.indexReference + maxDelta + 1) * G;
    const farthest = path[path.length - 1]?.index ?? tick;
    const have = new Set(path.map((t) => t.index));
    const extra: InitializedTick[] = [];
    if (aToB) {
      for (let b = Math.floor(tick / G) * G; b >= farthest && extra.length < 4096; b -= G) {
        if (b >= coreLo && b <= coreHi && !have.has(b)) extra.push({ index: b, liquidityNet: 0n });
      }
    } else {
      for (let b = (Math.floor(tick / G) + 1) * G; b <= farthest && extra.length < 4096; b += G) {
        if (b >= coreLo && b <= coreHi && !have.has(b)) extra.push({ index: b, liquidityNet: 0n });
      }
    }
    if (extra.length) {
      path = [...path, ...extra].sort((x, y) => (aToB ? y.index - x.index : x.index - y.index));
    }
  }

  let pathIdx = 0;
  const MAX_STEPS = 4096;

  for (let step = 0; remaining > 0n && step < MAX_STEPS; step++) {
    if (liquidity <= 0n) return { error: 'liquidity exhausted inside loaded range' };

    // Fee comes off the input before it moves the price, at THIS step's rate.
    const feeMicro = feeMicroAt(tick);
    const feeOnRemaining = mulDivCeil(remaining, feeMicro, 1_000_000n);
    const remainingAfterFee = remaining - feeOnRemaining;
    if (remainingAfterFee <= 0n) {
      feePaid += remaining;
      remaining = 0n;
      break;
    }

    const boundary = path[pathIdx];
    if (!boundary) {
      return {
        error: `swap exceeds loaded tick range (crossed ${crossed}); load more tick arrays`,
      };
    }
    const sqrtTarget = tickToSqrtPriceX64(boundary.index);

    // How much input would move the price exactly to that boundary?
    const maxIn = aToB
      ? amount0Delta(sqrtTarget, sqrtP, liquidity, true)
      : amount1Delta(sqrtP, sqrtTarget, liquidity, true);

    if (remainingAfterFee <= maxIn) {
      // Terminates inside this range.
      const sqrtNext = aToB
        ? nextSqrtPriceFromAmount0(sqrtP, liquidity, remainingAfterFee)
        : nextSqrtPriceFromAmount1(sqrtP, liquidity, remainingAfterFee);
      out += aToB
        ? amount1Delta(sqrtNext, sqrtP, liquidity, false)
        : amount0Delta(sqrtP, sqrtNext, liquidity, false);
      feePaid += feeOnRemaining;
      sqrtP = sqrtNext;
      remaining = 0n;
      break;
    }

    // Consume the whole range and cross the tick. The fee scales with the
    // portion actually used, not with everything still in hand.
    const fee = mulDivCeil(maxIn, feeMicro, 1_000_000n - feeMicro);
    out += aToB
      ? amount1Delta(sqrtTarget, sqrtP, liquidity, false)
      : amount0Delta(sqrtP, sqrtTarget, liquidity, false);
    feePaid += fee;
    remaining -= maxIn + fee;
    sqrtP = sqrtTarget;

    // Crossing down subtracts liquidityNet; crossing up adds it.
    liquidity += aToB ? -boundary.liquidityNet : boundary.liquidityNet;
    tick = aToB ? boundary.index - 1 : boundary.index;
    crossed++;
    pathIdx++;
  }

  if (remaining > 0n) return { error: 'swap did not converge within step limit' };
  if (out <= 0n) return { error: 'zero output' };

  return {
    amountIn,
    amountOut: out,
    sqrtPriceAfter: sqrtP,
    tickAfter: tick,
    ticksCrossed: crossed,
    feePaid,
  };
}

export function isSwapError(r: SwapResult | SwapError): r is SwapError {
  return (r as SwapError).error !== undefined;
}
