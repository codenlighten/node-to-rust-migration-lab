# Performance report

Measured, not assumed. Raw data: `benchmarks/results/run-A-two-cores.json`, `run-B-one-core.json` and the thermal/clock logs
`guard-A.log`, `guard-B.log`. Method and caveats are part of the result; read them before quoting a number.

## Setup

* Host: a laptop (12th-gen Intel i7-12650H), **E-cores 12-14 only** (max 3.5 GHz; measured median 3,499 MHz on all three during
  both runs), system turbo setting on, nothing on the P-cores. Package temperature 28-52 C, fan 2,700-2,800 RPM, no throttling, no aborts.
  One co-tenant: a read-only `tar` at nice 19 on a P-core.
* Both backends run as containers (Node 22 / Rust release build with thin LTO) against the same MongoDB 7 single-node replica set
  image, each on its own identically seeded database, taking turns (never at the same time).
* Load generator: autocannon (single thread) on CPU 14, 32 connections (8 for login, 16 for order writes), 15 s per measurement,
  **5 rounds alternating which backend goes first**; the tables show the median and the min-max range. Code version: `277b0b3`.
* **Run A:** both servers and MongoDB share CPUs 12-13. **Run B:** each server alone on CPU 12, MongoDB on CPU 13.
  Run B removes Rust's ability to use a second thread and is the fairer *per-core* comparison.

## Run B: one core per server

| Scenario | Node req/s (min-max) | Rust req/s (min-max) | Rust / Node | Node p99 | Rust p99 | Node CPU | Rust CPU |
|---|---|---|---|---|---|---|---|
| GET /health | 5,920 (5,894-6,002) | 44,281 (43,918-48,078) | 7.48x | 19 ms | 1 ms | 100% | 86% |
| GET /api/products/1 | 1,854 (1,723-1,864) | 5,318 (5,247-5,488) | 2.87x | 39 ms | 14 ms | 100% | 63% |
| GET /api/products?pageSize=100 | 1,126 (1,114-1,142) | 2,615 (2,539-2,691) | 2.32x | 66 ms | 29 ms | 100% | 62% |
| GET /api/products?search=a | 1,195 (1,177-1,212) | 2,210 (2,176-2,265) | 1.85x | 63 ms | 32 ms | 100% | 47% |
| POST /api/auth/login (bcrypt) | 15 (14-15) | 17 (17-18) | 1.15x | 863 ms | 889 ms | 100% | 97% |
| POST /api/orders (tx) | 74 (73-77) | 212 (209-217) | 2.85x | 1555 ms | 703 ms | 64% | 19% |

## Run A: two cores shared with MongoDB

| Scenario | Node req/s (min-max) | Rust req/s (min-max) | Rust / Node | Node p99 | Rust p99 | Node CPU | Rust CPU |
|---|---|---|---|---|---|---|---|
| GET /health | 6,424 (6,389-6,634) | 44,434 (44,357-48,709) | 6.92x | 9 ms | 1 ms | 109% | 86% |
| GET /api/products/1 | 1,791 (1,699-1,823) | 6,042 (5,863-6,135) | 3.37x | 34 ms | 14 ms | 102% | 82% |
| GET /api/products?pageSize=100 | 963 (955-968) | 2,872 (2,820-3,117) | 2.98x | 61 ms | 26 ms | 88% | 81% |
| GET /api/products?search=a | 957 (953-962) | 2,878 (2,803-2,968) | 3.01x | 59 ms | 27 ms | 84% | 69% |
| POST /api/auth/login (bcrypt) | 15 (15-15) | 33 (32-33) | 2.22x | 918 ms | 425 ms | 100% | 185% |
| POST /api/orders (tx) | 116 (111-118) | 386 (381-389) | 3.32x | 682 ms | 328 ms | 79% | 38% |

Memory (resident set): idle 85 MB (Node) vs 10 MB (Rust); after the load 101-103 MB vs 14-15 MB.

## What the data supports

* **Observed, consistent across two configurations (5 rounds of 15 s each; per-round values are in the raw JSON):** Rust served more
  requests per second than Node in all six scenarios, and within each configuration the min-max ranges do not overlap. That describes
  these ten short measurements per scenario; it is not a confidence interval, and it has not been repeated on another day or machine.
  Zero request errors in either run.
* **Observed:** at this offered load, DB-backed endpoints ran about 1.9x to 2.9x faster on Rust per core, and the framework-only
  `/health` about 7.5x. Both backends return identical responses on these routes (see the compatibility report), use the same queries
  and indexes by design, and hash with bcrypt cost 10.
* **Observed:** roughly 6-7x less memory under load.
* **These are results at a given load, not capacity limits.** In run B Node was CPU-saturated (100% of its core) on every read scenario.
  Rust was not (47-63% of its core on DB reads), so something else limited it: possibly MongoDB sharing the box, possibly the
  single-threaded load generator. `/health` returned the same ~44,000 req/s in runs A and B while using under one core and without
  touching MongoDB, which points at the generator for that scenario (hypothesized, not isolated). Rust's ceiling was therefore not
  measured; a faster generator and a load sweep would be needed to find it.
* **bcrypt login:** about 15 vs 17 logins/s per core in run B. This compares Rust's `bcrypt` crate with the pure-JS `bcryptjs`
  at the same cost factor; it does not isolate language overhead. The 2.2x in run A mostly reflects Rust using a second core.
* **Order writes are designed to induce contention.** Every request decrements the same product inside a transaction, so concurrent
  transactions conflict and retry, and retries may contribute to the high tail latency (p99 0.3-1.6 s). Retry counts were not
  measured, and the two backends use different retry code (the Node driver's `withTransaction` vs this repo's time-budgeted loop).
  Treat it as a stress test of transaction handling, not a realistic mixed workload.

## What it does not show

* **Hypothesized, untested:** Node in cluster mode (one worker per core) would narrow the gap in run A; a native `bcrypt` addon
  (this repo uses pure-JS `bcryptjs`, for portability) would change the bcrypt result; neither was tried.
* Not measured: cold start, a mixed read/write workload, long soak runs and garbage-collection effects, other MongoDB settings,
  more than two server cores, network latency between tiers.
* Absolute numbers are specific to this machine, this load generator and these container limits. The ratios compare these two implementations on these workloads, not Node/Express and Rust/Axum in general.

## Reproduce

```bash
docker compose --profile verify up -d node-verify rust-verify mongo
cd benchmarks && npm install && node benchmark.mjs --rounds 5 --duration 15
```
Pin the servers, MongoDB and the generator to disjoint CPUs on a quiet host (see `benchmarks/README.md`) and record the clocks;
otherwise label the numbers indicative.
