import { planRecordUnionLift, planRecordUnionWrap, planUnionRetag } from "../union-retag.js";
import type { WidthLift } from "../width-lift.js";
import type { IrRecordShape, IrType } from "../../../ir/ir.js";
import {
  canDynCheckTo,
  isUnitType,
  shapeHasAccessorSlots,
  typeEquals,
  UNDEFINED_T,
} from "../../../ir/ir.js";
import { type ClassInfo, findMethodOn, findGenericMethodOn } from "../lower-classes.js";
import { recordKeyResultOk } from "../lower-exprs.js";
import type { Lowerer } from "../lowerer.js";

/** Whether a record pair relates ONLY through the index-signature rule: the
 * source keeps a field the target names in its overflow map instead of a
 * declared slot. Constructing at a destination and keeping an established
 * conversion (a literal's contextual layout, a union arm) ask this to leave
 * such pairs on the path they took before overflow reads joined width
 * plans. */
export function widthFromOverflow(lowerer: Lowerer, from: IrType, to: IrType): boolean {
  if (from.kind !== "record" || to.kind !== "record") return false;
  const fromShape = lowerer.shapes.get(from.shapeId);
  const toShape = lowerer.shapes.get(to.shapeId);
  return (
    fromShape !== undefined &&
    toShape !== undefined &&
    fromShape.indexValue !== undefined &&
    !fromShape.tuple &&
    toShape.indexValue === undefined &&
    toShape.fields.some((field) => !fromShape.fields.some((own) => own.name === field.name))
  );
}

export type FieldLift =
  | { src: IrType; lift: WidthLift }
  /** A target field the source does not declare: TypeScript lets the
   * source's index signature satisfy it, so the projection reads whatever
   * the overflow holds under that key (a copy would complete undefined and
   * drop a value the object really has). Only a dynamic index value takes
   * this arm: its read answers the dyn undefined for a key the object never
   * had, which the member's check rejects. */
  | { overflow: IrType }
  /** The same overflow read taken at the target member's own type: the
   * index value surfaces there, and the type's undefined arm is what a key
   * the object never had answers (a read at the index value alone has no
   * value to give a missing key). */
  | { overflowAt: IrType }
  | { absent: true; utag: number }
  | { absentDyn: true };

/** Whether the source's index signature can answer a target member at the
 * member's own type: the overflow value reads there and the type holds
 * undefined, so a key the object never had is a value the member can take. */
function overflowReadsAt(lowerer: Lowerer, from: IrRecordShape, to: IrType): boolean {
  return (
    from.indexValue !== undefined &&
    from.indexValue.kind !== "dyn" &&
    to.kind === "union" &&
    lowerer.armTag(to.unionId, UNDEFINED_T) >= 0 &&
    recordKeyResultOk(lowerer, { ...from, fields: [] }, to)
  );
}

/** Plan one recursive structural conversion without interning helpers.
 * Validate the entire plan before building it; ambiguous union destinations
 * and conversions that can only throw are not structural conversions. */
export function widthLiftPlan(lowerer: Lowerer, src: IrType, dst: IrType): WidthLift | null {
  if (typeEquals(src, dst)) return { how: "copy" };
  // A promise whose payload widens (`Promise<void>` into `Promise<unknown>`,
  // a settlement type gaining optional members): the checked payload
  // widening coerceToExpected applies at a promise slot. The promise keeps
  // its identity and settlement turn; the payload converts when it settles.
  if (dst.kind === "promise" && src.kind === "promise" && lowerer.promisePayloadWidens(src, dst))
    return { how: "promiseWiden" };
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
      // Inside a checked method adapter (contravariant positions) and inside
      // the operand of a type assertion: source arms with no destination
      // home trap instead of refusing the pair.
      if (lowerer.coercions.checkedRetags > 0 || lowerer.coercions.assertedOperand > 0) {
        const from = lowerer.unions.get(src.unionId);
        const to = lowerer.unions.get(dst.unionId);
        if (from && to) {
          const trappable: number[] = [];
          from.arms.forEach((arm, tag) => {
            if (isUnitType(arm) || lowerer.armTag(dst.unionId, arm) >= 0) return;
            if (to.arms.some((d) => !isUnitType(d) && lowerer.widthLiftPlan(arm, d) !== null))
              return;
            trappable.push(tag);
          });
          if (
            trappable.length > 0 &&
            trappable.length < from.arms.length &&
            planUnionRetag(
              from,
              to,
              (id) => lowerer.shapes.get(id),
              (s, d) => lowerer.widthLiftPlan(s, d),
              new Set(trappable),
            ) !== null
          )
            return { how: "checkedRetag", trappable };
        }
      }
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
    const candidates: { tag: number; arm: IrType; checked: boolean }[] = [];
    def.arms.forEach((arm, i) => {
      if (isUnitType(arm)) return;
      const sameFamily =
        (src.kind === "record" && arm.kind === "record") ||
        (src.kind === "array" && arm.kind === "array") ||
        (src.kind === "func" && arm.kind === "func") ||
        (src.kind === "promise" && arm.kind === "promise") ||
        (src.kind === "object" && arm.kind === "object") ||
        // Tuples already lift into ordinary array slots. Consider that
        // same conversion when the array is an arm of a union too.
        (src.kind === "record" &&
          lowerer.shapes.get(src.shapeId)?.tuple === true &&
          arm.kind === "array") ||
        (src.kind === "object" && arm.kind === "record") ||
        (src.kind === "record" && arm.kind === "object");
      const armLift = sameFamily ? lowerer.widthLiftPlan(src, arm) : null;
      if (armLift !== null) {
        // A layout the source reaches only inside the assertion's checked
        // context (a field retagging with trapping arms, or a record or
        // array hiding one) is a CHECKED candidate: a layout the program's
        // own types reach without the claim wins, so a conversion that
        // already lowered keeps its code instead of taking the trapping
        // route the claim admits.
        const unclaimed =
          lowerer.coercions.assertedOperand > 0
            ? lowerer.coercions.withoutAssertedClaim(() => lowerer.widthLiftPlan(src, arm))
            : armLift;
        candidates.push({
          tag: i,
          arm,
          checked: armLift.how === "funcAdaptChecked" || unclaimed === null,
        });
      }
    });
    let selected = candidates;
    // A clean function candidate always wins over a checked one, so every
    // selection that resolves today resolves the same way.
    if (selected.some((c) => c.checked) && selected.some((c) => !c.checked))
      selected = selected.filter((c) => !c.checked);
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
    // The same question asked of the records the fields hold: several arms
    // keep every field of the record itself, and one alone also keeps every
    // field of each record inside it (`{ shape: { a; b; c } }` into
    // `{ shape: { a; b; c; d?: undefined } } | { shape: { a; d } }`, the
    // element types the checker gives an array of object literals). The
    // others would drop members the value has, so that arm is its layout.
    // Asked only of a selection the rules above left with several arms.
    if (selected.length > 1 && src.kind === "record") {
      const whole = selected.filter(({ arm }) => keepsEveryMember(lowerer, src, arm, new Set()));
      if (whole.length === 1) selected = whole;
    }
    // Arms no READ can tell apart for THIS value: each source field lands
    // on a same-typed field of every arm, and everything the arms add is a
    // field the source lacks that the completion rule already fills with
    // the absent state. Pick the first arm instead of an ambiguity fence.
    // The redundant-union shapes are ordinary declarations of a shared
    // record whose arms differ only in an optional field the value does
    // not carry (`{ boundaries: null | undefined }` beside `{ boundaries:
    // number[] | undefined }` in a metric definition, `{ type: "string";
    // values?: string[] }` beside five sibling attribute layouts), where
    // every read answers the same value whichever tag the box carries.
    if (
      selected.length > 1 &&
      src.kind === "record" &&
      armsIndistinguishable(lowerer, src.shapeId, selected)
    )
      selected = [selected[0]!];
    // An 'unknown' (dyn) source whose union destination has no dyn arm of
    // its own (`details: any` into `Details | undefined`, a tool result's
    // `structuredContent: unknown` into the JSON-value union): the checked
    // extraction, the same dynCheck coerceToExpected performs for a dyn
    // value in a union slot. A dyn source has no arm family, so every arm
    // rule above has passed it by, and every plan that exists for a dyn
    // source is the one above (its own arm) — this is exactly the case
    // that returned null (SC2002) before, so no convertible value changes
    // its lowering.
    if (
      selected.length !== 1 &&
      src.kind === "dyn" &&
      canDynCheckTo(
        dst,
        (id) => lowerer.shapes.get(id),
        (id) => lowerer.unions.get(id),
      )
    ) {
      return { how: "dynOut" };
    }
    if (selected.length !== 1) return null;
    return { how: "liftWrap", tag: selected[0]!.tag, arm: selected[0]!.arm };
  }
  // A UNION of tuples/arrays into ONE array slot: each arm converts on its
  // own tag (a tuple rebuilds through tupleArr, an array copies or lifts
  // through arr), and a unit arm takes the stranded TypeError — the slot
  // holds no unit. This includes a MIXED union that already holds the
  // destination array arm beside a tuple arm (`["one"] | string[]` into
  // `string[]`): Node has one array either way, so the tuple rebuilds
  // instead of the checked extraction trapping on it. It sits BEFORE the
  // checked-extraction rule below; a union whose only non-unit arm IS the
  // destination (`T[] | undefined`) has nothing to convert and keeps the
  // narrow it always took.
  if (dst.kind === "array" && src.kind === "union") {
    const from = lowerer.unions.get(src.unionId);
    if (
      from &&
      from.arms.some((arm) => !isUnitType(arm)) &&
      from.arms.some((arm) => !isUnitType(arm) && !typeEquals(arm, dst)) &&
      from.arms.every((arm) => isUnitType(arm) || lowerer.widthLiftPlan(arm, dst) !== null)
    )
      return { how: "unionArr" };
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
  // A method FIELD of a record width copy whose parameters convert only
  // through a checked narrowing (method bivariance across instantiations):
  // a checked adapter. Top-level function conversions never see it.
  if (
    dst.kind === "func" &&
    src.kind === "func" &&
    lowerer.coercions.methodFieldDepth > 0 &&
    lowerer.coercions.checkedRetags === 0
  ) {
    lowerer.coercions.checkedRetags++;
    try {
      if (lowerer.cleanFuncAdaptable(src, dst)) return { how: "funcAdaptChecked" };
    } finally {
      lowerer.coercions.checkedRetags--;
    }
  }
  if (dst.kind === "record" && src.kind === "record") {
    // An INDEX-SIGNATURE destination takes the overflow CAPTURE reshape:
    // declared fields copy off the source, every other source field keys
    // into the destination's overflow (the same helper widthCoerce uses
    // at top level). Without this the pair had no width plan at all, so a
    // union arm, field or element of this shape refused.
    if (lowerer.shapes.get(dst.shapeId)?.indexValue !== undefined) {
      return lowerer.recordOvfCapturePlan(src.shapeId, dst.shapeId) !== null
        ? { how: "ovf" }
        : null;
    }
    if (lowerer.recordWidthPlan(src.shapeId, dst.shapeId) !== null) return { how: "width" };
    return null;
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
    // A unit-only element array (`never[]`, `readonly []`) into a data
    // element array has no plan: an empty array is one array under every
    // name, so it is typed where it is written (empty-array-places.ts)
    // and never converted to another element type afterwards.
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

/** The checked widening's gates (see WidthLift's `checkedWiden`): every
 * field the source declares is a destination field of the same type, the
 * destination declares a REQUIRED member the source lacks (optional and
 * `unknown` members are the field-copy plan's own absent completion, so a
 * pair whose only missing members are those cannot reach here), the
 * source crosses into a checked-dynamic value at all, and the destination
 * is a shape dynCheck validates. */
function checkedWidenPlan(lowerer: Lowerer, fromId: string, toId: string): boolean {
  const from = lowerer.shapes.get(fromId);
  const to = lowerer.shapes.get(toId);
  if (!from || !to || from.tuple || to.tuple) return false;
  if (from.indexValue !== undefined || to.indexValue !== undefined) return false;
  for (const field of from.fields) {
    const target = to.fields.find((tf) => tf.name === field.name);
    if (!target || !typeEquals(target.type, field.type)) return false;
  }
  let missingRequired = false;
  for (const field of to.fields) {
    if (from.fields.some((ff) => ff.name === field.name)) continue;
    if (field.type.kind === "dyn") continue;
    if (field.type.kind === "union" && lowerer.armTag(field.type.unionId, UNDEFINED_T) >= 0)
      continue;
    missingRequired = true;
  }
  if (!missingRequired) return false;
  const source: IrType = { kind: "record", shapeId: fromId };
  return (
    lowerer.dynConvertible(source) &&
    canDynCheckTo(
      { kind: "record", shapeId: toId },
      (id) => lowerer.shapes.get(id),
      (id) => lowerer.unions.get(id),
    )
  );
}

/** The checked widening as its own conversion, for the sites that ask for
 * it BY NAME: a written predicate narrowing an element to a record that
 * declares required members the element's type lacks (filter-predicates.ts).
 * It is deliberately not part of widthLiftPlan: that relation answers every
 * speculative "could this pair convert?" question in the lowering, and a
 * trapping answer there would change the code of programs that already
 * compile. A caller that reaches this point has no field-copy plan, so only
 * a program that refused before gains the conversion. */
export function checkedWidthLift(lowerer: Lowerer, src: IrType, dst: IrType): WidthLift | null {
  // An array into a fixed tuple each of whose positions takes the array's
  // element (WidthLift's `arrTuple`).
  if (src.kind === "array" && dst.kind === "record") {
    const tuple = lowerer.shapes.get(dst.shapeId);
    return tuple?.tuple === true &&
      tuple.fields.length > 0 &&
      tuple.fields.every((field) => lowerer.widthLiftPlan(src.elem, field.type) !== null)
      ? { how: "arrTuple" }
      : null;
  }
  if (src.kind !== "record" || dst.kind !== "record" || typeEquals(src, dst)) return null;
  return checkedWidenPlan(lowerer, src.shapeId, dst.shapeId) ? { how: "checkedWiden" } : null;
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

/** True when a value of type `source` converted to `target` keeps every
 * member it declares, at every depth: a record's fields all have a field of
 * their name in the target record, whose type keeps theirs the same way; an
 * array's elements keep theirs; a union keeps an arm when one of its own
 * arms does. Types that hold no record (and equal types) lose nothing.
 * Tuples, index signatures and accessor slots have other layouts and
 * answer false. `seen` holds the record pairs being compared: a recursive
 * layout that reaches itself has lost nothing on the way. */
function keepsEveryMember(
  lowerer: Lowerer,
  source: IrType,
  target: IrType,
  seen: Set<string>,
): boolean {
  if (typeEquals(source, target)) return true;
  if (source.kind === "union") {
    const arms = lowerer.unions.get(source.unionId)?.arms;
    return (
      arms !== undefined &&
      arms.every((arm) => isUnitType(arm) || keepsEveryMember(lowerer, arm, target, seen))
    );
  }
  if (target.kind === "union") {
    const arms = lowerer.unions.get(target.unionId)?.arms;
    return (
      arms !== undefined &&
      arms.some((arm) => !isUnitType(arm) && keepsEveryMember(lowerer, source, arm, seen))
    );
  }
  if (source.kind === "array")
    return target.kind === "array" && keepsEveryMember(lowerer, source.elem, target.elem, seen);
  if (source.kind !== "record") return true;
  if (target.kind !== "record") return false;
  const from = lowerer.shapes.get(source.shapeId);
  const to = lowerer.shapes.get(target.shapeId);
  if (!from || !to) return false;
  if (from.tuple || to.tuple || from.indexValue !== undefined || to.indexValue !== undefined)
    return false;
  if (shapeHasAccessorSlots(from) || shapeHasAccessorSlots(to)) return false;
  const pair = `${from.id}>${to.id}`;
  if (seen.has(pair)) return true;
  seen.add(pair);
  return from.fields.every((field) => {
    const kept = to.fields.find((candidate) => candidate.name === field.name);
    return kept !== undefined && keepsEveryMember(lowerer, field.type, kept.type, seen);
  });
}

/** Whether width-lifting this source record into ANY of the candidate arms
 * answers the same value on every read: each source field must land on a
 * same-typed field of every arm, the source field order inside the arms
 * must agree (a record's key order is its JSON and Object.keys order), and
 * every arm must be a closed fixed shape without accessor slots so a read
 * of a field the source lacks answers the absent state in each. The arms
 * may still declare different fields of their own: those are all absent on
 * the lifted value. */
function armsIndistinguishable(
  lowerer: Lowerer,
  sourceId: string,
  selected: { tag: number; arm: IrType }[],
): boolean {
  const source = lowerer.shapes.get(sourceId);
  if (!source || source.tuple || source.indexValue) return false;
  const shapes: IrRecordShape[] = [];
  for (const { arm } of selected) {
    if (arm.kind !== "record") return false;
    const shape = lowerer.shapes.get(arm.shapeId);
    if (!shape || shape.tuple || shape.indexValue !== undefined || shapeHasAccessorSlots(shape))
      return false;
    shapes.push(shape);
  }
  const names = source.fields.map((f) => f.name);
  const placedOf = (shape: IrRecordShape): number[] =>
    names.map((name) => shape.fields.findIndex((f) => f.name === name));
  const first = placedOf(shapes[0]!);
  // A source field the arm does not declare drops from the copy (width
  // subtyping) — the arms would then disagree on it.
  if (first.some((i) => i < 0)) return false;
  for (const shape of shapes.slice(1)) {
    const placed = placedOf(shape);
    if (placed.some((i) => i < 0)) return false;
    for (let k = 0; k < placed.length; k++) {
      if (!typeEquals(shape.fields[placed[k]!]!.type, shapes[0]!.fields[first[k]!]!.type))
        return false;
      if (k > 0 && placed[k]! > placed[k - 1]! !== first[k]! > first[k - 1]!) return false;
    }
  }
  return true;
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
  // fields copy off the declared struct slots, and a target field the
  // source declares only through its signature reads the overflow key.
  // Index-signature TARGETS keep the overflow CAPTURE helper (widthCoerce's
  // other arm): a fresh hybrid needs keyed writes, not a field-list literal.
  if (!from || !to || to.indexValue) return null;
  // Tuple↔record pairs never relate; tuple↔tuple only arity-exact.
  if (!!from.tuple !== !!to.tuple) return null;
  if (from.tuple && from.fields.length !== to.fields.length) return null;
  const key = `${fromId}:${toId}`;
  // Recursive shapes: an in-progress pair re-entered through its own
  // fields answers "assume coercible" — see CoercionState.planning.
  if (lowerer.coercions.planning.has(key)) return new Map();
  lowerer.coercions.planning.add(key);
  lowerer.coercions.methodFieldDepth++;
  try {
    const plan = new Map<string, FieldLift>();
    for (const tf of to.fields) {
      const ff = from.fields.find((f) => f.name === tf.name);
      if (!ff) {
        // A target field MISSING on the source: the source's INDEX
        // SIGNATURE satisfies it, so the projection reads the key from
        // the overflow — completing undefined would drop a value the
        // object really holds.
        if (from.indexValue !== undefined && !from.tuple) {
          const iv = from.indexValue;
          // A key the object never had has no value to give: plan the read
          // only where its result type holds the undefined a miss answers.
          // A member whose type the index value surfaces at, with an
          // undefined arm, reads at the member's own type; a dynamic index
          // value reads as dyn. A typed value read at its own type has no
          // undefined to answer a miss with, so the pair keeps the checked
          // conversion it takes without a plan.
          if (overflowReadsAt(lowerer, from, tf.type)) {
            plan.set(tf.name, { overflowAt: tf.type });
            continue;
          }
          if (iv.kind === "dyn" && lowerer.dynExtractableTo(tf.type)) {
            plan.set(tf.name, { overflow: iv });
            continue;
          }
          return null;
        }
        // Otherwise legal exactly when it is optional-flavored (an
        // undefined-armed union) — the unset field IS the undefined arm,
        // the same rule literal completion applies — or 'unknown' (a dyn
        // slot holds the dyn undefined, exactly the absent-property read:
        // the options-record call shape against `{ plugins: unknown, ... }`).
        // Never for tuples: a completed position would change .length and
        // JSON where Node keeps the source arity.
        if (from.tuple) return null;
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
    lowerer.coercions.methodFieldDepth--;
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
      // An optional checked-dynamic slot has an ABSENT state, so a source
      // that never declares it still produces the right property surface.
      if (tf.optional === true) continue;
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
      if (from.indexValue !== undefined) {
        const iv = from.indexValue;
        const ok =
          overflowReadsAt(lowerer, from, tf.type) ||
          (iv.kind === "dyn" && lowerer.dynExtractableTo(tf.type));
        if (!ok)
          return `'${tf.name}' is not a declared field of the source, and the source's '[key: string]: ${lowerer.fmt(iv)}' overflow cannot produce '${lowerer.fmt(tf.type)}'`;
        continue;
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
 * builtin runtime layouts cannot be read as ordinary emitted storage: a
 * class rooted in a runtime-provided class (an emitter, an error, a stream)
 * projects the fields its program classes declare, which follow the runtime
 * prefix in the emitted struct, and declines a member the runtime class
 * itself holds. Such a class projects no absent optional field either: the
 * runtime class holds members outside its declared field list (an error's
 * stack, a stream's state), so a name no program class declares is not known
 * to be absent on the instance. */
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
  let runtimeRooted = false;
  for (let c: ClassInfo | null = info; c; c = c.base) {
    if (c.builtinError || c.builtinEmitter || c.builtinStream !== undefined || c.def.runtime) {
      if (c === info || to.fields.some((f) => c.fields.has(f.name))) return null;
      runtimeRooted = true;
    }
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
        if (runtimeRooted || tf.type.kind !== "union") return null;
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
