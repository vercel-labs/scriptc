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
const fixture = join(repoRoot, "tests/coverage-fixtures/key-order-untraced.ts");

type Result = { code: number; stdout: string; stderr: string };

async function run(argv: string[], cacheRoot: string): Promise<Result> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, argv, {
      env: { ...process.env, SCRIPTC_CACHE_DIR: cacheRoot },
      maxBuffer: 4 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

const cli = (args: string[], cacheRoot: string): Promise<Result> =>
  run(["--import", tsxLoader, cliEntry, ...args], cacheRoot);

test("a build reports the record types whose key order it does not follow, and --no-key-order-warning leaves them out", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-key-order-warning-"));
  try {
    await mkdir(join(dir, "cache"), { mode: 0o700 });
    const warned = await cli(["build", fixture, "-o", join(dir, "program")], join(dir, "cache"));
    expect(warned.code).toBe(0);
    expect(warned.stderr.match(/warning SC6014/g)?.length).toBe(2);
    expect(warned.stderr).toContain("2 warnings: the program compiled");

    await mkdir(join(dir, "quiet"), { mode: 0o700 });
    const quiet = await cli(
      ["build", fixture, "-o", join(dir, "quiet-program"), "--no-key-order-warning"],
      join(dir, "quiet"),
    );
    expect(quiet.code).toBe(0);
    expect(quiet.stderr).toBe("");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 300_000);

test("coverage --fail-on=divergences fails on the warning, and --no-key-order-warning cannot hide it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-key-order-warning-fail-on-"));
  try {
    await mkdir(join(dir, "cache"), { mode: 0o700 });
    const refused = "--fail-on=divergences checks the warning --no-key-order-warning leaves out";
    // The full CLI, then the launcher replaying the stored verdict: neither
    // may hide SC6014 and then gate on divergences.
    for (const start of [["--import", tsxLoader, cliEntry], [launcher]]) {
      const coverage = (extra: string[]) =>
        run([...start, "coverage", fixture, ...extra], join(dir, "cache"));

      const failing = await coverage(["--fail-on=divergences"]);
      expect(failing.code).toBe(1);
      expect(failing.stdout).toContain("SC6014");

      const silenced = await coverage(["--no-key-order-warning"]);
      expect(silenced.code).toBe(0);
      expect(silenced.stdout).not.toContain("SC6014");

      const conflict = await coverage(["--fail-on=divergences", "--no-key-order-warning"]);
      expect(conflict.code).toBe(1);
      expect(conflict.stderr).toContain(refused);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 300_000);
