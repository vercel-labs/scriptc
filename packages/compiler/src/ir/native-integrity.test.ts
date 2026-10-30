import { expect, test } from "vitest";
import {
  BOOL,
  DYN,
  F64,
  VOID,
  arrayOf,
  funcOf,
  type IrClassDef,
  type IrExpr,
  type IrFunction,
  type IrModule,
  type IrType,
} from "./ir.js";
import { computeNativeIntegrityTypes, computeRecordMetadataShapes } from "./native-integrity.js";
import { computePublishedTypes } from "../backend/publication.js";

const loc = { file: "integrity.ts", start: 0, end: 1 };
const record = (shapeId: string): IrType => ({ kind: "record", shapeId });
const object = (className: string): IrType => ({ kind: "object", className });
const ref = (type: IrType): IrExpr => ({ kind: "varRef", localId: "value", type, loc });
const cls = (name: string, fields: [string, IrType][], base?: string): IrClassDef =>
  ({
    name,
    fields: fields.map(([name, type]) => ({ name, type })),
    ...(base ? { base } : {}),
    loc,
  }) as IrClassDef;
const fn = (expr: IrExpr): IrFunction => ({
  name: "main",
  params: [],
  locals: [],
  returnType: VOID,
  body: [{ kind: "exprStmt", expr, loc }],
  loc,
});
const moduleWith = (expr: IrExpr): IrModule => ({
  irVersion: 17,
  sourceFile: loc.file,
  entry: "main",
  records: [
    { id: "child", fields: [{ name: "value", type: F64 }] },
    { id: "unrelated", fields: [{ name: "other", type: BOOL }] },
  ],
  classes: [
    cls("Base", [["value", F64]]),
    cls("Derived", [["child", record("child")]], "Base"),
    cls("Sibling", [], "Base"),
    cls("Other", []),
  ],
  functions: [fn(expr)],
});

test("checked integrity aliases require referent identity throughout their exposed hierarchy", () => {
  const mod = moduleWith({
    kind: "libCall",
    fn: "dyn.isFrozen",
    args: [{ kind: "dynFrom", value: ref(object("Derived")), type: DYN, loc }],
    type: BOOL,
    loc,
  });
  const facts = computeNativeIntegrityTypes(mod)!;
  expect([...facts.classes].sort()).toEqual(["Base", "Derived", "Sibling"]);
  expect(facts.requiresHeapIdentity(record("child"))).toBe(true);
  expect(facts.requiresHeapIdentity(record("unrelated"))).toBe(false);
  expect(facts.requiresHeapIdentity(object("Other"))).toBe(false);
  // Identity is not publication: constructor stores cannot inherit its exemption.
  expect(computePublishedTypes(mod)).toBeNull();
});

test("generated function and promise adapters expose native parameter and result identities", () => {
  const callback = funcOf([object("Base")], { kind: "promise", inner: record("child") });
  const mod = moduleWith({ kind: "dynCheck", value: ref(DYN), type: callback, loc });
  const facts = computeNativeIntegrityTypes(mod)!;
  expect(facts.requiresHeapIdentity(object("Derived"))).toBe(true);
  expect(facts.requiresHeapIdentity(record("child"))).toBe(true);
  expect(facts.requiresHeapIdentity(record("unrelated"))).toBe(false);
});

test("registered Error views expose nested records without an explicit dynamic conversion", () => {
  const mod = moduleWith(ref(F64));
  mod.functions[0]!.body = [];
  const fields: [string, IrType][] = [["detail", record("wrapper")]];
  mod.classes = [
    { ...cls("%Error", []), runtime: true },
    { ...cls("%TypeError", [], "%Error"), runtime: true },
    cls("Problem", fields, "%TypeError"),
    cls("DetailedProblem", fields, "Problem"),
    cls("Other", [["hidden", record("unrelated")]]),
  ];
  mod.records!.push(
    { id: "empty", fields: [] },
    {
      id: "wrapper",
      fields: [
        { name: "child", type: record("child") },
        { name: "empty", type: record("empty") },
      ],
    },
  );
  const facts = computeNativeIntegrityTypes(mod)!;
  expect(facts.classGuarded("DetailedProblem")).toBe(true);
  expect(facts.classGuarded("Other")).toBe(false);
  expect([...computeRecordMetadataShapes(mod, facts)].sort()).toEqual([
    "child",
    "empty",
    "wrapper",
  ]);
});

test("a native predicate seeds identity but an injected write guard does not", () => {
  const predicate = moduleWith({
    kind: "intrinsic",
    name: "native.isFrozen",
    args: [ref(record("child"))],
    type: BOOL,
    loc,
  });
  expect(computeNativeIntegrityTypes(predicate)!.requiresHeapIdentity(record("child"))).toBe(true);
  const guard = moduleWith({
    kind: "intrinsic",
    name: "native.checkWrite",
    args: [ref(record("child"))],
    type: BOOL,
    loc,
  });
  expect(computeNativeIntegrityTypes(guard)).toBeNull();
});

test("implicit stream and keyed-read boxing seed the same identity owner", () => {
  const stream = moduleWith({
    kind: "libCall",
    fn: "fetch.streamFrom",
    args: [ref(arrayOf(record("child")))],
    type: DYN,
    loc,
  });
  expect(computeNativeIntegrityTypes(stream)!.requiresHeapIdentity(record("child"))).toBe(true);
  const keyed = moduleWith({
    kind: "recordKeyGet",
    obj: ref(record("outer")),
    shapeId: "outer",
    key: { kind: "strLit", value: "item", type: { kind: "string" }, loc },
    type: DYN,
    loc,
  });
  keyed.records!.push({ id: "outer", fields: [{ name: "item", type: object("Base") }] });
  expect(computeNativeIntegrityTypes(keyed)!.requiresHeapIdentity(object("Derived"))).toBe(true);
});

test("generator channels retain payload identity without widening ordinary publication", () => {
  const generator: IrType = {
    kind: "generator",
    yieldT: DYN,
    retT: record("child"),
    nextT: object("Base"),
  };
  const mod = moduleWith({
    kind: "genResume",
    gen: ref(generator),
    mode: "next",
    arg: null,
    type: DYN,
    loc,
  });
  const facts = computeNativeIntegrityTypes(mod)!;
  expect(facts.requiresHeapIdentity(record("child"))).toBe(true);
  expect(facts.requiresHeapIdentity(object("Derived"))).toBe(true);
  const published = moduleWith({
    kind: "intrinsic",
    name: "threads.publish",
    args: [ref(funcOf([object("Base")], record("child")))],
    type: funcOf([object("Base")], record("child")),
    loc,
  });
  expect(computePublishedTypes(published)!.classes.size).toBe(0);
  expect(computePublishedTypes(published)!.records.size).toBe(0);
});
