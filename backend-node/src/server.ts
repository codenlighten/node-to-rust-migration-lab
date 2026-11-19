import { createApp } from "./app.js";
import { Store } from "./db.js";

const url = process.env.MONGO_URL ?? "mongodb://localhost:27017/?replicaSet=rs0";
const dbName = process.env.MONGO_DB ?? "lab";
const port = Number(process.env.PORT ?? 3001);
const jwtSecret = process.env.JWT_SECRET ?? "dev-only-secret-change-me";
const adminEmail = process.env.ADMIN_EMAIL ?? "admin@example.com";

const store = new Store(url, dbName);
// Retry: in compose the replica set may still be electing a primary.
for (let i = 0; ; i++) {
  try { await store.init(); break; }
  catch (e) { if (i >= 30) throw e; await new Promise((r) => setTimeout(r, 1000)); }
}
const server = createApp(store, { jwtSecret, adminEmail }).listen(port, () =>
  console.log(JSON.stringify({ ts: new Date().toISOString(), impl: "node", msg: "listening", port, db: dbName })));
const stop = () => server.close(() => store.client.close().then(() => process.exit(0)));
process.on("SIGTERM", stop); process.on("SIGINT", stop);
