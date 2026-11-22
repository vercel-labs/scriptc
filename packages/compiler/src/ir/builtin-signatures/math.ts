import { arrayOf, F64 } from "../ir.js";
import { defineLibFnSignatures } from "./shared.js";

/** The math builtin call slots. */
export const mathSignatures = defineLibFnSignatures({
  /** `Math.max(...xs)` / `Math.min(...xs)` over one spread number[]
   * (scr_number.c): the JS fold exactly — any NaN element poisons the
   * result, ±0 order by the JS comparison (max prefers +0, min prefers
   * -0), and the empty array yields -Infinity / +Infinity like the
   * zero-argument calls. Borrows the array; never throws. */
  "math.maxArr": { argTypes: [arrayOf(F64)], result: F64 },
  "math.minArr": { argTypes: [arrayOf(F64)], result: F64 },
  "math.hypotArr": { argTypes: [arrayOf(F64)], result: F64 },
  /** `Math.floor(x)` — C floor() IS the JS operation (NaN/±0/±Infinity
   * pass through bit-exactly). Never throws. */
  "math.floor": { argTypes: [F64], result: F64 },
  /** Math.abs (C fabs — IS the JS operation) and Math.round (scr_lib.c:
   * ECMA half-toward-+Infinity with the exact-fraction comparison — C
   * round() is half-away-from-zero and floor(x+0.5) drifts at the
   * epsilon boundary). Borrow nothing; never throw. */
  "math.abs": { argTypes: [F64], result: F64 },
  "math.round": { argTypes: [F64], result: F64 },

  "math.trunc": { argTypes: [F64], result: F64 },
  "math.ceil": { argTypes: [F64], result: F64 },
  "math.sin": { argTypes: [F64], result: F64 },
  "math.sinh": { argTypes: [F64], result: F64 },
  "math.cos": { argTypes: [F64], result: F64 },
  "math.cosh": { argTypes: [F64], result: F64 },
  "math.tan": { argTypes: [F64], result: F64 },
  "math.tanh": { argTypes: [F64], result: F64 },
  "math.asin": { argTypes: [F64], result: F64 },
  "math.asinh": { argTypes: [F64], result: F64 },
  "math.acos": { argTypes: [F64], result: F64 },
  "math.acosh": { argTypes: [F64], result: F64 },
  "math.atan": { argTypes: [F64], result: F64 },
  "math.atanh": { argTypes: [F64], result: F64 },
  "math.cbrt": { argTypes: [F64], result: F64 },
  "math.clz32": { argTypes: [F64], result: F64 },
  /** Return -1, +1, or the original NaN/zero. In particular, -0 remains -0. */
  "math.sign": { argTypes: [F64], result: F64 },
  "math.exp": { argTypes: [F64], result: F64 },
  "math.expm1": { argTypes: [F64], result: F64 },
  "math.f16round": { argTypes: [F64], result: F64 },
  "math.fround": { argTypes: [F64], result: F64 },
  "math.sqrt": { argTypes: [F64], result: F64 },
  "math.log": { argTypes: [F64], result: F64 },
  "math.log1p": { argTypes: [F64], result: F64 },
  "math.log2": { argTypes: [F64], result: F64 },
  "math.log10": { argTypes: [F64], result: F64 },
  "math.atan2": { argTypes: [F64, F64], result: F64 },
  "math.pow": { argTypes: [F64, F64], result: F64 },
  "math.imul": { argTypes: [F64, F64], result: F64 },
  /** `Math.min(a, b)` / `Math.max(a, b)` — the two-argument scalar forms
   * (scr_lib.c), JS-exact like the Arr folds: NaN poisons, max prefers +0
   * over -0 (min the reverse). C fmin/fmax are NOT these (they drop NaN).
   * Never throw. */
  "math.min": { argTypes: [F64, F64], result: F64 },
  "math.max": { argTypes: [F64, F64], result: F64 },
  /** `Math.random()` — a uniform double in [0,1) with the spec's 53-bit
   * granularity, drawn from arc4random_buf (the CSPRNG behind the crypto
   * lowerings). Same distribution as Node, NECESSARILY different sequence
   * (SEMANTICS.md 62 — no seeded sequence exists to match). Never throws. */
  "math.random": { argTypes: [], result: F64 },
});
