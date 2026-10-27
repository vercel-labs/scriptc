import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const repoRoot = join(import.meta.dirname, "../../..");
const cliEntry = join(repoRoot, "packages/cli/src/main.ts");
const tsxLoader = join(dirname(require.resolve("tsx/package.json")), "dist/loader.mjs");
const fixtures = join(repoRoot, "tests/coverage-fixtures/dynamic-tier");

const HEADER =
  "warning SC6101: 3 functions that likely run often use untyped values, which runs slower than typed code:";
const CLOSING =
  "The program compiled. Adding types to these functions lets scriptc compile them to faster code.";

async function cli(
  args: string[],
  cacheRoot: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ["--import", tsxLoader, cliEntry, ...args],
      {
        env: { ...process.env, SCRIPTC_CACHE_DIR: cacheRoot, SCRIPTC_TIMING: "1" },
        maxBuffer: 4 * 1024 * 1024,
      },
    );
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

test("a build names its likely-hot untyped functions, also when it comes from the cache", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-dynamic-tier-warning-"));
  const cacheRoot = join(dir, "cache");
  const outPath = join(dir, process.platform === "win32" ? "program.exe" : "program");
  try {
    await mkdir(cacheRoot, { mode: 0o700 });
    const build = (extra: string[] = []) =>
      cli(["build", join(fixtures, "hot.js"), "-o", outPath, ...extra], cacheRoot);

    const first = await build();
    expect(first.code).toBe(0);
    expect(first.stderr).toContain("scriptc lowering");
    expect(first.stderr).toContain(
      [
        HEADER,
        "  centroid (hot.js:7): untyped JavaScript file, in a loop",
        "  spread (hot.js:23): untyped JavaScript file, in a loop",
        "  distance (hot.js:17): untyped JavaScript file, called in a loop",
        "  hint: add types to compile these statically; see scriptc coverage --explain-dynamic",
        "",
        CLOSING,
      ].join("\n"),
    );

    // The cache hit skips lowering and repeats the warning.
    const cached = await build();
    expect(cached.code).toBe(0);
    expect(cached.stderr).not.toContain("scriptc lowering");
    expect(cached.stderr).toContain(HEADER);
    expect(cached.stderr).toContain(CLOSING);

    const silenced = await build(["--no-dynamic-tier-warning"]);
    expect(silenced.code).toBe(0);
    expect(silenced.stderr).not.toContain("SC6101");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 300_000);

test("untyped setup code builds without the warning", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-dynamic-tier-quiet-"));
  try {
    await mkdir(join(dir, "cache"), { mode: 0o700 });
    const result = await cli(
      ["build", join(fixtures, "quiet.ts"), "-o", join(dir, "program")],
      join(dir, "cache"),
    );
    expect(result.code).toBe(0);
    expect(result.stderr).not.toContain("SC6101");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 300_000);

test("coverage --fail-on=dynamic fails on the warning, and --no-dynamic-tier-warning cannot hide it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-dynamic-tier-fail-on-"));
  try {
    await mkdir(join(dir, "cache"), { mode: 0o700 });
    const coverage = (file: string, extra: string[]) =>
      cli(["coverage", join(fixtures, file), ...extra], join(dir, "cache"));

    const hot = await coverage("hot.js", ["--fail-on=dynamic"]);
    expect(hot.code).toBe(1);
    expect(hot.stdout).toContain("untyped and likely hot");
    expect((await coverage("hot.js", ["--fail-on=divergences"])).code).toBe(0);
    expect((await coverage("quiet.ts", ["--fail-on=dynamic"])).code).toBe(0);

    const silenced = await coverage("hot.js", ["--no-dynamic-tier-warning"]);
    expect(silenced.code).toBe(0);
    expect(silenced.stdout).not.toContain("untyped and likely hot");

    const conflict = await coverage("hot.js", ["--fail-on=dynamic", "--no-dynamic-tier-warning"]);
    expect(conflict.code).toBe(1);
    expect(conflict.stderr).toContain(
      "--fail-on=dynamic checks the warning --no-dynamic-tier-warning leaves out",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 300_000);
