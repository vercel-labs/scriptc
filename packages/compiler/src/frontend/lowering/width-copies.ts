/* Width copies: the conversions that build a second object where
 * JavaScript has one.
 *
 * A value converted to another record, array or class layout is copied
 * (width-lift.ts). Node keeps one object, so a write through either name
 * that the other should see is lost, and an identity comparison of the two
 * answers false. The lowering is the only place that knows where it copied,
 * so the facts come from the lowered program itself: every call of a copy
 * helper in the final function list is one conversion. Nothing here reads
 * the syntax tree.
 *
 * A conversion is a finding only when it can change what the program does:
 *
 * - the converted value is ALIASABLE: something else can still reach the
 *   object it copies. A literal, a spread, or another copy has no other
 *   reference, so copying it is not observable;
 * - the program OBSERVES one of the two layouts in a way a copy changes:
 *   it writes a field or element of either, compares values of the copy's
 *   type by identity, or lets either reach code this scan cannot follow.
 *   The observation is a fact about the whole program, not about one
 *   binding, so no flow of the copy can escape it.
 *
 * A program with an aliasable copy and no observation of its layouts
 * behaves as it does under Node; every other aliasable copy is reported
 * (SC6001). Programs without copy helpers skip the scan. */
import type { IrExpr, IrFunction, IrLibFn, IrStmt, IrType, SrcLoc } from "../../ir/ir.js";
import { isUnitType, typeKey } from "../../ir/ir.js";
import { dynamicFieldStores, type DynamicFieldStores } from "../../ir/int32-slots.js";
import { everyExprChild, everyStmtChild, everyTypeChild } from "../../ir/traverse.js";
import type { IrModule } from "../../ir/ir.js";
import * as ts from "../ts7/adapter.js";
import {
  ARM_EXTRACTION_HELPER,
  COPY_HELPERS,
  PREDICATE_HELPER,
  ROUTING_HELPERS,
} from "./width-lift.js";
import {
  unionArmCopyDiag,
  unsupportedDiag,
  widthCopyDivergenceDiag,
  type ScrDiagnostic,
} from "../../diagnostics/diagnostic.js";
import type { Lowerer } from "./lowerer.js";

/** The conversions that answer a new object. */
export type WidthCopyKind =
  | "width"
  | "ovf"
  | "objWidth"
  | "clsWidth"
  | "arr"
  | "tupleArr"
  /** A typed value converted to another typed layout through the checked
   * boundary (`dynCheck` of a `dynFrom`): a record inside it that the
   * target declares at another layout is copied unless the backend plans
   * a record view for the pair. */
  | "checked";

/** The helper families that copy their argument, by helper name prefix.
 * The lowering interns them under the names of width-lift.ts. */
const COPY_PREFIXES: readonly (readonly [string, WidthCopyKind])[] = [
  [`${COPY_HELPERS.width}.`, "width"],
  [`${COPY_HELPERS.ovf}.`, "ovf"],
  [`${COPY_HELPERS.objWidth}.`, "objWidth"],
  [`${COPY_HELPERS.clsWidth}.`, "clsWidth"],
  [`${COPY_HELPERS.arr}.`, "arr"],
  [`${COPY_HELPERS.tupleArr}.`, "tupleArr"],
];

/** Helpers that only route their argument to copy helpers: the copies
 * inside them belong to the site that calls the helper. */
const ROUTING_PREFIXES: readonly string[] = [
  `${ROUTING_HELPERS.unionRecord}.`,
  `${ROUTING_HELPERS.unionArr}.`,
  `${ROUTING_HELPERS.presence}.`,
  `${ROUTING_HELPERS.recordWrap}.`,
  `${ROUTING_HELPERS.recordRoute}.`,
  `${ROUTING_HELPERS.retag}.`,
  `${ROUTING_HELPERS.narrowWidth}.`,
];

/** A checked arm extraction answers the object its argument holds: the
 * result is as aliasable as the argument. */
const EXTRACTION_PREFIX = `${ARM_EXTRACTION_HELPER}.`;

/** A written predicate's conversion rebuilds a record of another layout
 * and answers an element of the predicate's own type as it is. */
const PREDICATE_PREFIX = `${PREDICATE_HELPER}.`;

/** A union converted to another union arm by arm, and the route an arm
 * takes inside it when it fits several destination arms by width: it
 * enters the arm the value of its own discriminant names (union-retag.ts,
 * the arm kind `own`). */
const RETAG_PREFIX = `${ROUTING_HELPERS.retag}.`;
const RECORD_ROUTE_PREFIX = `${ROUTING_HELPERS.recordRoute}.`;

/** How a program can tell a copy from the object it copied. */
export interface CopyObservation {
  how: "write" | "identity" | "untyped";
  /** Which of the two layouts is observed: the copy's or its source's. */
  side?: "copy" | "source";
  /** What is observed, for the message (`field 'a' of '{ a: number }'`). */
  what: string;
  loc: SrcLoc;
}

export interface WidthCopyFact {
  kind: WidthCopyKind;
  from: IrType;
  to: IrType;
  /** The conversion's place in the program. */
  loc: SrcLoc;
  /** `value`: the converted value is the copied object. `member`: an object
   * reached through it is (a field, an element, a union payload's field). */
  depth: "value" | "member";
  /** Whether something else can still reach the copied object. A copy of
   * a fresh value (a literal, a spread, another copy) is not observable. */
  aliasable: boolean;
  /** What receives the copy: the kind of the IR node the conversion is an
   * operand of (`call` for an argument, `recordLit` for a field value,
   * `arrIntrinsic.push`, `return`, `varDecl`, ...). */
  slot: string;
  /** Whether the copy is made by a union conversion one of whose arms
   * enters the destination by the value of its own discriminant. That
   * conversion compiles only where no copy it makes can be told from the
   * object (refuseObservedCopies). */
  routed: boolean;
  /** The first observation that tells the copy from its object, or null
   * when the program has none. */
  observed: CopyObservation | null;
}

/** One copy a helper performs on (part of) its argument. */
interface CopyEffect {
  kind: WidthCopyKind;
  from: IrType;
  to: IrType;
  depth: "value" | "member";
  routed: boolean;
}

/** A conversion site before the program's observations are asked. */
type CopySite = Omit<WidthCopyFact, "observed">;

function copyKindOf(name: string): WidthCopyKind | null {
  if (name.charCodeAt(0) !== 37 /* % */) return null;
  for (const [prefix, kind] of COPY_PREFIXES) if (name.startsWith(prefix)) return kind;
  return null;
}

function hasPrefix(name: string, prefixes: readonly string[]): boolean {
  if (name.charCodeAt(0) !== 37 /* % */) return false;
  for (const prefix of prefixes) if (name.startsWith(prefix)) return true;
  return false;
}

/** Whether `name` is a helper whose copies belong to its call sites. */
function isConversionHelper(name: string): boolean {
  return (
    copyKindOf(name) !== null ||
    hasPrefix(name, ROUTING_PREFIXES) ||
    name.startsWith(PREDICATE_PREFIX)
  );
}

/** Types whose values have no identity a program can observe and no state
 * a write can change. */
function isValueType(type: IrType): boolean {
  switch (type.kind) {
    case "f64":
    case "bigint":
    case "string":
    case "bool":
    case "void":
      return true;
    default:
      return isUnitType(type);
  }
}

/** Whether the body of `fn` builds a record: a predicate's conversion
 * that does answers a new object for the elements it rebuilds. */
function buildsRecord(fn: IrFunction): boolean {
  let found = false;
  const expr = (e: IrExpr): boolean => {
    if (e.kind === "recordLit") found = true;
    return !found && everyExprChild(e, expr, stmt);
  };
  const stmt = (s: IrStmt): boolean => !found && everyStmtChild(s, expr, stmt);
  for (const s of fn.body) if (!stmt(s)) break;
  return found;
}

/** The slots that read one member of their operand and drop it. */
const PROJECTING_SLOTS = new Set<string>([
  "recordGet",
  "recordHas",
  "recordKeyGet",
  "arrayGet",
  "arrayHas",
  "arrayState",
  "arrIntrinsic.length",
  "arrIntrinsic.join",
]);

/** The slot name of an operand of `e`. */
function slotOf(e: IrExpr): string {
  switch (e.kind) {
    case "call":
      return e.callee.charCodeAt(0) === 37 /* % */ ? "call:helper" : "call";
    case "arrIntrinsic":
      return `arrIntrinsic.${e.method}`;
    case "mapIntrinsic":
      return `mapIntrinsic.${e.method}`;
    case "setIntrinsic":
      return `setIntrinsic.${e.method}`;
    default:
      return e.kind;
  }
}

function elementType(type: IrType): IrType {
  return type.kind === "array" ? type.elem : type;
}

/** The width copies of a lowered program: every conversion in `functions`
 * that builds a new object, whether it copies a value something else can
 * still reach, and for those the observation that makes the copy a
 * divergence (or null). Called once, on the final function list. */
export function collectWidthCopies(
  lowerer: Lowerer,
  functions: IrFunction[],
  /** Also list the checked conversions between two typed layouts (kind
   * `checked`). They are measured, not reported: whether one copies is the
   * backend's record-view plan's answer. */
  checked = false,
): WidthCopyFact[] {
  return collectCopies(lowerer, functions, checked, false);
}

/** The copies that are refused where the program can tell them from their
 * object, instead of reported (refuseObservedCopies). */
function isNamedCopy(kind: WidthCopyKind, routed: boolean): boolean {
  return kind === "clsWidth" || routed;
}

/** collectWidthCopies, or with `namedOnly` the named copies alone: a program
 * none of whose helpers performs one is then not walked, and the program's
 * observations are asked for those copies only. */
function collectCopies(
  lowerer: Lowerer,
  functions: IrFunction[],
  checked: boolean,
  namedOnly: boolean,
): WidthCopyFact[] {
  const helpers = new Map<string, IrFunction>();
  for (const fn of functions) if (isConversionHelper(fn.name)) helpers.set(fn.name, fn);
  // A program that interned no conversion helper converts nothing by copy.
  if (helpers.size === 0 && !checked) return [];
  const scan = new CopyScan(helpers, functions, checked, (id) => lowerer.unions.get(id)?.arms);
  if (namedOnly && !scan.performsNamedCopy()) return [];
  const sites = namedOnly
    ? scan.sites().filter((site) => isNamedCopy(site.kind, site.routed))
    : scan.sites();
  if (sites.length === 0) return [];
  // The program-wide observations are only needed for an aliasable copy.
  let observations: Observations | null = null;
  const facts: WidthCopyFact[] = [];
  const seen = new Set<string>();
  for (const site of sites) {
    const key = `${site.loc.file}\0${site.loc.start}\0${site.kind}\0${site.depth}\0${site.routed ? 1 : 0}\0${typeKey(site.from)}\0${typeKey(site.to)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!site.aliasable) {
      facts.push({ ...site, observed: null });
      continue;
    }
    observations ??= new Observations(lowerer, functions);
    facts.push({ ...site, observed: observations.of(site) });
  }
  return facts;
}

/** Finds the copy helper calls of a function list and whether each
 * converts an aliasable value. */
class CopyScan {
  private readonly effects = new Map<string, CopyEffect[]>();
  private readonly freshReturns = new Map<string, boolean>();
  private readonly byName = new Map<string, IrFunction>();
  private readonly out: CopySite[] = [];

  constructor(
    private readonly helpers: ReadonlyMap<string, IrFunction>,
    private readonly functions: readonly IrFunction[],
    private readonly withChecked: boolean,
    private readonly unionArms: (unionId: string) => readonly IrType[] | undefined,
  ) {
    for (const fn of functions) if (!this.byName.has(fn.name)) this.byName.set(fn.name, fn);
  }

  /** Whether a call of some helper performs a named copy. Reads the
   * helpers alone. */
  performsNamedCopy(): boolean {
    for (const name of this.helpers.keys())
      for (const effect of this.effectsOf(name))
        if (isNamedCopy(effect.kind, effect.routed)) return true;
    return false;
  }

  sites(): CopySite[] {
    for (const fn of this.functions) {
      if (this.helpers.has(fn.name)) continue;
      this.walk(
        fn.body,
        (call, slot) => this.site(call, slot),
        this.withChecked ? (check, slot) => this.checked(check, slot) : undefined,
      );
    }
    return this.out;
  }

  private site(call: IrExpr & { kind: "call" }, slot: string): void {
    const arg = call.args[0];
    if (arg === undefined) return;
    for (const effect of this.effectsOf(call.callee)) {
      // A copy that only has one of its members read is gone before
      // anything can tell it from its object.
      const unseen =
        effect.depth === "value"
          ? this.fresh(arg) || PROJECTING_SLOTS.has(slot)
          : this.deepFresh(arg);
      this.out.push({ ...effect, loc: call.loc, aliasable: !unseen, slot });
    }
  }

  /** A conversion helper taken as a function value: whatever calls it
   * hands it a value this scan does not see, so each of its copies counts
   * as one of an aliasable value. */
  private valued(closure: IrExpr & { kind: "closure" }): void {
    for (const effect of this.effectsOf(closure.fnName))
      this.out.push({ ...effect, loc: closure.loc, aliasable: true, slot: "closure" });
  }

  /** A checked conversion of a typed value into another typed layout: one
   * site per pair of record, array or class layouts that the two types
   * declare at the same position. A position the target leaves untyped
   * keeps the value (boxing answers the object itself). */
  private checked(check: IrExpr & { kind: "dynCheck" }, slot: string): void {
    let inner = check.value;
    while (inner.kind === "seqExpr") inner = inner.result;
    if (inner.kind !== "dynFrom") return;
    const pairs: [IrType, IrType][] = [];
    this.layoutPairs(inner.value.type, check.type, pairs, new Set());
    if (pairs.length === 0) return;
    const aliasable = !this.deepFresh(inner.value);
    for (const [from, to] of pairs)
      this.out.push({
        kind: "checked",
        from,
        to,
        depth: "member",
        loc: check.loc,
        aliasable,
        slot,
        routed: false,
      });
  }

  private layoutPairs(from: IrType, to: IrType, out: [IrType, IrType][], seen: Set<string>): void {
    if (from.kind === "dyn" || to.kind === "dyn" || isValueType(from) || isValueType(to)) return;
    const key = `${typeKey(from)}\0${typeKey(to)}`;
    if (typeKey(from) === typeKey(to) || seen.has(key)) return;
    seen.add(key);
    if (from.kind === "union" || to.kind === "union") {
      // Read into a local first: called as `this.unionArms(…)` the function
      // is handed this scan as its receiver, which makes the class a dynamic
      // value in the compiler's own build (LlEmitter.integerCloneHost).
      const unionArms = this.unionArms;
      const sources = from.kind === "union" ? (unionArms(from.unionId) ?? []) : [from];
      const targets = to.kind === "union" ? (unionArms(to.unionId) ?? []) : [to];
      for (const source of sources)
        for (const target of targets)
          if (source.kind === target.kind) this.layoutPairs(source, target, out, seen);
      return;
    }
    if (from.kind === "promise" && to.kind === "promise") {
      this.layoutPairs(from.inner, to.inner, out, seen);
      return;
    }
    if (from.kind === "func" && to.kind === "func") {
      // A caller's argument, typed by the target, enters the source's parameter.
      for (let i = 0; i < from.params.length && i < to.params.length; i++)
        this.layoutPairs(to.params[i]!, from.params[i]!, out, seen);
      this.layoutPairs(from.ret, to.ret, out, seen);
      return;
    }
    const layout = (type: IrType): boolean =>
      type.kind === "record" || type.kind === "array" || type.kind === "object";
    if (!layout(from) || !layout(to)) return;
    out.push([from, to]);
    if (from.kind === "array" && to.kind === "array")
      this.layoutPairs(from.elem, to.elem, out, seen);
  }

  /** Calls `visit` for every call of a conversion helper in `body`, with
   * the kind of the node the call is an operand of. */
  private walk(
    body: readonly IrStmt[],
    visit: (call: IrExpr & { kind: "call" }, slot: string) => void,
    checked?: (check: IrExpr & { kind: "dynCheck" }, slot: string) => void,
  ): void {
    let slot = "";
    const expr = (e: IrExpr): boolean => {
      if (e.kind === "call" && this.helpers.has(e.callee)) visit(e, slot);
      else if (e.kind === "closure" && this.helpers.has(e.fnName)) this.valued(e);
      else if (e.kind === "dynCheck" && checked !== undefined) checked(e, slot);
      const outer = slot;
      slot = slotOf(e);
      const all = everyExprChild(e, expr, stmt);
      slot = outer;
      return all;
    };
    const stmt = (s: IrStmt): boolean => {
      const outer = slot;
      slot = s.kind;
      const all = everyStmtChild(s, expr, stmt);
      slot = outer;
      return all;
    };
    for (const s of body) stmt(s);
  }

  /** The copies a call of the helper `name` performs: its own, when it is
   * a copy helper, and those of the helpers its body passes (parts of) its
   * argument to. A helper that reaches itself adds nothing new. */
  private effectsOf(name: string): CopyEffect[] {
    const known = this.effects.get(name);
    if (known !== undefined) return known;
    const effects: CopyEffect[] = [];
    this.effects.set(name, effects);
    const fn = this.helpers.get(name);
    const param = fn?.params[0];
    if (fn === undefined || param === undefined) return effects;
    const keys = new Set<string>();
    const add = (effect: CopyEffect): void => {
      const key = `${effect.kind}\0${effect.depth}\0${effect.routed ? 1 : 0}\0${typeKey(effect.from)}\0${typeKey(effect.to)}`;
      if (keys.has(key)) return;
      keys.add(key);
      effects.push(effect);
    };
    const kind = copyKindOf(name);
    if (kind !== null)
      add({ kind, from: param.type, to: fn.returnType, depth: "value", routed: false });
    else if (name.startsWith(PREDICATE_PREFIX) && buildsRecord(fn))
      add({ kind: "width", from: param.type, to: fn.returnType, depth: "value", routed: false });
    // A union conversion one of whose arms takes the record's own route:
    // without that route the conversion has no plan, so every copy it
    // makes exists through it, the arms with one destination arm too.
    const routed = name.startsWith(RETAG_PREFIX) && this.takesOwnRoute(fn);
    this.walk(fn.body, (call) => {
      const arg = call.args[0];
      if (arg === undefined) return;
      const reach = this.reach(arg, param.localId);
      if (reach === null) return;
      for (const inner of this.effectsOf(call.callee)) {
        const copy = routed && !inner.routed ? { ...inner, routed: true } : inner;
        add(reach === "value" ? copy : { ...copy, depth: "member" });
      }
    });
    return effects;
  }

  /** Whether the union conversion `fn` hands one of its arms to the
   * record's own route into the destination union. */
  private takesOwnRoute(fn: IrFunction): boolean {
    const routes: string[] = [];
    this.walk(fn.body, (call) => {
      if (call.callee.startsWith(RECORD_ROUTE_PREFIX)) routes.push(call.callee);
    });
    return routes.length > 0;
  }

  /** How a helper's expression relates to its parameter `param`: `value`
   * when it is the object the parameter holds, `member` when it may be an
   * object reached through it, null when the helper built it. */
  private reach(e: IrExpr, param: string): "value" | "member" | null {
    switch (e.kind) {
      case "varRef":
        return e.localId === param ? "value" : "member";
      case "unionNarrow":
        return this.reach(e.value, param);
      case "seqExpr":
        return this.reach(e.result, param);
      case "call":
        if (e.callee.startsWith(EXTRACTION_PREFIX) && !hasPrefix(e.callee, ROUTING_PREFIXES)) {
          const arg = e.args[0];
          return arg === undefined ? "member" : this.reach(arg, param);
        }
        return this.fresh(e) ? null : "member";
      default:
        return this.fresh(e) ? null : "member";
    }
  }

  /** Whether nothing but this expression's consumer can reach the object
   * it answers. */
  private fresh(e: IrExpr): boolean {
    switch (e.kind) {
      case "recordLit":
      case "arrayLit":
      case "arrayNewLen":
      case "recordClone":
        return true;
      case "ternary":
        return this.fresh(e.then) && this.fresh(e.else_);
      case "seqExpr":
        return this.fresh(e.result);
      // A union box is a value: what a program can reach is the arm inside,
      // and that is the wrapped value, whichever union the box is viewed as.
      case "unionWrap":
      case "unionRetype":
      case "unionNarrow":
        return this.fresh(e.value);
      case "call": {
        // A copy is a new object, but it stands for the value it copied: a
        // conversion of a copy of an aliasable value (`w` to N to M in one
        // expression, or through a function that returns its converted
        // parameter) is still a second object where Node has `w`, and a
        // write to its layout is as lost as one to the first copy's. A
        // helper that routes its argument to copies, or extracts an arm of
        // it, answers that value or a copy of it.
        if (
          copyKindOf(e.callee) !== null ||
          hasPrefix(e.callee, ROUTING_PREFIXES) ||
          e.callee.startsWith(EXTRACTION_PREFIX)
        ) {
          const arg = e.args[0];
          return arg === undefined || this.fresh(arg);
        }
        return this.returnsFresh(e.callee);
      }
      default:
        return isValueType(e.type);
    }
  }

  /** Whether nothing else can reach the object or anything inside it. */
  private deepFresh(e: IrExpr): boolean {
    switch (e.kind) {
      case "recordLit":
        for (const field of e.fields) if (!this.deepFresh(field.value)) return false;
        return true;
      case "arrayLit":
        // A spread element shares its source's elements.
        if (e.spreads !== undefined && e.spreads.length > 0)
          return isValueType(elementType(e.type));
        for (const elem of e.elems) if (!this.deepFresh(elem)) return false;
        return true;
      case "arrayNewLen":
        return true;
      case "ternary":
        return this.deepFresh(e.then) && this.deepFresh(e.else_);
      case "seqExpr":
        return this.deepFresh(e.result);
      default:
        return isValueType(e.type);
    }
  }

  /** Whether every value the function `name` returns is fresh: each
   * `return` answers a literal, a copy of a fresh value, or a call of such
   * a function. */
  private returnsFresh(name: string): boolean {
    const known = this.freshReturns.get(name);
    if (known !== undefined) return known;
    // A function that reaches itself is not assumed fresh.
    this.freshReturns.set(name, false);
    const fn = this.byName.get(name);
    if (fn === undefined || fn.async === true || fn.generator !== undefined) return false;
    let returns = 0;
    let fresh = true;
    const expr = (e: IrExpr): boolean => everyExprChild(e, expr, stmt);
    const stmt = (s: IrStmt): boolean => {
      if (s.kind === "return" && s.value !== null) {
        returns++;
        if (!this.fresh(s.value)) fresh = false;
      }
      return fresh && everyStmtChild(s, expr, stmt);
    };
    for (const s of fn.body) if (!stmt(s)) break;
    const result = fresh && returns > 0;
    this.freshReturns.set(name, result);
    return result;
  }
}

/** Array methods that leave their receiver as it was. Every other method
 * counts as a write. */
const ARRAY_READS = new Set<string>([
  "length",
  "getNumber",
  "indexEq",
  "indexOf",
  "includes",
  "nextPresent",
  "join",
  "slice",
  "concatSpread",
  "toSortedPrimitive",
  "toReversed",
  "toSpliced",
  "withUndefined",
  "with",
]);

/** Array methods that compare elements by identity. */
const ARRAY_SEARCHES = new Set<string>(["indexOf", "includes"]);

/** Runtime calls that take typed operands and neither write them nor
 * compare them: the record-link and kept-source bookkeeping of the copy
 * helpers and the reflective walkers. Any other runtime call that receives
 * a value of a copied layout counts as an observation. */
const READ_ONLY_RUNTIME_CALLS: readonly string[] = [
  "record.link",
  "record.source",
  "insp.",
  "array.hasProperties",
];

function readOnlyRuntimeCall(fn: string): boolean {
  for (const prefix of READ_ONLY_RUNTIME_CALLS) if (fn.startsWith(prefix)) return true;
  return false;
}

/** The runtime calls a constructor makes for the runtime-provided class its
 * class is rooted in (superCall in lower-classes.ts). The runtime
 * initializes the members that class holds on the object being built and
 * runs none of the program's code with it, so the call does not let the
 * object out. */
const RUNTIME_BASE_CONSTRUCTORS: ReadonlySet<IrLibFn> = new Set<IrLibFn>([
  "error.ctor",
  "error.ctorOptions",
  "emitter.ctor",
  "readable.init",
  "writable.init",
  "duplex.init",
  "transform.init",
  "passthrough.init",
]);

/** What the whole program does to values of each layout. */
class Observations {
  /** `record:<shape>\0<field>` and `object:<root class>\0<field>` (field
   * `*` for a write that can name any field) to the first write. */
  private readonly fieldWrites = new Map<string, CopyObservation>();
  /** Array element type key to the first write of such an array. */
  private readonly arrayWrites = new Map<string, CopyObservation>();
  /** Type key to the first identity comparison of values of the type. */
  private readonly identity = new Map<string, CopyObservation>();
  /** Type key to the first place a value of the type (or one holding it)
   * leaves typed code. */
  private readonly untyped = new Map<string, CopyObservation>();
  /** Class name to the first `instanceof` test against it. */
  private readonly instanceTests = new Map<string, CopyObservation>();
  private readonly stores: DynamicFieldStores;
  /** Whether untyped code in the program can compare values by identity. */
  private untypedIdentity = false;
  /** Type keys opaque() has marked. */
  private readonly opaqueSeen = new Set<string>();
  /** Constructors by function name, and whether each lets `this` out. */
  private readonly constructors = new Map<string, IrFunction>();
  private readonly leaky = new Map<string, boolean>();

  constructor(
    private readonly lowerer: Lowerer,
    functions: IrFunction[],
  ) {
    // dynamicFieldStores reads a module's functions, and its records and
    // unions through the two tables.
    const lowered: IrModule = { irVersion: 17, sourceFile: "", functions, entry: "" };
    this.stores = dynamicFieldStores(
      lowered,
      new Map(lowerer.shapes.shapes.map((shape) => [shape.id, shape])),
      new Map(lowerer.unions.unions.map((union) => [union.id, union])),
    );
    for (const fn of functions)
      if (fn.name.endsWith(".constructor")) this.constructors.set(fn.name, fn);
    for (const fn of functions) {
      // A copy helper writes only the object it builds.
      if (isConversionHelper(fn.name) || fn.name.startsWith("%rec.compose.")) continue;
      this.scan(fn);
    }
    if (this.stores.all) this.untypedIdentity = true;
  }

  of(fact: Omit<WidthCopyFact, "observed">): CopyObservation | null {
    // A union on either side stands for its arms (a predicate's conversion
    // takes a union of records and may answer one).
    const targets = this.arms(fact.to);
    const sources = this.arms(fact.from);
    for (const to of targets) {
      const copy =
        this.written(to, null) ??
        this.compared(to) ??
        (fact.kind === "clsWidth" && to.kind === "object"
          ? this.instanceTested(to.className)
          : null);
      if (copy !== null) return { ...copy, side: "copy" };
    }
    for (const from of sources)
      for (const to of targets) {
        const source = this.written(from, to);
        if (source !== null) return { ...source, side: "source" };
      }
    return null;
  }

  /** `type`, or the arms of a union (and of the unions among them). */
  private arms(type: IrType): IrType[] {
    if (type.kind !== "union") return [type];
    const out: IrType[] = [];
    const seen = new Set<string>();
    const stack: IrType[] = [type];
    while (stack.length > 0) {
      const next = stack.pop()!;
      if (next.kind !== "union") {
        if (!isValueType(next)) out.push(next);
        continue;
      }
      if (seen.has(next.unionId)) continue;
      seen.add(next.unionId);
      for (const arm of this.lowerer.unions.get(next.unionId)?.arms ?? []) stack.push(arm);
    }
    return out;
  }

  /** The first write to a value of layout `type`: to one of the fields it
   * shares with `other` (any field when `other` is null), to one of its
   * elements, or through untyped code that holds it. */
  private written(type: IrType, other: IrType | null): CopyObservation | null {
    if (type.kind === "array") {
      const direct = this.arrayWrites.get(typeKey(type.elem));
      if (direct !== undefined) return direct;
      return this.untypedWrite(type, null);
    }
    const unit = this.unitOf(type);
    if (unit === null) return null;
    const any = this.fieldWrites.get(`${unit}\0*`);
    if (any !== undefined) return any;
    // Only a record or class on the other side narrows the fields that
    // matter: a tuple copied into an array shares every position.
    const shared =
      other !== null && (other.kind === "record" || other.kind === "object")
        ? this.fieldNames(other)
        : null;
    const names = this.fieldNames(type);
    for (const name of names) {
      if (shared !== null && !shared.includes(name)) continue;
      const write = this.fieldWrites.get(`${unit}\0${name}`);
      if (write !== undefined) return write;
    }
    return this.untypedWrite(type, shared ?? names);
  }

  private untypedWrite(type: IrType, names: readonly string[] | null): CopyObservation | null {
    const escape = this.untyped.get(typeKey(type));
    if (escape === undefined) return null;
    if (this.stores.all) return escape;
    if (names === null) return this.stores.names.size > 0 ? escape : null;
    for (const name of names) if (this.stores.names.has(name)) return escape;
    return null;
  }

  private compared(type: IrType): CopyObservation | null {
    const direct = this.identity.get(typeKey(type));
    if (direct !== undefined) return direct;
    const escape = this.untyped.get(typeKey(type));
    return escape !== undefined && this.untypedIdentity ? escape : null;
  }

  private instanceTested(className: string): CopyObservation | null {
    for (let info = this.lowerer.classes.get(className) ?? null; info; info = info.base) {
      const test = this.instanceTests.get(info.def.name);
      if (test !== undefined) return test;
    }
    return this.instanceTests.get("*") ?? null;
  }

  private unitOf(type: IrType): string | null {
    if (type.kind === "record") return `record:${type.shapeId}`;
    if (type.kind === "object") return `object:${this.rootClass(type.className)}`;
    return null;
  }

  private rootClass(className: string): string {
    let info = this.lowerer.classes.get(className) ?? null;
    if (info === null) return className;
    while (info.base !== null) info = info.base;
    return info.def.name;
  }

  private fieldNames(type: IrType): string[] {
    if (type.kind === "record")
      return (this.lowerer.shapes.get(type.shapeId)?.fields ?? []).map((f) => f.name);
    if (type.kind === "object") {
      const names: string[] = [];
      for (let info = this.lowerer.classes.get(type.className) ?? null; info; info = info.base)
        for (const name of info.fields.keys()) if (!names.includes(name)) names.push(name);
      return names;
    }
    return [];
  }

  /** Records the first observation under `key`. The description is built
   * only then: a program writes the same fields many times. */
  private note(
    table: Map<string, CopyObservation>,
    key: string,
    how: CopyObservation["how"],
    what: () => string,
    loc: SrcLoc,
  ): void {
    if (!table.has(key)) table.set(key, { how, what: what(), loc });
  }

  private fmt(type: IrType): string {
    return typeText(this.lowerer, type);
  }

  /** Records that values of `type`, and of every type reachable inside
   * it, leave typed code at `loc`. */
  private escape(root: IrType, loc: SrcLoc, how: string): void {
    const stack: IrType[] = [root];
    while (stack.length > 0) {
      const type = stack.pop()!;
      if (isValueType(type) || type.kind === "dyn") continue;
      const key = typeKey(type);
      if (this.untyped.has(key)) continue;
      this.untyped.set(key, { how: "untyped", what: `a '${this.fmt(type)}' ${how}`, loc });
      if (type.kind === "record") {
        const shape = this.lowerer.shapes.get(type.shapeId);
        for (const field of shape?.fields ?? []) stack.push(field.type);
        if (shape?.indexValue !== undefined) stack.push(shape.indexValue);
      } else if (type.kind === "union") {
        for (const arm of this.lowerer.unions.get(type.unionId)?.arms ?? []) stack.push(arm);
      } else if (type.kind === "object") {
        for (let info = this.lowerer.classes.get(type.className) ?? null; info; info = info.base)
          for (const field of info.fields.values()) stack.push(field);
      } else {
        everyTypeChild(type, (child) => {
          stack.push(child);
          return true;
        });
      }
    }
  }

  /** Records an identity comparison of values of `type` (of its arms, for
   * a union). */
  private compare(type: IrType, loc: SrcLoc): void {
    if (isValueType(type)) return;
    if (type.kind === "dyn") {
      this.untypedIdentity = true;
      return;
    }
    if (type.kind === "union") {
      for (const arm of this.lowerer.unions.get(type.unionId)?.arms ?? []) this.compare(arm, loc);
      return;
    }
    this.note(this.identity, typeKey(type), "identity", () => `'${this.fmt(type)}' values`, loc);
  }

  private arrayWrite(arr: IrExpr, loc: SrcLoc): void {
    const type = arr.type;
    if (type.kind !== "array") return;
    this.note(this.arrayWrites, typeKey(type.elem), "write", () => `a '${this.fmt(type)}'`, loc);
  }

  /** The locals of `fn` that hold an object the function built and that
   * nothing else can reach before the function returns it: declared with a
   * literal, never reassigned or captured, and used only as the receiver
   * of element and field reads and writes and as a `return` value. A
   * write to such a local is part of building the object: it can be
   * neither a copy nor copied before it leaves. */
  private builders(fn: IrFunction): Set<string> {
    const candidates = new Set<string>();
    const uses = new Map<string, number>();
    const allowed = new Map<string, number>();
    const allow = (e: IrExpr): void => {
      if (e.kind === "varRef" && candidates.has(e.localId))
        allowed.set(e.localId, (allowed.get(e.localId) ?? 0) + 1);
    };
    const declare = (s: IrStmt): boolean => {
      if (s.kind === "varDecl" && s.init !== null) {
        const init = s.init;
        if (init.kind === "arrayLit" || init.kind === "recordLit" || init.kind === "arrayNewLen")
          candidates.add(s.localId);
      }
      return everyStmtChild(s, () => true, declare);
    };
    for (const s of fn.body) declare(s);
    if (candidates.size === 0) return candidates;
    const expr = (e: IrExpr): boolean => {
      switch (e.kind) {
        case "varRef":
          if (candidates.has(e.localId)) uses.set(e.localId, (uses.get(e.localId) ?? 0) + 1);
          break;
        case "assignExpr":
        case "incDec":
          candidates.delete(e.localId);
          break;
        case "closure":
        case "classRef":
          for (const id of e.captures ?? []) candidates.delete(id);
          break;
        case "arrIntrinsic":
          // A method that answers an array may answer its receiver.
          if (e.type.kind !== "array") allow(e.receiver);
          break;
        case "arrayGet":
        case "arrayHas":
        case "arrayState":
          allow(e.arr);
          break;
        case "recordGet":
        case "recordKeyGet":
        case "recordHas":
          allow(e.obj);
          break;
      }
      return everyExprChild(e, expr, stmt);
    };
    const stmt = (s: IrStmt): boolean => {
      switch (s.kind) {
        case "assign":
          candidates.delete(s.localId);
          break;
        case "arraySet":
        case "arraySetLength":
        case "arraySetUndefined":
        case "arrayDelete":
          allow(s.arr);
          break;
        case "recordSet":
        case "recordKeySet":
        case "recordKeyDelete":
          allow(s.obj);
          break;
        case "return":
          if (s.value !== null) allow(s.value);
          break;
      }
      return everyStmtChild(s, expr, stmt);
    };
    for (const s of fn.body) stmt(s);
    const out = new Set<string>();
    for (const id of candidates) if ((uses.get(id) ?? 0) === (allowed.get(id) ?? 0)) out.add(id);
    return out;
  }

  private scan(fn: IrFunction): void {
    const builders = this.builders(fn);
    const builds = (e: IrExpr): boolean => e.kind === "varRef" && builders.has(e.localId);
    // A constructor's stores into the object it is building happen before
    // anything can have copied that object, unless the constructor lets
    // `this` out.
    const self = fn.name.endsWith(".constructor") ? fn.params[0]?.localId : undefined;
    const building = self !== undefined && !this.leaks(fn.name) ? self : null;
    const expr = (e: IrExpr): boolean => {
      switch (e.kind) {
        case "bin":
          if (e.op === "===" || e.op === "!==") {
            this.compare(e.left.type, e.loc);
            this.compare(e.right.type, e.loc);
          }
          break;
        case "unionEq":
          this.compare(e.left.type, e.loc);
          this.compare(e.right.type, e.loc);
          break;
        case "unionFuncEq":
          this.compare(e.union.type, e.loc);
          break;
        case "dynScalarEq":
          this.untypedIdentity = true;
          break;
        case "arrIntrinsic":
          if (!ARRAY_READS.has(e.method) && !builds(e.receiver)) this.arrayWrite(e.receiver, e.loc);
          if (ARRAY_SEARCHES.has(e.method) && e.receiver.type.kind === "array")
            this.compare(e.receiver.type.elem, e.loc);
          break;
        case "mapNew":
        case "mapIntrinsic": {
          const type = e.kind === "mapNew" ? e.type : e.receiver.type;
          if (type.kind === "map") this.compare(type.key, e.loc);
          break;
        }
        case "setNew":
        case "setIntrinsic": {
          const type = e.kind === "setNew" ? e.type : e.receiver.type;
          if (type.kind === "set") this.compare(type.elem, e.loc);
          break;
        }
        case "fieldIncDec":
          this.note(
            this.fieldWrites,
            `object:${this.rootClass(e.className)}\0${e.field}`,
            "write",
            () => `field '${e.field}' of a '${e.className}'`,
            e.loc,
          );
          break;
        case "instanceOf":
          this.note(
            this.instanceTests,
            e.className,
            "identity",
            () => `'instanceof ${e.className}'`,
            e.loc,
          );
          break;
        case "instanceOfValue":
          // The class is a run-time value: it can be any class.
          this.note(
            this.instanceTests,
            "*",
            "identity",
            () => "'instanceof' against a class value",
            e.loc,
          );
          break;
        case "dynFrom":
          this.escape(e.value.type, e.loc, "reaches untyped code");
          break;
        case "dynCheck":
          this.escape(e.type, e.loc, "comes from untyped code");
          break;
        case "ffiCall":
          for (const arg of e.args) this.opaque(arg.type, e.loc, "a foreign function");
          break;
        case "intrinsic":
          for (const arg of e.args) this.opaque(arg.type, e.loc, e.name);
          break;
        case "libCall":
          if (!readOnlyRuntimeCall(e.fn))
            for (const arg of e.args) this.opaque(arg.type, e.loc, e.fn);
          break;
      }
      return everyExprChild(e, expr, stmt);
    };
    const stmt = (s: IrStmt): boolean => {
      switch (s.kind) {
        case "recordSet":
          if (builds(s.obj)) break;
          this.note(
            this.fieldWrites,
            `record:${s.shapeId}\0${s.field}`,
            "write",
            () => `field '${s.field}' of a '${this.fmt({ kind: "record", shapeId: s.shapeId })}'`,
            s.loc,
          );
          break;
        case "recordKeySet":
        case "recordKeyDelete":
          if (builds(s.obj)) break;
          this.note(
            this.fieldWrites,
            `record:${s.shapeId}\0*`,
            "write",
            () => `a key of a '${this.fmt({ kind: "record", shapeId: s.shapeId })}'`,
            s.loc,
          );
          break;
        case "fieldSet":
          if (building === null || s.obj.kind !== "varRef" || s.obj.localId !== building)
            this.note(
              this.fieldWrites,
              `object:${this.rootClass(s.className)}\0${s.field}`,
              "write",
              () => `field '${s.field}' of a '${s.className}'`,
              s.loc,
            );
          break;
        case "arraySet":
        case "arraySetLength":
        case "arraySetUndefined":
        case "arrayDelete":
          if (!builds(s.arr)) this.arrayWrite(s.arr, s.loc);
          break;
        case "switch":
          this.compare(s.disc.type, s.loc);
          break;
        case "throw":
          this.escape(s.value.type, s.loc, "is thrown");
          break;
      }
      return everyStmtChild(s, expr, stmt);
    };
    for (const s of fn.body) stmt(s);
  }

  /** A typed operand of a runtime call the scan does not know: the call
   * may write or compare the records, arrays and instances it is handed,
   * and anything it can reach through them. */
  private opaque(root: IrType, loc: SrcLoc, fn: string): void {
    const stack: IrType[] = [root];
    while (stack.length > 0) {
      const type = stack.pop()!;
      if (isValueType(type) || type.kind === "dyn") continue;
      if (type.kind === "union") {
        for (const arm of this.lowerer.unions.get(type.unionId)?.arms ?? []) stack.push(arm);
        continue;
      }
      if (type.kind !== "record" && type.kind !== "array" && type.kind !== "object") continue;
      const key = typeKey(type);
      if (this.opaqueSeen.has(key)) continue;
      this.opaqueSeen.add(key);
      const observation: CopyObservation = {
        how: "untyped",
        what: `a '${this.fmt(type)}' reaches the runtime (${fn})`,
        loc,
      };
      if (!this.identity.has(key)) this.identity.set(key, observation);
      if (type.kind === "array") {
        const elem = typeKey(type.elem);
        if (!this.arrayWrites.has(elem)) this.arrayWrites.set(elem, observation);
        stack.push(type.elem);
      } else {
        const unit = this.unitOf(type);
        const held = type.kind === "object" ? this.runtimeHeld(type.className) : null;
        if (unit !== null && held !== null) {
          for (const name of held)
            if (!this.fieldWrites.has(`${unit}\0${name}`))
              this.fieldWrites.set(`${unit}\0${name}`, observation);
        } else if (unit !== null && !this.fieldWrites.has(`${unit}\0*`))
          this.fieldWrites.set(`${unit}\0*`, observation);
        if (type.kind === "record") {
          const shape = this.lowerer.shapes.get(type.shapeId);
          for (const field of shape?.fields ?? []) stack.push(field.type);
          if (shape?.indexValue !== undefined) stack.push(shape.indexValue);
        }
      }
    }
  }

  /** The fields the runtime can write on an instance of `className` it is
   * handed, when the class is rooted in a runtime-provided class (an
   * emitter, an error, a stream; objToRecordPlan's rule): the members that
   * runtime class holds. The runtime knows no other layout of the instance,
   * so the fields the program's classes declare are written by the program's
   * own code, which this scan reads, and no conversion copies a member the
   * runtime class holds. Null for any other class. */
  private runtimeHeld(className: string): string[] | null {
    let rooted = false;
    const names: string[] = [];
    for (let info = this.lowerer.classes.get(className) ?? null; info; info = info.base) {
      if (
        !info.builtinError &&
        !info.builtinEmitter &&
        info.builtinStream === undefined &&
        !info.def.runtime
      )
        continue;
      rooted = true;
      for (const name of info.fields.keys()) if (!names.includes(name)) names.push(name);
    }
    return rooted ? names : null;
  }

  /** Whether the constructor named `name` uses its `this` as anything but
   * the receiver of its own field stores and reads and of a base
   * constructor's call, or calls a base constructor that does. A name
   * that is no known constructor counts as letting it out. */
  private leaks(name: string): boolean {
    const known = this.leaky.get(name);
    if (known !== undefined) return known;
    // A constructor that reaches itself is not assumed private.
    this.leaky.set(name, true);
    const fn = this.constructors.get(name);
    const self = fn?.params[0]?.localId;
    if (fn === undefined || self === undefined) return true;
    let leaked = false;
    const isSelf = (e: IrExpr): boolean => e.kind === "varRef" && e.localId === self;
    // A base constructor takes the object at the base's type.
    const isReceiver = (e: IrExpr): boolean =>
      isSelf(e) || (e.kind === "upcast" && isSelf(e.value));
    const expr = (e: IrExpr): boolean => {
      if (leaked) return false;
      if (isSelf(e)) {
        leaked = true;
        return false;
      }
      if ((e.kind === "closure" || e.kind === "classRef") && (e.captures ?? []).includes(self)) {
        leaked = true;
        return false;
      }
      if (e.kind === "fieldGet" && isSelf(e.obj)) return true;
      if (
        e.kind === "call" &&
        e.callee.endsWith(".constructor") &&
        e.args.length > 0 &&
        isReceiver(e.args[0]!)
      ) {
        if (this.leaks(e.callee)) {
          leaked = true;
          return false;
        }
        for (let i = 1; i < e.args.length; i++) if (!expr(e.args[i]!)) return false;
        return true;
      }
      if (
        e.kind === "libCall" &&
        RUNTIME_BASE_CONSTRUCTORS.has(e.fn) &&
        e.args.length > 0 &&
        isReceiver(e.args[0]!)
      ) {
        for (let i = 1; i < e.args.length; i++) if (!expr(e.args[i]!)) return false;
        return true;
      }
      return everyExprChild(e, expr, stmt);
    };
    const stmt = (s: IrStmt): boolean => {
      if (leaked) return false;
      if (s.kind === "fieldSet" && isSelf(s.obj)) return expr(s.value);
      return everyStmtChild(s, expr, stmt);
    };
    for (const s of fn.body) if (!stmt(s)) break;
    this.leaky.set(name, leaked);
    return leaked;
  }
}

/** Refuses the two conversions whose copy is named instead of reported,
 * when the value converted is one something else can still reach and the
 * program can tell the copy from it. Runs while the module can still fail;
 * programs without such a conversion skip it.
 *
 * - A record converted to a class instance: an instance is not the record
 *   it was built from, so a write through either is lost. Nothing keeps
 *   such a value one object, and no program measured needs it.
 * - A union's arm that fits several arms of the destination union and
 *   enters the one its own discriminant names. That conversion compiles
 *   where the program cannot tell the copy from the object: a fresh value,
 *   or layouts nothing writes, compares or hands to code the scan cannot
 *   follow. Elsewhere it has no layout mapping that keeps the object, and
 *   it is refused as a union conversion without a mapping is. The object
 *   copied may be the arm or one inside a record or array converted with
 *   it. An arm with one destination arm is copied and reported (SC6001):
 *   the observation is a fact about a layout, not about one value, and
 *   programs that convert that way and write another value of the layout
 *   behave as they do under Node. */
export function refuseObservedCopies(lowerer: Lowerer, functions: IrFunction[]): void {
  const refusedArms = new Set<string>();
  for (const fact of collectCopies(lowerer, functions, false, true)) {
    const observed = fact.observed;
    if (observed === null) continue;
    if (fact.kind !== "clsWidth") {
      // One refusal per conversion, whichever of its arms is observed first.
      const site = `${fact.loc.file}\0${fact.loc.start}`;
      if (refusedArms.has(site)) continue;
      refusedArms.add(site);
      lowerer.pushDiag(
        unionArmCopyDiag(
          typeText(lowerer, fact.from),
          typeText(lowerer, fact.to),
          { how: observed.how, what: observed.what, where: whereOf(lowerer, observed.loc) },
          fact.loc,
        ),
      );
      continue;
    }
    lowerer.pushDiag(
      unsupportedDiag(
        "SC1090",
        fact.loc,
        `converting a '${typeText(lowerer, fact.from)}' to the class '${typeText(lowerer, fact.to)}' in a program that ${
          observed.how === "write"
            ? `writes ${observed.what}`
            : observed.how === "identity"
              ? `tests ${observed.what}`
              : `lets ${observed.what}`
        } (${whereOf(lowerer, observed.loc)})`,
        `the conversion would construct a new instance where Node has the one plain object: construct the instance where the value is made ('new ${lowerer.fmt(fact.to)}(...)'), or declare the slot with the record's own type`,
      ),
    );
  }
}

/** A type as a message names it: its structural text, cut where a large
 * record or union would otherwise fill the line. A program can carry
 * thousands of these warnings, and each names up to three types. */
function typeText(lowerer: Lowerer, type: IrType): string {
  const text = lowerer.fmt(type);
  return text.length <= TYPE_TEXT ? text : `${text.slice(0, TYPE_TEXT - 4)} ...`;
}

const TYPE_TEXT = 120;

/** The SC6001 warnings of a program's width copies: one per copy the
 * program can tell from its object. */
export function widthCopyDivergences(
  lowerer: Lowerer,
  facts: readonly WidthCopyFact[],
): ScrDiagnostic[] {
  const out: ScrDiagnostic[] = [];
  for (const fact of facts) {
    const observed = fact.observed;
    if (observed === null || fact.kind === "checked") continue;
    out.push(
      widthCopyDivergenceDiag(
        {
          from: typeText(lowerer, fact.from),
          to: typeText(lowerer, fact.to),
          member: fact.depth === "member",
        },
        { how: observed.how, what: observed.what, where: whereOf(lowerer, observed.loc) },
        fact.loc,
      ),
    );
  }
  return out;
}

/** `<file name>:<line>` of a place in the program. Sites that convert the
 * same pair share one observation and so one message, which lets the
 * coverage report count them as one group. */
function whereOf(lowerer: Lowerer, loc: SrcLoc): string {
  const slash = Math.max(loc.file.lastIndexOf("/"), loc.file.lastIndexOf("\\"));
  const name = loc.file.slice(slash + 1);
  const source = lowerer.program.getSourceFile(loc.file);
  if (source === undefined) return name;
  return `${name}:${ts.getLineAndCharacterOfPosition(source, loc.start).line + 1}`;
}

/** One line per fact, for `SCRIPTC_TRACE_WIDTH_COPIES=1` (the census the
 * copy baseline is measured with). */
export function traceWidthCopies(lowerer: Lowerer, facts: readonly WidthCopyFact[]): string[] {
  return facts.map((fact) => {
    const observed = !fact.aliasable
      ? "fresh"
      : fact.observed === null
        ? "unobserved"
        : `${fact.observed.how}:${fact.observed.side ?? ""}:${fact.observed.what}@${fact.observed.loc.file}:${fact.observed.loc.start}`;
    return `width-copy\t${fact.routed ? `${fact.kind}:routed` : fact.kind}\t${fact.depth}\t${observed}\t${lowerer.fmt(fact.from)}\t${lowerer.fmt(fact.to)}\t${fact.loc.file}:${fact.loc.start}\t${fact.slot}`;
  });
}
