import type { IrExpr, IrStmt, IrModule } from "./ir.js";

import { everyExprChild, everyStmtChild } from "./traverse.js";

export interface ConstantNumericTable {
  symbol: string;
  values: readonly number[];
}

const MAX_TABLE_ELEMENTS = 256;

/** A literal of up to this many elements keeps its slots inside the array's
 * own block (SCR_ARR_KNOWN_INLINE_MAX, scr_array.c); a larger one takes
 * storage of its own, which the table in the image replaces. */
const MIN_STATIC_ELEMENTS = 17;

function literalNumber(expr: IrExpr): number | null {
  if (expr.kind === "numLit") return expr.value;
  if (expr.kind === "unary" && expr.op === "-") {
    const value = literalNumber(expr.operand);
    if (value !== null) return -value;
  }
  return null;
}

interface ScannedTable {
  values: readonly number[];
  node: IrExpr;
}

/** Module globals whose only observable uses are primitive indexed reads and
 * length queries. `const` only protects the binding: every other use
 * (including aliases, exports to dynamic code, mutation, and passing or
 * returning the array) disqualifies the table. All functions are inspected,
 * including callbacks, and nested index expressions are checked too.
 *
 * With `readers`, a call of an element-reader helper counts as an indexed
 * read: `%arr.idxOr.<type>` (lowering/array-values.ts) is `a[i]` as
 * `T | undefined`, and its body only tests the element's state and reads
 * it. */
function scanNumericTables(
  mod: IrModule,
  maxElements: number,
  readers: boolean,
): Map<string, ScannedTable> {
  const candidates = new Map<
    string,
    {
      values: number[] | null;
      node: IrExpr | null;
      writes: number;
      reads: number;
      rejected: boolean;
    }
  >();
  for (const global of mod.globals ?? []) {
    if (!global.mutable && global.type.kind === "array" && global.type.elem.kind === "f64") {
      candidates.set(global.id, {
        values: null,
        node: null,
        writes: 0,
        reads: 0,
        rejected: false,
      });
    }
  }
  if (candidates.size === 0) return new Map();
  /* The lifted `a[i]` helpers, by their reserved name (`%` cannot begin a
   * source name); their bodies only read the array. */
  const readerNames = readers
    ? new Set(
        mod.functions
          .filter((fn) => fn.name.startsWith("%arr.idxOr.") && fn.params.length === 2)
          .map((fn) => fn.name),
      )
    : null;

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
      case "arrayGet":
      case "arrayHas":
      case "arrayState": {
        const candidate = candidateFor(node.arr);
        if (candidate) {
          // The scan that places the literal counts every indexed read; the
          // constant-data scan leaves these uncounted, so its tables are
          // unchanged.
          if (readers) candidate.reads++;
          return expr(node.index);
        }
        break;
      }
      case "call": {
        const candidate =
          readerNames !== null && readerNames.has(node.callee) && node.args.length === 2
            ? candidateFor(node.args[0]!)
            : undefined;
        if (candidate) {
          candidate.reads++;
          return expr(node.args[1]!);
        }
        break;
      }
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
              init.elems.length <= maxElements
            ) {
              const values: number[] = [];
              for (const elem of init.elems) {
                const value = literalNumber(elem);
                if (value !== null) values.push(value);
              }
              if (values.length === init.elems.length) {
                candidate.values = values;
                candidate.node = init;
              }
            }
            if (candidate.node === null) candidate.rejected = true;
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
  const tables = new Map<string, ScannedTable>();
  for (const [id, candidate] of candidates) {
    if (
      !candidate.rejected &&
      candidate.writes === 1 &&
      candidate.reads > 0 &&
      candidate.values !== null &&
      candidate.node !== null
    ) {
      tables.set(id, { values: candidate.values, node: candidate.node });
    }
  }
  return tables;
}

/** Find module globals whose only observable uses are primitive indexed
 * reads and length queries. Backends keep the array's own allocation and
 * initialization and read the constant data instead.
 *
 * This is read specialization only. Backends retain the original allocation,
 * initialization, receiver evaluation and cleanup. They must guard against
 * an uninitialized receiver and preserve the generic accessor for invalid
 * indices; the constant data must never make a not-yet-initialized array
 * observable early. No IR or runtime representation changes are needed. */
export function findConstantNumericTables(
  mod: IrModule,
): ReadonlyMap<string, ConstantNumericTable> {
  const tables = new Map<string, ConstantNumericTable>();
  for (const [id, table] of scanNumericTables(mod, MAX_TABLE_ELEMENTS, false)) {
    tables.set(id, { symbol: `sc_const_numbers_${tables.size}`, values: table.values });
  }
  return tables;
}

/** The initializing array literals of the same tables, for the backends that
 * construct them in place: the array becomes immortal storage over the data
 * in the program image, so it is neither allocated nor copied. Those backends
 * rely on the scan above having proved that nothing writes the table. Only
 * literals too large for an array's inline slots qualify: smaller ones are
 * built in place from registers. */
export function findStaticArrayTables(mod: IrModule): ReadonlySet<IrExpr> {
  const tables = new Set<IrExpr>();
  for (const table of scanNumericTables(mod, Number.POSITIVE_INFINITY, true).values())
    if (table.values.length >= MIN_STATIC_ELEMENTS) tables.add(table.node);
  return tables;
}
