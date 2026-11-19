# node-to-rust-migration-lab

A worked example of replacing a live Node.js backend with Rust **without breaking anything**: the same REST API, the same
MongoDB data, the same React frontend (no rebuild), a gateway that moves traffic between the two implementations and rolls back
automatically, and a verification harness that compares what the two backends *actually do*.

| | Original | Replacement |
|---|---|---|
| Language / framework | TypeScript, Express 4 | Rust, Axum 0.8 + Tokio |
| Database | MongoDB 7 (official `mongodb` driver) | the same database (official Rust driver) |
| Auth | JWT HS256, bcrypt cost 10 | wire-compatible: tokens and hashes work in both directions |
| Frontend | React + Vite, talks only to the gateway | unchanged |

The domain is a small inventory and order API (accounts, products, stock, orders, simulated payments): about 17 endpoints,
chosen because it has the hard parts of a real migration: money, state machines, concurrent stock updates and multi-document
transactions.

## Run it

```bash
git clone <this repo> && cd node-to-rust-migration-lab
docker compose up --build        # needs only Docker
```

| URL | What |
|---|---|
| http://localhost:3000 | dashboard and shop (switch backend, watch which one served each request) |
| http://localhost:3001 | Node API |
| http://localhost:3002 | Rust API |
| http://localhost:8080 | gateway (what the frontend uses) |

```bash
make verify-migration   # contract + concurrency verification on isolated databases; reports in migration-tests/report/
make benchmark          # see benchmarks/README.md
```

## What the verification does (and does not) show

`migration-tests/verify.mjs` runs the same request fixtures against both backends, each on its **own identically seeded
database**, and compares status code, content type, normalised JSON body and the resulting database state, after every
mutating step. Only deliberately nondeterministic fields (timestamps, JWTs) are normalised. It also checks that a failing
order leaves stock untouched, that 100 customers fighting over 10 units never oversell, and (on the shared demo database)
that users, tokens and orders written by one backend work in the other and that the gateway rolls back when Rust dies.

It demonstrates **parity on a fixed, reviewable fixture set**, not mathematical equivalence. See
[docs/compatibility-report.md](docs/compatibility-report.md) for what it catches, what it cannot, and the real differences it found
and fixed during development.

## Layout

```
backend-node/     original Express service            backend-rust/   Axum replacement
frontend/         React dashboard (no backend knowledge)    gateway/        traffic router + auto-rollback
api-contract/     OpenAPI 3 contract                  migration-tests/ fixtures, harness, concurrency, interop
benchmarks/       reproducible A/B benchmark          docs/           architecture, plan, rollback, reports
```

## Design notes worth reading

- **Contract first.** `api-contract/openapi.yaml` is the single source of truth; error codes, validation messages and edge
  cases (code-point string lengths, `2.0` accepted as an integer, repeated query keys) are reproduced deliberately.
- **Data model unchanged.** Integer ids via a counters collection, so no ObjectId leaks into the API; both backends read and write the
  same documents, which is what makes a gradual cutover and a rollback safe ([db/DATA-MODEL.md](db/DATA-MODEL.md)).
- **Stock integrity** relies on a conditional atomic decrement (`stock >= qty`) inside a multi-document transaction, with
  lines locked in a fixed order and transient conflicts retried within a time budget.
- **Benchmarks are published as measured**, with spread and environment; where the difference is inside the noise the report says so.

## License

MIT
