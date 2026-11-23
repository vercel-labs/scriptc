import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const runner = fileURLToPath(new URL("../../scripts/ci-vercel/run-lane.mjs", import.meta.url));

function runLane(args: string[], env: Record<string, string>) {
  const result = spawnSync(process.execPath, [runner, ...args], {
    encoding: "utf8",
    env: { ...process.env, VERCEL_GIT_COMMIT_REF: "", VERCEL_GIT_PULL_REQUEST_ID: "", ...env },
  });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout;
}

test("a pull request runs one sampled effect shard per flavor, not the full set", () => {
  expect(
    runLane(["effects", "plain", "7", "16"], { VERCEL_GIT_PULL_REQUEST_ID: "4082" }),
  ).toContain("A pull request runs one effect shard per flavor");
});

test("a push to the default branch runs every effect shard, not the sample", () => {
  expect(runLane(["effects-sample", "san"], { VERCEL_GIT_COMMIT_REF: "main" })).toContain(
    "Every effect shard runs outside a pull request",
  );
});
