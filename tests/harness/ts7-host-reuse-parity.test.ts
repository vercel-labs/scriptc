/* Program host reuse (FrontendServices.reuseProgramHosts) must not change
 * a compile: a build whose loads share program hosts emits the same IR,
 * the same diagnostics and the same exit status as a build with a new host
 * for every load (SCRIPTC_TS7_HOST_LOADS=1). Share 2 replaces each host after
 * two loads, so a fixpoint of several loads exercises both a rebind and a
 * replacement. The npm cases are the frontend's multi-load builds: each
 * imports packages, so its build loads the program at least twice. */
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeEach, describe, expect, test } from "vitest";
import { npmCases } from "./npm-cases.js";
import { skipUnownedTest } from "./shard.js";

const execFileAsync = promisify(execFile);
const repoRoot = join(import.meta.dirname, "../..");
const cli = join(repoRoot, "packages/cli/dist/bootstrap.js");
const out = mkdtempSync(join(tmpdir(), "scriptc-host-reuse-"));
afterAll(() => rmSync(out, { recursive: true, force: true }));

interface Build {
  ir: string | null;
  stderr: string;
  status: number;
}

async function build(entry: string, name: string, loads: string): Promise<Build> {
  const ir = join(out, `${name}.${loads}.ir.json`);
  const env = {
    ...process.env,
    SCRIPTC_TS7_HOST_LOADS: loads,
    SCRIPTC_CACHE_DIR: join(out, `cache-${loads}`),
  };
  try {
    const { stderr } = await execFileAsync(
      process.execPath,
      ["--max-old-space-size=8192", cli, "build", entry, "--emit=ir", "-o", ir],
      { env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
    return { ir: readFileSync(ir, "utf8"), stderr, status: 0 };
  } catch (error) {
    const e = error as { code?: unknown; stderr?: string };
    if (typeof e.code !== "number") throw error;
    return { ir: null, stderr: e.stderr ?? "", status: e.code };
  }
}

// Every sixth case by name (all of them with SCRIPTC_HOST_REUSE_PARITY_ALL=1).
const all = process.env["SCRIPTC_HOST_REUSE_PARITY_ALL"] === "1";
const cases = npmCases(join(repoRoot, "tests/fixtures"))
  .sort((a, b) => a.name.localeCompare(b.name))
  .filter((_, index) => all || index % 6 === 0);

describe("program host reuse parity", () => {
  beforeEach((context) => skipUnownedTest(context, {}));
  for (const { name, entry } of cases) {
    test(
      name,
      async () => {
        const fresh = await build(entry, name, "1");
        const reused = await build(entry, name, "2");
        expect(reused.status).toBe(fresh.status);
        expect(reused.stderr).toBe(fresh.stderr);
        expect(reused.ir === fresh.ir).toBe(true);
      },
      600_000,
    );
  }
});
