/**
 * swap-ix-whirlpool.mjs — build an Orca Whirlpool swap_v2 instruction.
 *
 * WHY THIS VENUE
 * --------------
 * 7.3% of the competitor's venue hops, already priced exactly by our decoder.
 * Like Raydium CP it needed only a builder.
 *
 * CAPTURED, NOT GUESSED
 * ---------------------
 * From two landed mainnet transactions:
 *
 *   disc 2b04ed0b1ac91e62   data 43 B   15 accounts
 *   2b04ed0b1ac91e62 37c56f0600000000 0000000000000000
 *     00000000000000000000000000000000 01 01 00
 *
 *   disc | amount u64 | otherAmountThreshold u64 | sqrtPriceLimit u128
 *        | amountSpecifiedIsInput u8 | aToB u8 | remainingAccountsInfo Option u8
 *
 * Earlier notes recorded 49 bytes / 17 accounts for Whirlpool. The landed bytes
 * say 43 / 15, and the landed bytes win — 49/17 was Raydium CLMM's shape, which
 * shares the discriminator because both named the instruction `swap_v2`.
 *
 * THREE TRAPS, ALL SILENT
 * -----------------------
 * 1. The pool is at index 4, not 0. Orca puts the two token programs, memo and
 *    the authority first, so reading accounts[2] gets the MEMO program and every
 *    offset after it is nonsense.
 * 2. Tick array seeds use the start index as an ASCII STRING, not bytes — Orca
 *    differs from Raydium here, which seeds a big-endian i32.
 * 3. Array indices must FLOOR, not truncate. Any pool priced below 1.0 has
 *    negative ticks, and truncating toward zero yields a real account holding
 *    the WRONG range: it fails at execution, not at derivation.
 */
import { PublicKey, TransactionInstruction } from '@solana/web3.js';

export const WHIRLPOOL = new PublicKey('whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc');
export const MEMO = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
export const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
export const TOKEN_2022 = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
export const ATA_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');

export const WHIRL_SWAP_DISC = Buffer.from('2b04ed0b1ac91e62', 'hex');
/** Orca packs 88 ticks per array; Raydium packs 60. */
export const TICKS_PER_ARRAY = 88;

const pda = (seeds, prog) => PublicKey.findProgramAddressSync(seeds, prog)[0];
const floorDiv = (a, b) => Math.floor(a / b);
export const ataFor = (owner, mint, tokenProgram = TOKEN_PROGRAM) =>
  pda([owner.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()], ATA_PROGRAM);
export const whirlOracle = (pool) => pda([Buffer.from('oracle'), pool.toBuffer()], WHIRLPOOL);

/** Seeds are ["tick_array", pool, ASCII(startIndex)] — a string, not bytes. */
export const tickArrayAddress = (pool, startIndex) =>
  pda([Buffer.from('tick_array'), pool.toBuffer(), Buffer.from(String(startIndex))], WHIRLPOOL);

/** Offsets previously validated against landed transactions. */
export function decodeWhirlpool(d) {
  return {
    tickSpacing: d.readUInt16LE(41),
    sqrtPrice: d.readBigUInt64LE(65) | (d.readBigUInt64LE(73) << 64n),
    tickCurrent: d.readInt32LE(81),
    mintA: new PublicKey(d.subarray(101, 133)),
    vaultA: new PublicKey(d.subarray(133, 165)),
    mintB: new PublicKey(d.subarray(181, 213)),
    vaultB: new PublicKey(d.subarray(213, 245)),
  };
}

/** Start index of the array containing `tick`, floored so negatives work. */
export function arrayStart(tick, spacing) {
  const span = spacing * TICKS_PER_ARRAY;
  return floorDiv(tick, span) * span;
}

export function buildWhirlpoolSwapIx({ poolData, pool, owner, inputMint, amountIn,
  minOut = 0n, opt = {} }) {
  const p = decodeWhirlpool(poolData);
  const a = p.mintA.toBase58(), b = p.mintB.toBase58();
  const aToB = a === inputMint;
  if (!aToB && b !== inputMint) throw new Error('inputMint not in pool');

  const tokA = opt.tokenProgramA ?? TOKEN_PROGRAM;
  const tokB = opt.tokenProgramB ?? TOKEN_PROGRAM;
  const span = p.tickSpacing * TICKS_PER_ARRAY;
  const start = arrayStart(p.tickCurrent, p.tickSpacing);
  /**
   * Selling A moves the price DOWN in tick space, so the arrays we may cross
   * trail downward; selling B moves it up. Supplying them in the wrong direction
   * still derives real accounts — they just hold ranges the swap never reaches.
   */
  const starts = opt.tickArrayStarts
    ?? [0, 1, 2].map((k) => start + (aToB ? -k : k) * span);

  const keys = [
    { pubkey: tokA, isSigner: false, isWritable: false },                   // 0
    { pubkey: tokB, isSigner: false, isWritable: false },                   // 1
    { pubkey: MEMO, isSigner: false, isWritable: false },                   // 2
    { pubkey: owner, isSigner: true, isWritable: true },                    // 3
    { pubkey: pool, isSigner: false, isWritable: true },                    // 4
    { pubkey: p.mintA, isSigner: false, isWritable: false },                // 5
    { pubkey: p.mintB, isSigner: false, isWritable: false },                // 6
    { pubkey: ataFor(owner, p.mintA, tokA), isSigner: false, isWritable: true },  // 7
    { pubkey: p.vaultA, isSigner: false, isWritable: true },                // 8
    { pubkey: ataFor(owner, p.mintB, tokB), isSigner: false, isWritable: true },  // 9
    { pubkey: p.vaultB, isSigner: false, isWritable: true },                // 10
  ];
  for (const s of starts) {
    keys.push({ pubkey: tickArrayAddress(pool, s), isSigner: false, isWritable: true });
  }
  // [14] oracle — WRITABLE in both landed samples.
  keys.push({ pubkey: whirlOracle(pool), isSigner: false, isWritable: true });

  const data = Buffer.alloc(43);
  WHIRL_SWAP_DISC.copy(data, 0);
  data.writeBigUInt64LE(BigInt(amountIn), 8);
  data.writeBigUInt64LE(BigInt(minOut), 16);
  // sqrt_price_limit u128 @24..40 stays zero: "no limit", as both samples had.
  data.writeUInt8(1, 40);                 // amountSpecifiedIsInput
  data.writeUInt8(aToB ? 1 : 0, 41);      // aToB
  data.writeUInt8(0, 42);                 // remainingAccountsInfo: None

  return { ix: new TransactionInstruction({ programId: WHIRLPOOL, keys, data }),
    aToB, tickArrayStarts: starts,
    inMint: aToB ? a : b, outMint: aToB ? b : a };
}
