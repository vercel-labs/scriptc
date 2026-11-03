/* The lane planner's rules: which loops get a plan, which keep their scalar
 * form, and the facts a plan records. The emitter half is in
 * backend/llvm/lanes.test.ts and the differential half is
 * tests/harness/lane-loops.test.ts. */
import { expect, test } from "vitest";
import { type LanePlan, laneShapesKeyParts, parseLaneShapes, planLaneLoops } from "./lane-plans.js";
import {
  BOOL,
  F64,
  type IrBytesElem,
  type IrExpr,
  type IrFunction,
  type IrLocal,
  type IrStmt,
  type IrType,
  arrayOf,
} from "./ir.js";

const loc = { file: "lane-plans.test.ts", start: 0, end: 0 };
const ALL = new Set(["sum", "count"] as const);

const bytes = (elem: IrBytesElem): IrType => ({ kind: "bytes", elem });
const num = (value: number): IrExpr => ({ kind: "numLit", value, type: F64, loc });
const ref = (localId: string, type: IrType = F64): IrExpr => ({
  kind: "varRef",
  localId,
  type,
  loc,
});
const get = (receiver: IrExpr, index: IrExpr): IrExpr => ({
  kind: "bytesIntrinsic",
  method: "get",
  receiver,
  args: [index],
  type: F64,
  loc,
  invalidNaN: true,
});
const lengthOf = (receiver: IrExpr): IrExpr => ({
  kind: "bytesIntrinsic",
  method: "length",
  receiver,
  args: [],
  type: F64,
  loc,
});
const bin = (
  op: Extract<IrExpr, { kind: "bin" }>["op"],
  left: IrExpr,
  right: IrExpr,
  type: IrType = F64,
): IrExpr => ({
  kind: "bin",
  op,
  left,
  right,
  type,
  loc,
});
const assign = (localId: string, value: IrExpr): IrStmt => ({
  kind: "assign",
  localId,
  value,
  loc,
});
const decl = (localId: string, init: IrExpr | null): IrStmt => ({
  kind: "varDecl",
  localId,
  init,
  loc,
});

/** `for (let i = 0; i < a.length; i++) body` over `receiver`. */
function countedLoop(
  receiver: string,
  body: IrStmt[],
  start = 0,
  elem: IrBytesElem = "u32",
): IrStmt {
  const read = ref(receiver, bytes(elem));
  return {
    kind: "for",
    init: decl("i", num(start)),
    cond: bin("<", ref("i"), lengthOf(read), BOOL),
    update: assign("i", bin("+", ref("i"), num(1))),
    body,
    loc,
  };
}

const sumBody = (receiver = "a", elem: IrBytesElem = "u32"): IrStmt[] => [
  assign("t", bin("+", ref("t"), get(ref(receiver, bytes(elem)), ref("i")))),
];

const countBody = (limit: IrExpr, receiver = "a", elem: IrBytesElem = "u32"): IrStmt[] => [
  {
    kind: "if",
    cond: bin(">=", get(ref(receiver, bytes(elem)), ref("i")), limit, BOOL),
    then: [assign("c", bin("+", ref("c"), num(1)))],
    else_: null,
    loc,
  },
];

function fn(
  body: IrStmt[],
  extra: IrLocal[] = [],
  elem: IrBytesElem = "u32",
): { fn: IrFunction; locals: Map<string, IrLocal> } {
  const locals = new Map<string, IrLocal>([
    ["i", { id: "i", name: "i", type: F64, mutable: true }],
    ["t", { id: "t", name: "t", type: F64, mutable: true }],
    ["c", { id: "c", name: "c", type: F64, mutable: true }],
    ["a", { id: "a", name: "a", type: bytes(elem), mutable: false }],
    ...extra.map((l) => [l.id, l] as const),
  ]);
  return {
    fn: { name: "probe", params: [], returnType: F64, body, locals: [...locals.values()], loc },
    locals,
  };
}

function plan(
  body: IrStmt[],
  shapes: ReadonlySet<"sum" | "count"> = ALL,
  elem: IrBytesElem = "u32",
): LanePlan | undefined {
  const { fn: f, locals } = fn(body, [], elem);
  const plans = planLaneLoops(f, locals, shapes);
  return [...plans.values()][0];
}

const sumLoop = (start = 0, elem: IrBytesElem = "u32"): IrStmt[] => [
  decl("t", num(0)),
  countedLoop("a", sumBody("a", elem), start, elem),
];

test("a typed-array sum gets a sum plan", () => {
  expect(plan(sumLoop())).toEqual({
    shape: "sum",
    induction: "i",
    receiver: "a",
    elem: "u32",
    accumulator: "t",
    lengthBound: 2 ** 21,
  });
});

test("the element type picks the length bound that keeps the sum exact", () => {
  const bounds: [IrBytesElem, number][] = [
    ["u8", 2 ** 45],
    ["u8c", 2 ** 45],
    ["i8", 2 ** 46],
    ["u16", 2 ** 37],
    ["i16", 2 ** 38],
    ["u32", 2 ** 21],
    ["i32", 2 ** 22],
  ];
  for (const [elem, bound] of bounds) {
    const p = plan(sumLoop(0, elem), ALL, elem);
    expect(p?.shape).toBe("sum");
    expect(p?.shape === "sum" && p.lengthBound).toBe(bound);
  }
});

test("either operand order of the accumulator and the element match", () => {
  const reversed = [
    decl("t", num(0)),
    countedLoop("a", [assign("t", bin("+", get(ref("a", bytes("u32")), ref("i")), ref("t")))]),
  ];
  expect(plan(reversed)?.shape).toBe("sum");
});

test("a typed-array count gets a count plan with its element test", () => {
  const p = plan([decl("c", num(0)), countedLoop("a", countBody(num(3)))]);
  expect(p).toMatchObject({
    shape: "count",
    induction: "i",
    receiver: "a",
    accumulator: "c",
    compare: { op: ">=" },
  });
});

test("a count whose element sits on the right flips the test", () => {
  const flipped = [
    decl("c", num(0)),
    countedLoop("a", [
      {
        kind: "if",
        cond: bin("<", num(3), get(ref("a", bytes("u32")), ref("i")), BOOL),
        then: [assign("c", bin("+", ref("c"), num(1)))],
        else_: null,
        loc,
      },
    ]),
  ];
  expect(plan(flipped)).toMatchObject({ shape: "count", compare: { op: ">" } });
});

test("a float element has no lane plan", () => {
  for (const elem of ["f16", "f32", "f64"] as IrBytesElem[])
    expect(plan(sumLoop(0, elem), ALL, elem)).toBeUndefined();
});

test("the shapes the environment names decide which plans exist", () => {
  const body = [
    decl("t", num(0)),
    decl("c", num(0)),
    countedLoop("a", sumBody()),
    countedLoop("a", countBody(num(3))),
  ];
  const { fn: f, locals } = fn(body);
  expect(planLaneLoops(f, locals, new Set(["sum"])).size).toBe(1);
  expect(planLaneLoops(f, locals, new Set(["count"])).size).toBe(1);
  expect(planLaneLoops(f, locals, new Set(["sum", "count"])).size).toBe(2);
  expect(planLaneLoops(f, locals, new Set()).size).toBe(0);
});

test("the accumulator must be declared as the literal +0", () => {
  expect(plan([decl("t", num(1)), countedLoop("a", sumBody())])).toBeUndefined();
  expect(plan([decl("t", num(-0)), countedLoop("a", sumBody())])).toBeUndefined();
  expect(plan([decl("t", null), countedLoop("a", sumBody())])).toBeUndefined();
  expect(plan([decl("t", ref("other")), countedLoop("a", sumBody())])).toBeUndefined();
});

test("the accumulator must be a mutable unboxed number", () => {
  const shapes: IrLocal[] = [
    { id: "t", name: "t", type: BOOL, mutable: true },
    { id: "t", name: "t", type: F64, mutable: false },
    { id: "t", name: "t", type: F64, mutable: true, boxed: true },
    { id: "t", name: "t", type: F64, mutable: true, tdz: true },
  ];
  for (const local of shapes) {
    const { fn: f, locals } = fn([decl("t", num(0)), countedLoop("a", sumBody())], [local]);
    expect(planLaneLoops(f, locals, ALL).size).toBe(0);
  }
});

test("a write between the declaration and the loop keeps the scalar form", () => {
  const body = [decl("t", num(0)), assign("t", num(5)), countedLoop("a", sumBody())];
  expect(plan(body)).toBeUndefined();
});

test("the declaration must come before the loop", () => {
  const loop = countedLoop("a", sumBody());
  expect(plan([loop, decl("t", num(0))])).toBeUndefined();
});

test("versioning puts the loop in a branch; the declaration may stay outside it", () => {
  const body = [
    decl("t", num(0)),
    {
      kind: "if" as const,
      cond: bin("===", ref("tag"), num(0), BOOL),
      then: [decl("arm", ref("a", bytes("u32"))), countedLoop("arm", sumBody("arm"))],
      else_: null,
      loc,
    },
  ];
  const { fn: f, locals } = fn(body, [
    { id: "arm", name: "arm", type: bytes("u32"), mutable: false },
    { id: "tag", name: "tag", type: F64, mutable: false },
  ]);
  expect([...planLaneLoops(f, locals, ALL).values()]).toMatchObject([
    { shape: "sum", receiver: "arm" },
  ]);
});

test("a loop re-entered by an outer loop needs the declaration inside that loop", () => {
  const inner = countedLoop("a", sumBody());
  const outer = (body: IrStmt[]): IrStmt => ({
    kind: "for",
    init: decl("k", num(0)),
    cond: bin("<", ref("k"), num(2), BOOL),
    update: assign("k", bin("+", ref("k"), num(1))),
    body,
    loc,
  });
  const { fn: outside, locals } = fn([decl("t", num(0)), outer([inner])]);
  expect(planLaneLoops(outside, locals, ALL).size).toBe(0);
  const { fn: inside, locals: insideLocals } = fn([outer([decl("t", num(0)), inner])]);
  expect(planLaneLoops(inside, insideLocals, ALL).size).toBe(1);
});

test("the body must be exactly one shape", () => {
  const extra = [decl("t", num(0)), countedLoop("a", [...sumBody(), assign("x", num(1))])];
  expect(plan(extra)).toBeUndefined();
  const doubled = [decl("t", num(0)), countedLoop("a", [assign("t", bin("*", ref("t"), num(2)))])];
  expect(plan(doubled)).toBeUndefined();
  const other = [
    decl("t", num(0)),
    countedLoop("a", [assign("t", get(ref("a", bytes("u32")), ref("i")))]),
  ];
  expect(plan(other)).toBeUndefined();
});

test("a count needs a limit the entry can evaluate once", () => {
  const dependent = [
    decl("c", num(0)),
    countedLoop("a", countBody(get(ref("a", bytes("u32")), ref("i")))),
  ];
  expect(plan(dependent)).toBeUndefined();
  const fromLocal = [
    decl("c", num(0)),
    decl("limit", num(3)),
    countedLoop("a", countBody(ref("limit"))),
  ];
  expect(plan(fromLocal)).toMatchObject({ shape: "count" });
});

test("a count's branch must not have an else", () => {
  const withElse = [
    decl("c", num(0)),
    countedLoop("a", [
      {
        kind: "if",
        cond: bin(">=", get(ref("a", bytes("u32")), ref("i")), num(3), BOOL),
        then: [assign("c", bin("+", ref("c"), num(1)))],
        else_: [assign("c", num(0))],
        loc,
      },
    ]),
  ];
  expect(plan(withElse)).toBeUndefined();
});

test("the loop must be the canonical typed-array loop", () => {
  // A different initial value, a different comparison, or a receiver that is
  // assigned in the function keeps the scalar form.
  expect(plan([decl("t", num(0)), countedLoop("a", sumBody(), 1)])).toBeUndefined();
  const down = [decl("t", num(0)), countedLoop("a", sumBody())] as IrStmt[];
  (down[1] as Extract<IrStmt, { kind: "for" }>).cond = bin(">", ref("i"), num(0), BOOL);
  expect(plan(down)).toBeUndefined();
});

test("a receiver that is not a typed array has no plan", () => {
  const arr = arrayOf(F64);
  const body = [
    decl("t", num(0)),
    countedLoop("arr", [assign("t", bin("+", ref("t"), get(ref("arr", arr), ref("i"))))]),
  ];
  const { fn: f, locals } = fn(body, [{ id: "arr", name: "arr", type: arr, mutable: false }]);
  expect(planLaneLoops(f, locals, ALL).size).toBe(0);
});

test("SCRIPTC_LANES_PLAN names the shapes", () => {
  expect([...parseLaneShapes(undefined)]).toEqual([]);
  expect([...parseLaneShapes("")]).toEqual([]);
  expect([...parseLaneShapes("sum")]).toEqual(["sum"]);
  expect([...parseLaneShapes(" count , sum ")]).toEqual(["count", "sum"]);
  expect([...parseLaneShapes("all")]).toEqual(["sum", "count"]);
  expect([...parseLaneShapes("sum,nonsense")]).toEqual(["sum"]);
});

test("a build without plans keeps the cache keys it had", () => {
  expect(laneShapesKeyParts(new Set())).toEqual([]);
  expect(laneShapesKeyParts(new Set(["sum", "count"]))).toEqual(["lane-plans-sum+count"]);
});
