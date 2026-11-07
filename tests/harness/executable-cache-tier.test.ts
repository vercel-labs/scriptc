/* A build under another tier policy is not answered from the cache.
 *
 * `--tier=static-only` makes every construct without a static lowering a
 * compile error; the default `auto` compiles such a construct in the
 * dynamic tier. The same file is therefore a program under one and an error
 * under the other, and the executable cache once had no tier in its key: a
 * `static-only` build of a program whose `auto` build was cached printed
 * the cached executable's path and exited 0. */
import { execFile } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const repoRoot = join(import.meta.dirname, "../..");
const cli = join(repoRoot, "packages/cli/dist/main.js");
const windows = process.platform === "win32";

let directory = "";

beforeAll(() => {
  directory = mkdtempSync(join(windows ? tmpdir() : "/tmp", "scriptc-cache-tier-"));
  // A program `auto` compiles and `static-only` refuses (SC2003).
  cpSync(join(repoRoot, "tests/diagnostics/union-spread-merge.ts"), join(directory, "main.ts"));
});

afterAll(() => {
  if (directory !== "") rmSync(directory, { recursive: true, force: true });
});

/** Runs the CLI in the scratch project; its exit code and output. */
async function scriptc(
  ...args: string[]
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [cli, ...args], {
      cwd: directory,
      env: { ...process.env, SCRIPTC_CACHE_DIR: join(directory, "cache") },
      maxBuffer: 1 << 24,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? -1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

describe.skipIf(windows)("the tier policy and the executable cache", () => {
  test(
    "a static-only build is refused whether or not the default build is cached",
    { timeout: 600_000 },
    async () => {
      const output = join(directory, "app");
      const refused = await scriptc("build", "main.ts", "-o", "app", "--tier=static-only");
      expect(refused.code).toBe(1);
      expect(refused.stderr).toContain("SC2003");
      // The default tier compiles it, twice: the second build is a cache hit.
      for (const _round of [0, 1]) {
        const built = await scriptc("build", "main.ts", "-o", "app");
        expect(built.code, built.stderr).toBe(0);
        expect(built.stdout.trim()).toBe(output);
      }
      expect(existsSync(output)).toBe(true);
      // The cached default build must not answer for the other policy.
      const again = await scriptc("build", "main.ts", "-o", "app", "--tier=static-only");
      expect(again.code, again.stdout).toBe(1);
      expect(again.stderr).toContain("SC2003");
      const run = await scriptc("run", "main.ts", "-o", "app", "--tier=static-only");
      expect(run.code, run.stdout).toBe(1);
      expect(run.stderr).toContain("SC2003");
      // Naming the default policy is the default build.
      const auto = await scriptc("build", "main.ts", "-o", "app", "--tier=auto");
      expect(auto.code, auto.stderr).toBe(0);
    },
  );
});
