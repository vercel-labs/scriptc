import { expect, test } from "vitest";
import {
  BOOL,
  F64,
  DYN,
  type IrExpr,
  type IrFunction,
  type IrStmt,
  type IrType,
} from "../../ir/ir.js";
import { numLit, varRef } from "../../ir/build.js";
import { everyStmtList } from "../../ir/traverse.js";
import {
  buildArraySortFn,
  buildBytesSortFn,
  buildSortKeyFn,
  recognizeKeyComparator,
  sortKeysOrder,
} from "./lower-array-sort.js";

const loc = { file: "sort.ts", start: 0, end: 0 };
const OPTIONAL: IrType = { kind: "union", unionId: "u0" };
const ROW: IrType = { kind: "record", shapeId: "r0" };
const a = (type: IrType = F64): IrExpr => varRef("a.0", type, loc);
const b = (type: IrType = F64): IrExpr => varRef("b.0", type, loc);
const field = (obj: IrExpr, name = "k", type: IrType = F64): IrExpr & { kind: "recordGet" } => ({
  kind: "recordGet",
  obj,
  shapeId: "r0",
  field: name,
  type,
  loc,
});
const sub = (left: IrExpr, right: IrExpr): IrExpr => ({
  kind: "bin",
  op: "-",
  left,
  right,
  type: F64,
  loc,
});
const cmp = (op: "<" | ">", left: IrExpr, right: IrExpr): IrExpr => ({
  kind: "bin",
  op,
  left,
  right,
  type: BOOL,
  loc,
});
const pick = (cond: IrExpr, then: IrExpr, else_: IrExpr): IrExpr => ({
  kind: "ternary",
  cond,
  then,
  else_,
  type: F64,
  loc,
});
const comparator = (value: IrExpr, param: IrType = F64, extra: Partial<IrFunction> = {}) => ({
  name: "%fn0",
  params: [
    { localId: "a.0", name: "a", type: param },
    { localId: "b.0", name: "b", type: param },
  ],
  returnType: F64,
  locals: [],
  captures: [],
  body: [{ kind: "return" as const, value, loc }],
  loc,
  ...extra,
});

function repeatedNodes(fn: IrFunction): number {
  const seen = new Set<IrExpr | IrStmt>();
  let repeated = 0;
  const visit = (node: IrExpr | IrStmt): boolean => {
    if (seen.has(node)) repeated++;
    seen.add(node);
    return true;
  };
  everyStmtList(fn.body, { expr: visit, stmt: visit });
  return repeated;
}

test("sort helpers give every IR site its own node", () => {
  const union = { kind: "union" as const, unionId: "u0" };
  const helpers = [
    buildArraySortFn("%arr.sort.0", F64, 2, false, null, loc),
    buildArraySortFn("%arr.toSorted.1", F64, 1, true, null, loc),
    buildArraySortFn("%arr.sort.2", DYN, 2, false, null, loc),
    buildArraySortFn("%arr.sort.3", union, 2, true, 1, loc),
    buildArraySortFn("%arr.sort.6", F64, 2, false, null, loc, true, {
      order: -1,
      key: false,
      keys: 1,
    }),
    buildArraySortFn("%arr.toSorted.7", ROW, 2, true, null, loc, true, {
      order: 1,
      key: true,
      keys: 1,
    }),
    buildArraySortFn("%arr.sort.11", ROW, 2, false, null, loc, true, {
      order: 0x202,
      key: true,
      keys: 2,
    }),
    buildSortKeyFn(
      "%arr.sortKey.8",
      ROW,
      [{ field: field(varRef("a.0", ROW, loc)), fallback: null }],
      loc,
    ),
    buildSortKeyFn(
      "%arr.sortKey.12",
      ROW,
      [
        {
          field: field(varRef("a.0", ROW, loc), "k", OPTIONAL),
          fallback: numLit(0, loc) as IrExpr & { kind: "numLit" },
        },
        { field: field(varRef("a.0", ROW, loc), "j"), fallback: null },
        { field: field(varRef("a.0", ROW, loc), "i"), fallback: null },
      ],
      loc,
    ),
    buildBytesSortFn("%bytes.sort.4", { kind: "bytes", elem: "u8" }, 2, true, true, null, loc),
    buildBytesSortFn("%bytes.sort.5", { kind: "bytes", elem: "u8" }, 0, false, true, null, loc),
    buildBytesSortFn("%bytes.sort.9", { kind: "bytes", elem: "f64" }, 2, true, false, -1, loc),
    buildBytesSortFn("%bytes.sort.10", { kind: "bytes", elem: "i16" }, 0, false, false, null, loc),
  ];
  for (const fn of helpers) expect(repeatedNodes(fn), fn.name).toBe(0);
});

test("recognizes subtraction comparators over numbers", () => {
  expect(recognizeKeyComparator(comparator(sub(a(), b())))).toEqual([{ order: 1, read: null }]);
  expect(recognizeKeyComparator(comparator(sub(b(), a())))).toEqual([{ order: -1, read: null }]);
});

test("recognizes subtraction comparators over one field", () => {
  const ascending = recognizeKeyComparator(comparator(sub(field(a(ROW)), field(b(ROW))), ROW));
  expect(ascending).toHaveLength(1);
  expect(ascending?.[0]?.order).toBe(1);
  expect(ascending?.[0]?.read).toMatchObject({
    field: { kind: "recordGet", field: "k" },
    fallback: null,
  });
  const descending = recognizeKeyComparator(comparator(sub(field(b(ROW)), field(a(ROW))), ROW));
  expect(descending?.[0]?.order).toBe(-1);
});

test("recognizes three-way ternaries in either test order and direction", () => {
  const three = (first: "<" | ">", firstSign: number, x: IrExpr, y: IrExpr) =>
    pick(
      cmp(first, x, y),
      numLit(firstSign, loc),
      pick(cmp(first === "<" ? ">" : "<", x, y), numLit(-firstSign, loc), numLit(0, loc)),
    );
  expect(recognizeKeyComparator(comparator(three("<", -1, a(), b())))?.[0]?.order).toBe(1);
  expect(recognizeKeyComparator(comparator(three(">", 1, a(), b())))?.[0]?.order).toBe(1);
  expect(recognizeKeyComparator(comparator(three("<", 1, a(), b())))?.[0]?.order).toBe(-1);
  expect(recognizeKeyComparator(comparator(three("<", -1, b(), a())))?.[0]?.order).toBe(-1);
  const fields = three("<", -1, field(a(ROW)), field(b(ROW)));
  expect(recognizeKeyComparator(comparator(fields, ROW))?.[0]?.order).toBe(1);
});

test("rejects comparators that are not one consistent numeric key", () => {
  const rejected: IrExpr[] = [
    sub(a(), a()),
    sub(field(a(ROW)), field(b(ROW), "j")),
    sub(field(a(ROW)), b()),
    sub(sub(a(), b()), numLit(1, loc)),
    sub(a(), varRef("c.0", F64, loc)),
    pick(
      cmp("<", a(), b()),
      numLit(-1, loc),
      pick(cmp("<", a(), b()), numLit(1, loc), numLit(0, loc)),
    ),
    pick(
      cmp("<", a(), b()),
      numLit(-1, loc),
      pick(cmp(">", a(), b()), numLit(1, loc), numLit(-1, loc)),
    ),
    pick(
      cmp("<", a(), b()),
      numLit(-2, loc),
      pick(cmp(">", a(), b()), numLit(2, loc), numLit(0, loc)),
    ),
    pick(
      cmp("<", a(), b()),
      numLit(-1, loc),
      pick(cmp(">", a(), b()), numLit(-1, loc), numLit(0, loc)),
    ),
  ];
  for (const value of rejected) expect(recognizeKeyComparator(comparator(value))).toBeNull();
  expect(
    recognizeKeyComparator(comparator(sub(field(a(ROW), "k", ROW), field(b(ROW), "k", ROW)), ROW)),
  ).toBeNull();
});

test("rejects comparators with captures or other bodies", () => {
  expect(
    recognizeKeyComparator(
      comparator(sub(a(), b()), F64, { captures: [{ localId: "c.0", name: "c", type: F64 }] }),
    ),
  ).toBeNull();
  expect(recognizeKeyComparator(comparator(sub(a(), b()), F64, { async: true }))).toBeNull();
  const body: IrStmt[] = [
    { kind: "exprStmt", expr: a(), loc },
    { kind: "return", value: sub(a(), b()), loc },
  ];
  expect(recognizeKeyComparator({ ...comparator(sub(a(), b())), body })).toBeNull();
});

const or = (left: IrExpr, right: IrExpr): IrExpr => ({
  kind: "logical",
  op: "||",
  left,
  right,
  type: F64,
  loc,
});
const orZero = (read: IrExpr & { kind: "recordGet" }, value = 0): IrExpr => ({
  kind: "nullish",
  left: read,
  right: numLit(value, loc),
  type: F64,
  loc,
});

test("recognizes an optional field with a number default as a key", () => {
  const keys = recognizeKeyComparator(
    comparator(
      sub(orZero(field(b(ROW), "k", OPTIONAL)), orZero(field(a(ROW), "k", OPTIONAL))),
      ROW,
    ),
  );
  expect(keys).toHaveLength(1);
  expect(keys?.[0]?.order).toBe(-1);
  expect(keys?.[0]?.read?.fallback).toMatchObject({ kind: "numLit", value: 0 });
});

test("recognizes chains of key terms joined by ||", () => {
  const keys = recognizeKeyComparator(
    comparator(
      or(
        or(
          sub(orZero(field(b(ROW), "k", OPTIONAL)), orZero(field(a(ROW), "k", OPTIONAL))),
          sub(field(a(ROW), "j"), field(b(ROW), "j")),
        ),
        sub(field(b(ROW), "i"), field(a(ROW), "i")),
      ),
      ROW,
    ),
  );
  expect(keys?.map((key) => [key.order, key.read?.field.field])).toEqual([
    [-1, "k"],
    [1, "j"],
    [-1, "i"],
  ]);
  // Three keys, the first and third descending.
  expect(sortKeysOrder(keys!)).toBe(3 | (1 << 8) | (1 << 10));
});

test("rejects key chains that are not all field keys", () => {
  const rejected: IrExpr[] = [
    // The elements themselves cannot be one of several keys.
    or(sub(a(), b()), sub(b(), a())),
    // Each operand pair must read the same key with the same default.
    or(sub(field(a(ROW)), field(b(ROW))), sub(field(a(ROW), "j"), field(b(ROW), "i"))),
    or(
      sub(orZero(field(a(ROW), "k", OPTIONAL)), orZero(field(b(ROW), "k", OPTIONAL), 1)),
      sub(field(a(ROW), "j"), field(b(ROW), "j")),
    ),
    // `&&` does not fall through on equal keys.
    {
      kind: "logical",
      op: "&&",
      left: sub(field(a(ROW)), field(b(ROW))),
      right: sub(field(a(ROW), "j"), field(b(ROW), "j")),
      type: F64,
      loc,
    },
  ];
  for (const value of rejected) expect(recognizeKeyComparator(comparator(value, ROW))).toBeNull();
  const nine = Array.from({ length: 9 }, (_, i) =>
    sub(field(a(ROW), `f${i}`), field(b(ROW), `f${i}`)),
  );
  expect(
    recognizeKeyComparator(
      comparator(
        nine.reduce((left, right) => or(left, right)),
        ROW,
      ),
    ),
  ).toBeNull();
});
