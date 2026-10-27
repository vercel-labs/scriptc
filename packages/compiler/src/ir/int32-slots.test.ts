import { expect, test } from "vitest";
import { analyzeInt32Slots } from "./int32-slots.js";
import {
  BOOL,
  DYN,
  F64,
  STRING,
  VOID,
  type IrClassDef,
  type IrExpr,
  type IrFunction,
  type IrModule,
  type IrStmt,
  type IrType,
} from "./ir.js";

const loc = { file: "test.ts", start: 0, end: 0 };
const obj = (className: string): IrType => ({ kind: "object", className });
const num = (value: number): IrExpr => ({ loc, kind: "numLit", value, type: F64 });
const ref = (localId: string, type: IrType = F64): IrExpr => ({
  loc,
  kind: "varRef",
  localId,
  type,
});
const bin = (op: "|" | "&" | "+" | "-" | "/" | "*" | "%", left: IrExpr, right: IrExpr): IrExpr => ({
  loc,
  kind: "bin",
  op,
  left,
  right,
  type: F64,
});
const cmp = (op: "===" | "!==" | ">", left: IrExpr, right: IrExpr): IrExpr => ({
  loc,
  kind: "bin",
  op,
  left,
  right,
  type: BOOL,
});
const cond = (test: IrExpr, then: IrExpr, else_: IrExpr): IrExpr => ({
  loc,
  kind: "ternary",
  cond: test,
  then,
  else_,
  type: then.type,
});
const get = (target: IrExpr, className: string, field: string): IrExpr => ({
  loc,
  kind: "fieldGet",
  obj: target,
  className,
  field,
  type: F64,
});
const set = (target: IrExpr, className: string, field: string, value: IrExpr): IrStmt => ({
  loc,
  kind: "fieldSet",
  obj: target,
  className,
  field,
  value,
});
const call = (callee: string, args: IrExpr[], type: IrType = F64): IrExpr => ({
  loc,
  kind: "call",
  callee,
  args,
  type,
});
const stmt = (expr: IrExpr): IrStmt => ({ loc, kind: "exprStmt", expr });
const ret = (value: IrExpr | null): IrStmt => ({ loc, kind: "return", value });
const fn = (
  name: string,
  params: { id: string; type?: IrType }[],
  body: IrStmt[],
  returnType: IrType = VOID,
): IrFunction => ({
  loc,
  name,
  params: params.map((p) => ({ localId: p.id, name: p.id, type: p.type ?? F64 })),
  locals: params.map((p) => ({ id: p.id, name: p.id, type: p.type ?? F64, mutable: true })),
  returnType,
  body,
});
const cls = (name: string, fields: string[], base?: string): IrClassDef => ({
  loc,
  name,
  ...(base ? { base } : {}),
  fields: fields.map((field) => ({ name: field, type: F64 })),
});
const ctor = (className: string, fields: string[]): IrFunction =>
  fn(
    `%${className}.constructor`,
    [{ id: "this", type: obj(className) }, ...fields.map((f) => ({ id: f }))],
    fields.map((f) => set(ref("this", obj(className)), className, f, ref(f))),
  );
const newOf = (className: string, args: IrExpr[]): IrExpr => ({
  loc,
  kind: "new",
  className,
  args,
  type: obj(className),
});
const mod = (classes: IrClassDef[], functions: IrFunction[]): IrModule => ({
  irVersion: 17,
  sourceFile: "test.ts",
  entry: "%main",
  classes,
  functions: [fn("%main", [], []), ...functions],
  records: [],
  unions: [],
  globals: [],
});

test("proves fields through constructor parameter chains and rejects a fractional caller", () => {
  const classes = [cls("T", ["flags", "id"])];
  const make = fn(
    "make",
    [{ id: "f" }],
    [ret(newOf("T", [bin("|", ref("f"), num(4)), num(1)]))],
    obj("T"),
  );
  const int = mod(classes, [
    ctor("T", ["flags", "id"]),
    make,
    fn("use", [], [stmt(call("make", [num(3)], obj("T")))]),
  ]);
  const slots = analyzeInt32Slots(int);
  expect(slots.isField("T", "flags")).toBe(true);
  expect(slots.isField("T", "id")).toBe(true);
  // Narrowed from non-negative int32 to the only argument passed.
  expect(slots.facts("make").params?.get("f")).toEqual({ min: 3, max: 3 });

  const fraction = fn("frac", [], [stmt(newOf("T", [num(1), num(0.5)]))]);
  const mixed = analyzeInt32Slots(mod(classes, [ctor("T", ["flags", "id"]), make, fraction]));
  expect(mixed.isField("T", "flags")).toBe(true);
  expect(mixed.isField("T", "id")).toBe(false);
  expect(mixed.reasons.get("field:T\0id")).toMatch(/not int32/);
});

test("subclass writes share the base field and ++ disqualifies it", () => {
  const classes = [cls("Base", ["x", "y"]), cls("Sub", ["x", "y"], "Base")];
  const self = ref("s", obj("Sub"));
  const functions = [
    fn(
      "init",
      [{ id: "s", type: obj("Sub") }],
      [
        set(self, "Sub", "x", bin("+", get(self, "Sub", "x"), num(1))),
        set(self, "Base", "y", num(2)),
        stmt({
          loc,
          kind: "fieldIncDec",
          obj: self,
          className: "Sub",
          field: "y",
          op: "+",
          prefix: true,
          type: F64,
        } as IrExpr),
      ],
    ),
  ];
  const slots = analyzeInt32Slots(mod(classes, functions));
  expect(slots.family("Sub", "x")).toBe("Base\0x");
  expect(slots.isField("Base", "x")).toBe(false);
  expect(slots.isField("Base", "y")).toBe(false);
  expect(slots.reasons.get("field:Base\0y")).toMatch(/\+\+/);
});

test("results are proven per return and parameters of escaping functions stay unknown", () => {
  const functions = [
    fn("bits", [{ id: "n" }], [ret(bin("&", ref("n"), num(255)))], F64),
    fn("half", [{ id: "n" }], [ret(bin("/", ref("n"), num(2)))], F64),
    fn("cb", [{ id: "n" }], [ret(ref("n"))], F64),
    fn(
      "user",
      [],
      [
        stmt(call("bits", [num(1)])),
        stmt(call("half", [num(1)])),
        stmt(call("cb", [num(1)])),
        stmt({ loc, kind: "closure", fnName: "cb", captures: [], type: DYN }),
      ],
    ),
  ];
  const slots = analyzeInt32Slots(mod([], functions));
  // Narrowed to `n & 255`; each bound narrows once, so the later fact that
  // n is only ever 1 does not narrow it again.
  expect(slots.facts("user").call?.("bits")).toEqual({ min: 0, max: 255 });
  expect(slots.facts("user").call?.("half")).toBeNull();
  expect(slots.facts("bits").params?.has("n")).toBe(true);
  expect(slots.facts("cb").params).toBeUndefined();
});

test("virtual dispatch targets keep unknown parameters", () => {
  const classes = [cls("A", []), cls("B", [], "A")];
  const recv = ref("a", obj("A"));
  const functions = [
    fn("%A.m", [{ id: "this", type: obj("A") }, { id: "n" }], []),
    fn("%B.m", [{ id: "this", type: obj("B") }, { id: "n" }], []),
    fn("%A.direct", [{ id: "this", type: obj("A") }, { id: "n" }], []),
    fn(
      "user",
      [{ id: "a", type: obj("A") }],
      [
        stmt({
          loc,
          kind: "virtualCall",
          className: "A",
          method: "m",
          args: [recv, num(1)],
          type: VOID,
        }),
        stmt(call("%A.direct", [recv, num(1)], VOID)),
      ],
    ),
  ];
  const slots = analyzeInt32Slots(mod(classes, functions));
  expect(slots.facts("%A.m").params).toBeUndefined();
  expect(slots.facts("%B.m").params).toBeUndefined();
  expect(slots.facts("%A.direct").params?.has("n")).toBe(true);
});

test("dynamic stores disqualify the field names they can reach", () => {
  const classes = [cls("C", ["a", "b"]), cls("Hidden", ["c"])];
  const view: IrExpr = { loc, kind: "dynFrom", value: ref("o", obj("C")), type: DYN };
  const write = (fnName: string, args: IrExpr[]): IrStmt =>
    stmt({ loc, kind: "libCall", fn: fnName, args, type: VOID } as IrExpr);
  const program = (store: IrStmt): IrModule =>
    mod(classes, [
      fn(
        "init",
        [
          { id: "o", type: obj("C") },
          { id: "h", type: obj("Hidden") },
        ],
        [
          set(ref("o", obj("C")), "C", "a", num(1)),
          set(ref("o", obj("C")), "C", "b", num(2)),
          set(ref("h", obj("Hidden")), "Hidden", "c", num(3)),
          store,
        ],
      ),
    ]);
  const strLit = (value: string): IrExpr => ({ loc, kind: "strLit", value, type: STRING });

  const named = analyzeInt32Slots(program(write("dyn.keySet", [view, strLit("a"), num(0)])));
  expect([named.isField("C", "a"), named.isField("C", "b"), named.isField("Hidden", "c")]).toEqual([
    false,
    true,
    true,
  ]);
  const computed = analyzeInt32Slots(program(write("dyn.keySetComputed", [view, view, view])));
  expect([computed.isField("C", "a"), computed.isField("C", "b")]).toEqual([false, false]);
  // Classes that never reach dynamic code are unaffected by dynamic stores.
  expect(computed.isField("Hidden", "c")).toBe(true);
  const readOnly = analyzeInt32Slots(program(write("dyn.typedRefIs", [view, strLit("object:C")])));
  expect([readOnly.isField("C", "a"), readOnly.isField("C", "b")]).toEqual([true, true]);
  // Reflection that only reads the view (Object.keys/values/entries, for-in,
  // own-key lists, typeof, toString and inspection) stores nothing, nor does
  // creating an object from a prototype, reading a prototype or naming a
  // class prototype for inspection.
  for (const reader of [
    "dyn.objKeys",
    "dyn.objKeyStrings",
    "dyn.objValues",
    "dyn.objEntries",
    "dyn.objEntryPairs",
    "dyn.forInKeys",
    "dyn.forInKeyStrings",
    "dyn.forInStable",
    "dyn.objectTag",
    "dyn.getOwnPropertyNames",
    "dyn.ownKeys",
    "dyn.hasOwn",
    "dyn.toString",
    "dyn.typeof",
    "insp.dyn",
    "insp.dynS",
    "insp.dynHidden",
    "dyn.objCreate",
    "dyn.getPrototype",
    "dyn.nameClassPrototype",
    // Registering or removing a process event listener stores nothing either.
    "process.onSignal",
    "process.offSignal",
    "process.onUncaughtException",
    "process.offUncaughtException",
    "process.onUnhandledRejection",
    "process.offUnhandledRejection",
    "process.onRejectionHandled",
    "process.offRejectionHandled",
    "process.onWarning",
    "process.offWarning",
  ]) {
    const reflected = analyzeInt32Slots(program(write(reader, [view])));
    expect([reader, reflected.isField("C", "a"), reflected.isField("C", "b")]).toEqual([
      reader,
      true,
      true,
    ]);
  }
  // The dynamic operators convert their operands to primitives and build a
  // new value; they store nothing into the view.
  for (const [operator, args] of [
    ["dyn.add", [view, strLit("|")]],
    ["dyn.arithmetic", [view, num(2), strLit("*")]],
    ["dyn.bitwise", [view, num(1), strLit("|")]],
    ["dyn.toNumeric", [view]],
    ["dyn.toNumberCoerce", [view]],
    ["dyn.increment", [view, { loc, kind: "boolLit", value: true, type: BOOL }]],
  ] as const) {
    const converted = analyzeInt32Slots(program(write(operator, [...args])));
    expect([operator, converted.isField("C", "a"), converted.isField("C", "b")]).toEqual([
      operator,
      true,
      true,
    ]);
  }
});

test("an Error subclass constructor forwarding dynamic arguments stores no class fields", () => {
  // `class E extends Error {}` forwards its arguments into the builtin
  // initializer; an unrelated class exposed to dynamic code keeps i32 fields.
  const classes = [cls("C", ["a"]), cls("E", [])];
  const view: IrExpr = { loc, kind: "dynFrom", value: ref("o", obj("C")), type: DYN };
  const libCall = (fnName: string, args: IrExpr[]): IrStmt =>
    stmt({ loc, kind: "libCall", fn: fnName, args, type: VOID } as IrExpr);
  const slots = analyzeInt32Slots(
    mod(classes, [
      fn(
        "init",
        [
          { id: "o", type: obj("C") },
          { id: "e", type: obj("E") },
          { id: "message", type: DYN },
          { id: "options", type: DYN },
        ],
        [
          set(ref("o", obj("C")), "C", "a", num(1)),
          libCall("dyn.typedRefIs", [
            view,
            { loc, kind: "strLit", value: "object:C", type: STRING },
          ]),
          libCall("error.ctorOptions", [
            ref("e", obj("E")),
            ref("message", DYN),
            ref("options", DYN),
          ]),
        ],
      ),
    ]),
  );
  expect(slots.isField("C", "a")).toBe(true);
});

test("Buffer.from over an ArrayBuffer range and Buffer as a value keep class fields int32", () => {
  // `Buffer.from(view.buffer, offset, length)` passes its operands as
  // checked values, and a program that reads the Buffer function's value
  // installs it in %main; neither stores into a class instance.
  const classes = [cls("C", ["a"])];
  const view: IrExpr = { loc, kind: "dynFrom", value: ref("o", obj("C")), type: DYN };
  const libCall = (fnName: string, args: IrExpr[], type: IrType = VOID): IrStmt =>
    stmt({ loc, kind: "libCall", fn: fnName, args, type } as IrExpr);
  const slots = analyzeInt32Slots(
    mod(classes, [
      fn(
        "load",
        [
          { id: "o", type: obj("C") },
          { id: "storage", type: DYN },
        ],
        [
          set(ref("o", obj("C")), "C", "a", num(1)),
          libCall("dyn.typedRefIs", [
            view,
            { loc, kind: "strLit", value: "object:C", type: STRING },
          ]),
          libCall("buffer.installValue", []),
          libCall("buffer.constructor", [], DYN),
          libCall(
            "buffer.poolFromDynRange",
            [ref("storage", DYN), num(2), num(4)].map((arg): IrExpr =>
              arg.type.kind === "dyn" ? arg : { loc, kind: "dynFrom", value: arg, type: DYN },
            ),
          ),
          libCall("buffer.poolFromDynOffset", [
            ref("storage", DYN),
            {
              loc,
              kind: "dynFrom",
              value: num(2),
              type: DYN,
            },
          ]),
        ],
      ),
    ]),
  );
  expect(slots.isField("C", "a")).toBe(true);
});

test("captured bindings share one proof across the declaring function and its closures", () => {
  const closure: IrExpr = { loc, kind: "closure", fnName: "inner", captures: ["s"], type: DYN };
  const outer = (): IrFunction => ({
    ...fn("outer", [{ id: "s" }], [stmt(closure)]),
    locals: [{ id: "s", name: "s", type: F64, mutable: true, boxed: true }],
  });
  const inner = (body: IrStmt[]): IrFunction => ({
    ...fn("inner", [], body),
    captures: [{ localId: "c", name: "s", type: F64 }],
    locals: [{ id: "c", name: "s", type: F64, mutable: true, boxed: true }],
  });
  const caller = fn("caller", [], [stmt(call("outer", [num(5)], VOID))]);
  const read = inner([ret(null)]);
  const proven = analyzeInt32Slots(mod([], [outer(), read, caller]));
  // Every write (the parameter's only argument, 5) is a non-negative int32.
  expect(proven.facts("inner").boxed?.("c")).toEqual({ min: 0, max: 2147483647 });
  expect(proven.facts("outer").boxed?.("s")).toEqual({ min: 0, max: 2147483647 });
  // A negative argument widens the parameter and its box to int32.
  const negative = fn("caller", [], [stmt(call("outer", [num(-5)], VOID))]);
  const widened = analyzeInt32Slots(mod([], [outer(), read, negative]));
  expect(widened.facts("inner").boxed?.("c")).toEqual({ min: -2147483648, max: 2147483647 });
  expect(widened.facts("outer").params?.get("s")).toEqual({ min: -5, max: -5 });

  const store = inner([{ loc, kind: "assign", localId: "c", value: bin("/", ref("c"), num(2)) }]);
  const stored = analyzeInt32Slots(mod([], [outer(), store, caller]));
  expect(stored.facts("outer").boxed?.("s") ?? null).toBeNull();
  expect(stored.reasons.get(`box:${stored.boxGroup("outer", "s")}`)).toMatch(/inner/);

  const fraction = fn("caller", [], [stmt(call("outer", [num(0.5)], VOID))]);
  expect(
    analyzeInt32Slots(mod([], [outer(), read, fraction]))
      .facts("inner")
      .boxed?.("c") ?? null,
  ).toBeNull();
});

test("non-negative parameter and result facts carry remainders through calls", () => {
  // step(x, n) = (x * 31 + n) % 1000003 proves a result only while x and n
  // cannot be negative; the caller feeds a result back in.
  const step = fn(
    "step",
    [{ id: "x" }, { id: "n" }],
    [ret(bin("%", bin("+", bin("*", ref("x"), num(31)), ref("n")), num(1000003)))],
    F64,
  );
  const caller = (first: number) =>
    fn("caller", [], [stmt(call("step", [call("step", [num(first), num(2)]), num(4)]))]);
  const proven = analyzeInt32Slots(mod([], [step, caller(1)]));
  // Proven at non-negative int32, then narrowed to the values written: the
  // remainder's range, x's arguments (1 and a result) and n's (2 and 4).
  expect(proven.facts("caller").call?.("step")).toEqual({ min: 0, max: 1000002 });
  expect(proven.facts("step").params?.get("x")).toEqual({ min: 0, max: 1000002 });
  expect(proven.facts("step").params?.get("n")).toEqual({ min: 2, max: 4 });
  // One negative argument widens x to int32, after which the remainder
  // may be negative or -0: no result fact, and the fed-back x fails too.
  const widened = analyzeInt32Slots(mod([], [step, caller(-1)]));
  expect(widened.facts("caller").call?.("step") ?? null).toBeNull();
  expect(widened.facts("step").params?.get("x") ?? null).toBeNull();
  expect(widened.facts("step").params?.get("n")).toEqual({ min: 2, max: 4 });
});

test("worker builds specialize int32 fields like ordinary executables", () => {
  const program = mod(
    [cls("T", ["x"])],
    [fn("init", [{ id: "t", type: obj("T") }], [set(ref("t", obj("T")), "T", "x", num(1))])],
  );
  expect(analyzeInt32Slots(program).isField("T", "x")).toBe(true);
  expect(analyzeInt32Slots({ ...program, workers: true }).isField("T", "x")).toBe(true);
});

test("counting-down recursion proves its parameter from the call-site ranges", () => {
  // count(d) = d === 0 ? 0 : count(d - 1): `d - 1` leaves int32 only for
  // the smallest int32, which no call passes.
  const count = fn(
    "count",
    [{ id: "d" }],
    [ret(cond(cmp("===", ref("d"), num(0)), num(0), call("count", [bin("-", ref("d"), num(1))])))],
    F64,
  );
  // even/odd count down through each other.
  const even = fn(
    "even",
    [{ id: "n" }],
    [ret(cond(cmp("!==", ref("n"), num(0)), call("odd", [bin("-", ref("n"), num(1))]), num(1)))],
    F64,
  );
  const odd = fn(
    "odd",
    [{ id: "n" }],
    [ret(cond(cmp("!==", ref("n"), num(0)), call("even", [bin("-", ref("n"), num(1))]), num(0)))],
    F64,
  );
  const user = (args: number[]): IrFunction =>
    fn(
      "user",
      [],
      args.flatMap((a) => [stmt(call("count", [num(a)])), stmt(call("even", [num(a)]))]),
    );
  const slots = analyzeInt32Slots(mod([], [count, even, odd, user([18, 3])]));
  // Under the non-negative assumption `d - 1` after `d !== 0` stays one.
  // Narrowing moves the upper bound once (to the largest `d - 1`) and then
  // stops instead of walking it down one step per round.
  for (const [name, id] of [
    ["count", "d"],
    ["even", "n"],
    ["odd", "n"],
  ] as const)
    expect(slots.facts(name).params?.get(id)).toEqual({ min: 0, max: 2147483646 });

  // Counting up from a negative start fails both assumptions (`d + 1`
  // leaves int32 for the largest one); the call-site ranges prove it.
  const up = fn(
    "up",
    [{ id: "d" }],
    [ret(cond(cmp("===", ref("d"), num(0)), num(0), call("up", [bin("+", ref("d"), num(1))])))],
    F64,
  );
  const rising = analyzeInt32Slots(mod([], [up, fn("user", [], [stmt(call("up", [num(-18)]))])]));
  expect(rising.facts("up").params?.get("d")).toEqual({ min: -18, max: 0 });
  // The same with the caller first, so the fixpoint analyzes it after the
  // parameter dropped: the narrowing still sees its argument.
  const callerFirst = analyzeInt32Slots(
    mod([], [fn("user", [], [stmt(call("up", [num(-18)]))]), up]),
  );
  expect(callerFirst.facts("up").params?.get("d")).toEqual({ min: -18, max: 0 });

  // A negative start counts down past the smallest int32.
  const negative = analyzeInt32Slots(mod([], [count, even, odd, user([18, -1])]));
  expect(negative.facts("count").params?.has("d") ?? false).toBe(false);
  expect(negative.facts("even").params?.has("n") ?? false).toBe(false);
  // A fraction never reaches the parameter either.
  const fraction = analyzeInt32Slots(mod([], [count, even, odd, user([0.5])]));
  expect(fraction.facts("count").params?.has("d") ?? false).toBe(false);
});

test("narrowed divisor facts prove remainders only while every divisor is positive", () => {
  // rem(a, m) = (a * 33 + 1) % m: at non-negative int32 the divisor may be
  // 0 (NaN), so only the values the call sites pass prove a result.
  const rem = fn(
    "rem",
    [{ id: "a" }, { id: "m" }],
    [ret(bin("%", bin("+", bin("*", ref("a"), num(33)), num(1)), ref("m")))],
    F64,
  );
  const caller = (divisors: number[]): IrFunction =>
    fn(
      "caller",
      [],
      divisors.map((m, i) => stmt(call("rem", [num(i + 5), num(m)]))),
    );
  const positive = analyzeInt32Slots(mod([], [rem, caller([1000003, 97])]));
  expect(positive.facts("rem").params?.get("m")).toEqual({ min: 97, max: 1000003 });
  // The result the level dropped is revived: a is 5 or 6, so `a * 33 + 1`
  // is at most 199 and so is the remainder.
  expect(positive.facts("caller").call?.("rem")).toEqual({ min: 0, max: 199 });
  // One zero divisor anywhere: the remainder may be NaN, so no result fact.
  const zero = analyzeInt32Slots(mod([], [rem, caller([1000003, 0])]));
  expect(zero.facts("rem").params?.get("m")).toEqual({ min: 0, max: 1000003 });
  expect(zero.facts("caller").call?.("rem") ?? null).toBeNull();
  expect(zero.reasons.get("ret:rem")).toMatch(/not int32/);
});
