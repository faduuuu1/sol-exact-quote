/**
 * cp.mjs — venue identification and constant-product math (Raydium CP, Raydium v4).
 *
 * Every fee here was pinned against the chain, never from an IDL alone:
 *   Raydium CP    trade_fee_rate u64 @12 of AmmConfig, creator fee below
 *   Raydium v4    fee numerator/denominator u64 @176/@184 of AmmInfo (per pool)
 */

export const WSOL = 'So11111111111111111111111111111111111111112';

/** Owning program -> venue name. A pool is identified by its owner AND its size (see quoter.mjs). */
export const VENUE_BY_OWNER = {
  LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo: 'Meteora DLMM',
  whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc: 'Whirlpool',
  CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK: 'Raydium CLMM',
  CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C: 'Raydium CP',
  pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA: 'Pump.fun Amm',
  /** The original OpenBook-linked AMM, distinct from CLMM and CP; a plain constant product. */
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8': 'Raydium v4',
  cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG: 'Meteora DAMM v2',
};

/** Constant product, fee on input, integer throughout, fee rounded UP. */
export function cpExactIn(reserveIn, reserveOut, amountIn, feeMicro) {
  if (reserveIn <= 0n || reserveOut <= 0n || amountIn <= 0n) return 0n;
  const fee = (amountIn * feeMicro + 999_999n) / 1_000_000n;
  const net = amountIn - fee;
  return (reserveOut * net) / (reserveIn + net);
}

/**
 * RAYDIUM CP CREATOR FEE.
 *
 * A CP pool with enable_creator_fee = 1 and a 1% creator rate came in -92.50 bps
 * against a quote that ignored it, on fresh state, twice; pools without it priced
 * exact. Verified against raydium-cp-swap source:
 *   PoolState   creator_fee_on u8 @389 (0 either token, 1 only token_0, 2 only token_1)
 *               enable_creator_fee bool @390   creator_fees_token_0/1 u64 @397/@405
 *   AmmConfig   trade_fee_rate u64 @12   creator_fee_rate u64 @108   (rates / 1e6)
 *   adjust_creator_fee_rate   rate is 0 unless enable_creator_fee
 *   is_creator_fee_on_input   on == 0, or 1 with token_0 in, or 2 with token_1 in
 *   swap_base_input  on input:  input -= ceil(input * (trade + creator) / 1e6)
 *                    on output: input -= ceil(input * trade / 1e6);
 *                               out = curve - ceil(curve * creator / 1e6)
 *   vault_amount_without_fee  also subtracts accrued creator fees, enabled or not
 */
export const CP_CREATOR = { on: 389, enable: 390, cf0: 397, cf1: 405, cfgRate: 108 };

export function cpCreatorTerms(poolData, cfgData, inIs0) {
  if (!poolData || poolData.length < CP_CREATOR.cf1 + 8) return { invalid: true };
  const on = poolData[CP_CREATOR.on];
  if (on > 2) return { invalid: true };               // the program's from_u8 would fail the swap
  const enabled = poolData[CP_CREATOR.enable] === 1;
  let creatorMicro = 0n;
  if (enabled) {
    if (!cfgData || cfgData.length < CP_CREATOR.cfgRate + 8) return { invalid: true };
    creatorMicro = cfgData.readBigUInt64LE(CP_CREATOR.cfgRate);
  }
  return { creatorMicro, onInput: on === 0 || (on === 1 && inIs0) || (on === 2 && !inIs0),
    cf0: poolData.readBigUInt64LE(CP_CREATOR.cf0), cf1: poolData.readBigUInt64LE(CP_CREATOR.cf1) };
}

export function cpExactInCreator(reserveIn, reserveOut, amountIn, tradeMicro, creatorMicro, onInput) {
  if (creatorMicro === 0n) return cpExactIn(reserveIn, reserveOut, amountIn, tradeMicro);
  if (reserveIn <= 0n || reserveOut <= 0n || amountIn <= 0n) return 0n;
  const ceil = (a, rate) => (a * rate + 999_999n) / 1_000_000n;
  if (onInput) {
    const net = amountIn - ceil(amountIn, tradeMicro + creatorMicro);
    return (reserveOut * net) / (reserveIn + net);
  }
  const net = amountIn - ceil(amountIn, tradeMicro);
  const swapped = (reserveOut * net) / (reserveIn + net);
  return swapped - ceil(swapped, creatorMicro);
}
