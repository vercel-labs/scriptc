import { expect, test } from "vitest";
import { F64, JSVAL, type IrExpr, type IrFunction, type IrStmt } from "../../ir/ir.js";
import { everyStmtList } from "../../ir/traverse.js";
import { buildArraySortFn, buildBytesSortFn } from "./lower-array-sort.js";

const loc = { file: "sort.ts", start: 0, end: 0 };

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
    buildArraySortFn("%arr.sort.2", JSVAL, 2, false, null, loc),
    buildArraySortFn("%arr.sort.3", union, 2, true, 1, loc),
    buildBytesSortFn("%bytes.sort.4", 2, true, loc),
    buildBytesSortFn("%bytes.sort.5", 0, false, loc),
  ];
  for (const fn of helpers) expect(repeatedNodes(fn), fn.name).toBe(0);
});
