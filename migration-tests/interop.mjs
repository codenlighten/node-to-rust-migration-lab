#!/usr/bin/env node
// Shared-database interoperability + rollback, the strangler scenario: BOTH backends on ONE database behind the gateway.
// Proves users, sessions (JWTs) and orders written by one implementation are usable by the other, and that the gateway
// rolls back to Node when Rust stops answering health checks (set RUST_PID to have the script stop Rust itself).
import { cfg } from "./lib/env.mjs";
const N = cfg.demo.node, R = cfg.demo.rust, G = process.env.GATEWAY_URL ?? "http://localhost:8080";
const checks = [];
const check = (name, ok, extra = "") => { checks.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`); };
const call = async (base, method, path, body, token) => {
  const r = await fetch(base + path, { method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null), by: r.headers.get("x-served-by") };
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const email = `interop-${Date.now()}@example.com`;

const reg = await call(N, "POST", "/api/auth/register", { email, password: "password123", name: "Interop" });
check("register on Node", reg.status === 201);
const rl = await call(R, "POST", "/api/auth/login", { email, password: "password123" });
check("login on Rust against a bcrypt hash written by Node", rl.status === 200);
const me = await call(N, "GET", "/api/me", null, rl.body?.token);
check("JWT issued by Rust accepted by Node", me.status === 200 && me.body?.email === email);
const nl = await call(N, "POST", "/api/auth/login", { email, password: "password123" });
const me2 = await call(R, "GET", "/api/me", null, nl.body?.token);
check("JWT issued by Node accepted by Rust", me2.status === 200);

const o = await call(N, "POST", "/api/orders", { items: [{ productId: 2, quantity: 1 }] }, nl.body.token);
check("order created on Node", o.status === 201);
const pay = await call(R, "POST", `/api/orders/${o.body.id}/pay`, { cardToken: "tok_ok" }, nl.body.token);
check("order paid on Rust", pay.status === 200 && pay.body.status === "paid");
const back = await call(N, "GET", `/api/orders/${o.body.id}`, null, nl.body.token);
check("Node reads the paid order", back.body?.status === "paid" && back.body.userId === o.body.userId);

// Gateway: switch, observe x-served-by, roll back.
const route = (mode, extra = {}) => call(G, "POST", "/__gateway/route", { mode, ...extra });
await route("node"); const a = await call(G, "GET", "/api/products/1");
await route("rust"); const b = await call(G, "GET", "/api/products/1");
check("gateway routes to Node, then Rust", a.by === "node" && b.by === "rust");
check("identical product body through either backend", JSON.stringify(a.body) === JSON.stringify(b.body));
await route("canary", { canaryPercent: 50 });
const seen = new Set(); for (let i = 0; i < 60; i++) seen.add((await call(G, "GET", "/health")).by);
check("canary splits traffic", seen.has("node") && seen.has("rust"));
await route("rust");

if (process.env.RUST_PID) {
  process.kill(Number(process.env.RUST_PID), "SIGTERM");
  let mode = "rust";
  for (let i = 0; i < 30 && mode === "rust"; i++) { await sleep(1000); mode = (await (await fetch(G + "/__gateway/status")).json()).mode; }
  const after = await call(G, "GET", `/api/orders/${o.body.id}`, null, nl.body.token);
  check("auto-rollback to Node after Rust stops", mode === "node");
  check("orders written before and during the migration still readable after rollback", after.status === 200 && after.body.status === "paid" && after.by === "node");
} else console.log("SKIP  auto-rollback (set RUST_PID to stop Rust and watch the gateway roll back)");
console.log(`\nINTEROP: ${checks.every(Boolean) ? "PASS" : "FAIL"} (${checks.filter(Boolean).length}/${checks.length})`);
process.exit(checks.every(Boolean) ? 0 : 1);
