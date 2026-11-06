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

/** Whether a rewrite may share what it did not change with its input tree.
 * The module finish turns it on; lowering keeps it off (see
 * withStructureSharing). */
let shareUnchanged = false;

/** Runs `body` with structure sharing on: a rewrite that leaves a node's
 * children unchanged then returns the node itself instead of a copy. The
 * module finish runs this way — its passes read the tree the lowering left,
 * so a subtree they keep belongs to the one function that holds it, and the
 * whole-program walks they run allocate nothing for it. Lowering keeps the
 * copy: a pass that shares a node of one function into another would let
 * that function's location reach this one, and settleSharedHelperLocations
 * rewrites locations in place. */
export function withStructureSharing<T>(body: () => T): T {
  const previous = shareUnchanged;
  shareUnchanged = true;
  try {
    return body();
  } finally {
    shareUnchanged = previous;
  }
}

/** Whether a rewrite hands its node back instead of a copy: sharing is on and
 * the child came back as it went in. Outside the shared windows the answer
 * is no, so every rewrite rebuilds the nodes it visits and its output never
 * holds a node of its input tree. kept2 to kept4 ask about that many
 * children. They are calls, and not comparisons in the caller, to keep the
 * caller's frame small; see mapExprChildren. */
function kept<A>(a: A, wasA: A): boolean {
  return shareUnchanged && a === wasA;
}

function kept2<A, B>(a: A, wasA: A, b: B, wasB: B): boolean {
  return shareUnchanged && a === wasA && b === wasB;
}

function kept3<A, B, C>(a: A, wasA: A, b: B, wasB: B, c: C, wasC: C): boolean {
  return shareUnchanged && a === wasA && b === wasB && c === wasC;
}

function kept4<A, B, C, D>(a: A, wasA: A, b: B, wasB: B, c: C, wasC: C, d: D, wasD: D): boolean {
  return shareUnchanged && a === wasA && b === wasB && c === wasC && d === wasD;
}

/** Maps a child list, returning `children` itself when no child changed. The
 * list a node already holds is then the answer, which lets a rewrite that
 * touches nothing leave the tree alone. */
function mapOf<T>(children: readonly T[], map: (child: T) => T): T[] {
  const length = children.length;
  if (!shareUnchanged) {
    const copy: T[] = [];
    for (let i = 0; i < length; i++) copy.push(map(children[i]!));
    return copy;
  }
  let result: T[] | null = null;
  for (let i = 0; i < length; i++) {
    const child = children[i]!;
    const mapped = map(child);
    if (mapped === child) continue;
    if (result === null) result = children.slice();
    result[i] = mapped;
  }
  return result ?? (children as unknown as T[]);
}

/** mapOf over entries that hold one expression each (record fields, override
 * tables). */
function mapValues<T extends { value: IrExpr }>(
  entries: readonly T[],
  expr: (expr: IrExpr) => IrExpr,
): T[] {
  const length = entries.length;
  if (!shareUnchanged) {
    const copy: T[] = [];
    for (let i = 0; i < length; i++) {
      const entry = entries[i]!;
      copy.push({ ...entry, value: expr(entry.value) });
    }
    return copy;
  }
  let result: T[] | null = null;
  for (let i = 0; i < length; i++) {
    const entry = entries[i]!;
    const value = expr(entry.value);
    if (value === entry.value) continue;
    if (result === null) result = entries.slice();
    result[i] = { ...entry, value };
  }
  return result ?? (entries as unknown as T[]);
}

/** mapOf over entries that hold a key and a value expression. */
function mapKeyValues<T extends { key: IrExpr; value: IrExpr }>(
  entries: readonly T[],
  expr: (expr: IrExpr) => IrExpr,
): T[] {
  const length = entries.length;
  if (!shareUnchanged) {
    const copy: T[] = [];
    for (let i = 0; i < length; i++) {
      const entry = entries[i]!;
      copy.push({ ...entry, key: expr(entry.key), value: expr(entry.value) });
    }
    return copy;
  }
  let result: T[] | null = null;
  for (let i = 0; i < length; i++) {
    const entry = entries[i]!;
    const key = expr(entry.key);
    const value = expr(entry.value);
    if (key === entry.key && value === entry.value) continue;
    if (result === null) result = entries.slice();
    result[i] = { ...entry, key, value };
  }
  return result ?? (entries as unknown as T[]);
}

type SwitchCase = Extract<IrStmt, { kind: "switch" }>["cases"][number];

/** mapOf over the cases of a switch: a test, when the case has one, and a
 * body. */
function mapCases(
  cases: readonly SwitchCase[],
  expr: (expr: IrExpr) => IrExpr,
  stmt: (stmt: IrStmt) => IrStmt,
): SwitchCase[] {
  const length = cases.length;
  if (!shareUnchanged) {
    const copy: SwitchCase[] = [];
    for (let i = 0; i < length; i++) {
      const entry = cases[i]!;
      copy.push({
        ...entry,
        test: entry.test === null ? null : expr(entry.test),
        body: mapOf(entry.body, stmt),
      });
    }
    return copy;
  }
  let result: SwitchCase[] | null = null;
  for (let i = 0; i < length; i++) {
    const entry = cases[i]!;
    const test = entry.test === null ? null : expr(entry.test);
    const body = mapOf(entry.body, stmt);
    if (test === entry.test && body === entry.body) continue;
    if (result === null) result = cases.slice();
    result[i] = { ...entry, test, body };
  }
  return result ?? (cases as SwitchCase[]);
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
 * tree. */
let recordLiteralRebuilt: ((from: IrExpr, to: IrExpr) => void) | null = null;

/** Installs (or with null removes) the record-literal rebuild observer. */
export function observeRecordLiteralRebuilds(
  observer: ((from: IrExpr, to: IrExpr) => void) | null,
): void {
  recordLiteralRebuilt = observer;
}

/** Copy a node with transformed immediate children, returning `node` itself
 * when no child changed. A whole-program rewrite that leaves a subtree alone
 * then shares it with the input tree instead of copying every node: the
 * later walks a module finish runs stay allocation-free, and a caller can
 * tell "not touched" by identity. Nodes are never mutated in place, so the
 * sharing is invisible. */
export function mapExprChildren(
  node: IrExpr,
  expr: (expr: IrExpr) => IrExpr,
  stmt: (stmt: IrStmt) => IrStmt,
): IrExpr {
  // Each case computes its children into these slots and asks kept() about
  // them, instead of naming them and comparing them itself. This function is
  // on the stack once per nesting level of every recursive rewrite, and in a
  // build that does not optimize, every local and every `===`, `&&` and
  // conditional result is a stack slot of its own. Spelled out per case they
  // took this frame from 265 slots to 680, and the sanitized emitter then
  // ran out of native stack emitting the compiler's own IR.
  let a: IrExpr;
  let b: IrExpr;
  let c: IrExpr;
  let orNull: IrExpr | null;
  let optional: IrExpr | undefined;
  let optional2: IrExpr | undefined;
  let list: IrExpr[];
  let block: IrStmt[];
  // The most common node kinds come first: the engine tests string cases
  // one after another, in source order.
  switch (node.kind) {
    case "varRef":
      return node;
    case "call": {
      list = mapOf(node.args, expr);
      if (kept(list, node.args)) return node;
      return { ...node, args: list };
    }
    case "dynFrom": {
      a = expr(node.value);
      if (kept(a, node.value)) return node;
      return { ...node, value: a };
    }
    case "strLit":
      return node;
    case "libCall": {
      list = mapOf(node.args, expr);
      if (kept(list, node.args)) return node;
      return { ...node, args: list };
    }
    case "dynCheck": {
      a = expr(node.value);
      if (kept(a, node.value)) return node;
      const rebuilt: IrExpr = { ...node, value: a };
      if (recordLiteralRebuilt !== null) recordLiteralRebuilt(node, rebuilt);
      return rebuilt;
    }
    case "strEq": {
      a = expr(node.left);
      b = expr(node.right);
      if (kept2(a, node.left, b, node.right)) return node;
      return { ...node, left: a, right: b };
    }
    case "fieldGet": {
      a = expr(node.obj);
      if (kept(a, node.obj)) return node;
      return { ...node, obj: a };
    }
    case "ternary": {
      a = expr(node.cond);
      b = expr(node.then);
      c = expr(node.else_);
      if (kept3(a, node.cond, b, node.then, c, node.else_)) return node;
      return { ...node, cond: a, then: b, else_: c };
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
      block = mapOf(node.stmts, stmt);
      a = expr(node.result);
      if (kept2(block, node.stmts, a, node.result)) return node;
      return { ...node, stmts: block, result: a };
    }
    case "dynCall": {
      a = expr(node.callee);
      optional = node.receiver === undefined ? undefined : expr(node.receiver);
      optional2 = node.calleeNameValue === undefined ? undefined : expr(node.calleeNameValue);
      list = mapOf(node.args, expr);
      if (
        kept4(
          a,
          node.callee,
          optional,
          node.receiver,
          optional2,
          node.calleeNameValue,
          list,
          node.args,
        )
      )
        return node;
      const result: Extract<IrExpr, { kind: "dynCall" }> = { ...node, callee: a };
      if (node.receiver !== undefined) result.receiver = optional!;
      if (node.calleeNameValue !== undefined) result.calleeNameValue = optional2!;
      result.args = list;
      return result;
    }
    case "dynTest": {
      a = expr(node.value);
      if (kept(a, node.value)) return node;
      return { ...node, value: a };
    }
    case "dynScalarEq": {
      a = expr(node.left);
      b = expr(node.right);
      if (kept2(a, node.left, b, node.right)) return node;
      return { ...node, left: a, right: b };
    }
    case "upcast": {
      a = expr(node.value);
      if (kept(a, node.value)) return node;
      return { ...node, value: a };
    }
    case "bin": {
      a = expr(node.left);
      b = expr(node.right);
      if (kept2(a, node.left, b, node.right)) return node;
      return { ...node, left: a, right: b };
    }
    case "moduleNsRef":
      return node;
    case "unary": {
      a = expr(node.operand);
      if (kept(a, node.operand)) return node;
      return { ...node, operand: a };
    }
    case "incDec":
      return node;
    case "fieldIncDec": {
      a = expr(node.obj);
      if (kept(a, node.obj)) return node;
      return { ...node, obj: a };
    }
    case "assignExpr": {
      a = expr(node.value);
      if (kept(a, node.value)) return node;
      return { ...node, value: a };
    }
    case "toBool": {
      a = expr(node.operand);
      if (kept(a, node.operand)) return node;
      return { ...node, operand: a };
    }
    case "logical": {
      a = expr(node.left);
      b = expr(node.right);
      if (kept2(a, node.left, b, node.right)) return node;
      return { ...node, left: a, right: b };
    }
    case "strConcat": {
      a = expr(node.left);
      b = expr(node.right);
      if (kept2(a, node.left, b, node.right)) return node;
      return { ...node, left: a, right: b };
    }
    case "strCmp": {
      a = expr(node.left);
      b = expr(node.right);
      if (kept2(a, node.left, b, node.right)) return node;
      return { ...node, left: a, right: b };
    }
    case "toString": {
      a = expr(node.operand);
      if (kept(a, node.operand)) return node;
      return { ...node, operand: a };
    }
    case "nullish": {
      a = expr(node.left);
      b = expr(node.right);
      if (kept2(a, node.left, b, node.right)) return node;
      return { ...node, left: a, right: b };
    }
    case "orDefault": {
      a = expr(node.left);
      b = expr(node.right);
      if (kept2(a, node.left, b, node.right)) return node;
      return { ...node, left: a, right: b };
    }
    case "optChain": {
      a = expr(node.receiver);
      b = expr(node.body);
      if (kept2(a, node.receiver, b, node.body)) return node;
      return { ...node, receiver: a, body: b };
    }
    case "chainRecv":
      return node;
    case "strIntrinsic": {
      a = expr(node.receiver);
      list = mapOf(node.args, expr);
      if (kept2(a, node.receiver, list, node.args)) return node;
      return { ...node, receiver: a, args: list };
    }
    case "regexLit":
      return node;
    case "templateStrings":
      return node;
    case "regexIntrinsic": {
      a = expr(node.receiver);
      list = mapOf(node.args, expr);
      if (kept2(a, node.receiver, list, node.args)) return node;
      return { ...node, receiver: a, args: list };
    }
    case "arrayLit": {
      list = mapOf(node.elems, expr);
      if (kept(list, node.elems)) return node;
      return { ...node, elems: list };
    }
    case "arrayNewLen": {
      a = expr(node.length);
      if (kept(a, node.length)) return node;
      return { ...node, length: a };
    }
    case "arrayGet": {
      a = expr(node.arr);
      b = expr(node.index);
      if (kept2(a, node.arr, b, node.index)) return node;
      return { ...node, arr: a, index: b };
    }
    case "arrayHas": {
      a = expr(node.arr);
      b = expr(node.index);
      if (kept2(a, node.arr, b, node.index)) return node;
      return { ...node, arr: a, index: b };
    }
    case "arrayState": {
      a = expr(node.arr);
      b = expr(node.index);
      if (kept2(a, node.arr, b, node.index)) return node;
      return { ...node, arr: a, index: b };
    }
    case "arrIntrinsic": {
      a = expr(node.receiver);
      list = mapOf(node.args, expr);
      if (kept2(a, node.receiver, list, node.args)) return node;
      return { ...node, receiver: a, args: list };
    }
    case "bytesNew": {
      orNull = node.source === null ? null : expr(node.source);
      if (kept(orNull, node.source)) return node;
      return { ...node, source: orNull };
    }
    case "bytesIntrinsic": {
      a = expr(node.receiver);
      list = mapOf(node.args, expr);
      if (kept2(a, node.receiver, list, node.args)) return node;
      return { ...node, receiver: a, args: list };
    }
    case "mapNew": {
      if (node.seed === undefined) return node;
      const seed = mapKeyValues(node.seed, expr);
      if (kept(seed, node.seed)) return node;
      return { ...node, seed };
    }
    case "mapIntrinsic": {
      a = expr(node.receiver);
      list = mapOf(node.args, expr);
      if (kept2(a, node.receiver, list, node.args)) return node;
      return { ...node, receiver: a, args: list };
    }
    case "setNew": {
      if (node.seed === undefined) return node;
      a = expr(node.seed);
      if (kept(a, node.seed)) return node;
      return { ...node, seed: a };
    }
    case "setIntrinsic": {
      a = expr(node.receiver);
      list = mapOf(node.args, expr);
      if (kept2(a, node.receiver, list, node.args)) return node;
      return { ...node, receiver: a, args: list };
    }
    case "ffiCall": {
      list = mapOf(node.args, expr);
      if (kept(list, node.args)) return node;
      return { ...node, args: list };
    }
    case "callValue": {
      a = expr(node.callee);
      if (node.receiver === undefined) {
        list = mapOf(node.args, expr);
        if (kept2(a, node.callee, list, node.args)) return node;
        return { ...node, callee: a, args: list };
      }
      b = expr(node.receiver);
      list = mapOf(node.args, expr);
      if (kept3(a, node.callee, b, node.receiver, list, node.args)) return node;
      return { ...node, callee: a, receiver: b, args: list };
    }
    case "selfRef":
      return node;
    case "yieldExpr": {
      orNull = node.value === null ? null : expr(node.value);
      if (kept(orNull, node.value)) return node;
      return { ...node, value: orNull };
    }
    case "genResume": {
      a = expr(node.gen);
      orNull = node.arg === null ? null : expr(node.arg);
      if (kept2(a, node.gen, orNull, node.arg)) return node;
      return { ...node, gen: a, arg: orNull };
    }
    case "awaitExpr": {
      a = expr(node.value);
      if (kept(a, node.value)) return node;
      return { ...node, value: a };
    }
    case "awaitUnionExpr": {
      a = expr(node.value);
      if (kept(a, node.value)) return node;
      return { ...node, value: a };
    }
    case "newPromise": {
      a = expr(node.executor);
      if (kept(a, node.executor)) return node;
      return { ...node, executor: a };
    }
    case "promiseWithResolvers":
      return node;
    case "new": {
      list = mapOf(node.args, expr);
      if (kept(list, node.args)) return node;
      return { ...node, args: list };
    }
    case "classRef":
      return node;
    case "newValue": {
      a = expr(node.callee);
      list = mapOf(node.args, expr);
      if (kept2(a, node.callee, list, node.args)) return node;
      return { ...node, callee: a, args: list };
    }
    case "instanceOfValue": {
      a = expr(node.value);
      b = expr(node.classValue);
      if (kept2(a, node.value, b, node.classValue)) return node;
      return { ...node, value: a, classValue: b };
    }
    case "promiseVoidWiden": {
      a = expr(node.value);
      if (kept(a, node.value)) return node;
      return { ...node, value: a };
    }
    case "downcast": {
      a = expr(node.value);
      if (kept(a, node.value)) return node;
      return { ...node, value: a };
    }
    case "instanceOf": {
      a = expr(node.value);
      if (kept(a, node.value)) return node;
      return { ...node, value: a };
    }
    case "virtualCall": {
      list = mapOf(node.args, expr);
      if (kept(list, node.args)) return node;
      return { ...node, args: list };
    }
    case "recordLit": {
      const fields = mapValues(node.fields, expr);
      if (kept(fields, node.fields)) return node;
      const rebuilt: IrExpr = { ...node, fields };
      if (recordLiteralRebuilt !== null) recordLiteralRebuilt(node, rebuilt);
      return rebuilt;
    }
    case "recordClone": {
      a = expr(node.source);
      const overrides = mapValues(node.overrides, expr);
      if (kept2(a, node.source, overrides, node.overrides)) return node;
      return { ...node, source: a, overrides };
    }
    case "recordGet": {
      a = expr(node.obj);
      if (kept(a, node.obj)) return node;
      return { ...node, obj: a };
    }
    case "recordKeyGet": {
      a = expr(node.obj);
      b = expr(node.key);
      if (kept2(a, node.obj, b, node.key)) return node;
      return { ...node, obj: a, key: b };
    }
    case "dynInvoke": {
      a = expr(node.recv);
      optional = node.calleeNameValue === undefined ? undefined : expr(node.calleeNameValue);
      list = mapOf(node.args, expr);
      if (kept3(a, node.recv, optional, node.calleeNameValue, list, node.args)) return node;
      const result: Extract<IrExpr, { kind: "dynInvoke" }> = { ...node, recv: a };
      if (node.calleeNameValue !== undefined) result.calleeNameValue = optional!;
      result.args = list;
      return result;
    }
    case "dynArrLit": {
      list = mapOf(node.elems, expr);
      if (kept(list, node.elems)) return node;
      return { ...node, elems: list };
    }
    case "dynObjLit": {
      if (node.fields === undefined) return node;
      const fields = mapKeyValues(node.fields, expr);
      if (kept(fields, node.fields)) return node;
      return { ...node, fields };
    }
    case "dynKeyGet": {
      a = expr(node.key);
      b = expr(node.value);
      if (kept2(a, node.key, b, node.value)) return node;
      return { ...node, key: a, value: b };
    }
    case "dynHasKey": {
      a = expr(node.value);
      if (kept(a, node.value)) return node;
      return { ...node, value: a };
    }
    case "dynDestrCheck": {
      a = expr(node.value);
      if (kept(a, node.value)) return node;
      return { ...node, value: a };
    }
    case "dynIterN": {
      a = expr(node.value);
      if (kept(a, node.value)) return node;
      return { ...node, value: a };
    }
    case "recordOvfKeys": {
      a = expr(node.obj);
      if (kept(a, node.obj)) return node;
      return { ...node, obj: a };
    }
    case "recordOvfHas": {
      a = expr(node.obj);
      b = expr(node.key);
      if (kept2(a, node.obj, b, node.key)) return node;
      return { ...node, obj: a, key: b };
    }
    case "recordNullProto": {
      a = expr(node.obj);
      if (kept(a, node.obj)) return node;
      return { ...node, obj: a };
    }
    case "recordHas": {
      a = expr(node.obj);
      if (kept(a, node.obj)) return node;
      return { ...node, obj: a };
    }
    case "fieldAbsent":
      return node;
    case "unionWrap": {
      a = expr(node.value);
      if (kept(a, node.value)) return node;
      return { ...node, value: a };
    }
    case "unionRetype": {
      a = expr(node.value);
      if (kept(a, node.value)) return node;
      return { ...node, value: a };
    }
    case "unionFuncEq": {
      a = expr(node.union);
      b = expr(node.func);
      if (kept2(a, node.union, b, node.func)) return node;
      return { ...node, union: a, func: b };
    }
    case "caughtTest": {
      a = expr(node.value);
      if (kept(a, node.value)) return node;
      return { ...node, value: a };
    }
    case "caughtNarrow": {
      a = expr(node.value);
      if (kept(a, node.value)) return node;
      return { ...node, value: a };
    }
    case "caughtCheck": {
      a = expr(node.value);
      if (kept(a, node.value)) return node;
      return { ...node, value: a };
    }
    case "caughtToDyn": {
      a = expr(node.value);
      if (kept(a, node.value)) return node;
      return { ...node, value: a };
    }
    case "unionNarrow": {
      a = expr(node.value);
      if (kept(a, node.value)) return node;
      return { ...node, value: a };
    }
    case "unionDisc": {
      a = expr(node.value);
      if (kept(a, node.value)) return node;
      return { ...node, value: a };
    }
    case "unionKeyGet": {
      a = expr(node.key);
      b = expr(node.value);
      if (kept2(a, node.key, b, node.value)) return node;
      return { ...node, key: a, value: b };
    }
    case "unionIsTag": {
      a = expr(node.value);
      if (kept(a, node.value)) return node;
      return { ...node, value: a };
    }
    case "unionEq": {
      a = expr(node.left);
      b = expr(node.right);
      if (kept2(a, node.left, b, node.right)) return node;
      return { ...node, left: a, right: b };
    }
    case "intrinsic": {
      list = mapOf(node.args, expr);
      if (kept(list, node.args)) return node;
      return { ...node, args: list };
    }
    case "jsonStringify": {
      a = expr(node.value);
      if (kept(a, node.value)) return node;
      return { ...node, value: a };
    }
  }
  node satisfies never;
  throw new Error("unhandled IR node");
}

/** Copy a node with transformed immediate children, returning `node` itself
 * when no child changed; see mapExprChildren. */
export function mapStmtChildren(
  node: IrStmt,
  expr: (expr: IrExpr) => IrExpr,
  stmt: (stmt: IrStmt) => IrStmt,
): IrStmt {
  // One set of slots for every case; see mapExprChildren.
  let a: IrExpr;
  let b: IrExpr;
  let c: IrExpr;
  let orNull: IrExpr | null;
  let block: IrStmt[];
  let block2: IrStmt[] | null;
  let block3: IrStmt[] | null;
  let first: IrStmt | null;
  let last: IrStmt | null;
  // The most common node kinds come first: the engine tests string cases
  // one after another, in source order.
  switch (node.kind) {
    case "return": {
      orNull = node.value === null ? null : expr(node.value);
      if (kept(orNull, node.value)) return node;
      return { ...node, value: orNull };
    }
    case "if": {
      a = expr(node.cond);
      block = mapOf(node.then, stmt);
      block2 = node.else_ === null ? null : mapOf(node.else_, stmt);
      if (kept3(a, node.cond, block, node.then, block2, node.else_)) return node;
      return { ...node, cond: a, then: block, else_: block2 };
    }
    case "varDecl": {
      orNull = node.init === null ? null : expr(node.init);
      if (kept(orNull, node.init)) return node;
      return { ...node, init: orNull };
    }
    case "exprStmt": {
      a = expr(node.expr);
      if (kept(a, node.expr)) return node;
      return { ...node, expr: a };
    }
    case "assign": {
      a = expr(node.value);
      if (kept(a, node.value)) return node;
      return { ...node, value: a };
    }
    case "block": {
      block = mapOf(node.body, stmt);
      if (kept(block, node.body)) return node;
      return { ...node, body: block };
    }
    case "fieldSet": {
      a = expr(node.obj);
      b = expr(node.value);
      if (kept2(a, node.obj, b, node.value)) return node;
      return { ...node, obj: a, value: b };
    }
    case "while": {
      a = expr(node.cond);
      block = mapOf(node.body, stmt);
      if (kept2(a, node.cond, block, node.body)) return node;
      return { ...node, cond: a, body: block };
    }
    case "doWhile": {
      block = mapOf(node.body, stmt);
      a = expr(node.cond);
      if (kept2(block, node.body, a, node.cond)) return node;
      return { ...node, body: block, cond: a };
    }
    case "switch": {
      a = expr(node.disc);
      const cases = mapCases(node.cases, expr, stmt);
      if (kept2(a, node.disc, cases, node.cases)) return node;
      return { ...node, disc: a, cases };
    }
    case "for": {
      first = node.init === null ? null : stmt(node.init);
      orNull = node.cond === null ? null : expr(node.cond);
      last = node.update === null ? null : stmt(node.update);
      block = mapOf(node.body, stmt);
      if (kept4(first, node.init, orNull, node.cond, last, node.update, block, node.body))
        return node;
      return { ...node, init: first, cond: orNull, update: last, body: block };
    }
    case "arraySet": {
      a = expr(node.arr);
      b = expr(node.index);
      c = expr(node.value);
      if (kept3(a, node.arr, b, node.index, c, node.value)) return node;
      return { ...node, arr: a, index: b, value: c };
    }
    case "arraySetLength": {
      a = expr(node.arr);
      b = expr(node.length);
      if (kept2(a, node.arr, b, node.length)) return node;
      return { ...node, arr: a, length: b };
    }
    case "arraySetUndefined": {
      a = expr(node.arr);
      b = expr(node.index);
      if (kept2(a, node.arr, b, node.index)) return node;
      return { ...node, arr: a, index: b };
    }
    case "arrayDelete": {
      a = expr(node.arr);
      b = expr(node.index);
      if (kept2(a, node.arr, b, node.index)) return node;
      return { ...node, arr: a, index: b };
    }
    case "bytesSet": {
      a = expr(node.arr);
      b = expr(node.index);
      c = expr(node.value);
      if (kept3(a, node.arr, b, node.index, c, node.value)) return node;
      return { ...node, arr: a, index: b, value: c };
    }
    case "forOf": {
      a = expr(node.iterable);
      block = mapOf(node.body, stmt);
      if (kept2(a, node.iterable, block, node.body)) return node;
      return { ...node, iterable: a, body: block };
    }
    case "recordSet": {
      a = expr(node.obj);
      b = expr(node.value);
      if (kept2(a, node.obj, b, node.value)) return node;
      return { ...node, obj: a, value: b };
    }
    case "recordKeySet": {
      a = expr(node.obj);
      b = expr(node.key);
      c = expr(node.value);
      if (kept3(a, node.obj, b, node.key, c, node.value)) return node;
      return { ...node, obj: a, key: b, value: c };
    }
    case "recordKeyDelete": {
      a = expr(node.obj);
      b = expr(node.key);
      if (kept2(a, node.obj, b, node.key)) return node;
      return { ...node, obj: a, key: b };
    }
    case "break":
      return node;
    case "continue":
      return node;
    case "throw": {
      a = expr(node.value);
      if (kept(a, node.value)) return node;
      return { ...node, value: a };
    }
    case "runtimeFence":
      return node;
    case "genBindBarrier":
      return node;
    case "rethrow":
      return node;
    case "tryCatch": {
      block = mapOf(node.tryBody, stmt);
      block2 = node.catchBody === null ? null : mapOf(node.catchBody, stmt);
      block3 = node.finallyBody === null ? null : mapOf(node.finallyBody, stmt);
      if (kept3(block, node.tryBody, block2, node.catchBody, block3, node.finallyBody)) return node;
      return { ...node, tryBody: block, catchBody: block2, finallyBody: block3 };
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
  // A rewrite that touches nothing returns the list itself, so the caller's
  // body (and any summary validated against its identity) stays as it was.
  return mapOf(body, transformation(transform).stmt);
}
