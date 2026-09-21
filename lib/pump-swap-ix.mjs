/**
 * pump-swap-ix.mjs — build a PumpSwap swap instruction.
 *
 * WHY THE SDK BUILDS IT AND NOT US
 * -------------------------------
 * A landed swap carries TWENTY-SIX accounts:
 *
 *   [0] pool  [1] user(S)  [2] globalConfig  [3] baseMint  [4] quoteMint
 *   [5] userBaseAta  [6] userQuoteAta  [7] poolBaseVault  [8] poolQuoteVault
 *   [9] protocolFeeRecipient  [10] its ATA  [11][12] token programs
 *   [13] system  [14] ATA program  [15] eventAuthority  [16] program
 *   [17] coinCreatorVaultAta  [18] coinCreatorVaultAuthority
 *   [19] globalVolumeAccumulator  [20] userVolumeAccumulator
 *   [21] feeConfig  [22] feeProgram  [23][24][25] boost/fee PDAs
 *
 * Discriminator confirmed: sha256("global:buy_exact_quote_in") = c62e1552b4d9e870,
 * data 25 bytes (disc + u64 + u64 + u8).
 *
 * We derived DLMM, CLMM, CP and Whirlpool by hand because each has 13-17
 * accounts and stable PDAs. Twenty-six, including volume accumulators and boost
 * vaults that change shape with protocol updates, is a different proposition:
 * every one is a silent 3012 waiting to happen. The SDK already computes them,
 * and it is the same source as the fee math we validated exact — so it builds
 * the instruction and we validate the RESULT by simulation.
 *
 * Nothing here signs or sends.
 */
import { PublicKey, TransactionInstruction } from '@solana/web3.js';
import BN from 'bn.js';
import * as pump from '@pump-fun/pump-swap-sdk';
import { decodeRawMint, mintNeedsCare, PUMP_AMM } from './pump-quote.mjs';

const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ATA_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');

const ataFor = (owner, mint, tokenProgram) => PublicKey.findProgramAddressSync(
  [owner.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()], ATA_PROGRAM)[0];

/**
 * Assemble the SwapSolanaState the SDK needs. Every field is something we
 * already read for pricing, so this adds no new RPC beyond the pool decode.
 */
export async function buildPumpSwapState(conn, { poolKey, user, globalConfig, feeConfig }) {
  const program = pump.getPumpAmmProgram(conn);
  const poolAccountInfo = await conn.getAccountInfo(new PublicKey(poolKey), 'confirmed');
  if (!poolAccountInfo) throw new Error('pool not found');
  const pool = program.coder.accounts.decode('pool', poolAccountInfo.data);

  const [baseMintInfo, quoteMintInfo, baseVault, quoteVault] =
    await conn.getMultipleAccountsInfo([pool.baseMint, pool.quoteMint,
      pool.poolBaseTokenAccount, pool.poolQuoteTokenAccount], 'confirmed');
  if (!baseMintInfo || !quoteMintInfo || !baseVault || !quoteVault) {
    throw new Error('pool accounts missing');
  }
  /**
   * A Token-2022 transfer fee is taken by the MINT, not the AMM, so the swap
   * math cannot see it and our quote would overstate the output. Refuse here
   * rather than build something whose result we cannot predict.
   */
  const care = mintNeedsCare(baseMintInfo.data, baseMintInfo.owner);
  if (care) throw new Error(care);

  const baseTokenProgram = baseMintInfo.owner;
  const quoteTokenProgram = quoteMintInfo.owner;
  const userBaseTokenAccount = ataFor(user, pool.baseMint, baseTokenProgram);
  const userQuoteTokenAccount = ataFor(user, pool.quoteMint, quoteTokenProgram);
  const [userBaseAccountInfo, userQuoteAccountInfo] =
    await conn.getMultipleAccountsInfo([userBaseTokenAccount, userQuoteTokenAccount], 'confirmed');

  return {
    globalConfig,
    feeConfig: feeConfig ?? null,
    poolKey: new PublicKey(poolKey),
    poolAccountInfo,
    pool,
    poolBaseAmount: new BN(baseVault.data.readBigUInt64LE(64).toString()),
    poolQuoteAmount: new BN(quoteVault.data.readBigUInt64LE(64).toString()),
    baseTokenProgram,
    quoteTokenProgram,
    baseMint: pool.baseMint,
    baseMintAccount: decodeRawMint(baseMintInfo.data),
    user,
    userBaseTokenAccount,
    userQuoteTokenAccount,
    userBaseAccountInfo,
    userQuoteAccountInfo,
  };
}

/**
 * Instructions for an exact-in swap.
 *
 * `inputIsQuote` true spends the quote token (usually WSOL) to buy base;
 * false sells base for quote. Slippage is a PERCENT here, not bps — passing
 * bps would silently allow a 100x worse fill.
 */
export async function buildPumpSwapIxs(conn, {
  poolKey, user, amountIn, inputIsQuote, slippagePercent = 1,
  globalConfig, feeConfig, exactQuoteIn = false,
}) {
  const sdk = new pump.PumpAmmSdk(conn);
  const state = await buildPumpSwapState(conn, { poolKey, user, globalConfig, feeConfig });
  const amt = new BN(amountIn.toString());
  const ixs = inputIsQuote
    ? await sdk.buyQuoteInput(state, amt, slippagePercent)
    : await sdk.sellBaseInput(state, amt, slippagePercent);
  if (exactQuoteIn && inputIsQuote) rewriteAsExactQuoteIn(ixs, amountIn);
  return { ixs, state };
}

/**
 * `buy` IS EXACT-OUT. AN ARB LEG NEEDS EXACT-IN.
 *
 * The SDK's buy path computes a base amount from the quote we want to spend and
 * then submits `buy(base_amount_out, max_quote_amount_in)` — the chain delivers
 * that base and takes whatever quote it costs, up to the cap. That is right for
 * a trader clicking buy and wrong for leg A of an arb, where leg B spends a
 * fixed amount and any shortfall on A must abort the whole thing.
 *
 * `buy_exact_quote_in` is the same 26 accounts and the same argument shapes
 * (u64, u64, OptionBool), so the safest construction is to keep the SDK's own
 * bytes and swap the discriminator and the two amounts. Re-encoding through the
 * coder would mean re-deriving OptionBool's representation for no benefit.
 *
 * min_base_amount_out is set to the base the SDK predicted, so a pool that
 * moved makes the transaction FAIL rather than fill worse than we priced.
 */
const BUY_EXACT_QUOTE_IN_DISC = Buffer.from('c62e1552b4d9e870', 'hex');
export function rewriteAsExactQuoteIn(ixs, spendableQuoteIn) {
  const i = ixs.findIndex((ix) => ix.programId.equals(PUMP_AMM) && ix.data.length > 8);
  if (i < 0) throw new Error('no pump swap instruction to rewrite');
  const old = ixs[i].data;
  if (old.length < 24) throw new Error('unexpected buy data length ' + old.length);
  const minBaseAmountOut = old.readBigUInt64LE(8);        // what `buy` asked for
  const data = Buffer.from(old);
  BUY_EXACT_QUOTE_IN_DISC.copy(data, 0);
  data.writeBigUInt64LE(BigInt(spendableQuoteIn), 8);
  data.writeBigUInt64LE(minBaseAmountOut, 16);
  ixs[i] = new TransactionInstruction({
    programId: ixs[i].programId, keys: ixs[i].keys, data });
  return { minBaseAmountOut };
}

/**
 * The single PumpSwap instruction, for composing into a multi-venue arb.
 *
 * The SDK returns a bundle: idempotent ATA creation, a WSOL wrap, the swap, and
 * a closeAccount that unwraps. Every one of those is right for a standalone
 * trade and wrong inside a two-leg transaction with 1232 bytes to spend — the
 * close in particular would hand leg B an account that no longer exists.
 */
export async function buildPumpLegIx(conn, opts) {
  const { ixs, state } = await buildPumpSwapIxs(conn, { ...opts, exactQuoteIn: true });
  const ix = ixs.find((x) => x.programId.equals(PUMP_AMM) && x.data.length > 8);
  if (!ix) throw new Error('no pump swap instruction built');
  return { ix, state };
}
