/* The pre-scan (DESIGN.md §1.4, phase 1): a syntactic walk over one
 * JavaScript module that finds the R1 (runtime) and R2 (object-model)
 * markers of rules.ts. It is a fast path and a source of good reasons; it
 * never decides alone that a module is native, and the authoritative signal
 * stays the lowering's refusals (classify.ts).
 *
 * Every check is local to the file: a name is a "function" when the file
 * declares it as a function, a builtin global when the file does not
 * declare it at all, and a builtin module object when the file binds it to
 * require("<builtin>") or imports it from one. Checker-dependent parts of
 * R2.3 (writes the declared type does not cover, freeze followed by writes)
 * and R2.4 (assignments to undeclared identifiers) are left to the lowering;
 * `this` in a plain call is marked conservatively (decision S2): a file
 * cannot see its call sites, so every `this` in a sloppy plain function
 * marks the module. */
import type { SrcLoc } from "../ir/ir.js";
import * as ts from "../frontend/ts7/adapter.js";
import { SUPPORTED_BUILTIN_MODULES } from "../frontend/builtin-modules.js";
import type { NodeIslandRule } from "./rules.js";

export interface NodeIslandMarker {
  rule: NodeIslandRule;
  /** The reason id (rules.ts). */
  reason: string;
  /** The construct, as a short phrase for messages. */
  construct: string;
  loc: SrcLoc;
  /** For `builtin-patch`: the builtin module member the module patches
   * ("fs.readFileSync"; "fs.*" when the source is not an object literal). */
  member?: string;
}

/** A member read through a builtin module's CommonJS object (H3.4): the
 * patch a Node island module installs is visible to such a read, which a
 * native build cannot reproduce. */
export interface CjsRead {
  /** The member read ("fs.readFileSync"). */
  member: string;
  loc: SrcLoc;
}

/** A read of a name the module declares nowhere and no builtin provides:
 * at run time it resolves on Node's global object. A Node island module's
 * sloppy implicit-global write creates the name there, which native code
 * cannot observe (H3.4). */
export interface GlobalRead {
  name: string;
  loc: SrcLoc;
}

/** Markers past this count in one module add nothing to a report. */
const MARKER_CAP = 64;

const BUILTIN_GLOBALS = new Set([
  "Object",
  "Array",
  "String",
  "Number",
  "Boolean",
  "Function",
  "Symbol",
  "BigInt",
  "Promise",
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "ReferenceError",
  "EvalError",
  "URIError",
  "AggregateError",
  "Map",
  "Set",
  "WeakMap",
  "WeakSet",
  "RegExp",
  "Date",
  "Math",
  "JSON",
  "Reflect",
  "Intl",
  "ArrayBuffer",
  "SharedArrayBuffer",
  "DataView",
  "Uint8Array",
  "Int8Array",
  "Uint16Array",
  "Int16Array",
  "Uint32Array",
  "Int32Array",
  "Float32Array",
  "Float64Array",
  "BigInt64Array",
  "BigUint64Array",
  "Uint8ClampedArray",
  "Buffer",
  "process",
  "console",
  "globalThis",
  "global",
  "URL",
  "URLSearchParams",
  "TextEncoder",
  "TextDecoder",
  "AbortController",
  "AbortSignal",
  "EventTarget",
  "Event",
  "fetch",
  "setTimeout",
  "setInterval",
  "setImmediate",
  "clearTimeout",
  "clearInterval",
  "clearImmediate",
  "queueMicrotask",
  "structuredClone",
]);

/** CommonJS module-scope names and JavaScript's value keywords: provided by
 * the module wrapper or the language, never the global object. */
const MODULE_SCOPE_NAMES = new Set([
  "require",
  "module",
  "exports",
  "__dirname",
  "__filename",
  "arguments",
  "eval",
  "undefined",
  "NaN",
  "Infinity",
]);

/** Writes to builtin members that the native subset models (process
 * state, tuning knobs). */
const ALLOWED_BUILTIN_WRITES = new Set([
  "process.exitCode",
  "process.title",
  "process.env",
  "Error.stackTraceLimit",
  "Buffer.poolSize",
  "events.defaultMaxListeners",
  "events.EventEmitter.defaultMaxListeners",
  "EventEmitter.defaultMaxListeners",
]);

const ADDON_LOADERS = new Set([
  "bindings",
  "node-gyp-build",
  "node-pre-gyp",
  "@mapbox/node-pre-gyp",
  "prebuild-install",
  "node-gyp-build-optional-packages",
]);

const LOADER_HOOK_PACKAGES = new Set(["import-in-the-middle", "require-in-the-middle"]);

function builtinModuleName(spec: string): string | null {
  const bare = spec.startsWith("node:") ? spec.slice(5) : spec;
  if ((SUPPORTED_BUILTIN_MODULES as readonly string[]).includes(bare)) return bare;
  if (bare === "vm" || bare === "v8" || bare === "module" || bare === "inspector") return bare;
  return null;
}

/** Parentheses and the TypeScript wrappers Node erases (`as`,
 * `satisfies`, `!` and the angle-bracket assertion). */
function stripWrappers(node: ts.Node): ts.Node {
  let value = node;
  for (;;) {
    if (
      ts.isParenthesizedExpression(value) ||
      ts.isAsExpression(value) ||
      ts.isTypeAssertion(value) ||
      ts.isNonNullExpression(value) ||
      ts.isSatisfiesExpression(value)
    )
      value = value.expression;
    else return value;
  }
}

function literalText(node: ts.Node | undefined): string | null {
  if (node === undefined) return null;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return null;
}

/** A property name the scan can spell: an identifier, a string or number
 * literal, or a computed literal key. */
function staticKey(node: ts.Node): string | null {
  if (ts.isIdentifier(node) || ts.isNumericLiteral(node)) return node.text;
  if (ts.isComputedPropertyName(node)) return literalText(stripWrappers(node.expression));
  return literalText(node);
}

/** A specifier that folds at build time: a literal, or a concatenation of
 * literals. */
function isFoldableSpecifier(node: ts.Node): boolean {
  if (literalText(node) !== null) return true;
  if (ts.isParenthesizedExpression(node)) return isFoldableSpecifier(node.expression);
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken)
    return isFoldableSpecifier(node.left) && isFoldableSpecifier(node.right);
  return false;
}

function isAssignmentOperator(kind: ts.SyntaxKind): boolean {
  return kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment;
}

/** The key of an object-literal property (`name`, `"name"` or a
 * template without substitutions). */
function literalKeyName(name: ts.Node | undefined): string | null {
  if (name === undefined) return null;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name))
    return name.text;
  return null;
}

function propertyName(node: ts.Node): string | null {
  if (ts.isPropertyAccessExpression(node)) {
    const name = node.name;
    return ts.isIdentifier(name) ? name.text : null;
  }
  if (ts.isElementAccessExpression(node)) return literalText(node.argumentExpression);
  return null;
}

/** `a.b.c` as "a.b.c" (element accesses with literal keys included), or
 * null when the chain has a computed key or does not start at a name. */
function chainText(node: ts.Node): string | null {
  const value = stripWrappers(node);
  if (ts.isIdentifier(value)) return value.text;
  if (value.kind === ts.SyntaxKind.ThisKeyword) return "this";
  if (ts.isPropertyAccessExpression(value) || ts.isElementAccessExpression(value)) {
    const base = chainText(value.expression);
    const name = propertyName(value);
    if (base === null || name === null) return null;
    return `${base}.${name}`;
  }
  return null;
}

/** Like chainText, with computed keys spelled `[…]`: `process.env[…]`. */
function memberText(node: ts.Node): string | null {
  const value = stripWrappers(node);
  const text = chainText(value);
  if (text !== null) return text;
  if (ts.isElementAccessExpression(value)) {
    const base = memberText(value.expression);
    return base === null ? null : `${base}[…]`;
  }
  if (ts.isPropertyAccessExpression(value)) {
    const base = memberText(value.expression);
    const name = propertyName(value);
    return base === null || name === null ? null : `${base}.${name}`;
  }
  return null;
}

/** The identifier a member chain starts at (`a` of `a.b[c].d`). */
function chainRoot(node: ts.Node): ts.Identifier | null {
  let cur = stripWrappers(node);
  for (;;) {
    if (ts.isIdentifier(cur)) return cur;
    if (ts.isPropertyAccessExpression(cur) || ts.isElementAccessExpression(cur)) {
      cur = stripWrappers(cur.expression);
      continue;
    }
    return null;
  }
}

function hasUseStrict(statements: readonly ts.Node[]): boolean {
  for (const stmt of statements) {
    if (!ts.isExpressionStatement(stmt)) return false;
    const text = literalText(stmt.expression);
    if (text === null) return false;
    if (text === "use strict") return true;
  }
  return false;
}

/** ES module syntax at the top level (static import or export): the
 * module is strict. The parser's module indicator is not used, since it
 * also marks CommonJS files under forced module detection. */
function hasEsmSyntax(sf: ts.SourceFile): boolean {
  for (const stmt of sf.statements.nodes) {
    if (ts.isImportDeclaration(stmt) || ts.isExportDeclaration(stmt)) return true;
    if (ts.isExportAssignment(stmt)) return true;
    if (ts.sourceTextRangeMatches(sf, ts.tokenStartOfNode(stmt), stmt.end, /^export /)) return true;
  }
  return false;
}

function isFunctionBoundary(node: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  );
}

/** Whether `node`, an identifier, is read rather than written, declared or
 * used as a name. A shorthand property and a `typeof` operand are reads. */
function isReadPosition(node: ts.Identifier, parent: ts.Node): boolean {
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false;
  if (
    (ts.isPropertyAssignment(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isGetAccessorDeclaration(parent) ||
      ts.isSetAccessorDeclaration(parent)) &&
    parent.name === node
  )
    return false;
  if (
    (ts.isPropertySignature(parent) || ts.isMethodSignatureDeclaration(parent)) &&
    parent.name === node
  )
    return false;
  if (ts.isLabeledStatement(parent) && parent.label === node) return false;
  if ((ts.isBreakStatement(parent) || ts.isContinueStatement(parent)) && parent.label === node)
    return false;
  if (
    ts.isBinaryExpression(parent) &&
    parent.left === node &&
    isAssignmentOperator(parent.operatorToken.kind)
  )
    return false;
  if (
    (ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) &&
    parent.operand === node &&
    (parent.operator === ts.SyntaxKind.PlusPlusToken ||
      parent.operator === ts.SyntaxKind.MinusMinusToken)
  )
    return false;
  if (ts.isDeleteExpression(parent) && parent.expression === node) return false;
  if ((ts.isForOfStatement(parent) || ts.isForInStatement(parent)) && parent.initializer === node)
    return false;
  return true;
}

/** Whether `node` sits in a type position: a name there is a type, not a
 * value the global object could provide. */
function isTypePosition(node: ts.Node): boolean {
  let current: ts.Node = node;
  let parent = current.parent;
  while (parent !== undefined) {
    if (ts.isTypeNode(parent)) return true;
    // A declaration's annotation (`const x: T`), a return type, `as` and
    // `satisfies` all hold their type in a `type` child.
    if ((parent as { type?: ts.Node }).type === current) return true;
    if (ts.isExpression(parent) || ts.isStatement(parent)) return false;
    current = parent;
    parent = parent.parent;
  }
  return false;
}

/** The name a plain function value is bound to in the same file
 * (`function f`, `var f = function`), for the constructor refinement. */
function boundFunctionName(fn: ts.FunctionDeclaration | ts.FunctionExpression): string | null {
  if (ts.isFunctionDeclaration(fn)) return fn.name?.text ?? null;
  const parent = fn.parent;
  if (parent === undefined) return null;
  if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
  if (ts.isPropertyAssignment(parent)) return propertyName(parent.name);
  return null;
}

/** `X.prototype.name = function () {}`: a method assignment, whose every
 * call through the same spelling has a receiver. */
function isPrototypeFunctionAssignment(left: ts.PropertyAccessExpression, right: ts.Node): boolean {
  let value = right;
  while (ts.isParenthesizedExpression(value)) value = value.expression;
  return (
    ts.isFunctionExpression(value) &&
    ts.isPropertyAccessExpression(left.expression) &&
    propertyName(left.expression) === "prototype"
  );
}

/** What a tracked name stands for at a use site. */
interface BindingValue {
  /** The builtin module (or `module.member`) the name is bound to; null
   * when the binding holds something else. */
  readonly builtin: string | null;
  /** The binding holds a builtin module's CommonJS object: require(), a
   * createRequire'd require's result, a default import, or an alias of one.
   * Writes through such a name patch the module object. */
  readonly cjs: boolean;
  /** The binding holds a createRequire(...) result. */
  readonly createRequire: boolean;
}

/** A declared name that is not a builtin module value. */
const NOT_BUILTIN: BindingValue = { builtin: null, cjs: false, createRequire: false };

/** One declaration of a tracked name and the scope it binds in. A name can
 * be declared again in a nested scope or with another initializer, so the
 * scan keeps every declaration and resolves the one a use site sees. */
interface ScopedBinding {
  readonly value: BindingValue;
  readonly scope: ts.Node;
  readonly depth: number;
  /** Source position, the tie-break for two declarations in one scope. */
  readonly order: number;
}

function isScopeBoundary(node: ts.Node): boolean {
  return (
    isFunctionBoundary(node) ||
    ts.isArrowFunction(node) ||
    ts.isSourceFile(node) ||
    ts.isClassStaticBlockDeclaration(node)
  );
}

/** Blocks and statement heads `let`, `const` and class declarations bind
 * in, in addition to a function or static-block scope. */
function isBlockBoundary(node: ts.Node): boolean {
  return (
    ts.isBlock(node) ||
    ts.isModuleBlock(node) ||
    ts.isForStatement(node) ||
    ts.isForOfStatement(node) ||
    ts.isForInStatement(node) ||
    ts.isCaseBlock(node)
  );
}

/** The scope a declaration binds its name in. `hoisted` asks for the
 * enclosing function's scope: `var`, parameters, and a sloppy block-level
 * function declaration (Annex B.3.2) reach the whole function. */
function bindingScope(decl: ts.Node, hoisted: boolean): ts.Node {
  // The name climbs through its binding pattern to the declaration that
  // hosts it: the declaration kind decides where the name is visible.
  let host = decl;
  for (;;) {
    const parent = host.parent;
    if (parent === undefined) break;
    if (
      ts.isBindingElement(host) ||
      ts.isObjectBindingPattern(host) ||
      ts.isArrayBindingPattern(host) ||
      (ts.isIdentifier(host) &&
        (ts.isBindingElement(parent) || ts.isVariableDeclaration(parent) || ts.isParameter(parent)))
    ) {
      host = parent;
      continue;
    }
    break;
  }
  // A named function or class expression binds inside itself only.
  if (ts.isFunctionExpression(host) || ts.isClassExpression(host)) return host;
  // A catch clause's parameter or declaration names a value that exists
  // only inside the catch block; outside it the name keeps the meaning the
  // enclosing scope gives it.
  if (host.parent !== undefined && ts.isCatchClause(host.parent)) return host.parent.block;
  const blockScoped =
    !hoisted &&
    (ts.isFunctionDeclaration(host) ||
      ts.isClassDeclaration(host) ||
      ts.isEnumDeclaration(host) ||
      ts.isModuleDeclaration(host) ||
      (ts.isVariableDeclaration(host) &&
        (ts.getCombinedNodeFlags(host) & ts.NodeFlags.BlockScoped) !== 0));
  for (let cur = host.parent; cur !== undefined; cur = cur.parent) {
    if (isScopeBoundary(cur)) return cur;
    if (blockScoped && isBlockBoundary(cur)) return cur;
  }
  // Unreachable for a parsed file (a source file is a scope boundary);
  // declare it at the outermost node so the binding never escapes.
  let root = host;
  while (root.parent !== undefined) root = root.parent;
  return root;
}

function scopeDepth(scope: ts.Node): number {
  let depth = 0;
  for (let cur: ts.Node | undefined = scope; cur !== undefined; cur = cur.parent) depth++;
  return depth;
}

function scopeContains(scope: ts.Node, at: ts.Node): boolean {
  for (let cur: ts.Node | undefined = at; cur !== undefined; cur = cur.parent) {
    if (cur === scope) return true;
  }
  return false;
}

/** One module's pre-scan. */
class ModuleScanner {
  readonly markers: NodeIslandMarker[] = [];
  /** Every name the file declares (any scope): a builtin global the file
   * redeclares is not the builtin. */
  private readonly declared = new Set<string>();
  /** Names declared as functions (declarations and function-valued
   * variables). */
  private readonly functions = new Set<string>();
  private readonly classes = new Set<string>();
  /** Every declaration of a name the scan tracks for builtin identity, by
   * name: a use resolves the innermost declaration whose scope contains
   * it, so a parameter or local of the same name masks an outer alias
   * instead of inheriting its identity. */
  private readonly bindings = new Map<string, ScopedBinding[]>();
  /** Members read through a CommonJS builtin object (H3.4). */
  readonly cjsReads: CjsRead[] = [];
  /** Reads of names the file declares nowhere and no builtin provides: each
   * resolves on the global object at run time. */
  readonly globalReads: GlobalRead[] = [];
  private readonly globalReadNames = new Set<string>();
  /** Names the file constructs with `new`: a constructor's `this` is never
   * the global object, so its `this` uses need no island (decision S5). */
  private readonly constructed = new Set<string>();
  /** Names the file calls as a bare identifier, `f(...)`: a name used both
   * ways is a constructor and a plain function, so it still marks. */
  private readonly bareCalled = new Set<string>();
  /** Function expressions the file assigns to `X.prototype.name`: every
   * same-file call of them is a receiver call (decision S5). */
  private readonly prototypeFunctions = new Set<ts.Node>();
  private readonly strictness = new Map<ts.Node, boolean>();
  private readonly moduleStrict: boolean;

  constructor(private readonly sf: ts.SourceFile) {
    const name = sf.fileName;
    this.moduleStrict =
      name.endsWith(".mjs") ||
      name.endsWith(".mts") ||
      hasEsmSyntax(sf) ||
      hasUseStrict(sf.statements.nodes);
  }

  scan(): NodeIslandMarker[] {
    this.collectDeclarations();
    ts.walkPreorder(this.sf, (node) => {
      if (this.markers.length >= MARKER_CAP) return "stop";
      this.visit(node);
      return undefined;
    });
    return this.markers;
  }

  private add(
    rule: NodeIslandRule,
    reason: string,
    construct: string,
    node: ts.Node,
    member?: string,
  ): void {
    if (this.markers.length >= MARKER_CAP) return;
    this.markers.push({
      rule,
      reason,
      construct,
      loc: { file: this.sf.fileName, start: ts.tokenStartOfNode(node), end: node.end },
      ...(member === undefined ? {} : { member }),
    });
  }

  /** Records that `decl` declares `name` with the identity `value` (null
   * for a declared name that is not a builtin module value, which still
   * masks an outer alias of the same name). */
  private recordBinding(
    name: string,
    decl: ts.Node,
    value: BindingValue | null,
    hoisted = false,
  ): void {
    const scope = bindingScope(decl, hoisted);
    const entry: ScopedBinding = {
      value: value ?? NOT_BUILTIN,
      scope,
      depth: scopeDepth(scope),
      order: ts.tokenStartOfNode(decl),
    };
    const list = this.bindings.get(name);
    if (list === undefined) this.bindings.set(name, [entry]);
    else list.push(entry);
  }

  /** The binding `name` resolves to at `at`: the innermost declaration
   * whose scope contains the use. */
  private bindingAt(name: string, at: ts.Node): BindingValue | undefined {
    const list = this.bindings.get(name);
    if (list === undefined) return undefined;
    let best: ScopedBinding | undefined;
    for (const entry of list) {
      if (!scopeContains(entry.scope, at)) continue;
      if (
        best === undefined ||
        entry.depth > best.depth ||
        (entry.depth === best.depth && entry.order > best.order)
      )
        best = entry;
    }
    return best?.value;
  }

  /** Whether `name` already has a declaration in the scope `decl` binds in. */
  private hasBindingInScope(name: string, decl: ts.Node, hoisted: boolean): boolean {
    const list = this.bindings.get(name);
    if (list === undefined) return false;
    const scope = bindingScope(decl, hoisted);
    return list.some((entry) => entry.scope === scope);
  }

  private bindName(
    name: ts.Node | undefined,
    init: ts.Node | undefined,
    hoisted = false,
    identity?: BindingValue,
  ): void {
    if (name === undefined) return;
    if (ts.isIdentifier(name)) {
      this.declared.add(name.text);
      if (init === undefined) {
        // `var fs;` declares the variable again without changing the value
        // it already holds, so it keeps the identity of the declaration it
        // shares a scope with instead of masking it as unbound.
        if (identity === undefined && this.hasBindingInScope(name.text, name, hoisted)) return;
        this.recordBinding(name.text, name, identity ?? null, hoisted);
        return;
      }
      const value = stripWrappers(init);
      if (ts.isFunctionExpression(value) || ts.isArrowFunction(value))
        this.functions.add(name.text);
      else if (ts.isClassExpression(value)) this.classes.add(name.text);
      const bound = this.builtinOf(value);
      const createRequire =
        ts.isCallExpression(value) && this.isCreateRequireCallee(value.expression);
      this.recordBinding(
        name.text,
        name,
        bound === null && !createRequire
          ? null
          : {
              builtin: bound,
              cjs: bound !== null && !bound.includes(".") && this.isCjsObjectValue(value),
              createRequire,
            },
        hoisted,
      );
      return;
    }
    if (ts.isObjectBindingPattern(name)) {
      this.recordCjsPatternReads(name, init);
      const base = init === undefined ? null : this.builtinOf(init);
      for (const element of name.elements.nodes) {
        if (!ts.isBindingElement(element)) continue;
        const local = element.name;
        if (local !== undefined && ts.isIdentifier(local) && base !== null) {
          const key = element.propertyName;
          const member = key !== undefined && ts.isIdentifier(key) ? key.text : local.text;
          this.bindName(local, undefined, hoisted, {
            builtin: `${base}.${member}`,
            cjs: false,
            createRequire: false,
          });
        } else this.bindName(local, undefined, hoisted);
      }
      return;
    }
    if (ts.isArrayBindingPattern(name)) {
      for (const element of name.elements.nodes) {
        if (ts.isBindingElement(element)) this.bindName(element.name, undefined, hoisted);
      }
    }
  }

  /** A value that is a builtin module's CommonJS object: a require() or a
   * createRequire'd require's result of a builtin, or an alias of one. */
  private isCjsObjectValue(value: ts.Node): boolean {
    if (ts.isIdentifier(value)) return this.bindingAt(value.text, value)?.cjs === true;
    if (!ts.isCallExpression(value)) return false;
    return (
      this.isRequireCallee(value.expression) ||
      (ts.isIdentifier(value.expression) &&
        this.bindingAt(value.expression.text, value.expression)?.createRequire === true)
    );
  }

  /** `require("fs")`, `require("node:util").inherits` → "fs", "util.inherits". */
  private builtinOf(node: ts.Node): string | null {
    const value = stripWrappers(node);
    if (
      ts.isCallExpression(value) &&
      (this.isRequireCallee(value.expression) ||
        (ts.isIdentifier(value.expression) &&
          this.bindingAt(value.expression.text, value.expression)?.createRequire === true))
    ) {
      const spec = literalText(value.arguments.nodes[0]);
      return spec === null ? null : builtinModuleName(spec);
    }
    if (ts.isPropertyAccessExpression(value)) {
      const base = this.builtinOf(value.expression);
      const name = propertyName(value);
      return base === null || name === null ? null : `${base}.${name}`;
    }
    if (ts.isIdentifier(value)) return this.bindingAt(value.text, value)?.builtin ?? null;
    return null;
  }

  private isRequireCallee(node: ts.Node): boolean {
    return ts.isIdentifier(node) && node.text === "require";
  }

  private isCreateRequireCallee(node: ts.Node): boolean {
    if (ts.isIdentifier(node)) {
      return (
        node.text === "createRequire" ||
        this.bindingAt(node.text, node)?.builtin === "module.createRequire"
      );
    }
    return propertyName(node) === "createRequire";
  }

  private collectDeclarations(): void {
    ts.walkPreorder(this.sf, (node) => {
      if (ts.isFunctionDeclaration(node) && node.name !== undefined) {
        this.declared.add(node.name.text);
        this.functions.add(node.name.text);
        this.recordBinding(
          node.name.text,
          node,
          null,
          this.isAnnexBBlockFunction(node) && !this.isStrict(node),
        );
      } else if (ts.isClassDeclaration(node) && node.name !== undefined) {
        this.declared.add(node.name.text);
        this.classes.add(node.name.text);
        this.recordBinding(node.name.text, node, null);
      } else if (
        (ts.isInterfaceDeclaration(node) ||
          ts.isTypeAliasDeclaration(node) ||
          ts.isEnumDeclaration(node) ||
          ts.isModuleDeclaration(node)) &&
        ts.isIdentifier(node.name)
      ) {
        this.declared.add(node.name.text);
        // An enum or namespace name is also a value binding; an interface
        // or type alias is not, and never shadows a value.
        if (ts.isEnumDeclaration(node) || ts.isModuleDeclaration(node))
          this.recordBinding(node.name.text, node, null);
      } else if (ts.isTypeParameterDeclaration(node)) {
        this.declared.add(node.name.text);
      } else if (ts.isEnumMember(node) && ts.isIdentifier(node.name)) {
        this.declared.add(node.name.text);
      } else if (ts.isVariableDeclaration(node)) {
        this.bindName(node.name, node.initializer);
      } else if (ts.isParameter(node)) {
        this.bindName(node.name, undefined);
      } else if (ts.isFunctionExpression(node) && node.name !== undefined) {
        this.declared.add(node.name.text);
        this.recordBinding(node.name.text, node, null);
      } else if (ts.isClassExpression(node) && node.name !== undefined) {
        this.recordBinding(node.name.text, node, null);
      } else if (ts.isCatchClause(node) && node.variableDeclaration !== undefined) {
        this.bindName(node.variableDeclaration.name, undefined);
      } else if (ts.isNewExpression(node) && ts.isIdentifier(node.expression)) {
        this.constructed.add(node.expression.text);
      } else if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        this.bareCalled.add(node.expression.text);
      } else if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isPropertyAccessExpression(node.left) &&
        isPrototypeFunctionAssignment(node.left, node.right)
      ) {
        this.prototypeFunctions.add(node.right);
      } else if (ts.isImportDeclaration(node)) {
        const spec = literalText(node.moduleSpecifier);
        const module = spec === null ? null : builtinModuleName(spec);
        const clause = node.importClause;
        if (clause !== undefined) {
          if (clause.name !== undefined) {
            this.declared.add(clause.name.text);
            this.recordBinding(
              clause.name.text,
              clause.name,
              module === null
                ? null
                : {
                    builtin: module,
                    // A default import is the CommonJS object (unlike a
                    // namespace or named import, through which Node refuses
                    // writes).
                    cjs: true,
                    createRequire: false,
                  },
            );
          }
          const bindings = clause.namedBindings;
          if (bindings !== undefined && ts.isNamespaceImport(bindings)) {
            this.declared.add(bindings.name.text);
            this.recordBinding(
              bindings.name.text,
              bindings.name,
              module === null ? null : { builtin: module, cjs: false, createRequire: false },
            );
          } else if (bindings !== undefined && ts.isNamedImports(bindings)) {
            for (const element of bindings.elements.nodes) {
              this.declared.add(element.name.text);
              const imported = element.propertyName;
              const member =
                imported !== undefined && ts.isIdentifier(imported)
                  ? imported.text
                  : element.name.text;
              this.recordBinding(
                element.name.text,
                element.name,
                module === null
                  ? null
                  : { builtin: `${module}.${member}`, cjs: false, createRequire: false },
              );
            }
          }
        }
      }
      return undefined;
    });
  }

  /** Whether the code at `node` runs in strict mode. */
  private isStrict(node: ts.Node): boolean {
    if (this.moduleStrict) return true;
    let cur: ts.Node | undefined = node.parent;
    const visited: ts.Node[] = [];
    let strict = false;
    while (cur !== undefined) {
      const known = this.strictness.get(cur);
      if (known !== undefined) {
        strict = known;
        break;
      }
      visited.push(cur);
      if (ts.isClassDeclaration(cur) || ts.isClassExpression(cur)) {
        strict = true;
        break;
      }
      if (isFunctionBoundary(cur) || ts.isArrowFunction(cur)) {
        const body = (cur as ts.FunctionLikeDeclaration).body;
        if (body !== undefined && ts.isBlock(body) && hasUseStrict(body.statements.nodes)) {
          strict = true;
          break;
        }
      }
      cur = cur.parent;
    }
    for (const n of visited) this.strictness.set(n, strict);
    return strict;
  }

  private isGlobal(name: string): boolean {
    return BUILTIN_GLOBALS.has(name) && !this.declared.has(name);
  }

  /** A function declaration whose parent is a block that is not a function
   * body: Annex B.3.2's block-level declaration, which in sloppy code also
   * creates a `var`-like binding in the enclosing function (DESIGN.md note 1
   * §3.1, construct 5). A declaration directly in a function body or at the
   * top level of a script is ordinary. */
  private isAnnexBBlockFunction(fn: ts.FunctionDeclaration): boolean {
    const parent = fn.parent;
    if (parent === undefined || !ts.isBlock(parent)) return false;
    const owner = parent.parent;
    if (owner === undefined) return false;
    // A function-like body, a class static block or a class member
    // initializer block is not a bare block statement.
    return (owner as ts.FunctionLikeDeclaration).body !== parent;
  }

  /** Whether the file shows the function is only ever called with a
   * receiver, so native's missing sloppy `this` cannot be observed: it is
   * constructed with `new`, or it is a `X.prototype.name` method (decision
   * S5 — the marker islands what native gets wrong, and native passes the
   * receiver for both shapes). */
  private receiverSafe(fn: ts.FunctionDeclaration | ts.FunctionExpression): boolean {
    if (this.prototypeFunctions.has(fn)) return true;
    const name = boundFunctionName(fn);
    return name !== null && this.constructed.has(name) && !this.bareCalled.has(name);
  }

  /** `this` in a plain function call: a sloppy function that is not a
   * method, constructor, accessor or class member, and is not an arrow
   * function (whose `this` is its enclosing function's). Conservative
   * (decision S2): a file-level scan cannot see cross-file call sites, so
   * any `this` in such a function marks the module, except the shapes the
   * file itself proves are receiver calls (decision S5). Top-level `this`
   * is not this marker: it is the module's exports object, and the test262
   * profile's script-environment exclusion covers the script form. */
  private visitThis(node: ts.Node): void {
    if (this.isStrict(node)) return;
    for (let cur: ts.Node | undefined = node.parent; cur !== undefined; cur = cur.parent) {
      // An arrow function has no `this` of its own: keep looking outward.
      if (ts.isArrowFunction(cur)) continue;
      if (ts.isFunctionDeclaration(cur) || ts.isFunctionExpression(cur)) {
        if (this.receiverSafe(cur)) return;
        this.add("R2.4", "sloppy-this", "'this' in a plain call in sloppy mode", node);
        return;
      }
      // A method, constructor or accessor has a receiver; a class member
      // initializer and a class static block have their own `this`; a
      // property assignment's function is commonly a method too.
      if (
        isFunctionBoundary(cur) ||
        ts.isClassDeclaration(cur) ||
        ts.isClassExpression(cur) ||
        ts.isClassStaticBlockDeclaration(cur) ||
        ts.isPropertyDeclaration(cur) ||
        ts.isPropertyAssignment(cur)
      )
        return;
      // Top-level `this` is the module's exports object, not a call site.
      if (ts.isSourceFile(cur)) return;
    }
  }

  private visit(node: ts.Node): void {
    if (ts.isCallExpression(node)) this.visitCall(node);
    else if (ts.isNewExpression(node)) this.visitNew(node);
    else if (ts.isBinaryExpression(node) && isAssignmentOperator(node.operatorToken.kind)) {
      this.visitWrite(node.left, node, "write");
      if (node.operatorToken.kind === ts.SyntaxKind.EqualsToken)
        this.recordCjsPatternReads(node.left, node.right);
    } else if (ts.isDeleteExpression(node)) this.visitDelete(node);
    else if (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) {
      if (
        node.operator === ts.SyntaxKind.PlusPlusToken ||
        node.operator === ts.SyntaxKind.MinusMinusToken
      )
        this.visitWrite(node.operand, node, "write");
    } else if (ts.isWithStatement(node)) {
      // A `with` in strict code is an early error (Node refuses the file
      // too), so only sloppy code carries the sloppy-semantics marker.
      if (!this.isStrict(node)) this.add("R2.4", "with", "a 'with' statement", node);
    } else if (ts.isImportDeclaration(node)) {
      const spec = literalText(node.moduleSpecifier);
      if (spec !== null) this.visitSpecifier(spec, node);
    } else if (ts.isIdentifier(node)) {
      this.visitIdentifier(node);
    } else if (ts.isNumericLiteral(node)) {
      const text = ts.getTextOfNode(node);
      if (/^0[0-9]+$/.test(text) && !this.isStrict(node))
        this.add("R2.4", "sloppy-mode", "a legacy octal literal", node);
    } else if (ts.isPropertyAccessExpression(node)) {
      const text = chainText(node);
      if ((text === "arguments.callee" || text === "arguments.caller") && !this.isStrict(node))
        this.add("R2.4", "sloppy-arguments", `'${text}'`, node);
      this.recordCjsRead(node);
    } else if (ts.isElementAccessExpression(node)) {
      this.recordCjsRead(node);
    } else if (node.kind === ts.SyntaxKind.ThisKeyword) {
      this.visitThis(node);
    } else if (ts.isObjectLiteralExpression(node)) {
      for (const prop of node.properties.nodes) {
        if (!ts.isPropertyAssignment(prop)) continue;
        const name = prop.name;
        const key = ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : null;
        if (key === "__proto__" && prop.initializer.kind !== ts.SyntaxKind.NullKeyword)
          this.add("R2.2", "prototype-write", "an object literal with a '__proto__' value", prop);
      }
    } else if (isFunctionBoundary(node)) {
      this.visitFunction(node as ts.FunctionLikeDeclaration);
    }
  }

  /** The builtin module whose CommonJS object `value` names, or null when
   * the binding there holds anything else. */
  private cjsModuleOf(value: ts.Node): string | null {
    if (!ts.isIdentifier(value)) return null;
    const binding = this.bindingAt(value.text, value);
    return binding !== undefined && binding.cjs ? binding.builtin : null;
  }

  /** Records a read of a member of a builtin module's CommonJS object, so
   * a patch installed by an island module can be checked against it
   * (H3.4). The left of an assignment (and a delete or ++/-- target) is a
   * write, not a read. A computed key reads a member the scan cannot name,
   * so it is recorded as the whole module ("fs.*"). */
  private recordCjsRead(node: ts.PropertyAccessExpression | ts.ElementAccessExpression): void {
    const root = chainRoot(node);
    if (root === null) return;
    const binding = this.bindingAt(root.text, root);
    if (binding === undefined || !binding.cjs || binding.builtin === null) return;
    const module = binding.builtin;
    const text = chainText(node);
    const parent = node.parent;
    if (parent !== undefined) {
      if (
        ts.isBinaryExpression(parent) &&
        isAssignmentOperator(parent.operatorToken.kind) &&
        parent.left === node
      )
        return;
      if (
        ts.isDeleteExpression(parent) ||
        ts.isPrefixUnaryExpression(parent) ||
        ts.isPostfixUnaryExpression(parent)
      )
        return;
    }
    this.pushCjsRead(text === null ? `${module}.*` : module + text.slice(root.text.length), node);
  }

  private pushCjsRead(member: string, node: ts.Node): void {
    this.cjsReads.push({
      member,
      loc: { file: this.sf.fileName, start: ts.tokenStartOfNode(node), end: node.end },
    });
  }

  /** The reads of a destructuring whose source is a builtin module's
   * CommonJS object (`const { readFileSync } = require("fs")`,
   * `({ readFileSync } = fs)`): each property it takes is read when the
   * destructuring runs, so it sees a patch installed before. A rest element
   * or a computed key reads members the scan cannot name ("fs.*"). */
  private recordCjsPatternReads(pattern: ts.Node, source: ts.Node | undefined): void {
    if (source === undefined) return;
    const value = stripWrappers(source);
    if (!this.isCjsObjectValue(value)) return;
    const module = this.builtinOf(value);
    if (module === null || module.includes(".")) return;
    this.recordPatternReads(pattern, module);
  }

  private recordPatternReads(pattern: ts.Node, base: string): void {
    const target = stripWrappers(pattern);
    const elements: {
      key: ts.Node | undefined;
      value: ts.Node | undefined;
      rest: boolean;
      node: ts.Node;
    }[] = [];
    if (ts.isObjectBindingPattern(target)) {
      for (const element of target.elements.nodes) {
        if (!ts.isBindingElement(element)) continue;
        elements.push({
          key: element.propertyName ?? element.name,
          value: element.name,
          rest: element.dotDotDotToken !== undefined,
          node: element,
        });
      }
    } else if (ts.isObjectLiteralExpression(target)) {
      for (const prop of target.properties.nodes) {
        if (ts.isPropertyAssignment(prop))
          elements.push({ key: prop.name, value: prop.initializer, rest: false, node: prop });
        else if (ts.isShorthandPropertyAssignment(prop))
          elements.push({ key: prop.name, value: undefined, rest: false, node: prop });
        else if (ts.isSpreadAssignment(prop))
          elements.push({ key: undefined, value: undefined, rest: true, node: prop });
      }
    } else return;
    for (const element of elements) {
      const key = element.rest || element.key === undefined ? null : staticKey(element.key);
      if (key === null) {
        this.pushCjsRead(`${base.split(".")[0]}.*`, element.node);
        continue;
      }
      const member = `${base}.${key}`;
      this.pushCjsRead(member, element.node);
      // A nested pattern reads the member's own properties too.
      if (element.value !== undefined) {
        let inner = stripWrappers(element.value);
        // `{ readFileSync = fallback }` (a default) and `{ a: { b } = {} }`.
        if (ts.isBinaryExpression(inner) && inner.operatorToken.kind === ts.SyntaxKind.EqualsToken)
          inner = stripWrappers(inner.left);
        if (ts.isObjectBindingPattern(inner) || ts.isObjectLiteralExpression(inner))
          this.recordPatternReads(inner, member);
      }
    }
  }

  private visitSpecifier(spec: string, node: ts.Node): void {
    const builtin = builtinModuleName(spec);
    if (builtin === "vm") this.add("R1.1", "vm", "the 'vm' module", node);
    else if (spec.endsWith(".node"))
      this.add("R1.3", "native-addon", `the native addon '${spec}'`, node);
    else if (ADDON_LOADERS.has(spec))
      this.add("R1.3", "native-addon", `the native addon loader '${spec}'`, node);
    else if (LOADER_HOOK_PACKAGES.has(spec))
      this.add("R1.4", "loader-hook", `the loader hook package '${spec}'`, node);
  }

  private visitCall(call: ts.CallExpression): void {
    const callee = call.expression;
    const args = call.arguments.nodes;
    const first = args[0];
    // import(e) and require(e)
    if (callee.kind === ts.SyntaxKind.ImportKeyword) {
      if (first !== undefined && !isFoldableSpecifier(first))
        this.add("R1.2", "dynamic-import", "import() with a computed specifier", call);
      else if (first !== undefined) this.visitSpecifier(literalText(first) ?? "", call);
      return;
    }
    if (
      this.isRequireCallee(callee) ||
      (ts.isIdentifier(callee) && this.bindingAt(callee.text, callee)?.createRequire === true)
    ) {
      if (first !== undefined && !isFoldableSpecifier(first))
        this.add("R1.2", "dynamic-require", "require() with a computed specifier", call);
      else if (first !== undefined) this.visitSpecifier(literalText(first) ?? "", call);
      return;
    }
    if (ts.isCallExpression(callee) && this.isCreateRequireCallee(callee.expression)) {
      if (first !== undefined && !isFoldableSpecifier(first))
        this.add("R1.2", "dynamic-require", "createRequire(...)() with a computed specifier", call);
      return;
    }
    // eval, Function
    let target = callee;
    while (ts.isParenthesizedExpression(target)) target = target.expression;
    // A bare `eval(...)` is the intrinsic's DIRECT call: it reads and
    // creates bindings in the caller's scope, and in sloppy mode creates
    // globals (DESIGN.md note 1 §3.1). `globalThis.eval(...)`, the
    // comma-operator idiom `(0, eval)(...)` and the other spellings are
    // indirect: they observe no caller scope, so only R1.1.
    const direct = ts.isIdentifier(target) && target.text === "eval" && !this.declared.has("eval");
    if (ts.isBinaryExpression(target) && target.operatorToken.kind === ts.SyntaxKind.CommaToken)
      target = target.right;
    const text = chainText(target);
    if (text === null) return;
    if (text === "eval" && !this.declared.has("eval")) {
      this.add("R1.1", "code-from-string", "eval()", call);
      if (direct && !this.isStrict(call))
        this.add("R2.4", "direct-eval", "a direct call of eval() in sloppy mode", call);
      return;
    }
    if (text === "globalThis.eval" || text === "global.eval" || text === "window.eval") {
      this.add("R1.1", "code-from-string", "eval()", call);
      return;
    }
    if (text === "Function" && this.isGlobal("Function")) {
      this.visitFunctionConstructor(call, args);
      return;
    }
    const root = chainRoot(target);
    const rootBinding =
      root === null ? undefined : (this.bindingAt(root.text, root)?.builtin ?? undefined);
    const resolved =
      rootBinding !== undefined && root !== null
        ? rootBinding + text.slice(root.text.length)
        : text;
    // engine internals
    if (
      (text === "process.binding" || text === "process._linkedBinding") &&
      this.isGlobal("process")
    ) {
      this.add("R1.5", "engine-internal", `'${text}()'`, call);
      return;
    }
    if (text === "internalBinding" && !this.declared.has("internalBinding")) {
      this.add("R1.5", "engine-internal", "'internalBinding()'", call);
      return;
    }
    if (resolved === "v8.setFlagsFromString" || text.endsWith(".setFlagsFromString")) {
      this.add("R1.5", "engine-internal", "'v8.setFlagsFromString()'", call);
      return;
    }
    if ((text === "global.gc" || text === "globalThis.gc") && this.isGlobal(text.split(".")[0]!)) {
      this.add("R1.5", "engine-internal", `'${text}()'`, call);
      return;
    }
    if (text === "process.dlopen" && this.isGlobal("process")) {
      this.add("R1.3", "native-addon", "'process.dlopen()'", call);
      return;
    }
    // loader hooks
    if (resolved === "module.register" || resolved === "module.registerHooks") {
      this.add("R1.4", "loader-hook", `'${resolved}()'`, call);
      return;
    }
    // prototype mutation
    if (
      (text === "Object.setPrototypeOf" && this.isGlobal("Object")) ||
      (text === "Reflect.setPrototypeOf" && this.isGlobal("Reflect"))
    ) {
      // The transpiled-Error idiom `Object.setPrototypeOf(this, …)` stays.
      if (first !== undefined && first.kind !== ts.SyntaxKind.ThisKeyword)
        this.add("R2.2", "prototype-write", `'${text}()'`, call);
      return;
    }
    // defineProperty outside the module object and interop helpers
    if (
      ((text === "Object.defineProperty" || text === "Object.defineProperties") &&
        this.isGlobal("Object")) ||
      (text === "Reflect.defineProperty" && this.isGlobal("Reflect"))
    ) {
      // A definition on a builtin module's CommonJS object is a patch the
      // code loading that object must see (R2.5, H3.1.4).
      const target = first === undefined ? undefined : stripWrappers(first);
      const builtin = target === undefined ? null : this.cjsModuleOf(target);
      if (builtin !== null) {
        const key = literalText(args[1] === undefined ? undefined : stripWrappers(args[1]));
        this.add(
          "R2.5",
          "builtin-patch",
          `'${text}()' on the builtin module '${builtin}'`,
          call,
          key === null ? `${builtin}.*` : `${builtin}.${key}`,
        );
        return;
      }
      if (first !== undefined && !this.isModuleObject(first) && !this.inInteropHelper(call))
        this.add("R2.3", "define-property", `'${text}()'`, call);
      return;
    }
    // Object.assign(fs, …) on a builtin module's CommonJS object: every
    // literal key is a patch (R2.5, H3.1.4).
    if (text === "Object.assign" && this.isGlobal("Object") && first !== undefined) {
      const target = stripWrappers(first);
      {
        const builtin = this.cjsModuleOf(target);
        if (builtin !== null) {
          const source = args.length === 2 ? stripWrappers(args[1]!) : undefined;
          const keys =
            source !== undefined && ts.isObjectLiteralExpression(source)
              ? source.properties.nodes
                  .map((property) =>
                    ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)
                      ? literalKeyName(property.name)
                      : null,
                  )
                  .filter((key): key is string => key !== null)
              : [];
          if (keys.length === 0)
            this.add(
              "R2.5",
              "builtin-patch",
              `'Object.assign()' on the builtin module '${builtin}'`,
              call,
              `${builtin}.*`,
            );
          else
            for (const key of keys)
              this.add(
                "R2.5",
                "builtin-patch",
                `'Object.assign()' on the builtin module '${builtin}'`,
                call,
                `${builtin}.${key}`,
              );
          return;
        }
      }
    }
    if (text.endsWith(".__defineGetter__") || text.endsWith(".__defineSetter__")) {
      this.add("R2.3", "define-property", `'${text.slice(text.lastIndexOf(".") + 1)}()'`, call);
      return;
    }
    // constructor functions
    if (
      args.length === 2 &&
      (resolved === "util.inherits" ||
        (text === "inherits" && !this.functions.has("inherits")) ||
        text.endsWith(".inherits"))
    ) {
      this.add("R2.1", "constructor-function", `'${text}()'`, call);
      return;
    }
    if (
      ts.isPropertyAccessExpression(target) &&
      (propertyName(target) === "call" || propertyName(target) === "apply") &&
      first !== undefined &&
      first.kind === ts.SyntaxKind.ThisKeyword &&
      ts.isExpressionStatement(call.parent!)
    ) {
      const fn = target.expression;
      const name = ts.isIdentifier(fn) ? fn.text : null;
      if (name !== null && /^[A-Z]/.test(name) && !this.classes.has(name))
        this.add(
          "R2.1",
          "constructor-function",
          `'${name}.${propertyName(target)}(this, …)'`,
          call,
        );
    }
  }

  private visitFunctionConstructor(node: ts.Node, args: readonly ts.Node[]): void {
    // The global-object idiom Function("return this")() folds to globalThis.
    if (args.length === 1) {
      const body = literalText(args[0]);
      if (body !== null && body.trim() === "return this") return;
    }
    // A capability probe tested inside try (zod 4's allowsEval) keeps
    // today's EvalError lowering.
    for (let cur = node.parent; cur !== undefined; cur = cur.parent) {
      if (isFunctionBoundary(cur) || ts.isArrowFunction(cur)) break;
      if (ts.isBlock(cur) && cur.parent !== undefined && ts.isTryStatement(cur.parent)) {
        if (cur.parent.tryBlock === cur) return;
      }
    }
    this.add("R1.1", "code-from-string", "new Function()", node);
  }

  private visitNew(node: ts.NewExpression): void {
    const callee = node.expression;
    if (!ts.isIdentifier(callee)) return;
    const name = callee.text;
    if (name === "Function" && this.isGlobal("Function")) {
      this.visitFunctionConstructor(node, node.arguments?.nodes ?? []);
    } else if (name === "Proxy" && !this.declared.has("Proxy")) {
      this.add("R2.5", "proxy", "new Proxy()", node);
    } else if (this.functions.has(name) && !this.classes.has(name)) {
      this.add("R2.1", "constructor-function", `'new ${name}()' of a function`, node);
    }
  }

  private isModuleObject(node: ts.Node): boolean {
    const text = chainText(node);
    return text === "exports" || text === "module.exports" || text === "module";
  }

  /** Inside a module-interop helper (tsc's __createBinding/__exportStar,
   * Babel's _interopRequireWildcard, esbuild's __export): their
   * defineProperty calls build module objects the native subset models. */
  private inInteropHelper(node: ts.Node): boolean {
    for (let cur = node.parent; cur !== undefined; cur = cur.parent) {
      let name: string | null = null;
      if (ts.isFunctionDeclaration(cur) && cur.name !== undefined) name = cur.name.text;
      else if (ts.isVariableDeclaration(cur) && ts.isIdentifier(cur.name)) name = cur.name.text;
      else if (ts.isBinaryExpression(cur) && isAssignmentOperator(cur.operatorToken.kind))
        name = chainText(cur.left);
      if (name !== null && /(^|\.)_/.test(name)) return true;
    }
    return false;
  }

  private visitWrite(target: ts.Node, node: ts.Node, what: "write" | "delete"): void {
    let left = target;
    while (ts.isParenthesizedExpression(left)) left = left.expression;
    if (ts.isIdentifier(left)) {
      if (this.isGlobal(left.text) && left.text !== "global" && left.text !== "globalThis")
        this.add("R2.5", "builtin-write", `a ${what} of the global '${left.text}'`, node);
      return;
    }
    if (!ts.isPropertyAccessExpression(left) && !ts.isElementAccessExpression(left)) return;
    const text = chainText(left);
    const root = chainRoot(left);
    const base = left.expression;
    const baseText = chainText(base);
    // require.extensions / require.cache
    if (
      text !== null &&
      (text.startsWith("require.extensions") || text.startsWith("require.cache"))
    ) {
      this.add(
        "R1.4",
        "loader-hook",
        `a ${what} of '${text.startsWith("require.cache") ? "require.cache" : "require.extensions"}'`,
        node,
      );
      return;
    }
    if (baseText === "require.cache" || baseText === "require.extensions") {
      this.add("R1.4", "loader-hook", `a ${what} of '${baseText}'`, node);
      return;
    }
    // __proto__ writes
    if (propertyName(left) === "__proto__") {
      this.add("R2.2", "prototype-write", `a ${what} of '__proto__'`, node);
      return;
    }
    if (root === null) return;
    const resolvedBinding = this.bindingAt(root.text, root);
    const binding = resolvedBinding?.builtin ?? undefined;
    // Module internals: Module._load = …, Module.prototype.require = …
    if (text !== null) {
      const resolved = binding !== undefined ? binding + text.slice(root.text.length) : text;
      if (
        /^(module|Module)\.(_load|_resolveFilename|_extensions|wrap|_compile|prototype\.require|prototype\._compile)$/.test(
          resolved,
        ) &&
        (binding !== undefined || !this.declared.has(root.text) || root.text === "Module")
      ) {
        this.add("R1.4", "loader-hook", `a ${what} of '${resolved}'`, node);
        return;
      }
      // F.prototype…
      const parts = text.split(".");
      if (parts.length >= 2 && parts[1] === "prototype") {
        const name = parts[0]!;
        if (this.isGlobal(name)) {
          this.add("R2.5", "builtin-write", `a ${what} of '${text}'`, node);
          return;
        }
        if (binding === undefined && this.classes.has(name) && !this.functions.has(name)) {
          this.add("R2.3", "define-property", `a ${what} of the class prototype '${text}'`, node);
          return;
        }
        if (binding === undefined && name !== "this") {
          this.add("R2.1", "constructor-function", `a ${what} of '${text}'`, node);
          return;
        }
      }
    }
    // Builtin globals and builtin module objects.
    const spelled = memberText(left) ?? `${root.text}[…]`;
    if (binding !== undefined) {
      const member = binding + spelled.slice(root.text.length);
      if (!this.allowedWrite(member)) {
        // A write through a builtin module's CommonJS object patches that
        // object; only code sharing Node's builtin can see it (H3.1).
        const patch = resolvedBinding?.cjs === true;
        this.add(
          "R2.5",
          patch ? "builtin-patch" : "builtin-write",
          `a ${what} of the builtin module member '${member}'`,
          node,
          patch ? member : undefined,
        );
      }
      return;
    }
    if (this.isGlobal(root.text)) {
      const member = spelled;
      if (!this.allowedWrite(member))
        this.add("R2.5", "builtin-write", `a ${what} of the builtin '${member}'`, node);
    }
  }

  private allowedWrite(member: string): boolean {
    for (const allowed of ALLOWED_BUILTIN_WRITES) {
      if (
        member === allowed ||
        member.startsWith(`${allowed}.`) ||
        member.startsWith(`${allowed}[`)
      )
        return true;
    }
    return false;
  }

  private visitDelete(node: ts.DeleteExpression): void {
    let target = node.expression;
    while (ts.isParenthesizedExpression(target)) target = target.expression;
    if (ts.isIdentifier(target)) {
      if (!this.isStrict(node))
        this.add("R2.4", "sloppy-mode", `'delete ${target.text}' of an identifier`, node);
      return;
    }
    this.visitWrite(target, node, "delete");
  }

  private visitIdentifier(node: ts.Identifier): void {
    const name = node.text;
    this.collectGlobalRead(node);
    if (name !== "WeakRef" && name !== "FinalizationRegistry") return;
    if (this.declared.has(name)) return;
    const parent = node.parent;
    if (parent === undefined) return;
    // Only value uses: not a property name, declaration name or typeof probe.
    if (ts.isPropertyAccessExpression(parent) && parent.name === node) return;
    if (ts.isTypeOfExpression(parent)) return;
    if ((ts.isPropertyAssignment(parent) || ts.isMethodDeclaration(parent)) && parent.name === node)
      return;
    this.add("R1.6", "weak-ref", `'${name}'`, node);
  }

  /** Records a read of a name the file declares nowhere and no builtin
   * provides: Node resolves it on the global object at run time, where an
   * island module's sloppy implicit-global write may have created it. */
  private collectGlobalRead(node: ts.Identifier): void {
    const name = node.text;
    if (this.declared.has(name) || this.isGlobal(name) || MODULE_SCOPE_NAMES.has(name)) return;
    if (this.globalReadNames.has(name) || this.globalReads.length >= MARKER_CAP) return;
    const parent = node.parent;
    if (parent === undefined || isTypePosition(node) || !isReadPosition(node, parent)) return;
    this.globalReadNames.add(name);
    this.globalReads.push({
      name,
      loc: { file: this.sf.fileName, start: ts.tokenStartOfNode(node), end: node.end },
    });
  }

  /** Observable `arguments` aliasing in a sloppy function: writes to
   * arguments[i], or to a parameter while `arguments` is read. */
  private visitFunction(fn: ts.FunctionLikeDeclaration): void {
    if (ts.isFunctionDeclaration(fn) && this.isAnnexBBlockFunction(fn) && !this.isStrict(fn))
      this.add(
        "R2.4",
        "annexb-block-function",
        "a function declaration in a block in sloppy mode",
        fn,
      );
    const body = fn.body;
    if (body === undefined || !ts.isBlock(body)) return;
    if (this.isStrict(body.statements.nodes[0] ?? body)) return;
    if (hasUseStrict(body.statements.nodes)) return;
    const params = new Set<string>();
    for (const p of fn.parameters.nodes) {
      if (ts.isIdentifier(p.name)) params.add(p.name.text);
    }
    const seen: ArgumentsUse = { reads: false, argumentsWrite: null, paramWrite: null };
    ts.walkPreorder(body, (node) => {
      if (
        node !== body &&
        (isFunctionBoundary(node) || ts.isClassDeclaration(node) || ts.isClassExpression(node))
      )
        return "skip";
      if (ts.isIdentifier(node) && node.text === "arguments") seen.reads = true;
      if (ts.isBinaryExpression(node) && isAssignmentOperator(node.operatorToken.kind)) {
        const left = node.left;
        if (
          ts.isElementAccessExpression(left) &&
          ts.isIdentifier(left.expression) &&
          left.expression.text === "arguments"
        ) {
          if (seen.argumentsWrite === null) seen.argumentsWrite = node;
        } else if (ts.isIdentifier(left) && params.has(left.text)) {
          if (seen.paramWrite === null) seen.paramWrite = node;
        }
      }
      return undefined;
    });
    if (seen.argumentsWrite !== null)
      this.add(
        "R2.4",
        "sloppy-arguments",
        "a write to 'arguments[i]' in sloppy mode",
        seen.argumentsWrite,
      );
    else if (seen.reads && seen.paramWrite !== null)
      this.add(
        "R2.4",
        "sloppy-arguments",
        "a parameter write while 'arguments' is read in sloppy mode",
        seen.paramWrite,
      );
  }
}

interface ArgumentsUse {
  reads: boolean;
  argumentsWrite: ts.Node | null;
  paramWrite: ts.Node | null;
}

/** The R1/R2 markers and CommonJS-object reads of one module, in source
 * order. */
export function scanModuleFacts(sf: ts.SourceFile): {
  markers: NodeIslandMarker[];
  cjsReads: CjsRead[];
  globalReads: GlobalRead[];
} {
  const scanner = new ModuleScanner(sf);
  const markers = scanner.scan();
  return {
    markers: markers.sort((a, b) => a.loc.start - b.loc.start),
    cjsReads: scanner.cjsReads.sort((a, b) => a.loc.start - b.loc.start),
    globalReads: scanner.globalReads.sort((a, b) => a.loc.start - b.loc.start),
  };
}

/** The R1/R2 markers of one module, in source order. */
export function scanModule(sf: ts.SourceFile): NodeIslandMarker[] {
  return scanModuleFacts(sf).markers;
}
