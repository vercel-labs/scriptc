/* Focused LLVM expression emission extracted from emitter.ts. */
import { InternalCompilerError } from "../../errors.js";
import { matchStringSelfConcat, undefinedArmTag } from "../../ir/analysis.js";
import { isRefCounted, type IrExpr, type IrStrCmpOp, type IrType } from "../../ir/ir.js";
import { mangleRecordClone, mangleRecordNew } from "../mangle.js";
import { arrNewCall, elemAccess } from "./shapes.js";
import { LlvmUnsupportedError } from "./unsupported.js";
import { offsetIndex } from "./expr-bytes.js";
import type { LlvmEmitterContext, ExprOf, LlValue } from "./expr-context.js";

import { BYTES_ELEM_NUM, closureIdentityEqual, f64Lit } from "./common.js";
import { CHECKED_INT32_MIN_LENGTH } from "../../ir/int32-arrays.js";
import { emitStringInputs } from "./string-lifetimes.js";
import { emitStringParts, numberPart, stringParts } from "./string-construction.js";
import { emitBorrowedInputs } from "./borrowed-inputs.js";
import {
  exactCompareOperands,
  exactInteger,
  int32Number,
  integerNumber,
  narrowInteger,
  wideArithmetic,
  widenInteger,
  type LlInteger,
} from "./integer-values.js";
import {
  bitwiseIdentityOperand,
  INT32_RANGE,
  integerArithmeticRange,
  isBitwiseOp,
  withinInt32,
  withinUint32,
} from "../../ir/integer-ranges.js";
import { charAtUnitRead, emitArrayValues } from "./expr-containers.js";
import {
  constantDivisor,
  emitCheckedRemainder,
  emitPowerOfTwoRemainder,
  emitSignedIntegerRemainder,
} from "./integer-remainder.js";
import {
  denseSlotWidth,
  emitDenseArrayRead,
  emitDenseArrayState,
  runtimeAccess,
  SCR_ELEM_I32,
  slotWidth,
  type ArrayAccess,
} from "./dense-array-access.js";
import {
  emitNanArithmetic,
  emitWrappingSum,
  integerOrNaNRange,
  markWrappingOperands,
} from "./wrapping-sums.js";
import { emitPowF64, emitPowerOfTwoQuotient, isPowerOfTwoCall } from "./lib-filesystem.js";

/** The signed integer predicates of the number compares. */
const INTEGER_COMPARES: Record<string, string> = {
  "<": "slt",
  "<=": "sle",
  ">": "sgt",
  ">=": "sge",
  "===": "eq",
  "!==": "ne",
};

const UNSIGNED_COMPARES: Record<string, string> = {
  "<": "ult",
  "<=": "ule",
  ">": "ugt",
  ">=": "uge",
  "===": "eq",
  "!==": "ne",
};

/** A number compare of operands that are each an exact integer or an
 * integer-or-NaN value (integerOrNaNRange: integer typed-array elements,
 * `charCodeAt` results, sums of those), all within int32 or all within
 * uint32: their 32-bit views compared, and NaN comparing false (unequal for
 * `!==`). The 32-bit view is the value's ToUint32, which holds its bits
 * whenever it is not NaN. Null when an operand has no such view. */
function emitIntegerOrNaNCompare(
  host: LlvmEmitterContext,
  e: ExprOf<"bin">,
  l: LlValue,
  li: LlInteger | null,
  r: LlValue,
  ri: LlInteger | null,
): string | null {
  const lr = li?.range ?? integerOrNaNRange(host, e.left),
    rr = ri?.range ?? integerOrNaNRange(host, e.right);
  if (!lr || !rr) return null;
  const signed = withinInt32(lr) && withinInt32(rr);
  if (!signed && !(withinUint32(lr) && withinUint32(rr))) return null;
  const bits = (value: LlValue, integer: LlInteger | null): string | undefined =>
    integer ? narrowInteger(host, integer) : value.uint32;
  const left = bits(l, li),
    right = bits(r, ri);
  if (left === undefined || right === undefined) return null;
  const B = host.B;
  const compare = B.tmp();
  B.line(
    `${compare} = icmp ${(signed ? INTEGER_COMPARES : UNSIGNED_COMPARES)[e.op]} i32 ${left}, ${right}`,
  );
  let result = compare;
  for (const [value, integer] of [
    [l, li],
    [r, ri],
  ] as const) {
    if (integer) continue;
    const ordered = B.tmp(),
      combined = B.tmp();
    B.line(`${ordered} = fcmp ord double ${value.name}, 0.0`);
    if (e.op === "!==") {
      const unordered = B.tmp();
      B.line(`${unordered} = xor i1 ${ordered}, true`);
      B.line(`${combined} = or i1 ${result}, ${unordered}`);
    } else B.line(`${combined} = and i1 ${result}, ${ordered}`);
    result = combined;
  }
  return result;
}

export function emitLiteralExpr(
  host: LlvmEmitterContext,
  e: ExprOf<"numLit" | "boolLit" | "strLit" | "moduleNsRef" | "unitLit" | "varRef">,
): LlValue {
  const B = host.B;
  switch (e.kind) {
    case "numLit":
      return { name: f64Lit(e.value), type: e.type, uint32: String(e.value >>> 0) };
    case "boolLit":
      return { name: e.value ? "true" : "false", type: e.type };
    case "strLit": {
      const sym = host.internLiteral(e.value);
      return host.own({ name: host.retainFrame(sym, e.type), type: e.type });
    }
    case "moduleNsRef": {
      const sym = host.internLiteral(`module:${e.moduleId}`);
      return host.own({ name: host.retainFrame(sym, e.type), type: e.type });
    }
    case "unitLit":
      // unitLits are consumed inline by the unionWrap case (a unit arm is
      // tag-only); one reaching the generic dispatch escaped its wrap.
      throw new InternalCompilerError(`llvm emitter bug: bare unitLit '${e.unit}'`);
    case "varRef": {
      host.materializeSplitLocal(e.localId);
      const integerSlot =
        host.integerLoopBindings.get(e.localId) ?? host.integerTemps.get(e.localId);
      if (integerSlot !== undefined) {
        const integer = B.tmp();
        const number = B.tmp();
        B.line(`${integer} = load ${integerSlot.type}, ptr ${integerSlot.slot}`);
        const uint32 = integerSlot.type === "i32" ? integer : B.tmp();
        if (integerSlot.type !== "i32")
          B.line(`${uint32} = trunc ${integerSlot.type} ${integer} to i32`);
        // An int32 counter (a dense array loop's) converts from its low half,
        // so LLVM folds a later `fptosi` of the double (an inlined callee's
        // index) back to the integer. Otherwise a 64-bit induction value is
        // a safe integer, so its sign bit is clear and the signed conversion
        // is exact: one cvtsi2sd instead of x86-64's multi-instruction
        // unsigned 64-bit conversion. (A uint32 counter would fold through
        // `uitofp i32` too, but the zero extension it adds on x86-64 cost
        // more in loops that never convert the double than it saved.)
        const range = integerSlot.range;
        const signedConversion = integerSlot.signed === true || integerSlot.type === "i64";
        if (range && range.min >= -2147483648 && range.max <= 2147483647)
          B.line(`${number} = sitofp i32 ${uint32} to double`);
        else
          B.line(
            `${number} = ${signedConversion ? "sitofp" : "uitofp"} ${integerSlot.type} ${integer} to double`,
          );
        return {
          name: number,
          type: e.type,
          uint32,
          integer: {
            name: integer,
            type: integerSlot.type,
            signed: integerSlot.signed === true,
            range: integerSlot.range ?? { min: 0, max: Number.MAX_SAFE_INTEGER },
          },
        };
      }
      if (host.int32Locals.has(e.localId)) {
        const bits = B.tmp();
        B.line(`${bits} = load i32, ptr ${host.binding(e.localId).slot}`);
        return host.int32LocalValue(e.localId, bits, e.type);
      }
      const b = host.binding(e.localId);
      if (b.kind === "global") host.checkGlobalTdz(e.localId);
      if (b.kind === "boxed") {
        // Reads go through the shared binding; ref kinds come out +1.
        // Forward-captured bindings (tdz) test the box's payload slot
        // first: empty is the temporal dead zone (catchable
        // ReferenceError, Node's message).
        const box = host.loadBox(b.slot);
        if (b.local!.tdz === true) {
          const v = host.tdzBoxRead(box, e.type, b.local!.name);
          return host.own({ name: host.adoptHeap(v, e.type), type: e.type });
        }
        const v = host.boxGet(box, e.type);
        return host.own({ name: host.adoptHeap(v, e.type), type: e.type });
      }
      const t = B.tmp();
      B.line(`${t} = load ${host.llType(b.type)}, ptr ${b.slot}${host.slotAlias(e.localId)}`);
      const integerView = host.integerViews.get(e.localId);
      if (integerView !== undefined) {
        // Snapshot both representations before later operands can write
        // the binding. Consumers must not reload its current view.
        const uint32 = B.tmp();
        B.line(`${uint32} = load i32, ptr ${integerView}`);
        const orderedView = host.orderedViews.get(e.localId);
        const range = orderedView && host.integerOrNaNLocals.get(e.localId);
        if (!orderedView || !range) return { name: t, type: e.type, uint32 };
        const ordered = B.tmp();
        B.line(`${ordered} = load i1, ptr ${orderedView}`);
        // The view holds the integer's low 32 bits (0 for NaN): its integer
        // when the range is within int32 or uint32.
        const signed = range.min >= -2147483648 && range.max <= 2147483647;
        if (!signed && !(range.min >= 0 && range.max <= 4294967295))
          return { name: t, type: e.type, uint32, ordered };
        const nanInteger = B.tmp();
        B.line(`${nanInteger} = ${signed ? "sext" : "zext"} i32 ${uint32} to i64`);
        return { name: t, type: e.type, uint32, ordered, nanInteger };
      }
      if (isRefCounted(e.type)) {
        // An immortal Immutable constant: nothing to count.
        if (b.kind === "global" && host.immortalGlobals.has(e.localId))
          return host.markImmortal({ name: t, type: e.type });
        // The binding's last read takes over its reference (lastUseRead).
        if (host.takeLastUseMove(e, b.slot, b.type)) return host.own({ name: t, type: e.type });
        return host.own({ name: host.retainFrame(t, e.type), type: e.type });
      }
      return { name: t, type: e.type };
    }
    default: {
      const _exhaustive: never = e;
      void _exhaustive;
      throw new InternalCompilerError("unreachable");
    }
  }
}

export function emitOperatorExpr(
  host: LlvmEmitterContext,
  e: ExprOf<"bin" | "unary" | "incDec" | "fieldIncDec" | "assignExpr" | "seqExpr">,
): LlValue {
  const B = host.B;
  switch (e.kind) {
    case "bin": {
      // UTF-8 and UTF-16 disagree on length, but agree exactly on zero.
      // A literal comparison has no second operand effects; evaluate the
      // receiver once and keep its normal ownership through the load.
      if (e.op === "===" || e.op === "!==") {
        const length =
          e.left.kind === "numLit" && e.left.value === 0
            ? e.right
            : e.right.kind === "numLit" && e.right.value === 0
              ? e.left
              : null;
        if (
          length?.kind === "strIntrinsic" &&
          length.method === "length" &&
          length.args.length === 0
        ) {
          const receiver = emitStringInputs(host, [length.receiver])[0]!;
          const pointer = B.tmp(),
            bytes = B.tmp(),
            result = B.tmp();
          B.line(
            `${pointer} = getelementptr inbounds ${host.sizeType}, ptr ${receiver.name}, i32 1`,
          );
          B.line(`${bytes} = load ${host.sizeType}, ptr ${pointer}`);
          B.line(`${result} = icmp ${e.op === "===" ? "eq" : "ne"} ${host.sizeType} ${bytes}, 0`);
          return { name: result, type: e.type };
        }
      }
      // JavaScript folds literal 0 / 0 to its positive NaN constant.
      // An unoptimized x86 division produces a negative NaN instead,
      // whose sign is observable through Buffer and typed-array writes.
      if (
        e.op === "/" &&
        e.left.kind === "numLit" &&
        e.right.kind === "numLit" &&
        e.left.value === 0 &&
        e.right.value === 0
      ) {
        return { name: f64Lit(NaN), type: e.type };
      }
      // Reference identity only reads the two pointers, so its operands can
      // borrow instead of taking a retain/release pair around one compare.
      // borrowableInputs keeps left-to-right evaluation and the owning
      // fallback for each operand.
      const identity =
        (e.op === "===" || e.op === "!==") &&
        e.left.type.kind !== "bool" &&
        host.llType(e.left.type) === "ptr";
      // A sum that only feeds the conversion of a bitwise operator can be
      // computed in 32 bits (emitWrappingSum).
      if (isBitwiseOp(e.op)) markWrappingOperands(host, e.left, e.right);
      const operands = identity
        ? emitBorrowedInputs(host, [e.left, e.right])
        : [host.emitExpr(e.left), host.emitExpr(e.right)];
      const l = operands[0]!;
      const r = operands[1]!;
      const t = B.tmp();
      // Strict frem has JS's truncating remainder semantics, including
      // signed zero, while exposing constant divisors to LLVM.
      const arith: Record<string, string> = {
        "+": "fadd",
        "-": "fsub",
        "*": "fmul",
        "/": "fdiv",
        "%": "frem",
      };
      const cmp: Record<string, string> = {
        "<": "olt",
        "<=": "ole",
        ">": "ogt",
        ">=": "oge",
        "===": "oeq",
        "!==": "une",
      };
      const bit: Record<string, "and" | "or" | "xor" | "shl" | "ashr" | "lshr"> = {
        "&": "and",
        "|": "or",
        "^": "xor",
        "<<": "shl",
        ">>": "ashr",
        ">>>": "lshr",
      };
      if ((e.op === "===" || e.op === "!==") && e.left.type.kind === "bool") {
        B.line(`${t} = icmp ${e.op === "===" ? "eq" : "ne"} i1 ${l.name}, ${r.name}`);
      } else if (
        (e.op === "===" || e.op === "!==") &&
        e.left.type.kind === "promise" &&
        e.right.type.kind === "promise"
      ) {
        host.declare(`declare zeroext i1 @scr_promise_identity_equal(ptr, ptr)`);
        const equal = e.op === "===" ? t : B.tmp();
        B.line(
          `${equal} = call zeroext i1 @scr_promise_identity_equal(ptr ${l.name}, ptr ${r.name})`,
        );
        if (e.op === "!==") B.line(`${t} = xor i1 ${equal}, true`);
      } else if (
        (e.op === "===" || e.op === "!==") &&
        e.left.type.kind === "func" &&
        e.right.type.kind === "func"
      ) {
        // A signature adapter stands for the function it adapts, so
        // function identity compares the closures' identity roots.
        const equal = e.op === "===" ? t : B.tmp();
        B.line(`${equal} = ${closureIdentityEqual(host, l.name, r.name)}`);
        if (e.op === "!==") B.line(`${t} = xor i1 ${equal}, true`);
      } else if ((e.op === "===" || e.op === "!==") && host.llType(e.left.type) === "ptr") {
        // Reference identity (JS object equality) — closures, arrays,
        // records compared as pointers, exactly the C `==`.
        B.line(`${t} = icmp ${e.op === "===" ? "eq" : "ne"} ptr ${l.name}, ${r.name}`);
      } else if (arith[e.op] !== undefined || cmp[e.op] !== undefined) {
        if (e.left.type.kind !== "f64")
          throw new LlvmUnsupportedError(`bin:${e.op}:${e.left.type.kind}`, e.loc);
        const li = exactInteger(host, l, e.left),
          ri = exactInteger(host, r, e.right);
        if (li && ri) {
          const range = e.op === "%" ? null : integerArithmeticRange(e.op, li.range, ri.range);
          if (range && withinInt32(range) && withinInt32(li.range) && withinInt32(ri.range)) {
            // Int32 operands and result: 32-bit arithmetic that cannot
            // overflow. The nsw flag survives where a truncated 64-bit
            // result would lose it, so LLVM can widen loop counters such
            // as `i = (i + 1) | 0` into 64-bit address arithmetic.
            const result = B.tmp();
            B.line(
              `${result} = ${e.op === "+" ? "add" : e.op === "-" ? "sub" : "mul"} nsw i32 ${narrowInteger(host, li)}, ${narrowInteger(host, ri)}`,
            );
            return int32Number(host, result, range, e.type);
          }
          const left = widenInteger(host, li),
            right = widenInteger(host, ri);
          if (range) {
            const result = B.tmp();
            B.line(
              `${result} = ${e.op === "+" ? "add" : e.op === "-" ? "sub" : "mul"} nsw i64 ${left}, ${right}`,
            );
            const number = integerNumber(host, result, range, e.type);
            const wrapped = emitWrappingSum(host, e, l, r, li, ri);
            return wrapped === undefined ? number : { ...number, ...wrapped };
          }
          if (e.op === "%" && li.range.min >= 0 && ri.range.min > 0) {
            const range = { min: 0, max: Math.min(li.range.max, ri.range.max - 1) };
            if (withinInt32(li.range) && withinInt32(ri.range)) {
              // LLVM does not narrow the i64 remainder of two extended
              // int32s; a 32-bit one takes a shorter magic-number sequence.
              const result = B.tmp();
              B.line(`${result} = urem i32 ${narrowInteger(host, li)}, ${narrowInteger(host, ri)}`);
              return int32Number(host, result, range, e.type);
            }
            const result = B.tmp();
            B.line(`${result} = urem i64 ${left}, ${right}`);
            return integerNumber(host, result, range, e.type);
          }
          if (e.op === "%") {
            const integer = emitSignedIntegerRemainder(host, l, li, ri);
            if (integer) return integer;
          }
          if (cmp[e.op] !== undefined) {
            B.line(`${t} = icmp ${INTEGER_COMPARES[e.op]} i64 ${left}, ${right}`);
            return { name: t, type: e.type };
          }
        }
        if (e.op === "%") {
          const constant = constantDivisor(e.right, ri);
          // Sums, differences and products are usually integers.
          const computed =
            e.left.kind === "bin" && (e.left.op === "+" || e.left.op === "-" || e.left.op === "*");
          const power =
            constant === null ? null : emitPowerOfTwoRemainder(host, l, constant, li, computed);
          if (power) return power;
          // A fractional constant divisor never passes the integer check.
          const checked =
            constant !== null && !Number.isInteger(constant)
              ? null
              : emitCheckedRemainder(host, l, r, li, ri);
          if (checked) return checked;
        }
        if (e.op === "/" && isPowerOfTwoCall(e.right))
          return { name: emitPowerOfTwoQuotient(host, l.name, r.name), type: e.type };
        if (arith[e.op] !== undefined) {
          B.line(`${t} = ${arith[e.op]} double ${l.name}, ${r.name}`);
          const wrapped = emitWrappingSum(host, e, l, r, li, ri);
          // The exact integer beside the double, for index consumers.
          const wideInteger = wideArithmetic(host, e.op, l, li, r, ri);
          // The integer of an exact integer or NaN, for index and loop guards.
          const nan = emitNanArithmetic(host, e, l, r, li, ri);
          const offset = offsetIndex(e, l, r);
          if (wrapped !== undefined || wideInteger || nan || offset) {
            const value: LlValue = { name: t, type: e.type };
            if (nan) Object.assign(value, nan);
            if (wrapped !== undefined) Object.assign(value, wrapped);
            if (wideInteger) value.wideInteger = wideInteger;
            if (offset) value.offsetIndex = offset;
            return value;
          }
        } else {
          // An operand with only a wide view, such as `i + 1` or `2 * i + 1`
          // of a speculated counter: compare the integers when that gives the
          // doubles' result.
          const operands = exactCompareOperands(host, l, li, r, ri);
          if (operands) {
            B.line(`${t} = icmp ${INTEGER_COMPARES[e.op]} i64 ${operands[0]}, ${operands[1]}`);
            return { name: t, type: e.type };
          }
          const nanCoded = emitIntegerOrNaNCompare(host, e, l, li, r, ri);
          if (nanCoded) return { name: nanCoded, type: e.type };
          B.line(`${t} = fcmp ${cmp[e.op]} double ${l.name}, ${r.name}`);
        }
      } else if (bit[e.op] !== undefined) {
        if (e.left.type.kind !== "f64" || e.right.type.kind !== "f64") {
          throw new LlvmUnsupportedError(
            `bin:${e.op}:${e.left.type.kind}:${e.right.type.kind}`,
            e.loc,
          );
        }
        // `x | 0` and the other identity forms over an operand the range
        // analysis proves an int32 (a uint32 for `>>>`) return that operand:
        // the conversion is the identity and ranges exclude -0, so the
        // operand's double is the result bit for bit. Its integer views stay.
        const identity = bitwiseIdentityOperand(e);
        if (identity !== null) {
          const operand = identity === "left" ? e.left : e.right;
          const value = identity === "left" ? l : r;
          const range = host.integerRanges.get(operand);
          if (e.op === ">>>" ? withinUint32(range) : withinInt32(range)) {
            const uint32 = host.emitToUint32(value.name, operand, value.uint32);
            return {
              name: value.name,
              type: e.type,
              uint32,
              ...(value.integer ? { integer: value.integer } : {}),
            };
          }
        }
        const left = host.emitToUint32(l.name, e.left, l.uint32);
        let right = host.emitToUint32(r.name, e.right, r.uint32);
        if (e.op === "<<" || e.op === ">>" || e.op === ">>>") {
          const shift = B.tmp();
          B.line(`${shift} = and i32 ${right}, 31`);
          right = shift;
        }
        const result = B.tmp();
        B.line(`${result} = ${bit[e.op]} i32 ${left}, ${right}`);
        B.line(`${t} = ${e.op === ">>>" ? "uitofp" : "sitofp"} i32 ${result} to double`);
        return { name: t, type: e.type, uint32: result };
      } else {
        if (e.op !== "**") throw new LlvmUnsupportedError(`bin:${e.op}`, e.loc);
        return { name: emitPowF64(host, l.name, r.name, e.right), type: e.type };
      }
      return { name: t, type: e.type };
    }
    case "unary": {
      if (e.op === "~") markWrappingOperands(host, e.operand);
      const v = host.emitExpr(e.operand);
      const t = B.tmp();
      if (e.op === "-") B.line(`${t} = fneg double ${v.name}`);
      else if (e.op === "!") B.line(`${t} = xor i1 ${v.name}, true`);
      else {
        const value = host.emitToUint32(v.name, e.operand, v.uint32);
        const result = B.tmp();
        B.line(`${result} = xor i32 ${value}, -1`);
        B.line(`${t} = sitofp i32 ${result} to double`);
        return { name: t, type: e.type, uint32: result };
      }
      return { name: t, type: e.type };
    }
    case "incDec": {
      // Expression-position ++/-- over an f64 binding (locals, module
      // globals, capture boxes): read, write ±1, yield old (postfix) or
      // new (prefix).
      const b = host.binding(e.localId);
      if (host.int32Locals.has(e.localId)) {
        if (!host.int32LocalWrites.has(e))
          throw new InternalCompilerError(`llvm emitter bug: unproven ++/-- of ${e.localId}`);
        // The written value is proven in the local's range: no wrap.
        const old = B.tmp();
        const next = B.tmp();
        B.line(`${old} = load i32, ptr ${b.slot}`);
        B.line(`${next} = ${e.op === "+" ? "add" : "sub"} i32 ${old}, 1`);
        B.line(`store i32 ${next}, ptr ${b.slot}`);
        return host.int32LocalValue(e.localId, e.prefix ? next : old, e.type);
      }
      if (b.kind === "boxed") {
        const box = host.loadBox(b.slot);
        const old = b.local!.tdz
          ? host.tdzBoxRead(box, e.type, b.local!.name)
          : host.boxGet(box, e.type);
        const next = B.tmp();
        B.line(`${next} = ${e.op === "+" ? "fadd" : "fsub"} double ${old}, ${f64Lit(1)}`);
        host.writeBindingBox(box, b.local!, next);
        return { name: e.prefix ? next : old, type: e.type };
      }
      const old = B.tmp();
      const next = B.tmp();
      B.line(`${old} = load double, ptr ${b.slot}`);
      B.line(`${next} = ${e.op === "+" ? "fadd" : "fsub"} double ${old}, ${f64Lit(1)}`);
      B.line(`store double ${next}, ptr ${b.slot}`);
      host.storeIntegerView(e.localId, { name: next, type: e.type });
      return { name: e.prefix ? next : old, type: e.type };
    }
    case "fieldIncDec": {
      // ++/-- over a class FIELD in expression position: one receiver
      // evaluation, read-modify-write, old/new snapshotted — the local
      // form over a field slot. CHECKED-DYNAMIC fields validate the
      // number OUT (dynCheck — the catchable TypeError on non-numbers),
      // compute, and box the result back into the slot; unlink-then-
      // release like fieldSet (exprs.ts's shape).
      const obj = host.emitExpr(e.obj);
      const { ptr } = host.classFieldPtr(obj.name, e.className, e.field);
      if (host.int32Slots.isField(e.className, e.field))
        throw new InternalCompilerError("llvm emitter bug: ++/-- on an int32 field");
      if (e.fieldDyn) {
        const box = B.tmp();
        B.line(`${box} = load ptr, ptr ${ptr}`);
        const helper = host.dyn.dynCheckHelper(e.type);
        const old = B.tmp();
        B.line(`${old} = call double @${helper}(ptr ${box}, ptr null)`);
        host.emitPendingCheck();
        host.emitPublishedFieldGuard(obj.name, e.className, e.field);
        const next = B.tmp();
        B.line(`${next} = ${e.op === "+" ? "fadd" : "fsub"} double ${old}, ${f64Lit(1)}`);
        host.declare(`declare ptr @scr_dyn_new_num(double)`);
        host.declare(`declare void @scr_dyn_release(ptr)`);
        const boxed = B.tmp();
        B.line(`${boxed} = call ptr @scr_dyn_new_num(double ${next})`);
        B.line(`store ptr ${boxed}, ptr ${ptr}`);
        B.line(`call void @scr_dyn_release(ptr ${box})`);
        return { name: e.prefix ? next : old, type: e.type };
      }
      host.emitPublishedFieldGuard(obj.name, e.className, e.field);
      const old = B.tmp();
      const next = B.tmp();
      B.line(`${old} = load double, ptr ${ptr}`);
      B.line(`${next} = ${e.op === "+" ? "fadd" : "fsub"} double ${old}, ${f64Lit(1)}`);
      B.line(`store double ${next}, ptr ${ptr}`);
      return { name: e.prefix ? next : old, type: e.type };
    }
    case "assignExpr": {
      // `x = e` in expression position: the binding takes its OWN
      // reference (retain for ref kinds), the temp stays the yielded
      // value — release the old value before storing the retained value.
      const self = matchStringSelfConcat(e.localId, e.value);
      if (self) return host.emitStringSelfConcatAssign(e.localId, self.left, self.suffix, true);
      const b = host.binding(e.localId);
      const v = host.emitExpr(e.value);
      if (host.storeInt32Local(e.localId, v, e.value)) return v;
      if (b.kind === "global") host.checkGlobalTdz(e.localId);
      if (b.kind === "boxed") {
        // box_set takes ownership of the passed reference, so hand it a
        // retained copy and keep the temp's own reference for the yield.
        host.writeBindingBox(host.loadBox(b.slot), b.local!, v.name, false, true);
        return v;
      }
      if (isRefCounted(b.type)) {
        const old = B.tmp();
        B.line(`${old} = load ptr, ptr ${b.slot}`);
        if (b.kind === "global") host.releaseHeap(old, b.type);
        else host.releaseFrame(old, b.type);
        B.line(
          `store ptr ${b.kind === "global" ? host.retainHeap(v.name, v.type) : host.retainFrame(v.name, v.type)}, ptr ${b.slot}`,
        );
      } else {
        B.line(`store ${host.llType(b.type)} ${v.name}, ptr ${b.slot}`);
        host.storeIntegerView(e.localId, v, e.value);
      }
      return v;
    }
    case "seqExpr": {
      // Statements mid-expression: each emits in place (its own frame,
      // exactly statement position); the result is an ordinary temp of
      // the current frame. No jump can leave the expression's region. A
      // statement can still end the block (a call that always throws):
      // what follows then emits in a block with no predecessors, so every
      // value it reads is defined there, and LLVM deletes it.
      for (const s of e.stmts) {
        if (host.B.isTerminated()) host.B.startBlock(host.B.newLabel("seq.dead"));
        host.emitStmt(s);
      }
      if (host.B.isTerminated()) host.B.startBlock(host.B.newLabel("seq.dead"));
      return host.emitExpr(e.result);
    }
    default: {
      const _exhaustive: never = e;
      void _exhaustive;
      throw new InternalCompilerError("unreachable");
    }
  }
}

/** The immortal template of a regex literal: one static per (pattern,
 * flags) pair. Pattern/flags strings intern NOW (the literal table is still
 * open — the runtime ABI's regex-literal discipline). */
export function regexLiteralTemplate(
  host: LlvmEmitterContext,
  e: IrExpr & { kind: "regexLit" },
): string {
  const key = `${e.flags}/${e.pattern}`;
  let re = host.regexInstances.get(key);
  if (!re) {
    re = {
      sym: host.contentSymbol("sc_re_", key),
      src: host.internLiteral(e.pattern),
      fl: host.internLiteral(e.flags),
      pattern: e.pattern,
      flags: e.flags,
    };
    host.regexInstances.set(key, re);
  }
  host.journal?.entry("regex", key, re);
  return `@${re.sym}`;
}

/** The build-time replacer of a global substitution of regex literal `e`
 * with the literal `replacement` (regex-matchers.ts), registered on first
 * use. */
export function regexLiteralReplacer(
  host: LlvmEmitterContext,
  e: IrExpr & { kind: "regexLit" },
  replacement: string,
): string {
  const key = `${e.flags}/${e.pattern}\0${replacement}`;
  let rr = host.regexReplacers.get(key);
  if (!rr) {
    rr = {
      sym: host.contentSymbol("sc_rr_", key),
      pattern: e.pattern,
      flags: e.flags,
      replacement,
    };
    host.regexReplacers.set(key, rr);
  }
  host.journal?.entry("regexReplacer", key, rr);
  return `@${rr.sym}`;
}

/** A string equality or comparison between `s.charAt(i)` and a literal of
 * exactly one UTF-16 code unit: the charAt call, the unit, and whether the
 * charAt is the left operand. */
function charAtUnitTest(
  e: ExprOf<"strEq" | "strCmp">,
): { charAt: ExprOf<"strIntrinsic">; code: number; left: boolean } | null {
  let text: string;
  let other: IrExpr;
  if (e.right.kind === "strLit") {
    text = e.right.value;
    other = e.left;
  } else if (e.left.kind === "strLit") {
    text = e.left.value;
    other = e.right;
  } else {
    return null;
  }
  if (text.length !== 1) return null;
  if (other.kind !== "strIntrinsic" || other.method !== "charAt" || other.args.length !== 1)
    return null;
  return { charAt: other, code: text.charCodeAt(0), left: other === e.left };
}

/** The fcmp predicate of `s.charAt(i) op "c"` on the code unit (or of
 * `"c" op s.charAt(i)` when `charAtLeft` is false). A one-unit string
 * compares as its unit; an index out of range reads "", which is below
 * every one-unit literal, and its unit read is NaN, which the unordered
 * predicates count as below. */
function charAtUnitPredicate(op: IrStrCmpOp, charAtLeft: boolean): string {
  const flipped = charAtLeft ? op : ({ "<": ">", "<=": ">=", ">": "<", ">=": "<=" } as const)[op];
  return { "<": "ult", "<=": "ule", ">": "ogt", ">=": "oge" }[flipped];
}

export function emitStringExpr(
  host: LlvmEmitterContext,
  e: ExprOf<
    | "strConcat"
    | "strEq"
    | "strCmp"
    | "toString"
    | "strIntrinsic"
    | "regexLit"
    | "templateStrings"
    | "regexIntrinsic"
  >,
): LlValue {
  const B = host.B;
  switch (e.kind) {
    case "strConcat": {
      if (
        e.left.kind === "strConcat" ||
        e.right.kind === "strConcat" ||
        numberPart(e.left) !== null
      ) {
        return emitStringParts(host, stringParts(e));
      }
      // Concat may append to a uniquely owned left temporary. A retained
      // read protects an existing binding from that in-place operation.
      const l = host.emitExpr(e.left);
      const number = numberPart(e.right);
      if (number !== null) {
        // The number is formatted into the result, not a temporary string.
        const x = host.emitExpr(number);
        host.declare(`declare ptr @scr_str_concat_f64(ptr, double)`);
        const t = B.tmp();
        B.line(`${t} = call ptr @scr_str_concat_f64(ptr ${l.name}, double ${x.name})`);
        return host.own({ name: t, type: e.type });
      }
      const [r] = emitStringInputs(host, [e.right]);
      host.declare(`declare ptr @scr_str_concat(ptr, ptr)`);
      const t = B.tmp();
      B.line(`${t} = call ptr @scr_str_concat(ptr ${l.name}, ptr ${r!.name})`);
      return host.own({ name: t, type: e.type });
    }
    case "strEq": {
      // `s.charAt(i) === "c"` (and `s[i]`, which lowers to charAt) for a
      // one-unit literal compares the code unit: charCodeAt converts the
      // index the same way, and an index out of range answers NaN, which
      // equals no unit, as "" equals no one-unit literal.
      const unit = charAtUnitTest(e);
      if (unit !== null) {
        const code = host.emitExpr(charAtUnitRead(host, unit.charAt));
        const t = B.tmp();
        B.line(
          `${t} = fcmp ${e.negated ? "une" : "oeq"} double ${code.name}, ${f64Lit(unit.code)}`,
        );
        return { name: t, type: e.type };
      }
      const [l, r] = emitStringInputs(host, [e.left, e.right]);
      const eq = B.tmp();
      // A literal side compares its length and bytes inline.
      const literal =
        e.right.kind === "strLit"
          ? { text: e.right.value, other: l! }
          : e.left.kind === "strLit"
            ? { text: e.left.value, other: r! }
            : null;
      if (literal !== null) {
        B.line(
          `${eq} = call zeroext i1 ${host.literalEquals(literal.text)}(ptr ${literal.other.name})`,
        );
      } else {
        host.declare(`declare zeroext i1 @scr_str_eq(ptr, ptr)`);
        B.line(`${eq} = call zeroext i1 @sc_str_eq(ptr ${l!.name}, ptr ${r!.name})`);
      }
      if (!e.negated) return { name: eq, type: e.type };
      const t = B.tmp();
      B.line(`${t} = xor i1 ${eq}, true`);
      return { name: t, type: e.type };
    }
    case "strCmp": {
      // `s.charAt(i) < "c"` (and `s[i]`) for a one-unit literal compares
      // the code unit, as the equality above does.
      const unit = charAtUnitTest(e);
      if (unit !== null) {
        const code = host.emitExpr(charAtUnitRead(host, unit.charAt));
        const t = B.tmp();
        B.line(
          `${t} = fcmp ${charAtUnitPredicate(e.op, unit.left)} double ${code.name}, ${f64Lit(unit.code)}`,
        );
        return { name: t, type: e.type };
      }
      const [l, r] = emitStringInputs(host, [e.left, e.right]);
      const fn = "scr_str_cmp_u16";
      host.declare(`declare i32 @${fn}(ptr, ptr)`);
      const c = B.tmp();
      const t = B.tmp();
      const pred = { "<": "slt", "<=": "sle", ">": "sgt", ">=": "sge" }[e.op];
      // Identity short-circuits through the inlined sc_ wrapper (helperDefs).
      B.line(`${c} = call i32 @${fn.replace(/^scr_/, "sc_")}(ptr ${l!.name}, ptr ${r!.name})`);
      B.line(`${t} = icmp ${pred} i32 ${c}, 0`);
      return { name: t, type: e.type };
    }
    case "toString": {
      const v =
        e.operand.type.kind === "union"
          ? host.emitReadReceiver(e.operand)
          : host.emitExpr(e.operand);
      if (v.type.kind === "union") {
        // The ARM value's ToString: an inline tag switch (unit arms are
        // interned literals, string arms retain the payload, f64/bool
        // arms format — the C per-union helper at the use site). Ref
        // arms never arrive (the frontend fences those).
        const def = host.unionsById.get(v.type.unionId);
        if (!def)
          throw new InternalCompilerError(
            `llvm emitter bug: ToString of unknown union ${v.type.unionId}`,
          );
        const slot = B.slot();
        B.entryAllocas.push(`${slot} = alloca ptr`);
        const join = B.newLabel("us.j");
        host.unionTagSwitch(v.name, def, (arm) => {
          switch (arm.kind) {
            case "undefinedT":
            case "nullT": {
              const lit = host.internLiteral(arm.kind === "undefinedT" ? "undefined" : "null");
              B.line(`store ptr ${host.retainFrame(lit, e.type)}, ptr ${slot}`);
              break;
            }
            case "string":
              B.line(
                `store ptr ${host.retainFrame(host.unionPeek(v.name, def.id), e.type)}, ptr ${slot}`,
              );
              break;
            case "f64": {
              const x = host.unionGetF64(v.name);
              const r = B.tmp();
              host.declare(`declare ptr @scr_f64_to_scrstr(double)`);
              B.line(`${r} = call ptr @scr_f64_to_scrstr(double ${x})`);
              B.line(`store ptr ${r}, ptr ${slot}`);
              break;
            }
            case "bool": {
              const x = host.unionGetBool(v.name);
              const r = B.tmp();
              host.declare(`declare ptr @scr_bool_to_scrstr(i1 zeroext)`);
              B.line(`${r} = call ptr @scr_bool_to_scrstr(i1 zeroext ${x})`);
              B.line(`store ptr ${r}, ptr ${slot}`);
              break;
            }
            case "bigint": {
              const p = host.unionPeek(v.name, def.id);
              const r = B.tmp();
              host.declare(`declare ptr @scr_bigint_to_string(ptr, double)`);
              B.line(`${r} = call ptr @scr_bigint_to_string(ptr ${p}, double ${f64Lit(10)})`);
              B.line(`store ptr ${r}, ptr ${slot}`);
              break;
            }
            case "bytes": {
              // Buffer.toString() IS the utf8 decode (Node's default
              // encoding) — the `Buffer | string` chunk idiom.
              const enc = host.internLiteral("utf8");
              const p = host.unionPeek(v.name, def.id);
              const r = B.tmp();
              host.declare(`declare ptr @scr_bytes_to_str(ptr, ptr)`);
              B.line(`${r} = call ptr @scr_bytes_to_str(ptr ${p}, ptr ${enc})`);
              B.line(`store ptr ${r}, ptr ${slot}`);
              break;
            }
            default:
              throw new LlvmUnsupportedError(`toString:union:${arm.kind}`, e.loc);
          }
          B.br(join);
        });
        B.startBlock(join);
        const t = B.tmp();
        B.line(`${t} = load ptr, ptr ${slot}`);
        const result = host.own({ name: t, type: e.type });
        host.emitPendingCheck();
        return result;
      }
      if (v.type.kind === "record") {
        // String(record) / `${record}`: Object.prototype.toString's
        // constant — the interned literal, retained like a strLit.
        const sym = host.internLiteral("[object Object]");
        return host.own({ name: host.retainFrame(sym, e.type), type: e.type });
      }
      if (v.type.kind === "caught") {
        // String(e) / `${e}` on a catch binding: JS's String() over the
        // snapshot (scr_caught_to_string — borrows the box, +1 result).
        host.declare(`declare ptr @scr_caught_to_string(ptr)`);
        const t = B.tmp();
        B.line(`${t} = call ptr @scr_caught_to_string(ptr ${v.name})`);
        const result = host.own({ name: t, type: e.type });
        host.emitPendingCheck();
        return result;
      }
      if (v.type.kind === "dyn") {
        // String(unknown): dispatch over the dyn kind (dyn.ts's sc_ds —
        // Node's String() incl. arrays-join and "[object Object]").
        const helper = host.dyn.dynToStrHelper();
        const t = B.tmp();
        B.line(`${t} = call ptr @${helper}(ptr ${v.name})`);
        const result = host.own({ name: t, type: e.type });
        host.emitPendingCheck();
        return result;
      }
      const t = B.tmp();
      if (v.type.kind === "f64") {
        host.declare(`declare ptr @scr_f64_to_scrstr(double)`);
        B.line(`${t} = call ptr @scr_f64_to_scrstr(double ${v.name})`);
      } else if (v.type.kind === "bool") {
        host.declare(`declare ptr @scr_bool_to_scrstr(i1 zeroext)`);
        B.line(`${t} = call ptr @scr_bool_to_scrstr(i1 zeroext ${v.name})`);
      } else {
        throw new LlvmUnsupportedError(`toString:${v.type.kind}`, e.loc);
      }
      return host.own({ name: t, type: e.type });
    }
    case "strIntrinsic":
      return host.emitStrIntrinsic(e);
    case "regexLit": {
      // Each evaluation is a fresh RegExp over the site's shared template
      // (compiled bytecode and matcher); the +1 result is owned.
      const template = regexLiteralTemplate(host, e);
      host.declare("declare ptr @scr_regex_literal(ptr)");
      const value = B.tmp();
      B.line(`${value} = call ptr @scr_regex_literal(ptr ${template})`);
      return host.own({ name: value, type: e.type });
    }
    case "templateStrings": {
      // One immortal static string array per template SITE (the key);
      // the +1 retain is a no-op on immortals. Cooked strings intern
      // NOW (the literal table is still open).
      let inst = host.templateStringsInstances.get(e.key);
      if (!inst) {
        inst = {
          sym: `sc_tsa_${host.templateStringsInstances.size}`,
          slots: e.cooked.map((s) => host.internLiteral(s)),
        };
        host.templateStringsInstances.set(e.key, inst);
      }
      host.journal?.entry("templateStrings", e.key, inst);
      return host.own({ name: host.retainFrame(`@${inst.sym}`, e.type), type: e.type });
    }
    case "regexIntrinsic":
      return host.emitRegexIntrinsic(e);
    default: {
      const _exhaustive: never = e;
      void _exhaustive;
      throw new InternalCompilerError("unreachable");
    }
  }
}

/** scr_arr_reserve_len reserves dense storage only up to this many slots
 * (SCR_ARR_DENSE_LIMIT, scr_array.c). */
const RESERVE_LIMIT = 2 ** 20;

/** Elements the inline slots of a small array construction
 * (scr_arr_new_small, scr_arr_new_ops_small) hold at least
 * (SCR_ARR_SMALL_SLOTS, scr_array.c). */
const SMALL_ARRAY_SLOTS = 3;

/** The capacity scr_arr_reserve_len would reserve for `length` on an empty
 * array: the length truncated when it is at least 1 and at most
 * RESERVE_LIMIT, else 0. */
function reservedCapacity(host: LlvmEmitterContext, length: IrExpr): string {
  const B = host.B;
  const n = host.emitExpr(length);
  const atLeastOne = B.tmp(),
    withinLimit = B.tmp(),
    reserves = B.tmp(),
    slots = B.tmp(),
    capacity = B.tmp();
  B.line(`${atLeastOne} = fcmp oge double ${n.name}, ${f64Lit(1)}`);
  B.line(`${withinLimit} = fcmp ole double ${n.name}, ${f64Lit(RESERVE_LIMIT)}`);
  B.line(`${reserves} = and i1 ${atLeastOne}, ${withinLimit}`);
  B.line(`${slots} = select i1 ${reserves}, double ${n.name}, double ${f64Lit(0)}`);
  B.line(`${capacity} = fptoui double ${slots} to ${host.sizeType}`);
  return capacity;
}

export function emitContainerExpr(
  host: LlvmEmitterContext,
  e: ExprOf<
    | "arrayLit"
    | "arrayNewLen"
    | "arrayGet"
    | "arrayHas"
    | "arrayState"
    | "arrIntrinsic"
    | "bytesNew"
    | "bytesIntrinsic"
    | "mapNew"
    | "mapIntrinsic"
    | "setIntrinsic"
    | "setNew"
  >,
): LlValue {
  const B = host.B;
  switch (e.kind) {
    case "arrayLit": {
      // Batch adjacent plain elements. Spread boundaries flush the batch
      // so every source is copied before later expressions can mutate it.
      // The fresh array and pending values stay owned across evaluation.
      if (e.type.kind !== "array")
        throw new InternalCompilerError("llvm emitter bug: arrayLit of non-array type");
      const elem = e.type.elem;
      const arr = B.tmp();
      const small = host.appendedArrayLiterals.has(e);
      const spreadSet = new Set(e.spreads ?? []);
      // With spreads, storage starts at the plain elements before the first
      // spread, and each spread reserves exactly its source's length plus
      // the plain elements up to the next one (scr_arr_reserve_spread).
      const firstSpread = e.elems.findIndex((_, i) => spreadSet.has(i));
      const capacity = small ? 0 : (e.capacity ?? (firstSpread < 0 ? e.elems.length : firstSpread));
      // An int32 array's allocation (ir/int32-arrays.ts) constructs
      // SCR_ELEM_I32 storage; its elements are proven int32s. The empty
      // temporary of a fill that allocates an int32 array with checked
      // stores takes SCR_ELEM_I32 storage when the fill's length (which
      // evaluates without effects) is at least CHECKED_INT32_MIN_LENGTH, and
      // SCR_ELEM_F64 storage otherwise.
      const fillLength = host.checkedAllocations.get(e);
      if (fillLength !== undefined && e.elems.length === 0) {
        const length = host.emitExpr(fillLength);
        const long = B.tmp(),
          kind = B.tmp();
        B.line(`${long} = fcmp oge double ${length.name}, ${f64Lit(CHECKED_INT32_MIN_LENGTH)}`);
        B.line(`${kind} = select i1 ${long}, i32 ${SCR_ELEM_I32}, i32 0`);
        host.declare(
          small
            ? `declare ptr @scr_arr_new_small(i32)`
            : `declare ptr @scr_arr_new(i32, ${host.sizeType})`,
        );
        B.line(
          small
            ? `${arr} = call ptr @scr_arr_new_small(i32 ${kind})`
            : `${arr} = call ptr @scr_arr_new(i32 ${kind}, ${host.sizeType} ${capacity})`,
        );
        return host.own({ name: arr, type: e.type });
      }
      const int32 = host.int32Allocations.has(e);
      if (int32) {
        host.declare(
          small
            ? `declare ptr @scr_arr_new_small(i32)`
            : `declare ptr @scr_arr_new(i32, ${host.sizeType})`,
        );
        B.line(
          small
            ? `${arr} = call ptr @scr_arr_new_small(i32 ${SCR_ELEM_I32})`
            : `${arr} = call ptr @scr_arr_new(i32 ${SCR_ELEM_I32}, ${host.sizeType} ${capacity})`,
        );
      } else {
        const hint = host.reservedArrayLengths.get(e);
        if (hint !== undefined) {
          host.reservedArrayLengths.delete(e);
          host.consumedReserves.add(hint);
          const capacity = reservedCapacity(host, hint.length);
          // The small construction's inline slots hold at least
          // SMALL_ARRAY_SLOTS elements; larger capacities are sized.
          const fits = B.tmp(),
            smallArr = B.tmp(),
            sizedArr = B.tmp();
          const smallLabel = B.newLabel("arr.cap.small"),
            sizedLabel = B.newLabel("arr.cap.sized"),
            joined = B.newLabel("arr.cap.j");
          B.line(`${fits} = icmp ule ${host.sizeType} ${capacity}, ${SMALL_ARRAY_SLOTS}`);
          B.condBr(fits, smallLabel, sizedLabel);
          B.startBlock(smallLabel);
          B.line(`${smallArr} = ${arrNewCall(host.shapeHost, elem, "0", true, host.arenaSite(e))}`);
          B.br(joined);
          B.startBlock(sizedLabel);
          B.line(
            `${sizedArr} = ${arrNewCall(host.shapeHost, elem, capacity, false, host.arenaSite(e))}`,
          );
          B.br(joined);
          B.startBlock(joined);
          B.line(
            `${arr} = phi ptr [ ${smallArr}, %${smallLabel} ], [ ${sizedArr}, %${sizedLabel} ]`,
          );
        } else
          B.line(
            `${arr} = ${arrNewCall(host.shapeHost, elem, String(capacity), small, host.arenaSite(e))}`,
          );
      }
      const out = host.own({ name: arr, type: e.type });
      const acc: ArrayAccess = int32 ? "i32" : elemAccess(elem);
      let pending: LlValue[] = [];
      let buffer: string | undefined;
      const flush = (): void => {
        if (pending.length > 1 && buffer === undefined) {
          buffer = B.tmp();
          B.entryAllocas.push(`${buffer} = alloca [${Math.min(e.elems.length, 64)} x i64]`);
        }
        if (pending.length > 0) emitArrayValues(host, arr, acc, elem, pending, false, buffer);
        pending = [];
      };
      e.elems.forEach((el, i) => {
        if (spreadSet.has(i)) {
          flush();
          const v = host.emitExpr(el);
          let plain = 0;
          for (let j = i + 1; j < e.elems.length && !spreadSet.has(j); j++) plain++;
          host.declare(`declare void @scr_arr_reserve_spread(ptr, ptr, ${host.sizeType})`);
          B.line(
            `call void @scr_arr_reserve_spread(ptr ${arr}, ptr ${v.name}, ${host.sizeType} ${plain})`,
          );
          // A literal with spreads is never an int32 allocation.
          host.emitArrayCopyLoop(arr, v.name, runtimeAccess(acc));
          return;
        }
        pending.push(host.emitExpr(el));
        if (pending.length === 64) flush();
      });
      flush();
      return out;
    }
    case "arrayNewLen": {
      // Mapper-less Array.from({ length: n }): a length-n array of
      // ABSENT slots — the interned undefined arm for unions carrying
      // one (immortal: pushing owes no retain), NULL for every other ref
      // element kind. The `i <= n - 1` bound is ToLength for the lengths
      // that terminate: fractions truncate, negative/NaN → empty.
      if (e.type.kind !== "array")
        throw new InternalCompilerError("llvm emitter bug: arrayNewLen of non-array type");
      const elem = e.type.elem;
      const n = host.emitExpr(e.length);
      const arr = B.tmp();
      B.line(`${arr} = ${arrNewCall(host.shapeHost, elem, "0")}`);
      host.declare(`declare void @scr_arr_reserve_len(ptr, double)`);
      B.line(`call void @scr_arr_reserve_len(ptr ${arr}, double ${n.name})`);
      const out = host.own({ name: arr, type: e.type });
      const acc = elemAccess(elem);
      let fill = acc === "f64" ? f64Lit(0) : acc === "bool" ? "false" : "null";
      if (elem.kind === "union") {
        const tag = undefinedArmTag(elem, host.unionsById);
        if (tag >= 0) fill = host.unitInstanceRef(elem.unionId, tag);
      }
      const bound = B.tmp();
      B.line(`${bound} = fsub double ${n.name}, ${f64Lit(1)}`);
      B.countedLoop(bound, () => host.arrPush(arr, acc, fill, elem), "ole");
      return out;
    }
    case "arrayGet": {
      // Element reads run no user code: a projection receiver (an array in
      // a parameter's field) stays rooted while the index preserves edges.
      const arr = host.emitStableReceiver(e.arr, [e.index]);
      const idx = host.emitExpr(e.index);
      if (e.arr.type.kind !== "array")
        throw new InternalCompilerError("llvm emitter bug: arrayGet on non-array");
      // Ref-element reads return +1 (the inline dense path retains like
      // the runtime getter); own registers the owned temp in the frame.
      const elem = e.arr.type.elem;
      if (host.checkedInt32Array(e.arr)) {
        const proven = host.provenDenseIndex(e.arr, e.index);
        const value = host.emitByElementKind(
          arr.name,
          "double",
          (kind) =>
            emitDenseArrayRead(
              host,
              arr.name,
              idx,
              e.index,
              kind,
              elem,
              "scr_arr_get_f64",
              true,
              proven,
            ).value,
        )!;
        return { name: value, type: e.type };
      }
      const acc = host.arrayAccess(e.arr, elem);
      const read = emitDenseArrayRead(
        host,
        arr.name,
        idx,
        e.index,
        acc,
        elem,
        `scr_arr_get_${runtimeAccess(acc)}`,
        true,
        host.provenDenseIndex(e.arr, e.index),
      );
      if (read.int32 !== null)
        // An int32 array's element: its i32 is exact for index consumers.
        return {
          name: read.value,
          type: e.type,
          uint32: read.int32,
          integer: { name: read.int32, type: "i32", signed: true, range: INT32_RANGE },
        };
      return host.own({ name: read.value, type: e.type });
    }
    case "arrayHas": {
      const arr = host.emitStableReceiver(e.arr, [e.index]);
      const idx = host.emitExpr(e.index);
      if (e.arr.type.kind !== "array")
        throw new InternalCompilerError("llvm emitter bug: arrayHas on non-array");
      const t = host.checkedInt32Array(e.arr)
        ? host.emitByElementKind(arr.name, "i1", (kind) =>
            emitDenseArrayState(host, arr.name, idx, e.index, "has", slotWidth(kind)),
          )!
        : emitDenseArrayState(
            host,
            arr.name,
            idx,
            e.index,
            "has",
            host.int32Array(e.arr) ? slotWidth("i32") : denseSlotWidth(host, e.arr.type.elem),
          );
      return { name: t, type: e.type };
    }
    case "arrayState": {
      const arr = host.emitStableReceiver(e.arr, [e.index]);
      const idx = host.emitExpr(e.index);
      if (e.arr.type.kind !== "array")
        throw new InternalCompilerError("llvm emitter bug: arrayState on non-array");
      const proven = host.provenDenseIndex(e.arr, e.index);
      const t = host.checkedInt32Array(e.arr)
        ? host.emitByElementKind(arr.name, "double", (kind) =>
            emitDenseArrayState(host, arr.name, idx, e.index, "state", slotWidth(kind), proven),
          )!
        : emitDenseArrayState(
            host,
            arr.name,
            idx,
            e.index,
            "state",
            host.int32Array(e.arr) ? slotWidth("i32") : denseSlotWidth(host, e.arr.type.elem),
            proven,
          );
      return { name: t, type: e.type };
    }
    case "arrIntrinsic":
      return host.emitArrIntrinsic(e);
    case "bytesNew": {
      // Typed-array/Buffer construction; the SOURCE's static type picks
      // the runtime entry. The source is borrowed; every form hands
      // back +1. Length and checked-input forms can throw; check after
      // the result joins its ownership frame.
      if (e.type.kind !== "bytes")
        throw new InternalCompilerError("llvm emitter bug: bytesNew of non-bytes type");
      const kind = BYTES_ELEM_NUM[e.type.elem];
      if (!e.source) {
        host.declare(`declare ptr @scr_bytes_new(i32, double)`);
        const t = B.tmp();
        B.line(`${t} = call ptr @scr_bytes_new(i32 ${kind}, double ${f64Lit(0)})`);
        return host.own({ name: t, type: e.type });
      }
      const src = host.emitExpr(e.source);
      const t = B.tmp();
      if (e.source.type.kind === "f64") {
        host.declare(`declare ptr @scr_bytes_new(i32, double)`);
        B.line(`${t} = call ptr @scr_bytes_new(i32 ${kind}, double ${src.name})`);
        const out = host.own({ name: t, type: e.type });
        host.emitPendingCheck();
        return out;
      }
      if (e.source.type.kind === "bytes") {
        host.declare(`declare ptr @scr_bytes_convert(i32, ptr)`);
        B.line(`${t} = call ptr @scr_bytes_convert(i32 ${kind}, ptr ${src.name})`);
        return host.own({ name: t, type: e.type });
      }
      if (e.source.type.kind === "dyn") {
        host.declare(`declare ptr @scr_bytes_from_dyn(i32, ptr, i1 zeroext)`);
        B.line(
          `${t} = call ptr @scr_bytes_from_dyn(i32 ${kind}, ptr ${src.name}, i1 zeroext ${e.from ? "true" : "false"})`,
        );
        const out = host.own({ name: t, type: e.type });
        host.emitPendingCheck();
        return out;
      }
      if (e.source.type.kind === "array") {
        host.declare(`declare ptr @scr_bytes_from_arr(i32, ptr)`);
        B.line(`${t} = call ptr @scr_bytes_from_arr(i32 ${kind}, ptr ${src.name})`);
        return host.own({ name: t, type: e.type });
      }
      throw new InternalCompilerError(
        `llvm emitter bug: bytesNew source of kind ${e.source.type.kind}`,
      );
    }
    case "bytesIntrinsic":
      return host.emitBytesIntrinsic(e);
    case "mapNew":
      return host.emitMapNew(e);
    case "mapIntrinsic":
    case "setIntrinsic":
      return host.emitMapLikeIntrinsic(e);
    case "setNew":
      return host.emitSetNew(e);
    default: {
      const _exhaustive: never = e;
      void _exhaustive;
      throw new InternalCompilerError("unreachable");
    }
  }
}

export function emitRecordExpr(
  host: LlvmEmitterContext,
  e: ExprOf<
    | "fieldGet"
    | "recordGet"
    | "recordLit"
    | "recordClone"
    | "recordKeyGet"
    | "recordOvfKeys"
    | "recordOvfHas"
    | "recordNullProto"
    | "recordHas"
    | "fieldAbsent"
  >,
): LlValue {
  const B = host.B;
  switch (e.kind) {
    case "fieldGet": {
      const obj = host.emitReadReceiver(e.obj);
      const { ptr, type, inline } = host.classFieldPtr(
        obj.name,
        e.className,
        e.field,
        "compressed",
      );
      if (host.int32Slots.isField(e.className, e.field)) return host.loadInt32Field(ptr, e.type);
      if (inline) return host.own({ name: host.inlineFieldUnion(ptr, type), type: e.type });
      const nullable = host.nullableFieldGet(e);
      if (nullable) {
        const p = host.loadRef(ptr);
        return host.own({ name: host.nullableToOwnedUnion(p, nullable), type: e.type });
      }
      const v = host.loadField(ptr, type, false);
      if (isRefCounted(e.type))
        return host.own({ name: host.retainFrame(v, e.type), type: e.type });
      return { name: v, type: e.type };
    }
    case "recordGet": {
      const obj = host.emitReadReceiver(e.obj);
      const { ptr, type, inline } = host.recordFieldPtr(obj.name, e.shapeId, e.field);
      if (inline) return host.own({ name: host.inlineFieldUnion(ptr, type), type: e.type });
      const v = host.loadRecordField(ptr, type, false);
      if (isRefCounted(e.type))
        return host.own({ name: host.retainFrame(v, e.type), type: e.type });
      return { name: v, type: e.type };
    }
    case "recordLit": {
      // Allocate (fields zeroed), then write each field IN SOURCE ORDER —
      // JS evaluates property values in source order. Ownership of
      // refcounted values moves in; the struct is fresh, so there is
      // never an old value to release. OVERFLOW entries insert into the
      // shape's overflow map in the same interleaved order.
      if (e.type.kind !== "record")
        throw new InternalCompilerError("llvm emitter bug: recordLit of non-record type");
      const shapeId = e.type.shapeId;
      const rec = B.tmp();
      B.line(`${rec} = call ptr @${host.allocSym(mangleRecordNew(shapeId), e)}()`);
      const out = host.own({ name: rec, type: e.type });
      // A null-prototype record: SCR_MAP_NULL_PROTO on the fresh map.
      if (e.nullProto) B.line(`store i8 1, ptr ${host.recordMapFlagsPtr(rec, shapeId)}`);
      emitRecordLitFields(host, e, rec);
      return out;
    }
    case "recordClone": {
      if (e.type.kind !== "record")
        throw new InternalCompilerError("llvm emitter bug: recordClone of non-record type");
      host.recordCloneShapes.add(e.type.shapeId);
      const source = host.emitExpr(e.source);
      const rec = B.tmp();
      B.line(`${rec} = call ptr @${mangleRecordClone(e.type.shapeId)}(ptr ${source.name})`);
      const out = host.own({ name: rec, type: e.type });
      for (const f of e.overrides) {
        const v = host.emitFieldValue(f.value, host.recordFieldInline(e.type.shapeId, f.name));
        const { ptr, type, inline } = host.recordFieldPtr(rec, e.type.shapeId, f.name);
        host.replaceField(ptr, type, inline, v);
      }
      return out;
    }
    case "recordKeyGet":
      return host.emitRecordKeyGet(e);
    case "recordHas": {
      // Own-property presence: only an undefined-armed union slot can
      // lack its property, by holding the ABSENT state.
      const obj = host.emitReadReceiver(e.obj);
      const { ptr, type, inline } = host.recordFieldPtr(obj.name, e.shapeId, e.field);
      if (type.kind !== "union" || undefinedArmTag(type, host.unionsById) < 0)
        return { name: "true", type: e.type };
      const v = host.loadField(ptr, type, inline);
      const absent = host.fieldAbsentTest(v, type.unionId);
      const t = B.tmp();
      B.line(`${t} = xor i1 ${absent}, true`);
      return { name: t, type: e.type };
    }
    case "fieldAbsent":
      return { name: host.absentInstanceRef(e.unionId), type: e.type };
    case "recordOvfHas": {
      const obj = host.emitExpr(e.obj);
      const key = host.emitExpr(e.key);
      const ovf = host.recordOvfPtr(obj.name, e.shapeId);
      host.declare(`declare zeroext i1 @scr_map_has_str(ptr, ptr)`);
      const t = B.tmp();
      B.line(`${t} = call zeroext i1 @scr_map_has_str(ptr ${ovf}, ptr ${key.name})`);
      return { name: t, type: e.type };
    }
    case "recordNullProto": {
      const obj = host.emitExpr(e.obj);
      const flags = B.tmp();
      const t = B.tmp();
      B.line(`${flags} = load i8, ptr ${host.recordMapFlagsPtr(obj.name, e.shapeId)}`);
      B.line(`${t} = icmp ne i8 ${flags}, 0`);
      return { name: t, type: e.type };
    }
    case "recordOvfKeys": {
      // The overflow map's live keys in JS own-key order — a fresh
      // string[] snapshot (+1); the record is borrowed.
      const obj = host.emitExpr(e.obj);
      const ovf = host.recordOvfPtr(obj.name, e.shapeId);
      host.declare(`declare ptr @scr_map_keys_js_order(ptr)`);
      const t = B.tmp();
      B.line(`${t} = call ptr @scr_map_keys_js_order(ptr ${ovf})`);
      return host.own({ name: t, type: e.type });
    }
    default: {
      const _exhaustive: never = e;
      void _exhaustive;
      throw new InternalCompilerError("unreachable");
    }
  }
}

/** Write a record literal's fields into the fresh record `rec`, IN SOURCE
 * ORDER (JS evaluates property values in source order). Ownership of
 * refcounted values moves in; the struct is fresh, so there is never an
 * old value to release. */
export function emitRecordLitFields(
  host: LlvmEmitterContext,
  e: IrExpr & { kind: "recordLit" },
  rec: string,
): void {
  const B = host.B;
  const shapeId = (e.type as IrType & { kind: "record" }).shapeId;
  for (const f of e.fields) {
    const v = host.emitFieldValue(
      f.value,
      f.overflow !== true && host.recordFieldInline(shapeId, f.name),
    );
    if (f.overflow) {
      const lit = host.internLiteral(f.name);
      const acc = v.type.kind === "f64" ? "f64" : v.type.kind === "bool" ? "bool" : "ref";
      if (acc === "ref") host.toHeap(v);
      const ovf = host.recordOvfPtr(rec, shapeId);
      const argTy = acc === "f64" ? "double" : acc === "bool" ? "i1 zeroext" : "ptr";
      host.declare(`declare void @scr_map_set_str_${acc}(ptr, ptr, ${argTy})`);
      B.line(
        `call void @scr_map_set_str_${acc}(ptr ${ovf}, ptr ${lit}, ${argTy === "i1 zeroext" ? "i1" : argTy} ${v.name})`,
      );
      continue;
    }
    const { ptr, type, inline } = host.recordFieldPtr(rec, shapeId, f.name);
    host.initField(ptr, type, inline, v);
  }
}
