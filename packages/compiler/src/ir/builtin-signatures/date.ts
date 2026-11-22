import { DATE_T, DYN, F64, STRING, VOID } from "../ir.js";
import { defineLibFnSignatures } from "./shared.js";

/** The date builtin call slots. */
export const dateSignatures = defineLibFnSignatures({
  "date.nativeNew": { argTypes: [DYN], result: DYN },
  /** `new Date(year, monthIndex, ...)` in JavaScript: the argument array's
   * first seven values pass through ToNumber in order (later ones are
   * evaluated, never converted), then the local-time field constructor. */
  "date.nativeNewFields": { argTypes: [DYN], result: DYN },
  /** `new Date(value)` in JavaScript: a string argument parses with V8's
   * full date parser; every other value constructs as date.nativeNew. */
  "date.nativeNewValue": { argTypes: [DYN], result: DYN },
  "date.argumentsTime": { argTypes: [DYN], result: DATE_T },
  "date.classOperation": { argTypes: [DYN, DYN], result: VOID },
  "date.checkedValue": { argTypes: [DYN], result: DATE_T },
  /** Date (scr_lib.c). Values are TimeClip'd epoch-millisecond scalars:
   * construction/store/pass/getters are exact while identity and mutation
   * remain fenced. date.now is Node's integer milliseconds since epoch;
   * date.toISOString formats one raw f64 millisecond time value and
   * date.toISOStringValue formats a stored Date, both with Node's rules (UTC,
   * YYYY-MM-DDTHH:mm:ss.sssZ, expanded ±YYYYYY years outside 0–9999,
   * ToInteger truncation of fractional ms) and THROWS Node's "Invalid
   * time value" RangeError on NaN / out-of-range input (may-throw seed).
   * Results: f64 / owned (+1) string. */
  "date.now": { argTypes: [], result: F64 },
  "date.newNow": { argTypes: [], result: DATE_T },
  "date.newMs": { argTypes: [F64], result: DATE_T },
  "date.newString": { argTypes: [STRING], result: DATE_T },
  /** Date.parse(dateString), with its own reach witness for exact fences. */
  "date.parse": { argTypes: [STRING], result: F64 },
  "date.getTime": { argTypes: [DATE_T], result: F64 },
  "date.valueOf": { argTypes: [DATE_T], result: F64 },
  "date.toISOString": { argTypes: [F64], result: STRING },
  "date.toISOStringValue": { argTypes: [DATE_T], result: STRING },
  /** Date.prototype.toUTCString over a stored Date ("Invalid Date" for
   * NaN; never throws). */
  "date.toUTCString": { argTypes: [DATE_T], result: STRING },
  "date.getFullYear": { argTypes: [DATE_T], result: F64 },
  "date.getUTCFullYear": { argTypes: [DATE_T], result: F64 },
  "date.getMonth": { argTypes: [DATE_T], result: F64 },
  "date.getUTCMonth": { argTypes: [DATE_T], result: F64 },
  "date.getDate": { argTypes: [DATE_T], result: F64 },
  "date.getUTCDate": { argTypes: [DATE_T], result: F64 },
  "date.getDay": { argTypes: [DATE_T], result: F64 },
  "date.getUTCDay": { argTypes: [DATE_T], result: F64 },
  "date.getHours": { argTypes: [DATE_T], result: F64 },
  "date.getUTCHours": { argTypes: [DATE_T], result: F64 },
  "date.getMinutes": { argTypes: [DATE_T], result: F64 },
  "date.getUTCMinutes": { argTypes: [DATE_T], result: F64 },
  "date.getSeconds": { argTypes: [DATE_T], result: F64 },
  "date.getUTCSeconds": { argTypes: [DATE_T], result: F64 },
  "date.getMilliseconds": { argTypes: [DATE_T], result: F64 },
  "date.getUTCMilliseconds": { argTypes: [DATE_T], result: F64 },
  "date.getTimezoneOffset": { argTypes: [DATE_T], result: F64 },
  /** A Date object for a time value a local holds (date-values.ts): a
   * lib-call argument passes the time value itself, and any other use
   * creates the Date. */
  "date.fromTime": { argTypes: [F64], result: DATE_T },
  /** Date.prototype's field setters over a time value
   * (scr_date_set_fields): time value, setter code, argument count and four
   * arguments; answers the new time value. */
  "date.setFields": { argTypes: [F64, F64, F64, F64, F64, F64, F64], result: F64 },
  /** TimeClip of a number (setTime's argument). */
  "date.timeClip": { argTypes: [F64], result: F64 },
  /** Stores a time value into a Date object and answers it (a setter's
   * write). */
  "date.store": { argTypes: [DATE_T, F64], result: F64 },
  /** Date.prototype.toString / toDateString / toTimeString and String(date):
   * V8's local-time formats with the host zone's long name, "Invalid Date"
   * for an invalid date. Owned (+1) string; never throws. */
  "date.toString": { argTypes: [DATE_T], result: STRING },
  "date.toDateString": { argTypes: [DATE_T], result: STRING },
  "date.toTimeString": { argTypes: [DATE_T], result: STRING },
  /** The composed `new Date(dateString).getTime()` read: one borrowed
   * string, f64 milliseconds since epoch, with V8's date-string grammar
   * (the ES5 format, then the legacy forms: RFC 1123/2822, Date#toString,
   * "Jan 2, 2024", ...). Zone-less dates are local time; anything V8
   * rejects is NaN, Node's invalid-date getTime. Never throws. */
  "date.parseGetTime": { argTypes: [STRING], result: F64 },
  /** `Date.UTC(...)` — seven f64 arguments (the frontend completes the
   * spec's defaults for omitted trailing parts: month 0, date 1, time
   * parts 0), the spec's MakeDay/MakeTime/TimeClip exactly: 0–99 years
   * map to 1900+year, out-of-range months/dates roll over, non-finite
   * parts and out-of-range results answer NaN. Never throws. */
  "date.utc": { argTypes: [F64, F64, F64, F64, F64, F64, F64], result: F64 },
  /** `new Date(year, monthIndex[, date, hours, minutes, seconds, ms])` —
   * the same seven-f64 completion as date.utc, but the fields are LOCAL
   * time: V8's MakeDay/MakeTime, then UTC(t) in the host zone (DST gaps
   * read with the offset before the transition, overlaps answer the
   * earlier instant), then TimeClip. Never throws. */
  "date.newLocal": { argTypes: [F64, F64, F64, F64, F64, F64, F64], result: DATE_T },
});
