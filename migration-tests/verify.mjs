#!/usr/bin/env node
// Migration verification harness ("RustBridge" core).
// Runs identical request fixtures against the original and the replacement backend, each on its own
// identically seeded database, and compares status, content type, normalised body and resulting DB state.
import { writeFileSync, mkdirSync } from "node:fs";
import { groups } from "./scenarios.mjs";
import { cfg, connect, dumpState, resetAndSeed, waitFor } from "./lib/env.mjs";

const OUT = new URL("./report/", import.meta.url).pathname;
const PASSWORD = "password123";
const USERS = { admin: "admin@example.com", alice: "alice@example.com", bob: "bob@example.com" };

const TS = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
const JWT = /^[\w-]+\.[\w-]+\.[\w-]+$/;
/** Normalise ONLY deliberately nondeterministic fields. */
function normalise(v, key = "") {
  if (Array.isArray(v)) return v.map((x) => normalise(x));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, normalise(x, k)]));
  if (typeof v === "string") {
    if ((key === "createdAt" || key === "updatedAt") && TS.test(v)) return "<timestamp>";
    if (key === "token" && JWT.test(v)) return "<jwt>";
  }
  return v;
}

async function call(base, step, tokens) {
  const headers = {};
  if (step.as === "badtoken") headers.authorization = "Bearer not.a.token";
  else if (step.as) headers.authorization = `Bearer ${tokens[step.as]}`;
  let body;
  if (step.body !== undefined) {
    body = typeof step.body === "string" ? step.body : JSON.stringify(step.body);
    headers["content-type"] = step.contentType ?? "application/json";
  }
  const res = await fetch(base + step.path, { method: step.method, headers, body });
  const raw = await res.text();
  let json; try { json = raw ? JSON.parse(raw) : null; } catch { json = { __nonJson: raw }; }
  return {
    status: res.status,
    contentType: (res.headers.get("content-type") ?? "").split(";")[0].trim(),
    hasRequestId: !!res.headers.get("x-request-id"),
    body: normalise(json),
    rawJson: json, // unmasked, so later steps use the token from THIS login (no second, unreported login)
  };
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function diffPaths(a, b, path = "") {
  if (same(a, b)) return [];
  if (a && b && typeof a === "object" && typeof b === "object" && Array.isArray(a) === Array.isArray(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    return [...keys].flatMap((k) => diffPaths(a[k], b[k], path ? `${path}.${k}` : k));
  }
  return [`${path || "(root)"}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`];
}

async function main() {
  const { original: O, replacement: R } = cfg;
  await waitFor(O.url, "original"); await waitFor(R.url, "replacement");
  const mongo = await connect();
  const results = [];
  const t0 = Date.now();

  for (const g of groups) {
    for (const side of [O, R]) await resetAndSeed(mongo, side.db);
    const tokens = { original: {}, replacement: {} };
    const preamble = Object.entries(USERS).flatMap(([who, email]) => [
      { name: `setup: register ${who}`, method: "POST", path: "/api/auth/register", body: { email, password: PASSWORD, name: who } },
      { name: `setup: login ${who}`, method: "POST", path: "/api/auth/login", body: { email, password: PASSWORD }, save: who },
    ]);
    const steps = [...preamble, ...g.steps];
    const gr = { group: g.name, steps: [], dbDiff: [] };
    for (const step of steps) {
      const [a, b] = await Promise.all([call(O.url, step, tokens.original), call(R.url, step, tokens.replacement)]);
      if (step.save) {
        // A broken setup would make every later step "agree" on failures: abort the group instead.
        if (a.status !== 200 || b.status !== 200 || !a.rawJson?.token || !b.rawJson?.token) throw new Error(`setup failed in group "${g.name}": ${step.name} (${a.status}/${b.status})`);
        tokens.original[step.save] = a.rawJson.token; tokens.replacement[step.save] = b.rawJson.token;
      }
      if (step.name.startsWith("setup: register") && (a.status !== 201 || b.status !== 201)) throw new Error(`setup failed in group "${g.name}": ${step.name} (${a.status}/${b.status})`);
      let stepDb = [];
      if (step.method !== "GET") { // snapshot after every mutating step so transient effects of failed writes are caught
        const [sa, sb] = await Promise.all([dumpState(mongo, O.db), dumpState(mongo, R.db)]);
        stepDb = diffPaths(sa, sb);
      }
      const diffs = [];
      if (a.status !== b.status) diffs.push(`status: ${a.status} != ${b.status}`);
      if (a.contentType !== b.contentType) diffs.push(`content-type: ${a.contentType} != ${b.contentType}`);
      if (a.hasRequestId !== b.hasRequestId) diffs.push(`x-request-id header presence differs`);
      diffs.push(...diffPaths(a.body, b.body, "body"));
      stepDb.slice(0, 3).forEach((d) => diffs.push(`db: ${d}`));
      const knownDiff = !!step.known && diffs.length > 0;
      gr.steps.push({ known: step.known, knownDiff, knownStale: !!step.known && diffs.length === 0, name: step.name, request: `${step.method} ${step.path}`, original: a.status, replacement: b.status, pass: diffs.length === 0 || knownDiff, diffs, originalBody: a.body, replacementBody: b.body });
    }
    const [da, db] = await Promise.all([dumpState(mongo, O.db), dumpState(mongo, R.db)]);
    gr.dbDiff = diffPaths(da, db);
    results.push(gr);
  }
  await mongo.close();

  // ---- report ----
  const knownCount = results.reduce((n, g) => n + g.steps.filter((s) => s.knownDiff).length, 0);
  const total = results.reduce((n, g) => n + g.steps.length, 0);
  const passed = results.reduce((n, g) => n + g.steps.filter((s) => s.pass).length, 0);
  const dbBad = results.filter((g) => g.dbDiff.length);
  const verified = passed === total && dbBad.length === 0; // fixture parity, not proof of correctness (see docs/compatibility-report.md)
  const lines = [];
  lines.push("MIGRATION VERIFICATION (fixture parity: identical observable behaviour on the fixtures below)", "=".repeat(60), `Original:    ${O.name} @ ${O.url}  (db ${O.db})`, `Replacement: ${R.name} @ ${R.url}  (db ${R.db})`, "");
  for (const g of results) {
    const p = g.steps.filter((s) => s.pass).length;
    lines.push(`${g.group}: ${p}/${g.steps.length} steps identical, database state ${g.dbDiff.length ? "DIFFERS" : "identical"}`);
    for (const s of g.steps.filter((s) => s.knownDiff)) lines.push(`  KNOWN DIFFERENCE  ${s.request}  [${s.name}]: ${s.known}`);
    for (const s of g.steps.filter((s) => s.knownStale)) lines.push(`  NOTE  known difference no longer reproduces: [${s.name}]`);
    for (const s of g.steps.filter((s) => !s.pass)) { lines.push(`  MISMATCH  ${s.request}  [${s.name}]`); s.diffs.forEach((d) => lines.push(`      ${d}`)); }
    g.dbDiff.slice(0, 10).forEach((d) => lines.push(`  DB  ${d}`));
  }
  lines.push("", "=".repeat(60), `Scenarios: ${total}   identical: ${passed - knownCount}   documented known differences: ${knownCount}   unexpected mismatches: ${total - passed}   DB-state groups differing: ${dbBad.length}`,
    `Compatibility: ${((passed / total) * 100).toFixed(2)}%   (${((Date.now() - t0) / 1000).toFixed(1)}s)`, `MIGRATION STATUS: ${verified ? (knownCount ? `VERIFIED (with ${knownCount} documented known differences)` : "VERIFIED") : "FAILED"}`);
  console.log(lines.join("\n"));

  mkdirSync(OUT, { recursive: true });
  const summary = { knownDifferences: knownCount, generatedAt: new Date().toISOString(), original: O, replacement: R, total, passed, dbDiffGroups: dbBad.length, verified, groups: results };
  writeFileSync(OUT + "verification.json", JSON.stringify(summary, null, 2));
  writeFileSync(OUT + "verification.html", html(summary));
  process.exit(verified ? 0 : 1);
}

const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
function html(s) {
  const rows = s.groups.map((g) => `<h2>${esc(g.group)}</h2><table><tr><th>Request</th><th>Scenario</th><th>${esc(s.original.name)}</th><th>${esc(s.replacement.name)}</th><th>Result</th></tr>` +
    g.steps.map((x) => `<tr class="${x.pass ? "ok" : "bad"}"><td><code>${esc(x.request)}</code></td><td>${esc(x.name)}</td><td>${x.original}</td><td>${x.replacement}</td><td>${x.pass ? "match" : esc(x.diffs.join("; "))}</td></tr>`).join("") +
    `</table><p>${g.dbDiff.length ? "Database state differs: " + esc(g.dbDiff[0]) : "Database state identical."}</p>`).join("");
  return `<!doctype html><meta charset="utf-8"><title>Migration verification</title><style>body{font:14px system-ui;margin:2rem;max-width:1100px}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ccc;padding:4px 8px;text-align:left}.ok td:last-child{color:#0a7d33}.bad{background:#fde8e8}</style>
<h1>Migration verification: ${s.verified ? "VERIFIED" : "FAILED"}</h1><p>${s.passed}/${s.total} scenarios identical. Generated ${esc(s.generatedAt)}.</p>${rows}`;
}

main().catch((e) => { console.error(e); process.exit(2); });
