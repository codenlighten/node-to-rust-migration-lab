import express, { NextFunction, Request, Response } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { randomUUID } from "node:crypto";
import { MongoServerError, Sort } from "mongodb";
import { OrderDoc, ProductDoc, Store, UserDoc } from "./db.js";
import { Detail, MAX_INT32, Obj, bool, int, isObj, str, validEmail } from "./validate.js";

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) { super(message); }
}
const bad = (details: Detail[]) => new ApiError(400, "VALIDATION_ERROR", "Request validation failed", details);
const iso = (d: Date) => d.toISOString();

const productOut = (p: ProductDoc) => ({
  id: p._id, sku: p.sku, name: p.name, description: p.description, priceCents: p.priceCents,
  stock: p.stock, active: p.active, createdAt: iso(p.createdAt), updatedAt: iso(p.updatedAt),
});
const orderOut = (o: OrderDoc) => ({
  id: o._id, userId: o.userId, status: o.status, totalCents: o.totalCents,
  items: o.items.map((i) => ({ productId: i.productId, quantity: i.quantity, unitPriceCents: i.unitPriceCents })),
  createdAt: iso(o.createdAt), updatedAt: iso(o.updatedAt),
});

type Claims = { sub: string; role: "customer" | "admin" };
type Authed = Request & { auth?: Claims; body: unknown };

const wrap = (fn: (req: Authed, res: Response) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction) => fn(req as Authed, res).catch(next);

function parseBody(req: Authed): Obj {
  const raw = req.body as string;
  let v: unknown;
  try { v = raw && raw.length ? JSON.parse(raw) : undefined; } catch { throw new ApiError(400, "VALIDATION_ERROR", "Malformed JSON body"); }
  if (!isObj(v)) throw new ApiError(400, "VALIDATION_ERROR", "Request body must be a JSON object");
  return v;
}

function idParam(v: string): number {
  if (!/^\d{1,10}$/.test(v) || Number(v) < 1 || Number(v) > MAX_INT32)
    throw bad([{ field: "id", message: "must be a positive integer" }]);
  return Number(v);
}

function pageParams(q: Request["query"], d: Detail[]) {
  const num = (f: string, def: number, min: number, max: number) => {
    const v = q[f];
    if (v === undefined) return def;
    if (typeof v !== "string" || !/^\d{1,9}$/.test(v)) { d.push({ field: f, message: "must be an integer" }); return def; }
    const n = Number(v);
    if (n < min || n > max) { d.push({ field: f, message: `must be between ${min} and ${max}` }); return def; }
    return n;
  };
  return { page: num("page", 1, 1, 1_000_000), pageSize: num("pageSize", 20, 1, 100) };
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function createApp(store: Store, opts: { jwtSecret: string; adminEmail: string }) {
  const app = express();
  app.disable("x-powered-by");
  app.disable("etag");
  app.set("query parser", "simple"); // node:querystring semantics: bracket keys are literal, repeated keys become arrays

  // Structured request log + request id.
  app.use((req, res, next) => {
    const id = (req.headers["x-request-id"] as string) || randomUUID();
    res.setHeader("x-request-id", id);
    const t0 = process.hrtime.bigint();
    res.on("finish", () => {
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      if (req.path === "/health") return;
      console.log(JSON.stringify({ ts: new Date().toISOString(), impl: "node", reqId: id, method: req.method, path: req.path, status: res.statusCode, ms: Math.round(ms * 100) / 100 }));
    });
    next();
  });

  // Raw text for every request so JSON handling is identical regardless of Content-Type.
  app.use(express.text({ type: () => true, limit: "100kb" }));

  const auth = (req: Authed): Claims => {
    const h = req.headers.authorization;
    if (!h || !h.startsWith("Bearer ")) throw new ApiError(401, "UNAUTHORIZED", "Missing or invalid Authorization header");
    try {
      const p = jwt.verify(h.slice(7), opts.jwtSecret, { algorithms: ["HS256"] }) as jwt.JwtPayload;
      if (typeof p.sub !== "string" || (p.role !== "customer" && p.role !== "admin")) throw new Error("claims");
      return (req.auth = { sub: p.sub, role: p.role });
    } catch { throw new ApiError(401, "UNAUTHORIZED", "Invalid or expired token"); }
  };
  const admin = (req: Authed) => {
    const c = auth(req);
    if (c.role !== "admin") throw new ApiError(403, "FORBIDDEN", "Admin role required");
    return c;
  };

  // ---- health ----
  app.get("/health", (_q, res) => { res.json({ status: "ok" }); });
  app.get("/ready", wrap(async (_q, res) => {
    if (await store.ping()) res.json({ status: "ready" }); else res.status(503).json({ status: "unavailable" });
  }));

  // ---- auth ----
  app.post("/api/auth/register", wrap(async (req, res) => {
    const b = parseBody(req); const d: Detail[] = [];
    const email = str(b, "email", 3, 254, d);
    if (email !== undefined && !validEmail(email)) d.push({ field: "email", message: "must be a valid email address" });
    const password = str(b, "password", 8, 72, d);
    const name = str(b, "name", 1, 100, d);
    if (d.length) throw bad(d);
    const lower = email!.toLowerCase();
    const hash = await bcrypt.hash(password!, 10);
    const doc: UserDoc = {
      _id: await store.nextId("users"), email: lower, name: name!, passwordHash: hash,
      role: lower === opts.adminEmail.toLowerCase() ? "admin" : "customer", createdAt: new Date(),
    };
    try { await store.users.insertOne(doc); }
    catch (e) { if ((e as MongoServerError).code === 11000) throw new ApiError(409, "EMAIL_TAKEN", "Email is already registered"); throw e; }
    res.status(201).json({ id: doc._id, email: doc.email, name: doc.name, role: doc.role });
  }));

  app.post("/api/auth/login", wrap(async (req, res) => {
    const b = parseBody(req); const d: Detail[] = [];
    const email = str(b, "email", 1, 254, d); const password = str(b, "password", 1, 72, d);
    if (d.length) throw bad(d);
    const u = await store.users.findOne({ email: email!.toLowerCase() });
    const ok = u ? await bcrypt.compare(password!, u.passwordHash) : false;
    if (!u || !ok) throw new ApiError(401, "INVALID_CREDENTIALS", "Invalid email or password");
    const token = jwt.sign({ role: u.role }, opts.jwtSecret, { algorithm: "HS256", subject: String(u._id), expiresIn: "1h" });
    res.json({ token, user: { id: u._id, email: u.email, name: u.name, role: u.role } });
  }));

  app.get("/api/me", wrap(async (req, res) => {
    const c = auth(req);
    const u = await store.users.findOne({ _id: Number(c.sub) });
    if (!u) throw new ApiError(401, "UNAUTHORIZED", "Invalid or expired token");
    res.json({ id: u._id, email: u.email, name: u.name, role: u.role });
  }));

  // ---- products ----
  const SORTS: Record<string, Sort> = {
    id: { _id: 1 }, newest: { _id: -1 }, name: { name: 1, _id: 1 },
    price_asc: { priceCents: 1, _id: 1 }, price_desc: { priceCents: -1, _id: 1 },
  };

  app.get("/api/products", wrap(async (req, res) => {
    const d: Detail[] = [];
    const { page, pageSize } = pageParams(req.query, d);
    const q = req.query;
    const money = (f: string) => {
      const v = q[f]; if (v === undefined) return undefined;
      if (typeof v !== "string" || !/^\d{1,9}$/.test(v)) { d.push({ field: f, message: "must be an integer" }); return undefined; }
      return Number(v);
    };
    const minPrice = money("minPrice"), maxPrice = money("maxPrice");
    let search: string | undefined;
    if (q.search !== undefined) {
      if (typeof q.search !== "string" || [...q.search].length > 100) d.push({ field: "search", message: "must be at most 100 characters" });
      else search = q.search;
    }
    let sort = "id";
    if (q.sort !== undefined) {
      if (typeof q.sort !== "string" || !(q.sort in SORTS)) d.push({ field: "sort", message: "must be one of id, newest, name, price_asc, price_desc" });
      else sort = q.sort;
    }
    if (d.length) throw bad(d);
    const filter: Record<string, unknown> = { active: true };
    if (minPrice !== undefined || maxPrice !== undefined) {
      filter.priceCents = { ...(minPrice !== undefined ? { $gte: minPrice } : {}), ...(maxPrice !== undefined ? { $lte: maxPrice } : {}) };
    }
    if (search) {
      const rx = { $regex: escapeRe(search), $options: "i" };
      filter.$or = [{ name: rx }, { sku: rx }];
    }
    const [items, total] = await Promise.all([
      store.products.find(filter).sort(SORTS[sort]).skip((page - 1) * pageSize).limit(pageSize).toArray(),
      store.products.countDocuments(filter),
    ]);
    res.json({ items: items.map(productOut), page, pageSize, total });
  }));

  app.get("/api/products/:id", wrap(async (req, res) => {
    const p = await store.products.findOne({ _id: idParam(req.params.id), active: true });
    if (!p) throw new ApiError(404, "NOT_FOUND", "Product not found");
    res.json(productOut(p));
  }));

  app.post("/api/products", wrap(async (req, res) => {
    admin(req);
    const b = parseBody(req); const d: Detail[] = [];
    const sku = str(b, "sku", 1, 64, d), name = str(b, "name", 1, 200, d);
    const description = str(b, "description", 0, 2000, d, false);
    const priceCents = int(b, "priceCents", 0, MAX_INT32, d), stock = int(b, "stock", 0, 1_000_000, d, false);
    if (d.length) throw bad(d);
    const now = new Date();
    const doc: ProductDoc = {
      _id: await store.nextId("products"), sku: sku!, name: name!, description: description ?? "",
      priceCents: priceCents!, stock: stock ?? 0, active: true, createdAt: now, updatedAt: now,
    };
    try { await store.products.insertOne(doc); }
    catch (e) { if ((e as MongoServerError).code === 11000) throw new ApiError(409, "SKU_TAKEN", "SKU is already in use"); throw e; }
    res.status(201).json(productOut(doc));
  }));

  app.put("/api/products/:id", wrap(async (req, res) => {
    admin(req);
    const id = idParam(req.params.id);
    const b = parseBody(req); const d: Detail[] = [];
    const name = str(b, "name", 1, 200, d, false), description = str(b, "description", 0, 2000, d, false);
    const priceCents = int(b, "priceCents", 0, MAX_INT32, d, false), active = bool(b, "active", d);
    if (!d.length && name === undefined && description === undefined && priceCents === undefined && active === undefined)
      d.push({ field: "body", message: "at least one field is required" });
    if (d.length) throw bad(d);
    const set: Record<string, unknown> = { updatedAt: new Date() };
    if (name !== undefined) set.name = name;
    if (description !== undefined) set.description = description;
    if (priceCents !== undefined) set.priceCents = priceCents;
    if (active !== undefined) set.active = active;
    const p = await store.products.findOneAndUpdate({ _id: id }, { $set: set }, { returnDocument: "after" });
    if (!p) throw new ApiError(404, "NOT_FOUND", "Product not found");
    res.json(productOut(p));
  }));

  app.delete("/api/products/:id", wrap(async (req, res) => {
    admin(req);
    const r = await store.products.updateOne({ _id: idParam(req.params.id), active: true }, { $set: { active: false, updatedAt: new Date() } });
    if (!r.matchedCount) throw new ApiError(404, "NOT_FOUND", "Product not found");
    res.status(204).end();
  }));

  app.patch("/api/products/:id/stock", wrap(async (req, res) => {
    admin(req);
    const id = idParam(req.params.id);
    const b = parseBody(req); const d: Detail[] = [];
    const delta = int(b, "delta", -1_000_000, 1_000_000, d);
    if (!d.length && delta === 0) d.push({ field: "delta", message: "must not be zero" });
    if (d.length) throw bad(d);
    const p = await store.products.findOneAndUpdate(
      { _id: id, active: true, stock: { $gte: -delta! } },
      { $inc: { stock: delta! }, $set: { updatedAt: new Date() } }, { returnDocument: "after" });
    if (p) { res.json(productOut(p)); return; }
    const cur = await store.products.findOne({ _id: id, active: true });
    if (!cur) throw new ApiError(404, "NOT_FOUND", "Product not found");
    throw new ApiError(409, "INSUFFICIENT_STOCK", "Insufficient stock", [{ productId: id, requested: -delta!, available: cur.stock }]);
  }));

  // ---- orders ----
  app.post("/api/orders", wrap(async (req, res) => {
    const c = auth(req);
    const b = parseBody(req); const d: Detail[] = [];
    const lines: { productId: number; quantity: number }[] = [];
    if (!Array.isArray(b.items)) d.push({ field: "items", message: "must be an array" });
    else if (b.items.length < 1 || b.items.length > 20) d.push({ field: "items", message: "must contain between 1 and 20 entries" });
    else {
      const seen = new Set<number>();
      b.items.forEach((it, i) => {
        if (!isObj(it)) { d.push({ field: `items[${i}]`, message: "must be an object" }); return; }
        const sub: Detail[] = [];
        const productId = int(it, "productId", 1, MAX_INT32, sub), quantity = int(it, "quantity", 1, 1000, sub);
        sub.forEach((s) => d.push({ field: `items[${i}].${s.field}`, message: s.message }));
        if (productId !== undefined && seen.has(productId)) d.push({ field: `items[${i}].productId`, message: "must be unique" });
        if (productId !== undefined) seen.add(productId);
        if (productId !== undefined && quantity !== undefined) lines.push({ productId, quantity });
      });
    }
    if (d.length) throw bad(d);
    lines.sort((x, y) => x.productId - y.productId);

    const orderId = await store.nextId("orders");
    const userId = Number(c.sub);
    const now = new Date();
    const doc: OrderDoc = { _id: orderId, userId, status: "pending", totalCents: 0, items: [], createdAt: now, updatedAt: now };

    const session = store.client.startSession();
    try {
      await session.withTransaction(async () => {
        doc.items = []; doc.totalCents = 0;
        for (const l of lines) {
          const p = await store.products.findOneAndUpdate(
            { _id: l.productId, active: true, stock: { $gte: l.quantity } },
            { $inc: { stock: -l.quantity }, $set: { updatedAt: now } }, { session, returnDocument: "before" });
          if (!p) {
            const cur = await store.products.findOne({ _id: l.productId, active: true }, { session });
            if (!cur) throw new ApiError(404, "NOT_FOUND", `Product ${l.productId} not found`);
            throw new ApiError(409, "INSUFFICIENT_STOCK", "Insufficient stock",
              [{ productId: l.productId, requested: l.quantity, available: cur.stock }]);
          }
          doc.items.push({ productId: l.productId, quantity: l.quantity, unitPriceCents: p.priceCents });
          doc.totalCents += p.priceCents * l.quantity;
        }
        if (doc.totalCents > MAX_INT32) throw bad([{ field: "items", message: "order total is too large" }]);
        await store.orders.insertOne(doc, { session });
      });
    } finally { await session.endSession(); }
    res.status(201).json(orderOut(doc));
  }));

  const loadOrder = async (c: Claims, id: number) => {
    const o = await store.orders.findOne(c.role === "admin" ? { _id: id } : { _id: id, userId: Number(c.sub) });
    if (!o) throw new ApiError(404, "NOT_FOUND", "Order not found");
    return o;
  };

  app.get("/api/orders", wrap(async (req, res) => {
    const c = auth(req); const d: Detail[] = [];
    const { page, pageSize } = pageParams(req.query, d);
    if (d.length) throw bad(d);
    const filter = { userId: Number(c.sub) };
    const [items, total] = await Promise.all([
      store.orders.find(filter).sort({ _id: -1 }).skip((page - 1) * pageSize).limit(pageSize).toArray(),
      store.orders.countDocuments(filter),
    ]);
    res.json({ items: items.map(orderOut), page, pageSize, total });
  }));

  app.get("/api/orders/:id", wrap(async (req, res) => {
    const c = auth(req);
    res.json(orderOut(await loadOrder(c, idParam(req.params.id))));
  }));

  const stateErr = (s: string) => new ApiError(409, "INVALID_STATE", `Order is ${s}, expected pending`);

  app.post("/api/orders/:id/pay", wrap(async (req, res) => {
    const c = auth(req);
    const id = idParam(req.params.id);
    const b = parseBody(req); const d: Detail[] = [];
    const token = str(b, "cardToken", 1, 100, d);
    if (d.length) throw bad(d);
    const o = await loadOrder(c, id);
    if (o.status !== "pending") throw stateErr(o.status);
    if (token === "tok_decline") throw new ApiError(402, "PAYMENT_DECLINED", "Payment declined");
    const r = await store.orders.findOneAndUpdate({ _id: id, status: "pending" }, { $set: { status: "paid", updatedAt: new Date() } }, { returnDocument: "after" });
    if (!r) throw stateErr((await store.orders.findOne({ _id: id }))!.status);
    res.json(orderOut(r));
  }));

  app.post("/api/orders/:id/cancel", wrap(async (req, res) => {
    const c = auth(req);
    const id = idParam(req.params.id);
    const o = await loadOrder(c, id);
    if (o.status !== "pending") throw stateErr(o.status);
    const session = store.client.startSession();
    let out: OrderDoc | null = null;
    try {
      await session.withTransaction(async () => {
        out = await store.orders.findOneAndUpdate({ _id: id, status: "pending" }, { $set: { status: "cancelled", updatedAt: new Date() } }, { session, returnDocument: "after" });
        if (!out) throw stateErr((await store.orders.findOne({ _id: id }, { session }))!.status);
        for (const i of [...out.items].sort((x, y) => x.productId - y.productId))
          await store.products.updateOne({ _id: i.productId }, { $inc: { stock: i.quantity } }, { session });
      });
    } finally { await session.endSession(); }
    res.json(orderOut(out!));
  }));

  // ---- fallbacks ----
  app.use((_req, _res, next) => next(new ApiError(404, "NOT_FOUND", "Route not found")));
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ApiError) {
      res.status(err.status).json({ error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) } });
      return;
    }
    const e = err as { type?: string };
    if (e.type === "entity.too.large") { res.status(413).json({ error: { code: "PAYLOAD_TOO_LARGE", message: "Request body too large" } }); return; }
    console.error(JSON.stringify({ level: "error", impl: "node", err: String(err) }));
    res.status(500).json({ error: { code: "INTERNAL", message: "Internal server error" } });
  });

  return app;
}
