import { expect, test } from "vitest";
import {
  BOOL,
  F64,
  funcOf,
  type IrExpr,
  type IrFunction,
  type IrLocal,
  type IrStmt,
  type IrType,
} from "../../ir/ir.js";
import { ValueCaptures } from "./value-captures.js";

const loc = { file: "values.ts", start: 0, end: 0 };
const record: IrType = { kind: "record", shapeId: "options" };
const fnType = funcOf([], F64);
const ref = (localId: string, type: IrType = record): IrExpr => ({
  kind: "varRef",
  localId,
  type,
  loc,
});
const closure = (fnName: string, captures: string[], adapts = false): IrExpr => ({
  kind: "closure",
  fnName,
  captures,
  type: fnType,
  loc,
  ...(adapts ? { adapts: true as const } : {}),
});
const use = (expr: IrExpr): IrStmt => ({ kind: "exprStmt", expr, loc });
const declare = (localId: string, init: IrExpr | null): IrStmt => ({
  kind: "varDecl",
  localId,
  init,
  loc,
});
const assign = (localId: string, value: IrExpr): IrStmt => ({
  kind: "assign",
  localId,
  value,
  loc,
});
const boxed = (id: string, type: IrType = record, extra: Partial<IrLocal> = {}): IrLocal => ({
  id,
  name: id,
  type,
  mutable: true,
  boxed: true,
  ...extra,
});

function outer(locals: IrLocal[], body: IrStmt[], extra: Partial<IrFunction> = {}): IrFunction {
  return { name: "outer", params: [], returnType: F64, locals, body, loc, ...extra };
}
function lifted(
  name: string,
  captures: string[],
  body: IrStmt[] = [],
  extra: Partial<IrFunction> = {},
  type: IrType = record,
): IrFunction {
  return {
    name,
    params: [],
    returnType: F64,
    captures: captures.map((id) => ({ localId: id, name: id, type })),
    locals: captures.map((id) => boxed(id, type)),
    body,
    loc,
    ...extra,
  };
}
function analyze(...functions: IrFunction[]): ValueCaptures {
  return new ValueCaptures(new Map(functions.map((fn) => [fn.name, fn])), true);
}
const slots = (values: ValueCaptures, name: string): number[] => [...values.slots(name)].sort();

test("a binding declared once before its closure is captured by value and loses its box", () => {
  const fn = outer([boxed("x")], [declare("x", ref("p")), use(closure("reader", ["x"]))]);
  const values = analyze(fn, lifted("reader", ["x"]));
  expect(slots(values, "reader")).toEqual([0]);
  expect([...values.plain(fn)]).toEqual(["x"]);
  expect(values.layout("reader")).toEqual({
    boxes: 0,
    references: [record],
    scalars: [],
    slots: [{ kind: "reference", index: 0 }],
  });
});

test("a rebinding anywhere along the capture chain keeps the box", () => {
  const reader = lifted("reader", ["x"]);
  const declared = [declare("x", ref("p")), use(closure("reader", ["x"]))];
  expect(
    slots(analyze(outer([boxed("x")], [...declared, assign("x", ref("p"))]), reader), "reader"),
  ).toEqual([]);
  const writer = lifted("reader", ["x"], [assign("x", ref("x"))]);
  expect(slots(analyze(outer([boxed("x")], declared), writer), "reader")).toEqual([]);
  // Two closures down.
  const middle = lifted("reader", ["x"], [use(closure("inner", ["x"]))]);
  const quiet = lifted("inner", ["x"]);
  const loud = lifted("inner", ["x"], [assign("x", ref("x"))]);
  const fn = outer([boxed("x")], declared);
  expect(slots(analyze(fn, middle, quiet), "inner")).toEqual([0]);
  expect(slots(analyze(fn, middle, loud), "reader")).toEqual([]);
  expect(slots(analyze(fn, middle, loud), "inner")).toEqual([]);
});

test("a closure created inside the initializer, or before the fill, keeps the box", () => {
  const reader = lifted("reader", ["x"]);
  // `const x = make(() => x)`.
  const inside = outer([boxed("x")], [declare("x", closure("reader", ["x"]))]);
  expect(slots(analyze(inside, reader), "reader")).toEqual([]);
  expect(analyze(inside, reader).plain(inside).size).toBe(0);
  // Mutually recursive declarations: `a` is created before `b` is assigned.
  const fn = outer(
    [boxed("a", fnType), boxed("b", fnType)],
    [
      declare("a", null),
      declare("b", null),
      assign("a", closure("fa", ["b"])),
      assign("b", closure("fb", ["a"])),
      use(closure("both", ["a", "b"])),
    ],
  );
  const values = analyze(
    fn,
    lifted("fa", ["b"], [], {}, fnType),
    lifted("fb", ["a"], [], {}, fnType),
    lifted("both", ["a", "b"], [], {}, fnType),
  );
  expect(slots(values, "fa")).toEqual([]);
  expect(slots(values, "fb")).toEqual([0]);
  expect(slots(values, "both")).toEqual([0, 1]);
  // `b` still has a box for `fa`; `a` has none.
  expect([...values.plain(fn)]).toEqual(["a"]);
});

test("temporal-dead-zone bindings, class captures and adapters keep their boxes", () => {
  const reader = lifted("reader", ["x"]);
  const body = [declare("x", ref("p")), use(closure("reader", ["x"]))];
  expect(
    slots(analyze(outer([boxed("x", record, { tdz: true })], body), reader), "reader"),
  ).toEqual([]);
  const classRef: IrExpr = {
    kind: "classRef",
    className: "C",
    type: { kind: "classval", className: "C" } as IrType,
    loc,
    captures: ["x"],
  };
  expect(slots(analyze(outer([boxed("x")], [...body, use(classRef)]), reader), "reader")).toEqual(
    [],
  );
  const adapter = outer(
    [boxed("x")],
    [declare("x", ref("p")), use(closure("reader", ["x"], true))],
  );
  expect(slots(analyze(adapter, reader), "reader")).toEqual([]);
});

test("a declaration a switch can skip is not a source", () => {
  const fn = outer(
    [boxed("x")],
    [
      {
        kind: "switch",
        disc: ref("k", F64),
        cases: [
          { test: ref("k", F64), body: [declare("x", ref("p")), use(closure("reader", ["x"]))] },
          { test: null, body: [use(closure("reader", ["x"]))] },
        ],
        loc,
      } as IrStmt,
    ],
  );
  expect(slots(analyze(fn, lifted("reader", ["x"])), "reader")).toEqual([]);
});

test("a loop counter rebound only by its update clause is copied by closures in the body", () => {
  const counter = boxed("i", F64);
  const update = assign("i", ref("i", F64));
  const loop = (body: IrStmt[], extra: Partial<IrStmt & { kind: "for" }> = {}): IrStmt => ({
    kind: "for",
    init: declare("i", ref("z", F64)),
    cond: null,
    update,
    body,
    loc,
    ...extra,
  });
  const reader = lifted("reader", ["i"], [], {}, F64);
  const plain = outer([counter], [loop([use(closure("reader", ["i"]))])]);
  const values = analyze(plain, reader);
  expect(slots(values, "reader")).toEqual([0]);
  expect([...values.plain(plain)]).toEqual(["i"]);
  expect(values.layout("reader")!.slots).toEqual([{ kind: "f64", index: 0 }]);
  // The body writes the counter after creating the closure.
  const written = outer([counter], [loop([use(closure("reader", ["i"])), update])]);
  expect(slots(analyze(written, reader), "reader")).toEqual([]);
  // A closure in the update clause sees the next iteration's binding.
  const inUpdate = outer([counter], [loop([], { update: assign("i", closure("reader", ["i"])) })]);
  expect(slots(analyze(inUpdate, reader), "reader")).toEqual([]);
});

test("parameters, nested captures and mixed environments", () => {
  const fn = outer(
    [boxed("p"), boxed("flag", BOOL), boxed("count", F64)],
    [assign("count", ref("count", F64)), use(closure("middle", ["count", "p", "flag"]))],
    {
      params: [
        { localId: "p", name: "p", type: record },
        { localId: "flag", name: "flag", type: BOOL },
      ],
    },
  );
  const middle: IrFunction = {
    name: "middle",
    params: [],
    returnType: F64,
    captures: [
      { localId: "count", name: "count", type: F64 },
      { localId: "p", name: "p", type: record },
      { localId: "flag", name: "flag", type: BOOL },
    ],
    locals: [boxed("count", F64), boxed("p"), boxed("flag", BOOL)],
    body: [use(closure("inner", ["p"])), use(closure("adapter", ["p"], true))],
    loc,
  };
  const values = analyze(fn, middle, lifted("inner", ["p"]), lifted("adapter", ["p"]));
  expect(slots(values, "middle")).toEqual([1, 2]);
  expect(values.layout("middle")).toEqual({
    boxes: 1,
    references: [record],
    scalars: ["i8"],
    slots: [
      { kind: "box", index: 0 },
      { kind: "reference", index: 0 },
      { kind: "bool", index: 0 },
    ],
  });
  expect(slots(values, "inner")).toEqual([0]);
  // The adapter needs a box made from the value `middle` received.
  expect(values.boxedOnDemand(middle)).toEqual(["p"]);
  expect([...values.plain(fn)].sort()).toEqual(["flag", "p"]);
});

test("a jsval twin shares its closure's environment, and debug builds keep every box", () => {
  const fn = outer([boxed("x")], [declare("x", ref("p")), use(closure("reader", ["x"]))]);
  const reader = lifted("reader", ["x"], [], { jsEntry: "reader%js" });
  const twin = lifted("reader%js", ["x"]);
  expect(slots(analyze(fn, reader, twin), "reader%js")).toEqual([0]);
  const writingTwin = lifted("reader%js", ["x"], [assign("x", ref("x"))]);
  expect(slots(analyze(fn, reader, writingTwin), "reader")).toEqual([]);
  const debug = new ValueCaptures(new Map([fn, reader].map((f) => [f.name, f])), false);
  expect(debug.slots("reader").size).toBe(0);
  expect(debug.plain(fn).size).toBe(0);
});
