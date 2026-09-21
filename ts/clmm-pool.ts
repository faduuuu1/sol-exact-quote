/**
 * clmm-pool.ts — decode Raydium CLMM and Orca Whirlpool state, including the
 * tick arrays that `clmm-math.ts` needs to price a swap exactly.
 *
 * OFFSETS ARE VERIFIED, NOT REMEMBERED
 * ------------------------------------
 * Every offset below was confirmed against mainnet with a check that cannot
 * pass by luck: the decoded sqrtPrice must lie inside
 * [tickToSqrtPrice(tickCurrent), tickToSqrtPrice(tickCurrent + 1)).
 *
 * That single assertion validates liquidity, sqrtPrice and tickCurrent at once
 * — three independent offsets have to be simultaneously right for a decoded
 * price to land inside its own decoded tick. `assertPoolConsistent` below runs
 * it at load time, because a pool decoded at the wrong offset does not look
 * broken, it looks like an arbitrage.
 *
 *   Raydium CLMM (1544 bytes)   liquidity @237  sqrtPrice @253  tick @269
 *                               tickSpacing @235
 *   Orca Whirlpool (653 bytes)  liquidity @49   sqrtPrice @65   tick @81
 *                               tickSpacing @41  feeRate @45
 *
 * FEE SCALES DIFFER AND THE DIFFERENCE IS 10,000x
 * -----------------------------------------------
 * Orca stores feeRate in MILLIONTHS (400 = 0.04%). Raydium's API reports a
 * FRACTION (0.0025 = 0.25%). Both are normalised to a fraction here. Assuming
 * one scale for the other once turned a 1% pool's no-arb band into a "+0.36%
 * profit" that held for 25 consecutive slots.
 */

import { Connection, PublicKey } from '@solana/web3.js';
import type { InitializedTick, SwapPoolState } from './clmm-math.js';
import { tickToSqrtPriceX64, swapExactIn, isSwapError } from './clmm-math.js';

export const RAY_CLMM_PROGRAM = new PublicKey('CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK');
export const ORCA_WHIRLPOOL_PROGRAM = new PublicKey('whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc');

/** Ticks stored per tick-array account. Fixed by each program's layout. */
const RAY_TICKS_PER_ARRAY = 60;
const ORCA_TICKS_PER_ARRAY = 88;
/** Bytes per tick entry. */
const RAY_TICK_SIZE = 168;
const ORCA_TICK_SIZE = 113;
/** Where the tick list starts inside a tick-array account. */
const RAY_TICKS_OFFSET = 44;
const ORCA_TICKS_OFFSET = 12;

export type Venue = 'ray' | 'orca';

export interface DecodedPool {
  address: string;
  venue: Venue;
  liquidity: bigint;
  sqrtPriceX64: bigint;
  tickCurrent: number;
  tickSpacing: number;
  /** Always a fraction. */
  feeRate: number;
}

function readU128LE(b: Buffer, o: number): bigint {
  let v = 0n;
  for (let i = 15; i >= 0; i--) v = (v << 8n) + BigInt(b[o + i] ?? 0);
  return v;
}

/** Two's-complement i128. liquidityNet is signed and negative on the way out of a range. */
function readI128LE(b: Buffer, o: number): bigint {
  const v = readU128LE(b, o);
  return v >= 1n << 127n ? v - (1n << 128n) : v;
}

/** Floor division that behaves correctly for negative ticks. */
function floorDiv(a: number, b: number): number {
  return Math.floor(a / b);
}

export function decodePool(address: string, venue: Venue, data: Buffer): DecodedPool {
  if (venue === 'ray') {
    if (data.length < 273) throw new Error(`raydium pool ${address} too short (${data.length})`);
    return {
      address, venue,
      liquidity: readU128LE(data, 237),
      sqrtPriceX64: readU128LE(data, 253),
      tickCurrent: data.readInt32LE(269),
      tickSpacing: data.readUInt16LE(235),
      // Raydium's per-pool fee lives in its AmmConfig account, not the pool, so
      // the caller supplies it from the API (already a fraction). Set later.
      feeRate: NaN,
    };
  }
  if (data.length < 85) throw new Error(`orca pool ${address} too short (${data.length})`);
  return {
    address, venue,
    liquidity: readU128LE(data, 49),
    sqrtPriceX64: readU128LE(data, 65),
    tickCurrent: data.readInt32LE(81),
    tickSpacing: data.readUInt16LE(41),
    feeRate: data.readUInt16LE(45) / 1_000_000, // MILLIONTHS -> fraction
  };
}

/**
 * The check that catches a wrong offset. A price decoded at the wrong byte
 * lands outside its own tick essentially always, so this is a strong test.
 */
export function assertPoolConsistent(p: DecodedPool): void {
  if (p.sqrtPriceX64 <= 0n) throw new Error(`${p.address}: sqrtPrice is zero`);
  if (p.tickSpacing <= 0) throw new Error(`${p.address}: tickSpacing ${p.tickSpacing}`);
  const lo = tickToSqrtPriceX64(p.tickCurrent);
  const hi = tickToSqrtPriceX64(p.tickCurrent + 1);
  if (!(p.sqrtPriceX64 >= lo && p.sqrtPriceX64 < hi)) {
    throw new Error(
      `${p.address} (${p.venue}): sqrtPrice ${p.sqrtPriceX64} is outside tick ` +
        `${p.tickCurrent} range [${lo}, ${hi}) — the layout offsets are wrong`,
    );
  }
}

/** Ticks spanned by one tick-array account. */
function arraySpan(venue: Venue, tickSpacing: number): number {
  return (venue === 'ray' ? RAY_TICKS_PER_ARRAY : ORCA_TICKS_PER_ARRAY) * tickSpacing;
}

/** The start index of the tick array containing `tick`. */
export function arrayStartIndex(venue: Venue, tick: number, tickSpacing: number): number {
  const span = arraySpan(venue, tickSpacing);
  return floorDiv(tick, span) * span;
}

/** Derive a tick-array account address. The two programs seed these differently. */
export function tickArrayAddress(
  venue: Venue, pool: PublicKey, startIndex: number,
): PublicKey {
  if (venue === 'ray') {
    // Raydium seeds with the start index as a 4-byte BIG-endian i32.
    const buf = Buffer.alloc(4);
    buf.writeInt32BE(startIndex);
    return PublicKey.findProgramAddressSync(
      [Buffer.from('tick_array'), pool.toBuffer(), buf], RAY_CLMM_PROGRAM,
    )[0];
  }
  // Orca seeds with the start index as a DECIMAL STRING.
  return PublicKey.findProgramAddressSync(
    [Buffer.from('tick_array'), pool.toBuffer(), Buffer.from(startIndex.toString())],
    ORCA_WHIRLPOOL_PROGRAM,
  )[0];
}

/** Parse the initialized ticks out of one tick-array account. */
export function decodeTickArray(venue: Venue, data: Buffer, tickSpacing: number): InitializedTick[] {
  const out: InitializedTick[] = [];
  if (venue === 'ray') {
    const start = data.readInt32LE(40);
    for (let i = 0; i < RAY_TICKS_PER_ARRAY; i++) {
      const o = RAY_TICKS_OFFSET + i * RAY_TICK_SIZE;
      if (o + RAY_TICK_SIZE > data.length) break;
      const liquidityGross = readU128LE(data, o + 20);
      if (liquidityGross === 0n) continue;           // uninitialized
      out.push({ index: data.readInt32LE(o), liquidityNet: readI128LE(data, o + 4) });
    }
    void start;
    return out;
  }
  const start = data.readInt32LE(8);
  for (let i = 0; i < ORCA_TICKS_PER_ARRAY; i++) {
    const o = ORCA_TICKS_OFFSET + i * ORCA_TICK_SIZE;
    if (o + ORCA_TICK_SIZE > data.length) break;
    if (data[o] !== 1) continue;                      // `initialized` flag
    out.push({ index: start + i * tickSpacing, liquidityNet: readI128LE(data, o + 1) });
  }
  return out;
}

export interface LoadedPool extends DecodedPool {
  ticks: InitializedTick[];
  /** How many tick arrays were actually found, per side. */
  arraysLoaded: number;
}

/**
 * Load a pool plus `radius` tick arrays either side of the current tick.
 *
 * Radius is a real tradeoff: too few arrays and large swaps return "exceeds
 * loaded tick range" (a refusal, which is safe); too many and each quote costs
 * more RPC. Three each way covers ~180 ticks of Raydium travel at spacing 1,
 * comfortably more than a $100k WSOL/USDC swap needs, and one batched
 * getMultipleAccounts fetches them all in ~120 ms.
 */
export async function loadPoolWithTicks(
  connection: Connection,
  address: string,
  venue: Venue,
  feeRateFraction: number | undefined,
  radius = 3,
): Promise<LoadedPool> {
  const pool = new PublicKey(address);
  const info = await connection.getAccountInfo(pool, 'processed');
  if (!info?.data) throw new Error(`pool ${address} not found`);

  const decoded = decodePool(address, venue, Buffer.from(info.data));
  if (venue === 'ray') {
    if (feeRateFraction === undefined || !(feeRateFraction >= 0 && feeRateFraction < 1)) {
      throw new Error(`raydium pool ${address} needs an explicit feeRate fraction`);
    }
    decoded.feeRate = feeRateFraction;
  }
  assertPoolConsistent(decoded);

  const span = arraySpan(venue, decoded.tickSpacing);
  const centre = arrayStartIndex(venue, decoded.tickCurrent, decoded.tickSpacing);
  const starts: number[] = [];
  for (let i = -radius; i <= radius; i++) starts.push(centre + i * span);

  const addrs = starts.map((s) => tickArrayAddress(venue, pool, s));
  const infos = await connection.getMultipleAccountsInfo(addrs, 'processed');

  const ticks: InitializedTick[] = [];
  let arraysLoaded = 0;
  infos.forEach((acc) => {
    if (!acc?.data) return;                            // uninitialized array: legitimately absent
    arraysLoaded++;
    ticks.push(...decodeTickArray(venue, Buffer.from(acc.data), decoded.tickSpacing));
  });

  return { ...decoded, ticks, arraysLoaded };
}

/** Shape a loaded pool for `swapExactIn`. */
export function toSwapState(p: LoadedPool): SwapPoolState {
  return {
    sqrtPriceX64: p.sqrtPriceX64,
    liquidity: p.liquidity,
    tickCurrent: p.tickCurrent,
    feeRate: p.feeRate,
    ticks: p.ticks,
  };
}

/**
 * Quote a swap, widening the tick window until the swap fits.
 *
 * A thin pool can blow through 180 ticks on a single-SOL trade — the Raydium
 * WSOL/USDC pool at spacing 1 crossed 16 ticks selling 10 SOL — so a fixed
 * radius either refuses constantly or over-fetches for everyone. Widening on
 * demand keeps the common case at one batched read and still prices the tail.
 *
 * Returns an error rather than a partial fill if even the widest window is not
 * enough. That case means the swap would consume essentially all of the pool's
 * liquidity, which is never a trade worth making.
 */
export async function quoteExactIn(
  connection: Connection,
  address: string,
  venue: Venue,
  feeRateFraction: number | undefined,
  amountIn: bigint,
  aToB: boolean,
  radii: number[] = [3, 12, 40],
): Promise<
  | { ok: true; amountOut: bigint; ticksCrossed: number; radiusUsed: number; pool: LoadedPool }
  | { ok: false; error: string }
> {
  let lastError = 'not attempted';
  for (const radius of radii) {
    let pool: LoadedPool;
    try {
      pool = await loadPoolWithTicks(connection, address, venue, feeRateFraction, radius);
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
    const res = swapExactIn(toSwapState(pool), amountIn, aToB);
    if (!isSwapError(res)) {
      return {
        ok: true, amountOut: res.amountOut, ticksCrossed: res.ticksCrossed,
        radiusUsed: radius, pool,
      };
    }
    lastError = res.error;
    // Only widening helps for a range overflow; anything else is terminal.
    if (!res.error.includes('exceeds loaded tick range')) break;
  }
  return { ok: false, error: lastError };
}
