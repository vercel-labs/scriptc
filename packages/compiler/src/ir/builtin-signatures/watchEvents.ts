import { BOOL, DYN, WATCHEVENTS_T, VOID } from "../ir.js";
import { defineLibFnSignatures } from "./shared.js";

/** The watchEvents builtin call slots. */
export const watchEventsSignatures = defineLibFnSignatures({
  "watchEvents.wait": { argTypes: [WATCHEVENTS_T], result: { kind: "promise", inner: BOOL } },
  "watchEvents.take": { argTypes: [WATCHEVENTS_T], result: DYN },
  "watchEvents.close": { argTypes: [WATCHEVENTS_T], result: VOID },
});
