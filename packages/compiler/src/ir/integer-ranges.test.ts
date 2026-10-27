import { expect, test } from "vitest";
import {
  analyzeIntegerRangeFacts,
  analyzeIntegerRanges,
  bitwiseIdentityOperand,
  bitwiseRange,
  type BitwiseOp,
  type BitwiseOperand,
} from "./integer-ranges.js";
import { BOOL, F64, STRING, type IrExpr, type IrFunction, type IrStmt } from "./ir.js";

const loc = { file: "test.ts", start: 0, end: 0 };
const num = (value: number): IrExpr => ({ loc, kind: "numLit", value, type: F64 });
const ref = (localId = "x"): IrExpr => ({ loc, kind: "varRef", localId, type: F64 });
const bin = (op: Extract<IrExpr, { kind: "bin" }>["op"], left: IrExpr, right: IrExpr): IrExpr => ({
  loc,
  kind: "bin",
  op,
  left,
  right,
  type: F64,
});
const unaryMinus = (operand: IrExpr): IrExpr => ({
  loc,
  kind: "unary",
  op: "-",
  operand,
  type: F64,
});
const assign = (value: IrExpr): IrStmt => ({ loc, kind: "assign", localId: "x", value });
const fn = (body: IrStmt[], boxed = false): IrFunction => ({
  loc,
  name: "f",
  params: [],
  returnType: F64,
  locals: [
    { id: "x", name: "x", type: F64, mutable: true, ...(boxed ? { boxed: true as const } : {}) },
  ],
  body,
});

test("tracks exact additions and bitwise conversions through assignments", () => {
  const sum = bin("+", ref(), bin("<<", ref(), num(3)));
  const unsigned = bin(">>>", ref(), num(0));
  const ranges = analyzeIntegerRanges(
    fn([
      assign(bin("|", ref("unknown"), num(0))),
      assign(sum),
      { loc, kind: "return", value: unsigned },
    ]),
  );
  expect(ranges.get(sum)).toEqual({ min: -4294967296, max: 4294967294 });
  expect(ranges.get(unsigned)).toEqual({ min: 0, max: 4294967295 });
});

test("element reads of Int32[] arrays that found a value are int32s", () => {
  const arrType = { kind: "array", elem: F64 } as const;
  const read = (localId: string): IrExpr => ({
    loc,
    kind: "arrayGet",
    arr: { loc, kind: "varRef", localId, type: arrType },
    index: num(0),
    type: F64,
  });
  const checked = read("ints");
  const other = read("floats");
  const ranges = analyzeIntegerRanges(
    fn([
      { loc, kind: "exprStmt", expr: checked },
      { loc, kind: "exprStmt", expr: other },
    ]),
    { elements: (arr) => arr.kind === "varRef" && arr.localId === "ints" },
  );
  expect(ranges.get(checked)).toEqual({ min: -2147483648, max: 2147483647 });
  expect(ranges.get(other) ?? null).toBeNull();
});

test("rejects negative zero, fractions, nonfinite values and imprecise sums", () => {
  for (const value of [-0, 0.5, NaN, Infinity, -Infinity, 9007199254740992]) {
    const sum = bin("+", num(value), num(0));
    expect(analyzeIntegerRanges(fn([{ loc, kind: "return", value: sum }])).get(sum)).toBeNull();
  }
  const exact = bin("-", num(Number.MAX_SAFE_INTEGER), num(1));
  const rounded = bin("+", num(Number.MAX_SAFE_INTEGER), num(2));
  const ranges = analyzeIntegerRanges(fn([assign(exact), { loc, kind: "return", value: rounded }]));
  expect(ranges.get(exact)).toEqual({ min: 9007199254740990, max: 9007199254740990 });
  expect(ranges.get(rounded)).toBeNull();
});

test("preserves uncaptured slots across calls and invalidates writes and boxed locals", () => {
  const sum = (): IrExpr => bin("+", ref(), num(1));
  const call: IrExpr = { loc, kind: "call", callee: "unknown", args: [], type: F64 };
  const afterCall = sum();
  const afterBlock = sum();
  const boxed = sum();
  const ranges = analyzeIntegerRanges(
    fn([
      assign(num(1)),
      { loc, kind: "exprStmt", expr: call },
      assign(afterCall),
      assign(num(1)),
      { loc, kind: "block", body: [assign(num(Infinity))] },
      { loc, kind: "return", value: afterBlock },
    ]),
  );
  expect(ranges.get(afterCall)).toEqual({ min: 2, max: 2 });
  expect(ranges.get(afterBlock)).toBeNull();
  expect(
    analyzeIntegerRanges(fn([assign(num(1)), { loc, kind: "return", value: boxed }], true)).get(
      boxed,
    ),
  ).toBeNull();
});

test("analyzes nested bodies independently and snapshots operands before writes", () => {
  const before = ref();
  const write: IrExpr = { loc, kind: "assignExpr", localId: "x", value: num(Infinity), type: F64 };
  const after = ref();
  const nested = bin("+", ref(), num(1));
  const ranges = analyzeIntegerRanges(
    fn([
      assign(num(1)),
      { loc, kind: "exprStmt", expr: bin("|", before, write) },
      { loc, kind: "exprStmt", expr: after },
      { loc, kind: "block", body: [assign(num(2)), { loc, kind: "return", value: nested }] },
    ]),
  );
  expect(ranges.get(before)).toEqual({ min: 1, max: 1 });
  expect(ranges.get(after)).toBeNull();
  expect(ranges.get(nested)).toEqual({ min: 3, max: 3 });
});

test("shared expression objects never inherit a proof from another occurrence", () => {
  const shared = ref();
  const ranges = analyzeIntegerRanges(
    fn([
      assign(num(1)),
      { loc, kind: "exprStmt", expr: shared },
      assign(num(Infinity)),
      {
        loc,
        kind: "return",
        value: { loc, kind: "call", callee: "unknown", args: [shared], type: F64 },
      },
    ]),
  );
  expect(ranges.get(shared)).toBeNull();
});

const condition = (
  op: Extract<IrExpr, { kind: "bin" }>["op"],
  left: IrExpr,
  right: IrExpr,
): IrExpr => ({ loc, kind: "bin", op, left, right, type: BOOL });
const observe = (value: IrExpr): IrStmt => ({ loc, kind: "exprStmt", expr: value });
const INT32 = { min: -2147483648, max: 2147483647 };
const UINT32 = { min: 0, max: 4294967295 };
const INT32_AND_UINT32 = { min: 0, max: 2147483647 };

test("joins branch assignments and refines signed masks on guarded paths", () => {
  const inside = ref(),
    joined = ref();
  const ranges = analyzeIntegerRanges(
    fn([
      assign(bin("|", ref("unknown"), num(0))),
      {
        loc,
        kind: "if",
        cond: condition(">=", ref(), num(0)),
        then: [observe(inside), assign(bin("&", ref(), num(255)))],
        else_: [assign(num(7))],
      },
      observe(joined),
    ]),
  );
  expect(ranges.get(inside)).toEqual({ min: 0, max: 2147483647 });
  expect(ranges.get(joined)).toEqual({ min: 0, max: 255 });
});

test("assignment snapshots and lazy joins do not overwrite earlier operands", () => {
  const before = ref(),
    after = ref(),
    last = ref();
  const write: IrExpr = { loc, kind: "assignExpr", localId: "x", value: num(3), type: F64 };
  const ternary: IrExpr = {
    loc,
    kind: "ternary",
    cond: condition("===", ref("flag"), num(0)),
    then: write,
    else_: num(5),
    type: F64,
  };
  const ranges = analyzeIntegerRanges(
    fn([
      assign(num(1)),
      observe(bin("+", before, ternary)),
      observe(after),
      observe({
        loc,
        kind: "logical",
        op: "&&",
        left: ref("flag"),
        right: { ...write, value: num(9) },
        type: F64,
      }),
      observe(last),
    ]),
  );
  expect(ranges.get(before)).toEqual({ min: 1, max: 1 });
  expect(ranges.get(after)).toEqual({ min: 1, max: 3 });
  expect(ranges.get(last)).toEqual({ min: 1, max: 9 });
});

test("guards that mutate a compared binding cannot refine its later value", () => {
  const current = ref();
  const writes: IrExpr = {
    loc,
    kind: "seqExpr",
    stmts: [assign(bin(">>>", ref("unknown"), num(0)))],
    result: num(100),
    type: F64,
  };
  const ranges = analyzeIntegerRanges(
    fn([
      assign(num(1)),
      {
        loc,
        kind: "if",
        cond: condition("<", ref(), writes),
        then: [observe(current)],
        else_: null,
      },
    ]),
  );
  expect(ranges.get(current)).toEqual({ min: 0, max: 4294967295 });
});

test("labeled exits and do-while conditions cannot lend facts to skipped paths", () => {
  const afterBlock = ref(),
    firstBody = ref();
  const ranges = analyzeIntegerRanges(
    fn([
      assign(num(100)),
      {
        loc,
        kind: "block",
        labels: ["done"],
        body: [
          {
            loc,
            kind: "if",
            cond: condition("===", ref("flag"), num(0)),
            then: [{ loc, kind: "break", label: "done" }],
            else_: null,
          },
          assign(num(1)),
        ],
      },
      observe(afterBlock),
      {
        loc,
        kind: "doWhile",
        cond: condition(
          "<",
          { loc, kind: "assignExpr", localId: "x", value: num(0), type: F64 },
          num(-1),
        ),
        body: [observe(firstBody)],
      },
    ]),
  );
  // The break skips `x = 1`; both writes are literals, so the join keeps
  // only the closed range of the entry value and the block's write, never
  // the skipped path's fact (`x === 1`).
  expect(ranges.get(afterBlock)).toEqual({ min: 1, max: 100 });
  // Likewise the condition's `x = 0` does not reach the first iteration:
  // the body sees the entry range joined with that write.
  expect(ranges.get(firstBody)).toEqual({ min: 0, max: 100 });
});

test("unit induction is exact but loop-carried assignments remain unknown", () => {
  const counter = ref(),
    carried = ref("state"),
    after = ref();
  const f = fn([
    {
      loc,
      kind: "for",
      init: { loc, kind: "varDecl", localId: "x", init: num(0) },
      cond: condition("<", ref(), num(10)),
      update: assign(bin("+", ref(), num(1))),
      body: [
        observe(counter),
        observe(carried),
        { loc, kind: "assign", localId: "state", value: num(3) },
      ],
    },
    observe(after),
  ]);
  f.locals.push({ id: "state", name: "state", type: F64, mutable: true });
  const ranges = analyzeIntegerRanges(f);
  expect(ranges.get(counter)).toEqual({ min: 0, max: 9 });
  expect(ranges.get(carried)).toBeNull();
  expect(ranges.get(after)).toBeNull();
});

test("filtered strided loops retain decoded values and bound secondary cursors", () => {
  const cursor = ref("position"),
    decoded = ref("decoded"),
    conditionRead = ref("x");
  const loop: IrStmt & { kind: "for" } = {
    loc,
    kind: "for",
    init: { loc, kind: "varDecl", localId: "x", init: num(0) },
    cond: condition("<", conditionRead, num(100)),
    update: assign(bin("+", ref(), num(24))),
    body: [
      { loc, kind: "varDecl", localId: "decoded", init: bin(">>>", ref("input"), num(0)) },
      {
        loc,
        kind: "if",
        cond: condition("===", ref("flag"), num(0)),
        then: [{ loc, kind: "continue" }],
        else_: null,
      },
      observe(decoded),
      observe(cursor),
      { loc, kind: "assign", localId: "position", value: bin("+", ref("position"), num(16)) },
    ],
  };
  const f = fn([{ loc, kind: "varDecl", localId: "position", init: num(0) }, loop]);
  f.locals.push(
    ...["position", "decoded"].map((id) => ({ id, name: id, type: F64, mutable: true })),
  );
  const ranges = analyzeIntegerRanges(f);
  expect(ranges.get(cursor)).toEqual({ min: 0, max: 80 });
  expect(ranges.get(decoded)).toEqual({ min: 0, max: 4294967295 });
  // The last pass enters at most at 99, so the failing test reads at most 123.
  expect(ranges.get(conditionRead)).toEqual({ min: 0, max: 123 });
  for (const mutation of ["fraction", "repeat", "overflow", "counter"] as const) {
    const changed = structuredClone(f);
    const body = (changed.body[1] as IrStmt & { kind: "for" }).body;
    const update = body[4] as IrStmt & { kind: "assign" };
    if (mutation === "fraction") update.value = bin("+", ref("position"), num(0.5));
    if (mutation === "repeat")
      body[4] = {
        loc,
        kind: "while",
        cond: condition("<", ref("unknown"), num(1)),
        body: [update],
      };
    if (mutation === "overflow")
      (changed.body[0] as IrStmt & { kind: "varDecl" }).init = num(Number.MAX_SAFE_INTEGER);
    if (mutation === "counter") body.push(assign(num(0)));
    const observation = body[3] as IrStmt & { kind: "exprStmt" };
    expect(analyzeIntegerRanges(changed).get(observation.expr), mutation).toBeNull();
  }
});

test("an exit branch does not discard the surviving facts or escape its own label", () => {
  const afterReturn = ref(),
    afterLabel = ref();
  const ranges = analyzeIntegerRanges(
    fn([
      assign(num(3)),
      {
        loc,
        kind: "if",
        cond: condition("===", ref("flag"), num(0)),
        then: [{ loc, kind: "return", value: num(1) }],
        else_: null,
      },
      observe(afterReturn),
      {
        loc,
        kind: "if",
        cond: condition("===", ref("flag"), num(1)),
        then: [
          {
            loc,
            kind: "block",
            labels: ["done"],
            body: [assign(num(0.5)), { loc, kind: "break", label: "done" }],
          },
        ],
        else_: null,
      },
      observe(afterLabel),
    ]),
  );
  expect(ranges.get(afterReturn)).toEqual({ min: 3, max: 3 });
  expect(ranges.get(afterLabel)).toBeNull();
});

test("int32-closed locals keep the int32 range across loops and switches", () => {
  const loop = (write: IrExpr): { inside: IrExpr; after: IrExpr; f: IrFunction } => {
    const inside = ref(),
      after = ref();
    const f = fn([
      assign(num(0)),
      {
        loc,
        kind: "while",
        cond: condition("<", ref("unknown"), num(1)),
        body: [assign(write), observe(inside)],
      },
      observe(after),
    ]);
    return { inside, after, f };
  };
  const closed = loop(bin("|", ref(), ref("unknown")));
  const closedRanges = analyzeIntegerRanges(closed.f);
  expect(closedRanges.get(closed.inside)).toEqual(INT32);
  expect(closedRanges.get(closed.after)).toEqual(INT32);
  const unsigned = loop(bin(">>>", ref("unknown"), num(0)));
  expect(analyzeIntegerRanges(unsigned.f).get(unsigned.after)).toEqual(UINT32);
  // `x >>> 0` of a local that only ever holds non-negative int32s is one.
  const identity = loop(bin(">>>", ref(), num(0)));
  expect(analyzeIntegerRanges(identity.f).get(identity.after)).toEqual(INT32_AND_UINT32);
  for (const write of [bin("+", ref(), num(1)), bin("/", ref(), num(2))]) {
    const open = loop(write);
    expect(analyzeIntegerRanges(open.f).get(open.after), write.kind).toBeNull();
  }
  const afterSwitch = ref();
  const switched = analyzeIntegerRanges(
    fn([
      assign(num(1)),
      {
        loc,
        kind: "switch",
        disc: ref("unknown"),
        cases: [
          { test: num(0), body: [assign(bin("^", ref(), num(4)))] },
          { test: null, body: [assign(num(-1))] },
        ],
      } as IrStmt,
      observe(afterSwitch),
    ]),
  );
  expect(switched.get(afterSwitch)).toEqual(INT32);
});

test("loop-carried locals written from Int32[] element reads keep the int32 range", () => {
  const arrType = { kind: "array", elem: F64 } as const;
  const loop = (localId: string): { after: IrExpr; f: IrFunction } => {
    const after = ref();
    // `x = a[x]!` in a loop: a cursor that follows indices stored in the array.
    const read: IrExpr = {
      loc,
      kind: "arrayGet",
      arr: { loc, kind: "varRef", localId, type: arrType },
      index: ref(),
      type: F64,
    };
    const f = fn([
      assign(num(0)),
      {
        loc,
        kind: "while",
        cond: condition("<", ref("unknown"), num(1)),
        body: [assign(read)],
      },
      observe(after),
    ]);
    return { after, f };
  };
  const elements = { elements: (arr: IrExpr) => arr.kind === "varRef" && arr.localId === "ints" };
  const ints = loop("ints");
  expect(analyzeIntegerRanges(ints.f, elements).get(ints.after)).toEqual(INT32);
  const floats = loop("floats");
  expect(analyzeIntegerRanges(floats.f, elements).get(floats.after) ?? null).toBeNull();
});

test("uint32-closed locals keep the uint32 range across loop back edges", () => {
  // for (let i = 0; i < n; i++) { v = unknown >>> 0; acc = (acc + v) >>> 0; ... }
  const loop = (start: IrExpr | null, writes: IrExpr[]) => {
    const inside = ref("acc"),
      sum = bin("+", inside, ref("v")),
      after = ref("acc");
    const set = (localId: string, value: IrExpr): IrStmt => ({
      loc,
      kind: "assign",
      localId,
      value,
    });
    const f = fn([
      ...(start ? [set("acc", start)] : []),
      {
        loc,
        kind: "for",
        init: { loc, kind: "varDecl", localId: "i", init: num(0) },
        cond: condition("<", ref("i"), ref("n")),
        update: set("i", bin("+", ref("i"), num(1))),
        body: [
          set("v", bin(">>>", ref("unknown"), num(0))),
          set("acc", bin(">>>", sum, num(0))),
          ...writes.map((value) => set("acc", value)),
        ],
      },
      observe(after),
    ]);
    for (const id of ["acc", "i", "v", "n"])
      f.locals.push({ id, name: id, type: F64, mutable: true });
    return { inside, sum, after, ranges: analyzeIntegerRanges(f) };
  };
  const closed = loop(num(0), []);
  expect(closed.ranges.get(closed.inside)).toEqual(UINT32);
  // The add before `>>> 0` stays exact: it can exceed 2^32.
  expect(closed.ranges.get(closed.sum)).toEqual({ min: 0, max: 2 * 4294967295 });
  expect(closed.ranges.get(closed.after)).toEqual(UINT32);
  // A uint32 literal above 2^31 and a `>>>` chain through the closed local
  // keep the closure.
  for (const write of [num(4294967295), bin(">>>", ref("acc"), num(1))]) {
    const kept = loop(num(2147483648), [write]);
    expect(kept.ranges.get(kept.inside)).toEqual(UINT32);
    expect(kept.ranges.get(kept.after)).toEqual(UINT32);
  }
  // Mixing signed and unsigned writes, any other write, an entry outside
  // uint32 or an unknown entry leaves the local unknown at the loop head.
  const open: [IrExpr | null, IrExpr | null][] = [
    [num(0), bin("|", ref("acc"), num(0))],
    [num(0), num(-1)],
    [num(0), num(4294967296)],
    [num(0), num(-0)],
    [num(0), num(0.5)],
    [num(0), bin("+", ref("acc"), num(1))],
    [num(-1), null],
    [num(4294967296), null],
    [null, null],
  ];
  for (const [start, write] of open) {
    const result = loop(start, write ? [write] : []);
    expect(result.ranges.get(result.inside)).toBeNull();
    expect(result.ranges.get(result.after)).toBeNull();
  }
});

test("arithmetic-closed loop-carried locals keep exact ranges across back edges", () => {
  // n = unknown & 3; v = start;
  // for (let i = 0; i < 100000; i++) { v = write(v); observe(v) } observe(v)
  const set = (localId: string, value: IrExpr): IrStmt => ({ loc, kind: "assign", localId, value });
  const loop = (start: IrExpr, write: (v: IrExpr) => IrExpr) => {
    const inside = ref("v"),
      after = ref("v"),
      value = write(ref("v"));
    const f = fn([
      set("n", bin("&", ref("unknown"), num(3))),
      set("v", start),
      {
        loc,
        kind: "for",
        init: { loc, kind: "varDecl", localId: "i", init: num(0) },
        cond: condition("<", ref("i"), num(100000)),
        update: set("i", bin("+", ref("i"), num(1))),
        body: [observe(inside), set("v", value)],
      },
      observe(after),
    ]);
    for (const id of ["v", "i", "n"]) f.locals.push({ id, name: id, type: F64, mutable: true });
    const ranges = analyzeIntegerRanges(f);
    return { inside: ranges.get(inside), after: ranges.get(after), value: ranges.get(value) };
  };
  const M = 1000003;
  // The 41-closures kernel: the dividend is a non-negative exact integer.
  const hash = loop(num(7), (v) => bin("%", bin("+", bin("*", v, num(31)), ref("n")), num(M)));
  expect(hash).toEqual({
    inside: { min: 0, max: M - 1 },
    after: { min: 0, max: M - 1 },
    value: { min: 0, max: M - 1 },
  });
  // The counter's header range holds at every read in the body.
  const counted = loop(num(0), (v) => bin("%", bin("+", bin("*", v, num(31)), ref("i")), num(M)));
  expect(counted.inside).toEqual({ min: 0, max: M - 1 });
  // A wrap counter, and a product that crosses 2^31 but stays exact.
  expect(loop(num(0), (v) => bin("%", bin("+", v, num(1)), num(10))).after).toEqual({
    min: 0,
    max: 9,
  });
  const wide = loop(num(1), (v) =>
    bin("%", bin("+", bin("*", v, num(31)), ref("n")), num(2 ** 31)),
  );
  expect(wide.after).toEqual({ min: 0, max: 2 ** 31 - 1 });
  // Unary minus of a value that cannot be zero stays exact, also into
  // negative ranges (closed under int32 rather than the non-negative bound).
  expect(
    loop(num(1), (v) => unaryMinus(unaryMinus(bin("+", bin("%", v, num(7)), num(1))))).after,
  ).toEqual({ min: 1, max: 7 });
  expect(loop(num(-1), (v) => unaryMinus(bin("+", bin("&", v, num(7)), num(1)))).after).toEqual({
    min: -8,
    max: -1,
  });
  // Writes that could leave the bound, produce -0, NaN, a fraction or an
  // inexact product, and entries outside it, leave the local unknown.
  const open: [string, IrExpr, (v: IrExpr) => IrExpr][] = [
    [
      "negative dividend (-0)",
      num(7),
      (v) => bin("%", bin("-", bin("*", v, num(31)), ref("n")), num(M)),
    ],
    ["growth", num(7), (v) => bin("+", bin("*", v, num(31)), ref("n"))],
    ["unknown divisor", num(7), (v) => bin("%", v, ref("unknown"))],
    ["zero divisor (NaN)", num(7), (v) => bin("%", v, num(0))],
    ["fraction divisor", num(7), (v) => bin("%", v, num(2.5))],
    ["negated remainder (-0)", num(7), (v) => unaryMinus(bin("%", v, num(7)))],
    ["inexact product", num(7), (v) => bin("%", bin("*", v, num(2 ** 30)), num(M))],
    ["negative entry", num(-1), (v) => bin("%", bin("+", bin("*", v, num(31)), ref("n")), num(M))],
    ["fraction entry", num(0.5), (v) => bin("%", bin("+", v, num(1)), num(10))],
    ["unknown entry", ref("unknown"), (v) => bin("%", bin("+", v, num(1)), num(10))],
    ["infinite entry", num(Infinity), (v) => bin("%", bin("+", v, num(1)), num(10))],
    ["division", num(7), (v) => bin("%", bin("/", v, num(2)), num(10))],
  ];
  for (const [label, start, write] of open) {
    const result = loop(start, write);
    expect(result.inside, label).toBeNull();
    expect(result.after, label).toBeNull();
  }
});

test("a loop-invariant positive step bounds the counter of a limited loop", () => {
  // s = (unknown & 7) + 1; for (let j = s * 2; j <= 1000; j += s) observe(j)
  const set = (localId: string, value: IrExpr): IrStmt => ({ loc, kind: "assign", localId, value });
  const loop = (
    step: IrExpr,
    update: (j: IrExpr) => IrExpr = (j) => bin("+", j, ref("s")),
    body: IrStmt[] = [],
  ) => {
    const inside = ref("j"),
      next = update(ref("j"));
    const f = fn([
      set("s", step),
      {
        loc,
        kind: "for",
        init: { loc, kind: "varDecl", localId: "j", init: bin("*", ref("s"), num(2)) },
        cond: condition("<=", ref("j"), num(1000)),
        update: set("j", next),
        body: [observe(inside), ...body],
      },
    ]);
    for (const id of ["s", "j"]) f.locals.push({ id, name: id, type: F64, mutable: true });
    const ranges = analyzeIntegerRanges(f);
    return { inside: ranges.get(inside), next: ranges.get(next) };
  };
  const positive = bin("+", bin("&", ref("unknown"), num(7)), num(1));
  expect(loop(positive)).toEqual({ inside: { min: 2, max: 1000 }, next: { min: 3, max: 1008 } });
  // Early exits only shorten the walk.
  const exits: IrStmt = {
    loc,
    kind: "if",
    cond: condition("===", ref("unknown"), num(0)),
    then: [{ loc, kind: "break" }],
    else_: [{ loc, kind: "continue" }],
  };
  expect(loop(positive, undefined, [exits]).inside).toEqual({ min: 2, max: 1000 });
  // A step that can be zero, negative or a fraction, a step the body
  // writes, and a subtracted positive step, prove nothing.
  const open: [string, IrExpr, ((j: IrExpr) => IrExpr) | undefined, IrStmt[]][] = [
    ["zero step", bin("&", ref("unknown"), num(7)), undefined, []],
    ["negative step", unaryMinus(positive), undefined, []],
    ["fraction step", num(0.5), undefined, []],
    ["unknown step", ref("unknown"), undefined, []],
    ["written step", positive, undefined, [set("s", num(1))]],
    ["subtracted step", positive, (j) => bin("-", j, ref("s")), []],
  ];
  for (const [label, step, update, body] of open)
    expect(loop(step, update, body).inside, label).toBeNull();
});

test("a while condition bounds a counter the loop only increments", () => {
  // it = start; while (unknown <= 4 && it < MAX) { observe(it); it++ } observe(it)
  const set = (localId: string, value: IrExpr): IrStmt => ({ loc, kind: "assign", localId, value });
  const bump = (op: "+" | "-" = "+"): IrStmt => ({
    loc,
    kind: "exprStmt",
    expr: { loc, kind: "incDec", op, prefix: false, localId: "it", type: F64 },
  });
  const and = (left: IrExpr, right: IrExpr): IrExpr => ({
    loc,
    kind: "logical",
    op: "&&",
    left,
    right,
    type: BOOL,
  });
  const run = (
    options: {
      start?: IrExpr;
      cond?: IrExpr;
      body?: IrStmt[];
      before?: IrStmt[];
    } = {},
  ) => {
    const inside = ref("it"),
      after = ref("it");
    const f = fn([
      set("max", num(300)),
      set("it", options.start ?? num(0)),
      ...(options.before ?? []),
      {
        loc,
        kind: "while",
        cond:
          options.cond ??
          and(condition("<=", ref("unknown"), num(4)), condition("<", ref("it"), ref("max"))),
        body: options.body ?? [observe(inside), bump()],
      },
      observe(after),
    ]);
    for (const id of ["it", "max"]) f.locals.push({ id, name: id, type: F64, mutable: true });
    const ranges = analyzeIntegerRanges(f);
    return { inside: ranges.get(inside), after: ranges.get(after) };
  };
  expect(run()).toEqual({ inside: { min: 0, max: 299 }, after: { min: 0, max: 300 } });
  // `MAX > it`, an inclusive bound, two increments per pass and an early exit.
  expect(run({ cond: condition(">", ref("max"), ref("it")) }).after).toEqual({ min: 0, max: 300 });
  expect(run({ cond: condition("<=", ref("it"), num(10)) }).after).toEqual({ min: 0, max: 11 });
  const twice = [observe(ref("it")), bump(), set("it", bin("+", ref("it"), num(2)))];
  expect(run({ body: twice }).after).toEqual({ min: 0, max: 302 });
  const exit: IrStmt = {
    loc,
    kind: "if",
    cond: condition("===", ref("unknown"), num(0)),
    then: [{ loc, kind: "break" }],
    else_: null,
  };
  expect(run({ body: [exit, bump()] }).after).toEqual({ min: 0, max: 300 });
  // A start above the bound stays the entry value.
  expect(run({ start: num(500) }).after).toEqual({ min: 500, max: 500 });
  // Decrements, fractional or variable steps, increments in a nested loop,
  // writes in the condition, a bound the loop writes, a disjunction, and an
  // unknown start prove nothing.
  const nested: IrStmt = {
    loc,
    kind: "while",
    cond: condition("<", ref("unknown"), num(3)),
    body: [bump()],
  };
  const counted: IrExpr = { loc, kind: "incDec", op: "+", prefix: false, localId: "it", type: F64 };
  const open: [string, Parameters<typeof run>[0]][] = [
    ["decrement", { body: [bump("-")] }],
    ["fraction step", { body: [set("it", bin("+", ref("it"), num(0.5)))] }],
    ["variable step", { body: [set("it", bin("+", ref("it"), ref("unknown")))] }],
    ["nested increment", { body: [nested] }],
    ["condition write", { cond: condition("<", counted, ref("max")), body: [] }],
    ["written bound", { body: [bump(), set("max", num(1e12))] }],
    [
      "disjunction",
      {
        cond: {
          loc,
          kind: "logical",
          op: "||",
          left: condition("<=", ref("unknown"), num(4)),
          right: condition("<", ref("it"), ref("max")),
          type: BOOL,
        },
      },
    ],
    ["unknown start", { start: ref("unknown") }],
  ];
  for (const [label, options] of open) expect(run(options).after, label).toBeNull();
});

test("a while condition on a string's length bounds a counter, and guarded increments stay below it", () => {
  // while (pos < text.length) { observe(pos); pos++; if (pos < text.length && unknown === 13) pos++; }
  const text: IrExpr = { loc, kind: "varRef", localId: "text", type: STRING };
  const length: IrExpr = {
    loc,
    kind: "strIntrinsic",
    method: "length",
    receiver: text,
    args: [],
    type: F64,
  };
  const set = (localId: string, value: IrExpr): IrStmt => ({ loc, kind: "assign", localId, value });
  const bump: IrStmt = {
    loc,
    kind: "exprStmt",
    expr: { loc, kind: "incDec", op: "+", prefix: false, localId: "pos", type: F64 },
  };
  const and = (left: IrExpr, right: IrExpr): IrExpr => ({
    loc,
    kind: "logical",
    op: "&&",
    left,
    right,
    type: BOOL,
  });
  const run = (body: (inside: IrExpr) => IrStmt[]) => {
    const inside = ref("pos"),
      after = ref("pos");
    const f = fn([
      set("pos", num(0)),
      { loc, kind: "while", cond: condition("<", ref("pos"), length), body: body(inside) },
      observe(after),
    ]);
    f.locals.push(
      { id: "pos", name: "pos", type: F64, mutable: true },
      { id: "text", name: "text", type: STRING, mutable: true },
    );
    const ranges = analyzeIntegerRanges(f);
    return { inside: ranges.get(inside), after: ranges.get(after) };
  };
  const guarded = (cond: IrExpr): IrStmt => ({ loc, kind: "if", cond, then: [bump], else_: null });
  const crlf = guarded(
    and(condition("<", ref("pos"), length), condition("===", ref("unknown"), num(13))),
  );
  expect(run((inside) => [observe(inside), bump, crlf])).toEqual({
    inside: { min: 0, max: 2147483646 },
    after: { min: 0, max: 2147483647 },
  });
  // An exit before the second increment, and an else branch, keep the bound.
  const exit: IrStmt = {
    loc,
    kind: "if",
    cond: condition("===", ref("unknown"), num(0)),
    then: [{ loc, kind: "continue" }],
    else_: [crlf],
  };
  expect(run((inside) => [observe(inside), bump, exit]).after).toEqual({ min: 0, max: 2147483647 });
  // Without the guard both increments count; a string the loop rebinds bounds nothing.
  const unguarded = guarded(condition("===", ref("unknown"), num(13)));
  expect(run((inside) => [observe(inside), bump, unguarded]).after).toEqual({
    min: 0,
    max: 2147483648,
  });
  const rebound = set("text", { loc, kind: "strLit", value: "abc", type: STRING });
  expect(run((inside) => [observe(inside), bump, rebound]).after).toBeNull();
});

test("a while counter every pass advances bounds the companions the loop increments", () => {
  // pos = 0; k = 0; while (pos < text.length) { pos++; observe(k); if (unknown === 1) k++; k++; } observe(k)
  const text: IrExpr = { loc, kind: "varRef", localId: "text", type: STRING };
  const length: IrExpr = {
    loc,
    kind: "strIntrinsic",
    method: "length",
    receiver: text,
    args: [],
    type: F64,
  };
  const set = (localId: string, value: IrExpr): IrStmt => ({ loc, kind: "assign", localId, value });
  const bump = (localId: string): IrStmt => ({
    loc,
    kind: "exprStmt",
    expr: { loc, kind: "incDec", op: "+", prefix: false, localId, type: F64 },
  });
  const maybe = (then: IrStmt[]): IrStmt => ({
    loc,
    kind: "if",
    cond: condition("===", ref("unknown"), num(1)),
    then,
    else_: null,
  });
  const run = (body: (inside: IrExpr) => IrStmt[]) => {
    const inside = ref("k"),
      after = ref("k");
    const loop: IrStmt = {
      loc,
      kind: "while",
      cond: condition("<", ref("pos"), length),
      body: body(inside),
    };
    const f = fn([set("pos", num(0)), set("k", num(0)), loop, observe(after)]);
    f.locals.push(
      { id: "pos", name: "pos", type: F64, mutable: true },
      { id: "k", name: "k", type: F64, mutable: true },
      { id: "text", name: "text", type: STRING, mutable: false },
    );
    const facts = analyzeIntegerRangeFacts(f);
    return {
      inside: facts.ranges.get(inside),
      after: facts.ranges.get(after),
      loop: facts.loopRanges.get(loop)?.get("k"),
    };
  };
  // At most 2^31 - 1 passes, each adding at most 2.
  const bounded = { min: 0, max: 4294967294 };
  expect(run((inside) => [bump("pos"), observe(inside), maybe([bump("k")]), bump("k")])).toEqual({
    inside: bounded,
    after: bounded,
    loop: bounded,
  });
  // A pass that can continue before advancing the counter, or an increment a
  // nested loop repeats, bounds nothing.
  const skip: IrStmt = maybe([{ loc, kind: "continue" }]);
  expect(run((inside) => [skip, bump("pos"), observe(inside), bump("k")]).after).toBeNull();
  const repeat: IrStmt = {
    loc,
    kind: "while",
    cond: condition("===", ref("unknown"), num(1)),
    body: [bump("k")],
  };
  expect(run((inside) => [bump("pos"), observe(inside), repeat]).after).toBeNull();
});

test("a nested while loop may advance a counter its own condition bounds", () => {
  // while (pos < text.length) { observe(pos); while (pos < text.length && unknown === 1) pos++; pos += 2; }
  const text: IrExpr = { loc, kind: "varRef", localId: "text", type: STRING };
  const length: IrExpr = {
    loc,
    kind: "strIntrinsic",
    method: "length",
    receiver: text,
    args: [],
    type: F64,
  };
  const bump: IrStmt = {
    loc,
    kind: "exprStmt",
    expr: { loc, kind: "incDec", op: "+", prefix: false, localId: "pos", type: F64 },
  };
  const skip: IrStmt = { loc, kind: "assign", localId: "pos", value: bin("+", ref("pos"), num(2)) };
  const and = (left: IrExpr, right: IrExpr): IrExpr => ({
    loc,
    kind: "logical",
    op: "&&",
    left,
    right,
    type: BOOL,
  });
  const scan = (cond: IrExpr): IrStmt => ({ loc, kind: "while", cond, body: [bump] });
  const run = (inner: IrStmt) => {
    const inside = ref("pos"),
      after = ref("pos");
    const f = fn([
      { loc, kind: "assign", localId: "pos", value: num(0) },
      {
        loc,
        kind: "while",
        cond: condition("<", ref("pos"), length),
        body: [observe(inside), inner, skip],
      },
      observe(after),
    ]);
    f.locals.push(
      { id: "pos", name: "pos", type: F64, mutable: true },
      { id: "text", name: "text", type: STRING, mutable: false },
    );
    const ranges = analyzeIntegerRanges(f);
    return { inside: ranges.get(inside), after: ranges.get(after) };
  };
  // Each inner pass starts below the length, so the scan stops at it at the
  // latest; the skip then adds 2.
  const bounded = scan(
    and(condition("<", ref("pos"), length), condition("===", ref("unknown"), num(1))),
  );
  expect(run(bounded)).toEqual({
    inside: { min: 0, max: 2147483646 },
    after: { min: 0, max: 2147483649 },
  });
  // A nested loop that does not bound the counter, or writes it in its
  // condition, leaves it unbounded.
  expect(run(scan(condition("===", ref("unknown"), num(1)))).after).toBeNull();
  const writing = scan(
    condition(
      "<",
      { loc, kind: "incDec", op: "+", prefix: true, localId: "pos", type: F64 },
      length,
    ),
  );
  expect(run(writing).after).toBeNull();
  // The same scan inside a labeled block or an expression is not walked
  // pass by pass; its increments could repeat, so the counter stays unbounded.
  expect(run({ loc, kind: "block", labels: ["scan"], body: [bounded] }).after).toBeNull();
  const inExpression: IrStmt = {
    loc,
    kind: "exprStmt",
    expr: { loc, kind: "seqExpr", stmts: [bounded], result: num(0), type: F64 },
  };
  expect(run(inExpression).after).toBeNull();
});

test("an array length bounds while and for counters even when the body resizes the array", () => {
  // let i = 0; while (i < items.length) { observe(i); items.push(i); i++; } observe(i);
  const ARR = { kind: "array", elem: F64 } as const;
  const items: IrExpr = { loc, kind: "varRef", localId: "items", type: ARR };
  const length: IrExpr = {
    loc,
    kind: "arrIntrinsic",
    method: "length",
    receiver: items,
    args: [],
    type: F64,
  };
  const push: IrStmt = {
    loc,
    kind: "exprStmt",
    expr: {
      loc,
      kind: "arrIntrinsic",
      method: "push",
      receiver: items,
      args: [ref("i")],
      type: F64,
    },
  };
  const bump: IrStmt = {
    loc,
    kind: "exprStmt",
    expr: { loc, kind: "incDec", op: "+", prefix: false, localId: "i", type: F64 },
  };
  const inside = ref("i"),
    after = ref("i");
  const f = fn([
    { loc, kind: "assign", localId: "i", value: num(0) },
    {
      loc,
      kind: "while",
      cond: condition("<", ref("i"), length),
      body: [observe(inside), push, bump],
    },
    observe(after),
  ]);
  f.locals.push(
    { id: "i", name: "i", type: F64, mutable: true },
    { id: "items", name: "items", type: ARR, mutable: false },
  );
  const ranges = analyzeIntegerRanges(f);
  expect(ranges.get(inside)).toEqual({ min: 0, max: 4294967294 });
  expect(ranges.get(after)).toEqual({ min: 0, max: 4294967295 });
  // A secondary cursor of `for (let j = 0; j < items.length; j++) k++` stays a uint32.
  const cursor = ref("k");
  const loop: IrStmt = {
    loc,
    kind: "for",
    init: { loc, kind: "varDecl", localId: "j", init: num(0) },
    cond: condition("<", ref("j"), length),
    update: { loc, kind: "assign", localId: "j", value: bin("+", ref("j"), num(1)) },
    body: [
      push,
      observe(cursor),
      { loc, kind: "assign", localId: "k", value: bin("+", ref("k"), num(1)) },
    ],
  };
  const g = fn([{ loc, kind: "assign", localId: "k", value: num(0) }, loop]);
  g.locals.push(
    { id: "j", name: "j", type: F64, mutable: true },
    { id: "k", name: "k", type: F64, mutable: true },
    { id: "items", name: "items", type: ARR, mutable: false },
  );
  expect(analyzeIntegerRanges(g).get(cursor)).toEqual({ min: 0, max: 4294967295 });
});

test("a counter plus or minus a literal compared with a bound narrows the counter", () => {
  // for (let i = 0; i + 1 < items.length; i++) { pair(items, i, i + 1); }
  const ARR = { kind: "array", elem: F64 } as const;
  const items: IrExpr = { loc, kind: "varRef", localId: "items", type: ARR };
  const length: IrExpr = {
    loc,
    kind: "arrIntrinsic",
    method: "length",
    receiver: items,
    args: [],
    type: F64,
  };
  const inside = ref("i"),
    next = bin("+", ref("i"), num(1)),
    step = bin("+", ref("i"), num(1));
  const call: IrStmt = {
    loc,
    kind: "exprStmt",
    expr: { loc, kind: "call", callee: "pair", args: [items, inside, next], type: F64 },
  };
  const f = fn([
    {
      loc,
      kind: "for",
      init: { loc, kind: "varDecl", localId: "i", init: num(0) },
      cond: condition("<", bin("+", ref("i"), num(1)), length),
      update: { loc, kind: "assign", localId: "i", value: step },
      body: [call],
    },
  ]);
  f.locals.push(
    { id: "i", name: "i", type: F64, mutable: true },
    { id: "items", name: "items", type: ARR, mutable: false },
  );
  const ranges = analyzeIntegerRanges(f);
  expect(ranges.get(inside)).toEqual({ min: 0, max: 4294967293 });
  expect(ranges.get(next)).toEqual({ min: 1, max: 4294967294 });
  expect(ranges.get(step)).toEqual({ min: 1, max: 4294967294 });

  // if (1 + x < 10) observe(x); if (x - 2 >= 0) observe(x); with x in [0, 100]
  const below = ref(),
    above = ref(),
    wide = ref();
  const g = fn([
    assign(bin("&", ref("unknown"), num(100))),
    {
      loc,
      kind: "if",
      cond: condition("<", bin("+", num(1), ref()), num(10)),
      then: [observe(below)],
      else_: null,
    },
    {
      loc,
      kind: "if",
      cond: condition(">=", bin("-", ref(), num(2)), num(0)),
      then: [observe(above)],
      else_: null,
    },
    // A bound beyond 2^52 narrows nothing through an offset.
    {
      loc,
      kind: "if",
      cond: condition("<", bin("+", ref(), num(1)), num(2 ** 53)),
      then: [observe(wide)],
      else_: null,
    },
  ]);
  const gRanges = analyzeIntegerRanges(g);
  expect(gRanges.get(below)).toEqual({ min: 0, max: 8 });
  expect(gRanges.get(above)).toEqual({ min: 2, max: 100 });
  expect(gRanges.get(wide)).toEqual({ min: 0, max: 100 });
});

test("an offset comes off a fractional bound after the bound rounds to an integer", () => {
  // x = unknown | 0; if (x + 2147483648 > -(2 ** -60)) observe(x): the sum is
  // an integer, so the condition holds exactly when x + 2^31 >= 0. Subtracting
  // the offset from the fractional bound first would round to -2^31 and drop
  // x = -2^31 from the range.
  const kept = ref();
  const f = fn([
    assign(bin("|", ref("unknown"), num(0))),
    {
      loc,
      kind: "if",
      cond: condition(">", bin("+", ref(), num(2147483648)), num(-(2 ** -60))),
      then: [observe(kept)],
      else_: null,
    },
  ]);
  expect(analyzeIntegerRanges(f).get(kept)).toEqual({ min: -2147483648, max: 2147483647 });
});

test("whole-program slot facts seed parameters, field reads and call results", () => {
  const field: IrExpr = {
    loc,
    kind: "fieldGet",
    obj: { loc, kind: "varRef", localId: "o", type: { kind: "object", className: "C" } },
    className: "C",
    field: "flags",
    type: F64,
  };
  const result: IrExpr = { loc, kind: "call", callee: "bits", args: [], type: F64 };
  const param = ref("p");
  const f: IrFunction = {
    ...fn([observe(field), observe(result), observe(param)]),
    params: [{ localId: "p", name: "p", type: F64 }],
    locals: [{ id: "p", name: "p", type: F64, mutable: true }],
  };
  const plain = analyzeIntegerRanges(f);
  expect([plain.get(field), plain.get(result), plain.get(param)]).toEqual([null, null, null]);
  const seeded = analyzeIntegerRanges(f, {
    params: new Map([["p", INT32]]),
    field: (className, name) => (className === "C" && name === "flags" ? INT32 : null),
    call: (callee) => (callee === "bits" ? INT32 : null),
  });
  expect([seeded.get(field), seeded.get(result), seeded.get(param)]).toEqual([INT32, INT32, INT32]);
});

test("string lengths and found indices are int32, other string reads stay unknown", () => {
  const text: IrExpr = { loc, kind: "strLit", value: "abc", type: STRING };
  const read = (method: "length" | "indexOf" | "charCodeAt", args: IrExpr[] = []): IrExpr => ({
    loc,
    kind: "strIntrinsic",
    method,
    receiver: text,
    args,
    type: F64,
  });
  const length = read("length");
  const found = read("indexOf", [{ loc, kind: "strLit", value: "b", type: STRING }]);
  const code = read("charCodeAt", [num(0)]);
  const next = bin("+", length, num(1));
  const ranges = analyzeIntegerRanges(
    fn([observe(length), observe(found), observe(code), observe(next)]),
  );
  expect(ranges.get(length)).toEqual({ min: 0, max: 2147483647 });
  expect(ranges.get(found)).toEqual({ min: -1, max: 2147483647 });
  // charCodeAt can be NaN.
  expect(ranges.get(code)).toBeNull();
  expect(ranges.get(next)).toEqual({ min: 1, max: 2147483648 });
});

const BITWISE: Record<BitwiseOp, (left: number, right: number) => number> = {
  "&": (left, right) => left & right,
  "|": (left, right) => left | right,
  "^": (left, right) => left ^ right,
  "<<": (left, right) => left << right,
  ">>": (left, right) => left >> right,
  ">>>": (left, right) => left >>> right,
};

test("bitwise result ranges contain every JS result over their operands", () => {
  const ranges: { min: number; max: number }[] = [
    { min: 0, max: 0 },
    { min: 0, max: 1 },
    { min: 0, max: 100 },
    { min: 3, max: 5 },
    { min: -1, max: -1 },
    { min: -7, max: -2 },
    { min: -5, max: 9 },
    { min: 0, max: 31 },
    { min: 30, max: 33 },
    { min: 2 ** 31 - 2, max: 2 ** 31 + 1 },
    { min: 2 ** 31, max: 2 ** 32 - 1 },
    { min: 2 ** 32 - 1, max: 2 ** 32 + 1 },
    { min: -(2 ** 31) - 1, max: -(2 ** 31) + 1 },
    { min: -(2 ** 31), max: 2 ** 31 - 1 },
    { min: 0, max: 2 ** 32 - 1 },
    { min: -(2 ** 53), max: 2 ** 53 },
  ];
  const literals = [
    -0,
    0.5,
    -1.5,
    NaN,
    Infinity,
    -Infinity,
    2 ** 31,
    2 ** 32,
    2 ** 32 + 3,
    2 ** 53 + 2,
  ];
  const samples = (operand: BitwiseOperand): number[] => {
    if (typeof operand === "number") return [operand];
    if (operand === null) return [...literals, 7, -7, 2 ** 31 - 1, -(2 ** 31)];
    const { min, max } = operand;
    const values = new Set([min, max, Math.floor((min + max) / 2), min + 1, max - 1]);
    if (max - min <= 64) for (let value = min; value <= max; value++) values.add(value);
    return [...values].filter((value) => value >= min && value <= max);
  };
  const operands: BitwiseOperand[] = [null, ...ranges, ...literals, 0, -1, 3, 31, 32, 255];
  for (const op of Object.keys(BITWISE) as BitwiseOp[])
    for (const left of operands)
      for (const right of operands) {
        const range = bitwiseRange(op, left, right);
        for (const a of samples(left))
          for (const b of samples(right)) {
            const result = BITWISE[op](a, b);
            if (result < range.min || result > range.max || Object.is(result, -0))
              throw new Error(
                `${a} ${op} ${b} = ${result} outside [${range.min}, ${range.max}] (operands ${JSON.stringify(left)}, ${JSON.stringify(right)})`,
              );
          }
      }
});

test("bitwise ranges keep known operand ranges", () => {
  const small = { min: 0, max: 100 };
  expect(bitwiseRange("|", small, 0)).toEqual(small);
  expect(bitwiseRange("|", 0, small)).toEqual(small);
  expect(bitwiseRange("^", small, 2 ** 32)).toEqual(small);
  expect(bitwiseRange("&", small, -1)).toEqual(small);
  expect(bitwiseRange("&", null, 255)).toEqual({ min: 0, max: 255 });
  expect(bitwiseRange("|", small, { min: 1, max: 2 })).toEqual({ min: 1, max: 127 });
  expect(bitwiseRange(">>", small, 1)).toEqual({ min: 0, max: 50 });
  expect(bitwiseRange(">>", { min: -9, max: 9 }, null)).toEqual({ min: -9, max: 9 });
  expect(bitwiseRange("<<", small, 2)).toEqual({ min: 0, max: 400 });
  expect(bitwiseRange(">>>", null, 1)).toEqual({ min: 0, max: 2 ** 31 - 1 });
  expect(bitwiseRange(">>>", { min: -1, max: -1 }, 0)).toEqual({
    min: 2 ** 32 - 1,
    max: 2 ** 32 - 1,
  });
  expect(bitwiseRange("|", { min: 2 ** 31, max: 2 ** 31 }, 0)).toEqual({
    min: -(2 ** 31),
    max: -(2 ** 31),
  });
  expect(bitwiseRange("|", null, 0)).toEqual(INT32);
  expect(bitwiseRange("|", NaN, 0)).toEqual({ min: 0, max: 0 });
  // The analysis carries operand ranges through `| 0` and shifts.
  const length: IrExpr = {
    loc,
    kind: "strIntrinsic",
    method: "length",
    receiver: { loc, kind: "varRef", localId: "s", type: STRING },
    args: [],
    type: F64,
  };
  const truncated = bin("|", length, num(0));
  const half = bin(">>", length, num(1));
  const analyzed = analyzeIntegerRanges(
    fn([observe(truncated), observe(half), observe(bin("|", ref("unknown"), num(0)))]),
  );
  expect(analyzed.get(truncated)).toEqual({ min: 0, max: 2 ** 31 - 1 });
  expect(analyzed.get(half)).toEqual({ min: 0, max: 2 ** 30 - 1 });
});

test("bitwise identity operands follow ToInt32 and the shift-count mask", () => {
  const x = ref();
  const identity = (op: BitwiseOp, left: IrExpr, right: IrExpr) =>
    bitwiseIdentityOperand(bin(op, left, right) as IrExpr & { kind: "bin" });
  expect(identity("|", x, num(0))).toBe("left");
  expect(identity("|", num(0), x)).toBe("right");
  expect(identity("|", x, num(-0))).toBe("left");
  expect(identity("|", x, num(2 ** 32))).toBe("left");
  expect(identity("^", x, num(NaN))).toBe("left");
  expect(identity("&", x, num(-1))).toBe("left");
  expect(identity("&", num(2 ** 32 - 1), x)).toBe("right");
  expect(identity("<<", x, num(0))).toBe("left");
  expect(identity(">>", x, num(32))).toBe("left");
  expect(identity(">>>", x, num(0))).toBe("left");
  expect(identity("|", x, num(1))).toBeNull();
  expect(identity("&", x, num(0))).toBeNull();
  expect(identity(">>", x, num(1))).toBeNull();
  expect(identity("<<", num(0), x)).toBeNull();
  expect(identity(">>>", num(0), x)).toBeNull();
});

test("a for loop bounds cursors it resets and copies, and their writes keep the loop range", () => {
  // for (x = 0; x < 100; x++) { if (flag === 0) run = run + 1; else run = 0;
  //   if (run > longest) longest = run; changes = changes + 1; }
  const sum = bin("+", ref("run"), num(1)),
    copied = ref("run"),
    counted = bin("+", ref("changes"), num(1));
  const write = (localId: string, value: IrExpr): IrStmt => ({
    loc,
    kind: "assign",
    localId,
    value,
  });
  const loop: IrStmt & { kind: "for" } = {
    loc,
    kind: "for",
    init: { loc, kind: "varDecl", localId: "x", init: num(0) },
    cond: condition("<", ref(), num(100)),
    update: assign(bin("+", ref(), num(1))),
    body: [
      {
        loc,
        kind: "if",
        cond: condition("===", ref("flag"), num(0)),
        then: [write("run", sum)],
        else_: [write("run", num(0))],
      },
      {
        loc,
        kind: "if",
        cond: condition(">", ref("run"), ref("longest")),
        then: [write("longest", copied)],
        else_: null,
      },
      write("changes", counted),
    ],
  };
  const declare = (localId: string): IrStmt => ({ loc, kind: "varDecl", localId, init: num(0) });
  const f = fn([declare("run"), declare("longest"), declare("changes"), loop]);
  f.locals.push(
    ...["run", "longest", "changes", "flag"].map((id) => ({
      id,
      name: id,
      type: F64,
      mutable: true,
    })),
  );
  const ranges = analyzeIntegerRanges(f);
  // Each of the 100 passes adds at most one, so `run + 1` and
  // `changes + 1` stay within the loop range though their operands reach it.
  const range = { min: 0, max: 100 };
  expect(ranges.get(sum)).toEqual({ min: 1, max: 100 });
  expect(ranges.get(counted)).toEqual({ min: 1, max: 100 });
  expect(ranges.get(copied)).toEqual({ min: 1, max: 100 });
  expect(analyzeIntegerRangeFacts(f).loopRanges.get(loop)).toEqual(
    new Map([
      ["run", range],
      ["longest", range],
      ["changes", range],
    ]),
  );
  for (const mutation of ["fraction", "cycle", "nested"] as const) {
    const changed = structuredClone(f);
    const body = (changed.body[3] as IrStmt & { kind: "for" }).body;
    if (mutation === "fraction") body.push(write("run", num(0.5)));
    // `run = longest` and `longest = run` bound neither.
    if (mutation === "cycle") body.push(write("run", ref("longest")));
    if (mutation === "nested")
      body.push({
        loc,
        kind: "while",
        cond: condition("<", ref("unknown"), num(1)),
        body: [write("run", num(0))],
      });
    const cursors = analyzeIntegerRangeFacts(changed).loopRanges.get(changed.body[3]!);
    expect(cursors?.has("run"), mutation).toBe(false);
    expect(cursors?.get("changes"), mutation).toEqual(range);
  }
});

test("a cursor of a loop over a typed array keeps its writes within the largest length", () => {
  // for (x = 0; x < bytes.length; x++) changes = changes + 1;
  const bytes: IrExpr = {
    loc,
    kind: "varRef",
    localId: "bytes",
    type: { kind: "bytes", elem: "u8" },
  };
  const length: IrExpr = {
    loc,
    kind: "bytesIntrinsic",
    method: "length",
    receiver: bytes,
    args: [],
    type: F64,
  };
  const counted = bin("+", ref("changes"), num(1));
  const f = fn([
    { loc, kind: "varDecl", localId: "changes", init: num(0) },
    {
      loc,
      kind: "for",
      init: { loc, kind: "varDecl", localId: "x", init: num(0) },
      cond: condition("<", ref(), length),
      update: assign(bin("+", ref(), num(1))),
      body: [{ loc, kind: "assign", localId: "changes", value: counted }],
    },
  ]);
  f.locals.push(
    { id: "changes", name: "changes", type: F64, mutable: true },
    { id: "bytes", name: "bytes", type: { kind: "bytes", elem: "u8" }, mutable: false },
  );
  // The sum of the header range passes the largest typed array length; the
  // write takes the loop range instead.
  expect(analyzeIntegerRanges(f).get(counted)).toEqual({ min: 1, max: 2 ** 48 });
});
