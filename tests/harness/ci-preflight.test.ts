import { readFileSync } from "node:fs";
import { load } from "js-yaml";
import { expect, test } from "vitest";
import { ciTestPlan, coverageCorpusFile, coverageFile } from "../../scripts/ci-test-plan.mjs";
import { preflightChecks } from "../../scripts/preflight.mjs";

type Step = { name?: string; run?: string; uses?: string; env?: Record<string, string> };
type Job = { needs?: string | string[]; if?: string; env?: Record<string, string>; steps?: Step[] };
const workflow = load(
  readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8"),
) as { jobs: Record<string, Job> };
const { jobs } = workflow;
const needsOf = (name: string): string[] => {
  const needs = jobs[name]!.needs ?? [];
  return typeof needs === "string" ? [needs] : needs;
};
/** Every job `name` waits on, directly or through the jobs it needs. */
function ancestors(name: string, seen = new Set<string>()): Set<string> {
  for (const need of needsOf(name))
    if (!seen.has(need)) {
      seen.add(need);
      ancestors(need, seen);
    }
  return seen;
}
// The jobs that may start before code_quality ends: the scope and lane selection, the check itself, the required
// aggregate (if: always()), and the nightly shape overlay jobs, which build their own packages outside the required
// check.
const ungated = [
  "validation_scope",
  "lanes",
  "queue_plan",
  "code_quality",
  "test",
  "shape_overlay_native",
  "shape_overlay",
];

test("every expensive CI job waits on code_quality", () => {
  const notGated = Object.keys(jobs).filter(
    (name) => !ungated.includes(name) && !ancestors(name).has("code_quality"),
  );
  expect(notGated).toEqual([]);
  expect(needsOf("native_linux")).toContain("code_quality");
  expect(jobs.code_quality!.needs).toBeUndefined();
  expect(jobs.code_quality!.if).toBeUndefined();
});

test("a failing code_quality starts no lane job", () => {
  // A job whose needs fail is skipped, and so is every job that needs it. With code_quality red, the jobs that
  // still start are the ungated ones, and the required aggregate fails on code_quality's result.
  const started = Object.keys(jobs).filter((name) => !ancestors(name).has("code_quality"));
  expect(started.toSorted()).toEqual(ungated.filter((name) => name !== "test").toSorted());
  expect(jobs.test!.if).toBe("${{ always() }}");
  const gate = jobs.test!.steps!.find((step) => step.run)!.run!;
  expect(gate).toContain('test "${{ needs.code_quality.result }}" = success');
});

test("pnpm preflight runs the code_quality job's checks", () => {
  const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
    scripts: Record<string, string>;
  };
  expect(pkg.scripts["preflight"]).toBe("node scripts/preflight.mjs");
  const steps = jobs.code_quality!.steps!;
  const install = steps.findIndex((step) => step.run === "pnpm install --frozen-lockfile");
  expect(install).toBeGreaterThan(-1);
  const checks = steps.slice(install + 1).map((step) => ({
    run: step.run,
    ...(step.env === undefined ? {} : { env: step.env }),
  }));
  expect(checks).toEqual(preflightChecks);
  // The cheapest checks first, so a formatting error ends the job within seconds of the install.
  expect(preflightChecks[0]!.run).toBe("pnpm format:check");
  expect(preflightChecks.map((check) => check.run)).toContain("pnpm build");
});

test("the coverage report runs once per run, its corpus sweep across the plain shards", () => {
  const job = jobs.coverage!;
  expect(job.if).toBe(
    "${{ needs.validation_scope.outputs.full == 'true' && needs.lanes.outputs.linux == 'true' && needs.lanes.outputs.queue != 'true' }}",
  );
  expect(needsOf("coverage")).toEqual(
    expect.arrayContaining(["validation_scope", "lanes", "code_quality"]),
  );
  expect(job.steps!.map((step) => step.run)).toContain(`pnpm test ${coverageFile}`);
  expect(needsOf("test")).toContain("coverage");
  expect(jobs.test!.steps!.find((step) => step.run)!.run).toContain(
    'lane coverage "${{ needs.coverage.result }}" "${{ needs.lanes.outputs.linux }}"',
  );
  for (const flavor of ["plain", "san"] as const)
    for (const shard of ["1/20", "20/20"]) {
      const plan = ciTestPlan({ shard, flavor, platform: "linux" });
      const files = [plan.corpus, ...plan.side].flatMap((task) => task.args);
      expect(files, `${flavor} ${shard}`).not.toContain(coverageFile);
      expect(files.includes(coverageCorpusFile), `${flavor} ${shard}`).toBe(flavor === "plain");
      expect(plan.side[0]!.args).toContain(`--exclude=${coverageFile}`);
      expect(plan.side[0]!.args).toContain(`--exclude=${coverageCorpusFile}`);
    }
});

test("the Sandbox runner splits the coverage corpus sweep and runs the coverage report once", () => {
  // scripts/sandbox-test.mjs runs as a command, so its lists are read from its source.
  const source = readFileSync(new URL("../../scripts/sandbox-test.mjs", import.meta.url), "utf8");
  const list = (name: string): string[] => {
    const match = new RegExp(`const ${name} = \\[([^\\]]*)\\]`).exec(source);
    expect(match, name).not.toBeNull();
    return [...match![1]!.matchAll(/"([^"]+)"/g)].map((entry) => entry[1]!);
  };
  expect(list("invariantCaseShardedFiles")).toContain(coverageCorpusFile);
  expect(list("invariantRemoteFiles")).toContain(coverageFile);
  expect(list("invariantCaseShardedFiles")).not.toContain(coverageFile);
});
