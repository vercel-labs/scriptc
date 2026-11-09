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
  requireBindingEarlyUse7,
  requireSpecOf,
  splitRequireCallOf,
} from "../program.js";
import { createRequireCalleeFileOf } from "./builtins/module-bindings.js";
import { isCjsRequireGlobal } from "./lower-node-module.js";
import {
  BOOL,
  DYN,
  type IrExpr,
  type IrGlobal,
  type IrStmt,
  type IrType,
  type SrcLoc,
} from "../../ir/ir.js";
import { npmStaticAccessorExport } from "../npm-static.js";
import { keyedHelperName } from "./stable-names.js";
import { nodeThrowExpr } from "../../ir/build.js";
import { probeNodeRequireRefusal } from "../npm.js";
import { cjsAccessorCall } from "./lower-exprs.js";
import { isWriteTarget } from "./binding-analysis.js";
import { isCjsExportsIdentifier, isCjsModuleExports } from "./cjs-exports-object.js";
import { resolveCjsRuntime } from "../cjs-resolve.js";
import { isRelativeSpecifier } from "../workspace-registry.js";
import { lowerIslandRequireCall } from "./lower-node-island.js";

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
  if (!ts.sourceTextIncludes(sf, "require")) return null;
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

/** The target whole-export symbol behind a split-binding symbol. When the
 * target's value lives in a snapshot global (an exported binding the module
 * reassigns before the export), the binding reads that storage: the alias
 * chase would land on the live binding and answer a later value than Node's
 * requirer sees. */
function splitWholeExportSymbolOfSymbol(lowerer: Lowerer, symbol: ts.Symbol): ts.Symbol | null {
  const binding = splitBindingOfSymbol(lowerer, symbol);
  if (binding === null) return null;
  return (
    lowerer.wholeExportStorageSymbolOf(binding.dep) ??
    wholeExportSymbolOfModule(lowerer, binding.dep)
  );
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
    lowerer.facts.importedModule(sf, spec, "require") ??
    lowerer.facts.npmStaticModule(sf, spec, "require");
  if (!dep || dep.isDeclarationFile || dep.fileName.endsWith(".json")) return null;
  return { call: e, spec, dep };
}

/** Where the program evaluates the export of the CommonJS module `dep`:
 * Node reads `module.exports` at every `require()` call that names it, and
 * once for all of its ES-module imports together. */
export interface CjsExportEvaluations {
  /** `require()` calls naming the module at the top level of a module. */
  requires: number;
  /** A `require()` call that can run more than once (inside a function or
   * a loop), or two of them in one module. */
  repeats: boolean;
  /** An ES-module import, export-from or `import()` names the module. */
  imported: boolean;
}

export function cjsExportEvaluations(lowerer: Lowerer, dep: ts.SourceFile): CjsExportEvaluations {
  const found: CjsExportEvaluations = { requires: 0, repeats: false, imported: false };
  const names = (from: ts.SourceFile, spec: string, kind: "import" | "require"): boolean =>
    (lowerer.facts.importedModule(from, spec, kind) ??
      lowerer.facts.npmStaticModule(from, spec, kind)) === dep;
  for (const sf of lowerer.program.getSourceFiles()) {
    if (sf.isDeclarationFile) continue;
    let here = 0;
    ts.walkPreorder(sf, (node) => {
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier !== undefined &&
        ts.isStringLiteral(node.moduleSpecifier)
      ) {
        if (names(sf, node.moduleSpecifier.text, "import")) found.imported = true;
        return undefined;
      }
      if (!ts.isCallExpression(node)) return undefined;
      const argument = node.arguments.nodes[0];
      if (
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        argument !== undefined &&
        ts.isStringLiteralLike(argument)
      ) {
        if (names(sf, argument.text, "import")) found.imported = true;
        return undefined;
      }
      const spec = requireSpecOf(node);
      if (spec === null || !names(sf, spec, "require")) return undefined;
      for (let p: ts.Node | undefined = node.parent; p !== undefined; p = p.parent)
        if (
          ts.isFunctionLike(p) ||
          ts.isForStatement(p) ||
          ts.isForOfStatement(p) ||
          ts.isForInStatement(p) ||
          ts.isWhileStatement(p) ||
          ts.isDoStatement(p)
        )
          found.repeats = true;
      here += 1;
      found.requires += 1;
      return undefined;
    });
    if (here > 1) found.repeats = true;
  }
  return found;
}

/** Whether the lowering gives every evaluation of an accessor-exporting
 * module's export (npm-static-cjs-exports-accessor.ts) the value Node
 * gives it: `require()` calls that each run once and sit in different
 * modules (each keeps a value of its own, accessorRequirerSlot), or
 * ES-module imports alone (Node reads the export once for all of them). */
export function accessorExportIsExact(evaluations: CjsExportEvaluations): boolean {
  return !evaluations.repeats && (!evaluations.imported || evaluations.requires === 0);
}

/** The storage of what `require()` of the accessor-exporting module `dep`
 * answered in the module `from`: Node runs the getter for every
 * `require()`, so each requiring module holds a value of its own. Null for
 * any other pair, and for a module the program only imports (its importers
 * share the one read Node makes). */
export function accessorRequirerSlot(
  lowerer: Lowerer,
  from: ts.SourceFile,
  dep: ts.SourceFile,
): IrGlobal | null {
  if (from === dep || !npmStaticAccessorExport(dep.fileName)) return null;
  const slots = lowerer.accessorRequirerSlots;
  const key = `${from.fileName}\0${dep.fileName}`;
  const known = slots.get(key);
  if (known !== undefined) return known;
  const whole = cjsWholeExportValueOf(dep);
  const exported = whole === null ? undefined : lowerer.globalsByDeclNode.get(whole.assign);
  const evaluations = cjsExportEvaluations(lowerer, dep);
  let slot: IrGlobal | null = null;
  if (exported !== undefined && accessorExportIsExact(evaluations) && !evaluations.imported) {
    const id = keyedHelperName(lowerer, "%g.%required", key);
    slot = lowerer.globalsList.find((g) => g.id === id) ?? null;
    if (slot === null) {
      slot = { id, name: id.slice(3), type: exported.type, mutable: true };
      lowerer.globalsList.push(slot);
    }
  }
  slots.set(key, slot);
  return slot;
}

/** The statements that give the module `from` its own value of the
 * accessor-exporting module `dep` at a `require()`: the value the module's
 * load stored for its first requirer, and one more call of the getter for
 * every later one. Empty when the pair has no slot. */
export function accessorRequirerAssign(
  lowerer: Lowerer,
  from: ts.SourceFile,
  dep: ts.SourceFile,
  loc: SrcLoc,
): IrStmt[] {
  const slot = accessorRequirerSlot(lowerer, from, dep);
  const whole = cjsWholeExportValueOf(dep);
  const exported = whole === null ? undefined : lowerer.globalsByDeclNode.get(whole.assign);
  if (slot === null || whole === null || exported === undefined) return [];
  // The respelled export is the loader's decision over calls of the getter
  // (exportReads): whichever way it goes, its value is one call of the
  // getter, and the branch a falsy read takes is that call alone.
  let call: ts.Expression = whole.rhs;
  while (
    ts.isParenthesizedExpression(call) ||
    ts.isConditionalExpression(call) ||
    (ts.isBinaryExpression(call) && call.operatorToken.kind === ts.SyntaxKind.CommaToken)
  )
    call = ts.isParenthesizedExpression(call)
      ? call.expression
      : ts.isConditionalExpression(call)
        ? call.whenFalse
        : call.right;
  const takenId = keyedHelperName(lowerer, "%g.%requiredOnce", dep.fileName);
  if (!lowerer.globalsList.some((g) => g.id === takenId))
    lowerer.globalsList.push({ id: takenId, name: takenId.slice(3), type: BOOL, mutable: true });
  const again = lowerer.coerceInto(call, lowerer.lowerExpr(call), slot.type);
  return [
    {
      kind: "if",
      cond: { kind: "varRef", localId: takenId, type: BOOL, loc },
      then: [{ kind: "assign", localId: slot.id, value: again, loc }],
      else_: [
        {
          kind: "assign",
          localId: takenId,
          value: { kind: "boolLit", value: true, type: BOOL, loc },
          loc,
        },
        {
          kind: "assign",
          localId: slot.id,
          value: { kind: "varRef", localId: exported.id, type: exported.type, loc },
          loc,
        },
      ],
      loc,
    },
  ];
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

/** The first `module.exports = <value>` of a CommonJS module that is not a
 * top-level statement: inside a function (a UMD wrapper's body) or in an arm
 * of a condition. The value is chosen when the module runs, so the module's
 * static export table does not hold it, and the statement itself is refused
 * where it would run (lowerExprStatement). Null when the module has none. */
export function cjsNestedExportReplacementOf(sf: ts.SourceFile): ts.BinaryExpression | null {
  let found: ts.BinaryExpression | null = null;
  for (const stmt of sf.statements.nodes) {
    const top = cjsExportAssignmentOf(stmt)?.expr ?? null;
    ts.walkPreorder(stmt, (node) => {
      if (
        node !== top &&
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        isModuleExportsAccess(node.left)
      ) {
        found = node;
        return "stop";
      }
      return undefined;
    });
    if (found !== null) break;
  }
  return found;
}

/** The table behind pure CommonJS re-exports (inline, initialized, or split
 * require bindings). Member reads use the original table's symbols, while
 * each require still initializes its own wrapper at its source position. */
export function cjsNamespaceTargetOf(lowerer: Lowerer, dep: ts.SourceFile): ts.SourceFile | null {
  const cached = lowerer.cjsNamespaceTargets.get(dep);
  if (cached !== undefined) return cached;
  // A pure forwarding cycle has no terminal table. Mark this module before
  // following its edge so revisiting it terminates the search.
  lowerer.cjsNamespaceTargets.set(dep, null);
  const whole = cjsWholeExportValueOf(dep);
  if (whole === null) {
    lowerer.cjsNamespaceTargets.set(dep, dep);
    return dep;
  }
  if (cjsHasLiveMemberExports(lowerer, dep)) return null;
  let inner: InlineRequire | null = inlineProgramRequireOf(lowerer, whole.rhs);
  if (inner === null && ts.isIdentifier(whole.rhs)) {
    const symbol = lowerer.checker.getSymbolAtLocation(whole.rhs);
    const decl = symbol?.declarations.find(ts.isVariableDeclaration);
    if (decl !== undefined) {
      inner =
        splitRequireBindingOf(lowerer, decl) ??
        (decl.initializer !== undefined &&
        (ts.getCombinedNodeFlags(decl) & ts.NodeFlags.Const) !== 0
          ? inlineProgramRequireOf(lowerer, decl.initializer)
          : null);
    }
  }
  const target = inner === null ? null : cjsNamespaceTargetOf(lowerer, inner.dep);
  lowerer.cjsNamespaceTargets.set(dep, target);
  return target;
}

/** True when `dep`'s exports resolve to a static table. */
export function cjsNamespaceModule(lowerer: Lowerer, dep: ts.SourceFile): boolean {
  return cjsNamespaceTargetOf(lowerer, dep) !== null;
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
  /** The module whose `require()` names `dep`: the reader's, or the module
   * a re-export chain passed through. */
  from: ts.SourceFile = ts.getSourceFileOfNode(blame),
): IrExpr | null {
  const whole = cjsWholeExportValueOf(dep);
  if (whole === null || depth > 32) return null;
  // An accessor-exporting module answers every requiring module a value of
  // its own (accessorRequirerSlot).
  {
    const own = accessorRequirerSlot(lowerer, from, dep);
    if (own !== null) return { kind: "varRef", localId: own.id, type: own.type, loc: locOf(blame) };
  }
  const inner = inlineProgramRequireOf(lowerer, whole.rhs);
  if (inner !== null) return wholeExportValue(lowerer, inner.dep, blame, depth + 1, dep);
  if (ts.isIdentifier(whole.rhs)) {
    // A source binding that is REASSIGNED in its module stores its VALUE in
    // the snapshot global keyed by this statement (collectGlobals): Node's
    // export keeps that storage, so requiring the module answers the
    // snapshot, not the later binding value the identifier resolves to.
    const slot = lowerer.globalsByDeclNode.get(whole.assign);
    if (slot !== undefined)
      return { kind: "varRef", localId: slot.id, type: slot.type, loc: locOf(blame) };
    // An identifier that is itself a required-module binding
    // (`var $gOPD = require("./gOPD"); module.exports = $gOPD`)
    // re-exports that module's whole-export value — its own binding is
    // alias plumbing with no storage to read.
    const rebound = wholeExportValueOfModuleBinding(lowerer, whole.rhs, depth + 1);
    if (rebound !== null) return rebound;
    // A split require binding (`var m; m = require("./y")`) re-exports the
    // module it names; the value is that module's whole export.
    const split = splitRequireBindingOfIdent(lowerer, whole.rhs);
    if (split !== null && wholeExportSymbolOfModule(lowerer, split.dep) !== null)
      return wholeExportValue(lowerer, split.dep, blame, depth + 1, dep);
    // Otherwise the identifier names a declaration of the exporting module
    // (or a builtin global): reading it IS the export, exactly what
    // requirer bindings alias to.
    return lowerer.lowerExpr(whole.rhs);
  }
  if (ts.isClassExpression(whole.rhs)) {
    return lowerer.classValueRef(lowerer.lowerClassExpressionInfo(whole.rhs), blame);
  }
  // Every other value shape stores its snapshot on the export assignment
  // itself (collectGlobals' export slot). The declaration spelling
  // (`var x = module.exports = <value>`) registers that same slot: `x` is
  // an ordinary binding initialized with the value, and REASSIGNING it
  // leaves module.exports untouched, as in Node.
  const g = lowerer.globalsByDeclNode.get(whole.assign);
  if (g === undefined) return null;
  return { kind: "varRef", localId: g.id, type: g.type, loc: locOf(blame) };
}

/** True when wholeExportValue would answer a value for `dep` — the
 * side-effect-free shape test used where lowering the value would be
 * premature (binding classification, property-symbol resolution). */
export function hasWholeExportValue(lowerer: Lowerer, dep: ts.SourceFile, depth = 0): boolean {
  const whole = cjsWholeExportValueOf(dep);
  if (whole === null || depth > 32) return false;
  const inner = inlineProgramRequireOf(lowerer, whole.rhs);
  if (inner !== null) return hasWholeExportValue(lowerer, inner.dep, depth + 1);
  if (ts.isIdentifier(whole.rhs) || ts.isClassExpression(whole.rhs)) return true;
  return lowerer.globalsByDeclNode.has(whole.assign);
}

/** The represented whole-export value behind a plain module binding
 * (`const m = require("./x")`, `import d from "./x.cjs"`, a
 * createRequire binding) of a single-value module: Node's require
 * answers module.exports, so the binding IS that value. Null for table
 * modules, for split bindings (`var m; m = require("./x")` — their own
 * path owns the read), and for exports with no represented value. */
export function wholeExportValueOfModuleBinding(
  lowerer: Lowerer,
  expr: ts.Identifier,
  depth = 0,
): IrExpr | null {
  if (depth > 32) return null;
  if (splitRequireBindingOfIdent(lowerer, expr) !== null) return null;
  const dep = lowerer.cjsModuleBindingDepOf(expr);
  if (dep === null || cjsNamespaceModule(lowerer, dep)) return null;
  if (!hasWholeExportValue(lowerer, dep)) return null;
  return wholeExportValue(lowerer, dep, expr, depth);
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

/** A `require()` of a relative specifier that names no module: Node's
 * catchable MODULE_NOT_FOUND, thrown where the call sits. The module graph
 * is fixed at build time, so a file that Node's CommonJS resolution does not
 * find then (the exact file, its `.js`, `.json` and `.node` spellings, a
 * directory's `main` or index) can never load, and the compiled call is
 * Node's throw, as it already is for a package nothing installed resolves.
 * Null when the program resolves the specifier or Node would find a file:
 * those keep their own lowering or refusal. `node` is the call or the
 * statement that holds it. */
export function unresolvedRequireThrow(
  lowerer: Lowerer,
  node: ts.Node,
  spec: string,
  type: IrType,
): IrExpr | null {
  if (!isRelativeSpecifier(spec)) return null;
  const sf = ts.getSourceFileOfNode(node);
  if (!isCjsJsFile(sf, lowerer.program)) return null;
  if (
    lowerer.facts.importedModule(sf, spec, "require") ??
    lowerer.facts.npmStaticModule(sf, spec, "require")
  )
    return null;
  const resolved = resolveCjsRuntime(sf.fileName, spec);
  if (resolved.ok || resolved.error.code !== "MODULE_NOT_FOUND") return null;
  return nodeThrowExpr(0, "MODULE_NOT_FOUND", resolved.error.message, type, locOf(node));
}

/** A `require(...)` call of the CommonJS global in a CommonJS file that no
 * other lowering claimed (not a builtin, JSON document, program module or
 * createRequire binding): a package nothing installed resolves, or a
 * relative path that names no file, throws Node's catchable
 * MODULE_NOT_FOUND at the call, and every other form is refused by name
 * instead of as an unlowerable `require` value. */
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
  const missing = unresolvedRequireThrow(lowerer, call, spec, DYN);
  if (missing !== null) return missing;
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

/** The rest elements of a top-level `const { a, ...rest } = require("./x")`
 * declaration over a program-module table (preflight admits exactly these):
 * Node copies the module's remaining own enumerable exports into a fresh
 * object at the require, which lower-stmts.ts materializes from the table's
 * statically known members. */
export function requireRestElementsOf(decl: ts.VariableDeclaration): ts.BindingElement[] {
  if (!ts.isObjectBindingPattern(decl.name) || decl.initializer === undefined) return [];
  const spec = requireSpecOf(decl.initializer);
  if (spec === null || canonicalBuiltinModule(spec) !== null) return [];
  if (!isJsSourceFile(ts.getSourceFileOfNode(decl))) return [];
  return decl.name.elements.nodes.filter(
    (e): e is ts.BindingElement =>
      e.name !== undefined && ts.isIdentifier(e.name) && e.dotDotDotToken !== undefined,
  );
}

/** The runtime own enumerable export names of a CommonJS table module, in
 * Node's insertion order — the object's own key order, which is what
 * `{ a, ...rest } = require("./m")` copies. Follows `module.exports =
 * require("./y")` re-exports. Null when the exports object's keys are not
 * statically known (computed keys, spreads, non-literal table values). */
export function cjsTableExportNamesInOrder(
  lowerer: Lowerer,
  dep: ts.SourceFile,
  depth = 0,
): string[] | null {
  return cjsTableExportNamesOf(
    dep,
    depth,
    (expr) => inlineProgramRequireOf(lowerer, expr)?.dep ?? null,
  );
}

/** The lowerer-free core of cjsTableExportNamesInOrder: `reExportDepOf`
 * names the program module a `module.exports = require("<spec>")` value
 * re-exports, or null when that value is not such a re-export. */
export function cjsTableExportNamesOf(
  dep: ts.SourceFile,
  depth: number,
  reExportDepOf: (expr: ts.Expression) => ts.SourceFile | null,
): string[] | null {
  if (depth > 32) return null;
  const stmts = dep.statements.nodes;
  let lastTable = -1;
  for (let i = 0; i < stmts.length; i++) {
    const cjs = cjsExportAssignmentOf(stmts[i]!);
    if (cjs?.kind === "table" && cjsExportDiscardReason(stmts[i]!) === null) lastTable = i;
  }
  const names: string[] = [];
  const seen = new Set<string>();
  const add = (name: string): void => {
    if (seen.has(name)) return;
    seen.add(name);
    names.push(name);
  };
  if (lastTable >= 0) {
    const table = cjsExportAssignmentOf(stmts[lastTable]!);
    if (table?.kind !== "table") return null;
    let rhs = table.expr.right;
    while (ts.isParenthesizedExpression(rhs)) rhs = rhs.expression;
    const inner = reExportDepOf(rhs);
    if (inner !== null) {
      // A re-export: the export object IS the inner module's, so its own
      // keys come first, and this module's member writes after the
      // assignment append to that same object. A `module.exports.f =`
      // write lands on the assigned object; an `exports.f =` write only
      // when the assignment rebinds `exports`, which the discard test
      // below enforces (Node drops the others).
      const innerNames = cjsTableExportNamesOf(inner, depth + 1, reExportDepOf);
      if (innerNames === null) return null;
      for (const name of innerNames) add(name);
    } else {
      const lit = table.obj ?? cjsExportTargetLiteral(rhs, dep);
      if (lit === null) return null;
      for (const prop of lit.properties.nodes) {
        if (ts.isSpreadAssignment(prop)) return null;
        const nameNode = prop.name;
        if (nameNode === undefined || ts.isComputedPropertyName(nameNode)) return null;
        if (!(ts.isIdentifier(nameNode) || ts.isStringLiteralLike(nameNode))) return null;
        // `__proto__: value` sets the prototype; it is not an own key.
        if (nameNode.text === "__proto__" && !ts.isShorthandPropertyAssignment(prop)) continue;
        add(nameNode.text);
      }
    }
    for (let i = lastTable + 1; i < stmts.length; i++) {
      const member = cjsExportAssignmentOf(stmts[i]!);
      if (member?.kind !== "member" || cjsExportDiscardReason(stmts[i]!) !== null) continue;
      if (!ts.isIdentifier(member.name)) return null;
      add(member.name.text);
    }
    return names;
  }
  // Member exports only (`exports.a = …`): the original exports object's
  // own keys, in assignment order.
  for (const stmt of stmts) {
    const member = cjsExportAssignmentOf(stmt);
    if (member === null || cjsExportDiscardReason(stmt) !== null) continue;
    if (member.kind !== "member" || !ts.isIdentifier(member.name)) return null;
    add(member.name.text);
  }
  return names;
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

function cjsNamedBindingOf(
  lowerer: Lowerer,
  element: ts.BindingElement,
): { name: ts.Identifier; key: string } | null {
  if (
    element.initializer !== undefined ||
    element.dotDotDotToken !== undefined ||
    element.name === undefined ||
    !ts.isIdentifier(element.name)
  )
    return null;
  const property = element.propertyName ?? element.name;
  const key = ts.isComputedPropertyName(property)
    ? lowerer.foldedStringKeyOf(property.expression)
    : ts.isIdentifier(property) || ts.isStringLiteral(property)
      ? property.text
      : ts.isNumericLiteral(property)
        ? String(Number(property.text))
        : null;
  return key === null ? null : { name: element.name, key };
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
    const binding = cjsNamedBindingOf(lowerer, e);
    if (binding === null) return null;
    elements.push(binding);
  }
  return { dep, elements };
}

type MemberWrite = ts.PropertyAccessExpression | ts.ElementAccessExpression;

function memberWritesByName(lowerer: Lowerer): Map<string, MemberWrite[]> {
  if (lowerer.cjsMemberWritesByName !== null) return lowerer.cjsMemberWritesByName;
  const writes = new Map<string, MemberWrite[]>();
  const visit = (node: ts.Node): void => {
    const key = ts.isPropertyAccessExpression(node)
      ? node.name.text
      : ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)
        ? node.argumentExpression.text
        : null;
    if (key !== null && isWriteTarget(node as MemberWrite)) {
      const sites = writes.get(key);
      if (sites === undefined) writes.set(key, [node as MemberWrite]);
      else sites.push(node as MemberWrite);
    }
    ts.forEachChild(node, visit);
  };
  for (const sf of lowerer.fileTag.keys()) if (!sf.isDeclarationFile) visit(sf);
  lowerer.cjsMemberWritesByName = writes;
  return writes;
}

/** Whether a write can run after its module's initialization returned:
 * from another module, a callable body, or an instance field initializer. */
function writeRunsAfterInit(write: ts.Node, exporter: ts.SourceFile): boolean {
  if (ts.getSourceFileOfNode(write) !== exporter) return true;
  for (let parent = write.parent; parent && !ts.isSourceFile(parent); parent = parent.parent) {
    if (ts.isFunctionLike(parent)) return true;
    if (
      ts.isPropertyDeclaration(parent) &&
      !ts.getModifiers(parent)?.some((m) => m.kind === ts.SyntaxKind.StaticKeyword)
    )
      return true;
  }
  return false;
}

/** Whether a CommonJS data export can change after its module initialized,
 * so bindings that copy it must not alias its storage. */
export function cjsExportChangesAfterInit(lowerer: Lowerer, symbol: ts.Symbol): boolean {
  const cached = lowerer.cjsLateWrittenExports.get(symbol);
  if (cached !== undefined) return cached;
  const exporter = symbol.declarations[0] && ts.getSourceFileOfNode(symbol.declarations[0]);
  const changes =
    exporter !== undefined &&
    (memberWritesByName(lowerer).get(ts.symbolName(symbol)) ?? []).some(
      (write) => writeRunsAfterInit(write, exporter) && writesExport(lowerer, write, symbol),
    );
  lowerer.cjsLateWrittenExports.set(symbol, changes);
  return changes;
}

function writesExport(lowerer: Lowerer, write: MemberWrite, symbol: ts.Symbol): boolean {
  let target = lowerer.checker.getSymbolAtLocation(
    ts.isPropertyAccessExpression(write) ? write.name : write.argumentExpression,
  );
  if (
    target === undefined &&
    (isCjsModuleExports(lowerer, write.expression) ||
      isCjsExportsIdentifier(lowerer, write.expression))
  )
    target = lowerer.cjsModuleExportSymbol(ts.getSourceFileOfNode(write), ts.symbolName(symbol));
  if (target !== undefined && target.flags & ts.SymbolFlags.Alias)
    target = lowerer.checker.getAliasedSymbol(target);
  return target === symbol;
}

/** Require destructuring needs storage for getters and data exports that
 * may change after the module initializes. Stable exports remain aliases. */
export function cjsRequireSnapshotBindingsOf(
  lowerer: Lowerer,
  decl: ts.VariableDeclaration,
): {
  dep: ts.SourceFile;
  bindings: Map<ts.BindingElement, { name: ts.Identifier; key: string }>;
} | null {
  if (!ts.isObjectBindingPattern(decl.name) || decl.initializer === undefined) return null;
  const dep = lowerer.cjsModuleRefDepOf(decl.initializer);
  if (dep === null) return null;
  const bindings = new Map<ts.BindingElement, { name: ts.Identifier; key: string }>();
  for (const element of decl.name.elements.nodes) {
    const binding = cjsNamedBindingOf(lowerer, element);
    if (binding === null) continue;
    let symbol = lowerer.cjsModuleExportSymbol(dep, binding.key);
    if (symbol !== undefined && symbol.flags & ts.SymbolFlags.Alias)
      symbol = lowerer.checker.getAliasedSymbol(symbol);
    if (
      symbol !== undefined &&
      (symbol.declarations.some(ts.isGetAccessorDeclaration) ||
        cjsExportChangesAfterInit(lowerer, symbol))
    )
      bindings.set(element, binding);
  }
  return bindings.size === 0 ? null : { dep, bindings };
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
    if (ts.isGetAccessorDeclaration(d)) return cjsAccessorCall(lowerer, d, locOf(blame));
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
