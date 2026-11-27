import test from "node:test";
import assert from "node:assert/strict";
import { judge, unmetExpectations } from "./lib/judge.mjs";

const run = (step, a, b, diffs = a === b ? [] : [`status: ${a} != ${b}`]) => judge(step, diffs, unmetExpectations(step, a, b));

test("without an expectation, agreement passes and difference fails", () => {
  assert.equal(run({}, 200, 200).pass, true);
  assert.equal(run({}, 401, 200).pass, false);
});
test("two backends that agree on the wrong answer fail", () => {
  assert.equal(run({ expect: 401 }, 200, 200).pass, false);
  assert.equal(run({ expect: 401 }, 401, 401).pass, true);
});
test("a pinned documented difference passes only in the documented direction", () => {
  const step = { known: "why", expect: [200, 401] };
  assert.deepEqual(run(step, 200, 401), { knownDiff: true, knownStale: false, pass: true });
  assert.equal(run(step, 401, 200).pass, false);
  assert.equal(run(step, 200, 200).pass, false, "the replacement becoming looser must not pass as a stale note");
});
test("an unpinned documented difference keeps its old behaviour", () => {
  assert.equal(run({ known: "why" }, 400, 401).pass, true);
  assert.deepEqual(run({ known: "why" }, 400, 400), { knownDiff: false, knownStale: true, pass: true });
});
