/* Lazily initialized ES modules in a CommonJS bundle. esbuild scope-hoists
 * every ES module it bundles into the bundle's own scope; one that some
 * code require()s instead of importing runs from a lazy initializer,
 *
 *   var COUNT, import_fs;
 *   var init_x = __esm({ "src/x.ts"() { import_fs = __toESM(require("fs")); COUNT = 0; } });
 *
 * and the requiring site reads its namespace as
 * `(init_x(), __toCommonJS(x_exports))`. `init_x()` runs the body once (a
 * call during the body answers immediately). The pass below keeps that
 * shape in the bundle's scope and respells only what has no static
 * representation:
 *
 *   - the initializer becomes a run-once closure over the same body;
 *   - an interop binding the body assigns once from require() (`import_fs`
 *     above) becomes that require at the assignment's position, and its
 *     member reads become member reads of the required module, exactly
 *     like the top-level interop erasure (npm-static-rewrite-syntax.ts);
 *   - a namespace read only through member reads becomes an object
 *     literal of getters over the module's live bindings (what
 *     __toCommonJS copies, minus the non-enumerable __esModule mark no
 *     member read can reach).
 *
 * The respelled interop reads resolve the required module even if they
 * ran before the initializer, where Node would read a member of
 * undefined and throw; esbuild only reaches them through the module's
 * own code, which runs after its initializer. Shapes outside the
 * recognized forms answer a degrade reason. */
import * as ts from "./ts7/syntax.js";
import { bareRequireSpecOf } from "./cjs-syntax.js";
import { helperTokens } from "./helper-tokens.js";
import { canonicalBuiltinModule } from "./builtin-modules.js";
import {
  applyEdits,
  countDeclarations,
  declaredNames,
  factoryFrameUse,
  helperBase,
  isWritten,
  references,
  strictPrologue,
  unparen,
  type Edit,
} from "./npm-static-bundled-chunks.js";
import { getTextOfNode, tokenStartOfNode } from "./ts7/node-functions.js";

export interface EsmInitHost {
  requireTargetEsModuleStamped(fromFile: string, specifier: string): boolean;
}

/** A top-level binding of the bundle: its statement and declaration. */
interface Top {
  stmt: ts.Statement;
  node: ts.VariableDeclaration | ts.FunctionDeclaration;
}

/** A lazy initializer: its declaration's `__esm(...)` call and body. */
interface InitBody {
  name: string;
  call: ts.CallExpression;
  body: ts.Block;
}

const ESM_SHAPE_DEGRADE =
  "its shipped JS initializes bundled ES modules through the __esm helper in a shape the " +
  "recognizer cannot verify";

/* The recognized __esm forms over its parameter names (FN, RES) and the
 * own-key reader (KEYS): keyed `(FN, RES) => function [name]() { return
 * <keyed>; }` with a one-method object argument, and arrow
 * `(FN, RES) => () => (<arrow>)` with a function argument. */
const KEYED_RETURN = "FN && (RES = (0, FN[KEYS(FN)[0]])(FN = 0)), RES";
const ARROW_BODY = "(FN && (RES = FN(FN = 0)), RES)";

function template(text: string, fn: string, res: string, keys: string): string | null {
  return helperTokens(
    text
      .replace(/\bFN\b/g, fn)
      .replace(/\bRES\b/g, res)
      .replace(/\bKEYS\b/g, keys),
  );
}

function esmHelperForm(
  init: ts.Expression,
  sf: ts.SourceFile,
  ownNames: (name: string) => boolean,
): "keyed" | "arrow" | null {
  const fn = unparen(init);
  if (!ts.isArrowFunction(fn) || fn.parameters.nodes.length !== 2 || ts.isBlock(fn.body))
    return null;
  const [p0, p1] = fn.parameters.nodes;
  if (
    !p0 ||
    !p1 ||
    !ts.isIdentifier(p0.name) ||
    !ts.isIdentifier(p1.name) ||
    p0.initializer ||
    p1.initializer ||
    p0.name.text === p1.name.text
  )
    return null;
  const [f, r] = [p0.name.text, p1.name.text];
  const body = unparen(fn.body);
  if (ts.isFunctionExpression(body)) {
    if (body.parameters.nodes.length !== 0 || body.asteriskToken || body.modifiers?.nodes.length)
      return null;
    const stmts = body.body.statements.nodes;
    const ret = stmts[0];
    if (stmts.length !== 1 || !ret || !ts.isReturnStatement(ret) || !ret.expression) return null;
    const text = getTextOfNode(ret.expression);
    const keys = /\[\s*([A-Za-z_$][\w$]*(?:\.keys)?)\s*\(/.exec(text)?.[1];
    if (keys === undefined || (keys !== "Object.keys" && !ownNames(keys))) return null;
    return helperTokens(text) === template(KEYED_RETURN, f, r, keys) ? "keyed" : null;
  }
  if (ts.isArrowFunction(body) && body.parameters.nodes.length === 0 && !ts.isBlock(body.body)) {
    const actual = helperTokens(getTextOfNode(body.body));
    return actual !== null && actual === template(ARROW_BODY, f, r, "") ? "arrow" : null;
  }
  return null;
}

/** Pads the given declarators out of their statements (separating commas
 * included; a statement whose declarators all go pads whole). */
function removeDeclarators(sf: ts.SourceFile, dead: ReadonlySet<ts.VariableDeclaration>): Edit[] {
  const edits: Edit[] = [];
  const stmts = new Set<ts.VariableStatement>();
  for (const d of dead) {
    const stmt = d.parent?.parent;
    if (stmt !== undefined && ts.isVariableStatement(stmt)) stmts.add(stmt);
  }
  for (const stmt of stmts) {
    const decls = stmt.declarationList.declarations.nodes;
    const deadAt = decls.map((d) => dead.has(d));
    if (deadAt.every((x) => x)) {
      edits.push({ start: tokenStartOfNode(stmt), end: stmt.end, text: "" });
      continue;
    }
    const lastLive = deadAt.lastIndexOf(false);
    for (let i = 0; i < decls.length; i++) {
      if (!deadAt[i]) continue;
      edits.push(
        i < lastLive
          ? { start: tokenStartOfNode(decls[i]!), end: tokenStartOfNode(decls[i + 1]!), text: "" }
          : { start: decls[lastLive]!.end, end: decls[i]!.end, text: "" },
      );
    }
  }
  return edits;
}

/** True when `id` roots the member chain a `new` expression constructs. */
function inNewCallee(id: ts.Identifier): boolean {
  let e: ts.Node = id;
  for (let p = e.parent; p !== undefined; e = p, p = p.parent) {
    if ((ts.isPropertyAccessExpression(p) || ts.isElementAccessExpression(p)) && p.expression === e)
      continue;
    return ts.isNewExpression(p) && p.expression === e;
  }
  return false;
}

/** The elements of an expression statement's comma chain, in order. */
function commaElements(e: ts.Expression): ts.Expression[] {
  const out: ts.Expression[] = [];
  const visit = (x: ts.Expression): void => {
    if (ts.isBinaryExpression(x) && x.operatorToken.kind === ts.SyntaxKind.CommaToken) {
      visit(x.left);
      visit(x.right);
    } else out.push(x);
  };
  visit(e);
  return out;
}

/** True when a call's result is discarded: an expression statement or a
 * non-final comma operand (parentheses included). */
function resultUnused(call: ts.Expression): boolean {
  let child: ts.Node = call;
  let p = call.parent;
  while (p !== undefined && ts.isParenthesizedExpression(p)) {
    child = p;
    p = p.parent;
  }
  if (p === undefined) return false;
  if (ts.isExpressionStatement(p)) return true;
  if (ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.CommaToken) {
    if (p.left === child) return true;
    return resultUnused(p);
  }
  return false;
}

/** True when a member access is a plain read (not written, deleted or
 * updated). */
function plainRead(access: ts.Expression): boolean {
  const p = access.parent;
  if (p === undefined) return true;
  if (ts.isDeleteExpression(p)) return false;
  if (
    ts.isBinaryExpression(p) &&
    p.left === access &&
    p.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
    p.operatorToken.kind <= ts.SyntaxKind.LastAssignment
  )
    return false;
  if (
    (ts.isPrefixUnaryExpression(p) || ts.isPostfixUnaryExpression(p)) &&
    (p.operator === ts.SyntaxKind.PlusPlusToken || p.operator === ts.SyntaxKind.MinusMinusToken)
  )
    return false;
  return true;
}

/** True when a member read is the callee of a call or a tag, which receives
 * the object it was read from as `this`. */
function calledWithReceiver(access: ts.Expression): boolean {
  let callee: ts.Node = access;
  while (callee.parent !== undefined && ts.isParenthesizedExpression(callee.parent))
    callee = callee.parent;
  const p = callee.parent;
  return (
    p !== undefined &&
    ((ts.isCallExpression(p) && p.expression === callee) ||
      (ts.isTaggedTemplateExpression(p) && p.tag === callee))
  );
}

/** True when a function reads its own `this`: in its body or a parameter's
 * default value, or in an arrow function inside them. */
function readsThis(fn: ts.FunctionDeclaration): boolean {
  let found = false;
  if (fn.body === undefined) return false;
  const visit = (n: ts.Node): "stop" | "skip" | undefined => {
    if (found) return "stop";
    if (
      ts.isFunctionDeclaration(n) ||
      ts.isFunctionExpression(n) ||
      ts.isMethodDeclaration(n) ||
      ts.isGetAccessorDeclaration(n) ||
      ts.isSetAccessorDeclaration(n) ||
      ts.isConstructorDeclaration(n) ||
      ts.isClassDeclaration(n) ||
      ts.isClassExpression(n)
    )
      return "skip";
    if (n.kind === ts.SyntaxKind.ThisKeyword) found = true;
    return undefined;
  };
  for (const parameter of fn.parameters.nodes) ts.walkPreorder(parameter, visit);
  ts.walkPreorder(fn.body, visit);
  return found;
}

/** The `__export(T, { name: () => value, … })` getter table of T, or null. */
function exportTableOf(
  call: ts.CallExpression,
): { target: string; entries: [string, ts.Expression][] } | null {
  if (!ts.isIdentifier(call.expression) || helperBase(call.expression.text) !== "__export")
    return null;
  const [target, table] = call.arguments.nodes;
  if (
    call.arguments.nodes.length !== 2 ||
    !target ||
    !table ||
    !ts.isIdentifier(target) ||
    !ts.isObjectLiteralExpression(table)
  )
    return null;
  const entries: [string, ts.Expression][] = [];
  for (const prop of table.properties.nodes) {
    if (!ts.isPropertyAssignment(prop)) return null;
    if (!ts.isIdentifier(prop.name) && !ts.isStringLiteral(prop.name)) return null;
    const getter = unparen(prop.initializer);
    if (!ts.isArrowFunction(getter) || getter.parameters.nodes.length !== 0) return null;
    if (ts.isBlock(getter.body)) return null;
    entries.push([prop.name.text, getter.body]);
  }
  return { target: target.text, entries };
}

/** Lowers a CommonJS bundle's __esm initializers (see the header). Null:
 * nothing to lower. */
export function lowerBundledEsmInits(
  sf: ts.SourceFile,
  filePath: string,
  host: EsmInitHost,
): string | { degrade: string } | null {
  const source = sf.text;
  if (!source.includes("__esm")) return null;
  if (!filePath.endsWith(".cjs") && ts.isExternalModule(sf)) return null;

  const top = new Map<string, Top>();
  const duplicate = new Set<string>();
  for (const stmt of sf.statements.nodes) {
    const add = (name: string, node: Top["node"]): void => {
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
  const helpers = [...top.keys()].filter((n) => helperBase(n) === "__esm");
  if (helpers.length === 0) return null;

  const allRefs = references(sf);
  const writes = new Map<string, number>();
  for (const r of allRefs) if (isWritten(r)) writes.set(r.text, (writes.get(r.text) ?? 0) + 1);
  const declaredAnywhere = declaredNames(sf);
  if (declaredAnywhere.has("Object") || writes.has("Object")) return { degrade: ESM_SHAPE_DEGRADE };
  const stable = (name: string): boolean => !duplicate.has(name) && !writes.has(name);
  const ownNames = (name: string): boolean => {
    const t = top.get(name);
    const init =
      t !== undefined && ts.isVariableDeclaration(t.node) ? t.node.initializer : undefined;
    return (
      init !== undefined &&
      stable(name) &&
      helperTokens(getTextOfNode(init)) === helperTokens("Object.getOwnPropertyNames")
    );
  };
  const forms = new Map<string, "keyed" | "arrow">();
  for (const name of helpers) {
    const t = top.get(name)!;
    const init = ts.isVariableDeclaration(t.node) ? t.node.initializer : undefined;
    const form = init !== undefined && stable(name) ? esmHelperForm(init, sf, ownNames) : null;
    if (form === null) return { degrade: ESM_SHAPE_DEGRADE };
    forms.set(name, form);
  }

  // The initializers: `NAME = HELPER(factory)` declarators.
  const inits = new Map<string, InitBody>();
  for (const [name, t] of top) {
    if (!ts.isVariableDeclaration(t.node) || t.node.initializer === undefined) continue;
    const call = unparen(t.node.initializer);
    if (!ts.isCallExpression(call) || !ts.isIdentifier(call.expression)) continue;
    const form = forms.get(call.expression.text);
    if (form === undefined) continue;
    if (call.arguments.nodes.length !== 1 || !stable(name)) return { degrade: ESM_SHAPE_DEGRADE };
    let factory: ts.Node = call.arguments.nodes[0]!;
    if (form === "keyed") {
      if (!ts.isObjectLiteralExpression(factory) || factory.properties.nodes.length !== 1)
        return { degrade: ESM_SHAPE_DEGRADE };
      factory = factory.properties.nodes[0]!;
      if (!ts.isMethodDeclaration(factory) || ts.isComputedPropertyName(factory.name))
        return { degrade: ESM_SHAPE_DEGRADE };
    } else {
      factory = unparen(factory as ts.Expression);
      if (!ts.isArrowFunction(factory) && !ts.isFunctionExpression(factory))
        return { degrade: ESM_SHAPE_DEGRADE };
    }
    const fn = factory as ts.MethodDeclaration | ts.ArrowFunction | ts.FunctionExpression;
    if (fn.modifiers?.nodes.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword))
      return {
        degrade: `its bundled ES module initializer '${name}' is asynchronous (top-level await), which the lazy initialization rewrite does not cover`,
      };
    if (
      fn.body === undefined ||
      !ts.isBlock(fn.body) ||
      fn.asteriskToken !== undefined ||
      (fn.modifiers?.nodes.length ?? 0) > 0 ||
      fn.parameters.nodes.length > 0
    )
      return { degrade: ESM_SHAPE_DEGRADE };
    const frame = factoryFrameUse(fn.body, false);
    if (frame !== null) return { degrade: `its bundled ES module initializer '${name}' ${frame}` };
    inits.set(name, { name, call, body: fn.body });
  }
  if (inits.size === 0) return null;

  const edits: Edit[] = [];
  // Every initializer reference is a direct call whose result is unused.
  for (const r of allRefs) {
    if (!inits.has(r.text)) continue;
    const call = r.parent;
    if (
      call === undefined ||
      !ts.isCallExpression(call) ||
      call.expression !== r ||
      call.arguments.nodes.length !== 0 ||
      !resultUnused(call)
    )
      return {
        degrade: `its bundled ES module initializer '${r.text}' is used other than as a statement call`,
      };
  }
  for (const name of inits.keys()) {
    if (countDeclarations(sf, name) !== 1) return { degrade: ESM_SHAPE_DEGRADE };
  }

  /* Interop bindings an initializer assigns once from require(). */
  const refsByName = new Map<string, ts.Identifier[]>();
  for (const r of allRefs) {
    const list = refsByName.get(r.text);
    if (list === undefined) refsByName.set(r.text, [r]);
    else list.push(r);
  }
  const deadDeclarators = new Set<ts.VariableDeclaration>();
  const interopSpecs = new Map<string, string>();
  for (const init of inits.values()) {
    for (const stmt of init.body.statements.nodes) {
      if (!ts.isExpressionStatement(stmt)) continue;
      for (const el of commaElements(stmt.expression)) {
        if (
          !ts.isBinaryExpression(el) ||
          el.operatorToken.kind !== ts.SyntaxKind.EqualsToken ||
          !ts.isIdentifier(el.left)
        )
          continue;
        const name = el.left.text;
        const decl = top.get(name)?.node;
        if (
          decl === undefined ||
          !ts.isVariableDeclaration(decl) ||
          decl.initializer !== undefined ||
          duplicate.has(name) ||
          writes.get(name) !== 1 ||
          countDeclarations(sf, name) !== 1
        )
          continue;
        let rhs = unparen(el.right);
        let isNodeMode = false;
        let interop = false;
        if (
          ts.isCallExpression(rhs) &&
          ts.isIdentifier(rhs.expression) &&
          helperBase(rhs.expression.text) === "__toESM"
        ) {
          const [arg, mode] = rhs.arguments.nodes;
          if (!arg || rhs.arguments.nodes.length > 2) continue;
          if (mode !== undefined) {
            if (ts.isNumericLiteral(mode)) isNodeMode = Number(mode.text) !== 0;
            else if (mode.kind === ts.SyntaxKind.TrueKeyword) isNodeMode = true;
            else if (mode.kind !== ts.SyntaxKind.FalseKeyword) continue;
          }
          rhs = unparen(arg);
          interop = true;
        }
        const spec = bareRequireSpecOf(rhs);
        if (spec === null) continue;
        const req = getTextOfNode(rhs);
        const defaultIsModule =
          interop && (isNodeMode || !host.requireTargetEsModuleStamped(filePath, spec));
        // Every other reference must be a plain member read.
        const uses: Edit[] = [];
        let ok = true;
        for (const r of refsByName.get(name) ?? []) {
          if (r === el.left) continue;
          const access = r.parent;
          if (
            access === undefined ||
            !ts.isPropertyAccessExpression(access) ||
            access.expression !== r ||
            !plainRead(access)
          ) {
            ok = false;
            break;
          }
          if (defaultIsModule && access.name.text === "default")
            uses.push({ start: tokenStartOfNode(access), end: access.end, text: `(${req})` });
          // `new import_x.C()` must stay `new (require("x")).C()`: a bare
          // `new require("x").C()` constructs the require call itself.
          else
            uses.push({
              start: tokenStartOfNode(r),
              end: r.end,
              text: inNewCallee(r) ? `(${req})` : req,
            });
        }
        if (!ok) continue;
        edits.push({ start: tokenStartOfNode(el), end: el.end, text: req }, ...uses);
        deadDeclarators.add(decl);
        interopSpecs.set(name, spec);
      }
    }
  }
  const hoisted = hoistInitClasses(sf, inits, top, duplicate, writes, refsByName, interopSpecs);
  for (const h of hoisted.values()) {
    edits.push(...h.edits);
    for (const d of h.declarators) deadDeclarators.add(d);
  }

  /* Namespaces of lazily initialized modules read through members. */
  let mainTarget: string | null = null;
  for (const stmt of sf.statements.nodes) {
    if (!ts.isExpressionStatement(stmt) || !ts.isBinaryExpression(stmt.expression)) continue;
    const e = stmt.expression;
    const rhs = e.right;
    if (
      e.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(e.left) &&
      ts.isIdentifier(e.left.expression) &&
      e.left.expression.text === "module" &&
      e.left.name.text === "exports" &&
      ts.isCallExpression(rhs) &&
      ts.isIdentifier(rhs.expression) &&
      helperBase(rhs.expression.text) === "__toCommonJS" &&
      rhs.arguments.nodes.length === 1 &&
      ts.isIdentifier(rhs.arguments.nodes[0]!)
    )
      mainTarget = (rhs.arguments.nodes[0] as ts.Identifier).text;
  }
  const tables = new Map<string, { stmt: ts.Statement; entries: [string, ts.Expression][] }>();
  for (const stmt of sf.statements.nodes) {
    if (!ts.isExpressionStatement(stmt) || !ts.isCallExpression(stmt.expression)) continue;
    const table = exportTableOf(stmt.expression);
    if (table !== null && table.target !== mainTarget) {
      if (tables.has(table.target)) return { degrade: ESM_SHAPE_DEGRADE };
      tables.set(table.target, { stmt, entries: table.entries });
    }
  }
  const lowered = new Set<string>();
  /** Some binding between the use site and the top level rebinds a name
   * the table's getters read. */
  const shadowed = (site: ts.Node, entries: readonly [string, ts.Expression][]): boolean => {
    const read = new Set<string>();
    for (const [, value] of entries) for (const x of references(value)) read.add(x.text);
    for (let a = site.parent; a !== undefined && !ts.isSourceFile(a); a = a.parent) {
      if (
        ts.isFunctionLike(a) ||
        ts.isBlock(a) ||
        ts.isClassDeclaration(a) ||
        ts.isClassExpression(a)
      ) {
        for (const n of declaredNames(a)) if (read.has(n)) return true;
      }
    }
    return false;
  };
  const getterText = (value: ts.Expression): string =>
    applyEdits(source, tokenStartOfNode(value), value.end, edits);
  /** A call through the namespace (`ns.fn()`, `L().fn()`) passes the object
   * the read came from as `this`; the lowered object differs from Node's
   * module object (`__esModule`, property attributes), so it must stay
   * unobservable: the callee is a top-level function that never reads
   * `this`. */
  const receiverHidden = (values: ReadonlyMap<string, ts.Expression>, name: string): boolean => {
    const value = values.get(name);
    if (value === undefined || !ts.isIdentifier(value) || !stable(value.text)) return false;
    const decl = top.get(value.text)?.node;
    return decl !== undefined && ts.isFunctionDeclaration(decl) && !readsThis(decl);
  };

  /* Memoized lazy loaders of those namespaces, `L = () => M ??= NS` (a
   * bundle plugin's lazy re-exports): every `L().name` becomes the
   * initializer call followed by the export's live read, so the first
   * access still initializes the module, once, and later accesses read
   * the binding. */
  const loaderSpans: { start: number; end: number }[] = [];
  for (const [name, t] of top) {
    const d = t.node;
    if (!ts.isVariableDeclaration(d) || d.initializer === undefined) continue;
    const fn = unparen(d.initializer);
    if (!ts.isArrowFunction(fn) || fn.parameters.nodes.length !== 0 || ts.isBlock(fn.body))
      continue;
    const memoize = unparen(fn.body);
    if (
      !ts.isBinaryExpression(memoize) ||
      (memoize.operatorToken.kind !== ts.SyntaxKind.QuestionQuestionEqualsToken &&
        memoize.operatorToken.kind !== ts.SyntaxKind.BarBarEqualsToken) ||
      !ts.isIdentifier(memoize.left)
    )
      continue;
    let w = unparen(memoize.right);
    let interop = false;
    let nodeMode = false;
    if (
      ts.isCallExpression(w) &&
      ts.isIdentifier(w.expression) &&
      helperBase(w.expression.text) === "__toESM"
    ) {
      const [arg, mode] = w.arguments.nodes;
      if (!arg || w.arguments.nodes.length > 2) continue;
      if (mode !== undefined) {
        if (ts.isNumericLiteral(mode)) nodeMode = Number(mode.text) !== 0;
        else if (mode.kind === ts.SyntaxKind.TrueKeyword) nodeMode = true;
        else if (mode.kind !== ts.SyntaxKind.FalseKeyword) continue;
      }
      interop = true;
      w = unparen(arg);
    }
    let initCall: ts.CallExpression | null = null;
    if (ts.isBinaryExpression(w) && w.operatorToken.kind === ts.SyntaxKind.CommaToken) {
      const left = unparen(w.left);
      if (
        !ts.isCallExpression(left) ||
        !ts.isIdentifier(left.expression) ||
        !inits.has(left.expression.text) ||
        left.arguments.nodes.length !== 0
      )
        continue;
      initCall = left;
      w = unparen(w.right);
    }
    if (
      !ts.isCallExpression(w) ||
      !ts.isIdentifier(w.expression) ||
      helperBase(w.expression.text) !== "__toCommonJS" ||
      w.arguments.nodes.length !== 1 ||
      !ts.isIdentifier(w.arguments.nodes[0]!)
    )
      continue;
    const target = (w.arguments.nodes[0] as ts.Identifier).text;
    const table = tables.get(target);
    if (table === undefined) continue;
    const loaderWhy = {
      degrade: `its memoized lazy loader '${name}' returns the namespace of a bundled ES module as a value, a module object the static rewrite cannot represent (only member reads of its result compile, and calls only of exported functions that do not read 'this')`,
    };
    const memo = memoize.left.text;
    const memoDecl = top.get(memo)?.node;
    if (
      memoDecl === undefined ||
      !ts.isVariableDeclaration(memoDecl) ||
      memoDecl.initializer !== undefined ||
      writes.get(memo) !== 1 ||
      countDeclarations(sf, memo) !== 1 ||
      (refsByName.get(memo) ?? []).some((x) => x !== memoize.left) ||
      writes.has(name) ||
      countDeclarations(sf, name) !== 1
    )
      return loaderWhy;
    const entries = new Map(table.entries);
    for (const ref of refsByName.get(name) ?? []) {
      const call = ref.parent;
      if (
        call === undefined ||
        !ts.isCallExpression(call) ||
        call.expression !== ref ||
        call.arguments.nodes.length !== 0
      )
        return loaderWhy;
      let access: ts.Node | undefined = call.parent;
      if (
        access === undefined ||
        !ts.isPropertyAccessExpression(access) ||
        access.expression !== call ||
        !plainRead(access)
      )
        return loaderWhy;
      // Node mode binds `default` to the namespace object itself.
      if (interop && nodeMode && access.name.text === "default") {
        const outer: ts.Node | undefined = access.parent;
        if (
          outer === undefined ||
          !ts.isPropertyAccessExpression(outer) ||
          outer.expression !== access ||
          !plainRead(outer)
        )
          return loaderWhy;
        access = outer;
      }
      const member = (access as ts.PropertyAccessExpression).name.text;
      const value = entries.get(member);
      if (value === undefined || shadowed(access, table.entries)) return loaderWhy;
      // The rewrite reads the export without the namespace object, so a
      // call through it (`L().fn()`) loses its receiver.
      if (calledWithReceiver(access as ts.Expression) && !receiverHidden(entries, member))
        return loaderWhy;
      const init = initCall === null ? "" : `${getTextOfNode(initCall)}, `;
      edits.push({
        start: tokenStartOfNode(access),
        end: access.end,
        text: `(${init}${getterText(value)})`,
      });
    }
    deadDeclarators.add(d);
    deadDeclarators.add(memoDecl);
    loaderSpans.push({ start: tokenStartOfNode(d), end: d.end });
    lowered.add(target);
  }

  for (const r of allRefs) {
    const table = tables.get(r.text);
    if (table === undefined) continue;
    if (loaderSpans.some((span) => tokenStartOfNode(r) >= span.start && r.end <= span.end))
      continue;
    const p = r.parent;
    // The table's own declaration and __export call are handled below.
    if (p !== undefined && ts.isVariableDeclaration(p) && p.name === r) continue;
    if (
      p !== undefined &&
      ts.isCallExpression(p) &&
      p.arguments.nodes[0] === r &&
      ts.isExpressionStatement(p.parent) &&
      p.parent === table.stmt
    )
      continue;
    const why = `reads the namespace of a bundled ES module ('${r.text}') in a way the static rewrite cannot follow (only member reads of its exports compile, and calls only of exported functions that do not read 'this')`;
    if (
      p === undefined ||
      !ts.isCallExpression(p) ||
      !ts.isIdentifier(p.expression) ||
      helperBase(p.expression.text) !== "__toCommonJS" ||
      p.arguments.nodes.length !== 1
    )
      return { degrade: `its shipped JS ${why}` };
    // The namespace expression: `(init_x(), __toCommonJS(T))` or the call.
    let ns: ts.Expression = p;
    for (;;) {
      const up = ns.parent;
      if (up !== undefined && ts.isParenthesizedExpression(up)) ns = up;
      else if (
        up !== undefined &&
        ts.isBinaryExpression(up) &&
        up.operatorToken.kind === ts.SyntaxKind.CommaToken &&
        up.right === ns
      )
        ns = up;
      else break;
    }
    const values = new Map(table.entries);
    const memberRead = (access: ts.Node | undefined, of: ts.Node): boolean =>
      access !== undefined &&
      ts.isPropertyAccessExpression(access) &&
      access.expression === of &&
      values.has(access.name.text) &&
      plainRead(access) &&
      (!calledWithReceiver(access) || receiverHidden(values, access.name.text));
    const holder = ns.parent;
    // `__reExport(main, ns, module.exports)`: a star re-export of the
    // module into the bundle's own exports (`export * from` in its entry).
    // The initializer runs at the statement; the names become live getter
    // entries of the export table, after its explicit ones (first wins)
    // and without `default`, exactly the names __reExport copies.
    if (
      holder !== undefined &&
      ts.isCallExpression(holder) &&
      ts.isIdentifier(holder.expression) &&
      helperBase(holder.expression.text) === "__reExport" &&
      holder.arguments.nodes[1] === ns &&
      holder.arguments.nodes.length <= 3 &&
      ts.isExpressionStatement(holder.parent) &&
      mainTarget !== null &&
      ts.isIdentifier(holder.arguments.nodes[0]!) &&
      (holder.arguments.nodes[0] as ts.Identifier).text === mainTarget
    ) {
      const inner = unparen(ns);
      const init =
        ts.isBinaryExpression(inner) && inner.operatorToken.kind === ts.SyntaxKind.CommaToken
          ? `${getTextOfNode(unparen(inner.left))}; `
          : "";
      if (shadowed(holder, table.entries)) return { degrade: `its shipped JS ${why}` };
      const entries = table.entries
        .filter(([n]) => n !== "default")
        .map(([n, value]) => `${JSON.stringify(n)}: () => ${getterText(value)}`)
        .join(", ");
      edits.push({
        start: tokenStartOfNode(holder.parent),
        end: holder.parent.end,
        text: `${init}__export(${mainTarget}, { ${entries} });`,
      });
      lowered.add(r.text);
      continue;
    }
    let readable = memberRead(holder, ns);
    if (
      !readable &&
      holder !== undefined &&
      ts.isVariableDeclaration(holder) &&
      holder.initializer === ns &&
      ts.isIdentifier(holder.name)
    ) {
      const local = holder.name.text;
      const localRefs = (refsByName.get(local) ?? []).filter((x) => x !== holder.name);
      readable =
        countDeclarations(sf, local) === 1 &&
        !writes.has(local) &&
        localRefs.every((x) => memberRead(x.parent, x));
    }
    if (!readable) {
      // A namespace kept for later (`x ??= __toESM(ns)`, a hand-rolled
      // lazy loader) is a value with no static representation.
      let outer: ts.Node | undefined = holder;
      while (
        outer !== undefined &&
        (ts.isParenthesizedExpression(outer) ||
          (ts.isCallExpression(outer) &&
            ts.isIdentifier(outer.expression) &&
            helperBase(outer.expression.text) === "__toESM"))
      )
        outer = outer.parent;
      if (
        outer !== undefined &&
        ts.isBinaryExpression(outer) &&
        outer.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        outer.operatorToken.kind <= ts.SyntaxKind.LastAssignment
      )
        return {
          degrade: `its shipped JS stores the namespace of a bundled ES module ('${r.text}') in a variable (a memoized lazy loader), a module object the static rewrite cannot represent`,
        };
      return { degrade: `its shipped JS ${why}` };
    }
    // The getters read top-level bindings: nothing between the use site
    // and the top level may rebind one of their names.
    if (shadowed(p, table.entries)) return { degrade: `its shipped JS ${why}` };
    const getters = table.entries
      .map(
        ([n, value]) =>
          `get ${/^[A-Za-z_$][\w$]*$/.test(n) ? n : JSON.stringify(n)}() { return ${getterText(value)}; }`,
      )
      .join(", ");
    edits.push({ start: tokenStartOfNode(p), end: p.end, text: `{ ${getters} }` });
    lowered.add(r.text);
  }
  // A table nothing reads (its module is never required) goes too: its
  // names are no exports of the bundle.
  for (const [target, table] of tables) {
    if (lowered.has(target)) continue;
    const live = (refsByName.get(target) ?? []).some((x) => {
      const p = x.parent;
      if (p !== undefined && ts.isVariableDeclaration(p) && p.name === x) return false;
      return !(tokenStartOfNode(x) >= tokenStartOfNode(table.stmt) && x.end <= table.stmt.end);
    });
    if (!live) lowered.add(target);
  }
  for (const target of lowered) {
    const table = tables.get(target)!;
    const decl = top.get(target)?.node;
    if (
      decl === undefined ||
      !ts.isVariableDeclaration(decl) ||
      decl.initializer === undefined ||
      !ts.isObjectLiteralExpression(unparen(decl.initializer)) ||
      (unparen(decl.initializer) as ts.ObjectLiteralExpression).properties.nodes.length !== 0 ||
      writes.has(target)
    )
      return { degrade: ESM_SHAPE_DEGRADE };
    edits.push({ start: tokenStartOfNode(table.stmt), end: table.stmt.end, text: "" });
    deadDeclarators.add(decl);
  }
  // Every removed declarator in one pass: declarators of one statement
  // removed separately would leave overlapping edits, and applyEdits keeps
  // only the first of them.
  edits.push(...removeDeclarators(sf, deadDeclarators));

  /* The run-once closures. */
  for (const init of inits.values()) {
    const { call, body } = init;
    edits.push(
      {
        start: tokenStartOfNode(call),
        end: tokenStartOfNode(body) + 1,
        text: `(() => { let __scriptc_done = false; function __scriptc_init() {`,
      },
      {
        start: body.end - 1,
        end: call.end,
        // A body split around hoisted classes ends in its last tail function.
        text: hoisted.has(init.name) ? "}" : `} ${RUN_ONCE_TAIL}`,
      },
    );
  }
  return applyEdits(source, 0, source.length, edits);
}

/** Global constructors a hoisted class may extend: reading one runs no
 * code. */
const GLOBAL_BASES: ReadonlySet<string> = new Set([
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "ReferenceError",
  "EvalError",
  "URIError",
  "AggregateError",
  "Array",
  "Map",
  "Set",
  "Promise",
  "Object",
]);

/** The run-once closure's closing text after the initializer function. */
const RUN_ONCE_TAIL =
  "return function () { if (__scriptc_done) return; __scriptc_done = true; __scriptc_init(); }; })()";

/* Classes an initializer defines into a module binding,
 *
 *   var Multi;
 *   var init_m = __esm({ "src/m.ts"() { Multi = class extends import_stream.Readable { … }; } });
 *
 * become class declarations in the bundle's scope, at the same text
 * position: the initializer's body splits around each class into run-once
 * pieces that call one another in order (`… __scriptc_rest_init_m_1(); }
 * return …; })(); class Multi extends … { … } function
 * __scriptc_rest_init_m_1() { … }`), so the class's own text stays where
 * it was and only its binding changes. A stored class value with a
 * runtime-provided base has no static representation, while a declared
 * class does.
 *
 * Exact where defining the class earlier is unobservable: its heritage is
 * absent, a builtin module member, or a class hoisted before it; it has no
 * static field initializers, static blocks or computed member names, so
 * evaluating the definition runs no code; the binding is declared once,
 * assigned only there, and read only inside functions (which esbuild's
 * code reaches only after the initializer ran, the assumption the interop
 * respelling makes too); and the body declares nothing, so its statements
 * can move between functions. */
function hoistInitClasses(
  sf: ts.SourceFile,
  inits: ReadonlyMap<string, InitBody>,
  top: ReadonlyMap<string, Top>,
  duplicate: ReadonlySet<string>,
  writes: ReadonlyMap<string, number>,
  refsByName: ReadonlyMap<string, ts.Identifier[]>,
  interopSpecs: ReadonlyMap<string, string>,
): Map<string, { edits: Edit[]; declarators: ts.VariableDeclaration[] }> {
  const out = new Map<string, { edits: Edit[]; declarators: ts.VariableDeclaration[] }>();
  const hoistedNames = new Set<string>();
  /** esbuild's `0 && (module.exports = { … })` annotation for Node's
   * CommonJS lexer: code that never runs. */
  const inDeadAnnotation = (n: ts.Node): boolean => {
    for (let child: ts.Node = n, p = n.parent; p !== undefined; child = p, p = p.parent) {
      if (
        ts.isBinaryExpression(p) &&
        p.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
        p.right === child &&
        ts.isNumericLiteral(unparen(p.left)) &&
        (unparen(p.left) as ts.NumericLiteral).text === "0"
      )
        return true;
    }
    return false;
  };
  const insideFunction = (n: ts.Node): boolean => {
    for (let p = n.parent; p !== undefined && !ts.isSourceFile(p); p = p.parent)
      if (ts.isFunctionLike(p)) return true;
    return false;
  };
  const heritageOk = (cls: ts.ClassExpression): boolean => {
    const clause = cls.heritageClauses?.nodes.find((c) => c.token === ts.SyntaxKind.ExtendsKeyword);
    if (clause === undefined) return true;
    const type = clause.types.nodes[0];
    if (type === undefined || clause.types.nodes.length !== 1 || type.typeArguments !== undefined)
      return false;
    let root: ts.Expression = type.expression;
    while (ts.isPropertyAccessExpression(root) && !root.questionDotToken) root = root.expression;
    if (ts.isIdentifier(root)) {
      if (root === type.expression)
        return (
          hoistedNames.has(root.text) ||
          // A standard global constructor the bundle never rebinds
          // (`class extends Error`, an error base class).
          (GLOBAL_BASES.has(root.text) && countDeclarations(sf, root.text) === 0)
        );
      const spec = interopSpecs.get(root.text);
      return spec !== undefined && canonicalBuiltinModule(spec) !== null;
    }
    const spec = bareRequireSpecOf(root);
    return spec !== null && canonicalBuiltinModule(spec) !== null && root !== type.expression;
  };
  const definitionInert = (cls: ts.ClassExpression): boolean =>
    (cls.modifiers?.nodes.length ?? 0) === 0 &&
    cls.members.nodes.every((m) => {
      if (ts.isClassStaticBlockDeclaration(m)) return false;
      if (m.name !== undefined && ts.isComputedPropertyName(m.name)) return false;
      if (m.modifiers?.nodes.some((x) => x.kind === ts.SyntaxKind.Decorator)) return false;
      const isStatic = m.modifiers?.nodes.some((x) => x.kind === ts.SyntaxKind.StaticKeyword);
      return !(isStatic && ts.isPropertyDeclaration(m));
    });

  for (const init of inits.values()) {
    const stmts = init.body.statements.nodes;
    if (stmts.some((st) => !ts.isExpressionStatement(st) && !ts.isEmptyStatement(st))) continue;
    // The initializer's declarator is its statement's last one.
    const declarator = init.call.parent;
    const list = declarator?.parent;
    if (
      declarator === undefined ||
      !ts.isVariableDeclaration(declarator) ||
      list === undefined ||
      !ts.isVariableDeclarationList(list) ||
      // The initializer ends its statement: the split pieces follow it
      // (`var A, B, init_x = __esm(…)` keeps A and B declared before).
      list.declarations.nodes[list.declarations.nodes.length - 1] !== declarator ||
      unparen(declarator.initializer!) !== init.call
    )
      continue;
    const strict = strictPrologue(stmts) ? '"use strict"; ' : "";
    const edits: Edit[] = [];
    const declarators: ts.VariableDeclaration[] = [];
    let piece = 0;
    for (const stmt of stmts) {
      if (!ts.isExpressionStatement(stmt)) continue;
      const els = commaElements(stmt.expression);
      const hoistedEls = new Set<ts.Expression>();
      for (let i = 0; i < els.length; i++) {
        const el = els[i]!;
        if (
          !ts.isBinaryExpression(el) ||
          el.operatorToken.kind !== ts.SyntaxKind.EqualsToken ||
          !ts.isIdentifier(el.left) ||
          !ts.isClassExpression(el.right)
        )
          continue;
        const name = el.left.text;
        const cls = el.right;
        const target = el.left;
        const decl = top.get(name)?.node;
        if (
          decl === undefined ||
          !ts.isVariableDeclaration(decl) ||
          decl.initializer !== undefined ||
          duplicate.has(name) ||
          writes.get(name) !== 1 ||
          (cls.name !== undefined && cls.name.text !== name) ||
          // The binding's declarator (and the class's own name, if spelled).
          countDeclarations(sf, name) !== (cls.name === undefined ? 1 : 2) ||
          !definitionInert(cls) ||
          !heritageOk(cls) ||
          !(refsByName.get(name) ?? []).every(
            (r) =>
              r === target ||
              // The class's own methods name the class itself.
              (tokenStartOfNode(r) >= tokenStartOfNode(cls) && r.end <= cls.end) ||
              inDeadAnnotation(r) ||
              (insideFunction(r) &&
                // The initializer's own earlier code reads the unassigned binding.
                !(
                  tokenStartOfNode(r) >= tokenStartOfNode(init.body) && tokenStartOfNode(r) < el.end
                )),
          )
        )
          continue;
        piece++;
        const rest = `__scriptc_rest_${init.name}_${piece}`;
        const close = piece === 1 ? `} ${RUN_ONCE_TAIL};` : "}";
        // `a, X = class …, b`: the elements around the class end and begin
        // the neighboring pieces.
        // After a hoisted neighbor the separating comma is already gone.
        const fresh = i === 0 || hoistedEls.has(els[i - 1]!);
        const from =
          i === 0 ? tokenStartOfNode(stmt) : fresh ? tokenStartOfNode(el) : els[i - 1]!.end;
        const sep = fresh ? "" : ";";
        hoistedEls.add(el);
        edits.push({
          start: from,
          end: tokenStartOfNode(cls),
          text: `${sep} ${rest}(); ${close} `,
        });
        const next = els[i + 1];
        // The class's own closing brace carries the next piece's opener: an
        // empty insertion at its end would share its position with the
        // initializer body's closing edit in minified text (`…}}})`).
        edits.push(
          next === undefined
            ? {
                start: cls.end - 1,
                end: cls.end,
                text: `} function ${rest}() { ${strict}`,
              }
            : {
                start: cls.end,
                end: tokenStartOfNode(next),
                text: ` function ${rest}() { ${strict}`,
              },
        );
        if (cls.name === undefined) {
          const keyword = tokenStartOfNode(cls);
          edits.push({ start: keyword, end: keyword + "class".length, text: `class ${name}` });
        }
        declarators.push(decl);
        hoistedNames.add(name);
      }
    }
    if (piece > 0) out.set(init.name, { edits, declarators });
  }
  return out;
}
