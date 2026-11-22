import { readFileSync } from "node:fs";
import { load } from "js-yaml";
import { expect, test } from "vitest";

// A job without timeout-minutes holds its runner for six hours when it hangs,
// and the run, and anything waiting on it, for as long.
test("every CI job has a timeout", () => {
  const { jobs } = load(
    readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8"),
  ) as { jobs: Record<string, { "timeout-minutes"?: number | string }> };
  const missing = Object.entries(jobs)
    .filter(([, job]) => job["timeout-minutes"] === undefined)
    .map(([name]) => name);
  expect(missing).toEqual([]);
});
