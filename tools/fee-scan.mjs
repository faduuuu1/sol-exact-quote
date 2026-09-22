/**
 * fee-scan.mjs — measure the hidden fee on each pool and write site/data.json.
 *
 * For every pool, at a reference trade size, it takes two quotes from the SAME state:
 * one with the full fee, one with the hidden component switched off. The gap between
 * them, in basis points, is exactly how much a naive quote would overstate the output.
 *
 *   Raydium CLMM / Orca Whirlpool   dynamicFees:false  -> volatility / adaptive fee
 *   Raydium CP                      creatorFees:false  -> creator fee
 *   Meteora DLMM                    reports the pool's total fee rate (variable fee always on)
 *   Raydium v4 / DAMM v2 / PumpSwap reports the effective fee at the reference size
 *
 * No signing, no sending. One RPC endpoint that can batch getMultipleAccountsInfo.
 *
 *   RPC_URL=https://... node tools/fee-scan.mjs [poolsFile]
 * poolsFile: one pool address per line (default site/pools.txt).
 */
import fs from 'fs';
import { Connection, PublicKey } from '@solana/web3.js';
import { ExactQuoter } from '../lib/quoter.mjs';
import { loadPumpConfigs } from '../lib/pump-quote.mjs';

const RPC = (process.env.RPC_URL || '').trim();
if (!RPC) { console.log('set RPC_URL'); process.exit(1); }
const POOLS_FILE = process.argv[2] || new URL('../site/pools.txt', import.meta.url);
const OUT = new URL('../site/data.json', import.meta.url);

const WSOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
const KNOWN = { [WSOL]: 'SOL', [USDC]: 'USDC', [USDT]: 'USDT' };
const MINTS = { 'Meteora DLMM': [88, 120], 'Raydium CLMM': [73, 105], Whirlpool: [101, 181],
  'Raydium CP': [168, 200], 'Raydium v4': [400, 432], 'Meteora DAMM v2': [168, 200], 'Pump.fun Amm': [43, 75] };
const sym = (m) => KNOWN[m] || (m.slice(0, 4) + '…');
const bps = (full, base) => (base === 0n ? NaN : (1 - Number(full) / Number(base)) * 1e4);

const pools = fs.readFileSync(POOLS_FILE, 'utf8').trim().split('\n')
  .map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));

const conn = new Connection(RPC, 'processed');
const rows = [];
let pumpConfigs = null;

for (const pool of pools) {
  try {
    const q = new ExactQuoter();
    q.registerAll([pool]);
    await q.refresh(conn);
    const meta = q.pools.get(pool);
    if (!meta?.venue) { console.log('skip (unsupported):', pool.slice(0, 8)); continue; }
    const venue = meta.venue;
    if (venue === 'Pump.fun Amm') { pumpConfigs ??= await loadPumpConfigs(conn); q.setPumpConfigs(pumpConfigs); }
    q.slot = await conn.getSlot('processed');
    await q.refresh(conn);
    q.opts.clock = Math.floor(Date.now() / 1000);

    const d = q.data.get(pool);
    const [o0, o1] = MINTS[venue];
    const m0 = new PublicKey(d.subarray(o0, o0 + 32)).toBase58();
    const m1 = new PublicKey(d.subarray(o1, o1 + 32)).toBase58();
    const base = [m0, m1].includes(WSOL) ? WSOL : [m0, m1].includes(USDC) ? USDC : m0;
    const size = base === WSOL ? 20_000_000n : base === USDC ? 2_500_000n
      : (() => { const md = q.data.get(base); return 10n ** BigInt(md && md.length > 44 ? md[44] : 6); })();

    const full = q.quote(pool, base, size);
    if (!full.ok) { console.log('skip (' + full.reason.slice(0, 30) + '):', pool.slice(0, 8)); continue; }

    let hiddenBps = 0, hiddenKind = 'none';
    if (venue === 'Raydium CLMM' || venue === 'Whirlpool') {
      q.opts.dynamicFees = false; const b = q.quote(pool, base, size); q.opts.dynamicFees = true;
      if (b.ok && b.out !== full.out) { hiddenBps = bps(full.out, b.out); hiddenKind = venue === 'Whirlpool' ? 'adaptive fee' : 'dynamic fee'; }
    } else if (venue === 'Raydium CP') {
      q.opts.creatorFees = false; const b = q.quote(pool, base, size); q.opts.creatorFees = true;
      if (b.ok && b.out !== full.out) { hiddenBps = bps(full.out, b.out); hiddenKind = 'creator fee'; }
    }

    rows.push({ pool, venue, pair: sym(m0) + ' / ' + sym(m1),
      hiddenKind, hiddenBps: Number.isFinite(hiddenBps) ? +hiddenBps.toFixed(2) : 0,
      hasHidden: hiddenKind !== 'none' && Math.abs(hiddenBps) >= 0.01 });
    process.stdout.write('.');
  } catch (e) { console.log('\nerror', pool.slice(0, 8), String(e.message).slice(0, 50)); }
}

rows.sort((a, b) => Math.abs(b.hiddenBps) - Math.abs(a.hiddenBps));
const out = { generatedAt: new Date().toISOString(), scanned: pools.length, priced: rows.length,
  withHidden: rows.filter((r) => r.hasHidden).length, rows };
fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n');
console.log('\nwrote', OUT.pathname ?? OUT, '·', rows.length, 'priced,', out.withHidden, 'with a hidden fee');
process.exit(0);
