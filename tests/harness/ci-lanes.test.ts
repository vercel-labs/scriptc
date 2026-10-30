import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { load } from "js-yaml";
import { expect, test } from "vitest";
import { select } from "../../scripts/ci-lanes.mjs";
import { darwinCorpusFiles, darwinFiles } from "../../scripts/ci-test-plan.mjs";

type Job = {
  if?: string;
  "runs-on"?: string;
  strategy?: { matrix?: { include?: { runner?: string }[] } };
  steps: { id?: string; run?: string }[];
};
const workflow = load(
  readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8"),
) as { on: { workflow_dispatch: { inputs: Record<string, unknown> } }; jobs: Record<string, Job> };
const lanesScript = workflow.jobs["lanes"]!.steps.find((step) => step.id === "lanes")!.run!;

type Selection = { on: Record<string, boolean>; reasons: string[] };
const lanesOf = (files: string[], lines: { file: string; text: string }[] = []) =>
  (select(files, lines) as Selection).on;

test.each([
  [
    "a compiler change",
    ["packages/compiler/src/backend/emit.ts"],
    { linux: true, macos: false, effects: false, bootstrap: false },
  ],
  [
    "a runtime C change",
    ["packages/runtime/src/scr_array.c"],
    { linux: true, macos: false, effects: false, bootstrap: false },
  ],
  [
    "a corpus program",
    ["tests/corpus/1234-example.ts"],
    { linux: true, macos: false, effects: false, bootstrap: false },
  ],
  [
    "documentation only",
    ["docs/content/guide.mdx", "README.md"],
    { linux: false, macos: false, effects: false, bootstrap: false },
  ],
  [
    "a darwin package",
    ["packages/runtime-darwin-arm64/scripts/build.mjs"],
    { linux: true, macos: true, effects: false, bootstrap: false },
  ],
  [
    "the LLVM helper",
    ["native/llvm-codegen/src/emit.cpp"],
    { linux: true, macos: true, effects: false, bootstrap: false },
  ],
  [
    "a darwin test file",
    ["tests/harness/ffi-frameworks.test.ts"],
    { linux: true, macos: true, effects: false, bootstrap: false },
  ],
  [
    "the kqueue event loop",
    ["packages/runtime/src/scr_loop_kqueue.c"],
    { linux: true, macos: true, effects: false, bootstrap: false },
  ],
  [
    "the runtime's platform header",
    ["packages/runtime/src/scr_platform.h"],
    { linux: true, macos: true, effects: false, bootstrap: false },
  ],
  [
    "the Effect harness",
    ["tests/harness/effect.test.ts"],
    { linux: true, macos: false, effects: true, bootstrap: false },
  ],
  [
    "the bootstrap scripts",
    ["scripts/build-native-cli.mts"],
    { linux: true, macos: false, effects: false, bootstrap: true },
  ],
  [
    "CI configuration",
    [".github/workflows/ci.yml"],
    { linux: true, macos: true, effects: true, bootstrap: true },
  ],
  [
    "this script",
    ["scripts/ci-lanes.mjs"],
    { linux: true, macos: true, effects: true, bootstrap: true },
  ],
  [
    "the lockfile",
    ["pnpm-lock.yaml"],
    { linux: true, macos: true, effects: true, bootstrap: true },
  ],
  [
    "a package manifest",
    ["packages/compiler/package.json"],
    { linux: true, macos: true, effects: true, bootstrap: true },
  ],
  [
    "the shard partitioner",
    ["tests/harness/shard.ts"],
    { linux: true, macos: true, effects: true, bootstrap: true },
  ],
])("CI lanes for %s", (_name, files, expected) => {
  expect(lanesOf(files)).toEqual(expected);
});

test("a changed line that mentions a darwin-specific API runs the macOS lane", () => {
  const file = "packages/runtime/src/scr_event_loop.c";
  expect(lanesOf([file], [{ file, text: "#if defined(__APPLE__)" }]).macos).toBe(true);
  expect(lanesOf([file], [{ file, text: "  epoll_wait(fd, events, n, timeout);" }]).macos).toBe(
    false,
  );
  expect(lanesOf([file], [{ file, text: "  struct kevent change;" }]).macos).toBe(true);
});

test("every file of the darwin suite runs the macOS lane", () => {
  for (const file of [...darwinCorpusFiles, ...darwinFiles])
    expect(lanesOf([file]).macos, file).toBe(true);
});

test("CI runs the base commit's lane selection against the pull request's diff", () => {
  expect(lanesScript).toContain('git show "$BASE:scripts/ci-lanes.mjs"');
  expect(lanesScript).toContain(
    'node "$RUNNER_TEMP/ci-lanes.mjs" --base "$BASE" --head "$HEAD" --github-output',
  );
  // The nightly sweep and manual runs, and a base without the script, run every lane.
  expect(lanesScript.match(/every$/gm)).toHaveLength(2);
});

function runLanes(event: string) {
  const directory = mkdtempSync(join(tmpdir(), "ci-lanes-"));
  try {
    const output = join(directory, "output");
    writeFileSync(output, "");
    const result = spawnSync("bash", ["-e", "-o", "pipefail", "-c", lanesScript], {
      encoding: "utf8",
      env: { ...process.env, EVENT: event, GITHUB_OUTPUT: output },
    });
    expect(result.status, result.stderr).toBe(0);
    return readFileSync(output, "utf8");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("pushes to main run every lane except macos; the nightly sweep and manual runs run every lane", () => {
  expect(runLanes("push")).toBe("linux=true\nmacos=false\neffects=true\nbootstrap=true\n");
  for (const event of ["schedule", "workflow_dispatch"])
    expect(runLanes(event), event).toBe("linux=true\nmacos=true\neffects=true\nbootstrap=true\n");
  expect(workflow.on.workflow_dispatch.inputs["macos_suite"]).toEqual({
    description: "The test suite to run on macOS",
    type: "choice",
    options: ["full", "darwin"],
    default: "full",
  });
});

test("every job on a macOS runner is in the macos lane", () => {
  const macosJobs = Object.entries(workflow.jobs).filter(([, job]) =>
    [job["runs-on"], ...(job.strategy?.matrix?.include ?? []).map((entry) => entry.runner)].some(
      (runner) => runner?.startsWith("macos"),
    ),
  );
  expect(macosJobs.map(([name]) => name).sort()).toEqual([
    "llvm_artifacts_macos_arm64",
    "llvm_artifacts_macos_arm64_contracts",
    "llvm_artifacts_macos_x64",
    "mobile_runtime_packs_ios",
    "native_macos",
    "tests_macos",
  ]);
  for (const [name, job] of macosJobs)
    expect(job.if, name).toContain("needs.lanes.outputs.macos == 'true'");
});
