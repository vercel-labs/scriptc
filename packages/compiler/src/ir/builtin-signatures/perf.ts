import { BIGINT_T, BOOL, DYN, F64, STRING, VOID } from "../ir.js";
import { defineLibFnSignatures } from "./shared.js";

/** The perf builtin call slots. */
export const perfSignatures = defineLibFnSignatures({
  /** perf_hooks performance.now(): fractional ms since process start. */
  "perf.now": { argTypes: [], result: F64 },
  /** perf_hooks user timing over the thread's performance timeline. The
   * producing calls take the call's whole argument vector as one dyn
   * array (Node's validation and errors run in the runtime, MAY THROW):
   * mark/measure answer 1, entries(args, which) the entry count of
   * getEntries (0), getEntriesByName (1) or getEntriesByType (2). The
   * entryName/Type/Start/Duration/Detail accessors read entry i of that
   * answer; the frontend builds a new entry's record from them and hands
   * it to entryKeep (a typed reference capsule), and the getters read the
   * kept records back through entryRef, so entries keep their identity. */
  "perf.mark": { argTypes: [DYN], result: F64 },
  "perf.measure": { argTypes: [DYN], result: F64 },
  "perf.entries": { argTypes: [DYN, F64], result: F64 },
  "perf.clearMarks": { argTypes: [DYN], result: VOID },
  "perf.clearMeasures": { argTypes: [DYN], result: VOID },
  "perf.entryName": { argTypes: [F64], result: STRING },
  "perf.entryType": { argTypes: [F64], result: STRING },
  "perf.entryStart": { argTypes: [F64], result: F64 },
  "perf.entryDuration": { argTypes: [F64], result: F64 },
  "perf.entryDetail": { argTypes: [F64], result: DYN },
  /** performance.markResourceTiming: the call's dyn argument vector in,
   * the resource entry (view index 0) out (MAY THROW). clearResourceTimings
   * and setResourceTimingBufferSize take their argument vector too.
   * entryResourceNum/Str read a view entry's resource fields by the
   * selector order builtins/performance.ts defines. */
  "perf.resourceMark": { argTypes: [DYN], result: F64 },
  "perf.timerify": { argTypes: [DYN], result: DYN },
  "perf.resourceClear": { argTypes: [DYN], result: VOID },
  "perf.resourceBufferSize": { argTypes: [DYN], result: VOID },
  "perf.entryResourceNum": { argTypes: [F64, F64], result: F64 },
  "perf.entryResourceStr": { argTypes: [F64, F64], result: STRING },
  "perf.entryKeep": { argTypes: [DYN], result: VOID },
  "perf.entryRef": { argTypes: [F64], result: DYN },
  /** new PerformanceMark(name, options?): Node's constructor (MAY
   * THROW) — the mark timings update, the marks buffer does not; the
   * new entry is view index 0. observerNew(args) constructs a
   * PerformanceObserver from the call's argument vector and answers the
   * handle (MAY THROW). The observer methods take the receiver handle:
   * observe(obs, args) takes observe's argument vector, take(obs) moves
   * the buffered entries into the view (both answer a count for the
   * scr_perf_entry_* accessors), disconnect(obs) stops it. listEntries
   * (list, args, which) selects from a PerformanceObserverEntryList
   * (which: 0 getEntries, 1 getEntriesByName, 2 getEntriesByType).
   * observerIs(value, which) and entryIs(value, which) are the
   * `instanceof` tests for values whose static type is not the class:
   * observer/list classes 0 and 1, and PerformanceEntry 0,
   * PerformanceMark 1, PerformanceMeasure 2. */
  "perf.markNew": { argTypes: [DYN], result: F64 },
  "perf.observerNew": { argTypes: [DYN], result: DYN },
  "perf.observerObserve": { argTypes: [DYN, DYN], result: VOID },
  "perf.observerDisconnect": { argTypes: [DYN], result: VOID },
  "perf.observerTake": { argTypes: [DYN], result: F64 },
  "perf.listEntries": { argTypes: [DYN, DYN, F64], result: F64 },
  "perf.observerIs": { argTypes: [DYN, F64], result: BOOL },
  "perf.entryIs": { argTypes: [DYN, F64], result: BOOL },
  /** perf_hooks event-loop metrics (scr_perf_loop.c): loopStart is the
   * loop's start in performance.now() ms (0 before it), idleTime the idle
   * ms since. eldNew(resolution ms) creates a monitorEventLoopDelay
   * histogram handle (MAY THROW Node's resolution RangeError); enable/disable answer whether the state changed;
   * eldPercentile expects Node's validated range; eldStat(which) reads
   * 0 min, 1 max, 2 mean, 3 stddev, 4 count, 5 exceeds. loopExit is when
   * the loop ended (-1 until then, Node's PerformanceNodeTiming.loopExit),
   * loopCount the number of loop turns taken. */
  "perf.loopStart": { argTypes: [], result: F64 },
  "perf.loopExit": { argTypes: [], result: F64 },
  "perf.loopCount": { argTypes: [], result: F64 },
  "perf.idleTime": { argTypes: [], result: F64 },
  "perf.eldNew": { argTypes: [F64], result: DYN },
  "perf.eldEnable": { argTypes: [DYN], result: BOOL },
  "perf.eldDisable": { argTypes: [DYN], result: BOOL },
  "perf.eldReset": { argTypes: [DYN], result: VOID },
  "perf.eldPercentile": { argTypes: [DYN, F64], result: F64 },
  "perf.eldStat": { argTypes: [DYN, F64], result: F64 },
  /** perf_hooks createHistogram (scr_perf_loop.c): a negative handle into
   * a refcounted checked-dynamic runtime object (its release frees the
   * buckets); the base Histogram interface accepts either this object or
   * an event-loop histogram, and the runtime dispatches on the handle.
   * histoNew(options dyn, the dyn undefined
   * when absent) validates the options as Node does (MAY THROW);
   * histoRecord/RecordCorrected validate an integer >= 1 (MAY THROW) and
   * histoRecordBig takes the bigint form (MAY THROW for an out-of-range
   * bigint); histoStat(which) reads 0 count, 1 min, 2 max, 3 mean,
   * 4 stddev, 5 exceeds and histoStatBig answers the integer readings as a
   * bigint. percentile expects Node's validated (0, 100]. The percentiles
   * getter's Map is built from the view histoPercentilesCount rebuilds. */
  "perf.histoNew": { argTypes: [DYN], result: DYN },
  "perf.histoRecord": { argTypes: [DYN, F64], result: VOID },
  "perf.histoRecordBig": { argTypes: [DYN, BIGINT_T], result: VOID },
  "perf.histoRecordCorrected": { argTypes: [DYN, F64, F64], result: VOID },
  "perf.histoRecordDelta": { argTypes: [DYN], result: VOID },
  "perf.histoReset": { argTypes: [DYN], result: VOID },
  "perf.histoAdd": { argTypes: [DYN, DYN], result: VOID },
  "perf.histoSubtract": { argTypes: [DYN, DYN], result: VOID },
  "perf.histoStat": { argTypes: [DYN, F64], result: F64 },
  "perf.histoStatBig": { argTypes: [DYN, F64], result: BIGINT_T },
  "perf.histoEwma": { argTypes: [DYN, F64], result: F64 },
  "perf.histoBurnRate": { argTypes: [DYN, DYN], result: F64 },
  "perf.histoPercentile": { argTypes: [DYN, F64], result: F64 },
  "perf.histoPercentileBig": { argTypes: [DYN, F64], result: BIGINT_T },
  "perf.histoCountAt": { argTypes: [DYN, F64], result: F64 },
  "perf.histoCdf": { argTypes: [DYN, F64], result: F64 },
  "perf.histoCcdf": { argTypes: [DYN, F64], result: F64 },
  "perf.histoBucketArg": { argTypes: [DYN, F64], result: F64 },
  "perf.histoLinearBucketsCount": { argTypes: [DYN, F64], result: F64 },
  "perf.histoLogBucketsCount": { argTypes: [DYN, F64, F64], result: F64 },
  "perf.histoBucketsKey": { argTypes: [F64], result: F64 },
  "perf.histoBucketsValue": { argTypes: [F64], result: F64 },
  "perf.histoPercentilesCount": { argTypes: [DYN], result: F64 },
  "perf.histoPercentilesKey": { argTypes: [DYN, F64], result: F64 },
  "perf.histoPercentilesValue": { argTypes: [DYN, F64], result: F64 },
  "perf.histoPercentilesValueBig": { argTypes: [DYN, F64], result: BIGINT_T },
  "perf.histoLinearView": { argTypes: [DYN, DYN], result: F64 },
  "perf.histoLogView": { argTypes: [DYN, DYN, DYN], result: F64 },
  "perf.histoPercentilesAtView": { argTypes: [DYN, DYN], result: F64 },
  "perf.histoDispose": { argTypes: [DYN], result: VOID },
  "perf.slidingNew": { argTypes: [DYN], result: DYN },
  "perf.slidingRecord": { argTypes: [DYN, F64], result: VOID },
  "perf.slidingRecordBig": { argTypes: [DYN, BIGINT_T], result: VOID },
  "perf.slidingReset": { argTypes: [DYN], result: VOID },
  "perf.slidingSnapshot": { argTypes: [DYN], result: DYN },
  "perf.histoKsTest": { argTypes: [DYN, DYN], result: F64 },
  "perf.histoCohensD": { argTypes: [DYN, DYN], result: F64 },
  "perf.histoCliffsD": { argTypes: [DYN, DYN], result: F64 },
  "perf.histoMannWhitneyU": { argTypes: [DYN, DYN], result: F64 },
  "perf.histoMannWhitneyZ": { argTypes: [DYN, DYN], result: F64 },
  "perf.histoMannWhitneyP": { argTypes: [DYN, DYN], result: F64 },
  "perf.histoConfidence": { argTypes: [DYN], result: F64 },
  "perf.histoPercentileArg": { argTypes: [DYN], result: F64 },
  "perf.histoOther": { argTypes: [DYN], result: VOID },
  "perf.histoMeanCI": { argTypes: [DYN, F64, F64], result: F64 },
  "perf.histoWelch": { argTypes: [DYN, DYN, F64, F64], result: F64 },
  "perf.histoPercentileCI": { argTypes: [DYN, F64, F64, F64], result: F64 },
});
