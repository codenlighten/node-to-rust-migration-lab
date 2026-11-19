// Runs the shared vectors (api-contract/validation-vectors.json); backend-rust/src/validate.rs runs the same file.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Detail, Obj, int, str, validEmail } from "../src/validate.js";

const V = JSON.parse(readFileSync(new URL("../../api-contract/validation-vectors.json", import.meta.url), "utf8"));
// The route's escapeRe lives in app.ts (not exported); keep an identical copy under test via the same regex.
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

test("email vectors", () => { for (const c of V.email) assert.equal(validEmail(c.in), c.valid, JSON.stringify(c.in)); });

for (const kind of ["str", "int"] as const) {
  test(`${kind} vectors`, () => {
    for (const c of V[kind]) {
      const o = JSON.parse(c.body) as Obj; const d: Detail[] = [];
      const value = kind === "str" ? str(o, c.field, c.min, c.max, d, c.required) : int(o, c.field, c.min, c.max, d, c.required);
      assert.deepEqual({ value: value === undefined ? null : typeof value === "number" ? value + 0 : value, details: d }, c.expect, c.body); // +0 folds -0 into 0
    }
  });
}

test("escapeRegex vectors", () => { for (const c of V.escapeRegex) assert.equal(escapeRe(c.in), c.out, c.in); });
