import * as ts from "../ts7/adapter.js";
import type { Lowerer } from "./lowerer.js";
import { ambientUndefinedFnSymbolOf, ambientUndefinedVarSymbolOf } from "./lower-namespaces.js";

/** The answer `typeof <operand>` gives without evaluating anything, for
 * the global-detection idioms (`typeof window < "u"`, `typeof global !==
 * "undefined"`): a name nothing declares, or one the program declares
 * ambiently and nothing defines, answers "undefined" (Node's answer for an
 * undeclared global such as window or self, and typeof never throws for
 * one), and the Node global object and process answer "object". Null for
 * every other operand. */
export function staticTypeofAnswer(lowerer: Lowerer, operand: ts.Expression): string | null {
  let e = operand;
  while (ts.isParenthesizedExpression(e)) e = e.expression;
  if (!ts.isIdentifier(e)) return null;
  if (lowerer.checker.getSymbolAtLocation(e) === undefined) return "undefined";
  for (const name of ["global", "globalThis", "process"])
    if (lowerer.isStdlibGlobal(e, name)) return "object";
  // A name the program declares ambiently but nothing defines (`declare
  // const Bun`): undeclared at run time.
  if (ambientUndefinedVarSymbolOf(lowerer, e) || ambientUndefinedFnSymbolOf(lowerer, e))
    return "undefined";
  return null;
}

/** A comparison of a statically answered typeof against a string literal
 * (`typeof window < "u"`, esbuild's minified undefined test, or
 * `typeof self !== "undefined"`), folded: the operand read has no effects,
 * so only the comparison's value remains. Null for other shapes. */
export function staticTypeofComparison(lowerer: Lowerer, e: ts.BinaryExpression): boolean | null {
  const unwrap = (x: ts.Expression): ts.Expression => {
    while (ts.isParenthesizedExpression(x)) x = x.expression;
    return x;
  };
  const left = unwrap(e.left);
  const right = unwrap(e.right);
  const literal = (x: ts.Expression): string | null =>
    ts.isStringLiteral(x) || ts.isNoSubstitutionTemplateLiteral(x) ? x.text : null;
  let answer: string | null = null;
  let text: string | null = null;
  let flipped = false;
  if (ts.isTypeOfExpression(left) && literal(right) !== null) {
    answer = staticTypeofAnswer(lowerer, left.expression);
    text = literal(right);
  } else if (ts.isTypeOfExpression(right) && literal(left) !== null) {
    answer = staticTypeofAnswer(lowerer, right.expression);
    text = literal(left);
    flipped = true;
  }
  if (answer === null || text === null) return null;
  const [a, b] = flipped ? [text, answer] : [answer, text];
  switch (e.operatorToken.kind) {
    case ts.SyntaxKind.EqualsEqualsEqualsToken:
    case ts.SyntaxKind.EqualsEqualsToken:
      return a === b;
    case ts.SyntaxKind.ExclamationEqualsEqualsToken:
    case ts.SyntaxKind.ExclamationEqualsToken:
      return a !== b;
    case ts.SyntaxKind.LessThanToken:
      return a < b;
    case ts.SyntaxKind.LessThanEqualsToken:
      return a <= b;
    case ts.SyntaxKind.GreaterThanToken:
      return a > b;
    case ts.SyntaxKind.GreaterThanEqualsToken:
      return a >= b;
    default:
      return null;
  }
}

/** Whether a callback's error parameter holds an Error (true) or null
 * (false) in the copy of the callback body being lowered
 * (lowerUndefinedResultBody), or null for other expressions. */
function knownError(lowerer: Lowerer, e: ts.Expression): boolean | null {
  while (ts.isParenthesizedExpression(e)) e = e.expression;
  if (lowerer.knownErrors.size === 0 || !ts.isIdentifier(e)) return null;
  const symbol = lowerer.checker.getSymbolAtLocation(e);
  return symbol === undefined ? null : (lowerer.knownErrors.get(symbol) ?? null);
}

/** A comparison of a known error parameter against `null`
 * (`err !== null`, `err == null`), folded. Null for other shapes. */
function knownErrorComparison(lowerer: Lowerer, e: ts.BinaryExpression): boolean | null {
  const isNull = (x: ts.Expression): boolean => {
    while (ts.isParenthesizedExpression(x)) x = x.expression;
    return x.kind === ts.SyntaxKind.NullKeyword;
  };
  const error = isNull(e.right)
    ? knownError(lowerer, e.left)
    : isNull(e.left)
      ? knownError(lowerer, e.right)
      : null;
  if (error === null) return null;
  switch (e.operatorToken.kind) {
    case ts.SyntaxKind.EqualsEqualsEqualsToken:
    case ts.SyntaxKind.EqualsEqualsToken:
      return !error;
    case ts.SyntaxKind.ExclamationEqualsEqualsToken:
    case ts.SyntaxKind.ExclamationEqualsToken:
      return error;
    default:
      return null;
  }
}

/** The value of a condition built from statically answered typeof
 * comparisons, known callback error parameters, `!`, `&&` and `||` (the
 * global-detection chains), or null when any operand needs evaluation. */
export function staticCondition(lowerer: Lowerer, expr: ts.Expression): boolean | null {
  let e = expr;
  while (ts.isParenthesizedExpression(e)) e = e.expression;
  if (ts.isPrefixUnaryExpression(e) && e.operator === ts.SyntaxKind.ExclamationToken) {
    const inner = staticCondition(lowerer, e.operand);
    return inner === null ? null : !inner;
  }
  if (ts.isIdentifier(e)) return knownError(lowerer, e);
  if (!ts.isBinaryExpression(e)) return null;
  const op = e.operatorToken.kind;
  if (op === ts.SyntaxKind.AmpersandAmpersandToken || op === ts.SyntaxKind.BarBarToken) {
    const isAnd = op === ts.SyntaxKind.AmpersandAmpersandToken;
    const left = staticCondition(lowerer, e.left);
    if (left === null) return null;
    if (left !== isAnd) return left;
    return staticCondition(lowerer, e.right);
  }
  return staticTypeofComparison(lowerer, e) ?? knownErrorComparison(lowerer, e);
}

/** The expression a value reduces to once statically decided conditions
 * select their arms (`(typeof global < "u" ? global : window)` → `global`),
 * through parentheses. */
export function staticallySelected(lowerer: Lowerer, expr: ts.Expression): ts.Expression {
  let e = expr;
  for (;;) {
    while (ts.isParenthesizedExpression(e)) e = e.expression;
    if (!ts.isConditionalExpression(e)) return e;
    const taken = staticCondition(lowerer, e.condition);
    if (taken === null) return e;
    e = taken ? e.whenTrue : e.whenFalse;
  }
}

/** True when `stmt` declares a binding that is visible outside it: a `var`
 * or a function declaration, outside nested functions. Such an arm still
 * lowers when its condition is decided, for the hoisted binding. */
export function declaresHoistedBinding(stmt: ts.Statement): boolean {
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (ts.isFunctionDeclaration(n)) {
      found = true;
      return;
    }
    if (ts.isFunctionLike(n) || ts.isClassDeclaration(n) || ts.isClassExpression(n)) return;
    if (
      ts.isVariableDeclarationList(n) &&
      (n.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) === 0
    ) {
      found = true;
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(stmt);
  return found;
}
