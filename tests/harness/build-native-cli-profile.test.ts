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

test("a profile that matches at least 95% of its functions is reported without a warning", () => {
  expect(judgeProfileMatch(match(950, 50))).toEqual({
    summary:
      "native compiler profile: 950 of 1000 profiled functions match (95.0%); 120 functions have no profile",
  });
});

test("a profile between 90% and 95% warns", () => {
  // 94.96% is reported as 94.9%, not rounded up to the floor.
  const stale = match(9496, 504, { annotatedCounts: 900, mismatchedCounts: 100 });
  const warning = `the native compiler profile matches 94.9% of the functions it describes, below 95%; refresh packages/compiler/native/cli.profdata.gz with \`node scripts/refresh-cli-profile.mjs --tsc-ts <tsc-ts checkout>\` on a Linux x64 host and commit it`;
  expect(judgeProfileMatch(stale)).toEqual({
    summary:
      "native compiler profile: 9496 of 10000 profiled functions match (94.9%); 120 functions have no profile; changed functions hold 10.0% of its counts",
    warning,
  });
});

test("a profile below 90% warns and does not fail the build", () => {
  const stale = match(8999, 1001, { annotatedCounts: 900, mismatchedCounts: 100 });
  const refresh =
    "refresh packages/compiler/native/cli.profdata.gz with `node scripts/refresh-cli-profile.mjs --tsc-ts <tsc-ts checkout>` on a Linux x64 host and commit it";
  expect(judgeProfileMatch(stale)).toEqual({
    summary:
      "native compiler profile: 8999 of 10000 profiled functions match (89.9%); 120 functions have no profile; changed functions hold 10.0% of its counts",
    warning: `the native compiler profile matches 89.9% of the functions it describes, below 95%; ${refresh}`,
  });
});

test("a build that reused partitions without their counts is not judged", () => {
  expect(judgeProfileMatch(match(10, 90, { unknownPartitions: 3 }))).toEqual({
    summary:
      "native compiler profile: 10 of 100 profiled functions match (10.0%); 120 functions have no profile; 3 partitions reused without counts",
  });
});

test("a build laid out differently from the instrumented build is not judged", () => {
  // The bootstrap seed uses no layout; a refresh would not raise its match.
  expect(judgeProfileMatch(match(1000, 8000), { layoutMatchesProfile: false })).toEqual({
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
  // The build runs through the self-compile budget, which runs the script
  // `pnpm build:native-compiler` runs and judges the build's own cost.
  const build = job.steps.find(
    (step) => step.run === "node scripts/self-compile-budget.mjs --native-build",
  )!;
  expect(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).toContain(
    '"build:native-compiler": "node --max-old-space-size=8192 --import tsx scripts/build-native-cli.mts"',
  );
  expect(
    readFileSync(new URL("../../scripts/self-compile-budget.mjs", import.meta.url), "utf8"),
  ).toContain('"--import", "tsx", join(root, "scripts/build-native-cli.mts")');
  // The check reports the match and fails only when the profile cannot be
  // judged. The committed layout must stay in use: the profile was collected
  // with it, and a build without it matches fewer functions however fresh the
  // profile is.
  expect(build.env).toEqual({ SCRIPTC_NATIVE_PROFILE_CHECK: "1" });
});

test("the nightly profile refresh collects a profile on main and opens a pull request", () => {
  const workflow = load(
    readFileSync(new URL("../../.github/workflows/profile-refresh.yml", import.meta.url), "utf8"),
  ) as {
    on: { schedule: { cron: string }[]; workflow_dispatch?: unknown };
    jobs: {
      refresh: { steps: { run?: string; env?: Record<string, string> }[] };
    };
  };
  expect(workflow.on.schedule.map((entry) => entry.cron)).toEqual(["43 8 * * *"]);
  expect("workflow_dispatch" in workflow.on).toBe(true);
  const steps = workflow.jobs.refresh.steps;
  const collect = steps.find((step) => step.run?.includes("scripts/refresh-cli-profile.mjs"))!;
  expect(collect.run).toContain("--context-sensitive");
  // The profile must be collected with the committed layout: a profile
  // collected with a fresh one would describe partitions builds on main do
  // not use, and the check would fail on it.
  expect(collect.env).toBeUndefined();
  const build = steps.find((step) => step.run?.includes("pnpm build:native-compiler"))!;
  expect(build.env).toEqual({ SCRIPTC_NATIVE_PROFILE_CHECK: "1" });
  // `tee` reports its own exit status, so without pipefail a build that fails
  // after printing its summary would pass this step, and the refresh would
  // open a pull request for a profile it could not build with.
  const pipefail = build.run!.indexOf("set -o pipefail");
  expect(pipefail).toBeGreaterThanOrEqual(0);
  expect(pipefail).toBeLessThan(build.run!.indexOf("pnpm build:native-compiler"));
  // The repository refuses unsigned commits on every branch, and a commit
  // made with git on the runner is unsigned: the job's push failed on each
  // of its first five nights. GitHub signs a commit made through its API,
  // and the step checks that it did before it moves the branch.
  const open = steps.find((step) => step.run?.includes("gh pr create"))!;
  expect(open.run).toContain("createCommitOnBranch");
  expect(open.run).toContain(".commit.verification.verified");
  expect(open.run).not.toMatch(/\bgit (commit|push)\b/);
  expect(open.run!.indexOf(".commit.verification.verified")).toBeLessThan(
    open.run!.indexOf("--method PATCH"),
  );
  // Whether the branch exists is asked by its exact name. The plural
  // endpoint answers a name no branch has with the branches that start with
  // it, which the scratch branch does: the first run would then try to move
  // a branch that is not there.
  expect(open.run).toContain('if gh api "$ref/heads/$branch"');
  expect(open.run).toContain('ref="repos/$GITHUB_REPOSITORY/git/ref"');
  expect(open.run).not.toMatch(/gh api "\$refs\/heads\//);
});
