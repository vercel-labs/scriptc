/* Inline CommonJS `require("./x")` of a program module in expression
 * position. A top-level `const m = require("./x")` binding is alias
 * plumbing: member reads resolve to the exporter's declarations, and the
 * statement lowers to the dependency's run-once %init call. An inline
 * require is the same thing without the binding: the %init call runs at
 * exactly the call's position (Node evaluates the module there, or
 * answers from its cache), and the value is then read statically:
 *
 *   - `require("./x").f` and `require("./x").f(...)` over a module whose
 *     exports are a table (member exports or `module.exports = {...}`)
 *     read the member like a binding would;
 *   - `require("./x")` as a value over a module whose whole export is one
 *     value (`module.exports = fn` / `= class {}` / `= make()` / `= 42` /
 *     `= require("./y")`) answers that value.
 *
 * A table module's exports object as a value has no static
 * representation; it keeps a named refusal (a first-class CommonJS module
 * object is the two-tier design's S9 stage). */
import * as ts from "../ts7/adapter.js";
import type { Lowerer } from "./lowerer.js";
import {
  canonicalBuiltinModule,
  cjsExportAssignmentOf,
  cjsExportDiscardReason,
  cjsExportTargetLiteral,
  isCjsJsFile,
  isJsSourceFile,
  isModuleExportsAccess,
  locOf,
  npmStaticDepSf7,
  requireSpecOf,
  resolveImport,
} from "../program.js";
import { createRequireCalleeFileOf } from "./builtins/module-bindings.js";
import { isCjsRequireGlobal } from "./lower-node-module.js";
import { DYN, type IrExpr } from "../../ir/ir.js";
import { nodeThrowExpr } from "../../ir/build.js";
import { probeNodeRequireRefusal } from "../npm.js";
import { lowerIslandRequireCall } from "./lower-node-island.js";

export interface InlineRequire {
  call: ts.CallExpression;
  spec: string;
  dep: ts.SourceFile;
}

/** A `require("<literal>")` call of the CommonJS global in a CommonJS JS
 * file whose target is a compiled program module (relative, aliased, or an
 * opted-in --npm-static package). Builtins, JSON documents and
 * createRequire bindings answer null: their own lowerings own them. */
export function inlineProgramRequireOf(
  lowerer: Lowerer,
  expr: ts.Expression,
): InlineRequire | null {
  let e = expr;
  while (ts.isParenthesizedExpression(e)) e = e.expression;
  if (!ts.isCallExpression(e) || !ts.isIdentifier(e.expression)) return null;
  const spec = requireSpecOf(e);
  if (spec === null || canonicalBuiltinModule(spec) !== null) return null;
  const sf = ts.getSourceFileOfNode(e);
  if (!isCjsJsFile(sf, lowerer.program)) return null;
  if (!isCjsRequireGlobal(lowerer, e.expression)) return null;
  if (createRequireCalleeFileOf(lowerer, e.expression) !== null) return null;
  const dep =
    resolveImport(lowerer.program, sf, spec, "require") ??
    npmStaticDepSf7(lowerer.program, sf, spec, "require");
  if (!dep || dep.isDeclarationFile || dep.fileName.endsWith(".json")) return null;
  return { call: e, spec, dep };
}

/** The kept (last, not discarded) top-level `module.exports = <value>` of a
 * CommonJS module whose whole export is a single value, or null when its
 * exports are a table: member exports only, or a literal / const-literal /
 * Proxy-over-literal table. */
export function cjsWholeExportValueOf(
  sf: ts.SourceFile,
): { assign: ts.BinaryExpression; rhs: ts.Expression } | null {
  let kept: ts.BinaryExpression | null = null;
  for (const stmt of sf.statements.nodes) {
    const cjs = cjsExportAssignmentOf(stmt);
    if (cjs?.kind === "table" && cjsExportDiscardReason(stmt) === null) kept = cjs.expr;
  }
  if (kept === null) return null;
  let rhs: ts.Expression = kept.right;
  while (ts.isParenthesizedExpression(rhs)) rhs = rhs.expression;
  if (ts.isObjectLiteralExpression(rhs) || cjsExportTargetLiteral(rhs, sf) !== null) return null;
  return { assign: kept, rhs };
}

/** True when `dep`'s exports, through `module.exports = require("./y")`
 * re-export chains, are a table that member reads resolve against. */
export function cjsNamespaceModule(lowerer: Lowerer, dep: ts.SourceFile, depth = 0): boolean {
  const whole = cjsWholeExportValueOf(dep);
  if (whole === null) return true;
  const inner = inlineProgramRequireOf(lowerer, whole.rhs);
  return inner !== null && depth < 32 && cjsNamespaceModule(lowerer, inner.dep, depth + 1);
}

/** An inline program-module require over a table module (member reads and
 * member calls resolve through it), or null. */
export function inlineNamespaceRequireOf(
  lowerer: Lowerer,
  expr: ts.Expression,
): InlineRequire | null {
  const req = inlineProgramRequireOf(lowerer, expr);
  return req !== null && cjsNamespaceModule(lowerer, req.dep) ? req : null;
}

/** `value` evaluated after the required module's run-once %init (and its
 * module-registry link) at the require's own position. */
export function withRequireInit(lowerer: Lowerer, req: InlineRequire, value: IrExpr): IrExpr {
  if (lowerer.inlineRequireCycleCalls.has(req.call)) {
    lowerer.unsupported(
      "SC1090",
      req.call,
      `require() of '${req.spec}' while it is still evaluating (a require cycle: Node answers its partial exports, which the static export table does not model)`,
    );
  }
  // Every inline program require is a preflight module edge, so its module
  // has an initializer; never read its exports without evaluating it.
  if (!lowerer.initNameOf.has(req.dep)) {
    lowerer.unsupported(
      "SC1090",
      req.call,
      `require() of '${req.spec}' here (the module is not part of the compiled module order)`,
    );
  }
  const init = lowerer.requireInitStmt(req.spec, req.call);
  if (init === null) return value;
  return { kind: "seqExpr", stmts: [init], result: value, type: value.type, loc: value.loc };
}

/** The whole-export value of `dep` read from the requirer, following
 * `module.exports = require("./y")` re-exports (the inner module already
 * evaluated inside dep's own %init). Null for table modules and for
 * whole-export shapes with no represented value. */
export function wholeExportValue(
  lowerer: Lowerer,
  dep: ts.SourceFile,
  blame: ts.Node,
  depth = 0,
): IrExpr | null {
  const whole = cjsWholeExportValueOf(dep);
  if (whole === null || depth > 32) return null;
  const inner = inlineProgramRequireOf(lowerer, whole.rhs);
  if (inner !== null) return wholeExportValue(lowerer, inner.dep, blame, depth + 1);
  // An identifier names a declaration of the exporting module (or a
  // builtin global): reading it IS the export, exactly what requirer
  // bindings alias to.
  if (ts.isIdentifier(whole.rhs)) return lowerer.lowerExpr(whole.rhs);
  if (ts.isClassExpression(whole.rhs)) {
    return lowerer.classValueRef(lowerer.lowerClassExpressionInfo(whole.rhs), blame);
  }
  const g = lowerer.globalsByDeclNode.get(whole.assign);
  if (g === undefined) return null;
  return { kind: "varRef", localId: g.id, type: g.type, loc: locOf(blame) };
}

/** `require("./x")` as a value (`require("debug")("ns")`, `new
 * (require("./C"))()`, `{ verify: require("./verify") }`): the module's
 * %init at this position, then its whole-export value. Null when `call`
 * is not an inline program-module require. */
export function lowerInlineRequireValue(lowerer: Lowerer, call: ts.CallExpression): IrExpr | null {
  const req = inlineProgramRequireOf(lowerer, call);
  if (req === null) return null;
  const value = wholeExportValue(lowerer, req.dep, call, 0);
  if (value === null) {
    lowerer.unsupported(
      "SC1090",
      call,
      cjsNamespaceModule(lowerer, req.dep)
        ? `the exports object of '${req.spec}' as a value (its exports compile to a static table: read require(${JSON.stringify(req.spec)}).member directly, or bind const m = require(${JSON.stringify(req.spec)}) at the module's top level)`
        : `the whole export of '${req.spec}' as a value (its 'module.exports =' value has no static representation)`,
    );
  }
  return withRequireInit(lowerer, req, value);
}

/** Lowers `inner` (a member read or member call whose receiver is the
 * inline require) with that require marked as handled, so the receiver
 * resolves as a module binding, then sequences the module's %init first. */
export function lowerWithInlineRequireInit(
  lowerer: Lowerer,
  req: InlineRequire,
  inner: () => IrExpr,
): IrExpr {
  lowerer.inlineRequireInitDone.add(req.call);
  try {
    return withRequireInit(lowerer, req, inner());
  } finally {
    lowerer.inlineRequireInitDone.delete(req.call);
  }
}

/** A `require(...)` call of the CommonJS global in a CommonJS file that no
 * other lowering claimed (not a builtin, JSON document, program module or
 * createRequire binding): a package nothing installed resolves throws
 * Node's catchable MODULE_NOT_FOUND at the call, and every other form is
 * refused by name instead of as an unlowerable `require` value. */
export function lowerUncompiledRequireCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
): IrExpr | null {
  if (!ts.isIdentifier(call.expression) || call.expression.text !== "require") return null;
  const sf = ts.getSourceFileOfNode(call);
  if (!isCjsJsFile(sf, lowerer.program) || !isCjsRequireGlobal(lowerer, call.expression))
    return null;
  if (createRequireCalleeFileOf(lowerer, call.expression) !== null) return null;
  const spec = requireSpecOf(call);
  if (spec === null) {
    lowerer.unsupported(
      "SC1090",
      call,
      'require() with a computed specifier (the compiled module graph is fixed at build time: require("<string literal>") lowers)',
      undefined,
      "dynamic-require",
    );
  }
  if (canonicalBuiltinModule(spec) !== null) return null;
  // A package that runs in a Node island loads at the call (scope B).
  const island = lowerIslandRequireCall(lowerer, call);
  if (island !== null) return island;
  if (!spec.startsWith(".") && !spec.startsWith("/") && !spec.startsWith("#")) {
    const refusal = probeNodeRequireRefusal(sf.fileName, spec);
    if (refusal !== null) {
      return nodeThrowExpr(0, "MODULE_NOT_FOUND", refusal.message, DYN, locOf(call));
    }
    lowerer.unsupported(
      "SC1090",
      call,
      `require() of the package '${spec}' in an expression (the package is not compiled into this program)`,
    );
  }
  lowerer.unsupported(
    "SC1090",
    call,
    `require() of '${spec}' in an expression (it does not resolve to a compiled program module)`,
  );
}

/** The elements of a top-level `const { key: { ... } } = require("./x")`
 * declaration over a program module whose nested pattern destructures the
 * named export's value (preflight admits exactly these). Plain elements
 * stay alias plumbing. */
export function requireNestedPatternsOf(decl: ts.VariableDeclaration): ts.BindingElement[] {
  if (!ts.isObjectBindingPattern(decl.name) || decl.initializer === undefined) return [];
  const spec = requireSpecOf(decl.initializer);
  if (spec === null || canonicalBuiltinModule(spec) !== null) return [];
  if (!isJsSourceFile(ts.getSourceFileOfNode(decl))) return [];
  return decl.name.elements.nodes.filter(
    (e) =>
      e.name !== undefined &&
      ts.isObjectBindingPattern(e.name) &&
      e.propertyName !== undefined &&
      ts.isIdentifier(e.propertyName) &&
      e.initializer === undefined &&
      e.dotDotDotToken === undefined,
  );
}

/** A plain method entry of a `module.exports = { ... }` table: identifier
 * name, a body, not a generator. Its value is the method's function. */
export function cjsTableMethodEntry(
  prop: ts.ObjectLiteralElementLike,
): (ts.MethodDeclaration & { name: ts.Identifier; body: ts.Block }) | null {
  if (!ts.isMethodDeclaration(prop) || !ts.isIdentifier(prop.name) || prop.body === undefined)
    return null;
  if (prop.asteriskToken !== undefined) return null;
  return prop as ts.MethodDeclaration & { name: ts.Identifier; body: ts.Block };
}

/** `exports.<name> = value` / `module.exports.<name> = value` assignments in
 * VALUE position inside a top-level statement (`const src = exports.src =
 * []`), outside function bodies and outside the statement's own export
 * chain (`statementExport`, which the statement-level machinery owns). */
export function nestedCjsExportAssignmentsOf(
  stmt: ts.Statement,
  statementExport: ts.BinaryExpression | undefined,
): { name: ts.Identifier; value: ts.Expression }[] {
  if (!ts.isVariableStatement(stmt) && !ts.isExpressionStatement(stmt)) return [];
  const owned = new Set<ts.Node>();
  for (let e: ts.Expression | undefined = statementExport; e !== undefined;) {
    while (ts.isParenthesizedExpression(e)) e = e.expression;
    if (!ts.isBinaryExpression(e) || e.operatorToken.kind !== ts.SyntaxKind.EqualsToken) break;
    owned.add(e);
    e = e.right;
  }
  const out: { name: ts.Identifier; value: ts.Expression }[] = [];
  ts.walkPreorder(stmt, (node) => {
    if (
      node !== stmt &&
      (ts.isFunctionLike(node) || ts.isClassDeclaration(node) || ts.isClassExpression(node))
    )
      return "skip";
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      !owned.has(node) &&
      ts.isPropertyAccessExpression(node.left) &&
      node.left.questionDotToken === undefined &&
      ts.isIdentifier(node.left.name) &&
      ((ts.isIdentifier(node.left.expression) && node.left.expression.text === "exports") ||
        isModuleExportsAccess(node.left.expression))
    ) {
      out.push({ name: node.left.name, value: node.right });
    }
    return undefined;
  });
  return out;
}

/** `const { A, B: b } = ns` at a module's top level, where `ns` is a
 * CommonJS module binding over a table module (picomatch's `const {
 * MAX_LENGTH, ... } = constants`): each name takes a snapshot of the named
 * export's value at this statement, exactly like destructuring the exports
 * object would. Null for every other declaration; the plain elements and
 * their key names otherwise. */
export function cjsNamespaceDestructureOf(
  lowerer: Lowerer,
  decl: ts.VariableDeclaration,
): { dep: ts.SourceFile; elements: { name: ts.Identifier; key: string }[] } | null {
  if (!ts.isObjectBindingPattern(decl.name) || decl.initializer === undefined) return null;
  const stmt = decl.parent?.parent;
  if (stmt === undefined || !ts.isVariableStatement(stmt) || !ts.isSourceFile(stmt.parent))
    return null;
  if (!isJsSourceFile(stmt.parent)) return null;
  let init: ts.Expression = decl.initializer;
  while (ts.isParenthesizedExpression(init)) init = init.expression;
  if (!ts.isIdentifier(init) || !lowerer.cjsLocalModuleBindingOf(init)) return null;
  const dep = lowerer.cjsModuleBindingDepOf(init);
  if (dep === null) return null;
  const elements: { name: ts.Identifier; key: string }[] = [];
  for (const e of decl.name.elements.nodes) {
    if (e.initializer !== undefined || e.dotDotDotToken !== undefined) return null;
    if (e.name === undefined || !ts.isIdentifier(e.name)) return null;
    const key =
      e.propertyName === undefined
        ? e.name.text
        : ts.isIdentifier(e.propertyName) || ts.isStringLiteral(e.propertyName)
          ? e.propertyName.text
          : null;
    if (key === null) return null;
    elements.push({ name: e.name, key });
  }
  return { dep, elements };
}

/** The value of `dep`'s export `key` read from another module: its export
 * global, or the function/class declaration it aliases. Null when it has no
 * static value. */
export function cjsExportValueByName(
  lowerer: Lowerer,
  dep: ts.SourceFile,
  key: string,
  blame: ts.Node,
): IrExpr | null {
  let sym = lowerer.cjsModuleExportSymbol(dep, key);
  if (sym === undefined) return null;
  if (sym.flags & ts.SymbolFlags.Alias) sym = lowerer.checker.getAliasedSymbol(sym);
  const direct = lowerer.globalsBySymbol.get(sym);
  if (direct) return { kind: "varRef", localId: direct.id, type: direct.type, loc: locOf(blame) };
  for (const d of sym.declarations) {
    const byDecl = lowerer.globalsByDeclNode.get(d);
    if (byDecl) return { kind: "varRef", localId: byDecl.id, type: byDecl.type, loc: locOf(blame) };
    // Alias plumbing: a shorthand/identifier table entry or a member
    // export naming a declaration. Reading that identifier IS the value.
    if (ts.isShorthandPropertyAssignment(d)) return lowerer.lowerShorthandValue(d);
    if (ts.isPropertyAssignment(d) && ts.isIdentifier(d.initializer)) {
      return lowerer.lowerExpr(d.initializer);
    }
    if ((ts.isFunctionDeclaration(d) || ts.isClassDeclaration(d)) && d.name !== undefined) {
      return lowerer.lowerExpr(d.name);
    }
  }
  return null;
}
