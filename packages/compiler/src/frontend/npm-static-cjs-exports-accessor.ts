/* CommonJS modules that install an accessor as their export object:
 *
 *   function assemble() { … return styles; }
 *   Object.defineProperty(module, 'exports', { enumerable: true, get: assemble });
 *
 * `require()` returns `module.exports`, which now runs the getter: the
 * module's export is whatever `assemble()` answers when the module is
 * required. Node's loader reads `module.exports` five times while it loads
 * a module for the first time (once when the module's evaluation ends,
 * four times before the first `require()` returns; measured on the pinned
 * Node 24, where a getter that counts its calls answers 5 to its first
 * requirer) and hands the requirer the last read. The pass respells the
 * statement as `module.exports = (assemble(), …, assemble());` with that
 * many calls: the whole-export form both resolvers model, so the checker
 * types the export and the lowering stores it, and what the getter does
 * besides answering happens as often as under Node.
 *
 * Exact for the module's first `require()` only while nothing can tell the
 * calls at the statement from the reads Node makes when the module's
 * evaluation ends: the statement is the file's last top-level statement,
 * the getter is a top-level function declaration (the file's only binding
 * of its name, never reassigned) that reads neither `this` nor
 * `arguments`, the descriptor holds nothing but `get` and boolean
 * `enumerable`/`configurable` entries, and `module` and `exports` are the
 * CommonJS globals, named nowhere else in the file (so nothing reads or
 * replaces the export object before the accessor is installed). Node runs
 * the getter once more for every later `require()` of the module and
 * answers each a value of its own, so the caller records the file
 * (npmStaticAccessorExport) and the lowering refuses the statement when
 * the program evaluates the module's export more than once. Other shapes
 * answer null and keep their existing treatment. */
import * as ts from "./ts7/syntax.js";
import { withoutParentheses } from "./outer-expressions.js";
import {
  countDeclarations,
  declaredNames,
  isWritten,
  references,
} from "./npm-static-bundled-chunks.js";
import { tokenStartOfNode } from "./ts7/node-functions.js";

/** How often Node 24 reads `module.exports` while a module loads for the
 * first time, the last read being the first requirer's value
 * (Module.prototype.load once, Module._load four times). The npm suite's
 * `cjs-exports-accessor` case counts the reads under the pinned Node. */
const FIRST_LOAD_EXPORT_READS = 5;

export function mayHoldCjsExportsAccessor(source: string): boolean {
  return source.includes("defineProperty") && source.includes("module") && source.includes("get");
}

/** True when a function body reads its own `this` or `arguments`. */
function readsReceiverOrArguments(fn: ts.FunctionDeclaration): boolean {
  let found = false;
  const visit = (node: ts.Node): "skip" | "stop" | undefined => {
    if (found) return "stop";
    // An arrow function shares the enclosing `this` and `arguments`; every
    // other function has its own.
    if (
      node !== fn &&
      (ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isMethodDeclaration(node) ||
        ts.isGetAccessorDeclaration(node) ||
        ts.isSetAccessorDeclaration(node) ||
        ts.isConstructorDeclaration(node) ||
        ts.isClassDeclaration(node) ||
        ts.isClassExpression(node))
    )
      return "skip";
    if (node.kind === ts.SyntaxKind.ThisKeyword) found = true;
    if (ts.isIdentifier(node) && node.text === "arguments") found = true;
    return undefined;
  };
  ts.walkPreorder(fn, visit);
  return found;
}

export function normalizeCjsExportsAccessor(sf: ts.SourceFile): string | null {
  const source = sf.text;
  if (!mayHoldCjsExportsAccessor(source)) return null;
  if (!sf.fileName.endsWith(".cjs") && ts.isExternalModule(sf)) return null;
  const declared = declaredNames(sf);
  if (declared.has("exports") || declared.has("module") || declared.has("Object")) return null;

  // The file's last statement: `Object.defineProperty(module, "exports", { … get: F … });`.
  const stmts = sf.statements.nodes.filter((stmt) => !ts.isEmptyStatement(stmt));
  const last = stmts[stmts.length - 1];
  if (last === undefined || !ts.isExpressionStatement(last)) return null;
  const call = withoutParentheses(last.expression);
  if (!ts.isCallExpression(call) || call.questionDotToken) return null;
  const callee = call.expression;
  if (
    !ts.isPropertyAccessExpression(callee) ||
    callee.questionDotToken ||
    !ts.isIdentifier(callee.expression) ||
    callee.expression.text !== "Object" ||
    callee.name.text !== "defineProperty"
  )
    return null;
  const args = call.arguments.nodes;
  if (args.length !== 3) return null;
  const [target, key, descriptor] = args as unknown as [
    ts.Expression,
    ts.Expression,
    ts.Expression,
  ];
  if (!ts.isIdentifier(target) || target.text !== "module") return null;
  if (!ts.isStringLiteralLike(key) || key.text !== "exports") return null;
  if (!ts.isObjectLiteralExpression(descriptor)) return null;
  let getter: string | null = null;
  for (const property of descriptor.properties.nodes) {
    if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name)) return null;
    const value = withoutParentheses(property.initializer);
    if (property.name.text === "get") {
      if (getter !== null || !ts.isIdentifier(value)) return null;
      getter = value.text;
    } else if (property.name.text === "enumerable" || property.name.text === "configurable") {
      if (value.kind !== ts.SyntaxKind.TrueKeyword && value.kind !== ts.SyntaxKind.FalseKeyword)
        return null;
    } else {
      return null;
    }
  }
  if (getter === null) return null;
  const getterName = getter;

  // The getter: one top-level function declaration, the only binding of
  // its name, never written, reading neither `this` nor `arguments`.
  const decls = stmts.filter(
    (stmt): stmt is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(stmt) && stmt.name?.text === getterName && stmt.body !== undefined,
  );
  if (decls.length !== 1 || countDeclarations(sf, getterName) !== 1) return null;
  const fn = decls[0]!;
  if (fn.asteriskToken !== undefined || fn.modifiers?.nodes.length) return null;
  if (readsReceiverOrArguments(fn)) return null;
  for (const reference of references(sf)) {
    if (reference.text === getterName && isWritten(reference)) return null;
    // `module` and `exports` appear in the statement and nowhere else.
    if (
      (reference.text === "module" || reference.text === "exports") &&
      (tokenStartOfNode(reference) < tokenStartOfNode(last) || reference.end > last.end)
    )
      return null;
  }

  // Respell the statement; its span keeps its line breaks, so every other
  // line of the file stays where it was.
  const start = tokenStartOfNode(last);
  const end = last.end;
  return (
    source.slice(0, start) +
    `module.exports = (${Array.from({ length: FIRST_LOAD_EXPORT_READS }, () => `${getterName}()`).join(", ")});` +
    source.slice(start, end).replace(/[^\n]/g, "") +
    source.slice(end)
  );
}
