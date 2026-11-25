/* Own-key questions about a record held under its type, answered without a
 * key list or a checked view.
 *
 * A program that must know whether a value is exactly the plain record its
 * type names asks at source level: is the prototype Object.prototype, and
 * are the own names the declared ones in the declared order. Each question
 * went through a key array or a checked view of the record. For a closed
 * declared-field record the answers are in the type: a record that kept no
 * source and links to none has Object.prototype and lists its present
 * fields in its shape's order. This module answers three source forms from
 * that, and keeps the lowering they had for every other record:
 *
 *  - `Object.getPrototypeOf(r) === Object.prototype` (and `!==`, either
 *    operand order): true when the record reflects statically
 *    (record.reflectsStatic), the checked view's answer otherwise;
 *  - `const keys = Object.keys(r)`, `Object.getOwnPropertyNames(r)` or
 *    `Reflect.ownKeys(r)` whose every use is `keys.length` or `keys[i]`
 *    compared with a string literal by `===` or `!==`: the statements that
 *    follow the declaration in its block are lowered twice, under one test
 *    of the record. For a record that reflects statically no array is
 *    made: the declaration computes the key count and the position of each
 *    compared name once (a snapshot, as the array was), and the uses read
 *    those numbers. For any other record the statements are what they were
 *    before, with the array;
 *  - `Object.keys(r).length` and the two other lists' `.length`.
 *
 * `r` is a local or a parameter whose lowered type is a record that
 * recordMayKeepSource names: closed, with declared fields, no accessor
 * slot and no index signature. Anything else keeps its lowering.
 *
 * A record that kept a source, a linked copy and a record with a live
 * checked view of its own take the lowering the question had before: the
 * answers are the same as before in every case, only how they are computed
 * changes.
 *
 * The array is given up on proof, not on a prediction. The statements for a
 * record that reflects statically are lowered with the array declared as
 * before, and the declaration is dropped only when nothing in them reads
 * it: a use that reaches a lowering path these hooks do not see reads the
 * array, which is then built as before. */
import * as ts from "../ts7/adapter.js";
import {
  BOOL,
  F64,
  shapeHasAccessorSlots,
  shapeKeyOrders,
  type IrExpr,
  type IrFunction,
  type IrRecordShape,
  type IrStmt,
  type IrType,
  type SrcLoc,
} from "../../ir/ir.js";
import { numLit, varRef } from "../../ir/build.js";
import { locOf } from "../program.js";
import type { Lowerer } from "./lowerer.js";
import { declareContextLocal, type FnCtx } from "./function-context.js";
import { identifiersNamed } from "./identifier-uses.js";
import { perKeyOrder } from "./key-order-witness.js";
import { recordLinksInto, registerLinkedHelper } from "./record-links.js";
import { recordMayKeepSource } from "./record-sources.js";
import { keyedHelperName } from "./stable-names.js";

/** Which list a call answers: the enumerable names, every string name, or
 * every own key. */
type ListKind = "keys" | "names" | "ownKeys";

type RecordType = IrType & { kind: "record" };

/** The statements after a list's declaration are lowered twice, so a block
 * with more syntax nodes than this after the declaration keeps its array. */
const MAX_VERSIONED_NODES = 600;

/** A list declared among the statements of another list's is lowered four
 * times; a third level keeps its array. */
const MAX_VERSIONED_DEPTH = 2;

/** A key list that exists only as numbers: its length and the position of
 * each name the program compares an element with (-1 for a name the record
 * does not list). */
interface KeyList {
  /** The function that declared the numbers; a use lowered into any other
   * function reads the array. */
  ctx: FnCtx;
  count: string;
  positions: Map<string, string>;
}

/** What this module keeps while it lowers. The Lowerer holds one as its
 * `ownKeyLists` field: a table keyed by the Lowerer would hand the Lowerer
 * over as an untyped key, and the compiler's own build would compile it
 * for untyped code as well. */
export class OwnKeyListState {
  /** The lists whose statements are being lowered, by the list's symbol. */
  readonly lists = new Map<ts.Symbol, KeyList>();
  /** Syntax being lowered as it was before this module. */
  readonly plain = new Set<ts.Node>();
  /** How many lists' statements are being lowered twice. */
  depth = 0;
}

/** Lowers `node` as it was lowered before this module. */
function lowerPlain(lowerer: Lowerer, node: ts.Expression): IrExpr {
  const state = lowerer.ownKeyLists;
  state.plain.add(node);
  try {
    return lowerer.lowerExpr(node);
  } finally {
    state.plain.delete(node);
  }
}

/** `Object.keys(r)`, `Object.getOwnPropertyNames(r)` or `Reflect.ownKeys(r)`
 * with `r` a name: the list's kind and `r`. */
function listCall(
  lowerer: Lowerer,
  node: ts.Node,
): { kind: ListKind; record: ts.Identifier } | null {
  if (!ts.isCallExpression(node) || node.questionDotToken) return null;
  const access = node.expression;
  if (!ts.isPropertyAccessExpression(access) || access.questionDotToken) return null;
  const name = access.name.text;
  if (name !== "keys" && name !== "getOwnPropertyNames" && name !== "ownKeys") return null;
  if (node.arguments.nodes.length !== 1) return null;
  const record = node.arguments.nodes[0]!;
  if (!ts.isIdentifier(record)) return null;
  if (name === "ownKeys")
    return lowerer.stdlibGlobalMember(access, "Reflect") === "ownKeys"
      ? { kind: "ownKeys", record }
      : null;
  if (lowerer.stdlibGlobalMember(access, "Object") !== name) return null;
  return { kind: name === "keys" ? "keys" : "names", record };
}

/** The record `name` reads, when it is a local of a closed declared-field
 * record type whose reflection the type describes. */
function staticRecord(
  lowerer: Lowerer,
  name: ts.Identifier,
): { ref: IrExpr & { kind: "varRef" }; type: RecordType; shape: IrRecordShape } | null {
  if (lowerer.mapTypeOf(lowerer.typeOf(name))?.kind !== "record") return null;
  const ref = lowerer.lowerExpr(name);
  if (ref.kind !== "varRef" || ref.type.kind !== "record") return null;
  const type = ref.type;
  const shape = lowerer.shapes.get(type.shapeId);
  if (
    !shape ||
    shape.tuple ||
    shape.indexValue !== undefined ||
    shapeHasAccessorSlots(shape) ||
    !recordMayKeepSource(lowerer, type)
  )
    return null;
  return { ref: ref as IrExpr & { kind: "varRef" }, type, shape };
}

function call(callee: string, record: IrExpr, type: IrType, loc: SrcLoc): IrExpr {
  return { kind: "call", callee, args: [record], type, loc };
}

/** A helper over record type `type`, interned by `key`. `build` answers its
 * body from the shape as it is when it runs: once now, and again when the
 * key orders are settled. */
function shapeHelper(
  lowerer: Lowerer,
  prefix: string,
  key: string,
  type: RecordType,
  returnType: IrType,
  loc: SrcLoc,
  build: (shape: IrRecordShape, r: IrExpr, fn: IrFunction) => IrStmt[],
): { name: string; fn: IrFunction | null } {
  const known = lowerer.arrHofHelpers.get(key);
  if (known !== undefined) return { name: known, fn: null };
  const name = keyedHelperName(lowerer, prefix, key);
  lowerer.arrHofHelpers.set(key, name);
  const r = varRef("r.0", type, loc);
  const fn: IrFunction = {
    name,
    params: [{ localId: "r.0", name: "r", type }],
    returnType,
    locals: [{ id: "r.0", name: "r", type, mutable: false }],
    body: [],
    loc,
  };
  const finalize = (): void => {
    const shape = lowerer.shapes.get(type.shapeId);
    if (shape === undefined) return;
    fn.locals.length = 1;
    fn.body = build(shape, r, fn);
  };
  finalize();
  lowerer.shapeOrderHelperFinalizers.push(finalize);
  lowerer.liftedFns.push(fn);
  return { name, fn };
}

/** `present ? 1 : 0` summed over `names`, as one number expression. */
function presentCount(
  lowerer: Lowerer,
  r: IrExpr,
  shapeId: string,
  names: readonly string[],
  loc: SrcLoc,
): IrExpr {
  let always = 0;
  let sum: IrExpr | null = null;
  for (const name of names) {
    const present = lowerer.recordFieldPresent(r, shapeId, name, loc);
    if (present.kind !== "recordHas") {
      always++;
      continue;
    }
    const one: IrExpr = {
      kind: "ternary",
      cond: present,
      then: numLit(1, loc),
      else_: numLit(0, loc),
      type: F64,
      loc,
    };
    sum = sum === null ? one : { kind: "bin", op: "+", left: sum, right: one, type: F64, loc };
  }
  if (sum === null) return numLit(always, loc);
  if (always === 0) return sum;
  return { kind: "bin", op: "+", left: numLit(always, loc), right: sum, type: F64, loc };
}

/** `%obj.keyCount(r)`: how many keys the shape's table lists for `r`. */
function keyCountCall(lowerer: Lowerer, record: IrExpr, type: RecordType, loc: SrcLoc): IrExpr {
  lowerer.keyOrder.observe(type);
  const helper = shapeHelper(
    lowerer,
    "%obj.keyCount",
    `obj.keyCount:${type.shapeId}`,
    type,
    F64,
    loc,
    (shape, r) => [
      {
        kind: "return",
        value: presentCount(lowerer, r, type.shapeId, shapeKeyOrders(shape)[0]!, loc),
        loc,
      },
    ],
  );
  return call(helper.name, record, F64, loc);
}

/** `%obj.keyPosition(r)`: the position of `name` in the keys the shape's
 * table lists for `r`, or -1 when `r` does not list it. */
function keyPositionCall(
  lowerer: Lowerer,
  record: IrExpr,
  type: RecordType,
  name: string,
  loc: SrcLoc,
): IrExpr {
  lowerer.keyOrder.observe(type);
  const helper = shapeHelper(
    lowerer,
    "%obj.keyPosition",
    `obj.keyPosition:${type.shapeId}:${name}`,
    type,
    F64,
    loc,
    (shape, r, fn) => {
      fn.locals.push({ id: "at.0", name: "at", type: F64, mutable: true });
      const walks = shapeKeyOrders(shape).map((order): IrStmt[] => {
        const index = order.indexOf(name);
        if (index < 0) return [];
        const before = presentCount(lowerer, r, type.shapeId, order.slice(0, index), loc);
        const present = lowerer.recordFieldPresent(r, type.shapeId, name, loc);
        const value: IrExpr =
          present.kind === "recordHas"
            ? {
                kind: "ternary",
                cond: present,
                then: before,
                else_: numLit(-1, loc),
                type: F64,
                loc,
              }
            : before;
        return [{ kind: "assign", localId: "at.0", value, loc }];
      });
      return [
        { kind: "varDecl", localId: "at.0", init: numLit(-1, loc), loc },
        ...perKeyOrder(shape, r, walks, loc),
        { kind: "return", value: varRef("at.0", F64, loc), loc },
      ];
    },
  );
  return call(helper.name, record, F64, loc);
}

/** Whether `record` answers reflection from its shape's table and has
 * Object.prototype: it kept no source, is no linked copy, and no live
 * checked view of it has a member or a prototype of its own. The one fact
 * every answer of this module rests on. */
function reflectsStatic(lowerer: Lowerer, record: IrExpr, type: RecordType, loc: SrcLoc): IrExpr {
  // Whether a record of the type can be a linked copy is the program's
  // fact, known once every conversion into the type is: until then the
  // runtime looks, and a type nothing is narrowed into skips that probe.
  const linked: IrExpr & { kind: "boolLit" } = { kind: "boolLit", value: true, type: BOOL, loc };
  const helper = shapeHelper(
    lowerer,
    "%obj.reflectsStatic",
    `obj.reflectsStatic:${type.shapeId}`,
    type,
    BOOL,
    loc,
    (_shape, r) => [
      {
        kind: "return",
        value: { kind: "libCall", fn: "record.reflectsStatic", args: [r, linked], type: BOOL, loc },
        loc,
      },
    ],
  );
  if (helper.fn !== null) {
    registerLinkedHelper(lowerer, helper.fn, type.shapeId, "custom");
    lowerer.linkedHelperFinalizers.push(() => {
      linked.value = recordLinksInto(lowerer, type.shapeId).length > 0;
    });
  }
  return call(helper.name, record, BOOL, loc);
}

function isStrictEquality(kind: ts.SyntaxKind): boolean {
  return (
    kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
    kind === ts.SyntaxKind.ExclamationEqualsEqualsToken
  );
}

function enclosingFunction(node: ts.Node): ts.Node | undefined {
  let current: ts.Node | undefined = node.parent;
  while (current && !ts.isFunctionLike(current)) current = current.parent;
  return current;
}

/** Whether `rest` can be lowered twice: it holds no function and no class
 * (each would be lifted twice), and is small. */
function lowersTwice(rest: readonly ts.Statement[]): boolean {
  let nodes = 0;
  let twice = true;
  for (const stmt of rest) {
    ts.walkPreorder(stmt, (node) => {
      if (
        ++nodes > MAX_VERSIONED_NODES ||
        ts.isFunctionLike(node) ||
        ts.isClassDeclaration(node) ||
        ts.isClassExpression(node)
      ) {
        twice = false;
        return "stop";
      }
      return undefined;
    });
    if (!twice) return false;
  }
  return true;
}

/** The names the uses of list `symbol` compare its elements with, or null
 * when a use is anything but `list.length` or `list[i] === "name"` inside
 * `rest`, the statements that follow the declaration in its block. */
function comparedNames(
  lowerer: Lowerer,
  decl: ts.VariableDeclaration,
  symbol: ts.Symbol,
  rest: ReadonlySet<ts.Node>,
): Set<string> | null {
  if (!ts.isIdentifier(decl.name)) return null;
  const owner = enclosingFunction(decl);
  const names = new Set<string>();
  for (const use of identifiersNamed(lowerer, ts.getSourceFileOfNode(decl), decl.name.text)) {
    if (use === decl.name) continue;
    if (lowerer.checker.getSymbolAtLocation(use) !== symbol) continue;
    if (enclosingFunction(use) !== owner) return null;
    let inside: ts.Node | undefined = use;
    while (inside !== undefined && inside !== owner && !rest.has(inside)) inside = inside.parent;
    if (inside === undefined || inside === owner) return null;
    const parent = use.parent;
    if (
      ts.isPropertyAccessExpression(parent) &&
      parent.expression === use &&
      parent.name.text === "length" &&
      !parent.questionDotToken
    ) {
      // A read: not the target of an assignment or an update.
      const holder = parent.parent;
      if (
        ts.isBinaryExpression(holder) &&
        holder.left === parent &&
        ts.isAssignmentOperator(holder.operatorToken.kind)
      )
        return null;
      if (ts.isPrefixUnaryExpression(holder) || ts.isPostfixUnaryExpression(holder)) {
        const op = holder.operator;
        if (op === ts.SyntaxKind.PlusPlusToken || op === ts.SyntaxKind.MinusMinusToken) return null;
      }
      continue;
    }
    if (
      !ts.isElementAccessExpression(parent) ||
      parent.expression !== use ||
      parent.questionDotToken
    )
      return null;
    const compare = parent.parent;
    if (!ts.isBinaryExpression(compare) || !isStrictEquality(compare.operatorToken.kind))
      return null;
    const other = compare.left === parent ? compare.right : compare.left;
    if (!ts.isStringLiteralLikeNode(other)) return null;
    if (lowerer.mapTypeOf(lowerer.typeOf(parent.argumentExpression))?.kind !== "f64") return null;
    names.add(other.text);
  }
  return names;
}

/** `stmts[index]` as `const keys = <list call>(r)` whose uses, all in the
 * statements after it, only count the list and compare its elements with
 * names: the declaration and those statements, as one statement that tests
 * the record once and runs them without the array or as they were before.
 * Null for every other statement, which the caller lowers itself. */
export function lowerOwnKeyListScope(
  lowerer: Lowerer,
  stmts: readonly ts.Statement[],
  index: number,
): IrStmt[] | null {
  const stmt = stmts[index]!;
  if (!ts.isVariableStatement(stmt) || index + 1 >= stmts.length) return null;
  const declared = stmt.declarationList;
  if ((declared.flags & ts.NodeFlags.Const) === 0 || declared.declarations.nodes.length !== 1)
    return null;
  const decl = declared.declarations.nodes[0]!;
  if (decl.initializer === undefined || !ts.isIdentifier(decl.name)) return null;
  const list = listCall(lowerer, decl.initializer);
  if (list === null || enclosingFunction(decl) === undefined) return null;
  const state = lowerer.ownKeyLists;
  // Inside a probe the diagnostics go elsewhere, and a function with a
  // constant some closure captured before its declaration initializes that
  // constant's box once: both keep the array.
  if (
    state.plain.has(stmt) ||
    state.depth >= MAX_VERSIONED_DEPTH ||
    lowerer.diagSink !== null ||
    lowerer.ctx.tdzPredeclared.size > 0
  )
    return null;
  const symbol = lowerer.checker.getSymbolAtLocation(decl.name);
  if (symbol === undefined) return null;
  const record = staticRecord(lowerer, list.record);
  if (record === null) return null;
  const rest = stmts.slice(index + 1);
  if (!lowersTwice(rest)) return null;
  const compared = comparedNames(lowerer, decl, symbol, new Set<ts.Node>(rest));
  if (compared === null) return null;
  const loc = locOf(decl);
  const ctx = lowerer.ctx;
  const diags = lowerer.diags.length;
  const fences = lowerer.runtimeFences.length;
  const reported = (): boolean =>
    lowerer.diags.length !== diags || lowerer.runtimeFences.length !== fences;
  // The statements as they were before, with the array: what a record the
  // table does not describe runs, and what the block is when it reports
  // anything (a second lowering would report it again).
  const before = lowerSeparately(lowerer, state, [stmt, ...rest], stmt, false);
  if (reported()) return before;
  // The same statements for a record that reflects statically. The array
  // is declared as before, so a use these hooks do not answer reads it.
  const locals = ctx.locals.length;
  let withArray: IrStmt[];
  let numbers: IrStmt[];
  let body: IrStmt[];
  let arrayLocals: number;
  lowerer.scopes.push(new Map());
  try {
    withArray = lowerSeparately(lowerer, state, [stmt], stmt, true);
    arrayLocals = ctx.locals.length;
    const declare = (name: string): string =>
      declareContextLocal(ctx, name, F64, false, undefined, undefined).id;
    const keyList: KeyList = { ctx, count: declare("%keyCount"), positions: new Map() };
    numbers = [
      {
        kind: "varDecl",
        localId: keyList.count,
        init: keyCountCall(lowerer, record.ref, record.type, loc),
        loc,
      },
    ];
    for (const name of compared) {
      const position = declare("%keyAt");
      keyList.positions.set(name, position);
      numbers.push({
        kind: "varDecl",
        localId: position,
        init: record.shape.fields.some((field) => field.name === name)
          ? keyPositionCall(lowerer, record.ref, record.type, name, loc)
          : numLit(-1, loc),
        loc,
      });
    }
    state.lists.set(symbol, keyList);
    try {
      body = lowerSeparately(lowerer, state, rest, null, true);
    } finally {
      state.lists.delete(symbol);
    }
  } finally {
    lowerer.scopes.pop();
  }
  if (reported()) {
    // Nothing the second lowering reports may be heard: the block keeps
    // its array.
    lowerer.diags.length = diags;
    lowerer.runtimeFences.length = fences;
    ctx.locals.length = locals;
    return before;
  }
  // The proof: no statement reads a local the array's declaration made.
  const made = ctx.locals.slice(locals, arrayLocals).map((local) => local.id);
  if (made.length > 0 && !mentionsAny([numbers, body], new Set(made))) {
    ctx.locals.splice(locals, arrayLocals - locals);
    withArray = [];
  }
  return [
    {
      kind: "if",
      cond: reflectsStatic(lowerer, record.ref, record.type, loc),
      then: [...withArray, ...numbers, ...body],
      else_: before,
      loc,
    },
  ];
}

/** Lowers `stmts` as a list of their own. `plain` is the declaration this
 * module must leave alone inside it; `again` marks a second lowering of
 * statements that are already counted. */
function lowerSeparately(
  lowerer: Lowerer,
  state: OwnKeyListState,
  stmts: readonly ts.Statement[],
  plain: ts.Statement | null,
  again: boolean,
): IrStmt[] {
  const counted = lowerer.suppressStats;
  if (again) lowerer.suppressStats = true;
  if (plain !== null) state.plain.add(plain);
  state.depth++;
  lowerer.runtimeOptionalLocals.beginScope();
  try {
    return lowerer.lowerStmts(stmts);
  } finally {
    lowerer.runtimeOptionalLocals.endScope();
    state.depth--;
    if (plain !== null) state.plain.delete(plain);
    lowerer.suppressStats = counted;
  }
}

/** Whether anything under `node` names one of the local ids: a read, a
 * write, a capture, or any field a later IR form may add. Source positions
 * and types name no local. */
export function mentionsAny(node: unknown, ids: ReadonlySet<string>): boolean {
  if (typeof node === "string") return ids.has(node);
  if (node === null || typeof node !== "object") return false;
  if (Array.isArray(node)) {
    for (const item of node) if (mentionsAny(item, ids)) return true;
    return false;
  }
  const fields = node as Record<string, unknown>;
  for (const key in fields) {
    if (key === "loc" || key === "type") continue;
    if (mentionsAny(fields[key], ids)) return true;
  }
  return false;
}

/** The list a name reads, when its statements are being lowered for a
 * record that reflects statically and the name is read in the function
 * that declared the list. */
function keyListOf(lowerer: Lowerer, node: ts.Node): KeyList | null {
  const lists = lowerer.ownKeyLists.lists;
  if (lists.size === 0 || !ts.isIdentifier(node)) return null;
  const symbol = lowerer.checker.getSymbolAtLocation(node);
  const list = symbol === undefined ? undefined : lists.get(symbol);
  return list !== undefined && list.ctx === lowerer.ctx ? list : null;
}

/** `Object.getPrototypeOf(r)` with `r` a name. */
function prototypeCall(lowerer: Lowerer, node: ts.Node): ts.Identifier | null {
  if (!ts.isCallExpression(node) || node.questionDotToken) return null;
  const access = node.expression;
  if (!ts.isPropertyAccessExpression(access) || access.questionDotToken) return null;
  if (access.name.text !== "getPrototypeOf" || node.arguments.nodes.length !== 1) return null;
  const record = node.arguments.nodes[0]!;
  if (!ts.isIdentifier(record)) return null;
  return lowerer.stdlibGlobalMember(access, "Object") === "getPrototypeOf" ? record : null;
}

/** `Object.prototype`. */
function isObjectPrototype(lowerer: Lowerer, node: ts.Node): boolean {
  return (
    ts.isPropertyAccessExpression(node) &&
    !node.questionDotToken &&
    node.name.text === "prototype" &&
    lowerer.isStdlibGlobal(node.expression, "Object")
  );
}

/** One of this module's source forms as an expression, or null: a list's
 * `.length`, an element of a list compared with a name, a list call's
 * `.length`, and the prototype compared with Object.prototype. */
export function lowerOwnKeyQuestion(lowerer: Lowerer, expr: ts.Expression): IrExpr | null {
  if (ts.isPropertyAccessExpression(expr)) {
    if (expr.name.text !== "length" || expr.questionDotToken) return null;
    const keyList = keyListOf(lowerer, expr.expression);
    if (keyList !== null) return varRef(keyList.count, F64, locOf(expr));
    const list = listCall(lowerer, expr.expression);
    if (list === null || lowerer.ownKeyLists.plain.has(expr)) return null;
    const record = staticRecord(lowerer, list.record);
    if (record === null) return null;
    const before = lowerPlain(lowerer, expr);
    if (before.type.kind !== "f64") return before;
    const loc = locOf(expr);
    return {
      kind: "ternary",
      cond: reflectsStatic(lowerer, record.ref, record.type, loc),
      then: keyCountCall(lowerer, record.ref, record.type, loc),
      else_: before,
      type: F64,
      loc,
    };
  }
  if (!ts.isBinaryExpression(expr) || !isStrictEquality(expr.operatorToken.kind)) return null;
  const negated = expr.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken;
  const loc = locOf(expr);
  const element = ts.isElementAccessExpression(expr.left)
    ? expr.left
    : ts.isElementAccessExpression(expr.right)
      ? expr.right
      : null;
  if (element !== null) {
    const keyList = keyListOf(lowerer, element.expression);
    if (keyList === null) return null;
    const other = element === expr.left ? expr.right : expr.left;
    const position = ts.isStringLiteralLikeNode(other)
      ? keyList.positions.get(other.text)
      : undefined;
    if (position === undefined) return null;
    const at = varRef(position, F64, loc);
    // The index is evaluated whether or not the record lists the name.
    const equal: IrExpr = {
      kind: "logical",
      op: "&&",
      left: {
        kind: "bin",
        op: "===",
        left: at,
        right: lowerer.lowerExprExpecting(element.argumentExpression, F64),
        type: BOOL,
        loc,
      },
      right: { kind: "bin", op: "<", left: numLit(-1, loc), right: at, type: BOOL, loc },
      type: BOOL,
      loc,
    };
    return negated ? { kind: "unary", op: "!", operand: equal, type: BOOL, loc } : equal;
  }
  const subject =
    prototypeCall(lowerer, expr.left) !== null && isObjectPrototype(lowerer, expr.right)
      ? prototypeCall(lowerer, expr.left)
      : prototypeCall(lowerer, expr.right) !== null && isObjectPrototype(lowerer, expr.left)
        ? prototypeCall(lowerer, expr.right)
        : null;
  if (subject === null || lowerer.ownKeyLists.plain.has(expr)) return null;
  const record = staticRecord(lowerer, subject);
  if (record === null) return null;
  const before = lowerPlain(lowerer, expr);
  if (before.type.kind !== "bool") return before;
  const statically = reflectsStatic(lowerer, record.ref, record.type, loc);
  // A record that reflects statically has Object.prototype; any other
  // answers as its checked view does.
  return negated
    ? {
        kind: "logical",
        op: "&&",
        left: { kind: "unary", op: "!", operand: statically, type: BOOL, loc },
        right: before,
        type: BOOL,
        loc,
      }
    : { kind: "logical", op: "||", left: statically, right: before, type: BOOL, loc };
}
