/* Whether the program reads util.inspect's function value.
 *
 * Node's inspect, format and console renderings read three tables live on
 * every call: `util.inspect.defaultOptions` supplies the options a call
 * does not give, and `util.inspect.styles`/`util.inspect.colors` supply the
 * SGR codes of a colored leaf. The compiler folds inspects of typed values
 * into their exact text at build time, which bakes those tables' built-in
 * contents. That is Node's behavior for a program that cannot change them,
 * and wrong for one that can.
 *
 * A program can only reach the tables through util.inspect's function
 * value: either a member access (`inspect.defaultOptions.depth = 1`,
 * `inspect.colors.yellow = [101, 102]`, `inspect.styles`), or the value in
 * any other position (a store, a call argument, a destructuring target),
 * from which the tables can be reached later. Reading `inspect.custom` is
 * not such a use (a symbol read reaches no table), and a direct call
 * (`inspect(value)`) does not read the value at all.
 *
 * So one occurrence decides for the whole program: this census finds it,
 * and every static rendering then routes through the runtime, which reads
 * the tables per call. A program without one keeps the folded renderings
 * byte for byte.
 *
 * The census resolves the value by symbol (an import binding of "util", a
 * namespace import's `inspect` member, a CommonJS require binding), never
 * by the spelling of an identifier. A value aliased through an untyped
 * binding (`const i = inspect as any`) is still a read of the value at the
 * alias, which the census counts. */
import * as ts from "../ts7/adapter.js";
import { withoutParenthesesTypeWrappers } from "../outer-expressions.js";
import type { Lowerer } from "./lowerer.js";

/** Whether the program reads util.inspect's function value anywhere, so a
 * static inspect rendering could disagree with the tables it reads at run
 * time. Cached on the lowerer (Lowerer.inspectTablesTouched). */
export function programTouchesInspectTables(lowerer: Lowerer): boolean {
  const known = lowerer.inspectTablesTouched;
  if (known !== null) return known;
  const touched = census(lowerer);
  lowerer.inspectTablesTouched = touched;
  return touched;
}

/** Whether `expr` is util.inspect's function value: the binding a named
 * import of `inspect` from "util" declares (also through CommonJS require
 * spellings), or the `inspect` member of the util module namespace. */
function isInspectValue(lowerer: Lowerer, expr: ts.Expression): boolean {
  const value = withoutParenthesesTypeWrappers(expr);
  if (ts.isIdentifier(value)) {
    const binding = lowerer.builtinImportOf(value);
    return binding !== null && binding.module === "util" && binding.member === "inspect";
  }
  if (ts.isPropertyAccessExpression(value) && value.name.text === "inspect")
    return lowerer.builtinNamespaceModuleOf(value.expression) === "util";
  return false;
}

/** Whether an occurrence of the inspect value cannot reach a table: the
 * callee of a direct call, a declaration (an import specifier, a binding
 * name), a type query, or the base of a `.custom` read. */
function unreachableUse(node: ts.Node): boolean {
  const parent = node.parent;
  if (parent === undefined) return false;
  if (ts.isCallExpression(parent) && parent.expression === node) return true;
  if (
    ts.isImportSpecifier(parent) ||
    ts.isImportClause(parent) ||
    ts.isNamespaceImport(parent) ||
    ts.isExportSpecifier(parent)
  )
    return true;
  if (ts.isBindingElement(parent) && parent.name === node) return true;
  if (
    ts.isPropertyAccessExpression(parent) &&
    parent.expression === node &&
    parent.name.text === "custom"
  )
    return true;
  for (let p: ts.Node | undefined = parent; p !== undefined; p = p.parent)
    if (ts.isTypeQueryNode(p)) return true;
  return false;
}

/** Whether any source file of the program reads the inspect value in a
 * position that can reach its tables. */
function census(lowerer: Lowerer): boolean {
  for (const file of lowerer.program.getSourceFiles()) {
    if (file.isDeclarationFile) continue;
    let found = false;
    const visit = (node: ts.Node): void => {
      if (found) return;
      if (
        (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node)) &&
        isInspectValue(lowerer, node) &&
        !unreachableUse(node)
      ) {
        found = true;
        return;
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(file, visit);
    if (found) return true;
  }
  return false;
}
