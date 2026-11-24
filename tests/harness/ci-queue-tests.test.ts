import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { load } from "js-yaml";
import { expect, test } from "vitest";
import { PLAIN_SHARDS, queueTests } from "../../scripts/ci/queue-tests.mjs";

const workflow = load(
  readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8"),
) as {
  jobs: Record<
    string,
    {
      needs?: string[];
      outputs?: Record<string, string>;
      strategy?: { matrix?: Record<string, string> };
      steps?: { id?: string; run?: string }[];
    }
  >;
};

test("the queue runs every plain shard and no smoke cases", () => {
  const plan = queueTests();
  expect(plan.plainShards).toEqual(Array.from({ length: 20 }, (_, index) => index + 1));
  expect(new Set(plan.plainShards).size).toBe(plan.plainShards.length);
  expect(PLAIN_SHARDS).toEqual(plan.plainShards);
  // The queue's fast gate has no separate smoke corpus yet; a later selection fills this in.
  expect(plan.smoke).toEqual([]);
});

test("the plan writes the workflow's outputs", () => {
  const directory = mkdtempSync(join(tmpdir(), "ci-queue-tests-"));
  try {
    const outputPath = join(directory, "output");
    const result = spawnSync(
      "node",
      [new URL("../../scripts/ci/queue-tests.mjs", import.meta.url).pathname, "--github-output"],
      { encoding: "utf8", env: { ...process.env, GITHUB_OUTPUT: outputPath } },
    );
    expect(result.status, result.stderr).toBe(0);
    const outputs = Object.fromEntries(
      readFileSync(outputPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => {
          const [name, ...value] = line.split("=");
          return [name, JSON.parse(value.join("="))];
        }),
    );
    expect(outputs.plain_shards).toEqual(PLAIN_SHARDS);
    expect(outputs.smoke).toEqual([]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the queue's test matrix comes from the plan and runs the plain flavor only", () => {
  const planJob = workflow.jobs.queue_plan!;
  expect(planJob.outputs).toEqual({
    plain_shards: "${{ steps.plan.outputs.plain_shards }}",
    smoke: "${{ steps.plan.outputs.smoke }}",
  });
  // The base revision's copy decides, as the lane selector's does; the pull request that lands the script runs its
  // own copy until then.
  const planStep = planJob.steps!.find((step) => step.id === "plan")!;
  expect(planStep.run).toContain('git show "$BASE:scripts/ci/queue-tests.mjs"');
  expect(planStep.run).toContain('node "$RUNNER_TEMP/queue-tests.mjs" --github-output');
  expect(planStep.run).toContain("node scripts/ci/queue-tests.mjs --github-output");
  const tests = workflow.jobs.tests!;
  expect(tests.needs).toContain("queue_plan");
  const matrix = tests.strategy!.matrix!;
  expect(matrix.flavor).toBe(
    "${{ needs.lanes.outputs.queue == 'true' && fromJSON('[\"plain\"]') || fromJSON('[\"plain\", \"san\"]') }}",
  );
  expect(matrix.shard).toContain("needs.queue_plan.outputs.plain_shards");
});
