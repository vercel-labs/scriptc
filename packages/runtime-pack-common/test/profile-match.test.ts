import { expect, test } from "vitest";
import { profileMatchSummary } from "../scripts/profile-match.mjs";

// One helper report per unit object: the object's counts, and the profile's
// counters for each function the annotation matched or found changed.
const report = (
  annotated: Record<string, number>,
  mismatched: Record<string, number>,
  missing = 0,
) => ({
  annotated: Object.keys(annotated).length,
  mismatched: Object.keys(mismatched).length,
  missing,
  annotated_counts: annotated,
  mismatched_counts: mismatched,
});

test("a function that matches the profile in one object is not counted as changed", () => {
  // scr_send's control flow differs between the two builds of its unit, and
  // the profile holds the record of the default one.
  const summary = profileMatchSummary([
    report({ scr_send: 40, "scr_unit.c;helper": 10 }, {}),
    report({ "scr_unit.c;helper": 10 }, { scr_send: 40 }, 3),
  ]);
  expect(summary).toEqual({
    annotated: 3,
    mismatched: 1,
    missing: 3,
    annotated_names: 2,
    mismatched_names: 0,
    annotated_counts: 50,
    mismatched_counts: 0,
    stale: [],
  });
});

test("a function that matches the profile in no object is counted once, with its counters", () => {
  const summary = profileMatchSummary([
    report({ scr_kept: 5 }, { scr_changed: 70, scr_cold: 1 }),
    report({ scr_kept: 5 }, { scr_changed: 70 }),
    report({}, { "scr_other.c;changed": 20 }),
  ]);
  expect(summary).toEqual({
    annotated: 2,
    mismatched: 4,
    missing: 0,
    annotated_names: 1,
    mismatched_names: 3,
    annotated_counts: 5,
    mismatched_counts: 91,
    stale: ["scr_changed", "scr_other.c;changed", "scr_cold"],
  });
});

test("the functions with the most counts are named, at most ten", () => {
  const changed = Object.fromEntries(
    Array.from({ length: 12 }, (_, index) => [`scr_f${index}`, index]),
  );
  const { stale } = profileMatchSummary([report({ scr_kept: 1 }, changed)]);
  expect(stale).toEqual(Array.from({ length: 10 }, (_, index) => `scr_f${11 - index}`));
});

test("reports of a helper that does not list the functions give the per-object counts only", () => {
  expect(
    profileMatchSummary([
      { annotated: 7, mismatched: 2, missing: 1 },
      { annotated: 3, mismatched: 0, missing: 4 },
    ]),
  ).toEqual({ annotated: 10, mismatched: 2, missing: 5 });
});
