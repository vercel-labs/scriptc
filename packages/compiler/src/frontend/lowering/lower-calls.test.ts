import { expect, test } from "vitest";
import { DYN, type IrExpr, type IrRecordShape, type SrcLoc } from "../../ir/ir.js";
import { isPlainDescriptorMap, isPlainObjectLiteral } from "./lower-calls.js";

const loc: SrcLoc = { file: "descriptors.ts", start: 0, end: 1 };

function dynObjLit(): IrExpr {
  return { kind: "dynObjLit", fields: [], type: DYN, loc };
}

function recordLit(): IrExpr {
  return { kind: "recordLit", fields: [], type: { kind: "record", shapeId: "r1" }, loc };
}

function recordClone(): IrExpr {
  return {
    kind: "recordClone",
    source: recordLit(),
    overrides: [],
    type: { kind: "record", shapeId: "r1" },
    loc,
  };
}

function dynFrom(value: IrExpr): IrExpr {
  return { kind: "dynFrom", value, type: DYN, loc };
}

test("a plain object keeps the default descriptor reader", () => {
  expect(isPlainObjectLiteral(dynObjLit())).toBe(true);
  // A typed object literal boxes into dyn through dynFrom, and so does any
  // expression already of a record type (a variable, a clone).
  expect(isPlainObjectLiteral(dynFrom(recordLit()))).toBe(true);
  expect(isPlainObjectLiteral(dynFrom(recordClone()))).toBe(true);
  const recordVariable: IrExpr = {
    kind: "varRef",
    localId: "p1",
    type: { kind: "record", shapeId: "r1" },
    loc,
  };
  expect(isPlainObjectLiteral(dynFrom(recordVariable))).toBe(true);
});

test("any other descriptor may be an object of any kind and takes the any-object entry points", () => {
  const variable: IrExpr = { kind: "varRef", localId: "p0", type: DYN, loc };
  const array: IrExpr = { kind: "dynArrLit", elems: [], type: DYN, loc };
  const call: IrExpr = {
    kind: "libCall",
    fn: "dyn.objCreate",
    args: [dynObjLit()],
    type: DYN,
    loc,
  };
  for (const expr of [variable, dynFrom(variable), array, call])
    expect(isPlainObjectLiteral(expr)).toBe(false);
});

test("a descriptor map is plain only when every descriptor in it is plain", () => {
  const key: IrExpr = { kind: "strLit", value: "a", type: { kind: "string" }, loc };
  const variable: IrExpr = { kind: "varRef", localId: "p0", type: DYN, loc };
  const map = (value: IrExpr): IrExpr => ({
    kind: "dynObjLit",
    fields: [{ key, value }],
    type: DYN,
    loc,
  });
  const shapes = new Map<string, IrRecordShape>([
    ["r1", { id: "r1", fields: [] }],
    ["plain", { id: "plain", fields: [{ name: "a", type: { kind: "record", shapeId: "r1" } }] }],
    ["dyn", { id: "dyn", fields: [{ name: "a", type: DYN }] }],
  ]);
  const record = (shapeId: string): IrExpr => ({
    kind: "varRef",
    localId: "p1",
    type: { kind: "record", shapeId },
    loc,
  });
  const getRecord = (id: string) => shapes.get(id);
  expect(isPlainDescriptorMap(map(dynObjLit()), getRecord)).toBe(true);
  expect(isPlainDescriptorMap(dynFrom(record("plain")), getRecord)).toBe(true);
  // `{ a: view }` with `view` a DataView, an array or any other dyn value.
  expect(isPlainDescriptorMap(map(variable), getRecord)).toBe(false);
  expect(isPlainDescriptorMap(dynFrom(record("dyn")), getRecord)).toBe(false);
  expect(isPlainDescriptorMap(variable, getRecord)).toBe(false);
});
