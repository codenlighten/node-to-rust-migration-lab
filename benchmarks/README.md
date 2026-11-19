# Benchmarks

`benchmark.mjs` runs identical load against the Node and Rust backends on separate, identically seeded databases.

* Scenarios: framework overhead (`/health`), DB point read, DB read + JSON (100 items), regex search, bcrypt login (CPU-bound),
  transactional order write.
* Method: autocannon, fixed connections and duration, **rounds alternate** which backend goes first, report is the **median with the
  min-max spread**; when the two backends' ranges overlap the conclusion is "inconclusive".
* The environment (CPU, load average before/after, versions, commit and dirty flag, idle memory) is stored with the results in
  `results/latest.json`, which the dashboard displays.
* Run on a quiet host with the servers pinned to their own cores; numbers from a busy or shared machine are indicative only.

```bash
docker compose --profile verify up -d node-verify rust-verify
node benchmark.mjs --rounds 5 --duration 15      # add --node-pid/--rust-pid for local processes to sample RSS and CPU
```

Results are not checked in until they have been measured on a quiet host.
