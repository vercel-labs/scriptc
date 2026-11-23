import { DYN } from "../ir.js";
import { defineLibFnSignatures } from "./shared.js";

/** The te builtin call slots. */
export const teSignatures = defineLibFnSignatures({
  /** node:trace_events (scr_async_dyn.c): createTracing(options) validates
   * the options object and its categories array (Node's ERR_INVALID_ARG_TYPE
   * and ERR_TRACE_EVENTS_CATEGORY_REQUIRED — MAY THROW) and answers a
   * Tracing handle; getEnabledCategories answers the sorted, de-duplicated
   * categories of the enabled Tracing objects, or the undefined value. */
  "te.createTracing": { argTypes: [DYN], result: DYN },
  "te.getEnabledCategories": { argTypes: [], result: DYN },
});
