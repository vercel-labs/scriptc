/* Uses of a value that answer for every JavaScript value.
 *
 * A value that reaches native code from outside it (a member of a live
 * island view, a member of an island's own object) meets its declared type
 * through a checked conversion, and a failed conversion throws: types do not
 * lie. Declarations are routinely wrong about "absent" against "null",
 * though, and programs read such members defensively (`usage.input || 0`,
 * `if (usage.input != null)`). Those uses never needed a typed value: each
 * of them is defined for every value JavaScript has, and answers the same
 * for `undefined` as Node does. So the read hands the value on unconverted
 * there, and the conversion happens at the first use that needs a typed
 * value, to the type that use needs.
 *
 * This module is the one list of those uses. It is syntax only: the
 * position of the read in its parent expression, so it is the same answer
 * for every kind of value that may not be what its type says. The island
 * lowering asks it for the reads it converts (lower-node-island.ts). A read
 * of a property that a partial record assertion left unwritten is the same
 * question on program records (partial-assertions.ts, which throws for
 * every such read today): it must ask here too rather than keep a list of
 * its own.
 *
 * The list:
 *   - truthiness: the condition of `if`, `while`, `do`, `for` and `?:`,
 *     the operand of `!`, the left operand of `||`;
 *   - the left operand of `??`;
 *   - `==`, `!=`, `===`, `!==` against `null` or `undefined`, and `===`,
 *     `!==` against a string, number or boolean literal;
 *   - the operand of `typeof`;
 *   - the receiver of `?.`;
 *   - a template literal's substitution;
 *   - a value nobody reads (an expression statement, `void`, the left of a
 *     comma).
 * A position whose value is the enclosing expression's value takes that
 * expression's answer: the right operand of `||`, `??` and a comma, either
 * operand of `&&` (the left one is the result when it is falsy),
 * parentheses, and the type-only wrappers (`as`, `satisfies`, `!`).
 *
 * Everything else needs a typed value: a binding, an argument, a field
 * write, a return, arithmetic, a branch of `?:`. */

import * as ts from "../ts7/adapter.js";
import type { Lowerer } from "./lowerer.js";

/** Whether the value of `node` is only used in ways that answer for every
 * JavaScript value (the list above), so nothing needs it converted to its
 * declared type. */
export function totalUse(lowerer: Lowerer, node: ts.Expression): boolean {
  let n: ts.Node = node;
  for (;;) {
    const p = n.parent;
    if (p === undefined) return false;
    // Parentheses and type-only wrappers hand the value on as it is.
    if (
      ts.isParenthesizedExpression(p) ||
      ts.isAsExpression(p) ||
      ts.isTypeAssertion(p) ||
      ts.isSatisfiesExpression(p) ||
      ts.isNonNullExpression(p)
    ) {
      n = p;
      continue;
    }
    if (ts.isExpressionStatement(p) || ts.isVoidExpression(p) || ts.isTypeOfExpression(p))
      return true;
    if (ts.isIfStatement(p) || ts.isWhileStatement(p) || ts.isDoStatement(p))
      return p.expression === n;
    if (ts.isForStatement(p)) return p.condition === n;
    if (ts.isConditionalExpression(p)) return p.condition === n;
    if (ts.isPrefixUnaryExpression(p)) return p.operator === ts.SyntaxKind.ExclamationToken;
    if (ts.isTemplateSpan(p)) {
      // A tag function receives the value itself.
      const template = p.parent?.parent;
      return template === undefined || !ts.isTaggedTemplateExpression(template);
    }
    if (
      ts.isPropertyAccessExpression(p) ||
      ts.isElementAccessExpression(p) ||
      ts.isCallExpression(p)
    )
      return p.expression === n && p.questionDotToken !== undefined;
    if (!ts.isBinaryExpression(p)) return false;
    switch (p.operatorToken.kind) {
      case ts.SyntaxKind.BarBarToken:
      case ts.SyntaxKind.QuestionQuestionToken:
      case ts.SyntaxKind.CommaToken:
        if (p.left === n) return true;
        n = p;
        continue;
      case ts.SyntaxKind.AmpersandAmpersandToken:
        n = p;
        continue;
      case ts.SyntaxKind.EqualsEqualsEqualsToken:
      case ts.SyntaxKind.ExclamationEqualsEqualsToken:
        return comparedLiteral(lowerer, p.left === n ? p.right : p.left) !== null;
      case ts.SyntaxKind.EqualsEqualsToken:
      case ts.SyntaxKind.ExclamationEqualsToken: {
        // Loose equality coerces its operands; only the unit test
        // (`x == null`) answers without looking at the value's type.
        const other = comparedLiteral(lowerer, p.left === n ? p.right : p.left);
        return other === "null" || other === "undefined";
      }
      default:
        return false;
    }
  }
}

/** What a comparison's other operand is, when it is a literal: `null`, the
 * global `undefined`, or a string, number or boolean literal ("scalar").
 * Null for anything else. */
export function comparedLiteral(
  lowerer: Lowerer,
  node: ts.Expression,
): "null" | "undefined" | "scalar" | null {
  let inner = node;
  while (ts.isParenthesizedExpression(inner)) inner = inner.expression;
  switch (inner.kind) {
    case ts.SyntaxKind.NullKeyword:
      return "null";
    case ts.SyntaxKind.StringLiteral:
    case ts.SyntaxKind.NoSubstitutionTemplateLiteral:
    case ts.SyntaxKind.NumericLiteral:
    case ts.SyntaxKind.TrueKeyword:
    case ts.SyntaxKind.FalseKeyword:
      return "scalar";
    default:
      break;
  }
  if (
    ts.isPrefixUnaryExpression(inner) &&
    inner.operator === ts.SyntaxKind.MinusToken &&
    inner.operand.kind === ts.SyntaxKind.NumericLiteral
  )
    return "scalar";
  if (!ts.isIdentifier(inner) || inner.text !== "undefined") return null;
  return (lowerer.typeOf(inner).flags & ts.TypeFlags.Undefined) !== 0 ? "undefined" : null;
}
