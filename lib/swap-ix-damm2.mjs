/**
 * swap-ix-damm2.mjs — one Meteora DAMM v2 swap instruction.
 *
 * Built by the protocol's OWN SDK rather than by hand, the same choice made for
 * PumpSwap and for the same reason: DAMM v2's accounts include a pool authority
 * PDA, per-mint token programs and an event authority, and a hand-derived
 * account list that is subtly wrong fails as an opaque 3012 at simulation time.
 * The SDK builds it; we strip the result to the single program instruction so
 * the leg stays one instruction inside an atomic two-leg transaction.
 *
 * Everything it needs is already in the cached pool account: decodeDamm2 returns
 * the SDK's own PoolState — mints, vaults, and the token-program FLAGS (0 = SPL,
 * 1 = Token-2022), so nothing here guesses a token program.
 *
 * minOut IS THE PROFIT GUARD and defaults to 0 for simulation only; see
 * sim-gate.mjs. A leg that is actually sent must carry a floor.
 *
 * Nothing here signs or sends.
 */
import { PublicKey } from '@solana/web3.js';
import BN from 'bn.js';
import { CpAmm, CP_AMM_PROGRAM_ID } from '@meteora-ag/cp-amm-sdk';
import { decodeDamm2 } from './damm2-local.mjs';

const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const TOKEN_2022_PROGRAM = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
const progOf = (flag) => (Number(flag) === 1 ? TOKEN_2022_PROGRAM : TOKEN_PROGRAM);
const DAMM2 = new PublicKey(CP_AMM_PROGRAM_ID ?? 'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG');

/**
 * @returns {{ ix: import('@solana/web3.js').TransactionInstruction }}
 */
export async function buildDamm2SwapIx(conn, { poolData, pool, owner, inputMint, amountIn, minOut = 0n }) {
  const ps = decodeDamm2(poolData);
  const aMint = ps.tokenAMint.toBase58 ? ps.tokenAMint.toBase58() : String(ps.tokenAMint);
  const bMint = ps.tokenBMint.toBase58 ? ps.tokenBMint.toBase58() : String(ps.tokenBMint);
  if (inputMint !== aMint && inputMint !== bMint) throw new Error('mint not in damm2 pool');
  const outputMint = inputMint === aMint ? bMint : aMint;

  const cpAmm = new CpAmm(conn);
  const built = cpAmm.swap({
    payer: new PublicKey(owner),
    pool: new PublicKey(pool),
    inputTokenMint: new PublicKey(inputMint),
    outputTokenMint: new PublicKey(outputMint),
    amountIn: new BN(amountIn.toString()),
    minimumAmountOut: new BN(minOut.toString()),
    tokenAMint: new PublicKey(aMint),
    tokenBMint: new PublicKey(bMint),
    tokenAVault: new PublicKey(ps.tokenAVault),
    tokenBVault: new PublicKey(ps.tokenBVault),
    tokenAProgram: progOf(ps.tokenAFlag),
    tokenBProgram: progOf(ps.tokenBFlag),
    referralTokenAccount: null,
    poolState: ps,
  });

  /**
   * The SDK hands back a builder, and its exact shape has changed across
   * versions — .instruction(), .transaction(), or an object carrying
   * instructions. Take whichever exists and then keep only the DAMM v2
   * instruction: any ATA creation or SOL wrapping it adds belongs to the
   * caller's transaction, not inside our leg.
   */
  let ixs = [];
  if (built && typeof built.instruction === 'function') ixs = [await built.instruction()];
  else if (built && typeof built.transaction === 'function') ixs = (await built.transaction()).instructions ?? [];
  else if (built && Array.isArray(built.instructions)) ixs = built.instructions;
  else if (built && typeof built.then === 'function') {
    const tx = await built;
    ixs = tx?.instructions ?? (typeof tx?.transaction === 'function' ? (await tx.transaction()).instructions : []);
  }
  const ix = ixs.filter(Boolean).find((i) => i.programId?.equals?.(DAMM2));
  if (!ix) {
    throw new Error('damm2 builder returned no program instruction (' + ixs.length + ' instructions, shape '
      + Object.keys(built ?? {}).slice(0, 6).join(',') + ')');
  }
  return { ix };
}
