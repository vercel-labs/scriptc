import { DATE_T, DYN, F64, STRING } from "../ir.js";
import { defineLibFnSignatures } from "./shared.js";

/** The icu builtin call slots. */
export const icuSignatures = defineLibFnSignatures({
  /** `x.toLocaleString()` at the default locale: the same ICU number
   * engine V8 uses, over the full ICU data (scr_intl.c). Throws an Error
   * when the ICU data file is missing. Result +1. */
  "icu.numFormatDefault": { argTypes: [F64], result: STRING },
  /** `process.config.variables.v8_enable_i18n_support`: the number 1, as
   * Node (which bundles ICU) answers. Reading it selects the `icu`
   * runtime feature, so the binary that reports ICU is the binary that
   * carries it (scr_intl.c). */
  "icu.i18nSupport": { argTypes: [], result: F64 },
  /** `d.toLocaleString()` / `d.toLocaleTimeString()` at the default
   * locale over `d`'s time value (scr_intl.c). Throws an Error when the
   * ICU data file is missing. Result +1. */
  "icu.dateLocaleString": { argTypes: [DATE_T], result: STRING },
  "icu.dateLocaleTimeString": { argTypes: [DATE_T], result: STRING },
  /** `new Intl.NumberFormat(locales, options)` (and the call without
   * `new`): the locale tag the compiler accepted (the empty string: the
   * default locale) and the options argument as a checked-dynamic value
   * (undefined when absent), which the runtime reads by ECMA-402's steps:
   * Node's reads, conversions and errors. The result is a NumberFormat
   * handle (+1). */
  "icu.numberFormatNew": { argTypes: [STRING, DYN], result: DYN },
  /** `nf.format(x)` over a number: the formatter's text (+1); a TypeError
   * when the value is not a NumberFormat. */
  "icu.numberFormatFormat": { argTypes: [DYN, F64], result: STRING },
  /** The same over a checked-dynamic argument: a number, or undefined
   * (NaN); any other value is refused with the code SC2020. */
  "icu.numberFormatFormatDyn": { argTypes: [DYN, DYN], result: STRING },
  /** `x.toLocaleString(locales, options)`: the same formatter built for
   * one call, with the method's name in the null-options TypeError. */
  "icu.numToLocaleString": { argTypes: [F64, STRING, DYN], result: STRING },
  /** `new Intl.DateTimeFormat(locales, options)` (and the call without
   * `new`): as icu.numberFormatNew; a DateTimeFormat handle (+1). */
  "icu.dateTimeFormatNew": { argTypes: [STRING, DYN], result: DYN },
  /** `new Intl.ListFormat(locales, options)` (and the call without
   * `new`): as icu.numberFormatNew; a ListFormat handle (+1). */
  "icu.listFormatNew": { argTypes: [STRING, DYN], result: DYN },
  /** `lf.format(list)`: the formatted text (+1). The list is read at run
   * time as an iterable whose elements must be strings (Node's TypeError
   * otherwise); undefined formats the empty list. */
  "icu.listFormatFormat": { argTypes: [DYN, DYN], result: STRING },
  /** `dtf.format(date)` over a time value: the text (+1); a RangeError
   * outside the time value range. */
  "icu.dateTimeFormatFormat": { argTypes: [DYN, F64], result: STRING },
  /** The same over a checked-dynamic argument: a Date's time value,
   * undefined (the current time), else ToNumber. */
  "icu.dateTimeFormatFormatDyn": { argTypes: [DYN, DYN], result: STRING },
  /** `d.toLocaleString(locales, options)` (kind 0), `toLocaleDateString`
   * (1) and `toLocaleTimeString` (2) over the receiver's time value: the
   * formatter with the method's required and default components, built
   * for one call. "Invalid Date" for an invalid date, before any option
   * is read. */
  "icu.dateToLocale": { argTypes: [F64, F64, STRING, DYN], result: STRING },
  /** The same with a computed locales argument: the runtime checks the time
   * value first, so an invalid Date answers "Invalid Date" without
   * canonicalizing the locale (or reading the options), as Node does.
   * Result +1. */
  "icu.dateToLocaleDyn": { argTypes: [F64, F64, DYN, DYN], result: STRING },
  /** A locales argument the program computed (a checked-dynamic value): the
   * tag the formatter builds at, by ECMA-402's CanonicalizeLocaleList as
   * far as the runtime models it. Undefined and a value without a locale
   * list length (a number, a boolean, a plain object) name the empty list,
   * which selects the default locale; a string is its own tag, validated
   * by the formatter; null is Node's TypeError; a non-empty list is locale
   * negotiation and is refused by name. Result +1. */
  "icu.localeValue": { argTypes: [DYN], result: STRING },
  /** `new Intl.Segmenter(locale?, { granularity: "word" })`: ICU's UAX
   * #29 word iterator (scr_intl.c over ICU), which the
   * table-driven grapheme segmenter above cannot express. The argument is
   * the negotiated language tag; the empty string selects the default
   * locale (ICU's, resolved from the host environment like V8's). +1
   * handle. */
  "icu.segmenterWord": { argTypes: [STRING], result: DYN },
});
