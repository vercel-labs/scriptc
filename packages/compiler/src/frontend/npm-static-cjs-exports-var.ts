/* CommonJS modules that name their export object through a variable:
 *
 *   var ip = exports;
 *   ip.isPrivate = function (addr) { … };
 *   ip.isPublic = function (addr) { return !ip.isPrivate(addr); };
 *
 * `ip` IS the export object, so every member read or write through it is
 * an export. The pass respells those accesses as `exports.<name>`, the
 * form the static export protocol models, and drops the alias declaration
 * (the export object has no storage of its own to bind).
 *
 * Exact only while the variable is nothing but that alias: one top-level
 * declaration initialized with the CommonJS `exports` global, never
 * reassigned, never declared again anywhere in the file (so no nested
 * binding shadows it), and used only as the object of member accesses.
 * `exports` itself must be the global (never declared in the file) and is
 * never reassigned. Other shapes answer null and keep their existing
 * treatment. */
import * as ts from "./ts7/syntax.js";
import { tokenStartOfNode } from "./ts7/node-functions.js";

function unparen(e: ts.Expression): ts.Expression {
  let x = e;
  while (ts.isParenthesizedExpression(x)) x = x.expression;
  return x;
}

function isDeclarationName(id: ts.Identifier): boolean {
  const p = id.parent;
  return (
    ((ts.isVariableDeclaration(p) ||
      ts.isParameter(p) ||
      ts.isBindingElement(p) ||
      ts.isFunctionDeclaration(p) ||
      ts.isFunctionExpression(p) ||
      ts.isClassDeclaration(p) ||
      ts.isClassExpression(p)) &&
      p.name === id) ||
    (ts.isPropertyAccessExpression(p) && p.name === id) ||
    ((ts.isPropertyAssignment(p) || ts.isMethodDeclaration(p) || ts.isPropertyDeclaration(p)) &&
      p.name === id)
  );
}

function isFunctionScope(n: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(n) ||
    ts.isFunctionExpression(n) ||
    ts.isArrowFunction(n) ||
    ts.isMethodDeclaration(n) ||
    ts.isGetAccessorDeclaration(n) ||
    ts.isSetAccessorDeclaration(n) ||
    ts.isConstructorDeclaration(n)
  );
}

function bindsName(name: ts.BindingName | undefined, text: string): boolean {
  if (name === undefined) return false;
  if (ts.isIdentifier(name)) return name.text === text;
  for (const element of name.elements.nodes) {
    if (!ts.isOmittedExpression(element) && bindsName(element.name, text)) return true;
  }
  return false;
}

/** True when one of `statements` declares `text` lexically: a let/const,
 * or a class or function declaration. */
function declaresLexically(statements: readonly ts.Statement[], text: string): boolean {
  for (const stmt of statements) {
    if (
      ts.isVariableStatement(stmt) &&
      (stmt.declarationList.flags & ts.NodeFlags.BlockScoped) !== 0 &&
      stmt.declarationList.declarations.nodes.some((d) => bindsName(d.name, text))
    )
      return true;
    if ((ts.isClassDeclaration(stmt) || ts.isFunctionDeclaration(stmt)) && stmt.name?.text === text)
      return true;
  }
  return false;
}

/** True when a function body declares `text` with `var` (or a function
 * declaration in a nested block) anywhere outside nested functions. */
function declaresVar(body: ts.Node, text: string): boolean {
  let found = false;
  ts.walkPreorder(body, (n) => {
    if (found) return "stop";
    if (n === body) return undefined;
    if (isFunctionScope(n)) {
      if (ts.isFunctionDeclaration(n) && n.name?.text === text) found = true;
      return "skip";
    }
    if (
      ts.isVariableDeclarationList(n) &&
      (n.flags & ts.NodeFlags.BlockScoped) === 0 &&
      n.declarations.nodes.some((d) => bindsName(d.name, text))
    )
      found = true;
    return undefined;
  });
  return found;
}

/** True when `scope` declares `text` itself, so references inside it name
 * that binding instead of the module-level alias: a function's parameters,
 * own name, `var`s and the let/const, class and function declarations of
 * its body; a block's or case block's own let/const, class and function
 * declarations; a catch binding; a for loop's let/const. A let/const in a
 * nested block shadows only that block, which the walk reaches as its own
 * scope. */
function shadows(scope: ts.Node, text: string): boolean {
  if (isFunctionScope(scope)) {
    const fn = scope as ts.SignatureDeclaration;
    if (fn.parameters.nodes.some((p) => bindsName(p.name, text))) return true;
    if (ts.isFunctionExpression(scope) && scope.name?.text === text) return true;
    const body = (scope as { body?: ts.Node }).body;
    if (body === undefined || !ts.isBlock(body)) return false;
    return declaresVar(body, text) || declaresLexically(body.statements.nodes, text);
  }
  if (ts.isBlock(scope)) return declaresLexically(scope.statements.nodes, text);
  if (ts.isCaseBlock(scope))
    return declaresLexically(
      scope.clauses.nodes.flatMap((clause) => clause.statements.nodes),
      text,
    );
  if (ts.isCatchClause(scope)) return bindsName(scope.variableDeclaration?.name, text);
  if (ts.isForStatement(scope) || ts.isForInStatement(scope) || ts.isForOfStatement(scope)) {
    const init = scope.initializer;
    return (
      init !== undefined &&
      ts.isVariableDeclarationList(init) &&
      (init.flags & ts.NodeFlags.BlockScoped) !== 0 &&
      init.declarations.nodes.some((d) => bindsName(d.name, text))
    );
  }
  if (ts.isClassExpression(scope)) return scope.name?.text === text;
  return false;
}

export function normalizeCjsExportsVar(sf: ts.SourceFile): string | null {
  const source = sf.text;
  if (!/\b(?:var|let|const)\s+[A-Za-z_$][\w$]*\s*=\s*exports\s*[;,\n]/.test(source)) return null;
  if (!sf.fileName.endsWith(".cjs") && ts.isExternalModule(sf)) return null;
  let alias: { name: string; stmt: ts.VariableStatement } | null = null;
  for (const stmt of sf.statements.nodes) {
    if (!ts.isVariableStatement(stmt)) continue;
    const decls = stmt.declarationList.declarations.nodes;
    if (decls.length !== 1) continue;
    const decl = decls[0]!;
    const init = decl.initializer !== undefined ? unparen(decl.initializer) : undefined;
    if (
      ts.isIdentifier(decl.name) &&
      init !== undefined &&
      ts.isIdentifier(init) &&
      init.text === "exports"
    ) {
      if (alias !== null) return null; /* two aliases: keep the plain treatment */
      alias = { name: decl.name.text, stmt };
    }
  }
  if (alias === null) return null;
  const name = alias.name;
  const aliasDecl = alias.stmt.declarationList.declarations.nodes[0]!;
  const edits: { start: number; end: number; text: string }[] = [];
  let ok = true;
  ts.walkPreorder(sf, (n) => {
    if (!ok) return "stop";
    if (n.kind >= ts.SyntaxKind.FirstJSDocNode && n.kind <= ts.SyntaxKind.LastJSDocNode)
      return "skip";
    if (
      ts.isBinaryExpression(n) &&
      n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(unparen(n.left)) &&
      (unparen(n.left) as ts.PropertyAccessExpression).name.text === "exports" &&
      ts.isIdentifier((unparen(n.left) as ts.PropertyAccessExpression).expression) &&
      ((unparen(n.left) as ts.PropertyAccessExpression).expression as ts.Identifier).text ===
        "module"
    ) {
      ok = false; /* module.exports replaced: the alias no longer names the exports */
      return "stop";
    }
    // A scope that declares the alias's name again: its references name
    // that binding, not the export object.
    if (
      n !== sf &&
      (isFunctionScope(n) ||
        ts.isBlock(n) ||
        ts.isCaseBlock(n) ||
        ts.isCatchClause(n) ||
        ts.isForStatement(n) ||
        ts.isForInStatement(n) ||
        ts.isForOfStatement(n) ||
        ts.isClassExpression(n)) &&
      shadows(n, name)
    )
      return "skip";
    if (!ts.isIdentifier(n)) return undefined;
    if (n.text === "exports" && n !== aliasDecl.initializer) {
      // `exports` declared in the file, or the export object replaced
      if (isDeclarationName(n) && !ts.isPropertyAccessExpression(n.parent)) ok = false;
      const p = n.parent;
      if (
        ts.isBinaryExpression(p) &&
        p.left === n &&
        p.operatorToken.kind === ts.SyntaxKind.EqualsToken
      )
        ok = false;
      return undefined;
    }
    if (n.text !== name) return undefined;
    if (n === aliasDecl.name) return undefined;
    const p = n.parent;
    if (ts.isPropertyAccessExpression(p) && p.name === n) return undefined;
    if ((ts.isPropertyAssignment(p) || ts.isMethodDeclaration(p)) && p.name === n) return undefined;
    if (isDeclarationName(n)) {
      ok = false; /* declared again (a shadowing binding): not a plain alias */
      return undefined;
    }
    if (
      (ts.isPropertyAccessExpression(p) || ts.isElementAccessExpression(p)) &&
      p.expression === n
    ) {
      edits.push({ start: tokenStartOfNode(n), end: n.end, text: "exports" });
      return undefined;
    }
    ok = false; /* used as a value, assigned, or passed along */
    return undefined;
  });
  if (!ok || edits.length === 0) return null;
  edits.push({ start: tokenStartOfNode(alias.stmt), end: alias.stmt.end, text: "" });
  edits.sort((a, b) => a.start - b.start);
  let out = "";
  let at = 0;
  for (const e of edits) {
    out += source.slice(at, e.start) + e.text;
    at = e.end;
  }
  return out + source.slice(at);
}
