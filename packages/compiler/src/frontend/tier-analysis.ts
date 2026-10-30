/* Tier assignment, report-only (two-tier design, stage S2).
 *
 * The design assigns every binding, field, function instance, class and
 * module a tier. Static is today's compiler; dynamic code operates on
 * dynamic values. Demotion from static to dynamic is monotone and is seeded
 * by `any`, untyped JavaScript, types and operations without a static
 * lowering, reflection a static layout cannot answer, and dynamic modules
 * (DESIGN.md §6).
 *
 * Stage S2 computes what WOULD be demoted without demoting anything:
 *
 * 1. Existing dynamic code. Functions whose bodies already use the `dyn`
 *    vocabulary are the dynamic tier today (ir/tiers.ts assigns them). The
 *    source statements whose lowering performs a dynamic operation are the
 *    coverage report's statementsDynamic.
 * 2. Demotion requests. Every refusal or runtime fence the lowerer commits
 *    (today's poison sites: the SC1xxx/SC2xxx families) and every refused
 *    import or package becomes a request, attributed to the unit whose
 *    static representation could not express the construct. The lowerer
 *    still refuses or fences exactly as before; the requests are recorded
 *    from the committed diagnostics, so speculative probes that roll back
 *    record nothing. Under `--tier=static-only` every request stays today's
 *    refusal; stage S6 turns requests into demotions in the default mode.
 * 3. Demoted units. A request demotes its unit, and the function instance
 *    containing the site turns dynamic (it would hold dynamic operations,
 *    invariant I1). Units are deduplicated; each keeps its requests, which
 *    is the chain `--explain-dynamic` prints.
 *
 * Attribution is syntactic and approximate: the site's innermost node, the
 * operand it acts on, and that operand's declaration. Stage S6 replaces it
 * with requests the failing lowering names exactly. */
import type {
  ScrDiagnostic,
  TypeFailureFamily,
  TypeFailureSlot,
} from "../diagnostics/diagnostic.js";
import { isWarningCode } from "../diagnostics/render.js";
import type { IrFunction, SrcLoc } from "../ir/ir.js";
import { dynamicOperationSites, type DynamicFunction } from "../ir/tiers.js";
import * as ts from "./ts7/adapter.js";

/** `--tier`: "auto" (the default) will demote; "static-only" keeps every
 * demotion request a refusal (design invariant I2). Identical in S2. */
export type TierMode = "auto" | "static-only";

export const TIER_MODES: readonly TierMode[] = ["auto", "static-only"];

export type DemotionUnitKind = "binding" | "field" | "function" | "class" | "module";

export interface DemotionUnit {
  kind: DemotionUnitKind;
  /** Display name: `x`, `Point.x`, `parse`, `Parser.next`, `Point`, or the
   * module's file path. */
  name: string;
  /** Bindings: the function declaring a local, absent for module scope. */
  owner?: string;
  /** The unit's declaration (the site itself when none is known). */
  loc: SrcLoc;
}

/** Why a unit is demoted (DESIGN.md §6.2): a type with no static
 * representation, an operation with no static lowering, reflection on a
 * class, a use of a binding whose declaration was refused, a module or
 * package that cannot be static, or a construct excluded by policy (no
 * demotion: it stays a refusal). */
export type DemotionSeed = "type" | "operation" | "reflection" | "cascade" | "module" | "excluded";

export type DemotionScope = "reached" | "deferred" | "unreached";

export interface DemotionRequest {
  unit: DemotionUnit;
  /** The function instance (or module top level) containing the site. */
  enclosing: DemotionUnit;
  seed: DemotionSeed;
  scope: DemotionScope;
  code: string;
  message: string;
  loc: SrcLoc;
}

export interface DemotedUnit extends DemotionUnit {
  /** Requests naming this unit directly. */
  requests: number;
  /** Requests whose sites this function instance or module contains. */
  sites: number;
}

export interface TierDynamicFunction extends DynamicFunction {
  /** Source statements with a dynamic operation in this function. */
  statements: number;
}

/** The localized-failure stage whose slot positions include a slot kind
 * (design §3.6): locals and globals degrade first, declarations next,
 * members of declared types with push-down, expression types last. */
export type LocalizedFailureStage = "L1" | "L2" | "L3" | "L4";

export function slotStage(slot: TypeFailureSlot): LocalizedFailureStage {
  switch (slot) {
    case "local":
    case "global":
    case "loop":
      return "L1";
    case "field":
    case "param":
    case "return":
      return "L2";
    case "member":
      return "L3";
    case "expression":
      return "L4";
  }
}

/** A committed type failure that would become a checked dynamic slot
 * (SC6104) instead of an error. */
export interface WouldBeSlot {
  loc: SrcLoc;
  slot: TypeFailureSlot;
  name: string;
  declaredType: string;
  family: TypeFailureFamily;
  code: string;
  message: string;
  stage: LocalizedFailureStage;
  /** The declaration the failure rejects today (a failure-group key), if
   * any: a class, a signature, or a declaration statement. */
  rejects: string | null;
  /** Other committed diagnostics that inherit from this slot's group and
   * clear once every group they inherit from degrades (with push-down and
   * expression slots, the full design). */
  cascade: number;
}

/** Localized failure, report-only (stage L0): what the committed errors
 * would become. Two scenarios: through stage L2 (declaration slots) and
 * through L4 (members and expressions too). */
export interface LocalizedFailureReport {
  /** Reached errors (warnings excluded). */
  errors: number;
  /** Type failures, by whether a checked dynamic slot keeps meaning. */
  typeFailures: { degradable: number; refused: number };
  slots: WouldBeSlot[];
  /** Diagnostics attributed to a rejected declaration they used. */
  cascades: number;
  /** Errors that disappear (degraded slots plus cleared cascades). */
  clearedThroughL2: number;
  clearedThroughL4: number;
  /** The errors that remain through L4, by code. */
  remainingByCode: Record<string, number>;
}

export interface TierReport {
  mode: TierMode;
  /** Localized failure (report-only). */
  localizedFailure: LocalizedFailureReport;
  /** Reached source statements that perform a dynamic operation. */
  statementsDynamic: number;
  dynamicFunctions: TierDynamicFunction[];
  requests: DemotionRequest[];
  /** Units the requests would demote (reached and deferred scopes),
   * deduplicated, by kind then source order. */
  units: DemotedUnit[];
}

/* ── statements of dynamic functions ─────────────────────────────────── */

function isClassLike(node: ts.Node): boolean {
  return ts.isClassDeclaration(node) || ts.isClassExpression(node);
}

/** The innermost node spanning exactly or containing [start, end). */
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

/** The source statement an IR location belongs to: the innermost
 * statement containing it, or an arrow function's expression body. Null
 * for synthetic locations. */
function statementAt(program: ts.Program, loc: SrcLoc): ts.Node | null {
  if (loc.start === 0 && loc.end === 0) return null;
  const sf = program.getSourceFile(loc.file);
  if (sf === undefined) return null;
  let node: ts.Node | undefined = nodeAt(sf, loc.start, loc.end);
  while (node !== undefined && !ts.isSourceFile(node)) {
    const parent: ts.Node | undefined = node.parent;
    if (parent !== undefined && ts.isArrowFunction(parent) && parent.body === node) return node;
    if (ts.isStatement(node) && !ts.isBlock(node)) return node;
    node = parent;
  }
  return null;
}

/** Dynamic statements are the source statements whose lowering performs a
 * dynamic operation (in the function itself or in a generated helper it
 * calls). They count once however many functions and operations they
 * involve. A function's tier is the unit of I1, but static operations
 * inside a dynamic function stay static, so the statement is the honest
 * measure of how much code is dynamic. */
function dynamicFunctionReports(
  program: ts.Program,
  bodies: readonly IrFunction[],
): { functions: TierDynamicFunction[]; statements: number } {
  const byLoc = new Map<string, ts.Node | null>();
  const all = new Set<ts.Node>();
  const functions: TierDynamicFunction[] = [];
  for (const fn of bodies) {
    const sites = dynamicOperationSites(fn);
    if (sites.length === 0) continue;
    const own = new Set<ts.Node>();
    for (const site of sites) {
      const key = `${site.loc.file}\0${site.loc.start}\0${site.loc.end}`;
      let statement = byLoc.get(key);
      if (statement === undefined) {
        statement = statementAt(program, site.loc);
        byLoc.set(key, statement);
      }
      if (statement === null) continue;
      own.add(statement);
      all.add(statement);
    }
    functions.push({
      name: fn.name,
      loc: fn.loc,
      operation: sites[0]!.operation,
      operationLoc: sites[0]!.loc,
      statements: own.size,
    });
  }
  return { functions, statements: all.size };
}

/* ── demotion requests ───────────────────────────────────────────────── */

const TYPE_CODES = new Set([
  "SC2001",
  "SC2002",
  "SC2003",
  "SC2005",
  "SC2006",
  "SC2007",
  "SC2008",
  "SC2009",
  "SC2011",
  "SC1063",
  "SC1100",
  "SC1101",
]);
const MODULE_CODES = new Set([
  "SC1010",
  "SC1012",
  "SC1013",
  "SC1014",
  "SC1015",
  "SC1016",
  "SC2013",
]);
/** Runtime code generation (`eval`, `new Function`): excluded by policy,
 * since the dynamic tier compiles ahead of time (DESIGN.md §12 class X). */
const EXCLUDED_CODES = new Set(["SC2010"]);
const EXCLUDED_SURFACE = /^'(?:new Function|Function|eval)'/;

/** Refusals and fences that name a static-tier gap. Type errors,
 * environment and target refusals, divergences and internal errors are
 * not demotion requests. */
export function isDemotionCode(code: string): boolean {
  return /^SC[12]\d{3}$/.test(code);
}

function isFunctionLikeOrFile(node: ts.Node): boolean {
  return (
    ts.isSourceFile(node) ||
    ts.isFunctionLikeDeclaration(node) ||
    ts.isClassStaticBlockDeclaration(node)
  );
}

function nameText(name: ts.Node | undefined): string | null {
  if (name === undefined) return null;
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) return name.text;
  if (ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return null;
}

function className(node: ts.Node | undefined): string {
  if (node === undefined) return "<anonymous class>";
  if ((ts.isClassDeclaration(node) || ts.isClassExpression(node)) && node.name !== undefined)
    return node.name.text;
  const parent = node.parent;
  if (parent !== undefined && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name))
    return parent.name.text;
  return "<anonymous class>";
}

/** The display name of a function-like node, as a user would look it up. */
function functionName(node: ts.Node): string {
  if (ts.isSourceFile(node)) return "<module top level>";
  if (ts.isClassStaticBlockDeclaration(node)) return `${className(node.parent)}.<static block>`;
  if (ts.isConstructorDeclaration(node)) return `${className(node.parent)}.constructor`;
  const own = ts.isFunctionLikeDeclaration(node) ? nameText(node.name) : null;
  const parent = node.parent;
  if (parent !== undefined && isClassLike(parent) && own !== null)
    return `${className(parent)}.${own}`;
  if (own !== null) return own;
  if (parent !== undefined) {
    if (ts.isVariableDeclaration(parent) || ts.isPropertyAssignment(parent)) {
      const bound = nameText(parent.name);
      if (bound !== null) return bound;
    }
    if (
      ts.isPropertyDeclaration(parent) &&
      parent.parent !== undefined &&
      isClassLike(parent.parent)
    ) {
      const field = nameText(parent.name);
      if (field !== null) return `${className(parent.parent)}.${field}`;
    }
    if (ts.isBinaryExpression(parent) && parent.right === node) {
      const left = parent.left;
      if (ts.isIdentifier(left)) return left.text;
      if (ts.isPropertyAccessExpression(left)) return ts.getTextOfNode(left);
    }
  }
  const sf = ts.getSourceFileOfNode(node);
  const pos = ts.getLineAndCharacterOfPosition(sf, ts.tokenStartOfNode(node));
  return `<anonymous ${pos.line + 1}:${pos.character + 1}>`;
}

function locOfNode(node: ts.Node): SrcLoc {
  const sf = ts.getSourceFileOfNode(node);
  return { file: sf.fileName, start: ts.tokenStartOfNode(node), end: node.end };
}

function enclosingFunction(node: ts.Node): ts.Node {
  let current: ts.Node | undefined = node.parent;
  while (current !== undefined && !isFunctionLikeOrFile(current)) current = current.parent;
  return current ?? ts.getSourceFileOfNode(node);
}

function functionUnit(node: ts.Node, instance: string | null): DemotionUnit {
  // Top-level code runs in the module's initializer function.
  if (ts.isSourceFile(node))
    return {
      kind: "function",
      name: "<top level>",
      loc: { file: node.fileName, start: 0, end: 0 },
    };
  const name = functionName(node);
  return {
    kind: "function",
    name: instance === null ? name : `${name} ${instance}`,
    loc: locOfNode(node),
  };
}

/** Generic instances append their instantiation context to diagnostics
 * (Lowerer.pushDiag: ` (instantiating 'f' with <T>)`); the instance, not
 * the source function, is the unit. Returns the type-argument text. */
function instanceOf(message: string): string | null {
  const at = message.lastIndexOf(" (instantiating ");
  if (at < 0 || !message.endsWith(")")) return null;
  const context = message.slice(at + 2, -1);
  const withAt = context.indexOf(" with ");
  return withAt < 0 ? context : context.slice(withAt + 6);
}

/** Strip wrappers and walk receivers down to the value an operation acts
 * on: `a.b.c(…)` → `a`, `(x as T)[k]` → `x`. Records whether the chain
 * passes through `.prototype`. */
function rootOf(expr: ts.Node): { root: ts.Node; viaPrototype: boolean } {
  let node = expr;
  let viaPrototype = false;
  for (;;) {
    if (
      ts.isParenthesizedExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isNonNullExpression(node) ||
      ts.isAssertionExpression(node) ||
      ts.isSatisfiesExpression(node) ||
      ts.isSpreadElement(node) ||
      ts.isAwaitExpression(node)
    ) {
      node = node.expression!;
    } else if (ts.isPropertyAccessExpression(node)) {
      if (node.name.text === "prototype") viaPrototype = true;
      node = node.expression;
    } else if (ts.isElementAccessExpression(node) || ts.isCallExpression(node)) {
      node = node.expression;
    } else if (
      ts.isDeleteExpression(node) ||
      ts.isTypeOfExpression(node) ||
      ts.isVoidExpression(node)
    ) {
      node = node.expression;
    } else {
      return { root: node, viaPrototype };
    }
  }
}

const REFLECTION_NAMESPACES = new Set(["Object", "Reflect"]);

/** The expression an operation at `node` acts on. Reflection calls
 * (`Object.defineProperty(x, …)`, `Reflect.set(x, …)`) act on their first
 * argument; `new C()` and `x instanceof C` on the class value. */
function subjectOf(node: ts.Node): ts.Node {
  let current = node;
  // A refused callee or member name: the whole call or access is the site.
  const parent = current.parent;
  if (parent !== undefined && ts.isPropertyAccessExpression(parent) && parent.name === current)
    current = parent;
  if (ts.isCallExpression(current)) {
    const callee = current.expression;
    if (
      ts.isPropertyAccessExpression(callee) &&
      ts.isIdentifier(callee.expression) &&
      REFLECTION_NAMESPACES.has(callee.expression.text) &&
      current.arguments.nodes.length > 0
    ) {
      return current.arguments.nodes[0]!;
    }
    return callee;
  }
  if (ts.isNewExpression(current)) return current.expression;
  if (ts.isBinaryExpression(current)) {
    if (current.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword) return current.right;
    if (current.operatorToken.kind === ts.SyntaxKind.EqualsToken) return current.left;
  }
  return current;
}

/** The declaration owning a type-refused node: the binding, parameter,
 * field or function whose declared type has no static representation. */
function typeOwnerOf(node: ts.Node): ts.Node | null {
  let current: ts.Node | undefined = node;
  while (current !== undefined && !ts.isSourceFile(current)) {
    if (
      ts.isVariableDeclaration(current) ||
      ts.isParameter(current) ||
      ts.isBindingElement(current) ||
      ts.isPropertyDeclaration(current) ||
      ts.isPropertySignature(current) ||
      ts.isCatchClause(current)
    ) {
      return current;
    }
    if (ts.isFunctionLikeDeclaration(current) || isClassLike(current)) return current;
    if (ts.isStatement(current)) return null;
    current = current.parent;
  }
  return null;
}

function isModuleObjectName(node: ts.Node): boolean {
  return ts.isIdentifier(node) && (node.text === "exports" || node.text === "module");
}

class UnitResolver {
  constructor(private readonly checker: ts.TypeChecker) {}

  /** The unit a declaration node denotes. */
  declarationUnit(decl: ts.Node): DemotionUnit | null {
    if (isClassLike(decl)) return { kind: "class", name: className(decl), loc: locOfNode(decl) };
    if (ts.isFunctionLikeDeclaration(decl)) return functionUnit(decl, null);
    if (ts.isPropertyDeclaration(decl) || ts.isPropertySignature(decl)) {
      const field = nameText(decl.name) ?? "<computed>";
      const owner = decl.parent;
      const ownerName = owner !== undefined && isClassLike(owner) ? className(owner) : null;
      return {
        kind: ownerName === null ? "binding" : "field",
        name: ownerName === null ? field : `${ownerName}.${field}`,
        loc: locOfNode(decl),
      };
    }
    if (ts.isCatchClause(decl)) {
      const binding = decl.variableDeclaration;
      if (binding === undefined) return null;
      return this.declarationUnit(binding);
    }
    if (ts.isVariableDeclaration(decl) || ts.isParameter(decl) || ts.isBindingElement(decl)) {
      const name =
        nameText(decl.name) ??
        (decl.name === undefined ? undefined : ts.getTextOfNode(decl.name)) ??
        "<binding>";
      const scope = enclosingFunction(decl);
      const unit: DemotionUnit = { kind: "binding", name, loc: locOfNode(decl) };
      if (ts.isParameter(decl) && ts.isFunctionLikeDeclaration(decl.parent))
        unit.owner = functionName(decl.parent);
      else if (!ts.isSourceFile(scope)) unit.owner = functionName(scope);
      return unit;
    }
    return null;
  }

  /** The unit an operand expression denotes. */
  valueUnit(expr: ts.Node): { unit: DemotionUnit; reflection: boolean } | null {
    const { root, viaPrototype } = rootOf(expr);
    const sf = ts.getSourceFileOfNode(root);
    if (root.kind === ts.SyntaxKind.ThisKeyword) {
      const owner = enclosingFunction(root);
      if (ts.isSourceFile(owner))
        return {
          unit: { kind: "module", name: sf.fileName, loc: locOfNode(sf) },
          reflection: false,
        };
      const cls = owner.parent;
      if (cls !== undefined && isClassLike(cls)) {
        // `this.f` names a field; `this` itself is the instance.
        const access = root.parent;
        if (
          access !== undefined &&
          ts.isPropertyAccessExpression(access) &&
          access.expression === root
        ) {
          return {
            unit: {
              kind: "field",
              name: `${className(cls)}.${access.name.text}`,
              loc: locOfNode(access),
            },
            reflection: false,
          };
        }
        return {
          unit: { kind: "class", name: className(cls), loc: locOfNode(cls) },
          reflection: viaPrototype,
        };
      }
      return null;
    }
    if (!ts.isIdentifier(root)) return null;
    let symbol = this.checker.getSymbolAtLocation(root);
    if (symbol !== undefined && (symbol.flags & ts.SymbolFlags.Alias) !== 0)
      symbol = this.checker.getAliasedSymbol(symbol);
    const decls = symbol === undefined ? [] : symbol.declarations;
    const decl = decls.find((d) => !ts.getSourceFileOfNode(d).isDeclarationFile);
    if (decl === undefined) {
      // CommonJS `exports`/`module` as values: the module object.
      if (isModuleObjectName(root))
        return {
          unit: { kind: "module", name: sf.fileName, loc: locOfNode(sf) },
          reflection: false,
        };
      return null;
    }
    if (ts.isSourceFile(decl))
      return {
        unit: { kind: "module", name: decl.fileName, loc: locOfNode(decl) },
        reflection: false,
      };
    const unit = this.declarationUnit(decl);
    if (unit === null) return null;
    // `C.prototype.m = …`, `Object.defineProperty(C.prototype, …)`: the
    // class (or the constructor function's prototype object).
    if (viaPrototype && (unit.kind === "class" || unit.kind === "function"))
      return { unit: { ...unit, kind: "class" }, reflection: true };
    return { unit, reflection: unit.kind === "class" };
  }
}

function seedOf(code: string, message: string): DemotionSeed {
  if (EXCLUDED_CODES.has(code) || EXCLUDED_SURFACE.test(message)) return "excluded";
  if (code === "SC2004") return "cascade";
  if (MODULE_CODES.has(code)) return "module";
  if (TYPE_CODES.has(code)) return "type";
  return "operation";
}

/** One request for a committed refusal or fence diagnostic. */
function requestFor(
  program: ts.Program,
  resolver: UnitResolver,
  diag: ScrDiagnostic,
  scope: DemotionScope,
): DemotionRequest | null {
  if (!isDemotionCode(diag.code)) return null;
  let seed = seedOf(diag.code, diag.message);
  const base = { code: diag.code, message: diag.message, loc: diag.loc, scope };
  const sf = program.getSourceFile(diag.loc.file);
  if (sf === undefined) {
    const unit: DemotionUnit = { kind: "module", name: diag.loc.file, loc: diag.loc };
    return { ...base, unit, enclosing: unit, seed };
  }
  const moduleUnit: DemotionUnit = { kind: "module", name: sf.fileName, loc: locOfNode(sf) };
  const node = nodeAt(sf, diag.loc.start, diag.loc.end);
  const instance = instanceOf(diag.message);
  const owner = ts.isSourceFile(node) ? sf : enclosingFunction(node);
  const enclosing = functionUnit(owner, instance);
  if (seed === "module" || ts.isSourceFile(node))
    return { ...base, unit: moduleUnit, enclosing, seed };
  let unit: DemotionUnit | null = null;
  if (seed === "type") {
    const decl = typeOwnerOf(node);
    if (decl !== null) unit = resolver.declarationUnit(decl);
  }
  if (unit === null) {
    const value = resolver.valueUnit(subjectOf(node));
    if (value !== null) {
      unit = value.unit;
      if (value.reflection && seed === "operation") seed = "reflection";
    }
  }
  return { ...base, unit: unit ?? enclosing, enclosing, seed };
}

function unitKey(unit: DemotionUnit): string {
  return `${unit.kind}\0${unit.name}\0${unit.owner ?? ""}\0${unit.loc.file}\0${unit.loc.start}`;
}

const KIND_ORDER: readonly DemotionUnitKind[] = ["module", "class", "field", "function", "binding"];

function demotedUnits(requests: readonly DemotionRequest[]): DemotedUnit[] {
  const units = new Map<string, DemotedUnit>();
  const entry = (unit: DemotionUnit): DemotedUnit => {
    const key = unitKey(unit);
    let found = units.get(key);
    if (found === undefined) units.set(key, (found = { ...unit, requests: 0, sites: 0 }));
    return found;
  };
  for (const request of requests) {
    if (request.scope === "unreached" || request.seed === "excluded") continue;
    entry(request.unit).requests++;
    entry(request.enclosing).sites++;
  }
  return [...units.values()].sort(
    (a, b) =>
      KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) ||
      a.loc.file.localeCompare(b.loc.file) ||
      a.loc.start - b.loc.start ||
      a.name.localeCompare(b.name),
  );
}

/* ── localized failure ───────────────────────────────────────────────── */

/** A diagnostic's failure-group bookkeeping (lowerer: badType, deferred
 * flushes, blocked statements) turned into the would-be report. A group
 * (a rejected declaration or blocked statement) clears in a scenario when
 * each of its diagnostics either degrades (a degradable type failure at a
 * slot the scenario covers) or is a cascade whose every cause clears. */
export function localizedFailureReport(reached: readonly ScrDiagnostic[]): LocalizedFailureReport {
  const errors = reached.filter((d) => !isWarningCode(d.code));
  const groups = new Map<string, ScrDiagnostic[]>();
  for (const d of errors) {
    if (d.rejects === undefined) continue;
    const list = groups.get(d.rejects);
    if (list === undefined) groups.set(d.rejects, [d]);
    else list.push(d);
  }
  const stages: Record<"L2" | "L4", ReadonlySet<LocalizedFailureStage>> = {
    L2: new Set(["L1", "L2"]),
    L4: new Set(["L1", "L2", "L3", "L4"]),
  };
  const clears = (scenario: "L2" | "L4") => {
    const covered = stages[scenario];
    const memo = new Map<string, boolean>();
    const degrades = (d: ScrDiagnostic): boolean =>
      d.typeFailure !== undefined &&
      d.typeFailure.degradable &&
      covered.has(slotStage(d.typeFailure.slot));
    const causeClears = (d: ScrDiagnostic): boolean =>
      d.cause !== undefined && d.cause.length > 0 && d.cause.every((g) => groupClears(g));
    const groupClears = (group: string): boolean => {
      const known = memo.get(group);
      if (known !== undefined) return known;
      memo.set(group, false); // a cycle never clears
      const members = groups.get(group) ?? [];
      const ok = members.length > 0 && members.every((d) => degrades(d) || causeClears(d));
      memo.set(group, ok);
      return ok;
    };
    return { degrades, causeClears, groupClears };
  };
  const l2 = clears("L2");
  const l4 = clears("L4");
  const cleared = (c: ReturnType<typeof clears>, d: ScrDiagnostic) =>
    c.degrades(d) || c.causeClears(d);
  // Each slot's cascade: diagnostics whose causes (transitively) include
  // the slot's group and that clear in the full scenario.
  const reachesGroup = (d: ScrDiagnostic, group: string, seen: Set<string>): boolean => {
    for (const g of d.cause ?? []) {
      if (g === group) return true;
      if (seen.has(g)) continue;
      seen.add(g);
      for (const m of groups.get(g) ?? []) if (reachesGroup(m, group, seen)) return true;
    }
    return false;
  };
  const slots: WouldBeSlot[] = [];
  let degradable = 0;
  let refused = 0;
  for (const d of errors) {
    const f = d.typeFailure;
    if (f === undefined) continue;
    if (!f.degradable) {
      refused++;
      continue;
    }
    degradable++;
    const group = d.rejects ?? null;
    let cascade = 0;
    if (group !== null)
      for (const e of errors)
        if (
          e !== d &&
          e.typeFailure === undefined &&
          cleared(l4, e) &&
          reachesGroup(e, group, new Set())
        )
          cascade++;
    slots.push({
      loc: d.loc,
      slot: f.slot,
      name: f.name,
      declaredType: f.declaredType,
      family: f.family,
      code: d.code,
      message: d.message,
      stage: slotStage(f.slot),
      rejects: group,
      cascade,
    });
  }
  slots.sort(
    (a, b) =>
      b.cascade - a.cascade || a.loc.file.localeCompare(b.loc.file) || a.loc.start - b.loc.start,
  );
  const remainingByCode: Record<string, number> = {};
  let clearedThroughL2 = 0;
  let clearedThroughL4 = 0;
  for (const d of errors) {
    if (cleared(l2, d)) clearedThroughL2++;
    if (cleared(l4, d)) clearedThroughL4++;
    else remainingByCode[d.code] = (remainingByCode[d.code] ?? 0) + 1;
  }
  return {
    errors: errors.length,
    typeFailures: { degradable, refused },
    slots,
    cascades: errors.filter((d) => d.cause !== undefined && d.typeFailure === undefined).length,
    clearedThroughL2,
    clearedThroughL4,
    remainingByCode,
  };
}

export interface TierAnalysisInput {
  mode: TierMode;
  /** The dynamic-tier IR functions of the reached program. */
  dynamicFunctions: readonly IrFunction[];
  reached: readonly ScrDiagnostic[];
  deferred: readonly ScrDiagnostic[];
  unreached: readonly ScrDiagnostic[];
}

/** Coverage's statementsDynamic (see dynamicFunctionReports). */
export function dynamicStatementCount(
  program: ts.Program,
  dynamicFunctions: readonly IrFunction[],
): number {
  return dynamicFunctionReports(program, dynamicFunctions).statements;
}

export function analyzeTiers(program: ts.Program, input: TierAnalysisInput): TierReport {
  const resolver = new UnitResolver(program.getTypeChecker());
  const requests: DemotionRequest[] = [];
  const add = (diags: readonly ScrDiagnostic[], scope: DemotionScope): void => {
    for (const diag of diags) {
      let request: DemotionRequest | null;
      try {
        request = requestFor(program, resolver, diag, scope);
      } catch {
        // Attribution is best effort; a report never fails an analysis.
        if (!isDemotionCode(diag.code)) continue;
        const unit: DemotionUnit = { kind: "module", name: diag.loc.file, loc: diag.loc };
        request = {
          unit,
          enclosing: unit,
          seed: seedOf(diag.code, diag.message),
          scope,
          code: diag.code,
          message: diag.message,
          loc: diag.loc,
        };
      }
      if (request !== null) requests.push(request);
    }
  };
  add(input.reached, "reached");
  add(input.deferred, "deferred");
  add(input.unreached, "unreached");
  const dynamic = dynamicFunctionReports(program, input.dynamicFunctions);
  return {
    mode: input.mode,
    localizedFailure: localizedFailureReport(input.reached),
    statementsDynamic: dynamic.statements,
    dynamicFunctions: dynamic.functions,
    requests,
    units: demotedUnits(requests),
  };
}
