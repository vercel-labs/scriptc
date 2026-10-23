import { numLit } from "../../ir/build.js";
import {
  BOOL,
  F64,
  STRING,
  type IrExpr,
  type IrFunction,
  type IrStmt,
  typeKey,
} from "../../ir/ir.js";
import { everyExprChild, everyStmtChild, transformStmtList } from "../../ir/traverse.js";
import type { Lowerer } from "./lowerer.js";

type Intrinsic = IrExpr & { kind: "regexIntrinsic" };

/** One read of capture `index` of a candidate result: the IR node that
 * consumes it and the narrowed result it reads from. */
interface CaptureUse {
  index: number;
  result: IrExpr;
}

interface Candidate {
  match: Intrinsic;
  folds: Map<IrExpr, CaptureUse>;
  strings: Set<number>;
  rejected: boolean;
}

/** Captures that need no string. An execGroups or matchGroups result
 * (execResultCaptureMask's const binding) whose capture k is read only by
 * strict comparisons with a string literal, Number() and parseInt() lets
 * the runtime keep capture k as a span of the subject: those reads become
 * regex.groupEquals/groupNumber/groupParseInt and the match becomes
 * execSpans (or matchGroups) with the lazy mask. The pass reads the
 * lowered IR, so it sees every read: any other read of capture k keeps k a
 * string, and any use of the binding it cannot attribute to a capture
 * leaves the whole result unchanged. */
export function foldRegexSpanReads(lowerer: Lowerer, fn: IrFunction): void {
  const candidates = new Map<string, Candidate>();
  const assigned = new Set<string>();
  const findStmt = (stmt: IrStmt): boolean => {
    // A non-literal receiver is saved first: the call is a sequence result.
    const init =
      stmt.kind !== "varDecl" ? null : stmt.init?.kind === "seqExpr" ? stmt.init.result : stmt.init;
    if (
      stmt.kind === "varDecl" &&
      init?.kind === "regexIntrinsic" &&
      (init.method === "execGroups" || init.method === "matchGroups")
    ) {
      candidates.set(stmt.localId, {
        match: init,
        folds: new Map(),
        strings: new Set(),
        rejected: candidates.has(stmt.localId),
      });
    }
    if (stmt.kind === "assign") assigned.add(stmt.localId);
    return everyStmtChild(stmt, findExpr, findStmt);
  };
  const findExpr = (expr: IrExpr): boolean => everyExprChild(expr, findExpr, findStmt);
  fn.body.every(findStmt);
  if (candidates.size === 0) return;
  for (const id of assigned) candidates.delete(id);

  const stringIndexHelper = lowerer.arrHofHelpers.get(`idxOr:${typeKey(STRING)}`);
  /** `m[k]` as lowered: the optional element read of the narrowed result,
   * or the dense read with or without the presence test before it (`m[k]!`,
   * a read concatenated with a string). */
  const captureRead = (expr: IrExpr): { local: string; use: CaptureUse } | null => {
    let result: IrExpr | undefined;
    let index: IrExpr | undefined;
    if (expr.kind === "call" && expr.callee === stringIndexHelper && expr.args.length === 2)
      [result, index] = expr.args;
    else if (expr.kind === "arrayGet" || expr.kind === "arrayState")
      ({ arr: result, index } = expr);
    else return null;
    if (
      result?.kind !== "unionNarrow" ||
      result.value.kind !== "varRef" ||
      index?.kind !== "numLit" ||
      !Number.isInteger(index.value) ||
      index.value < 0 ||
      index.value >= 53
    )
      return null;
    return { local: result.value.localId, use: { index: index.value, result } };
  };
  /** The capture read a foldable consumer takes, and its other operands. */
  const foldable = (expr: IrExpr): { read: IrExpr; rest: IrExpr[] } | null => {
    if (expr.kind === "unionEq" && !expr.sameValue) {
      if (isLiteral(expr.right)) return { read: expr.left, rest: [] };
      if (isLiteral(expr.left)) return { read: expr.right, rest: [] };
      return null;
    }
    if (
      expr.kind === "libCall" &&
      expr.fn === "dyn.numberConstructor" &&
      expr.args[0]?.kind === "dynFrom"
    )
      return { read: expr.args[0].value, rest: [] };
    if (
      expr.kind === "call" &&
      expr.args.length === 2 &&
      expr.args[0]!.type.kind === "union" &&
      expr.callee === lowerer.valueHelpers.get(`parseInt.optional:${expr.args[0]!.type.unionId}`)
    )
      return { read: expr.args[0]!, rest: [expr.args[1]!] };
    return null;
  };

  const visitExpr = (expr: IrExpr, parent: IrExpr | null): boolean => {
    const fold = foldable(expr);
    const folded = fold && fold.read.kind === "call" ? captureRead(fold.read) : null;
    const candidate = folded && candidates.get(folded.local);
    if (fold && folded && candidate) {
      candidate.folds.set(expr, folded.use);
      for (const operand of fold.rest) visitExpr(operand, expr);
      return true;
    }
    const read = captureRead(expr);
    const reader = read && candidates.get(read.local);
    if (read && reader) {
      reader.strings.add(read.use.index);
      return true;
    }
    if (expr.kind === "varRef") {
      const use = candidates.get(expr.localId);
      // Null tests are the only other use the binding may have.
      if (use && parent?.kind !== "unionIsTag") use.rejected = true;
      return true;
    }
    return everyExprChild(
      expr,
      (child) => visitExpr(child, expr),
      (stmt) => visitStmt(stmt),
    );
  };
  const visitStmt = (stmt: IrStmt): boolean =>
    everyStmtChild(stmt, (child) => visitExpr(child, null), visitStmt);
  fn.body.every(visitStmt);

  const rewrites = new Map<IrExpr, IrExpr>();
  for (const candidate of candidates.values()) {
    if (candidate.rejected) continue;
    let lazy = 0;
    const lazyIndices = new Set<number>();
    for (const use of candidate.folds.values()) {
      if (!candidate.strings.has(use.index) && !lazyIndices.has(use.index)) {
        lazyIndices.add(use.index);
        lazy += 2 ** use.index;
      }
    }
    if (lazy === 0) continue;
    for (const [consumer, use] of candidate.folds) {
      if (lazyIndices.has(use.index)) rewrites.set(consumer, spanRead(consumer, use));
    }
    const { match } = candidate;
    const mask = match.args[1]!;
    rewrites.set(match, {
      ...match,
      method: match.method === "matchGroups" ? "matchGroups" : "execSpans",
      args: [match.args[0]!, mask, numLit(lazy, match.loc)],
    });
  }
  if (rewrites.size === 0) return;
  fn.body = transformStmtList(fn.body, {
    stmt: (stmt) => stmt,
    expr: (expr) => rewrites.get(expr) ?? expr,
  });
}

function isLiteral(expr: IrExpr): boolean {
  return expr.kind === "unionWrap" && expr.value.kind === "strLit";
}

/** The span form of a foldable consumer of `use`. */
function spanRead(consumer: IrExpr, use: CaptureUse): IrExpr {
  const loc = consumer.loc;
  const capture = [use.result, numLit(use.index, loc)];
  if (consumer.kind === "unionEq") {
    const literal = isLiteral(consumer.right) ? consumer.right : consumer.left;
    const value = (literal as IrExpr & { kind: "unionWrap" }).value;
    const test: IrExpr = {
      kind: "libCall",
      fn: "regex.groupEquals",
      args: [...capture, value],
      type: BOOL,
      loc,
    };
    return consumer.negated ? { kind: "unary", op: "!", operand: test, type: BOOL, loc } : test;
  }
  if (consumer.kind === "libCall")
    return { kind: "libCall", fn: "regex.groupNumber", args: capture, type: F64, loc };
  const radix = (consumer as IrExpr & { kind: "call" }).args[1]!;
  return { kind: "libCall", fn: "regex.groupParseInt", args: [...capture, radix], type: F64, loc };
}
