import { expect, test } from "vitest";
import { findUnaliasedLocalArrays, preservesArrayLength } from "./array-length-stability.js";
import {
  BOOL,
  F64,
  arrayOf,
  mapOf,
  setOf,
  type IrExpr,
  type IrFunction,
  type IrLocal,
  type IrStmt,
} from "./ir.js";

const loc = { file: "array-length-stability.ts", start: 0, end: 0 };
const ARR = arrayOf(F64);
const num = (value: number): IrExpr => ({ kind: "numLit", value, type: F64, loc });
const ref = (localId: string): IrExpr => ({ kind: "varRef", localId, type: F64, loc });
const arr = (localId: string): IrExpr => ({ kind: "varRef", localId, type: ARR, loc });
const method = (
  receiver: string,
  name: Extract<IrExpr, { kind: "arrIntrinsic" }>["method"],
  args: IrExpr[] = [],
): IrExpr => ({
  kind: "arrIntrinsic",
  method: name,
  receiver: arr(receiver),
  args,
  type: F64,
  loc,
});
const length = (receiver: string): IrExpr => method(receiver, "length");
const read = (receiver: string, index: IrExpr): IrExpr => method(receiver, "getNumber", [index]);
const plus = (left: IrExpr, right: IrExpr): IrExpr => ({
  kind: "bin",
  op: "+",
  left,
  right,
  type: F64,
  loc,
});
const stmt = (expr: IrExpr): IrStmt => ({ kind: "exprStmt", expr, loc });
const set = (receiver: string, index: IrExpr, value: IrExpr): IrStmt => ({
  kind: "arraySet",
  arr: arr(receiver),
  index,
  value,
  loc,
});
const cond: IrExpr = { kind: "bin", op: "<", left: ref("i"), right: length("a"), type: BOOL, loc };
const sum: IrStmt = {
  kind: "assign",
  localId: "s",
  value: plus(ref("s"), read("a", ref("i"))),
  loc,
};
const locals = new Map<string, IrLocal>([
  ["i", { id: "i", name: "i", type: F64, mutable: true }],
  ["s", { id: "s", name: "s", type: F64, mutable: true }],
  ["a", { id: "a", name: "a", type: ARR, mutable: false }],
  ["b", { id: "b", name: "b", type: ARR, mutable: false }],
  ["out", { id: "out", name: "out", type: ARR, mutable: false }],
]);
const preserves = (
  body: IrStmt[],
  inRange: string | null = "i",
  unaliased: ReadonlySet<string> = new Set(),
  scope = locals,
): boolean => preservesArrayLength([cond, ...body], { receiver: "a", inRange }, scope, unaliased);

test("reads, local arithmetic and element writes at the in-range counter keep the length", () => {
  expect(preserves([sum])).toBe(true);
  expect(preserves([set("a", ref("i"), num(1)), set("b", ref("i"), read("a", ref("i")))])).toBe(
    true,
  );
  expect(preserves([stmt(method("a", "indexOf", [num(3)]))])).toBe(true);
});

test("writes past the counter, without an in-range counter, or to the counter can grow it", () => {
  expect(preserves([set("a", plus(ref("i"), num(1)), num(1))])).toBe(false);
  expect(preserves([set("b", ref("s"), num(1))])).toBe(false);
  expect(preserves([set("a", ref("i"), num(1))], null)).toBe(false);
  expect(preserves([{ kind: "assign", localId: "i", value: num(0), loc }, sum])).toBe(false);
});

test("resizing methods, length stores, calls and escapes refuse the proof", () => {
  for (const name of ["push", "pop", "shift", "unshift", "splice", "fill"] as const)
    expect(preserves([stmt(method("a", name, [num(1)]))])).toBe(false);
  // An unrelated array may alias the receiver.
  expect(preserves([stmt(method("b", "push", [num(1)]))])).toBe(false);
  expect(preserves([{ kind: "arraySetLength", arr: arr("a"), length: num(0), loc }])).toBe(false);
  expect(preserves([{ kind: "arrayDelete", arr: arr("a"), index: ref("i"), loc }])).toBe(false);
  expect(preserves([stmt({ kind: "call", callee: "f", args: [], type: F64, loc })])).toBe(false);
  expect(preserves([stmt({ kind: "call", callee: "f", args: [arr("a")], type: F64, loc })])).toBe(
    false,
  );
  expect(preserves([{ kind: "varDecl", localId: "b", init: arr("a"), loc }])).toBe(false);
  expect(preserves([{ kind: "assign", localId: "a", value: arr("b"), loc }])).toBe(false);
});

test("an unaliased local array other than the receiver may grow", () => {
  const push = stmt(method("out", "push", [read("a", ref("i"))]));
  expect(preserves([push], "i", new Set(["out"]))).toBe(true);
  expect(preserves([set("out", ref("s"), num(1))], "i", new Set(["out"]))).toBe(true);
  expect(preserves([push])).toBe(false);
  // The receiver itself is never resized, even when no alias exists.
  expect(preserves([stmt(method("a", "push", [num(1)]))], "i", new Set(["a"]))).toBe(false);
});

test("captured receivers have no local proof", () => {
  const boxed = new Map(locals);
  boxed.set("a", { ...locals.get("a")!, boxed: true });
  expect(preserves([sum], "i", new Set(), boxed)).toBe(false);
});

test("Map and Set reads and checked union extractions run no user code", () => {
  const counts: IrExpr = { kind: "varRef", localId: "m", type: mapOf(F64, F64), loc };
  const seen: IrExpr = { kind: "varRef", localId: "v", type: setOf(F64), loc };
  const onMap = (name: string, args: IrExpr[]): IrExpr =>
    ({ kind: "mapIntrinsic", method: name, receiver: counts, args, type: F64, loc }) as IrExpr;
  const onSet = (name: string, args: IrExpr[]): IrExpr =>
    ({ kind: "setIntrinsic", method: name, receiver: seen, args, type: BOOL, loc }) as IrExpr;
  const call = (callee: string): IrExpr => ({
    kind: "call",
    callee,
    args: [ref("s")],
    type: F64,
    loc,
  });
  const key = read("a", ref("i"));
  expect(
    preserves([stmt(onMap("has", [key])), stmt(onMap("get", [key])), stmt(onMap("size", []))]),
  ).toBe(true);
  expect(preserves([stmt(onSet("has", [key])), stmt(onSet("size", []))])).toBe(true);
  expect(preserves([stmt(call("%union.narrow.0"))])).toBe(true);
  // Writes release replaced values; other calls run user code.
  expect(preserves([stmt(onMap("set", [key, num(1)]))])).toBe(false);
  expect(preserves([stmt(onSet("add", [key]))])).toBe(false);
  expect(preserves([stmt(call("g"))])).toBe(false);
});

function fn(body: IrStmt[], params: string[] = []): IrFunction {
  return {
    loc,
    name: "f",
    params: params.map((localId) => ({ localId, type: ARR })),
    returnType: ARR,
    locals: [...locals.values()],
    body,
  } as IrFunction;
}
const fresh: IrExpr = { kind: "arrayLit", elems: [], type: ARR, loc };

test("fresh local arrays read only as receivers have no alias", () => {
  const body: IrStmt[] = [
    { kind: "varDecl", localId: "out", init: fresh, loc },
    stmt(method("out", "push", [num(1)])),
    { kind: "return", value: arr("out"), loc },
  ];
  expect([...findUnaliasedLocalArrays(fn(body))]).toEqual(["out"]);
  // Parameters, copies into another binding, and arguments escape.
  expect(findUnaliasedLocalArrays(fn(body, ["out"])).size).toBe(0);
  const copied = [...body, { kind: "varDecl", localId: "b", init: arr("out"), loc } as IrStmt];
  expect(findUnaliasedLocalArrays(fn(copied)).has("out")).toBe(false);
  const passed = [...body, stmt({ kind: "call", callee: "g", args: [arr("out")], type: F64, loc })];
  expect(findUnaliasedLocalArrays(fn(passed)).has("out")).toBe(false);
  const rebound = [...body, { kind: "assign", localId: "out", value: arr("a"), loc } as IrStmt];
  expect(findUnaliasedLocalArrays(fn(rebound)).has("out")).toBe(false);
});

test("number and boolean writes to class fields run no user code", () => {
  const obj: IrExpr = {
    kind: "varRef",
    localId: "o",
    type: { kind: "object", className: "P" },
    loc,
  };
  const scope = new Map(locals).set("o", {
    id: "o",
    name: "o",
    type: { kind: "object", className: "P" },
    mutable: false,
  });
  const fieldSet = (value: IrExpr): IrStmt => ({
    kind: "fieldSet",
    obj,
    className: "P",
    field: "x",
    value,
    loc,
  });
  expect(preserves([fieldSet(read("a", ref("i")))], "i", new Set(), scope)).toBe(true);
  // A reference stored into a field releases the old one.
  expect(preserves([fieldSet(arr("b"))], "i", new Set(), scope)).toBe(false);
});

test("optional element reads, their assertion errors and present-undefined stores at an in-range index keep the length", () => {
  const optional = (receiver: string, index: IrExpr): IrExpr => ({
    kind: "call",
    callee: "%arr.idxOr.f64",
    args: [arr(receiver), index],
    type: F64,
    loc,
  });
  const undefinedAt = (receiver: string, index: IrExpr): IrStmt => ({
    kind: "arraySetUndefined",
    arr: arr(receiver),
    index,
    loc,
  });
  const thrown: IrExpr = { kind: "libCall", fn: "error.nodeThrow", args: [num(1)], type: F64, loc };
  expect(preserves([stmt(optional("a", ref("i"))), stmt(thrown)])).toBe(true);
  expect(preserves([undefinedAt("a", ref("i"))])).toBe(true);
  // Past the counter, a present undefined extends the array.
  expect(preserves([undefinedAt("a", plus(ref("i"), num(1)))])).toBe(false);
  // The high counter of a two-counter loop is in range as well.
  const paired = (body: IrStmt[]): boolean =>
    preservesArrayLength(
      [cond, ...body],
      { receiver: "a", inRange: "i", inRangeHigh: "j" },
      locals,
      new Set(),
    );
  expect(paired([undefinedAt("a", ref("j")), set("a", ref("j"), num(0))])).toBe(true);
  expect(preserves([set("a", ref("j"), num(0))])).toBe(false);
});
