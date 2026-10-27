/* Static immutability facts the backend uses to drop run-time immutability
 * checks (see computeConstructionFacts). Pure functions of the IR module. */
import type { DynamicFieldStores } from "../ir/int32-slots.js";
import type { IrExpr, IrModule, IrStmt } from "../ir/ir.js";
import { everyExprChild, everyStmtChild } from "../ir/traverse.js";
import { eachNodeOfKinds, type IrNodeIndex, type IrNodeKind } from "../ir/node-index.js";
import {
  computeCycleMutability,
  constructorEscapePoint,
  constructorThisAliases,
  fieldKey,
  type CycleMutability,
} from "./cycle-mutability.js";

/** Fields that are never written once their object can be observed outside
 * its own construction (cycle-mutability.ts derives the facts from every
 * store in the IR, including typed-ref commits from checked-dynamic code,
 * and disables them for library builds).
 *
 * Outside constructors, a reference read from such a field stays valid for
 * as long as its owner object is alive: nothing can replace it and release
 * the old value. Constructors themselves may still write their own
 * `this`'s fields, so the facts do not apply while one runs. */
export class ImmutableFields {
  constructor(
    private readonly mutability: CycleMutability,
    private readonly unitOfClass: (className: string) => string,
  ) {}

  /** `obj.field` on a class instance is construction-only. */
  classField(className: string, field: string): boolean {
    return this.unit(this.unitOfClass(className), field);
  }

  /** `obj.field` on a record is never written after the literal. */
  recordField(shapeId: string, field: string): boolean {
    return this.unit(`record:${shapeId}`, field);
  }

  private unit(unit: string, field: string): boolean {
    return (
      !this.mutability.all &&
      !this.mutability.units.has(unit) &&
      !this.mutability.fields.has(fieldKey(unit, field))
    );
  }
}

export function computeImmutableFields(
  mod: IrModule,
  stores?: DynamicFieldStores,
  /** computeCycleMutability's answer for this module, when the caller has it. */
  precomputed?: CycleMutability,
): ImmutableFields | null {
  if (mod.lib !== undefined) return null;
  const baseOf = new Map((mod.classes ?? []).map((c) => [c.name, c.base ?? null] as const));
  const roots = new Map<string, string>();
  const rootOf = (name: string): string => {
    const known = roots.get(name);
    if (known !== undefined) return known;
    let cur = name;
    for (let base = baseOf.get(cur); base !== null && base !== undefined; base = baseOf.get(cur))
      cur = base;
    roots.set(name, cur);
    return cur;
  };
  const unitOfClass = (name: string): string => `object:${rootOf(name)}`;
  const mutability = precomputed ?? computeCycleMutability(mod, unitOfClass, stores);
  return mutability.all ? null : new ImmutableFields(mutability, unitOfClass);
}

/** Stores that provably target an object no other code can reach yet.
 *
 * A published object (@scriptc/threads `publish`) rejects every write, so
 * the emitter guards each store into a type the program may publish. A
 * store into the constructor's own `this` cannot target a published object
 * when nothing outside the construction can hold `this` at that point:
 *
 * - the constructor runs on a fresh object: it is only reached through
 *   `new` (or a construct thunk) for its class or a subclass, never by a
 *   direct call on an existing object (`%C.constructor` called anywhere but
 *   as the direct super call of a subclass constructor disqualifies C and
 *   every ancestor, which that call reaches with the same receiver);
 * - no ancestor constructor, which runs before this body continues, lets
 *   `this` escape, and the store lies in a top-level statement before the
 *   first one in which this constructor lets it escape
 *   (cycle-mutability's constructorEscapePoint: `this`, or a constant alias
 *   of it, may only be a field-store target, a field-read receiver or the
 *   direct base constructor's receiver; storing it anywhere, including
 *   into one of its own fields whose later reads would hand it out again,
 *   and closures and class references capturing it count as escapes).
 *   A subclass constructor's code only runs after this body returns.
 *
 * Library builds keep every guard: their constructors can be invoked by an
 * embedder in ways the module does not show. */
export interface ConstructionFacts {
  /** `fieldSet` statements whose target is a still-private `this`. */
  privateStores: Set<IrStmt>;
}

/** The nodes that can reach a constructor with a reused receiver. */
const CONSTRUCTOR_USE_KINDS: readonly IrNodeKind[] = ["call", "closure"];

export function computeConstructionFacts(mod: IrModule, nodes?: IrNodeIndex): ConstructionFacts {
  const facts: ConstructionFacts = { privateStores: new Set() };
  if (mod.lib !== undefined) return facts;
  const classes = new Map((mod.classes ?? []).map((c) => [c.name, c] as const));
  const ctorClass = new Map([...classes.keys()].map((name) => [`%${name}.constructor`, name]));
  const fnByName = new Map(mod.functions.map((fn) => [fn.name, fn] as const));
  const thisOf = (name: string): string | null =>
    fnByName.get(`%${name}.constructor`)?.params[0]?.localId ?? null;
  const isThisRef = (e: IrExpr, thisId: string | null): boolean => {
    if (thisId === null) return false;
    if (e.kind === "varRef") return e.localId === thisId;
    if (e.kind === "upcast") return isThisRef(e.value, thisId);
    if (e.kind === "seqExpr") return isThisRef(e.result, thisId);
    return false;
  };

  // Constructors reached with a receiver that may not be fresh.
  const reused = new Set<string>();
  const markReused = (name: string): void => {
    for (let c: string | undefined = name; c !== undefined && classes.has(c);) {
      if (reused.has(c)) break;
      reused.add(c);
      c = classes.get(c)!.base;
    }
  };
  const scan = nodes?.scan(CONSTRUCTOR_USE_KINDS);
  for (const fn of mod.functions) {
    const own = ctorClass.get(fn.name);
    const thisId = own !== undefined ? thisOf(own) : null;
    const baseCtor =
      own !== undefined && classes.get(own)!.base !== undefined
        ? `%${classes.get(own)!.base}.constructor`
        : null;
    eachNodeOfKinds(fn, scan, (node) => {
      if (node.kind === "call") {
        const target = ctorClass.get(node.callee);
        if (
          target !== undefined &&
          !(node.callee === baseCtor && node.args.length > 0 && isThisRef(node.args[0]!, thisId))
        )
          markReused(target);
      } else if (node.kind === "closure") {
        const target = ctorClass.get(node.fnName);
        if (target !== undefined) markReused(target);
      }
    });
  }

  // The first escaping statement of each constructor (body length: none).
  // A class without a constructor function of its own (runtime roots) is
  // treated as escaping at once.
  const points = new Map<string, number>();
  const escapePoint = (name: string): number => {
    const known = points.get(name);
    if (known !== undefined) return known;
    const fn = fnByName.get(`%${name}.constructor`);
    const base = classes.get(name)?.base;
    const thisId = thisOf(name);
    const point =
      fn === undefined || thisId === null || classes.get(name)?.runtime === true
        ? 0
        : constructorEscapePoint(fn, thisId, base !== undefined ? `%${base}.constructor` : null);
    points.set(name, point);
    return point;
  };
  const ancestorEscapes = (name: string): boolean => {
    for (let c = classes.get(name)?.base; c !== undefined; c = classes.get(c)?.base) {
      const fn = fnByName.get(`%${c}.constructor`);
      if (!classes.has(c) || fn === undefined || escapePoint(c) < fn.body.length) return true;
    }
    return false;
  };

  for (const [name] of classes) {
    const fn = fnByName.get(`%${name}.constructor`);
    if (fn === undefined || reused.has(name) || ancestorEscapes(name)) continue;
    const point = escapePoint(name);
    if (point === 0) continue;
    const aliases = constructorThisAliases(fn, thisOf(name)!);
    const isOwn = (e: IrExpr): boolean =>
      (e.kind === "varRef" && aliases.has(e.localId)) ||
      (e.kind === "upcast" && isOwn(e.value)) ||
      (e.kind === "seqExpr" && isOwn(e.result));
    const expr = (e: IrExpr): boolean => everyExprChild(e, expr, stmt);
    const stmt = (s: IrStmt): boolean => {
      if (s.kind === "fieldSet" && isOwn(s.obj)) facts.privateStores.add(s);
      return everyStmtChild(s, expr, stmt);
    };
    for (let i = 0; i < point; i++) stmt(fn.body[i]!);
  }
  return facts;
}

/** The nodes that write a binding: statement and expression assignments. */
const ASSIGNMENT_KINDS: readonly IrNodeKind[] = ["assign", "assignExpr"];

/** Module constants whose value never changes once initialized: immutable,
 * not TDZ-checked (every read follows the initialization), no import-cycle
 * init flag, and at most one assignment in the whole module. Such a global
 * owns its value for the rest of the program, so a read of it can be
 * borrowed across any later operand or call. */
export function stableGlobals(mod: IrModule, nodes?: IrNodeIndex): Set<string> {
  const candidates = new Set(
    (mod.globals ?? [])
      .filter((g) => !g.mutable && g.tdz !== true && g.initFlag === undefined)
      .map((g) => g.id),
  );
  const assigned = new Set<string>();
  const scan = nodes?.scan(ASSIGNMENT_KINDS);
  for (const fn of mod.functions) {
    if (candidates.size === 0) break;
    eachNodeOfKinds(fn, scan, (node) => {
      if (node.kind === "assignExpr" && candidates.has(node.localId))
        candidates.delete(node.localId);
      else if (node.kind === "assign" && candidates.has(node.localId)) {
        if (assigned.has(node.localId)) candidates.delete(node.localId);
        assigned.add(node.localId);
      }
    });
  }
  return candidates;
}
