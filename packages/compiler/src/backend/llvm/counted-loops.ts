import type {
  IntegerCountedForLoop,
  IntegerLoopFollower,
  IntegerPairedForLoop,
} from "../../ir/integer-loops.js";
import { FOLLOWER_GUARD_LIMIT } from "../../ir/integer-loops.js";
import type { IrExpr } from "../../ir/ir.js";
import type { IntegerRange } from "../../ir/integer-ranges.js";
import type { LlValue, LlvmEmitterContext } from "./expr-context.js";
import { f64Lit } from "./common.js";
import { exactInteger, widenInteger } from "./integer-values.js";
import { integerOrNaNRange } from "./wrapping-sums.js";

/** The caller has proved or guarded the direction's finite endpoint. Clamp
 * the opposite infinity before integer conversion. Fractional limits become
 * exclusive integer endpoints for signed comparisons in either direction. A
 * limit that is an exact integer (an int32 local, an integer view, or a
 * proven range) is its own floor and ceiling and within ±2^53, so it is the
 * endpoint without the double conversion and rounding. */
export function emitCountedLoopLimit(
  host: LlvmEmitterContext,
  loop: IntegerCountedForLoop,
): string {
  const ascending = loop.step > 0;
  if (loop.limit.kind === "numLit") {
    const value = ascending
      ? Math.max(-(2 ** 53), loop.limit.value)
      : Math.min(2 ** 53, loop.limit.value);
    return String(
      ascending
        ? loop.inclusive
          ? Math.floor(value) + 1
          : Math.ceil(value)
        : loop.inclusive
          ? Math.ceil(value) - 1
          : Math.floor(value),
    );
  }
  const B = host.B;
  const value = host.emitExpr(loop.limit);
  const exact = exactInteger(host, value, loop.limit);
  if (exact) {
    // An i32 literal may be the unsigned bit pattern of a negative int32
    // (a ToUint32 view): read it back with the integer's signedness.
    const integer = /^-?\d+$/.test(exact.name)
      ? String(
          exact.type === "i64"
            ? Number(exact.name)
            : exact.signed
              ? Number(exact.name) | 0
              : Number(exact.name) >>> 0,
        )
      : widenInteger(host, exact);
    if (!loop.inclusive) return integer;
    const limit = B.tmp();
    B.line(`${limit} = add nsw i64 ${integer}, ${ascending ? 1 : -1}`);
    return limit;
  }
  const within = B.tmp(),
    bounded = B.tmp(),
    rounded = B.tmp(),
    integer = B.tmp();
  const clamp = ascending ? -(2 ** 53) : 2 ** 53;
  B.line(`${within} = fcmp ${ascending ? "oge" : "ole"} double ${value.name}, ${f64Lit(clamp)}`);
  B.line(`${bounded} = select i1 ${within}, double ${value.name}, double ${f64Lit(clamp)}`);
  const rounding = ascending === loop.inclusive ? "floor" : "ceil";
  host.declare(`declare double @llvm.${rounding}.f64(double)`);
  B.line(`${rounded} = call double @llvm.${rounding}.f64(double ${bounded})`);
  B.line(`${integer} = fptosi double ${rounded} to i64`);
  if (!loop.inclusive) return integer;
  const limit = B.tmp();
  B.line(`${limit} = add nsw i64 ${integer}, ${ascending ? 1 : -1}`);
  return limit;
}

/** The run-time test of a guarded counted loop: an unproven limit is within
 * the integer form's finite range and an unproven start is an exact integer
 * within the loop's start bound. Returns `true` when nothing needs testing. */
export function emitCountedLoopSafety(
  host: LlvmEmitterContext,
  loop: IntegerCountedForLoop,
): string {
  const B = host.B;
  let safe = "true";
  if (loop.limitGuarded) {
    const bound = host.emitExpr(loop.limit);
    safe = B.tmp();
    B.line(
      `${safe} = fcmp ${loop.step > 0 ? "ole" : "oge"} double ${bound.name}, ${f64Lit(loop.guardLimit)}`,
    );
  }
  if (loop.startGuarded) {
    const start = host.emitExpr(loop.start);
    const bound = loop.startBound;
    safe = andSafe(host, safe, emitValueIntegerTest(host, start, loop.start, -bound, bound).ok);
  }
  for (const follower of loop.followers) {
    if (follower.startGuarded) safe = andSafe(host, safe, emitExactStart(host, follower.start));
    if (follower.tripGuarded) safe = andSafe(host, safe, emitFollowerReach(host, loop, follower));
  }
  return safe;
}

/** `|start| + |step| * span / |driver step| <= 2^52` for a follower, where
 * `span` is the distance from the driver's start to the limit. The body runs
 * at most `span / |driver step| + 1` times, so every value the follower holds
 * on a body entry is within the bound. NaN and infinities fail the ordered
 * test. */
function emitFollowerReach(
  host: LlvmEmitterContext,
  loop: IntegerCountedForLoop,
  follower: IntegerLoopFollower,
): string {
  const B = host.B;
  const start = host.emitExpr(loop.start),
    limit = host.emitExpr(loop.limit),
    from = host.emitExpr(follower.start);
  const span = B.tmp(),
    reach = B.tmp(),
    magnitude = B.tmp(),
    total = B.tmp(),
    ok = B.tmp();
  B.line(
    loop.step > 0
      ? `${span} = fsub double ${limit.name}, ${start.name}`
      : `${span} = fsub double ${start.name}, ${limit.name}`,
  );
  B.line(
    `${reach} = fmul double ${span}, ${f64Lit(Math.abs(follower.step) / Math.abs(loop.step))}`,
  );
  host.declare(`declare double @llvm.fabs.f64(double)`);
  B.line(`${magnitude} = call double @llvm.fabs.f64(double ${from.name})`);
  B.line(`${total} = fadd double ${magnitude}, ${reach}`);
  B.line(`${ok} = fcmp ole double ${total}, ${f64Lit(FOLLOWER_GUARD_LIMIT)}`);
  return ok;
}

/** The run-time test of a guarded paired loop: each unproven start is an
 * exact safe integer. */
export function emitPairedLoopSafety(host: LlvmEmitterContext, loop: IntegerPairedForLoop): string {
  let safe = "true";
  for (const counter of [loop.low, loop.high])
    if (counter.startGuarded) safe = andSafe(host, safe, emitExactStart(host, counter.start));
  return safe;
}

function andSafe(host: LlvmEmitterContext, safe: string, ok: string): string {
  if (ok === "true") return safe;
  if (safe === "true") return ok;
  const both = host.B.tmp();
  host.B.line(`${both} = and i1 ${safe}, ${ok}`);
  return both;
}

/** An exact integer of at most 2^53 - 1 in magnitude, and not -0 (the bit
 * patterns of the value and its round trip agree). NaN and infinities fail
 * the ordered range tests. A start with an integer form (an int32 local,
 * `p0 - 1` of one) is an exact integer already: its range answers the test,
 * or two integer compares do. */
function emitExactStart(host: LlvmEmitterContext, expr: IrExpr): string {
  const B = host.B;
  const start = host.emitExpr(expr);
  const integer = exactInteger(host, start, expr);
  if (!integer) {
    const limit = Number.MAX_SAFE_INTEGER;
    const tested = emitNanIntegerTest(host, start, expr, -limit, limit);
    if (tested) return tested.ok;
  }
  if (integer) {
    const limit = Number.MAX_SAFE_INTEGER;
    if (integer.range.min >= -limit && integer.range.max <= limit) return "true";
    const wide = widenInteger(host, integer),
      low = B.tmp(),
      high = B.tmp(),
      ok = B.tmp();
    B.line(`${low} = icmp sge i64 ${wide}, ${-limit}`);
    B.line(`${high} = icmp sle i64 ${wide}, ${limit}`);
    B.line(`${ok} = and i1 ${low}, ${high}`);
    return ok;
  }
  const low = B.tmp(),
    high = B.tmp(),
    raw = B.tmp(),
    wide = B.tmp(),
    back = B.tmp(),
    bits = B.tmp(),
    backBits = B.tmp(),
    exact = B.tmp(),
    inRange = B.tmp(),
    ok = B.tmp();
  B.line(`${low} = fcmp oge double ${start.name}, ${f64Lit(-Number.MAX_SAFE_INTEGER)}`);
  B.line(`${high} = fcmp ole double ${start.name}, ${f64Lit(Number.MAX_SAFE_INTEGER)}`);
  B.line(`${inRange} = and i1 ${low}, ${high}`);
  B.line(`${raw} = fptosi double ${start.name} to i64`);
  B.line(`${wide} = freeze i64 ${raw}`);
  B.line(`${back} = sitofp i64 ${wide} to double`);
  B.line(`${bits} = bitcast double ${start.name} to i64`);
  B.line(`${backBits} = bitcast double ${back} to i64`);
  B.line(`${exact} = icmp eq i64 ${bits}, ${backBits}`);
  B.line(`${ok} = and i1 ${inRange}, ${exact}`);
  return ok;
}

/** Tests that a double is an exact integer within [min, max] (not -0; NaN
 * fails the ordered comparisons) and gives its i64. The integer is frozen,
 * so it is a fixed value even when the test fails. */
export function emitExactIntegerTest(
  host: LlvmEmitterContext,
  value: string,
  min: number,
  max: number,
): { ok: string; integer: string } {
  const B = host.B;
  const low = B.tmp(),
    high = B.tmp(),
    inRange = B.tmp(),
    raw = B.tmp(),
    integer = B.tmp(),
    back = B.tmp(),
    bits = B.tmp(),
    backBits = B.tmp(),
    exact = B.tmp(),
    ok = B.tmp();
  B.line(`${low} = fcmp oge double ${value}, ${f64Lit(min)}`);
  B.line(`${high} = fcmp ole double ${value}, ${f64Lit(max)}`);
  B.line(`${inRange} = and i1 ${low}, ${high}`);
  B.line(`${raw} = fptosi double ${value} to i64`);
  B.line(`${integer} = freeze i64 ${raw}`);
  B.line(`${back} = sitofp i64 ${integer} to double`);
  B.line(`${bits} = bitcast double ${value} to i64`);
  B.line(`${backBits} = bitcast double ${back} to i64`);
  B.line(`${exact} = icmp eq i64 ${bits}, ${backBits}`);
  B.line(`${ok} = and i1 ${inRange}, ${exact}`);
  return { ok, integer };
}

/** The i64 start of an integer counter: the integer form the start value
 * carries (an int32 local, `p0 - 1` of one), or the double's conversion,
 * which the loop's guard or proof makes exact. */
export function emitCountedStart(host: LlvmEmitterContext, expr: IrExpr): string {
  const value = host.emitExpr(expr);
  const integer = exactInteger(host, value, expr);
  if (integer) return widenInteger(host, integer);
  // The guard's test of an exact integer or NaN required the ordered bit.
  if (value.nanInteger !== undefined && integerOrNaNRange(host, expr)) return value.nanInteger;
  const start = host.B.tmp();
  host.B.line(`${start} = fptosi double ${value.name} to i64`);
  return start;
}

/** emitExactIntegerTest of a start expression: when the value carries an
 * integer form (an exact integer, never -0), its range answers the test or
 * two integer compares do, and the integer is the form's. */
export function emitStartIntegerTest(
  host: LlvmEmitterContext,
  expr: IrExpr,
  min: number,
  max: number,
): { ok: string; integer: string } {
  return emitValueIntegerTest(host, host.emitExpr(expr), expr, min, max);
}

/** emitExactIntegerTest of a value with the integer form it carries: an
 * exact integer, whose range answers the test or two integer compares do;
 * or the integer of an exact integer or NaN (`nanInteger`), which the test
 * takes when the ordered bit is set and the range or compares agree. Any
 * other value takes the double's test. */
export function emitValueIntegerTest(
  host: LlvmEmitterContext,
  value: LlValue,
  expr: IrExpr | undefined,
  min: number,
  max: number,
): { ok: string; integer: string } {
  const integer = exactInteger(host, value, expr);
  if (integer) return integerRangeTest(host, widenInteger(host, integer), integer.range, min, max);
  return (
    emitNanIntegerTest(host, value, expr, min, max) ??
    emitExactIntegerTest(host, value.name, min, max)
  );
}

/** The test of a value's `nanInteger`: its ordered bit, and the range or two
 * integer compares. Null when the value carries none. */
function emitNanIntegerTest(
  host: LlvmEmitterContext,
  value: LlValue,
  expr: IrExpr | undefined,
  min: number,
  max: number,
): { ok: string; integer: string } | null {
  if (value.nanInteger === undefined || value.ordered === undefined || !expr) return null;
  const range = integerOrNaNRange(host, expr);
  if (!range) return null;
  const tested = integerRangeTest(host, value.nanInteger, range, min, max);
  return { ok: andSafe(host, value.ordered, tested.ok), integer: value.nanInteger };
}

/** An integer within [min, max]: true when its range is, two compares
 * otherwise. */
function integerRangeTest(
  host: LlvmEmitterContext,
  wide: string,
  range: IntegerRange,
  min: number,
  max: number,
): { ok: string; integer: string } {
  if (range.min >= min && range.max <= max) return { ok: "true", integer: wide };
  const B = host.B;
  const low = B.tmp(),
    high = B.tmp(),
    ok = B.tmp();
  B.line(`${low} = icmp sge i64 ${wide}, ${min}`);
  B.line(`${high} = icmp sle i64 ${wide}, ${max}`);
  B.line(`${ok} = and i1 ${low}, ${high}`);
  return { ok, integer: wide };
}
