/* tsc's CommonJS import interop: `const x_1 = __importDefault(require("./m"))`
 * and `const x_1 = __importStar(require("./m"))` at a module's top level,
 * with the helpers tsc emits at the top of the file:
 *
 *   var __importDefault = (this && this.__importDefault) || function (mod) {
 *     return (mod && mod.__esModule) ? mod : { "default": mod };
 *   };
 *
 * For a CommonJS dependency the helper's answer is fixed by the
 * dependency's source: stamped with `__esModule` (tsc output), the binding
 * IS the module's exports; otherwise `x_1.default` is the module's exports
 * (and __importStar also copies every export onto x_1). Both are the
 * static alias model a plain `const x_1 = require("./m")` already has, so
 * the binding lowers as a require binding: the statement is the module's
 * %init, `x_1.f` / `x_1.default.f` read the exports statically, and
 * `x_1.default` over a single-value module is that value. The helper
 * declarations themselves are dead once every call is such a binding (the
 * self-probe `this.__importDefault` reads the pristine exports object,
 * which never has the name), so they lower to nothing. */
import * as ts from "../ts7/adapter.js";
import type { Lowerer } from "./lowerer.js";
import {
  isCjsJsFile,
  isEsModuleStamp,
  npmStaticDepSf7,
  requireSpecOf,
  resolveImport,
} from "../program.js";
import { cjsNamespaceModule } from "./cjs-inline-require.js";

const HELPERS = new Set([
  "__importDefault",
  "__importStar",
  "__createBinding",
  "__setModuleDefault",
]);

export interface TscInteropBinding {
  helper: "__importDefault" | "__importStar";
  spec: string;
  dep: ts.SourceFile;
  /** The dependency stamps `__esModule`: the binding IS its exports. */
  stamped: boolean;
}

/** `var <helper> = (this && this.<helper>) || <function>` at a module's top
 * level: the tsc helper declaration shape. */
function tscHelperDeclName(stmt: ts.Statement): string | null {
  if (!ts.isVariableStatement(stmt)) return null;
  const decls = stmt.declarationList.declarations.nodes;
  if (decls.length !== 1) return null;
  const d = decls[0]!;
  if (!ts.isIdentifier(d.name) || !HELPERS.has(d.name.text) || d.initializer === undefined)
    return null;
  let init: ts.Expression = d.initializer;
  while (ts.isParenthesizedExpression(init)) init = init.expression;
  if (!ts.isBinaryExpression(init) || init.operatorToken.kind !== ts.SyntaxKind.BarBarToken)
    return null;
  let probe: ts.Expression = init.left;
  while (ts.isParenthesizedExpression(probe)) probe = probe.expression;
  if (
    !ts.isBinaryExpression(probe) ||
    probe.operatorToken.kind !== ts.SyntaxKind.AmpersandAmpersandToken ||
    probe.left.kind !== ts.SyntaxKind.ThisKeyword ||
    !ts.isPropertyAccessExpression(probe.right) ||
    probe.right.expression.kind !== ts.SyntaxKind.ThisKeyword ||
    probe.right.name.text !== d.name.text
  )
    return null;
  // The fallback is the helper body: a function, or (newer tsc output) a
  // conditional or IIFE producing one. It never runs when the helper is dead.
  return d.name.text;
}

/** True when the dependency stamps itself as an ES module translation. */
function stampsEsModule(dep: ts.SourceFile): boolean {
  return dep.statements.nodes.some((s) => {
    if (!ts.isExpressionStatement(s)) return false;
    if (isEsModuleStamp(s.expression)) return true;
    const e = s.expression;
    return (
      ts.isBinaryExpression(e) &&
      e.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(e.left) &&
      ts.isIdentifier(e.left.expression) &&
      e.left.expression.text === "exports" &&
      e.left.name.text === "__esModule" &&
      e.right.kind === ts.SyntaxKind.TrueKeyword
    );
  });
}

/** The interop binding a top-level `const x = __importDefault(require(s))` /
 * `__importStar(require(s))` declaration makes, or null. The helper must be
 * the module's own tsc helper declaration and the dependency a compiled
 * CommonJS program module. */
export function tscInteropBindingOfDecl(
  lowerer: Lowerer,
  decl: ts.VariableDeclaration,
): TscInteropBinding | null {
  if (!ts.isIdentifier(decl.name) || decl.initializer === undefined) return null;
  const stmt = decl.parent?.parent;
  if (stmt === undefined || !ts.isVariableStatement(stmt) || !ts.isSourceFile(stmt.parent))
    return null;
  const sf = stmt.parent;
  if (!isCjsJsFile(sf, lowerer.program)) return null;
  let init: ts.Expression = decl.initializer;
  while (ts.isParenthesizedExpression(init)) init = init.expression;
  if (!ts.isCallExpression(init) || init.arguments.nodes.length !== 1) return null;
  const callee = init.expression;
  if (!ts.isIdentifier(callee)) return null;
  if (callee.text !== "__importDefault" && callee.text !== "__importStar") return null;
  if (!sf.statements.nodes.some((s) => tscHelperDeclName(s) === callee.text)) return null;
  const spec = requireSpecOf(init.arguments.nodes[0]!);
  if (spec === null) return null;
  const dep =
    resolveImport(lowerer.program, sf, spec, "require") ??
    npmStaticDepSf7(lowerer.program, sf, spec, "require");
  if (!dep || dep.isDeclarationFile || !isCjsJsFile(dep, lowerer.program)) return null;
  return {
    helper: callee.text as TscInteropBinding["helper"],
    spec,
    dep,
    stamped: stampsEsModule(dep),
  };
}

/** The interop binding an identifier reads, or null. */
export function tscInteropBindingOf(
  lowerer: Lowerer,
  expr: ts.Expression,
): TscInteropBinding | null {
  if (!ts.isIdentifier(expr)) return null;
  const sym = lowerer.checker.getSymbolAtLocation(expr);
  const decl = sym ? sym.declarations.find(ts.isVariableDeclaration) : undefined;
  return decl ? tscInteropBindingOfDecl(lowerer, decl) : null;
}

/** The module whose exports `expr` denotes through an interop binding:
 * the binding itself when the dependency is stamped (or for __importStar,
 * whose copy carries every export), and `binding.default` when it is not.
 * Null for anything else. */
export function tscInteropModuleOf(
  lowerer: Lowerer,
  expr: ts.Expression,
): TscInteropBinding | null {
  let e = expr;
  while (ts.isParenthesizedExpression(e)) e = e.expression;
  const direct = tscInteropBindingOf(lowerer, e);
  if (direct !== null) {
    return direct.stamped || direct.helper === "__importStar" ? direct : null;
  }
  if (ts.isPropertyAccessExpression(e) && !e.questionDotToken && e.name.text === "default") {
    const via = tscInteropBindingOf(lowerer, e.expression);
    if (via !== null && !via.stamped) return via;
  }
  return null;
}

/** `binding.default` over an unstamped single-value dependency: that value
 * (the caller lowers the dependency's whole export). */
export function tscInteropDefaultValueOf(
  lowerer: Lowerer,
  expr: ts.PropertyAccessExpression,
): TscInteropBinding | null {
  if (expr.questionDotToken || expr.name.text !== "default") return null;
  const via = tscInteropBindingOf(lowerer, expr.expression);
  if (via === null || via.stamped) return null;
  return cjsNamespaceModule(lowerer, via.dep) ? null : via;
}

/** True for a tsc helper declaration every reference to which is a
 * recognized interop binding's callee, its own self-probe, or a reference
 * from another such dead helper: the statement lowers to nothing. */
export function isDeadTscHelperDecl(lowerer: Lowerer, stmt: ts.Statement): boolean {
  const name = tscHelperDeclName(stmt);
  if (name === null) return false;
  const sf = ts.getSourceFileOfNode(stmt);
  const helperSpans = new Map<string, ts.Statement>();
  for (const s of sf.statements.nodes) {
    const n = tscHelperDeclName(s);
    if (n !== null) helperSpans.set(n, s);
  }
  const dead = new Set<string>();
  for (let changed = true; changed;) {
    changed = false;
    for (const [helper, decl] of helperSpans) {
      if (dead.has(helper)) continue;
      let live = false;
      ts.walkPreorder(sf, (node) => {
        if (!ts.isIdentifier(node) || node.text !== helper) return undefined;
        const parent = node.parent;
        if (parent !== undefined && ts.isVariableDeclaration(parent) && parent.name === node)
          return undefined;
        const at = ts.tokenStartOfNode(node);
        if (at >= ts.tokenStartOfNode(decl) && at < decl.end) return undefined;
        for (const [other, otherDecl] of helperSpans) {
          if (other !== helper && dead.has(other)) {
            if (at >= ts.tokenStartOfNode(otherDecl) && at < otherDecl.end) return undefined;
          }
        }
        const call = parent;
        const binding = call?.parent;
        if (
          call !== undefined &&
          ts.isCallExpression(call) &&
          call.expression === node &&
          binding !== undefined &&
          ts.isVariableDeclaration(binding) &&
          tscInteropBindingOfDecl(lowerer, binding) !== null
        )
          return undefined;
        live = true;
        return "stop";
      });
      if (!live) {
        dead.add(helper);
        changed = true;
      }
    }
  }
  return dead.has(name);
}
