// Seeds the demo database once (idempotent: skips when products already exist).
import { cfg, connect, SEED_PRODUCTS } from "./lib/env.mjs";
const db = process.env.SEED_DB ?? "lab";
const c = await connect();
const d = c.db(db);
if (await d.collection("products").countDocuments({}) === 0) {
  const now = new Date();
  await d.collection("products").insertMany(SEED_PRODUCTS.map(([sku, name, description, priceCents, stock], i) => ({ _id: i + 1, sku, name, description, priceCents, stock, active: true, createdAt: now, updatedAt: now })));
  await d.collection("counters").updateOne({ _id: "products" }, { $set: { seq: SEED_PRODUCTS.length } }, { upsert: true });
  console.log(`seeded ${SEED_PRODUCTS.length} products into ${db}`);
} else console.log(`${db} already seeded`);
await c.close();
