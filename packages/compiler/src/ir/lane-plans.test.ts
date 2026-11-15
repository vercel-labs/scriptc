/* The lane planner's rules: which loops get a plan, which keep their scalar
 * form, and the facts a plan records. The emitter half is in
 * backend/llvm/lanes.test.ts and the differential half is
 * tests/harness/lane-loops.test.ts. */
import { expect, test } from "vitest";
import {
  type LaneNum,
  type LaneOuterPlan,
  type LanePlan,
  type LaneShape,
  type LaneStorePlan,
  laneShapesKeyParts,
  parseLaneShapes,
  planLaneLoops,
} from "./lane-plans.js";
import {
  BOOL,
  F64,
  type IrBytesElem,
  type IrClassDef,
  type IrExpr,
  type IrFunction,
  type IrLocal,
  type IrParam,
  type IrStmt,
  type IrType,
  arrayOf,
} from "./ir.js";

const loc = { file: "lane-plans.test.ts", start: 0, end: 0 };
const ALL: ReadonlySet<LaneShape> = new Set<LaneShape>(["sum", "count", "store"]);

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
    ["base", { id: "base", name: "base", type: F64, mutable: false }],
    ["factor", { id: "factor", name: "factor", type: F64, mutable: false }],
    ["b", { id: "b", name: "b", type: bytes("u32"), mutable: false }],
    ["v", { id: "v", name: "v", type: F64, mutable: true }],
    ...extra.map((l) => [l.id, l] as const),
  ]);
  return {
    fn: { name: "probe", params: [], returnType: F64, body, locals: [...locals.values()], loc },
    locals,
  };
}

function plan(
  body: IrStmt[],
  shapes: ReadonlySet<LaneShape> = ALL,
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
    container: "bytes",
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

test("a switch case ahead of the loop's own can fall into it and write the accumulator", () => {
  const tag = { id: "tag", name: "tag", type: F64, mutable: false };
  const ahead = (first: IrStmt[]): IrStmt[] => [
    decl("t", num(0)),
    {
      kind: "switch",
      disc: ref("tag"),
      cases: [
        { test: num(0), body: first },
        { test: num(1), body: [countedLoop("a", sumBody())] },
      ],
      loc,
    },
  ];
  const { fn: writes, locals } = fn(ahead([assign("t", num(5))]), [tag]);
  expect(planLaneLoops(writes, locals, ALL).size).toBe(0);
  const { fn: quiet, locals: quietLocals } = fn(ahead([decl("u", num(1))]), [tag]);
  expect([...planLaneLoops(quiet, quietLocals, ALL).values()]).toMatchObject([{ shape: "sum" }]);
});

test("a loop in a catch or finally body sees the writes ahead of it", () => {
  const attempt = (
    tryBody: IrStmt[],
    catchBody: IrStmt[] | null,
    finallyBody: IrStmt[] | null,
  ): IrStmt => ({ kind: "tryCatch", tryBody, catchBody, catchLocalId: "e", finallyBody, loc });
  const writing = [assign("t", num(5))];
  const quiet = [decl("u", num(1))];
  const loop = (): IrStmt => countedLoop("a", sumBody());
  const bodies = (held: IrStmt[]): IrStmt[] => [decl("t", num(0)), ...held];
  // The try body ran, and possibly wrote the accumulator, before the catch
  // or the finally: only a loop in the try body itself starts from +0.
  expect(plan(bodies([attempt(writing, [loop()], null)]))).toBeUndefined();
  expect(plan(bodies([attempt(writing, quiet, [loop()])]))).toBeUndefined();
  expect(plan(bodies([attempt(quiet, writing, [loop()])]))).toBeUndefined();
  expect(plan(bodies([attempt(quiet, [loop()], null)]))).toMatchObject({ shape: "sum" });
  expect(plan(bodies([attempt(quiet, quiet, [loop()])]))).toMatchObject({ shape: "sum" });
  expect(plan(bodies([attempt([loop()], writing, null)]))).toMatchObject({ shape: "sum" });
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

test("a count's limit must not change inside the loop", () => {
  // The entry evaluates the limit once, so a limit that the loop itself
  // writes would be frozen at its starting value: neither the accumulator
  // nor the counter may serve as one.
  const fromAccumulator = [decl("c", num(0)), countedLoop("a", countBody(ref("c")))];
  expect(plan(fromAccumulator)).toBeUndefined();
  const fromInduction = [decl("c", num(0)), countedLoop("a", countBody(ref("i")))];
  expect(plan(fromInduction)).toBeUndefined();
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

const set = (
  receiver: string,
  index: IrExpr,
  value: IrExpr,
  elem: IrBytesElem = "u32",
): IrStmt => ({
  kind: "bytesSet",
  arr: ref(receiver, bytes(elem)),
  index,
  value,
  loc,
});

const storePlanOf = (body: IrStmt[], elem: IrBytesElem = "u32") =>
  plan(body, ALL, elem) as LaneStorePlan | undefined;

test("an elementwise store gets a store plan", () => {
  const fill = countedLoop("a", [set("a", ref("i"), bin("+", ref("base"), ref("i")))]);
  const p = storePlanOf([fill], "u32");
  expect(p).toMatchObject({ shape: "store", induction: "i", receiver: "a", elem: "u32" });
  expect(p?.value).toMatchObject({
    op: "+",
    left: { role: "invariant", expr: { kind: "varRef", localId: "base" } },
    right: { role: "induction", expr: null },
  });
});

test("the stored value may be one temp holding the expression", () => {
  // The IR binds the value to a temp before the store.
  const body = [
    {
      kind: "block" as const,
      body: [decl("v", bin("*", ref("base"), ref("i"))), set("a", ref("i"), ref("v"))],
      loc,
    },
  ];
  expect(storePlanOf([countedLoop("a", body)])).toMatchObject({
    shape: "store",
    value: { op: "*", left: { role: "invariant" }, right: { role: "induction" } },
  });
});

test("a versioned union arm's store is read through the blocks that group it", () => {
  // The union arm pass folds the arm's tag test away, which leaves the store
  // inside a block inside the body's own block: the same shape as an
  // unversioned body, and the same plan.
  const body = [
    {
      kind: "block" as const,
      body: [
        decl("v", bin("*", ref("base"), ref("i"))),
        { kind: "block" as const, body: [set("a", ref("i"), ref("v"))], loc },
      ],
      loc,
    },
  ];
  expect(storePlanOf([countedLoop("a", body)])).toMatchObject({
    shape: "store",
    value: { op: "*", left: { role: "invariant" }, right: { role: "induction" } },
  });
});

test("an element read may be the stored value or one operand", () => {
  const read = get(ref("a", bytes("u32")), ref("i"));
  expect(storePlanOf([countedLoop("a", [set("a", ref("i"), read)])])?.value).toMatchObject({
    role: "element",
  });
  const scaled = bin("*", get(ref("a", bytes("u32")), ref("i")), ref("factor"));
  expect(storePlanOf([countedLoop("a", [set("a", ref("i"), scaled)])])?.value).toMatchObject({
    op: "*",
    left: { role: "element" },
    right: { role: "invariant" },
  });
});

test("a store to a float array and the clamped array get plans", () => {
  expect(
    storePlanOf([countedLoop("a", [set("a", ref("i"), ref("i"), "f64")], 0, "f64")], "f64"),
  ).toMatchObject({ shape: "store", elem: "f64" });
  expect(
    storePlanOf([countedLoop("a", [set("a", ref("i"), ref("i"), "u8c")], 0, "u8c")], "u8c"),
  ).toMatchObject({ shape: "store", elem: "u8c" });
});

test("a store keeps its scalar form when the lane body would need more work", () => {
  const read = (): IrExpr => get(ref("a", bytes("u32")), ref("i"));
  const cases: IrStmt[][] = [
    // Two element reads.
    [countedLoop("a", [set("a", ref("i"), bin("+", read(), read()))])],
    // The induction twice.
    [countedLoop("a", [set("a", ref("i"), bin("+", ref("i"), ref("i")))])],
    // An operator the lanes do not transcribe.
    [countedLoop("a", [set("a", ref("i"), bin("/", ref("base"), ref("i")))])],
    // An element read at another index.
    [countedLoop("a", [set("a", ref("i"), get(ref("a", bytes("u32")), ref("base")))])],
    // A second statement besides the store.
    [
      countedLoop("a", [
        set("a", ref("i"), bin("+", ref("base"), ref("i"))),
        assign("base", num(1)),
      ]),
    ],
    // The write goes to another array than the one that bounds the loop.
    [countedLoop("a", [set("b", ref("i"), bin("+", ref("base"), ref("i")))])],
    // The induction is not the index.
    [countedLoop("a", [set("a", ref("base"), bin("+", ref("base"), ref("i")))])],
  ];
  for (const body of cases) expect(plan(body)).toBeUndefined();
});

const array = (): IrType => arrayOf(F64);
const arrayGet = (receiver: string, index: IrExpr = ref("i")): IrExpr => ({
  kind: "arrayGet",
  arr: ref(receiver, array()),
  index,
  type: F64,
  loc,
});
const number = (receiver: string, index: IrExpr = ref("i")): IrExpr => ({
  kind: "arrIntrinsic",
  method: "getNumber",
  receiver: ref(receiver, array()),
  args: [index],
  type: F64,
  loc,
});
const arraySet = (receiver: string, value: IrExpr): IrStmt => ({
  kind: "arraySet",
  arr: ref(receiver, array()),
  index: ref("i"),
  value,
  loc,
});
/** `for (let i = 0; i < a.length; i++) body` over a dense number array. */
const arrayLoop = (receiver: string, body: IrStmt[]): IrStmt[] => [
  {
    kind: "for",
    init: decl("i", num(0)),
    cond: bin(
      "<",
      ref("i"),
      {
        kind: "arrIntrinsic",
        method: "length",
        receiver: ref(receiver, array()),
        args: [],
        type: F64,
        loc,
      },
      BOOL,
    ),
    update: assign("i", bin("+", ref("i"), num(1))),
    body,
    loc,
  },
];

const DENSE: IrLocal = { id: "a", name: "a", type: array(), mutable: false };

function densePlan(body: IrStmt[], shapes: ReadonlySet<LaneShape> = ALL): LanePlan | undefined {
  const { fn: f, locals } = fn(body, [DENSE]);
  return [...planLaneLoops(f, locals, shapes).values()][0];
}

test("a dense number array's sum and count are planned on its int32 slots", () => {
  // Only the int32 storage holds values an integer sum can be exact over, so
  // the plan names that slot kind and the emitter tests for it at the entry.
  const sum = densePlan([
    decl("t", num(0)),
    ...arrayLoop("a", [assign("t", bin("+", ref("t"), arrayGet("a")))]),
  ]);
  expect(sum).toEqual({
    shape: "sum",
    induction: "i",
    receiver: "a",
    container: "array",
    elem: "i32slot",
    accumulator: "t",
    lengthBound: 2 ** 22,
  });
  const count = densePlan([
    decl("c", num(0)),
    ...arrayLoop("a", [
      {
        kind: "if",
        cond: bin(">=", number("a"), num(3), BOOL),
        then: [assign("c", bin("+", ref("c"), num(1)))],
        else_: null,
        loc,
      },
    ]),
  ]);
  expect(count).toMatchObject({ shape: "count", container: "array", elem: "i32slot" });
});

test("a dense number array's store is planned on its double slots", () => {
  const p = densePlan(arrayLoop("a", [arraySet("a", bin("*", ref("i"), ref("factor")))]));
  expect(p).toMatchObject({
    shape: "store",
    induction: "i",
    receiver: "a",
    container: "array",
    elem: "f64slot",
    value: { op: "*", left: { role: "induction" }, right: { role: "invariant" } },
  });
  expect(densePlan(arrayLoop("a", [arraySet("a", arrayGet("a"))]))).toMatchObject({
    shape: "store",
    value: { role: "element" },
  });
});

test("a dense loop the integer loop matcher refuses has no plan", () => {
  // A loop that starts from an outer counter is not the canonical zero-based
  // form the dense matcher accepts here, and a receiver of another element
  // type is not a number array.
  const nested = arrayLoop("a", [assign("t", bin("+", ref("t"), arrayGet("a")))]);
  const start = decl("i", bin("+", ref("base"), num(1)));
  nested[0] = { ...(nested[0] as IrStmt & { kind: "for" }), init: start };
  expect(densePlan([decl("t", num(0)), ...nested])).toBeUndefined();
  const other = { ...DENSE, type: arrayOf({ kind: "string" } as IrType) };
  const { fn: f, locals } = fn(
    [decl("t", num(0)), ...arrayLoop("a", [assign("t", bin("+", ref("t"), arrayGet("a")))])],
    [other],
  );
  expect(planLaneLoops(f, locals, ALL).size).toBe(0);
});

test("SCRIPTC_LANES_PLAN names the shapes", () => {
  expect([...parseLaneShapes(undefined)]).toEqual([]);
  expect([...parseLaneShapes("")]).toEqual([]);
  expect([...parseLaneShapes("sum")]).toEqual(["sum"]);
  expect([...parseLaneShapes(" count , sum ")]).toEqual(["count", "sum"]);
  expect([...parseLaneShapes("all")]).toEqual(["sum", "count", "store", "outer"]);
  expect([...parseLaneShapes("sum,nonsense")]).toEqual(["sum"]);
});

test("a build without plans keeps the cache keys it had", () => {
  expect(laneShapesKeyParts(new Set())).toEqual([]);
  expect(laneShapesKeyParts(new Set(["sum", "count"]))).toEqual(["lane-plans-sum+count"]);
  expect(laneShapesKeyParts(new Set(["store"]))).toEqual(["lane-plans-store"]);
});

/* Outer rows: a `for` whose body declares the row's own state, runs one
 * inner `while` to that row's own exit, and counts the rows whose test held.
 * The plan records the row's slots, the inner test, the steps in source
 * order, and the trailing count. Everything the lane body may not read keeps
 * the row scalar. */

const OUTER: ReadonlySet<LaneShape> = new Set<LaneShape>(["outer"]);
const objOf = (className: string): IrType => ({ kind: "object", className });
const newOf = (className: string, args: IrExpr[]): IrExpr => ({
  kind: "new",
  className,
  args,
  type: objOf(className),
  loc,
});
const callOf = (callee: string, args: IrExpr[]): IrExpr => ({
  kind: "call",
  callee,
  args,
  type: F64,
  loc,
});
const fieldOf = (objExpr: IrExpr, className: string, field: string): IrExpr => ({
  kind: "fieldGet",
  obj: objExpr,
  className,
  field,
  type: F64,
  loc,
});
const setField = (className: string, objExpr: IrExpr, field: string, value: IrExpr): IrStmt => ({
  kind: "fieldSet",
  className,
  obj: objExpr,
  field,
  value,
  loc,
});
const whileOf = (cond: IrExpr, body: IrStmt[]): IrStmt => ({ kind: "while", cond, body, loc });
const ifOf = (cond: IrExpr, then: IrStmt[]): IrStmt => ({
  kind: "if",
  cond,
  then,
  else_: null,
  loc,
});
const paramOf = (localId: string, type: IrType): IrParam => ({ localId, name: localId, type });
const logical = (op: "&&" | "||", left: IrExpr, right: IrExpr): IrExpr => ({
  kind: "logical",
  op,
  left,
  right,
  type: BOOL,
  loc,
});

const PAIR = "Pair";
const pairType = objOf(PAIR);
const PAIR_CLASS: IrClassDef = {
  name: PAIR,
  methods: ["plus", "times", "norm"],
  fields: [
    { name: "re", type: F64 },
    { name: "im", type: F64 },
  ],
  loc,
};
const field2 = (field: string): IrExpr => fieldOf(ref("self"), PAIR, field);
const product = (left: string, right: string): IrExpr => bin("*", field2(left), field2(right));
const pairCtor: IrFunction = {
  name: "%Pair.constructor",
  params: [paramOf("self", pairType), paramOf("re", F64), paramOf("im", F64)],
  returnType: { kind: "undefinedT" },
  locals: [
    { id: "self", name: "self", type: pairType, mutable: false },
    { id: "re", name: "re", type: F64, mutable: false },
    { id: "im", name: "im", type: F64, mutable: false },
  ],
  body: [
    setField(PAIR, ref("self"), "re", ref("re")),
    setField(PAIR, ref("self"), "im", ref("im")),
  ],
  loc,
};
const pairNorm: IrFunction = {
  name: "%Pair.norm",
  params: [paramOf("self", pairType)],
  returnType: F64,
  locals: [{ id: "self", name: "self", type: pairType, mutable: false }],
  body: [{ kind: "return", value: bin("+", product("re", "re"), product("im", "im")), loc }],
  loc,
};
const pairTimes: IrFunction = {
  name: "%Pair.times",
  params: [paramOf("self", pairType), paramOf("o", pairType)],
  returnType: pairType,
  locals: [
    { id: "self", name: "self", type: pairType, mutable: false },
    { id: "o", name: "o", type: pairType, mutable: false },
  ],
  body: [
    {
      kind: "return",
      value: newOf(PAIR, [
        bin(
          "-",
          bin("*", field2("re"), fieldOf(ref("o"), PAIR, "re")),
          bin("*", field2("im"), fieldOf(ref("o"), PAIR, "im")),
        ),
        bin(
          "+",
          bin("*", field2("re"), fieldOf(ref("o"), PAIR, "im")),
          bin("*", field2("im"), fieldOf(ref("o"), PAIR, "re")),
        ),
      ]),
      loc,
    },
  ],
  loc,
};
const pairFunctions = [pairCtor, pairNorm, pairTimes];

const rowLocals: IrLocal[] = [
  { id: "x", name: "x", type: F64, mutable: true },
  { id: "size", name: "size", type: F64, mutable: false },
  { id: "limit", name: "limit", type: F64, mutable: false },
  { id: "total", name: "total", type: F64, mutable: true },
  { id: "inside", name: "inside", type: F64, mutable: true },
  { id: "c", name: "c", type: pairType, mutable: false },
  { id: "z", name: "z", type: pairType, mutable: true },
  { id: "n", name: "n", type: F64, mutable: true },
  { id: "j", name: "j", type: F64, mutable: true },
];

function rowPlan(
  body: IrStmt[],
  opts: {
    shapes?: ReadonlySet<LaneShape>;
    locals?: IrLocal[];
    classes?: IrClassDef[];
    functions?: IrFunction[];
  } = {},
): LanePlan | undefined {
  const locals = opts.locals ?? rowLocals;
  const f: IrFunction = {
    name: "row",
    params: [],
    returnType: F64,
    body,
    locals,
    loc,
  };
  const plans = planLaneLoops(
    f,
    new Map(locals.map((l) => [l.id, l] as const)),
    opts.shapes ?? OUTER,
    opts.classes ?? [PAIR_CLASS],
    opts.functions ?? pairFunctions,
  );
  return [...plans.values()][0];
}

/** `for (let x = 0; x < bound; x++) body`. */
function row(body: IrStmt[], bound: string = "size"): IrStmt {
  return {
    kind: "for",
    init: decl("x", num(0)),
    cond: bin("<", ref("x"), ref(bound)),
    update: assign("x", bin("+", ref("x"), num(1))),
    body,
    loc,
  };
}

/** The value-object row: the row's constant, a carried instance, the inner
 * test, and the counted rows. */
function rowBody(): IrStmt[] {
  return [
    decl(
      "c",
      newOf(PAIR, [
        bin("-", bin("*", bin("/", ref("x"), ref("size")), num(3)), num(2)),
        ref("limit"),
      ]),
    ),
    decl("z", newOf(PAIR, [num(0), num(0)])),
    decl("n", num(0)),
    whileOf(
      logical(
        "&&",
        bin("<", ref("n"), ref("limit"), BOOL),
        bin("<=", callOf("%Pair.norm", [ref("z")]), num(4), BOOL),
      ),
      [
        assign("z", callOf("%Pair.times", [ref("z"), ref("z")])),
        assign("n", bin("+", ref("n"), num(1))),
      ],
    ),
    ifOf(bin("===", ref("n"), ref("limit"), BOOL), [
      assign("inside", bin("+", ref("inside"), num(1))),
    ]),
  ];
}

const slotName = (v: { id: string; field: string | null }): string =>
  v.field === null ? v.id : `${v.id}.${v.field}`;

test("a value-object row gets an outer plan", () => {
  const p = rowPlan([row(rowBody())]);
  expect(p?.shape).toBe("outer");
  if (p?.shape !== "outer") return;
  expect(p.induction).toBe("x");
  expect(p.bound).toEqual(ref("size"));
  // The row's declarations start every group: the constant's two fields, the
  // carried instance's two, and the inner counter.
  expect(p.initial.map(slotName)).toEqual(["c.re", "c.im", "z.re", "z.im", "n"]);
  // Each inner assignment is a group of its own, so the second one reads what
  // the first stored.
  expect(p.steps.map((v) => `${slotName(v)}@${v.group}`)).toEqual(["z.re@0", "z.im@0", "n@1"]);
  expect(p.tail).toEqual({
    accumulator: "inside",
    test: {
      kind: "cmp",
      op: "===",
      left: { kind: "state", id: "n", field: null },
      right: { kind: "invariant", expr: ref("limit") },
    },
  });
});

test("an inner assignment reads the slots the earlier groups stored", () => {
  const plain = rowBody();
  const loop = plain[3] as IrStmt & { kind: "while" };
  expect(loop.kind).toBe("while");
  const p = rowPlan([
    row([
      ...plain.slice(0, 3),
      whileOf(loop.cond, [
        assign("z", callOf("%Pair.times", [ref("z"), ref("c")])),
        assign("z", callOf("%Pair.times", [ref("z"), ref("z")])),
        assign("n", bin("+", ref("n"), num(1))),
      ]),
      plain[4]!,
    ]),
  ]);
  if (p?.shape !== "outer") throw new Error("expected an outer plan");
  expect(p.steps.map((v) => `${slotName(v)}@${v.group}`)).toEqual([
    "z.re@0",
    "z.im@0",
    "z.re@1",
    "z.im@1",
    "n@2",
  ]);
  // The second assignment's `z` reads what the first group stored; the trees
  // the first assignment was built from would read the updated slots instead.
  expect(p.steps[2]!.value).toEqual({
    kind: "op",
    op: "-",
    left: {
      kind: "op",
      op: "*",
      left: { kind: "state", id: "z", field: "re" },
      right: { kind: "state", id: "z", field: "re" },
    },
    right: {
      kind: "op",
      op: "*",
      left: { kind: "state", id: "z", field: "im" },
      right: { kind: "state", id: "z", field: "im" },
    },
  });
});

test("a row's test reads the slots and its constant keeps the counter", () => {
  const p = rowPlan([row(rowBody())]);
  if (p?.shape !== "outer") throw new Error("expected an outer plan");
  expect(p.cond).toMatchObject({
    kind: "and",
    left: {
      kind: "cmp",
      op: "<",
      left: { kind: "state", id: "n", field: null },
      right: { kind: "invariant" },
    },
    right: {
      kind: "cmp",
      op: "<=",
      left: {
        kind: "op",
        op: "+",
        left: { kind: "op", op: "*", left: { kind: "state", id: "z", field: "re" } },
        right: { kind: "op", op: "*", left: { kind: "state", id: "z", field: "im" } },
      },
      right: { kind: "const", value: 4 },
    },
  });
  // `(x / size) * 3 - 2`: the row's constant follows the counter.
  expect(p.initial[0]!.value).toMatchObject({
    kind: "op",
    op: "-",
    left: { kind: "op", op: "*", left: { kind: "op", op: "/", left: { kind: "induction" } } },
    right: { kind: "const", value: 2 },
  });
  // The carried instance starts from its own constructor's field writes.
  expect(p.initial[2]!.value).toEqual({ kind: "const", value: 0 });
});

test("a chained initializer reads the earlier initializer's slot", () => {
  // `let t1 = t0 * t0 + t0 + 1`, through `t8`, then a row whose constant is
  // `t8`. A declaration's slots are stored before the next declaration's
  // values are computed, so each initializer can read the one before it from
  // its slot. Carrying the trees instead would inline the whole chain at each
  // use, and the last row's constant would hold a copy of every step.
  const locals = [
    ...rowLocals,
    ...Array.from({ length: 9 }, (_, i): IrLocal => ({
      id: `t${i}`,
      name: `t${i}`,
      type: F64,
      mutable: false,
    })),
  ];
  const rowOf = (length: number): LaneOuterPlan => {
    const body: IrStmt[] = [
      decl("t0", bin("-", bin("*", bin("/", ref("x"), ref("size")), num(3)), num(2))),
    ];
    for (let i = 1; i <= length; i++) {
      const prev = ref(`t${i - 1}`);
      body.push(decl(`t${i}`, bin("+", bin("*", prev, ref(`t${i - 1}`)), bin("+", prev, num(1)))));
    }
    // The row's constant and everything after it, with `t<length>` for the
    // counter expression the plain row starts from.
    body.push(decl("c", newOf(PAIR, [ref(`t${length}`), ref("limit")])));
    body.push(...rowBody().slice(1));
    const p = rowPlan([row(body)], { locals });
    if (p?.shape !== "outer") throw new Error("expected an outer plan");
    return p;
  };
  const nodes = (v: LaneNum): number => {
    switch (v.kind) {
      case "op":
        return 1 + nodes(v.left) + nodes(v.right);
      case "neg":
        return 1 + nodes(v.operand);
      default:
        return 1;
    }
  };
  // Every step adds the same seven nodes whatever the chain's length: the two
  // reads of the previous temp, its product, the term's read, `1`, the sum,
  // and the assignment. Inlining the previous trees instead doubled the count
  // with each declaration.
  const initial = (length: number) => rowOf(length).initial;
  expect([2, 4, 8].map((n) => nodes(initial(n)[n]!.value))).toEqual([7, 7, 7]);
  expect(initial(8)[8]!.value).toMatchObject({
    kind: "op",
    op: "+",
    left: {
      kind: "op",
      op: "*",
      left: { kind: "state", id: "t7" },
      right: { kind: "state", id: "t7" },
    },
    right: {
      kind: "op",
      op: "+",
      left: { kind: "state", id: "t7" },
      right: { kind: "const", value: 1 },
    },
  });
  // The constant after the chain reads the last temp's slot.
  expect(initial(8)[9]).toEqual({
    id: "c",
    field: "re",
    group: 9,
    value: { kind: "state", id: "t8", field: null },
  });
});

test("a row without the trailing count still plans, and one statement too many does not", () => {
  const plain = rowBody().slice(0, 4);
  const p = rowPlan([row(plain)]);
  expect(p).toMatchObject({ shape: "outer", tail: null });
  // Anything after the inner loop but `acc++` under one test keeps the row
  // scalar: the lanes would have to run it once per row.
  expect(rowPlan([row([...plain, assign("total", num(0))])])).toBeUndefined();
  // The count may write any number local the row does not carry, so the
  // accumulator is that local.
  expect(
    rowPlan([
      row([
        ...plain,
        ifOf(bin("===", ref("n"), ref("limit"), BOOL), [
          assign("total", bin("+", ref("total"), num(1))),
        ]),
      ]),
    ]),
  ).toMatchObject({ shape: "outer", tail: { accumulator: "total" } });
  // A trailing statement under the test that is not an increment keeps the
  // row scalar: its effect is not one the lane tail can count.
  expect(
    rowPlan([
      row([...plain, ifOf(bin("===", ref("n"), ref("limit"), BOOL), [assign("total", num(0))])]),
    ]),
  ).toBeUndefined();
  expect(
    rowPlan([
      row([
        ...plain,
        ifOf(bin("===", ref("n"), ref("limit"), BOOL), [
          assign("inside", bin("+", ref("inside"), num(1))),
          assign("inside", bin("+", ref("inside"), num(1))),
        ]),
      ]),
    ]),
  ).toBeUndefined();
});

test("a row the lane body cannot run keeps its scalar form", () => {
  const body = rowBody();
  const inner = body[3] as IrStmt & { kind: "while" };
  const cases: [string, IrStmt[]][] = [
    // Two inner loops.
    [
      "two whiles",
      [
        ...body.slice(0, 3),
        inner,
        whileOf(bin("<", ref("j"), num(4), BOOL), [assign("j", bin("+", ref("j"), num(1)))]),
      ],
    ],
    // A branch inside the inner loop.
    [
      "branch",
      [
        ...body.slice(0, 3),
        whileOf(inner.cond, [
          ...inner.body,
          ifOf(bin("<", ref("n"), num(2), BOOL), [assign("n", bin("+", ref("n"), num(1)))]),
        ]),
      ],
    ],
    // A declaration inside the inner loop: every step must be an assignment.
    ["decl inside", [...body.slice(0, 3), whileOf(inner.cond, [decl("j", num(1)), ...inner.body])]],
    // An inner assignment to a local the row did not declare.
    [
      "escapes",
      [
        ...body.slice(0, 3),
        whileOf(inner.cond, [...inner.body, assign("total", bin("+", ref("total"), num(1)))]),
      ],
    ],
    // A carried instance that changes class.
    [
      "changes class",
      [
        ...body.slice(0, 3),
        whileOf(inner.cond, [...inner.body, assign("z", newOf("Other", [num(1)]))]),
      ],
    ],
    // The first body statement is not a declaration.
    ["no leading decl", [assign("total", num(0)), ...body.slice(0, 4)]],
    // The inner loop never runs a step.
    ["empty inner", [...body.slice(0, 3), whileOf(inner.cond, []), body[4]!]],
    // The accumulator is the row's own state.
    ["accumulator declared in the row", [decl("inside", num(0)), ...body]],
  ];
  for (const [name, stmts] of cases) expect(rowPlan([row(stmts)]), name).toBeUndefined();
});

test("a row counter must be an ordinary number stepped by one", () => {
  const body = rowBody();
  const base = row(body);
  const for_ = (patch: Partial<IrStmt & { kind: "for" }>): IrStmt => ({
    ...(base as IrStmt & { kind: "for" }),
    ...patch,
  });
  // `<` with an f64 bound the row never writes.
  expect(rowPlan([for_({})])).toBeDefined();
  // `<=` is not the exclusive form the group guard reads.
  expect(rowPlan([for_({ cond: bin("<=", ref("x"), ref("size"), BOOL) })])).toBeUndefined();
  // A bound computed in the header is evaluated once; the guard reads a value.
  expect(
    rowPlan([for_({ cond: bin("<", ref("x"), bin("+", ref("size"), num(1)), BOOL) })]),
  ).toBeUndefined();
  // A bound the row writes changes under the lanes.
  expect(
    rowPlan([
      for_({
        body: [decl("size", ref("limit")), ...body],
      }),
    ]),
  ).toBeUndefined();
  // A stride of two, a negative step and a missing start keep it scalar.
  expect(rowPlan([for_({ update: assign("x", bin("+", ref("x"), num(2))) })])).toBeUndefined();
  expect(rowPlan([for_({ update: assign("x", bin("-", ref("x"), num(1))) })])).toBeUndefined();
  expect(rowPlan([for_({ init: decl("x", null) })])).toBeUndefined();
  expect(rowPlan([for_({ init: null })])).toBeUndefined();
  // `-0` is not the step one.
  expect(rowPlan([for_({ update: assign("x", bin("+", ref("x"), num(-0))) })])).toBeUndefined();
});

test("only a numeric class's fields can ride the lanes", () => {
  const method = (
    name: string,
    body: IrStmt[],
    params: IrParam[] = [paramOf("self", pairType)],
  ): IrFunction => ({
    name,
    params,
    returnType: F64,
    locals: params.map((p) => ({ id: p.localId, name: p.name, type: p.type, mutable: false })),
    body,
    loc,
  });
  const rowOf = (
    className: string,
    functions: IrFunction[],
    classes: IrClassDef[],
  ): LanePlan | undefined =>
    rowPlan(
      [
        row([
          decl("c", newOf(className, [num(0), num(0)])),
          decl("n", num(0)),
          whileOf(bin("<", ref("n"), ref("limit"), BOOL), [
            assign("n", bin("+", ref("n"), num(1))),
          ]),
          ifOf(bin("===", ref("n"), ref("limit"), BOOL), [
            assign("inside", bin("+", ref("inside"), num(1))),
          ]),
        ]),
      ],
      { classes, functions },
    );
  const NUMERIC: IrClassDef = {
    name: "Num",
    fields: [
      { name: "re", type: F64 },
      { name: "im", type: F64 },
    ],
    loc,
  };
  const ctor = (name: string): IrFunction => ({
    name: `%${name}.constructor`,
    params: [paramOf("self", objOf(name)), paramOf("re", F64), paramOf("im", F64)],
    returnType: { kind: "undefinedT" },
    locals: [
      { id: "self", name: "self", type: objOf(name), mutable: false },
      { id: "re", name: "re", type: F64, mutable: false },
      { id: "im", name: "im", type: F64, mutable: false },
    ],
    body: [
      setField(name, ref("self"), "re", ref("re")),
      setField(name, ref("self"), "im", ref("im")),
    ],
    loc,
  });
  expect(rowOf("Num", [ctor("Num")], [NUMERIC])).toMatchObject({ shape: "outer" });
  // A field that is not a number.
  const mixed: IrClassDef = {
    ...NUMERIC,
    fields: [
      { name: "re", type: F64 },
      { name: "tag", type: { kind: "string" } },
    ],
  };
  expect(rowOf("Num", [ctor("Num")], [mixed])).toBeUndefined();
  // A class in a hierarchy, and one evaluated inside a function.
  expect(rowOf("Num", [ctor("Num")], [{ ...NUMERIC, base: "Base" }])).toBeUndefined();
  expect(
    rowOf("Num", [ctor("Num")], [{ ...NUMERIC, localCaptures: [paramOf("cap", F64)] }]),
  ).toBeUndefined();
  // A class the module does not define.
  expect(rowOf("Num", [ctor("Num")], [])).toBeUndefined();
  // A method with more than a single return, and one with captures, cannot
  // be read into a lane body.
  const twoStatements = method("%Pair.norm", [
    decl("t", num(0)),
    { kind: "return", value: ref("t"), loc },
  ]);
  expect(
    rowPlan([row(rowBody())], { functions: [pairCtor, twoStatements, pairTimes] }),
  ).toBeUndefined();
  const capturing = { ...pairNorm, captures: [paramOf("cap", F64)] };
  expect(
    rowPlan([row(rowBody())], { functions: [pairCtor, capturing, pairTimes] }),
  ).toBeUndefined();
  const async_ = { ...pairNorm, async: true as const };
  expect(rowPlan([row(rowBody())], { functions: [pairCtor, async_, pairTimes] })).toBeUndefined();
});

test("an outer row is planned only when the outer shape is enabled", () => {
  expect(
    rowPlan([row(rowBody())], { shapes: new Set<LaneShape>(["sum", "count", "store"]) }),
  ).toBeUndefined();
  expect(rowPlan([row(rowBody())], { shapes: new Set<LaneShape>() })).toBeUndefined();
  expect([...parseLaneShapes("outer")]).toEqual(["outer"]);
  expect(laneShapesKeyParts(new Set(["outer"]))).toEqual(["lane-plans-outer"]);
});
