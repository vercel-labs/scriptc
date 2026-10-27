import * as ts from "./ts7/syntax.js";
import { helperTokens } from "./helper-tokens.js";
import { getTextOfNode, tokenStartOfNode } from "./ts7/node-functions.js";

// Bun's cached node-mode interop helper. Match the complete token stream,
// including its dependencies: helper names alone are not a semantic contract.
const helperSources = new Map<string, string>([
  ["__create", `var __create = Object.create;`],
  ["__getProtoOf", `var __getProtoOf = Object.getPrototypeOf;`],
  ["__defProp", `var __defProp = Object.defineProperty;`],
  ["__getOwnPropNames", `var __getOwnPropNames = Object.getOwnPropertyNames;`],
  ["__hasOwnProp", `var __hasOwnProp = Object.prototype.hasOwnProperty;`],
  ["__accessProp", `function __accessProp(key) { return this[key]; }`],
  ["__toESMCache_node", `var __toESMCache_node;`],
  ["__toESMCache_esm", `var __toESMCache_esm;`],
  [
    "__toESM",
    `var __toESM = (mod, isNodeMode, target) => {
  var canCache = mod != null && typeof mod === "object";
  if (canCache) {
    var cache = isNodeMode ? __toESMCache_node ??= new WeakMap : __toESMCache_esm ??= new WeakMap;
    var cached = cache.get(mod);
    if (cached) return cached;
  }
  target = mod != null ? __create(__getProtoOf(mod)) : {};
  const to = isNodeMode || !mod || !mod.__esModule || !__hasOwnProp.call(mod, "default") ? __defProp(target, "default", { value: mod, enumerable: true }) : target;
  if (mod && typeof mod === "object" || typeof mod === "function") {
    for (let key of __getOwnPropNames(mod))
      if (!__hasOwnProp.call(to, key))
        __defProp(to, key, { get: __accessProp.bind(mod, key), enumerable: true });
  }
  if (canCache) cache.set(mod, to);
  return to;
};`,
  ],
  [
    "__commonJS",
    `var __commonJS = (cb, mod) => () => (mod || cb((mod = { exports: {} }).exports, mod), mod.exports);`,
  ],
]);
const helperShapes = new Map<string, string>();
for (const [name, source] of helperSources) {
  const shape = helperTokens(source);
  if (shape === null) throw new Error(`invalid canonical helper ${name}`);
  helperShapes.set(name, shape);
}

function declaration(stmt: ts.Statement): ts.VariableDeclaration | ts.FunctionDeclaration | null {
  if (ts.isFunctionDeclaration(stmt)) return stmt;
  if (ts.isVariableStatement(stmt) && stmt.declarationList.declarations.nodes.length === 1) {
    return stmt.declarationList.declarations.nodes[0]!;
  }
  return null;
}

interface Edit {
  start: number;
  end: number;
  text: string;
}

function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  ts.walkPreorder(node, visit);
}

/** Is a reference part of an assignment, including destructuring or a loop
 * target? Treat writes through a member conservatively as well. */
function written(node: ts.Node): boolean {
  let child = node;
  for (let p = child.parent; p; child = p, p = p.parent) {
    if (ts.isBinaryExpression(p)) {
      return (
        p.left === child &&
        p.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        p.operatorToken.kind <= ts.SyntaxKind.LastAssignment
      );
    }
    if (ts.isDeleteExpression(p)) return true;
    if (ts.isPrefixUnaryExpression(p) || ts.isPostfixUnaryExpression(p)) {
      return (
        p.operator === ts.SyntaxKind.PlusPlusToken || p.operator === ts.SyntaxKind.MinusMinusToken
      );
    }
    if (ts.isForInStatement(p) || ts.isForOfStatement(p)) return p.initializer === child;
    if (
      !(
        ts.isParenthesizedExpression(p) ||
        ts.isArrayLiteralExpression(p) ||
        ts.isObjectLiteralExpression(p) ||
        ts.isPropertyAssignment(p) ||
        ts.isShorthandPropertyAssignment(p) ||
        ts.isSpreadElement(p) ||
        ts.isPropertyAccessExpression(p) ||
        ts.isElementAccessExpression(p)
      )
    )
      return false;
  }
  return false;
}

/** Admit a bundled CJS factory whose entire body assigns one function
 * literal to module.exports. Its allocation can move to the factory binding:
 * no initializer runs early, and every require sees the same function. Keep
 * node-mode namespaces as records so their initialization point is unchanged.
 * Namespace identity/prototypes/named properties and function receivers must
 * not be observable. Unknown helpers, factories, or uses return null. */
export function rewriteBundledFunctionImports(source: string, sf: ts.SourceFile): string | null {
  const declarations = new Map<
    string,
    { stmt: ts.Statement; decl: ts.VariableDeclaration | ts.FunctionDeclaration }
  >();
  for (const stmt of sf.statements.nodes) {
    const decl = declaration(stmt);
    if (!decl?.name || !ts.isIdentifier(decl.name)) continue;
    if (declarations.has(decl.name.text)) return null;
    declarations.set(decl.name.text, { stmt, decl });
  }
  for (const [name, shape] of helperShapes) {
    const actual = declarations.get(name);
    if (!actual || helperTokens(getTextOfNode(actual.stmt)) !== shape) return null;
  }
  // These initializers must execute before any factory or namespace. The
  // original bundle would throw if a var helper were still undefined.
  let helperEnd = 0;
  for (const name of helperShapes.keys()) {
    const stmt = declarations.get(name)!.stmt;
    if (tokenStartOfNode(stmt) < helperEnd) return null;
    helperEnd = stmt.end;
  }
  const edits: Edit[] = [];
  const allowedRefs = new Set<ts.Node>();
  const factories = new Map<string, ts.Statement>();
  for (const [name, { stmt, decl }] of declarations) {
    if (
      !ts.isVariableDeclaration(decl) ||
      !decl.initializer ||
      !ts.isCallExpression(decl.initializer)
    )
      continue;
    const call = decl.initializer;
    if (!ts.isIdentifier(call.expression) || call.expression.text !== "__commonJS") continue;
    if (
      tokenStartOfNode(stmt) < helperEnd ||
      (ts.canHaveModifiers(stmt) &&
        ts.getModifiers(stmt)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword))
    )
      return null;
    if (call.arguments.nodes.length !== 1) return null;
    const factory = call.arguments.nodes[0]!;
    if (
      !ts.isFunctionExpression(factory) ||
      factory.name ||
      factory.asteriskToken ||
      factory.modifiers?.nodes.length ||
      factory.parameters.nodes.length !== 2 ||
      factory.body.statements.nodes.length !== 1
    )
      return null;
    if (
      factory.parameters.nodes.some(
        (p) => !ts.isIdentifier(p.name) || p.initializer || p.dotDotDotToken,
      )
    )
      return null;
    const [exportsName, moduleName] = factory.parameters.nodes.map(
      (p) => (p.name as ts.Identifier).text,
    );
    const statement = factory.body.statements.nodes[0]!;
    if (!ts.isExpressionStatement(statement) || !ts.isBinaryExpression(statement.expression))
      return null;
    const assignment = statement.expression;
    if (
      assignment.operatorToken.kind !== ts.SyntaxKind.EqualsToken ||
      !ts.isPropertyAccessExpression(assignment.left) ||
      !ts.isIdentifier(assignment.left.expression) ||
      assignment.left.expression.text !== moduleName ||
      assignment.left.name.text !== "exports"
    )
      return null;
    const value = assignment.right;
    if (!ts.isArrowFunction(value) && !ts.isFunctionExpression(value)) return null;
    let unsafe = false;
    walk(value, (n) => {
      if (
        n.kind === ts.SyntaxKind.ThisKeyword ||
        n.kind === ts.SyntaxKind.SuperKeyword ||
        ts.isMetaProperty(n) ||
        (ts.isIdentifier(n) &&
          [exportsName, moduleName, "arguments", "eval", "Function"].includes(n.text))
      )
        unsafe = true;
    });
    if (unsafe) return null;
    // The comma expression prevents inferred naming of an anonymous export.
    edits.push(
      { start: tokenStartOfNode(call), end: tokenStartOfNode(value), text: "(0," },
      { start: value.end, end: call.end, text: ")" },
    );
    factories.set(name, stmt);
    allowedRefs.add(call.expression);
    allowedRefs.add(decl.name);
  }
  if (factories.size === 0) return null;
  const namespaces = new Map<string, ts.VariableDeclaration>();
  for (const [name, { stmt, decl }] of declarations) {
    if (
      !ts.isVariableDeclaration(decl) ||
      !decl.initializer ||
      !ts.isCallExpression(decl.initializer)
    )
      continue;
    const call = decl.initializer;
    if (!ts.isIdentifier(call.expression) || call.expression.text !== "__toESM") continue;
    if (
      tokenStartOfNode(stmt) < helperEnd ||
      (ts.canHaveModifiers(stmt) &&
        ts.getModifiers(stmt)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword))
    )
      return null;
    const [requireCall, mode] = call.arguments.nodes;
    if (
      call.arguments.nodes.length !== 2 ||
      !requireCall ||
      !ts.isCallExpression(requireCall) ||
      !ts.isIdentifier(requireCall.expression) ||
      requireCall.arguments.nodes.length !== 0 ||
      !mode ||
      !ts.isNumericLiteral(mode) ||
      Number(mode.text) !== 1
    )
      return null;
    const factory = factories.get(requireCall.expression.text);
    if (!factory || factory.end > tokenStartOfNode(stmt)) return null;
    edits.push({
      start: tokenStartOfNode(call),
      end: call.end,
      text: `{default:${requireCall.expression.text}}`,
    });
    namespaces.set(name, decl);
    allowedRefs.add(call.expression);
    allowedRefs.add(requireCall.expression);
    allowedRefs.add(decl.name);
  }
  if (namespaces.size === 0) return null;
  const helperSpans = [...helperShapes.keys()].map((name) => declarations.get(name)!.stmt);
  const insideHelper = (n: ts.Node): boolean =>
    helperSpans.some((s) => n.pos >= s.pos && n.end <= s.end);
  let unsafe = false;
  walk(sf, (n) => {
    if (!ts.isIdentifier(n) || allowedRefs.has(n) || insideHelper(n)) return;
    if (n.text === "__commonJS" || n.text === "__toESM" || factories.has(n.text)) unsafe = true;
    if (namespaces.has(n.text)) {
      const p = n.parent;
      if (
        !ts.isPropertyAccessExpression(p) ||
        p.expression !== n ||
        p.name.text !== "default" ||
        written(p)
      )
        unsafe = true;
    }
    // A locally shadowed or directly modified intrinsic invalidates the
    // matched helpers. Direct eval could observe the erased local bindings.
    if (n.text === "eval" && ts.isCallExpression(n.parent) && n.parent.expression === n)
      unsafe = true;
    if (helperShapes.has(n.text) || n.text === "Object" || n.text === "WeakMap") {
      const p = n.parent;
      if (
        written(n) ||
        ((ts.isVariableDeclaration(p) ||
          ts.isParameter(p) ||
          ts.isBindingElement(p) ||
          ts.isFunctionDeclaration(p) ||
          ts.isFunctionExpression(p) ||
          ts.isClassDeclaration(p) ||
          ts.isClassExpression(p) ||
          ts.isImportSpecifier(p) ||
          ts.isNamespaceImport(p) ||
          ts.isImportClause(p)) &&
          p.name === n)
      )
        unsafe = true;
    }
  });
  if (unsafe) return null;
  // Remove only helpers that became dead. Other bundle features may share
  // __defProp, so a recognized declaration alone does not justify erasure.
  const dead = (n: ts.Node): boolean =>
    edits.some((e) => tokenStartOfNode(n) >= e.start && n.end <= e.end);
  const removed = new Set<string>();
  for (let changed = true; changed;) {
    changed = false;
    for (const name of helperShapes.keys()) {
      if (removed.has(name)) continue;
      const stmt = declarations.get(name)!.stmt;
      let live = false;
      walk(sf, (n) => {
        if (
          ts.isIdentifier(n) &&
          n.text === name &&
          !(n.pos >= stmt.pos && n.end <= stmt.end) &&
          !dead(n)
        )
          live = true;
      });
      if (!live) {
        edits.push({ start: tokenStartOfNode(stmt), end: stmt.end, text: "" });
        removed.add(name);
        changed = true;
      }
    }
  }
  let text = source;
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    const pad = source.slice(edit.start, edit.end).replace(/[^\r\n]/g, " ");
    // Keep every source offset/newline. Unusually wrapped calls without room
    // for the shorter spelling stay refused rather than split an identifier.
    const at = edit.text.length === 0 ? 0 : pad.search(new RegExp(` {${edit.text.length}}`));
    if (at < 0) return null;
    text =
      text.slice(0, edit.start) +
      pad.slice(0, at) +
      edit.text +
      pad.slice(at + edit.text.length) +
      text.slice(edit.end);
  }
  return text;
}
