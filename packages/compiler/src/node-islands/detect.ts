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
 * and R2.4 (assignments to undeclared identifiers, `this` as the global
 * object) are left to the lowering. */
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

function literalText(node: ts.Node | undefined): string | null {
  if (node === undefined) return null;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return null;
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
  if (ts.isIdentifier(node)) return node.text;
  if (node.kind === ts.SyntaxKind.ThisKeyword) return "this";
  if (ts.isParenthesizedExpression(node)) return chainText(node.expression);
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
    const base = chainText(node.expression);
    const name = propertyName(node);
    if (base === null || name === null) return null;
    return `${base}.${name}`;
  }
  return null;
}

/** Like chainText, with computed keys spelled `[…]`: `process.env[…]`. */
function memberText(node: ts.Node): string | null {
  const text = chainText(node);
  if (text !== null) return text;
  if (ts.isElementAccessExpression(node)) {
    const base = memberText(node.expression);
    return base === null ? null : `${base}[…]`;
  }
  if (ts.isPropertyAccessExpression(node)) {
    const base = memberText(node.expression);
    const name = propertyName(node);
    return base === null || name === null ? null : `${base}.${name}`;
  }
  return null;
}

/** The identifier a member chain starts at (`a` of `a.b[c].d`). */
function chainRoot(node: ts.Node): ts.Identifier | null {
  let cur = node;
  for (;;) {
    if (ts.isIdentifier(cur)) return cur;
    if (ts.isPropertyAccessExpression(cur) || ts.isElementAccessExpression(cur)) {
      cur = cur.expression;
      continue;
    }
    if (ts.isParenthesizedExpression(cur)) {
      cur = cur.expression;
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
    const head = sf.text.slice(ts.tokenStartOfNode(stmt), ts.tokenStartOfNode(stmt) + 7);
    if (head === "export ") return true;
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
  /** Local name → the builtin module (or `module.member`) it is bound to. */
  private readonly builtinBindings = new Map<string, string>();
  /** Local names bound to a createRequire(...) result. */
  private readonly createdRequires = new Set<string>();
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

  private add(rule: NodeIslandRule, reason: string, construct: string, node: ts.Node): void {
    if (this.markers.length >= MARKER_CAP) return;
    this.markers.push({
      rule,
      reason,
      construct,
      loc: { file: this.sf.fileName, start: ts.tokenStartOfNode(node), end: node.end },
    });
  }

  private bindName(name: ts.Node | undefined, init: ts.Node | undefined): void {
    if (name === undefined) return;
    if (ts.isIdentifier(name)) {
      this.declared.add(name.text);
      if (init === undefined) return;
      let value = init;
      while (ts.isParenthesizedExpression(value)) value = value.expression;
      if (ts.isFunctionExpression(value) || ts.isArrowFunction(value))
        this.functions.add(name.text);
      else if (ts.isClassExpression(value)) this.classes.add(name.text);
      const bound = this.builtinOf(value);
      if (bound !== null) this.builtinBindings.set(name.text, bound);
      if (ts.isCallExpression(value) && this.isCreateRequireCallee(value.expression))
        this.createdRequires.add(name.text);
      return;
    }
    if (ts.isObjectBindingPattern(name)) {
      const base = init === undefined ? null : this.builtinOf(init);
      for (const element of name.elements.nodes) {
        if (!ts.isBindingElement(element)) continue;
        const local = element.name;
        if (local !== undefined && ts.isIdentifier(local) && base !== null) {
          const key = element.propertyName;
          const member = key !== undefined && ts.isIdentifier(key) ? key.text : local.text;
          this.builtinBindings.set(local.text, `${base}.${member}`);
        }
        this.bindName(local, undefined);
      }
      return;
    }
    if (ts.isArrayBindingPattern(name)) {
      for (const element of name.elements.nodes) {
        if (ts.isBindingElement(element)) this.bindName(element.name, undefined);
      }
    }
  }

  /** `require("fs")`, `require("node:util").inherits` → "fs", "util.inherits". */
  private builtinOf(node: ts.Node): string | null {
    let value = node;
    while (ts.isParenthesizedExpression(value)) value = value.expression;
    if (ts.isCallExpression(value) && this.isRequireCallee(value.expression)) {
      const spec = literalText(value.arguments.nodes[0]);
      return spec === null ? null : builtinModuleName(spec);
    }
    if (ts.isPropertyAccessExpression(value)) {
      const base = this.builtinOf(value.expression);
      const name = propertyName(value);
      return base === null || name === null ? null : `${base}.${name}`;
    }
    if (ts.isIdentifier(value)) return this.builtinBindings.get(value.text) ?? null;
    return null;
  }

  private isRequireCallee(node: ts.Node): boolean {
    return ts.isIdentifier(node) && node.text === "require";
  }

  private isCreateRequireCallee(node: ts.Node): boolean {
    if (ts.isIdentifier(node)) {
      return (
        node.text === "createRequire" ||
        this.builtinBindings.get(node.text) === "module.createRequire"
      );
    }
    return propertyName(node) === "createRequire";
  }

  private collectDeclarations(): void {
    ts.walkPreorder(this.sf, (node) => {
      if (ts.isFunctionDeclaration(node) && node.name !== undefined) {
        this.declared.add(node.name.text);
        this.functions.add(node.name.text);
      } else if (ts.isClassDeclaration(node) && node.name !== undefined) {
        this.declared.add(node.name.text);
        this.classes.add(node.name.text);
      } else if (ts.isVariableDeclaration(node)) {
        this.bindName(node.name, node.initializer);
      } else if (ts.isParameter(node)) {
        this.bindName(node.name, undefined);
      } else if (ts.isImportDeclaration(node)) {
        const spec = literalText(node.moduleSpecifier);
        const module = spec === null ? null : builtinModuleName(spec);
        const clause = node.importClause;
        if (clause !== undefined) {
          if (clause.name !== undefined) {
            this.declared.add(clause.name.text);
            if (module !== null) this.builtinBindings.set(clause.name.text, module);
          }
          const bindings = clause.namedBindings;
          if (bindings !== undefined && ts.isNamespaceImport(bindings)) {
            this.declared.add(bindings.name.text);
            if (module !== null) this.builtinBindings.set(bindings.name.text, module);
          } else if (bindings !== undefined && ts.isNamedImports(bindings)) {
            for (const element of bindings.elements.nodes) {
              this.declared.add(element.name.text);
              const imported = element.propertyName;
              const member =
                imported !== undefined && ts.isIdentifier(imported)
                  ? imported.text
                  : element.name.text;
              if (module !== null)
                this.builtinBindings.set(element.name.text, `${module}.${member}`);
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

  private visit(node: ts.Node): void {
    if (ts.isCallExpression(node)) this.visitCall(node);
    else if (ts.isNewExpression(node)) this.visitNew(node);
    else if (ts.isBinaryExpression(node) && isAssignmentOperator(node.operatorToken.kind))
      this.visitWrite(node.left, node, "write");
    else if (ts.isDeleteExpression(node)) this.visitDelete(node);
    else if (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) {
      if (
        node.operator === ts.SyntaxKind.PlusPlusToken ||
        node.operator === ts.SyntaxKind.MinusMinusToken
      )
        this.visitWrite(node.operand, node, "write");
    } else if (ts.isWithStatement(node)) {
      this.add("R2.4", "with", "a 'with' statement", node);
    } else if (ts.isImportDeclaration(node)) {
      const spec = literalText(node.moduleSpecifier);
      if (spec !== null) this.visitSpecifier(spec, node);
    } else if (ts.isIdentifier(node)) {
      this.visitIdentifier(node);
    } else if (ts.isNumericLiteral(node)) {
      const text = this.sf.text.slice(ts.tokenStartOfNode(node), node.end);
      if (/^0[0-9]+$/.test(text) && !this.isStrict(node))
        this.add("R2.4", "sloppy-mode", "a legacy octal literal", node);
    } else if (ts.isPropertyAccessExpression(node)) {
      const text = chainText(node);
      if ((text === "arguments.callee" || text === "arguments.caller") && !this.isStrict(node))
        this.add("R2.4", "sloppy-arguments", `'${text}'`, node);
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
      (ts.isIdentifier(callee) && this.createdRequires.has(callee.text))
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
    if (ts.isBinaryExpression(target) && target.operatorToken.kind === ts.SyntaxKind.CommaToken)
      target = target.right;
    const text = chainText(target);
    if (text === null) return;
    if (
      (text === "eval" && !this.declared.has("eval")) ||
      text === "globalThis.eval" ||
      text === "global.eval" ||
      text === "window.eval"
    ) {
      this.add("R1.1", "code-from-string", "eval()", call);
      return;
    }
    if (text === "Function" && this.isGlobal("Function")) {
      this.visitFunctionConstructor(call, args);
      return;
    }
    const root = chainRoot(target);
    const rootBinding = root === null ? undefined : this.builtinBindings.get(root.text);
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
      if (first !== undefined && !this.isModuleObject(first) && !this.inInteropHelper(call))
        this.add("R2.3", "define-property", `'${text}()'`, call);
      return;
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
    const binding = this.builtinBindings.get(root.text);
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
        this.add(
          "R2.5",
          "builtin-write",
          `a ${what} of the builtin module member '${member}'`,
          node,
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

  /** Observable `arguments` aliasing in a sloppy function: writes to
   * arguments[i], or to a parameter while `arguments` is read. */
  private visitFunction(fn: ts.FunctionLikeDeclaration): void {
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

/** The R1/R2 markers of one JavaScript module, in source order. */
export function scanModule(sf: ts.SourceFile): NodeIslandMarker[] {
  const markers = new ModuleScanner(sf).scan();
  return markers.sort((a, b) => a.loc.start - b.loc.start);
}
