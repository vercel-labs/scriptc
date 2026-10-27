/* TypeScript's enum emit in a compiled package: a bare `var` filled by an
 * immediately invoked function that writes each member onto its argument.
 *
 *   var Kind;
 *   (function (Kind) {
 *       Kind["Identifier"] = "Identifier";
 *       Kind[Kind["Zero"] = 0] = "Zero";
 *   })(Kind || (exports.Kind = Kind = {}));
 *
 * Inference types the variable from the empty object the argument creates,
 * so every member read lands on `{}`. When every member value is a literal,
 * the enum is that object literal: the declaration becomes
 * `var Kind = { ... };` and the call becomes the export assignment it
 * performs. Keys keep Node's own-property order (integer keys ascending,
 * then the rest in insertion order, a later write replacing an earlier
 * value in place), so enumeration observes the same object.
 *
 * Accepted argument spellings: `Kind || (exports.Kind = Kind = {})`
 * (TypeScript 5), `Kind = exports.Kind || (exports.Kind = {})` (earlier
 * releases) and `Kind || (Kind = {})` (an enum the module does not
 * export). Merged declarations, computed or referencing members, and any
 * other write to the variable keep the original text. */
import * as ts from "./ts7/syntax.js";
import { tokenStartOfNode } from "./ts7/node-functions.js";
import { applyEdits, unparen, type Edit } from "./npm-static-bundled-chunks.js";

/** True when the text may hold an enum IIFE (a cheap probe). */
export function mayHoldEnumIife(source: string): boolean {
  return source.includes("(function (") && source.includes("|| (");
}

/** The module text with each literal-valued enum IIFE respelled as an
 * object literal, or null when there is none. */
export function rewriteEnumIifes(sf: ts.SourceFile): string | null {
  const stmts = sf.statements.nodes;
  const edits: Edit[] = [];
  for (let i = 1; i < stmts.length; i++) {
    const decl = bareVarName(stmts[i - 1]!);
    if (decl === null) continue;
    const iife = enumIife(stmts[i]!, decl);
    if (iife === null || writtenElsewhere(sf, decl, stmts[i]!)) continue;
    // Modifiers before `var` stay: `export var Kind;` (an ES module's
    // enum) keeps exporting the binding.
    const declaration = stmts[i - 1] as ts.VariableStatement;
    const modifiers = sf.text.slice(
      tokenStartOfNode(declaration),
      tokenStartOfNode(declaration.declarationList),
    );
    edits.push({
      start: tokenStartOfNode(declaration),
      end: declaration.end,
      text: `${modifiers}var ${decl} = ${objectLiteral(iife.members)};`,
    });
    edits.push({
      start: tokenStartOfNode(stmts[i]!),
      end: stmts[i]!.end,
      text: iife.exportName === null ? "" : `exports.${iife.exportName} = ${decl};`,
    });
  }
  if (edits.length === 0) return null;
  return applyEdits(sf.text, 0, sf.text.length, edits);
}

/** `var Name;`: one declarator, no initializer. */
function bareVarName(stmt: ts.Statement): string | null {
  if (!ts.isVariableStatement(stmt)) return null;
  const list = stmt.declarationList;
  if ((list.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) !== 0) return null;
  const decls = list.declarations.nodes;
  if (decls.length !== 1) return null;
  const d = decls[0]!;
  if (d.initializer !== undefined || !ts.isIdentifier(d.name)) return null;
  return d.name.text;
}

type Members = Map<string, string | number>;

function enumIife(
  stmt: ts.Statement,
  name: string,
): { members: Members; exportName: string | null } | null {
  if (!ts.isExpressionStatement(stmt)) return null;
  const call = unparen(stmt.expression);
  if (!ts.isCallExpression(call) || call.arguments.nodes.length !== 1) return null;
  const fn = unparen(call.expression);
  if (!ts.isFunctionExpression(fn) || fn.name !== undefined || fn.asteriskToken !== undefined)
    return null;
  if (fn.modifiers !== undefined && fn.modifiers.nodes.length > 0) return null;
  const params = fn.parameters.nodes;
  if (params.length !== 1) return null;
  const param = params[0]!;
  if (!ts.isIdentifier(param.name) || param.initializer !== undefined) return null;
  if (param.dotDotDotToken !== undefined) return null;
  const exportName = enumArgument(call.arguments.nodes[0]!, name);
  if (exportName === undefined) return null;
  const members = enumMembers(fn.body.statements.nodes, param.name.text);
  return members === null ? null : { members, exportName };
}

/** The export name the argument assigns (null: not exported), or
 * undefined when it is not one of the enum spellings. */
function enumArgument(arg: ts.Expression, name: string): string | null | undefined {
  const e = unparen(arg);
  if (!ts.isBinaryExpression(e)) return undefined;
  // `Kind = exports.Kind || (exports.Kind = {})`
  if (e.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
    if (!isName(e.left, name)) return undefined;
    const or = unparen(e.right);
    if (!ts.isBinaryExpression(or) || or.operatorToken.kind !== ts.SyntaxKind.BarBarToken)
      return undefined;
    const exported = exportsMember(or.left);
    if (exported === null) return undefined;
    const init = unparen(or.right);
    if (
      !ts.isBinaryExpression(init) ||
      init.operatorToken.kind !== ts.SyntaxKind.EqualsToken ||
      exportsMember(init.left) !== exported ||
      !isEmptyObject(init.right)
    )
      return undefined;
    return exported;
  }
  if (e.operatorToken.kind !== ts.SyntaxKind.BarBarToken || !isName(e.left, name)) return undefined;
  const init = unparen(e.right);
  if (!ts.isBinaryExpression(init) || init.operatorToken.kind !== ts.SyntaxKind.EqualsToken)
    return undefined;
  // `Kind || (Kind = {})`
  if (isName(init.left, name)) return isEmptyObject(init.right) ? null : undefined;
  // `Kind || (exports.Kind = Kind = {})`
  const exported = exportsMember(init.left);
  const inner = unparen(init.right);
  if (
    exported === null ||
    !ts.isBinaryExpression(inner) ||
    inner.operatorToken.kind !== ts.SyntaxKind.EqualsToken ||
    !isName(inner.left, name) ||
    !isEmptyObject(inner.right)
  )
    return undefined;
  return exported;
}

/** The members the body writes, or null when a statement is anything but
 * a literal member write (`E["K"] = v`, `E.K = v`, or the reverse-mapped
 * `E[E["K"] = v] = "K"`). */
function enumMembers(body: readonly ts.Statement[], param: string): Members | null {
  const members: Members = new Map();
  for (const stmt of body) {
    if (!ts.isExpressionStatement(stmt)) return null;
    const e = stmt.expression;
    if (!ts.isBinaryExpression(e) || e.operatorToken.kind !== ts.SyntaxKind.EqualsToken)
      return null;
    const value = literalValue(e.right);
    if (value === null) return null;
    const key = memberKey(e.left, param);
    if (key !== null) {
      members.set(key, value);
      continue;
    }
    // E[E["K"] = v] = "K"
    const target = e.left;
    if (!ts.isElementAccessExpression(target) || !isName(target.expression, param)) return null;
    const inner = unparen(target.argumentExpression);
    if (!ts.isBinaryExpression(inner) || inner.operatorToken.kind !== ts.SyntaxKind.EqualsToken)
      return null;
    const innerKey = memberKey(inner.left, param);
    const innerValue = literalValue(inner.right);
    if (innerKey === null || innerValue === null) return null;
    members.set(innerKey, innerValue);
    members.set(propertyKey(innerValue), value);
  }
  return members.size > 0 ? members : null;
}

function memberKey(target: ts.Expression, param: string): string | null {
  if (ts.isElementAccessExpression(target) && isName(target.expression, param)) {
    const k = unparen(target.argumentExpression);
    return ts.isStringLiteral(k) || ts.isNoSubstitutionTemplateLiteral(k) ? k.text : null;
  }
  if (
    ts.isPropertyAccessExpression(target) &&
    isName(target.expression, param) &&
    ts.isIdentifier(target.name)
  )
    return target.name.text;
  return null;
}

function literalValue(expr: ts.Expression): string | number | null {
  const e = unparen(expr);
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return e.text;
  if (ts.isNumericLiteral(e)) return numberOf(e.text);
  if (
    ts.isPrefixUnaryExpression(e) &&
    e.operator === ts.SyntaxKind.MinusToken &&
    ts.isNumericLiteral(e.operand)
  ) {
    const n = numberOf(e.operand.text);
    return n === null ? null : -n;
  }
  return null;
}

function numberOf(text: string): number | null {
  if (!/^(?:\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|0[xX][0-9a-fA-F]+)$/.test(text)) return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

/** ToPropertyKey of a member value. */
function propertyKey(value: string | number): string {
  return typeof value === "string" ? value : String(value);
}

/** The canonical array-index keys JavaScript enumerates first. */
function isIndexKey(key: string): boolean {
  return /^(?:0|[1-9]\d*)$/.test(key) && Number(key) < 4294967295;
}

function objectLiteral(members: Members): string {
  const keys = [...members.keys()];
  const ordered = [
    ...keys.filter(isIndexKey).sort((a, b) => Number(a) - Number(b)),
    ...keys.filter((k) => !isIndexKey(k)),
  ];
  const parts = ordered.map((k) => {
    const v = members.get(k)!;
    const value = typeof v === "string" ? JSON.stringify(v) : Object.is(v, -0) ? "-0" : String(v);
    return `${isIndexKey(k) ? k : JSON.stringify(k)}: ${value}`;
  });
  return `{ ${parts.join(", ")} }`;
}

/** True when the module writes `name` anywhere outside the enum call. */
function writtenElsewhere(sf: ts.SourceFile, name: string, iife: ts.Statement): boolean {
  const start = tokenStartOfNode(iife);
  const end = iife.end;
  let written = false;
  ts.walkPreorder(sf, (n) => {
    if (written) return "stop";
    if (n.pos >= start && n.end <= end) return "skip";
    if (ts.isBinaryExpression(n) && isAssignmentOperator(n.operatorToken.kind)) {
      if (isName(n.left, name)) written = true;
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
    }
    return undefined;
  });
  return written;
}

function isAssignmentOperator(kind: ts.SyntaxKind): boolean {
  return kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment;
}

function isName(e: ts.Expression, name: string): boolean {
  const u = unparen(e);
  return ts.isIdentifier(u) && u.text === name;
}

function exportsMember(e: ts.Expression): string | null {
  const u = unparen(e);
  return ts.isPropertyAccessExpression(u) &&
    ts.isIdentifier(u.expression) &&
    u.expression.text === "exports" &&
    ts.isIdentifier(u.name)
    ? u.name.text
    : null;
}

function isEmptyObject(e: ts.Expression): boolean {
  const u = unparen(e);
  return ts.isObjectLiteralExpression(u) && u.properties.nodes.length === 0;
}
