import type { IrType } from "../../../ir/ir.js";
import type * as ts from "../../ts7/adapter.js";
import type { Lowerer } from "../lowerer.js";

/** Per-compilation conversion state. Recursive plans are scoped to the
 * active planning stack; only fully validated copy routes are memoized. */
export class CoercionState {
  // Re-entering a recursive pair assumes it is coercible while the outer
  // plan checks its other fields. Remove every assumption on unwind;
  // generated helpers must intern their names before building their bodies.
  readonly planning = new Set<string>();
  // Registry revisions invalidate only fully validated copy-only routes.
  readonly copyRetags = new Map<string, { name: string; shapes: number; unions: number }>();
  // Provenance for checked extraction; consumers must not infer it from names.
  readonly checkedNarrows = new Set<string>();
  // The extracted arm of each checked (non-defaulting) extraction helper.
  readonly checkedNarrowArms = new Map<
    string,
    {
      unionId: string;
      tag: number;
      target: IrType;
      widens?: true;
      message?: string;
      origin?: string;
    }
  >();
  readonly retags = new Map<string, string>();
  readonly narrows = new Map<string, string>();
  readonly widthNarrows = new Map<string, string>();
  /** Unions widenReducedReturn produced: only these read through the
   * width-converting extraction (widthNarrowHelper). */
  readonly widenedReturns = new Set<string>();
  /** widenReducedReturn's results by declaration and inferred return type,
   * for the results computed without cutting a widening cycle through
   * another function. Each keeps the type-parameter bindings it was mapped
   * under and answers only under the same bindings. */
  readonly widenedReturnTypes = new Map<ts.Node, Map<ts.Type, WidenedReturn>>();
}

/** A widened inferred return type and the lowering state that mapped it
 * (Lowerer.typeParamBindings and its checker-type and implicit-any twins,
 * and whether an erased generic body is lowering). */
export interface WidenedReturn {
  type: IrType;
  bindings: Lowerer["typeParamBindings"];
  tsBindings: Lowerer["typeParamTsBindings"];
  implicit: Lowerer["implicitParamTypes"];
  erasing: boolean;
}
