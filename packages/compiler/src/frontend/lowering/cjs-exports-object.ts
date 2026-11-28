/* A CommonJS module's own exports object, seen from inside the module.
 *
 * The compiled module system has no reflective exports object: each export
 * is a module global (collectGlobals) or alias plumbing to a declaration.
 * Inside the module that is enough for
 *
 *   - member reads and member calls (`exports.f`, `exports.f(x)`,
 *     `module.exports.f(x)`): they are the member's export global, the
 *     storage every `exports.f =` statement assigns;
 *   - identity comparisons of the object itself (`root === module.exports`,
 *     `exports === module.exports`): while the module never replaces
 *     `module.exports` and never rebinds `exports`, both name the module's
 *     original exports object, which top-level `this` already represents
 *     (lowerCjsTopLevelThis). `typeof` and truthiness keep their existing
 *     lowerings.
 *
 * Every other use of the object as a value (passing it to a function,
 * storing it, reading a member through an alias) would need a real object
 * whose properties are the exports; those uses keep a named refusal. The
 * dynamic CommonJS module object is the two-tier design's S9 stage. */
import * as ts from "../ts7/adapter.js";
import type { Lowerer } from "./lowerer.js";
import {
  cjsExportAssignmentOf,
  cjsExportDiscardReason,
  cjsExportTargetLiteral,
  isCjsJsFile,
  isJsSourceFile,
  isEsModuleStamp,
  isModuleExportsAccess,
  isRequireStatement,
  locOf,
} from "../program.js";
import {
  cjsNamespaceTargetOf,
  cjsWholeExportValueOf,
  inlineProgramRequireOf,
} from "./cjs-inline-require.js";
import { isCjsModuleGlobal } from "./lower-node-module.js";
import { cjsAccessorValue } from "./lower-exprs.js";
import { requireBindingTdzCheck } from "./require-initialization.js";
import { bindingNeverReassigned } from "./binding-analysis.js";
import { moduleExportIgnoresThis } from "./module-member-this.js";
import {
  BOOL,
  DYN,
  STRING,
  VOID,
  type IrExpr,
  type IrGlobal,
  type IrStmt,
  type SrcLoc,
} from "../../ir/ir.js";

/** True for the CommonJS wrapper's `exports` binding (not shadowed by any
 * source declaration) in a CommonJS JS file. */
export function isCjsExportsIdentifier(lowerer: Lowerer, node: ts.Expression): boolean {
  if (!ts.isIdentifier(node) || node.text !== "exports") return false;
  if (!isCjsJsFile(ts.getSourceFileOfNode(node), lowerer.program)) return false;
  const symbol = lowerer.checker.getSymbolAtLocation(node);
  const decls = symbol ? symbol.declarations : [];
  return !decls.some(
    (d) =>
      !ts.getSourceFileOfNode(d).isDeclarationFile &&
      (ts.isVariableDeclaration(d) ||
        ts.isParameter(d) ||
        ts.isBindingElement(d) ||
        ts.isFunctionDeclaration(d) ||
        ts.isClassDeclaration(d) ||
        ts.isImportSpecifier(d) ||
        ts.isNamespaceImport(d) ||
        ts.isImportEqualsDeclaration(d)),
  );
}

/** `exports` in a CommonJS JavaScript file where the checker resolves no
 * symbol for it (the module assigns no member of it, so nothing declares
 * the name for the checker): still the module's exports object, which Node
 * passes to every CommonJS module, never an undeclared name. The folds that
 * answer `typeof <undeclared name>` with "undefined" ask this first. */
export function isUnresolvedCjsExports(lowerer: Lowerer, node: ts.Expression): boolean {
  let inner = node;
  while (ts.isParenthesizedExpression(inner)) inner = inner.expression;
  return (
    isCjsExportsIdentifier(lowerer, inner) &&
    lowerer.checker.getSymbolAtLocation(inner) === undefined
  );
}

/** `module.exports` over the CommonJS `module` global in a CommonJS file. */
export function isCjsModuleExports(lowerer: Lowerer, node: ts.Expression): boolean {
  return (
    isModuleExportsAccess(node) &&
    isCjsModuleGlobal(lowerer, node.expression) &&
    isCjsJsFile(ts.getSourceFileOfNode(node), lowerer.program)
  );
}

/** The export global behind a same-module member access `exports.<name>` /
 * `module.exports.<name>`, or null (identifier-valued members are alias
 * plumbing with no storage, and other receivers are not the exports
 * object). */
export function cjsInFileExportGlobalOf(
  lowerer: Lowerer,
  access: ts.PropertyAccessExpression,
): IrGlobal | null {
  if (access.questionDotToken || !ts.isIdentifier(access.name)) return null;
  const sf = ts.getSourceFileOfNode(access);
  const recv =
    isModuleExportsAccess(access.expression) ||
    (ts.isIdentifier(access.expression) &&
      access.expression.text === "exports" &&
      !lowerer.resolveLocal(access.expression) &&
      !lowerer.globalOf(access.expression));
  if (!recv || !isCjsJsFile(sf, lowerer.program)) return null;
  const sym =
    lowerer.checker.getSymbolAtLocation(access.name) ??
    lowerer.cjsModuleExportSymbol(sf, access.name.text);
  const resolved =
    sym !== undefined && sym.flags & ts.SymbolFlags.Alias
      ? lowerer.checker.getAliasedSymbol(sym)
      : sym;
  const g =
    (sym ? lowerer.globalsBySymbol.get(sym) : undefined) ??
    (resolved ? lowerer.globalsBySymbol.get(resolved) : undefined) ??
    null;
  if (g === null || sym === undefined || !declaredOnlyOutside(sym, sf)) return g;
  return replacementExportsAccess(access, sf) ? g : null;
}

/** True when every declaration of `sym` is in a file other than `sf`. */
function declaredOnlyOutside(sym: ts.Symbol, sf: ts.SourceFile): boolean {
  return (
    sym.declarations.length > 0 && sym.declarations.every((d) => ts.getSourceFileOfNode(d) !== sf)
  );
}

/** Whether `access` reads `module.exports` after the module replaced it with
 * another module's exports. The checker gives members of `module.exports` and
 * `exports` the replacement's symbols everywhere in the file, but `exports`
 * keeps the original object, and so does `module.exports` before the
 * replacement runs. Only top-level code after the `module.exports = ...`
 * statement is known to run after it. */
function replacementExportsAccess(access: ts.PropertyAccessExpression, sf: ts.SourceFile): boolean {
  if (!isModuleExportsAccess(access.expression)) return false;
  const whole = cjsWholeExportValueOf(sf);
  if (whole === null || ts.tokenStartOfNode(access) < whole.assign.end) return false;
  for (let p: ts.Node | undefined = access.parent; p !== undefined && p !== sf; p = p.parent) {
    if (ts.isFunctionLike(p) || ts.isClassDeclaration(p) || ts.isClassExpression(p)) return false;
  }
  return true;
}

/** Whether `node` is an operand of an equality operator: only its identity
 * is observed. */
function identityUse(node: ts.Expression): boolean {
  let child: ts.Node = node;
  let parent = node.parent;
  while (parent !== undefined && ts.isParenthesizedExpression(parent)) {
    child = parent;
    parent = parent.parent;
  }
  if (parent === undefined || !ts.isBinaryExpression(parent)) return false;
  const op = parent.operatorToken.kind;
  return (
    (op === ts.SyntaxKind.EqualsEqualsEqualsToken ||
      op === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
      op === ts.SyntaxKind.EqualsEqualsToken ||
      op === ts.SyntaxKind.ExclamationEqualsToken) &&
    (parent.left === child || parent.right === child)
  );
}

/** Uses whose answer does not need the object: `typeof`, `void`, and
 * truthiness tests (their existing lowerings answer them). */
function answeredWithoutObject(node: ts.Expression): boolean {
  let child: ts.Node = node;
  let parent = node.parent;
  while (parent !== undefined && ts.isParenthesizedExpression(parent)) {
    child = parent;
    parent = parent.parent;
  }
  if (parent === undefined) return false;
  if (ts.isTypeOfExpression(parent) || ts.isVoidExpression(parent)) return true;
  return truthinessOnly(child as ts.Expression);
}

function truthinessOnly(node: ts.Expression): boolean {
  let child: ts.Node = node;
  for (let parent = node.parent; parent !== undefined; child = parent, parent = parent.parent) {
    if (ts.isParenthesizedExpression(parent)) continue;
    if (ts.isPrefixUnaryExpression(parent))
      return parent.operator === ts.SyntaxKind.ExclamationToken;
    if (
      ts.isBinaryExpression(parent) &&
      (parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
        parent.operatorToken.kind === ts.SyntaxKind.BarBarToken)
    )
      continue;
    if (ts.isIfStatement(parent) || ts.isWhileStatement(parent) || ts.isDoStatement(parent))
      return parent.expression === child;
    if (ts.isForStatement(parent)) return parent.condition === child;
    if (ts.isConditionalExpression(parent)) return parent.condition === child;
    return false;
  }
  return false;
}

/** Which of the module's exports bindings the file ever assigns (any
 * nesting, compound operators included), cached per file on the lowerer
 * (Lowerer.cjsExportsAssignments). */
function exportsAssignments(
  lowerer: Lowerer,
  sf: ts.SourceFile,
): { exports: boolean; moduleExports: boolean } {
  const cached = lowerer.cjsExportsAssignments.get(sf);
  if (cached !== undefined) return cached;
  const out = { exports: false, moduleExports: false };
  lowerer.cjsExportsAssignments.set(sf, out);
  ts.walkPreorder(sf, (node) => {
    // A fresh `exports = module.exports = {}` reset leaves both bindings
    // naming one (new, empty) exports object for the rest of the module.
    if (ts.isExpressionStatement(node) && isFreshExportsReset(lowerer, node)) return "skip";
    if (
      !ts.isBinaryExpression(node) ||
      node.operatorToken.kind < ts.SyntaxKind.FirstAssignment ||
      node.operatorToken.kind > ts.SyntaxKind.LastAssignment
    )
      return undefined;
    let target = node.left;
    while (ts.isParenthesizedExpression(target)) target = target.expression;
    if (isCjsModuleExports(lowerer, target)) out.moduleExports = true;
    if (isCjsExportsIdentifier(lowerer, target)) out.exports = true;
    return undefined;
  });
  return out;
}

/** Whether `node` still names the module's ORIGINAL exports object wherever
 * it runs: `exports` unless the file rebinds it; `module.exports` unless the
 * file rebinds `exports` or replaces `module.exports`. */
function namesOriginalExports(lowerer: Lowerer, node: ts.Expression): boolean {
  const assigned = exportsAssignments(lowerer, ts.getSourceFileOfNode(node));
  if (assigned.exports) return false;
  return ts.isIdentifier(node) || !assigned.moduleExports;
}

/** The uses this module answers with the original exports object: identity
 * comparisons and `typeof` of either spelling, and truthiness or `void` of
 * `exports` (`module.exports` truthiness keeps its existing fold). */
function objectAnsweredUse(node: ts.Expression): boolean {
  if (identityUse(node)) return true;
  let parent = node.parent;
  while (parent !== undefined && ts.isParenthesizedExpression(parent)) parent = parent.parent;
  if (parent !== undefined && ts.isTypeOfExpression(parent)) return true;
  return ts.isIdentifier(node) && answeredWithoutObject(node);
}

/** Whether `node` (`exports` or `module.exports`) is a use of the module's
 * exports object as a VALUE (not a member access receiver, not an
 * assignment target). */
export function isCjsExportsObjectValue(lowerer: Lowerer, node: ts.Expression): boolean {
  if (!isCjsExportsIdentifier(lowerer, node) && !isCjsModuleExports(lowerer, node)) return false;
  let outer: ts.Node = node;
  while (outer.parent !== undefined && ts.isParenthesizedExpression(outer.parent))
    outer = outer.parent;
  const parent = outer.parent;
  if (parent === undefined) return false;
  if (
    (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) &&
    parent.expression === outer
  )
    return false;
  if (
    ts.isBinaryExpression(parent) &&
    parent.left === outer &&
    parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
    parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment
  )
    return false;
  return true;
}

/** Files whose exports object is observed by identity somewhere: their top-
 * level `this` object must exist (lowerFileInit creates it). */
export function usesCjsExportsIdentity(lowerer: Lowerer, sf: ts.SourceFile): boolean {
  if (!isCjsJsFile(sf, lowerer.program)) return false;
  let found = false;
  ts.walkPreorder(sf, (node) => {
    if (
      (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node)) &&
      isCjsExportsObjectValue(lowerer, node) &&
      objectAnsweredUse(node) &&
      namesOriginalExports(lowerer, node)
    ) {
      found = true;
      return "stop";
    }
    return undefined;
  });
  return found;
}

/** `exports` / `module.exports` used as a value inside its own module: the
 * original exports object for identity, typeof and truthiness, or a named
 * refusal. Null when `node` is not such a use. */
export function lowerCjsExportsObjectValue(lowerer: Lowerer, node: ts.Expression): IrExpr | null {
  if (!isCjsExportsObjectValue(lowerer, node)) return null;
  const sf = ts.getSourceFileOfNode(node);
  // A module that replaces module.exports answers `module.exports` reads
  // through the replacement's own machinery (the class-expression whole
  // export, the replaced-exports reads).
  if (!ts.isIdentifier(node) && exportsAssignments(lowerer, sf).moduleExports) return null;
  const spelled = ts.isIdentifier(node) ? "exports" : "module.exports";
  const original = lowerer.cjsExportsThis.get(sf);
  if (objectAnsweredUse(node) && original !== undefined && namesOriginalExports(lowerer, node)) {
    return { kind: "varRef", localId: original.id, type: DYN, loc: locOf(node) };
  }
  // `module.exports` truthiness keeps its existing fold (and anything the
  // object is not needed for keeps whatever answered it before).
  if (answeredWithoutObject(node)) return null;
  // A module of a require cycle whose exports a member can observe keeps
  // Node's live exports object (%exportsThis, mirrored on every export
  // write): any other value use answers that object, so passing `exports`
  // to Object.getOwnPropertyNames and friends is the object Node passes.
  const partial = cjsPartialExportsObject(lowerer, sf);
  if (partial !== null) return { kind: "varRef", localId: partial.id, type: DYN, loc: locOf(node) };
  lowerer.unsupported(
    "SC1090",
    node,
    identityUse(node)
      ? `comparing '${spelled}' in a module that replaces module.exports or rebinds exports (the compiled exports are a static table, not an object with an identity)`
      : `'${spelled}' as a value other than a member access, comparison, typeof or truthiness test (the compiled exports are a static table, not an object: read ${spelled}.<name>)`,
  );
}

/** `exports = module.exports = {}` (either order) as a top-level statement
 * that runs before anything could observe or extend the original exports
 * object: only directives, require statements and function declarations
 * precede it, and the module assigns neither binding anywhere else. Node
 * swaps the original empty exports object for another empty one that both
 * bindings name; the compiled module's static exports start out exactly
 * the same, so the statement is a no-op (semver's internal/re.js). */
export function isFreshExportsReset(lowerer: Lowerer, stmt: ts.ExpressionStatement): boolean {
  const sf = stmt.parent;
  if (!ts.isSourceFile(sf) || !isCjsJsFile(sf, lowerer.program)) return false;
  let e: ts.Expression = stmt.expression;
  const targets: ts.Expression[] = [];
  for (;;) {
    while (ts.isParenthesizedExpression(e)) e = e.expression;
    if (!ts.isBinaryExpression(e) || e.operatorToken.kind !== ts.SyntaxKind.EqualsToken) break;
    targets.push(e.left);
    e = e.right;
  }
  if (!ts.isObjectLiteralExpression(e) || e.properties.nodes.length !== 0) return false;
  if (targets.length !== 2) return false;
  const hasExports = targets.some((t) => isCjsExportsIdentifier(lowerer, t));
  const hasModuleExports = targets.some((t) => isCjsModuleExports(lowerer, t));
  if (!hasExports || !hasModuleExports) return false;
  for (const prior of sf.statements.nodes) {
    if (prior === stmt) break;
    if (ts.isFunctionDeclaration(prior) || isRequireStatement(prior)) continue;
    if (ts.isExpressionStatement(prior) && ts.isStringLiteral(prior.expression)) continue;
    return false;
  }
  let others = 0;
  ts.walkPreorder(sf, (node) => {
    if (
      !ts.isBinaryExpression(node) ||
      node.operatorToken.kind < ts.SyntaxKind.FirstAssignment ||
      node.operatorToken.kind > ts.SyntaxKind.LastAssignment
    )
      return undefined;
    let target = node.left;
    while (ts.isParenthesizedExpression(target)) target = target.expression;
    if (isCjsModuleExports(lowerer, target) || isCjsExportsIdentifier(lowerer, target)) others++;
    return undefined;
  });
  return others === 2;
}

/** The export global a WRITE `exports.<name> = v` / `module.exports.<name> =
 * v` updates when it is not a top-level export statement (inside a
 * function, or in value position): only while the module keeps its
 * original exports object, which is then the object every requirer reads
 * the member from. */
export function cjsExportMemberWriteGlobalOf(
  lowerer: Lowerer,
  target: ts.PropertyAccessExpression,
): IrGlobal | null {
  const sf = ts.getSourceFileOfNode(target);
  if (!isCjsJsFile(sf, lowerer.program)) return null;
  const assigned = exportsAssignments(lowerer, sf);
  if (assigned.exports || assigned.moduleExports) return null;
  return cjsInFileExportGlobalOf(lowerer, target);
}

/** Whether a function body reads `this` (arrow functions inherit it; other
 * nested functions bind their own). */
export function functionUsesThis(fn: ts.FunctionLikeDeclaration): boolean {
  if (fn.body === undefined) return false;
  let found = false;
  ts.walkPreorder(fn.body, (node) => {
    if (node !== fn.body && ts.isFunctionLike(node) && !ts.isArrowFunction(node)) return "skip";
    if (node.kind === ts.SyntaxKind.ThisKeyword) {
      found = true;
      return "stop";
    }
    return undefined;
  });
  return found;
}

/** The ES-module half (a TypeScript module required from JavaScript, such
 * as a package shim): require() answers its namespace, so a call through
 * it binds `this` to the namespace. True when the export is a function
 * that never reads `this` (every declaration of an overload set), a
 * builtin module's member re-exported from its declarations, or reached
 * through an `export *` of a module where that holds. */
function esModuleExportIgnoresThis(
  lowerer: Lowerer,
  sf: ts.SourceFile,
  name: string,
  depth: number,
): boolean {
  const moduleSym = lowerer.checker.getSymbolAtLocation(sf);
  const exported = moduleSym?.getExports().get(ts.escapedSymbolName(name));
  if (exported !== undefined) {
    const target =
      exported.flags & ts.SymbolFlags.Alias ? lowerer.checker.getAliasedSymbol(exported) : exported;
    const decls = target.declarations;
    if (decls.length === 0) return false;
    return decls.every(
      (d) =>
        (ts.isFunctionDeclaration(d) && moduleExportIgnoresThis(lowerer, d)) ||
        (ts.getSourceFileOfNode(d).isDeclarationFile && ts.isFunctionDeclaration(d)),
    );
  }
  for (const stmt of sf.statements.nodes) {
    if (
      !ts.isExportDeclaration(stmt) ||
      stmt.exportClause !== undefined ||
      stmt.moduleSpecifier === undefined ||
      !ts.isStringLiteral(stmt.moduleSpecifier)
    )
      continue;
    const dep = lowerer.facts.importedModule(sf, stmt.moduleSpecifier.text);
    if (
      dep !== null &&
      !dep.isDeclarationFile &&
      esModuleExportIgnoresThis(lowerer, dep, name, depth + 1)
    )
      return true;
  }
  return false;
}

/** True when every value the module assigns to its export `name` is a
 * function that never reads `this`. A call through the exports object
 * (`exports.f(x)`) binds `this` to that object, which the static export
 * table cannot supply, so only these calls lower; the others keep a fence. */
export function cjsExportCallIgnoresThis(
  lowerer: Lowerer,
  sf: ts.SourceFile,
  name: string,
): boolean {
  sf = cjsNamespaceTargetOf(lowerer, sf) ?? sf;
  let proofs = lowerer.cjsReceiverProofs.get(sf);
  const cached = proofs?.get(name);
  if (cached !== undefined) return cached;
  // Recursive searches are depth-bounded; cache only complete root queries.
  const result = computeExportCallIgnoresThis(lowerer, sf, name, 0);
  if (proofs === undefined) {
    proofs = new Map();
    lowerer.cjsReceiverProofs.set(sf, proofs);
  }
  proofs.set(name, result);
  return result;
}

/** Whether every value `expr` can hold is something a call cannot invoke: a
 * `void`/`undefined` write (the `exports.name = void 0` preamble of a
 * tsc-emitted module), a primitive literal, or an object or array literal.
 * A call that reaches one throws in Node before it can read its receiver,
 * so the value says nothing about `this` being needed. */
function holdsNoCallable(expr: ts.Expression): boolean {
  let e = expr;
  while (ts.isParenthesizedExpression(e)) e = e.expression;
  return (
    e.kind === ts.SyntaxKind.VoidExpression ||
    e.kind === ts.SyntaxKind.NullKeyword ||
    e.kind === ts.SyntaxKind.TrueKeyword ||
    e.kind === ts.SyntaxKind.FalseKeyword ||
    ts.isNumericLiteral(e) ||
    ts.isStringLiteral(e) ||
    ts.isNoSubstitutionTemplateLiteral(e) ||
    ts.isRegularExpressionLiteral(e) ||
    ts.isObjectLiteralExpression(e) ||
    ts.isArrayLiteralExpression(e)
  );
}

function computeExportCallIgnoresThis(
  lowerer: Lowerer,
  sf: ts.SourceFile,
  name: string,
  depth: number,
): boolean {
  if (depth > 16) return false;
  if (!isJsSourceFile(sf)) return esModuleExportIgnoresThis(lowerer, sf, name, depth);
  const values: ts.Expression[] = [];
  ts.walkPreorder(sf, (node) => {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(node.left) &&
      node.left.name.text === name &&
      (isCjsExportsIdentifier(lowerer, node.left.expression) ||
        isCjsModuleExports(lowerer, node.left.expression))
    ) {
      values.push(node.right);
    }
    return undefined;
  });
  // Entries of a `module.exports = { ... }` table (direct, or a const
  // literal the statement names).
  let methodEntry: ts.MethodDeclaration | null = null;
  let shorthandOnly = false;
  for (const stmt of sf.statements.nodes) {
    const cjs = cjsExportAssignmentOf(stmt);
    if (cjs?.kind !== "table") continue;
    const table = cjs.obj ?? cjsExportTargetLiteral(cjs.expr.right, sf);
    for (const prop of table?.properties?.nodes ?? []) {
      if (prop.name === undefined || !ts.isIdentifier(prop.name) || prop.name.text !== name)
        continue;
      if (ts.isPropertyAssignment(prop)) values.push(prop.initializer);
      else if (ts.isShorthandPropertyAssignment(prop)) {
        if (!moduleExportIgnoresThis(lowerer, prop.name)) return false;
        shorthandOnly = true;
      } else if (ts.isMethodDeclaration(prop)) methodEntry = prop;
    }
  }
  if (methodEntry !== null)
    return values.length === 0 && moduleExportIgnoresThis(lowerer, methodEntry);
  if (values.length === 0) return shorthandOnly;
  return values.every((v) => {
    let e = v;
    // A chain `exports.a = exports.b = value` stores `value` in both
    // members; an assignment's own value is its right-hand side.
    for (;;) {
      while (ts.isParenthesizedExpression(e)) e = e.expression;
      if (!ts.isBinaryExpression(e) || e.operatorToken.kind !== ts.SyntaxKind.EqualsToken) break;
      e = e.right;
    }
    if (
      ts.isFunctionExpression(e) ||
      ts.isArrowFunction(e) ||
      ts.isIdentifier(e) ||
      ts.isCallExpression(e)
    )
      return moduleExportIgnoresThis(lowerer, e);
    // A value no call can invoke (the `void 0` a tsc-emitted module opens
    // each export with, a primitive, a plain object): reaching it throws
    // whatever receiver the call would have had, so it cannot read `this`.
    if (holdsNoCallable(e)) return true;
    // Another module's member (`exports.f = require("./lib").f`, or through
    // a module binding): that module's own export values decide.
    if (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.name)) {
      const dep = ts.isIdentifier(e.expression)
        ? lowerer.cjsLocalModuleBindingOf(e.expression)
          ? lowerer.cjsModuleBindingDepOf(e.expression)
          : null
        : lowerer.cjsModuleRefDepOf(e.expression);
      return dep !== null && computeExportCallIgnoresThis(lowerer, dep, e.name.text, depth + 1);
    }
    return false;
  });
}

/** The value behind a binding of a CommonJS member export (an `import {
 * name }` or a top-level `const { name } = require(...)`) written once as
 * `module.exports.<name> = <value>` or `exports.<name> = <value>`, when the
 * module exports a value whole and the member is a property added to it
 * (`exports = module.exports = Client; exports.StatsD = Client`). The
 * checker gives such a binding a synthesized property symbol, so the
 * module's statements answer. The value is a binding of the exporting
 * module or a primitive literal, which the use site reads again. Follows
 * `module.exports = require("./x")` re-exports. Null for any other binding. */
export function cjsMemberAliasValueOf(lowerer: Lowerer, ref: ts.Identifier): ts.Expression | null {
  const sym = lowerer.checker.getSymbolAtLocation(ref);
  if (!sym) return null;
  const decls = sym.declarations;
  // `import { StatsD } from "pkg"`
  const specifier = sym.flags & ts.SymbolFlags.Alias ? decls.find(ts.isImportSpecifier) : undefined;
  if (specifier !== undefined) {
    const importDecl = specifier.parent?.parent?.parent;
    if (
      importDecl === undefined ||
      !ts.isImportDeclaration(importDecl) ||
      !ts.isStringLiteral(importDecl.moduleSpecifier)
    )
      return null;
    const spec = importDecl.moduleSpecifier.text;
    const from = ts.getSourceFileOfNode(importDecl);
    const dep =
      lowerer.facts.importedModule(from, spec, "import") ??
      lowerer.facts.npmStaticModule(from, spec, "import");
    if (dep === null) return null;
    return memberAliasIn(lowerer, dep, (specifier.propertyName ?? specifier.name).text, 0);
  }
  // `const { shout } = require("./lib")` at a module's top level
  const element = decls.find(ts.isBindingElement);
  if (element === undefined || element.dotDotDotToken || !ts.isIdentifier(element.name))
    return null;
  const pattern = element.parent;
  const declaration = pattern?.parent;
  if (
    pattern === undefined ||
    !ts.isObjectBindingPattern(pattern) ||
    declaration === undefined ||
    !ts.isVariableDeclaration(declaration) ||
    declaration.initializer === undefined ||
    (ts.getCombinedNodeFlags(declaration) & ts.NodeFlags.Const) === 0
  )
    return null;
  const key = element.propertyName ?? element.name;
  if (!ts.isIdentifier(key)) return null;
  const req = inlineProgramRequireOf(lowerer, declaration.initializer);
  if (req === null) return null;
  return memberAliasIn(lowerer, req.dep, key.text, 0);
}

function memberAliasIn(
  lowerer: Lowerer,
  sf: ts.SourceFile,
  name: string,
  depth: number,
): ts.Expression | null {
  const member = memberWritesIn(lowerer, sf, name, depth);
  // One write: a member written again would be a runtime slot.
  return member !== null && member.writes === 1 ? member.value : null;
}

/** The writes of member `name` in `sf` and in the modules it re-exports
 * through `module.exports = require("./x")`, which share its exports
 * object. `value` is the last write's value when the use site can read
 * it again. Null when the module does not export a value whole. */
function memberWritesIn(
  lowerer: Lowerer,
  sf: ts.SourceFile,
  name: string,
  depth: number,
): { value: ts.Expression | null; writes: number } | null {
  if (depth > 32 || sf.isDeclarationFile || !isCjsJsFile(sf, lowerer.program)) return null;
  const whole = cjsWholeExportValueOf(sf);
  if (whole === null) return null;
  let value: ts.Expression | null = null;
  let writes = 0;
  const inner = inlineProgramRequireOf(lowerer, whole.rhs);
  if (inner !== null) {
    // The re-exported module runs first; this module's own writes follow.
    const dep = memberWritesIn(lowerer, inner.dep, name, depth + 1);
    if (dep === null) return null;
    ({ value, writes } = dep);
  }
  for (const stmt of sf.statements.nodes) {
    const cjs = cjsExportAssignmentOf(stmt);
    if (cjs?.kind !== "member" || !ts.isIdentifier(cjs.name) || cjs.name.text !== name) continue;
    writes++;
    if (cjsExportDiscardReason(stmt) !== null) return null;
    let written: ts.Expression = cjs.value;
    while (ts.isParenthesizedExpression(written)) written = written.expression;
    value = rereadableMemberValue(lowerer, stmt, written) ? written : null;
  }
  return { value, writes };
}

/** True when reading `value` again at the use site observes what the
 * member write `stmt` stored: a primitive literal, or a module binding
 * declared before the write and never reassigned. */
function rereadableMemberValue(
  lowerer: Lowerer,
  stmt: ts.Statement,
  value: ts.Expression,
): boolean {
  if (
    ts.isStringLiteral(value) ||
    ts.isNumericLiteral(value) ||
    ts.isNoSubstitutionTemplateLiteral(value) ||
    value.kind === ts.SyntaxKind.TrueKeyword ||
    value.kind === ts.SyntaxKind.FalseKeyword
  )
    return true;
  if (!ts.isIdentifier(value)) return false;
  const sym = lowerer.resolveValueSymbol(value);
  if (sym === null || sym.declarations.length !== 1) return false;
  const decl = sym.declarations[0]!;
  if (ts.getSourceFileOfNode(decl) !== ts.getSourceFileOfNode(stmt)) return false;
  // A function declaration is initialized when the module starts; any
  // other binding must be initialized before the write stores it.
  if (!ts.isFunctionDeclaration(decl) && decl.end > stmt.pos) return false;
  return bindingNeverReassigned(lowerer.bindingScope(), sym, decl);
}

/* ── partial require() cycles ───────────────────────────────────────────
 * Node hands a requiring module the still-evaluating module's exports
 * object, as it stands: members assigned before the require are there,
 * members assigned later are missing (a read of one is undefined, and
 * while the module evaluates Node warns). The compiled static export
 * globals cannot show that state, so a CommonJS module of such a cycle
 * also keeps a live checked-dynamic exports object (%exportsThis): every
 * export write lands in both, and reads through a module binding read the
 * live object. */

/** True for a CommonJS module of a require() cycle whose partially
 * initialized exports object a member of the cycle can observe. */
export function isPartialCjsCycleModule(lowerer: Lowerer, sf: ts.SourceFile): boolean {
  return lowerer.program.analysis.partialCjsCycleMembers.has(sf);
}

/** The live exports object of a partial-cycle module, or null. */
export function cjsPartialExportsObject(lowerer: Lowerer, sf: ts.SourceFile): IrGlobal | null {
  if (!isPartialCjsCycleModule(lowerer, sf)) return null;
  return lowerer.cjsExportsThis.get(sf) ?? null;
}

function partialObjectRef(obj: IrGlobal, loc: SrcLoc): IrExpr {
  return { kind: "varRef", localId: obj.id, type: DYN, loc };
}

/** The statements that also write one export member into the module's live
 * exports object, at the same position as the static export global write. */
export function cjsPartialExportMirror(
  lowerer: Lowerer,
  sf: ts.SourceFile,
  key: string,
  value: IrExpr,
  blame: ts.Node,
  loc: SrcLoc,
): IrStmt[] {
  const obj = cjsPartialExportsObject(lowerer, sf);
  if (obj === null) return [];
  return [
    {
      kind: "exprStmt",
      expr: {
        kind: "libCall",
        fn: "dyn.keySet",
        args: [
          partialObjectRef(obj, loc),
          { kind: "strLit", value: key, type: STRING, loc },
          lowerer.coerceInto(blame, value, DYN),
        ],
        type: VOID,
        loc,
      },
      loc,
    },
  ];
}

/** The statement that replaces the module's exports object with a fresh
 * one (`module.exports = { … }`), exactly where Node replaces it. */
export function cjsPartialExportsReplaceStmt(
  lowerer: Lowerer,
  sf: ts.SourceFile,
  loc: SrcLoc,
): IrStmt | null {
  const obj = cjsPartialExportsObject(lowerer, sf);
  if (obj === null) return null;
  return {
    kind: "assign",
    localId: obj.id,
    value: { kind: "dynObjLit", fields: [], type: DYN, loc },
    loc,
  };
}

/** A read of export `key` through a module binding of `dep`: the live
 * exports object's property as a checked-dynamic value. While `dep` still
 * evaluates and the member is missing, the read first reports Node's
 * circular-dependency warning (the proxy Node puts on the exports object
 * for the window). */
export function cjsPartialExportRead(
  lowerer: Lowerer,
  dep: ts.SourceFile,
  key: string,
  blame: ts.Node,
): IrExpr | null {
  // A read through a `const m = require(…)` binding uses the exports object
  // that require answered (Node's per-requirer identity), not the target's
  // current object a later replacement installed.
  const receiverIdent =
    ts.isPropertyAccessExpression(blame) && ts.isIdentifier(blame.expression)
      ? blame.expression
      : null;
  const receiverSym =
    receiverIdent === null
      ? undefined
      : (lowerer.checker.getSymbolAtLocation(receiverIdent) ??
        lowerer.resolveValueSymbol(receiverIdent) ??
        undefined);
  const captured =
    receiverSym === undefined
      ? undefined
      : lowerer.cjsPartialRequireObjects.get(receiverSym)?.object;
  const obj = captured ?? cjsPartialExportsObject(lowerer, dep);
  if (obj === null || obj === undefined) return null;
  const loc = locOf(blame);
  const receiver = partialObjectRef(obj, loc);
  const keyRef: IrExpr = { kind: "strLit", value: key, type: STRING, loc };
  const read: IrExpr = {
    kind: "libCall",
    fn: "dyn.bagGet",
    args: [receiver, keyRef, partialObjectRef(obj, loc)],
    type: DYN,
    loc,
  };
  // The binding itself may still be uninitialized (another member called a
  // function of this module before its require returned): Node's TDZ.
  const receiverNode = ts.isPropertyAccessExpression(blame) ? blame.expression : null;
  const tdz = receiverNode === null ? null : requireBindingTdzCheck(lowerer, receiverNode, loc);
  // Node installs its warning proxy only on a plain exports object: a
  // module whose top level stamps __esModule keeps the silent object.
  const evaluatingId = dep.statements.nodes.some(
    (stmt) => ts.isExpressionStatement(stmt) && isEsModuleStamp(stmt.expression),
  )
    ? undefined
    : lowerer.moduleEvaluatingOf.get(dep);
  if (evaluatingId === undefined)
    return tdz === null ? read : { kind: "seqExpr", stmts: [tdz], result: read, type: DYN, loc };
  const warning: IrStmt = {
    kind: "exprStmt",
    expr: {
      kind: "libCall",
      fn: "process.emitWarningText",
      args: [
        {
          kind: "strLit",
          value: `Accessing non-existent property '${key}' of module exports inside circular dependency`,
          type: STRING,
          loc,
        },
      ],
      type: VOID,
      loc,
    },
    loc,
  };
  const missing: IrStmt = {
    kind: "if",
    cond: {
      kind: "unary",
      op: "!",
      operand: {
        kind: "libCall",
        fn: "dyn.in",
        args: [partialObjectRef(obj, loc), keyRef],
        type: BOOL,
        loc,
      },
      type: BOOL,
      loc,
    },
    then: [warning],
    else_: null,
    loc,
  };
  // Node unsets the warning proxy when a module finishes loading with the
  // object still installed as module.exports. A requirer that got the object
  // mid-cycle keeps it when the module later REPLACES module.exports, and
  // that stale object keeps warning for the rest of the process; identity
  // against the module's current exports object decides that case.
  let warn: IrExpr = { kind: "varRef", localId: evaluatingId, type: BOOL, loc };
  const currentObj = captured === undefined ? null : lowerer.cjsExportsThis.get(dep);
  if (captured !== undefined && currentObj !== null && currentObj !== undefined) {
    warn = {
      kind: "logical",
      op: "||",
      left: warn,
      right: {
        kind: "unary",
        op: "!",
        operand: {
          kind: "libCall",
          fn: "dyn.sameValue",
          args: [partialObjectRef(obj, loc), partialObjectRef(currentObj, loc)],
          type: BOOL,
          loc,
        },
        type: BOOL,
        loc,
      },
      type: BOOL,
      loc,
    };
  }
  return {
    kind: "seqExpr",
    stmts: [
      ...(tdz === null ? [] : [tdz]),
      { kind: "if", cond: warn, then: [missing], else_: null, loc },
    ],
    result: read,
    type: DYN,
    loc,
  };
}

/** A member read through a module binding of a module of a partial
 * require() cycle: the live exports object's member as it stands, undefined
 * (with Node's circular-dependency warning) while the module evaluates and
 * the member is missing. Null when the receiver is not such a binding or the
 * module has no live object. */
export function lowerCjsPartialCycleMemberRead(
  lowerer: Lowerer,
  access: ts.PropertyAccessExpression,
): IrExpr | null {
  if (access.questionDotToken || !ts.isIdentifier(access.name)) return null;
  const members = lowerer.program.analysis.partialCjsCycleMembers;
  if (members.size === 0) return null;
  let recv: ts.Expression = access.expression;
  while (ts.isParenthesizedExpression(recv)) recv = recv.expression;
  if (!ts.isIdentifier(recv)) return null;
  const dep = lowerer.cjsModuleBindingDepOf(recv);
  if (dep === null) return null;
  const target = cjsNamespaceTargetOf(lowerer, dep) ?? dep;
  if (!members.has(target)) return null;
  return cjsPartialExportRead(lowerer, target, access.name.text, access);
}

/** The statement that installs export `key`'s accessor descriptor on a
 * partial-cycle module's live exports object (`module.exports = { get … }`):
 * Node's exports object carries the getter/setter, so a read through a
 * module binding runs it. Null for modules outside a partial cycle. */
export function cjsPartialAccessorDefineStmt(
  lowerer: Lowerer,
  sf: ts.SourceFile,
  key: string,
  getter: ts.GetAccessorDeclaration | null,
  setter: ts.SetAccessorDeclaration | null,
  loc: SrcLoc,
): IrStmt | null {
  const obj = cjsPartialExportsObject(lowerer, sf);
  if (obj === null || (getter === null && setter === null)) return null;
  const fields: { key: IrExpr; value: IrExpr }[] = [];
  const member = (
    name: string,
    accessor: ts.GetAccessorDeclaration | ts.SetAccessorDeclaration,
  ) => {
    const value = cjsAccessorValue(lowerer, accessor, loc);
    if (value === null) return false;
    fields.push({
      key: { kind: "strLit", value: name, type: STRING, loc },
      value: lowerer.coerceToExpected(value, DYN),
    });
    return true;
  };
  if (getter !== null && !member("get", getter)) return null;
  if (setter !== null && !member("set", setter)) return null;
  const truth = (): IrExpr => ({
    kind: "dynFrom",
    value: { kind: "boolLit", value: true, type: BOOL, loc },
    type: DYN,
    loc,
  });
  fields.push(
    { key: { kind: "strLit", value: "enumerable", type: STRING, loc }, value: truth() },
    { key: { kind: "strLit", value: "configurable", type: STRING, loc }, value: truth() },
  );
  return {
    kind: "exprStmt",
    expr: {
      kind: "libCall",
      fn: "dyn.defineProperty",
      args: [
        partialObjectRef(obj, loc),
        {
          kind: "dynFrom",
          value: { kind: "strLit", value: key, type: STRING, loc },
          type: DYN,
          loc,
        },
        { kind: "dynObjLit", fields, type: DYN, loc },
      ],
      type: DYN,
      loc,
    },
    loc,
  };
}
