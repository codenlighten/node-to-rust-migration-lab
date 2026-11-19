# Performance report

Measured, not assumed. Raw data: `benchmarks/results/run-A-two-cores.json`, `run-B-one-core.json`, `run-C-node-cluster.json`, `sweep-D.json`,
`bcrypt-micro.jsonl` and the thermal/clock logs `guard-A.log` ... `guard-D.log`. CPU percentages in the tables are of **one core** (200% = two cores busy). Method and caveats are part of the result; read them before quoting a number.

## Setup

* Host: a laptop (12th-gen Intel i7-12650H), E-cores only, system turbo setting on, no benchmark component on the P-cores.
  **Runs A and B:** E-cores 12-14 (max 3.5 GHz; measured median 3,499 MHz on all three), package 28-52 C, fan 2,700-2,800 RPM, no throttling, no
  aborts; one co-tenant, a read-only `tar` at nice 19 on a P-core. **Run C:** E-cores 12-15, median 3,499 MHz on all four, package 33-52 C, fan
  2,700-4,100 RPM, no aborts (233 guard samples); the other session's job was paused (stopped), so no co-tenant.
* Both backends run as containers (Node 22 / Rust release build with thin LTO) against the same MongoDB 7 single-node replica set
  image, each on its own identically seeded database, taking turns (never at the same time).
* Load generator: autocannon (single thread), 32 connections (8 for login, 16 for order writes), 15 s per measurement (12 s in run C),
  **5 rounds alternating which backend goes first**; the tables show the median and the min-max range. Code versions: `277b0b3` (A, B),
  `0520889` (C).
* **Run A:** both servers and MongoDB share CPUs 12-13. **Run B:** each server alone on CPU 12, MongoDB on CPU 13 (a per-core comparison).
  **Run C (added after review):** Node in **cluster mode with 2 workers** versus Rust, both on CPUs 12-13, MongoDB alone on CPU 14, load
  generator on CPU 15, 5 rounds of 12 s, same guard. Run C is the most directly comparable two-server-core configuration here, since Node uses
  both cores. It also differs from A/B in MongoDB and generator placement, duration and co-tenant status, so the change in ratios cannot be
  attributed to clustering alone. In A and B the generator ran on CPU 14. Run C used `bcryptjs` like the others.

## Run D: load sweep with per-component CPU (a different, larger machine)

Purpose: find what limited the Rust numbers in runs A-C. Host: AMD Ryzen 7 260 (8 cores, 2 threads each; governor performance, boost on, median
4,963 MHz on the used CPUs, Tctl 34-67 C, fans 2,300-3,100 RPM, no aborts, 242 guard samples). Layout by physical core: servers (Node
cluster of 2 workers, then Rust, never together) on 2 cores = 4 hardware threads; MongoDB on 2 cores = 4 threads; load generator (autocannon, 5 worker
threads) on 3 cores = 6 threads; one core left to the OS. Co-tenants: a desktop file indexer and a low-priority upload. Offered concurrency 8-256
connections, 10 s per point, 3 alternating rounds, code version `92b87b4`. "Cores" below are CPU-seconds per second summed over a component's threads
(4.0 = all four of its hardware threads busy). These are logical-CPU times, not physical-core-equivalent work: two SMT threads sharing a core each get less than a full core.

| Endpoint | Connections | Node req/s | Rust req/s | Rust / Node | Node server | Rust server | Node mongod | Rust mongod | Generator (Node / Rust) |
|---|---|---|---|---|---|---|---|---|---|
| GET /api/products/1 | 8 | 7,338 | 19,832 | 2.70x | 2.20 | 1.78 | 0.82 | 2.20 | 0.42 / 0.74 |
| GET /api/products/1 | 16 | 7,449 | 32,746 | 4.40x | 2.32 | 2.74 | 0.86 | 3.66 | 0.42 / 1.07 |
| GET /api/products/1 | 32 | 7,548 | 33,161 | 4.39x | 2.33 | 2.80 | 0.91 | 3.77 | 0.44 / 1.09 |
| GET /api/products/1 | 256 | 7,017 | 32,518 | 4.63x | 2.41 | 3.08 | 0.90 | 3.81 | 0.44 / 1.18 |
| GET /api/products?pageSize=100 | 8 | 4,769 | 10,507 | 2.20x | 2.34 | 2.00 | 1.16 | 2.42 | 0.38 / 0.48 |
| GET /api/products?pageSize=100 | 16 | 4,602 | 16,683 | 3.63x | 2.39 | 3.15 | 1.17 | 3.80 | 0.38 / 0.65 |
| GET /api/products?pageSize=100 | 32 | 4,509 | 16,408 | 3.64x | 2.37 | 3.13 | 1.24 | 3.81 | 0.39 / 0.66 |
| GET /api/products?pageSize=100 | 256 | 3,798 | 15,722 | 4.14x | 2.61 | 3.35 | 1.01 | 3.80 | 0.38 / 0.70 |

CPU cost per request (CPU time of each component divided by requests served):

| Endpoint (32 connections) | Node server | Rust server | Node / Rust | Node mongod | Rust mongod |
|---|---|---|---|---|---|
| GET /api/products/1 | 0.31 ms | 0.08 ms | 3.7x | 0.12 ms | 0.11 ms |
| GET /api/products?pageSize=100 | 0.53 ms | 0.19 ms | 2.8x | 0.27 ms | 0.23 ms |

Findings:

* **Node is limited by its own CPU.** Its two workers saturate from the first step (7.3-7.5k req/s on the point read from 8 connections upward, server at
  2.2-2.4 cores while MongoDB used under 1 and the generator under 0.5); more connections only add queueing delay (p99 1 -> 49 ms on the point read).
* **Rust's throughput plateaus at about 32.5k (point read) and 16k (list) req/s from 16 connections upward.** At the plateau MongoDB was at 3.7-3.8 of its 4
  threads, the Rust server at 2.8-3.4 of 4, and the generator at about 1.1-1.2 of 6 in aggregate. MongoDB is the busiest component and a plausible limiter, and
  the Rust server is also close to its allotment; neither MongoDB nor the generator (whose individual worker threads were not measured) was isolated as the
  limiting component. Giving MongoDB more cores would resolve it; that was not done.
* **Why runs A-C probably understated Rust.** In run C, MongoDB had one core and the generator one thread, and Rust reached only about 5,300 req/s while using
  under one core: that suggests a constraint outside the Rust server but does not identify it. With a larger database tier and a multi-threaded generator,
  the same two-core Node cluster is outrun by **4.4x-4.6x** (point read) and **3.6x-4.1x** (list) at 16-256 connections (2.7x and 2.2x at 8 connections,
  before Node saturates). Run C's 1.2-1.7x on those routes should be read as a figure limited by that rig, not as a general Rust lead.
* **Server CPU per request** was about 3.6x higher for Node on the point read and 2.8-3.2x on the list. MongoDB's CPU per request was nearly the same for both
  backends (about 0.12 ms on the point read), which supports the claim that they do the same database work. These are logical-CPU times in this SMT
  configuration: both the milliseconds and their ratios are specific to it, because SMT contention may differ between the two backends' load.
* **Different machine, different ratios.** Absolute throughput differs substantially by host and backend (at 32 connections Rust's point-read rate here is about
  6x run C's), and the ratios differ by rig; do not mix runs into one table.

## Run C: Node cluster (2 workers) vs Rust, same 2 cores

| Scenario | Node req/s (min-max) | Rust req/s (min-max) | Rust / Node | Node p99 | Rust p99 | Node CPU | Rust CPU |
|---|---|---|---|---|---|---|---|
| GET /health | 10,851 (10,767-10,868) | 46,995 (46,736-48,579) | 4.33x | 13 ms | 1 ms | 200% | 89% |
| GET /api/products/1 | 3,176 (2,905-3,195) | 5,298 (5,270-5,425) | 1.67x | 29 ms | 14 ms | 186% | 77% |
| GET /api/products?pageSize=100 | 1,949 (1,852-1,977) | 2,566 (2,541-2,582) | 1.32x | 38 ms | 29 ms | 184% | 75% |
| GET /api/products?search=a | 1,895 (1,822-1,951) | 2,197 (2,173-2,228) | 1.16x | 32 ms | 32 ms | 169% | 56% |
| POST /api/auth/login (bcrypt) | 30 (30-30) | 35 (35-35) | 1.16x | 430 ms | 352 ms | 200% | 197% |
| POST /api/orders (tx) | 76 (76-77) | 215 (209-218) | 2.81x | 1472 ms | 767 ms | 72% | 23% |

Memory (summed resident set of the whole process tree; shared pages may be counted more than once): Node 276-298 MB under load (250 MB idle, two
workers) vs Rust 15 MB (10 MB idle).

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

* **Observed, consistent across three configurations (5 alternating rounds each; per-round values are in the raw JSON):** Rust served more
  requests per second than Node in all six scenarios in every run; within each run the min-max ranges do not overlap. That describes
  these short measurements; it is not a confidence interval and has not been repeated on another day or machine. Zero request errors.
* **The size of the advantage depends on how Node is run.** Against a single-process Node (runs A and B) Rust led by 1.85-3.37x on the three database **read**
  endpoints. Against Node in cluster mode on the same two cores (run C) it led by **1.16-1.67x** on those same reads on that rig: point read 1.67x,
  JSON list 1.32x, regex search 1.16x; but run D, with more MongoDB and generator capacity than run C, found larger read ratios (3.6-4.6x at 16-256 connections); its limiting component was not confirmed. Clustering may explain part of the smaller gap (a single-process Node cannot use the second core), but run C
  also changed other conditions, so the split is not measured.
* **Framework-only requests** (`/health`): about 4.3x in run C, 7.5x per core. Rust returned ~44-47,000 req/s in every run while using under
  one core of CPU and with no MongoDB involved. The limiting component was not identified (the single-threaded load generator is a candidate), so
  the true ratio is not measured.
* **Transactional order writes:** about 2.8x in runs B and C. This scenario is designed to induce contention (every request decrements the same
  product, so transactions conflict and retry; retries may contribute to the 0.7-1.5 s p99). Retry counts were not measured and the two
  backends use different retry code, so treat it as a stress test, not a verdict on the languages.
* **bcrypt login:** about 1.15x in runs B and C. The microbenchmark below shows why: bcrypt dominates the request and the implementations are
  close.
* **Memory:** in summed process RSS, Rust used about 15 MB under load against about 101-103 MB for single-process Node and 276-298 MB for the
  two-worker cluster (about 7x and 18-20x). Idle: 10 MB vs 85 MB (single process, runs A/B) and 250 MB (cluster, run C). Summed RSS can double-count
  shared pages, so these are not measurements of physical memory.
* **Runs A-C did not measure Rust's capacity; run D shows an observed system plateau, not a Rust-only ceiling.** In runs A-C Rust used 0.47-0.82 of a core on reads
  and returned the same point-read throughput on one core as on two, which suggests a constraint outside the Rust server. Run D found the plateau with MongoDB at
  3.7-3.8 of its 4 threads; Rust's server-only capacity remains unmeasured.

### bcrypt microbenchmark (one pinned core, cost 10, same password, 40 hashes after warm-up)

| Implementation | Hash (median) | Hash (min-max) | Verify (median) |
|---|---|---|---|
| Node `bcryptjs` (pure JS, what this repo uses) | 65.1 ms | 64.5-66.4 | 65.6 ms |
| Node `bcrypt` (native addon) | **49.1 ms** | 47.4-49.3 | 49.2 ms |
| Rust `bcrypt` crate 0.17 | 55.6 ms | 55.6-55.8 | 55.6 ms |

On one core, the native Node addon was the fastest, about 12% faster than Rust's crate, and pure-JS `bcryptjs` was slowest (about 17% slower
than Rust). Language is not what decides bcrypt speed; the implementation is. In this single-core hash test the native addon's median was lower than the Rust crate's; request-level performance with the addon was not measured
(run C used `bcryptjs` with two workers).

## What it does not show

* Not measured: cold start, a mixed read/write workload, long soak runs and garbage-collection effects, other MongoDB settings, more than two
  server cores, network latency between tiers, a test that isolates Rust's server-only capacity (for example by giving MongoDB more cores).
* Node cluster mode was tested in run C (with `bcryptjs`); native bcrypt only in the single-core microbenchmark. A Node setup tuned beyond that (more workers than cores, a
  different HTTP server, native addons elsewhere) was not tried.
* Absolute numbers are specific to this machine, this load generator and these container limits. The ratios compare these two implementations
  on these workloads, not Node/Express and Rust/Axum in general.

## Reproduce

```bash
docker compose --profile verify up -d node-verify rust-verify mongo
cd benchmarks && npm install && node benchmark.mjs --rounds 5 --duration 15   # runs A/B
```
Run C: give the `node-verify` service `NODE_WORKERS=2`, pin `node-verify` and `rust-verify` to the same two CPUs (compose `cpuset`), MongoDB and the
load generator (`taskset`) to one different CPU each, and use `--duration 12`. The bcrypt microbenchmark is `benchmarks/bcrypt-micro/micro.sh <cpu>`.
Pin the servers, MongoDB and the generator to disjoint CPUs on a quiet host (see `benchmarks/README.md`) and record the clocks;
otherwise label the numbers indicative.
