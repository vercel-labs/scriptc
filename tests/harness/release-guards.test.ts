import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { load } from "js-yaml";
import { expect, test } from "vitest";
import { preflight, publishedPackages, releaseNotes } from "../../scripts/release-preflight.mjs";
import { PUBLISHING_JOBS, staleRuns } from "../../scripts/release-supersede.mjs";

const repoRoot = join(import.meta.dirname, "../..");

type Job = { name: string; status: string };
const run = (id: number, status: string, jobs: Job[]) => ({ id, run_number: id, status, jobs });
const jobsOf = (r: { jobs: Job[] }) => r.jobs;

test("a newer release run supersedes older runs that have not started publishing", () => {
  const runs = [
    run(1, "waiting", [
      { name: "Build native package (linux-x64)", status: "completed" },
      { name: "Publish to npm", status: "waiting" },
    ]),
    run(2, "in_progress", [{ name: "Build native package (linux-x64)", status: "in_progress" }]),
    run(3, "in_progress", [
      { name: "Publish to npm", status: "completed" },
      { name: "Wait for npm availability", status: "in_progress" },
    ]),
    run(4, "in_progress", [{ name: "Publish to npm", status: "in_progress" }]),
    run(5, "in_progress", [{ name: "Check for new version", status: "in_progress" }]),
    run(6, "queued", []),
  ];
  const stale = staleRuns(runs, 5, jobsOf);
  expect(stale.map(({ run, reason }) => [run.id, reason])).toEqual([
    [1, "waiting for approval to publish"],
    [2, "not publishing yet"],
  ]);
  // The newest run supersedes everything older that has not published, and nothing newer.
  expect(staleRuns(runs, 6, jobsOf).map(({ run }) => run.id)).toEqual([1, 2, 5]);
  expect(staleRuns(runs, 1, jobsOf)).toEqual([]);
});

test("the publishing jobs the supersede guard protects exist in release.yml", () => {
  const release = load(readFileSync(join(repoRoot, ".github/workflows/release.yml"), "utf8")) as {
    concurrency?: unknown;
    jobs: Record<string, { name?: string; concurrency?: unknown }>;
  };
  const names = Object.values(release.jobs).map((job) => job.name);
  for (const name of PUBLISHING_JOBS) expect(names).toContain(name);
  // No workflow-wide group: a run waiting for approval must not hold every later run.
  expect(release.concurrency).toBeUndefined();
  expect(release.jobs["publish"]!.concurrency).toMatchObject({ "cancel-in-progress": false });
});

test("preflight passes on the tree and names each problem it finds", () => {
  expect(preflight(repoRoot).problems).toEqual([]);
  // The publish job uploads 36 packages; preflight checks the same set.
  expect(publishedPackages(repoRoot)).toContain("packages/libnode-darwin-arm64");
  expect(publishedPackages(repoRoot)).not.toContain("packages/runtime-pack-common");

  const dir = mkdtempSync(join(tmpdir(), "scriptc-preflight-"));
  try {
    for (const name of ["cli", "runtime", "compiler"])
      cpSync(
        join(repoRoot, "packages", name, "package.json"),
        join(dir, "packages", name, "package.json"),
      );
    const runtime = join(dir, "packages/runtime/package.json");
    writeFileSync(runtime, JSON.stringify({ name: "@scriptc/runtime", version: "0.0.1" }));
    writeFileSync(join(dir, "CHANGELOG.md"), "# Changelog\n\n## Unreleased\n");
    const { problems } = preflight(dir);
    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain("packages/runtime is at 0.0.1");
    expect(problems[1]).toContain("<!-- release:start -->");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  expect(releaseNotes("a\n<!-- release:start -->\n## 1.0.0\n\n- x\n<!-- release:end -->\n")).toBe(
    "## 1.0.0\n\n- x",
  );
});
