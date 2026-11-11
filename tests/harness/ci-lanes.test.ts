import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { load } from "js-yaml";
import { expect, test } from "vitest";
import { effectShardCount, effectShardList, select } from "../../scripts/ci-lanes.mjs";
import { darwinCorpusFiles, darwinFiles } from "../../scripts/ci-test-plan.mjs";

type Job = {
  if?: string;
  "runs-on"?: string;
  outputs?: Record<string, string>;
  env?: Record<string, string>;
  strategy?: { matrix?: { shard?: unknown; include?: { runner?: string }[] } };
  steps: { id?: string; run?: string; env?: Record<string, string> }[];
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
    { linux: true, macos: false, effects: true, bootstrap: false, profile: true, islands: false },
  ],
  [
    "a compiler test",
    ["packages/compiler/test/emit.test.ts"],
    { linux: true, macos: false, effects: false, bootstrap: false, profile: false, islands: false },
  ],
  [
    "a refreshed profile",
    ["packages/compiler/native/cli.profdata.gz"],
    { linux: true, macos: false, effects: false, bootstrap: false, profile: true, islands: false },
  ],
  [
    "a raised self-compile budget",
    ["scripts/self-compile-budget.json"],
    { linux: true, macos: false, effects: false, bootstrap: false, profile: true, islands: false },
  ],
  [
    "the probe that measures the self-compile's heap",
    ["scripts/self-compile-heap-probe.mjs"],
    { linux: true, macos: false, effects: false, bootstrap: false, profile: true, islands: false },
  ],
  [
    "a runtime C change",
    ["packages/runtime/src/scr_array.c"],
    { linux: true, macos: false, effects: true, bootstrap: false, profile: false, islands: false },
  ],
  [
    "a corpus program",
    ["tests/corpus/1234-example.ts"],
    { linux: true, macos: false, effects: false, bootstrap: false, profile: false, islands: false },
  ],
  [
    "documentation only",
    ["docs/content/guide.mdx", "README.md"],
    {
      linux: false,
      macos: false,
      effects: false,
      bootstrap: false,
      profile: false,
      islands: false,
    },
  ],
  [
    "a darwin package",
    ["packages/runtime-darwin-arm64/scripts/build.mjs"],
    { linux: true, macos: true, effects: false, bootstrap: false, profile: false, islands: false },
  ],
  [
    "the LLVM helper",
    ["native/llvm-codegen/src/emit.cpp"],
    { linux: true, macos: true, effects: true, bootstrap: false, profile: true, islands: false },
  ],
  [
    "a darwin test file",
    ["tests/harness/ffi-frameworks.test.ts"],
    { linux: true, macos: true, effects: false, bootstrap: false, profile: false, islands: false },
  ],
  [
    "the kqueue event loop",
    ["packages/runtime/src/scr_loop_kqueue.c"],
    { linux: true, macos: true, effects: true, bootstrap: false, profile: false, islands: false },
  ],
  [
    "the runtime's platform header",
    ["packages/runtime/src/scr_platform.h"],
    { linux: true, macos: true, effects: true, bootstrap: false, profile: false, islands: false },
  ],
  [
    "the Effect harness",
    ["tests/harness/effect.test.ts"],
    { linux: true, macos: false, effects: true, bootstrap: false, profile: false, islands: false },
  ],
  [
    "the bootstrap scripts",
    ["scripts/build-native-cli.mts"],
    { linux: true, macos: false, effects: false, bootstrap: true, profile: true, islands: false },
  ],
  [
    "the island decision",
    ["packages/compiler/src/node-islands/policy.ts"],
    { linux: true, macos: false, effects: true, bootstrap: false, profile: true, islands: true },
  ],
  [
    "the island boundary lowering",
    ["packages/compiler/src/frontend/lowering/lower-node-island.ts"],
    { linux: true, macos: false, effects: true, bootstrap: false, profile: true, islands: true },
  ],
  [
    "an island runtime unit",
    ["packages/runtime/src/scr_node_island_handle.c"],
    { linux: true, macos: false, effects: true, bootstrap: false, profile: false, islands: true },
  ],
  [
    "the island host script",
    ["packages/runtime/src/scr_node_island_host.cjs"],
    { linux: true, macos: false, effects: true, bootstrap: false, profile: false, islands: true },
  ],
  [
    "the libnode bridge",
    ["packages/libnode-common/bridge/scr_node_bridge.cc"],
    { linux: true, macos: false, effects: false, bootstrap: false, profile: false, islands: true },
  ],
  [
    "the island conformance list",
    ["tests/harness/island-conformance/known-failures.json"],
    { linux: true, macos: false, effects: false, bootstrap: false, profile: false, islands: true },
  ],
  [
    "an npm suite package",
    ["tests/fixtures/npm/node_modules/zod/index.js"],
    { linux: true, macos: false, effects: false, bootstrap: false, profile: false, islands: true },
  ],
  [
    "CI configuration",
    [".github/workflows/ci.yml"],
    { linux: true, macos: true, effects: true, bootstrap: true, profile: true, islands: true },
  ],
  [
    "this script",
    ["scripts/ci-lanes.mjs"],
    { linux: true, macos: true, effects: true, bootstrap: true, profile: true, islands: true },
  ],
  [
    "the lockfile",
    ["pnpm-lock.yaml"],
    { linux: true, macos: true, effects: true, bootstrap: true, profile: true, islands: true },
  ],
  [
    "a package manifest",
    ["packages/compiler/package.json"],
    { linux: true, macos: true, effects: true, bootstrap: true, profile: true, islands: true },
  ],
  [
    "the shard partitioner",
    ["tests/harness/shard.ts"],
    { linux: true, macos: true, effects: true, bootstrap: true, profile: true, islands: true },
  ],
])("CI lanes for %s", (_name, files, expected) => {
  expect(lanesOf(files)).toEqual(expected);
});

test("compiler and runtime changes sample one Effect shard; the Effect harness runs all sixteen", () => {
  const shards = (files: string[]) =>
    (select(files, []) as Selection & { effectShards: string }).effectShards;
  const every = Array.from({ length: effectShardCount }, (_, index) => index + 1);
  for (const file of [
    "packages/compiler/src/backend/emit.ts",
    "packages/runtime/src/scr_array.c",
    "native/llvm-codegen/src/emit.cpp",
  ]) {
    expect(lanesOf([file]).effects, file).toBe(true);
    expect(shards([file]), file).toBe("sample");
  }
  // The harness, its fixtures, or anything that runs every lane, with or
  // without a compiler change beside it.
  for (const file of [
    "tests/harness/effect4.test.ts",
    "tests/fixtures/effect/main.ts",
    ".github/workflows/ci.yml",
  ])
    for (const files of [[file], [file, "packages/compiler/src/backend/emit.ts"]]) {
      expect(lanesOf(files).effects, files.join()).toBe(true);
      expect(shards(files), files.join()).toBe("all");
    }
  // Compiler tests and corpus programs leave the lane off.
  for (const file of ["packages/compiler/test/emit.test.ts", "tests/corpus/1234-example.ts"])
    expect(lanesOf([file]).effects, file).toBe(false);
  expect(JSON.parse(effectShardList("all", "7"))).toEqual(every);
  // A pull request keeps one shard from push to push, and the numbers of
  // sixteen consecutive pull requests cover every shard.
  expect(JSON.parse(effectShardList("sample", "3104"))).toEqual([(3104 % effectShardCount) + 1]);
  expect(
    Array.from({ length: effectShardCount }, (_, index) =>
      JSON.parse(effectShardList("sample", String(3100 + index))),
    )
      .flat()
      .toSorted((a, b) => a - b),
  ).toEqual(every);
  for (const pr of [undefined, "", "x", "0", "-4"])
    expect(JSON.parse(effectShardList("sample", pr)), String(pr)).toEqual([1]);
});

test("the Effect job runs the shards the lane selection names", () => {
  const every = Array.from({ length: effectShardCount }, (_, index) => index + 1);
  const lanes = workflow.jobs["lanes"]!;
  const effects = workflow.jobs["effects"]!;
  // Pushes, the nightly sweep, manual runs and a base selector that predates
  // the sample name no shards: the job then runs all of them.
  const output = /^\$\{\{ steps\.lanes\.outputs\.effect_shards \|\| '(.*)' \}\}$/.exec(
    lanes.outputs!["effect_shards"]!,
  );
  expect(JSON.parse(output![1]!)).toEqual(every);
  expect(effects.strategy!.matrix!.shard).toBe(
    "${{ fromJSON(needs.lanes.outputs.effect_shards) }}",
  );
  expect(effects.env!["SCRIPTC_TEST_SHARD"]).toBe(`\${{ matrix.shard }}/${effectShardCount}`);
  expect(lanes.steps.find((step) => step.id === "lanes")!.env!["PR"]).toBe(
    "${{ github.event.pull_request.number }}",
  );
  expect(lanesScript).toContain('--pr "$PR" --github-output');
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

test("a script only a macOS job runs turns the macOS lane on", () => {
  // The packed installation check with the opt-in libnode pack runs in the
  // macOS contracts job and nowhere else.
  const contracts = workflow.jobs["llvm_artifacts_macos_arm64_contracts"]!;
  const script = "scripts/smoke-libnode-opt-in.mjs";
  expect(contracts.steps.some((step) => step.run?.includes(`node ${script}`))).toBe(true);
  expect(
    Object.entries(workflow.jobs)
      .filter(([, job]) => job.steps?.some((step) => step.run?.includes(script)))
      .map(([name]) => name),
  ).toEqual(["llvm_artifacts_macos_arm64_contracts"]);
  expect(lanesOf([script]).macos).toBe(true);
});

test("CI runs the base commit's lane selection against the pull request's diff", () => {
  expect(lanesScript).toContain('git show "$BASE:scripts/ci-lanes.mjs"');
  expect(lanesScript).toContain(
    'node "$RUNNER_TEMP/ci-lanes.mjs" --base "$BASE" --head "$HEAD" --pr "$PR" --github-output',
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

test("pushes to main and merge queue groups run every lane except macos; the nightly sweep and manual runs run every lane", () => {
  for (const event of ["push", "merge_group"])
    expect(runLanes(event), event).toBe(
      "linux=true\nmacos=false\neffects=true\nbootstrap=true\nprofile=true\nislands=true\n",
    );
  // The workflow starts on a merge queue group, which is what would become main.
  expect("merge_group" in workflow.on).toBe(true);
  for (const event of ["schedule", "workflow_dispatch"])
    expect(runLanes(event), event).toBe(
      "linux=true\nmacos=true\neffects=true\nbootstrap=true\nprofile=true\nislands=true\n",
    );
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
