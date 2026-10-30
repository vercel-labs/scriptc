/* Hot dynamic-tier functions (SC6101, diagnostics/dynamic-tier.ts): the
 * functions of a program that compile to the dynamic tier (ir/tiers.ts) and
 * likely run often, so a build can name them. Without a profile, a function
 * counts as likely hot when a dynamic operation runs on every iteration of
 * one of its loops, when a loop calls it, or when it calls itself. Dynamic code that
 * runs once (setup code that reads an `any` configuration, for example)
 * stays quiet.
 *
 * The tier assignment is the one lowering made (Lowerer.dynamicFunctions);
 * this module ranks its functions and says why each one is dynamic, from
 * the source at its dynamic operations. A function is named only when the
 * source says why (an `any`, an untyped `JSON.parse` result, an untyped
 * JavaScript file): functions dynamic for operations without a static
 * lowering would stay dynamic with more types. */
import { relative } from "node:path";
import type { ScrDiagnostic } from "../../diagnostics/diagnostic.js";
import {
  dynamicTierDiag,
  type DynamicTierPackageCount,
  type HotReason,
  type UntypedCause,
} from "../../diagnostics/dynamic-tier.js";
import type { IrExpr, IrFunction, IrModule, IrStmt, SrcLoc } from "../../ir/ir.js";
import {
  dynamicOperationOf,
  dynamicOperationSites,
  type DynamicOperationSite,
} from "../../ir/tiers.js";
import { everyExprChild, everyStmtChild } from "../../ir/traverse.js";
import * as ts from "../ts7/adapter.js";
import { isCheckedJsSourceFile, isJsSourceFile } from "../program.js";
import { isNodeModulesPath } from "../resolve.js";
import type { DynamicSlot, Lowerer } from "./lowerer.js";

export interface HotDynamicFunction {
  /** The IR function name (`%Point.norm`, `parse`, ...). */
  name: string;
  loc: SrcLoc;
  hot: HotReason;
  /** Dynamic operations inside the function's loops. */
  loopOperations: number;
  cause: UntypedCause;
}

export interface DynamicTierReport {
  /** Likely-hot dynamic functions in the program's own files, most likely
   * hot first. */
  hot: HotDynamicFunction[];
  /** Dynamic-tier functions in npm packages, by package. */
  packages: DynamicTierPackageCount[];
}

interface FunctionFacts {
  /** Dynamic operations in the parts of the function's loops that run on
   * every iteration. */
  loopSites: DynamicOperationSite[];
  /** Callee names of direct calls, and whether each runs on every
   * iteration of a loop. */
  calls: { callee: string; inLoop: boolean }[];
}

/** Walks a function body by structure: a loop's condition, update and body
 * repeat, while a `for` loop's initializer and a `for...of` loop's iterable
 * run once. (Locations cannot tell them apart: lowering may give a loop's
 * repeated parts the whole statement's span.) */
function factsOf(fn: IrFunction): FunctionFacts {
  const facts: FunctionFacts = { loopSites: [], calls: [] };
  const expr = (e: IrExpr, inLoop: boolean): void => {
    if (inLoop) {
      const operation = dynamicOperationOf(e);
      if (operation !== null) facts.loopSites.push({ operation, loc: e.loc });
    }
    if (e.kind === "call") facts.calls.push({ callee: e.callee, inLoop });
    everyExprChild(
      e,
      (child) => {
        expr(child, inLoop);
        return true;
      },
      (child) => {
        stmt(child, inLoop);
        return true;
      },
    );
  };
  const children = (s: IrStmt, inLoop: boolean): void => {
    everyStmtChild(
      s,
      (child) => {
        expr(child, inLoop);
        return true;
      },
      (child) => {
        stmt(child, inLoop);
        return true;
      },
    );
  };
  const stmt = (s: IrStmt, inLoop: boolean): void => {
    switch (s.kind) {
      case "for":
        if (s.init !== null) stmt(s.init, inLoop);
        if (s.cond !== null) expr(s.cond, true);
        if (s.update !== null) stmt(s.update, true);
        for (const b of s.body) stmt(b, true);
        return;
      case "forOf":
        expr(s.iterable, inLoop);
        for (const b of s.body) stmt(b, true);
        return;
      case "while":
      case "doWhile":
        children(s, true);
        return;
      default:
        children(s, inLoop);
    }
  };
  for (const s of fn.body) stmt(s, false);
  return facts;
}

/** The package directory name of a node_modules path (`@scope/name` or `name`). */
function packageOf(file: string): string {
  const parts = file.split("/");
  const at = parts.lastIndexOf("node_modules");
  const first = parts[at + 1] ?? "";
  return first.startsWith("@") ? `${first}/${parts[at + 2] ?? ""}` : first;
}

/** The innermost node spanning [start, end). */
function nodeAt(sf: ts.SourceFile, start: number, end: number): ts.Node {
  let node: ts.Node = sf;
  for (;;) {
    let next: ts.Node | undefined;
    ts.forEachChild(node, (child) => {
      if (ts.tokenStartOfNode(child) <= start && end <= child.end) {
        next = child;
        return true;
      }
      return undefined;
    });
    if (next === undefined) return node;
    node = next;
  }
}

/** The identifier an operand reads through (`items` in `items[i].x`). */
function rootIdentifier(node: ts.Node): ts.Identifier | null {
  let n: ts.Node = node;
  for (;;) {
    if (ts.isIdentifier(n)) return n;
    if (
      ts.isPropertyAccessExpression(n) ||
      ts.isElementAccessExpression(n) ||
      ts.isCallExpression(n)
    )
      n = n.expression;
    else if (ts.isParenthesizedExpression(n) || ts.isNonNullExpression(n)) n = n.expression;
    else return null;
  }
}

function isJsonParse(node: ts.Node | undefined): boolean {
  if (node === undefined || !ts.isCallExpression(node)) return false;
  const callee = node.expression;
  return (
    ts.isPropertyAccessExpression(callee) &&
    ts.isIdentifier(callee.expression) &&
    callee.expression.text === "JSON" &&
    callee.name.text === "parse"
  );
}

/** Bindings that hold a value: variables, parameters and properties (not
 * types, classes or functions, whose names an operand may also mention). */
const VALUE_BINDING =
  ts.SymbolFlags.FunctionScopedVariable |
  ts.SymbolFlags.BlockScopedVariable |
  ts.SymbolFlags.Property;

/** Why an identifier holds a value without a static type, or null. */
function identifierCause(lowerer: Lowerer, id: ts.Identifier, depth = 0): UntypedCause | null {
  let symbol = lowerer.checker.getSymbolAtLocation(id);
  if (symbol !== undefined && (symbol.flags & ts.SymbolFlags.Alias) !== 0)
    symbol = lowerer.checker.getAliasedSymbol(symbol);
  if (symbol === undefined || (symbol.flags & VALUE_BINDING) === 0) return null;
  const decl = symbol.declarations?.[0];
  // An unannotated `for (const item of items)` variable: name `items`.
  if (
    depth < 4 &&
    decl !== undefined &&
    ts.isVariableDeclaration(decl) &&
    decl.type === undefined &&
    ts.isVariableDeclarationList(decl.parent) &&
    ts.isForOfStatement(decl.parent.parent)
  ) {
    const iterated = rootIdentifier(decl.parent.parent.expression);
    if (iterated !== null) {
      const cause = identifierCause(lowerer, iterated, depth + 1);
      if (cause !== null) return cause;
    }
  }
  if (decl !== undefined && ts.isVariableDeclaration(decl) && isJsonParse(decl.initializer))
    return { kind: "json-binding", name: id.text };
  const type = lowerer.checker.getTypeAtLocation(id);
  if ((type.flags & ts.TypeFlags.Any) !== 0) return { kind: "any", name: id.text };
  return null;
}

/** A dynamic slot (localized failure): the node's declared type degraded
 * to the checked dynamic, wholly or in pieces. Null while nothing degraded. */
function slotCause(lowerer: Lowerer, n: ts.Node): UntypedCause | null {
  if (lowerer.degradedTypes.size === 0) return null;
  if (!ts.isIdentifier(n) && !ts.isPropertyAccessExpression(n)) return null;
  // The declared type of the binding or property, not its narrowed flow
  // type (narrowing makes new checker types).
  let symbol = lowerer.checker.getSymbolAtLocation(ts.isIdentifier(n) ? n : n.name);
  if (symbol !== undefined && (symbol.flags & ts.SymbolFlags.Alias) !== 0)
    symbol = lowerer.checker.getAliasedSymbol(symbol);
  const type =
    symbol !== undefined && (symbol.flags & VALUE_BINDING) !== 0
      ? lowerer.checker.getTypeOfSymbol(symbol)
      : lowerer.checker.getTypeAtLocation(n);
  const id = (type as { id?: number }).id ?? -1;
  // A whole degraded type, or a dynamic piece of a pushed-down one. A type
  // that is also a slot of its own belongs to that slot, not to a container
  // it is a piece of.
  const owner = lowerer.degradedTypes.has(id) ? undefined : lowerer.lenientPieces.get(id);
  if (!lowerer.degradedTypes.has(id) && owner === undefined) return null;
  const text = ts.getTextOfNode(n);
  const declaredType = lowerer.checker.typeToString(type);
  return {
    kind: "slot",
    name: text.length > 40 ? `${text.slice(0, 37)}...` : text,
    declaredType,
    ...(owner !== undefined && owner !== declaredType ? { owner } : {}),
  };
}

/** Why a node's value has no static type, or null. */
function nodeCause(lowerer: Lowerer, n: ts.Node): UntypedCause | null {
  if (isJsonParse(n)) return { kind: "json" };
  const slot = slotCause(lowerer, n);
  if (slot !== null) return slot;
  const id = rootIdentifier(n);
  return id === null ? null : identifierCause(lowerer, id);
}

/** Why the dynamic operation at `loc` has no static type, or null when
 * the source does not say. The site's own subexpressions are asked first
 * (the operand of a dynamic `for...of`), then its ancestors. */
function causeAt(lowerer: Lowerer, loc: SrcLoc): UntypedCause | null {
  return causeSiteAt(lowerer, loc)?.cause ?? null;
}

/** causeAt, with the node that names the cause (none for an untyped
 * JavaScript file). */
function causeSiteAt(
  lowerer: Lowerer,
  loc: SrcLoc,
): { cause: UntypedCause; node?: ts.Node } | null {
  const sf = lowerer.program.getSourceFile(loc.file);
  if (sf === undefined) return null;
  if (isJsSourceFile(sf) && !isCheckedJsSourceFile(sf, lowerer.projectCheckJs))
    return { cause: { kind: "javascript" } };
  const node = nodeAt(sf, loc.start, loc.end);
  let found: { cause: UntypedCause; node: ts.Node } | null = null;
  const ask = (n: ts.Node): void => {
    const cause = nodeCause(lowerer, n);
    if (cause !== null) found = { cause, node: n };
  };
  const descend = (n: ts.Node, depth: number): void => {
    if (found !== null || depth > 3) return;
    ask(n);
    if (found === null)
      ts.forEachChild(n, (child) => (descend(child, depth + 1), found !== null || undefined));
  };
  descend(node, 0);
  for (
    let n: ts.Node | undefined = node.parent;
    found === null && n !== undefined && n !== sf;
    n = n.parent
  )
    ask(n);
  return found;
}

/** The first cause the function's dynamic operations name, loop sites
 * first, or null when none names one. */
function causeOf(lowerer: Lowerer, sites: readonly { loc: SrcLoc }[]): UntypedCause | null {
  for (const site of sites) {
    const cause = causeAt(lowerer, site.loc);
    if (cause !== null) return cause;
  }
  return null;
}

/** Generated functions (see scanDynamicTier), after any module prefix. */
const GENERATED = /^%*(?:m\d+\.)?%*(?:dyn|caught|init)\./;

/** Generated helpers that repeat their callers' locations: `%dyn.*` and
 * `%caught.*`, but not a module's top level (`%init.*`). */
const HELPERS = /^%*(?:m\d+\.)?%*(?:dyn|caught)\./;

/** The likely-hot dynamic-tier functions of `module` (see the header). */
export function scanDynamicTier(lowerer: Lowerer, module: IrModule): DynamicTierReport {
  const facts = new Map<string, FunctionFacts>();
  for (const fn of module.functions) facts.set(fn.name, factsOf(fn));
  // Functions some loop calls directly.
  const calledInLoop = new Set<string>();
  for (const fn of module.functions) {
    const f = facts.get(fn.name)!;
    for (const call of f.calls) if (call.inLoop) calledInLoop.add(call.callee);
  }
  const hot: HotDynamicFunction[] = [];
  const packages = new Map<string, number>();
  for (const fn of module.functions) {
    // Generated `%dyn.*` helpers are dynamic operations lowered out of line,
    // `%caught.*` helpers test caught values, and `%init.*` is a module's top
    // level: none is a function to name.
    if (fn.tier !== "dynamic" || GENERATED.test(fn.name)) continue;
    if (isNodeModulesPath(fn.loc.file)) {
      const name = packageOf(fn.loc.file);
      packages.set(name, (packages.get(name) ?? 0) + 1);
      continue;
    }
    const f = facts.get(fn.name)!;
    const sites = dynamicOperationSites(fn);
    const inLoops = f.loopSites;
    const recursive = f.calls.some((c) => c.callee === fn.name);
    const reason: HotReason | null =
      inLoops.length > 0
        ? "loop"
        : calledInLoop.has(fn.name)
          ? "called-in-loop"
          : recursive
            ? "recursive"
            : null;
    if (reason === null) continue;
    // Only functions the source makes dynamic are named: ones dynamic for
    // operations without a static lowering would stay dynamic with more types.
    const looped = new Set(inLoops.map((s) => `${s.loc.file}:${s.loc.start}:${s.loc.end}`));
    const rest = sites.filter((s) => !looped.has(`${s.loc.file}:${s.loc.start}:${s.loc.end}`));
    const cause = causeOf(lowerer, [...inLoops, ...rest]);
    if (cause === null) continue;
    hot.push({
      name: fn.name,
      loc: fn.loc,
      hot: reason,
      loopOperations: inLoops.length,
      cause,
    });
  }
  const rank = { loop: 0, "called-in-loop": 1, recursive: 2 } as const;
  // Functions that rank alike list in source order: by the file's place in
  // the module order, then by position.
  const fileOrder = new Map(lowerer.moduleOrder.map((sf, index) => [sf.fileName, index]));
  const fileRank = (file: string): number => fileOrder.get(file) ?? lowerer.moduleOrder.length;
  hot.sort(
    (a, b) =>
      rank[a.hot] - rank[b.hot] ||
      b.loopOperations - a.loopOperations ||
      fileRank(a.loc.file) - fileRank(b.loc.file) ||
      (a.loc.file < b.loc.file ? -1 : a.loc.file > b.loc.file ? 1 : 0) ||
      a.loc.start - b.loc.start,
  );
  return {
    hot,
    packages: [...packages]
      .map(([name, functions]) => ({ name, functions }))
      .sort((a, b) => b.functions - a.functions || (a.name < b.name ? -1 : 1)),
  };
}

/** The name the source binds a function expression to (`totals` in
 * `const totals = (rows) => ...`), or null. */
function boundName(lowerer: Lowerer, loc: SrcLoc): string | null {
  const sf = lowerer.program.getSourceFile(loc.file);
  if (sf === undefined) return null;
  const parent = nodeAt(sf, loc.start, loc.end).parent;
  if (
    parent !== undefined &&
    (ts.isVariableDeclaration(parent) ||
      ts.isPropertyAssignment(parent) ||
      ts.isPropertyDeclaration(parent)) &&
    ts.isIdentifier(parent.name)
  )
    return parent.name.text;
  return null;
}

/** A function's name as the source spells it, without a module prefix
 * (`%%m144.Session.finish` → `Session.finish`, `m163.find` → `find`). A
 * function expression (`%fn.<hash>`, with `_<name>` when the expression is
 * named) takes its own name, else the name it is bound to, else
 * `anonymous function`. */
function displayName(lowerer: Lowerer, f: HotDynamicFunction): string {
  const plain = f.name
    .replace(/^%+/, "")
    .replace(/^m\d+\./, "")
    .replace(/^%+/, "");
  const lambda = /^fn\.[0-9a-f]+(?:_(.+))?$/.exec(plain);
  if (lambda === null) return plain;
  return lambda[1] ?? boundName(lowerer, f.loc) ?? "anonymous function";
}

/** SC6101 for the program lowering produced, or null (see the header).
 * Paths are relative to `root`, the entry's directory. */
export function dynamicTierWarning(
  lowerer: Lowerer,
  module: IrModule,
  root: string,
): ScrDiagnostic | null {
  const report = scanDynamicTier(lowerer, module);
  const first = report.hot[0];
  if (first === undefined) return null;
  const where = (loc: SrcLoc): string => {
    const sf = lowerer.program.getSourceFile(loc.file);
    const line = sf === undefined ? 0 : ts.getLineAndCharacterOfPosition(sf, loc.start).line + 1;
    return `${relative(root, loc.file) || loc.file}:${line}`;
  };
  return dynamicTierDiag(
    report.hot.map((f) => ({
      name: displayName(lowerer, f),
      where: where(f.loc),
      cause: f.cause,
      hot: f.hot,
    })),
    report.packages,
    first.loc,
  );
}

/** Localized failure: dynamic operations attributed to each dynamic slot
 * of `slots` (by index), over the dynamic-tier functions of the program. A
 * site counts for the slot the SC6101 cause search names at it: the slot
 * declared by the binding the site reads (for a dynamic piece, the binding
 * its access starts from), or else the one slot of the declared type. */
export function dynamicSlotOperationCounts(
  lowerer: Lowerer,
  bodies: readonly IrFunction[],
  slots: readonly DynamicSlot[],
): number[] {
  const counts = slots.map(() => 0);
  if (lowerer.degradedTypes.size === 0) return counts;
  for (const fn of bodies) {
    // Generated helpers repeat their callers' locations; top-level code
    // (`%init.*`) counts like any function.
    if (HELPERS.test(fn.name)) continue;
    for (const site of dynamicOperationSites(fn)) {
      const found = causeSiteAt(lowerer, site.loc);
      if (found?.cause.kind !== "slot" || found.node === undefined) continue;
      const declaredType = found.cause.owner ?? found.cause.declaredType;
      const index = slotOfSite(lowerer, slots, found.node, declaredType, found.cause.owner);
      if (index >= 0) counts[index]!++;
    }
  }
  return counts;
}

/** The index in `slots` of the slot a dynamic operation on `node` (an
 * identifier or property access the cause search named) belongs to, or -1
 * when the declared type is not one slot's and no declaration says. */
function slotOfSite(
  lowerer: Lowerer,
  slots: readonly DynamicSlot[],
  node: ts.Node,
  declaredType: string,
  owner: string | undefined,
): number {
  const candidates: number[] = [];
  slots.forEach((slot, i) => {
    if (slot.failure.declaredType === declaredType) candidates.push(i);
  });
  if (candidates.length <= 1) return candidates[0] ?? -1;
  // The binding: the identifier or property itself for a whole slot, the
  // root of the access for a piece of a container.
  const named =
    owner !== undefined
      ? rootIdentifier(node)
      : ts.isPropertyAccessExpression(node)
        ? node.name
        : node;
  if (named === null) return -1;
  let symbol = lowerer.checker.getSymbolAtLocation(named);
  if (symbol !== undefined && (symbol.flags & ts.SymbolFlags.Alias) !== 0)
    symbol = lowerer.checker.getAliasedSymbol(symbol);
  for (const decl of symbol?.declarations ?? []) {
    const file = ts.getSourceFileOfNode(decl).fileName;
    const start = ts.tokenStartOfNode(decl);
    const index = candidates.find((i) => {
      const loc = slots[i]!.loc;
      return loc.file === file && loc.start >= start && loc.start < decl.end;
    });
    if (index !== undefined) return index;
  }
  return -1;
}
