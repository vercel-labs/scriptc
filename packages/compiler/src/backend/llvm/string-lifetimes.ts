import { isStableReceiverOperand } from "../../ir/analysis.js";
import type { IrExpr, IrStrIntrinsicMethod } from "../../ir/ir.js";
import type { LlValue, LlvmEmitterContext } from "./expr-context.js";
import { borrowableInputs } from "./borrowed-inputs.js";

/** These methods consume string pointers only for the duration of their
 * runtime call. Reference results carry their own owner, even when the
 * runtime returns an unchanged input. Keep new methods conservative until
 * their ownership contract has been checked. */
export function borrowsStringInputs(method: IrStrIntrinsicMethod): boolean {
  switch (method) {
    case "length":
    case "charCodeAt":
    case "charAt":
    case "indexOf":
    case "includes":
    case "startsWith":
    case "endsWith":
    case "slice":
    case "substring":
    case "repeat":
    case "trim":
    case "trimStart":
    case "trimEnd":
    case "split":
    case "padStart":
    case "padEnd":
    case "toLowerCase":
    case "toUpperCase":
    case "normalize":
    case "isWellFormed":
    case "toWellFormed":
    case "byteLength":
    case "cpAtByte":
      return true;
    default:
      return false;
  }
}

/** No callback, suspension or reference write can invalidate an earlier
 * borrowed string during these expressions. Numeric assignment is handled
 * by the receiver proof; string assignment deliberately stays on the owned
 * path. A future expression kind does not inherit this guarantee. */
function preservesStringInputs(value: IrExpr, localId: string): boolean {
  if (isStableReceiverOperand(value, localId)) return true;
  switch (value.kind) {
    case "strLit":
      return true;
    case "strEq":
    case "strCmp":
    case "strConcat":
      return (
        preservesStringInputs(value.left, localId) && preservesStringInputs(value.right, localId)
      );
    case "strIntrinsic":
      return (
        borrowsStringInputs(value.method) &&
        preservesStringInputs(value.receiver, localId) &&
        value.args.every((arg) => preservesStringInputs(arg, localId))
      );
    default:
      return false;
  }
}

/** Evaluate left to right. An immutable local or immortal literal owns its
 * value across later operands. A writable binding needs a snapshot unless
 * the remaining expressions preserve it. Projections also require those
 * expressions to preserve every reference edge; other values keep ownership. */
export function emitStringInputs(host: LlvmEmitterContext, inputs: readonly IrExpr[]): LlValue[] {
  const borrowed = borrowableInputs(host, inputs);
  return inputs.map((value, index) => {
    if (value.type.kind !== "string") return host.emitExpr(value);
    if (value.kind === "strLit") return { name: host.internLiteral(value.value), type: value.type };
    if (borrowed[index]) return host.emitReadReceiver(value);
    if (
      value.kind === "varRef" &&
      inputs.slice(index + 1).every((next) => preservesStringInputs(next, value.localId))
    ) {
      return host.emitReadReceiver(value);
    }
    return host.emitExpr(value);
  });
}
