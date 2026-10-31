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

test("calls that omit a constant default or pass booleans take the variant, and unreached originals go", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-presence-calls-"));
  try {
    const entry = join(dir, "main.ts"),
      outPath = join(dir, "main.ir.json");
    await writeFile(
      entry,
      `
let ticks = 0;
function tick(): number { ticks++; return ticks; }
function scale(value: number, by: number = 2): number { return value * by; }
function flag(on: boolean = true): string { return on ? "on" : "off"; }
function stepped(value: number, step: number = tick()): number { return value + step; }
function shown(value: number, extra?: number): string { return extra === undefined ? "-" : String(value + extra); }
function held(value: number, by: number = 3): number { return value - by; }
const keep = held;
const values: number[] = [4];
const on = values.length > 0;
console.log(scale(values.length), scale(1, undefined), scale(2, on ? 5 : undefined), flag(), flag(on));
console.log(stepped(1), stepped(2, 3), shown(1), shown(1, 2), held(5), keep(6));
`,
    );
    const result = await compile(entry, { outDir: dir, outPath, outputKind: "ir" });
    if (!result.ok) throw new Error(result.diagnostics.map((d) => d.message).join("\n"));
    const original = deserializeModule(await readFile(outPath, "utf8"));
    const specialized = specializeNumericCalls(original);
    expect(validateModule(specialized)).toEqual([]);
    const names = new Set(specialized.functions.map((fn) => fn.name));
    // Every call of scale and flag reaches the variant, so the originals go;
    // held is also a value, and stepped's and shown's omitted arguments are
    // not constants, so those keep theirs.
    expect(
      [...names].filter((name) => /^(scale|flag|stepped|shown|held)/.test(name)).sort(),
    ).toEqual([
      "flag.nativeNumber",
      "held",
      "held.nativeNumber",
      "scale.nativeNumber",
      "shown",
      "shown.nativeNumber",
      "stepped",
      "stepped.nativeNumber",
    ]);
    expect(
      specialized.functions.find((fn) => fn.name === "flag.nativeNumber")?.params[0]?.type.kind,
    ).toBe("bool");
    const calls: [string, string][] = [];
    for (const fn of specialized.functions)
      everyStmtList(fn.body, {
        stmt: () => true,
        expr: (expr) => {
          if (expr.kind === "call" && /^(scale|flag|stepped|shown)/.test(expr.callee))
            calls.push([expr.callee, expr.args.map((arg) => arg.kind).join(",")]);
          return true;
        },
      });
    expect(calls).toEqual([
      ["scale.nativeNumber", "arrIntrinsic,numLit"],
      ["scale.nativeNumber", "numLit,numLit"],
      ["scale.nativeNumber", "numLit,ternary"],
      ["flag.nativeNumber", "boolLit"],
      ["flag.nativeNumber", "varRef"],
      ["stepped", "numLit,unionWrap"],
      ["stepped.nativeNumber", "numLit,numLit"],
      ["shown", "numLit,unionWrap"],
      ["shown.nativeNumber", "numLit,numLit"],
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
