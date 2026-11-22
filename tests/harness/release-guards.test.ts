import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { load } from "js-yaml";
import { expect, test } from "vitest";
import {
  nextPatch,
  promoteAction,
  npmPreflight,
  preflight,
  publishedNames,
  publishedPackages,
  releaseNotes,
} from "../../scripts/release-preflight.mjs";
import { hostPackages, versionMismatches } from "../../scripts/release-registry-smoke.mjs";
import { decide, eligibleRuns, gateBranch } from "../../scripts/release-ci-gate.mjs";
import { PUBLISHING_JOBS, staleRuns } from "../../scripts/release-supersede.mjs";
import { payloadDifferences, tarballFiles } from "../../scripts/verify-npm-published.mjs";

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

test("the release CI gate waits for, accepts, rejects or dispatches CI on the release commit", () => {
  const run = (event: string, status: string, conclusion: string | null, created_at: string) => ({
    event,
    status,
    conclusion,
    created_at,
    html_url: `https://example.test/${created_at}`,
  });
  // The push run finished green.
  expect(decide([run("push", "completed", "success", "1")]).action).toBe("pass");
  // The push run is still running or waiting in the main group.
  expect(decide([run("push", "pending", null, "1")]).action).toBe("wait");
  expect(decide([run("push", "in_progress", null, "1")]).action).toBe("wait");
  // It failed: a re-run of its failed jobs turns it back to in_progress.
  expect(decide([run("push", "completed", "failure", "1")]).action).toBe("fail");
  // A newer push replaced its pending run, or there never was one: start one.
  expect(decide([run("push", "completed", "cancelled", "1")]).action).toBe("dispatch");
  expect(decide([]).action).toBe("dispatch");
  // After dispatching, wait for the run to appear, then for it to finish.
  expect(decide([run("push", "completed", "cancelled", "1")], { dispatched: true }).action).toBe(
    "wait",
  );
  const dispatchedRuns = [
    run("push", "completed", "cancelled", "1"),
    run("workflow_dispatch", "queued", null, "2"),
  ];
  expect(decide(dispatchedRuns, { dispatched: true }).action).toBe("wait");
  dispatchedRuns[1] = run("workflow_dispatch", "completed", "success", "2");
  expect(decide(dispatchedRuns, { dispatched: true }).action).toBe("pass");
  dispatchedRuns[1] = run("workflow_dispatch", "completed", "cancelled", "2");
  expect(decide(dispatchedRuns, { dispatched: true }).action).toBe("fail");
});

test("only the push run and the gate's own complete dispatch vouch for the release commit", () => {
  const sha = "0123456789abcdef0123456789abcdef01234567";
  const run = (event: string, head_branch: string, conclusion: string, created_at: string) => ({
    event,
    head_branch,
    status: "completed",
    conclusion,
    created_at,
    html_url: `https://example.test/${created_at}`,
  });
  // A manual run on main may have run the shape overlay alone (scope
  // shape_overlay) or the smaller darwin macOS suite; its success does not
  // outweigh the push run's failure.
  const runs = [
    run("push", "main", "failure", "1"),
    run("workflow_dispatch", "main", "success", "2"),
    run("pull_request", "ctate/x", "success", "3"),
  ];
  expect(eligibleRuns(runs, sha).map((r) => r.created_at)).toEqual(["1"]);
  expect(decide(eligibleRuns(runs, sha)).action).toBe("fail");
  // The same manual run with the push run dropped: the gate dispatches its own.
  runs[0] = run("push", "main", "cancelled", "1");
  expect(decide(eligibleRuns(runs, sha)).action).toBe("dispatch");
  // The run the gate dispatched on its branch counts.
  runs.push(run("workflow_dispatch", gateBranch(sha), "success", "4"));
  expect(decide(eligibleRuns(runs, sha), { dispatched: true }).action).toBe("pass");
});

test("CI on main keeps one group without cancelling, and pull requests keep cancelling", () => {
  const ci = load(readFileSync(join(repoRoot, ".github/workflows/ci.yml"), "utf8")) as {
    concurrency: { group: string; "cancel-in-progress": string };
  };
  expect(ci.concurrency.group).toContain("github.event_name == 'push' && 'main'");
  expect(ci.concurrency["cancel-in-progress"]).toBe("${{ github.event_name == 'pull_request' }}");
});

test("a version npm already holds counts as published only when npm holds this payload", () => {
  // #4011: 0.4.15's runtime packs were refused as already published, by an
  // earlier failed attempt from an older commit, and the release counted them
  // as its own. The publish step now compares the payloads first.
  const release = load(readFileSync(join(repoRoot, ".github/workflows/release.yml"), "utf8")) as {
    jobs: Record<string, { steps: { id?: string; run?: string }[] }>;
  };
  const publish = release.jobs["publish"]!.steps.find((step) => step.id === "publish")!.run!;
  const exists = publish.indexOf('if npm view "$name@$VERSION" version');
  const verify = publish.indexOf(
    'node scripts/verify-npm-published.mjs "$packed" "$name@$VERSION" || return 1',
  );
  const accept = publish.indexOf('echo "$name@$VERSION is now public"');
  expect(exists).toBeGreaterThan(-1);
  expect(verify).toBeGreaterThan(exists);
  expect(accept).toBeGreaterThan(verify);
  // The one place that accepts a version npm already has is that one.
  expect(publish.split('if npm view "$name@$VERSION"').length).toBe(2);

  const dir = mkdtempSync(join(tmpdir(), "scriptc-npm-verify-test-"));
  try {
    const pack = (name: string, files: Record<string, string>, executable: string[] = []) => {
      const root = join(dir, name);
      for (const [path, contents] of Object.entries(files)) {
        mkdirSync(join(root, "package", path, ".."), { recursive: true });
        writeFileSync(join(root, "package", path), contents);
        chmodSync(join(root, "package", path), executable.includes(path) ? 0o755 : 0o644);
        utimesSync(
          join(root, "package", path),
          new Date(),
          new Date(Date.now() - 1000 * name.length),
        );
      }
      const tarball = join(dir, `${name}.tgz`);
      const tar = spawnSync("tar", ["-czf", tarball, "-C", root, "package"]);
      expect(tar.status, String(tar.stderr)).toBe(0);
      return tarballFiles(tarball);
    };
    const files = {
      "package.json": '{"name":"@scriptc/runtime-darwin-arm64","version":"0.4.15"}',
      "runtime-pack.json": '{"runtime_abi":{"version":51}}',
      "artifacts/release/libscr.a": "v51",
      "bin/helper": "#!/bin/sh",
    };
    const local = pack("local", files, ["bin/helper"]);
    // A retry of the same payload passes, whatever the timestamps.
    expect(payloadDifferences(local, pack("same", files, ["bin/helper"]))).toEqual([]);
    expect(
      payloadDifferences(
        local,
        pack(
          "stale",
          {
            ...files,
            "runtime-pack.json": '{"runtime_abi":{"version":48}}',
            "artifacts/release/libscr.a": "v48",
            "artifacts/release/old.a": "old",
          },
          [],
        ),
      ),
    ).toEqual([
      "artifacts/release/libscr.a: differs",
      "artifacts/release/old.a: only on npm",
      "bin/helper: differs",
      "runtime-pack.json: differs",
    ]);
    const { "bin/helper": _helper, ...withoutHelper } = files;
    expect(payloadDifferences(local, pack("missing", withoutHelper))).toEqual([
      "bin/helper: only in this release",
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

type ReleaseJob = {
  name?: string;
  needs?: string[];
  if?: string;
  environment?: string;
  concurrency?: { group: string; "cancel-in-progress": boolean };
  permissions?: Record<string, string>;
  strategy?: { matrix: { include: { platform: string; runner: string }[] } };
  steps: {
    id?: string;
    name?: string;
    if?: string;
    uses?: string;
    run?: string;
    with?: Record<string, unknown>;
  }[];
};
const releaseWorkflow = () =>
  load(readFileSync(join(repoRoot, ".github/workflows/release.yml"), "utf8")) as {
    jobs: Record<string, ReleaseJob>;
  };

test("a release never reuses a version npm already has any package of", async () => {
  const names = publishedNames(repoRoot);
  const version = JSON.parse(
    readFileSync(join(repoRoot, "packages/cli/package.json"), "utf8"),
  ).version;
  expect(names).toContain("scriptc");
  expect(names).toContain("@scriptc/runtime-darwin-arm64");
  expect(await npmPreflight(repoRoot, async () => false)).toBeNull();
  // One stale runtime pack is enough to stop the run, before any build, naming the next patch.
  const problem = await npmPreflight(repoRoot, async (name, at) => {
    expect(at).toBe(version);
    return name === "@scriptc/runtime-darwin-arm64";
  });
  expect(problem).toContain(`1 of the ${names.length} packages of ${version} are already on npm`);
  expect(problem).toContain("@scriptc/runtime-darwin-arm64");
  expect(problem).toContain(`release ${nextPatch(version)} instead`);
  expect(nextPatch("0.4.15")).toBe("0.4.16");
  expect(nextPatch("1.9.9-rc.1")).toBe("1.9.10");
  expect(() => nextPatch("next")).toThrow();

  // The check runs in check-release, which every build and publish job needs.
  const { jobs } = releaseWorkflow();
  const check = jobs["check-release"]!.steps.find(
    (step) => step.name === "Check the release can publish",
  )!;
  expect(check.run).toBe("node scripts/release-preflight.mjs --npm");
  for (const job of ["build-native-packages", "build-libnode-packs", "publish"])
    expect(jobs[job]!.needs, job).toContain("check-release");
  // Only this run's receipts resume a publish (re-running its failed jobs); no earlier run's.
  expect(JSON.stringify(jobs)).not.toContain("receipt_run");
});

test("the release publishes under next, smoke-tests from npm on every host, then moves latest", () => {
  const { jobs } = releaseWorkflow();
  const publish = jobs["publish"]!.steps.find((step) => step.id === "publish")!.run!;
  expect(publish).toContain('npm publish "$packed" $PROVENANCE --access public --tag next');
  expect(publish.match(/npm publish /g)).toHaveLength(1);

  const smoke = jobs["registry-smoke"]!;
  expect(smoke.needs).toEqual(["check-release", "npm-available"]);
  expect(smoke.strategy!.matrix.include.map(({ platform }) => platform)).toEqual([
    "linux-x64",
    "linux-arm64",
    "darwin-arm64",
    "darwin-x64",
    "windows-x64",
  ]);
  expect(smoke.steps.at(-1)!.run).toBe(
    "node scripts/release-registry-smoke.mjs ${{ needs.check-release.outputs.version }}",
  );

  const promote = jobs["promote"]!;
  expect(promote.needs).toEqual(["check-release", "registry-smoke"]);
  expect(promote.if).toContain("needs.registry-smoke.result == 'success'");
  expect(promote.environment).toBe("Release");
  expect(promote.permissions).toMatchObject({ "id-token": "write" });
  const move = promote.steps.at(-1)!.run!;
  // npm authorizes dist-tag over OIDC from 11.21.0.
  expect(move).toContain("npm install --global npm@11.21.0");
  expect(move).toContain('npm dist-tag add "$name@$VERSION" latest');
  // The GitHub release, which marks the version complete, waits for latest.
  expect(jobs["github-release"]!.needs).toContain("promote");
  expect(jobs["github-release"]!.if).toContain("needs.promote.result == 'success'");
});

test("the registry smoke test checks the host's packages are all at the release's version", () => {
  expect(hostPackages("darwin", "arm64")).toEqual([
    "scriptc",
    "@scriptc/cli-darwin-arm64",
    "@scriptc/runtime-darwin-arm64",
    "@scriptc/llvm-darwin-arm64",
  ]);
  expect(hostPackages("win32", "x64")[1]).toBe("@scriptc/cli-win32-x64-msvc");
  expect(() => hostPackages("freebsd", "x64")).toThrow();
  // Every name it checks is one the release publishes.
  for (const [platform, arch] of [
    ["linux", "x64"],
    ["linux", "arm64"],
    ["darwin", "arm64"],
    ["darwin", "x64"],
    ["win32", "x64"],
  ] as const)
    for (const name of hostPackages(platform, arch))
      expect(publishedNames(repoRoot)).toContain(name);
  expect(
    versionMismatches({ scriptc: "0.4.16", "@scriptc/runtime-darwin-arm64": "0.4.15" }, "0.4.16"),
  ).toEqual(["@scriptc/runtime-darwin-arm64 is 0.4.15, expected 0.4.16"]);
  expect(versionMismatches({ "@scriptc/llvm-darwin-arm64": undefined }, "0.4.16")).toEqual([
    "@scriptc/llvm-darwin-arm64 is missing, expected 0.4.16",
  ]);
});

test("promoting a release never moves latest back to an older one", () => {
  expect(promoteAction("0.4.15", "0.4.16")).toBe("move");
  expect(promoteAction("0.4.16", "0.4.16")).toBe("current");
  // A retried promotion of 0.4.16 after 0.4.17 went out leaves 0.4.17.
  expect(promoteAction("0.4.17", "0.4.16")).toBe("newer");
  expect(promoteAction("0.10.0", "0.9.9")).toBe("newer");
  expect(promoteAction("1.0.0-rc.1", "1.0.0")).toBe("move");
  expect(promoteAction("1.0.0", "1.0.0-rc.1")).toBe("newer");
  expect(promoteAction("", "0.4.16")).toBe("move");
  expect(() => promoteAction("0.4.16", "next")).toThrow();
  const move = releaseWorkflow().jobs["promote"]!.steps.at(-1)!.run!;
  const decide = move.indexOf('node scripts/release-preflight.mjs --promote "$latest" "$VERSION"');
  expect(decide).toBeGreaterThan(-1);
  expect(move.indexOf('move) npm dist-tag add "$name@$VERSION" latest ;;')).toBeGreaterThan(decide);
  expect(move.match(/npm dist-tag add/g)).toHaveLength(1);
  // Promotions of different runs never interleave their check and their update.
  expect(releaseWorkflow().jobs["promote"]!.concurrency).toEqual({
    group: "release-promote",
    "cancel-in-progress": false,
  });
});

test("the Windows registry smoke test installs Zig, which scriptc links Windows executables with", () => {
  const smoke = releaseWorkflow().jobs["registry-smoke"]!;
  const zig = smoke.steps.findIndex((step) => step.uses === "./.github/actions/zig");
  expect(zig).toBeGreaterThan(-1);
  expect(smoke.steps[zig]!.if).toBe("runner.os == 'Windows'");
  expect(zig).toBeLessThan(smoke.steps.length - 1);
  expect(String(smoke.steps[0]!.with!["sparse-checkout"])).toContain(".github/actions/zig");
});
