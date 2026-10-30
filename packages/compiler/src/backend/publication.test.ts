import { expect, test } from "vitest";
import {
  arrayOf,
  F64,
  STRING,
  VOID,
  type IrClassDef,
  type IrExpr,
  type IrFunction,
  type IrModule,
  type IrStmt,
  type IrType,
} from "../ir/ir.js";
import { computeMayThrow } from "./may-throw.js";
import { computePublishedTypes, writesPublished } from "./publication.js";

const loc = { file: "publish.ts", start: 0, end: 1 };
const obj = (className: string): IrType => ({ kind: "object", className });
const cls = (name: string, fields: [string, IrType][], base?: string): IrClassDef =>
  ({
    name,
    fields: fields.map(([n, type]) => ({ name: n, type })),
    ...(base ? { base } : {}),
    loc,
  }) as IrClassDef;
const ref = (id: string, type: IrType): IrExpr => ({ kind: "varRef", localId: id, type, loc });
const fn = (name: string, body: IrStmt[]): IrFunction => ({
  name,
  body,
  locals: [],
  params: [],
  returnType: VOID,
  loc,
});
const publishOf = (type: IrType): IrStmt => ({
  kind: "exprStmt",
  expr: { kind: "intrinsic", name: "threads.publish", args: [ref("root", type)], type, loc },
  loc,
});
const fieldSet = (className: string, field: string): IrStmt => ({
  kind: "fieldSet",
  obj: ref("o", obj(className)),
  className,
  field,
  value: { kind: "numLit", value: 1, type: F64, loc },
  loc,
});

test("published types close over fields, containers and whole hierarchies", () => {
  const classes = [
    cls("Base", [["label", STRING]]),
    cls("Derived", [["items", arrayOf(obj("Leaf"))]], "Base"),
    cls("Leaf", [["weight", F64]]),
    cls("Other", [["n", F64]]),
  ];
  const mod: IrModule = {
    irVersion: 17,
    sourceFile: loc.file,
    entry: "main",
    classes,
    functions: [fn("main", [publishOf(obj("Derived"))])],
  };
  const published = computePublishedTypes(mod)!;
  // Publishing a Derived reaches its base (writes through a Base reference)
  // and its fields' types; unrelated classes stay unguarded.
  expect([...published.classes].sort()).toEqual(["Base", "Derived", "Leaf"]);
  expect(published.containerGuarded(arrayOf(obj("Leaf")))).toBe(true);
  expect(published.containerGuarded(arrayOf(F64))).toBe(false);
  expect(writesPublished(published, fieldSet("Base", "label"))).toBe(true);
  expect(writesPublished(published, fieldSet("Other", "n"))).toBe(false);
  // Guarded stores can throw, so their functions become may-throw.
  const withStores: IrModule = {
    ...mod,
    functions: [
      ...mod.functions,
      fn("writeBase", [fieldSet("Base", "label")]),
      fn("writeOther", [fieldSet("Other", "n")]),
    ],
  };
  const may = computeMayThrow(withStores).fns;
  expect(may.has("writeBase")).toBe(true);
  expect(may.has("writeOther")).toBe(false);
  // Without a publish call nothing is guarded.
  expect(
    computePublishedTypes({ ...withStores, functions: withStores.functions.slice(1) }),
  ).toBeNull();
});
