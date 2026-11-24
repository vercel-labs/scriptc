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
const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
  scripts: Record<string, string>;
};
const turbo = JSON.parse(readFileSync(new URL("../../turbo.json", import.meta.url), "utf8")) as {
  tasks: Record<string, { env?: string[]; inputs?: string[]; outputs?: string[]; tags?: string[] }>;
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
  expect(effects.map(([name]) => name)).toHaveLength(98);
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

test("the Vercel lanes are resharded to keep each task under the runner deadline", () => {
  const names = Object.keys(turbo.tasks);
  const count = (pattern: RegExp) => names.filter((name) => pattern.test(name)).length;
  expect(count(/^\/\/#ci:lane:test:plain:\d+$/)).toBe(60);
  expect(count(/^\/\/#ci:lane:test:san:\d+$/)).toBe(90);
  expect(count(/^\/\/#ci:lane:effects:(plain|san):\d+$/)).toBe(96);
  expect(count(/^\/\/#ci:lane:islands:\d+$/)).toBe(8);
  expect(count(/^\/\/#ci:lane:llvm-artifacts:/)).toBe(9);
  // The monolithic builds stay in the task graph for local runs but are no longer selected by Vercel CI.
  for (const name of names.filter((name) =>
    /^\/\/#ci:(lane:(bootstrap|native-profile|native-frontend-san:|three-nodes-san)|setup:seed:)/.test(
      name,
    ),
  ))
    expect(turbo.tasks[name]!.tags ?? [], name).not.toContain("ci");
});

test("every Vercel task has a package script that runs it", () => {
  for (const name of Object.keys(turbo.tasks).filter((name) => name.startsWith("//#"))) {
    const script = pkg.scripts[name.slice(3)];
    expect(script, name).toBeDefined();
    expect(script, name).toMatch(
      /^(node scripts\/ci-vercel\/run-lane\.mjs|node scripts\/ci-vercel\/toolchain\.mjs)/,
    );
  }
});

test("every runtime pack builds after the host LLVM helper", () => {
  // The pack's speed units and their profile are emitted through the host glibc helper. Without it the build falls
  // back to unoptimized bitcode and caches a pack that lacks the profiled speed flavor, so each pack task must be
  // ordered after the helper's output.
  for (const name of [
    "//#ci:setup:runtime-pack",
    "//#ci:setup:native:musl",
    "//#ci:setup:native:wasi",
  ])
    expect(turbo.tasks[name]!.dependsOn, name).toContain("ci:setup:llvm-helper");
});

test("the build setup clears its outputs before they run", () => {
  // A checkout can force-add an ignored output tree; without clearing it first, a build would cache the planted
  // files alongside what it generated, and a later clean run would restore and execute them.
  expect(runnerSource).toContain("clearOutputs(");
  expect(runnerSource).toContain('readdirSync(join(root, "packages")');
  expect((runnerSource.match(/clearOutputs\(/g) ?? []).length).toBeGreaterThanOrEqual(4);
  // The declared cache tree cannot carry a planted node_modules beside the build output.
  expect(turbo.tasks["//#ci:setup:build"]!.outputs).toContain("!packages/*/dist/node_modules/**");
});

test("the seed and build tasks hash every script", () => {
  // Imported staging helpers decide executable outputs; the task key names the whole scripts tree rather than a
  // hand list, so a newly imported helper invalidates the cached build or seed.
  for (const name of [
    "//#ci:setup:build",
    "//#ci:setup:llvm-helper",
    "//#ci:setup:runtime-pack",
    "//#ci:setup:native:musl",
    "//#ci:setup:native:wasi",
    "//#ci:setup:seed:plain",
    "//#ci:setup:seed:san",
  ])
    expect(turbo.tasks[name]!.inputs, name).toContain("scripts/**");
});

test("the checker identity lane is sharded and the toolchain reports its steps", () => {
  // The whole-corpus checker run took more than the runner's deadline on its own; two shards keep each task under
  // it. The toolchain prints a line per phase, so a slow archive shows which phase is slow.
  expect(
    Object.keys(turbo.tasks).filter((name) => name.startsWith("//#ci:lane:checker-identity:")),
  ).toHaveLength(4);
  expect(toolchainSource).toContain("XZ_OPT");
  expect(toolchainSource).toContain("checkpoint");
  expect(toolchainSource).toContain("[toolchain]");
});
