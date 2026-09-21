/**
 * sol-exact-quote — exact offline swap quotes for seven Solana venues.
 *
 *   import { ExactQuoter, loadPumpConfigs } from 'sol-exact-quote';
 *   const q = new ExactQuoter();
 *   q.registerAll([poolAddress]);
 *   q.setPumpConfigs(await loadPumpConfigs(connection));   // only for PumpSwap pools
 *   await q.refresh(connection);                           // 1-2 batched RPC calls for ANY number of pools
 *   const r = q.quote(poolAddress, inputMint, amountIn);   // { ok, out, venue, crossed } | { ok: false, reason }
 *
 * quote() is synchronous, never throws and never touches the network. It REFUSES
 * (ok: false, with a reason) whenever an account it needs is missing or a pool is in
 * a state it does not model, rather than returning an approximate number.
 */
export { ExactQuoter, PoolCache, WSOL } from './quoter.mjs';
export { VENUE_BY_OWNER, cpExactIn, cpCreatorTerms, cpExactInCreator } from './cp.mjs';
export { loadPumpConfigs, loadPumpConfigBytes, decodePumpConfigs, PUMP_CONFIG_ACCOUNTS } from './pump-quote.mjs';
export { swapExactIn as dlmmSwapExactIn } from './dlmm-swap.mjs';
export { swapExactIn as clmmSwapExactIn } from '../dist/clmm-math.js';
