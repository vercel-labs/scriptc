import type { IrExpr, IrFunction, IrModule, IrStmt, IrType } from "../ir/ir.js";
import { RUNTIME_EMITTER_CLASS, RUNTIME_STREAM_CLASSES, typeKey } from "../ir/ir.js";
import { dynamicFieldStores, type DynamicFieldStores } from "../ir/int32-slots.js";
import { everyExprChild, everyStmtChild, everyTypeChild } from "../ir/traverse.js";
import { resultSlotStore } from "./result-slots.js";

/** Which shape fields can be written after their object escapes.
 *
 * The cycle analysis treats a reference edge as IMMUTABLE when the program
 * can only store into it while the owning object is still private to its
 * construction. Every heap cycle then needs at least one mutable edge:
 * an object can only point through immutable edges to objects that existed
 * before it. The facts are derived from the final IR, never from TypeScript
 * `readonly` (records intern structurally, and casts, `any`, and helper
 * functions all reach the same field stores), and they are deliberately
 * conservative:
 *
 * - every `fieldSet` outside a constructor's own `this`, `fieldIncDec`, and
 *   `recordSet` makes its (unit, field) mutable; `recordKeySet` on declared
 *   fields and `recordKeyDelete` make the whole record mutable;
 * - a result-slot entry's stores into its destination (result-slots.ts) are
 *   not writes: the destination is frame storage of a caller that only
 *   projects the value, so no object can point to it and its fields cannot
 *   lie on a cycle;
 * - a constructor's stores into its own `this` are construction-only up to
 *   the first top-level statement in which `this` escapes (any use other
 *   than a field store target, a field read, or the receiver of the direct
 *   base constructor call — including closure and class captures); stores
 *   from there on, and all stores of a constructor whose ancestor
 *   constructor let `this` escape, are writes. Any other call to a
 *   constructor function makes its whole hierarchy mutable;
 * - every type that can cross into the checked-dynamic world (operands of
 *   `dynFrom`, including boxed closure signatures, thrown values, and
 *   arguments of library/intrinsic/JSON/FFI calls) makes its entire type
 *   closure mutable, because typed-ref capsules commit dynamic mutations
 *   straight into native fields — unless the program contains no runtime
 *   store into a dynamic value at all (int32-slots' dynamicFieldStores),
 *   in which case no commit can happen; FFI operands and intrinsics other
 *   than publish always count;
 * - a `dynCheck` converts a dynamic value into its target type, and the
 *   builder of a record shape that reaches itself stores into the record
 *   after converting its members, which may be the record itself or an
 *   ancestor when the dynamic value is cyclic: every such record shape in
 *   the target's type closure is mutable;
 * - runtime-rooted hierarchies (errors, emitters, streams) are mutable;
 * - library builds disable the refinement.
 *
 * Keys: `object:<hierarchy root>` / `record:<id>` units, fields as
 * `<unit>\0<field>`. */
export interface CycleMutability {
  /** Every edge is mutable (the refinement is disabled for this module). */
  all: boolean;
  /** No runtime store into a dynamic value exists, so the hidden property
   * bags of classes (DYN_CLASS_PROPERTIES) stay empty: they hold no
   * references. */
  emptyPropertyBags: boolean;
  /** Units whose every field is mutable. */
  units: Set<string>;
  /** Individually mutable fields. */
  fields: Set<string>;
}

/** Expressions whose operands may be converted to checked-dynamic values
 * (typed-ref capsules) by the backend or runtime. */
const DYNAMIC_BOUNDARY_EXPRS = new Set<string>([
  "dynFrom",
  "libCall",
  "intrinsic",
  "jsonStringify",
  "ffiCall",
]);

export function fieldKey(unit: string, field: string): string {
  return `${unit}\0${field}`;
}

/** The cycle unit of a class: `object:<root>`, the root of its hierarchy,
 * as computeImmutableFields and computeTraced group classes. */
export function hierarchyUnitOfClass(mod: IrModule): (className: string) => string {
  const baseOf = new Map((mod.classes ?? []).map((c) => [c.name, c.base ?? null] as const));
  const roots = new Map<string, string>();
  return (name) => {
    const known = roots.get(name);
    if (known !== undefined) return `object:${known}`;
    let cur = name;
    for (let base = baseOf.get(cur); base !== null && base !== undefined; base = baseOf.get(cur))
      cur = base;
    roots.set(name, cur);
    return `object:${cur}`;
  };
}

export function computeCycleMutability(
  mod: IrModule,
  unitOfClass: (className: string) => string,
  stores?: DynamicFieldStores,
): CycleMutability {
  const result: CycleMutability = {
    all: false,
    emptyPropertyBags: false,
    units: new Set(),
    fields: new Set(),
  };
  if (mod.lib !== undefined) return { ...result, all: true };
  const classes = mod.classes ?? [];
  const recordsById = new Map((mod.records ?? []).map((r) => [r.id, r] as const));
  const unionsById = new Map((mod.unions ?? []).map((u) => [u.id, u] as const));
  const ctorOf = new Map<string, (typeof classes)[number]>(
    classes.map((c) => [`%${c.name}.constructor`, c]),
  );

  for (const c of classes) {
    if (c.runtime || c.name === RUNTIME_EMITTER_CLASS || RUNTIME_STREAM_CLASSES.has(c.name))
      result.units.add(unitOfClass(c.name));
  }

  // A typed-ref capsule writes into its native object only when a runtime
  // store into the capsule commits (dynamicFieldStores audits which helpers
  // can store; a commit rewrites every field, reference fields possibly
  // with fresh conversions). Without any such store in the program,
  // crossing into checked-dynamic code writes nothing. FFI calls and
  // intrinsics other than publish (which only marks objects immortal), the
  // intern-table operations (which store published values) and ThreadSlots
  // reads stay conservative.
  const dynStores = stores ?? dynamicFieldStores(mod);
  const dynamicStores = dynStores.all || dynStores.names.size > 0;
  result.emptyPropertyBags = !dynamicStores;
  const boundaryWrites = (e: IrExpr): boolean =>
    dynamicStores ||
    e.kind === "ffiCall" ||
    (e.kind === "intrinsic" &&
      e.name !== "threads.publish" &&
      !e.name.startsWith("itable.") &&
      e.name !== "slots.get" &&
      e.name !== "slots.has");

  // Types that can become checked-dynamic values: mark their whole closure.
  const exposedTypes = new Set<string>();
  const expose = (root: IrType): void => {
    const stack: IrType[] = [root];
    while (stack.length > 0) {
      const t = stack.pop()!;
      if (t.kind === "object" || t.kind === "classval") {
        const unit = unitOfClass(t.className);
        if (exposedTypes.has(unit)) continue;
        exposedTypes.add(unit);
        result.units.add(unit);
        for (const c of classes)
          if (unitOfClass(c.name) === unit) for (const f of c.fields) stack.push(f.type);
      } else if (t.kind === "record") {
        const unit = `record:${t.shapeId}`;
        if (exposedTypes.has(unit)) continue;
        exposedTypes.add(unit);
        result.units.add(unit);
        const shape = recordsById.get(t.shapeId);
        for (const f of shape?.fields ?? []) stack.push(f.type);
        if (shape?.indexValue !== undefined) stack.push(shape.indexValue);
      } else if (t.kind === "union") {
        const key = `union:${t.unionId}`;
        if (exposedTypes.has(key)) continue;
        exposedTypes.add(key);
        for (const arm of unionsById.get(t.unionId)?.arms ?? []) stack.push(arm);
      } else {
        everyTypeChild(t, (child) => {
          stack.push(child);
          return true;
        });
      }
    }
  };

  // Record shapes a dynCheck conversion can build with a cycle: those
  // that reach themselves through fields, index values, union arms and
  // containers.
  const children = (t: IrType): IrType[] => {
    if (t.kind === "record") {
      const shape = recordsById.get(t.shapeId);
      const fields = (shape?.fields ?? []).map((f) => f.type);
      return shape?.indexValue !== undefined ? [...fields, shape.indexValue] : fields;
    }
    if (t.kind === "union") return [...(unionsById.get(t.unionId)?.arms ?? [])];
    const out: IrType[] = [];
    everyTypeChild(t, (child) => {
      out.push(child);
      return true;
    });
    return out;
  };
  const selfReaching = new Map<string, boolean>();
  const reachesItself = (shapeId: string): boolean => {
    const known = selfReaching.get(shapeId);
    if (known !== undefined) return known;
    const root: IrType = { kind: "record", shapeId };
    const key = typeKey(root);
    const seen = new Set<string>();
    const stack = children(root);
    let found = false;
    while (stack.length > 0 && !found) {
      const t = stack.pop()!;
      const k = typeKey(t);
      if (k === key) found = true;
      else if (!seen.has(k)) {
        seen.add(k);
        stack.push(...children(t));
      }
    }
    selfReaching.set(shapeId, found);
    return found;
  };
  const checkedTypes = new Set<string>();
  const checkInto = (root: IrType): void => {
    const stack: IrType[] = [root];
    while (stack.length > 0) {
      const t = stack.pop()!;
      const k = typeKey(t);
      if (checkedTypes.has(k)) continue;
      checkedTypes.add(k);
      if (t.kind === "record" && reachesItself(t.shapeId)) result.units.add(`record:${t.shapeId}`);
      stack.push(...children(t));
    }
  };

  // Constructor stores are construction-only until `this` first escapes:
  // stores from the escaping statement on, and every store of a
  // constructor whose ancestor constructor already let `this` escape, are
  // ordinary writes.
  const fnByName = new Map(mod.functions.map((fn) => [fn.name, fn] as const));
  const classByName = new Map(classes.map((c) => [c.name, c] as const));
  const escapePoints = new Map<string, number>();
  /** The constructor's escape point; 0 without an analyzable constructor. */
  const escapePoint = (name: string): number => {
    const known = escapePoints.get(name);
    if (known !== undefined) return known;
    const fn = fnByName.get(`%${name}.constructor`);
    const cls = classByName.get(name);
    const thisId = fn?.params[0]?.localId;
    const base = cls?.base !== undefined ? `%${cls.base}.constructor` : null;
    const point =
      fn === undefined || cls === undefined || thisId === undefined
        ? 0
        : constructorEscapePoint(fn, thisId, base);
    escapePoints.set(name, point);
    return point;
  };
  const escapes = (name: string): boolean => {
    const fn = fnByName.get(`%${name}.constructor`);
    // A program class without a constructor function runs no code at construction. Generic
    // classes are such bases: their instantiations name them as their base.
    if (fn === undefined && classByName.get(name)?.runtime !== true) return false;
    return escapePoint(name) < (fn?.body.length ?? 1);
  };
  const ancestorEscaped = (name: string): boolean => {
    for (let c = classByName.get(name)?.base; c !== undefined; c = classByName.get(c)?.base)
      if (escapes(c)) return true;
    return false;
  };
  let privateUntil = 0;
  let topLevel = 0;

  let aliases = new Set<string>();
  const isThisRef = (e: IrExpr, thisId: string | null): boolean => {
    if (thisId === null) return false;
    if (e.kind === "varRef") return aliases.has(e.localId);
    if (e.kind === "upcast") return isThisRef(e.value, thisId);
    if (e.kind === "seqExpr") return isThisRef(e.result, thisId);
    return false;
  };

  for (const fn of mod.functions) {
    const ctorClass = ctorOf.get(fn.name);
    const thisId = ctorClass !== undefined ? (fn.params[0]?.localId ?? null) : null;
    aliases = thisId !== null ? constructorThisAliases(fn, thisId) : new Set();
    privateUntil =
      ctorClass !== undefined && thisId !== null && !ancestorEscaped(ctorClass.name)
        ? escapePoint(ctorClass.name)
        : 0;
    const baseCtor = ctorClass?.base !== undefined ? `%${ctorClass.base}.constructor` : null;
    const expr = (e: IrExpr): boolean => {
      if (DYNAMIC_BOUNDARY_EXPRS.has(e.kind) && boundaryWrites(e)) {
        everyExprChild(
          e,
          (child) => {
            expose(child.type);
            return true;
          },
          () => true,
        );
      }
      switch (e.kind) {
        case "dynCheck":
          checkInto(e.type);
          break;
        case "fieldIncDec":
          result.fields.add(fieldKey(unitOfClass(e.className), e.field));
          break;
        case "call": {
          const target = ctorOf.get(e.callee);
          if (
            target !== undefined &&
            !(e.callee === baseCtor && e.args.length > 0 && isThisRef(e.args[0]!, thisId))
          )
            result.units.add(unitOfClass(target.name));
          break;
        }
        case "closure": {
          const target = ctorOf.get(e.fnName);
          if (target !== undefined) result.units.add(unitOfClass(target.name));
          break;
        }
      }
      return everyExprChild(e, expr, stmt);
    };
    const stmt = (s: IrStmt): boolean => {
      switch (s.kind) {
        case "fieldSet":
          if (!isThisRef(s.obj, thisId) || topLevel >= privateUntil)
            result.fields.add(fieldKey(unitOfClass(s.className), s.field));
          break;
        case "recordSet":
          if (!resultSlotStore(fn.name, s))
            result.fields.add(fieldKey(`record:${s.shapeId}`, s.field));
          break;
        case "recordKeySet":
          if (s.overflowOnly !== true) result.units.add(`record:${s.shapeId}`);
          break;
        case "recordKeyDelete":
          result.units.add(`record:${s.shapeId}`);
          break;
        case "throw":
          if (dynamicStores) expose(s.value.type);
          break;
      }
      return everyStmtChild(s, expr, stmt);
    };
    for (topLevel = 0; topLevel < fn.body.length; topLevel++) stmt(fn.body[topLevel]!);
  }
  return result;
}

/** The locals of a constructor that always hold its `this`: the parameter
 * itself plus immutable locals declared with a `this` initializer and never
 * assigned (the receiver temporaries of compound field assignments). */
export function constructorThisAliases(fn: IrFunction, thisId: string): Set<string> {
  const aliases = new Set([thisId]);
  const immutable = new Set(fn.locals.filter((l) => !l.mutable).map((l) => l.id));
  const assigned = new Set<string>();
  const candidates: string[] = [];
  const isThisParam = (e: IrExpr): boolean =>
    (e.kind === "varRef" && e.localId === thisId) ||
    (e.kind === "upcast" && isThisParam(e.value)) ||
    (e.kind === "seqExpr" && isThisParam(e.result));
  const expr = (e: IrExpr): boolean => everyExprChild(e, expr, stmt);
  const stmt = (s: IrStmt): boolean => {
    if (s.kind === "assign") assigned.add(s.localId);
    if (s.kind === "varDecl" && s.init !== null && immutable.has(s.localId) && isThisParam(s.init))
      candidates.push(s.localId);
    return everyStmtChild(s, expr, stmt);
  };
  fn.body.every(stmt);
  for (const id of candidates) if (!assigned.has(id)) aliases.add(id);
  return aliases;
}

/** The index of the first top-level statement of a constructor body in
 * which `this` can be observed by anything other than the constructor's own
 * field stores and reads (the body length when it never is). Statements run
 * in order, so every store in an earlier statement completes while the
 * object is still private. Within and after the escaping statement nothing
 * is private any more. */
export function constructorEscapePoint(
  fn: IrFunction,
  thisId: string,
  baseCtor: string | null,
): number {
  let escaped = false;
  const aliases = constructorThisAliases(fn, thisId);
  const isThisRef = (e: IrExpr): boolean =>
    (e.kind === "varRef" && aliases.has(e.localId)) ||
    (e.kind === "upcast" && isThisRef(e.value)) ||
    (e.kind === "seqExpr" && isThisRef(e.result));
  // The non-`this` parts of a `this`-valued wrapper (seqExpr statements).
  const wrapper = (e: IrExpr): boolean => {
    if (e.kind === "upcast") return wrapper(e.value);
    if (e.kind === "seqExpr") return e.stmts.every(stmt) && wrapper(e.result);
    return true;
  };
  const expr = (e: IrExpr): boolean => {
    if (e.kind === "varRef" && aliases.has(e.localId)) {
      escaped = true;
      return false;
    }
    // Closures and class references are the expressions that capture locals.
    if (
      (e.kind === "closure" || e.kind === "classRef") &&
      (e.captures ?? []).some((id) => aliases.has(id))
    ) {
      escaped = true;
      return false;
    }
    if (e.kind === "fieldGet" && isThisRef(e.obj)) return wrapper(e.obj);
    if (
      e.kind === "call" &&
      baseCtor !== null &&
      e.callee === baseCtor &&
      e.args.length > 0 &&
      isThisRef(e.args[0]!)
    )
      return wrapper(e.args[0]!) && e.args.slice(1).every(expr);
    return everyExprChild(e, expr, stmt);
  };
  const stmt = (s: IrStmt): boolean => {
    if (s.kind === "fieldSet" && isThisRef(s.obj)) return wrapper(s.obj) && expr(s.value);
    if (s.kind === "exprStmt" && isThisRef(s.expr)) return wrapper(s.expr);
    // Declaring an alias is not an escape; its uses are checked like `this`.
    if (s.kind === "varDecl" && aliases.has(s.localId) && s.init !== null) return wrapper(s.init);
    return everyStmtChild(s, expr, stmt);
  };
  for (let i = 0; i < fn.body.length; i++) {
    stmt(fn.body[i]!);
    if (escaped) return i;
  }
  return fn.body.length;
}
