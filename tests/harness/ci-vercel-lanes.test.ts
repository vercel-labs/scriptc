import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const runner = fileURLToPath(new URL("../../scripts/ci-vercel/run-lane.mjs", import.meta.url));
const runnerSource = readFileSync(
  new URL("../../scripts/ci-vercel/run-lane.mjs", import.meta.url),
  "utf8",
);
const toolchainSource = readFileSync(
  new URL("../../scripts/ci-vercel/toolchain.mjs", import.meta.url),
  "utf8",
);
const turbo = JSON.parse(readFileSync(new URL("../../turbo.json", import.meta.url), "utf8")) as {
  tasks: Record<string, { env?: string[]; inputs?: string[]; outputs?: string[] }>;
};

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

test("the effect tasks hash the branch and pull request they sample for", () => {
  // These decide whether a task skips (pull request) or runs every shard (default branch), and which shard a pull
  // request samples. Turbo's strict mode strips them unless the task names them, and the hash then does not tell a
  // pull request's skip from a default-branch run.
  const effects = Object.entries(turbo.tasks).filter(([name]) =>
    name.startsWith("//#ci:lane:effects:"),
  );
  expect(effects.map(([name]) => name)).toHaveLength(34);
  for (const [name, task] of effects)
    expect(task.env, name).toEqual(
      expect.arrayContaining([
        "GITHUB_HEAD_REF",
        "VERCEL_GIT_COMMIT_REF",
        "VERCEL_GIT_PULL_REQUEST_ID",
      ]),
    );
});

test("the TS7 parity task hashes the fixtures whose baselines it checks", () => {
  const inputs = turbo.tasks["//#ci:lane:ts7-parity"]!.inputs!;
  for (const fixtures of [
    "tests/corpus/**",
    "tests/diagnostics/**",
    "tests/fixtures/**",
    "packages/compiler/test/ts7/**",
    "scripts/ts7-order-fixtures.mjs",
  ])
    expect(inputs, fixtures).toContain(fixtures);
});

test("the toolchain task rebuilds from the pinned archives instead of trusting a checkout's tree", () => {
  // A checkout can carry an ignored .ci/ path (a forced git add), so no marker or installed file may short-circuit
  // the install; only the task cache, filled by an install from these archives, skips it.
  expect(toolchainSource).not.toContain("already installed");
  expect(toolchainSource).not.toContain(".complete");
  expect(toolchainSource).toMatch(/rmSync\(toolchain/);
  expect(toolchainSource).toMatch(/rmSync\(downloads/);
  // The script is one of the task's inputs, so an install revision written into it invalidates older cached trees.
  expect(turbo.tasks["//#ci:setup:toolchain"]!.inputs).toContain("scripts/ci-vercel/toolchain.mjs");
});

test("the other setup outputs are rebuilt from empty directories", () => {
  expect(runnerSource).toContain("fresh(libnodeDirectory)");
  expect(runnerSource).toContain('fresh(join(root, ".ci/bootstrap-seed", flavor))');
});

test("the toolchain provides the static zlib and zstd the helper links", () => {
  // The image ships the runtime libraries, not the development ones, and the static LLVM helper links -lz and
  // -lzstd. The toolchain unpacks the pinned Ubuntu packages into a sysroot and run-lane points the compiler at it.
  expect(toolchainSource).toContain("zlib1g-dev");
  expect(toolchainSource).toContain("libzstd-dev");
  expect(toolchainSource).toContain("sysroot/lib/libz.a");
  expect(toolchainSource).toContain("sysroot/lib/libzstd.a");
  expect(runnerSource).toContain("LIBRARY_PATH");
  expect(runnerSource).toContain("CPATH");
});

test("the build and native setups clear their outputs before they run", () => {
  // A checkout can force-add an ignored output tree; without clearing it first, a build would cache the planted
  // files alongside what it generated, and a later clean run would restore and execute them.
  expect(runnerSource).toContain("clearOutputs(");
  expect(runnerSource).toContain('readdirSync(join(root, "packages")');
  expect((runnerSource.match(/clearOutputs\(/g) ?? []).length).toBeGreaterThanOrEqual(5);
  // The declared cache tree cannot carry a planted node_modules beside the build output.
  expect(turbo.tasks["//#ci:setup:build"]!.outputs).toContain("!packages/*/dist/node_modules/**");
});

test("the seed and build tasks hash every script", () => {
  // Imported staging helpers decide executable outputs; the task key names the whole scripts tree rather than a
  // hand list, so a newly imported helper invalidates the cached build or seed.
  for (const name of [
    "//#ci:setup:build",
    "//#ci:setup:native",
    "//#ci:setup:native:musl",
    "//#ci:setup:native:wasi",
    "//#ci:setup:seed:plain",
    "//#ci:setup:seed:san",
  ])
    expect(turbo.tasks[name]!.inputs, name).toContain("scripts/**");
});
