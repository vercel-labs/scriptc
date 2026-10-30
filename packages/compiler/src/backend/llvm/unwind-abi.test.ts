import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule } from "../../index.js";
import { validateModule } from "../../ir/validate.js";
import { emitLlvmModule } from "./emitter.js";
import { UnwindAbiViolation, bridgePlainUnwindCalls } from "./unwind-abi.js";

async function moduleFor(source: string) {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-unwind-abi-"));
  try {
    const entry = join(dir, "main.ts"),
      output = join(dir, "main.ir.json");
    await writeFile(entry, source);
    const result = await compile(entry, { outDir: dir, outPath: output, outputKind: "ir" });
    if (!result.ok)
      throw new Error(result.diagnostics.map((item) => `${item.code}: ${item.message}`).join("\n"));
    const module = deserializeModule(await readFile(output, "utf8"));
    expect(validateModule(module)).toEqual([]);
    return module;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** The definition of the source function `name` (its i32 or borrowing entry when it has one). */
function body(ir: string, name: string): string {
  return new RegExp(
    `^define internal [^\\n]*@sc_b?f_[^\\n(]*${name}(?:\\.i32)?\\([^]*?^}`,
    "m",
  ).exec(ir)![0];
}

const SOURCE = `
function leaf(n: number): number {
  if (n === 3) throw new RangeError("three");
  return n * 2;
}
function first(n: number): number {
  return leaf(n) + 1;
}
function second(n: number): number {
  return first(n) * 3;
}
function third(n: number): number {
  return second(n) - 2;
}
function mid(n: number): number {
  const parts: string[] = ["a" + n];
  const r = third(n);
  parts.push("b");
  return r + parts.length;
}
class Counter {
  total = 0;
  add(n: number): void { this.total += mid(n); }
}
function outer(n: number): string {
  try { return "ok " + mid(n); } catch (e) { return "caught " + (e as Error).message; }
}
const counter = new Counter();
for (let i = 0; i < 5; i++) { console.log(outer(i)); try { counter.add(i); } catch { console.log("add", i); } }
const f = (x: number) => mid(x);
console.log(f(1), counter.total);
`;

const LINUX = { targetTriple: "x86_64-unknown-linux-gnu", unwindAbi: true } as const;

test("directly called functions raise, and their callers invoke them without a pending check", async () => {
  const ir = emitLlvmModule(await moduleFor(SOURCE), LINUX);
  // leaf throws: the exception starts on the pending flag, and the three
  // calls above it test the flag too; mid raises it on.
  for (const name of ["leaf", "first", "second", "third"])
    expect(body(ir, name)).not.toContain("@scr_unwind_raise");
  const mid = body(ir, "mid");
  expect(mid).toMatch(/= call double @sc_b?f_[^(]*third\(/);
  expect(mid).toContain("call void @scr_unwind_raise()");
  // outer invokes mid; the landing pad takes the exception to its handler.
  const outer = body(ir, "outer");
  expect(outer).toMatch(
    /= invoke double @sc_b?f_[^(]*mid[^\n]* to label %inv\.ok\d+ unwind label %inv\.lp\d+/,
  );
  expect(outer).toMatch(/inv\.lp\d+:\n\s+%t\d+ = landingpad \{ ptr, i32 \} cleanup/);
  expect(outer).toContain("personality ptr @__gcc_personality_v0");
  expect(ir).toContain("declare i32 @__gcc_personality_v0(...)");
  expect(ir).toContain("declare void @scr_unwind_raise() cold");
});

test("a method of a class outside any hierarchy is on the unwinding ABI; closures keep the flag", async () => {
  const ir = emitLlvmModule(await moduleFor(SOURCE), LINUX);
  // Counter.add invokes mid and resumes the unwind from its landing pad; the
  // closure over mid is a pointer target and returns with the flag.
  const add = body(ir, "Counter_add");
  expect(add).toMatch(/invoke double @sc_b?f_[^(]*mid/);
  expect(add).toMatch(/call void @scr_unwind_resume\(ptr %[\w.]+\)\n\s+unreachable/);
  expect(add).not.toMatch(/\bresume \{/);
  expect(ir).toContain("declare void @scr_unwind_resume(ptr) cold");
  expect(add).not.toContain("@scr_unwind_raise");
  const closures = ir
    .split(/\n(?=define )/)
    .filter((def) => /^define internal [^\n]*@sc_b?f_[^\n(]*fn_/.test(def));
  expect(closures.length).toBeGreaterThan(0);
  for (const def of closures) expect(def).not.toContain("call void @scr_unwind_raise()");
});

test("recursive functions keep the pending flag, also when they recurse through a callback", async () => {
  const source = `
function leaf(n: number): number {
  if (n < 0) throw new RangeError("negative");
  return n;
}
function one(n: number): number { return leaf(n) + 1; }
function two(n: number): number { return one(n) + 1; }
function three(n: number): number { return two(n) + 1; }
function four(n: number): number {
  const parts: string[] = ["a" + n];
  const r = three(n);
  return r + parts.length;
}
function walk(n: number, depth: number): number {
  const parts: string[] = ["w" + n];
  const r = depth === 0 ? four(n) : walk(n, depth - 1);
  return r + parts.length;
}
function visit(n: number, depth: number, each: (n: number, depth: number) => number): number {
  const parts: string[] = ["v" + n];
  const r = depth === 0 ? four(n) : each(n, depth - 1);
  return r + parts.length;
}
const each = (n: number, depth: number): number => visit(n, depth, each);
for (let i = -1; i < 2; i++) {
  try { console.log(walk(i, 3), visit(i, 3, each)); } catch (e) { console.log((e as Error).message); }
}
`;
  const ir = emitLlvmModule(await moduleFor(source), LINUX);
  expect(body(ir, "four")).toContain("call void @scr_unwind_raise()");
  for (const name of ["walk", "visit"]) {
    expect(body(ir, name)).not.toContain("@scr_unwind_raise");
    expect(body(ir, name)).toMatch(/invoke double @sc_b?f_[^(]*four/);
  }
});

test("with rareExceptions, recursive functions and those near a throw unwind; throwing ones keep the flag", async () => {
  const source = `
function leaf(n: number): number {
  if (n < 0) throw new RangeError("negative");
  return n;
}
function one(n: number): number { return leaf(n) + 1; }
function two(n: number): number { return one(n) + 1; }
function walk(n: number, depth: number): number {
  const parts: string[] = ["w" + n];
  const r = depth === 0 ? two(n) : walk(n, depth - 1);
  return r + parts.length;
}
for (let i = -1; i < 2; i++) {
  try { console.log(walk(i, 3)); } catch (e) { console.log((e as Error).message); }
}
`;
  const mod = await moduleFor(source);
  const common = emitLlvmModule(mod, LINUX);
  const rare = emitLlvmModule(mod, { ...LINUX, rareExceptions: true });
  for (const [caller, callee] of [
    ["two", "one"],
    ["walk", "walk"],
    ["walk", "two"],
  ] as const) {
    const invoke = new RegExp(`invoke double @sc_b?f_[^(]*${callee}`);
    expect(body(common, caller)).not.toMatch(invoke);
    expect(body(rare, caller)).toMatch(invoke);
  }
  // one raises what leaf returns pending; leaf throws, so it keeps the flag.
  expect(body(rare, "one")).toContain("call void @scr_unwind_raise()");
  expect(body(rare, "one")).not.toMatch(/invoke double @sc_b?f_[^(]*leaf/);
});

test("without the option, and off Linux, emission keeps the pending-flag ABI", async () => {
  const mod = await moduleFor(SOURCE);
  for (const options of [{}, { targetTriple: "arm64-apple-macosx14.0.0", unwindAbi: true }]) {
    const ir = emitLlvmModule(mod, options);
    expect(ir).not.toContain("invoke ");
    expect(ir).not.toContain("@scr_unwind_raise");
    expect(ir).not.toContain("personality");
  }
});

test("bridgePlainUnwindCalls keeps the pending-flag contract at plain calls of raising functions", () => {
  const raising = [
    "define internal ptr @sc_bf_raises(ptr %p) #0 { ; raises",
    "entry:",
    "  call void @scr_unwind_raise()",
    "  unreachable",
    "}",
  ].join("\n");
  const caller = [
    "define internal ptr @sc_f_adapter(ptr %p0) #0 {",
    "entry:",
    "  %result = call ptr @sc_bf_raises(ptr %p0) ; borrowed result",
    "  br label %next",
    "next:",
    "  %v = phi ptr [ %result, %entry ]",
    "  ret ptr %v",
    "}",
  ].join("\n");
  const [out] = bridgePlainUnwindCalls([`${raising}\n${caller}`]);
  expect(out).toContain(
    "%result.ub = invoke ptr @sc_bf_raises(ptr %p0) to label %ub.n.0 unwind label %ub.lp.0",
  );
  expect(out).toContain("%result = phi ptr [ %result.ub, %ub.n.0 ], [ null, %ub.lp.0 ]");
  // The split block's successor now comes from its last part.
  expect(out).toContain("%v = phi ptr [ %result, %ub.ok.0 ]");
  expect(out).toMatch(
    /define internal ptr @sc_f_adapter\(ptr %p0\) #0 personality ptr @__gcc_personality_v0 \{/,
  );
  expect(out).toContain("declare i32 @__gcc_personality_v0(...)");
});

test("an invoked wrapper of a raising function resumes the unwind; its address must not escape", () => {
  const raising = [
    "define internal double @sc_bf_body.i32(i32 %a) #0 {",
    "entry:",
    "  call void @scr_unwind_raise()",
    "  unreachable",
    "}",
  ].join("\n");
  const wrapper = [
    "define internal double @sc_bf_body(double %a) #0 {",
    "entry:",
    "  %i = fptosi double %a to i32",
    "  %r = call double @sc_bf_body.i32(i32 %i)",
    "  ret double %r",
    "}",
  ].join("\n");
  const caller = [
    "define internal double @sc_bf_caller(double %a) #0 personality ptr @__gcc_personality_v0 {",
    "entry:",
    "  %r = invoke double @sc_bf_body(double %a) to label %ok unwind label %lp",
    "lp:",
    "  %x = landingpad { ptr, i32 } cleanup",
    "  call void @scr_unwind_raise()",
    "  unreachable",
    "ok:",
    "  ret double %r",
    "}",
  ].join("\n");
  const [out] = bridgePlainUnwindCalls([[raising, wrapper, caller].join("\n")]);
  expect(out).toContain(
    "%r = invoke double @sc_bf_body.i32(i32 %i) to label %ub.ok.0 unwind label %ub.lp.0",
  );
  expect(out).toContain(
    "%ub.e.0 = extractvalue { ptr, i32 } %ub.v.0, 0\n  call void @scr_unwind_resume(ptr %ub.e.0)\n  unreachable",
  );
  expect(out).toContain("declare void @scr_unwind_resume(ptr) cold");
  expect(() =>
    bridgePlainUnwindCalls([
      `${raising}\n@table = internal constant [1 x ptr] [ptr @sc_bf_body.i32]`,
    ]),
  ).toThrow(UnwindAbiViolation);
  try {
    bridgePlainUnwindCalls([
      `${raising}\n@table = internal constant [1 x ptr] [ptr @sc_bf_body.i32]`,
    ]);
  } catch (error) {
    expect([...(error as UnwindAbiViolation).symbols]).toEqual(["sc_bf_body.i32"]);
  }
});

test("an invoked function that never tests the pending flag needs no raise", () => {
  const raising = [
    "define internal void @sc_bf_raises() #0 {",
    "entry:",
    "  call void @scr_unwind_raise()",
    "  unreachable",
    "}",
  ].join("\n");
  const leaf = [
    "define internal double @sc_bf_leaf() #0 {",
    "entry:",
    "  ret double 1.0",
    "}",
  ].join("\n");
  const caller = (callee: string) =>
    [
      "define internal double @sc_bf_caller() #0 personality ptr @__gcc_personality_v0 {",
      "entry:",
      `  %r = invoke double @${callee}() to label %ok unwind label %lp`,
      "lp:",
      "  %x = landingpad { ptr, i32 } cleanup",
      "  call void @scr_unwind_raise()",
      "  unreachable",
      "ok:",
      "  ret double %r",
      "}",
    ].join("\n");
  expect(() =>
    bridgePlainUnwindCalls([[raising, leaf, caller("sc_bf_leaf")].join("\n")]),
  ).not.toThrow();
  const testing = leaf.replace(
    "  ret double 1.0",
    "  %f = load i32, ptr @scr_exc_flag\n  ret double 1.0",
  );
  expect(() =>
    bridgePlainUnwindCalls([[raising, testing, caller("sc_bf_leaf")].join("\n")]),
  ).toThrow(UnwindAbiViolation);
});

test("calls that cannot unwind are marked nounwind", () => {
  const raising = [
    "define internal void @sc_bf_raises(ptr %b) #0 {",
    "entry:",
    "  %n = call i64 @scr_bytes_length(ptr %b) ; length",
    "  call void @scr_bytes_release(ptr %b), !dbg !4",
    "  %r = call ptr %b(ptr %b)",
    "  call void @scr_unwind_raise()",
    "  unreachable",
    "}",
  ].join("\n");
  const resuming = [
    "define internal void @sc_bf_resumes(ptr %b) #0 personality ptr @__gcc_personality_v0 {",
    "entry:",
    "  invoke void @sc_bf_raises(ptr %b) to label %ok unwind label %lp",
    "ok:",
    "  ret void",
    "lp:",
    "  %e = landingpad { ptr, i32 } cleanup",
    "  %t = extractvalue { ptr, i32 } %e, 0",
    "  call void @scr_unwind_resume(ptr %t)",
    "  unreachable",
    "}",
  ].join("\n");
  const [out] = bridgePlainUnwindCalls([[raising, resuming].join("\n")]);
  expect(out).toContain("%n = call i64 @scr_bytes_length(ptr %b) nounwind ; length");
  expect(out).toContain("call void @scr_bytes_release(ptr %b) nounwind, !dbg !4");
  expect(out).toContain("%r = call ptr %b(ptr %b) nounwind");
  expect(out).toContain("  call void @scr_unwind_raise()\n");
  // The resume unwinds: where LLVM inlines the function at an invoke, the
  // call becomes an invoke of the caller's landing pad.
  expect(out).toContain("  call void @scr_unwind_resume(ptr %t)\n");
});

test("functions without a plain call of a raising function change only their call lines", () => {
  const raising = [
    "define internal void @sc_bf_raises() #0 {",
    "entry:",
    "  call void @scr_unwind_raise()",
    "  unreachable",
    "}",
  ].join("\n");
  const other = [
    "define internal void @sc_bf_raises.copy() #0 {",
    "entry:",
    "  ret void",
    "}",
  ].join("\n");
  const plain = [
    "define internal double @sc_f_plain(ptr %p) #0 {",
    "entry: ; call sites below",
    "  %a = call double @sc_f_other(ptr %p)",
    "  %b = tail call double @sc_f_other(ptr %p) ; mentions @ and @sc_bf_raises.copy",
    "  store ptr @sc_bf_raises.copy, ptr %p",
    "  ret double %a",
    "}",
  ].join("\n");
  const parts = [`${raising}\n${other}`, plain, "@table = internal constant ptr @sc_f_plain"];
  const out = bridgePlainUnwindCalls(parts);
  expect(out[0]).toBe(parts[0]);
  expect(out[1]).toBe(
    plain
      .replace("@sc_f_other(ptr %p)\n", "@sc_f_other(ptr %p) nounwind\n")
      .replace("@sc_f_other(ptr %p) ;", "@sc_f_other(ptr %p) nounwind ;"),
  );
  expect(out[2]).toBe(parts[2]);
  expect(() =>
    bridgePlainUnwindCalls([
      raising,
      plain.replace("store ptr @sc_bf_raises.copy", "store ptr @sc_bf_raises"),
    ]),
  ).toThrow(UnwindAbiViolation);
});
