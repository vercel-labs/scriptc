import { planRecordUnionLift, planRecordUnionWrap } from "../union-retag.js";
import type { WidthLift } from "../width-lift.js";
import type { IrRecordShape, IrType } from "../../../ir/ir.js";
import { canDynCheckTo, isUnitType, typeEquals, UNDEFINED_T } from "../../../ir/ir.js";
import { type ClassInfo, findMethodOn, findGenericMethodOn } from "../lower-classes.js";
import type { Lowerer } from "../lowerer.js";

export type FieldLift =
  | { src: IrType; lift: WidthLift }
  | { absent: true; utag: number }
  | { absentDyn: true };

/** Plan one recursive structural conversion without interning helpers.
 * Validate the entire plan before building it; ambiguous union destinations
 * and conversions that can only throw are not structural conversions. */
export function widthLiftPlan(lowerer: Lowerer, src: IrType, dst: IrType): WidthLift | null {
  if (typeEquals(src, dst)) return { how: "copy" };
  // An 'unknown' (dyn) DESTINATION slot: the static→dyn conversion —
  // dynFrom, a DEEP COPY (`{ v: 5 }` into `{ v: unknown }`, `number[]`
  // into `unknown[]` — tsc's top type over the width family's copies).
  if (dst.kind === "dyn" && src.kind !== "dyn" && lowerer.dynConvertible(src)) {
    return { how: "dynIn" };
  }
  // An 'unknown' (dyn) SOURCE field into a typed slot — a field TypeScript
  // types `any` (a JSON.parse read), which the checker lets into any
  // declared field type: the checked extraction, the same dynCheck a
  // typed binding initialized from that value applies.
  if (
    src.kind === "dyn" &&
    dst.kind !== "dyn" &&
    dst.kind !== "union" &&
    canDynCheckTo(
      dst,
      (id) => lowerer.shapes.get(id),
      (id) => lowerer.unions.get(id),
    )
  ) {
    return { how: "dynOut" };
  }
  if (dst.kind === "union") {
    if (src.kind === "union") {
      if (lowerer.unionRetagMappable(src.unionId, dst.unionId)) return { how: "retag" };
      // A field the checker types `undefined` alone (an object literal's
      // omitted member, normalized to `?: undefined` across a union of
      // literal types) carries the unit-only union. Into a slot with an
      // undefined arm it lifts as that arm; its null arm cannot occur.
      const srcArms = lowerer.unions.get(src.unionId)?.arms ?? [];
      if (
        srcArms.length > 0 &&
        srcArms.every(isUnitType) &&
        lowerer.armTag(dst.unionId, UNDEFINED_T) >= 0
      )
        return { how: "unitRetag" };
      return null;
    }
    // A unit-typed source can't wrap here (unionWrap requires the
    // LITERAL unit — and no lowered shape carries a bare unit field).
    if (isUnitType(src)) return null;
    const tag = lowerer.armTag(dst.unionId, src);
    const def = lowerer.unions.get(dst.unionId);
    if (!def) return null;
    if (tag >= 0) {
      const shape = src.kind === "record" ? lowerer.shapes.get(src.shapeId) : undefined;
      if (shape && planRecordUnionWrap(shape, def, (id) => lowerer.shapes.get(id)))
        return { how: "discriminantWrap" };
      return { how: "wrap", tag };
    }
    const candidates: { tag: number; arm: IrType }[] = [];
    def.arms.forEach((arm, i) => {
      if (isUnitType(arm)) return;
      const sameFamily =
        (src.kind === "record" && arm.kind === "record") ||
        (src.kind === "array" && arm.kind === "array") ||
        (src.kind === "func" && arm.kind === "func") ||
        (src.kind === "object" && arm.kind === "object") ||
        // Tuples already lift into ordinary array slots. Consider that
        // same conversion when the array is an arm of a union too.
        (src.kind === "record" &&
          lowerer.shapes.get(src.shapeId)?.tuple === true &&
          arm.kind === "array") ||
        (src.kind === "object" && arm.kind === "record") ||
        (src.kind === "record" && arm.kind === "object");
      if (sameFamily && lowerer.widthLiftPlan(src, arm) !== null) candidates.push({ tag: i, arm });
    });
    let selected = candidates;
    if (selected.length > 1 && src.kind === "record") {
      const source = lowerer.shapes.get(src.shapeId);
      // An inferred JS union may widen its tag while retaining variants
      // with and without a value. Prefer the unique layout whose omitted
      // fields are explicitly undefined, rather than filling an optional
      // unknown slot and making both variants look equally compatible.
      const absentOnly = selected.filter(({ arm }) => {
        if (!source || arm.kind !== "record") return false;
        const target = lowerer.shapes.get(arm.shapeId);
        return (
          target !== undefined &&
          target.fields.every((field) => {
            if (source.fields.some((present) => present.name === field.name)) return true;
            return (
              isUnitType(field.type) ||
              (field.type.kind === "union" &&
                lowerer.unions.get(field.type.unionId)?.arms.every(isUnitType) === true)
            );
          })
        );
      });
      // That layout does not win when it holds the record only by dropping
      // fields and another arm keeps every field (`{ kind; type }` beside
      // `{ kind; name; adapts?: true; type }`): the value is not its variant.
      const dropsFields = (arm: IrType): boolean => !keepsEveryField(lowerer, source, arm);
      if (
        absentOnly.length === 1 &&
        !(dropsFields(absentOnly[0]!.arm) && selected.some(({ arm }) => !dropsFields(arm)))
      )
        selected = absentOnly;
    }
    // A record that fits several arms of a discriminated union selects one
    // by its discriminant at run time. Without this, an arm that a nested
    // field could reach only ambiguously dropped out of the candidates, and
    // an arm reached by dropping fields could win alone.
    if (selected.length !== 1 && src.kind === "record") {
      const source = lowerer.shapes.get(src.shapeId);
      if (
        source &&
        planRecordUnionLift(
          source,
          def,
          (id) => lowerer.shapes.get(id),
          (from, to) => lowerer.widthLiftPlan(from, to),
        )
      ) {
        return { how: "discriminantRoute" };
      }
    }
    if (selected.length === 2 && src.kind === "record") {
      const route = presenceRoute(lowerer, src.shapeId, selected[0]!, selected[1]!);
      if (route) return route;
    }
    // A record whose fields some arm keeps EVERY one of, each lifting
    // (`{ id; limit; opts?: A | B }` into `{ id; limit; opts?: A | B | C } |
    // { id; opts?: C }`): that arm is the value's own layout, widened; the
    // others hold it only by dropping fields. Prefer the unique lossless arm
    // with the record's own fields, then the unique one that also declares
    // optional fields the record lacks, which complete as absent.
    if (selected.length > 1 && src.kind === "record") {
      const source = lowerer.shapes.get(src.shapeId);
      const lossless = selected.filter(({ arm }) => keepsEveryField(lowerer, source, arm));
      const exact = lossless.filter(
        ({ arm }) =>
          arm.kind === "record" &&
          lowerer.shapes.get(arm.shapeId)?.fields.length === source?.fields.length,
      );
      if (exact.length === 1) selected = exact;
      else if (exact.length === 0 && lossless.length === 1) selected = lossless;
    }
    if (selected.length !== 1) return null;
    return { how: "liftWrap", tag: selected[0]!.tag, arm: selected[0]!.arm };
  }
  // A UNION source into a slot that is ONE of its arms (a width copy
  // whose target field narrowed — the option-table choices shape:
  // `value: boolean | string` copying into a `value: string` slot the
  // checker approved): the CHECKED extraction — narrowedArmHelper,
  // exactly `x!`'s machinery — the proven arm's payload comes out, any
  // other arm throws the catchable TypeError (divergence 38's stance).
  if (
    src.kind === "union" &&
    !isUnitType(dst) &&
    dst.kind !== "void" &&
    lowerer.armTag(src.unionId, dst) >= 0
  ) {
    return { how: "narrow" };
  }
  // A DERIVED instance into a BASE-typed slot (`{ p: Q }` copying into
  // `{ p: P }`): the same implicit upcast coerceToExpected performs at
  // top level — prefix layout, a pointer reinterpret, no copy.
  if (
    dst.kind === "object" &&
    src.kind === "object" &&
    lowerer.isSubclassOf(src.className, dst.className)
  ) {
    return { how: "upcast" };
  }
  // A FUNCTION into a slot whose signature differs only by CLEAN
  // mechanical conversions (fewer params — JS ignores extras — and
  // coercibleValue pieces): the general function-value adapter, plan-
  // gated to the clean subset. The stranded (trap-only) dispositions
  // funcCoerceAdapter also builds stay TOP-LEVEL only: a width plan
  // never promises a bridge that can only throw.
  if (dst.kind === "func" && src.kind === "func" && lowerer.cleanFuncAdaptable(src, dst)) {
    return { how: "funcAdapt" };
  }
  if (dst.kind === "record" && src.kind === "record") {
    return lowerer.recordWidthPlan(src.shapeId, dst.shapeId) !== null ? { how: "width" } : null;
  }
  if (dst.kind === "record" && src.kind === "union") {
    // A union of records can share a structural destination without
    // choosing one payload layout in advance. Plan every arm: omitted
    // destination fields need the ordinary optional-field completion,
    // and a required field missing from any arm still rejects the pair.
    const from = lowerer.unions.get(src.unionId);
    if (!from || from.arms.length === 0 || !from.arms.every((arm) => arm.kind === "record"))
      return null;
    const key = `unionWidth:${src.unionId}:${dst.shapeId}`;
    if (lowerer.coercions.planning.has(key)) return { how: "unionWidth" };
    lowerer.coercions.planning.add(key);
    try {
      return from.arms.every((arm) => lowerer.widthLiftPlan(arm, dst) !== null)
        ? { how: "unionWidth" }
        : null;
    } finally {
      lowerer.coercions.planning.delete(key);
    }
  }
  if (dst.kind === "record" && src.kind === "object") {
    return lowerer.objToRecordPlan(src.className, dst.shapeId) !== null
      ? { how: "objWidth" }
      : null;
  }
  if (dst.kind === "object" && src.kind === "record") {
    return lowerer.recordToClassPlan(src.shapeId, dst.className) !== null
      ? { how: "clsWidth" }
      : null;
  }
  if (dst.kind === "array" && src.kind === "array") {
    if (lowerer.widthLiftPlan(src.elem, dst.elem) !== null) return { how: "arr" };
    // The EMPTY-array lift: a unit-only element type (`readonly []`
    // mapped as the unit-element array, `(null | undefined)[]`) has no
    // per-element conversion into a data element — but the only value
    // such a slot honestly holds in the width family is EMPTY, so the
    // lift is a fresh empty array of the target type, guarded by a
    // runtime non-empty trap (the checked-extraction stance).
    if (lowerer.unitOnlyElem(src.elem) && !lowerer.unitOnlyElem(dst.elem)) {
      return { how: "emptyArr" };
    }
    return null;
  }
  // A TUPLE flowing into an array FIELD/ELEMENT (`aliases: ["ls"]` into
  // an `aliases: string[]` slot): per-position lifts, the top-level
  // tuple-into-array coercion applied recursively.
  if (dst.kind === "array" && src.kind === "record") {
    const from = lowerer.shapes.get(src.shapeId);
    if (from?.tuple && from.fields.every((f) => lowerer.widthLiftPlan(f.type, dst.elem) !== null)) {
      return { how: "tupleArr" };
    }
    return null;
  }
  return null;
}

/** True when the record arm `arm` has a field of every name the record
 * `source` has. Tuples keep their own positional layouts. */
function keepsEveryField(
  lowerer: Lowerer,
  source: IrRecordShape | undefined,
  arm: IrType,
): boolean {
  const target = arm.kind === "record" ? lowerer.shapes.get(arm.shapeId) : undefined;
  return (
    source !== undefined &&
    target !== undefined &&
    !source.tuple &&
    !target.tuple &&
    source.fields.every((field) => target.fields.some((kept) => kept.name === field.name))
  );
}

/** Two record arms a source record fits, where one arm declares a field
 * the other lacks and the source types that field `T | undefined`
 * (`{ count, errors: errs.length ? errs : undefined }` into `{ count;
 * errors: string[] } | { count }`): the field's value picks the arm at
 * run time. Null for any other pair. */
function presenceRoute(
  lowerer: Lowerer,
  sourceId: string,
  a: { tag: number; arm: IrType },
  b: { tag: number; arm: IrType },
): WidthLift | null {
  const source = lowerer.shapes.get(sourceId);
  if (!source || source.tuple || source.indexValue || a.arm.kind !== "record") return null;
  if (b.arm.kind !== "record") return null;
  const shapeA = lowerer.shapes.get(a.arm.shapeId);
  const shapeB = lowerer.shapes.get(b.arm.shapeId);
  if (!shapeA || !shapeB) return null;
  const optional = (t: IrType): boolean =>
    t.kind === "union" && lowerer.armTag(t.unionId, UNDEFINED_T) >= 0;
  for (const [present, absent, presentShape, absentShape] of [
    [a, b, shapeA, shapeB],
    [b, a, shapeB, shapeA],
  ] as const) {
    const extra = presentShape.fields.filter(
      (f) => !absentShape.fields.some((g) => g.name === f.name),
    );
    if (extra.length !== 1 || optional(extra[0]!.type)) continue;
    if (absentShape.fields.some((g) => !presentShape.fields.some((f) => f.name === g.name)))
      continue;
    const field = source.fields.find((f) => f.name === extra[0]!.name);
    if (!field || !optional(field.type)) continue;
    return { how: "presenceRoute", field: field.name, present, absent };
  }
  return null;
}

/** True for the unit-only element types (`(null | undefined)[]`, the
 * `readonly []` mapping): a union whose every arm is a unit. */
export function unitOnlyElem(lowerer: Lowerer, t: IrType): boolean {
  if (t.kind !== "union") return false;
  const def = lowerer.unions.get(t.unionId);
  return def !== undefined && def.arms.every((a) => isUnitType(a));
}

/** Plan each destination field before interning a record projection.
 * Missing optional fields complete to undefined; tuples require equal arity.
 * Index-signature destinations use the separate overflow-capture path. */
export function recordWidthPlan(
  lowerer: Lowerer,
  fromId: string,
  toId: string,
): Map<string, FieldLift> | null {
  const from = lowerer.shapes.get(fromId);
  const to = lowerer.shapes.get(toId);
  // INDEX-SIGNATURE sources narrow like any wider record — the target
  // fields copy off the declared struct slots and the overflow drops
  // with the rest of the width (divergence 36's stance; the absent-
  // completion rule below is the one extra fence). Index-signature
  // TARGETS keep the overflow CAPTURE helper (widthCoerce's other arm):
  // a fresh hybrid needs keyed writes, not a field-list literal.
  if (!from || !to || to.indexValue) return null;
  // Tuple↔record pairs never relate; tuple↔tuple only arity-exact.
  if (!!from.tuple !== !!to.tuple) return null;
  if (from.tuple && from.fields.length !== to.fields.length) return null;
  const key = `${fromId}:${toId}`;
  // Recursive shapes: an in-progress pair re-entered through its own
  // fields answers "assume coercible" — see CoercionState.planning.
  if (lowerer.coercions.planning.has(key)) return new Map();
  lowerer.coercions.planning.add(key);
  try {
    const plan = new Map<string, FieldLift>();
    for (const tf of to.fields) {
      const ff = from.fields.find((f) => f.name === tf.name);
      if (!ff) {
        // A target field MISSING on the source: legal exactly when it is
        // optional-flavored (an undefined-armed union) — the unset field
        // IS the undefined arm, the same rule literal completion applies
        // — or 'unknown' (a dyn slot holds the dyn undefined, exactly
        // the absent-property read: the options-record call shape
        // against `{ plugins: unknown, ... }`). Never for tuples: a
        // completed position would change .length and JSON where Node
        // keeps the source arity. Never for INDEX-SIGNATURE sources:
        // the overflow may hold this very key at runtime (tsc lets the
        // signature satisfy optional target members), so completing to
        // undefined would drop a value Node keeps — the pair stays
        // fenced.
        if (from.tuple || from.indexValue) return null;
        if (tf.type.kind === "dyn") {
          plan.set(tf.name, { absentDyn: true });
          continue;
        }
        if (tf.type.kind !== "union") return null;
        const def = lowerer.unions.get(tf.type.unionId);
        const utag = def ? def.arms.findIndex((a) => a.kind === "undefinedT") : -1;
        if (utag < 0) return null;
        plan.set(tf.name, { absent: true, utag });
        continue;
      }
      const lift = lowerer.widthLiftPlan(ff.type, tf.type);
      if (!lift) return null;
      plan.set(tf.name, { src: ff.type, lift });
    }
    return plan;
  } finally {
    lowerer.coercions.planning.delete(key);
  }
}

/** Explain the first blocked field conversion after SC2002 rejects a pair.
 * This describes the planning rules without changing which pairs convert. */
export function describeRecordWidthBlocker(
  lowerer: Lowerer,
  fromId: string,
  toId: string,
): string | null {
  const from = lowerer.shapes.get(fromId);
  const to = lowerer.shapes.get(toId);
  if (!from || !to) return null;
  if (to.indexValue) {
    // The overflow CAPTURE's gates (lowerRecordOvfCaptureHelper).
    if (from.tuple || to.tuple) return "a tuple cannot reshape into an index-signature record";
    const tIv = to.indexValue;
    const slotOk = (t: IrType): boolean =>
      typeEquals(t, tIv) ||
      (tIv.kind === "dyn" && (t.kind === "dyn" || lowerer.dynConvertible(t))) ||
      lowerer.widthLiftPlan(t, tIv) !== null;
    const consumed = new Set<string>();
    for (const tf of to.fields) {
      const sf = from.fields.find((f) => f.name === tf.name);
      if (sf) {
        if (lowerer.widthLiftPlan(sf.type, tf.type) !== null) {
          consumed.add(tf.name);
          continue;
        }
        return `field '${tf.name}': '${lowerer.fmt(sf.type)}' does not lift into '${lowerer.fmt(tf.type)}'`;
      }
      if (tf.type.kind !== "union" || lowerer.armTag(tf.type.unionId, UNDEFINED_T) < 0) {
        return `the expected field '${tf.name}' is required and the source has no field to copy into it`;
      }
      if (tIv.kind === "dyn" ? !lowerer.dynConvertible(tf.type) : !typeEquals(tf.type, tIv)) {
        return `the expected field '${tf.name}' ('${lowerer.fmt(tf.type)}') cannot take a runtime key collision from the '${lowerer.fmt(tIv)}' signature slot`;
      }
    }
    for (const ff of from.fields) {
      if (consumed.has(ff.name)) continue;
      if (!slotOk(ff.type)) {
        return `the source field '${ff.name}' ('${lowerer.fmt(ff.type)}') cannot enter the expected '[key: string]: ${lowerer.fmt(tIv)}' slot`;
      }
    }
    if (from.indexValue && !slotOk(from.indexValue)) {
      return `the source's '[key: string]: ${lowerer.fmt(from.indexValue)}' slot cannot enter the expected '[key: string]: ${lowerer.fmt(tIv)}' slot`;
    }
    // The dispatch-writes gate: runtime-keyed writes can collide with a
    // declared field whose type is not the slot's.
    const dispatchWrites =
      from.indexValue !== undefined ||
      from.fields.some((ff) => !consumed.has(ff.name) && to.fields.some((f) => f.name === ff.name));
    if (dispatchWrites) {
      const bad = to.fields.find((f) =>
        tIv.kind === "dyn" ? !lowerer.dynConvertible(f.type) : !typeEquals(f.type, tIv),
      );
      if (bad) {
        return `runtime-keyed writes can collide with the expected field '${bad.name}' ('${lowerer.fmt(bad.type)}'), which cannot take a '${lowerer.fmt(tIv)}' slot value`;
      }
    }
    return null;
  }
  // The field-copy plan's gates (recordWidthPlan).
  if (!!from.tuple !== !!to.tuple) return null;
  if (from.tuple && from.fields.length !== to.fields.length) {
    return `tuple arities differ (${from.fields.length} vs ${to.fields.length}; TS permits no tuple width)`;
  }
  for (const tf of to.fields) {
    const ff = from.fields.find((f) => f.name === tf.name);
    if (!ff) {
      if (from.tuple) return null;
      if (from.indexValue) {
        return `'${tf.name}' is not a declared field of the source, and the source's index signature could hold it at runtime (a completed undefined would drop that value)`;
      }
      if (tf.type.kind === "dyn") continue;
      if (tf.type.kind !== "union" || lowerer.armTag(tf.type.unionId, UNDEFINED_T) < 0) {
        return `the expected field '${tf.name}' is missing on the source and is not optional`;
      }
      continue;
    }
    if (lowerer.widthLiftPlan(ff.type, tf.type) === null) {
      return `field '${tf.name}': '${lowerer.fmt(ff.type)}' does not lift into '${lowerer.fmt(tf.type)}'`;
    }
  }
  return null;
}

/** Plan a record projection from plain class fields, including inherited
 * fields and absent optional fields. Methods, accessors, reserved slots and
 * builtin runtime layouts cannot be read as ordinary emitted storage. */
export function objToRecordPlan(
  lowerer: Lowerer,
  className: string,
  toId: string,
): Map<string, FieldLift> | null {
  const info = lowerer.classes.get(className);
  const to = lowerer.shapes.get(toId);
  if (!info || !to || to.indexValue || to.tuple) return null;
  // Reserved slots (%call hybrids, %get:/%set: accessor closures) are
  // not projectable storage.
  if (to.fields.some((f) => f.name.startsWith("%"))) return null;
  for (let c: ClassInfo | null = info; c; c = c.base) {
    if (c.builtinError || c.builtinEmitter || c.builtinStream !== undefined || c.def.runtime)
      return null;
  }
  const key = `obj:${className}:${toId}`;
  if (lowerer.coercions.planning.has(key)) return new Map();
  lowerer.coercions.planning.add(key);
  try {
    const plan = new Map<string, FieldLift>();
    for (const tf of to.fields) {
      // A method/accessor satisfying the checker has no projectable
      // value — decline the whole plan, field or not.
      if (
        findMethodOn(lowerer, info, tf.name) ||
        findMethodOn(lowerer, info, `get:${tf.name}`) ||
        findGenericMethodOn(lowerer, info, tf.name)
      ) {
        return null;
      }
      const ft = info.fields.get(tf.name);
      if (ft === undefined) {
        if (tf.type.kind !== "union") return null;
        const def = lowerer.unions.get(tf.type.unionId);
        const utag = def ? def.arms.findIndex((a) => a.kind === "undefinedT") : -1;
        if (utag < 0) return null;
        plan.set(tf.name, { absent: true, utag });
        continue;
      }
      const lift = lowerer.widthLiftPlan(ft, tf.type);
      if (!lift) return null;
      plan.set(tf.name, { src: ft, lift });
    }
    return plan;
  } finally {
    lowerer.coercions.planning.delete(key);
  }
}

/** Plan construction of a data class from record fields. The class must
 * have only parameter properties and a trivial constructor, with no methods,
 * accessors, decorations or runtime layout. Entries follow parameter order. */
export function recordToClassPlan(
  lowerer: Lowerer,
  fromId: string,
  className: string,
): ({ field: string; src: IrType; lift: WidthLift } | { absent: true })[] | null {
  const from = lowerer.shapes.get(fromId);
  const info = lowerer.classes.get(className);
  if (!from || !info || from.indexValue || from.tuple) return null;
  if (from.fields.some((f) => f.name.startsWith("%"))) return null;
  if (!info.decl || info.def.abstract || info.def.runtime || info.generic) return null;
  if (info.builtinError || info.builtinEmitter || info.builtinStream !== undefined) return null;
  if (info.classDecorators) return null;
  if (info.base && !(info.base.generic && !info.base.base)) return null;
  for (let c: ClassInfo | null = info; c; c = c.base) {
    if (
      c.methods.size > 0 ||
      (c.genericMethods?.size ?? 0) > 0 ||
      (c.symbolFields?.size ?? 0) > 0 ||
      c.throwingSetters.length > 0 ||
      (c.def.abstractMethods?.length ?? 0) > 0
    ) {
      return null;
    }
  }
  if (!info.ctor || info.ctor.body === undefined || info.ctor.body.statements.nodes.length > 0)
    return null;
  const props = info.paramProps ?? [];
  if (props.length !== info.ctorParams.length) return null;
  // Every layout field must come from a parameter property (no declared
  // fields with initializers the projection would prefer without a
  // diagnostic).
  if (info.def.fields.length !== props.length) return null;
  const key = `cls:${fromId}:${className}`;
  if (lowerer.coercions.planning.has(key)) return [];
  lowerer.coercions.planning.add(key);
  try {
    const plan: ({ field: string; src: IrType; lift: WidthLift } | { absent: true })[] = [];
    for (let i = 0; i < props.length; i++) {
      const shape = info.ctorParams[i];
      if (!shape || (shape.mode !== "required" && shape.mode !== "omittable")) return null;
      const name = props[i]!.name;
      const ff = from.fields.find((f) => f.name === name);
      if (!ff) {
        if (shape.mode !== "omittable" || shape.type.kind !== "union") return null;
        const def = lowerer.unions.get(shape.type.unionId);
        if (!def || !def.arms.some((a) => a.kind === "undefinedT")) return null;
        plan.push({ absent: true });
        continue;
      }
      const lift = lowerer.widthLiftPlan(ff.type, shape.type);
      if (!lift) return null;
      plan.push({ field: name, src: ff.type, lift });
    }
    return plan;
  } finally {
    lowerer.coercions.planning.delete(key);
  }
}
