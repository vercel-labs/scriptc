import { DYN, F64, STRING } from "../ir.js";
import { defineLibFnSignatures } from "./shared.js";

/** The intl builtin call slots. */
export const intlSignatures = defineLibFnSignatures({
  /** `new Intl.NumberFormat("en-US").format(x)` and
   * `x.toLocaleString("en-US")` with DEFAULT options — the one locale
   * whose data the runtime embeds (Node's default-build locale): decimal
   * notation, 0–3 fraction digits rounded half-up on the SHORTEST
   * round-tripping decimal (ICU's rounding input, probed vs Node —
   * format(1.0005) is "1.001" though toFixed(3) answers "1.000"), ","
   * grouping every three integer digits, "∞"/"NaN" texts, and "-0" for
   * negative inputs rounding to zero. Result +1; never throws. */
  "intl.numFormatEnUs": { argTypes: [F64], result: STRING },
  "intl.segmenterNew": { argTypes: [], result: DYN },
  "intl.segmenterRefusing": { argTypes: [STRING], result: DYN },
});
