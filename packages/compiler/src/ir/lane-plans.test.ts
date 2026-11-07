/* The lane planner's rules: which loops get a plan, which keep their scalar
 * form, and the facts a plan records. The emitter half is in
 * backend/llvm/lanes.test.ts and the differential half is
 * tests/harness/lane-loops.test.ts. */
import { expect, test } from "vitest";
import {
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
  type IrExpr,
  type IrFunction,
  type IrLocal,
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
  expect([...parseLaneShapes("all")]).toEqual(["sum", "count", "store"]);
  expect([...parseLaneShapes("sum,nonsense")]).toEqual(["sum"]);
});

test("a build without plans keeps the cache keys it had", () => {
  expect(laneShapesKeyParts(new Set())).toEqual([]);
  expect(laneShapesKeyParts(new Set(["sum", "count"]))).toEqual(["lane-plans-sum+count"]);
  expect(laneShapesKeyParts(new Set(["store"]))).toEqual(["lane-plans-store"]);
});
