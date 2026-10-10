/* Expression helpers share the actual emitter instance. A nominal context
 * preserves mutable state and checked method signatures without casting a
 * class to a record of closures. Layout stages use explicit callback hosts. */
import type { IrExpr, IrLibFn, IrType } from "../../ir/ir.js";
import type { LlEmitter } from "./emitter.js";
import type { IntegerRange } from "../../ir/integer-ranges.js";

export type LlvmEmitterContext = LlEmitter;

export interface LlValue {
  name: string;
  type: IrType;
  /** An i32 SSA value equal to ToUint32 of this snapshotted number. */
  uint32?: string;
  /** An exact integer snapshot, excluding negative zero, with no discarded
   * high bits and the proven range of its original value. */
  integer?: { name: string; type: "i32" | "i64"; signed: boolean; range: IntegerRange };
  slot?: boolean;
  /** A sequence local held in a capture box; release the box itself. */
  boxed?: boolean;
}

export type ExprOf<K extends IrExpr["kind"]> = Extract<IrExpr, { kind: K }>;
export type LibCallExpr = ExprOf<"libCall">;
type LibCallPrefixOf<T extends string> = T extends `${infer Prefix}.${string}` ? Prefix : never;
export type LibCallPrefix = LibCallPrefixOf<IrLibFn>;

export interface LlStreamTypedRefAdapter {
  snapshot: string;
  commit: string;
  /** `@sym` of the ScrDynTypedArrayOps table for live array capsules. */
  arrayOps?: string;
}
