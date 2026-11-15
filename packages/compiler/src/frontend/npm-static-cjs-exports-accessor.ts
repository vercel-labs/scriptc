/* CommonJS modules that install an accessor as their export object:
 *
 *   function assemble() { … return styles; }
 *   Object.defineProperty(module, 'exports', { enumerable: true, get: assemble });
 *
 * `require()` returns `module.exports`, which now runs the getter: the
 * module's export is whatever `assemble()` answers when the module is
 * required. Node's loader reads `module.exports` several times while it
 * loads a module for the first time, and how often depends on what the
 * reads answer (Module.prototype.load and the end of Module._load;
 * measured on the pinned Node 24 with a getter that prints each call, by
 * position and kind of value):
 *
 *   read 1   when the module's evaluation ends; its value is not used
 *   read 2   tested for truth: a falsy value ends the load, and
 *            read 3 is the first requirer's value (3 reads)
 *   read 3   tested for being a Proxy: for one,
 *            read 4 is the first requirer's value (4 reads)
 *   read 4   its prototype is read: null or undefined throws the
 *            TypeError "Cannot convert undefined or null to object"
 *   read 5   is the first requirer's value (5 reads)
 *
 * The pass respells the statement as that decision over calls of the
 * getter (exportReads): the whole-export form both resolvers model, so the
 * checker types the export and the lowering stores it, and what the getter
 * does besides answering happens as often, and in the same order, as
 * under Node, whatever it answers.
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

/** The reads Node 24 makes of `module.exports` while a module loads for
 * the first time, as one expression over calls of the getter `get` whose
 * value is the first requirer's (the table in this file's header). The
 * npm suite's `cjs-exports-accessor` and `cjs-exports-accessor-values`
 * cases print each read under the pinned Node. Every branch ends in a
 * call of the getter; a later `require()` is one more such call
 * (accessorRequirerAssign). */
export function exportReads(get: string): string {
  const call = `${get}()`;
  const isProxy = `require("util").types.isProxy(${call})`;
  const prototypeRead = `(function (value) { if (value === null || value === undefined) throw new TypeError("Cannot convert undefined or null to object"); })(${call})`;
  return `(${call}, ${call} ? (${isProxy} ? ${call} : (${prototypeRead}, ${call})) : ${call})`;
}

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
    `module.exports = ${exportReads(getterName)};` +
    source.slice(start, end).replace(/[^\n]/g, "") +
    source.slice(end)
  );
}
