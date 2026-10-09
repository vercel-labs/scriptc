import type { IrExpr } from "../../ir/ir.js";
import type { LlValue, LlvmEmitterContext } from "./expr-context.js";
import { emitStringInputs } from "./string-lifetimes.js";

const MAX_PARTS = 16;

/** Flatten only string concatenation, preserving conversion and operand
 * order. Larger trees remain operands of bounded groups, so each call uses
 * at most sixteen stack slots and does not need a heap argument array. */
export function stringParts(value: IrExpr): IrExpr[] {
  const pending = [value];
  const parts: IrExpr[] = [];
  while (pending.length > 0) {
    const part = pending.pop()!;
    if (part.kind === "strConcat" && parts.length + pending.length < MAX_PARTS - 1) {
      pending.push(part.right, part.left);
    } else {
      parts.push(part);
    }
  }
  return parts;
}

/** The number operand of a `String(number)` concatenation part. The runtime
 * formats it directly into the result; converting a number has no effects,
 * so evaluating the operand in the part's position keeps JavaScript order. */
export function numberPart(part: IrExpr): IrExpr | null {
  return part.kind === "toString" && part.operand.type.kind === "f64" ? part.operand : null;
}

/** Evaluate string parts, and the operands of number parts, left to right. */
export function emitConcatInputs(host: LlvmEmitterContext, parts: readonly IrExpr[]): LlValue[] {
  return emitStringInputs(
    host,
    parts.map((part) => numberPart(part) ?? part),
  );
}

/** scr_str_concat_mixed over evaluated inputs: number values (f64) select
 * the numeric operand, strings are borrowed. `head` is a string the caller
 * owns, or null. Returns the +1 result. */
export function emitMixedConcat(
  host: LlvmEmitterContext,
  head: string | null,
  values: readonly LlValue[],
): string {
  const B = host.B;
  const count = values.length;
  const strings = B.slot(),
    numbers = B.slot();
  B.entryAllocas.push(`${strings} = alloca [${count} x ptr]`);
  B.entryAllocas.push(`${numbers} = alloca [${count} x double]`);
  values.forEach((value, i) => {
    const slot = B.tmp();
    B.line(`${slot} = getelementptr [${count} x ptr], ptr ${strings}, i32 0, i32 ${i}`);
    if (value.type.kind === "f64") {
      const number = B.tmp();
      B.line(`store ptr null, ptr ${slot}`);
      B.line(`${number} = getelementptr [${count} x double], ptr ${numbers}, i32 0, i32 ${i}`);
      B.line(`store double ${value.name}, ptr ${number}`);
    } else {
      B.line(`store ptr ${value.name}, ptr ${slot}`);
    }
  });
  host.declare(`declare ptr @scr_str_concat_mixed(ptr, ptr, ptr, ${host.sizeType})`);
  const result = B.tmp();
  B.line(
    `${result} = call ptr @scr_str_concat_mixed(ptr ${head ?? "null"}, ptr ${strings}, ptr ${numbers}, ${host.sizeType} ${count})`,
  );
  return result;
}

/** The runtime borrows every part without mutating it. Earlier operands
 * therefore borrow only when their owners survive all later evaluations;
 * other operands retain ordinary snapshots and exception cleanup. */
export function emitStringParts(host: LlvmEmitterContext, parts: readonly IrExpr[]): LlValue {
  if (parts.some((part) => numberPart(part) !== null)) {
    const result = emitMixedConcat(host, null, emitConcatInputs(host, parts));
    return host.own({ name: result, type: parts[0]!.type });
  }
  const values = emitStringInputs(host, parts);
  const B = host.B;
  const storage = B.slot();
  B.entryAllocas.push(`${storage} = alloca [${parts.length} x ptr]`);
  for (let i = 0; i < values.length; i++) {
    const slot = B.tmp();
    B.line(`${slot} = getelementptr [${parts.length} x ptr], ptr ${storage}, i32 0, i32 ${i}`);
    B.line(`store ptr ${values[i]!.name}, ptr ${slot}`);
  }
  host.declare(`declare ptr @scr_str_concat_parts(ptr, ${host.sizeType})`);
  const result = B.tmp();
  B.line(
    `${result} = call ptr @scr_str_concat_parts(ptr ${storage}, ${host.sizeType} ${parts.length})`,
  );
  return host.own({ name: result, type: parts[0]!.type });
}
