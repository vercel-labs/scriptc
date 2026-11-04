// Math.max/Math.min over a fixed-length NUMERIC TUPLE spread. A tuple is a
// record with positional number fields "0".."n-1", so the spread folds
// those positions with the same two-arg scalar compare the positional form
// uses: no number[] is built, and the source evaluates once into a hidden
// local. A number[] spread keeps the runtime array fold.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule, validateModule } from "../src/index.js";

type IrModule = { entry: string; functions: unknown[] };

async function compileToIr(
  body: string[],
): Promise<{ ok: boolean; module: IrModule | null; diagnostics: string }> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-math-tuple-"));
  try {
    const entry = join(dir, "main.ts");
    const outPath = join(dir, "main.ir.json");
    await writeFile(entry, body.join("\n"));
    const result = await compile(entry, { outDir: dir, outPath, outputKind: "ir" });
    if (!result.ok)
      return {
        ok: false,
        module: null,
        diagnostics: result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"),
      };
    const module = deserializeModule(await readFile(outPath, "utf8")) as unknown as IrModule;
    expect(validateModule(module as never)).toEqual([]);
    return { ok: true, module, diagnostics: "" };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function functions(module: IrModule): string {
  return JSON.stringify(module.functions);
}

test("a numeric tuple spread folds its positions without an array", async () => {
  const compiled = await compileToIr([
    "function point(c: number): [number, number, number] {",
    "  return [c, c * 2, 1 - c];",
    "}",
    "console.log(Math.max(...point(0.5)), Math.min(...point(0.5)));",
  ]);
  expect(compiled.ok, compiled.diagnostics).toBe(true);
  const ir = functions(compiled.module!);
  // Two positional reads per three-field tuple, and no array fold.
  expect(ir.match(/"math\.max"/g)?.length).toBe(2);
  expect(ir.match(/"math\.min"/g)?.length).toBe(2);
  expect(ir).toContain('"recordGet"');
  expect(ir).not.toContain('"math.maxArr"');
  expect(ir).not.toContain('"math.minArr"');
});

test("a number[] spread keeps the runtime array fold", async () => {
  const compiled = await compileToIr([
    "const xs: number[] = [4, 7, 2];",
    "console.log(Math.max(...xs), Math.min(...xs));",
  ]);
  expect(compiled.ok, compiled.diagnostics).toBe(true);
  const ir = functions(compiled.module!);
  expect(ir).toContain('"math.maxArr"');
  expect(ir).toContain('"math.minArr"');
});
