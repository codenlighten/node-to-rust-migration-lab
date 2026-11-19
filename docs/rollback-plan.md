# Rollback plan

Rollback is cheap because **there is nothing to migrate back**: both implementations read and write the same MongoDB documents, so
orders and stock changed while Rust was serving are immediately visible to Node.

* **Automatic:** the gateway checks `/ready` on both backends every 2 s; three consecutive Rust failures route all traffic to Node
  (`migration-tests/interop.mjs` proves this by killing the Rust process and then reading an order written before the failure).
* **Manual:** `POST /__gateway/route {"mode":"node"}`.
* **In-flight requests** to Rust at the moment of failure get a 502 from the gateway; clients retry. Order creation is a single
  transaction, so a request is either fully applied or not at all.
* **Preconditions for a safe rollback:** no schema or document-shape change ships with the cutover (a shape change would need an
  expand/contract sequence with both versions reading both shapes), and JWT secret and bcrypt cost stay identical in both services.
