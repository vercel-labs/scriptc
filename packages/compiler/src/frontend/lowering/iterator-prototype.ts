/* %Iterator% and %Iterator.prototype% as values in JavaScript sources
 * (ES2025 iterator helpers). The runtime unit scr_js_iterator.c builds them
 * as live objects on first use: the prototype holds the same interned
 * helper functions every native iterator, generator and helper object
 * answers, so a helper reached through the prototype (`Iterator.prototype.
 * map.call(plain, f)`) runs the runtime's one implementation of the
 * helpers over any receiver. Every form lowered here refused or read
 * undefined before, so a program that compiles today keeps its IR. Typed
 * helper chains (`g().map(f).toArray()`) keep their static lowering
 * (containers/iterator-helpers.ts). */
import * as ts from "../ts7/adapter.js";
import { BOOL, DYN, STRING, type IrExpr, type SrcLoc } from "../../ir/ir.js";
import { dynUndefinedExpr } from "../../ir/build.js";
import { isJsSourceFile, locOf } from "../program.js";
import type { Lowerer } from "./lowerer.js";
import { helperCallTakesRuntime, iteratorFromIsTyped } from "./containers/iterator-helpers.js";

/** Whether `node` is the stdlib `Iterator` global in a JavaScript source. */
export function isJsIteratorGlobal(lowerer: Lowerer, node: ts.Expression): boolean {
  while (ts.isParenthesizedExpression(node)) node = node.expression;
  return (
    ts.isIdentifier(node) &&
    node.text === "Iterator" &&
    isJsSourceFile(ts.getSourceFileOfNode(node)) &&
    lowerer.isStdlibGlobal(node, "Iterator")
  );
}

export function iteratorConstructorExpr(loc: SrcLoc): IrExpr {
  return { kind: "libCall", fn: "iterator.constructor", args: [], type: DYN, loc };
}

export function iteratorPrototypeExpr(loc: SrcLoc): IrExpr {
  return { kind: "libCall", fn: "iterator.prototype", args: [], type: DYN, loc };
}

function keyGet(value: IrExpr, name: ts.MemberName, loc: SrcLoc): IrExpr {
  return {
    kind: "dynKeyGet",
    value,
    key: { kind: "strLit", value: name.text, type: STRING, loc: locOf(name) },
    type: DYN,
    loc,
  };
}

/** `Iterator.prototype`, `Iterator.prototype.<m>` and `Iterator.<m>` read
 * as values in JavaScript: the live objects' members. Null otherwise. */
export function lowerIteratorMemberValue(
  lowerer: Lowerer,
  expr: ts.PropertyAccessExpression,
): IrExpr | null {
  if (expr.questionDotToken) return null;
  const loc = locOf(expr);
  if (isJsIteratorGlobal(lowerer, expr.expression)) {
    if (expr.name.text === "prototype") return iteratorPrototypeExpr(loc);
    return keyGet(iteratorConstructorExpr(locOf(expr.expression)), expr.name, loc);
  }
  const inner = expr.expression;
  if (
    ts.isPropertyAccessExpression(inner) &&
    !inner.questionDotToken &&
    inner.name.text === "prototype" &&
    isJsIteratorGlobal(lowerer, inner.expression)
  )
    return keyGet(iteratorPrototypeExpr(locOf(inner)), expr.name, loc);
  return null;
}

/** `Iterator.from(x)` in JavaScript when the typed lowering does not
 * apply: the runtime's GetIteratorFlattenable over the checked value. */
export function lowerIteratorFromDyn(lowerer: Lowerer, call: ts.CallExpression): IrExpr | null {
  if (!isJsSourceFile(ts.getSourceFileOfNode(call))) return null;
  const args = call.arguments.nodes;
  if (args.some(ts.isSpreadElement)) return null;
  const loc = locOf(call);
  const value: IrExpr =
    args.length > 0 ? lowerer.lowerExprExpecting(args[0]!, DYN) : dynUndefinedExpr(loc);
  // Arguments past the first are evaluated and ignored.
  const rest = args.slice(1).map((arg) => ({
    kind: "exprStmt" as const,
    expr: lowerer.lowerExpr(arg),
    loc: locOf(arg),
  }));
  const from: IrExpr = { kind: "libCall", fn: "iterator.from", args: [value], type: DYN, loc };
  if (rest.length === 0) return from;
  const local = lowerer.declareHiddenLocal("%iteratorFromArg", DYN);
  return {
    kind: "seqExpr",
    stmts: [{ kind: "varDecl", localId: local.id, init: value, loc }, ...rest],
    result: { ...from, args: [{ kind: "varRef", localId: local.id, type: DYN, loc }] },
    type: DYN,
    loc,
  };
}

/** Whether `expr` is a JavaScript `Iterator.from(...)` call that takes the
 * runtime's Iterator.from: its binding holds the checked value, never a
 * native generator adapted from it. */
export function isDynIteratorFrom(lowerer: Lowerer, expr: ts.Expression): boolean {
  return (
    ts.isCallExpression(expr) &&
    ts.isPropertyAccessExpression(expr.expression) &&
    expr.expression.name.text === "from" &&
    isJsIteratorGlobal(lowerer, expr.expression.expression) &&
    !iteratorFromIsTyped(lowerer, expr)
  );
}

/** The iterator helper stages, which answer a new helper object. */
const STAGES: ReadonlySet<string> = new Set(["map", "filter", "take", "drop", "flatMap"]);

/** Whether `expr` (JavaScript) evaluates to an iterator the runtime made
 * or wraps: a runtime `Iterator.from(...)`, a helper stage over one
 * (`Iterator.from(o).map(f)`), or a binding initialized with one. Such a
 * binding holds the checked value, never a native generator adapted from
 * it, so `.return`, identity and the helper object's own members stay
 * Node's. */
export function isDynIteratorValue(
  lowerer: Lowerer,
  expr: ts.Expression,
  seen = new Set<ts.Symbol>(),
): boolean {
  while (ts.isParenthesizedExpression(expr)) expr = expr.expression;
  if (!isJsSourceFile(ts.getSourceFileOfNode(expr))) return false;
  if (isDynIteratorFrom(lowerer, expr)) return true;
  // A helper call the typed lowering would refuse (helperCallTakesRuntime)
  // runs on the runtime's helper objects: its value is checked-dynamic.
  if (ts.isCallExpression(expr) && helperCallTakesRuntime(lowerer, expr)) return true;
  if (
    ts.isCallExpression(expr) &&
    !expr.questionDotToken &&
    ts.isPropertyAccessExpression(expr.expression) &&
    !expr.expression.questionDotToken &&
    STAGES.has(expr.expression.name.text) &&
    lowerer.isStdlibMember(expr.expression)
  )
    return isDynIteratorValue(lowerer, expr.expression.expression, seen);
  if (!ts.isIdentifier(expr)) return false;
  const symbol = lowerer.resolveValueSymbol(expr);
  if (!symbol || seen.has(symbol)) return false;
  seen.add(symbol);
  return symbol.declarations.some(
    (decl) =>
      ts.isVariableDeclaration(decl) &&
      decl.initializer !== undefined &&
      isDynIteratorValue(lowerer, decl.initializer, seen),
  );
}

/** `x instanceof Iterator` in JavaScript: OrdinaryHasInstance(%Iterator%,
 * x) over the checked value. */
export function lowerIteratorInstanceOf(
  lowerer: Lowerer,
  expr: ts.BinaryExpression,
  loc: SrcLoc,
): IrExpr | null {
  if (!isJsIteratorGlobal(lowerer, expr.right)) return null;
  const value = lowerer.coerceInto(expr.left, lowerer.lowerExpr(expr.left), DYN);
  return { kind: "libCall", fn: "iterator.instanceOf", args: [value], type: BOOL, loc };
}

/** `new Iterator(...)` in JavaScript: the arguments are evaluated, then
 * Node's abstract-class TypeError. */
export function lowerIteratorNew(lowerer: Lowerer, expr: ts.NewExpression): IrExpr | null {
  if (!isJsIteratorGlobal(lowerer, expr.expression)) return null;
  const loc = locOf(expr);
  const args = expr.arguments?.nodes ?? [];
  if (args.some(ts.isSpreadElement)) return null;
  const stmts = args.map((arg) => ({
    kind: "exprStmt" as const,
    expr: lowerer.lowerExpr(arg),
    loc: locOf(arg),
  }));
  const construct: IrExpr = { kind: "libCall", fn: "iterator.construct", args: [], type: DYN, loc };
  if (stmts.length === 0) return construct;
  return { kind: "seqExpr", stmts, result: construct, type: DYN, loc };
}
