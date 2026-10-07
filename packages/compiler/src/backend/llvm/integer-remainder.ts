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
