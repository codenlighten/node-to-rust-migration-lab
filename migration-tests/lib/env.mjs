// Shared configuration + helpers for the verification harness.
import { createHmac } from "node:crypto";
import { MongoClient } from "mongodb";
import { Agent, setGlobalDispatcher } from "undici";

// The harness sleeps between steps (database resets) and the servers close idle keep-alive sockets on their
// own schedule; reusing a socket the server just closed shows up as "fetch failed: EPIPE". Drop idle sockets quickly.
setGlobalDispatcher(new Agent({ keepAliveTimeout: 300, keepAliveMaxTimeout: 300 }));

export const cfg = {
  mongoUrl: process.env.MONGO_URL ?? "mongodb://localhost:27017/?replicaSet=rs0",
  // Isolated, identically seeded databases: one per implementation under test.
  original: { name: "node", url: process.env.ORIGINAL_URL ?? "http://localhost:3011", db: process.env.ORIGINAL_DB ?? "verify_node" },
  replacement: { name: "rust", url: process.env.REPLACEMENT_URL ?? "http://localhost:3012", db: process.env.REPLACEMENT_DB ?? "verify_rust" },
  // The demo pair shares ONE database (used for interoperability checks).
  demo: { node: process.env.DEMO_NODE_URL ?? "http://localhost:3001", rust: process.env.DEMO_RUST_URL ?? "http://localhost:3002" },
};

/** A hand-built JWT, for tokens that neither backend would issue. `alg: "none"` produces an unsigned one. */
export function mintToken(claims, { alg = "HS256", secret = process.env.JWT_SECRET ?? "dev-only-secret-change-me" } = {}) {
  const part = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const body = `${part({ alg, typ: "JWT" })}.${part(claims)}`;
  if (alg === "none") return `${body}.`;
  return `${body}.${createHmac(alg === "HS384" ? "sha384" : "sha256", secret).update(body).digest("base64url")}`;
}

export const SEED_PRODUCTS = [
  ["KB-001", "Mechanical Keyboard", "Tenkeyless, brown switches", 8999, 50],
  ["MS-002", "Wireless Mouse", "Ergonomic, 2.4GHz", 3499, 120],
  ["MN-003", "27in Monitor", "1440p IPS", 24999, 15],
  ["HD-004", "USB-C Dock", "8-in-1", 12900, 40],
  ["LM-005", "Limited Edition Mug", "Only 10 exist (concurrency demo)", 1500, 10],
];

/** Wipe a database's documents (indexes stay, so running backends keep working) and load the seed. */
export async function resetAndSeed(client, dbName) {
  const db = client.db(dbName);
  for (const c of ["users", "products", "orders", "counters"]) await db.collection(c).deleteMany({});
  const now = new Date("2026-01-01T00:00:00.000Z");
  await db.collection("products").insertMany(
    SEED_PRODUCTS.map(([sku, name, description, priceCents, stock], i) => ({
      _id: i + 1, sku, name, description, priceCents, stock, active: true, createdAt: now, updatedAt: now,
    })),
  );
  await db.collection("counters").insertMany([
    { _id: "users", seq: 0 }, { _id: "products", seq: SEED_PRODUCTS.length }, { _id: "orders", seq: 0 },
  ]);
}

export async function connect() {
  const client = new MongoClient(cfg.mongoUrl);
  await client.connect();
  return client;
}

/** Database state, normalised for comparison (timestamps and password hashes masked). */
export async function dumpState(client, dbName) {
  const db = client.db(dbName);
  const mask = (o) => JSON.parse(JSON.stringify(o, (k, v) =>
    k === "createdAt" || k === "updatedAt" ? "<ts>" : k === "passwordHash" ? (String(v).startsWith("$2") ? "<bcrypt>" : "<?>") : v));
  const out = {};
  for (const c of ["users", "products", "orders", "counters"])
    out[c] = mask(await db.collection(c).find({}).sort({ _id: 1 }).toArray());
  return out;
}

export async function waitFor(url, label, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(url + "/ready"); if (r.ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${label} not ready at ${url}`);
}
