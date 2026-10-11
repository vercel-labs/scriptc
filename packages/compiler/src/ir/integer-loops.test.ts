import { expect, test } from "vitest";
import { BOOL, F64, arrayOf, type IrExpr, type IrLocal, type IrStmt } from "./ir.js";
import { matchIntegerArrayForLoop, matchIntegerCountedForLoop } from "./integer-loops.js";

const loc = { file: "integer-array-loop.ts", start: 0, end: 0 };
const number = (value: number): IrExpr => ({ kind: "numLit", value, type: F64, loc });
const ref = (localId: string): IrExpr => ({ kind: "varRef", localId, type: F64, loc });
const locals = new Map<string, IrLocal>([
  ["i", { id: "i", name: "i", type: F64, mutable: true }],
  ["a", { id: "a", name: "a", type: arrayOf(F64), mutable: false }],
]);
function loop(start = number(0)): IrStmt & { kind: "for" } {
  return {
    kind: "for",
    loc,
    init: { kind: "varDecl", localId: "i", init: start, loc },
    cond: {
      kind: "bin",
      op: "<",
      left: ref("i"),
      right: {
        kind: "arrIntrinsic",
        method: "length",
        receiver: { kind: "varRef", localId: "a", type: arrayOf(F64), loc },
        args: [],
        type: F64,
        loc,
      },
      type: BOOL,
      loc,
    },
    update: {
      kind: "assign",
      localId: "i",
      value: { kind: "bin", op: "+", left: ref("i"), right: number(1), type: F64, loc },
      loc,
    },
    body: [],
  };
}

test("array length loops and active outer-array induction have exact integer bounds", () => {
  expect(matchIntegerArrayForLoop(loop(), locals, new Set())?.localId).toBe("i");
  const nested = loop({
    kind: "bin",
    op: "+",
    left: ref("outer"),
    right: number(1),
    type: F64,
    loc,
  });
  expect(matchIntegerArrayForLoop(nested, locals, new Set(["outer"]))?.localId).toBe("i");
  expect(matchIntegerArrayForLoop(nested, locals, new Set())).toBeNull();
});

test("negative zero, unknown starts, captured counters and body writes stay floating point", () => {
  for (const start of [number(-0), number(0.5), number(-1), ref("unknown")])
    expect(matchIntegerArrayForLoop(loop(start), locals, new Set())).toBeNull();
  const captured = new Map(locals);
  captured.set("i", { ...locals.get("i")!, boxed: true });
  expect(matchIntegerArrayForLoop(loop(), captured, new Set())).toBeNull();
  const changed = loop();
  changed.body.push({
    kind: "exprStmt",
    expr: { kind: "assignExpr", localId: "i", value: number(0.5), type: F64, loc },
    loc,
  });
  expect(matchIntegerArrayForLoop(changed, locals, new Set())).toBeNull();
});

test("changing the array length does not invalidate integer induction", () => {
  const changed = loop();
  changed.body.push({
    kind: "arraySetLength",
    arr: { kind: "varRef", localId: "a", type: arrayOf(F64), loc },
    length: number(0),
    loc,
  });
  expect(matchIntegerArrayForLoop(changed, locals, new Set())?.localId).toBe("i");
});

function counted(limit: IrExpr = number(4), inclusive = false): IrStmt & { kind: "for" } {
  const s = loop();
  s.cond = {
    kind: "bin",
    op: inclusive ? "<=" : "<",
    left: ref("i"),
    right: limit,
    type: BOOL,
    loc,
  };
  s.body = [
    {
      kind: "exprStmt",
      expr: { kind: "bin", op: "%", left: ref("i"), right: number(3), type: F64, loc },
      loc,
    },
  ];
  return s;
}

test("counted loops normalize finite literal limits and guard stable numeric locals", () => {
  for (const value of [0, -0, -1, 0.5, 4.5, -Infinity, 2 ** 53]) {
    expect(matchIntegerCountedForLoop(counted(number(value)), locals)?.guarded).toBe(false);
  }
  const withLimit = new Map(locals);
  withLimit.set("limit", { id: "limit", name: "limit", type: F64, mutable: true });
  expect(matchIntegerCountedForLoop(counted(ref("limit"), true), withLimit)).toMatchObject({
    localId: "i",
    guarded: true,
    inclusive: true,
  });
  for (const value of [NaN, Infinity, 2 ** 53 + 2])
    expect(matchIntegerCountedForLoop(counted(number(value)), locals)).toBeNull();
  expect(matchIntegerCountedForLoop(counted(number(2 ** 53), true), locals)).toBeNull();
});

test("counted loop proofs reject writes, captures, effectful bounds and signed-zero starts", () => {
  const withLimit = new Map(locals);
  withLimit.set("limit", { id: "limit", name: "limit", type: F64, mutable: true });
  for (const id of ["i", "limit"]) {
    const s = counted(ref("limit"));
    s.body.push({
      kind: "exprStmt",
      expr: { kind: "assignExpr", localId: id, value: number(2), type: F64, loc },
      loc,
    });
    expect(matchIntegerCountedForLoop(s, withLimit)).toBeNull();
    const captured = new Map(withLimit);
    captured.set(id, { ...captured.get(id)!, boxed: true });
    expect(matchIntegerCountedForLoop(counted(ref("limit")), captured)).toBeNull();
  }
  for (const value of [-0, 0.5, Infinity]) {
    const s = counted();
    s.init = { kind: "varDecl", localId: "i", init: number(value), loc };
    expect(matchIntegerCountedForLoop(s, locals)).toBeNull();
  }
  expect(
    matchIntegerCountedForLoop(
      counted({ kind: "incDec", localId: "limit", op: "+", prefix: false, type: F64, loc }),
      withLimit,
    ),
  ).toBeNull();
  expect(matchIntegerCountedForLoop(counted(ref("missing")), withLimit)).toBeNull();
});

test("versioning is bounded and requires an integer consumer", () => {
  const floating = counted();
  floating.body = [
    {
      kind: "exprStmt",
      expr: { kind: "bin", op: "+", left: ref("i"), right: number(0.5), type: F64, loc },
      loc,
    },
  ];
  expect(matchIntegerCountedForLoop(floating, locals)).toBeNull();
  const withLimit = new Map(locals);
  withLimit.set("limit", { id: "limit", name: "limit", type: F64, mutable: true });
  const large = counted(ref("limit"));
  large.body = Array.from({ length: 81 }, () => large.body[0]!);
  expect(matchIntegerCountedForLoop(large, withLimit)).toBeNull();
  const nested = counted(ref("limit"));
  nested.body.push(counted());
  expect(matchIntegerCountedForLoop(nested, withLimit)).toBeNull();
  expect(matchIntegerCountedForLoop(counted(number(4)), locals)?.guarded).toBe(false);
});

test("an unproven start versions the loop on an exact integer start", () => {
  const withStart = new Map(locals);
  withStart.set("start", { id: "start", name: "start", type: F64, mutable: false });
  const s = counted(number(8));
  s.init = { kind: "varDecl", localId: "i", init: ref("start"), loc };
  expect(matchIntegerCountedForLoop(s, withStart)).toMatchObject({
    guarded: true,
    startGuarded: true,
    limitGuarded: false,
    range: { min: -Number.MAX_SAFE_INTEGER, max: 7 },
  });
  // The versioned body is duplicated, so the usual size bound applies.
  const large = counted(number(8));
  large.init = { kind: "varDecl", localId: "i", init: ref("start"), loc };
  large.body = Array.from({ length: 81 }, () => large.body[0]!);
  expect(matchIntegerCountedForLoop(large, withStart)).toBeNull();
});
