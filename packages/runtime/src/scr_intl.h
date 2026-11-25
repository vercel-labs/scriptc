/* scriptc runtime — Intl over ICU (scr_intl.c). Included by scr_runtime.h,
 * which says where new declarations go. */
#ifndef SCR_INTL_H
#define SCR_INTL_H

#include "scr_string.h"

typedef struct ScrDyn ScrDyn; /* full definition in scr_dyn.h (C11 repeat) */

/* ── Intl over ICU4C (scr_intl.c) ─────────────────────────────────────
 * Compiled and linked — with the vendored ICU archive — only into
 * programs whose IR selects the `icu` runtime feature (the `icu.*`
 * libCalls below). Every other program links none of it: the engine-free
 * fast paths stay in scr_grapheme.c (default grapheme clusters) and
 * scr_lib.c (numbers at the embedded en-US locale).
 *
 * Node answers these forms from ICU's DATA, which is a 31.6 MiB file
 * (icudt78l.dat) shipped beside the executable, never embedded. */

/* Number.prototype.toLocaleString() at the default locale: the same
 * formatter engine V8 uses (icu::number::LocalizedNumberFormatter) with
 * CLDR's default decimal pattern, group sizes and grouping thresholds,
 * and half-up rounding to three fraction digits. +1 result. */
ScrStr *scr_intl_num_format_default(double x);

/* process.config.variables.v8_enable_i18n_support: Node's own answer is the
 * number 1 (it bundles ICU). A compiled binary answers the same 1, and the
 * read is what links ICU — so the flag is true of the binary that reports
 * it, and no binary that reports it can lack ICU. */
double scr_intl_i18n_support(void);

/* Date.prototype.toLocaleString() and toLocaleTimeString() at the default
 * locale: ICU's best pattern for the skeleton V8 asks for ("yMdjms" /
 * "jms") over `ms` milliseconds in the host time zone, with V8's U+202F →
 * U+0020 replacement ("Revert ICU 72 change — crbug.com/1414292"). An
 * invalid date (NaN) answers "Invalid Date". +1 result. */
ScrStr *scr_intl_date_locale_string(double ms);
ScrStr *scr_intl_date_locale_time_string(double ms);

/* Intl.Segmenter({ granularity: "word" }), ICU's UAX #29 word break
 * iterator at `locale` (NULL: the default locale). Records carry
 * `isWordLike`, as Node's word segments do. +1 handle. */
ScrDyn *scr_intl_segmenter_word_new(ScrStr *locale);

/* Intl.NumberFormat: `new Intl.NumberFormat(locale, options)` (and the
 * call without `new`), `format(x)` on its result, and
 * Number.prototype.toLocaleString(locale, options), which constructs the
 * same formatter for one call. `locale` is the BCP 47 tag the compiler
 * accepted, or the empty string for the default locale; `options` is the
 * options argument as a checked-dynamic value (undefined when absent), read
 * by ECMA-402's steps: Node's reads, conversions and errors. The formatter
 * is a NumberFormat handle. The `_dyn` form takes the argument as a
 * checked-dynamic value (a number, or undefined). +1 results; NULL with the
 * exception pending. */
ScrDyn *scr_intl_number_format_new(ScrStr *locale, ScrDyn *options);
ScrStr *scr_intl_number_format_format(ScrDyn *format, double x);
ScrStr *scr_intl_number_format_format_dyn(ScrDyn *format, ScrDyn *value);
ScrStr *scr_intl_number_to_locale_string(double x, ScrStr *locale, ScrDyn *options);

/* Intl.DateTimeFormat: the constructor, `format(ms)` on its result (a
 * RangeError outside the time value range), and Date.prototype
 * .toLocaleString / toLocaleDateString / toLocaleTimeString (`kind` 0, 1,
 * 2) with a locale and options; an invalid date answers "Invalid Date"
 * before any option is read. */
ScrDyn *scr_intl_date_time_format_new(ScrStr *locale, ScrDyn *options);
ScrStr *scr_intl_date_time_format_format(ScrDyn *format, double ms);
ScrStr *scr_intl_date_time_format_format_dyn(ScrDyn *format, ScrDyn *value);
ScrStr *scr_intl_date_to_locale(double ms, double kind, ScrStr *locale, ScrDyn *options);

#endif /* SCR_INTL_H */
