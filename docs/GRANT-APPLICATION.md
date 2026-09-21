# Grant application draft: sol-exact-quote

> **For the applicant.** This is a draft to adapt to each program's form. It was written from the repository's own measurements.
> The budget is a suggested starting point: about 640 hours at $35/hour, itemised below. You can change it.
> Your contact email goes in each application form, not in this public file.
> - Solana Foundation: apply at solana.org/grants-funding. Grants are milestone-based and require open source.
> - Superteam Instagrants: through Superteam Earn, via Superteam Pakistan (apply here first).
> - Orca's Whirlpools Builders Program, if a round is open.

---

## Project

**Name:** sol-exact-quote
**Repository:** https://github.com/faduuuu1/sol-exact-quote
**License:** Apache-2.0. The library holds no funds, deploys no program, and has no token.
**Applicant:** Fahad Ullah · @faduuuu1 · contact email in the application form · Pakistan

**One line:** an open-source library that returns the exact output of a swap on seven Solana DEX venues from raw account
bytes, verified against mainnet simulation, and refuses rather than approximates.

## Problem

Every wallet, router, analytics dashboard, risk engine and trading tool on Solana needs to know what a swap will return.
There are two common ways to get that number, and both have a cost:

1. **Ask an aggregator API.** This means a network round trip, a public rate limit, and a route chosen by someone else.
   It also can't price a specific pool you name.
2. **Reimplement each venue's math.** Here the fee model is where it goes wrong. Several venues now charge fee components
   that the obvious reading of the pool account does not show. We measured the error of leaving each one out, on mainnet,
   on state re-read immediately before each simulation:

| Fee component a base-rate quote leaves out | Share of sampled pools | Error |
|---|---|---|
| Raydium CLMM dynamic (volatility) fee | 12 of 40 | −6.23 bps at every size |
| Orca Whirlpool adaptive fee (separate Oracle account) | 18 of 37 | −5.37 to −17.66 bps, growing with size |
| Raydium CP creator fee | pools with it enabled | −92.50 bps at a 1% rate |
| PumpSwap market-cap-tiered fee | all | 0.30%–2.27%. A constant rate invented 18 false price gaps. |

There are structural traps as well:
- **The executable tick-array window.** A swap instruction carries 3 tick arrays, so quoting across more overstated output by 8.27 bps.
- **Uninitialised current tick arrays.** The program rejects the swap, but a naive quote succeeds.
- **Token-2022 transfer-fee mints.** The AMM cannot see the cut.
- **Dead or disabled pools.**
- **DAMM v2's two pool types.**

Each of these makes a quote **overstate** the output. That is the harmful direction: a minimum-out set on it fails, a
split routed on it underdelivers, and a displayed price impact is too small.

## What exists today (v0.1)

- **Quoter.** It covers 7 venues:
  - Meteora DLMM
  - Meteora DAMM v2
  - Raydium CLMM
  - Raydium CP
  - Raydium v4
  - Orca Whirlpool
  - PumpSwap

  It is about 3,800 lines of JavaScript and TypeScript. `quote()` is synchronous and never throws. After one batched
  refresh it makes zero network calls.
- **Refusals.** When an account is missing, or a pool is in a state the model doesn't cover, the quoter returns a reason
  instead of a number.
- **Swap builders** for all 7 venues, so every quote can be checked against the chain.
- **`tools/verify.mjs`.** It quotes a swap, builds it, and simulates it on mainnet (nothing is signed), then compares the
  two to the unit. It flags any case where the pool traded between the quote and the simulation.
- **Offline fixtures and `npm test`.** Recorded account bytes with a pinned clock, replayed without a network.
- **Validation result:** **125 of 125** simulated swaps exact to the unit (worst error 0.0000 bps), across 23 pools on all 7 venues, both directions, three sizes each (2026-09-21). Another 12 rows were excluded because the pool traded between quote and simulation; they are all listed. On the live adaptive-fee Whirlpool, a base-rate-only quote missed by −17.7 to −18.0 bps. The 125 recorded fixtures replay offline (`npm test`: 126 of 126 pass), and the suite fails when a fee component is removed, which was checked. Full table: `docs/VALIDATION.md`.

## Who uses it

- **Wallets:** correct minimum-out and price-impact display.
- **Routers and aggregators:** local pricing of named pools with no API round trip.
- **LP and analytics dashboards:** exact depth and impact.
- **Risk and liquidation engines:** exact proceeds of a forced swap.
- **Researchers and trading developers:** a reference implementation, with a test harness that proves it.

## Milestones

| # | Deliverable | Acceptance criteria | Duration | Budget |
|---|---|---|---|---|
| M1 | **Rust crate** with the same seven venues | Every fixture in the corpus replays to the same integer in Rust as in JS, with the same refusal reason. Published on crates.io with docs. | 6 weeks (240 h) | $8,400 |
| M2 | **Fixture corpus + CI** | At least 500 mainnet-recorded fixtures across all venues and both directions. GitHub Actions replays them offline on every commit, for JS and Rust. | 3 weeks (100 h) | $3,500 |
| M3 | **Upgrade watch** | A scheduled job re-verifies a pool set against mainnet each week and opens an issue on any mismatch, which catches program upgrades and layout changes. A public status page shows the latest run. | 2 weeks (60 h) | $2,100 |
| M4 | **Two more venues** | Chosen by volume share with the grant committee. Each meets the same bar: exact on unchanged state in `verify.mjs`, with fixtures in CI. | 4 weeks (140 h) | $4,900 |
| M5 | **Maintenance, 12 months** | Mismatches from M3 fixed within 7 days of detection. Releases tagged. Issues answered. | 12 months (~8 h/month, 100 h) | $3,500 |
| | **Total** | | ~15 weeks of build + 12 months of upkeep (640 h) | **$22,400** |

Payment requested per milestone, on delivery against its acceptance criteria.

**How the budget was set.** Each milestone was estimated in hours from the work already done: the seven JS pricers and
the verification tool exist, and a Rust port of two venues is under way. All hours are costed at one rate, $35/hour.
The total is below the reported average of roughly $40,000 for Solana open-source public-good grants.

**Split across programs, so no work is funded twice.** If Superteam Pakistan funds M2 and M3 as an Instagrant
($5,600), the Solana Foundation request drops to M1, M4 and M5 ($16,800). Each application will state which
milestones the other program already covers.

## Why this team

The code in this repository is the evidence. Each fee component above was found the same way:
1. Measure a mismatch against simulation.
2. Read the program source.
3. Implement the fee.
4. Re-verify to 0.00 bps.

The layouts were confirmed against live accounts, not read from IDLs alone. One example: a Raydium CLMM status check read
byte 285 until the struct was summed and the field turned out to be at 389.

[Add your background, prior work and links.]
