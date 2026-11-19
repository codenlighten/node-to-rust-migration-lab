#!/usr/bin/env node
// Load sweep: increase offered concurrency until throughput stops growing, and record how much CPU the SERVER, MONGODB and the LOAD GENERATOR
// each used at every step. The component whose CPU use is at its allotment when throughput flattens is the limiter; if none is, the limit is
// elsewhere (serial work, network stack, or MongoDB latency). Backends take turns; rounds alternate who goes first.
//
//   node sweep.mjs --node-pid P --rust-pid P --mongo-pid P [--rounds 3] [--duration 10] [--conns 8,16,32,64,128,256] [--workers 5] [--out file]
import autocannon from "autocannon";
import { writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import { cfg, connect, resetAndSeed } from "../migration-tests/lib/env.mjs";
import { cpuSec } from "./lib/proc.mjs";

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const ROUNDS = Number(arg("rounds", 3)), DURATION = Number(arg("duration", 10)), WORKERS = Number(arg("workers", 5));
const CONNS = arg("conns", "8,16,32,64,128,256").split(",").map(Number);
const pids = { node: arg("node-pid"), rust: arg("rust-pid"), mongo: arg("mongo-pid") };
const OUT = arg("out", new URL("./results/sweep.json", import.meta.url).pathname);
const SCENARIOS = [
  { id: "point-read", path: "/api/products/1" },
  { id: "list-json", path: "/api/products?pageSize=100&sort=price_desc" },
];
const median = (a) => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

const mongo = await connect();
const sides = [cfg.original, cfg.replacement];
for (const side of sides) await resetAndSeed(mongo, side.db);
await mongo.close();

const raw = [];
for (let round = 1; round <= ROUNDS; round++) {
  const order = round % 2 ? sides : [...sides].reverse();
  for (const sc of SCENARIOS) for (const c of CONNS) for (const side of order) {
    const sCpu0 = cpuSec(pids[side.name]), mCpu0 = cpuSec(pids.mongo), gUsage0 = process.cpuUsage(), t0 = Date.now();
    const r = await autocannon({ url: side.url + sc.path, connections: c, duration: DURATION, workers: WORKERS, timeout: 30 });
    const dt = (Date.now() - t0) / 1000, gu = process.cpuUsage(gUsage0);
    const row = {
      round, backend: side.name, scenario: sc.id, connections: c, rps: r.requests.average, p50: r.latency.p50, p99: r.latency.p99,
      errors: r.errors + r.timeouts + r.non2xx,
      serverCores: (cpuSec(pids[side.name]) - sCpu0) / dt, mongoCores: (cpuSec(pids.mongo) - mCpu0) / dt,
      // process.cpuUsage covers the main thread and the autocannon worker threads (same process); microseconds
      generatorCores: (gu.user + gu.system) / 1e6 / dt,
    };
    raw.push(row);
    console.log(`r${round} ${sc.id.padEnd(10)} ${side.name.padEnd(5)} c=${String(c).padStart(3)} ${row.rps.toFixed(0).padStart(7)} rps p99 ${String(row.p99).padStart(4)} ms | cores: server ${row.serverCores.toFixed(2)} mongo ${row.mongoCores.toFixed(2)} gen ${row.generatorCores.toFixed(2)} | errors ${row.errors}`);
  }
}

const summary = [];
for (const sc of SCENARIOS) for (const backend of ["node", "rust"]) for (const c of CONNS) {
  const rows = raw.filter((x) => x.scenario === sc.id && x.backend === backend && x.connections === c);
  const m = (k) => median(rows.map((x) => x[k]));
  summary.push({ scenario: sc.id, backend, connections: c, rpsMedian: m("rps"), rpsMin: Math.min(...rows.map((x) => x.rps)), rpsMax: Math.max(...rows.map((x) => x.rps)),
    p99Median: m("p99"), serverCores: +m("serverCores").toFixed(2), mongoCores: +m("mongoCores").toFixed(2), generatorCores: +m("generatorCores").toFixed(2), errors: rows.reduce((n, x) => n + x.errors, 0) });
}
mkdirSync(new URL("./results/", import.meta.url).pathname, { recursive: true });
writeFileSync(OUT, JSON.stringify({ environment: { generatedAt: new Date().toISOString(), cpu: os.cpus()[0].model, nodeVersion: process.version, rounds: ROUNDS, durationSec: DURATION, generatorWorkers: WORKERS,
  connections: CONNS, note: process.env.BENCH_NOTE ?? "" }, summary, raw }, null, 1));
console.log("wrote", OUT);
