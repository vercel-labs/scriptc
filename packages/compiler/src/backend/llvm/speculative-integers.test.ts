import { expect, test } from "vitest";
import { F64, type IrExpr, type IrStmt } from "../../ir/ir.js";
import {
  inlinableNumberFunction,
  isSpeculableValue,
  planProvenIntegerLoop,
  planSpeculativeLoop,
  rewriteSpeculable,
  speculativeReads,
} from "./speculative-integers.js";

const loc = { file: "speculative.ts", start: 0, end: 0 };
const num = (value: number): IrExpr => ({ kind: "numLit", value, type: F64, loc });
const ref = (localId: string): IrExpr => ({ kind: "varRef", localId, type: F64, loc });
const bin = (op: "+" | "-" | "*" | "/" | "%" | "<" | "|", left: IrExpr, right: IrExpr): IrExpr => ({
  kind: "bin",
  op,
  left,
  right,
  type: op === "<" ? { kind: "bool" } : F64,
  loc,
});
const assign = (localId: string, value: IrExpr): IrStmt => ({
  kind: "assign",
  localId,
  value,
  loc,
});
const increment = (localId: string): IrStmt => ({
  kind: "exprStmt",
  expr: { kind: "incDec", op: "+", prefix: false, localId, type: F64, loc },
  loc,
});
const loop = (body: IrStmt[], cond: IrExpr = bin("<", ref("i"), ref("n"))): IrStmt => ({
  kind: "while",
  cond,
  body,
  loc,
});
const all = (): boolean => true;

test("integer writes and their loop-invariant inputs are speculated", () => {
  const write = assign(
    "v",
    bin("%", bin("+", bin("*", ref("v"), num(31)), ref("k")), num(1000003)),
  );
  const step = increment("i");
  const plan = planSpeculativeLoop(loop([write, step]) as never, all)!;
  expect(plan.writes).toEqual(new Set([write, step]));
  // `n` (condition) and `k` (write input) are invariant and checked on entry.
  expect([...plan.locals]).toEqual([
    ["v", true],
    ["i", true],
    ["k", true],
    ["n", true],
  ]);
});

test("locals declared in the body need no entry check", () => {
  const declare: IrStmt = { kind: "varDecl", localId: "t", init: bin("*", ref("i"), num(2)), loc };
  const plan = planSpeculativeLoop(
    loop([
      declare,
      assign("s", bin("%", bin("*", ref("s"), ref("t")), num(65521))),
      increment("i"),
    ]) as never,
    all,
  )!;
  expect(plan.locals.get("t")).toBe(false);
  expect(plan.locals.get("s")).toBe(true);
});

test("non-integer, expression-position and ineligible writes keep the double copy", () => {
  expect(isSpeculableValue(bin("/", ref("a"), num(2)))).toBe(false);
  expect(isSpeculableValue(num(0.5))).toBe(false);
  expect(isSpeculableValue(num(-0))).toBe(false);
  expect(isSpeculableValue(bin("|", ref("a"), num(0)))).toBe(true);
  // A fractional write leaves only the counter, which alone is not worth a copy.
  const halves = loop([assign("x", bin("/", ref("x"), num(2))), increment("i")]);
  expect(planSpeculativeLoop(halves as never, all)?.locals.has("x")).toBeFalsy();
  // A write inside a sequence expression cannot restart its statement.
  const sequence: IrStmt = {
    kind: "exprStmt",
    expr: {
      kind: "seqExpr",
      stmts: [assign("v", bin("+", ref("v"), num(1)))],
      result: num(0),
      type: F64,
      loc,
    },
    loc,
  };
  const plan = planSpeculativeLoop(
    loop([sequence, assign("v", bin("+", ref("v"), num(2))), increment("i")]) as never,
    all,
  );
  expect(plan?.locals.has("v")).toBeFalsy();
  expect(
    planSpeculativeLoop(
      loop([assign("v", bin("+", ref("v"), num(2)))]) as never,
      (id) => id !== "v",
    ),
  ).toBeNull();
});

test("accumulators that are only added to keep their double", () => {
  const sum = loop([assign("s", bin("+", ref("s"), bin("%", ref("i"), num(7)))), increment("i")]);
  expect(planSpeculativeLoop(sum as never, all)?.locals.has("s")).toBeFalsy();
});

test("nested loops are left to the inner loop", () => {
  const inner = loop([assign("v", bin("+", ref("v"), num(1)))]);
  expect(planSpeculativeLoop(loop([inner, increment("i")]) as never, all)).toBeNull();
});

test("statically proven locals are never shadowed and leave nothing to duplicate", () => {
  const write = assign(
    "v",
    bin("%", bin("+", bin("*", ref("v"), num(31)), ref("k")), num(1000003)),
  );
  const body = [write, increment("i")];
  // Every read proven: no plan at all.
  expect(
    planSpeculativeLoop(
      loop(body) as never,
      all,
      () => false,
      () => true,
    ),
  ).toBeNull();
  // Only `k` proven: `v` and the counter are shadowed, `k` is not checked.
  const plan = planSpeculativeLoop(
    loop(body) as never,
    all,
    () => false,
    (e) => e.kind === "varRef" && e.localId === "k",
  )!;
  expect(plan.locals.has("v")).toBe(true);
  expect(plan.locals.has("k")).toBe(false);
});

test("heap reads are speculative leaves, read before any check", () => {
  const rows: IrExpr = {
    kind: "varRef",
    localId: "rows",
    type: { kind: "array", elem: F64 },
    loc,
  } as never;
  const element: IrExpr = { kind: "arrayGet", arr: rows, index: ref("i"), type: F64, loc };
  const text: IrExpr = { kind: "varRef", localId: "s", type: { kind: "string" }, loc } as never;
  const code: IrExpr = {
    kind: "strIntrinsic",
    method: "charCodeAt",
    receiver: text,
    args: [ref("i")],
    type: F64,
    loc,
  } as never;
  const value = bin("%", bin("+", bin("*", ref("h"), num(33)), code), num(2147483647));
  expect(isSpeculableValue(value)).toBe(true);
  expect(speculativeReads(bin("+", element, code))).toEqual([element, code]);
  // The ordinary emitter evaluates bitwise operators; heap reads stay out.
  expect(isSpeculableValue(bin("|", code, num(0)))).toBe(false);
  const eligible = (id: string): boolean => id !== "rows" && id !== "s";
  const plan = planSpeculativeLoop(loop([assign("h", value), increment("i")]) as never, eligible)!;
  expect(plan.locals.has("h")).toBe(true);
});

test("invariants may come from bindings no shadow could be written to", () => {
  const write = assign("h", bin("%", bin("+", bin("*", ref("h"), num(33)), ref("i")), ref("m")));
  const body = [write, increment("i")];
  const locals = (id: string): boolean => id !== "m";
  expect(planSpeculativeLoop(loop(body) as never, locals)?.locals.has("h")).toBeFalsy();
  const plan = planSpeculativeLoop(
    loop(body) as never,
    locals,
    () => false,
    () => false,
    all,
  )!;
  expect(plan.locals.get("m")).toBe(true);
  expect(plan.locals.has("h")).toBe(true);
});

test("loops that only count and compare keep one copy", () => {
  const counter = loop([increment("i")]);
  expect(planSpeculativeLoop(counter as never, all)).toBeNull();
  // A product in the condition alone is not.
  const bounded = loop([increment("i")], bin("<", ref("i"), bin("*", ref("n"), ref("scale"))));
  expect(planSpeculativeLoop(bounded as never, all)).toBeNull();
  // A variable step (a sieve's `j += i`) is worth a copy.
  const sieve = loop([assign("i", bin("+", ref("i"), ref("step")))]);
  expect(planSpeculativeLoop(sieve as never, all)?.locals.has("i")).toBe(true);
  const scaled = loop([
    assign("j", bin("+", ref("j"), bin("*", ref("i"), ref("n")))),
    increment("i"),
  ]);
  expect(planSpeculativeLoop(scaled as never, all)?.locals.has("n")).toBe(true);
});

test("bounded cursors with proven writes are shadowed in a proven integer loop", () => {
  // for (i = 0; i < n; i++) { if (a < b) run = run + 1; else run = 0;
  //   if (run > longest) longest = run; }
  const sum = bin("+", ref("run"), num(1));
  const step = assign("run", sum);
  const reset = assign("run", num(0));
  const copy = assign("longest", ref("run"));
  const forLoop = (body: IrStmt[]): IrStmt => ({
    kind: "for",
    init: null,
    cond: bin("<", ref("i"), ref("n")),
    update: assign("i", bin("+", ref("i"), num(1))),
    body,
    loc,
  });
  const branch = (then: IrStmt[], else_: IrStmt[] | null): IrStmt => ({
    kind: "if",
    cond: bin("<", ref("a"), ref("b")),
    then,
    else_,
    loc,
  });
  const body = [branch([step], [reset]), branch([copy], null)];
  const range = { min: 0, max: 100 };
  const cursors = new Map([
    ["run", range],
    ["longest", range],
  ]);
  const plan = planProvenIntegerLoop(forLoop(body) as never, cursors, all, () => false, all)!;
  expect([...plan.locals]).toEqual([
    ["run", range],
    ["longest", range],
  ]);
  expect(plan.writes).toEqual(new Set([step, reset, copy]));
  // A binding the loop does not bound keeps its double.
  const only = planProvenIntegerLoop(
    forLoop(body) as never,
    new Map([["run", range]]),
    all,
    () => false,
    all,
  )!;
  expect([...only.locals.keys()]).toEqual(["run"]);
  // An unproven sum leaves `run` unshadowed, and its copy reads `run`
  // where nothing proves it integral.
  const unproven = (e: IrExpr): boolean => e !== sum && e.kind !== "varRef";
  expect(
    planProvenIntegerLoop(forLoop(body) as never, cursors, all, () => false, unproven),
  ).toBeNull();
  // An expression-position write refuses the binding.
  const inner: IrStmt = {
    kind: "exprStmt",
    expr: { kind: "incDec", op: "+", prefix: false, localId: "longest", type: F64, loc },
    loc,
  };
  expect([
    ...planProvenIntegerLoop(
      forLoop([...body, inner]) as never,
      cursors,
      all,
      () => false,
      all,
    )!.locals.keys(),
  ]).toEqual(["run"]);
  // A labeled jump may leave past the write-back.
  const jump: IrStmt = { kind: "break", label: "outer", loc };
  expect(
    planProvenIntegerLoop(forLoop([...body, jump]) as never, cursors, all, () => false, all),
  ).toBeNull();
});

const libCall = (fn: string, args: IrExpr[]): IrExpr =>
  ({ kind: "libCall", fn, args, type: F64, loc }) as never;
const call = (callee: string, args: IrExpr[]): IrExpr => ({
  kind: "call",
  callee,
  args,
  type: F64,
  loc,
});
const pow2 = (n: IrExpr): IrExpr => libCall("math.pow", [num(2), n]);
/** `function trim(v, n) { return v - Math.floor(v / Math.pow(2, n)) * Math.pow(2, n); }` */
const trim = {
  name: "trim",
  params: [
    { localId: "v", name: "v", type: F64 },
    { localId: "n", name: "n", type: F64 },
  ],
  returnType: F64,
  locals: [],
  body: [
    {
      kind: "return",
      value: bin(
        "-",
        ref("v"),
        bin("*", libCall("math.floor", [bin("/", ref("v"), pow2(ref("n")))]), pow2(ref("n"))),
      ),
      loc,
    },
  ],
  loc,
} as never;

test("calls of small pure number functions expand into a speculated write", () => {
  const inlinable = inlinableNumberFunction(trim)!;
  expect(inlinable.params).toEqual(["v", "n"]);
  const context = { inlinable: (callee: string) => (callee === "trim" ? inlinable : undefined) };
  // key = trim(key, m) * 4 + c
  const value = bin("+", bin("*", call("trim", [ref("key"), ref("m")]), num(4)), ref("c"));
  expect(isSpeculableValue(value)).toBe(false);
  const rewritten = rewriteSpeculable(value, context)!;
  expect(rewritten.leaves).toEqual([]);
  expect(JSON.stringify(rewritten.value)).not.toContain('"call"');
  const write = assign("key", value);
  const plan = planSpeculativeLoop(
    loop([write, increment("i")]) as never,
    all,
    () => false,
    () => false,
    all,
    context,
  )!;
  expect(plan.writes.has(write)).toBe(true);
  expect(plan.values.get(write)).toEqual(rewritten);
  // `m`, an input of the expanded body, is checked on entry with the others.
  expect([...plan.locals.keys()].sort()).toEqual(["c", "i", "key", "m", "n"]);
});

test("Math.floor needs a power-of-two divisor, and expansion pure arguments", () => {
  const context = { inlinable: () => inlinableNumberFunction(trim) };
  expect(rewriteSpeculable(libCall("math.floor", [bin("/", ref("a"), num(8))]), {})).not.toBeNull();
  expect(rewriteSpeculable(libCall("math.floor", [bin("/", ref("a"), num(6))]), {})).toBeNull();
  expect(rewriteSpeculable(libCall("math.floor", [bin("/", ref("a"), ref("b"))]), {})).toBeNull();
  // An argument that is itself a call is evaluated once: no expansion.
  expect(rewriteSpeculable(call("trim", [call("other", []), ref("m")]), context)).toBeNull();
  const effectful = {
    ...(trim as object),
    body: [{ kind: "exprStmt", expr: call("log", []), loc }],
  };
  expect(inlinableNumberFunction(effectful as never)).toBeUndefined();
});

test("other leaves are hoisted only when no call can change the write's locals", () => {
  let next = 0;
  const leafId = (): string => `%leaf.${next++}`;
  const value = bin(
    "%",
    bin("+", bin("*", ref("acc"), num(7)), call("noisy", [ref("i")])),
    num(1000003),
  );
  const hoisted = rewriteSpeculable(value, { unaliased: () => true, leafId })!;
  expect(hoisted.leaves.map((leaf) => leaf.expr)).toEqual([call("noisy", [ref("i")])]);
  expect(rewriteSpeculable(value, { unaliased: (id) => id !== "acc", leafId })).toBeNull();
  // Without leaf ids nothing is hoisted.
  expect(rewriteSpeculable(value, { unaliased: () => true })).toBeNull();
  const write = assign("acc", value);
  const plan = planSpeculativeLoop(
    loop([write, increment("i")]) as never,
    (id) => !id.startsWith("%leaf"),
    () => false,
    () => false,
    (id) => !id.startsWith("%leaf"),
    { unaliased: () => true, leafId },
  )!;
  expect(plan.values.get(write)!.leaves).toHaveLength(1);
  expect([...plan.locals.keys()].some((id) => id.startsWith("%leaf"))).toBe(false);
});
