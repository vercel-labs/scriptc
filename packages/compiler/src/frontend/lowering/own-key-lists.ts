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
 *    compared with a string literal by `===` or `!==`: no array is made.
 *    The declaration computes the key count and the position of each
 *    compared name once (a snapshot, as the array was), and the uses read
 *    those numbers;
 *  - `Object.keys(r).length` and the two other lists' `.length`.
 *
 * `r` is a local or a parameter whose lowered type is a record that
 * recordMayKeepSource names: closed, with declared fields, no accessor
 * slot and no index signature. Anything else keeps its lowering.
 *
 * A record that kept a source, a linked copy, and (for Reflect.ownKeys and
 * the prototype) a record with a live checked view of its own take the
 * lowering the call had before, once per declaration: the answers are the
 * same as before in every case, only how they are computed changes. */
import * as ts from "../ts7/adapter.js";
import {
  BOOL,
  DYN,
  F64,
  STRING,
  arrayOf,
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
import { declareContextLocal } from "./function-context.js";
import { identifiersNamed } from "./identifier-uses.js";
import { perKeyOrder } from "./key-order-witness.js";
import { recordLinksInto, recordLinkTest, registerLinkedHelper } from "./record-links.js";
import { recordMayKeepSource, recordSourceTest } from "./record-sources.js";
import { keyedHelperName } from "./stable-names.js";

/** Which list a call answers: the enumerable names, every string name, or
 * every own key. */
type ListKind = "keys" | "names" | "ownKeys";

type RecordType = IrType & { kind: "record" };

/** A key list that exists only as numbers: its length and the position of
 * each name the program compares an element with (-1 for a name the record
 * does not list). */
interface KeyList {
  count: string;
  positions: Map<string, string>;
}

interface State {
  /** The lists of the declarations lowered so far, by the list's symbol. */
  lists: Map<ts.Symbol, KeyList>;
  /** Expressions being lowered as they were before, inside an answer. */
  plain: Set<ts.Node>;
}

const STATES = new WeakMap<Lowerer, State>();

function stateOf(lowerer: Lowerer): State {
  let state = STATES.get(lowerer);
  if (!state) {
    state = { lists: new Map(), plain: new Set() };
    STATES.set(lowerer, state);
  }
  return state;
}

/** Lowers `node` as it was lowered before this module. */
function lowerPlain(lowerer: Lowerer, node: ts.Expression): IrExpr {
  const state = stateOf(lowerer);
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

/** `%obj.keyStatic(r)`: whether `r` lists its own keys from its shape's
 * table, which a copy linked to a wider source does not. */
function keyStaticCall(lowerer: Lowerer, record: IrExpr, type: RecordType, loc: SrcLoc): IrExpr {
  const helper = shapeHelper(
    lowerer,
    "%obj.keyStatic",
    `obj.keyStatic:${type.shapeId}`,
    type,
    BOOL,
    loc,
    () => [{ kind: "return", value: { kind: "boolLit", value: true, type: BOOL, loc }, loc }],
  );
  if (helper.fn !== null) {
    const fn = helper.fn;
    // The links are known once every conversion into the type is
    // (finalizeRecordLinks), after the key orders are settled.
    registerLinkedHelper(lowerer, fn, type.shapeId, "custom");
    lowerer.linkedHelperFinalizers.push(() => {
      const r = varRef("r.0", type, loc);
      const linked: IrStmt[] = recordLinksInto(lowerer, type.shapeId).map((link) => ({
        kind: "if",
        cond: recordLinkTest(r, link, loc),
        then: [{ kind: "return", value: { kind: "boolLit", value: false, type: BOOL, loc }, loc }],
        else_: null,
        loc,
      }));
      fn.body = [...linked, ...fn.body];
    });
  }
  return call(helper.name, record, BOOL, loc);
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

/** Whether `record` answers `kind` from its shape's table: it kept no
 * source and is no linked copy, and, for the list that holds symbols, no
 * live checked view of it has a member of its own. */
function answersFromTable(
  lowerer: Lowerer,
  kind: ListKind,
  record: IrExpr,
  type: RecordType,
  loc: SrcLoc,
): IrExpr {
  const unsourced: IrExpr =
    kind === "ownKeys"
      ? { kind: "libCall", fn: "record.reflectsStatic", args: [record], type: BOOL, loc }
      : { kind: "unary", op: "!", operand: recordSourceTest(record, loc), type: BOOL, loc };
  return {
    kind: "logical",
    op: "&&",
    left: unsourced,
    right: keyStaticCall(lowerer, record, type, loc),
    type: BOOL,
    loc,
  };
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

/** The names the uses of list `symbol` compare its elements with, or null
 * when a use is anything but `list.length` or `list[i] === "name"`. */
function comparedNames(
  lowerer: Lowerer,
  decl: ts.VariableDeclaration,
  symbol: ts.Symbol,
): Set<string> | null {
  if (!ts.isIdentifier(decl.name)) return null;
  const owner = enclosingFunction(decl);
  const names = new Set<string>();
  for (const use of identifiersNamed(lowerer, ts.getSourceFileOfNode(decl), decl.name.text)) {
    if (use === decl.name) continue;
    if (lowerer.checker.getSymbolAtLocation(use) !== symbol) continue;
    if (enclosingFunction(use) !== owner) return null;
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

/** `const keys = <list call>(r)` whose uses only count the list and compare
 * its elements with names: the statements that compute the count and each
 * name's position. Null for every other declaration. */
export function lowerOwnKeyListDecl(
  lowerer: Lowerer,
  decl: ts.VariableDeclaration,
  isConst: boolean,
): IrStmt[] | null {
  if (!isConst || decl.initializer === undefined || !ts.isIdentifier(decl.name)) return null;
  const list = listCall(lowerer, decl.initializer);
  if (list === null || enclosingFunction(decl) === undefined) return null;
  const symbol = lowerer.checker.getSymbolAtLocation(decl.name);
  if (symbol === undefined) return null;
  const record = staticRecord(lowerer, list.record);
  if (record === null) return null;
  const compared = comparedNames(lowerer, decl, symbol);
  if (compared === null) return null;
  const loc = locOf(decl);
  // What the call answered before, for the records the table does not
  // describe: the names as a string list, and the list's length.
  const before = lowerPlain(lowerer, decl.initializer);
  let names: IrExpr;
  let length: (list: IrExpr) => IrExpr;
  const stringList = arrayOf(STRING);
  if (list.kind === "ownKeys") {
    if (before.type.kind !== "dyn") return null;
    names = {
      kind: "dynCheck",
      value: {
        kind: "libCall",
        fn: "dyn.getOwnPropertyNames",
        args: [lowerer.lowerExprExpecting(list.record, DYN)],
        type: DYN,
        loc,
      },
      type: stringList,
      loc,
    };
    length = () => ({ kind: "libCall", fn: "dyn.arrLen", args: [before], type: F64, loc });
  } else {
    if (before.type.kind !== "array" || before.type.elem.kind !== "string") return null;
    names = before;
    length = (held) => ({
      kind: "arrIntrinsic",
      method: "length",
      receiver: held,
      args: [],
      type: F64,
      loc,
    });
  }
  const declare = (name: string, type: IrType, mutable: boolean): string =>
    declareContextLocal(lowerer.ctx, name, type, mutable, undefined, undefined).id;
  const keyList: KeyList = { count: declare("%keyCount", F64, true), positions: new Map() };
  const stmts: IrStmt[] = [{ kind: "varDecl", localId: keyList.count, init: numLit(0, loc), loc }];
  const fast: IrStmt[] = [
    {
      kind: "assign",
      localId: keyList.count,
      value: keyCountCall(lowerer, record.ref, record.type, loc),
      loc,
    },
  ];
  const held = declare("%keyNames", stringList, false);
  const slow: IrStmt[] = [
    { kind: "varDecl", localId: held, init: names, loc },
    { kind: "assign", localId: keyList.count, value: length(varRef(held, stringList, loc)), loc },
  ];
  for (const name of compared) {
    const position = declare("%keyAt", F64, true);
    keyList.positions.set(name, position);
    stmts.push({ kind: "varDecl", localId: position, init: numLit(-1, loc), loc });
    if (record.shape.fields.some((field) => field.name === name))
      fast.push({
        kind: "assign",
        localId: position,
        value: keyPositionCall(lowerer, record.ref, record.type, name, loc),
        loc,
      });
    // indexOf answers -1 for a name the list lacks.
    slow.push({
      kind: "assign",
      localId: position,
      value: {
        kind: "arrIntrinsic",
        method: "indexOf",
        receiver: varRef(held, stringList, loc),
        args: [{ kind: "strLit", value: name, type: STRING, loc }],
        type: F64,
        loc,
      },
      loc,
    });
  }
  stmts.push({
    kind: "if",
    cond: answersFromTable(lowerer, list.kind, record.ref, record.type, loc),
    then: fast,
    else_: slow,
    loc,
  });
  stateOf(lowerer).lists.set(symbol, keyList);
  return stmts;
}

/** The list a name reads, when its declaration made one. */
function keyListOf(lowerer: Lowerer, node: ts.Node): KeyList | null {
  const lists = STATES.get(lowerer)?.lists;
  if (!lists || lists.size === 0 || !ts.isIdentifier(node)) return null;
  const symbol = lowerer.checker.getSymbolAtLocation(node);
  return symbol === undefined ? null : (lists.get(symbol) ?? null);
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
    if (list === null || STATES.get(lowerer)?.plain.has(expr)) return null;
    const record = staticRecord(lowerer, list.record);
    if (record === null) return null;
    const before = lowerPlain(lowerer, expr);
    if (before.type.kind !== "f64") return before;
    const loc = locOf(expr);
    return {
      kind: "ternary",
      cond: answersFromTable(lowerer, list.kind, record.ref, record.type, loc),
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
  if (subject === null || STATES.get(lowerer)?.plain.has(expr)) return null;
  const record = staticRecord(lowerer, subject);
  if (record === null) return null;
  const before = lowerPlain(lowerer, expr);
  if (before.type.kind !== "bool") return before;
  const statically: IrExpr = {
    kind: "libCall",
    fn: "record.reflectsStatic",
    args: [record.ref],
    type: BOOL,
    loc,
  };
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
