/**
 * swap-ix-clmm.mjs — build a Raydium CLMM swap_v2 instruction ourselves.
 *
 * WHY THIS VENUE NEXT
 * -------------------
 * DLMM + Raydium CLMM is what the winners actually trade, and 4,625 tokens have
 * pools on both. Every previous cross-venue measurement went through Jupiter;
 * with this the whole pair is ours.
 *
 * THE DATA IS 49 BYTES, NOT 41
 * ----------------------------
 * The documented swap_v2 args are amount u64 + other_amount_threshold u64 +
 * sqrt_price_limit_x64 u128 + is_base_input bool = 41 with the discriminator.
 * Every landed sample is 49. Rather than guess what the extra 8 bytes are, this
 * COPIES the tail from a real transaction and overwrites only `amount` and
 * `other_amount_threshold`. Reproducing known-good bytes and changing the
 * minimum is the same discipline that got DLMM right; inventing a tail would
 * fail at deserialisation, and inventing it *plausibly* would be worse.
 *
 * ACCOUNT LAYOUT, from a landed transaction (roles by owner and size, flags from the inner instruction):
 *   [0] WS payer/owner        [1]    amm_config (117B)
 *   [2] W  pool_state (1544)  [3] W  user_token_in
 *   [4] W  user_token_out     [5] W  pool_vault_in
 *   [6] W  pool_vault_out     [7] W  observation_state (4483)
 *   [8]    SPL Token          [9]    Token-2022
 *   [10]   memo               [11]   mint_in
 *   [12]   mint_out           [13] W tick_array_bitmap_extension (1832)
 *   [14+] W tick arrays (10240 each)
 *
 * PoolState offsets, all previously validated: amm_config@9, mints@73/105,
 * vaults@137/169, observation@201, tick_spacing@235, sqrt_price@253, tick@269.
 */
import { PublicKey, TransactionInstruction } from '@solana/web3.js';
import { tickArrayAddress, arrayStartIndex } from '../dist/clmm-pool.js';

export const RAY_CLMM = new PublicKey('CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK');
export const MEMO = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
export const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
export const TOKEN_2022 = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
export const ATA_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');

/** The 49-byte template from a landed swap; only amount+threshold are replaced. */
export const CLMM_DATA_TEMPLATE = Buffer.from(
  '2b04ed0b1ac91e62' + '0000000000000000' + '0000000000000000'
  + '00000000000000000000000000000000' + '01' + '0000000000000000', 'hex');

const pda = (seeds, prog) => PublicKey.findProgramAddressSync(seeds, prog)[0];
export const bitmapExtPda = (pool) =>
  pda([Buffer.from('pool_tick_array_bitmap_extension'), pool.toBuffer()], RAY_CLMM);
export const ataFor = (owner, mint, tokenProgram = TOKEN_PROGRAM) =>
  pda([owner.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()], ATA_PROGRAM);

export function decodeClmmPool(d) {
  return {
    ammConfig: new PublicKey(d.subarray(9, 41)),
    mint0: new PublicKey(d.subarray(73, 105)),
    mint1: new PublicKey(d.subarray(105, 137)),
    vault0: new PublicKey(d.subarray(137, 169)),
    vault1: new PublicKey(d.subarray(169, 201)),
    observation: new PublicKey(d.subarray(201, 233)),
    tickSpacing: d.readUInt16LE(235),
    tickCurrent: d.readInt32LE(269),
  };
}

/**
 * @param {Buffer} poolData
 * @param {number} tickArrayCount how many arrays to supply in the swap direction
 */
/**
 * @param {object} [opt.programId] a Raydium-CLMM-COMPATIBLE fork, e.g.
 *   byreal_clmm (REALQqNE…), which shares the discriminator, args, account
 *   order and PoolState layout. Only the program id and therefore the
 *   tick-array PDAs differ.
 */
export function buildClmmSwapIx({ poolData, pool, owner, inputMint, amountIn,
  minOut = 0n, opt = {} }) {
  const PROGRAM = opt.programId ?? RAY_CLMM;
  const p = decodeClmmPool(poolData);
  const m0 = p.mint0.toBase58(), m1 = p.mint1.toBase58();
  const zeroForOne = m0 === inputMint;
  if (!zeroForOne && m1 !== inputMint) throw new Error('inputMint not in pool');

  const tokIn = opt.tokenProgramIn ?? TOKEN_PROGRAM;
  const tokOut = opt.tokenProgramOut ?? TOKEN_PROGRAM;
  const mintIn = zeroForOne ? p.mint0 : p.mint1;
  const mintOut = zeroForOne ? p.mint1 : p.mint0;
  const vaultIn = zeroForOne ? p.vault0 : p.vault1;
  const vaultOut = zeroForOne ? p.vault1 : p.vault0;

  /**
   * Tick arrays, stepping by a full array span. Selling token0 moves the price
   * DOWN in tick space, so the arrays needed trail downward, and vice versa.
   * The span is 60 * tickSpacing on Raydium — computing it as a difference of
   * two adjacent arrayStartIndex values yields 0 and silently collapses to a
   * stride of 1, which is exactly the bug that broke the warm cache.
   */
  const span = 60 * p.tickSpacing;
  const start = arrayStartIndex('ray', p.tickCurrent, p.tickSpacing);
  const n = opt.tickArrayCount ?? 3;
  const starts = opt.tickArrayStarts
    ?? Array.from({ length: n }, (_, k) => start + (zeroForOne ? -k : k) * span);
  // tick_array PDA seeds are the same; only the owning program changes.
  const taFor = (st) => {
    const buf = Buffer.alloc(4); buf.writeInt32BE(st);
    return PublicKey.findProgramAddressSync(
      [Buffer.from('tick_array'), pool.toBuffer(), buf], PROGRAM)[0];
  };
  const bmpFor = () => PublicKey.findProgramAddressSync(
    [Buffer.from('pool_tick_array_bitmap_extension'), pool.toBuffer()], PROGRAM)[0];

  const keys = [
    { pubkey: owner, isSigner: true, isWritable: true },                  // 0
    { pubkey: p.ammConfig, isSigner: false, isWritable: false },          // 1
    { pubkey: pool, isSigner: false, isWritable: true },                  // 2
    { pubkey: ataFor(owner, mintIn, tokIn), isSigner: false, isWritable: true },  // 3
    { pubkey: ataFor(owner, mintOut, tokOut), isSigner: false, isWritable: true },// 4
    { pubkey: vaultIn, isSigner: false, isWritable: true },               // 5
    { pubkey: vaultOut, isSigner: false, isWritable: true },              // 6
    { pubkey: p.observation, isSigner: false, isWritable: true },         // 7
    { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },        // 8
    { pubkey: TOKEN_2022, isSigner: false, isWritable: false },           // 9
    { pubkey: MEMO, isSigner: false, isWritable: false },                 // 10
    { pubkey: mintIn, isSigner: false, isWritable: false },               // 11
    { pubkey: mintOut, isSigner: false, isWritable: false },              // 12
    { pubkey: bmpFor(), isSigner: false, isWritable: true },               // 13
  ];
  for (const st of starts) {
    keys.push({ pubkey: taFor(st), isSigner: false, isWritable: true });
  }

  const data = Buffer.from(CLMM_DATA_TEMPLATE);      // copy, do not mutate
  data.writeBigUInt64LE(BigInt(amountIn), 8);
  data.writeBigUInt64LE(BigInt(minOut), 16);

  return { ix: new TransactionInstruction({ programId: PROGRAM, keys, data }),
    zeroForOne, tickArrayStarts: starts,
    outMint: mintOut.toBase58(), inMint: mintIn.toBase58() };
}
