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
  isModuleExportsAccess,
  isRequireStatement,
  locOf,
  npmStaticDepSf7,
  resolveImport,
} from "../program.js";
import { cjsWholeExportValueOf, inlineProgramRequireOf } from "./cjs-inline-require.js";
import { isCjsModuleGlobal } from "./lower-node-module.js";
import { bindingNeverReassigned } from "./binding-analysis.js";
import { DYN, type IrExpr, type IrGlobal } from "../../ir/ir.js";

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
  return (
    (sym ? lowerer.globalsBySymbol.get(sym) : undefined) ??
    (resolved ? lowerer.globalsBySymbol.get(resolved) : undefined) ??
    null
  );
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
function functionUsesThis(fn: ts.FunctionLikeDeclaration): boolean {
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

/** A function declaration, or a variable initialized with a function or
 * arrow expression, that never reads `this`. */
function symbolIsThisFreeFunction(lowerer: Lowerer, sym: ts.Symbol | undefined): boolean {
  const decls = sym ? sym.declarations : [];
  const fn = decls.find(ts.isFunctionDeclaration);
  if (fn !== undefined) return !functionUsesThis(fn);
  const v = decls.find(ts.isVariableDeclaration);
  let init = v?.initializer;
  while (init !== undefined && ts.isParenthesizedExpression(init)) init = init.expression;
  return (
    init !== undefined &&
    (ts.isFunctionExpression(init) || ts.isArrowFunction(init)) &&
    !functionUsesThis(init)
  );
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
        (ts.isFunctionDeclaration(d) && !functionUsesThis(d)) ||
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
    const dep = resolveImport(lowerer.program, sf, stmt.moduleSpecifier.text);
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
  depth = 0,
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
        const value = lowerer.checker.getShorthandAssignmentValueSymbol(prop);
        if (!symbolIsThisFreeFunction(lowerer, value)) return false;
        shorthandOnly = true;
      } else if (ts.isMethodDeclaration(prop)) methodEntry = prop;
    }
  }
  if (methodEntry !== null) return values.length === 0 && !functionUsesThis(methodEntry);
  if (values.length === 0) return shorthandOnly;
  return values.every((v) => {
    let e = v;
    while (ts.isParenthesizedExpression(e)) e = e.expression;
    if (ts.isFunctionExpression(e) || ts.isArrowFunction(e)) return !functionUsesThis(e);
    if (ts.isIdentifier(e)) {
      return symbolIsThisFreeFunction(lowerer, lowerer.checker.getSymbolAtLocation(e));
    }
    // Another module's member (`exports.f = require("./lib").f`, or through
    // a module binding): that module's own export values decide.
    if (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.name)) {
      const dep = ts.isIdentifier(e.expression)
        ? lowerer.cjsLocalModuleBindingOf(e.expression)
          ? lowerer.cjsModuleBindingDepOf(e.expression)
          : null
        : lowerer.cjsModuleRefDepOf(e.expression);
      return dep !== null && cjsExportCallIgnoresThis(lowerer, dep, e.name.text, depth + 1);
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
      resolveImport(lowerer.program, from, spec, "import") ??
      npmStaticDepSf7(lowerer.program, from, spec, "import");
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
  return bindingNeverReassigned(lowerer, sym, decl);
}
