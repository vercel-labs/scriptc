/** A require callee: the bare identifier `require`, or the CommonJS module
 * object's own method `module.require` — Node's alias for the same loader,
 * resolving from the module it names. Every module edge, statement
 * lowering, and JSON, builtin, package or program-module require path asks
 * this one question before treating a call as a require. Kept in its own
 * module so the syntactic analyses that only need the shape do not have to
 * reach into the program loader.
 *
 * `module.require` is only the global loader when `module` IS the CommonJS
 * module global: a parameter or local named `module` (a permission-checking
 * loader handed in, say) keeps its own method call. Pass a checker wherever
 * one is in hand so that distinction is made by binding; the syntactic
 * answer accepts the spelling and is only for the passes that over-approximate
 * candidates before a bound decision is made. */
import * as ts from "./ts7/adapter.js";

/** True when `decl` is a binding form the program author wrote in a source
 * file, so a use of the name resolves to that binding and never to the
 * standard library's global. EVERY binding form counts: a default import's
 * declaration is its ImportClause (there is no ImportDefaultSpecifier node
 * to match), an enum or namespace name binds a value too, and a named
 * function or class expression names itself inside its own body. */
export function isSourceValueBinding(decl: ts.Node): boolean {
  if (ts.getSourceFileOfNode(decl).isDeclarationFile) return false;
  return (
    ts.isVariableDeclaration(decl) ||
    ts.isParameter(decl) ||
    ts.isBindingElement(decl) ||
    ts.isFunctionDeclaration(decl) ||
    ts.isFunctionExpression(decl) ||
    ts.isClassDeclaration(decl) ||
    ts.isClassExpression(decl) ||
    ts.isEnumDeclaration(decl) ||
    ts.isModuleDeclaration(decl) ||
    ts.isImportClause(decl) ||
    ts.isImportSpecifier(decl) ||
    ts.isNamespaceImport(decl) ||
    ts.isImportEqualsDeclaration(decl)
  );
}

export function isCjsModuleReceiver(expr: ts.Expression, checker?: ts.TypeChecker): boolean {
  if (!ts.isIdentifier(expr) || expr.text !== "module") return false;
  if (checker === undefined) return true;
  const symbol = checker.getSymbolAtLocation(expr);
  if (symbol === undefined) return true;
  // Any source binding of the name — a parameter, a local, a class, a
  // function, an enum, a namespace, or an import in any of its forms
  // (default import included: `import module from "./policy.js"` hands the
  // program its own loader) — keeps its own method call. Only the standard
  // library's global, declared in a declaration file, is the CommonJS
  // module object.
  return !symbol.declarations.some(isSourceValueBinding);
}

export function isRequireCallee(expr: ts.Expression, checker?: ts.TypeChecker): boolean {
  if (ts.isIdentifier(expr)) return expr.text === "require";
  return (
    ts.isPropertyAccessExpression(expr) &&
    !expr.questionDotToken &&
    expr.name.text === "require" &&
    isCjsModuleReceiver(expr.expression, checker)
  );
}
