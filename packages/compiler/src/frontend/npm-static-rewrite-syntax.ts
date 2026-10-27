import * as ts from "./ts7/syntax.js";
import {
  bareRequireSpecOf,
  cjsLexedExportsOfFile,
  isExportsIdent,
  isModuleExports,
} from "./cjs-syntax.js";
import { rewriteBundledFunctionImports } from "./npm-static-bundled-cjs.js";
import { getTextOfNode, tokenStartOfNode } from "./ts7/node-functions.js";

/** Resolution stays with the compilation host. Syntax never reads disk or
 * starts a parser implicitly, so native and Node hosts run the same pass. */
export interface CjsRewriteHost {
  requireTargetEsModuleStamped(fromFile: string, specifier: string): boolean;
  starTargetNames(fromFile: string, specifier: string): Set<string>;
  /** Told when the rewritten file's tail export table stands for a live
   * getter table the original installed before it could run another
   * module's code (liveExportTableFirst): a module of a require cycle that
   * captured the export object early observes exactly that table. */
  liveExportTable?: ((filePath: string) => void) | undefined;
  /** True for a module only ever loaded through require() (a bundle's
   * CommonJS chunk split into its own module): no ES-module importer
   * exists, so Node's lexer-visible name set bounds nothing and every
   * name the export plumbing defines is part of its surface. */
  requireOnly?: ((filePath: string) => boolean) | undefined;
  /** Told the names Node's lexer detects in the original file that the
   * rewritten text spells only as accessors (which the lexer skips). */
  lexerVisibleNames?: ((filePath: string, names: readonly string[]) => void) | undefined;
}

/** True when esbuild's export object (`module.exports = __toCommonJS(T)`
 * over a getter table `__export(T, {...})`) is installed before anything
 * that can run another module's code, and nothing else writes the export
 * object. Every statement before the installation is then a declaration,
 * a directive, or the getter-table call (whose getters run only when
 * read), and variable initializers evaluate no calls outside function
 * bodies. The getters read live bindings, so the object a cycle partner
 * captures early answers every later read exactly like the final table. */
function liveExportTableFirst(
  sf: ts.SourceFile,
  installAt: number,
  target: string,
  exportTables: readonly { target: string }[],
): boolean {
  if (!exportTables.some((t) => t.target === target)) return false;
  let callsOutsideFunctions = false;
  const noCalls = (root: ts.Node): boolean => {
    callsOutsideFunctions = false;
    ts.walkPreorder(root, (n) => {
      if (callsOutsideFunctions) return "stop";
      if (ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isFunctionDeclaration(n))
        return "skip";
      if (ts.isCallExpression(n) || ts.isNewExpression(n) || ts.isTaggedTemplateExpression(n))
        callsOutsideFunctions = true;
      return undefined;
    });
    return !callsOutsideFunctions;
  };
  let sawTable = false;
  for (const stmt of sf.statements.nodes) {
    if (tokenStartOfNode(stmt) >= installAt) return sawTable;
    if (ts.isFunctionDeclaration(stmt) || ts.isEmptyStatement(stmt)) continue;
    if (ts.isExpressionStatement(stmt) && ts.isStringLiteral(stmt.expression)) continue;
    if (ts.isVariableStatement(stmt)) {
      if (
        stmt.declarationList.declarations.nodes.every(
          (d) => ts.isIdentifier(d.name) && (d.initializer === undefined || noCalls(d.initializer)),
        )
      )
        continue;
      return false;
    }
    if (ts.isExpressionStatement(stmt) && ts.isCallExpression(stmt.expression)) {
      const table = exportCallOf(stmt.expression);
      if (table !== null && table.target === target) {
        sawTable = true;
        continue;
      }
    }
    return false;
  }
  return false;
}

export function isBundlerCjsCandidate(source: string): boolean {
  return (
    source.includes("__toCommonJS") ||
    source.includes("__toESM") ||
    source.includes("__exportStar") ||
    source.includes("__reExport") ||
    (source.includes("Object.defineProperty(exports") && source.includes("get"))
  );
}

/** The helper a bundler-emitted name spells. esbuild suffixes a helper
 * that a bundled module declares again with a counter (a bundled esbuild
 * dist inside another bundle carries `__export2`, `__toCommonJS2`, …); the
 * recognizers below verify each call's shape, so the counter carries no
 * meaning beyond the name collision it avoided. */
export function bundlerHelperBase(name: string): string {
  return /^__[A-Za-z]+\d+$/.test(name) ? name.replace(/\d+$/, "") : name;
}

/** The last NAME of a callee: bare identifier or any member chain's final
 * name (`tslib_1.__exportStar` → "__exportStar"), helper counters dropped. */
function calleeNameOf(call: ts.CallExpression): string | null {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return bundlerHelperBase(callee.text);
  if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.name))
    return bundlerHelperBase(callee.name.text);
  return null;
}

/** True for an identifier spelling the named helper (counter-suffixed
 * spellings included). */
function isHelperIdent(node: ts.Node, base: string): node is ts.Identifier {
  return ts.isIdentifier(node) && bundlerHelperBase(node.text) === base;
}

/** An entry the canonical table can carry. */
interface EntrySpec {
  /** The export name (may need string-key spelling). */
  name: string;
  /** "ident": VALUE is a plain identifier spelled directly in the table.
   * "hoist": VALUE is an expression text hoisted to a tail const first.
   * "getter": VALUE is a getter body's returned expression the table
   *   keeps as a live accessor (read on every access, like the original
   *   getter, so a lazily initialized module still initializes at the
   *   first read).
   * "any": the checked-dynamic fallback (`__scriptc_any`). */
  kind: "ident" | "hoist" | "getter" | "any";
  value?: string;
}

/** A chaseable getter/descriptor VALUE: a plain identifier, an
 * identifier-rooted member/element chain (string keys only), or a scalar
 * literal. Answers the classification or null (not chaseable). */
function chaseValue(e: ts.Expression): { kind: "ident" | "hoist"; text: string } | null {
  let cur: ts.Expression = e;
  while (ts.isParenthesizedExpression(cur)) cur = cur.expression;
  if (ts.isIdentifier(cur)) return { kind: "ident", text: cur.text };
  if (
    ts.isNumericLiteral(cur) ||
    ts.isStringLiteral(cur) ||
    ts.isNoSubstitutionTemplateLiteral(cur) ||
    cur.kind === ts.SyntaxKind.TrueKeyword ||
    cur.kind === ts.SyntaxKind.FalseKeyword ||
    cur.kind === ts.SyntaxKind.NullKeyword
  ) {
    return { kind: "hoist", text: getTextOfNode(cur) };
  }
  // ident-rooted member chains: this.x / a.b.c / a["k"].d — side-effect
  // free reads the tail const can evaluate once.
  let walk: ts.Expression = cur;
  while (
    (ts.isPropertyAccessExpression(walk) &&
      walk.questionDotToken === undefined &&
      ts.isIdentifier(walk.name)) ||
    (ts.isElementAccessExpression(walk) &&
      walk.questionDotToken === undefined &&
      ts.isStringLiteral(walk.argumentExpression))
  ) {
    walk = walk.expression;
  }
  if (ts.isIdentifier(walk)) return { kind: "hoist", text: getTextOfNode(cur) };
  return null;
}

/** An object literal of side-effect-free member values (`exports.default
 * = { context: context_api_1.context, metrics: metrics_api_1.metrics }`,
 * tsc's default-export object): the tail const can build it once, like a
 * chased value. Null for any other shape (spreads, methods, accessors,
 * computed keys, or a value chaseValue rejects). */
function chaseObjectLiteral(e: ts.Expression): { kind: "hoist"; text: string } | null {
  let cur: ts.Expression = e;
  while (ts.isParenthesizedExpression(cur)) cur = cur.expression;
  if (!ts.isObjectLiteralExpression(cur)) return null;
  for (const prop of cur.properties.nodes) {
    if (
      !ts.isPropertyAssignment(prop) ||
      !(ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name)) ||
      (chaseValue(prop.initializer) === null && chaseObjectLiteral(prop.initializer) === null)
    )
      return null;
  }
  return { kind: "hoist", text: getTextOfNode(cur) };
}

/** The getter body's returned expression for the two descriptor getter
 * spellings (`get() { return X }` / `get: function () { return X }`) and
 * the arrow forms the esbuild table uses (`() => X`, `() => { return X }`). */
function getterReturnOf(fn: ts.Node): ts.Expression | null {
  let body: ts.ConciseBody | undefined;
  if (ts.isArrowFunction(fn) && fn.parameters.nodes.length === 0) body = fn.body;
  else if (ts.isFunctionExpression(fn) && fn.parameters.nodes.length === 0) body = fn.body;
  else if (ts.isMethodDeclaration(fn) && fn.parameters.nodes.length === 0 && fn.body !== undefined)
    body = fn.body;
  else return null;
  if (body === undefined) return null;
  if (!ts.isBlock(body)) return body; // expression-bodied arrow
  if (body.statements.nodes.length !== 1) return null;
  const ret = body.statements.nodes[0]!;
  return ts.isReturnStatement(ret) && ret.expression !== undefined ? ret.expression : null;
}

/** The `__export(IDENT, { name: () => value, ... })` call's parts, or null.
 * Every property must be a `name: <function>` assignment (identifier or
 * string-literal name) — anything else is not the esbuild table. */
function exportCallOf(
  call: ts.CallExpression,
): { target: string; entries: [string, ts.Expression | null][] } | null {
  if (calleeNameOf(call) !== "__export") return null;
  if (call.arguments.nodes.length !== 2) return null;
  const [target, table] = call.arguments.nodes as unknown as [ts.Expression, ts.Expression];
  if (!ts.isIdentifier(target) || !ts.isObjectLiteralExpression(table)) return null;
  const entries: [string, ts.Expression | null][] = [];
  for (const prop of table.properties.nodes) {
    if (!ts.isPropertyAssignment(prop)) return null;
    let name: string;
    if (ts.isIdentifier(prop.name)) name = prop.name.text;
    else if (ts.isStringLiteral(prop.name)) name = prop.name.text;
    else return null;
    entries.push([name, getterReturnOf(prop.initializer)]);
  }
  return { target: target.text, entries };
}

/** `Object.defineProperty(exports|module.exports, 'name', {...})` — the
 * name plus the chased descriptor value (getter return or `value:`), or
 * null when the statement is not that shape at all. `value: null` means
 * recognized but unchaseable. */
function definePropertyExportOf(
  call: ts.CallExpression,
): { name: string; value: ts.Expression | null; esModuleStamp: boolean } | null {
  const callee = call.expression;
  if (
    !ts.isPropertyAccessExpression(callee) ||
    !ts.isIdentifier(callee.expression) ||
    callee.expression.text !== "Object" ||
    !ts.isIdentifier(callee.name) ||
    callee.name.text !== "defineProperty"
  ) {
    return null;
  }
  if (call.arguments.nodes.length !== 3) return null;
  const [recv, nameArg, desc] = call.arguments.nodes as unknown as [
    ts.Expression,
    ts.Expression,
    ts.Expression,
  ];
  if (!isExportsIdent(recv) && !isModuleExports(recv)) return null;
  if (!ts.isStringLiteral(nameArg) || !ts.isObjectLiteralExpression(desc)) return null;
  const name = nameArg.text;
  let value: ts.Expression | null = null;
  for (const p of desc.properties.nodes) {
    if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name)) {
      if (p.name.text === "value") value = p.initializer;
      else if (p.name.text === "get") value = getterReturnOf(p.initializer);
    } else if (ts.isMethodDeclaration(p) && ts.isIdentifier(p.name) && p.name.text === "get") {
      value = getterReturnOf(p);
    }
  }
  const esModuleStamp = name === "__esModule" && value !== null && isTrueLiteral(value);
  return { name, value, esModuleStamp };
}

/** `true`, or `!0`, its minified spelling. */
function isTrueLiteral(expr: ts.Expression): boolean {
  return (
    expr.kind === ts.SyntaxKind.TrueKeyword ||
    (ts.isPrefixUnaryExpression(expr) &&
      expr.operator === ts.SyntaxKind.ExclamationToken &&
      ts.isNumericLiteral(expr.operand) &&
      expr.operand.text === "0")
  );
}

/** Space-pads [start, end) of `text` preserving newlines — the recognized
 * statement disappears while every original offset survives. */
function padSpan(text: string, start: number, end: number): string {
  let pad = "";
  for (let i = start; i < end; i++) pad += text[i] === "\n" ? "\n" : " ";
  return text.slice(0, start) + pad + text.slice(end);
}

/** A valid identifier-run export name (the table can spell it bare). */
function isPlainName(name: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name);
}

interface ToEsmPlan {
  /** Wrapper/`.default` spans to space-pad (they join `neutralize`, so the
   * helper sweep sees the erased call sites as dead references). */
  pads: { start: number; end: number }[];
  /** Interop bindings whose `.default` IS the module (plain-CJS targets,
   * the node-mode variant): pads erase their source `.default` accesses,
   * and TEXT COPIED off the source (the canonical table's hoisted getter
   * bodies) must drop the member spelling the same way. */
  moduleBindings: Set<string>;

  degrade: string | null;
}

/** Structural recognition of esbuild's vendored __toESM helper:
 * `var __toESM = (mod, isNodeMode, target) => (target = …, __copyProps(
 *   isNodeMode || !mod || !mod.__esModule
 *     ? __defProp(target, "default", { value: mod, enumerable: true })
 *     : target,
 *   mod))`
 * — an arrow over (mod, isNodeMode[, target]) whose result is a
 * __copyProps(…, mod) call copying onto a conditional that tests
 * isNodeMode/__esModule and defines "default" with value mod. Comments and
 * formatting are free; the SHAPE is the contract. */
function recognizedToEsmDecl(d: ts.VariableDeclaration): boolean {
  if (!isHelperIdent(d.name, "__toESM") || d.initializer === undefined) return false;
  let init: ts.Expression = d.initializer;
  while (ts.isParenthesizedExpression(init)) init = init.expression;
  if (!ts.isArrowFunction(init)) return false;
  if (init.parameters.nodes.length < 2 || init.parameters.nodes.length > 3) return false;
  const p0 = init.parameters.nodes[0]!;
  const p1 = init.parameters.nodes[1]!;
  if (!ts.isIdentifier(p0.name) || !ts.isIdentifier(p1.name)) return false;
  const mod = p0.name.text;
  const isNodeMode = p1.name.text;
  if (ts.isBlock(init.body)) return false;
  let expr: ts.Expression = init.body;
  while (ts.isParenthesizedExpression(expr)) expr = expr.expression;
  // the rightmost comma operand carries the result
  while (ts.isBinaryExpression(expr) && expr.operatorToken.kind === ts.SyntaxKind.CommaToken) {
    expr = expr.right;
  }
  while (ts.isParenthesizedExpression(expr)) expr = expr.expression;
  if (!ts.isCallExpression(expr) || !isHelperIdent(expr.expression, "__copyProps")) return false;
  if (expr.arguments.nodes.length < 2) return false;
  const from = expr.arguments.nodes[1]!;
  if (!ts.isIdentifier(from) || from.text !== mod) return false;
  let to: ts.Expression = expr.arguments.nodes[0]!;
  while (ts.isParenthesizedExpression(to)) to = to.expression;
  if (!ts.isConditionalExpression(to)) return false;
  const condText = getTextOfNode(to.condition);
  if (!condText.includes(isNodeMode) || !condText.includes("__esModule")) return false;
  let stamp: ts.Expression = to.whenTrue;
  while (ts.isParenthesizedExpression(stamp)) stamp = stamp.expression;
  if (!ts.isCallExpression(stamp) || !isHelperIdent(stamp.expression, "__defProp")) return false;
  if (stamp.arguments.nodes.length !== 3) return false;
  const nameArg = stamp.arguments.nodes[1]!;
  if (!ts.isStringLiteral(nameArg) || nameArg.text !== "default") return false;
  const desc = stamp.arguments.nodes[2]!;
  if (!ts.isObjectLiteralExpression(desc)) return false;
  return desc.properties.nodes.some(
    (p) =>
      ts.isPropertyAssignment(p) &&
      ts.isIdentifier(p.name) &&
      p.name.text === "value" &&
      ts.isIdentifier(p.initializer) &&
      p.initializer.text === mod,
  );
}

const TO_ESM_SHAPE_DEGRADE =
  "its shipped JS calls the __toESM bundler-interop helper but spells it in a shape the " +
  "recognizer cannot verify";
const TO_ESM_ESCAPE_DEGRADE =
  "a __toESM(require(…)) bundler-interop object escapes into a use the static rewrite cannot " +
  "follow (only module-scope bindings and direct member reads compile)";
const TO_ESM_ARG_DEGRADE =
  "it calls the __toESM bundler-interop helper on something other than require(…) of a string " +
  "literal";
const TO_ESM_MIXED_DEGRADE =
  "its bundler-emitted export surface cannot be respelled around its __toESM interop imports";

/** The interop-erasure plan for one CJS file (see the section header). */
function planToEsmInterop(sf: ts.SourceFile, filePath: string, host: CjsRewriteHost): ToEsmPlan {
  const pads: { start: number; end: number }[] = [];
  const moduleBindings = new Set<string>();
  const plan: ToEsmPlan = { pads, moduleBindings, degrade: null };
  const fail = (reason: string): ToEsmPlan => ({
    pads: [],
    moduleBindings: new Set(),
    degrade: reason,
  });

  // Top-level declarators of the helper, any statement shape (minified
  // dists share one `var` among several helpers), by spelling.
  const decls = new Map<string, ts.VariableDeclaration[]>();
  for (const s of sf.statements.nodes) {
    if (!ts.isVariableStatement(s)) continue;
    for (const d of s.declarationList.declarations.nodes) {
      if (!isHelperIdent(d.name, "__toESM")) continue;
      const list = decls.get(d.name.text);
      if (list === undefined) decls.set(d.name.text, [d]);
      else list.push(d);
    }
  }
  const refs: ts.Identifier[] = [];
  const calls: ts.CallExpression[] = [];
  const collect = (n: ts.Node): void => {
    if (isHelperIdent(n, "__toESM")) refs.push(n);
    if (ts.isCallExpression(n) && isHelperIdent(n.expression, "__toESM")) calls.push(n);
  };
  ts.walkPreorder(sf, collect);
  if (calls.length === 0 && refs.length === 0) return plan;
  // Every reference must be the declarator's own name or a call's callee —
  // a helper that escapes as a VALUE is outside the recognized shape.
  const callees = new Set<ts.Node>(calls.map((c) => c.expression));
  const declNames = new Set<ts.Node>();
  for (const list of decls.values()) for (const d of list) declNames.add(d.name);
  if (refs.some((r) => !callees.has(r) && !declNames.has(r))) return fail(TO_ESM_ESCAPE_DEGRADE);
  if (calls.length === 0) return plan; // declared but never called — dead helper
  // Every spelling a call uses must be declared exactly once, in the
  // recognized shape.
  for (const call of calls) {
    const list = decls.get((call.expression as ts.Identifier).text);
    if (list === undefined || list.length !== 1 || !recognizedToEsmDecl(list[0]!))
      return fail(TO_ESM_SHAPE_DEGRADE);
  }

  /** Module-scope interop bindings: name → whether `.default` IS the
   * module (pad the access) rather than a member read of its `default`. */
  const bindings = new Map<string, boolean>();
  for (const call of calls) {
    const arg0 = call.arguments.nodes[0];
    const spec = arg0 !== undefined ? bareRequireSpecOf(arg0) : null;
    if (spec === null || call.arguments.nodes.length > 2) return fail(TO_ESM_ARG_DEGRADE);
    let isNodeMode = false;
    if (call.arguments.nodes.length === 2) {
      const modeArg = call.arguments.nodes[1]!;
      if (ts.isNumericLiteral(modeArg)) isNodeMode = Number(modeArg.text) !== 0;
      else if (modeArg.kind === ts.SyntaxKind.TrueKeyword) isNodeMode = true;
      else if (modeArg.kind === ts.SyntaxKind.FalseKeyword) isNodeMode = false;
      else return fail(TO_ESM_ARG_DEGRADE);
    }
    const defaultIsModule = isNodeMode || !host.requireTargetEsModuleStamped(filePath, spec);
    // classify the call's use: a variable binding, or an immediate member
    // read; anything else escapes.
    let child: ts.Expression = call;
    let parent = call.parent;
    while (ts.isParenthesizedExpression(parent)) {
      child = parent;
      parent = parent.parent;
    }
    if (
      ts.isVariableDeclaration(parent) &&
      parent.initializer === child &&
      ts.isIdentifier(parent.name)
    ) {
      if (bindings.has(parent.name.text)) return fail(TO_ESM_ESCAPE_DEGRADE);
      bindings.set(parent.name.text, defaultIsModule);
      if (defaultIsModule) moduleBindings.add(parent.name.text);
    } else if (
      ts.isPropertyAccessExpression(parent) &&
      parent.expression === child &&
      ts.isIdentifier(parent.name)
    ) {
      if (parent.name.text === "default" && defaultIsModule) {
        if (!readOnlyAccess(parent)) return fail(TO_ESM_ESCAPE_DEGRADE);
        pads.push({ start: child.end, end: parent.end });
      }
    } else {
      return fail(TO_ESM_ESCAPE_DEGRADE);
    }
    // the wrapper itself: callee + '(' down, and everything after the
    // require argument (`, 1` included) — the bare require survives at its
    // original offsets.
    pads.push({ start: tokenStartOfNode(call), end: tokenStartOfNode(arg0!) });
    pads.push({ start: arg0!.end, end: call.end });
  }

  if (bindings.size > 0) {
    // Binding safety: the erased binding must be declared exactly once and
    // never written — the `.default` mapping below matches receivers by
    // NAME (syntactic, like the rest of this file), so a shadow or a
    // reassignment would change what a padded access reads without a
    // diagnostic.
    const declCount = new Map<string, number>();
    const bump = (name: string): void => {
      if (bindings.has(name)) declCount.set(name, (declCount.get(name) ?? 0) + 1);
    };
    let violated = false;
    const scan = (n: ts.Node): void => {
      if (violated) return;
      if (
        (ts.isVariableDeclaration(n) || ts.isBindingElement(n) || ts.isParameter(n)) &&
        ts.isIdentifier(n.name)
      ) {
        bump(n.name.text);
      } else if (
        (ts.isFunctionDeclaration(n) || ts.isClassDeclaration(n)) &&
        n.name !== undefined
      ) {
        bump(n.name.text);
      } else if (
        ts.isBinaryExpression(n) &&
        n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        n.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
        ts.isIdentifier(n.left) &&
        bindings.has(n.left.text)
      ) {
        violated = true;
      } else if (
        (ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) &&
        (n.operator === ts.SyntaxKind.PlusPlusToken ||
          n.operator === ts.SyntaxKind.MinusMinusToken) &&
        ts.isIdentifier(n.operand) &&
        bindings.has(n.operand.text)
      ) {
        violated = true;
      }
    };
    ts.walkPreorder(sf, scan);
    if (violated || [...bindings.keys()].some((name) => (declCount.get(name) ?? 0) !== 1)) {
      return fail(TO_ESM_ESCAPE_DEGRADE);
    }
    // `.default` reads on a module-valued binding pad down to the binding.
    const padDefaults = (n: ts.Node): void => {
      if (
        ts.isPropertyAccessExpression(n) &&
        ts.isIdentifier(n.expression) &&
        bindings.get(n.expression.text) === true &&
        ts.isIdentifier(n.name) &&
        n.name.text === "default"
      ) {
        if (!readOnlyAccess(n)) {
          violated = true;
          return;
        }
        pads.push({ start: n.expression.end, end: n.end });
      }
    };
    ts.walkPreorder(sf, padDefaults);
    if (violated) return fail(TO_ESM_ESCAPE_DEGRADE);
  }
  return plan;
}

/** True when a padded-away `.default` access is a plain READ — an
 * assignment target or delete operand cannot lose its member spelling. */
function readOnlyAccess(access: ts.PropertyAccessExpression): boolean {
  const p = access.parent;
  if (p !== undefined && ts.isDeleteExpression(p)) return false;
  if (
    p !== undefined &&
    ts.isBinaryExpression(p) &&
    p.left === access &&
    p.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
    p.operatorToken.kind <= ts.SyntaxKind.LastAssignment
  ) {
    return false;
  }
  if (
    p !== undefined &&
    (ts.isPrefixUnaryExpression(p) || ts.isPostfixUnaryExpression(p)) &&
    (p.operator === ts.SyntaxKind.PlusPlusToken || p.operator === ts.SyntaxKind.MinusMinusToken)
  ) {
    return false;
  }
  return true;
}

const RESERVED_KEYS = new Set(["__proto__"]);

/** The rewrite (see the header). Null = not a recognized bundle shape (or
 * nothing to fix) — serve the file untouched. A `{ degrade }` answer means
 * the file carries a bundler-interop construct the recognizers cannot
 * finish: the caller reports the PACKAGE as an offender with the reason
 * and the selection loop records a package refusal. */
export function rewriteBundlerCjsSyntax(
  sf: ts.SourceFile,
  filePath: string,
  host: CjsRewriteHost,
): string | { degrade: string } | null {
  const source = sf.text;
  if (!isBundlerCjsCandidate(source)) return null;

  // ESM bundles can contain closed CommonJS function factories. Recognize
  // those before refusing interop that needs a dynamic module namespace.
  // TypeScript forces every `.cjs` file to be an external module
  // (isFileForcedToBeModuleByFormat), yet Node always loads one as
  // CommonJS: the extension, not that flag, decides the format there.
  if (!filePath.endsWith(".cjs") && ts.isExternalModule(sf)) {
    const bundled = rewriteBundledFunctionImports(source, sf);
    if (bundled !== null) return bundled;
    if (!source.includes("__toESM(")) return null;
    return {
      degrade: source.includes("__commonJS")
        ? "its ES-module bundle reaches bundled CommonJS modules through the __commonJS and " +
          "__toESM bundler-interop helpers, which cannot compile natively in ESM output"
        : "its ES-module dist routes an external dependency through the __toESM " +
          "bundler-interop helper, which cannot compile natively in ESM output",
    };
  }

  // The __toESM interop pass (see the section header): wrapper call sites
  // pad down to the bare require they wrap, module-valued `.default`
  // accesses pad down to their binding, and a file whose interop deviates
  // beyond recognition degrades the package.
  const toEsm = planToEsmInterop(sf, filePath, host);
  if (toEsm.degrade !== null) return { degrade: toEsm.degrade };

  interface Neutralize {
    start: number;
    end: number;
  }
  const neutralize: Neutralize[] = [];
  const exportTables: { target: string; entries: [string, ts.Expression | null][] }[] = [];
  const definePropEntries: { name: string; value: ts.Expression | null }[] = [];
  const memberStmts: {
    names: string[];
    finalRhs: ts.Expression;
    viaBareExports: boolean;
    pos: number;
    start: number;
    end: number;
  }[] = [];
  /** Star spec → require-load emission order (statement order). */
  const starSpecsInOrder: string[] = [];
  let esbuildMainTarget: string | null = null;
  let tablePos: number | null = null;
  let sawBundleShape = false;

  const addStarSpec = (spec: string): void => {
    if (!starSpecsInOrder.includes(spec)) starSpecsInOrder.push(spec);
  };

  for (const stmt of sf.statements.nodes) {
    if (!ts.isExpressionStatement(stmt)) continue;
    const e = stmt.expression;
    // `module.exports = <rhs>`
    if (
      ts.isBinaryExpression(e) &&
      e.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      isModuleExports(e.left)
    ) {
      const rhs = e.right;
      if (
        ts.isCallExpression(rhs) &&
        calleeNameOf(rhs) === "__toCommonJS" &&
        rhs.arguments.nodes.length === 1 &&
        ts.isIdentifier(rhs.arguments.nodes[0]!)
      ) {
        esbuildMainTarget = (rhs.arguments.nodes[0] as ts.Identifier).text;
        tablePos = tokenStartOfNode(stmt);
        neutralize.push({ start: tokenStartOfNode(stmt), end: stmt.end });
        sawBundleShape = true;
        continue;
      }
      // Any other real module.exports assignment: the file has an export
      // mechanism the checker already models (or a shape outside the
      // recognizers) — not ours to rewrite.
      return null;
    }
    // member exports — `exports.N = RHS;` / `module.exports.N = RHS;`,
    // chains included (`exports.a = exports.b = void 0;` — the tsc
    // void-init preamble collects every name with the chain's final RHS).
    {
      let cur: ts.Expression = e;
      const names: string[] = [];
      let viaBareExports = false;
      while (
        ts.isBinaryExpression(cur) &&
        cur.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isPropertyAccessExpression(cur.left) &&
        cur.left.questionDotToken === undefined &&
        ts.isIdentifier(cur.left.name) &&
        (isExportsIdent(cur.left.expression) || isModuleExports(cur.left.expression))
      ) {
        names.push(cur.left.name.text);
        if (isExportsIdent(cur.left.expression)) viaBareExports = true;
        cur = cur.right;
      }
      if (names.length > 0) {
        memberStmts.push({
          names,
          finalRhs: cur,
          viaBareExports,
          pos: tokenStartOfNode(stmt),
          start: tokenStartOfNode(stmt),
          end: stmt.end,
        });
        continue; // classified later (only when a rewrite actually happens)
      }
    }
    // the dead esbuild annotation: `0 && (module.exports = { ... });`
    if (
      ts.isBinaryExpression(e) &&
      e.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
      ts.isNumericLiteral(e.left) &&
      e.left.text === "0"
    ) {
      let inner: ts.Expression = e.right;
      while (ts.isParenthesizedExpression(inner)) inner = inner.expression;
      if (
        ts.isBinaryExpression(inner) &&
        inner.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        isModuleExports(inner.left) &&
        ts.isObjectLiteralExpression(inner.right)
      ) {
        neutralize.push({ start: tokenStartOfNode(stmt), end: stmt.end });
        sawBundleShape = true;
        continue;
      }
    }
    if (!ts.isCallExpression(e)) continue;
    const name = calleeNameOf(e);
    // `__export(TARGET, { getter table });`
    const table = exportCallOf(e);
    if (table !== null) {
      exportTables.push(table);
      neutralize.push({ start: tokenStartOfNode(stmt), end: stmt.end });
      sawBundleShape = true;
      continue;
    }
    // `__exportStar(require('spec'), exports);` — the tsc/tslib spelling —
    // and `__export(require('spec'))`, the legacy twin.
    if ((name === "__exportStar" || name === "__export") && e.arguments.nodes.length >= 1) {
      const spec = bareRequireSpecOf(e.arguments.nodes[0]!);
      if (spec !== null) {
        addStarSpec(spec);
        neutralize.push({ start: tokenStartOfNode(stmt), end: stmt.end });
        sawBundleShape = true;
        continue;
      }
    }
    // `__reExport(TARGET, require('spec')[, module.exports]);` — esbuild's
    // `export * from` plumbing.
    if (name === "__reExport" && e.arguments.nodes.length >= 2) {
      const spec = bareRequireSpecOf(e.arguments.nodes[1]!);
      if (spec !== null) {
        addStarSpec(spec);
        neutralize.push({ start: tokenStartOfNode(stmt), end: stmt.end });
        sawBundleShape = true;
        continue;
      }
    }
    // Object.defineProperty(exports, 'n', {...})
    const def = definePropertyExportOf(e);
    if (def !== null) {
      if (def.esModuleStamp) {
        neutralize.push({ start: tokenStartOfNode(stmt), end: stmt.end });
        // the canonical table re-stamps it (lexer-visibly — merve detects
        // this defineProperty form, so parity wants a visible entry)
        continue;
      }
      const chased = def.value !== null ? chaseValue(def.value) : null;
      if (chased !== null) {
        definePropEntries.push({ name: def.name, value: def.value });
        neutralize.push({ start: tokenStartOfNode(stmt), end: stmt.end });
        sawBundleShape = true;
      }
      // unchaseable descriptor: LEAVE the statement (its runtime fence
      // throws where an undefined-valued entry would be a wrong result); the
      // name still types through the any-fallback below.
      continue;
    }
  }

  const lexed = cjsLexedExportsOfFile(sf);
  if (host.requireOnly?.(filePath) === true) {
    for (const t of exportTables) for (const [name] of t.entries) lexed.exports.add(name);
    for (const d of definePropEntries) lexed.exports.add(d.name);
    for (const m of memberStmts) for (const name of m.names) lexed.exports.add(name);
  }
  let emitTable = sawBundleShape && (lexed.exports.size > 0 || lexed.reexports.length > 0);

  const starSpecs: string[] = [];
  const entries = new Map<string, EntrySpec>();
  const starMembers: { name: string; ref: string }[] = [];
  const requireConsts: string[] = [];
  if (emitTable) {
    /* Star specs Node actually honors are the lexer's SURVIVING reexports
     * (annotation spreads for esbuild bundles, star-pattern calls for tsc
     * output). The statements walked above contribute load order; specs the
     * lexer dropped (cleared by a later module.exports=) drop here too. */
    const lexerSpecs = new Set(lexed.reexports);
    starSpecs.push(...starSpecsInOrder.filter((s) => lexerSpecs.has(s)));
    for (const s of lexed.reexports) {
      if (!starSpecs.includes(s)) starSpecs.push(s);
    }

    /* The entry list, first-wins per name: own getter-table entries, then
     * defineProperty entries, then surviving top-level member exports, then
     * (for names still uncovered) star enumerations in spec order, then the
     * any fallback for every remaining lexer-visible name. */
    const claim = (name: string, spec: EntrySpec): void => {
      if (name === "__esModule" || RESERVED_KEYS.has(name)) return;
      if (!entries.has(name)) entries.set(name, spec);
    };
    const classify = (name: string, value: ts.Expression | null): EntrySpec => {
      const chased = value !== null ? chaseValue(value) : null;
      if (chased === null) return { name, kind: "any" };
      if (chased.kind === "ident") return { name, kind: "ident", value: chased.text };
      return { name, kind: "hoist", value: chased.text };
    };

    // Own names: the getter table(s) — the one feeding module.exports first.
    const tablesOrdered = [
      ...exportTables.filter((t) => t.target === esbuildMainTarget),
      ...exportTables.filter((t) => t.target !== esbuildMainTarget),
    ];
    for (const t of tablesOrdered) {
      for (const [name, value] of t.entries) {
        const spec = classify(name, value);
        // The table feeding module.exports keeps a getter it cannot chase
        // as a live accessor rather than a snapshot.
        if (spec.kind === "any" && value !== null && t.target === esbuildMainTarget)
          claim(name, { name, kind: "getter", value: getTextOfNode(value) });
        else claim(name, spec);
      }
    }
    for (const d of definePropEntries) claim(d.name, classify(d.name, d.value));

    /* Top-level member exports. Node's export-object identity rules decide
     * each statement's fate against the ORIGINAL table (esbuildMainTarget's
     * assignment): a member attached BEFORE it was discarded (the table
     * replaced the object), a bare `exports.N =` AFTER it wrote the stale
     * object — both keep only their lexer-visible NAME (value undefined,
     * exactly Node's link answer: the any fallback below). A surviving
     * member (`module.exports.N =` after the table, or any spelling when no
     * table exists) re-emits its VALUE as a canonical entry — identifier
     * RHS only; any other RHS would need a second evaluation, so the file
     * is left alone (the offender path owns it — and when the file also
     * carries erased interop wrappers, "untouched" is not on the menu:
     * the live helper chain would fence at module load, so the package
     * degrades with the note instead). Every member statement is then
     * NEUTRALIZED: the canonical tail table replaces the object, and a
     * stray earlier attach would meet the lowering's discard fence. */
    for (const m of memberStmts) {
      let cur: ts.Expression = m.finalRhs;
      while (ts.isParenthesizedExpression(cur)) cur = cur.expression;
      const isVoidInit =
        cur.kind === ts.SyntaxKind.VoidExpression ||
        (ts.isIdentifier(cur) && cur.text === "undefined");
      const discarded = tablePos !== null && (m.pos < tablePos || m.viaBareExports);
      if (!isVoidInit) {
        // Only side-effect-free RHS shapes may be neutralized (identifiers,
        // scalar literals, ident-rooted member chains — chaseValue's set);
        // anything else keeps the file untouched (the offender path owns
        // it: neutralizing would drop an evaluation, keeping it meets the
        // lowering's discard fence at load).
        const chased = chaseValue(cur) ?? chaseObjectLiteral(cur);
        if (chased === null) {
          return toEsm.pads.length > 0 ? { degrade: TO_ESM_MIXED_DEGRADE } : null;
        }
        if (!discarded) {
          for (const name of m.names) claim(name, { name, kind: chased.kind, value: chased.text });
        }
        // discarded members keep only their lexer-visible NAME (the any
        // fallback below) — value undefined, exactly Node's link answer
      }
      neutralize.push({ start: m.start, end: m.end });
    }

    /* Direct-vs-hoist for ident entries: only bindings declared by a
     * top-level const/function/class may be spelled directly (alias
     * plumbing needs an immutable target — a `var`/`let` in the table would
     * fence the whole statement). Everything else snapshots via a tail
     * const. */
    const immutableTopLevel = new Set<string>();
    for (const stmt of sf.statements.nodes) {
      if (ts.isFunctionDeclaration(stmt) && stmt.name !== undefined)
        immutableTopLevel.add(stmt.name.text);
      else if (ts.isClassDeclaration(stmt) && stmt.name !== undefined)
        immutableTopLevel.add(stmt.name.text);
      else if (
        ts.isVariableStatement(stmt) &&
        (stmt.declarationList.flags & ts.NodeFlags.Const) !== 0
      ) {
        for (const d of stmt.declarationList.declarations.nodes) {
          if (ts.isIdentifier(d.name)) immutableTopLevel.add(d.name.text);
        }
      }
    }
    for (const spec of entries.values()) {
      if (spec.kind === "ident" && !immutableTopLevel.has(spec.value!)) spec.kind = "hoist";
    }

    // Star enumerations for names the own entries left uncovered.
    starSpecs.forEach((spec, i) => {
      const names = host.starTargetNames(filePath, spec);
      let refVar: string | null = null;
      for (const n of names) {
        if (n === "default" || n === "__esModule" || entries.has(n) || RESERVED_KEYS.has(n))
          continue;
        if (starMembers.some((m) => m.name === n)) continue; // earlier spec wins
        if (refVar === null) {
          refVar = `__scriptc_r${i}`;
          requireConsts.push(`const ${refVar} = require(${JSON.stringify(spec)});`);
        }
        starMembers.push({ name: n, ref: refVar });
      }
    });

    // The any fallback: every lexer-visible name nothing above covered.
    for (const n of lexed.exports) claim(n, { name: n, kind: "any" });

    emitTable = entries.size > 0 || starSpecs.length > 0;
  }

  /* A file with interop pads but no canonical table still rewrites: the
   * pads erase the __toESM wrappers and the sweep below drops the dead
   * helper chain — but nothing replaces the export plumbing, so none of
   * it may be neutralized (the surviving text keeps exactly its
   * untouched-file behavior). */
  if (!emitTable) {
    if (toEsm.pads.length === 0) return null;
    neutralize.length = 0;
  }
  // Interop pads join the neutralized set BEFORE the sweep: the erased
  // __toESM call sites read as dead references, so the helper declaration
  // sweeps away and its __create/__getProtoOf chain follows.
  neutralize.push(...toEsm.pads);

  /* Bundler HELPPER declarations left unused once the plumbing statements
   * are gone would still fence at module load (`var __defProp =
   * Object.defineProperty;` — a stdlib generic method as a value has no
   * lowering, and a top-level declaration's fence throws when init runs
   * it). Mark-and-sweep the RECOGNIZED helper names: a helper whose every
   * reference lies inside an already-neutralized span (the plumbing
   * calls, the erased __toESM interop wrappers, or another swept helper's
   * declaration) is neutralized too. Helpers live code still calls
   * (__commonJS chunk factories) stay — their declarations are plain
   * function values whose bodies defer per the JS function-poison rule. */
  {
    const HELPER_NAMES = new Set([
      "__create",
      "__defProp",
      "__defProps",
      "__getOwnPropDesc",
      "__getOwnPropDescs",
      "__getOwnPropNames",
      "__getOwnPropSymbols",
      "__getProtoOf",
      "__hasOwnProp",
      "__propIsEnum",
      "__export",
      "__copyProps",
      "__reExport",
      "__toESM",
      "__toCommonJS",
      "__commonJS",
      "__esm",
      "__exportStar",
      "__createBinding",
      "__setModuleDefault",
      "__importStar",
      "__importDefault",
    ]);
    /* Helper declarators by name. A minified dist shares one `var` among
     * several helpers (`var __getProtoOf=…,__hasOwnProp=…;`): each
     * declarator is its own candidate, and the statement pads whole only
     * once every declarator in it is dead. */
    const helperDecls = new Map<string, { start: number; end: number }>();
    const helperStmts: ts.VariableStatement[] = [];
    for (const stmt of sf.statements.nodes) {
      if (!ts.isVariableStatement(stmt)) continue;
      const decls = stmt.declarationList.declarations.nodes;
      let anyHelper = false;
      for (const d of decls) {
        if (!ts.isIdentifier(d.name) || !HELPER_NAMES.has(bundlerHelperBase(d.name.text))) continue;
        if (helperDecls.has(d.name.text)) continue; // redeclared: keep the first, never sweep twice
        anyHelper = true;
        helperDecls.set(
          d.name.text,
          decls.length === 1
            ? { start: tokenStartOfNode(stmt), end: stmt.end }
            : { start: tokenStartOfNode(d), end: d.end },
        );
      }
      if (anyHelper && decls.length > 1) helperStmts.push(stmt);
    }
    // every identifier occurrence of a helper name outside its own
    // declarator name node, position-recorded for the span test
    const refs = new Map<string, number[]>();
    const record = (node: ts.Node): void => {
      if (ts.isIdentifier(node) && helperDecls.has(node.text)) {
        const parent = node.parent;
        if (parent !== undefined && ts.isVariableDeclaration(parent) && parent.name === node)
          return;
        const list = refs.get(node.text);
        if (list === undefined) refs.set(node.text, [tokenStartOfNode(node)]);
        else list.push(tokenStartOfNode(node));
      }
    };
    ts.walkPreorder(sf, record);
    const dead = [...neutralize];
    const inDead = (pos: number): boolean => dead.some((s) => pos >= s.start && pos < s.end);
    const removed = new Set<string>();
    for (let changed = true; changed;) {
      changed = false;
      for (const [name, span] of helperDecls) {
        if (removed.has(name)) continue;
        // SELF-references inside the candidate's own declaration don't
        // keep it alive (`var __createBinding = (this && this.__createBinding)
        // || ...` — the tsc helper's UMD-style self probe).
        const live = (refs.get(name) ?? []).filter((p) => p < span.start || p >= span.end);
        if (live.every(inDead)) {
          removed.add(name);
          dead.push(span);
          changed = true;
        }
      }
    }
    // A swept declarator of a shared statement pads with its separating
    // comma, and the statement pads whole once every declarator is dead:
    // padding the bare declarator span would leave a dangling comma.
    const declaratorSpans = new Set<{ start: number; end: number }>();
    const declaratorPads: { start: number; end: number }[] = [];
    for (const stmt of helperStmts) {
      const decls = stmt.declarationList.declarations.nodes;
      const deadAt = decls.map((d) => {
        if (!ts.isIdentifier(d.name) || !removed.has(d.name.text)) return false;
        const span = helperDecls.get(d.name.text)!;
        if (span.start !== tokenStartOfNode(d)) return false;
        declaratorSpans.add(span);
        return true;
      });
      if (deadAt.every((x) => x)) {
        declaratorPads.push({ start: tokenStartOfNode(stmt), end: stmt.end });
        continue;
      }
      // Dead declarators before the last live one take their trailing
      // comma; the dead tail after it pads from that declarator's end.
      const lastLive = deadAt.lastIndexOf(false);
      for (let i = 0; i < decls.length; i++) {
        if (!deadAt[i]) continue;
        const d = decls[i]!;
        declaratorPads.push(
          i < lastLive
            ? { start: tokenStartOfNode(d), end: tokenStartOfNode(decls[i + 1]!) }
            : { start: decls[lastLive]!.end, end: d.end },
        );
      }
    }
    neutralize.length = 0;
    neutralize.push(...dead.filter((span) => !declaratorSpans.has(span)), ...declaratorPads);
  }

  /* ── emission ─────────────────────────────────────────────────────── */
  let text = source;
  // pad from the END so earlier spans' offsets stay valid
  for (const n of [...neutralize].sort((a, b) => b.start - a.start)) {
    text = padSpan(text, n.start, n.end);
  }

  if (!emitTable) return text; // interop pads only — nothing appends

  if (
    esbuildMainTarget !== null &&
    tablePos !== null &&
    memberStmts.length === 0 &&
    definePropEntries.length === 0 &&
    liveExportTableFirst(sf, tablePos, esbuildMainTarget, exportTables)
  )
    host.liveExportTable?.(filePath);

  const lines: string[] = [""];
  const hasAnyFallback = [...entries.values()].some((s) => s.kind === "any");
  if (hasAnyFallback) {
    // checked-dynamic undefined: an implicit-any IIFE result registers a
    // dyn module global the table's alias plumbing can resolve.
    lines.push("const __scriptc_any = (() => { let u; return u; })();");
  }
  lines.push(...requireConsts);
  const hoists: string[] = [];
  let hoistN = 0;
  const keyOf = (name: string): string => (isPlainName(name) ? name : JSON.stringify(name));
  /* Hoist texts are COPIED off the original source, where a `.default`
   * access on a module-valued interop binding still carries its member
   * spelling (the pads erase only source spans) — drop it here exactly
   * like the pads do, or the tail const would read a member the module
   * never exports. */
  const dropInteropDefault = (text: string): string => {
    let out = text;
    for (const b of toEsm.moduleBindings) {
      out = out.replace(new RegExp(`\\b${b}\\s*\\.\\s*default\\b`, "g"), b);
    }
    return out;
  };
  const plainParts: string[] = [];
  for (const spec of entries.values()) {
    if (spec.kind === "ident") {
      plainParts.push(`${keyOf(spec.name)}: ${spec.value!},`);
    } else if (spec.kind === "hoist") {
      const v = `__scriptc_e${hoistN++}`;
      hoists.push(`const ${v} = ${dropInteropDefault(spec.value!)};`);
      plainParts.push(`${keyOf(spec.name)}: ${v},`);
    } else if (spec.kind === "getter") {
      plainParts.push(`get ${keyOf(spec.name)}() { return ${dropInteropDefault(spec.value!)}; },`);
    } else {
      plainParts.push(`${keyOf(spec.name)}: __scriptc_any,`);
    }
  }
  lines.push(...hoists);
  /* The table. Spread entries first (REVERSED: Node's star copies are
   * first-wins, an object literal's later-wins — reversing makes them
   * agree), then the scan-visible plain entries, then — only where the
   * original stamped it LEXER-DETECTABLY (the tsc defineProperty form;
   * Node links `import { __esModule }` there) — the `__esModule: true`
   * entry, then the member-access star entries whose names the spread
   * records already cover. esbuild's marker lives inside __toCommonJS
   * where Node's lexer never saw it, and spelling it here would flip the
   * checker's default-import interop (an __esModule-stamped surface binds
   * `import def` to exports.default) away from Node's CJS answer — so it
   * is deliberately OMITTED from the canonical table. */
  const spreadParts = [...starSpecs].reverse().map((s) => `...require(${JSON.stringify(s)}),`);
  const esModulePart = lexed.exports.has("__esModule") ? "__esModule: true," : "";
  const memberParts = starMembers.map(
    (m) =>
      `${keyOf(m.name)}: ${m.ref}${isPlainName(m.name) ? `.${m.name}` : `[${JSON.stringify(m.name)}]`},`,
  );
  lines.push(
    `module.exports = {${spreadParts.join("")}${plainParts.join("")}${esModulePart}${memberParts.join("")}};`,
  );
  /* Node's lexer skips accessors (and stops reading an object literal at
   * the first one), so a canonical table with accessor entries hides
   * names the original showed it (esbuild's dead annotation): the host
   * keeps the original's lexer answer, so ES-module importers link
   * exactly as they do against the original. */
  if ([...entries.values()].some((spec) => spec.kind === "getter"))
    host.lexerVisibleNames?.(filePath, [...lexed.exports]);
  return text + lines.join("\n") + "\n";
}
