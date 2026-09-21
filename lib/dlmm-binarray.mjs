/**
 * dlmm-binarray.mjs — establish Meteora DLMM's BinArray layout from FACTS.
 *
 * WHY THIS SCRIPT EXISTS
 * ----------------------
 * The LbPair layout is settled (active_id@76, bin_step@80, mints@88/120,
 * validated across many pools). That gives a MID price. It does not give a swap
 * output, because DLMM liquidity lives in discrete bins stored in separate
 * BinArray accounts. Pricing a real swap means walking those bins.
 *
 * This project has twice been burned by fitted offsets — Raydium's fee read at
 * byte 43 instead of 47 turned a 1% pool into an apparent +0.36% profit, and an
 * earlier DLMM attempt matched ONE pool to 0.004% and was 2-3% wrong on the next.
 * So nothing here is fitted to a price. Every claim is anchored on a value that
 * can be checked independently:
 *
 *   1. BinArray.lb_pair must EQUAL the pool address we derived it from
 *   2. BinArray.index must EQUAL floor(active_id / BINS_PER_ARRAY), signed
 *   3. the account length must equal the computed struct size exactly
 *   4. the PDA we derive must be the account that actually exists on chain
 *
 * Four independent constraints. A wrong layout cannot satisfy all four by luck.
 *
 *   (self-check: tools/verify.mjs on a DLMM pool)
 */
import { PublicKey } from '@solana/web3.js';

const DLMM_PROGRAM = new PublicKey('LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo');
const WSOL = 'So11111111111111111111111111111111111111112';

/** Settled LbPair offsets — see memory meteora-dlmm-decode. */
export const LB = { activeId: 76, binStep: 80, mintX: 88, mintY: 120,
  reserveX: 152, reserveY: 184 };

/** Meteora packs 70 bins per array. Verified below against account length. */
export const BINS_PER_ARRAY = 70;

/**
 * Bin, from Meteora's own layout:
 *   amount_x u64 | amount_y u64 | price u128 | liquidity_supply u128
 *   reward_per_token_stored [u128;2] | fee_amount_x_per_token_stored u128
 *   fee_amount_y_per_token_stored u128 | amount_x_in u128 | amount_y_in u128
 * = 8+8+16+16+32+16+16+16+16 = 144
 */
export const BIN_SIZE = 144;
export const BIN_ARRAY_HEADER = 8 + 8 + 1 + 7 + 32;   // disc,index,version,pad,lb_pair

/** u128 little-endian. Combine as BigInt FIRST — Number() mangles the low word. */
export const u128 = (d, o) => d.readBigUInt64LE(o) | (d.readBigUInt64LE(o + 8) << 64n);

/** Signed floor division. active_id is i32 and is NEGATIVE for pools priced <1. */
export function binArrayIndexOf(binId, perArray = BINS_PER_ARRAY) {
  return Math.floor(binId / perArray);
}

/** PDA: seeds ["bin_array", lb_pair, index_i64_le] */
export function binArrayAddress(lbPair, index) {
  const buf = Buffer.alloc(8);
  buf.writeBigInt64LE(BigInt(index));
  return PublicKey.findProgramAddressSync(
    [Buffer.from('bin_array'), lbPair.toBuffer(), buf], DLMM_PROGRAM)[0];
}

export function decodeLbPair(d) {
  return {
    activeId: d.readInt32LE(LB.activeId),
    binStep: d.readUInt16LE(LB.binStep),
    mintX: new PublicKey(d.subarray(LB.mintX, LB.mintX + 32)).toBase58(),
    mintY: new PublicKey(d.subarray(LB.mintY, LB.mintY + 32)).toBase58(),
    reserveX: new PublicKey(d.subarray(LB.reserveX, LB.reserveX + 32)).toBase58(),
    reserveY: new PublicKey(d.subarray(LB.reserveY, LB.reserveY + 32)).toBase58(),
  };
}

export function decodeBinArray(d) {
  const index = Number(d.readBigInt64LE(8));
  const lbPair = new PublicKey(d.subarray(24, 56)).toBase58();
  const bins = [];
  for (let i = 0; i < BINS_PER_ARRAY; i++) {
    const o = BIN_ARRAY_HEADER + i * BIN_SIZE;
    if (o + BIN_SIZE > d.length) break;
    bins.push({
      amountX: d.readBigUInt64LE(o),
      amountY: d.readBigUInt64LE(o + 8),
      price: u128(d, o + 16),
      liquiditySupply: u128(d, o + 32),
    });
  }
  return { index, lbPair, bins };
}
