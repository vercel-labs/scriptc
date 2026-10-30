import type { IrExpr, IrStmt, IrModule } from "./ir.js";

import { everyExprChild, everyStmtChild } from "./traverse.js";

export interface ConstantNumericTable {
  symbol: string;
  values: readonly number[];
}

const MAX_TABLE_ELEMENTS = 256;

function literalNumber(expr: IrExpr): number | null {
  if (expr.kind === "numLit") return expr.value;
  if (expr.kind === "unary" && expr.op === "-") {
    const value = literalNumber(expr.operand);
    if (value !== null) return -value;
  }
  return null;
}

/** Find module globals whose only observable uses are primitive indexed
 * reads and length queries. `const` only protects the binding: every other
 * use (including aliases, exports to dynamic code, mutation, and passing or
 * returning the array) disqualifies the table. All functions are inspected,
 * including callbacks, and nested index expressions are checked too.
 *
 * This is read specialization only. Backends retain the original allocation,
 * initialization, receiver evaluation and cleanup. They must guard against
 * an uninitialized receiver and preserve the generic accessor for invalid
 * indices; the constant data must never make a not-yet-initialized array
 * observable early. No IR or runtime representation changes are needed. */
export function findConstantNumericTables(
  mod: IrModule,
): ReadonlyMap<string, ConstantNumericTable> {
  const candidates = new Map<
    string,
    { values: number[] | null; writes: number; reads: number; rejected: boolean }
  >();
  for (const global of mod.globals ?? []) {
    if (!global.mutable && global.type.kind === "array" && global.type.elem.kind === "f64") {
      candidates.set(global.id, { values: null, writes: 0, reads: 0, rejected: false });
    }
  }
  if (candidates.size === 0) return new Map();

  function candidateFor(expr: IrExpr) {
    return expr.kind === "varRef" && expr.type.kind === "array" && expr.type.elem.kind === "f64"
      ? candidates.get(expr.localId)
      : undefined;
  }

  function reject(id: string): void {
    const candidate = candidates.get(id);
    if (candidate) candidate.rejected = true;
  }

  function expr(node: IrExpr): boolean {
    switch (node.kind) {
      case "closure":
      case "classRef":
        for (const id of node.captures ?? []) reject(id);
        break;
      case "arrIntrinsic": {
        const candidate = candidateFor(node.receiver);
        if (
          candidate &&
          ((node.method === "getNumber" && node.args.length === 1) ||
            (node.method === "length" && node.args.length === 0))
        ) {
          if (node.method === "getNumber") candidate.reads++;
          return node.args.every(expr);
        }
        break;
      }
      case "arrayPropertyRead": {
        const candidate = candidateFor(node.arr);
        if (candidate && (node.consume === "number" || node.consume === "numberConstructor")) {
          candidate.reads++;
          return expr(node.index);
        }
        break;
      }
      case "arrayGet":
      case "arrayHas":
      case "arrayHasProperty":
      case "arrayState":
        if (candidateFor(node.arr)) return expr(node.index);
        break;
      case "varRef":
      case "assignExpr":
      case "incDec":
        reject(node.localId);
        break;
    }
    return everyExprChild(node, expr, stmt);
  }

  function stmt(node: IrStmt): boolean {
    switch (node.kind) {
      case "assign": {
        const candidate = candidates.get(node.localId);
        if (candidate) {
          candidate.writes++;
          if (candidate.writes === 1) {
            const init = node.value;
            if (
              init.kind === "arrayLit" &&
              !init.spreads?.length &&
              init.elems.length > 0 &&
              init.elems.length <= MAX_TABLE_ELEMENTS
            ) {
              const values: number[] = [];
              for (const elem of init.elems) {
                const value = literalNumber(elem);
                if (value !== null) values.push(value);
              }
              if (values.length === init.elems.length) candidate.values = values;
            }
            if (candidate.values === null) candidate.rejected = true;
          } else candidate.rejected = true;
        }
        break;
      }
      case "varDecl":
      case "forOf":
      case "rethrow":
        reject(node.localId);
        break;
    }
    return everyStmtChild(node, expr, stmt);
  }
  for (const fn of mod.functions) fn.body.every(stmt);
  const tables = new Map<string, ConstantNumericTable>();
  for (const [id, candidate] of candidates) {
    if (
      !candidate.rejected &&
      candidate.writes === 1 &&
      candidate.reads > 0 &&
      candidate.values !== null
    ) {
      tables.set(id, { symbol: `sc_const_numbers_${tables.size}`, values: candidate.values });
    }
  }
  return tables;
}
