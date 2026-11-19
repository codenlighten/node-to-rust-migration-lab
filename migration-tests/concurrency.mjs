#!/usr/bin/env node
// Oversell test: N customers simultaneously try to buy the last units. Run per backend on its own
// isolated, identically seeded database. PASS requires exactly `stock` successes, N-stock clean 409s,
// final stock 0, and exactly `stock` persisted orders, identically on both implementations.
import { writeFileSync, mkdirSync } from "node:fs";
import { cfg, connect, resetAndSeed, waitFor } from "./lib/env.mjs";

const CUSTOMERS = Number(process.env.CUSTOMERS ?? 100);
const MUG = 5, STOCK = 10; // seeded: product 5 has stock 10

async function api(base, method, path, body, token) {
  const r = await fetch(base + path, { method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
}

async function run(side, mongo) {
  await resetAndSeed(mongo, side.db);
  const tokens = await Promise.all(Array.from({ length: CUSTOMERS }, async (_, i) => {
    const email = `c${i}@example.com`;
    await api(side.url, "POST", "/api/auth/register", { email, password: "password123", name: `C${i}` });
    return (await api(side.url, "POST", "/api/auth/login", { email, password: "password123" })).body.token;
  }));
  const t0 = performance.now();
  const results = await Promise.all(tokens.map((t) => api(side.url, "POST", "/api/orders", { items: [{ productId: MUG, quantity: 1 }] }, t)));
  const ms = performance.now() - t0;
  const by = {};
  for (const r of results) by[r.status] = (by[r.status] ?? 0) + 1;
  const db = mongo.db(side.db);
  const stock = (await db.collection("products").findOne({ _id: MUG })).stock;
  const orders = await db.collection("orders").countDocuments({});
  const orderIds = new Set((await db.collection("orders").find({}).toArray()).map((o) => o._id)).size;
  const badConflicts = results.filter((r) => r.status === 409 && r.body?.error?.code !== "INSUFFICIENT_STOCK").length;

  // Opposite lock order across two products: must not deadlock or lose stock.
    const mixed = await Promise.all(tokens.slice(0, 40).map((t, i) => api(side.url, "POST", "/api/orders",
    { items: i % 2 ? [{ productId: 1, quantity: 1 }, { productId: 2, quantity: 1 }] : [{ productId: 2, quantity: 1 }, { productId: 1, quantity: 1 }] }, t)));
  const mixedOk = mixed.filter((r) => r.status === 201).length;
  const p1 = (await db.collection("products").findOne({ _id: 1 })).stock, p2 = (await db.collection("products").findOne({ _id: 2 })).stock;

  return { backend: side.name, created201: by[201] ?? 0, conflicts409: by[409] ?? 0, other: results.length - (by[201] ?? 0) - (by[409] ?? 0),
    finalStock: stock, persistedOrders: orders, distinctOrderIds: orderIds, badConflicts, elapsedMs: Math.round(ms),
    mixedOrderOk: mixedOk, mixedStockConsistent: p1 === 50 - mixedOk && p2 === 120 - mixedOk };
}

const mongo = await connect();
await waitFor(cfg.original.url, "original"); await waitFor(cfg.replacement.url, "replacement");
const out = [];
for (const side of [cfg.original, cfg.replacement]) out.push(await run(side, mongo));
await mongo.close();

const ok = (r) => r.created201 === STOCK && r.conflicts409 === CUSTOMERS - STOCK && r.other === 0 && r.finalStock === 0 &&
  r.persistedOrders === STOCK && r.distinctOrderIds === STOCK && r.badConflicts === 0 && r.mixedStockConsistent && r.mixedOrderOk === 40;
console.log(`CONCURRENCY: ${CUSTOMERS} customers, ${STOCK} units in stock\n`);
for (const r of out) console.log(`${r.backend.padEnd(5)} 201=${r.created201} 409=${r.conflicts409} other=${r.other} finalStock=${r.finalStock} orders=${r.persistedOrders} mixed-order=${r.mixedOrderOk}/40 stockConsistent=${r.mixedStockConsistent}  [${r.elapsedMs} ms]  ${ok(r) ? "PASS" : "FAIL"}`);
const pass = out.every(ok);
console.log(`\nINVENTORY INTEGRITY: ${pass ? "PASS" : "FAIL"}`);
mkdirSync(new URL("./report/", import.meta.url).pathname, { recursive: true });
writeFileSync(new URL("./report/concurrency.json", import.meta.url).pathname, JSON.stringify({ generatedAt: new Date().toISOString(), customers: CUSTOMERS, stock: STOCK, pass, results: out }, null, 2));
process.exit(pass ? 0 : 1);
