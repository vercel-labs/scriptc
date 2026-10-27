import { expect, test } from "vitest";
import { BOOL, F64, arrayOf, type IrExpr, type IrLocal, type IrStmt } from "../../ir/ir.js";
import type { IntegerCountedForLoop, IntegerPairedForLoop } from "../../ir/integer-loops.js";
import {
  countedDenseShape,
  matchDenseArrayLoop,
  pairedDenseShape,
  type DenseLoopShape,
} from "./dense-array-loops.js";

const loc = { file: "dense-array-loops.ts", start: 0, end: 0 };
const ARR = arrayOf(F64);
const num = (value: number): IrExpr => ({ kind: "numLit", value, type: F64, loc });
const ref = (localId: string): IrExpr => ({ kind: "varRef", localId, type: F64, loc });
const arr = (localId: string): IrExpr & { kind: "varRef" } => ({
  kind: "varRef",
  localId,
  type: ARR,
  loc,
});
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
const read = (receiver: string, index = ref("i")): IrExpr => method(receiver, "getNumber", [index]);
const write = (receiver: string, value: IrExpr, index = ref("i")): IrStmt => ({
  kind: "arraySet",
  arr: arr(receiver),
  index,
  value,
  loc,
});
const locals = new Map<string, IrLocal>([
  ["i", { id: "i", name: "i", type: F64, mutable: true }],
  ["a", { id: "a", name: "a", type: ARR, mutable: false }],
  ["b", { id: "b", name: "b", type: ARR, mutable: true }],
  ["c", { id: "c", name: "c", type: ARR, mutable: false }],
  ["j", { id: "j", name: "j", type: F64, mutable: true }],
  ["t", { id: "t", name: "t", type: F64, mutable: false }],
]);

/** for (let i = 0; i < a.length; i++) body */
function loop(body: IrStmt[]): IrStmt & { kind: "for" } {
  return {
    kind: "for",
    loc,
    init: { kind: "varDecl", localId: "i", init: num(0), loc },
    cond: { kind: "bin", op: "<", left: ref("i"), right: method("a", "length"), type: BOOL, loc },
    update: {
      kind: "assign",
      localId: "i",
      value: { kind: "bin", op: "+", left: ref("i"), right: num(1), type: F64, loc },
      loc,
    },
    body,
  };
}
const shape: DenseLoopShape = {
  counter: "i",
  length: arr("a"),
  range: { min: 0, max: 4294967294 },
};
const match = (body: IrStmt[], initialized = new Set(["a", "b"])) =>
  matchDenseArrayLoop(loop(body), shape, locals, new Set(), initialized);

test("arrays indexed at the counter of a length-preserving loop get an int32 fast copy", () => {
  const scale = write("b", {
    kind: "bin",
    op: "*",
    left: read("a"),
    right: num(2),
    type: F64,
    loc,
  });
  const dense = match([scale]);
  expect([...dense!.arrays.keys()].sort()).toEqual(["a", "b"]);
  expect(dense!.range).toEqual({ min: 0, max: 2147483646 });
  // A binding not definitely assigned before the loop is not read by the guard.
  expect([...match([scale], new Set())!.arrays.keys()]).toEqual(["a"]);
});

test("loops that may resize, rebind or move storage keep the ordinary copy only", () => {
  expect(match([{ kind: "exprStmt", expr: method("a", "push", [num(1)]), loc }])).toBeNull();
  expect(match([write("a", num(0), ref("unknown"))])).toBeNull();
  expect(
    match([
      { kind: "exprStmt", expr: { kind: "call", callee: "f", args: [], type: F64, loc }, loc },
    ]),
  ).toBeNull();
  // A nested loop would be duplicated too.
  expect(match([{ kind: "exprStmt", expr: read("a"), loc }, loop([])])).toBeNull();
  // No access at the counter: nothing to prove.
  expect(match([{ kind: "exprStmt", expr: read("a", num(0)), loc }])).toBeNull();
  // Copying the bounding array into another binding lets it escape.
  expect(
    match([
      { kind: "exprStmt", expr: read("a"), loc },
      { kind: "assign", localId: "b", value: arr("a"), loc },
    ]),
  ).toBeNull();
  // A rebound array is not covered, but the bounding array still is.
  const rebound = match([
    { kind: "exprStmt", expr: read("b"), loc },
    { kind: "exprStmt", expr: read("a"), loc },
    { kind: "assign", localId: "b", value: arr("c"), loc },
  ]);
  expect([...rebound!.arrays.keys()]).toEqual(["a"]);
});

const counted = (
  fields: Pick<IntegerCountedForLoop, "start" | "limit" | "step" | "inclusive" | "range">,
): IntegerCountedForLoop => ({
  localId: "i",
  guarded: false,
  limitGuarded: false,
  startGuarded: false,
  startBound: Number.MAX_SAFE_INTEGER,
  guardLimit: 0,
  followers: [],
  ...fields,
});

test("counted shapes need a non-negative counter strictly below the length", () => {
  const ascending = (limit: IrExpr, inclusive: boolean, min = 0) =>
    countedDenseShape(
      loop([]),
      counted({ start: num(min), limit, step: 1, inclusive, range: { min, max: 100 } }),
    );
  const minus = (offset: number): IrExpr => ({
    kind: "bin",
    op: "-",
    left: method("a", "length"),
    right: num(offset),
    type: F64,
    loc,
  });
  expect(ascending(method("a", "length"), false)?.length?.localId).toBe("a");
  expect(ascending(minus(1), true)?.length?.localId).toBe("a");
  expect(ascending(method("a", "length"), true)).toBeNull();
  expect(ascending(minus(1), false, -1)).toBeNull();
  // Another invariant limit bounds the counter itself; the entry test
  // compares it with every indexed array's hole-free prefix.
  const limited = ascending(ref("n"), false);
  expect(limited?.length).toBeNull();
  expect(limited?.limit?.limit).toEqual(ref("n"));
  expect(ascending(ref("n"), false, -1)).toBeNull();
  const descending = (offset: number) =>
    countedDenseShape(
      loop([]),
      counted({
        start: minus(offset),
        limit: num(0),
        step: -1,
        inclusive: true,
        range: { min: 0, max: 100 },
      }),
    );
  expect(descending(1)?.length?.localId).toBe("a");
  expect(descending(0)).toBeNull();
});

test("a loop to another invariant limit covers each array whose length it keeps", () => {
  const limited: DenseLoopShape = {
    counter: "i",
    length: null,
    limit: counted({
      start: num(0),
      limit: ref("n"),
      step: 1,
      inclusive: false,
      range: { min: 0, max: 100 },
    }),
    range: { min: 0, max: 100 },
  };
  const matchLimited = (body: IrStmt[], unaliased = new Set<string>()) =>
    matchDenseArrayLoop(loop(body), limited, locals, unaliased, new Set(["a", "b"]));
  const copy = write("b", read("a"));
  const dense = matchLimited([copy]);
  expect([...dense!.arrays.keys()].sort()).toEqual(["a", "b"]);
  expect(dense!.length).toBeNull();
  expect(dense!.limit?.limit).toEqual(ref("n"));
  // An array the loop may resize is not covered; neither is one it may
  // share storage with.
  const resizing = [
    { kind: "exprStmt" as const, expr: read("a"), loc },
    { kind: "exprStmt" as const, expr: method("b", "getNumber", [ref("i")]), loc },
    { kind: "exprStmt" as const, expr: method("b", "push", [num(1)]), loc },
  ];
  expect([...matchLimited(resizing, new Set(["b"]))!.arrays.keys()]).toEqual(["a"]);
  expect(matchLimited(resizing)).toBeNull();
});

test("a two-counter loop covers the arrays indexed at either counter", () => {
  // for (let i = 1, j = k - 1; i < j; i++, j--) { t = a[i]; a[i] = a[j]; a[j] = t; }
  const paired: IntegerPairedForLoop = {
    low: { localId: "i", start: num(1), step: 1, startGuarded: false },
    high: { localId: "j", start: ref("k"), step: -1, startGuarded: true },
    inclusive: false,
    guarded: true,
    range: { min: -Number.MAX_SAFE_INTEGER, max: Number.MAX_SAFE_INTEGER },
  };
  const pairedShape = pairedDenseShape(paired);
  const matchPaired = (body: IrStmt[]) =>
    matchDenseArrayLoop(loop(body), pairedShape, locals, new Set(), new Set(["a", "b"]));
  const swap: IrStmt[] = [
    { kind: "varDecl", localId: "t", init: read("a"), loc },
    write("a", read("a", ref("j"))),
    write("a", ref("t"), ref("j")),
  ];
  const dense = matchPaired(swap);
  expect([...dense!.arrays.keys()]).toEqual(["a"]);
  expect(dense!.pair).toEqual({ high: "j", lowStart: num(1), highStart: ref("k") });
  expect(dense!.range).toEqual({ min: 0, max: 2147483646 });
  // Stores at any other index may extend the array.
  expect(matchPaired([...swap, write("a", num(0), ref("k"))])).toBeNull();
});

test("a present-undefined store is covered only where it stores a covered read's missing arm", () => {
  // const v = b[i] (as number | undefined);
  // if (v is undefined) c[i] = undefined; else c[i] = v is number ? v : throw;
  const unionType = { kind: "union" as const, unionId: "u" };
  const v: IrExpr = { kind: "varRef", localId: "v", type: unionType, loc };
  const isTag = (tag: number): IrExpr => ({
    kind: "unionIsTag",
    unionId: "u",
    tag,
    negated: false,
    value: v,
    type: BOOL,
    loc,
  });
  const reader = (array: string, index = ref("i")): IrExpr => ({
    kind: "call",
    callee: "%arr.idxOr.f64",
    args: [arr(array), index],
    type: unionType,
    loc,
  });
  const undefinedStore: IrStmt = { kind: "arraySetUndefined", arr: arr("c"), index: ref("i"), loc };
  const guarded = (array: string): IrStmt[] => [
    { kind: "varDecl", localId: "v", init: reader(array), loc },
    {
      kind: "if",
      cond: isTag(1),
      then: [undefinedStore],
      else_: [
        write("c", {
          kind: "ternary",
          cond: isTag(0),
          then: { kind: "unionNarrow", unionId: "u", tag: 0, value: v, type: F64, loc },
          else_: {
            kind: "libCall",
            fn: "error.nodeThrow",
            args: [num(1), { kind: "strLit", value: "", type: { kind: "string" }, loc }],
            type: F64,
            loc,
          },
          type: F64,
          loc,
        }),
      ],
      loc,
    },
  ];
  const withV = new Map([
    ...locals,
    ["v", { id: "v", name: "v", type: unionType, mutable: false }],
  ]);
  const matchStores = (body: IrStmt[], initialized: string[]) =>
    matchDenseArrayLoop(loop(body), shape, withV, new Set(), new Set(initialized));
  const dense = matchStores(guarded("b"), ["a", "b", "c"]);
  expect([...dense!.arrays.keys()].sort()).toEqual(["b", "c"]);
  // A read of an array the entry test does not cover may miss in the fast
  // copy, and its undefined store would run there.
  expect(matchStores(guarded("b"), ["a", "c"])).toBeNull();
  // A present undefined stored on its own leaves out its array and every
  // array the other name may hold.
  const alone: IrStmt[] = [{ kind: "exprStmt", expr: read("b"), loc }, undefinedStore];
  expect(matchStores(alone, ["a", "b", "c"])).toBeNull();
  const separate = matchDenseArrayLoop(
    loop(alone),
    shape,
    withV,
    new Set(["c"]),
    new Set(["a", "b", "c"]),
  );
  expect([...separate!.arrays.keys()]).toEqual(["b"]);
});
