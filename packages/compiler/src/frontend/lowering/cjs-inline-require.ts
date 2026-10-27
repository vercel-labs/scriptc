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
  requireBindingEarlyUse7,
  requireSpecOf,
  resolveImport,
  splitRequireCallOf,
} from "../program.js";
import { createRequireCalleeFileOf } from "./builtins/module-bindings.js";
import { isCjsRequireGlobal } from "./lower-node-module.js";
import { DYN, type IrExpr } from "../../ir/ir.js";
import { nodeThrowExpr } from "../../ir/build.js";
import { probeNodeRequireRefusal } from "../npm.js";

export interface InlineRequire {
  call: ts.CallExpression;
  spec: string;
  dep: ts.SourceFile;
}

/** A top-level `var m; m = require("./x")` binding. Node evaluates the
 * require at the assignment; the binding is alias plumbing exactly like
 * `const m = require("./x")` for every later read. */
export interface SplitRequireBinding {
  decl: ts.VariableDeclaration;
  assign: ts.BinaryExpression;
  call: ts.CallExpression;
  spec: string;
  dep: ts.SourceFile;
}

function symbolOfIdentifierValue(lowerer: Lowerer, ident: ts.Identifier): ts.Symbol | undefined {
  const parent = ident.parent;
  // A destructuring shorthand target resolves to the property symbol at
  // the name, but reads/writes the variable through its value symbol.
  if (ts.isShorthandPropertyAssignment(parent) && parent.name === ident) {
    return (
      lowerer.checker.getShorthandAssignmentValueSymbol(parent) ??
      lowerer.checker.getSymbolAtLocation(ident)
    );
  }
  return lowerer.checker.getSymbolAtLocation(ident);
}

function destructuringContainerOf(node: ts.Node): ts.Node | null {
  const parent = node.parent;
  if (ts.isShorthandPropertyAssignment(parent) && parent.name === node) return parent;
  if (ts.isPropertyAssignment(parent) && parent.initializer === node) return parent;
  if (ts.isSpreadElement(parent) && parent.expression === node) return parent;
  if (ts.isSpreadAssignment(parent) && parent.expression === node) return parent;
  return null;
}

function writeTargetOf(node: ts.Node): ts.Node | null {
  let target = node;
  for (;;) {
    const parent = target.parent;
    if (
      ts.isParenthesizedExpression(parent) ||
      ts.isArrayLiteralExpression(parent) ||
      ts.isObjectLiteralExpression(parent)
    ) {
      target = parent;
      continue;
    }
    const container = destructuringContainerOf(target);
    if (container === null) break;
    target = container;
  }
  const parent = target.parent;
  if (
    ts.isBinaryExpression(parent) &&
    parent.left === target &&
    ts.isAssignmentOperator(parent.operatorToken.kind)
  )
    return parent;
  if (
    (ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) &&
    parent.operand === target &&
    (parent.operator === ts.SyntaxKind.PlusPlusToken ||
      parent.operator === ts.SyntaxKind.MinusMinusToken)
  )
    return parent;
  if ((ts.isForInStatement(parent) || ts.isForOfStatement(parent)) && parent.initializer === target)
    return parent;
  return null;
}

/** The split form of a top-level require binding: `var m; m = require("./x")`.
 * Exactly one write, at a top-level `m = require("<literal>")` statement.
 * Null for the ordinary `const m = require("./x")` declaration and for
 * every form that needs runtime module selection. */
export function splitRequireBindingOf(
  lowerer: Lowerer,
  decl: ts.VariableDeclaration,
): SplitRequireBinding | null {
  // Cheap shape gate before the cache: ordinary declarations never enter the
  // per-Lowerer map.
  if (decl.initializer !== undefined || !ts.isIdentifier(decl.name)) return null;
  const list = decl.parent as ts.VariableDeclarationList;
  if ((list.flags & ts.NodeFlags.Const) !== 0) return null;
  const stmt = list.parent;
  if (!ts.isVariableStatement(stmt) || !ts.isSourceFile(stmt.parent)) return null;
  const cached = lowerer.cjsSplitRequireBindings.get(decl);
  if (cached !== undefined) return cached;
  const result = computeSplitRequireBinding(lowerer, decl);
  lowerer.cjsSplitRequireBindings.set(decl, result);
  return result;
}

function computeSplitRequireBinding(
  lowerer: Lowerer,
  decl: ts.VariableDeclaration,
): SplitRequireBinding | null {
  const sf = ts.getSourceFileOfNode(decl);
  if (!isCjsJsFile(sf, lowerer.program)) return null;
  if (!sf.text.includes("require")) return null;
  const symbol = lowerer.checker.getSymbolAtLocation(decl.name);
  if (symbol === undefined) return null;
  // Merged declarations make the binding's initialization order ambiguous;
  // keep ordinary storage instead of guessing.
  let declarations = 0;
  for (const other of symbol.declarations) {
    if (!ts.isVariableDeclaration(other) || ++declarations > 1) return null;
  }
  if (declarations !== 1) return null;

  // Find the one top-level `m = ...` statement first: most uninitialized
  // variables never reach that shape, so they avoid the full-file write scan.
  let assign: ts.BinaryExpression | null = null;
  for (const stmt of sf.statements.nodes) {
    if (!ts.isExpressionStatement(stmt)) continue;
    const expr = stmt.expression;
    if (
      !ts.isBinaryExpression(expr) ||
      expr.operatorToken.kind !== ts.SyntaxKind.EqualsToken ||
      !ts.isIdentifier(expr.left) ||
      expr.left.text !== decl.name.text ||
      lowerer.checker.getSymbolAtLocation(expr.left) !== symbol
    )
      continue;
    if (assign !== null) return null;
    assign = expr;
  }
  if (assign === null) return null;

  const req = inlineProgramRequireOf(lowerer, assign.right);
  if (req === null) return null;
  // Preflight treats the same bindings as require declarations (module edge,
  // cycle admission, early-read fence); a binding it does not know keeps
  // ordinary storage.
  if (splitRequireCallOf(lowerer.program, decl) !== req.call) return null;

  // Any other write makes the value depend on runtime control flow.
  let writes = 0;
  ts.walkPreorder(sf, (node) => {
    if (!ts.isIdentifier(node) || node.text !== decl.name.text) return;
    if (symbolOfIdentifierValue(lowerer, node) !== symbol) return;
    if (writeTargetOf(node) === null) return;
    if (++writes > 1) return "stop";
  });
  if (writes !== 1) return null;

  return { decl, assign, call: req.call, spec: req.spec, dep: req.dep };
}

/** The split binding an identifier names, or null. */
export function splitRequireBindingOfIdent(
  lowerer: Lowerer,
  ident: ts.Identifier,
): SplitRequireBinding | null {
  const symbol = symbolOfIdentifierValue(lowerer, ident);
  return symbol === undefined ? null : splitBindingOfSymbol(lowerer, symbol);
}

/** The exact top-level assignment statement that initializes `expr`, or null. */
export function splitRequireAssignmentOf(
  lowerer: Lowerer,
  expr: ts.Expression,
): SplitRequireBinding | null {
  if (
    !ts.isBinaryExpression(expr) ||
    expr.operatorToken.kind !== ts.SyntaxKind.EqualsToken ||
    !ts.isIdentifier(expr.left)
  )
    return null;
  const bindingOfIdent = splitRequireBindingOfIdent(lowerer, expr.left);
  return bindingOfIdent !== null && bindingOfIdent.assign === expr ? bindingOfIdent : null;
}

/** The whole-export symbol a module's `module.exports = <value>` names,
 * or null when the module is a table. */
export function wholeExportSymbolOfModule(lowerer: Lowerer, dep: ts.SourceFile): ts.Symbol | null {
  const cached = lowerer.cjsWholeExportSymbols.get(dep);
  if (cached !== undefined) return cached;
  if (cjsNamespaceModule(lowerer, dep)) {
    lowerer.cjsWholeExportSymbols.set(dep, null);
    return null;
  }
  const moduleSymbol = lowerer.checker.getSymbolAtLocation(dep);
  let symbol = moduleSymbol?.getExports()?.get("export=" as ts.__String);
  if (symbol === undefined) {
    lowerer.cjsWholeExportSymbols.set(dep, null);
    return null;
  }
  if (symbol.flags & ts.SymbolFlags.Alias) symbol = lowerer.checker.getAliasedSymbol(symbol);
  lowerer.cjsWholeExportSymbols.set(dep, symbol);
  return symbol;
}

function splitBindingOfSymbol(lowerer: Lowerer, symbol: ts.Symbol): SplitRequireBinding | null {
  const decl = symbol.declarations.find(ts.isVariableDeclaration);
  return decl === undefined ? null : splitRequireBindingOf(lowerer, decl);
}

/** The target whole-export symbol behind a split-binding symbol. */
function splitWholeExportSymbolOfSymbol(lowerer: Lowerer, symbol: ts.Symbol): ts.Symbol | null {
  const binding = splitBindingOfSymbol(lowerer, symbol);
  return binding === null ? null : wholeExportSymbolOfModule(lowerer, binding.dep);
}

/** True when a CommonJS module has a live member export (`exports.x` or
 * `module.exports.x`) after all `module.exports =` replacements. Those
 * members need a mutable whole-export root. */
export function cjsHasLiveMemberExports(lowerer: Lowerer, sf: ts.SourceFile): boolean {
  const cached = lowerer.cjsLiveMemberExports.get(sf);
  if (cached !== undefined) return cached;
  const stmts = sf.statements.nodes;
  let lastTable = -1;
  for (let i = 0; i < stmts.length; i++) {
    if (cjsExportAssignmentOf(stmts[i]!)?.kind === "table") lastTable = i;
  }
  let live = false;
  // Only members attached after the last replacement survive in Node.
  if (lastTable >= 0) {
    for (let i = lastTable + 1; i < stmts.length; i++) {
      const stmt = stmts[i]!;
      if (cjsExportAssignmentOf(stmt)?.kind === "member" && cjsExportDiscardReason(stmt) === null) {
        live = true;
        break;
      }
    }
  }
  lowerer.cjsLiveMemberExports.set(sf, live);
  return live;
}

/** The wrapper's export= symbol when a split binding is re-exported whole
 * (`module.exports = m`) and that assignment owns storage for later member
 * writes. Importers must read the wrapper's storage, not the split
 * binding's underlying value. */
function splitWholeExportStorageSymbolOf(lowerer: Lowerer, symbol: ts.Symbol): ts.Symbol | null {
  const binding = splitBindingOfSymbol(lowerer, symbol);
  if (binding === null) return null;
  if (wholeExportSymbolOfModule(lowerer, binding.dep) === null) return null;
  const sf = ts.getSourceFileOfNode(binding.decl);
  if (!cjsHasLiveMemberExports(lowerer, sf)) return null;
  const whole = cjsWholeExportValueOf(sf);
  if (whole === null) return null;
  let rhs: ts.Expression = whole.rhs;
  while (ts.isParenthesizedExpression(rhs)) rhs = rhs.expression;
  if (!ts.isIdentifier(rhs) || lowerer.checker.getSymbolAtLocation(rhs) !== symbol) return null;
  const moduleSymbol = lowerer.checker.getSymbolAtLocation(sf);
  let exportSymbol = moduleSymbol?.getExports()?.get("export=" as ts.__String);
  if (exportSymbol === undefined) return null;
  if (exportSymbol.flags & ts.SymbolFlags.Alias)
    exportSymbol = lowerer.checker.getAliasedSymbol(exportSymbol);
  return exportSymbol;
}

/** The source file whose `module.exports =` assignment declares `symbol`. */
function moduleExportSourceFileOf(symbol: ts.Symbol): ts.SourceFile | null {
  for (const decl of symbol.declarations) {
    if (
      ts.isBinaryExpression(decl) &&
      isModuleExportsAccess(decl.left) &&
      ts.isExpressionStatement(decl.parent) &&
      ts.isSourceFile(decl.parent.parent)
    )
      return decl.getSourceFile();
  }
  return null;
}

/** One hop from a wrapper's export= symbol to the value it re-exports
 * (`module.exports = require(...)` or `= <split binding>`), or null. A
 * wrapper with live members owns storage for them, so it is not followed. */
function wholeReexportTargetOf(lowerer: Lowerer, symbol: ts.Symbol): ts.Symbol | null {
  const sf = moduleExportSourceFileOf(symbol);
  if (sf === null) return null;
  // A wrapper with live members owns storage for them; importers must keep
  // reading that root rather than the inner value.
  if (cjsHasLiveMemberExports(lowerer, sf)) return null;
  const whole = cjsWholeExportValueOf(sf);
  if (whole === null) return null;
  const inner = inlineProgramRequireOf(lowerer, whole.rhs);
  if (inner !== null) return wholeExportSymbolOfModule(lowerer, inner.dep);
  let rhs: ts.Expression = whole.rhs;
  while (ts.isParenthesizedExpression(rhs)) rhs = rhs.expression;
  if (!ts.isIdentifier(rhs)) return null;
  const rhsSymbol = lowerer.checker.getSymbolAtLocation(rhs);
  return rhsSymbol === undefined ? null : splitWholeExportSymbolOfSymbol(lowerer, rhsSymbol);
}

/** Follow split bindings and whole re-exports to the ultimate value symbol. */
function followSplitWholeTarget(lowerer: Lowerer, candidate: ts.Symbol | null): ts.Symbol | null {
  if (candidate === null) return null;
  let symbol = candidate;
  const seen = new Set<ts.Symbol>();
  for (let depth = 0; depth < 32 && !seen.has(symbol); depth++) {
    seen.add(symbol);
    const next =
      splitWholeExportSymbolOfSymbol(lowerer, symbol) ?? wholeReexportTargetOf(lowerer, symbol);
    if (next === null) break;
    symbol = next;
  }
  return symbol;
}

/** The target whole-export symbol behind `module.exports = <split binding>`,
 * letting importers of that wrapper resolve to the real value symbol. */
export function splitWholeExportAliasTargetOf(
  lowerer: Lowerer,
  symbol: ts.Symbol,
): ts.Symbol | null {
  const storage = splitWholeExportStorageSymbolOf(lowerer, symbol);
  if (storage !== null) return followSplitWholeTarget(lowerer, storage);
  const direct = followSplitWholeTarget(lowerer, splitWholeExportSymbolOfSymbol(lowerer, symbol));
  if (direct !== null) return direct;
  return followSplitWholeTarget(lowerer, wholeReexportTargetOf(lowerer, symbol));
}

/** The first read of a split binding that code before its assignment can
 * reach, using the same reachability model as ordinary require bindings. */
export function splitRequireEarlyReadOf(
  lowerer: Lowerer,
  binding: SplitRequireBinding,
): ts.Identifier | null {
  const sf = ts.getSourceFileOfNode(binding.decl);
  const stmt = binding.assign.parent;
  // `binding` was recognized only from a top-level `m = require(...)`
  // statement, so the statement index is always present.
  const index = sf.statements.nodes.indexOf(stmt as ts.ExpressionStatement);
  return requireBindingEarlyUse7(lowerer.program, sf, index, binding.decl, []);
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
