/** Local reads that are the final use of their binding on every path.
 *
 * A refcounted local owns one reference until its scope ends. When a read
 * passes that value to an owning consumer and nothing reads the binding
 * afterwards, the consumer can take the local's reference instead of a new
 * one, and the slot is cleared for the scope-exit release; a borrowing
 * consumer can use the slot without a snapshot. Statements are numbered in
 * source order, so every later statement, branch, case, catch or finally
 * body counts as a later use: a conservative superset of the paths that can
 * run next. Reads inside loops or statement expressions can repeat and are
 * never final. */
import { everyExpr, everyStmtChild } from "../../ir/traverse.js";
import { isRefCounted, type IrExpr, type IrStmt } from "../../ir/ir.js";

function isLoop(stmt: IrStmt): boolean {
  return (
    stmt.kind === "while" || stmt.kind === "doWhile" || stmt.kind === "for" || stmt.kind === "forOf"
  );
}

/** `tracked` names the bindings a move could apply to; others are ignored. */
export function lastUseReads(body: readonly IrStmt[], tracked: ReadonlySet<string>): Set<IrExpr> {
  const result = new Set<IrExpr>();
  if (tracked.size === 0) return result;
  const position = new Map<IrStmt, number>();
  const lastUse = new Map<string, number>();
  let next = 0;
  const use = (id: string, at: number): void => {
    if (tracked.has(id) && (lastUse.get(id) ?? -1) < at) lastUse.set(id, at);
  };
  /** Every binding an expression tree names, at one position. */
  const record = (expr: IrExpr, at: number): void => {
    everyExpr(expr, {
      expr: (node) => {
        if ("localId" in node && typeof node.localId === "string") use(node.localId, at);
        if (node.kind === "closure") for (const id of node.captures) use(id, at);
        return true;
      },
      stmt: (node) => {
        if ("localId" in node && typeof node.localId === "string") use(node.localId, at);
        return true;
      },
    });
  };
  const number = (stmt: IrStmt): void => {
    const at = next++;
    position.set(stmt, at);
    if ("localId" in stmt && typeof stmt.localId === "string") use(stmt.localId, at);
    if (stmt.kind === "tryCatch" && stmt.catchLocalId !== null) use(stmt.catchLocalId, at);
    if (stmt.kind === "switch") {
      // Case tests run after the discriminant, interleaved with the bodies.
      record(stmt.disc, at);
      for (const c of stmt.cases) {
        if (c.test) record(c.test, next++);
        c.body.forEach(number);
      }
      return;
    }
    everyStmtChild(
      stmt,
      (expr) => {
        record(expr, at);
        return true;
      },
      (child) => {
        number(child);
        return true;
      },
    );
  };
  body.forEach(number);

  const candidates = (stmt: IrStmt): void => {
    if (isLoop(stmt)) return;
    const at = position.get(stmt)!;
    ownReads(stmt, tracked, (id) => (lastUse.get(id) ?? -1) > at, result);
    everyStmtChild(
      stmt,
      () => true,
      (child) => {
        candidates(child);
        return true;
      },
    );
  };
  body.forEach(candidates);
  return result;
}

/** The final read of each binding among a statement's own expressions, in
 * evaluation order. An earlier read may still be in use by a pending operand
 * — a borrowed argument or receiver — so it blocks the move unless it sits
 * inside an operand that already produced a value holding no reference. A
 * binding that also appears under an expression whose operand order is not
 * modeled keeps its reads owned. */
function ownReads(
  stmt: IrStmt,
  tracked: ReadonlySet<string>,
  liveAfter: (id: string) => boolean,
  result: Set<IrExpr>,
): void {
  const last = new Map<string, { read: IrExpr; blocked: boolean }>();
  const open = new Map<string, number>();
  const unordered = new Set<string>();
  let repeated = false;
  const opaque = (node: IrExpr): void => {
    everyExpr(node, {
      expr: (inner) => {
        if (inner.kind === "seqExpr") repeated = true;
        if ("localId" in inner && typeof inner.localId === "string") unordered.add(inner.localId);
        if (inner.kind === "closure") for (const id of inner.captures) unordered.add(id);
        return true;
      },
      stmt: () => {
        repeated = true;
        return true;
      },
    });
  };
  /** Visits `node`, returning the reads it leaves pending. */
  const ordered = (node: IrExpr): string[] => {
    if (node.kind === "varRef") {
      if (!tracked.has(node.localId)) return [];
      last.set(node.localId, { read: node, blocked: (open.get(node.localId) ?? 0) > 0 });
      open.set(node.localId, (open.get(node.localId) ?? 0) + 1);
      return [node.localId];
    }
    const children = evaluationOrder(node);
    if (children === null) {
      opaque(node);
      return [];
    }
    const pending = children.flatMap(ordered);
    if (isRefCounted(node.type)) return pending;
    for (const id of pending) open.set(id, open.get(id)! - 1);
    return [];
  };
  // Compound statements contribute only their own head expression; switch
  // case tests are later uses, numbered after the discriminant.
  if (stmt.kind === "switch") ordered(stmt.disc);
  else
    everyStmtChild(
      stmt,
      (node) => {
        ordered(node);
        return true;
      },
      () => true,
    );
  if (repeated) return;
  for (const [id, { read, blocked }] of last)
    if (!blocked && !unordered.has(id) && !liveAfter(id)) result.add(read);
}

/** Operands in the order the LLVM backend evaluates them, for the node kinds
 * whose order this analysis relies on; null for every other kind. */
function evaluationOrder(node: IrExpr): readonly IrExpr[] | null {
  switch (node.kind) {
    case "numLit":
    case "strLit":
    case "boolLit":
      return [];
    case "call":
      return node.args;
    case "callValue":
      return node.receiver === undefined
        ? [node.callee, ...node.args]
        : [node.callee, node.receiver, ...node.args];
    case "bin":
    case "logical":
    case "strEq":
    case "strConcat":
      return [node.left, node.right];
    case "ternary":
      return [node.cond, node.then, node.else_];
    case "unary":
    case "toBool":
      return [node.operand];
    case "unionNarrow":
    case "unionDisc":
    case "unionWrap":
      return [node.value];
    case "recordGet":
    case "fieldGet":
      return [node.obj];
    default:
      return null;
  }
}
