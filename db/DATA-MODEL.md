# Data model (MongoDB, shared by both backends)

Collections (database name comes from `MONGO_DB`):

| Collection | Document shape | Notes |
|---|---|---|
| `counters` | `{_id: "users"\|"products"\|"orders", seq: int}` | Sequential integer ids, so the API keeps stable integer ids across the migration (no ObjectId leakage). |
| `users` | `{_id:int, email, name, passwordHash, role, createdAt}` | Unique index on `email`. bcrypt hashes are readable by both backends. |
| `products` | `{_id:int, sku, name, description, priceCents, stock, active, createdAt, updatedAt}` | Unique index on `sku`. |
| `orders` | `{_id:int, userId, status, totalCents, items:[{productId, quantity, unitPriceCents}], createdAt, updatedAt}` | Items embedded. Index `(userId, _id)`. |

Timestamps are stored as BSON dates and serialised by both backends as
`YYYY-MM-DDTHH:MM:SS.mmmZ` (millisecond precision, the BSON date resolution).

Stock safety: order creation runs in a multi-document transaction (single-node replica set).
Each line does `findOneAndUpdate({_id, active:true, stock:{$gte:q}}, {$inc:{stock:-q}})`; a miss aborts the
whole transaction. Lines are processed in ascending product id order so concurrent orders take locks
in the same order.
