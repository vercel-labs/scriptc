import { arrayOf, BOOL, DYN, F64, SEARCH_PARAMS_T, STRING, VOID } from "../ir.js";
import { defineLibFnSignatures } from "./shared.js";

/** The sp builtin call slots. */
export const spSignatures = defineLibFnSignatures({
  /** URLSearchParams (scr_url.c — always linked with the url unit).
   * Construction: sp.new (empty), sp.parse (one borrowed init string —
   * a single leading '?' strips, Node's constructor), sp.copy (snapshot
   * of another list), sp.fromPairs (a string[][] value — THROWS Node's
   * ERR_INVALID_TUPLE TypeError on a non-[name, value] row; the one
   * throwing entry in the family), sp.with (the record-literal init
   * desugar: append one pair, answer the same list +1 — chains fold
   * `new URLSearchParams({...})` into nested calls). url.searchParams
   * answers the URL's LIVE cached view (+1, one identity per URL);
   * url.search is the WHATWG search getter ("" for no/empty query).
   * Methods mirror the WHATWG surface: sp.get answers +1-or-NULL (the
   * sym.desc union pattern, null arm), sp.getAll a fresh string[];
   * sp.append/sp.set/sp.delete/sp.deleteValue/sp.sort mutate and
   * re-serialize a live view's URL query; sp.has/sp.hasValue answer
   * bools; sp.size/sp.toString are pure reads. sp.keyAt/sp.valAt are
   * the for-of/forEach desugar's index reads (live — the loop re-reads
   * sp.size each pass). */
  "sp.new": { argTypes: [], result: SEARCH_PARAMS_T },
  "sp.newChecked": { argTypes: [DYN], result: SEARCH_PARAMS_T },
  "sp.parse": { argTypes: [STRING], result: SEARCH_PARAMS_T },
  "sp.copy": { argTypes: [SEARCH_PARAMS_T], result: SEARCH_PARAMS_T },
  // The pairs argument is string[][] — checked structurally in validate.ts (the
  // generic array-of slot has no named constant here).
  "sp.fromPairs": { argTypes: [null], result: SEARCH_PARAMS_T },
  "sp.with": { argTypes: [SEARCH_PARAMS_T, STRING, STRING], result: SEARCH_PARAMS_T },
  // Result is the interned `string | null` union — the libCall case
  // checks the arms (the spawnRes.signal pattern).
  "sp.get": { argTypes: [SEARCH_PARAMS_T, STRING], result: VOID },
  "sp.getAll": { argTypes: [SEARCH_PARAMS_T, STRING], result: arrayOf(STRING) },
  "sp.append": { argTypes: [SEARCH_PARAMS_T, STRING, STRING], result: VOID },
  "sp.set": { argTypes: [SEARCH_PARAMS_T, STRING, STRING], result: VOID },
  "sp.delete": { argTypes: [SEARCH_PARAMS_T, STRING], result: VOID },
  "sp.deleteValue": { argTypes: [SEARCH_PARAMS_T, STRING, STRING], result: VOID },
  "sp.has": { argTypes: [SEARCH_PARAMS_T, STRING], result: BOOL },
  "sp.hasValue": { argTypes: [SEARCH_PARAMS_T, STRING, STRING], result: BOOL },
  "sp.sort": { argTypes: [SEARCH_PARAMS_T], result: VOID },
  "sp.size": { argTypes: [SEARCH_PARAMS_T], result: F64 },
  "sp.toString": { argTypes: [SEARCH_PARAMS_T], result: STRING },
  "sp.keyAt": { argTypes: [SEARCH_PARAMS_T, F64], result: STRING },
  "sp.valAt": { argTypes: [SEARCH_PARAMS_T, F64], result: STRING },
  /** node:stream/promises — the promise forms over the same machinery:
   * sp.finished: (s) → a pending void promise the terminal watcher
   * settles; sp.pipeline: (count, s1..sn) → the callback pipeline's
   * chaining/destroyer semantics settling a void promise (fulfilled on a
   * clean finish, rejected with the finish status otherwise). */
  "sp.finished": { argTypes: [null], result: { kind: "promise", inner: VOID } },
  /** The options forms: finished(s, { readable, writable, error, cleanup,
   * signal }) as [s, readable, writable, error, cleanup, signal?] —
   * readable/writable -1 (absent), 0 or 1 — and pipeline(...streams,
   * { signal, end }) as [count, s1..sn, end, signal?]. The Signal forms
   * link the event-target unit (addAbortListener). The callback form
   * stream.finishedOpts: [s, readable, writable, error, signal?, cb] →
   * the cleanup closure. */
  "sp.finishedOpts": {
    argTypes: [null, F64, F64, BOOL, BOOL],
    result: { kind: "promise", inner: VOID },
  },
  "sp.finishedOptsSignal": {
    argTypes: [null, F64, F64, BOOL, BOOL, DYN],
    result: { kind: "promise", inner: VOID },
  },
  "sp.pipelineOpts": { argTypes: [F64], result: { kind: "promise", inner: VOID } },
  "sp.pipelineOptsSignal": { argTypes: [F64], result: { kind: "promise", inner: VOID } },
  "sp.pipeline": { argTypes: [F64], result: { kind: "promise", inner: VOID } },
  /** pipeline with function stages: [n, k, positions, flags, mask,
   * s1..sn, stage1..stagek, helpers..., box?, (signal, abort)?] (+ the
   * callback for the stream.* forms): the user's stage functions at the
   * positions the bitmask names, the frontend's (next, read, return)
   * helpers for each pumped generator (pipelinePumpedRuns) and a promise
   * destination's box, and the pipeline's AbortSignal with its abort
   * closure; flags bits 1-2 give the destination kind and bit 5 the
   * signal group (scr_stream_pipeline_stages). A promise destination's
   * promise type is sp.pipelineStages' result. */
  "sp.pipelineStages": {
    argTypes: [F64, F64, F64, F64, F64],
    result: { kind: "promise", inner: VOID },
  },
  /** sp.pipelineStages with the options argument: the same head, then
   * end (a bool) and, with flags bit 6, the options' signal (dyn). */
  "sp.pipelineStagesOpts": {
    argTypes: [F64, F64, F64, F64, F64],
    result: { kind: "promise", inner: VOID },
  },
});
