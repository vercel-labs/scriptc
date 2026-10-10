import { expect, test } from "vitest";
import {
  DYN,
  F64,
  STRING,
  VOID,
  type IrExpr,
  type IrModule,
  type IrStmt,
  type IrType,
} from "../ir/ir.js";
import { computeConstructionFacts, computeImmutableFields, stableGlobals } from "./immutability.js";

const loc = { file: "immutability.ts", start: 0, end: 1 };
const obj = (className: string): IrType => ({ kind: "object", className });
const value = (type: IrType): IrExpr => ({ kind: "varRef", localId: "v", type, loc });
const thisRef = (className: string): IrExpr => ({
  kind: "varRef",
  localId: "this.0",
  type: obj(className),
  loc,
});
const setThis = (className: string, field: string): IrStmt => ({
  kind: "fieldSet",
  obj: thisRef(className),
  className,
  field,
  value: value(F64),
  loc,
});
const call = (callee: string, args: IrExpr[]): IrStmt => ({
  kind: "exprStmt",
  expr: { kind: "call", callee, args, type: VOID, loc },
  loc,
});
function ctor(className: string, body: IrStmt[]): IrModule["functions"][number] {
  return {
    name: `%${className}.constructor`,
    params: [{ localId: "this.0", name: "this", type: obj(className) }],
    locals: [],
    returnType: VOID,
    body,
    loc,
  };
}
function module(
  classes: NonNullable<IrModule["classes"]>,
  functions: IrModule["functions"],
): IrModule {
  return {
    irVersion: 15,
    sourceFile: loc.file,
    entry: "main",
    classes,
    functions: [
      { name: "main", locals: [], params: [], returnType: VOID, body: [], loc },
      ...functions,
    ],
  };
}
const fields = (...names: string[]) => names.map((name) => ({ name, type: F64 }));

/** The fields of `className` whose constructor stores are private. */
function privateFields(mod: IrModule, className: string): string[] {
  const facts = computeConstructionFacts(mod);
  const fn = mod.functions.find((f) => f.name === `%${className}.constructor`)!;
  return fn.body
    .filter((s): s is Extract<IrStmt, { kind: "fieldSet" }> => s.kind === "fieldSet")
    .filter((s) => facts.privateStores.has(s))
    .map((s) => s.field);
}

test("constructor stores before this escapes are private", () => {
  const mod = module(
    [{ name: "P", fields: fields("a", "b"), loc }],
    [ctor("P", [setThis("P", "a"), call("register", [thisRef("P")]), setThis("P", "b")])],
  );
  expect(privateFields(mod, "P")).toEqual(["a"]);
});

test("storing this into its own field does not expose it", () => {
  const self: IrStmt = { ...setThis("P", "self"), value: thisRef("P") } as IrStmt;
  const mod = module(
    [{ name: "P", fields: [...fields("a"), { name: "self", type: obj("P") }], loc }],
    [ctor("P", [self, setThis("P", "a")])],
  );
  expect(privateFields(mod, "P")).toEqual(["self", "a"]);
});

test("a base constructor's escape makes every subclass store public", () => {
  const superCall = call("%Base.constructor", [
    { kind: "upcast", value: thisRef("Sub"), type: obj("Base"), loc },
  ]);
  const mod = module(
    [
      { name: "Base", fields: fields("a"), loc },
      { name: "Sub", base: "Base", fields: fields("a", "b"), loc },
    ],
    [
      ctor("Base", [setThis("Base", "a"), call("register", [thisRef("Base")])]),
      ctor("Sub", [superCall, setThis("Sub", "b")]),
    ],
  );
  expect(privateFields(mod, "Base")).toEqual(["a"]);
  expect(privateFields(mod, "Sub")).toEqual([]);
});

test("a constructor called on an existing object keeps every guard", () => {
  const mod = module([{ name: "P", fields: fields("a"), loc }], [ctor("P", [setThis("P", "a")])]);
  expect(privateFields(mod, "P")).toEqual(["a"]);
  mod.functions[0]!.body.push(call("%P.constructor", [value(obj("P"))]));
  expect(privateFields(mod, "P")).toEqual([]);
});

test("library builds keep every guard", () => {
  const mod = module([{ name: "P", fields: fields("a"), loc }], [ctor("P", [setThis("P", "a")])]);
  mod.lib = {} as NonNullable<IrModule["lib"]>;
  expect(privateFields(mod, "P")).toEqual([]);
});

test("construction-only fields exclude later writes and dynamic stores", () => {
  const mod = module(
    [{ name: "P", fields: fields("a", "b"), loc }],
    [ctor("P", [setThis("P", "a"), setThis("P", "b")])],
  );
  mod.functions[0]!.body.push(
    { kind: "fieldSet", obj: value(obj("P")), className: "P", field: "b", value: value(F64), loc },
    { kind: "exprStmt", expr: { kind: "dynFrom", value: value(obj("P")), type: DYN, loc }, loc },
  );
  const facts = computeImmutableFields(mod)!;
  expect(facts.classField("P", "a")).toBe(true);
  expect(facts.classField("P", "b")).toBe(false);
  // A runtime store into a dynamic value can reach P through its capsule.
  mod.functions[0]!.body.push({
    kind: "exprStmt",
    expr: {
      kind: "libCall",
      fn: "dyn.keySet",
      args: [value(DYN), value(STRING), value(DYN)],
      type: VOID,
      loc,
    },
    loc,
  });
  expect(computeImmutableFields(mod)!.classField("P", "a")).toBe(false);
});

test("module constants are stable once assigned exactly once", () => {
  const mod = module([], []);
  mod.globals = [
    { id: "%g.k", name: "k", type: STRING, mutable: false },
    { id: "%g.m", name: "m", type: STRING, mutable: true },
    { id: "%g.t", name: "t", type: STRING, mutable: false, tdz: true },
    { id: "%g.twice", name: "twice", type: STRING, mutable: false },
  ];
  const assign = (localId: string): IrStmt => ({
    kind: "assign",
    localId,
    value: value(STRING),
    loc,
  });
  mod.functions[0]!.body.push(
    assign("%g.k"),
    assign("%g.m"),
    assign("%g.t"),
    assign("%g.twice"),
    assign("%g.twice"),
  );
  expect([...stableGlobals(mod)]).toEqual(["%g.k"]);
});
