/**
 * verify.mjs — hold ExactQuoter against the chain, pool by pool.
 *
 * For each pool, both directions, several sizes:
 *   1. refresh the quoter and quote the swap at a fixed clock
 *   2. build the real swap instruction for a stand-in holder of the input token
 *   3. simulate it (sigVerify off — nothing is signed or sent) and read what the
 *      output token account actually received
 *   4. re-read every account the quote used: if any changed, the row is marked
 *      MOVED, because the simulation then priced different state than the quote
 *
 * A row is EXACT when the chain delivered the quoted amount to the unit.
 * For Raydium CLMM and Whirlpool pools with a volatility fee, the column
 * "no-dyn" shows what the same quote would be off by without that fee.
 *
 *   RPC_URL=https://... node tools/verify.mjs <pool> [<pool> ...]
 *
 * Env:  SIZES     multipliers of the reference size (default 0.2,1,5)
 *       REF_SOL   reference size when the pool holds WSOL (default 0.02)
 *       REF_USDC  reference size when it holds USDC instead (default 2.5)
 *       RECORD=1  write each simulated row as an offline fixture into test/fixtures/
 *       JSON=path append one JSON line per row, for docs/VALIDATION.md
 */
import fs from 'fs';
import { Connection, PublicKey, VersionedTransaction, TransactionMessage, ComputeBudgetProgram } from '@solana/web3.js';
import { ExactQuoter } from '../lib/quoter.mjs';
import { loadPumpConfigs, loadPumpConfigBytes } from '../lib/pump-quote.mjs';
import { buildLeg, findSigner, tokenProgramOf, createAtaIdempotentIx, ataFor } from '../lib/build.mjs';

const RPC = (process.env.RPC_URL || '').trim();
if (!RPC) { console.log('set RPC_URL (see .env.example)'); process.exit(1); }
const POOLS = process.argv.slice(2);
if (!POOLS.length) { console.log('usage: node tools/verify.mjs <pool> [<pool> ...]'); process.exit(1); }

const WSOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SIZES = (process.env.SIZES ?? '0.2,1,5').split(',').map(Number);
const REF_SOL = Number(process.env.REF_SOL ?? 0.02), REF_USDC = Number(process.env.REF_USDC ?? 2.5);
const RECORD = process.env.RECORD === '1';
const JSON_OUT = process.env.JSON || null;
const FIXDIR = new URL('../test/fixtures/', import.meta.url);

/** Where each venue keeps its two mints. */
const MINTS = { 'Meteora DLMM': [88, 120], 'Raydium CLMM': [73, 105], Whirlpool: [101, 181],
  'Raydium CP': [168, 200], 'Raydium v4': [400, 432], 'Meteora DAMM v2': [168, 200], 'Pump.fun Amm': [43, 75] };
const amountAt = (d) => (d && d.length >= 72 ? d.readBigUInt64LE(64) : 0n);

const conn = new Connection(RPC, 'processed');
let pumpConfigs = null, pumpBytes = null;
const rows = [];

for (const pool of POOLS) {
  const q = new ExactQuoter();
  q.registerAll([pool]);
  await q.refresh(conn);
  const meta = q.pools.get(pool);
  if (!meta?.venue) { console.log('\n  ' + pool + '   not a supported pool'); continue; }
  const venue = meta.venue;
  if (venue === 'Pump.fun Amm') {
    pumpConfigs ??= await loadPumpConfigs(conn);
    pumpBytes ??= await loadPumpConfigBytes(conn);
    q.setPumpConfigs(pumpConfigs);
  }
  await q.refresh(conn);
  const d = q.data.get(pool);
  const [o0, o1] = MINTS[venue];
  const m0 = new PublicKey(d.subarray(o0, o0 + 32)).toBase58();
  const m1 = new PublicKey(d.subarray(o1, o1 + 32)).toBase58();
  const base = [m0, m1].includes(WSOL) ? WSOL : [m0, m1].includes(USDC) ? USDC : m0;
  const other = base === m0 ? m1 : m0;
  let ref;
  if (base === WSOL) ref = BigInt(Math.round(REF_SOL * 1e9));
  else if (base === USDC) ref = BigInt(Math.round(REF_USDC * 1e6));
  else { const md = q.data.get(base); ref = 10n ** BigInt(md && md.length > 44 ? md[44] : 6); }

  console.log('\n  ' + venue + '  ' + pool + '   ' + base.slice(0, 6) + ' / ' + other.slice(0, 6));
  console.log('    direction   ' + 'amount in'.padStart(16) + 'quoted'.padStart(20) + 'chain'.padStart(20)
    + '      bps   no-dyn   verdict');

  for (const [inMint, outMint, label] of [[base, other, 'base->other'], [other, base, 'other->base']]) {
    for (const mult of SIZES) {
      let size;
      if (inMint === base) size = BigInt(Math.max(1, Math.round(Number(ref) * mult)));
      else {
        /* Size the reverse direction off a FRESH quote of the forward one. */
        let f;
        try { await q.refresh(conn); f = q.quote(pool, base, ref); } catch (e) { f = { ok: false, reason: String(e.message).slice(0, 60) }; }
        if (!f.ok) { console.log('    ' + label + '   cannot size: ' + f.reason); break; }
        size = BigInt(Math.max(1, Math.floor(Number(f.out) * mult)));
      }
      const row = { venue, pool, label, inputMint: inMint, amountIn: String(size) };
      rows.push(row);
      const line = (s) => console.log('    ' + label.padEnd(12) + String(size).padStart(16) + s);
      /* One retry: a rate-limited RPC read is not a verdict on the quoter. */
      for (let attempt = 0; attempt < 2; attempt++) {
      delete row.verdict; delete row.reason;
      try {
        /* Slot first: a slow getSlot AFTER the refresh let the quoter's 3 s age check refuse its own state. */
        q.slot = await conn.getSlot('processed');
        await q.refresh(conn);
        q.opts.clock = Math.floor(Date.now() / 1000);
        const quote = q.quote(pool, inMint, size);
        const snap = q.snapshot();
        let noDyn = null;
        if (quote.ok && (venue === 'Raydium CLMM' || venue === 'Whirlpool')) {
          q.opts.dynamicFees = false;
          const qs = q.quote(pool, inMint, size);
          q.opts.dynamicFees = true;
          if (qs.ok && qs.out !== quote.out) noDyn = qs.out;
        }
        const clock = q.opts.clock;
        q.opts.clock = null;
        Object.assign(row, { clock, slot: q.slot });
        if (!quote.ok) { row.verdict = 'refused'; row.reason = quote.reason; line('   refused: ' + quote.reason); break; }
        row.quoted = String(quote.out);

        const inProg = await tokenProgramOf(conn, inMint);
        const owner = await findSigner(conn, inMint, size * 2n, inProg);
        if (!owner) { row.verdict = 'no stand-in'; line('   no stand-in holder of the input token'); break; }
        const outProg = await tokenProgramOf(conn, outMint);
        const outAta = ataFor(owner, new PublicKey(outMint), outProg);
        const { ix } = await buildLeg(conn, q, pool, inMint, size, owner, 0n);
        const pre = await conn.getAccountInfo(outAta, 'processed');
        const { blockhash } = await conn.getLatestBlockhash('processed');
        const tx = new VersionedTransaction(new TransactionMessage({ payerKey: owner, recentBlockhash: blockhash,
          instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
            createAtaIdempotentIx({ payer: owner, owner, mint: new PublicKey(outMint), tokenProgram: outProg }), ix] })
          .compileToV0Message());
        const sr = await conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true,
          commitment: 'processed', accounts: { encoding: 'base64', addresses: [outAta.toBase58()] } });

        /* Did anything the quote read change before the simulation ran? */
        const keys = Object.keys(snap.accounts);
        const now = [];
        for (let i = 0; i < keys.length; i += 100) {
          now.push(...await conn.getMultipleAccountsInfo(keys.slice(i, i + 100).map((k) => new PublicKey(k)), 'processed'));
        }
        const moved = keys.some((k, i) => !now[i] || now[i].data.toString('base64') !== snap.accounts[k].data);
        row.stateMoved = moved;

        if (sr.value.err) {
          const why = [...(sr.value.logs ?? [])].reverse().find((l) => /fail|error|slippage/i.test(l)) ?? '';
          row.verdict = 'sim error'; row.reason = JSON.stringify(sr.value.err).slice(0, 60) + ' ' + why.slice(0, 60);
          line('   sim error ' + row.reason);
          break;
        }
        const acc = sr.value.accounts?.[0];
        const got = (acc ? amountAt(Buffer.from(acc.data[0], 'base64')) : 0n) - amountAt(pre?.data);
        const bps = Number(quote.out) === 0 ? NaN : (Number(got) / Number(quote.out) - 1) * 1e4;
        const bpsNoDyn = noDyn === null ? null : (Number(got) / Number(noDyn) - 1) * 1e4;
        const exact = got === quote.out;
        Object.assign(row, { chain: String(got), bps, bpsNoDyn, exact, cu: sr.value.unitsConsumed,
          verdict: exact ? 'EXACT' : moved ? 'moved' : 'OFF' });
        line(String(quote.out).padStart(20) + String(got).padStart(20) + bps.toFixed(4).padStart(9)
          + (bpsNoDyn === null ? '' : bpsNoDyn.toFixed(2)).padStart(9) + '   ' + row.verdict
          + (moved && !exact ? ' (state changed between quote and simulation)' : ''));

        if (RECORD && !moved) {
          const name = venue.replace(/[^A-Za-z0-9]+/g, '-').toLowerCase() + '-' + pool.slice(0, 8)
            + '-' + label.replace('->', '-') + '-' + size + '.json';
          const fx = { venue, pool, inputMint: inMint, amountIn: String(size), clock, slot: row.slot,
            quoted: String(quote.out), chain: String(got), exact, recordedAt: new Date().toISOString(),
            accounts: snap.accounts, missing: snap.missing,
            pumpConfigs: venue === 'Pump.fun Amm' ? { globalConfig: pumpBytes.globalConfig.toString('base64'),
              feeConfig: pumpBytes.feeConfig ? pumpBytes.feeConfig.toString('base64') : null } : null };
          fs.mkdirSync(FIXDIR, { recursive: true });
          fs.writeFileSync(new URL(name, FIXDIR), JSON.stringify(fx) + '\n');
        }
      } catch (e) {
        q.opts.clock = null; q.opts.dynamicFees = true;
        row.verdict = 'error'; row.reason = String(e.message).slice(0, 80);
        if (attempt === 1) line('   error: ' + row.reason);
        else continue;
      }
      break;
      }
      if (JSON_OUT) fs.appendFileSync(JSON_OUT, JSON.stringify(row) + '\n');
    }
  }
}

const sim = rows.filter((r) => r.chain !== undefined);
const still = sim.filter((r) => !r.stateMoved);
const exact = still.filter((r) => r.exact);
const worst = still.reduce((m, r) => Math.max(m, Math.abs(r.bps)), 0);
console.log('\n  simulated ' + sim.length + '   state unchanged ' + still.length + '   EXACT ' + exact.length
  + ' of ' + still.length + '   worst |bps| on unchanged state ' + worst.toFixed(4)
  + '   refused ' + rows.filter((r) => r.verdict === 'refused').length);
process.exit(0);
