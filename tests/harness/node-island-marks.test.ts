/* `--node-island=<path>` marks a module of the program to run in a Node
 * island, and `--node-island=<package>` a package. A mark is honored or
 * refused by name, never accepted and ignored: a marked JavaScript or
 * TypeScript module runs in Node, and a mark that names the entry module, no
 * module of the program, or a package the program does not load from
 * node_modules stops the build with SC8006. */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { compile } from "@scriptc/compiler";
import { libnodePack } from "./libnode.js";

const sanitize = process.env["SCRIPTC_SAN"] === "1";
const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

/** A program whose helper module builds a function from a string: native
 * code refuses that, Node runs it. */
function program(helper: string): string {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-island-marks-"));
  scratch.push(dir);
  writeFileSync(join(dir, "package.json"), '{ "type": "module" }\n');
  writeFileSync(
    join(dir, "main.ts"),
    `import { adder } from "./${helper}";\nconsole.log(adder(2)(40));\n`,
  );
  writeFileSync(
    join(dir, helper),
    helper.endsWith(".ts")
      ? 'export function adder(n: number): (v: number) => number {\n  return new Function("v", `return v + ${n};`) as (v: number) => number;\n}\n'
      : '/** @param {number} n @returns {(v: number) => number} */\nexport function adder(n) {\n  return new Function("v", `return v + ${n};`);\n}\n',
  );
  return dir;
}

function build(dir: string, islands: string[]) {
  return compile(join(dir, "main.ts"), {
    outPath: join(dir, "main"),
    outDir: dir,
    sanitize,
    nodeIslands: { islands },
  });
}

describe("--node-island marks", () => {
  test("a mark on the entry module is refused by name", async () => {
    const dir = program("helper.ts");
    const result = await build(dir, [join(dir, "main.ts")]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics.map((d) => `${d.code}: ${d.message}`)).toEqual([
      "SC8006: --node-island marks the entry module to run in a Node island, and the entry module stays native",
    ]);
  });

  test("a mark that names no module of the program is refused by name", async () => {
    const dir = program("helper.ts");
    const missing = join(dir, "not-imported.ts");
    const result = await build(dir, [missing]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics.map((d) => `${d.code}: ${d.message}`)).toEqual([
      `SC8006: --node-island=${missing} names no module of this program`,
    ]);
  });

  test("a package name the program does not load is refused by name", async () => {
    const dir = program("helper.ts");
    const result = await build(dir, ["left-pad"]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics.map((d) => `${d.code}: ${d.message}`)).toEqual([
      "SC8006: --node-island=left-pad names no package this program loads from node_modules",
    ]);
  });

  test("a package scriptc compiles from its own implementation is refused by name", async () => {
    // chalk 5 compiles from packages/compiler/shims/chalk/v5.ts.
    const entry = join(import.meta.dirname, "../fixtures/npm/cases/chalk5/main.ts");
    const dir = mkdtempSync(join(tmpdir(), "scriptc-island-marks-"));
    scratch.push(dir);
    const result = await compile(entry, {
      outPath: join(dir, "main"),
      outDir: dir,
      sanitize,
      nodeIslands: { islands: ["chalk"] },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics.map((d) => `${d.code}: ${d.message}`)).toEqual([
      "SC8006: --node-island=chalk cannot run 'chalk' in a Node island: scriptc compiles this package from its own implementation, not from the installed one",
    ]);
  });

  test.skipIf(libnodePack() === null).each(["helper.ts", "helper.js"])(
    "a marked %s module runs in a Node island",
    async (helper) => {
      const dir = program(helper);
      const result = await build(dir, [join(dir, helper)]);
      if (!result.ok)
        throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
      expect(result.islands?.modules.map((file) => basename(file))).toEqual([helper]);
      expect(execFileSync(result.binaryPath, { encoding: "utf8" })).toBe("42\n");
    },
    120_000,
  );
});
