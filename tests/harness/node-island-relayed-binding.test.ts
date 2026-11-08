/* A native module that imports a binding from a Node island package and
 * exports it again (`import { a } from "pkg"; export { a };`, renamed, as
 * the default export, and onward through a star export and a second hop)
 * hands its importers the island's own export
 * (tests/fixtures/node-island/relayed-binding). The program prints under
 * Node what it prints compiled. Needs a libnode pack in SCRIPTC_LIBNODE
 * (libnode.ts). */
import { execFile } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import { libnodePack } from "./libnode.js";

const execFileAsync = promisify(execFile);
const repoRoot = join(import.meta.dirname, "../..");
const cli = join(repoRoot, "packages/cli/dist/main.js");
const main = join(repoRoot, "tests/fixtures/node-island/relayed-binding/main.ts");
const outDir = join(repoRoot, "node_modules/.cache/scriptc-tests/node-island-relayed-binding");
const skip = libnodePack() === null;

describe.skipIf(skip)("a binding a native module imports from an island and exports again", () => {
  test("binds the island's own export in the importers", async () => {
    rmSync(outDir, { recursive: true, force: true });
    mkdirSync(outDir, { recursive: true });
    const binary = join(outDir, "main");
    const env = { ...process.env, SCRIPTC_CACHE_DIR: join(outDir, "build-cache") };
    await execFileAsync(process.execPath, [cli, "build", main, "-o", binary], {
      env,
      encoding: "utf8",
    });
    const node = await execFileAsync(process.execPath, [main], { encoding: "utf8" });
    const native = await execFileAsync(binary, [], {
      env: { ...process.env, XDG_CACHE_HOME: join(outDir, "cache") },
      encoding: "utf8",
    });
    expect(node.stdout.split("\n").length).toBeGreaterThan(5);
    expect(native.stdout).toBe(node.stdout);
    expect(native.stderr).toBe(node.stderr);
  }, 120_000);
});
