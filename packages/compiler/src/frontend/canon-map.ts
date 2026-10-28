/* Canonical mapping (localized-failure design §4.3), stage N1: the IR type
 * of a canonical node, built from about ten structural rules plus the
 * nominal table. Nominal objects (classes, standard-library interfaces,
 * handles), callables, index-signature shapes, tuples, bigint and symbol
 * keep their per-type recognitions: they map through mapType on the
 * checker type the node came from. Everything structural (primitives,
 * literals, units, arrays, flat unions, plain records) maps here, from the
 * canonical form alone.
 *
 * Shadow mode (SCRIPTC_CANON_SHADOW=1) compares this mapping with mapType
 * for every successful top-level mapping and appends one JSON line per
 * comparison to SCRIPTC_CANON_SHADOW_OUT. It maps into throwaway
 * registries, so the program's own IR is untouched. */
import { appendFileSync } from "node:fs";
import { BOOL, DYN, F64, NULL_T, STRING, UNDEFINED_T, typeKey, type IrType } from "../ir/ir.js";
import { canonKey, Normalizer, type Canon, type CanonProp } from "./canon.js";
import * as ts from "./ts7/adapter.js";
import {
  mapType,
  ShapeRegistry,
  UnionRegistry,
  withUndefinedArm,
  type TypeMapperCtx,
} from "./type-mapper.js";

const MAX_DEPTH = 24;

/** What a mapping did besides its result. */
export interface CanonMapNotes {
  /** A union in the form mapped to the checked dynamic because an arm
   * did (`string | {}`): the result holds a dynamic part the form did not
   * spell as `unknown`. */
  collapsedToDynamic: boolean;
}

/** The IR type of a canonical node, or null when no rule applies. */
export function mapCanonical(
  c: Canon,
  ctx: TypeMapperCtx,
  depth = 0,
  notes?: CanonMapNotes,
): IrType | null {
  if (depth > MAX_DEPTH) return null;
  const viaChecker = (): IrType | null => (c.src === undefined ? null : mapType(c.src, ctx));
  switch (c.k) {
    case "prim":
      return c.p === "number"
        ? F64
        : c.p === "string"
          ? STRING
          : c.p === "boolean"
            ? BOOL
            : viaChecker();
    case "lit":
      return typeof c.value === "number" ? F64 : typeof c.value === "string" ? STRING : BOOL;
    case "unit":
      return c.u === "undefined" ? UNDEFINED_T : c.u === "null" ? NULL_T : viaChecker();
    case "top":
      return DYN;
    case "param":
      // A class's type parameters bind at IR level only (a generic class
      // instance's bindings); the lowerer's resolver answers them.
      // `this` in a class body is the class itself: the nominal table.
      if (c.src === undefined) return null;
      if ((c.src as { isThisType?: boolean }).isThisType === true) return viaChecker();
      return ctx.resolveTypeParam?.(c.src) ?? null;
    case "opaque":
    case "tuple":
      return viaChecker();
    case "array": {
      const elem = mapCanonical(c.elem, ctx, depth + 1, notes);
      return elem === null ? null : { kind: "array", elem };
    }
    case "union": {
      const byKey = new Map<string, IrType>();
      for (const arm of c.arms) {
        const mapped = mapCanonical(arm, ctx, depth + 1, notes);
        if (mapped === null || mapped.kind === "void") return null;
        if (mapped.kind === "union") {
          const def = ctx.unions.get(mapped.unionId);
          if (def === undefined) return null;
          for (const a of def.arms) byKey.set(typeKey(a), a);
        } else byKey.set(typeKey(mapped), mapped);
      }
      const arms = [...byKey.values()];
      if (arms.length === 1) return arms[0]!;
      if (arms.some((a) => a.kind === "dyn")) {
        if (notes !== undefined) notes.collapsedToDynamic = true;
        return DYN;
      }
      arms.sort((a, b) => (typeKey(a) < typeKey(b) ? -1 : 1));
      return { kind: "union", unionId: ctx.unions.intern(arms) };
    }
    case "obj": {
      if (c.nominal !== undefined || c.call().length > 0 || c.construct().length > 0)
        return viaChecker();
      if (c.index().length > 0) return viaChecker();
      const props = c.props();
      // Accessor members are closure slots (`%get:x`, `%set:x`), and a
      // getter and setter of different types have no single slot type:
      // mapType's rules decide them, not a data field of the read type.
      if (props.some((p) => p.accessor)) return viaChecker();
      // `{}` holds any non-nullish value: the checked dynamic, as mapType.
      if (props.length === 0) return DYN;
      const structural = mapCanonicalRecord(props, ctx, depth, notes);
      // An object whose members do not map structurally (an interface over
      // Map or Set, methods) keeps its per-type recognition.
      return structural ?? viaChecker();
    }
  }
}

/** A plain record from an object's canonical members, or null when a
 * member does not map. */
function mapCanonicalRecord(
  props: readonly CanonProp[],
  ctx: TypeMapperCtx,
  depth: number,
  notes: CanonMapNotes | undefined,
): IrType | null {
  const fields: { name: string; type: IrType }[] = [];
  for (const p of props) {
    let t = mapCanonical(p.type(), ctx, depth + 1, notes);
    if (t === null) return null;
    if (p.optional && t.kind !== "dyn") {
      const armed = withUndefinedArm(t, ctx.unions);
      if (armed === null) return null;
      t = armed;
    }
    fields.push({ name: p.name, type: t });
  }
  const declaredOrder = fields.map((f) => f.name);
  fields.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { kind: "record", shapeId: ctx.shapes.intern(fields, false, undefined, declaredOrder) };
}

export type ShadowStatus = "equal" | "diverge" | "canon-fail";

/** Installs nothing unless SCRIPTC_CANON_SHADOW=1: the hook mapType calls
 * after each successful top-level mapping. */
export function canonShadowHook(
  checker: ts.TypeChecker,
): ((type: ts.Type, mapped: IrType, ctx: TypeMapperCtx) => void) | undefined {
  if (process.env["SCRIPTC_CANON_SHADOW"] !== "1") return undefined;
  const out = process.env["SCRIPTC_CANON_SHADOW_OUT"];
  let busy = false;
  return (type, mapped, ctx) => {
    if (busy) return;
    busy = true;
    // The shadow records and must never break a compile.
    try {
      const resolve = ctx.resolveTypeParamTs;
      const normalizer = new Normalizer(checker);
      const c = normalizer.canon(type, resolve ? (t) => resolve(t) : new Map());
      const { typeMemo: _memo, canonShadow: _hook, ...rest } = ctx;
      const shadowCtx: TypeMapperCtx = {
        ...rest,
        shapes: new ShapeRegistry(),
        unions: new UnionRegistry(),
        canMemoizeType: () => false,
      };
      let canonical: IrType | null = null;
      try {
        canonical = mapCanonical(c, shadowCtx);
      } catch {
        canonical = null;
      }
      const status: ShadowStatus =
        canonical === null
          ? "canon-fail"
          : typeKey(canonical) === typeKey(mapped)
            ? "equal"
            : "diverge";
      if (out !== undefined)
        appendFileSync(
          out,
          `${JSON.stringify({
            status,
            kind: c.k,
            type: checker.typeToString(type).slice(0, 160),
            canon: canonKey(c).slice(0, 160),
            strict: typeKey(mapped),
            ...(canonical !== null ? { canonical: typeKey(canonical) } : {}),
          })}\n`,
        );
    } catch {
      // A census line lost, nothing else.
    } finally {
      busy = false;
    }
  };
}
