/**
 * whirlpool-dynamic-ticks.mjs — decode Orca's DynamicTickArray.
 *
 * WHY IT EXISTS
 * -------------
 * About half the tick arrays around live Whirlpool prices are NOT the fixed
 * 9,988-byte TickArray our decoder reads (measured 2026-09-15: 109 fixed, 113
 * dynamic, 37 uninitialised across 37 pools). Those pools were refused rather
 * than mispriced; this decodes them properly.
 *
 * LAYOUT — from the program source, not memory
 * (orca-so/whirlpools, programs/whirlpool/src/state/dynamic_tick_array.rs):
 *
 *     8   discriminator            11d8f68ee1c7da38
 *     4   start_tick_index  i32
 *     32  whirlpool         Pubkey
 *     16  tick_bitmap       u128     bit i set  <=>  tick i initialised
 *     ..  88 entries, each either
 *           1 byte   tag 0, uninitialised
 *           113 byte tag 1 + liquidity_net i128 + liquidity_gross u128
 *                    + fee_growth_outside_a/b u128 + reward_growths [u128; 3]
 *
 * CONFIRMED AGAINST LIVE BYTES: every one of 113 sampled accounts had size
 * 148 + 112k (148 = 60 header + 88 one-byte entries; k = initialised ticks),
 * sizes 148 to 9,892 — arithmetic that only holds if the header is 60 bytes and
 * an initialised entry is 113.
 *
 * SELF-VALIDATING, BECAUSE A LAYOUT GUESS THAT SILENTLY "WORKS" IS THE FAILURE
 * MODE THIS PROJECT KEEPS PAYING FOR: the walk must consume the account
 * EXACTLY, the tags must agree with the bitmap, and the entry count must be 88.
 * Anything else throws, and the caller refuses the quote.
 */

export const DYNAMIC_TICK_ARRAY_DISC = Buffer.from('11d8f68ee1c7da38', 'hex');
export const FIXED_TICK_ARRAY_DISC = Buffer.from('4561bdbe6e0742bb', 'hex');
export const FIXED_TICK_ARRAY_LEN = 9988;

const TICKS_PER_ARRAY = 88;
const HEADER = 60;            // 8 disc + 4 start + 32 whirlpool + 16 bitmap
const INITIALIZED_LEN = 113;  // 1 tag + 112 payload

export const isDynamicTickArray = (d) =>
  !!d && d.length >= HEADER && d.subarray(0, 8).equals(DYNAMIC_TICK_ARRAY_DISC);

export const isFixedTickArray = (d) =>
  !!d && d.length === FIXED_TICK_ARRAY_LEN && d.subarray(0, 8).equals(FIXED_TICK_ARRAY_DISC);

/** Start tick index. Both layouts store it at offset 8, right after the discriminator. */
export const tickArrayStart = (d) => d.readInt32LE(8);

const readI128LE = (b, o) => (b.readBigInt64LE(o + 8) << 64n) | b.readBigUInt64LE(o);
const readU128LE = (b, o) => (b.readBigUInt64LE(o + 8) << 64n) | b.readBigUInt64LE(o);

/**
 * Initialised ticks as {index, liquidityNet}, the same shape decodeTickArray
 * returns for the fixed layout, so callers stay unchanged.
 */
export function decodeDynamicTickArray(data, tickSpacing) {
  if (!isDynamicTickArray(data)) throw new Error('not a DynamicTickArray');
  const start = data.readInt32LE(8);
  const bitmap = readU128LE(data, 44);
  const out = [];
  let o = HEADER;
  let seen = 0;
  for (let i = 0; i < TICKS_PER_ARRAY; i++) {
    if (o >= data.length) throw new Error('ran out of bytes at tick ' + i);
    const tag = data[o];
    const bit = (bitmap >> BigInt(i)) & 1n;
    if (tag === 0) {
      if (bit !== 0n) throw new Error('bitmap says tick ' + i + ' is initialised, tag says it is not');
      o += 1;
      continue;
    }
    if (tag !== 1) throw new Error('unknown tick tag ' + tag + ' at tick ' + i);
    if (bit !== 1n) throw new Error('bitmap says tick ' + i + ' is uninitialised, tag says it is');
    if (o + INITIALIZED_LEN > data.length) throw new Error('initialised tick ' + i + ' overruns the account');
    out.push({ index: start + i * tickSpacing, liquidityNet: readI128LE(data, o + 1) });
    seen++;
    o += INITIALIZED_LEN;
  }
  if (o !== data.length) throw new Error('walk consumed ' + o + ' of ' + data.length + ' bytes');
  if (data.length !== HEADER + TICKS_PER_ARRAY + seen * (INITIALIZED_LEN - 1)) {
    throw new Error('size ' + data.length + ' does not match ' + seen + ' initialised ticks');
  }
  return out;
}
