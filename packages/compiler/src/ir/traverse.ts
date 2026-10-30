import type { IrExpr, IrModule, IrStmt, IrType, SrcLoc } from "./ir.js";

// Child lists are walked with these loops rather than with `every` or `map`
// and an arrow function: the arrow would be a new closure at every visited
// node, which the native compiler allocates and releases per node.

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

function mapOf<T>(children: readonly T[], map: (child: T) => T): T[] {
  const length = children.length;
  const result: T[] = [];
  for (let i = 0; i < length; i++) result.push(map(children[i]!));
  return result;
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
      return node.params.every(visit) && visit(node.ret);
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
 * tree. */
let recordLiteralRebuilt: ((from: IrExpr, to: IrExpr) => void) | null = null;

/** Installs (or with null removes) the record-literal rebuild observer. */
export function observeRecordLiteralRebuilds(
  observer: ((from: IrExpr, to: IrExpr) => void) | null,
): void {
  recordLiteralRebuilt = observer;
}

/** Copy a node with transformed immediate children; preserve all metadata. */
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
    case "call":
      return { ...node, args: mapOf(node.args, expr) };
    case "dynFrom":
      return { ...node, value: expr(node.value) };
    case "strLit":
      return node;
    case "libCall":
      return { ...node, args: mapOf(node.args, expr) };
    case "dynCheck": {
      const rebuilt: IrExpr = { ...node, value: expr(node.value) };
      if (recordLiteralRebuilt !== null) recordLiteralRebuilt(node, rebuilt);
      return rebuilt;
    }
    case "strEq":
      return { ...node, left: expr(node.left), right: expr(node.right) };
    case "fieldGet":
      return { ...node, obj: expr(node.obj) };
    case "ternary":
      return { ...node, cond: expr(node.cond), then: expr(node.then), else_: expr(node.else_) };
    case "closure":
      return node;
    case "boolLit":
      return node;
    case "numLit":
      return node;
    case "unitLit":
      return node;
    case "seqExpr":
      return { ...node, stmts: mapOf(node.stmts, stmt), result: expr(node.result) };
    case "dynCall": {
      const result: Extract<IrExpr, { kind: "dynCall" }> = { ...node, callee: expr(node.callee) };
      if (node.receiver !== undefined) result.receiver = expr(node.receiver);
      if (node.calleeNameValue !== undefined) result.calleeNameValue = expr(node.calleeNameValue);
      result.args = mapOf(node.args, expr);
      return result;
    }
    case "dynTest":
      return { ...node, value: expr(node.value) };
    case "dynScalarEq":
      return { ...node, left: expr(node.left), right: expr(node.right) };
    case "upcast":
      return { ...node, value: expr(node.value) };
    case "bin":
      return { ...node, left: expr(node.left), right: expr(node.right) };
    case "moduleNsRef":
      return node;
    case "unary":
      return { ...node, operand: expr(node.operand) };
    case "incDec":
      return node;
    case "fieldIncDec":
      return { ...node, obj: expr(node.obj) };
    case "assignExpr":
      return { ...node, value: expr(node.value) };
    case "toBool":
      return { ...node, operand: expr(node.operand) };
    case "logical":
      return { ...node, left: expr(node.left), right: expr(node.right) };
    case "strConcat":
      return { ...node, left: expr(node.left), right: expr(node.right) };
    case "strCmp":
      return { ...node, left: expr(node.left), right: expr(node.right) };
    case "toString":
      return { ...node, operand: expr(node.operand) };
    case "nullish":
      return { ...node, left: expr(node.left), right: expr(node.right) };
    case "orDefault":
      return { ...node, left: expr(node.left), right: expr(node.right) };
    case "optChain":
      return { ...node, receiver: expr(node.receiver), body: expr(node.body) };
    case "chainRecv":
      return node;
    case "strIntrinsic":
      return {
        ...node,
        receiver: expr(node.receiver),
        args: mapOf(node.args, expr),
      };
    case "regexLit":
      return node;
    case "templateStrings":
      return node;
    case "regexIntrinsic":
      return {
        ...node,
        receiver: expr(node.receiver),
        args: mapOf(node.args, expr),
      };
    case "arrayLit":
      return { ...node, elems: mapOf(node.elems, expr) };
    case "arrayNewLen":
      return { ...node, length: expr(node.length) };
    case "arrayGet":
      return { ...node, arr: expr(node.arr), index: expr(node.index) };
    case "arrayHas":
      return { ...node, arr: expr(node.arr), index: expr(node.index) };
    case "arrayState":
      return { ...node, arr: expr(node.arr), index: expr(node.index) };
    case "arrIntrinsic":
      return {
        ...node,
        receiver: expr(node.receiver),
        args: mapOf(node.args, expr),
      };
    case "bytesNew":
      return { ...node, source: node.source === null ? null : expr(node.source) };
    case "bytesIntrinsic":
      return {
        ...node,
        receiver: expr(node.receiver),
        args: mapOf(node.args, expr),
      };
    case "mapNew":
      return node.seed === undefined
        ? node
        : {
            ...node,
            seed: node.seed.map((child) => ({
              ...child,
              key: expr(child.key),
              value: expr(child.value),
            })),
          };
    case "mapIntrinsic":
      return {
        ...node,
        receiver: expr(node.receiver),
        args: mapOf(node.args, expr),
      };
    case "setNew":
      return node.seed === undefined ? node : { ...node, seed: expr(node.seed) };
    case "setIntrinsic":
      return {
        ...node,
        receiver: expr(node.receiver),
        args: mapOf(node.args, expr),
      };
    case "ffiCall":
      return { ...node, args: mapOf(node.args, expr) };
    case "callValue": {
      const callee = expr(node.callee);
      if (node.receiver === undefined) return { ...node, callee, args: mapOf(node.args, expr) };
      return {
        ...node,
        callee,
        receiver: expr(node.receiver),
        args: mapOf(node.args, expr),
      };
    }
    case "selfRef":
      return node;
    case "yieldExpr":
      return { ...node, value: node.value === null ? null : expr(node.value) };
    case "genResume":
      return { ...node, gen: expr(node.gen), arg: node.arg === null ? null : expr(node.arg) };
    case "awaitExpr":
      return { ...node, value: expr(node.value) };
    case "awaitUnionExpr":
      return { ...node, value: expr(node.value) };
    case "newPromise":
      return { ...node, executor: expr(node.executor) };
    case "promiseWithResolvers":
      return node;
    case "new":
      return { ...node, args: mapOf(node.args, expr) };
    case "classRef":
      return node;
    case "newValue":
      return { ...node, callee: expr(node.callee), args: mapOf(node.args, expr) };
    case "instanceOfValue":
      return { ...node, value: expr(node.value), classValue: expr(node.classValue) };
    case "promiseVoidWiden":
      return { ...node, value: expr(node.value) };
    case "downcast":
      return { ...node, value: expr(node.value) };
    case "instanceOf":
      return { ...node, value: expr(node.value) };
    case "virtualCall":
      return { ...node, args: mapOf(node.args, expr) };
    case "recordLit": {
      const rebuilt: IrExpr = {
        ...node,
        fields: node.fields.map((child) => ({ ...child!, value: expr(child.value) })),
      };
      if (recordLiteralRebuilt !== null) recordLiteralRebuilt(node, rebuilt);
      return rebuilt;
    }
    case "recordClone":
      return {
        ...node,
        source: expr(node.source),
        overrides: node.overrides.map((child) => ({ ...child!, value: expr(child.value) })),
      };
    case "recordGet":
      return { ...node, obj: expr(node.obj) };
    case "recordKeyGet":
      return { ...node, obj: expr(node.obj), key: expr(node.key) };
    case "dynInvoke": {
      const result: Extract<IrExpr, { kind: "dynInvoke" }> = { ...node, recv: expr(node.recv) };
      if (node.calleeNameValue !== undefined) result.calleeNameValue = expr(node.calleeNameValue);
      result.args = mapOf(node.args, expr);
      return result;
    }
    case "dynArrLit":
      return { ...node, elems: mapOf(node.elems, expr) };
    case "dynObjLit":
      return node.fields === undefined
        ? node
        : {
            ...node,
            fields: node.fields.map((child) => ({
              ...child,
              key: expr(child.key),
              value: expr(child.value),
            })),
          };
    case "dynKeyGet":
      return { ...node, key: expr(node.key), value: expr(node.value) };
    case "dynHasKey":
      return { ...node, value: expr(node.value) };
    case "dynDestrCheck":
      return { ...node, value: expr(node.value) };
    case "dynIterN":
      return { ...node, value: expr(node.value) };
    case "recordOvfKeys":
      return { ...node, obj: expr(node.obj) };
    case "recordOvfHas":
      return { ...node, obj: expr(node.obj), key: expr(node.key) };
    case "recordNullProto":
      return { ...node, obj: expr(node.obj) };
    case "recordHas":
      return { ...node, obj: expr(node.obj) };
    case "fieldAbsent":
      return node;
    case "unionWrap":
      return { ...node, value: expr(node.value) };
    case "unionRetype":
      return { ...node, value: expr(node.value) };
    case "unionFuncEq":
      return { ...node, union: expr(node.union), func: expr(node.func) };
    case "caughtTest":
      return { ...node, value: expr(node.value) };
    case "caughtNarrow":
      return { ...node, value: expr(node.value) };
    case "caughtCheck":
      return { ...node, value: expr(node.value) };
    case "caughtToDyn":
      return { ...node, value: expr(node.value) };
    case "unionNarrow":
      return { ...node, value: expr(node.value) };
    case "unionDisc":
      return { ...node, value: expr(node.value) };
    case "unionKeyGet":
      return { ...node, key: expr(node.key), value: expr(node.value) };
    case "unionIsTag":
      return { ...node, value: expr(node.value) };
    case "unionEq":
      return { ...node, left: expr(node.left), right: expr(node.right) };
    case "intrinsic":
      return { ...node, args: mapOf(node.args, expr) };
    case "jsonStringify":
      return { ...node, value: expr(node.value) };
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
    case "return":
      return { ...node, value: node.value === null ? null : expr(node.value) };
    case "if":
      return {
        ...node,
        cond: expr(node.cond),
        then: mapOf(node.then, stmt),
        else_: node.else_ === null ? null : mapOf(node.else_, stmt),
      };
    case "varDecl":
      return { ...node, init: node.init === null ? null : expr(node.init) };
    case "exprStmt":
      return { ...node, expr: expr(node.expr) };
    case "assign":
      return { ...node, value: expr(node.value) };
    case "block":
      return { ...node, body: mapOf(node.body, stmt) };
    case "fieldSet":
      return { ...node, obj: expr(node.obj), value: expr(node.value) };
    case "while":
      return { ...node, cond: expr(node.cond), body: mapOf(node.body, stmt) };
    case "doWhile":
      return { ...node, body: mapOf(node.body, stmt), cond: expr(node.cond) };
    case "switch":
      return {
        ...node,
        disc: expr(node.disc),
        cases: node.cases.map((child) => ({
          ...child,
          test: child.test === null ? null : expr(child.test),
          body: mapOf(child.body, stmt),
        })),
      };
    case "for":
      return {
        ...node,
        init: node.init === null ? null : stmt(node.init),
        cond: node.cond === null ? null : expr(node.cond),
        update: node.update === null ? null : stmt(node.update),
        body: mapOf(node.body, stmt),
      };
    case "arraySet":
      return { ...node, arr: expr(node.arr), index: expr(node.index), value: expr(node.value) };
    case "arraySetLength":
      return { ...node, arr: expr(node.arr), length: expr(node.length) };
    case "arraySetUndefined":
      return { ...node, arr: expr(node.arr), index: expr(node.index) };
    case "arrayDelete":
      return { ...node, arr: expr(node.arr), index: expr(node.index) };
    case "bytesSet":
      return { ...node, arr: expr(node.arr), index: expr(node.index), value: expr(node.value) };
    case "forOf":
      return {
        ...node,
        iterable: expr(node.iterable),
        body: mapOf(node.body, stmt),
      };
    case "recordSet":
      return { ...node, obj: expr(node.obj), value: expr(node.value) };
    case "recordKeySet":
      return { ...node, obj: expr(node.obj), key: expr(node.key), value: expr(node.value) };
    case "recordKeyDelete":
      return { ...node, obj: expr(node.obj), key: expr(node.key) };
    case "break":
      return node;
    case "continue":
      return node;
    case "throw":
      return { ...node, value: expr(node.value) };
    case "runtimeFence":
      return node;
    case "rethrow":
      return node;
    case "tryCatch":
      return {
        ...node,
        tryBody: mapOf(node.tryBody, stmt),
        catchBody: node.catchBody === null ? null : mapOf(node.catchBody, stmt),
        finallyBody: node.finallyBody === null ? null : mapOf(node.finallyBody, stmt),
      };
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
  return body.map(transformation(transform).stmt);
}
