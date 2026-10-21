/* A workspace-linked package compiled from its TypeScript source (its bare
 * import answered by a .ts file outside node_modules) is program source as
 * a whole: the JavaScript modules its sources reach relatively lower like
 * the TypeScript ones, instead of staying out of the program as unselected
 * package JS, where every reference to one of their bindings is fenced
 * (SC1090 "a binding form with no lowering") and throws when it runs. */
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { analyze, compile } from "@scriptc/compiler";

const execFileAsync = promisify(execFile);
const sanitize = process.env["SCRIPTC_SAN"] === "1";

test("a linked package's JavaScript modules compile beside its TypeScript entry", async () => {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-workspace-source-js-"));
  try {
    const source = join(dir, "source");
    mkdirSync(source);
    writeFileSync(
      join(source, "package.json"),
      JSON.stringify({ name: "pkg", type: "module", exports: { ".": "./index.ts" } }),
    );
    writeFileSync(join(source, "index.ts"), 'export * from "./impl.js";\n');
    writeFileSync(
      join(source, "helper.js"),
      "/** @param {number} n */\nexport const double = (n) => n * 2;\n",
    );
    writeFileSync(
      join(source, "impl.js"),
      'import { double } from "./helper.js";\n' +
        "/** @param {(n: number) => number} f */\nconst through = (f) => (/** @type {number} */ n) => f(n) + 1;\n" +
        "export const value = through(double)(20);\n",
    );
    const app = join(dir, "app");
    mkdirSync(join(app, "node_modules"), { recursive: true });
    writeFileSync(join(app, "package.json"), '{"type":"module"}\n');
    symlinkSync(
      source,
      join(app, "node_modules/pkg"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const entry = join(app, "main.ts");
    writeFileSync(entry, 'import { value } from "pkg";\nconsole.log(`value ${value}`);\n');
    const { coverage } = analyze(entry, {});
    expect(coverage.preflightFailed).toBe(false);
    expect(coverage.diagnostics).toEqual([]);
    expect(coverage.stats.statementsFailed).toBe(0);
    const outDir = join(dir, "out");
    const built = await compile(entry, { outDir, outPath: join(outDir, "program"), sanitize });
    expect(built.ok, !built.ok ? JSON.stringify(built.diagnostics) : "").toBe(true);
    if (!built.ok) return;
    const native = await execFileAsync(built.binaryPath);
    expect(native.stdout).toBe("value 41\n");
    expect(native.stderr).toBe("");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
