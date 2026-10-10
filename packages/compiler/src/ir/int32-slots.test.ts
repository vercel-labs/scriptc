import { expect, test } from "vitest";
import { analyzeInt32Slots } from "./int32-slots.js";
import {
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
const bin = (op: "|" | "&" | "+" | "/", left: IrExpr, right: IrExpr): IrExpr => ({
  loc,
  kind: "bin",
  op,
  left,
  right,
  type: F64,
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
  irVersion: 15,
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
  expect(slots.facts("make").params?.get("f")).toEqual({ min: -2147483648, max: 2147483647 });

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
  expect(slots.facts("user").call?.("bits")).toEqual({ min: -2147483648, max: 2147483647 });
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
  expect(proven.facts("inner").boxed?.("c")).toEqual({ min: -2147483648, max: 2147483647 });
  expect(proven.facts("outer").boxed?.("s")).toEqual({ min: -2147483648, max: 2147483647 });

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

test("worker builds specialize int32 fields like ordinary executables", () => {
  const program = mod(
    [cls("T", ["x"])],
    [fn("init", [{ id: "t", type: obj("T") }], [set(ref("t", obj("T")), "T", "x", num(1))])],
  );
  expect(analyzeInt32Slots(program).isField("T", "x")).toBe(true);
  expect(analyzeInt32Slots({ ...program, workers: true }).isField("T", "x")).toBe(true);
});
