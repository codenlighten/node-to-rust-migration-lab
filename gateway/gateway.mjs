// Strangler-style gateway: routes /api traffic to the Node or Rust backend, supports a canary
// percentage, and rolls back automatically when the Rust backend fails health checks.
// No dependencies. Control plane: GET/POST /__gateway/*  (demo only; not exposed in a real deployment).
import http from "node:http";
import { randomUUID } from "node:crypto";

const NODE = new URL(process.env.NODE_URL ?? "http://localhost:3001");
const RUST = new URL(process.env.RUST_URL ?? "http://localhost:3002");
const PORT = Number(process.env.PORT ?? 8080);
const FAILS_TO_ROLLBACK = Number(process.env.FAILS_TO_ROLLBACK ?? 3);
const CHECK_MS = Number(process.env.CHECK_MS ?? 2000);

const state = {
  mode: process.env.INITIAL_BACKEND ?? "node", // "node" | "rust" | "canary"
  canaryPercent: 10,
  autoRollback: true,
  health: { node: { ok: null, fails: 0 }, rust: { ok: null, fails: 0 } },
  events: [], // newest first
  stats: { node: { n: 0, ms: 0 }, rust: { n: 0, ms: 0 } },
  recent: [],
};
const log = (msg) => { state.events.unshift({ ts: new Date().toISOString(), msg }); state.events.length = Math.min(state.events.length, 50); console.log(JSON.stringify({ gateway: msg })); };

const target = (name) => (name === "rust" ? RUST : NODE);
const pick = () => state.mode === "canary" ? (Math.random() * 100 < state.canaryPercent ? "rust" : "node") : state.mode;

async function check(name) {
  const h = state.health[name];
  try {
    const r = await fetch(new URL("/ready", target(name)), { signal: AbortSignal.timeout(1500) });
    if (!r.ok) throw new Error(String(r.status));
    if (h.ok === false) log(`${name} recovered`);
    h.ok = true; h.fails = 0;
  } catch {
    h.ok = false; h.fails++;
    if (name === "rust" && state.autoRollback && h.fails >= FAILS_TO_ROLLBACK && state.mode !== "node") {
      log(`ROLLBACK: rust failed ${h.fails} health checks; traffic returned to node (data is shared, nothing to migrate back)`);
      state.mode = "node";
    }
  }
}
setInterval(() => { check("node"); check("rust"); }, CHECK_MS);
check("node"); check("rust");

function json(res, code, obj) { res.writeHead(code, { "content-type": "application/json", "access-control-allow-origin": "*" }); res.end(JSON.stringify(obj)); }

const server = http.createServer((req, res) => {
  if (req.url?.startsWith("/__gateway")) {
    res.setHeader("access-control-allow-origin", "*");
    if (req.method === "OPTIONS") { res.writeHead(204, { "access-control-allow-headers": "content-type", "access-control-allow-methods": "GET,POST" }); res.end(); return; }
    if (req.url === "/__gateway/status") return json(res, 200, { ...state, stats: Object.fromEntries(Object.entries(state.stats).map(([k, v]) => [k, { requests: v.n, avgMs: v.n ? +(v.ms / v.n).toFixed(2) : 0 }])) });
    if (req.url === "/__gateway/route" && req.method === "POST") {
      let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
        try {
          const j = JSON.parse(b);
          if (!["node", "rust", "canary"].includes(j.mode)) return json(res, 400, { error: "mode must be node, rust or canary" });
          if (j.mode !== "node" && state.health.rust.ok === false && j.mode === "rust") return json(res, 409, { error: "rust is unhealthy; refusing to route to it" });
          state.mode = j.mode;
          if (Number.isInteger(j.canaryPercent) && j.canaryPercent >= 0 && j.canaryPercent <= 100) state.canaryPercent = j.canaryPercent;
          if (typeof j.autoRollback === "boolean") state.autoRollback = j.autoRollback;
          log(`route set to ${state.mode}${state.mode === "canary" ? ` (${state.canaryPercent}% rust)` : ""}`);
          json(res, 200, { mode: state.mode, canaryPercent: state.canaryPercent });
        } catch { json(res, 400, { error: "invalid JSON" }); }
      });
      return;
    }
    return json(res, 404, { error: "unknown gateway endpoint" });
  }

  const name = pick();
  const t = target(name);
  const t0 = process.hrtime.bigint();
  const reqId = req.headers["x-request-id"] ?? randomUUID();
  const up = http.request({ hostname: t.hostname, port: t.port, path: req.url, method: req.method, headers: { ...req.headers, host: t.host, "x-request-id": reqId } }, (ur) => {
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    state.stats[name].n++; state.stats[name].ms += ms;
    state.recent.unshift({ ts: Date.now(), backend: name, method: req.method, path: req.url, status: ur.statusCode, ms: +ms.toFixed(2) });
    state.recent.length = Math.min(state.recent.length, 25);
    res.writeHead(ur.statusCode ?? 502, { ...ur.headers, "x-served-by": name, "access-control-allow-origin": "*", "access-control-expose-headers": "x-served-by,x-request-id" });
    ur.pipe(res);
  });
  up.on("error", () => json(res, 502, { error: { code: "BAD_GATEWAY", message: `${name} backend unreachable` } }));
  req.pipe(up);
});
server.listen(PORT, () => log(`gateway listening on ${PORT}, mode=${state.mode}`));
