import { byteNumberRange, type ByteNumberAccess } from "../../ir/byte-numbers.js";
import type { IrExpr } from "../../ir/ir.js";
import type { LlValue, LlvmEmitterContext } from "./expr-context.js";
import { f64Lit } from "./common.js";
import { exactInteger, widenInteger } from "./integer-values.js";

/** Supported LLVM targets are little-endian. All memory accesses use align
 * 1: Buffer fields and DataView windows can start at arbitrary byte offsets. */
function endianBits(host: LlvmEmitterContext, raw: string, width: number, little: string): string {
  if (width === 1 || little === "true") return raw;
  const B = host.B,
    bits = width * 8;
  const swapBits = bits <= 16 ? 16 : bits <= 32 ? 32 : 64;
  let operand = raw;
  if (bits !== swapBits) {
    operand = B.tmp();
    B.line(`${operand} = zext i${bits} ${raw} to i${swapBits}`);
  }
  host.declare(`declare i${swapBits} @llvm.bswap.i${swapBits}(i${swapBits})`);
  let swapped = B.tmp();
  B.line(`${swapped} = call i${swapBits} @llvm.bswap.i${swapBits}(i${swapBits} ${operand})`);
  if (bits !== swapBits) {
    const shifted = B.tmp(),
      narrowed = B.tmp();
    B.line(`${shifted} = lshr i${swapBits} ${swapped}, ${swapBits - bits}`);
    B.line(`${narrowed} = trunc i${swapBits} ${shifted} to i${bits}`);
    swapped = narrowed;
  }
  if (little === "false") return swapped;
  const selected = B.tmp();
  B.line(`${selected} = select i1 ${little}, i${bits} ${raw}, i${bits} ${swapped}`);
  return selected;
}

/** Emit the successful numeric access directly. The original runtime call
 * remains the error path, preserving Buffer's value-before-offset errors,
 * DataView's ToIndex behavior, and exception cleanup through the host. All
 * operands have already been evaluated, exactly once and in source order. */
export function emitByteNumber(
  host: LlvmEmitterContext,
  e: IrExpr & { kind: "bytesIntrinsic" },
  spec: ByteNumberAccess,
  receiver: LlValue,
  offset: LlValue,
  value: LlValue | null,
  little: string,
  fallback: () => LlValue,
): LlValue {
  const B = host.B,
    size = host.sizeType;
  const slow = B.newLabel("bytes.number.slow"),
    access = B.newLabel("bytes.number.access");
  const fastDone = B.newLabel("bytes.number.fast.done"),
    slowDone = B.newLabel("bytes.number.slow.done");
  const done = B.newLabel("bytes.number.done");
  const bits = spec.width * 8;
  const integer = exactInteger(host, offset, e.args[spec.offsetArg]);
  const valueRange = spec.write && !spec.dataView && !spec.floating ? byteNumberRange(spec) : null;
  const knownValue = valueRange ? host.integerRanges.get(e.args[spec.valueArg]!) : null;
  const checked = !(
    integer &&
    host.bytesBounds.has(e) &&
    (!valueRange ||
      (knownValue && knownValue.min >= valueRange.min && knownValue.max <= valueRange.max))
  );
  let index: string,
    fits: string,
    room = "true";
  if (integer && host.bytesBounds.has(e)) {
    const wide = widenInteger(host, integer);
    index = size === "i64" ? wide : B.tmp();
    if (size !== "i64") B.line(`${index} = trunc i64 ${wide} to ${size}`);
    fits = "true";
  } else {
    const lengthPtr = B.tmp(),
      length = B.tmp(),
      capacity = B.tmp();
    room = B.tmp();
    B.line(`${lengthPtr} = getelementptr inbounds %ScrBytes, ptr ${receiver.name}, i64 0, i32 1`);
    B.line(`${length} = load ${size}, ptr ${lengthPtr}`);
    B.line(`${room} = icmp uge ${size} ${length}, ${spec.width}`);
    B.line(`${capacity} = sub ${size} ${length}, ${spec.width}`);
    if (integer) {
      const wide = widenInteger(host, integer);
      const cap = size === "i64" ? capacity : B.tmp();
      if (size !== "i64") B.line(`${cap} = zext ${size} ${capacity} to i64`);
      fits = B.tmp();
      B.line(`${fits} = icmp ule i64 ${wide}, ${cap}`);
      if (spec.dataView && integer.range.max > Number.MAX_SAFE_INTEGER) {
        const safe = B.tmp(),
          both = B.tmp();
        B.line(`${safe} = icmp ule i64 ${wide}, ${Number.MAX_SAFE_INTEGER}`);
        B.line(`${both} = and i1 ${fits}, ${safe}`);
        fits = both;
      }
      index = size === "i64" ? wide : B.tmp();
      if (size !== "i64") B.line(`${index} = trunc i64 ${wide} to ${size}`);
    } else {
      let normalized = offset.name;
      if (spec.dataView) {
        const nan = B.tmp(),
          finiteOrZero = B.tmp();
        normalized = B.tmp();
        B.line(`${nan} = fcmp uno double ${offset.name}, ${offset.name}`);
        B.line(`${finiteOrZero} = select i1 ${nan}, double ${f64Lit(0)}, double ${offset.name}`);
        host.declare("declare double @llvm.trunc.f64(double)");
        B.line(`${normalized} = call double @llvm.trunc.f64(double ${finiteOrZero})`);
      }
      const cap = B.tmp(),
        positive = B.tmp(),
        bounded = B.tmp(),
        representable = B.tmp(),
        range = B.tmp();
      const addressRange = B.tmp(),
        initial = B.tmp(),
        convert = B.newLabel("bytes.number.index");
      B.line(`${cap} = uitofp ${size} ${capacity} to double`);
      B.line(`${positive} = fcmp oge double ${normalized}, ${f64Lit(0)}`);
      B.line(`${bounded} = fcmp ole double ${normalized}, ${cap}`);
      // The separate address limit makes fptoui safe even if converting a
      // maximum size_t length to double rounds upward on a 64-bit target.
      B.line(
        `${representable} = fcmp olt double ${normalized}, ${f64Lit(size === "i64" ? 2 ** 64 : 2 ** 32)}`,
      );
      B.line(`${range} = and i1 ${positive}, ${bounded}`);
      B.line(`${addressRange} = and i1 ${range}, ${representable}`);
      B.line(`${initial} = and i1 ${room}, ${addressRange}`);
      B.condBr(initial, convert, slow);
      B.startBlock(convert);
      index = B.tmp();
      B.line(`${index} = fptoui double ${normalized} to ${size}`);
      fits = B.tmp();
      const roundTrip = B.tmp();
      B.line(`${roundTrip} = uitofp ${size} ${index} to double`);
      B.line(`${fits} = fcmp oeq double ${roundTrip}, ${normalized}`);
      const withinCapacity = B.tmp(),
        exactBounds = B.tmp();
      B.line(`${withinCapacity} = icmp ule ${size} ${index}, ${capacity}`);
      B.line(`${exactBounds} = and i1 ${fits}, ${withinCapacity}`);
      fits = exactBounds;
      if (spec.dataView) {
        const safe = B.tmp(),
          both = B.tmp();
        B.line(`${safe} = fcmp ole double ${normalized}, ${f64Lit(Number.MAX_SAFE_INTEGER)}`);
        B.line(`${both} = and i1 ${fits}, ${safe}`);
        fits = both;
      }
    }
  }
  let valid = "true";
  if (checked) {
    valid = B.tmp();
    B.line(`${valid} = and i1 ${room}, ${fits}`);
  }
  if (spec.write && !spec.dataView && !spec.floating) {
    const range = byteNumberRange(spec)!;
    const known = host.integerRanges.get(e.args[spec.valueArg]!);
    if (!known || known.min < range.min || known.max > range.max) {
      const above = B.tmp(),
        below = B.tmp(),
        valueFits = B.tmp(),
        both = B.tmp();
      // Buffer integer writes accept NaN (stored as zero) and fractions
      // within the declared range. Unordered comparisons preserve that.
      B.line(`${above} = fcmp uge double ${value!.name}, ${f64Lit(range.min)}`);
      B.line(`${below} = fcmp ule double ${value!.name}, ${f64Lit(range.max)}`);
      B.line(`${valueFits} = and i1 ${above}, ${below}`);
      B.line(`${both} = and i1 ${valid}, ${valueFits}`);
      valid = both;
    }
  }
  if (checked) {
    B.condBr(valid, access, slow);
    B.startBlock(access);
  }
  const data = host.emitBytesData(receiver.name),
    pointer = B.tmp();
  B.line(`${pointer} = getelementptr inbounds i8, ptr ${data}, ${size} ${index}`);
  let fastResult = "",
    fastInteger = "";
  const readRange = !spec.write ? byteNumberRange(spec) : null;
  const integerType = bits <= 32 ? "i32" : "i64";
  if (spec.write) {
    let raw: string;
    if (spec.floating) {
      let stored = value!.name;
      if (bits === 32) {
        stored = B.tmp();
        B.line(`${stored} = fptrunc double ${value!.name} to float`);
      }
      raw = B.tmp();
      B.line(`${raw} = bitcast ${bits === 32 ? "float" : "double"} ${stored} to i${bits}`);
    } else if (spec.dataView) {
      const stored = host.emitToUint32(value!.name, e.args[spec.valueArg], value!.uint32);
      raw = stored;
      if (bits < 32) {
        raw = B.tmp();
        B.line(`${raw} = trunc i32 ${stored} to i${bits}`);
      }
    } else {
      const integerValue = exactInteger(host, value!, e.args[spec.valueArg]);
      if (integerValue && (integerValue.type === "i64" || bits <= 32)) {
        raw = integerValue.name;
        if (integerValue.type !== `i${bits}`) {
          raw = B.tmp();
          B.line(`${raw} = trunc ${integerValue.type} ${integerValue.name} to i${bits}`);
        }
      } else {
        const nan = B.tmp(),
          normalized = B.tmp(),
          whole = B.tmp();
        B.line(`${nan} = fcmp uno double ${value!.name}, ${value!.name}`);
        B.line(`${normalized} = select i1 ${nan}, double ${f64Lit(0)}, double ${value!.name}`);
        B.line(`${whole} = fptosi double ${normalized} to i64`);
        raw = B.tmp();
        B.line(`${raw} = trunc i64 ${whole} to i${bits}`);
      }
    }
    const stored = endianBits(host, raw, spec.width, little);
    B.line(`store i${bits} ${stored}, ptr ${pointer}, align 1`);
    if (!spec.dataView) {
      fastResult = B.tmp();
      B.line(`${fastResult} = fadd double ${offset.name}, ${f64Lit(spec.width)}`);
    }
  } else {
    const loaded = B.tmp();
    B.line(`${loaded} = load i${bits}, ptr ${pointer}, align 1`);
    const raw = endianBits(host, loaded, spec.width, little);
    fastResult = B.tmp();
    if (spec.floating) {
      if (bits === 32) {
        const float = B.tmp();
        B.line(`${float} = bitcast i32 ${raw} to float`);
        B.line(`${fastResult} = fpext float ${float} to double`);
      } else B.line(`${fastResult} = bitcast i64 ${raw} to double`);
    } else {
      B.line(`${fastResult} = ${spec.signed ? "sitofp" : "uitofp"} i${bits} ${raw} to double`);
      if (readRange) {
        fastInteger = raw;
        if (`i${bits}` !== integerType) {
          fastInteger = B.tmp();
          B.line(
            `${fastInteger} = ${spec.signed ? "sext" : "zext"} i${bits} ${raw} to ${integerType}`,
          );
        }
      }
    }
  }
  if (!checked) {
    if (e.type.kind === "void") return { name: "", type: e.type };
    if (!readRange) return { name: fastResult, type: e.type };
    const uint32 = integerType === "i32" ? fastInteger : B.tmp();
    if (integerType !== "i32") B.line(`${uint32} = trunc i64 ${fastInteger} to i32`);
    return {
      name: fastResult,
      type: e.type,
      uint32,
      integer: { name: fastInteger, type: integerType, signed: spec.signed, range: readRange },
    };
  }
  B.br(fastDone);
  B.startBlock(fastDone);
  B.br(done);
  B.startBlock(slow);
  const failure = fallback();
  let slowInteger = "";
  if (readRange) {
    slowInteger = B.tmp();
    B.line(
      `${slowInteger} = ${spec.signed ? "fptosi" : "fptoui"} double ${failure.name} to ${integerType}`,
    );
  }
  B.br(slowDone);
  B.startBlock(slowDone);
  B.br(done);
  B.startBlock(done);
  if (e.type.kind === "void") return { name: "", type: e.type };
  const result = B.tmp();
  B.line(
    `${result} = phi double [ ${fastResult}, %${fastDone} ], [ ${failure.name}, %${slowDone} ]`,
  );
  if (readRange) {
    const integer = B.tmp();
    B.line(
      `${integer} = phi ${integerType} [ ${fastInteger}, %${fastDone} ], [ ${slowInteger}, %${slowDone} ]`,
    );
    const uint32 = integerType === "i32" ? integer : B.tmp();
    if (integerType !== "i32") B.line(`${uint32} = trunc i64 ${integer} to i32`);
    return {
      name: result,
      type: e.type,
      uint32,
      integer: { name: integer, type: integerType, signed: spec.signed, range: readRange },
    };
  }
  return { name: result, type: e.type };
}
