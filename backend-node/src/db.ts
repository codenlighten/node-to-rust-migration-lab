import { ClientSession, Collection, Db, MongoClient } from "mongodb";

export type UserDoc = { _id: number; email: string; name: string; passwordHash: string; role: "customer" | "admin"; createdAt: Date };
export type ProductDoc = {
  _id: number; sku: string; name: string; description: string; priceCents: number;
  stock: number; active: boolean; createdAt: Date; updatedAt: Date;
};
export type OrderItem = { productId: number; quantity: number; unitPriceCents: number };
export type OrderDoc = {
  _id: number; userId: number; status: "pending" | "paid" | "cancelled"; totalCents: number;
  items: OrderItem[]; createdAt: Date; updatedAt: Date;
};
type CounterDoc = { _id: string; seq: number };

export class Store {
  client: MongoClient;
  db: Db;
  users: Collection<UserDoc>;
  products: Collection<ProductDoc>;
  orders: Collection<OrderDoc>;
  counters: Collection<CounterDoc>;

  constructor(url: string, dbName: string) {
    this.client = new MongoClient(url, { maxPoolSize: 50 });
    this.db = this.client.db(dbName);
    this.users = this.db.collection("users");
    this.products = this.db.collection("products");
    this.orders = this.db.collection("orders");
    this.counters = this.db.collection("counters");
  }

  async init() {
    await this.client.connect();
    // Collections must exist before they are used inside a transaction.
    const existing = new Set((await this.db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name));
    for (const n of ["users", "products", "orders", "counters"]) {
      if (!existing.has(n)) await this.db.createCollection(n).catch(() => {});
    }
    await this.users.createIndex({ email: 1 }, { unique: true });
    await this.products.createIndex({ sku: 1 }, { unique: true });
    await this.orders.createIndex({ userId: 1, _id: 1 });
  }

  async nextId(name: string, session?: ClientSession): Promise<number> {
    const r = await this.counters.findOneAndUpdate(
      { _id: name }, { $inc: { seq: 1 } },
      { upsert: true, returnDocument: "after", session },
    );
    return r!.seq;
  }

  async ping(): Promise<boolean> {
    try { await this.db.command({ ping: 1 }); return true; } catch { return false; }
  }
}
