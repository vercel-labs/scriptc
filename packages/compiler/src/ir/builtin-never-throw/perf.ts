import type { IrLibFn } from "../builtin-signatures.js";

/** The builtins in the perf module decided never to throw. */
export const perfNeverThrow: readonly IrLibFn[] = [
  // perf_hooks histogram readings and state: the handle indexes the
  // thread's table, every selector is arithmetic over it, and none runs
  // program code. (Creating and recording validate their arguments, so
  // those are MAY_THROW.)
  "perf.histoStat",
  "perf.histoStatBig",
  "perf.histoEwma",
  "perf.histoPercentile",
  "perf.histoPercentileBig",
  "perf.histoMeanCI",
  "perf.histoWelch",
  "perf.histoPercentileCI",
  "perf.histoCountAt",
  "perf.histoCdf",
  "perf.histoCcdf",
  "perf.histoRecordDelta",
  "perf.histoReset",
  "perf.histoPercentilesCount",
  "perf.histoPercentilesKey",
  "perf.histoPercentilesValue",
  "perf.histoBucketsKey",
  "perf.histoBucketsValue",
  "perf.histoPercentilesValueBig",
  "perf.histoDispose",
  "perf.slidingReset",
  // Both instanceof predicates compare values: scr_dyn_perf_handle_is asks
  // the handle tag, and scr_dyn_perf_entry_is asks an object's prototype
  // chain (or, for a live record, the view its materializer builds, which
  // runs no program code).
  "perf.observerIs",
  "perf.entryIs",
  // The resource-timing field accessors read a view entry's own numbers and
  // strings; no program code runs.
  "perf.entryResourceNum",
  "perf.entryResourceStr",
  // scr_perf_loop_exit and scr_perf_loop_count read the loop's clock and its
  // counter; neither runs program code.
  "perf.loopExit",
  "perf.loopCount",
];
