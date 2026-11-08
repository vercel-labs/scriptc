/* Member chains on an untyped binding the checker narrowed to a compiled class.
 *
 * `if (value instanceof Shape) total += value.area` where `value` is stored
 * as a checked-dynamic value (an `unknown` local, parameter or global): the
 * checker types `value` as `Shape` inside the branch, while the stored value
 * stays the dynamic one, so each member operation on it was the dynamic
 * operation: a shared helper that tries every class with that member, reads
 * the slot and boxes the answer.
 *
 * A class test does not prove a layout: an object that inherits from an
 * instance, a Proxy, a value of a Node island and whatever a user-defined
 * `Symbol.hasInstance` accepts all pass `instanceof` without being a compiled
 * instance. What does prove it is the capsule itself: a capsule this program
 * boxed from the class, or from a class below it, carries that class's key
 * constant by address and holds an instance whose layout starts with the
 * class's. So the chain lowers twice behind that test:
 *
 *   keyIn(value, Shape) ? <the chain with `value` read as a typed Shape>
 *                       : <the dynamic chain, exactly as before>
 *
 * The typed arm takes the ordinary class paths (fields, accessors, methods,
 * optional links) through the lowerer's expression override, with the
 * binding reading as the capsule's instance. The other arm is the lowering
 * the chain had, so every value that is not such a capsule answers as it
 * did. The result has the type the dynamic chain gives; the typed arm
 * converts to it where the two differ.
 *
 * Programs without such a chain lower as before. */
import { dynUndefinedExpr, strLit } from "../../ir/build.js";
import { BOOL, type IrExpr, typeEquals, typeKey } from "../../ir/ir.js";
import * as ts from "../ts7/adapter.js";
import { isJsSourceFile, locOf } from "../program.js";
import { tryLowerExpression } from "./expressions/try-lower-expression.js";
import type { ClassInfo } from "./lower-classes.js";
import type { Lowerer } from "./lowerer.js";

interface ChainState {
  /** Chains whose two arms are being lowered. */
  readonly active: Set<ts.Node>;
  /** Bindings whose dynamic arm is being lowered: chains on them inside it
   * stay dynamic. */
  readonly dynamicArm: Set<ts.Symbol>;
}

const states = new WeakMap<Lowerer, ChainState>();

function stateOf(lowerer: Lowerer): ChainState {
  let state = states.get(lowerer);
  if (!state) {
    state = { active: new Set(), dynamicArm: new Set() };
    states.set(lowerer, state);
  }
  return state;
}

function skipWrappers(node: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node)) node = node.expression;
  return node;
}

/** Whether an operand of the chain (a call argument) can be lowered once per
 * arm: it creates no function or class, does not suspend, and leaves the
 * chain's binding alone. */
function plainOperand(node: ts.Node, root: ts.Identifier): boolean {
  if (
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isClassExpression(node) ||
    ts.isAwaitExpression(node) ||
    ts.isYieldExpression(node) ||
    ts.isSpreadElement(node)
  )
    return false;
  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
    node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
  ) {
    const target = skipWrappers(node.left);
    if (ts.isIdentifier(target) && target.text === root.text) return false;
  }
  if (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) {
    const target = skipWrappers(node.operand);
    if (
      ts.isIdentifier(target) &&
      target.text === root.text &&
      (node.operator === ts.SyntaxKind.PlusPlusToken ||
        node.operator === ts.SyntaxKind.MinusMinusToken)
    )
      return false;
  }
  let plain = true;
  ts.forEachChild(node, (child) => {
    if (plain && !plainOperand(child, root)) plain = false;
  });
  return plain;
}

/** The identifier a chain of property reads and method calls starts at, or
 * null when `expr` is not such a chain. */
function chainRoot(expr: ts.Expression): ts.Identifier | null {
  let node = skipWrappers(expr);
  for (;;) {
    if (ts.isPropertyAccessExpression(node)) {
      if (!ts.isIdentifier(node.name)) return null;
      node = skipWrappers(node.expression);
    } else if (ts.isCallExpression(node)) {
      if (!ts.isPropertyAccessExpression(skipWrappers(node.expression))) return null;
      node = skipWrappers(node.expression);
    } else break;
  }
  return ts.isIdentifier(node) ? node : null;
}

/** Whether every call argument of the chain can be lowered once per arm. */
function plainOperands(expr: ts.Expression, root: ts.Identifier): boolean {
  for (let node = skipWrappers(expr); node !== root;) {
    if (ts.isCallExpression(node)) {
      if (!node.arguments.nodes.every((argument) => plainOperand(argument, root))) return false;
      node = skipWrappers(node.expression);
    } else if (ts.isPropertyAccessExpression(node)) node = skipWrappers(node.expression);
    else return false;
  }
  return true;
}

/** The chain link `node` is the receiver of, or null. */
function enclosingLink(node: ts.Expression): ts.Expression | null {
  let child: ts.Node = node;
  let parent = child.parent;
  while (
    parent !== undefined &&
    (ts.isParenthesizedExpression(parent) || ts.isNonNullExpression(parent))
  ) {
    child = parent;
    parent = parent.parent;
  }
  if (parent === undefined) return null;
  if (
    (ts.isPropertyAccessExpression(parent) || ts.isCallExpression(parent)) &&
    parent.expression === child
  )
    return parent;
  return null;
}

/** Whether `node` is read as a value where it stands: not a call's callee,
 * not written, updated, deleted or constructed. */
function readPosition(node: ts.Expression): boolean {
  let child: ts.Node = node;
  let parent = child.parent;
  while (
    parent !== undefined &&
    (ts.isParenthesizedExpression(parent) || ts.isNonNullExpression(parent))
  ) {
    child = parent;
    parent = parent.parent;
  }
  if (parent === undefined) return true;
  if (ts.isCallExpression(parent) || ts.isNewExpression(parent)) return parent.expression !== child;
  if (ts.isTaggedTemplateExpression(parent)) return parent.tag !== child;
  if (ts.isBinaryExpression(parent) && parent.left === child)
    return !(
      parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    );
  if (ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent))
    return (
      parent.operator !== ts.SyntaxKind.PlusPlusToken &&
      parent.operator !== ts.SyntaxKind.MinusMinusToken
    );
  if (ts.isDeleteExpression(parent)) return false;
  return true;
}

function isChain(node: ts.Expression, root: ts.Identifier): boolean {
  return (
    (ts.isPropertyAccessExpression(node) || ts.isCallExpression(node)) &&
    readPosition(node) &&
    chainRoot(node) === root &&
    plainOperands(node, root)
  );
}

/** A compiled program class whose capsules hold an instance with the class's
 * own fixed layout: the class and every class above it are the program's
 * and none is generic. A generic class has one layout per instantiation,
 * and the checker names the narrowed value with yet another one
 * (`Cell<any>`), which no capsule is boxed from. */
function fixedLayout(info: ClassInfo): boolean {
  for (let current: ClassInfo | null = info; current !== null; current = current.base) {
    if (
      !current.decl ||
      current.decl.typeParameters !== undefined ||
      current.def.runtime ||
      current.builtinError ||
      current.builtinEmitter ||
      current.builtinStream ||
      current.localClass ||
      current.def.arrayElem !== undefined ||
      isJsSourceFile(ts.getSourceFileOfNode(current.decl))
    )
      return false;
  }
  return true;
}

/** `expr` lowered behind the capsule test when it is the outermost member
 * chain on such a binding, or null. */
export function lowerNarrowedClassChain(lowerer: Lowerer, expr: ts.Expression): IrExpr | null {
  if (!ts.isPropertyAccessExpression(expr) && !ts.isCallExpression(expr)) return null;
  const root = chainRoot(expr);
  if (root === null) return null;
  const stored = lowerer.peekLocal(root) ?? lowerer.globalOf(root);
  if (stored?.type.kind !== "dyn") return null;
  if (lowerer.chainRecvByNode.has(root)) return null;
  const state = stateOf(lowerer);
  if (state.active.has(expr)) return null;
  if (!readPosition(expr) || !plainOperands(expr, root)) return null;
  if (isJsSourceFile(ts.getSourceFileOfNode(expr))) return null;
  const narrowed = lowerer.mapTypeOf(lowerer.typeOf(root));
  if (narrowed?.kind !== "object") return null;
  const info = lowerer.classes.get(narrowed.className);
  if (!info || !fixedLayout(info)) return null;
  const symbol = lowerer.resolveValueSymbol(root);
  if (!symbol || state.dynamicArm.has(symbol)) return null;
  // A longer chain around this one takes both arms itself.
  for (let link = enclosingLink(expr); link !== null; link = enclosingLink(link))
    if (isChain(link, root)) return null;
  const value = tryLowerExpression(lowerer, root);
  if (value === null || value.kind !== "varRef" || value.type.kind !== "dyn") return null;
  const loc = locOf(expr);
  state.active.add(expr);
  try {
    state.dynamicArm.add(symbol);
    let dynamic: IrExpr;
    try {
      dynamic = lowerer.lowerExpr(expr);
    } finally {
      state.dynamicArm.delete(symbol);
    }
    const instance: IrExpr = {
      kind: "dynCheck",
      value,
      exact: true,
      type: narrowed,
      loc: value.loc,
    };
    const typed = lowerer.withExpressionOverride(root, instance, () =>
      tryLowerExpression(lowerer, expr),
    );
    if (typed === null) return dynamic;
    let then: IrExpr;
    if (typeEquals(typed.type, dynamic.type)) then = typed;
    else if (dynamic.type.kind !== "dyn") return dynamic;
    else if (typed.type.kind === "void")
      then = {
        kind: "seqExpr",
        stmts: [{ kind: "exprStmt", expr: typed, loc }],
        result: dynUndefinedExpr(loc),
        type: dynamic.type,
        loc,
      };
    else if (lowerer.dynConvertible(typed.type))
      then = lowerer.coerceToExpected(typed, dynamic.type);
    else return dynamic;
    const cond: IrExpr = {
      kind: "libCall",
      fn: "dyn.typedRefKeyIn",
      args: [value, strLit(typeKey(narrowed), loc)],
      type: BOOL,
      loc,
    };
    return { kind: "ternary", cond, then, else_: dynamic, type: dynamic.type, loc };
  } finally {
    state.active.delete(expr);
  }
}
