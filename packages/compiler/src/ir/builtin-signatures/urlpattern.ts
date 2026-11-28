import { BOOL, DYN } from "../ir.js";
import { defineLibFnSignatures } from "./shared.js";

/** The urlpattern builtin call slots. */
export const urlpatternSignatures = defineLibFnSignatures({
  /** new URLPattern(input[, baseURL][, options]): the input coerces or is
   * a component record; the runtime validates the pattern (MAY THROW). */
  "urlpattern.new": { argTypes: [DYN, DYN, DYN], result: DYN },
  /** `value instanceof URLPattern`. */
  "urlpattern.is": { argTypes: [DYN], result: BOOL },
});
