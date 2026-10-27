/* Provenance of the @scriptc/threads exports. The package is scriptc's own
 * (packages/threads): Node.js runs its JavaScript implementation, scriptc
 * builds lower its exports to intrinsics and never compile its body. */
import * as ts from "./ts7/adapter.js";

export const THREADS_MODULE = "@scriptc/threads";

export type ThreadsMember = "publish" | "sharesPublishedGraphs";

/** The @scriptc/threads export an identifier is a named-import binding of. */
export function threadsImportOf(program: ts.Program, ident: ts.Identifier): ThreadsMember | null {
  const checker = program.getTypeChecker();
  const symbol = checker.getSymbolAtLocation(ident);
  const decl = symbol ? symbol.declarations[0] : undefined;
  if (decl === undefined || !ts.isImportSpecifier(decl)) return null;
  const importDecl = decl.parent?.parent?.parent;
  if (
    !ts.isImportDeclaration(importDecl) ||
    !ts.isStringLiteral(importDecl.moduleSpecifier) ||
    importDecl.moduleSpecifier.text !== THREADS_MODULE
  )
    return null;
  const member = decl.propertyName?.text ?? decl.name.text;
  return member === "publish" || member === "sharesPublishedGraphs" ? member : null;
}
