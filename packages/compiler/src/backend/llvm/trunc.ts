/* ToIntegerOrInfinity-style truncation of a double toward zero. */
import type { LlvmEmitterContext } from "./expr-context.js";
import { f64Lit } from "./common.js";

/** `Math.trunc(value)`. Targets with a rounding instruction use
 * `llvm.trunc`; on baseline x86-64 that intrinsic is a libm call, so the
 * value instead takes an integer round trip. Every double of magnitude at
 * least 2^52 is already an integer, and NaN and the infinities fail the
 * magnitude test, so those keep their value; the round trip of a smaller
 * value restores its sign so that `-0.5` and `-0` truncate to `-0`. */
export function emitTruncF64(host: LlvmEmitterContext, value: string): string {
  const B = host.B;
  if (!host.inlineTrunc) {
    host.declare("declare double @llvm.trunc.f64(double)");
    const out = B.tmp();
    B.line(`${out} = call double @llvm.trunc.f64(double ${value})`);
    return out;
  }
  host.declare("declare double @llvm.fabs.f64(double)");
  host.declare("declare double @llvm.copysign.f64(double, double)");
  const magnitude = B.tmp(),
    small = B.tmp(),
    integer = B.tmp(),
    back = B.tmp(),
    signed = B.tmp(),
    out = B.tmp();
  B.line(`${magnitude} = call double @llvm.fabs.f64(double ${value})`);
  B.line(`${small} = fcmp olt double ${magnitude}, ${f64Lit(2 ** 52)}`);
  // Poison for a large or non-finite value, which the select never picks.
  B.line(`${integer} = fptosi double ${value} to i64`);
  B.line(`${back} = sitofp i64 ${integer} to double`);
  B.line(`${signed} = call double @llvm.copysign.f64(double ${back}, double ${value})`);
  B.line(`${out} = select i1 ${small}, double ${signed}, double ${value}`);
  return out;
}
