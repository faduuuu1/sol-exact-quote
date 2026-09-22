# Grant application draft: sol-exact-quote

> **For the applicant.** This is a draft to adapt to each program's form. It was written from the repository's own measurements.
> Submitted as a Google Doc following the Foundation's Developer Tooling template. This file mirrors its milestones and budget.
> Your contact email goes in each application form, not in this public file.
> - Solana Foundation: apply at solana.org/grants-funding. Grants are milestone-based and require open source.
> - Superteam Earn has no Pakistan grant open (checked 2026-09-22), so the full request goes to the Solana Foundation.
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

Structured to the Solana Foundation Developer Tooling template:
- **(a)** One milestone per component, each paid on completion.
- **(b)** Maintenance paid month by month.
- **(c)** Adoption metrics paid pro rata, in 25% steps of each target.

All effort is costed at $35/hour.

| # | Milestone / Deliverable | Success criteria | Effort | Amount |
|---|---|---|---|---|
| 1 | **C1: Rust crate**, all 7 venues (beta, crates.io 0.x) | Every fixture replays to the identical integer and identical refusal reason in Rust and JS | 6 weeks (240 h) | $8,400 |
| 2 | **C2: Fixture corpus, CI and production releases** | At least 500 mainnet fixtures. CI replays them for JS and Rust on every commit. Negative controls fail. npm and crates.io 1.0 releases published | 3 weeks (86 h) | $3,000 |
| 3 | **C3: Upgrade watch** | A weekly mainnet re-verification runs, an injected mismatch opens an issue automatically, and a public status page is live | 2 weeks (51 h) | $1,800 |
| 4 | **C4a: Additional venue #1**, chosen by volume share with the Foundation | Exact on unchanged state in `verify.mjs`; fixtures in CI | 2 weeks (60 h) | $2,100 |
| 5 | **C4b: Additional venue #2** | The same bar | 2 weeks (60 h) | $2,100 |
| 6–11 | **Maintenance, months 1–6**, one milestone per month at $250 | Issues triaged, bugs fixed, upgrade-watch mismatches fixed within 7 days, releases tagged | 6 months | $1,500 |
| 12 | **A1: Integrations**: 2 independent public projects depending on the library | npm and crates.io reverse dependencies plus the GitHub dependency graph; public list in the README | grant period | $500 |
| 13 | **A2: Downloads**: 300 in one calendar month, npm and crates.io combined | Public npm and crates.io download APIs; monthly figures published in the repo | grant period | $500 |
| | **Total** | | | **$19,900** |

**How adoption will be driven:**
- Integration guides and runnable examples: wallet minimum-out, router pricing, and a service fed by gRPC.
- A technical write-up on the hidden fee components and how to verify a quoter.
- Outreach, with pull requests, to open-source Solana projects that hand-roll swap quotes today.

The total is below the reported average of roughly $40,000 for Solana open-source public-good grants.

## Why this team

The code in this repository is the evidence. Each fee component above was found the same way:
1. Measure a mismatch against simulation.
2. Read the program source.
3. Implement the fee.
4. Re-verify to 0.00 bps.

The layouts were confirmed against live accounts, not read from IDLs alone. One example: a Raydium CLMM status check read
byte 285 until the struct was summed and the field turned out to be at 389.

[Add your background, prior work and links.]
