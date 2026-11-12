/* Where a class's declaration-time code (static field initializers, static
 * blocks, and the link to a computed base) evaluates.
 *
 * scriptc emits that code once, at a top-level statement of the declaring
 * file, and never reorders it. The expression whose evaluation point it must
 * share walks up from the expression to such a statement; every shape the
 * walk may cross is one whose evaluation is that statement's own, so the
 * emitted code runs at the same point in the program as JavaScript's.
 *
 * Anything else — a multi-declarator statement whose earlier declarators
 * could observe the statics, an argument behind one that runs code — is a
 * named fence at the call site, never a reordering.
 */
import * as ts from "./ts7/adapter.js";

/** The top-level statement whose evaluation IS `expression`'s evaluation
 * point, or null. The path may cross only parens, a conditional's test, an
 * argument position whose earlier arguments evaluate nothing observable, a
 * class expression's heritage clause, an enclosing class expression's
 * heritage, a sole-declarator top-level variable statement, a top-level
 * assignment, a bare expression statement, or a top-level class
 * declaration's heritage clause. */
export function staticsEvaluationStatementOf(expression: ts.Node): ts.Statement | null {
  return evaluationStatementOf(expression, false);
}

/** The top-level statement an expression inside a conditional's ARM
 * evaluates under, or null when the expression reaches a top-level
 * statement without crossing an arm (staticsEvaluationStatementOf answers
 * that case) or reaches none. Such an expression evaluates at most once, in
 * the statement, and only when the condition selects its arm, so code tied
 * to its evaluation must lower where the arm lowers instead of at the
 * statement's position. */
export function staticsArmStatementOf(expression: ts.Node): ts.Statement | null {
  if (evaluationStatementOf(expression, false) !== null) return null;
  return evaluationStatementOf(expression, true);
}

function evaluationStatementOf(expression: ts.Node, crossArms: boolean): ts.Statement | null {
  let n: ts.Node = expression;
  for (let p: ts.Node | undefined = n.parent; p !== undefined; n = p, p = p.parent) {
    if (ts.isParenthesizedExpression(p)) continue;
    // A conditional's TEST runs with the conditional, so declaration-time
    // code inside it evaluates where the enclosing statement does. An ARM
    // runs only when the condition selects it: emitting its code at the
    // statement would run it even when the arm never evaluated, so an arm
    // is not a position the walk may cross.
    if (ts.isConditionalExpression(p)) {
      if (n === p.condition || crossArms) continue;
      return null;
    }
    // A class expression the expression inside a heritage clause builds
    // evaluates at the class expression's own position — `define(tag,
    // class Owner extends mixin(Base) {})` builds the class where the
    // argument is evaluated, and `const C = class extends mixin(Base) {}`
    // where the initializer is.
    if (ts.isClassExpression(p) && ts.isHeritageClause(n)) continue;
    // An argument position is the enclosing call's statement, so long as no
    // argument AHEAD of it does anything the enclosing statement could be
    // observed by (a literal or a name read cannot).
    if (ts.isCallExpression(p)) {
      const index = p.arguments.nodes.findIndex((argument) => argument === n);
      if (index >= 0 && p.arguments.nodes.slice(0, index).every(evaluatesNothing)) continue;
    }
    if (
      ts.isVariableDeclaration(p) &&
      p.initializer === n &&
      ts.isVariableDeclarationList(p.parent) &&
      p.parent.declarations.nodes.length === 1 &&
      ts.isVariableStatement(p.parent.parent) &&
      ts.isSourceFile(p.parent.parent.parent)
    )
      return p.parent.parent;
    if (
      ts.isBinaryExpression(p) &&
      p.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isExpressionStatement(p.parent) &&
      ts.isSourceFile(p.parent.parent)
    )
      return p.parent;
    if (ts.isExpressionStatement(p) && ts.isSourceFile(p.parent)) return p;
    if (ts.isExpressionWithTypeArguments(p) || ts.isHeritageClause(p)) continue;
    if (ts.isClassDeclaration(p) && ts.isSourceFile(p.parent) && ts.isHeritageClause(n)) return p;
    return null;
  }
  return null;
}

/** An argument that evaluates nothing observable: a literal. A name read is
 * not one — the declaration-time code emitted ahead of the call can assign
 * the binding the name reads (`static { x = 2 }` in the class an earlier
 * argument builds), and the call would then read the new value where
 * JavaScript reads the old one. */
export function evaluatesNothing(argument: ts.Expression): boolean {
  return (
    ts.isStringLiteral(argument) ||
    ts.isNumericLiteral(argument) ||
    argument.kind === ts.SyntaxKind.TrueKeyword ||
    argument.kind === ts.SyntaxKind.FalseKeyword ||
    argument.kind === ts.SyntaxKind.NullKeyword
  );
}
