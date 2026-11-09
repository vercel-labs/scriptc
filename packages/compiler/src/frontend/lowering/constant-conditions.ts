import * as ts from "../ts7/adapter.js";
import { withoutParentheses } from "../outer-expressions.js";
import { definedValue } from "../define-branches.js";
import type { Lowerer } from "./lowerer.js";

/* Conditions that have one value in every run of the program:
 *
 *   const DEV = false;
 *   if (DEV) {
 *     Object.freeze(config);
 *   }
 *
 * The untaken arm of such an `if` is code the program never runs, so it does
 * not lower (lowerStatement), and what lowering it would have switched on
 * for the whole program stays off: the integrity words and write checks of
 * a program that freezes untyped values (frozen-records.ts
 * noteUntypedIntegrity) are the case this exists for. The condition itself
 * still lowers and runs, so a `const` read before its declaration throws as
 * under Node. The right operand of `&&` and `||` after a constant left
 * operand that decides the result is the same case (`DEV && check(x)`,
 * expressions/binary.ts).
 *
 * A condition is constant when it is `true` or `false`, a `const` binding
 * whose initializer is a constant condition (through imports and
 * re-exports), a comparison `--define` decides (define-branches.ts, the
 * rule the JavaScript `if` statements resolve by), or `!`, `&&` and `||`
 * over those, where the left operand of `&&` and `||` decides the result or
 * both operands are constant. */

/** The value of a constant condition, or null when it needs evaluation. */
export function constantCondition(lowerer: Lowerer, expr: ts.Expression): boolean | null {
  return constantValue(lowerer, expr, new Set());
}

function constantValue(lowerer: Lowerer, expr: ts.Expression, seen: Set<ts.Node>): boolean | null {
  const e = withoutParentheses(expr);
  if (e.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (e.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (ts.isPrefixUnaryExpression(e) && e.operator === ts.SyntaxKind.ExclamationToken) {
    const operand = constantValue(lowerer, e.operand, seen);
    return operand === null ? null : !operand;
  }
  if (ts.isIdentifier(e)) {
    const initializer = constInitializer(lowerer, e);
    if (initializer === null || seen.has(initializer)) return null;
    seen.add(initializer);
    return constantValue(lowerer, initializer, seen);
  }
  if (!ts.isBinaryExpression(e)) return null;
  const op = e.operatorToken.kind;
  if (op === ts.SyntaxKind.AmpersandAmpersandToken || op === ts.SyntaxKind.BarBarToken) {
    const isAnd = op === ts.SyntaxKind.AmpersandAmpersandToken;
    const left = constantValue(lowerer, e.left, seen);
    if (left === null) return null;
    if (left !== isAnd) return left;
    return constantValue(lowerer, e.right, seen);
  }
  return definedComparison(lowerer, e);
}

/** The initializer of the `const` declaration `ident` reads, or null: a
 * `let`, a `var`, a parameter, a destructured name and an ambient
 * declaration can hold other values. */
function constInitializer(lowerer: Lowerer, ident: ts.Identifier): ts.Expression | null {
  const declaration = lowerer.resolveValueSymbol(ident)?.valueDeclaration;
  if (
    declaration === undefined ||
    !ts.isVariableDeclaration(declaration) ||
    !ts.isIdentifier(declaration.name) ||
    declaration.initializer === undefined
  )
    return null;
  const list = declaration.parent;
  const blockScoped = ts.NodeFlags.Let | ts.NodeFlags.Const | ts.NodeFlags.Using;
  if (
    list === undefined ||
    !ts.isVariableDeclarationList(list) ||
    (list.flags & blockScoped) !== ts.NodeFlags.Const ||
    (ts.getCombinedModifierFlags(declaration) & ts.ModifierFlags.Ambient) !== 0
  )
    return null;
  return declaration.initializer;
}

/** The value of a comparison `--define` decides, when each `process` it
 * names is Node's global. */
function definedComparison(lowerer: Lowerer, e: ts.BinaryExpression): boolean | null {
  if (lowerer.define === undefined) return null;
  const value = definedValue(e, lowerer.define);
  if (typeof value !== "boolean") return null;
  let global = true;
  const visit = (n: ts.Node): void => {
    if (!global) return;
    if (ts.isIdentifier(n)) {
      if (n.text === "process" && !lowerer.isStdlibGlobal(n, "process")) global = false;
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(e);
  return global ? value : null;
}
