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
import {
  BOOL,
  DYN,
  F64,
  NULL_T,
  STRING,
  UNDEFINED_T,
  isSupportedArrayElem,
  sortArms,
  typeKey,
  type IrType,
} from "../ir/ir.js";
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
  /** The form holds an array whose elements are generators (iterators map
   * to the same kind), which have no array storage. */
  generatorArray?: boolean;
  /** Set by the caller: such an array maps to an array type all the same.
   * No value of that type can be built, so every use of one is refused
   * (generator-arrays.ts). */
  generatorArraysMap?: boolean;
}

/** The structural mappings one walk has finished: by object node, then by
 * the depth the node was reached at. Canonical nodes intern by checker type
 * (canon.ts), so a recursive type reaches its own node again and a type many
 * members share is one node however many paths lead to it. The depth is
 * part of the key because MAX_DEPTH cuts a mapping off at a distance that
 * depends on it. */
type CanonWalk = Map<Canon, (IrType | null | undefined)[]>;

/** The IR type of a canonical node, or null when no rule applies.
 *
 * An object node maps once per depth in one walk. Without that, a recursive
 * type is mapped again along every path that leads back to it, down to
 * MAX_DEPTH: (members leading back)^MAX_DEPTH mappings of the same nodes,
 * each with the same answer. */
export function mapCanonical(
  c: Canon,
  ctx: TypeMapperCtx,
  depth = 0,
  notes?: CanonMapNotes,
): IrType | null {
  return mapCanonicalAt(c, ctx, depth, notes, new Map());
}

function mapCanonicalAt(
  c: Canon,
  ctx: TypeMapperCtx,
  depth: number,
  notes: CanonMapNotes | undefined,
  walk: CanonWalk,
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
      const elem = mapCanonicalAt(c.elem, ctx, depth + 1, notes, walk);
      if (elem === null || elem.kind === "void") return null;
      if (elem.kind === "generator" && notes !== undefined) {
        notes.generatorArray = true;
        if (notes.generatorArraysMap === true) return { kind: "array", elem };
      }
      // A type that is itself an array of checked-dynamic elements is the
      // checked-dynamic value, as mapType maps `unknown[]`: an `any[]` value
      // is held that way wherever it comes from, so a native array of
      // untyped elements here would make every slot of the type a copy of
      // the value it receives. Only the type itself: an `any[]` inside a
      // shape (a record's field) keeps its array of untyped elements, the
      // layout the record has without this rule, which a declaration that
      // keeps an existing record's layout shares with it.
      if (elem.kind === "dyn" && depth === 0) {
        if (notes !== undefined) notes.collapsedToDynamic = true;
        return DYN;
      }
      // The storage contract mapType's array rule applies: an element kind
      // without array storage (a generator, an opaque handle) has no array.
      return isSupportedArrayElem(elem) ? { kind: "array", elem } : null;
    }
    case "union": {
      const byKey = new Map<string, IrType>();
      for (const arm of c.arms) {
        const mapped = mapCanonicalAt(arm, ctx, depth + 1, notes, walk);
        if (mapped === null || mapped.kind === "void") return null;
        if (mapped.kind === "union") {
          const def = ctx.unions.get(mapped.unionId);
          if (def === undefined) return null;
          for (const a of def.arms) byKey.set(typeKey(a), a);
        } else byKey.set(typeKey(mapped), mapped);
      }
      const arms = [...byKey.values()];
      if (arms.length === 1) return arms[0]!;
      // An arm of a union that is the type itself is that type for the array
      // rule above: `any[] | undefined` holds the value `any[]` holds, so it
      // is the checked-dynamic value too, as `unknown[] | undefined` is. An
      // array arm of a union inside a shape keeps its layout, as there.
      if (
        arms.some(
          (a) => a.kind === "dyn" || (depth === 0 && a.kind === "array" && a.elem.kind === "dyn"),
        )
      ) {
        if (notes !== undefined) notes.collapsedToDynamic = true;
        return DYN;
      }
      sortArms(arms);
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
      let atDepth = walk.get(c);
      if (atDepth === undefined) walk.set(c, (atDepth = []));
      const finished = atDepth[depth];
      if (finished !== undefined) return finished;
      const structural = mapCanonicalRecord(props, ctx, depth, notes, walk);
      // An object whose members do not map structurally (an interface over
      // Map or Set, methods) keeps its per-type recognition.
      const mapped = structural ?? viaChecker();
      atDepth[depth] = mapped;
      return mapped;
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
  walk: CanonWalk,
): IrType | null {
  const fields: { name: string; type: IrType; optional?: true }[] = [];
  for (const p of props) {
    let t = mapCanonicalAt(p.type(), ctx, depth + 1, notes, walk);
    if (t === null) return null;
    let absentable = false;
    if (p.optional) {
      if (t.kind === "dyn") absentable = true;
      else {
        const armed = withUndefinedArm(t, ctx.unions);
        if (armed === null) return null;
        t = armed;
      }
    }
    fields.push({ name: p.name, type: t, ...(absentable ? { optional: true as const } : {}) });
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
