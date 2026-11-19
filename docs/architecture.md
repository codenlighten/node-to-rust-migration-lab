# Architecture

```
 browser ──> frontend (nginx, static React)
                │  /api, /__gateway
                v
            gateway :8080  ── health checks every 2 s ──┐
             │ route: node | rust | canary(%)            │
        ┌────┴─────┐                                    │
        v          v                                    │
   Node API     Rust API  <───────── /ready ────────────┘
        └────┬─────┘
             v
         MongoDB 7 (single-node replica set, required for transactions)
```

* The **gateway** is a dependency-free Node proxy. It tags every response `x-served-by`, keeps per-backend request counts, supports a
  canary percentage, refuses to route to an unhealthy Rust service, and flips back to Node after three failed `/ready` checks.
  Its control endpoints (`/__gateway/*`) exist for the demo only and must not be exposed in a real deployment.
* Both backends share one database in the demo (strangler pattern). The verification harness instead uses `verify_node` and
  `verify_rust`, identically seeded, so behaviour can be compared without cross-talk.
* Both services log one JSON line per request (`impl`, `reqId`, `method`, `path`, `status`, `ms`) and honour an incoming `x-request-id`.
