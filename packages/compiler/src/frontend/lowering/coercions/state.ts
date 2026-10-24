import type { IrType } from "../../../ir/ir.js";
import type * as ts from "../../ts7/adapter.js";

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
    { unionId: string; tag: number; target: IrType; widens?: true }
  >();
  readonly retags = new Map<string, string>();
  readonly narrows = new Map<string, string>();
  readonly widthNarrows = new Map<string, string>();
  /** Unions widenReducedReturn produced: only these read through the
   * width-converting extraction (widthNarrowHelper). */
  readonly widenedReturns = new Set<string>();
  /** widenReducedReturn's results by declaration and inferred return type,
   * for the results computed without cutting a recursive widening. */
  readonly widenedReturnTypes = new Map<ts.Node, Map<ts.Type, IrType>>();
}
