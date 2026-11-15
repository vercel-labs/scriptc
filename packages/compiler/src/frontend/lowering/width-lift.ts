import type { IrType } from "../../ir/ir.js";

/** One step of the copy-reshape width relation (widthLiftPlan): how a
 * source-typed value enters a destination slot. Pure data — the plan half;
 * applyWidthLift is the build half. */
export type WidthLift =
  | { how: "copy" }
  | { how: "wrap"; tag: number }
  | { how: "discriminantWrap" }
  | { how: "discriminantRoute" }
  | { how: "retag" }
  | { how: "unitRetag" }
  | { how: "liftWrap"; tag: number; arm: IrType }
  /** A record into a union of two record arms that differ by one field:
   * the source field `field` (`T | undefined`) selects `present` when it
   * holds a value and `absent`, which lacks the field, when it is
   * undefined. */
  | {
      how: "presenceRoute";
      field: string;
      present: { tag: number; arm: IrType };
      absent: { tag: number; arm: IrType };
    }
  | { how: "width" }
  /** A record into a WIDER record that declares REQUIRED members the
   * source's type lacks (`{ role: string }` into a system message whose
   * `content` and `timestamp` are required, the shape a user type
   * predicate hands a value): no field list can be copied, because the
   * destination's members have no source slot. The CHECKED widening
   * instead — a live capsule of the source record checked against the
   * destination, which reads the properties the source kept beside its
   * declared fields (a width copy links to its source; a checked record
   * keeps its source properties) and throws the catchable TypeError when
   * the value genuinely lacks them. Asked for BY NAME by the conversion
   * that refused (lowerer.checkedWidthLift, filter-predicates.ts): it is
   * not an answer of widthLiftPlan, whose speculative callers would build
   * existing programs' code around it. */
  | { how: "checkedWiden" }
  /** A record into a record whose destination declares an index
   * signature: the overflow CAPTURE reshape (declared fields copy off the
   * source in declaration order, every other source field keys into the
   * destination's overflow). A copy, like every width lift. */
  | { how: "ovf" }
  | { how: "unionWidth" }
  /** A union of tuples/arrays into one array slot that no arm already is:
   * every arm converts on its own tag, unit arms take the stranded
   * TypeError. */
  | { how: "unionArr" }
  | { how: "arr" }
  | { how: "tupleArr" }
  /** An array claimed as a fixed tuple (`table as [Handler]` where the
   * table is typed as an array): the tuple's positions read the array's
   * elements, each converted, after a length check that throws the
   * catchable TypeError for an array of any other length. A copy, like
   * every width lift, and a checked one: asked for BY NAME by the
   * assertion that would otherwise trap (lowerer.checkedWidthLift), never
   * an answer of widthLiftPlan. */
  | { how: "arrTuple" }
  | { how: "objWidth" }
  | { how: "clsWidth" }
  | { how: "narrow" }
  | { how: "dynIn" }
  | { how: "dynOut" }
  | { how: "upcast" }
  | { how: "funcAdapt" }
  /** A method field whose parameter records differ per instantiation
   * (`Provider<"x">` into `Provider<Api>`, admitted by method bivariance):
   * funcCoerceAdapter built in checked mode. Record-field planning only. */
  | { how: "funcAdaptChecked" }
  /** A union into a union where the `trappable` source arms have no home:
   * they throw the catchable TypeError. Checked mode only. */
  | { how: "checkedRetag"; trappable: number[] }
  /** A promise whose payload widens (`Promise<void>` into `Promise<unknown>`):
   * the checked payload widening coerceToExpected applies at a promise slot,
   * which keeps the promise's identity and settlement turn. */
  | { how: "promiseWiden" };

/** The names the lowering interns its conversion helpers under. The width
 * copy scan (width-copies.ts) finds a program's conversions by them, so a
 * helper that copies its argument takes its name from here. */
export const COPY_HELPERS = {
  /** A record into a record of another layout. */
  width: "%rec.width",
  /** A record into an index-signature record (the overflow capture). */
  ovf: "%rec.capture",
  /** A class instance into a record. */
  objWidth: "%obj.width",
  /** A record into a class instance. */
  clsWidth: "%cls.width",
  /** An array into an array of another element layout. */
  arr: "%arr.width",
  /** A tuple into an array. */
  tupleArr: "%tup.arr",
} as const;

/** Helpers that route their argument to copy helpers by a union tag, a
 * discriminant or a field's presence, and copy nothing themselves. */
export const ROUTING_HELPERS = {
  unionRecord: "%union.record",
  unionArr: "%union.arr",
  presence: "%union.presence",
  recordWrap: "%record.wrap",
  recordRoute: "%record.route",
  retag: "%union.retag",
  narrowWidth: "%union.narrow.width",
} as const;

/** A checked arm extraction: it answers the object its argument holds. */
export const ARM_EXTRACTION_HELPER = "%union.narrow";

/** A written type predicate's conversion (containers/filter-predicates.ts):
 * it answers an element that already has the predicate's type and rebuilds
 * a record of another layout field by field. */
export const PREDICATE_HELPER = "%narrow.checked";
