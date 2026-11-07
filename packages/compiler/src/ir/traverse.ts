import type { IrExpr, IrModule, IrStmt, IrType, SrcLoc } from "./ir.js";

// Child lists are walked with these loops rather than with `every` or `map`
// and an arrow function: the arrow would be a new closure at every visited
// node, which the native compiler allocates and releases per node.

/** Maps a child list and returns `children` itself when every child maps to
 * itself. A rewrite pass walks whole functions, and the common case is a
 * subtree the pass does not touch; returning the input list keeps that walk
 * allocation-free. `map` is called on every child, in order, either way. */
function mapOf<T>(children: readonly T[], map: (child: T) => T): T[] {
  const length = children.length;
  for (let i = 0; i < length; i++) {
    const child = children[i]!;
    const mapped = map(child);
    if (mapped === child) continue;
    const result: T[] = children.slice(0, i) as T[];
    result.push(mapped);
    for (let j = i + 1; j < length; j++) result.push(map(children[j]!));
    return result;
  }
  return children as T[];
}

/** mapOf over a record literal's or object literal's value slots. */
function mapValues<T extends { value: IrExpr }>(
  children: readonly T[],
  expr: (expr: IrExpr) => IrExpr,
): T[] {
  const length = children.length;
  for (let i = 0; i < length; i++) {
    const child = children[i]!;
    const value = expr(child.value);
    if (value === child.value) continue;
    const result: T[] = children.slice(0, i) as T[];
    result.push({ ...child, value });
    for (let j = i + 1; j < length; j++) {
      const rest = children[j]!;
      result.push({ ...rest, value: expr(rest.value) });
    }
    return result;
  }
  return children as T[];
}

/** mapOf over a map literal's or dynamic object literal's entry slots. */
function mapEntries<T extends { key: IrExpr; value: IrExpr }>(
  children: readonly T[],
  expr: (expr: IrExpr) => IrExpr,
): T[] {
  const length = children.length;
  for (let i = 0; i < length; i++) {
    const child = children[i]!;
    const key = expr(child.key);
    const value = expr(child.value);
    if (key === child.key && value === child.value) continue;
    const result: T[] = children.slice(0, i) as T[];
    result.push({ ...child, key, value });
    for (let j = i + 1; j < length; j++) {
      const rest = children[j]!;
      result.push({ ...rest, key: expr(rest.key), value: expr(rest.value) });
    }
    return result;
  }
  return children as T[];
}

/** mapOf over a switch statement's cases (a test and a statement body). */
function mapCases<T extends { test: IrExpr | null; body: IrStmt[] }>(
  cases: readonly T[],
  expr: (expr: IrExpr) => IrExpr,
  stmt: (stmt: IrStmt) => IrStmt,
): T[] {
  const length = cases.length;
  for (let i = 0; i < length; i++) {
    const child = cases[i]!;
    const test = child.test === null ? null : expr(child.test);
    const body = mapOf(child.body, stmt);
    if (test === child.test && body === child.body) continue;
    const result: T[] = cases.slice(0, i) as T[];
    result.push({ ...child, test, body });
    for (let j = i + 1; j < length; j++) {
      const rest = cases[j]!;
      const restTest = rest.test === null ? null : expr(rest.test);
      result.push({ ...rest, test: restTest, body: mapOf(rest.body, stmt) });
    }
    return result;
  }
  return cases as T[];
}

function everyOf<T>(children: readonly T[], visit: (child: T) => boolean): boolean {
  const length = children.length;
  for (let i = 0; i < length; i++) if (!visit(children[i]!)) return false;
  return true;
}

function everyValue(
  children: readonly { value: IrExpr }[],
  expr: (expr: IrExpr) => boolean,
): boolean {
  const length = children.length;
  for (let i = 0; i < length; i++) if (!expr(children[i]!.value)) return false;
  return true;
}

function everyEntry(
  children: readonly { key: IrExpr; value: IrExpr }[],
  expr: (expr: IrExpr) => boolean,
): boolean {
  const length = children.length;
  for (let i = 0; i < length; i++) {
    const child = children[i]!;
    if (!expr(child.key) || !expr(child.value)) return false;
  }
  return true;
}

/** The type tree contains structural children; named shapes are references.
 * Module traversal visits each shape definition separately. */
export function everyTypeChild(node: IrType, visit: (node: IrType) => boolean): boolean {
  switch (node.kind) {
    case "array":
    case "set":
      return visit(node.elem);
    case "map":
      return visit(node.key) && visit(node.value);
    case "func":
      return everyOf(node.params, visit) && visit(node.ret);
    case "promise":
      return visit(node.inner);
    case "generator":
      return visit(node.yieldT) && visit(node.retT) && visit(node.nextT);
    case "f64":
    case "bigint":
    case "date":
    case "string":
    case "bool":
    case "regex":
    case "bytes":
    case "url":
    case "searchParams":
    case "symbol":
    case "stats":
    case "bigintStats":
    case "fileHandle":
    case "dir":
    case "spawnRes":
    case "child":
    case "netServer":
    case "netSocket":
    case "http2Session":
    case "http2Stream":
    case "dgramSocket":
    case "testCtx":
    case "httpReq":
    case "httpRes":
    case "httpClientReq":
    case "childStream":
    case "childWriter":
    case "procStream":
    case "fsWatcher":
    case "secureCtx":
    case "cryptoHash":
    case "cryptoHmac":
    case "object":
    case "classval":
    case "moduleNs":
    case "record":
    case "union":
    case "dyn":
    case "jsval":
    case "caught":
    case "undefinedT":
    case "nullT":
    case "void":
      return true;
  }
  node satisfies never;
  throw new Error("unhandled IR type");
}

export interface IrModuleVisitor extends IrVisitor {
  type: (type: IrType, loc: SrcLoc) => boolean;
}

/** Inspect executable nodes and every typed slot without reflecting over
 * source text, locations, labels, or other metadata. A false predicate stops
 * the whole walk. Results are never retained across mutable compiler passes. */
export function everyModuleNode(mod: IrModule, visitor: IrModuleVisitor): boolean {
  // Every node of one type tree reports the tree's location: one shared
  // child callback serves them all.
  let typeLoc: SrcLoc;
  const typeNode = (node: IrType): boolean =>
    visitor.type(node, typeLoc) && everyTypeChild(node, typeNode);
  const type = (node: IrType, loc: SrcLoc): boolean => {
    typeLoc = loc;
    return typeNode(node);
  };
  const expr = (node: IrExpr): boolean =>
    visitor.expr(node) && everyExprChild(node, expr, stmt) && type(node.type, node.loc);
  const stmt = (node: IrStmt): boolean => visitor.stmt(node) && everyStmtChild(node, expr, stmt);
  const entryLoc: SrcLoc = { file: mod.sourceFile, start: 0, end: 0 };
  for (const fn of mod.functions) {
    for (const param of fn.params) if (!type(param.type, fn.loc)) return false;
    if (!type(fn.returnType, fn.loc)) return false;
    for (const local of fn.locals) if (!type(local.type, local.source?.loc ?? fn.loc)) return false;
    for (const capture of fn.captures ?? []) if (!type(capture.type, fn.loc)) return false;
    for (const capture of fn.classCaptures ?? []) if (!type(capture.type, fn.loc)) return false;
    if (
      fn.generator !== undefined &&
      (!type(fn.generator.yieldT, fn.loc) ||
        !type(fn.generator.nextT, fn.loc) ||
        !type(fn.generator.resultType, fn.loc))
    )
      return false;
    for (const node of fn.body) if (!stmt(node)) return false;
  }
  for (const cls of mod.classes ?? []) {
    for (const capture of cls.localCaptures ?? []) if (!type(capture.type, cls.loc)) return false;
    for (const field of cls.fields) if (!type(field.type, cls.loc)) return false;
    if (cls.arrayElem !== undefined && !type(cls.arrayElem, cls.loc)) return false;
  }
  for (const global of mod.globals ?? [])
    if (!type(global.type, global.source?.loc ?? entryLoc)) return false;
  for (const record of mod.records ?? []) {
    for (const field of record.fields) if (!type(field.type, entryLoc)) return false;
    if (record.indexValue !== undefined && !type(record.indexValue, entryLoc)) return false;
  }
  for (const union of mod.unions ?? [])
    for (const arm of union.arms) if (!type(arm, entryLoc)) return false;
  return true;
}

/** Typed structural traversal of executable IR. Types, source locations,
 * captures, labels and other metadata are deliberately not child nodes.
 * Child order follows the IR schema; this visits all branches, including
 * dormant callbacks and lazy operands, rather than simulating execution.
 * Predicates can stop traversal without allocating a dynamic snapshot. */
export interface IrVisitor {
  expr: (expr: IrExpr) => boolean;
  stmt: (stmt: IrStmt) => boolean;
}

export interface IrTransform {
  expr: (expr: IrExpr) => IrExpr;
  stmt: (stmt: IrStmt) => IrStmt;
}

/** Visit immediate children, stopping on the first false result. */
export function everyExprChild(
  node: IrExpr,
  expr: (expr: IrExpr) => boolean,
  stmt: (stmt: IrStmt) => boolean,
): boolean {
  // The most common node kinds come first: the engine tests string cases
  // one after another, in source order.
  switch (node.kind) {
    case "varRef":
      return true;
    case "call":
      return everyOf(node.args, expr);
    case "dynFrom":
      return expr(node.value);
    case "strLit":
      return true;
    case "libCall":
      return everyOf(node.args, expr);
    case "dynCheck":
      return expr(node.value);
    case "strEq":
      return expr(node.left) && expr(node.right);
    case "fieldGet":
      return expr(node.obj);
    case "ternary":
      return expr(node.cond) && expr(node.then) && expr(node.else_);
    case "closure":
      return true;
    case "boolLit":
      return true;
    case "numLit":
      return true;
    case "unitLit":
      return true;
    case "seqExpr":
      return everyOf(node.stmts, stmt) && expr(node.result);
    case "dynCall":
      return (
        expr(node.callee) &&
        (node.receiver === undefined || expr(node.receiver)) &&
        (node.calleeNameValue === undefined || expr(node.calleeNameValue)) &&
        everyOf(node.args, expr)
      );
    case "dynTest":
      return expr(node.value);
    case "dynScalarEq":
      return expr(node.left) && expr(node.right);
    case "upcast":
      return expr(node.value);
    case "bin":
      return expr(node.left) && expr(node.right);
    case "moduleNsRef":
      return true;
    case "unary":
      return expr(node.operand);
    case "incDec":
      return true;
    case "fieldIncDec":
      return expr(node.obj);
    case "assignExpr":
      return expr(node.value);
    case "toBool":
      return expr(node.operand);
    case "logical":
      return expr(node.left) && expr(node.right);
    case "strConcat":
      return expr(node.left) && expr(node.right);
    case "strCmp":
      return expr(node.left) && expr(node.right);
    case "toString":
      return expr(node.operand);
    case "nullish":
      return expr(node.left) && expr(node.right);
    case "orDefault":
      return expr(node.left) && expr(node.right);
    case "optChain":
      return expr(node.receiver) && expr(node.body);
    case "chainRecv":
      return true;
    case "strIntrinsic":
      return expr(node.receiver) && everyOf(node.args, expr);
    case "regexLit":
      return true;
    case "templateStrings":
      return true;
    case "regexIntrinsic":
      return expr(node.receiver) && everyOf(node.args, expr);
    case "arrayLit":
      return everyOf(node.elems, expr);
    case "arrayNewLen":
      return expr(node.length);
    case "arrayGet":
      return expr(node.arr) && expr(node.index);
    case "arrayHas":
      return expr(node.arr) && expr(node.index);
    case "arrayState":
      return expr(node.arr) && expr(node.index);
    case "arrIntrinsic":
      return expr(node.receiver) && everyOf(node.args, expr);
    case "bytesNew":
      return node.source === null || expr(node.source);
    case "bytesIntrinsic":
      return expr(node.receiver) && everyOf(node.args, expr);
    case "mapNew":
      return node.seed === undefined || everyEntry(node.seed, expr);
    case "mapIntrinsic":
      return expr(node.receiver) && everyOf(node.args, expr);
    case "setNew":
      return node.seed === undefined || expr(node.seed);
    case "setIntrinsic":
      return expr(node.receiver) && everyOf(node.args, expr);
    case "ffiCall":
      return everyOf(node.args, expr);
    case "callValue":
      return (
        expr(node.callee) &&
        (node.receiver === undefined || expr(node.receiver)) &&
        everyOf(node.args, expr)
      );
    case "selfRef":
      return true;
    case "yieldExpr":
      return node.value === null || expr(node.value);
    case "genResume":
      return expr(node.gen) && (node.arg === null || expr(node.arg));
    case "awaitExpr":
      return expr(node.value);
    case "awaitUnionExpr":
      return expr(node.value);
    case "newPromise":
      return expr(node.executor);
    case "promiseWithResolvers":
      return true;
    case "new":
      return everyOf(node.args, expr);
    case "classRef":
      return true;
    case "newValue":
      return expr(node.callee) && everyOf(node.args, expr);
    case "instanceOfValue":
      return expr(node.value) && expr(node.classValue);
    case "promiseVoidWiden":
      return expr(node.value);
    case "downcast":
      return expr(node.value);
    case "instanceOf":
      return expr(node.value);
    case "virtualCall":
      return everyOf(node.args, expr);
    case "recordLit":
      return everyValue(node.fields, expr);
    case "recordClone":
      return expr(node.source) && everyValue(node.overrides, expr);
    case "recordGet":
      return expr(node.obj);
    case "recordKeyGet":
      return expr(node.obj) && expr(node.key);
    case "dynInvoke":
      return (
        expr(node.recv) &&
        (node.calleeNameValue === undefined || expr(node.calleeNameValue)) &&
        everyOf(node.args, expr)
      );
    case "dynArrLit":
      return everyOf(node.elems, expr);
    case "dynObjLit":
      return node.fields === undefined || everyEntry(node.fields, expr);
    case "dynKeyGet":
      return expr(node.key) && expr(node.value);
    case "dynHasKey":
      return expr(node.value);
    case "dynDestrCheck":
      return expr(node.value);
    case "dynIterN":
      return expr(node.value);
    case "recordOvfKeys":
      return expr(node.obj);
    case "recordOvfHas":
      return expr(node.obj) && expr(node.key);
    case "recordNullProto":
      return expr(node.obj);
    case "recordHas":
      return expr(node.obj);
    case "fieldAbsent":
      return true;
    case "unionWrap":
      return expr(node.value);
    case "unionRetype":
      return expr(node.value);
    case "unionFuncEq":
      return expr(node.union) && expr(node.func);
    case "caughtTest":
      return expr(node.value);
    case "caughtNarrow":
      return expr(node.value);
    case "caughtCheck":
      return expr(node.value);
    case "caughtToDyn":
      return expr(node.value);
    case "unionNarrow":
      return expr(node.value);
    case "unionDisc":
      return expr(node.value);
    case "unionKeyGet":
      return expr(node.key) && expr(node.value);
    case "unionIsTag":
      return expr(node.value);
    case "unionEq":
      return expr(node.left) && expr(node.right);
    case "intrinsic":
      return everyOf(node.args, expr);
    case "jsonStringify":
      return expr(node.value);
  }
  node satisfies never;
  throw new Error("unhandled IR node");
}

/** Visit immediate children, stopping on the first false result. */
export function everyStmtChild(
  node: IrStmt,
  expr: (expr: IrExpr) => boolean,
  stmt: (stmt: IrStmt) => boolean,
): boolean {
  // The most common node kinds come first: the engine tests string cases
  // one after another, in source order.
  switch (node.kind) {
    case "return":
      return node.value === null || expr(node.value);
    case "if":
      return (
        expr(node.cond) &&
        everyOf(node.then, stmt) &&
        (node.else_ === null || everyOf(node.else_, stmt))
      );
    case "varDecl":
      return node.init === null || expr(node.init);
    case "exprStmt":
      return expr(node.expr);
    case "assign":
      return expr(node.value);
    case "block":
      return everyOf(node.body, stmt);
    case "fieldSet":
      return expr(node.obj) && expr(node.value);
    case "while":
      return expr(node.cond) && everyOf(node.body, stmt);
    case "doWhile":
      return everyOf(node.body, stmt) && expr(node.cond);
    case "switch": {
      if (!expr(node.disc)) return false;
      const length = node.cases.length;
      for (let i = 0; i < length; i++) {
        const child = node.cases[i]!;
        if (child.test !== null && !expr(child.test)) return false;
        if (!everyOf(child.body, stmt)) return false;
      }
      return true;
    }
    case "for":
      return (
        (node.init === null || stmt(node.init)) &&
        (node.cond === null || expr(node.cond)) &&
        (node.update === null || stmt(node.update)) &&
        everyOf(node.body, stmt)
      );
    case "arraySet":
      return expr(node.arr) && expr(node.index) && expr(node.value);
    case "arraySetLength":
      return expr(node.arr) && expr(node.length);
    case "arraySetUndefined":
      return expr(node.arr) && expr(node.index);
    case "arrayDelete":
      return expr(node.arr) && expr(node.index);
    case "bytesSet":
      return expr(node.arr) && expr(node.index) && expr(node.value);
    case "forOf":
      return expr(node.iterable) && everyOf(node.body, stmt);
    case "recordSet":
      return expr(node.obj) && expr(node.value);
    case "recordKeySet":
      return expr(node.obj) && expr(node.key) && expr(node.value);
    case "recordKeyDelete":
      return expr(node.obj) && expr(node.key);
    case "break":
      return true;
    case "continue":
      return true;
    case "throw":
      return expr(node.value);
    case "runtimeFence":
      return true;
    case "genBindBarrier":
      return true;
    case "rethrow":
      return true;
    case "tryCatch":
      return (
        everyOf(node.tryBody, stmt) &&
        (node.catchBody === null || everyOf(node.catchBody, stmt)) &&
        (node.finallyBody === null || everyOf(node.finallyBody, stmt))
      );
  }
  node satisfies never;
  throw new Error("unhandled IR node");
}

/** Called with each record literal and checked conversion mapExprChildren
 * rebuilds and its replacement, so a side table keyed by node identity (the
 * lowering's key-order witness notes) follows the node into the rewritten
 * tree. A node whose children are unchanged is not rebuilt and keeps its
 * identity, so the note stays attached and no call is made. */
let recordLiteralRebuilt: ((from: IrExpr, to: IrExpr) => void) | null = null;

/** Installs (or with null removes) the record-literal rebuild observer. */
export function observeRecordLiteralRebuilds(
  observer: ((from: IrExpr, to: IrExpr) => void) | null,
): void {
  recordLiteralRebuilt = observer;
}

/** Copy a node with transformed immediate children; preserve all metadata.
 * A node whose children all map to themselves is returned as-is, so a
 * rewrite pass that changes nothing below it allocates nothing for it. A
 * rebuilt node is a new object and the caller owns it; the input is never
 * mutated. */
export function mapExprChildren(
  node: IrExpr,
  expr: (expr: IrExpr) => IrExpr,
  stmt: (stmt: IrStmt) => IrStmt,
): IrExpr {
  // The most common node kinds come first: the engine tests string cases
  // one after another, in source order.
  switch (node.kind) {
    case "varRef":
      return node;
    case "call": {
      const args = mapOf(node.args, expr);
      return args === node.args ? node : { ...node, args };
    }
    case "dynFrom": {
      const value = expr(node.value);
      return value === node.value ? node : { ...node, value };
    }
    case "strLit":
      return node;
    case "libCall": {
      const args = mapOf(node.args, expr);
      return args === node.args ? node : { ...node, args };
    }
    case "dynCheck": {
      const value = expr(node.value);
      if (value === node.value) return node;
      const rebuilt: IrExpr = { ...node, value };
      if (recordLiteralRebuilt !== null) recordLiteralRebuilt(node, rebuilt);
      return rebuilt;
    }
    case "strEq": {
      const left = expr(node.left);
      const right = expr(node.right);
      return left === node.left && right === node.right ? node : { ...node, left, right };
    }
    case "fieldGet": {
      const obj = expr(node.obj);
      return obj === node.obj ? node : { ...node, obj };
    }
    case "ternary": {
      const cond = expr(node.cond);
      const then = expr(node.then);
      const else_ = expr(node.else_);
      return cond === node.cond && then === node.then && else_ === node.else_
        ? node
        : { ...node, cond, then, else_ };
    }
    case "closure":
      return node;
    case "boolLit":
      return node;
    case "numLit":
      return node;
    case "unitLit":
      return node;
    case "seqExpr": {
      const stmts = mapOf(node.stmts, stmt);
      const result = expr(node.result);
      return stmts === node.stmts && result === node.result ? node : { ...node, stmts, result };
    }
    case "dynCall": {
      const callee = expr(node.callee);
      const receiver = node.receiver === undefined ? undefined : expr(node.receiver);
      const calleeNameValue =
        node.calleeNameValue === undefined ? undefined : expr(node.calleeNameValue);
      const args = mapOf(node.args, expr);
      if (
        callee === node.callee &&
        receiver === node.receiver &&
        calleeNameValue === node.calleeNameValue &&
        args === node.args
      )
        return node;
      const result: Extract<IrExpr, { kind: "dynCall" }> = { ...node, callee };
      if (receiver !== undefined) result.receiver = receiver;
      if (calleeNameValue !== undefined) result.calleeNameValue = calleeNameValue;
      result.args = args;
      return result;
    }
    case "dynTest": {
      const value = expr(node.value);
      return value === node.value ? node : { ...node, value };
    }
    case "dynScalarEq": {
      const left = expr(node.left);
      const right = expr(node.right);
      return left === node.left && right === node.right ? node : { ...node, left, right };
    }
    case "upcast": {
      const value = expr(node.value);
      return value === node.value ? node : { ...node, value };
    }
    case "bin": {
      const left = expr(node.left);
      const right = expr(node.right);
      return left === node.left && right === node.right ? node : { ...node, left, right };
    }
    case "moduleNsRef":
      return node;
    case "unary": {
      const operand = expr(node.operand);
      return operand === node.operand ? node : { ...node, operand };
    }
    case "incDec":
      return node;
    case "fieldIncDec": {
      const obj = expr(node.obj);
      return obj === node.obj ? node : { ...node, obj };
    }
    case "assignExpr": {
      const value = expr(node.value);
      return value === node.value ? node : { ...node, value };
    }
    case "toBool": {
      const operand = expr(node.operand);
      return operand === node.operand ? node : { ...node, operand };
    }
    case "logical": {
      const left = expr(node.left);
      const right = expr(node.right);
      return left === node.left && right === node.right ? node : { ...node, left, right };
    }
    case "strConcat": {
      const left = expr(node.left);
      const right = expr(node.right);
      return left === node.left && right === node.right ? node : { ...node, left, right };
    }
    case "strCmp": {
      const left = expr(node.left);
      const right = expr(node.right);
      return left === node.left && right === node.right ? node : { ...node, left, right };
    }
    case "toString": {
      const operand = expr(node.operand);
      return operand === node.operand ? node : { ...node, operand };
    }
    case "nullish": {
      const left = expr(node.left);
      const right = expr(node.right);
      return left === node.left && right === node.right ? node : { ...node, left, right };
    }
    case "orDefault": {
      const left = expr(node.left);
      const right = expr(node.right);
      return left === node.left && right === node.right ? node : { ...node, left, right };
    }
    case "optChain": {
      const receiver = expr(node.receiver);
      const body = expr(node.body);
      return receiver === node.receiver && body === node.body ? node : { ...node, receiver, body };
    }
    case "chainRecv":
      return node;
    case "strIntrinsic": {
      const receiver = expr(node.receiver);
      const args = mapOf(node.args, expr);
      return receiver === node.receiver && args === node.args ? node : { ...node, receiver, args };
    }
    case "regexLit":
      return node;
    case "templateStrings":
      return node;
    case "regexIntrinsic": {
      const receiver = expr(node.receiver);
      const args = mapOf(node.args, expr);
      return receiver === node.receiver && args === node.args ? node : { ...node, receiver, args };
    }
    case "arrayLit": {
      const elems = mapOf(node.elems, expr);
      return elems === node.elems ? node : { ...node, elems };
    }
    case "arrayNewLen": {
      const length = expr(node.length);
      return length === node.length ? node : { ...node, length };
    }
    case "arrayGet": {
      const arr = expr(node.arr);
      const index = expr(node.index);
      return arr === node.arr && index === node.index ? node : { ...node, arr, index };
    }
    case "arrayHas": {
      const arr = expr(node.arr);
      const index = expr(node.index);
      return arr === node.arr && index === node.index ? node : { ...node, arr, index };
    }
    case "arrayState": {
      const arr = expr(node.arr);
      const index = expr(node.index);
      return arr === node.arr && index === node.index ? node : { ...node, arr, index };
    }
    case "arrIntrinsic": {
      const receiver = expr(node.receiver);
      const args = mapOf(node.args, expr);
      return receiver === node.receiver && args === node.args ? node : { ...node, receiver, args };
    }
    case "bytesNew": {
      const source = node.source === null ? null : expr(node.source);
      return source === node.source ? node : { ...node, source };
    }
    case "bytesIntrinsic": {
      const receiver = expr(node.receiver);
      const args = mapOf(node.args, expr);
      return receiver === node.receiver && args === node.args ? node : { ...node, receiver, args };
    }
    case "mapNew": {
      if (node.seed === undefined) return node;
      const seed = mapEntries(node.seed, expr);
      return seed === node.seed ? node : { ...node, seed };
    }
    case "mapIntrinsic": {
      const receiver = expr(node.receiver);
      const args = mapOf(node.args, expr);
      return receiver === node.receiver && args === node.args ? node : { ...node, receiver, args };
    }
    case "setNew": {
      if (node.seed === undefined) return node;
      const seed = expr(node.seed);
      return seed === node.seed ? node : { ...node, seed };
    }
    case "setIntrinsic": {
      const receiver = expr(node.receiver);
      const args = mapOf(node.args, expr);
      return receiver === node.receiver && args === node.args ? node : { ...node, receiver, args };
    }
    case "ffiCall": {
      const args = mapOf(node.args, expr);
      return args === node.args ? node : { ...node, args };
    }
    case "callValue": {
      const callee = expr(node.callee);
      if (node.receiver === undefined) {
        const args = mapOf(node.args, expr);
        return callee === node.callee && args === node.args ? node : { ...node, callee, args };
      }
      const receiver = expr(node.receiver);
      const args = mapOf(node.args, expr);
      return callee === node.callee && receiver === node.receiver && args === node.args
        ? node
        : { ...node, callee, receiver, args };
    }
    case "selfRef":
      return node;
    case "yieldExpr": {
      const value = node.value === null ? null : expr(node.value);
      return value === node.value ? node : { ...node, value };
    }
    case "genResume": {
      const gen = expr(node.gen);
      const arg = node.arg === null ? null : expr(node.arg);
      return gen === node.gen && arg === node.arg ? node : { ...node, gen, arg };
    }
    case "awaitExpr": {
      const value = expr(node.value);
      return value === node.value ? node : { ...node, value };
    }
    case "awaitUnionExpr": {
      const value = expr(node.value);
      return value === node.value ? node : { ...node, value };
    }
    case "newPromise": {
      const executor = expr(node.executor);
      return executor === node.executor ? node : { ...node, executor };
    }
    case "promiseWithResolvers":
      return node;
    case "new": {
      const args = mapOf(node.args, expr);
      return args === node.args ? node : { ...node, args };
    }
    case "classRef":
      return node;
    case "newValue": {
      const callee = expr(node.callee);
      const args = mapOf(node.args, expr);
      return callee === node.callee && args === node.args ? node : { ...node, callee, args };
    }
    case "instanceOfValue": {
      const value = expr(node.value);
      const classValue = expr(node.classValue);
      return value === node.value && classValue === node.classValue
        ? node
        : { ...node, value, classValue };
    }
    case "promiseVoidWiden": {
      const value = expr(node.value);
      return value === node.value ? node : { ...node, value };
    }
    case "downcast": {
      const value = expr(node.value);
      return value === node.value ? node : { ...node, value };
    }
    case "instanceOf": {
      const value = expr(node.value);
      return value === node.value ? node : { ...node, value };
    }
    case "virtualCall": {
      const args = mapOf(node.args, expr);
      return args === node.args ? node : { ...node, args };
    }
    case "recordLit": {
      const fields = mapValues(node.fields, expr);
      if (fields === node.fields) return node;
      const rebuilt: IrExpr = { ...node, fields };
      if (recordLiteralRebuilt !== null) recordLiteralRebuilt(node, rebuilt);
      return rebuilt;
    }
    case "recordClone": {
      const source = expr(node.source);
      const overrides = mapValues(node.overrides, expr);
      return source === node.source && overrides === node.overrides
        ? node
        : { ...node, source, overrides };
    }
    case "recordGet": {
      const obj = expr(node.obj);
      return obj === node.obj ? node : { ...node, obj };
    }
    case "recordKeyGet": {
      const obj = expr(node.obj);
      const key = expr(node.key);
      return obj === node.obj && key === node.key ? node : { ...node, obj, key };
    }
    case "dynInvoke": {
      const recv = expr(node.recv);
      const calleeNameValue =
        node.calleeNameValue === undefined ? undefined : expr(node.calleeNameValue);
      const args = mapOf(node.args, expr);
      if (recv === node.recv && calleeNameValue === node.calleeNameValue && args === node.args)
        return node;
      const result: Extract<IrExpr, { kind: "dynInvoke" }> = { ...node, recv };
      if (calleeNameValue !== undefined) result.calleeNameValue = calleeNameValue;
      result.args = args;
      return result;
    }
    case "dynArrLit": {
      const elems = mapOf(node.elems, expr);
      return elems === node.elems ? node : { ...node, elems };
    }
    case "dynObjLit": {
      if (node.fields === undefined) return node;
      const fields = mapEntries(node.fields, expr);
      return fields === node.fields ? node : { ...node, fields };
    }
    case "dynKeyGet": {
      const key = expr(node.key);
      const value = expr(node.value);
      return key === node.key && value === node.value ? node : { ...node, key, value };
    }
    case "dynHasKey": {
      const value = expr(node.value);
      return value === node.value ? node : { ...node, value };
    }
    case "dynDestrCheck": {
      const value = expr(node.value);
      return value === node.value ? node : { ...node, value };
    }
    case "dynIterN": {
      const value = expr(node.value);
      return value === node.value ? node : { ...node, value };
    }
    case "recordOvfKeys": {
      const obj = expr(node.obj);
      return obj === node.obj ? node : { ...node, obj };
    }
    case "recordOvfHas": {
      const obj = expr(node.obj);
      const key = expr(node.key);
      return obj === node.obj && key === node.key ? node : { ...node, obj, key };
    }
    case "recordNullProto": {
      const obj = expr(node.obj);
      return obj === node.obj ? node : { ...node, obj };
    }
    case "recordHas": {
      const obj = expr(node.obj);
      return obj === node.obj ? node : { ...node, obj };
    }
    case "fieldAbsent":
      return node;
    case "unionWrap": {
      const value = expr(node.value);
      return value === node.value ? node : { ...node, value };
    }
    case "unionRetype": {
      const value = expr(node.value);
      return value === node.value ? node : { ...node, value };
    }
    case "unionFuncEq": {
      const union = expr(node.union);
      const func = expr(node.func);
      return union === node.union && func === node.func ? node : { ...node, union, func };
    }
    case "caughtTest": {
      const value = expr(node.value);
      return value === node.value ? node : { ...node, value };
    }
    case "caughtNarrow": {
      const value = expr(node.value);
      return value === node.value ? node : { ...node, value };
    }
    case "caughtCheck": {
      const value = expr(node.value);
      return value === node.value ? node : { ...node, value };
    }
    case "caughtToDyn": {
      const value = expr(node.value);
      return value === node.value ? node : { ...node, value };
    }
    case "unionNarrow": {
      const value = expr(node.value);
      return value === node.value ? node : { ...node, value };
    }
    case "unionDisc": {
      const value = expr(node.value);
      return value === node.value ? node : { ...node, value };
    }
    case "unionKeyGet": {
      const key = expr(node.key);
      const value = expr(node.value);
      return key === node.key && value === node.value ? node : { ...node, key, value };
    }
    case "unionIsTag": {
      const value = expr(node.value);
      return value === node.value ? node : { ...node, value };
    }
    case "unionEq": {
      const left = expr(node.left);
      const right = expr(node.right);
      return left === node.left && right === node.right ? node : { ...node, left, right };
    }
    case "intrinsic": {
      const args = mapOf(node.args, expr);
      return args === node.args ? node : { ...node, args };
    }
    case "jsonStringify": {
      const value = expr(node.value);
      return value === node.value ? node : { ...node, value };
    }
  }
  node satisfies never;
  throw new Error("unhandled IR node");
}

/** Copy a node with transformed immediate children; preserve all metadata. */
export function mapStmtChildren(
  node: IrStmt,
  expr: (expr: IrExpr) => IrExpr,
  stmt: (stmt: IrStmt) => IrStmt,
): IrStmt {
  // The most common node kinds come first: the engine tests string cases
  // one after another, in source order.
  switch (node.kind) {
    case "return": {
      const value = node.value === null ? null : expr(node.value);
      return value === node.value ? node : { ...node, value };
    }
    case "if": {
      const cond = expr(node.cond);
      const then = mapOf(node.then, stmt);
      const else_ = node.else_ === null ? null : mapOf(node.else_, stmt);
      return cond === node.cond && then === node.then && else_ === node.else_
        ? node
        : { ...node, cond, then, else_ };
    }
    case "varDecl": {
      const init = node.init === null ? null : expr(node.init);
      return init === node.init ? node : { ...node, init };
    }
    case "exprStmt": {
      const inner = expr(node.expr);
      return inner === node.expr ? node : { ...node, expr: inner };
    }
    case "assign": {
      const value = expr(node.value);
      return value === node.value ? node : { ...node, value };
    }
    case "block": {
      const body = mapOf(node.body, stmt);
      return body === node.body ? node : { ...node, body };
    }
    case "fieldSet": {
      const obj = expr(node.obj);
      const value = expr(node.value);
      return obj === node.obj && value === node.value ? node : { ...node, obj, value };
    }
    case "while": {
      const cond = expr(node.cond);
      const body = mapOf(node.body, stmt);
      return cond === node.cond && body === node.body ? node : { ...node, cond, body };
    }
    case "doWhile": {
      const body = mapOf(node.body, stmt);
      const cond = expr(node.cond);
      return body === node.body && cond === node.cond ? node : { ...node, body, cond };
    }
    case "switch": {
      const disc = expr(node.disc);
      const cases = mapCases(node.cases, expr, stmt);
      return disc === node.disc && cases === node.cases ? node : { ...node, disc, cases };
    }
    case "for": {
      const init = node.init === null ? null : stmt(node.init);
      const cond = node.cond === null ? null : expr(node.cond);
      const update = node.update === null ? null : stmt(node.update);
      const body = mapOf(node.body, stmt);
      return init === node.init &&
        cond === node.cond &&
        update === node.update &&
        body === node.body
        ? node
        : { ...node, init, cond, update, body };
    }
    case "arraySet": {
      const arr = expr(node.arr);
      const index = expr(node.index);
      const value = expr(node.value);
      return arr === node.arr && index === node.index && value === node.value
        ? node
        : { ...node, arr, index, value };
    }
    case "arraySetLength": {
      const arr = expr(node.arr);
      const length = expr(node.length);
      return arr === node.arr && length === node.length ? node : { ...node, arr, length };
    }
    case "arraySetUndefined": {
      const arr = expr(node.arr);
      const index = expr(node.index);
      return arr === node.arr && index === node.index ? node : { ...node, arr, index };
    }
    case "arrayDelete": {
      const arr = expr(node.arr);
      const index = expr(node.index);
      return arr === node.arr && index === node.index ? node : { ...node, arr, index };
    }
    case "bytesSet": {
      const arr = expr(node.arr);
      const index = expr(node.index);
      const value = expr(node.value);
      return arr === node.arr && index === node.index && value === node.value
        ? node
        : { ...node, arr, index, value };
    }
    case "forOf": {
      const iterable = expr(node.iterable);
      const body = mapOf(node.body, stmt);
      return iterable === node.iterable && body === node.body ? node : { ...node, iterable, body };
    }
    case "recordSet": {
      const obj = expr(node.obj);
      const value = expr(node.value);
      return obj === node.obj && value === node.value ? node : { ...node, obj, value };
    }
    case "recordKeySet": {
      const obj = expr(node.obj);
      const key = expr(node.key);
      const value = expr(node.value);
      return obj === node.obj && key === node.key && value === node.value
        ? node
        : { ...node, obj, key, value };
    }
    case "recordKeyDelete": {
      const obj = expr(node.obj);
      const key = expr(node.key);
      return obj === node.obj && key === node.key ? node : { ...node, obj, key };
    }
    case "break":
      return node;
    case "continue":
      return node;
    case "throw": {
      const value = expr(node.value);
      return value === node.value ? node : { ...node, value };
    }
    case "runtimeFence":
      return node;
    case "genBindBarrier":
      return node;
    case "rethrow":
      return node;
    case "tryCatch": {
      const tryBody = mapOf(node.tryBody, stmt);
      const catchBody = node.catchBody === null ? null : mapOf(node.catchBody, stmt);
      const finallyBody = node.finallyBody === null ? null : mapOf(node.finallyBody, stmt);
      return tryBody === node.tryBody &&
        catchBody === node.catchBody &&
        finallyBody === node.finallyBody
        ? node
        : { ...node, tryBody, catchBody, finallyBody };
    }
  }
  node satisfies never;
  throw new Error("unhandled IR node");
}

/** Preorder traversal. A false predicate stops the complete walk. */
function traversal(visitor: IrVisitor): IrVisitor {
  // Allocate the mutually recursive callbacks once per walk. Creating them
  // at every node makes native traversals allocate and retain their captures
  // in proportion to the tree size, even when the visitor only reads it.
  const expr = (node: IrExpr): boolean => visitor.expr(node) && everyExprChild(node, expr, stmt);
  const stmt = (node: IrStmt): boolean => visitor.stmt(node) && everyStmtChild(node, expr, stmt);
  return { expr, stmt };
}

export function everyExpr(node: IrExpr, visitor: IrVisitor): boolean {
  return traversal(visitor).expr(node);
}

export function everyStmt(node: IrStmt, visitor: IrVisitor): boolean {
  return traversal(visitor).stmt(node);
}

export function everyStmtList(body: IrStmt[], visitor: IrVisitor): boolean {
  return body.every(traversal(visitor).stmt);
}

/** Preorder rewrite: traverse the replacement's children, never mutate
 * the input tree, and leave type/loc/label metadata to the caller. */
function transformation(transform: IrTransform): IrTransform {
  const expr = (node: IrExpr): IrExpr => mapExprChildren(transform.expr(node), expr, stmt);
  const stmt = (node: IrStmt): IrStmt => mapStmtChildren(transform.stmt(node), expr, stmt);
  return { expr, stmt };
}

export function transformExpr(node: IrExpr, transform: IrTransform): IrExpr {
  return transformation(transform).expr(node);
}

export function transformStmt(node: IrStmt, transform: IrTransform): IrStmt {
  return transformation(transform).stmt(node);
}

export function transformStmtList(body: IrStmt[], transform: IrTransform): IrStmt[] {
  return mapOf(body, transformation(transform).stmt);
}
