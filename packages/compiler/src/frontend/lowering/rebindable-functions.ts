/* JavaScript function declarations that their own module reassigns.
 *
 * Capability probes in published packages replace a function declaration
 * with the implementation that works on the first call (yazl's
 * `function bufferFrom(...) { bufferFrom = modern; ... }`). A top-level
 * declaration normally lowers to a static function, which cannot change.
 * A reassigned one instead becomes a mutable module global holding the
 * function as a checked-dynamic value: the module initializer assigns it
 * before its first statement (the declaration's hoisting), and reads,
 * calls and writes of the name all go through the global. TypeScript
 * rejects such writes, so only JavaScript sources take this path. */
import * as ts from "../ts7/adapter.js";
import { isJsSourceFile } from "../program.js";
import type { Lowerer } from "./lowerer.js";

/** Top-level function declarations of `sf` that an assignment anywhere in
 * the file writes, recorded for the queries below. */
export function collectRebindableFunctions(
  lowerer: Lowerer,
  sf: ts.SourceFile,
): Set<ts.FunctionDeclaration> {
  const found = new Set<ts.FunctionDeclaration>();
  if (!isJsSourceFile(sf)) return found;
  // Every named declaration in the file, top level or nested: an assignment
  // to the binding replaces the function wherever the declaration sits, and
  // the symbol's own declarations decide which one it names.
  const byName = new Map<string, ts.FunctionDeclaration[]>();
  ts.walkPreorder(sf, (node) => {
    if (
      ts.isFunctionDeclaration(node) &&
      node.name &&
      node.body &&
      node.typeParameters === undefined
    ) {
      const list = byName.get(node.name.text);
      if (list) list.push(node);
      else byName.set(node.name.text, [node]);
    }
    return undefined;
  });
  if (byName.size === 0) return found;
  ts.walkPreorder(sf, (node) => {
    if (
      !ts.isBinaryExpression(node) ||
      node.operatorToken.kind !== ts.SyntaxKind.EqualsToken ||
      !ts.isIdentifier(node.left)
    )
      return undefined;
    const candidates = byName.get(node.left.text);
    if (candidates === undefined) return undefined;
    const symbol = lowerer.checker.getSymbolAtLocation(node.left);
    if (symbol === undefined) return undefined;
    for (const decl of candidates) {
      if (found.has(decl)) continue;
      if (symbol.declarations.includes(decl)) found.add(decl);
    }
    return undefined;
  });
  for (const decl of found) lowerer.rebindableFunctions.add(decl);
  return found;
}

export function isRebindableFunction(lowerer: Lowerer, decl: ts.Node | undefined): boolean {
  return (
    decl !== undefined && ts.isFunctionDeclaration(decl) && lowerer.rebindableFunctions.has(decl)
  );
}

/** Whether the symbol names a reassigned function declaration. */
export function isRebindableFunctionSymbol(
  lowerer: Lowerer,
  symbol: ts.Symbol | undefined,
): boolean {
  return symbol !== undefined && symbol.declarations.some((d) => isRebindableFunction(lowerer, d));
}
