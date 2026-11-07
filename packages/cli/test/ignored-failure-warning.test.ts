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
const fixture = join(repoRoot, "tests/coverage-fixtures/swallowed-conversions.ts");

async function run(
  command: string[],
  cacheRoot: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, command, {
      env: { ...process.env, SCRIPTC_CACHE_DIR: cacheRoot },
      maxBuffer: 4 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}
const cli = (args: string[], cacheRoot: string) =>
  run(["--import", tsxLoader, cliEntry, ...args], cacheRoot);

test("a build warns at conversions whose failure a handler ignores, and --no-ignored-failure-warning leaves them out", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-ignored-failure-"));
  try {
    await mkdir(join(dir, "cache"), { mode: 0o700 });
    const warned = await cli(["build", fixture, "-o", join(dir, "program")], join(dir, "cache"));
    expect(warned.code).toBe(0);
    expect(warned.stderr.match(/warning SC6009/g)?.length).toBe(4);
    expect(warned.stderr).toContain("4 warnings: the program compiled");
    // Each warning shows the conversion and names the handler.
    expect(warned.stderr).toContain("return JSON.parse(text) as Entry;");
    expect(warned.stderr).toContain("is caught by the handler of the 'try' at");
    expect(warned.stderr).toContain("is discarded by the 'finally' of the 'try' at");
    expect(warned.stderr).toContain("rejects a promise whose handler at");

    await mkdir(join(dir, "quiet"), { mode: 0o700 });
    const quiet = await cli(
      ["build", fixture, "-o", join(dir, "quiet-program"), "--no-ignored-failure-warning"],
      join(dir, "quiet"),
    );
    expect(quiet.code).toBe(0);
    expect(quiet.stderr).toBe("");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 300_000);

test("coverage --fail-on=divergences fails on the warning, and --no-ignored-failure-warning cannot hide it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-ignored-failure-fail-on-"));
  try {
    await mkdir(join(dir, "cache"), { mode: 0o700 });
    for (const coverage of [
      (extra: string[]) => cli(["coverage", fixture, ...extra], join(dir, "cache")),
      // The launcher answers an unchanged program's coverage from the
      // verdict cache without loading the compiler: the same answers.
      (extra: string[]) => run([launcher, "coverage", fixture, ...extra], join(dir, "cache")),
    ]) {
      const failing = await coverage(["--fail-on=divergences"]);
      expect(failing.code).toBe(1);
      expect(failing.stdout).toContain("SC6009");

      const silenced = await coverage(["--no-ignored-failure-warning"]);
      expect(silenced.code).toBe(0);
      expect(silenced.stdout).not.toContain("differs from Node");

      const conflict = await coverage(["--fail-on=divergences", "--no-ignored-failure-warning"]);
      expect(conflict.code).toBe(1);
      expect(conflict.stderr).toContain(
        "--fail-on=divergences checks the warning --no-ignored-failure-warning leaves out",
      );
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 300_000);
