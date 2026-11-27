// The pass/fail rule for one fixture step. Agreement between the two backends is not enough where a step states what
// the answer must be (`expect`: one status for both, or [original, replacement]).

export function unmetExpectations(step, original, replacement) {
  if (step.expect === undefined) return [];
  const [wantOriginal, wantReplacement] = Array.isArray(step.expect) ? step.expect : [step.expect, step.expect];
  const unmet = [];
  if (original !== wantOriginal) unmet.push(`expected original ${wantOriginal}, got ${original}`);
  if (replacement !== wantReplacement) unmet.push(`expected replacement ${wantReplacement}, got ${replacement}`);
  return unmet;
}

/** A documented difference excuses differences between the backends, never an unmet expectation. */
export function judge(step, diffs, unmet) {
  const knownDiff = !!step.known && diffs.length > 0 && unmet.length === 0;
  return { knownDiff, knownStale: !!step.known && diffs.length === 0, pass: unmet.length === 0 && (diffs.length === 0 || knownDiff) };
}
