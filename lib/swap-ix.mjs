/**
 * swap-ix.mjs — build a Meteora DLMM swap instruction ourselves. No Jupiter.
 *
 * Building the instruction locally means no aggregator round trip, no public
 * API rate limit, and no route chosen by someone else.
 *
 * NOTHING HERE IS FROM AN IDL
 * ---------------------------
 *   discriminator + data layout   decoded from landed transactions
 *   what each account slot IS     classified by OWNER and data LENGTH, not by position
 *   writable / signer flags       read off a landed transaction's inner instruction
 *   PDA seeds                     verified by reconstructing a real transaction
 *                                 account-for-account
 *
 * THE DATA IS 28 BYTES, NOT 24
 * ----------------------------
 *   [0..8)   discriminator 414b3f4ceb5b5b88
 *   [8..16)  amount_in            u64 LE
 *   [16..24) min_amount_out       u64 LE
 *   [24..28) remaining_accounts_info — an Anchor Vec length of 0
 *
 * That trailing empty vec is exactly what hand-writing from an IDL would miss,
 * and it would fail at deserialisation rather than mispricing. It is present in
 * the landed sample: ...88 ef98711b00000000 0000000000000000 00000000
 */
import { PublicKey, TransactionInstruction } from '@solana/web3.js';
import { binArrayIndexOf, binArrayAddress, decodeLbPair } from './dlmm-binarray.mjs';

export const DLMM_PROGRAM = new PublicKey('LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo');
export const MEMO_PROGRAM = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
export const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
export const TOKEN_2022 = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
export const ATA_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
export const DLMM_SWAP_DISC = Buffer.from('414b3f4ceb5b5b88', 'hex');

const pda = (seeds, prog) => PublicKey.findProgramAddressSync(seeds, prog)[0];

export const bitmapPda = (lbPair) =>
  pda([Buffer.from('bitmap'), lbPair.toBuffer()], DLMM_PROGRAM);
export const oraclePda = (lbPair) =>
  pda([Buffer.from('oracle'), lbPair.toBuffer()], DLMM_PROGRAM);
export const eventAuthPda = () =>
  pda([Buffer.from('__event_authority')], DLMM_PROGRAM);

/** Associated token address. */
export const ataFor = (owner, mint, tokenProgram = TOKEN_PROGRAM) =>
  pda([owner.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()], ATA_PROGRAM);

export const SYSTEM_PROGRAM = new PublicKey('11111111111111111111111111111111');

/**
 * CreateIdempotent on the Associated Token Account program (instruction 1).
 *
 * A swap writes into the user`s OUTPUT token account; if it does not exist the
 * program reports Anchor 3012 AccountNotInitialized and the whole thing
 * reverts. Real transactions always front-run this with a create — that is
 * what Jupiter`s `setupInstructions` are. Idempotent means it is a no-op when
 * the account is already there, so it can be included unconditionally.
 */
export function createAtaIdempotentIx({ payer, owner, mint, tokenProgram = TOKEN_PROGRAM }) {
  const ata = ataFor(owner, mint, tokenProgram);
  return new TransactionInstruction({
    programId: ATA_PROGRAM,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: ata, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SYSTEM_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: tokenProgram, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([1]),
  });
}

/**
 * SyncNative — token program instruction 17.
 *
 * WSOL is an ordinary SPL token account whose balance must be told about
 * lamports transferred into it. Wrapping is: create the ATA, transfer SOL to
 * it, then SyncNative so the token balance reflects the lamports. Without the
 * sync the account holds the SOL but reports a zero token balance and every
 * swap fails on insufficient funds — which is indistinguishable from a builder
 * bug in the error output.
 */
export function syncNativeIx(wsolAta) {
  return new TransactionInstruction({
    programId: TOKEN_PROGRAM,
    keys: [{ pubkey: wsolAta, isSigner: false, isWritable: true }],
    data: Buffer.from([17]),
  });
}

/**
 * Build the swap instruction.
 *
 * @param {Buffer} poolData   the LbPair account, already fetched
 * @param {PublicKey} pool
 * @param {PublicKey} owner   pays and receives; must be the signer
 * @param {string} inputMint
 * @param {bigint} amountIn
 * @param {bigint} minOut     the ONLY on-chain protection; 0 means no floor
 * @param {object} [opt]      { binArrayCount, tokenProgramX, tokenProgramY }
 */
export function buildDlmmSwapIx({ poolData, pool, owner, inputMint, amountIn,
  minOut = 0n, opt = {} }) {
  const p = decodeLbPair(poolData);
  const mintX = new PublicKey(p.mintX), mintY = new PublicKey(p.mintY);
  const swapForY = p.mintX === inputMint;
  if (!swapForY && p.mintY !== inputMint) {
    throw new Error('inputMint is not in this pool');
  }
  const tokX = opt.tokenProgramX ?? TOKEN_PROGRAM;
  const tokY = opt.tokenProgramY ?? TOKEN_PROGRAM;

  // Our two token accounts: input first, output second, matching slots [4][5].
  const userIn = ataFor(owner, swapForY ? mintX : mintY, swapForY ? tokX : tokY);
  const userOut = ataFor(owner, swapForY ? mintY : mintX, swapForY ? tokY : tokX);

  /**
   * Bin arrays trail the fixed 16. Which ones are needed depends on how far the
   * swap moves the active bin, and the direction: selling X walks DOWN in id,
   * selling Y walks UP. Supplying the wrong side means the program runs out of
   * liquidity mid-swap and reverts — a refusal, not a loss.
   *
   * They must also EXIST. Passing an uninitialised bin array makes the program
   * fail to deserialize it — observed as custom error 3007 on a 125-step pool
   * whose neighbouring arrays were never created. Pass `binArrayIndices` with
   * only the arrays the caller has confirmed on chain.
   */
  const here = binArrayIndexOf(p.activeId);
  let idxs;
  if (opt.binArrayIndices) {
    // Caller has checked which arrays actually EXIST on chain.
    idxs = opt.binArrayIndices;
  } else {
    const n = opt.binArrayCount ?? 3;
    idxs = [];
    for (let k = 0; k < n; k++) idxs.push(swapForY ? here - k : here + k);
  }
  if (!idxs.length) throw new Error('no bin arrays supplied');

  const keys = [
    { pubkey: pool, isSigner: false, isWritable: true },                    // 0
    /**
     * bin_array_bitmap_extension is an Option<Account>. Anchor encodes None as
     * the PROGRAM ID, not as a derived-but-nonexistent PDA.
     *
     * Passing the PDA for a pool that never created one gives Anchor error
     * 3007 AccountOwnedByWrongProgram — the account is System-owned (or absent)
     * where an LB_CLMM account was expected. DLMM's own errors are 6000-6110
     * per its on-chain IDL, so a 3000-range code is always the FRAMEWORK
     * complaining about an account, never the venue's business logic.
     *
     * Wide pools (large bin_step) commonly have no extension; narrow ones do.
     */
    { pubkey: opt.hasBitmapExt === false ? DLMM_PROGRAM : bitmapPda(pool),
      isSigner: false, isWritable: opt.hasBitmapExt !== false },             // 1
    { pubkey: new PublicKey(p.reserveX), isSigner: false, isWritable: true }, // 2
    { pubkey: new PublicKey(p.reserveY), isSigner: false, isWritable: true }, // 3
    { pubkey: userIn, isSigner: false, isWritable: true },                  // 4
    { pubkey: userOut, isSigner: false, isWritable: true },                 // 5
    { pubkey: mintX, isSigner: false, isWritable: false },                  // 6
    { pubkey: mintY, isSigner: false, isWritable: false },                  // 7
    { pubkey: oraclePda(pool), isSigner: false, isWritable: true },         // 8
    // host_fee_in is optional; Anchor's None is the program id itself.
    { pubkey: DLMM_PROGRAM, isSigner: false, isWritable: false },           // 9
    { pubkey: owner, isSigner: true, isWritable: true },                    // 10
    { pubkey: tokX, isSigner: false, isWritable: false },                   // 11
    { pubkey: tokY, isSigner: false, isWritable: false },                   // 12
    { pubkey: MEMO_PROGRAM, isSigner: false, isWritable: false },           // 13
    { pubkey: eventAuthPda(), isSigner: false, isWritable: false },         // 14
    { pubkey: DLMM_PROGRAM, isSigner: false, isWritable: false },           // 15
  ];
  for (const i of idxs) {
    keys.push({ pubkey: binArrayAddress(pool, i), isSigner: false, isWritable: true });
  }

  const data = Buffer.alloc(28);
  DLMM_SWAP_DISC.copy(data, 0);
  data.writeBigUInt64LE(BigInt(amountIn), 8);
  data.writeBigUInt64LE(BigInt(minOut), 16);
  data.writeUInt32LE(0, 24);          // remaining_accounts_info: empty vec

  return { ix: new TransactionInstruction({ programId: DLMM_PROGRAM, keys, data }),
    userIn, userOut, swapForY, binArrayIndices: idxs,
    outMint: (swapForY ? mintY : mintX).toBase58() };
}
