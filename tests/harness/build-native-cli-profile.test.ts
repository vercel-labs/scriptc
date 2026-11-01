import { readFileSync } from "node:fs";
import { load } from "js-yaml";
import { expect, test } from "vitest";
import { judgeProfileMatch } from "../../scripts/build-native-cli-profile.mjs";

const match = (annotated: number, mismatched: number, extra: object = {}) => ({
  annotated,
  mismatched,
  missing: 120,
  recovered: 0,
  unknownPartitions: 0,
  ...extra,
});

test("a profile that matches at least 95% of its functions passes", () => {
  expect(judgeProfileMatch(match(950, 50), { check: true })).toEqual({
    summary:
      "native compiler profile: 950 of 1000 profiled functions match (95.0%); 120 functions have no profile",
  });
});

test("a profile between 90% and 95% warns, and passes the check", () => {
  // 94.96% is reported as 94.9%, not rounded up to the floor.
  const stale = match(9496, 504, { annotatedCounts: 900, mismatchedCounts: 100 });
  const warning = `the native compiler profile matches 94.9% of the functions it describes, below 95%; refresh packages/compiler/native/cli.profdata.gz with \`node scripts/refresh-cli-profile.mjs --tsc-ts <tsc-ts checkout>\` on a Linux x64 host and commit it`;
  const verdict = {
    summary:
      "native compiler profile: 9496 of 10000 profiled functions match (94.9%); 120 functions have no profile; changed functions hold 10.0% of its counts",
    warning,
  };
  expect(judgeProfileMatch(stale)).toEqual(verdict);
  expect(judgeProfileMatch(stale, { check: true })).toEqual(verdict);
});

test("a profile below 90% fails the build with the check", () => {
  const stale = match(8999, 1001, { annotatedCounts: 900, mismatchedCounts: 100 });
  const refresh =
    "refresh packages/compiler/native/cli.profdata.gz with `node scripts/refresh-cli-profile.mjs --tsc-ts <tsc-ts checkout>` on a Linux x64 host and commit it";
  const below =
    "the native compiler profile matches 89.9% of the functions it describes, below 90%";
  const summary =
    "native compiler profile: 8999 of 10000 profiled functions match (89.9%); 120 functions have no profile; changed functions hold 10.0% of its counts";
  expect(judgeProfileMatch(stale, { check: true })).toEqual({
    summary,
    error: `${below}; ${refresh}`,
  });
  expect(judgeProfileMatch(stale)).toEqual({
    summary,
    warning: `${below}, which fails in CI; ${refresh}`,
  });
});

test("a build that reused partitions without their counts is not judged", () => {
  expect(judgeProfileMatch(match(10, 90, { unknownPartitions: 3 }), { check: true })).toEqual({
    summary:
      "native compiler profile: 10 of 100 profiled functions match (10.0%); 120 functions have no profile; 3 partitions reused without counts",
  });
});

test("a build laid out differently from the instrumented build is not judged", () => {
  // The bootstrap seed uses no layout; a refresh would not raise its match.
  expect(
    judgeProfileMatch(match(1000, 8000), { check: true, layoutMatchesProfile: false }),
  ).toEqual({
    summary:
      "native compiler profile: 1000 of 9000 profiled functions match (11.1%); 120 functions have no profile",
  });
});

test("CI checks the committed profile in a build that keeps the committed layout", () => {
  const workflow = load(
    readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8"),
  ) as {
    jobs: Record<string, { if?: string; steps: { run?: string; env?: Record<string, string> }[] }>;
  };
  const job = workflow.jobs.native_profile!;
  expect(job.if).toContain("needs.lanes.outputs.profile == 'true'");
  const build = job.steps.find((step) => step.run === "pnpm build:native-compiler")!;
  // The check fails the build below FAIL_BELOW. The committed layout must
  // stay in use: the profile was collected with it, and a build without it
  // matches fewer functions however fresh the profile is.
  expect(build.env).toEqual({ SCRIPTC_NATIVE_PROFILE_CHECK: "1" });
});
