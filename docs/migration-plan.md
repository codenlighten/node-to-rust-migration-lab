# Migration plan (the process this repo follows)

1. **Baseline.** Node service with tests and fixtures committed first.
2. **Contract capture.** OpenAPI document plus request fixtures covering validation failures, auth errors, empty results,
   pagination and state-machine errors.
3. **Replacement.** Rust implementation of the same contract, translating behaviour (validation order, error bodies, transaction
   boundaries), not just syntax.
4. **Verification.** Identical fixtures on both, isolated identically seeded databases, response and database-state comparison,
   concurrency and interoperability checks. Every mismatch is either fixed in the replacement or recorded as a known difference.
5. **Performance.** Measured, interleaved, with spread; published whatever the outcome.
6. **Cutover.** Gateway: 0% -> canary -> 100% Rust, watching error rate and health; Node stays running and warm.
7. **Rollback.** See [rollback-plan.md](rollback-plan.md).
8. **Decommission** only after a full soak period with zero fallbacks.
