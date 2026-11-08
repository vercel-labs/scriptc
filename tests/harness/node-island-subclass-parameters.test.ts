/* A native class that extends a class of a Node island, with optional and
 * defaulted parameters on its constructor, methods and accessors
 * (tests/fixtures/node-island/subclass-parameters). The members are the
 * dynamic functions the island's JavaScript class calls, but the class is
 * refused by name: a class that extends an island class does not answer its
 * `length` as Node does and its instances lose their class through a
 * union-typed value, and optional parameters must not let more programs
 * reach those answers. Needs a libnode pack in SCRIPTC_LIBNODE (libnode.ts). */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import { libnodePack } from "./libnode.js";

const execFileAsync = promisify(execFile);
const repoRoot = join(import.meta.dirname, "../..");
const cli = join(repoRoot, "packages/cli/dist/main.js");
const main = join(repoRoot, "tests/fixtures/node-island/subclass-parameters/main.ts");
const outDir = join(repoRoot, "node_modules/.cache/scriptc-tests/node-island-subclass-parameters");
const skip = libnodePack() === null;

describe.skipIf(skip)("a native class that extends an island class", () => {
  test("is refused by name when its members take optional or defaulted parameters", async () => {
    rmSync(outDir, { recursive: true, force: true });
    mkdirSync(outDir, { recursive: true });
    const binary = join(outDir, "main");
    const env = { ...process.env, SCRIPTC_CACHE_DIR: join(outDir, "build-cache") };
    const build = await execFileAsync(process.execPath, [cli, "build", main, "-o", binary], {
      env,
      encoding: "utf8",
    }).then(
      (done) => ({ code: 0, output: done.stdout + done.stderr }),
      (error: { code?: number; stdout?: string; stderr?: string }) => ({
        code: error.code ?? 1,
        output: `${error.stdout ?? ""}${error.stderr ?? ""}`,
      }),
    );
    expect(build.code).not.toBe(0);
    expect(build.output).toContain("SC1090");
    expect(build.output).toContain("functions with optional or defaulted parameters as values");
    expect(existsSync(binary)).toBe(false);
  }, 120_000);
});
