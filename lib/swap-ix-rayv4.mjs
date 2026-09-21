/**
 * swap-ix-rayv4.mjs — one Raydium v4 (AmmInfo) swapBaseIn instruction.
 *
 * DERIVED FROM LANDED TRANSACTIONS, the same way the other builders were
 * (18 mainnet blocks, 2026-09-16). Three independent shapes
 * on different pools agreed exactly:
 *
 *     tag 09  +  amountIn u64 LE  +  minAmountOut u64 LE        17 bytes
 *     17 accounts, and positions 3 and 6..13 all hold THE POOL'S OWN ID
 *
 * That is the modern pattern: OpenBook is dead for these pools, so the market
 * accounts are passed as placeholders. The message dedupes the repeated key, so
 * the 17-account form costs the same bytes as the newer 8-account one (tag 0x10)
 * while being the form we have three confirmations for.
 *
 * Every constant here is derived or read, never copied by eye:
 *   authority   PDA of seed "amm authority" — checked to equal the authority the
 *               landed instruction used (5Q544fKr...pge4j1)
 *   vaults      pool offsets 336 / 368 — checked to equal positions 4 and 5 of
 *               the landed instruction on 58oQChx4 (SOL/USDC)
 *   mints       pool offsets 400 (coin) / 432 (pc)
 *
 * A pool whose OpenBook market is still live would need the real market accounts
 * and will fail simulation here rather than trade wrongly — refusal, not a guess.
 *
 * minOut IS THE PROFIT GUARD and defaults to 0 for simulation only; see
 * sim-gate.mjs. Anything actually sent must carry a floor.
 *
 * Nothing here signs or sends.
 */
import { PublicKey, TransactionInstruction } from '@solana/web3.js';
/**
 * The ataFor that takes the TOKEN PROGRAM. A version hardcoding the classic
 * program returns, for a Token-2022 mint, an address the swap never touches —
 * which reads as "the chain delivered 0" against a successful swap.
 */
import { ataFor } from './swap-ix-cp.mjs';

export const RAY_V4_PROGRAM = new PublicKey('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8');
const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
/** Seeds verified against the authority the chain actually used. */
export const RAY_V4_AUTHORITY = PublicKey.findProgramAddressSync(
  [Buffer.from('amm authority')], RAY_V4_PROGRAM)[0];

const SWAP_BASE_IN = 9;
const COIN_VAULT = 336, PC_VAULT = 368, COIN_MINT = 400, PC_MINT = 432;

export function buildRayV4SwapIx({ poolData, pool, owner, inputMint, amountIn, minOut = 0n, opt = {} }) {
  const d = poolData;
  if (!d || d.length < PC_MINT + 32) throw new Error('raydium v4 pool data too short');
  const poolKey = pool instanceof PublicKey ? pool : new PublicKey(pool);
  const coinMint = new PublicKey(d.subarray(COIN_MINT, COIN_MINT + 32)).toBase58();
  const pcMint = new PublicKey(d.subarray(PC_MINT, PC_MINT + 32)).toBase58();
  if (inputMint !== coinMint && inputMint !== pcMint) throw new Error('mint not in raydium v4 pool');
  const outputMint = inputMint === coinMint ? pcMint : coinMint;

  const tokenProgramIn = opt.tokenProgramIn ?? TOKEN_PROGRAM;
  const tokenProgramOut = opt.tokenProgramOut ?? TOKEN_PROGRAM;
  const ownerKey = owner instanceof PublicKey ? owner : new PublicKey(owner);
  const userSource = ataFor(ownerKey, new PublicKey(inputMint), tokenProgramIn);
  const userDest = ataFor(ownerKey, new PublicKey(outputMint), tokenProgramOut);

  const data = Buffer.alloc(17);
  data.writeUInt8(SWAP_BASE_IN, 0);
  data.writeBigUInt64LE(BigInt(amountIn), 1);
  data.writeBigUInt64LE(BigInt(minOut), 9);

  /** Dead OpenBook slots carry the pool's own id, exactly as landed swaps do. */
  const placeholder = poolKey;
  const keys = [
    { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
    { pubkey: poolKey, isSigner: false, isWritable: true },
    { pubkey: RAY_V4_AUTHORITY, isSigner: false, isWritable: false },
    { pubkey: placeholder, isSigner: false, isWritable: true },      // ammOpenOrders
    { pubkey: new PublicKey(d.subarray(COIN_VAULT, COIN_VAULT + 32)), isSigner: false, isWritable: true },
    { pubkey: new PublicKey(d.subarray(PC_VAULT, PC_VAULT + 32)), isSigner: false, isWritable: true },
    { pubkey: placeholder, isSigner: false, isWritable: false },     // serumProgram
    { pubkey: placeholder, isSigner: false, isWritable: true },      // serumMarket
    { pubkey: placeholder, isSigner: false, isWritable: true },      // serumBids
    { pubkey: placeholder, isSigner: false, isWritable: true },      // serumAsks
    { pubkey: placeholder, isSigner: false, isWritable: true },      // serumEventQueue
    { pubkey: placeholder, isSigner: false, isWritable: true },      // serumCoinVault
    { pubkey: placeholder, isSigner: false, isWritable: true },      // serumPcVault
    { pubkey: placeholder, isSigner: false, isWritable: false },     // serumVaultSigner
    { pubkey: userSource, isSigner: false, isWritable: true },
    { pubkey: userDest, isSigner: false, isWritable: true },
    { pubkey: ownerKey, isSigner: true, isWritable: false },
  ];
  return { ix: new TransactionInstruction({ programId: RAY_V4_PROGRAM, keys, data }) };
}
