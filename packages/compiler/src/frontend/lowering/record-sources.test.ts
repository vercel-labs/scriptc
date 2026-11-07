import { expect, test } from "vitest";
import {
  BOOL,
  DYN,
  F64,
  STRING,
  VOID,
  type IrExpr,
  type IrFunction,
  type IrStmt,
  type IrType,
} from "../../ir/ir.js";
import type { IrLibFn } from "../../ir/builtin-signatures.js";
import { ShapeRegistry } from "../type-mapper.js";
import type { Lowerer } from "./lowerer.js";
import {
  foldRecordSourceTests,
  functionKeepsRecordSources,
  programKeepsRecordSources,
  recordSourceTest,
} from "./record-sources.js";

const loc = { file: "sources.ts", start: 0, end: 1 };

/** A lowerer with a shape table: `Rec` is a closed record (it can keep a
 * source), `Holder` holds one, `Pair` is a tuple (it cannot). */
function fixture() {
  const shapes = new ShapeRegistry();
  const record = (fields: [string, IrType][], tuple = false): IrType & { kind: "record" } => ({
    kind: "record",
    shapeId: shapes.intern(
      fields.map(([name, type]) => ({ name, type })),
      tuple,
    ),
  });
  const rec = record([
    ["a", F64],
    ["b", STRING],
  ]);
  const holder = record([
    ["inner", rec],
    ["n", F64],
  ]);
  const pair = record(
    [
      ["0", STRING],
      ["1", F64],
    ],
    true,
  );
  const lowerer = {
    shapes,
    unions: new Map(),
    dynConvertible: () => true,
  } as unknown as Lowerer;
  const keeps = (...body: IrStmt[]): boolean =>
    functionKeepsRecordSources(lowerer, fn(body), { memo: new Map(), visiting: new Set() });
  return { lowerer, rec, holder, pair, keeps };
}

const fn = (body: IrStmt[], name = "main"): IrFunction => ({
  name,
  params: [],
  returnType: VOID,
  locals: [],
  body,
  loc,
});
const ref = (localId: string, type: IrType): IrExpr => ({ kind: "varRef", localId, type, loc });
const run = (expr: IrExpr): IrStmt => ({ kind: "exprStmt", expr, loc });
const call = (name: IrLibFn, args: IrExpr[], type: IrType): IrExpr => ({
  kind: "libCall",
  fn: name,
  args,
  type,
  loc,
});
const box = (value: IrExpr, liveRef = false): IrExpr => ({
  kind: "dynFrom",
  value,
  ...(liveRef ? { liveRef: true as const } : {}),
  type: DYN,
  loc,
});
const check = (value: IrExpr, type: IrType): IrExpr => ({ kind: "dynCheck", value, type, loc });
/** `record.sourceHas(r) ? <the view's answer> : <the static answer>`. */
const surface = (r: IrExpr, viewAnswer: IrExpr, staticAnswer: IrExpr): IrExpr => ({
  kind: "ternary",
  cond: recordSourceTest(r, loc),
  then: viewAnswer,
  else_: staticAnswer,
  type: staticAnswer.type,
  loc,
});
const keysOf = (view: IrExpr): IrExpr =>
  call("dyn.objKeyStrings", [view], { kind: "array", elem: STRING });
const staticKeys: IrExpr = {
  kind: "arrayLit",
  elems: [],
  type: { kind: "array", elem: STRING },
  loc,
};

test("a checked conversion into a closed record keeps a source", () => {
  const f = fixture();
  expect(f.keeps(run(check(ref("d", DYN), f.rec)))).toBe(true);
  expect(f.keeps(run(check(ref("d", DYN), { kind: "array", elem: f.holder })))).toBe(true);
  expect(f.keeps(run(check(ref("d", DYN), f.pair)))).toBe(false);
  expect(f.keeps(run(check(ref("d", DYN), STRING)))).toBe(false);
});

test("the branch a source test guards does not count", () => {
  const f = fixture();
  const r = ref("r", f.rec);
  // The reflective surface: the view of the record, and a conversion of
  // the view's answer back into a typed value.
  const guarded = surface(r, keysOf(box(r, true)), staticKeys);
  expect(f.keeps(run(guarded))).toBe(false);
  const converting = surface(
    ref("h", f.holder),
    check(call("dyn.objValues", [box(ref("h", f.holder), true)], DYN), {
      kind: "array",
      elem: f.rec,
    }),
    { kind: "arrayLit", elems: [], type: { kind: "array", elem: f.rec }, loc },
  );
  expect(f.keeps(run(converting))).toBe(false);
  // The same box outside the test does.
  expect(f.keeps(run(keysOf(box(r, true))))).toBe(true);
  // A statement form, and a conjunction.
  const guardedIf: IrStmt = {
    kind: "if",
    cond: recordSourceTest(r, loc),
    then: [run(keysOf(box(r, true)))],
    else_: null,
    loc,
  };
  expect(f.keeps(guardedIf)).toBe(false);
  expect(f.keeps({ ...guardedIf, else_: [run(keysOf(box(r, true)))] })).toBe(true);
  const conjunction: IrExpr = {
    kind: "logical",
    op: "&&",
    left: recordSourceTest(r, loc),
    right: call("dyn.hasOwn", [box(r, true), ref("k", STRING)], BOOL),
    type: BOOL,
    loc,
  };
  expect(f.keeps(run(conjunction))).toBe(false);
  expect(f.keeps(run({ ...conjunction, op: "||" } as IrExpr))).toBe(true);
});

test("a typed value handed to untyped code keeps a source when it reaches a closed record", () => {
  const f = fixture();
  expect(f.keeps(run(box(ref("r", f.rec))))).toBe(true);
  expect(f.keeps(run(box(ref("h", f.holder))))).toBe(true);
  expect(f.keeps(run(box(ref("list", { kind: "array", elem: f.rec }))))).toBe(true);
  expect(f.keeps(run(box(ref("m", { kind: "map", key: STRING, value: f.rec }))))).toBe(true);
  expect(f.keeps(run(box(ref("p", { kind: "promise", inner: f.rec }))))).toBe(true);
  // A function untyped code can call with an object of its own.
  expect(f.keeps(run(box(ref("f", { kind: "func", params: [f.rec], ret: VOID }))))).toBe(true);
  expect(f.keeps(run(box(ref("c", { kind: "object", className: "Box" }))))).toBe(true);
  // Values that hold no closed record.
  expect(f.keeps(run(box(ref("s", STRING))))).toBe(false);
  expect(f.keeps(run(box(ref("t", f.pair))))).toBe(false);
  expect(f.keeps(run(box(ref("f", { kind: "func", params: [F64], ret: STRING }))))).toBe(false);
  expect(f.keeps(run(box(ref("e", { kind: "object", className: "%Error" }))))).toBe(false);
});

test("untyped and typed values meeting in one node keep a source", () => {
  const f = fixture();
  // A keyed read answers the field boxed.
  const keyedRead: IrExpr = {
    kind: "recordKeyGet",
    obj: ref("h", f.holder),
    shapeId: f.holder.shapeId,
    key: ref("k", STRING),
    type: DYN,
    loc,
  } as IrExpr;
  expect(f.keeps(run(keyedRead))).toBe(true);
  // A keyed write stores an untyped value into the record.
  const keyedWrite: IrStmt = {
    kind: "recordKeySet",
    obj: ref("h", f.holder),
    shapeId: f.holder.shapeId,
    key: ref("k", STRING),
    value: ref("d", DYN),
    loc,
  } as IrStmt;
  expect(f.keeps(keyedWrite)).toBe(true);
  // A library call that takes both.
  expect(f.keeps(run(call("dyn.assign", [ref("d", DYN), ref("h", f.holder)], DYN)))).toBe(true);
  // Untyped values alone, and typed values alone, do not.
  expect(f.keeps(run(call("dyn.typeof", [ref("d", DYN)], STRING)))).toBe(false);
  expect(f.keeps(run(call("json.stringifyValue", [ref("h", f.holder)], STRING)))).toBe(false);
});

test("a library call that hands back or calls back with a closed record keeps a source", () => {
  const f = fixture();
  expect(
    f.keeps(run(call("fetch.readerRead", [ref("d", DYN)], { kind: "promise", inner: f.rec }))),
  ).toBe(true);
  const callback = ref("cb", { kind: "func", params: [f.rec], ret: VOID });
  expect(f.keeps(run(call("process.onMessage", [callback, ref("once", BOOL)], VOID)))).toBe(true);
  // An always-throwing call only stands in for a value of its node's type,
  // and the compiler's own record operations read typed records.
  expect(f.keeps(run(call("error.nodeThrow", [ref("n", F64)], f.rec)))).toBe(false);
  expect(f.keeps(run(call("record.linkSource", [ref("r", f.rec), ref("n", F64)], f.rec)))).toBe(
    false,
  );
  // The calls that keep a source themselves.
  expect(f.keeps(run(call("record.sourceNote", [ref("r", f.rec), ref("d", DYN)], VOID)))).toBe(
    true,
  );
  expect(f.keeps(run(call("record.sourceShare", [ref("r", f.rec), ref("r", f.rec)], VOID)))).toBe(
    true,
  );
});

test("a thrown value its handler can write into keeps a source", () => {
  const f = fixture();
  const thrown = (type: IrType): IrStmt => ({ kind: "throw", value: ref("e", type), loc });
  expect(f.keeps(thrown({ kind: "object", className: "Failure" }))).toBe(true);
  expect(f.keeps(thrown(f.holder))).toBe(true);
  expect(f.keeps(thrown({ kind: "object", className: "%Error" }))).toBe(false);
  expect(f.keeps(thrown(STRING))).toBe(false);
});

test("the settled answer counts written conversions, unless a source test guards them all", () => {
  const f = fixture();
  const r = ref("r", f.rec);
  const conversion = fn([run(check(ref("d", DYN), f.rec))], "convert");
  const guardedConversion = fn(
    [
      run(
        surface(
          ref("h", f.holder),
          check(call("dyn.objValues", [box(ref("h", f.holder), true)], DYN), {
            kind: "array",
            elem: f.rec,
          }),
          { kind: "arrayLit", elems: [], type: { kind: "array", elem: f.rec }, loc },
        ),
      ),
    ],
    "values",
  );
  const boxing = fn([run(box(r))], "box");
  expect(programKeepsRecordSources(f.lowerer, [conversion])).toBe(true);
  expect(programKeepsRecordSources(f.lowerer, [guardedConversion])).toBe(false);
  // A box alone does not make the answer true: the passes that read it
  // keep keys for the types conversions build. It keeps a true answer from
  // being withdrawn.
  expect(programKeepsRecordSources(f.lowerer, [boxing])).toBe(false);
  expect(programKeepsRecordSources(f.lowerer, [guardedConversion, boxing])).toBe(true);
});

test("the fold removes each test with the branch it guards", () => {
  const f = fixture();
  const r = ref("r", f.rec);
  const view = keysOf(box(r, true));
  const body: IrStmt[] = [
    // `sourceHas(r) ? view : static` becomes the static answer.
    { kind: "varDecl", localId: "keys", init: surface(r, view, staticKeys), loc },
    // `if (sourceHas(r)) return view;` disappears.
    {
      kind: "if",
      cond: recordSourceTest(r, loc),
      then: [{ kind: "return", value: view, loc }],
      else_: null,
      loc,
    },
    // With an else branch, the else statements remain.
    {
      kind: "if",
      cond: recordSourceTest(r, loc),
      then: [run(view)],
      else_: [run(ref("kept", F64))],
      loc,
    },
    // `sourceHas(r) && view-test` is false; `sourceHas(r) || other` is other.
    {
      kind: "return",
      value: {
        kind: "logical",
        op: "&&",
        left: recordSourceTest(r, loc),
        right: call("dyn.hasOwn", [box(r, true), ref("k", STRING)], BOOL),
        type: BOOL,
        loc,
      },
      loc,
    },
    {
      kind: "return",
      value: {
        kind: "logical",
        op: "||",
        left: recordSourceTest(r, loc),
        right: ref("other", BOOL),
        type: BOOL,
        loc,
      },
      loc,
    },
  ];
  const main = fn(body);
  const untouched = fn([run(ref("n", F64))], "other");
  const untouchedBody = untouched.body;
  expect(foldRecordSourceTests(f.lowerer, [main, untouched])).toEqual([f.rec.shapeId]);
  expect(untouched.body).toBe(untouchedBody);
  expect(JSON.stringify(main.body)).not.toContain("record.sourceHas");
  expect(JSON.stringify(main.body)).not.toContain("dynFrom");
  expect(main.body).toEqual([
    { kind: "varDecl", localId: "keys", init: staticKeys, loc },
    { kind: "block", body: [run(ref("kept", F64))], loc },
    { kind: "return", value: { kind: "boolLit", value: false, type: BOOL, loc }, loc },
    { kind: "return", value: ref("other", BOOL), loc },
  ]);
});

test("the fold decides only the branches a removed test guarded", () => {
  const f = fixture();
  const r = ref("r", f.rec);
  const never: IrExpr = { kind: "boolLit", value: false, type: BOOL, loc };
  // A constant condition of the program's own, beside a test.
  const written: IrStmt = {
    kind: "if",
    cond: never,
    then: [run(ref("unreached", F64))],
    else_: null,
    loc,
  };
  const main = fn([written, run(surface(r, keysOf(box(r, true)), staticKeys))]);
  expect(foldRecordSourceTests(f.lowerer, [main])).toEqual([f.rec.shapeId]);
  expect(main.body).toEqual([written, run(staticKeys)]);
});

test("the fold leaves a program that keeps a source, or has no test, as it is", () => {
  const f = fixture();
  const r = ref("r", f.rec);
  const tested = fn([run(surface(r, keysOf(box(r, true)), staticKeys))]);
  const testedBody = tested.body;
  const converting = fn([run(check(ref("d", DYN), f.rec))], "convert");
  expect(foldRecordSourceTests(f.lowerer, [tested, converting])).toBeNull();
  expect(tested.body).toBe(testedBody);
  expect(foldRecordSourceTests(f.lowerer, [fn([run(ref("n", F64))])])).toBeNull();
  // A test of a value that is not a local stays: the fold would lose its
  // evaluation.
  const computed = fn([
    run(
      surface(call("record.linkSource", [r, ref("n", F64)], f.rec), ref("x", F64), ref("y", F64)),
    ),
  ]);
  expect(foldRecordSourceTests(f.lowerer, [computed])).toBeNull();
});
