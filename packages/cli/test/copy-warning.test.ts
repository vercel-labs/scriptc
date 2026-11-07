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
const launcher = join(repoRoot, "packages/cli/dist/bootstrap.js");
const tsxLoader = join(dirname(require.resolve("tsx/package.json")), "dist/loader.mjs");
const fixture = join(repoRoot, "tests/coverage-fixtures/width-copies.ts");

async function cli(
  args: string[],
  cacheRoot: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ["--import", tsxLoader, cliEntry, ...args],
      { env: { ...process.env, SCRIPTC_CACHE_DIR: cacheRoot }, maxBuffer: 4 * 1024 * 1024 },
    );
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

test("a build reports the conversions that copy, and --no-copy-warning leaves them out", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-copy-warning-"));
  try {
    await mkdir(join(dir, "cache"), { mode: 0o700 });
    const warned = await cli(["build", fixture, "-o", join(dir, "program")], join(dir, "cache"));
    expect(warned.code).toBe(0);
    expect(warned.stderr.match(/warning SC6001/g)?.length).toBe(3);
    expect(warned.stderr).toContain("3 warnings: the program compiled");

    await mkdir(join(dir, "quiet"), { mode: 0o700 });
    const quiet = await cli(
      ["build", fixture, "-o", join(dir, "quiet-program"), "--no-copy-warning"],
      join(dir, "quiet"),
    );
    expect(quiet.code).toBe(0);
    expect(quiet.stderr).toBe("");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 300_000);

test("coverage --fail-on=divergences fails on the warning, and --no-copy-warning cannot hide it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-copy-warning-fail-on-"));
  try {
    await mkdir(join(dir, "cache"), { mode: 0o700 });
    const coverage = (extra: string[]) => cli(["coverage", fixture, ...extra], join(dir, "cache"));

    const failing = await coverage(["--fail-on=divergences"]);
    expect(failing.code).toBe(1);
    expect(failing.stdout).toContain("SC6001");

    const silenced = await coverage(["--no-copy-warning"]);
    expect(silenced.code).toBe(0);
    expect(silenced.stdout).not.toContain("SC6001");

    const conflict = await coverage(["--fail-on=divergences", "--no-copy-warning"]);
    expect(conflict.code).toBe(1);
    expect(conflict.stderr).toContain(
      "--fail-on=divergences checks the warning --no-copy-warning leaves out",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 300_000);

test("a replayed coverage verdict refuses --fail-on=divergences with --no-copy-warning too", async () => {
  // The launcher answers an unchanged program's coverage from the verdict
  // cache without loading the compiler. Hiding SC6001 there and then
  // gating on divergences would pass a program the gate must fail.
  const dir = await mkdtemp(join(tmpdir(), "scriptc-copy-warning-replay-"));
  try {
    await mkdir(join(dir, "cache"), { mode: 0o700 });
    const coverage = async (extra: string[]) => {
      try {
        const { stdout, stderr } = await execFileAsync(
          process.execPath,
          [launcher, "coverage", fixture, ...extra],
          {
            env: { ...process.env, SCRIPTC_CACHE_DIR: join(dir, "cache") },
            maxBuffer: 4 * 1024 * 1024,
          },
        );
        return { code: 0, stdout, stderr };
      } catch (err) {
        const e = err as { code?: number; stdout?: string; stderr?: string };
        return { code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
      }
    };
    // The first run computes and stores the verdict; the rest replay it.
    expect((await coverage([])).code).toBe(0);
    const gated = await coverage(["--fail-on=divergences"]);
    expect(gated.code).toBe(1);
    expect(gated.stdout).toContain("SC6001");
    const silenced = await coverage(["--no-copy-warning"]);
    expect(silenced.code).toBe(0);
    expect(silenced.stdout).not.toContain("SC6001");
    const conflict = await coverage(["--fail-on=divergences", "--no-copy-warning"]);
    expect(conflict.code).toBe(1);
    expect(conflict.stderr).toContain(
      "--fail-on=divergences checks the warning --no-copy-warning leaves out",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 300_000);
