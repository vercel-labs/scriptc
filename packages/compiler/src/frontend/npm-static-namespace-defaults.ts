/* The guarded namespace declaration of pre-module JavaScript:
 *
 *   var ns = ns || {};
 *
 * In a module (CommonJS or ES), `var` is module-local and hoisted, so the
 * read in its own initializer sees `undefined` unless something writes the
 * variable first. When nothing else in the file ever writes it (no other
 * declaration, assignment or update of that name anywhere, no function or
 * class of that name), no earlier top-level statement mentions it, and it
 * is not a name a CommonJS module's wrapper defines (`exports`, `module`,
 * ...), the initializer is its right operand: `var ns = {};`. Inference then types
 * the namespace from that literal and the members later statements add,
 * instead of `any` (the self-reference makes the checker give up). `??`
 * is the same. Anything else keeps the original text. */
import * as ts from "./ts7/syntax.js";
import { tokenStartOfNode } from "./ts7/node-functions.js";
import { applyEdits, unparen, type Edit } from "./npm-static-bundled-chunks.js";

/** Names a CommonJS module's wrapper function defines before its first
 * statement: its parameters and its arguments object. `var exports =
 * exports || {}` keeps the module's export object, not a fresh one. */
const COMMONJS_WRAPPER_NAMES = new Set([
  "exports",
  "require",
  "module",
  "__filename",
  "__dirname",
  "arguments",
]);

/** A cheap probe: some `var X = X ||` or `?? ` may be present. */
export function mayHoldNamespaceDefault(source: string): boolean {
  return /\bvar\s+([A-Za-z_$][\w$]*)\s*=\s*\(?\s*\1\s*(\|\||\?\?)/.test(source);
}

/** The module text with each guarded namespace declaration respelled as a
 * plain one, or null when there is none. */
export function rewriteNamespaceDefaults(sf: ts.SourceFile): string | null {
  const stmts = sf.statements.nodes;
  const edits: Edit[] = [];
  for (let i = 0; i < stmts.length; i++) {
    const stmt = stmts[i]!;
    if (!ts.isVariableStatement(stmt)) continue;
    const list = stmt.declarationList;
    if ((list.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) !== 0) continue;
    for (const decl of list.declarations.nodes) {
      if (!ts.isIdentifier(decl.name) || decl.initializer === undefined) continue;
      const name = decl.name.text;
      const init = unparen(decl.initializer);
      if (
        !ts.isBinaryExpression(init) ||
        (init.operatorToken.kind !== ts.SyntaxKind.BarBarToken &&
          init.operatorToken.kind !== ts.SyntaxKind.QuestionQuestionToken)
      )
        continue;
      const left = unparen(init.left);
      if (!ts.isIdentifier(left) || left.text !== name) continue;
      if (COMMONJS_WRAPPER_NAMES.has(name)) continue;
      if (mentionedBefore(stmts, i, name) || writtenElsewhere(sf, name, decl)) continue;
      const right = init.right;
      edits.push({
        start: tokenStartOfNode(decl.initializer),
        end: decl.initializer.end,
        // A literal stays bare: inference types `var ns = {}` from the
        // members later statements add (a parenthesized one it does not).
        text:
          ts.isObjectLiteralExpression(unparen(right)) ||
          ts.isArrayLiteralExpression(unparen(right))
            ? sf.text.slice(tokenStartOfNode(right), right.end)
            : `(${sf.text.slice(tokenStartOfNode(right), right.end)})`,
      });
    }
  }
  if (edits.length === 0) return null;
  return applyEdits(sf.text, 0, sf.text.length, edits);
}

/** Whether a top-level statement before index `at` mentions `name`. */
function mentionedBefore(stmts: readonly ts.Statement[], at: number, name: string): boolean {
  for (let i = 0; i < at; i++) {
    let found = false;
    ts.walkPreorder(stmts[i]!, (n) => {
      if (found) return "stop";
      if (ts.isIdentifier(n) && n.text === name) found = true;
      return undefined;
    });
    if (found) return true;
  }
  return false;
}

/** Whether anything other than `decl` declares or writes `name`. */
function writtenElsewhere(sf: ts.SourceFile, name: string, decl: ts.VariableDeclaration): boolean {
  let written = false;
  ts.walkPreorder(sf, (n) => {
    if (written) return "stop";
    if (n === decl.name) return undefined;
    if (ts.isBinaryExpression(n) && isAssignmentOperator(n.operatorToken.kind)) {
      if (assignsName(n.left, name)) written = true;
    } else if (
      (ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) &&
      (n.operator === ts.SyntaxKind.PlusPlusToken ||
        n.operator === ts.SyntaxKind.MinusMinusToken) &&
      isName(n.operand, name)
    ) {
      written = true;
    } else if (
      (ts.isFunctionDeclaration(n) || ts.isClassDeclaration(n)) &&
      n.name !== undefined &&
      n.name.text === name
    ) {
      written = true;
    } else if (
      (ts.isVariableDeclaration(n) || ts.isParameter(n) || ts.isBindingElement(n)) &&
      n !== decl &&
      n.name !== undefined &&
      bindsName(n.name, name)
    ) {
      // Another declaration of the name (a redeclaration, or a local that
      // shadows it) — keep the original text rather than reason about it.
      written = true;
    } else if (
      (ts.isForInStatement(n) || ts.isForOfStatement(n)) &&
      !ts.isVariableDeclarationList(n.initializer) &&
      assignsName(n.initializer, name)
    ) {
      written = true;
    }
    return undefined;
  });
  return written;
}

function bindsName(binding: ts.Node, name: string): boolean {
  if (ts.isIdentifier(binding)) return binding.text === name;
  let found = false;
  ts.walkPreorder(binding, (n) => {
    if (found) return "stop";
    if (ts.isIdentifier(n) && n.text === name) found = true;
    return undefined;
  });
  return found;
}

/** Whether an assignment target may write `name`: the name itself, or a
 * destructuring pattern that mentions it anywhere (over-approximated: a
 * property key of that name counts too). */
function assignsName(target: ts.Node, name: string): boolean {
  const t = unparen(target as ts.Expression);
  if (ts.isArrayLiteralExpression(t) || ts.isObjectLiteralExpression(t)) return bindsName(t, name);
  return isName(t, name);
}

function isName(node: ts.Node, name: string): boolean {
  const n = unparen(node as ts.Expression);
  return ts.isIdentifier(n) && n.text === name;
}

function isAssignmentOperator(kind: ts.SyntaxKind): boolean {
  return kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment;
}
