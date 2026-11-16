/* CommonJS require bindings a module reassigns.
 *
 * `var React = require("react"); … React = { … }` is ordinary JavaScript:
 * the declaration is a `var`, so the binding is mutable and the assignment
 * replaces the module's value. tsgo's strict CommonJS modeling gives a
 * `require()` result the alias of an import, so the assignment is reported
 * as "cannot assign to … because it is an import" and the binding has no
 * storage. A top-level `var`/`let` the file assigns instead keeps its own
 * module global, checked-dynamic: the declaration still evaluates the
 * require (the dependency's run-once %init at its position) and stores the
 * module's value in that global, and reads and writes of the binding alias
 * the global. An ES import binding and a `const` require binding stay
 * immutable, exactly as Node makes them. */
import * as ts from "../ts7/adapter.js";
import { isJsSourceFile, requireSpecOf } from "../program.js";
import type { Lowerer } from "./lowerer.js";

/** Top-level JavaScript `var`/`let` declarations initialized from a
 * `require()` call whose binding an assignment in the same file writes,
 * recorded for the queries below. */
export function collectRebindableRequireDecls(
  lowerer: Lowerer,
  sf: ts.SourceFile,
): Set<ts.VariableDeclaration> {
  const found = new Set<ts.VariableDeclaration>();
  if (!isJsSourceFile(sf)) return found;
  const byName = new Map<string, ts.VariableDeclaration>();
  for (const stmt of sf.statements.nodes) {
    if (!ts.isVariableStatement(stmt)) continue;
    if ((stmt.declarationList.flags & ts.NodeFlags.Const) !== 0) continue;
    for (const decl of stmt.declarationList.declarations.nodes) {
      if (!ts.isIdentifier(decl.name) || decl.initializer === undefined) continue;
      if (requireSpecOf(decl.initializer) === null) continue;
      byName.set(decl.name.text, decl);
    }
  }
  if (byName.size === 0) return found;
  ts.walkPreorder(sf, (node) => {
    if (
      !ts.isBinaryExpression(node) ||
      node.operatorToken.kind !== ts.SyntaxKind.EqualsToken ||
      !ts.isIdentifier(node.left)
    )
      return undefined;
    const decl = byName.get(node.left.text);
    if (!decl || found.has(decl)) return undefined;
    const symbol = lowerer.checker.getSymbolAtLocation(node.left);
    if (symbol && symbol.declarations.includes(decl)) found.add(decl);
    return undefined;
  });
  for (const decl of found) lowerer.rebindableRequireDecls.add(decl);
  return found;
}

/** Whether `decl` is a require binding the program assigns. */
export function isRebindableRequireDecl(lowerer: Lowerer, decl: ts.VariableDeclaration): boolean {
  return lowerer.rebindableRequireDecls.has(decl);
}
