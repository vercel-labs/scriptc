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
  | { how: "unionWidth" }
  | { how: "arr" }
  | { how: "tupleArr" }
  | { how: "emptyArr" }
  | { how: "objWidth" }
  | { how: "clsWidth" }
  | { how: "narrow" }
  | { how: "dynIn" }
  | { how: "dynOut" }
  | { how: "upcast" }
  | { how: "funcAdapt" };
