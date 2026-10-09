import { F64 } from "../../ir/ir.js";
import type { LlValue, LlvmEmitterContext } from "./expr-context.js";
import { f64Lit } from "./common.js";
import { integerNumber, widenInteger, type LlInteger } from "./integer-values.js";

/** Integer proofs exclude negative zero and stay inside the exact-number
 * range, so signed i64 division cannot overflow. A possibly zero divisor
 * keeps floating remainder. Negative multiples must still produce -0;
 * never attach an exact-integer fact to that result. */
export function emitSignedIntegerRemainder(
  host: LlvmEmitterContext,
  left: LlValue,
  dividend: LlInteger,
  divisor: LlInteger,
): LlValue | null {
  if (divisor.range.min <= 0 && divisor.range.max >= 0) return null;
  const B = host.B;
  const integer = widenInteger(host, dividend),
    denominator = widenInteger(host, divisor),
    remainder = B.tmp();
  B.line(`${remainder} = srem i64 ${integer}, ${denominator}`);
  if (dividend.range.min >= 0)
    return integerNumber(
      host,
      remainder,
      {
        min: 0,
        max: Math.min(
          dividend.range.max,
          Math.max(Math.abs(divisor.range.min), Math.abs(divisor.range.max)) - 1,
        ),
      },
      F64,
    );
  const number = B.tmp(),
    zero = B.tmp(),
    signedZero = B.tmp(),
    result = B.tmp();
  B.line(`${number} = sitofp i64 ${remainder} to double`);
  B.line(`${zero} = icmp eq i64 ${remainder}, 0`);
  B.line(`${signedZero} = fmul double ${left.name}, ${f64Lit(0)}`);
  B.line(`${result} = select i1 ${zero}, double ${signedZero}, double ${number}`);
  return { name: result, type: F64 };
}

const EXACT = 2 ** 53;

/** Convert an unproven double to a candidate i64. `freeze` keeps NaN and
 * out-of-range conversions from producing poison; the returned condition
 * is the exact round trip, so it rejects every non-integer. Integral
 * doubles inside the i64 range convert exactly; a passing value outside
 * it (|x| >= 2^63) can only pair with a frozen integer of magnitude above
 * 2^53. `-0` converts to 0 and passes. */
function candidateInteger(host: LlvmEmitterContext, value: string): [string, string] {
  const B = host.B;
  const raw = B.tmp(),
    integer = B.tmp(),
    back = B.tmp(),
    exact = B.tmp();
  B.line(`${raw} = fptosi double ${value} to i64`);
  B.line(`${integer} = freeze i64 ${raw}`);
  B.line(`${back} = sitofp i64 ${integer} to double`);
  B.line(`${exact} = fcmp oeq double ${back}, ${value}`);
  return [integer, exact];
}

/** JS `%` with an inline integer path for operands that are not both
 * proven integers with a nonzero divisor. At run time the dividend must be
 * an integer of magnitude <= 2^53 and the divisor a nonzero integer; then
 * i64 `srem` is exact (no INT64_MIN / -1 overflow is possible), takes the
 * dividend's sign like JS, and an exact zero takes the dividend's sign
 * (`-4 % 2` and `-0 % 3` are -0). A divisor that passes the round trip
 * with magnitude above 2^53 exceeds the dividend's, so `srem` returns the
 * dividend exactly as JS does. Everything else (fractions, NaN, ±Infinity,
 * zero divisors, huge dividends) takes the floating remainder, unchanged.
 * Returns null when the divisor is the constant zero (always NaN). */
export function emitCheckedRemainder(
  host: LlvmEmitterContext,
  left: LlValue,
  right: LlValue,
  dividend: LlInteger | null,
  divisor: LlInteger | null,
): LlValue | null {
  if (divisor && divisor.range.min === 0 && divisor.range.max === 0) return null;
  const B = host.B;
  const conditions: string[] = [];
  let x: string;
  if (dividend) x = widenInteger(host, dividend);
  else {
    const [integer, exact] = candidateInteger(host, left.name);
    const biased = B.tmp(),
      inRange = B.tmp();
    B.line(`${biased} = add i64 ${integer}, ${EXACT}`);
    B.line(`${inRange} = icmp ule i64 ${biased}, ${2 * EXACT}`);
    conditions.push(exact, inRange);
    x = integer;
  }
  let y: string;
  if (divisor) {
    y = widenInteger(host, divisor);
    if (divisor.range.min <= 0 && divisor.range.max >= 0) {
      const nonzero = B.tmp();
      B.line(`${nonzero} = icmp ne i64 ${y}, 0`);
      conditions.push(nonzero);
    }
  } else {
    const [integer, exact] = candidateInteger(host, right.name);
    const nonzero = B.tmp();
    B.line(`${nonzero} = icmp ne i64 ${integer}, 0`);
    conditions.push(exact, nonzero);
    y = integer;
  }
  let ok = conditions[0]!;
  for (const c of conditions.slice(1)) {
    const t = B.tmp();
    B.line(`${t} = and i1 ${ok}, ${c}`);
    ok = t;
  }
  host.declare("declare i1 @llvm.expect.i1(i1, i1)");
  const expected = B.tmp();
  B.line(`${expected} = call i1 @llvm.expect.i1(i1 ${ok}, i1 true)`);
  const fast = B.newLabel("rem.int"),
    slow = B.newLabel("rem.float"),
    join = B.newLabel("rem.join");
  B.condBr(expected, fast, slow);
  B.startBlock(fast);
  const remainder = B.tmp(),
    number = B.tmp();
  B.line(`${remainder} = srem i64 ${x}, ${y}`);
  B.line(`${number} = sitofp i64 ${remainder} to double`);
  let fastValue = number;
  if (!dividend || dividend.range.min < 0) {
    const zero = B.tmp(),
      signedZero = B.tmp();
    fastValue = B.tmp();
    B.line(`${zero} = icmp eq i64 ${remainder}, 0`);
    B.line(`${signedZero} = fmul double ${left.name}, ${f64Lit(0)}`);
    B.line(`${fastValue} = select i1 ${zero}, double ${signedZero}, double ${number}`);
  }
  B.br(join);
  B.startBlock(slow);
  const floating = B.tmp();
  B.line(`${floating} = frem double ${left.name}, ${right.name}`);
  B.br(join);
  B.startBlock(join);
  const result = B.tmp();
  B.line(`${result} = phi double [ ${fastValue}, %${fast} ], [ ${floating}, %${slow} ]`);
  return { name: result, type: F64 };
}
