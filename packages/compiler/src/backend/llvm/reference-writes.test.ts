import { expect, test } from "vitest";
import {
  F64,
  arrayOf,
  type IrExpr,
  type IrFunction,
  type IrStmt,
  type IrType,
} from "../../ir/ir.js";
import { ReferenceWrites } from "./reference-writes.js";

const loc = { file: "writes.ts", start: 0, end: 0 };
const cell: IrType = { kind: "object", className: "Cell" };
const cells = arrayOf(cell);
const ref = (localId: string, type: IrType = cells): IrExpr => ({
  kind: "varRef",
  localId,
  type,
  loc,
});
const num = (value: number): IrExpr => ({ kind: "numLit", value, type: F64, loc });
const element = (arr: string): IrExpr => ({
  kind: "arrayGet",
  arr: ref(arr),
  index: num(0),
  type: cell,
  loc,
});
const store = (arr: string, value: IrExpr): IrStmt => ({
  kind: "arraySet",
  arr: ref(arr),
  index: { kind: "arrIntrinsic", method: "length", receiver: ref(arr), args: [], type: F64, loc },
  value,
  loc,
});

/** fill(input): const out = []; out[out.length] = input[0]; ...; return out */
function fill(name: string, extra: IrStmt[]): IrFunction {
  return {
    name,
    loc,
    returnType: cells,
    params: [{ localId: "input", name: "input", type: cells }],
    locals: [
      { id: "input", name: "input", type: cells, mutable: false },
      { id: "out", name: "out", type: cells, mutable: false },
      { id: "x", name: "x", type: cell, mutable: false },
    ],
    body: [
      {
        kind: "varDecl",
        localId: "out",
        init: { kind: "arrayLit", elems: [], type: cells, loc },
        loc,
      },
      store("out", element("input")),
      ...extra,
      { kind: "return", value: ref("out"), loc },
    ],
  };
}

function writes(fn: IrFunction): ReferenceWrites {
  return new ReferenceWrites(new Map([[fn.name, fn]]), [], () => false, new Set());
}

test("stores into a function's own unreached array write no shared location", () => {
  const fn = fill("fill", []);
  const rw = writes(fn);
  expect(rw.summary("fill")).toBeNull();
  rw.enter(fn);
  expect(rw.stmts(fn.body)).toBeNull();
});

test("an array that is read back or escapes keeps its element writes", () => {
  const readBack = fill("readBack", [{ kind: "varDecl", localId: "x", init: element("out"), loc }]);
  const rw = writes(readBack);
  expect(rw.summary("readBack")).not.toBeNull();
  expect(rw.conflicts(["a"], rw.summary("readBack"))).toBe(true);
  // Storing the array somewhere else lets another path reach its slots.
  const escaped = fill("escaped", [
    {
      kind: "exprStmt",
      expr: {
        kind: "arrIntrinsic",
        method: "push",
        receiver: ref("input"),
        args: [ref("out")],
        type: F64,
        loc,
      },
      loc,
    },
  ]);
  expect(writes(escaped).conflicts(["a"], writes(escaped).summary("escaped"))).toBe(true);
  // Writing the input array is never private.
  const input = fill("input", [store("input", element("input"))]);
  expect(writes(input).conflicts(["a"], writes(input).summary("input"))).toBe(true);
});

test("a keyed record read depends on every field and keyed entry of records", () => {
  const handler: IrType = { kind: "func", params: [F64], ret: F64 };
  const table: IrType = { kind: "record", shapeId: "t" };
  const key: IrExpr = { kind: "strLit", value: "k", type: { kind: "string" }, loc };
  const read: IrExpr = {
    kind: "recordKeyGet",
    obj: ref("table", table),
    shapeId: "t",
    key,
    type: { kind: "union", unionId: "hu" },
    loc,
  };
  const keyedWrite: IrStmt = {
    kind: "recordKeySet",
    obj: ref("table", table),
    shapeId: "t",
    key,
    value: ref("h", handler),
    loc,
  };
  const fn = (name: string, body: IrStmt[]): IrFunction => ({
    name,
    loc,
    returnType: F64,
    params: [{ localId: "table", name: "table", type: table }],
    locals: [
      { id: "table", name: "table", type: table, mutable: false },
      { id: "h", name: "h", type: handler, mutable: false },
    ],
    body,
  });
  const records = [{ id: "t", fields: [{ name: "add", type: handler }], indexValue: handler }];
  const quiet = fn("quiet", []);
  const writer = fn("writer", [keyedWrite]);
  const functions = new Map([quiet, writer].map((f) => [f.name, f]));
  const rw = new ReferenceWrites(functions, [], () => false, new Set(), { records });
  rw.enter(quiet);
  const keys = rw.readKeys(read);
  expect(keys).toEqual(expect.arrayContaining(["r:*", "r:add"]));
  expect(rw.conflicts(keys!, rw.summary("quiet"))).toBe(false);
  expect(rw.conflicts(keys!, rw.summary("writer"))).toBe(true);
});
