/* Provenance of the @scriptc/node exports. The package is scriptc's own
 * (packages/node): Node.js runs its JavaScript implementation in-process,
 * and scriptc builds lower its calls to calls into Node loaded into the
 * program (lowering/lower-node-island.ts) and never compile its body. */
import * as ts from "./ts7/adapter.js";

export const NODE_API_MODULE = "@scriptc/node";

export type NodeApiMember = "call" | "callSync" | "requireModule";

function isNodeApiMember(name: string): name is NodeApiMember {
  return name === "call" || name === "callSync" || name === "requireModule";
}

function moduleSpecifierText(decl: ts.Node | undefined): string | null {
  return ts.isImportDeclaration(decl) && ts.isStringLiteral(decl.moduleSpecifier)
    ? decl.moduleSpecifier.text
    : null;
}

/** What an identifier binds from @scriptc/node: a named import of one of
 * its functions, the namespace import (`import * as node`), or nothing. */
export function nodeApiBindingOf(
  program: ts.Program,
  ident: ts.Identifier,
): NodeApiMember | "namespace" | null {
  const symbol = program.getTypeChecker().getSymbolAtLocation(ident);
  const decl = symbol ? symbol.declarations[0] : undefined;
  if (decl === undefined) return null;
  if (ts.isNamespaceImport(decl))
    return moduleSpecifierText(decl.parent?.parent) === NODE_API_MODULE ? "namespace" : null;
  if (!ts.isImportSpecifier(decl)) return null;
  if (moduleSpecifierText(decl.parent?.parent?.parent) !== NODE_API_MODULE) return null;
  const member = decl.propertyName?.text ?? decl.name.text;
  return isNodeApiMember(member) ? member : null;
}

/** The @scriptc/node export an identifier is a named-import binding of. */
export function nodeApiImportOf(program: ts.Program, ident: ts.Identifier): NodeApiMember | null {
  const binding = nodeApiBindingOf(program, ident);
  return binding === "namespace" ? null : binding;
}

/** Whether an identifier is a namespace-import binding of @scriptc/node
 * (`import * as node from "@scriptc/node"`). */
export function isNodeApiNamespace(program: ts.Program, ident: ts.Identifier): boolean {
  return nodeApiBindingOf(program, ident) === "namespace";
}

/** The @scriptc/node function a call's callee names: a named import
 * (`callSync(...)`, also renamed) or a namespace member
 * (`node.callSync(...)`). */
export function nodeApiCalleeOf(program: ts.Program, callee: ts.Expression): NodeApiMember | null {
  if (ts.isIdentifier(callee)) return nodeApiImportOf(program, callee);
  if (
    !ts.isPropertyAccessExpression(callee) ||
    !ts.isIdentifier(callee.name) ||
    !ts.isIdentifier(callee.expression)
  )
    return null;
  const member = callee.name.text;
  if (!isNodeApiMember(member)) return null;
  return isNodeApiNamespace(program, callee.expression) ? member : null;
}

/** Whether an expression evaluates to a value owned by a Node island: a
 * requireModule(...) result or anything reached from one through member
 * reads, element reads, destructuring or a const alias (`const { Point } =
 * requireModule("./lib.cjs")`, `lib.Point`, `const P = lib.Point`). Used
 * to refuse native subclasses of island classes (SC8011). */
export function islandValueOrigin(program: ts.Program, expr: ts.Expression, depth = 0): boolean {
  if (depth > 8) return false;
  let e: ts.Node = expr;
  for (;;) {
    if (ts.isParenthesizedExpression(e)) e = e.expression;
    else if (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e)) e = e.expression;
    else if (ts.isAsExpression(e) || ts.isNonNullExpression(e)) e = e.expression;
    else break;
  }
  if (ts.isCallExpression(e)) return nodeApiCalleeOf(program, e.expression) === "requireModule";
  if (!ts.isIdentifier(e)) return false;
  const symbol = program.getTypeChecker().getSymbolAtLocation(e);
  let decl: ts.Node | undefined = symbol ? symbol.declarations[0] : undefined;
  // A destructuring binding: climb to the declaration that initializes it.
  while (decl !== undefined && ts.isBindingElement(decl)) decl = decl.parent?.parent;
  if (decl === undefined || !ts.isVariableDeclaration(decl) || decl.initializer === undefined)
    return false;
  return islandValueOrigin(program, decl.initializer, depth + 1);
}
