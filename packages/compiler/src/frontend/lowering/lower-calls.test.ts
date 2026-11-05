import { describe, expect, test } from "vitest";
import {
  BOOL,
  DYN,
  type IrExpr,
  type IrRecordShape,
  type IrType,
  type SrcLoc,
} from "../../ir/ir.js";
import { isPlainDescriptorMap, isPlainObjectLiteral, lowerBytesIntegrity } from "./lower-calls.js";
import type { Lowerer } from "./lowerer.js";

const loc: SrcLoc = { file: "bytes.js", start: 0, end: 1 };
const bytes: IrType = { kind: "bytes", elem: "i8" };

/** The conversions the helper needs: a value boxes into dyn (dynFrom) and a
 * dyn value converts back to a typed slot through its checked cast. */
function stub(): Lowerer {
  return {
    coerceToExpected: (expr: IrExpr, expected: IrType): IrExpr =>
      expected.kind === "dyn"
        ? { kind: "dynFrom", value: expr, type: DYN, loc: expr.loc }
        : { kind: "dynCheck", value: expr, type: expected, loc: expr.loc },
  } as unknown as Lowerer;
}

const view: IrExpr = { kind: "varRef", localId: "s.0", type: bytes, loc };

describe("lowerBytesIntegrity", () => {
  test("seal boxes the view, seals it dynamically and answers the same view", () => {
    const result = lowerBytesIntegrity(stub(), "dyn.seal", view, loc);
    // A typed result: the checked cast of the same view (identity preserved).
    expect(result.kind).toBe("dynCheck");
    expect(result.type).toEqual(bytes);
    const call = result.kind === "dynCheck" ? result.value : null;
    expect(call?.kind).toBe("libCall");
    expect(call?.kind === "libCall" ? call.fn : null).toBe("dyn.seal");
    expect(call?.kind === "libCall" ? call.type : null).toEqual(DYN);
    const arg = call?.kind === "libCall" ? call.args[0] : null;
    expect(arg?.kind).toBe("dynFrom");
    expect(arg?.kind === "dynFrom" ? arg.value : null).toEqual(view);
  });

  test("freeze of a DataView (bytes<u8>) answers the view", () => {
    const dv: IrExpr = { kind: "varRef", localId: "s.1", type: { kind: "bytes", elem: "u8" }, loc };
    const result = lowerBytesIntegrity(stub(), "dyn.freeze", dv, loc);
    expect(result.kind).toBe("dynCheck");
  });

  test("a query answers a boolean and keeps no view result", () => {
    const result = lowerBytesIntegrity(stub(), "dyn.isSealed", view, loc);
    expect(result.kind).toBe("libCall");
    expect(result.type).toEqual(BOOL);
    expect(result.kind === "libCall" ? result.fn : null).toBe("dyn.isSealed");
  });
});

const descriptorLoc: SrcLoc = { file: "descriptors.ts", start: 0, end: 1 };

function dynObjLit(): IrExpr {
  return { kind: "dynObjLit", fields: [], type: DYN, loc: descriptorLoc };
}

function recordLit(): IrExpr {
  return {
    kind: "recordLit",
    fields: [],
    type: { kind: "record", shapeId: "r1" },
    loc: descriptorLoc,
  };
}

function recordClone(): IrExpr {
  return {
    kind: "recordClone",
    source: recordLit(),
    overrides: [],
    type: { kind: "record", shapeId: "r1" },
    loc: descriptorLoc,
  };
}

function dynFrom(value: IrExpr): IrExpr {
  return { kind: "dynFrom", value, type: DYN, loc: descriptorLoc };
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
    loc: descriptorLoc,
  };
  expect(isPlainObjectLiteral(dynFrom(recordVariable))).toBe(true);
});

test("any other descriptor may be an object of any kind and takes the any-object entry points", () => {
  const variable: IrExpr = { kind: "varRef", localId: "p0", type: DYN, loc: descriptorLoc };
  const array: IrExpr = { kind: "dynArrLit", elems: [], type: DYN, loc: descriptorLoc };
  const call: IrExpr = {
    kind: "libCall",
    fn: "dyn.objCreate",
    args: [dynObjLit()],
    type: DYN,
    loc: descriptorLoc,
  };
  for (const expr of [variable, dynFrom(variable), array, call])
    expect(isPlainObjectLiteral(expr)).toBe(false);
});

test("a descriptor map is plain only when every descriptor in it is plain", () => {
  const key: IrExpr = { kind: "strLit", value: "a", type: { kind: "string" }, loc: descriptorLoc };
  const variable: IrExpr = { kind: "varRef", localId: "p0", type: DYN, loc: descriptorLoc };
  const map = (value: IrExpr): IrExpr => ({
    kind: "dynObjLit",
    fields: [{ key, value }],
    type: DYN,
    loc: descriptorLoc,
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
    loc: descriptorLoc,
  });
  const getRecord = (id: string) => shapes.get(id);
  expect(isPlainDescriptorMap(map(dynObjLit()), getRecord)).toBe(true);
  expect(isPlainDescriptorMap(dynFrom(record("plain")), getRecord)).toBe(true);
  // `{ a: view }` with `view` a DataView, an array or any other dyn value.
  expect(isPlainDescriptorMap(map(variable), getRecord)).toBe(false);
  expect(isPlainDescriptorMap(dynFrom(record("dyn")), getRecord)).toBe(false);
  expect(isPlainDescriptorMap(variable, getRecord)).toBe(false);
});
