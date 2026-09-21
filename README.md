# sol-exact-quote

Exact offline swap quotes for seven Solana DEX venues, checked against mainnet simulation.

`sol-exact-quote` takes raw account bytes and returns the amount a swap will actually produce, to the unit.
It reproduces each program's integer math, including the fee components that generic quoters leave out.
When it cannot be sure, it **refuses** with a reason instead of returning an approximate number.

| Venue | Program | What is modelled beyond the base curve |
|---|---|---|
| Meteora DLMM | `LBUZKhRx…` | Variable fee from the volatility accumulator, decayed by time and bins crossed. Per-bin walk across bin arrays. |
| Meteora DAMM v2 | `cpamdpZC…` | Both pool types and the fee scheduler, evaluated by the protocol's own SDK. |
| Raydium CLMM | `CAMMCzo5…` | **Dynamic fee** (`dynamic_fee_info`), stepped per tick group. Pool status, `fee_on` modes, and the tick-array window a swap instruction can actually reach. |
| Raydium CP | `CPMMoo8L…` | **Creator fee** on input or output. Protocol, fund and accrued creator fees are subtracted from the vaults. |
| Raydium v4 | `675kPX9M…` | Per-pool fee numerator and denominator. `needTakePnl` is subtracted from the vaults. |
| Orca Whirlpool | `whirLbMi…` | **Adaptive fee** from the Oracle account, stepped per tick group. Fixed and dynamic tick-array layouts. |
| PumpSwap | `pAMMBay6…` | Market-cap-tiered fee, creator fee and virtual quote reserves, computed by the protocol's own SDK math. |

Every venue refuses a mint carrying a Token-2022 **transfer fee**, because the AMM cannot see that cut.

## Why

A quote that leaves out a fee component doesn't fail loudly. It overstates the output, and each downstream user inherits the error: a wallet's minimum-out, a router's split, an LP dashboard's price impact, a liquidation engine's proceeds. The errors below were measured on mainnet, on state re-read right before each simulation:

| Missing component | Pools affected (sample) | Error of a base-rate quote |
|---|---|---|
| Raydium CLMM dynamic fee | 12 of 40 | −6.23 bps at every size |
| Orca Whirlpool adaptive fee | 18 of 37 | −5.37 to −17.66 bps, growing with size |
| Raydium CP creator fee (1%) | pools with it enabled | −92.50 bps |
| PumpSwap tiered fee as a constant | varies 0.30–2.27% | up to 3.3× on virtual-reserve pools |
| CLMM tick arrays past the instruction's 3 | any large swap | −8.27 bps (depth the transaction can't reach) |

**Current result: 125 of 125 simulated swaps exact to the unit** across 23 pools on all 7 venues (2026-09-21), with 12 rows excluded because the pool traded mid-check and all of them listed. On the live adaptive-fee Whirlpool, the base-rate quote was off by −17.7 to −18.0 bps. Full table: **[docs/VALIDATION.md](docs/VALIDATION.md)**.

## Install

Not on npm yet. Build from source:

```bash
git clone https://github.com/givemebot/sol-exact-quote.git && cd sol-exact-quote && npm install && npm test
```

Node 20 or newer. `npm install` compiles the CLMM math (TypeScript) into `dist/`.

## Use

```js
import { Connection } from '@solana/web3.js';
import { ExactQuoter, loadPumpConfigs } from 'sol-exact-quote';

const conn = new Connection(process.env.RPC_URL, 'processed');
const q = new ExactQuoter();
q.registerAll([poolA, poolB /* , ... any number of pools */]);
q.setPumpConfigs(await loadPumpConfigs(conn));    // only needed for PumpSwap pools
await q.refresh(conn);                            // 1-2 batched RPC calls, independent of pool count

const r = q.quote(poolA, inputMint, 1_000_000n);  // synchronous, no network, never throws
if (r.ok) console.log(r.venue, r.out, 'crossed', r.crossed);
else console.log('refused:', r.reason);
```

`refresh()` fetches each pool together with everything its quote depends on: configs, vaults, mints, the tick or bin
arrays around the current price, and the Whirlpool oracle. The addresses it can only know after reading the pool
are fetched in a second batched phase. In steady state a refresh is **one** `getMultipleAccountsInfo` round trip.

### Offline, from your own account feed

```js
const q = new ExactQuoter({ clock: unixSeconds, slot, live: true });
q.registerAll([pool]);
const unsupplied = q.loadAccounts(
  { [addr]: { data: Buffer, owner: 'base58' }, /* ... */ },
  missingAddresses,    // addresses known NOT to exist (uninitialised arrays, absent oracle)
);
// `unsupplied` lists derived addresses you still need to provide; until you do, quotes refuse.
```

`clock` pins the time used by every time-decayed fee, so a replay reproduces a recorded quote exactly.
`live: true` switches off the polling-age check when a subscription keeps the accounts current.

### Options

| Option | Default | Meaning |
|---|---|---|
| `maxAgeMs` | `3000` | Refuse quotes from a polled cache older than this (`0` turns the check off). |
| `live` | `false` | A subscription keeps the cache current, so there is no age check. |
| `clock` | wall clock | Fixed unix seconds for time-dependent fees. |
| `slot` | `null` | Current slot. Needed only for DAMM v2 pools whose fee schedule is keyed on slots. |
| `dynamicFees` | `true` | `false` prices CLMM and Whirlpool without their volatility fee, for A/B checks. |
| `execTickArrays` | `3` | Tick arrays a swap instruction carries, which limits the depth a quote may use. |
| `fetchConcurrency` | `8` | Parallel batched reads in `refresh()`. |
| `commitment` | `processed` | Commitment for `refresh()` reads. |

### Refusals

`quote()` returns `{ ok: false, reason }` rather than a guess. Common reasons:
- A needed account is not loaded.
- A tick array in the executable window is unknown.
- The array holding the current tick is uninitialised (the program would reject the swap).
- The pool is dead or disabled.
- Raydium CLMM `fee_on` is not "from input".
- A Token-2022 transfer-fee mint.
- A DAMM v2 slot-keyed pool with no slot set.

Each reason says which account or condition caused it.

### Building the swap

`sol-exact-quote/build` builds the matching swap instruction for every venue:

```js
import { buildSwapIx } from 'sol-exact-quote/build';
const { ix } = await buildSwapIx(conn, q, pool, inputMint, amountIn, owner, minOut);
```

`minOut` defaults to `0`, which is right only for simulation. Set it before sending anything.

## Verify it yourself

```bash
RPC_URL=https://your-rpc node tools/verify.mjs <pool> [<pool> ...]
```

For each pool, in both directions and at three sizes, `verify.mjs` quotes the swap, builds it for an address that holds
the input token, and **simulates it on mainnet**. Nothing is signed or sent. It then compares what the output account
received with the quote, to the unit. It also re-reads every account the quote used and marks the row `moved` if the
pool traded in between. `RECORD=1` saves each row as an offline fixture.

The RPC must serve `getTokenLargestAccounts`, which is used to find a holder of the input token. Some providers refuse it,
or refuse it for WSOL.

```bash
npm test     # replays every fixture in test/fixtures offline: no RPC, pinned clock
```

Each fixture must reproduce its recorded quote to the unit. Fixtures that matched the chain when recorded must still match it.

## Status and roadmap

- **v0.1 (this release):**
  - JavaScript quoter and builders for 7 venues.
  - Mainnet verification tool.
  - Offline fixture replay.
- **Next:**
  - A Rust crate with byte-for-byte parity against these fixtures.
  - A larger fixture corpus replayed in CI.
  - A scheduled re-verification that flags program upgrades.
  - More venues.

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE), which credits the programs whose on-chain behaviour this reproduces.
