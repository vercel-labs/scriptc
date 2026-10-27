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
  /** An i64 holding the exact integer that the arithmetic producing this
   * number computes, when that integer has no proven safe range: its
   * absolute value is at most `bound`, and the double equals it whenever
   * its absolute value is below `below` (a zero may be -0). Index consumers
   * use it in place of a round trip (integer-values.ts `indexInteger`). */
  wideInteger?: WideInteger;
  /** An i1 SSA value (or `true`) that is true exactly when this number is
   * not NaN: set by NaN-coded integer element reads and the wrapping sums
   * of them, so ToInt32 consumers need no floating compare. */
  ordered?: string;
  /** An i64 equal to this number whenever `ordered` is true: the integer of
   * a number that is an exact integer or NaN (a NaN-coded integer element
   * read, a local that only holds those, or a sum, difference or product of
   * them), so integer consumers need no conversion of the double. */
  nanInteger?: string;
  /** The sum `base + offset` of a number local and an integer literal of
   * magnitude below 2^31: the base as the sum read it. Typed array indexes
   * convert it instead of the sum (expr-bytes.ts). */
  offsetIndex?: OffsetIndex;
  slot?: boolean;
  /** A sequence local held in a capture box; release the box itself. */
  boxed?: boolean;
  /** A group arena list slot (arenas.ts): the frame closes the newest
   * arena on it, or drops the whole list, after its other temps. */
  arena?: "close" | "drop";
}

export interface OffsetIndex {
  base: string;
  offset: number;
}

export interface WideInteger {
  name: string;
  below: number;
  bound: number;
  /** The double is the integer rounded once: the result of one operation on
   * operands that always equal their doubles. */
  single?: true;
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
  /** `@sym` of the ScrDynTypedRecordOps table for live record capsules. */
  recordOps?: string;
  /** `@sym` of the ScrDynTypedClassOps table for class instance capsules. */
  classOps?: string;
  /** `@sym` of the ScrDynTypedBagClassOps table for capsules of bag-tracked
   * class instances whose views inherit from prototype data. */
  bagClassOps?: string;
}
