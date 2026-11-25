/* A native class that extends a class of a Node island, with optional and
 * defaulted parameters on its constructor, methods and accessors
 * (tests/fixtures/node-island/subclass-parameters). The members are the
 * dynamic functions the island's JavaScript class calls, so an omitted
 * argument completes with undefined and a default runs when it does. The
 * program prints under Node what it prints compiled. Needs a libnode pack
 * in SCRIPTC_LIBNODE (libnode.ts). */
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
  test("takes optional and defaulted parameters on its constructor and methods", async () => {
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
    expect(node.stdout.split("\n").length).toBeGreaterThan(8);
    expect(native.stdout).toBe(node.stdout);
    expect(native.stderr).toBe(node.stderr);
  }, 120_000);

  // Two uses the class cannot answer as Node does are refused by name
  // rather than built into a different answer.
  for (const [name, what] of [
    ["refused-result-slot", "a function whose result is an island value"],
    ["refused-method-length", "the 'length' of 'volume'"],
  ] as const) {
    test(`refuses ${name} by name`, async () => {
      const dir = join(outDir, name);
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });
      const binary = join(dir, "main");
      const entry = join(repoRoot, `tests/fixtures/node-island/subclass-parameters/${name}.ts`);
      const env = { ...process.env, SCRIPTC_CACHE_DIR: join(dir, "build-cache") };
      const build = await execFileAsync(process.execPath, [cli, "build", entry, "-o", binary], {
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
      expect(build.output).toContain("SC8010");
      expect(build.output).toContain(what);
      expect(existsSync(binary)).toBe(false);
    }, 120_000);
  }
});
