import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule, validateModule } from "../src/index.js";
import { specializeNumericCalls } from "../src/ir/numeric-call-specialization.js";
import { everyStmtList } from "../src/ir/traverse.js";
import { emitLlvmModule } from "../src/backend/llvm/emitter.js";
import { mangleFunction } from "../src/backend/mangle.js";

test("known numeric calls bypass optional boxes while uncertain calls retain their ABI", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-numeric-calls-"));
  try {
    const entry = join(dir, "main.ts"),
      outPath = join(dir, "main.ir.json");
    await writeFile(
      entry,
      `
function scale(value: number): number { return value * 3; }
function scale_nativeNumber(value: number): number { return value + 9; }
function forward(value: number): number { return scale(value) + 1; }
function rewrite(value: number): number { if (value < 0) value = 2; return value | 0; }
const values: number[] = [4];
console.log(scale(values[2]), forward(values[2]), rewrite(values[2]));
console.log(scale(5), forward(6), rewrite(-1), scale_nativeNumber(1));
`,
    );
    const result = await compile(entry, { outDir: dir, outPath, outputKind: "ir" });
    if (!result.ok) throw new Error(result.diagnostics.map((d) => d.message).join("\n"));
    const original = deserializeModule(await readFile(outPath, "utf8"));
    const before = JSON.stringify(original);
    const specialized = specializeNumericCalls(original, mangleFunction);
    expect(validateModule(original)).toEqual([]);
    expect(validateModule(specialized)).toEqual([]);
    expect(JSON.stringify(original)).toBe(before);
    expect(specialized.functions.find((fn) => fn.name === "scale_nativeNumber")).toBe(
      original.functions.find((fn) => fn.name === "scale_nativeNumber"),
    );
    for (const name of ["scale", "forward", "rewrite"]) {
      expect(original.functions.find((fn) => fn.name === name)?.params[0]?.type.kind).toBe("union");
      expect(
        specialized.functions.find(
          (fn) => fn.name === name + ".nativeNumber" + (name === "scale" ? "_" : ""),
        )?.params[0]?.type.kind,
      ).toBe("f64");
    }
    const scalarForward = specialized.functions.find((fn) => fn.name === "forward.nativeNumber")!;
    const calls: string[] = [];
    everyStmtList(scalarForward.body, {
      stmt: () => true,
      expr: (expr) => {
        if (expr.kind === "call") calls.push(expr.callee);
        return true;
      },
    });
    expect(calls).toContain("scale.nativeNumber_");
    const llvm = emitLlvmModule(original);
    expect(llvm).toMatch(/define internal double @sc_f_scale_nativeNumber_\(double/);
    expect(llvm).toMatch(/define internal double @sc_f_scale\(ptr/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
