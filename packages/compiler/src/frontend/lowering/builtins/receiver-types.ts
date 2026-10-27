import * as ts from "../../ts7/adapter.js";
import { type Lowerer } from "../lowerer.js";

/** Handle and record representations do not retain the builtin receiver's identity.
 * Match its checker symbol and declaration provenance before using a builtin ABI. */
export function isBuiltinClassInstance(
  lowerer: Lowerer,
  node: ts.Expression,
  name: string,
): boolean {
  const type = lowerer.checker.getTypeAtLocation(node);
  const symbol = type.getAliasSymbol() ?? type.getSymbol();
  if (symbol === undefined || ts.symbolName(symbol) !== name) return false;
  return symbol.declarations.some(
    (declaration) =>
      (ts.isClassDeclaration(declaration) || ts.isInterfaceDeclaration(declaration)) &&
      lowerer.isStdlibFile(ts.getSourceFileOfNode(declaration)),
  );
}
