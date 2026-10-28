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
  | { how: "emptyArr" }
  | { how: "objWidth" }
  | { how: "clsWidth" }
  | { how: "narrow" }
  | { how: "dynIn" }
  | { how: "dynOut" }
  | { how: "upcast" }
  | { how: "funcAdapt" }
  /** A promise whose payload widens (`Promise<void>` into `Promise<unknown>`):
   * the checked payload widening coerceToExpected applies at a promise slot,
   * which keeps the promise's identity and settlement turn. */
  | { how: "promiseWiden" };
