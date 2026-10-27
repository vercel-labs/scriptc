/* Array spreads whose elements nothing else can reach. */
import * as ts from "../../ts7/adapter.js";
import type { IrExpr, IrType, SrcLoc } from "../../../ir/ir.js";
import type { Lowerer } from "../lowerer.js";

/** Whether the elements a spread inserts are reachable only through it: an
 * array literal (`...(cond ? [{ ... }] : [])`), or an unexported const
 * initialized by one that this spread is the only reference to, and that
 * the spread reads at most once per evaluation of the initializer. Converting such elements
 * into the destination's element layout copies them, which nothing can
 * observe. */
export function freshSpreadSource(lowerer: Lowerer, node: ts.Expression): boolean {
  let e = node;
  while (ts.isParenthesizedExpression(e)) e = e.expression;
  if (ts.isArrayLiteralExpression(e))
    return e.elements.nodes.every(
      (x) => !ts.isSpreadElement(x) && (ts.isObjectLiteralExpression(x) || !isReference(x)),
    );
  if (ts.isConditionalExpression(e))
    return freshSpreadSource(lowerer, e.whenTrue) && freshSpreadSource(lowerer, e.whenFalse);
  if (!ts.isIdentifier(e)) return false;
  const symbol = lowerer.resolveValueSymbol(e);
  const decl = symbol?.valueDeclaration;
  if (!symbol || !decl || !ts.isVariableDeclaration(decl) || !decl.initializer) return false;
  const list = decl.parent;
  if (!ts.isVariableDeclarationList(list) || (list.flags & ts.NodeFlags.Const) === 0) return false;
  // Other modules can import an exported binding and reach its elements.
  const statement = list.parent;
  if (
    ts.isVariableStatement(statement) &&
    statement.modifiers?.nodes.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
  )
    return false;
  if (!freshSpreadSource(lowerer, decl.initializer)) return false;
  // The binding's only use is this spread; an export specifier naming it
  // (`export { name }`) is another.
  let scope: ts.Node = list;
  while (scope.parent && !ts.isBlock(scope) && !ts.isSourceFile(scope)) scope = scope.parent;
  let uses = 0;
  const visit = (n: ts.Node): void => {
    if (uses > 1) return;
    if (ts.isExportSpecifier(n) && (n.propertyName ?? n.name).text === e.text) {
      uses = 2;
      return;
    }
    if (ts.isIdentifier(n) && n !== decl.name && n.text === e.text) {
      if (lowerer.resolveValueSymbol(n) === symbol) uses++;
    }
    ts.forEachChild(n, visit);
  };
  visit(scope);
  return uses === 1 && runsOnceInScope(node, scope);
}

/** Whether `node` runs at most once each time `scope` runs: no loop body,
 * loop test or update, function, or class field initializer lies between
 * them. A spread that runs again inserts the same elements again, and
 * copies would no longer be the same objects. */
function runsOnceInScope(node: ts.Node, scope: ts.Node): boolean {
  let child = node;
  for (let n = node.parent; n && n !== scope; child = n, n = n.parent) {
    if (ts.isFunctionLike(n) || ts.isPropertyDeclaration(n)) return false;
    if (ts.isForOfStatement(n) || ts.isForInStatement(n)) {
      if (child !== n.expression) return false;
    } else if (ts.isForStatement(n)) {
      if (child !== n.initializer) return false;
    } else if (ts.isWhileStatement(n) || ts.isDoStatement(n)) {
      return false;
    }
  }
  return true;
}

function isReference(e: ts.Expression): boolean {
  return !(
    ts.isStringLiteral(e) ||
    ts.isNumericLiteral(e) ||
    e.kind === ts.SyntaxKind.TrueKeyword ||
    e.kind === ts.SyntaxKind.FalseKeyword ||
    e.kind === ts.SyntaxKind.NullKeyword
  );
}

/** A fresh array spread converted into the destination's array layout by
 * the structural width lift, or null when the layouts do not lift. */
export function liftedFreshSpread(
  lowerer: Lowerer,
  node: ts.Expression,
  source: IrExpr,
  arrType: IrType,
  loc: SrcLoc,
): IrExpr | null {
  if (source.type.kind !== "array" || arrType.kind !== "array") return null;
  if (!freshSpreadSource(lowerer, node)) return null;
  const lift = lowerer.widthLiftPlan(source.type, arrType);
  return lift ? lowerer.applyWidthLift(lift, source, arrType, loc) : null;
}
