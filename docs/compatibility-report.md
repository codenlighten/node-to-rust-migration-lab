# Compatibility report

Generated from `migration-tests/report/verification.json` and `concurrency.json` (run in Docker, isolated databases,
identically seeded). Re-generate with `make verify-migration`.

## Result

| Check | Result |
|---|---|
| Request fixtures (178 steps across 6 groups, including per-group account setup) | 173 identical, 5 documented known differences, 0 unexpected mismatches |
| Database state after every mutating step | identical in all 6 groups |
| Oversell test: 100 customers, 10 units | both: exactly 10 orders, 90 clean `409 INSUFFICIENT_STOCK`, final stock 0 |
| Opposite lock order across two products, 40 concurrent orders | both: 40/40 succeed, stock consistent |
| Shared-database interoperability | users, bcrypt hashes, JWTs and orders move between backends in both directions |
| Gateway rollback | traffic returned to Node after the Rust container was stopped; earlier orders still readable |

"Identical" means identical status code, content-type media type, JSON body (after masking only timestamps and JWTs) and
database state. This is **parity on a reviewable fixture set**, not a proof of equivalence.

The committed reports come from a GitHub Actions run on a clean checkout (`make verify-migration`, same counts; the
oversell test passes on both backends).

## What the harness found while this repo was built

Real differences, each discovered by a fixture and then fixed or recorded:

| Finding | Cause | Resolution |
|---|---|---|
| Rust returned 500 under 100-way write contention | transaction retry loop gave up after 10 immediate attempts; the Node driver's `withTransaction` retries within a time budget | Rust retries transient conflicts for up to 10 s with jittered backoff |
| `/api/products/` and `/API/Products` worked on Node only | Express routing is case-insensitive and ignores a trailing slash by default | Rust normalises the path before routing |
| `?page=1&page=2` accepted on Rust, rejected on Node | Express turns repeated keys into arrays; Rust's map kept the last value | Rust marks repeated keys invalid; Node uses the simple query parser so bracket keys are literal in both |
| JSON body starting with a UTF-8 BOM accepted on Node only | Node's body decoding strips the BOM | Rust strips it |
| Rust accepted a token that was not valid yet (`nbf` in the future, as a number, as text, or `null`) | jsonwebtoken does not check `nbf` unless asked | Rust now checks it, and refuses an `nbf` that is not a number |
| Rust refused a token whose expiry time has a fraction | claims were decoded into an integer | Rust leaves `exp` to the library, which accepts fractions; expiry stays required |
| Container image shipped a stub binary | Dockerfile dependency-cache step left a stale `main.rs` build | `touch src/main.rs` before the real build |

## Known differences (not fixed, tracked by the harness)

| Input | Node | Rust | Why |
|---|---|---|---|
| JSON number `1e999` | parsed as `Infinity`, rejected by field validation | rejected as malformed JSON | `serde_json` cannot represent out-of-range numbers; both return 400 with different messages |
| Lone surrogate escape `"\ud800"` | accepted as a string | rejected as malformed JSON | RFC 8259 leaves this implementation-defined; Node answers 401, Rust 400 |
| Signed token with no `exp` | accepted | refused (401) | Rust requires an expiry; deliberately stricter |
| Signed token with an `aud` (audience) claim | accepted | refused (401) | Rust follows RFC 7519 section 4.1.3, since it is configured with no audience; deliberately stricter |
| Signed token with `sub` written as `"2.0"` | read as user 2 | refused (401) | Node uses `Number()`, Rust parses an integer |

The three token rows need the server's signing secret, and neither login issues such a token. The harness pins the
direction of each: if either backend's status changes, the run fails.

If either stops reproducing, the harness prints a note so the entry can be removed.

## What this does not cover

* Both backends can be wrong in the same way: fixtures check agreement, and only some assert absolute expectations.
* Unexplored input classes: very large payloads near the body limit, slow clients, HTTP/2, header edge cases, and request-ID properties
  beyond presence.
* Content-type is compared as a media type; `charset` parameters differ (`application/json; charset=utf-8` vs `application/json`).
* Token times are tested minutes away from now; the exact expiry second and clock differences between hosts are not.
* The token cases cover `/api/me` only, with the claims listed in `migration-tests/scenarios.mjs`.
* Fixtures are hand-written. Property-based or traffic-replay testing would widen coverage and is the natural next step.
