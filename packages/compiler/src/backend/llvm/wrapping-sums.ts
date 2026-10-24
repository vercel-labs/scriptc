import type { IrExpr, IrFunction, IrStmt } from "../../ir/ir.js";
import { everyExprChild, everyStmtChild } from "../../ir/traverse.js";
import { integerArithmeticRange, type IntegerRange } from "../../ir/integer-ranges.js";
import type { LlValue, LlvmEmitterContext } from "./expr-context.js";
import type { LlInteger } from "./integer-values.js";

/** Marks the `+`, `-` and `*` operands whose number only reaches
 * ToInt32/ToUint32 consumers (`| 0`, the other bitwise operators,
 * `Math.imul`, `Math.clz32`), directly or through further sums and
 * products, in the emitter's `wrappingSums`. Called by the consumer before
 * its operands emit. */
export function markWrappingOperands(host: LlvmEmitterContext, ...operands: IrExpr[]): void {
  for (const operand of operands) {
    if (operand.kind !== "bin" || (operand.op !== "+" && operand.op !== "-" && operand.op !== "*"))
      continue;
    if (operand.type.kind !== "f64" || host.wrappingSums.has(operand)) continue;
    host.wrappingSums.add(operand);
    markWrappingOperands(host, operand.left, operand.right);
  }
}

/** The values an f64 expression can have when each one is an exact integer
 * (never -0) or NaN: proven ranges, safe integer literals, NaN-coded reads
 * of integer typed-array elements and of Int32[] elements, `charCodeAt`,
 * and sums and differences of those whose every integer result is still
 * exact in a double. */
export function integerOrNaNRange(host: LlvmEmitterContext, e: IrExpr): IntegerRange | null {
  if (e.type.kind !== "f64") return null;
  const range = host.integerRanges.get(e);
  if (range) return range;
  if (e.kind === "numLit")
    return Number.isSafeInteger(e.value) && !Object.is(e.value, -0)
      ? { min: e.value, max: e.value }
      : null;
  if (
    e.kind === "bytesIntrinsic" &&
    e.method === "get" &&
    e.invalidNaN === true &&
    e.receiver.type.kind === "bytes"
  )
    return ELEMENT_RANGES[e.receiver.type.elem] ?? null;
  // ToNumber of an Int32[] element read: the stored int32, or NaN for a
  // hole, a present undefined or a missing index.
  if (
    e.kind === "arrIntrinsic" &&
    e.method === "getNumber" &&
    host.int32Elements !== null &&
    host.int32Elements(e.receiver)
  )
    return ELEMENT_RANGES.i32!;
  // A UTF-16 code unit, or NaN past either end.
  if (e.kind === "strIntrinsic" && e.method === "charCodeAt") return { min: 0, max: 65535 };
  if (e.kind === "varRef") return host.integerOrNaNLocals.get(e.localId) ?? null;
  if (e.kind === "bin" && (e.op === "+" || e.op === "-")) {
    const left = integerOrNaNRange(host, e.left);
    const right = left && integerOrNaNRange(host, e.right);
    return right ? integerArithmeticRange(e.op, left!, right) : null;
  }
  return null;
}

/** An index that is an exact integer or NaN (`integerOrNaNRange`): the integer as an i64, and an
 * i1 that is false when the index is NaN. An index check then needs no round trip through a double:
 * the integer is the value's ToUint32 view where the range proves it holds the whole value, or one
 * conversion, which is exact for a safe integer and frozen, since the conversion of NaN is poison.
 * Null for any other index. */
export function integerOrNaNIndex(
  host: LlvmEmitterContext,
  value: LlValue,
  expr: IrExpr | undefined,
): { wide: string; ordered: string } | null {
  const range = expr ? integerOrNaNRange(host, expr) : null;
  if (!range) return null;
  const B = host.B;
  const ordered = B.tmp();
  const wide = B.tmp();
  B.line(`${ordered} = fcmp ord double ${value.name}, 0.0`);
  if (value.uint32 !== undefined && range.min >= 0 && range.max <= 4294967295) {
    B.line(`${wide} = zext i32 ${value.uint32} to i64`);
  } else if (value.uint32 !== undefined && range.min >= -2147483648 && range.max <= 2147483647) {
    B.line(`${wide} = sext i32 ${value.uint32} to i64`);
  } else {
    const raw = B.tmp();
    B.line(`${raw} = fptosi double ${value.name} to i64`);
    B.line(`${wide} = freeze i64 ${raw}`);
  }
  return { wide, ordered };
}

const ELEMENT_RANGES: Partial<Record<string, IntegerRange>> = {
  u8: { min: 0, max: 255 },
  u8c: { min: 0, max: 255 },
  i8: { min: -128, max: 127 },
  u16: { min: 0, max: 65535 },
  i16: { min: -32768, max: 32767 },
  u32: { min: 0, max: 4294967295 },
  i32: { min: -2147483648, max: 2147483647 },
};

/** The low 32 bits of an operand (0 for NaN), and an i1 that is false when
 * it is NaN (null when it never is). */
function wrappingOperand(
  host: LlvmEmitterContext,
  value: LlValue,
  integer: LlInteger | null,
  range: IntegerRange,
): { low: string; valid: string | null } {
  const B = host.B;
  if (integer) {
    if (integer.type === "i32") return { low: integer.name, valid: null };
    const low = B.tmp();
    B.line(`${low} = trunc i64 ${integer.name} to i32`);
    return { low, valid: null };
  }
  // The number is an exact integer or NaN, and its ToUint32 view is the
  // integer's low 32 bits or 0. An ordered compare tells the two apart.
  const valid = B.tmp();
  B.line(`${valid} = fcmp ord double ${value.name}, 0.0`);
  if (value.uint32 !== undefined) return { low: value.uint32, valid };
  // Without a view, convert once. The conversion of NaN is poison, but the
  // result only selects the sum when every operand is ordered.
  const low = B.tmp();
  if (range.min >= -2147483648 && range.max <= 2147483647) {
    B.line(`${low} = fptosi double ${value.name} to i32`);
  } else {
    const wide = B.tmp();
    B.line(`${wide} = fptosi double ${value.name} to i64`);
    B.line(`${low} = trunc i64 ${wide} to i32`);
  }
  return { low, valid };
}

/** ToUint32 of `left op right` (`+`, `-` or `*`) in 32-bit arithmetic when
 * the expression only reaches ToInt32/ToUint32 consumers and both operands
 * are exact integers or NaN with an exact result. Both conversions are
 * arithmetic mod 2^32, so the wrapping i32 sum or product of the operands'
 * low halves is the converted exact result; a NaN operand makes the result
 * NaN, which converts to 0. A product is exact when the operands' magnitude
 * bounds multiply to at most 2^53; it may be -0 (`0 * -1`), which converts
 * to 0 like the integer 0. Returns undefined, emitting nothing, for any
 * other expression. */
export function emitWrappingSum(
  host: LlvmEmitterContext,
  e: IrExpr & { kind: "bin" },
  l: LlValue,
  r: LlValue,
  li: LlInteger | null,
  ri: LlInteger | null,
): string | undefined {
  if ((e.op !== "+" && e.op !== "-" && e.op !== "*") || !host.wrappingSums.has(e)) return undefined;
  const leftRange = li ? li.range : integerOrNaNRange(host, e.left);
  const rightRange = leftRange && (ri ? ri.range : integerOrNaNRange(host, e.right));
  if (!rightRange) return undefined;
  if (
    e.op === "*"
      ? !exactProduct(leftRange!, rightRange)
      : !integerArithmeticRange(e.op, leftRange!, rightRange)
  )
    return undefined;
  const B = host.B;
  const left = wrappingOperand(host, l, li, leftRange!);
  const right = wrappingOperand(host, r, ri, rightRange);
  const sum = B.tmp();
  B.line(
    `${sum} = ${e.op === "+" ? "add" : e.op === "-" ? "sub" : "mul"} i32 ${left.low}, ${right.low}`,
  );
  let valid = left.valid ?? right.valid;
  if (valid === null) return sum;
  if (left.valid && right.valid) {
    valid = B.tmp();
    B.line(`${valid} = and i1 ${left.valid}, ${right.valid}`);
  }
  const out = B.tmp();
  B.line(`${out} = select i1 ${valid}, i32 ${sum}, i32 0`);
  return out;
}

/** Whether every product of a value in `left` and one in `right` is an
 * integer of magnitude at most 2^53, which the double product holds
 * exactly. */
function exactProduct(left: IntegerRange, right: IntegerRange): boolean {
  const magnitude = (range: IntegerRange): number =>
    Math.max(Math.abs(range.min), Math.abs(range.max));
  return magnitude(left) * magnitude(right) <= 2 ** 53;
}

/** The number locals of `fn` that only hold exact integers (never -0) or NaN, with the range of
 * those integers: locals declared once with an initializer, neither parameters nor captured or
 * boxed, whose initializer and every later write `integerOrNaNRange` covers. A local joins once
 * the values it is written depend only on locals that have joined, so `x = x + 1` keeps `x` out:
 * its values have no bound. Uses the function's `integerRanges` and `int32Elements`. */
export function findIntegerOrNaNLocals(
  host: LlvmEmitterContext,
  fn: IrFunction,
): ReadonlyMap<string, IntegerRange> {
  const found = new Map<string, IntegerRange>();
  if (fn.async || fn.generator) return found;
  const excluded = new Set<string>();
  for (const param of fn.params) excluded.add(param.localId);
  for (const capture of fn.captures ?? []) excluded.add(capture.localId);
  for (const capture of fn.classCaptures ?? []) excluded.add(capture.localId);
  const candidates = new Set<string>();
  for (const local of fn.locals)
    if (local.type.kind === "f64" && !local.boxed && !local.tdz && !excluded.has(local.id))
      candidates.add(local.id);
  if (candidates.size === 0) return found;
  const declared = new Set<string>();
  const writes = new Map<string, IrExpr[]>();
  const drop = (id: string): void => {
    candidates.delete(id);
    writes.delete(id);
  };
  const write = (id: string, value: IrExpr): void => {
    if (!candidates.has(id)) return;
    const list = writes.get(id);
    if (list) list.push(value);
    else writes.set(id, [value]);
  };
  function walkExpr(e: IrExpr): boolean {
    if (e.kind === "assignExpr") write(e.localId, e.value);
    else if (e.kind === "incDec") drop(e.localId);
    return everyExprChild(e, walkExpr, walkStmt);
  }
  function walkStmt(s: IrStmt): boolean {
    if (s.kind === "assign") write(s.localId, s.value);
    else if (s.kind === "varDecl") {
      if (s.init === null || declared.has(s.localId)) drop(s.localId);
      else {
        declared.add(s.localId);
        write(s.localId, s.init);
      }
    } else if (s.kind === "forOf") drop(s.localId);
    else if (s.kind === "tryCatch" && s.catchLocalId) drop(s.catchLocalId);
    return everyStmtChild(s, walkExpr, walkStmt);
  }
  for (const s of fn.body) walkStmt(s);
  // `integerOrNaNRange` reads the joined locals while the next ones are tested.
  const previous = host.integerOrNaNLocals;
  host.integerOrNaNLocals = found;
  try {
    let joined = true;
    while (joined) {
      joined = false;
      for (const [id, values] of writes) {
        if (found.has(id) || !declared.has(id)) continue;
        let range: IntegerRange | null = null;
        for (const value of values) {
          const next = integerOrNaNRange(host, value);
          if (next === null) {
            range = null;
            break;
          }
          range =
            range === null
              ? next
              : { min: Math.min(range.min, next.min), max: Math.max(range.max, next.max) };
        }
        if (range === null) continue;
        found.set(id, range);
        joined = true;
      }
    }
  } finally {
    host.integerOrNaNLocals = previous;
  }
  return found;
}
