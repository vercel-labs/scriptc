/* Program modules that run in a Node island (compiler node-islands/
 * snapshot.ts): when the build may evaluate one to defer its load, and when
 * Node starts in a program that imports them. The programs are corpus
 * programs (their output is compared with Node's there); this file reads
 * the build's deferral trace and the run's boot trace. Needs a libnode pack
 * in SCRIPTC_LIBNODE (libnode.ts). */
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, test } from "vitest";
import { libnodePack } from "./libnode.js";

const execFileAsync = promisify(execFile);
const repoRoot = join(import.meta.dirname, "../..");
const cli = join(repoRoot, "packages/cli/dist/main.js");
const corpus = join(repoRoot, "tests/corpus");
const outDir = join(repoRoot, "node_modules/.cache/scriptc-tests/node-island-program-modules");
// The executable unpacks its island modules under the user's cache
// directory, and these are TypeScript: Node strips types from no file under
// a node_modules directory, so the cache is outside the repository's.
const cacheDir = mkdtempSync(join(tmpdir(), "scriptc-program-modules-"));
afterAll(() => rmSync(cacheDir, { recursive: true, force: true }));
const skip = libnodePack() === null;

const islandLines = (text: string): string[] =>
  text.split("\n").filter((l) => l.startsWith("[node-islands] "));

/** Builds a corpus program with the deferral trace on; answers the binary
 * and the build's decisions. */
async function build(name: string): Promise<{ binary: string; trace: string[] }> {
  const dir = join(outDir, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const binary = join(dir, "main");
  const env = {
    ...process.env,
    SCRIPTC_NODE_ISLANDS_TRACE: "defer",
    SCRIPTC_CACHE_DIR: join(dir, "build-cache"),
  };
  const { stderr } = await execFileAsync(
    process.execPath,
    [cli, "build", join(corpus, name, "main.ts"), "-o", binary],
    { env, encoding: "utf8" },
  );
  return { binary, trace: islandLines(stderr) };
}

/** Runs `binary` with the boot trace on; answers its stdout and boot trace. */
async function run(binary: string): Promise<{ stdout: string; boot: string[] }> {
  const env = {
    ...process.env,
    XDG_CACHE_HOME: cacheDir,
    SCRIPTC_NODE_ISLANDS_TRACE: "boot",
  };
  const { stdout, stderr } = await execFileAsync(binary, [], { env, encoding: "utf8" });
  return { stdout, boot: islandLines(stderr) };
}

describe.skipIf(skip)("program modules that run in a Node island", () => {
  test("defer when their top level only declares, and Node never starts unused", async () => {
    const { binary, trace } = await build("8717-node-island-program-module-deferred");
    for (const module of ["patch.ts", "read.ts"]) {
      const decision = trace.find((l) => l.includes(`/${module}:`));
      expect(decision).toMatch(/^\[node-islands\] defer .*guarded by the loads before it/);
    }
    const { stdout, boot } = await run(binary);
    expect(stdout).toBe("start function function installPatch\nlibnode mapped: false\n");
    expect(boot.filter((l) => l.includes("] deferred "))).toHaveLength(2);
    expect(boot.some((l) => l.includes("starting Node"))).toBe(false);
  }, 300_000);

  test("wait at every import when two modules of the program import one", async () => {
    const { binary, trace } = await build("9355-node-island-program-module-two-importers");
    const decisions = trace.filter((l) => l.includes("/patch.ts:"));
    expect(decisions).toHaveLength(2);
    for (const decision of decisions)
      expect(decision).toMatch(/^\[node-islands\] defer .*guarded by the loads before it/);
    const { stdout, boot } = await run(binary);
    expect(stdout).toBe("start function function installPatch\nlibnode mapped: false\n");
    // The second import registers the load the first one did: its guard is
    // the first one's, and nothing has been loaded in between.
    expect(boot.filter((l) => l.includes("] deferred ./patch.ts"))).toHaveLength(2);
    expect(boot.some((l) => l.includes("boot guard failed"))).toBe(false);
    expect(boot.some((l) => l.includes("starting Node"))).toBe(false);
  }, 300_000);

  test("stay where they are imported when their top level has effects", async () => {
    const { binary, trace } = await build("8722-node-island-program-module-effectful");
    expect(trace.find((l) => l.includes("/read.ts:"))).toMatch(
      /^\[node-islands\] eager .*a module of the program, and its top level is not provably free of effects: a top-level expression with possible effects at line 5/,
    );
    expect(trace.find((l) => l.includes("/patch.ts:"))).toMatch(/^\[node-islands\] defer /);
    const { stdout } = await run(binary);
    expect(stdout).toBe("read.ts: evaluating\nmain body\nreader: patched payload\n");
  }, 300_000);
});
