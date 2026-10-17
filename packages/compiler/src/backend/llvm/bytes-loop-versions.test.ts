import { expect, test } from "vitest";
import {
  BOOL,
  F64,
  VOID,
  type IrExpr,
  type IrFunction,
  type IrLocal,
  type IrModule,
  type IrStmt,
  type IrType,
} from "../../ir/ir.js";
import { analyzeIntegerRanges } from "../../ir/integer-ranges.js";
import { matchIntegerCountedForLoop } from "../../ir/integer-loops.js";
import { findInitializedByteLoopBindings } from "./byte-windows.js";
import { matchBytesLoopVersion, type BytesLoopVersion } from "./bytes-loop-versions.js";
import { emitLlvmModule } from "./emitter.js";

const loc = { file: "versions.ts", start: 0, end: 0 };
const f64s: IrType = { kind: "bytes", elem: "f64" };
const i32s: IrType = { kind: "bytes", elem: "i32" };
const num = (value: number): IrExpr => ({ kind: "numLit", value, type: F64, loc });
const ref = (localId: string, type: IrType = F64): IrExpr => ({
  kind: "varRef",
  localId,
  type,
  loc,
});
const bin = (op: string, left: IrExpr, right: IrExpr): IrExpr =>
  ({ kind: "bin", op, left, right, type: F64, loc }) as IrExpr;
const get = (receiver: IrExpr, index: IrExpr): IrExpr => ({
  kind: "bytesIntrinsic",
  method: "get",
  receiver,
  args: [index],
  invalidNaN: true,
  type: F64,
  loc,
});
const set = (arr: IrExpr, index: IrExpr, value: IrExpr): IrStmt => ({
  kind: "bytesSet",
  arr,
  index,
  value,
  loc,
});
const counted = (
  body: IrStmt[],
  limit: IrExpr = ref("n"),
  counter = "i",
): IrStmt & { kind: "for" } => ({
  kind: "for",
  init: { kind: "varDecl", localId: counter, init: num(0), loc },
  cond: { kind: "bin", op: "<", left: ref(counter), right: limit, type: BOOL, loc },
  update: { kind: "assign", localId: counter, value: bin("+", ref(counter), num(1)), loc },
  body,
  loc,
});
const local = (
  id: string,
  type: IrType,
  mutable = false,
  extra: Partial<IrLocal> = {},
): IrLocal => ({
  id,
  name: id,
  type,
  mutable,
  ...extra,
});

function fn(body: IrStmt[], extra: IrLocal[] = []): IrFunction {
  return {
    name: "kernel",
    params: [
      { localId: "out", name: "out", type: f64s },
      { localId: "src", name: "src", type: f64s },
      { localId: "table", name: "table", type: i32s },
      { localId: "n", name: "n", type: F64 },
      { localId: "k", name: "k", type: F64 },
    ],
    returnType: VOID,
    locals: [
      local("out", f64s),
      local("src", f64s),
      local("table", i32s),
      local("n", F64),
      local("k", F64),
      local("i", F64, true),
      local("j", F64, true),
      ...extra,
    ],
    body,
    loc,
  };
}

function match(
  f: IrFunction,
  loop: IrStmt & { kind: "for" },
  captured: string[] = [],
): BytesLoopVersion | null {
  const ranges = analyzeIntegerRanges(f);
  const locals = new Map(f.locals.map((l) => [l.id, l]));
  return matchBytesLoopVersion(loop, matchIntegerCountedForLoop(loop, locals, ranges), {
    locals,
    invariantGlobals: new Set(),
    captured: new Set(captured),
    ranges,
    initialized: findInitializedByteLoopBindings(f).get(loop) ?? new Set(),
    proven: new Set(),
  });
}

test("a counted loop's affine accesses get one guard and exact operand ranges", () => {
  const shifted = bin("+", ref("i"), num(1));
  const loop = counted([set(ref("out", f64s), ref("i"), get(ref("src", f64s), shifted))]);
  const version = match(fn([loop]), loop)!;
  expect(version).not.toBeNull();
  expect(version.bounds.size).toBe(2);
  expect(version.receivers.map((r) => r.ref.kind === "varRef" && r.ref.localId)).toEqual([
    "out",
    "src",
  ]);
  expect(version.affine.map((c) => [c.scale, c.minOffset, c.maxEnd])).toEqual([
    [1, 0, 0],
    [1, 1, 1],
  ]);
  // `n` is unproven: the guard bounds the counter so `i + 1` stays exact.
  expect(version.counted?.limitGuarded).toBe(true);
  expect(version.counterBound).toBe(Number.MAX_SAFE_INTEGER - 1);
  expect(version.ranges.get(shifted)).toEqual({ min: 1, max: Number.MAX_SAFE_INTEGER });
});

test("statically ranged indices compare one constant with the length", () => {
  const masked = bin("&", bin("^", ref("i"), ref("k")), num(255));
  const loop = counted([set(ref("out", f64s), num(0), get(ref("table", i32s), masked))]);
  const version = match(fn([loop]), loop)!;
  expect(version.fixed.map((c) => [version.receivers[c.receiver]!.ref, c.end])).toEqual([
    [ref("out", f64s), 0],
    [ref("table", i32s), 255],
  ]);
  expect(version.affine).toEqual([]);
  expect(version.counted).toBeNull();
});

test("scaled counters and body temps resolve to their receiver and index", () => {
  const temps = [local("view", f64s), local("at", F64)];
  const at = bin("+", bin("*", ref("i"), num(4)), num(3));
  const loop = counted([
    { kind: "varDecl", localId: "view", init: ref("src", f64s), loc },
    { kind: "varDecl", localId: "at", init: at, loc },
    set(ref("view", f64s), ref("at"), num(1)),
    // (The integer counted loop needs one direct counter index.)
    set(ref("out", f64s), ref("i"), num(0)),
  ]);
  const version = match(fn([loop], temps), loop)!;
  expect(version.receivers.map((r) => r.ref)).toEqual([ref("src", f64s), ref("out", f64s)]);
  expect(version.affine.map((c) => [c.scale, c.minOffset, c.maxEnd])).toEqual([
    [4, 3, 3],
    [1, 0, 0],
  ]);
  expect(version.ranges.has(at)).toBe(true);
});

test("negative factors, rebinding, captures and outer loops are not versioned", () => {
  // `i * -1` is -0 at zero, so it is not treated as an affine operand.
  const negative = counted([set(ref("out", f64s), bin("*", ref("i"), num(-1)), num(1))]);
  expect(match(fn([negative]), negative)).toBeNull();
  const rebound = counted([
    set(ref("out", f64s), ref("i"), num(1)),
    { kind: "assign", localId: "out", value: ref("src", f64s), loc },
  ]);
  expect(match(fn([rebound]), rebound)).toBeNull();
  const plain = counted([set(ref("out", f64s), ref("i"), num(1))]);
  expect(match(fn([plain]), plain, ["out"])).toBeNull();
  const inner = counted([set(ref("out", f64s), ref("j"), num(1))], ref("n"), "j");
  const outer = counted([inner]);
  expect(match(fn([outer]), outer)).toBeNull();
  expect(match(fn([outer]), inner)).not.toBeNull();
});

test("emitted loops version the body and tag typed-array memory", () => {
  const loop = counted([
    set(ref("out", f64s), ref("i"), bin("*", get(ref("src", f64s), ref("i")), num(2))),
  ]);
  const kernel = fn([loop]);
  const mod: IrModule = {
    irVersion: 16,
    sourceFile: loc.file,
    entry: "__main",
    functions: [
      { name: "__main", params: [], returnType: VOID, locals: [], body: [], loc },
      kernel,
    ],
  };
  const llvm = emitLlvmModule(mod);
  const body = /^define internal [^\n]*@sc_bf_kernel[^]*?^}/m.exec(llvm)![0];
  expect(body).toContain("bytes.version.fast");
  expect(body).toContain("bytes.version.slow");
  // The checked copy keeps its per-element tests; the guard reads lengths.
  expect(body).toContain("bytes.index.invalid");
  expect(body).toMatch(/store double [^\n]*, align 1, !tbaa !\d+/);
  expect(body).toMatch(/load double, ptr [^\n]*, align 1, !tbaa !\d+/);
  expect(body).toMatch(/load i64, ptr [^\n]*, !tbaa !\d+/);
  expect(body).toMatch(/load ptr, ptr [^\n]*, !tbaa !\d+/);
  const elements = /store double [^\n]*!tbaa !(\d+)/.exec(body)![1];
  const header = /load ptr, ptr [^\n]*!tbaa !(\d+)/.exec(body)![1];
  expect(elements).not.toBe(header);
});
