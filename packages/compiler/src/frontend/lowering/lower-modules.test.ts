import { expect, test } from "vitest";
import {
  BOOL,
  DYN,
  F64,
  UNDEFINED_T,
  type IrExpr,
  type IrFunction,
  type IrType,
} from "../../ir/ir.js";
import type { Program, SourceFile } from "../ts7/adapter.js";
import { Lowerer } from "./lowerer.js";
import { moduleArtifacts } from "./lower-modules.js";
import type { ClassInfo } from "./lower-classes.js";

test("retains dependencies from function storage, captures, generator channels and globals", () => {
  const loc = { file: "artifacts.ts", start: 0, end: 1 };
  const lowerer = new Lowerer(
    { getTypeChecker: () => ({}) } as Program,
    { fileName: loc.file } as SourceFile,
    [],
  );
  const record = (name: string, type: IrType = F64): IrType & { kind: "record" } => ({
    kind: "record",
    shapeId: lowerer.shapes.intern([{ name, type }]),
  });
  const param = record("parameter");
  const result = record("return");
  const local = record("local");
  const capture = record("capture");
  const classCapture = record("classCapture");
  const yielded = record("yielded");
  const sent = record("sent");
  const completed = record("completed");
  const body = record("body");
  const global = record("global", record("nested"));
  const wanted = lowerer.shapes.shapes.map((shape) => shape.id).sort();
  record("unused");
  const unionId = lowerer.unions.intern([body, UNDEFINED_T]);
  const unusedUnion = lowerer.unions.intern([F64, UNDEFINED_T]);
  const fn: IrFunction = {
    name: "entry",
    params: [{ localId: "p", name: "p", type: param }],
    returnType: result,
    locals: [{ id: "l", name: "l", type: local, mutable: false }],
    captures: [{ localId: "c", name: "c", type: capture }],
    classCaptures: [{ localId: "cc", name: "cc", type: classCapture, slot: 0 }],
    generator: { yieldT: yielded, nextT: sent, resultType: completed },
    body: [
      {
        kind: "return",
        value: { kind: "varRef", localId: "v", type: { kind: "union", unionId }, loc },
        loc,
      },
    ],
    loc,
  };
  lowerer.globalsList.push({ id: "g", name: "g", type: global, mutable: false });
  const artifacts = moduleArtifacts(lowerer, [fn]);
  expect(artifacts.records.map((shape) => shape.id)).toEqual(wanted);
  expect(artifacts.unions.map((union) => union.id)).toEqual([unionId]);
  expect(artifacts.unions.some((union) => union.id === unusedUnion)).toBe(false);
});

test("retains a constructible grandchild through an unused intermediate class", () => {
  const loc = { file: "hierarchy.ts", start: 0, end: 1 };
  const lowerer = new Lowerer(
    { getTypeChecker: () => ({}) } as Program,
    { fileName: loc.file } as SourceFile,
    [],
  );
  const info = (name: string, base: ClassInfo | null): ClassInfo => {
    const value = {
      def: { name, fields: [], ...(base ? { base: base.def.name } : {}) },
      base,
      subclasses: [],
      fields: new Map(),
      methods: new Map(),
    } as unknown as ClassInfo;
    base?.subclasses.push(value);
    lowerer.classes.set(name, value);
    return value;
  };
  const root = info("Root", null);
  const middle = info("Middle", root);
  info("Leaf", middle);
  info("Unused", root);
  lowerer.classCanBeConstructed = (value) => value.def.name === "Root" || value.def.name === "Leaf";
  const entry: IrFunction = {
    name: "entry",
    params: [{ localId: "p", name: "p", type: { kind: "object", className: "Root" } }],
    returnType: UNDEFINED_T,
    locals: [],
    body: [],
    loc,
  };
  const names = moduleArtifacts(lowerer, [entry]).classes.map((value) => value.name);
  expect(names).toContain("Root");
  expect(names).toContain("Middle");
  expect(names).toContain("Leaf");
  expect(names).not.toContain("Unused");
});

test("retains references carried by executable metadata and generator completion", () => {
  const loc = { file: "references.ts", start: 0, end: 1 };
  const lowerer = new Lowerer(
    { getTypeChecker: () => ({}) } as Program,
    { fileName: loc.file } as SourceFile,
    [],
  );
  const shapeId = lowerer.shapes.intern([{ name: "payload", type: F64 }]);
  const completedId = lowerer.shapes.intern([{ name: "completed", type: F64 }]);
  const unionId = lowerer.unions.intern([F64, UNDEFINED_T]);
  const className = "Checked";
  lowerer.classes.set(className, {
    def: { name: className, fields: [], loc },
    base: null,
    subclasses: [],
  } as unknown as ClassInfo);
  const value: IrExpr = { kind: "varRef", localId: "value", type: DYN, loc };
  const nodes: IrExpr[] = [
    { kind: "caughtTest", test: "instanceof", className, value, type: BOOL, loc },
    { kind: "recordGet", shapeId, obj: value, field: "payload", type: F64, loc },
    { kind: "unionIsTag", unionId, tag: 0, negated: false, value, type: BOOL, loc },
    {
      kind: "yieldExpr",
      value: null,
      captureCompletion: { returnType: { kind: "record", shapeId: completedId } },
      type: UNDEFINED_T,
      loc,
    },
  ];
  const entry: IrFunction = {
    name: "entry",
    params: [],
    locals: [],
    returnType: UNDEFINED_T,
    body: nodes.map((expr) => ({ kind: "exprStmt", expr, loc })),
    loc,
  };
  const artifacts = moduleArtifacts(lowerer, [entry]);
  expect(artifacts.classes.map((cls) => cls.name)).toContain(className);
  expect(artifacts.records.map((shape) => shape.id)).toEqual([shapeId, completedId]);
  expect(artifacts.unions.map((union) => union.id)).toEqual([unionId]);
});

test("closes nested structural types and index-signature values", () => {
  const loc = { file: "structural.ts", start: 0, end: 1 };
  const lowerer = new Lowerer(
    { getTypeChecker: () => ({}) } as Program,
    { fileName: loc.file } as SourceFile,
    [],
  );
  const record = (name: string): IrType & { kind: "record" } => ({
    kind: "record",
    shapeId: lowerer.shapes.intern([{ name, type: F64 }]),
  });
  const key = record("key"),
    item = record("item"),
    yielded = record("yielded"),
    returned = record("returned"),
    sent = record("sent"),
    indexed = record("indexed");
  const containerId = lowerer.shapes.intern([], false, indexed);
  const wanted = lowerer.shapes.shapes.map((shape) => shape.id).sort();
  record("unused");
  const nested: IrType = {
    kind: "func",
    params: [{ kind: "map", key, value: { kind: "set", elem: { kind: "array", elem: item } } }],
    ret: {
      kind: "promise",
      inner: { kind: "generator", yieldT: yielded, retT: returned, nextT: sent },
    },
  };
  const entry: IrFunction = {
    name: "entry",
    params: [{ localId: "p", name: "p", type: nested }],
    locals: [],
    returnType: { kind: "record", shapeId: containerId },
    body: [],
    loc,
  };
  expect(moduleArtifacts(lowerer, [entry]).records.map((shape) => shape.id)).toEqual(wanted);
});

test("boxed child values retain native stdio classes through recursive storage", () => {
  const loc = { file: "child.ts", start: 0, end: 1 };
  const lowerer = new Lowerer(
    { getTypeChecker: () => ({}) } as Program,
    { fileName: loc.file } as SourceFile,
    [],
  );
  for (const name of ["%Readable", "%Writable"])
    lowerer.classes.set(name, {
      def: { name, fields: [], loc },
      base: null,
      subclasses: [],
    } as unknown as ClassInfo);
  const shapeId = lowerer.shapes.intern([
    { name: "children", type: { kind: "array", elem: { kind: "child" } } },
  ]);
  const value: IrExpr = {
    kind: "varRef",
    localId: "value",
    type: { kind: "record", shapeId },
    loc,
  };
  const entry: IrFunction = {
    name: "entry",
    params: [],
    locals: [],
    returnType: UNDEFINED_T,
    body: [{ kind: "exprStmt", expr: { kind: "dynFrom", value, type: DYN, loc }, loc }],
    loc,
  };
  expect(moduleArtifacts(lowerer, [entry]).classes.map((cls) => cls.name)).toEqual(
    expect.arrayContaining(["%Readable", "%Writable"]),
  );
});
