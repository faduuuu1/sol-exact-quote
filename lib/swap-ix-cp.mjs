/**
 * swap-ix-cp.mjs — build a Raydium CP (CPMM) swap_base_input instruction.
 *
 * WHY THIS VENUE
 * --------------
 * Raydium CP is 10.1% of the competitor's venue hops and we already price it
 * exactly (5/5 in cp-validate). It was the largest gap that needed no new math —
 * only an instruction builder.
 *
 * CAPTURED, NOT GUESSED
 * ---------------------
 * Bytes and account flags come from two landed mainnet transactions:
 *
 *   disc 8fbe5adac41e33de   data 24 B   13 accounts
 *   8fbe5adac41e33de a0860100000000 00 0000000000000000
 *   [0]WS [1] [2] [3]W [4]W [5]W [6]W [7]W [8] [9] [10] [11] [12]W
 *
 * The data is genuinely just disc + amount_in(8) + minimum_amount_out(8), so
 * unlike CLMM there is no mystery tail to copy.
 *
 * Note the program address is NOT indexed by getSignaturesForAddress on the
 * providers we use — it returns 0 signatures despite the program being active.
 * These samples came from querying a POOL account instead.
 *
 * DIRECTION ORDERING
 * ------------------
 * Positions [6]/[7] and [10]/[11] are input/output vault and mint, not vault_0 /
 * vault_1. Which of the two lands where depends on the swap direction, so a
 * "mismatch" against a landed transaction going the other way is correct
 * behaviour rather than a bug.
 */
import { PublicKey, TransactionInstruction } from '@solana/web3.js';

export const RAY_CP = new PublicKey('CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C');
export const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
export const TOKEN_2022 = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
export const ATA_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');

/** sha256("global:swap_base_input")[0..8] — confirmed on two landed txs. */
export const CP_SWAP_DISC = Buffer.from('8fbe5adac41e33de', 'hex');

const pda = (seeds, prog) => PublicKey.findProgramAddressSync(seeds, prog)[0];
export const cpAuthority = () => pda([Buffer.from('vault_and_lp_mint_auth_seed')], RAY_CP);
export const cpObservation = (pool) => pda([Buffer.from('observation'), pool.toBuffer()], RAY_CP);
export const ataFor = (owner, mint, tokenProgram = TOKEN_PROGRAM) =>
  pda([owner.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()], ATA_PROGRAM);

/** PoolState offsets, previously validated: ammConfig@8, vaults@72/104, mints@168/200. */
export function decodeCpPool(d) {
  return {
    ammConfig: new PublicKey(d.subarray(8, 40)),
    vault0: new PublicKey(d.subarray(72, 104)),
    vault1: new PublicKey(d.subarray(104, 136)),
    mint0: new PublicKey(d.subarray(168, 200)),
    mint1: new PublicKey(d.subarray(200, 232)),
  };
}

/**
 * @param {Buffer} poolData raw 637-byte pool account
 * @param {PublicKey} pool
 * @param {PublicKey} owner signer; its ATAs are used for both sides
 * @param {string} inputMint base58 of the mint being sold
 */
export function buildCpSwapIx({ poolData, pool, owner, inputMint, amountIn,
  minOut = 0n, opt = {} }) {
  const p = decodeCpPool(poolData);
  const m0 = p.mint0.toBase58(), m1 = p.mint1.toBase58();
  const zeroForOne = m0 === inputMint;
  if (!zeroForOne && m1 !== inputMint) throw new Error('inputMint not in pool');

  const mintIn = zeroForOne ? p.mint0 : p.mint1;
  const mintOut = zeroForOne ? p.mint1 : p.mint0;
  const vaultIn = zeroForOne ? p.vault0 : p.vault1;
  const vaultOut = zeroForOne ? p.vault1 : p.vault0;
  const tokIn = opt.tokenProgramIn ?? TOKEN_PROGRAM;
  const tokOut = opt.tokenProgramOut ?? TOKEN_PROGRAM;

  const keys = [
    { pubkey: owner, isSigner: true, isWritable: true },                    // 0
    { pubkey: cpAuthority(), isSigner: false, isWritable: false },          // 1
    { pubkey: p.ammConfig, isSigner: false, isWritable: false },            // 2
    { pubkey: pool, isSigner: false, isWritable: true },                    // 3
    { pubkey: ataFor(owner, mintIn, tokIn), isSigner: false, isWritable: true },   // 4
    { pubkey: ataFor(owner, mintOut, tokOut), isSigner: false, isWritable: true }, // 5
    { pubkey: vaultIn, isSigner: false, isWritable: true },                 // 6
    { pubkey: vaultOut, isSigner: false, isWritable: true },                // 7
    { pubkey: tokIn, isSigner: false, isWritable: false },                  // 8
    { pubkey: tokOut, isSigner: false, isWritable: false },                 // 9
    { pubkey: mintIn, isSigner: false, isWritable: false },                 // 10
    { pubkey: mintOut, isSigner: false, isWritable: false },                // 11
    { pubkey: cpObservation(pool), isSigner: false, isWritable: true },     // 12
  ];

  const data = Buffer.alloc(24);
  CP_SWAP_DISC.copy(data, 0);
  data.writeBigUInt64LE(BigInt(amountIn), 8);
  data.writeBigUInt64LE(BigInt(minOut), 16);

  return { ix: new TransactionInstruction({ programId: RAY_CP, keys, data }),
    zeroForOne, inMint: mintIn.toBase58(), outMint: mintOut.toBase58() };
}
