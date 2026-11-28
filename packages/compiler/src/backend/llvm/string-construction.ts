import type { IrExpr } from "../../ir/ir.js";
import type { LlValue, LlvmEmitterContext } from "./expr-context.js";
import { emitStringByteLength } from "./string-reads.js";
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

/** The two operand arrays scr_str_concat_mixed takes: strings (null for a
 * number operand) and numbers, one entry per part. */
export interface MixedConcatSlots {
  readonly strings: string;
  readonly numbers: string;
  readonly count: number;
}

/** Evaluate `values` left to right into the arrays the mixed concatenation
 * reads: number values (f64) select the numeric operand, strings are
 * borrowed. Split from the call so a self-append site can check the length
 * before it lets go of the container's reference. */
export function emitMixedConcatInputs(
  host: LlvmEmitterContext,
  values: readonly LlValue[],
): MixedConcatSlots {
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
  return { strings, numbers, count };
}

/** scr_str_concat_mixed over evaluated inputs: `head` is a string the
 * caller owns, or null. Returns the +1 result. A result past Node's maximum
 * string length throws its catchable RangeError, hence the pending check. */
export function emitMixedConcatCall(
  host: LlvmEmitterContext,
  head: string | null,
  slots: MixedConcatSlots,
  moveHead = false,
): string {
  const fn = moveHead ? "scr_str_concat_mixed_move" : "scr_str_concat_mixed";
  host.declare(`declare ptr @${fn}(ptr, ptr, ptr, ${host.sizeType})`);
  const result = host.B.tmp();
  host.B.line(
    `${result} = call ptr @${fn}(ptr ${head ?? "null"}, ptr ${slots.strings}, ptr ${slots.numbers}, ${host.sizeType} ${slots.count})`,
  );
  host.emitPendingCheck();
  return result;
}

/** Node's maximum string length in UTF-16 code units (0x1fffffe8). */
const STRING_MAX_UNITS = "536870888";

/** The inline length test for a self-append site: the sum of two byte
 * lengths, which bounds the UTF-16 length from above, against the maximum.
 * Only a sum past the bound enters the cold runtime check, so the hot append
 * path carries two loads, an add and one predicted branch. Throws Node's
 * RangeError before the site lets go of its reference. */
function emitGrowthBranch(host: LlvmEmitterContext, sum: string, check: () => void): void {
  const B = host.B;
  const over = B.tmp();
  B.line(`${over} = icmp ugt ${host.sizeType} ${sum}, ${STRING_MAX_UNITS}`);
  const slow = B.newLabel("str.check");
  const ok = B.newLabel("str.ok");
  B.condBr(over, slow, ok);
  B.startBlock(slow);
  check();
  host.emitPendingCheck();
  B.br(ok);
  B.startBlock(ok);
}

/** The length check for a self-append of one string (scr_str_growth_check2). */
export function emitConcatCheck(host: LlvmEmitterContext, a: string, b: string): void {
  const sum = host.B.tmp();
  host.B.line(
    `${sum} = add ${host.sizeType} ${emitStringByteLength(host, a)}, ${emitStringByteLength(host, b)}`,
  );
  emitGrowthBranch(host, sum, () => {
    host.declare(`declare void @scr_str_growth_check2(ptr, ptr)`);
    host.B.line(`call void @scr_str_growth_check2(ptr ${a}, ptr ${b})`);
  });
}

/** The length check for a self-append of one code unit
 * (scr_str_growth_check_add). */
export function emitConcatAddCheck(host: LlvmEmitterContext, a: string): void {
  const sum = host.B.tmp();
  host.B.line(`${sum} = add ${host.sizeType} ${emitStringByteLength(host, a)}, 1`);
  emitGrowthBranch(host, sum, () => {
    host.declare(`declare void @scr_str_growth_check_add(ptr, ${host.sizeType})`);
    host.B.line(`call void @scr_str_growth_check_add(ptr ${a}, ${host.sizeType} 1)`);
  });
}

/** The length check for a self-append site with mixed parts
 * (scr_str_growth_check_parts): throws Node's RangeError before the site
 * lets go of its reference. */
export function emitMixedConcatCheck(
  host: LlvmEmitterContext,
  head: string | null,
  slots: MixedConcatSlots,
): void {
  host.declare(`declare void @scr_str_growth_check_parts(ptr, ptr, ptr, ${host.sizeType})`);
  host.B.line(
    `call void @scr_str_growth_check_parts(ptr ${head ?? "null"}, ptr ${slots.strings}, ptr ${slots.numbers}, ${host.sizeType} ${slots.count})`,
  );
  host.emitPendingCheck();
}

/** scr_str_concat_mixed over freshly evaluated inputs. */
export function emitMixedConcat(
  host: LlvmEmitterContext,
  head: string | null,
  values: readonly LlValue[],
  moveHead = false,
): string {
  return emitMixedConcatCall(host, head, emitMixedConcatInputs(host, values), moveHead);
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
  host.emitPendingCheck();
  return host.own({ name: result, type: parts[0]!.type });
}
