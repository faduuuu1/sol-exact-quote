/**
 * damm2-local.mjs — Meteora DAMM v2 pricing from an ALREADY-FETCHED buffer.
 *
 * `cp.getQuote` needs an async fetchPoolState per pool, which made the first
 * cross-venue scan RPC-bound AND skewed: the DLMM/CLMM side came from one warm
 * snapshot while each DAMM side was fetched seconds later. Stale reserves on one
 * leg invent edges that do not exist — the exact failure mode that produced fake
 * backrun profits before.
 *
 * The SDK exports the pure function underneath getQuote. Driving that from a
 * batched getMultipleAccounts makes both legs synchronous, local, and taken from
 * the same instant. No math is re-derived here; the SDK still does all of it.
 */
import { PublicKey } from '@solana/web3.js';
import BN from 'bn.js';
import * as M from '@meteora-ag/cp-amm-sdk';

export const CP_AMM = new PublicKey('cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG');
export const DAMM2_SIZE = 1112;

/**
 * The coder returns the IDL's snake_case field names, but every SDK function
 * (including swapQuoteExactInput) reads the camelCase shape that anchor's
 * Program namespace produces. Convert, leaving BN and PublicKey instances
 * alone — recursing into a BN would destroy it.
 */
const camel = (s) => s.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
function camelize(v) {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(camelize);
  if (v.constructor && v.constructor.name !== 'Object') return v;   // BN, PublicKey, Buffer
  const o = {};
  for (const [k, val] of Object.entries(v)) o[camel(k)] = camelize(val);
  return o;
}

/** Decode a raw pool account with the SDK's own coder. */
export function decodeDamm2(buf) {
  return camelize(M.cpAmmCoder.accounts.decode('Pool', buf));
}

/**
 * Cheap liveness gate, from raw bytes — avoids decoding 20k dead pools.
 * liquidity u128 @360 must be non-zero and pool_status @481 must be 0.
 */
export function damm2Live(buf) {
  if (!buf || buf.length !== DAMM2_SIZE) return false;
  if (buf[481] !== 0) return false;
  return buf.readBigUInt64LE(360) !== 0n || buf.readBigUInt64LE(368) !== 0n;
}

/**
 * Price a swap. `currentPoint` is a SLOT when activationType is 0 and a UNIX
 * TIMESTAMP when it is 1 — the fee schedulers read it, so passing the wrong one
 * silently returns a fee from the wrong point on the schedule.
 */
export function quoteDamm2({ poolState, inputMint, amountIn, slot, time,
  decA = 9, decB = 6, slippage = 0 }) {
  const a = poolState.tokenAMint.toBase58();
  const b = poolState.tokenBMint.toBase58();
  if (inputMint !== a && inputMint !== b) return { ok: false, reason: 'mint not in pool' };
  const aToB = inputMint === a;
  const activation = Number(poolState.activationType ?? 0);
  const point = new BN(String(activation === 0 ? slot : time));
  try {
    const r = M.swapQuoteExactInput(poolState, point, new BN(String(amountIn)),
      slippage, aToB, false, decA, decB);
    const out = r?.outputAmount ?? r?.swapOutAmount ?? r?.amountOut;
    if (!out) return { ok: false, reason: 'no outputAmount' };
    return { ok: true, out: BigInt(out.toString()), mintOut: aToB ? b : a };
  } catch (e) { return { ok: false, reason: 'damm2: ' + String(e.message).slice(0, 40) }; }
}
