import * as ts from "../../ts7/adapter.js";
import type { Lowerer } from "../lowerer.js";
import { identifiersNamed } from "../identifier-uses.js";

/** The captures an `exec` result is read through, as a bit mask (bit k for
 * capture k), when `const m = re.exec(s)` is observed only by null tests
 * (`m === null`, `m != null`, ...) and constant-index element reads
 * (`m[3]`, `m[3]!`). No other use can tell an unread capture, or the
 * result's `index`/`input` properties, from a missing one, so the runtime
 * leaves them out. Null when any use has another shape or the binding is
 * exported, which keeps the complete result. */
export function execResultCaptureMask(lowerer: Lowerer, call: ts.CallExpression): number | null {
  const decl = call.parent;
  if (
    !ts.isVariableDeclaration(decl) ||
    decl.initializer !== call ||
    !ts.isIdentifier(decl.name) ||
    decl.type !== undefined ||
    !ts.isVariableDeclarationList(decl.parent) ||
    (decl.parent.flags & ts.NodeFlags.Const) === 0
  )
    return null;
  const statement = decl.parent.parent;
  if (
    ts.isVariableStatement(statement) &&
    statement.modifiers?.nodes.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
  )
    return null;
  const symbol = lowerer.resolveValueSymbol(decl.name);
  if (!symbol) return null;
  const read = new Set<number>();
  for (const use of identifiersNamed(lowerer, ts.getSourceFileOfNode(decl), decl.name.text)) {
    if (use === decl.name || lowerer.resolveValueSymbol(use) !== symbol) continue;
    const ref = outerValue(use);
    const parent = ref.parent;
    if (ts.isBinaryExpression(parent) && EQUALITY.has(parent.operatorToken.kind)) {
      const other = parent.left === ref ? parent.right : parent.left;
      if (other.kind === ts.SyntaxKind.NullKeyword) continue;
      return null;
    }
    if (
      ts.isElementAccessExpression(parent) &&
      parent.expression === ref &&
      parent.questionDotToken === undefined &&
      ts.isNumericLiteral(parent.argumentExpression) &&
      isValueRead(parent)
    ) {
      const index = Number(parent.argumentExpression.text);
      if (!Number.isInteger(index) || index < 0 || index >= 53) return null;
      read.add(index);
      continue;
    }
    return null;
  }
  let mask = 0;
  for (const index of read) mask += 2 ** index;
  return mask;
}

const EQUALITY = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
]);

function outerValue(node: ts.Node): ts.Node {
  let ref = node;
  while (ts.isParenthesizedExpression(ref.parent) || ts.isNonNullExpression(ref.parent))
    ref = ref.parent;
  return ref;
}

/** An element read whose value is only consumed: not a write, update,
 * delete or destructuring target. */
function isValueRead(access: ts.ElementAccessExpression): boolean {
  const ref = outerValue(access);
  const parent = ref.parent;
  if (
    ts.isBinaryExpression(parent) &&
    parent.left === ref &&
    parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
    parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment
  )
    return false;
  return !(
    (ts.isPrefixUnaryExpression(parent) &&
      (parent.operator === ts.SyntaxKind.PlusPlusToken ||
        parent.operator === ts.SyntaxKind.MinusMinusToken)) ||
    ts.isPostfixUnaryExpression(parent) ||
    ts.isDeleteExpression(parent) ||
    ts.isArrayLiteralExpression(parent) ||
    ts.isObjectLiteralElementLike(parent) ||
    ts.isSpreadElement(parent) ||
    ((ts.isForOfStatement(parent) || ts.isForInStatement(parent)) && parent.initializer === ref)
  );
}
