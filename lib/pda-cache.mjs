/**
 * pda-cache.mjs — memoised PDA derivation for the hot pricing path.
 *
 * WHY THIS EXISTS
 * ---------------
 * A CPU profile of a live quoting loop put 43% of ALL CPU in one call —
 * tickArrayAddress() inside the quoter — and 40 of those points were ed25519
 * on-curve tests. A PDA search is sha256 plus a curve test per bump, and a
 * size search prices each pool ~80 times, re-deriving the same handful of
 * addresses every time.
 *
 * An address is a pure function of (program, pool, index), so caching it
 * cannot change any result. A derivation that THROWS (an out-of-range index)
 * is never cached and throws again, exactly as the direct call would.
 *
 * Bounded: past MAX entries the map is dropped wholesale and rebuilt on demand.
 */
import { PublicKey } from '@solana/web3.js';
import { tickArrayAddress } from '../dist/clmm-pool.js';
import { binArrayAddress } from './dlmm-binarray.mjs';

const MAX = 200_000;
const tick = new Map();
const bin = new Map();
export const pdaCacheStats = { hits: 0, misses: 0, resets: 0 };

function remember(map, key, derive) {
  const hit = map.get(key);
  if (hit !== undefined) { pdaCacheStats.hits++; return hit; }
  const value = derive();                    // a throw propagates, uncached
  if (map.size >= MAX) { map.clear(); pdaCacheStats.resets++; }
  map.set(key, value);
  pdaCacheStats.misses++;
  return value;
}

/** Tick-array address as base58. `venue` is 'ray' or 'orca', as in dist/clmm-pool.js. */
export function tickArrayAddr58(venue, pool58, startIndex) {
  return remember(tick, venue + '|' + pool58 + '|' + startIndex,
    () => tickArrayAddress(venue, new PublicKey(pool58), startIndex).toBase58());
}

/** Meteora DLMM bin-array address as base58. */
export function binArrayAddr58(pool58, index) {
  return remember(bin, pool58 + '|' + index,
    () => binArrayAddress(new PublicKey(pool58), index).toBase58());
}

/**
 * Orca Whirlpool oracle address as base58 — PDA ["oracle", whirlpool].
 *
 * The oracle holds the ADAPTIVE FEE state (18 of 37 sampled Whirlpools have one),
 * and pricing reads it on every quote, so it is memoised like the array addresses.
 */
const WHIRLPOOL_PROGRAM = new PublicKey('whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc');
const oracle = new Map();
export function whirlOracleAddr58(pool58) {
  return remember(oracle, pool58, () => PublicKey.findProgramAddressSync(
    [Buffer.from('oracle'), new PublicKey(pool58).toBuffer()], WHIRLPOOL_PROGRAM)[0].toBase58());
}
