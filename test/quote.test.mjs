/**
 * Replay recorded fixtures OFFLINE — no RPC, no clock.
 *
 * Each fixture (written by `RECORD=1 node tools/verify.mjs`) holds every account a
 * quote read, the clock and slot it was priced at, and what the chain delivered
 * when the same swap was simulated against that state. Two assertions per fixture:
 *
 *   reproducible   the quote from these bytes equals the recorded quote, to the unit
 *   exact          where the recording matched the chain, it still does
 *
 *   npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import { ExactQuoter } from '../lib/quoter.mjs';
import { decodePumpConfigs } from '../lib/pump-quote.mjs';

const DIR = new URL('./fixtures/', import.meta.url);
const files = fs.existsSync(DIR) ? fs.readdirSync(DIR).filter((f) => f.endsWith('.json')).sort() : [];

test('fixtures exist', () => {
  assert.ok(files.length > 0, 'no fixtures in test/fixtures — record some with RECORD=1 node tools/verify.mjs');
});

for (const f of files) {
  const fx = JSON.parse(fs.readFileSync(new URL(f, DIR), 'utf8'));
  test(fx.venue + '  ' + f, () => {
    const q = new ExactQuoter({ clock: fx.clock, slot: fx.slot });
    q.registerAll([fx.pool]);
    if (fx.pumpConfigs) {
      q.setPumpConfigs(decodePumpConfigs(Buffer.from(fx.pumpConfigs.globalConfig, 'base64'),
        fx.pumpConfigs.feeConfig ? Buffer.from(fx.pumpConfigs.feeConfig, 'base64') : null));
    }
    const accounts = {};
    for (const [a, v] of Object.entries(fx.accounts)) accounts[a] = { data: Buffer.from(v.data, 'base64'), owner: v.owner };
    const unsupplied = q.loadAccounts(accounts, fx.missing);
    assert.deepEqual(unsupplied, [], 'fixture lacks derived accounts: ' + unsupplied.join(', '));

    const r = q.quote(fx.pool, fx.inputMint, BigInt(fx.amountIn));
    assert.ok(r.ok, 'quote refused: ' + r.reason);
    assert.equal(String(r.out), fx.quoted, 'quote no longer reproduces the recorded value');
    if (fx.exact) assert.equal(String(r.out), fx.chain, 'quote no longer matches what the chain delivered');
  });
}
