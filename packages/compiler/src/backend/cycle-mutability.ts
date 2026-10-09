import type { IrExpr, IrFunction, IrModule, IrStmt, IrType } from "../ir/ir.js";
import { RUNTIME_EMITTER_CLASS, RUNTIME_STREAM_CLASSES } from "../ir/ir.js";
import { everyExprChild, everyModuleNode, everyStmtChild, everyTypeChild } from "../ir/traverse.js";

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
 * - a constructor in which `this` escapes (any use other than a field store
 *   target, a field read, or the receiver of the direct base constructor
 *   call — including closure and class captures) makes its whole hierarchy
 *   mutable, as does any other call to a constructor function;
 * - every type that can cross into the checked-dynamic world (operands of
 *   `dynFrom`, including boxed closure signatures, thrown values, and
 *   arguments of library/intrinsic/JSON/FFI calls) makes its entire type
 *   closure mutable, because typed-ref capsules commit dynamic mutations
 *   straight into native fields;
 * - runtime-rooted hierarchies (errors, emitters, streams) are mutable;
 * - library builds and dynamic-island programs disable the refinement.
 *
 * Keys: `object:<hierarchy root>` / `record:<id>` units, fields as
 * `<unit>\0<field>`. */
export interface CycleMutability {
  /** Every edge is mutable (the refinement is disabled for this module). */
  all: boolean;
  /** Units whose every field is mutable. */
  units: Set<string>;
  /** Individually mutable fields. */
  fields: Set<string>;
}

const DYNAMIC_ISLAND_EXPRS = new Set<string>([
  "jsMarshal",
  "jsOp",
  "jsExit",
  "jsBridgePromise",
  "dynFromJsval",
]);

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

export function computeCycleMutability(
  mod: IrModule,
  unitOfClass: (className: string) => string,
): CycleMutability {
  const result: CycleMutability = { all: false, units: new Set(), fields: new Set() };
  if (mod.lib !== undefined) return { ...result, all: true };
  const classes = mod.classes ?? [];
  const recordsById = new Map((mod.records ?? []).map((r) => [r.id, r] as const));
  const unionsById = new Map((mod.unions ?? []).map((u) => [u.id, u] as const));
  const ctorOf = new Map<string, (typeof classes)[number]>(
    classes.map((c) => [`%${c.name}.constructor`, c]),
  );

  // The dynamic island stores engine values in native slots and can reach
  // any object through them: no refinement.
  let island = false;
  everyModuleNode(mod, {
    expr: (e) => !(island = island || DYNAMIC_ISLAND_EXPRS.has(e.kind)),
    stmt: () => true,
    type: (t) => !(island = island || t.kind === "jsval"),
  });
  if (island) return { ...result, all: true };

  for (const c of classes) {
    if (c.runtime || c.name === RUNTIME_EMITTER_CLASS || RUNTIME_STREAM_CLASSES.has(c.name))
      result.units.add(unitOfClass(c.name));
  }

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

  const isThisRef = (e: IrExpr, thisId: string | null): boolean => {
    if (thisId === null) return false;
    if (e.kind === "varRef") return e.localId === thisId;
    if (e.kind === "upcast") return isThisRef(e.value, thisId);
    if (e.kind === "seqExpr") return isThisRef(e.result, thisId);
    return false;
  };

  for (const fn of mod.functions) {
    const ctorClass = ctorOf.get(fn.name);
    const thisId = ctorClass !== undefined ? (fn.params[0]?.localId ?? null) : null;
    const baseCtor = ctorClass?.base !== undefined ? `%${ctorClass.base}.constructor` : null;
    const expr = (e: IrExpr): boolean => {
      if (DYNAMIC_BOUNDARY_EXPRS.has(e.kind)) {
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
          if (!isThisRef(s.obj, thisId))
            result.fields.add(fieldKey(unitOfClass(s.className), s.field));
          break;
        case "recordSet":
          result.fields.add(fieldKey(`record:${s.shapeId}`, s.field));
          break;
        case "recordKeySet":
          if (s.overflowOnly !== true) result.units.add(`record:${s.shapeId}`);
          break;
        case "recordKeyDelete":
          result.units.add(`record:${s.shapeId}`);
          break;
        case "throw":
          expose(s.value.type);
          break;
      }
      return everyStmtChild(s, expr, stmt);
    };
    fn.body.every(stmt);
    if (ctorClass !== undefined && thisId !== null && constructorEscapes(fn, thisId, baseCtor))
      result.units.add(unitOfClass(ctorClass.name));
  }
  return result;
}

/** Whether `this` can be observed by anything other than the constructor's
 * own field stores before construction completes. Flow-insensitive: any
 * escape anywhere in the body counts. */
function constructorEscapes(fn: IrFunction, thisId: string, baseCtor: string | null): boolean {
  let escaped = false;
  const isThisRef = (e: IrExpr): boolean =>
    (e.kind === "varRef" && e.localId === thisId) ||
    (e.kind === "upcast" && isThisRef(e.value)) ||
    (e.kind === "seqExpr" && isThisRef(e.result));
  // The non-`this` parts of a `this`-valued wrapper (seqExpr statements).
  const wrapper = (e: IrExpr): boolean => {
    if (e.kind === "upcast") return wrapper(e.value);
    if (e.kind === "seqExpr") return e.stmts.every(stmt) && wrapper(e.result);
    return true;
  };
  const expr = (e: IrExpr): boolean => {
    if (e.kind === "varRef" && e.localId === thisId) {
      escaped = true;
      return false;
    }
    // Closures and class references are the expressions that capture locals.
    if ((e.kind === "closure" || e.kind === "classRef") && (e.captures ?? []).includes(thisId)) {
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
    return everyStmtChild(s, expr, stmt);
  };
  fn.body.every(stmt);
  return escaped;
}
