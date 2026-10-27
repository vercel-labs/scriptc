/* IR helpers shared by the region analyses (region-groups.ts): node
 * traversal, allocation kinds, and how a use of a value passes it on or
 * keeps it in the frame. */
import type { IrExpr, IrStmt, IrType } from "../../ir/ir.js";
import { everyExprChild, everyStmtChild } from "../../ir/traverse.js";

export type Node = IrExpr | IrStmt;

/** The kinds of heap allocation sites counted. */
export const ALLOCATIONS = new Set([
  "arrayLit",
  "arrayNewLen",
  "mapNew",
  "setNew",
  "new",
  "recordLit",
  "recordClone",
  "closure",
]);

/** Array methods that return a fresh array without keeping the receiver. */
export const FRESH_ARRAY_METHODS = new Set([
  "slice",
  "concatSpread",
  "toReversed",
  "toSpliced",
  "with",
  "withUndefined",
  "flatCopy",
  "flatOne",
  "toSortedPrimitive",
  "splice",
]);
/** Array methods that return the receiver itself. */
export const RECEIVER_RESULT = new Set([
  "reverse",
  "fill",
  "fillUndefined",
  "copyWithin",
  "sortPrimitive",
]);
/** Array methods whose arguments are only read (compared, copied from). */
export const READ_ARGS = new Set([
  "includes",
  "indexOf",
  "indexEq",
  "getNumber",
  "join",
  "slice",
  "concatSpread",
  "pushSpread",
  "unshiftSpread",
  "nextPresent",
  "length",
]);

export function refType(t: IrType): boolean {
  return (
    t.kind === "array" ||
    t.kind === "map" ||
    t.kind === "set" ||
    t.kind === "object" ||
    t.kind === "record" ||
    t.kind === "func" ||
    t.kind === "union"
  );
}

export function children(node: Node, out: Node[]): void {
  const push = (child: Node): boolean => {
    out.push(child);
    return true;
  };
  if ("type" in node && (node as IrExpr).type !== undefined && isExpr(node))
    everyExprChild(node as IrExpr, push, push);
  else everyStmtChild(node as IrStmt, push, push);
}

const STMT_KINDS = new Set([
  "varDecl",
  "assign",
  "exprStmt",
  "if",
  "while",
  "doWhile",
  "switch",
  "for",
  "arraySet",
  "arraySetLength",
  "arraySetUndefined",
  "arrayDelete",
  "bytesSet",
  "forOf",
  "return",
  "fieldSet",
  "recordSet",
  "recordKeySet",
  "recordKeyDelete",
  "break",
  "continue",
  "block",
  "throw",
  "runtimeFence",
  "rethrow",
  "tryCatch",
]);
export function isExpr(node: Node): node is IrExpr {
  return !STMT_KINDS.has(node.kind);
}

/** Whether `a` and `b` are the same node. */
export function same(a: Node | undefined, b: Node): boolean {
  return a !== undefined && a === b;
}

/** Whether `parent` passes `child`'s value on as its own value (a branch of
 * a conditional, a union wrap or narrow, a class up- or downcast, the
 * result of a sequence), so the value's fate is the parent's. */
export function transparent(child: Node, parent: Node | undefined): boolean {
  if (parent === undefined) return false;
  switch (parent.kind) {
    case "ternary":
      return same(parent.then, child) || same(parent.else_, child);
    case "nullish":
    case "logical":
      return true;
    case "seqExpr":
      return same(parent.result, child);
    case "unionWrap":
    case "unionRetype":
    case "unionNarrow":
    case "upcast":
    case "downcast":
      return same(parent.value, child);
    default:
      return false;
  }
}

/** Whether a use of a local's value as `child` of `parent` keeps it in the
 * frame (given the current parameter summaries). */
export function keepsInFrame(
  child: Node,
  parent: Node | undefined,
  summaries: ReadonlyMap<string, Set<number>>,
): boolean {
  if (parent === undefined) return false;
  switch (parent.kind) {
    case "exprStmt":
      return true;
    case "arrayGet":
    case "arrayHas":
    case "arrayState":
    case "arraySetUndefined":
    case "arrayDelete":
    case "arraySetLength":
    case "arraySet":
      return same(parent.arr, child);
    case "fieldGet":
    case "recordGet":
    case "recordKeyGet":
    case "recordHas":
    case "recordOvfHas":
    case "recordOvfKeys":
    case "fieldSet":
    case "recordSet":
    case "recordKeySet":
    case "recordKeyDelete":
      return same(parent.obj, child);
    case "forOf":
      return same(parent.iterable, child);
    case "arrIntrinsic":
      if (same(parent.receiver, child)) return !RECEIVER_RESULT.has(parent.method);
      return READ_ARGS.has(parent.method);
    case "mapIntrinsic":
      if (same(parent.receiver, child)) return true;
      return parent.method === "get" || parent.method === "has" || parent.method === "delete";
    case "setIntrinsic":
      if (same(parent.receiver, child)) return true;
      return parent.method === "has" || parent.method === "delete";
    case "bin":
      return parent.op === "===" || parent.op === "!==";
    case "toBool":
    case "unary":
    case "unionIsTag":
    case "unionEq":
      return true;
    case "unionDisc":
    case "unionKeyGet":
      return same(parent.value, child);
    case "callValue":
      return same(parent.callee, child);
    case "call": {
      const index = indexOfNode(parent.args, child);
      return index >= 0 && summaries.get(parent.callee)?.has(index) === true;
    }
    default:
      return false;
  }
}

/** The index of `node` in `list`, or -1. */
export function indexOfNode(list: readonly IrExpr[], node: Node): number {
  for (let i = 0; i < list.length; i++) if (same(list[i], node)) return i;
  return -1;
}

/** The arguments of a node that takes them (calls, constructions,
 * intrinsics), or null. */
export function argsOf(node: Node): readonly IrExpr[] | null {
  switch (node.kind) {
    case "call":
    case "callValue":
    case "virtualCall":
    case "new":
    case "newValue":
    case "ffiCall":
    case "dynCall":
    case "dynInvoke":
    case "intrinsic":
    case "libCall":
    case "arrIntrinsic":
    case "bytesIntrinsic":
    case "mapIntrinsic":
    case "setIntrinsic":
    case "strIntrinsic":
    case "regexIntrinsic":
      return node.args;
    default:
      return null;
  }
}

const LOOP_STMTS = new Set(["while", "doWhile", "for", "forOf"]);

/** Calls `visit(node, parent, loops)` for every node of `body`, parents
 * before their children (siblings in no set order), where `loops` counts
 * the loops around `node`. Allocates nothing per node. */
export function forEachNode(
  body: readonly IrStmt[],
  visit: (node: Node, parent: Node | undefined, loops: number) => void,
): void {
  const nodes: Node[] = [];
  const parents: (Node | undefined)[] = [];
  const depths: number[] = [];
  let parent: Node | undefined = undefined;
  let depth = 0;
  const pushExpr = (child: IrExpr): boolean => {
    nodes.push(child);
    parents.push(parent);
    depths.push(depth);
    return true;
  };
  const pushStmt = (child: IrStmt): boolean => {
    nodes.push(child);
    parents.push(parent);
    depths.push(depth);
    return true;
  };
  for (const st of body) pushStmt(st);
  while (nodes.length > 0) {
    const node = nodes.pop()!;
    const above = parents.pop();
    const loops = depths.pop()!;
    visit(node, above, loops);
    parent = node;
    depth = loops + (LOOP_STMTS.has(node.kind) ? 1 : 0);
    if (isExpr(node)) everyExprChild(node, pushExpr, pushStmt);
    else everyStmtChild(node, pushExpr, pushStmt);
  }
}
