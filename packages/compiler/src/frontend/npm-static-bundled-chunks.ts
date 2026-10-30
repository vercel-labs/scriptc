/* Bundled CommonJS chunks: esbuild wraps every CommonJS module it bundles
 * in a lazily evaluated factory,
 *
 *   var require_x = __commonJS({ "src/x.js"(exports, module) { BODY } });
 *
 * and each `require_x()` runs BODY once (later calls answer the cached
 * module.exports, a call during BODY answers the partial one). That is
 * exactly a CommonJS module that the bundle requires at the call's
 * position, so each recognized chunk becomes its own module: a virtual
 * sibling file `<bundle>.<binding>.cjs` holding BODY, its module
 * parameters respelled as the CommonJS globals, and every `require_x()`
 * call becomes `require("./<bundle>.<binding>.cjs")`. The program then
 * compiles chunks with the ordinary CommonJS machinery: evaluation at the
 * require's position, the run-once module cache, export tables, and the
 * __toESM interop erasure.
 *
 * Only shapes whose meaning is verified move: the helper must be one of
 * the recognized __commonJS spellings, every reference to a factory
 * binding must be a direct call, and BODY must not observe the
 * difference between a factory and a module (its `this`, `arguments`,
 * `__filename`, the module object beyond `module.exports`, a top-level
 * return, or a binding of the bundle other than the pure helpers copied
 * beside it). Anything else answers a degrade reason. */
import * as ts from "./ts7/syntax.js";
import { helperTokens } from "./helper-tokens.js";
import { canonicalBuiltinModule } from "./builtin-modules.js";
import { getTextOfNode, tokenStartOfNode } from "./ts7/node-functions.js";
import { bundledShimForwarder, packageShimForBundledFile } from "./package-shims.js";
import {
  builtinAliasOf,
  versionedPackageOfKey,
  type BuiltinAlias,
} from "./builtin-package-aliases.js";

export interface BundledChunkSplit {
  /** The bundle with chunk declarations blanked and calls respelled. */
  text: string;
  /** Virtual sibling modules, in declaration order. */
  chunks: { path: string; source: string }[];
}

export interface Edit {
  start: number;
  end: number;
  text: string;
}

const CHUNK_SHAPE_DEGRADE =
  "its shipped JS bundles CommonJS modules through the __commonJS helper in a shape the " +
  "recognizer cannot verify";

/** The helper a counter-suffixed bundler name spells (`__commonJS2`). */
export function helperBase(name: string): string {
  return /^__[A-Za-z]+\d+$/.test(name) ? name.replace(/\d+$/, "") : name;
}

export function unparen(e: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(e)) e = e.expression;
  return e;
}

/** True for an identifier occurrence that reads or writes a binding (as
 * opposed to a property name, a label, or a declaration's own name).
 * Shorthand property values count: `{ x }` reads x. */
export function isReference(id: ts.Identifier): boolean {
  const p = id.parent;
  if (p === undefined) return false;
  if (ts.isPropertyAccessExpression(p)) return p.expression === id;
  if (ts.isPropertyAssignment(p)) return p.initializer === id;
  if (
    ts.isMethodDeclaration(p) ||
    ts.isPropertyDeclaration(p) ||
    ts.isGetAccessorDeclaration(p) ||
    ts.isSetAccessorDeclaration(p)
  )
    return p.name !== id;
  if (ts.isBindingElement(p)) return p.initializer === id;
  if (ts.isVariableDeclaration(p) || ts.isParameter(p)) return p.initializer === id;
  if (
    ts.isFunctionDeclaration(p) ||
    ts.isFunctionExpression(p) ||
    ts.isClassDeclaration(p) ||
    ts.isClassExpression(p)
  )
    return p.name !== id;
  if (ts.isLabeledStatement(p)) return p.label !== id;
  if (ts.isBreakStatement(p) || ts.isContinueStatement(p)) return false;
  if (ts.isMetaProperty(p)) return false;
  return true;
}

/** Names a subtree declares anywhere inside it: variables (destructuring
 * included), parameters, function and class names, catch bindings. */
export function declaredNames(root: ts.Node): Set<string> {
  const names = new Set<string>();
  // Binding patterns nest BindingElements, which the walk visits too.
  ts.walkPreorder(root, (n) => {
    if (n.kind >= ts.SyntaxKind.FirstJSDocNode && n.kind <= ts.SyntaxKind.LastJSDocNode)
      return "skip";
    if (ts.isVariableDeclaration(n) || ts.isParameter(n) || ts.isBindingElement(n)) {
      const name = n.name;
      if (name !== undefined && ts.isIdentifier(name)) names.add(name.text);
    } else if (
      (ts.isFunctionDeclaration(n) ||
        ts.isFunctionExpression(n) ||
        ts.isClassDeclaration(n) ||
        ts.isClassExpression(n)) &&
      n.name !== undefined
    )
      names.add(n.name.text);
    return undefined;
  });
  return names;
}

/** Adds the identifiers a binding name (an identifier or a destructuring
 * pattern) declares. */
function addBindingNames(name: ts.BindingName, out: Set<string>): void {
  if (ts.isIdentifier(name)) {
    out.add(name.text);
    return;
  }
  for (const element of name.elements.nodes) {
    if (!ts.isOmittedExpression(element) && element.name !== undefined)
      addBindingNames(element.name, out);
  }
}

function isFunctionScope(n: ts.Node): n is ts.SignatureDeclaration {
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

/** The `var` names a function body declares, without entering nested
 * functions. Function declarations in nested blocks count as block-scoped
 * here; treating one as free only adds an unused helper copy. */
function varScopedNames(body: ts.Node): Set<string> {
  const out = new Set<string>();
  ts.walkPreorder(body, (n) => {
    if (n !== body && (isFunctionScope(n) || ts.isClassDeclaration(n) || ts.isClassExpression(n)))
      return "skip";
    if (ts.isVariableDeclarationList(n) && (n.flags & ts.NodeFlags.BlockScoped) === 0) {
      for (const d of n.declarations.nodes) addBindingNames(d.name, out);
    }
    return undefined;
  });
  return out;
}

/** The names a function binds for references in its parameter list
 * (default values, computed keys of destructuring patterns): its
 * parameters and a function expression's own name. Parameter initializers
 * run in their own scope, so the body's `var`s are not visible there. */
function parameterScopeNames(scope: ts.SignatureDeclaration): Set<string> {
  const out = new Set<string>();
  for (const param of scope.parameters.nodes) addBindingNames(param.name, out);
  if (ts.isFunctionExpression(scope) && scope.name !== undefined) out.add(scope.name.text);
  return out;
}

const NO_NAMES: ReadonlySet<string> = new Set();

/** True when `node` lies inside `ancestor` (or is it). */
function within(node: ts.Node, ancestor: ts.Node): boolean {
  for (let n: ts.Node | undefined = node; n !== undefined; n = n.parent)
    if (n === ancestor) return true;
  return false;
}

/** The names one scope node binds for the references inside it. */
function scopeNames(scope: ts.Node): Set<string> {
  const out = new Set<string>();
  if (isFunctionScope(scope)) {
    for (const param of scope.parameters.nodes) addBindingNames(param.name, out);
    if (ts.isFunctionExpression(scope) && scope.name !== undefined) out.add(scope.name.text);
    if (scope.body !== undefined) for (const name of varScopedNames(scope.body)) out.add(name);
  } else if (ts.isBlock(scope) || ts.isSourceFile(scope) || ts.isCaseBlock(scope)) {
    const statements = ts.isCaseBlock(scope)
      ? scope.clauses.nodes.flatMap((clause) => clause.statements.nodes)
      : scope.statements.nodes;
    for (const stmt of statements) {
      if ((ts.isFunctionDeclaration(stmt) || ts.isClassDeclaration(stmt)) && stmt.name)
        out.add(stmt.name.text);
      else if (
        ts.isVariableStatement(stmt) &&
        (stmt.declarationList.flags & ts.NodeFlags.BlockScoped) !== 0
      ) {
        for (const d of stmt.declarationList.declarations.nodes) addBindingNames(d.name, out);
      }
    }
  } else if (ts.isCatchClause(scope) && scope.variableDeclaration !== undefined) {
    addBindingNames(scope.variableDeclaration.name, out);
  } else if (
    (ts.isForStatement(scope) || ts.isForInStatement(scope) || ts.isForOfStatement(scope)) &&
    scope.initializer !== undefined &&
    ts.isVariableDeclarationList(scope.initializer) &&
    (scope.initializer.flags & ts.NodeFlags.BlockScoped) !== 0
  ) {
    for (const d of scope.initializer.declarations.nodes) addBindingNames(d.name, out);
  } else if (
    (ts.isClassDeclaration(scope) || ts.isClassExpression(scope)) &&
    scope.name !== undefined
  ) {
    out.add(scope.name.text);
  }
  return out;
}

/** Resolves references against one bundle's scopes, keeping each scope's
 * names for the bundle's split. */
class BundleScopes {
  private readonly names = new Map<ts.Node, Set<string>>();
  private readonly parameterNames = new Map<ts.Node, Set<string>>();

  private of(scope: ts.Node): Set<string> {
    let names = this.names.get(scope);
    if (names === undefined) {
      names = scopeNames(scope);
      this.names.set(scope, names);
    }
    return names;
  }

  /** The names `scope` binds for a reference reached through its child
   * `from`: a function's parameter list sees its parameters and own name
   * but not its body's `var`s, and a computed method name sees none of
   * them. */
  private visible(scope: ts.Node, from: ts.Node): ReadonlySet<string> {
    if (!isFunctionScope(scope) || from === scope.body) return this.of(scope);
    if (from === scope.name) return NO_NAMES;
    let names = this.parameterNames.get(scope);
    if (names === undefined) {
      names = parameterScopeNames(scope);
      this.parameterNames.set(scope, names);
    }
    return names;
  }

  /** True when a scope between the reference and `root` (inclusive)
   * binds its name. */
  boundWithin(id: ts.Identifier, root: ts.Node): boolean {
    for (let from: ts.Node = id, n = id.parent; n !== undefined; from = n, n = n.parent) {
      if (this.visible(n, from).has(id.text)) return true;
      if (n === root) return false;
    }
    return false;
  }

  /** True when a scope inside `root` (exclusive) binds the reference's
   * name. */
  boundInside(id: ts.Identifier, root: ts.Node): boolean {
    for (
      let from: ts.Node = id, n = id.parent;
      n !== undefined && n !== root;
      from = n, n = n.parent
    ) {
      if (this.visible(n, from).has(id.text)) return true;
    }
    return false;
  }

  /** True when the reference resolves to a top-level binding of `sf`. */
  topLevel(id: ts.Identifier, sf: ts.SourceFile): boolean {
    for (
      let from: ts.Node = id, n = id.parent;
      n !== undefined && n !== sf;
      from = n, n = n.parent
    ) {
      if (this.visible(n, from).has(id.text)) return false;
    }
    return true;
  }
}

/** Every binding reference inside a subtree. */
export function references(root: ts.Node): ts.Identifier[] {
  const out: ts.Identifier[] = [];
  ts.walkPreorder(root, (n) => {
    if (n.kind >= ts.SyntaxKind.FirstJSDocNode && n.kind <= ts.SyntaxKind.LastJSDocNode)
      return "skip";
    if (ts.isIdentifier(n) && isReference(n)) out.push(n);
    return undefined;
  });
  return out;
}

/** True when the reference is written (assignment target, update operand,
 * loop target, delete operand). */
export function isWritten(id: ts.Identifier): boolean {
  let child: ts.Node = id;
  for (let p = child.parent; p !== undefined; child = p, p = p.parent) {
    if (ts.isBinaryExpression(p)) {
      return (
        p.left === child &&
        p.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        p.operatorToken.kind <= ts.SyntaxKind.LastAssignment
      );
    }
    if (ts.isPrefixUnaryExpression(p) || ts.isPostfixUnaryExpression(p)) {
      return (
        p.operator === ts.SyntaxKind.PlusPlusToken || p.operator === ts.SyntaxKind.MinusMinusToken
      );
    }
    if (ts.isForInStatement(p) || ts.isForOfStatement(p)) return p.initializer === child;
    if (ts.isDeleteExpression(p)) return true;
    if (
      !(
        ts.isParenthesizedExpression(p) ||
        ts.isArrayLiteralExpression(p) ||
        ts.isObjectLiteralExpression(p) ||
        ts.isShorthandPropertyAssignment(p) ||
        ts.isPropertyAssignment(p) ||
        ts.isSpreadElement(p)
      )
    )
      return false;
  }
  return false;
}

/** The recognized __commonJS helper forms, as token templates over the
 * helper's own parameter names (CB, MOD) and the own-key reader (KEYS:
 * esbuild's `__getOwnPropNames` alias, or `Object.keys` in esbuild 0.11):
 *   keyed: `(CB, MOD) => function [name]() { return <keyed>; }` — the
 *     factory is the only method of an object literal;
 *   arrow: `(CB, MOD) => () => (<arrow>)` — the factory itself. */
const KEYED_RETURN =
  "MOD || (0, CB[KEYS(CB)[0]])((MOD = { exports: {} }).exports, MOD), MOD.exports";
const ARROW_BODY = "(MOD || CB((MOD = { exports: {} }).exports, MOD), MOD.exports)";

function template(text: string, cb: string, mod: string, keys: string): string | null {
  return helperTokens(
    text
      .replace(/\bCB\b/g, cb)
      .replace(/\bMOD\b/g, mod)
      .replace(/\bKEYS\b/g, keys),
  );
}

type HelperForm = "keyed" | "arrow";

/** The helper's form, or null when its initializer is not recognized.
 * `ownNames` answers whether an identifier names the verified
 * Object.getOwnPropertyNames alias. */
function helperForm(
  init: ts.Expression,
  sf: ts.SourceFile,
  ownNames: (name: string) => boolean,
): HelperForm | null {
  const fn = unparen(init);
  if (!ts.isArrowFunction(fn) || fn.parameters.nodes.length !== 2) return null;
  const params = fn.parameters.nodes.map((p) =>
    ts.isIdentifier(p.name) && p.initializer === undefined && p.dotDotDotToken === undefined
      ? p.name.text
      : null,
  );
  const [cb, mod] = params;
  if (cb === null || mod === null || cb === undefined || mod === undefined || cb === mod)
    return null;
  if (ts.isBlock(fn.body)) return null;
  const body = unparen(fn.body);
  if (ts.isFunctionExpression(body)) {
    if (body.parameters.nodes.length !== 0 || body.asteriskToken || body.modifiers?.nodes.length)
      return null;
    const stmts = body.body.statements.nodes;
    const ret = stmts[0];
    if (stmts.length !== 1 || ret === undefined || !ts.isReturnStatement(ret) || !ret.expression)
      return null;
    const actual = helperTokens(getTextOfNode(ret.expression));
    if (actual === null) return null;
    // The own-key reader: esbuild's alias or the 0.11 spelling.
    const keysRef = /\[\s*([A-Za-z_$][\w$]*(?:\.keys)?)\s*\(/.exec(getTextOfNode(ret.expression));
    const keys = keysRef?.[1];
    if (keys === undefined || (keys !== "Object.keys" && !ownNames(keys))) return null;
    return actual === template(KEYED_RETURN, cb, mod, keys) ? "keyed" : null;
  }
  if (ts.isArrowFunction(body) && body.parameters.nodes.length === 0 && !ts.isBlock(body.body)) {
    const actual = helperTokens(getTextOfNode(body.body));
    return actual !== null && actual === template(ARROW_BODY, cb, mod, "") ? "arrow" : null;
  }
  return null;
}

/** A top-level declaration the virtual chunk can copy verbatim: a pure
 * helper whose evaluation runs nothing (a function, or a member read of
 * Object such as `Object.create` / `Object.prototype.hasOwnProperty`). */
function copyableInitializer(init: ts.Expression | undefined): boolean {
  if (init === undefined) return false;
  const e = unparen(init);
  if (ts.isArrowFunction(e) || ts.isFunctionExpression(e)) return true;
  let walk: ts.Expression = e;
  let depth = 0;
  while (ts.isPropertyAccessExpression(walk) && ts.isIdentifier(walk.name)) {
    walk = walk.expression;
    depth++;
  }
  return depth > 0 && ts.isIdentifier(walk) && walk.text === "Object";
}

/** A top-level declaration whose value is a function. */
function isFunctionValued(node: ts.VariableDeclaration | ts.FunctionDeclaration): boolean {
  if (ts.isFunctionDeclaration(node)) return true;
  const init = node.initializer && unparen(node.initializer);
  return init !== undefined && (ts.isArrowFunction(init) || ts.isFunctionExpression(init));
}

/** True when a named function expression initializer (`var f = function
 * self() {}`) uses its own name only as a callee: `self` is the copied
 * function, so it is as observable as the top-level binding. */
function selfCalledOnly(
  node: ts.VariableDeclaration | ts.FunctionDeclaration,
  scopes: BundleScopes,
): boolean {
  if (!ts.isVariableDeclaration(node) || node.initializer === undefined) return true;
  const fn = unparen(node.initializer);
  if (!ts.isFunctionExpression(fn) || fn.name === undefined || fn.body === undefined) return true;
  const self = fn.name.text;
  // A parameter of the same name hides the function's own name everywhere
  // in it; a `var` of the same name hides it only in the body, since the
  // parameter initializers do not see the body's `var`s.
  if (fn.parameters.nodes.some((p) => bindsName(p.name, self))) return true;
  const bodyVar = varScopedNames(fn.body).has(self);
  const body = fn.body;
  return references(fn).every(
    (r) =>
      r.text !== self || scopes.boundInside(r, fn) || (bodyVar && within(r, body)) || isCallee(r),
  );
}

/** True when a binding name (an identifier or a destructuring pattern)
 * declares `name`. */
function bindsName(binding: ts.BindingName, name: string): boolean {
  const names = new Set<string>();
  addBindingNames(binding, names);
  return names.has(name);
}

/** True when a reference is the function a call invokes: `f(...)`, or the
 * `(0, f)(...)` form that drops the receiver. */
function isCallee(id: ts.Identifier): boolean {
  let callee: ts.Node = id;
  const p = id.parent;
  if (
    p !== undefined &&
    ts.isBinaryExpression(p) &&
    p.operatorToken.kind === ts.SyntaxKind.CommaToken &&
    p.right === id &&
    p.parent !== undefined &&
    ts.isParenthesizedExpression(p.parent)
  )
    callee = p.parent;
  while (callee.parent !== undefined && ts.isParenthesizedExpression(callee.parent))
    callee = callee.parent;
  const call = callee.parent;
  return call !== undefined && ts.isCallExpression(call) && call.expression === callee;
}

/** One recognized chunk declaration. */
interface Chunk {
  name: string;
  stmt: ts.VariableStatement;
  params: string[];
  body: ts.Block;
  path: string;
  spec: string;
  /** The keyed helper form's module key (the bundled file's path). */
  key: string | null;
}

interface TopLevel {
  stmt: ts.Statement;
  /** The declarator (or function declaration) itself. */
  node: ts.VariableDeclaration | ts.FunctionDeclaration;
}

/** True when the file opens with a "use strict" directive prologue. */
export function strictPrologue(stmts: readonly ts.Statement[]): boolean {
  for (const s of stmts) {
    if (!ts.isExpressionStatement(s) || !ts.isStringLiteral(s.expression)) return false;
    if (s.expression.text === "use strict") return true;
  }
  return false;
}

/** A cheap text probe: the helper's name, or its minified body's
 * `(m={exports:{}}).exports,m` fragment. */
export function mayBundleChunks(source: string): boolean {
  return (
    source.includes("__commonJS") ||
    /\{\s*exports\s*:\s*\{\s*\}\s*\}\s*\)\s*\.exports\s*,/.test(source)
  );
}

/** Splits a CommonJS bundle's __commonJS chunks into virtual modules (see
 * the header). Null: no chunks (or not a CommonJS bundle) — serve the file
 * unchanged. */
export function splitBundledChunks(
  sf: ts.SourceFile,
  filePath: string,
): BundledChunkSplit | { degrade: string } | null {
  const source = sf.text;
  if (!mayBundleChunks(source)) return null;
  // ES-module bundles have no require: their chunks keep the existing
  // treatment (the Bun factory recognizer, or the ESM interop refusal).
  if (!filePath.endsWith(".cjs") && ts.isExternalModule(sf)) return null;

  const top = new Map<string, TopLevel>();
  const duplicate = new Set<string>();
  for (const stmt of sf.statements.nodes) {
    const add = (name: string, node: TopLevel["node"]): void => {
      if (top.has(name)) duplicate.add(name);
      else top.set(name, { stmt, node });
    };
    if (ts.isFunctionDeclaration(stmt) && stmt.name !== undefined) add(stmt.name.text, stmt);
    else if (ts.isVariableStatement(stmt)) {
      for (const d of stmt.declarationList.declarations.nodes) {
        if (ts.isIdentifier(d.name)) add(d.name.text, d);
      }
    }
  }
  let helperNames = [...top.keys()].filter((n) => helperBase(n) === "__commonJS");

  // Every name a recognizer relies on is written nowhere and declared
  // once at the top level; `Object` itself is never rebound.
  const allRefs = references(sf);
  const written = new Set<string>();
  for (const r of allRefs) if (isWritten(r)) written.add(r.text);
  const declaredAnywhere = declaredNames(sf);
  if (declaredAnywhere.has("Object") || written.has("Object"))
    return { degrade: CHUNK_SHAPE_DEGRADE };
  const stable = (name: string): boolean => !duplicate.has(name) && !written.has(name);
  // Names whose every reference in the bundle is a callee: `f(...)` or the
  // `(0, f)(...)` form.
  const scopes = new BundleScopes();
  const valueUsed = new Set<string>();
  for (const r of allRefs) if (!isCallee(r) && scopes.topLevel(r, sf)) valueUsed.add(r.text);
  const calledOnly = (name: string): boolean => !valueUsed.has(name);
  const ownNames = (name: string): boolean => {
    const t = top.get(name);
    if (t === undefined || !stable(name) || !ts.isVariableDeclaration(t.node)) return false;
    const init = t.node.initializer;
    return (
      init !== undefined &&
      helperTokens(getTextOfNode(init)) === helperTokens("Object.getOwnPropertyNames")
    );
  };
  if (helperNames.length === 0) {
    // An identifier-minified bundle: the helper's shape under another name.
    helperNames = [...top].flatMap(([name, t]) => {
      const init = ts.isVariableDeclaration(t.node) ? t.node.initializer : undefined;
      return init !== undefined && stable(name) && helperForm(init, sf, ownNames) !== null
        ? [name]
        : [];
    });
    if (helperNames.length === 0) return null;
  }
  const forms = new Map<string, HelperForm>();
  for (const name of helperNames) {
    const t = top.get(name)!;
    const init = ts.isVariableDeclaration(t.node) ? t.node.initializer : undefined;
    const form = init !== undefined && stable(name) ? helperForm(init, sf, ownNames) : null;
    if (form === null) return { degrade: CHUNK_SHAPE_DEGRADE };
    forms.set(name, form);
  }

  // The chunk declarations: `var NAME = HELPER(factory);`, one declarator.
  const chunks = new Map<string, Chunk>();
  const base = filePath.replace(/^.*[\\/]/, "");
  for (const [name, t] of top) {
    if (!ts.isVariableDeclaration(t.node) || t.node.initializer === undefined) continue;
    const call = unparen(t.node.initializer);
    if (!ts.isCallExpression(call) || !ts.isIdentifier(call.expression)) continue;
    const form = forms.get(call.expression.text);
    if (form === undefined) continue;
    const stmt = t.stmt;
    if (
      !ts.isVariableStatement(stmt) ||
      stmt.declarationList.declarations.nodes.length !== 1 ||
      call.arguments.nodes.length !== 1 ||
      !stable(name)
    )
      return { degrade: CHUNK_SHAPE_DEGRADE };
    let factory: ts.Node = call.arguments.nodes[0]!;
    let key: string | null = null;
    if (form === "keyed") {
      if (!ts.isObjectLiteralExpression(factory) || factory.properties.nodes.length !== 1)
        return { degrade: CHUNK_SHAPE_DEGRADE };
      factory = factory.properties.nodes[0]!;
      if (!ts.isMethodDeclaration(factory) || ts.isComputedPropertyName(factory.name))
        return { degrade: CHUNK_SHAPE_DEGRADE };
      if (ts.isStringLiteral(factory.name)) key = factory.name.text;
    } else {
      factory = unparen(factory as ts.Expression);
      if (!ts.isArrowFunction(factory) && !ts.isFunctionExpression(factory))
        return { degrade: CHUNK_SHAPE_DEGRADE };
    }
    const fn = factory as ts.MethodDeclaration | ts.ArrowFunction | ts.FunctionExpression;
    if (
      fn.body === undefined ||
      !ts.isBlock(fn.body) ||
      fn.asteriskToken !== undefined ||
      (fn.modifiers?.nodes.length ?? 0) > 0 ||
      fn.parameters.nodes.length > 2
    )
      return { degrade: CHUNK_SHAPE_DEGRADE };
    const params: string[] = [];
    for (const p of fn.parameters.nodes) {
      if (!ts.isIdentifier(p.name) || p.initializer !== undefined || p.dotDotDotToken)
        return { degrade: CHUNK_SHAPE_DEGRADE };
      params.push(p.name.text);
    }
    const file = `${base}.${name}.cjs`;
    chunks.set(name, {
      name,
      stmt,
      params,
      body: fn.body,
      path: filePath.slice(0, filePath.length - base.length) + file,
      spec: `./${file}`,
      key,
    });
  }
  if (chunks.size === 0) return null;

  // Every factory reference is a direct zero-argument call. Calls inside a
  // chunk body belong to that chunk's text, the rest to the bundle's.
  const callEdits: Edit[] = [];
  const callNames: string[] = [];
  const unaliased = new Set<string>();
  for (const r of allRefs) {
    const chunk = chunks.get(r.text);
    if (chunk === undefined) continue;
    callNames.push(chunk.name);
    const call = r.parent;
    if (
      call === undefined ||
      !ts.isCallExpression(call) ||
      call.expression !== r ||
      call.arguments.nodes.length !== 0 ||
      call.questionDotToken !== undefined
    )
      return {
        degrade: `its bundled CommonJS module factory '${r.text}' is used other than as a direct call`,
      };
    const alias = builtinAliasOfChunk(chunk);
    const aliased = alias === null ? null : aliasReplacement(call, alias);
    if (alias !== null && aliased === null) unaliased.add(chunk.name);
    const forwarded =
      forwarderSpec(chunk) ?? (shimOfChunk(chunk) !== null ? shimSpec(chunk) : null);
    callEdits.push({
      start: tokenStartOfNode(call),
      end: call.end,
      text: aliased ?? `require(${JSON.stringify(forwarded ?? chunk.spec)})`,
    });
  }
  // A chunk keeps its module when any call site's use left the alias
  // undetermined; every call site then requires the module.
  if (unaliased.size > 0) {
    for (let i = 0; i < callEdits.length; i++) {
      const name = callNames[i]!;
      if (!unaliased.has(name)) continue;
      const chunk = chunks.get(name)!;
      callEdits[i] = {
        ...callEdits[i]!,
        text: `require(${JSON.stringify(forwarderSpec(chunk) ?? chunk.spec)})`,
      };
    }
  }
  for (const name of chunks.keys()) {
    if (declaredAnywhere.has(name) && countDeclarations(sf, name) > 1)
      return { degrade: CHUNK_SHAPE_DEGRADE };
  }

  const bundleStrict = strictPrologue(sf.statements.nodes);
  const out: BundledChunkSplit["chunks"] = [];
  const bundleEdits: Edit[] = [...callEdits];
  for (const chunk of chunks.values()) {
    if (!unaliased.has(chunk.name) && builtinAliasOfChunk(chunk) !== null) {
      // A chunk of a package that IS a builtin on Node 24 is that builtin.
      bundleEdits.push({ start: tokenStartOfNode(chunk.stmt), end: chunk.stmt.end, text: "" });
      continue;
    }
    const shim = shimOfChunk(chunk);
    if (shim !== null) {
      // A bundled copy of a package scriptc implements itself is the
      // package's shim (package-shims.ts), reached through a forwarder
      // declaration the checker follows.
      out.push({
        path: shimDeclPath(chunk),
        source: bundledShimForwarder(shimDeclPath(chunk), shim),
      });
      bundleEdits.push({ start: tokenStartOfNode(chunk.stmt), end: chunk.stmt.end, text: "" });
      continue;
    }
    if (forwarderSpec(chunk) !== null) {
      // A chunk that only re-exports a builtin module is that module.
      bundleEdits.push({ start: tokenStartOfNode(chunk.stmt), end: chunk.stmt.end, text: "" });
      continue;
    }
    const result = chunkSource(
      sf,
      chunk,
      chunks,
      top,
      stable,
      calledOnly,
      scopes,
      callEdits,
      bundleStrict,
    );
    if (typeof result !== "string") return result;
    out.push({ path: chunk.path, source: result });
    bundleEdits.push({ start: tokenStartOfNode(chunk.stmt), end: chunk.stmt.end, text: "" });
  }
  return { text: applyEdits(source, 0, source.length, bundleEdits), chunks: out };
}

export function countDeclarations(sf: ts.Node, name: string): number {
  let n = 0;
  ts.walkPreorder(sf, (node) => {
    if (
      (ts.isVariableDeclaration(node) ||
        ts.isParameter(node) ||
        ts.isBindingElement(node) ||
        ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isClassDeclaration(node) ||
        ts.isClassExpression(node)) &&
      node.name !== undefined &&
      ts.isIdentifier(node.name) &&
      node.name.text === name
    )
      n++;
    return undefined;
  });
  return n;
}

/** Applies non-overlapping edits inside [from, to): replaced spans keep
 * their newlines (blanked text stays line-aligned); edits nested in a
 * blanked span vanish with it. */
export function applyEdits(source: string, from: number, to: number, edits: Edit[]): string {
  const inside = edits
    .filter((e) => e.start >= from && e.end <= to)
    .sort((a, b) => a.start - b.start || b.end - a.end);
  let text = "";
  let at = from;
  for (const e of inside) {
    if (e.start < at) continue; // nested in an earlier edit
    text += source.slice(at, e.start);
    const replaced = source.slice(e.start, e.end);
    // A respelled span keeps its line breaks after the replacement.
    text +=
      e.text === "" ? replaced.replace(/[^\r\n]/g, " ") : e.text + replaced.replace(/[^\n]/g, "");
    at = e.end;
  }
  return text + source.slice(at, to);
}

/* Use analysis for a require of a builtin-aliased module
 * (npm-static-builtin-aliases.ts). */

function isAssignmentTarget(node: ts.Node): boolean {
  const p = node.parent;
  return (
    p !== undefined &&
    ts.isBinaryExpression(p) &&
    p.left === node &&
    p.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
    p.operatorToken.kind <= ts.SyntaxKind.LastAssignment
  );
}

/** The outermost expression the call's value flows through unchanged
 * (parentheses). */
function valueNode(call: ts.Expression): ts.Expression {
  let e: ts.Expression = call;
  while (e.parent !== undefined && ts.isParenthesizedExpression(e.parent)) e = e.parent;
  return e;
}

type Use = "member" | "value" | "invalid";

/** How one occurrence of the module value is used: a read of a carried
 * member, any other value use (member reads of other names included, which
 * the class itself answers), or a write that keeps the package. */
function useOf(node: ts.Expression, names: ReadonlySet<string>): Use {
  const p = node.parent;
  if (p !== undefined && ts.isPropertyAccessExpression(p) && p.expression === node) {
    if (isAssignmentTarget(p) || p.questionDotToken !== undefined) return "invalid";
    return names.has(p.name.text) ? "member" : "value";
  }
  if (p !== undefined && ts.isElementAccessExpression(p) && p.expression === node) return "invalid";
  return "value";
}

function scopeRoot(node: ts.Node): ts.Node {
  for (let p = node.parent; p !== undefined; p = p.parent) {
    if (ts.isFunctionLike(p) || ts.isSourceFile(p)) return p;
  }
  return node;
}

/** The text replacing a require of an aliased module, or null when its uses
 * do not determine one or when the file declares the global the text
 * starts with (`process`, `Array`): the text would read that binding
 * instead of the builtin. `require` roots are the require the call site
 * already uses. */
export function aliasReplacement(call: ts.CallExpression, alias: BuiltinAlias): string | null {
  const text = aliasUseReplacement(call, alias);
  if (text === null) return null;
  const root = /^[A-Za-z_$][\w$]*/.exec(text)?.[0];
  if (
    root !== undefined &&
    root !== "require" &&
    countDeclarations(ts.getSourceFileOfNode(call), root) > 0
  )
    return null;
  return text;
}

function aliasUseReplacement(call: ts.CallExpression, alias: BuiltinAlias): string | null {
  const members = alias.members;
  if (members === undefined) return alias.whole;
  const whole = alias.whole;
  const node = valueNode(call);
  const p = node.parent;
  let uses: Use[];
  if (p !== undefined && ts.isVariableDeclaration(p) && p.initializer === node) {
    if (ts.isObjectBindingPattern(p.name)) {
      const ok = p.name.elements.nodes.every((el) => {
        if (el.dotDotDotToken !== undefined) return false;
        const key = el.propertyName ?? el.name;
        return ts.isIdentifier(key) && members.names.has(key.text);
      });
      return ok ? members.object : null;
    }
    if (!ts.isIdentifier(p.name)) return null;
    const name = p.name.text;
    const root = scopeRoot(p);
    if (countDeclarations(root as ts.SourceFile, name) !== 1) return null;
    const list = p.parent;
    // `var` hoisting: a read before the declaration sees undefined.
    if (list === undefined || !ts.isVariableDeclarationList(list)) return null;
    uses = [];
    for (const ref of references(root)) {
      if (ref.text !== name) continue;
      if (isWritten(ref) || ref.pos < p.end) return null;
      uses.push(useOf(ref, members.names));
    }
  } else {
    uses = [useOf(node, members.names)];
  }
  if (uses.includes("invalid")) return null;
  if (uses.length > 0 && uses.every((u) => u === "member")) return members.object;
  if (uses.every((u) => u === "value")) return whole;
  return null;
}

/** The builtin a chunk's module is on Node 24, when its key names an
 * aliased package at a checked version (builtin-package-aliases.ts). */
function builtinAliasOfChunk(chunk: Chunk): BuiltinAlias | null {
  if (chunk.key === null) return null;
  const pkg = versionedPackageOfKey(chunk.key);
  return pkg === null ? null : builtinAliasOf(pkg.name, pkg.version, pkg.subpath);
}

/** The shim module standing in for a chunk that is a bundled copy of a
 * shimmed package's main file at a supported version, or null. */
function shimOfChunk(chunk: Chunk): string | null {
  if (chunk.key === null) return null;
  const pkg = versionedPackageOfKey(chunk.key);
  return pkg === null ? null : packageShimForBundledFile(pkg.name, pkg.version, pkg.subpath);
}

/** The forwarder declaration beside the bundle for a shimmed chunk, and
 * the specifier its call sites require. */
function shimDeclPath(chunk: Chunk): string {
  return chunk.path.replace(/\.cjs$/, ".shim.d.ts");
}

function shimSpec(chunk: Chunk): string {
  return chunk.spec.replace(/\.cjs$/, ".shim");
}

/** The builtin module a chunk forwards, or null: a body that is exactly
 * `module.exports = require("<builtin>")` (readable-stream's
 * internal/streams/stream.js). Requiring the chunk is then requiring the
 * builtin itself (same object, and loading a builtin runs no code). */
function forwarderSpec(chunk: Chunk): string | null {
  const moduleParam = chunk.params[1];
  if (moduleParam === undefined) return null;
  const stmts = chunk.body.statements.nodes.filter(
    (st) => !(ts.isExpressionStatement(st) && ts.isStringLiteral(st.expression)),
  );
  const only = stmts[0];
  if (stmts.length !== 1 || only === undefined || !ts.isExpressionStatement(only)) return null;
  const e = unparen(only.expression);
  if (
    !ts.isBinaryExpression(e) ||
    e.operatorToken.kind !== ts.SyntaxKind.EqualsToken ||
    !ts.isPropertyAccessExpression(e.left) ||
    !ts.isIdentifier(e.left.expression) ||
    e.left.expression.text !== moduleParam ||
    e.left.name.text !== "exports"
  )
    return null;
  const call = unparen(e.right);
  if (
    !ts.isCallExpression(call) ||
    !ts.isIdentifier(call.expression) ||
    call.expression.text !== "require" ||
    call.arguments.nodes.length !== 1 ||
    !ts.isStringLiteral(call.arguments.nodes[0]!)
  )
    return null;
  const spec = (call.arguments.nodes[0] as ts.StringLiteral).text;
  return canonicalBuiltinModule(spec) !== null ? spec : null;
}

/** How code in a factory body (a chunk or a lazy ES-module initializer)
 * observes the factory's own frame, or null: its receiver, its arguments
 * object, `super`, a meta property, or (when `returns`) a top-level
 * return have no module-scope equivalent. */
export function factoryFrameUse(body: ts.Block, returns: boolean): string | null {
  let frameUse: string | null = null;
  /** The innermost frame boundary between a node and the factory body. */
  const frameOf = (n: ts.Node): "factory" | "arrow" | "function" => {
    let arrow = false;
    for (let p = n.parent; p !== undefined && p !== body; p = p.parent) {
      if (
        ts.isFunctionDeclaration(p) ||
        ts.isFunctionExpression(p) ||
        ts.isMethodDeclaration(p) ||
        ts.isGetAccessorDeclaration(p) ||
        ts.isSetAccessorDeclaration(p) ||
        ts.isConstructorDeclaration(p) ||
        ts.isClassDeclaration(p) ||
        ts.isClassExpression(p)
      )
        return "function";
      if (ts.isArrowFunction(p)) arrow = true;
    }
    return arrow ? "arrow" : "factory";
  };
  ts.walkPreorder(body, (n) => {
    if (frameUse !== null) return "stop";
    if (n.kind >= ts.SyntaxKind.FirstJSDocNode && n.kind <= ts.SyntaxKind.LastJSDocNode)
      return "skip";
    let use: string | null = null;
    if (n.kind === ts.SyntaxKind.ThisKeyword) use = "reads its factory's receiver (`this`)";
    else if (n.kind === ts.SyntaxKind.SuperKeyword) use = "reads `super` at its top level";
    else if (ts.isIdentifier(n) && n.text === "arguments" && isReference(n))
      use = "reads its factory's arguments object";
    else if (ts.isMetaProperty(n)) use = "reads a meta property at its top level";
    else if (ts.isReturnStatement(n)) {
      if (returns && frameOf(n) === "factory") frameUse = "returns from its top level";
      return undefined;
    }
    if (use !== null && frameOf(n) !== "function") frameUse = use;
    return undefined;
  });
  return frameUse;
}

/** The virtual module text for one chunk, or a degrade reason. */
function chunkSource(
  sf: ts.SourceFile,
  chunk: Chunk,
  chunks: ReadonlyMap<string, Chunk>,
  top: ReadonlyMap<string, TopLevel>,
  stable: (name: string) => boolean,
  calledOnly: (name: string) => boolean,
  scopes: BundleScopes,
  callEdits: readonly Edit[],
  bundleStrict: boolean,
): string | { degrade: string } {
  const why = (reason: string): { degrade: string } => ({
    degrade: `its bundled CommonJS module '${chunk.name}' ${reason}`,
  });
  const [exportsParam, moduleParam] = chunk.params;
  const body = chunk.body;
  const local = declaredNames(body);
  for (const p of chunk.params) {
    if (
      local.has(p) ||
      (p !== "exports" && local.has("exports")) ||
      (p !== "module" && local.has("module"))
    )
      return why(
        "rebinds its module parameters inside its body (an identifier-minified bundle the recognizer cannot respell)",
      );
  }

  const frameUse = factoryFrameUse(body, true);
  if (frameUse !== null) return why(frameUse);

  const edits: Edit[] = callEdits.filter((e) => e.start >= body.pos && e.end <= body.end);
  const copied = new Set<string>();
  const copyQueue: string[] = [];
  for (const r of references(body)) {
    const name = r.text;
    if (chunks.has(name)) continue; // a call edit already respells it
    if (name === exportsParam || name === moduleParam) {
      if (name === moduleParam) {
        const p = r.parent;
        if (!ts.isPropertyAccessExpression(p) || p.expression !== r || p.name.text !== "exports")
          return why("uses its module object beyond module.exports");
      }
      const global = name === exportsParam ? "exports" : "module";
      if (name !== global) {
        const p = r.parent;
        edits.push(
          ts.isShorthandPropertyAssignment(p)
            ? { start: tokenStartOfNode(r), end: r.end, text: `${name}: ${global}` }
            : { start: tokenStartOfNode(r), end: r.end, text: global },
        );
      }
      continue;
    }
    // The factory function itself binds the parameters and `var`s.
    if (scopes.boundWithin(r, body.parent ?? body)) continue;
    if (name === "exports" || name === "module")
      return why(`reads the bundle's own '${name}' binding`);
    if (name === "__filename") return why("reads __filename, which names the bundle file");
    if (top.has(name)) {
      if (!copied.has(name)) {
        copied.add(name);
        copyQueue.push(name);
      }
    }
  }

  // The pure helpers BODY reads, closed over their own top-level reads.
  const header: string[] = [];
  for (let i = 0; i < copyQueue.length; i++) {
    const name = copyQueue[i]!;
    const t = top.get(name)!;
    const node = t.node;
    const pure =
      stable(name) &&
      (ts.isFunctionDeclaration(node) ||
        (ts.isVariableDeclaration(node) && copyableInitializer(node.initializer)));
    if (!pure || chunks.has(name))
      return why(`reads the bundle's top-level binding '${name}', which it cannot carry along`);
    // Each chunk gets its own copy, so a function's identity and its
    // properties must stay unobservable: the bundle only ever calls it.
    if (isFunctionValued(node) && (!calledOnly(name) || !selfCalledOnly(node, scopes)))
      return why(
        `uses the bundle's top-level function '${name}' as a value, which its chunks cannot share`,
      );
    for (const r of references(node)) {
      if (scopes.boundWithin(r, node) || !top.has(r.text) || copied.has(r.text)) continue;
      copied.add(r.text);
      copyQueue.push(r.text);
    }
  }
  // Declaration order of the bundle: a helper reads only earlier ones.
  const ordered = [...copied].sort(
    (a, b) => tokenStartOfNode(top.get(a)!.node) - tokenStartOfNode(top.get(b)!.node),
  );
  for (const name of ordered) {
    const node = top.get(name)!.node;
    header.push(
      ts.isFunctionDeclaration(node) ? getTextOfNode(node) : `var ${getTextOfNode(node)};`,
    );
  }

  const bodyStrict = strictPrologue(body.statements.nodes);
  const text = applyEdits(sf.text, tokenStartOfNode(body) + 1, body.end - 1, edits);
  const prologue = bundleStrict || bodyStrict ? '"use strict";\n' : "";
  return prologue + (header.length > 0 ? header.join("\n") + "\n" : "") + text + "\n";
}
