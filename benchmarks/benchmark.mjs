#!/usr/bin/env node
// Reproducible A/B benchmark: Node vs Rust on identical, isolated, identically seeded databases.
// Rounds alternate between implementations (A B A B ...) so drift hits both equally; the report gives
// the median and the min-max spread per metric. A difference smaller than the spread is "inconclusive".
//
//   node benchmark.mjs --node-pid <pid> --rust-pid <pid> [--rounds 3] [--duration 10] [--connections 32]
//
// Environment: ORIGINAL_URL / REPLACEMENT_URL / ORIGINAL_DB / REPLACEMENT_DB / MONGO_URL (see migration-tests/lib/env.mjs).
import autocannon from "autocannon";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { execSync } from "node:child_process";
import os from "node:os";
import { cfg, connect, resetAndSeed } from "../migration-tests/lib/env.mjs";

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const ROUNDS = Number(arg("rounds", 3)), DURATION = Number(arg("duration", 10)), CONNS = Number(arg("connections", 32));
const pids = { node: arg("node-pid"), rust: arg("rust-pid") };
const OUT = new URL("./results/", import.meta.url).pathname;

const rssMb = (pid) => { try { return Number(readFileSync(`/proc/${pid}/status`, "utf8").match(/VmRSS:\s+(\d+)/)[1]) / 1024; } catch { return null; } };
const cpuSec = (pid) => { try { const f = readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1].split(" "); return (Number(f[11]) + Number(f[12])) / 100; } catch { return null; } };
const median = (a) => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

async function login(base, email) {
  await fetch(base + "/api/auth/register", { method: "POST", body: JSON.stringify({ email, password: "password123", name: "bench" }) });
  return (await (await fetch(base + "/api/auth/login", { method: "POST", body: JSON.stringify({ email, password: "password123" }) })).json()).token;
}

const scenarios = (token) => [
  { id: "health", label: "GET /health (framework overhead)", req: { method: "GET", path: "/health" } },
  { id: "point-read", label: "GET /api/products/1 (DB point read)", req: { method: "GET", path: "/api/products/1" } },
  { id: "list-json", label: "GET /api/products?pageSize=100 (DB read + JSON)", req: { method: "GET", path: "/api/products?pageSize=100&sort=price_desc" } },
  { id: "search", label: "GET /api/products?search=a (regex scan)", req: { method: "GET", path: "/api/products?search=a&pageSize=20" } },
  { id: "login-bcrypt", label: "POST /api/auth/login (bcrypt cost 10, CPU-bound)", req: { method: "POST", path: "/api/auth/login", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "bench@example.com", password: "password123" }) }, connections: 8 },
  { id: "order-write", label: "POST /api/orders (transactional write)", req: { method: "POST", path: "/api/orders", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ items: [{ productId: 2, quantity: 1 }] }) }, connections: 16 },
];

async function runOne(side, sc, pid) {
  const cpu0 = cpuSec(pid), t0 = Date.now();
  const r = await autocannon({ url: side.url, connections: sc.connections ?? CONNS, duration: DURATION, requests: [sc.req], timeout: 30 });
  const cpu1 = cpuSec(pid);
  return {
    rps: r.requests.average, p50: r.latency.p50, p97_5: r.latency.p97_5, p99: r.latency.p99,
    non2xx: r.non2xx, errors: r.errors + r.timeouts, rssMb: rssMb(pid),
    cpuPct: cpu0 != null && cpu1 != null ? ((cpu1 - cpu0) / ((Date.now() - t0) / 1000)) * 100 : null,
  };
}

const mongo = await connect();
const sides = [cfg.original, cfg.replacement];
const raw = {};
const idleRss = { node: rssMb(pids.node), rust: rssMb(pids.rust) };
const load0 = os.loadavg();
for (const side of sides) await resetAndSeed(mongo, side.db);
const tokens = {};
for (const side of sides) {
  tokens[side.name] = await login(side.url, "bench@example.com");
  await mongo.db(side.db).collection("products").updateOne({ _id: 2 }, { $set: { stock: 100_000_000 } }); // never run out during the write test
}
for (let round = 1; round <= ROUNDS; round++) {
  // alternate who goes first each round to cancel ordering effects
  const order = round % 2 ? sides : [...sides].reverse();
  for (const idx of ["health", "point-read", "list-json", "search", "login-bcrypt", "order-write"]) {
    for (const side of order) {
      const sc = scenarios(tokens[side.name]).find((s) => s.id === idx);
      const res = await runOne(side, sc, pids[side.name]);
      ((raw[idx] ??= {})[side.name] ??= []).push(res);
      console.log(`round ${round} ${idx.padEnd(13)} ${side.name.padEnd(5)} ${res.rps.toFixed(0).padStart(7)} rps  p50 ${res.p50} ms  p99 ${res.p99} ms  errors ${res.errors} non2xx ${res.non2xx}`);
    }
  }
}
await mongo.close();

const summary = {};
for (const [id, perSide] of Object.entries(raw)) {
  summary[id] = { label: scenarios("x").find((s) => s.id === id).label };
  for (const [name, runs] of Object.entries(perSide)) {
    const f = (k) => runs.map((r) => r[k]).filter((v) => v != null);
    summary[id][name] = {
      rps: { median: median(f("rps")), min: Math.min(...f("rps")), max: Math.max(...f("rps")) },
      p50ms: { median: median(f("p50")) }, p99ms: { median: median(f("p99")), max: Math.max(...f("p99")) },
      rssMbAfter: f("rssMb").length ? median(f("rssMb")) : null, cpuPct: f("cpuPct").length ? median(f("cpuPct")) : null,
      errors: runs.reduce((n, r) => n + r.errors + r.non2xx, 0),
    };
  }
  const a = summary[id].node, b = summary[id].rust;
  const ratio = b.rps.median / a.rps.median;
  const separated = b.rps.min > a.rps.max || a.rps.min > b.rps.max; // ranges do not overlap
  summary[id].rustVsNodeRps = +ratio.toFixed(2);
  summary[id].conclusion = separated ? (ratio > 1 ? "Rust faster (ranges do not overlap)" : "Node faster (ranges do not overlap)") : "inconclusive (spread overlaps)";
}
const env = {
  generatedAt: new Date().toISOString(), cpu: os.cpus()[0].model, logicalCpus: os.cpus().length, totalMemGb: +(os.totalmem() / 2 ** 30).toFixed(1),
  loadavgBefore: load0.map((x) => +x.toFixed(2)), loadavgAfter: os.loadavg().map((x) => +x.toFixed(2)), nodeVersion: process.version,
  rounds: ROUNDS, durationSec: DURATION, connections: CONNS, idleRssMb: idleRss,
  commit: (() => { try { return execSync("git rev-parse --short HEAD", { cwd: new URL("..", import.meta.url).pathname }).toString().trim() + (execSync("git status --porcelain", { cwd: new URL("..", import.meta.url).pathname }).toString().trim() ? "+dirty" : ""); } catch { return "no-git"; } })(),
  note: process.env.BENCH_NOTE ?? "Load generator shares the host with the servers unless pinned; label results indicative unless run on a quiet, pinned host.",
};
mkdirSync(OUT, { recursive: true });
const doc = { environment: env, summary, raw };
writeFileSync(OUT + "latest.json", JSON.stringify(doc, null, 2));
console.log("\n" + JSON.stringify(Object.fromEntries(Object.entries(summary).map(([k, v]) => [k, `${v.label}: rust/node = ${v.rustVsNodeRps}x -> ${v.conclusion}`])), null, 2));
