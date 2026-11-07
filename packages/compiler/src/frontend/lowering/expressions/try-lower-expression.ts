import type { IrExpr } from "../../../ir/ir.js";
import * as ts from "../../ts7/adapter.js";
import { PoisonError } from "../lowerer.js";
import type { Lowerer } from "../lowerer.js";

/**
 * Attempts to lower an expression and returns null when the candidate hits a normal unsupported-feature fence. Diagnostics from declined candidates are discarded, while diagnostics from successful candidates are retained.
 *
 * A refusal that left nothing behind (Lowerer.probeEffects) is recorded, so the caller's next request for the same operand inside a probe is refused without lowering it again.
 */
export function tryLowerExpression(lowerer: Lowerer, node: ts.Expression): IrExpr | null {
  const saved = lowerer.diagSink;
  const captured: typeof lowerer.diags = [];
  lowerer.diagSink = captured;
  const effects = lowerer.probeEffects();
  let result: IrExpr | null;
  try {
    result = lowerer.lowerExpr(node);
  } catch (error) {
    lowerer.diagSink = saved;
    if (error instanceof PoisonError) {
      if (lowerer.probeEffects() === effects) lowerer.noteRefusedProbe(node, captured);
      return null;
    }
    throw error;
  }
  lowerer.diagSink = saved;
  for (const diagnostic of captured) lowerer.pushDiag(diagnostic);
  return result;
}
