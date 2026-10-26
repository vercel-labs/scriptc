/* `if` statements whose condition `--define` decides, resolved in the
 * JavaScript text every later pass reads:
 *
 *   if (process.env.NODE_ENV === "production") {
 *     module.exports = require("./cjs/react.production.js");
 *   } else {
 *     module.exports = require("./cjs/react.development.js");
 *   }
 *
 * becomes the taken branch's statements, so the untaken branch's modules
 * never join the program and the taken statements sit where the CommonJS
 * analyses look for them (the module's top level, here).
 *
 * A condition is decided when it is built from defined reads, string
 * literals, `===`, `!==`, `==` and `!=` between two of them, `!`, and `&&`
 * and `||` whose left operand decides the result. Only an `if` in a
 * statement list resolves. The untaken branch's `var` names stay declared
 * (`var x;`), holding undefined as under Node. A taken block keeps its
 * braces when it declares block-scoped bindings, and an `if` whose untaken
 * branch declares a function keeps its text. Each removed span becomes a
 * `;`, so the kept statements never join their neighbors in code without
 * semicolons, padded with spaces that keep the positions of the text after
 * it. The executable sets the defined variables when it starts
 * (buildMain), so its reads agree with the resolved branches. */
import * as ts from "./ts7/syntax.js";
import { tokenStartOfNode } from "./ts7/node-functions.js";
import { countDeclarations, unparen } from "./npm-static-bundled-chunks.js";
import { definedEnvValue, type Defines } from "./defines.js";

/** True when the text may read a defined variable (a cheap probe). */
export function mayReadDefine(source: string, defines: Defines): boolean {
  return Object.keys(defines).some((key) => source.includes(key.slice("process.env.".length)));
}

/** The module text with each decided `if` resolved, or null when none is. */
export function resolveDefinedBranches(sf: ts.SourceFile, defines: Defines): string | null {
  if (countDeclarations(sf, "process") > 0 || importsBinding(sf, "process")) return null;
  const edits: { start: number; end: number; text: string }[] = [];
  const replace = (start: number, end: number, text: string): void => {
    edits.push({ start, end, text });
  };
  // `if` statements that stand where their parent `if` stood: the taken
  // `else if` of a resolved `if`.
  const inStatementList = new Set<ts.Node>();
  const visit = (n: ts.Node): "skip" | undefined => {
    if (!ts.isIfStatement(n) || !(isStatementList(n.parent) || inStatementList.has(n)))
      return undefined;
    const taken = staticValue(n.expression, defines);
    if (taken === null) return undefined;
    const live = taken ? n.thenStatement : n.elseStatement;
    const dead = taken ? n.elseStatement : n.thenStatement;
    if (dead !== undefined && declaresFunction(dead)) return undefined;
    const hoisted = dead === undefined ? [] : varNames(dead);
    const ending = hoisted.length === 0 ? ";" : `;var ${hoisted.join(", ")};`;
    const start = tokenStartOfNode(n);
    if (live === undefined) {
      replace(start, n.end, ending);
      return "skip";
    }
    const unwrap = ts.isBlock(live) && !declaresBlockScoped(live);
    const liveStart = tokenStartOfNode(live);
    const bodyStart = unwrap ? liveStart + 1 : liveStart;
    const bodyEnd = unwrap ? live.end - 1 : live.end;
    if (taken) {
      replace(start, bodyStart, ";");
      if (bodyEnd < n.end) replace(bodyEnd, n.end, ending);
    } else {
      replace(start, bodyStart, ending);
      if (unwrap) replace(bodyEnd, live.end, ";");
    }
    if (ts.isIfStatement(live)) inStatementList.add(live);
    ts.walkPreorder(live, visit);
    return "skip";
  };
  ts.walkPreorder(sf, visit);
  if (edits.length === 0) return null;
  edits.sort((a, b) => a.start - b.start);
  let text = "";
  let at = 0;
  for (const edit of edits) {
    text += sf.text.slice(at, edit.start) + padded(sf.text.slice(edit.start, edit.end), edit.text);
    at = edit.end;
  }
  return text + sf.text.slice(at);
}

/** `text` in place of `replaced`, whose other characters become spaces and
 * keep its line breaks. The text takes the first run of those spaces long
 * enough to hold it, so nothing after the span moves. */
function padded(replaced: string, text: string): string {
  const blank = replaced.replace(/[^\r\n]/g, " ");
  const at = blank.indexOf(" ".repeat(text.length));
  return at < 0 ? text + blank : blank.slice(0, at) + text + blank.slice(at + text.length);
}

/** Whether a top-level import binds `name` locally (`import name from`,
 * `import * as name from`, `import { x as name } from`), which shadows the
 * global as a declaration does. */
function importsBinding(sf: ts.SourceFile, name: string): boolean {
  return sf.statements.nodes.some((s) => {
    if (ts.isImportEqualsDeclaration(s)) return s.name.text === name;
    if (!ts.isImportDeclaration(s) || s.importClause === undefined) return false;
    const clause = s.importClause;
    if (clause.name?.text === name) return true;
    const bindings = clause.namedBindings;
    if (bindings === undefined) return false;
    return ts.isNamespaceImport(bindings)
      ? bindings.name.text === name
      : bindings.elements.nodes.some((element) => element.name.text === name);
  });
}

/** The value of a condition operand `--define` decides, or null. */
function staticValue(expr: ts.Expression, defines: Defines): string | boolean | null {
  const e = unparen(expr);
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return e.text;
  const name = envReadName(e);
  if (name !== null) return definedEnvValue(defines, name) ?? null;
  if (ts.isPrefixUnaryExpression(e) && e.operator === ts.SyntaxKind.ExclamationToken) {
    const operand = staticValue(e.operand, defines);
    return operand === null ? null : !operand;
  }
  if (!ts.isBinaryExpression(e)) return null;
  const left = staticValue(e.left, defines);
  if (left === null) return null;
  switch (e.operatorToken.kind) {
    case ts.SyntaxKind.AmpersandAmpersandToken:
      return left ? staticValue(e.right, defines) : left;
    case ts.SyntaxKind.BarBarToken:
      return left ? left : staticValue(e.right, defines);
  }
  const right = staticValue(e.right, defines);
  // Mixed operand types would compare by coercion.
  if (right === null || typeof left !== typeof right) return null;
  switch (e.operatorToken.kind) {
    case ts.SyntaxKind.EqualsEqualsEqualsToken:
    case ts.SyntaxKind.EqualsEqualsToken:
      return left === right;
    case ts.SyntaxKind.ExclamationEqualsEqualsToken:
    case ts.SyntaxKind.ExclamationEqualsToken:
      return left !== right;
    default:
      return null;
  }
}

/** NAME for `process.env.NAME` or `process.env["NAME"]`, else null. */
function envReadName(e: ts.Expression): string | null {
  if (ts.isPropertyAccessExpression(e) && e.questionDotToken === undefined) {
    return isProcessEnv(e.expression) ? e.name.text : null;
  }
  if (ts.isElementAccessExpression(e) && e.questionDotToken === undefined) {
    const key = unparen(e.argumentExpression);
    return isProcessEnv(e.expression) && ts.isStringLiteral(key) ? key.text : null;
  }
  return null;
}

function isProcessEnv(e: ts.Expression): boolean {
  return (
    ts.isPropertyAccessExpression(e) &&
    e.questionDotToken === undefined &&
    e.name.text === "env" &&
    ts.isIdentifier(e.expression) &&
    e.expression.text === "process"
  );
}

function isStatementList(n: ts.Node | undefined): boolean {
  return ts.isSourceFile(n) || ts.isBlock(n) || ts.isCaseClause(n) || ts.isDefaultClause(n);
}

function declaresBlockScoped(block: ts.Block): boolean {
  return block.statements.nodes.some(
    (s) =>
      ts.isClassDeclaration(s) ||
      ts.isFunctionDeclaration(s) ||
      (ts.isVariableStatement(s) && (s.declarationList.flags & ts.NodeFlags.BlockScoped) !== 0),
  );
}

/** Whether `stmt` declares a function outside nested functions (its
 * binding's hoisting depends on strictness). */
function declaresFunction(stmt: ts.Statement): boolean {
  let found = false;
  ts.walkPreorder(stmt, (n) => {
    if (ts.isFunctionDeclaration(n)) found = true;
    return found || ts.isFunctionLike(n) || isClass(n) ? "skip" : undefined;
  });
  return found;
}

function varNames(stmt: ts.Statement): string[] {
  const names: string[] = [];
  const bind = (name: ts.BindingName): void => {
    if (ts.isIdentifier(name)) names.push(name.text);
    else
      for (const element of name.elements.nodes)
        if (!ts.isOmittedExpression(element)) bind(element.name!);
  };
  ts.walkPreorder(stmt, (n) => {
    if (ts.isFunctionLike(n) || isClass(n)) return "skip";
    if (ts.isVariableDeclarationList(n) && (n.flags & ts.NodeFlags.BlockScoped) === 0)
      for (const declaration of n.declarations.nodes) bind(declaration.name);
    return undefined;
  });
  return names;
}

function isClass(n: ts.Node): boolean {
  return ts.isClassDeclaration(n) || ts.isClassExpression(n);
}
