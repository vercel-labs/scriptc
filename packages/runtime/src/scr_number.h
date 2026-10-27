/* scriptc runtime — numbers, String.fromCharCode, Number statics, Date and
 * numeric coercion (scr_number.c, scr_lib.c). Included by scr_runtime.h,
 * which says where new declarations go. */
#ifndef SCR_NUMBER_H
#define SCR_NUMBER_H

#include "scr_events.h"

/* ── numbers ────────────────────────────────────────────────────────────
 * JS-exact Number-to-string (ECMA-262 §6.1.6.1.20 Number::toString, radix
 * 10): shortest digit string that round-trips, ECMA placement rules.
 * Writes NUL-terminated result into buf (>= 32 bytes), returns length.
 */
size_t scr_f64_to_str(double x, char *buf);

/* The Ryū digit core (scr_number.c), shared with the Intl en-US number
 * formatter: the shortest round-tripping digits of a POSITIVE finite
 * double — value = 0.digits × 10^n, no trailing zeros, NUL-terminated.
 * Returns k, the digit count (≤ 17). */
int scr_f64_digits(double x, char digits[18], int *n_out);

/* Clinger's exact fast path for a VALIDATED decimal span ([+-]? digits
 * with optional fraction and exponent; no whitespace, no Infinity): sets
 * *out and returns true when the value is m × 10^e with m <= 2^53 and a
 * small |e| (one correctly rounded multiply/divide, bit-identical to
 * strtod); false means the caller must take its strtod path. */
bool scr_decimal_fast(const char *p, size_t n, double *out);
/* The same fast path with whole-span validation folded into its scan: -1
 * when p[0..n) is not such a decimal literal, 1 with *out set when exact,
 * 0 when valid but the caller must use strtod. */
int scr_decimal_scan(const char *p, size_t n, double *out);

/* Number.prototype.toFixed's digit string for finite |x| < 1e21 and
 * 0 <= f <= 100: the spec's n (closest to |x| × 10^f on the EXACT binary
 * value, ties up) with the point placed f digits from the right and "-"
 * for x < 0. Writes NUL-terminated text into buf (>= 128 bytes); returns
 * the length. */
size_t scr_f64_to_fixed(double x, int f, char *buf);

/* toPrecision / toExponential(fractionDigits) digits for POSITIVE finite
 * a and 1 <= p <= 101: the spec's p-digit n (ties to the larger n on the
 * exact binary value) into digits (NUL-terminated, >= p + 1 bytes) and its
 * decimal exponent e (value ~ d.ddd x 10^e) into *e_out. Returns p. */
int scr_f64_precision_digits(double a, int p, char *digits, int *e_out);

/* ToString for template literals / string coercion. Returns +1. */
ScrStr *scr_f64_to_scrstr(double x);
ScrStr *scr_bool_to_scrstr(bool b); /* interned "true"/"false" */

/* ── String surface (scr_lib.c) ───────────────────────────────────────
 * fromCharCode: ONE packed f64[] of UTF-16 code units — ToUint16 each,
 * adjacent surrogate pairs combine, other surrogates stay lone. Borrowed
 * args; the string result is +1; neither throws. */
ScrStr *scr_str_from_char_code(ScrArr *codes);
/* String.fromCharCode over n codes in a caller-owned array (no ScrArr). */
ScrStr *scr_str_from_char_codes(const double *codes, size_t n);
/* Single numeric argument; avoids argument packing. Defined in scr_string.c
 * to share its character cache. Same ToUint16 and lone-surrogate behavior. */
ScrStr *scr_str_from_char_code_one(double code);
/* The spread-typed-array form (String.fromCharCode(...bytes) — the
 * magic-number ASCII probe); same semantics per element. */
ScrStr *scr_str_from_char_code_bytes(ScrBytes *codes);
/* Numeric Unicode code points, borrowed source; +1 string or NULL with
 * a pending RangeError. Adjacent surrogate code points combine. */
ScrStr *scr_str_from_code_point(ScrArr *codes);
ScrStr *scr_str_from_code_point_bytes(ScrBytes *codes);

/* ── Number statics (scr_lib.c) ───────────────────────────────────────
 * JS-exact by construction: Number.isFinite/isNaN/isInteger/isSafeInteger
 * never coerce, and the compiler only routes f64-typed arguments here.
 * None throws. */
bool scr_num_is_finite(double x);
bool scr_num_is_nan(double x);
bool scr_num_is_integer(double x);
bool scr_num_is_safe_integer(double x);
/* Number.prototype formatters: toExponential() is the fraction-digits-free
 * shortest correctly-rounded mantissa; toFixed0 is the non-throwing omitted
 * argument form. toFixed implements an explicit 0..100 fractionDigits with
 * exact binary-value rounding and THROWS V8's catchable RangeError outside
 * that range. All successful results are +1. */
ScrStr *scr_num_to_exponential(double x);
ScrStr *scr_num_to_fixed0(double x);
ScrStr *scr_num_to_fixed(double x, double fraction_digits);
/* Number.prototype.toPrecision(precision) and toExponential(fractionDigits)
 * with the argument already coerced (has_precision false = undefined).
 * Invalid digit counts throw V8's RangeError (NULL). Result +1. */
ScrStr *scr_num_to_precision(double x, double precision, bool has_precision);
ScrStr *scr_num_to_exponential_digits(double x, double fraction_digits);
ScrStr *scr_num_to_string_radix_f64(double value, double radix);

/* Object.is over two numbers — the spec's SameValue on doubles: NaN
 * equals NaN, +0 differs from -0, everything else is ==. Never throws. */
bool scr_num_same_value(double a, double b);

/* Intl.NumberFormat("en-US").format(x) / x.toLocaleString("en-US") with
 * default options: decimal notation, 0–3 fraction digits rounded half-up
 * on the shortest round-tripping decimal (ICU's rounding input — NOT
 * toFixed's exact-value rounding), "," grouping every three integer
 * digits, "∞"/"NaN" texts, "-0" for negative inputs rounding to zero.
 * en-US is the one embedded locale. Result +1; never throws. */
ScrStr *scr_intl_num_format_en_us(double x);

/* ── Date, the read-only value slice (scr_lib.c) ──────────────────────
 * A Date value is its TimeClip'd epoch-millisecond scalar. Identity and
 * mutation are frontend-fenced; construction, storage, getters, and ISO
 * formatting are exact over this representation. */
double scr_date_now(void); /* integer ms since epoch, like Node */
/* The clock of the MockTimers that mocks Date (scr_test.c), NULL while
 * Date is not mocked. Dynamic `new Date()` reads it; the runtime's own
 * time stamps keep scr_date_now, as Node's internals keep the real Date. */
extern SCR_TL const double *scr_date_mock_now;
double scr_date_new_ms(double ms); /* TimeClip (NaN when invalid) */
double scr_date_get_time(double ms);
/* Date.prototype's setters (setMilliseconds ... setFullYear and their UTC
 * forms) over a time value: the new time value for `argc` arguments
 * `a`..`d` (scr_lib.c). `setter` is an SCR_DATE_SET_* code; it and `argc`
 * are whole numbers passed as doubles, as the compiler's lib calls pass
 * numbers. */
enum {
  SCR_DATE_SET_MILLISECONDS = 0,
  SCR_DATE_SET_SECONDS = 1,
  SCR_DATE_SET_MINUTES = 2,
  SCR_DATE_SET_HOURS = 3,
  SCR_DATE_SET_DATE = 4,
  SCR_DATE_SET_MONTH = 5,
  SCR_DATE_SET_FULL_YEAR = 6,
  SCR_DATE_SET_UTC = 8,
};
double scr_date_set_fields(double t, double setter, double argc,
                           double a, double b, double c, double d);
/* A Date object: the TimeClip'd time value in milliseconds (NaN for an
 * invalid date). Dates are immutable; their identity is the pointer.
 * Retain/release follow the runtime's RC conventions (SIZE_MAX immortal). */
typedef struct ScrDate {
  size_t rc;
  double ms;
} ScrDate;
ScrDate *scr_date_new(double ms); /* +1 */
ScrDate *scr_date_retain(ScrDate *date);
void scr_date_release(ScrDate *date);
void *scr_date_retain_v(void *p);
void scr_date_release_v(void *p);
/* Node's exact ISO 8601 UTC format (expanded ±YYYYYY years outside
 * 0–9999). THROWS Node's "Invalid time value" RangeError on NaN or
 * |ms| > 8.64e15 and returns NULL; +1 otherwise. */
ScrStr *scr_date_to_iso(double ms);
/* Node's Date.prototype.toUTCString ("Thu, 01 Jan 1970 00:00:00 GMT";
 * "Invalid Date" for NaN). Never throws; +1. */
ScrStr *scr_date_to_utc_string(double ms);
/* The BOUNDED parse (the X509 validity shape + ECMA's format with an
 * explicit offset); NaN elsewhere. */
double scr_date_parse_get_time(ScrStr *s);
/* Date.parse and new Date(dateString): V8's date parser (the ES5 format,
 * then its legacy grammar: RFC 1123/2822, Date#toString, "Jan 2, 2024",
 * ...). Zone-less dates are local time. Never throws. */
double scr_date_parse(ScrStr *s);
/* new Date(year, monthIndex, date, hours, minutes, seconds, ms) over
 * already-number arguments: V8's MakeDay/MakeTime over LOCAL fields, then
 * UTC(t) in the host zone and TimeClip. Never throws. */
double scr_date_new_local(double y, double mo, double d,
                          double h, double mi, double s, double ms);
/* Date.UTC over already-number arguments (frontend completes the spec's
 * defaults): MakeDay/MakeTime/TimeClip exactly — 0–99 maps to 1900+year,
 * month/date rollover, NaN for non-finite parts, out-of-range results,
 * and years past V8's ±1e6 MakeDay bound. Never throws. */
double scr_date_utc(double y, double mo, double d,
                    double h, double mi, double s, double ms);
double scr_date_get_full_year(double ms, bool utc);
double scr_date_get_month(double ms, bool utc);
double scr_date_get_date(double ms, bool utc);
double scr_date_get_day(double ms, bool utc);
double scr_date_get_hours(double ms, bool utc);
double scr_date_get_minutes(double ms, bool utc);
double scr_date_get_seconds(double ms, bool utc);
double scr_date_get_milliseconds(double ms);
double scr_date_get_timezone_offset(double ms);
/* Date.prototype.toString, toDateString and toTimeString with V8's
 * formats; "Invalid Date" for NaN. +1. */
ScrStr *scr_date_to_string(double ms);
ScrStr *scr_date_to_date_string(double ms);
ScrStr *scr_date_to_time_string(double ms);
/* String() of a Date object (ScrDate *), and Array.prototype.join over an
 * array of Date objects (holes empty). +1. */
ScrStr *scr_date_object_to_string(void *date);
struct ScrArr;
ScrStr *scr_date_arr_join(struct ScrArr *dates, const ScrStr *sep);
/* The long time zone name Node prints after the GMT offset for the host
 * zone at time value `ms`; `isdst` is tm_isdst at `ms`, or -1 when not
 * known. Borrowed; valid until the next call on the same thread. */
const char *scr_date_zone_name(double ms, int isdst);
/* One-argument ABI wrappers used by the LLVM lib-call table. */
double scr_date_get_full_year_local(double ms);
double scr_date_get_full_year_utc(double ms);
double scr_date_get_month_local(double ms);
double scr_date_get_month_utc(double ms);
double scr_date_get_date_local(double ms);
double scr_date_get_date_utc(double ms);
double scr_date_get_day_local(double ms);
double scr_date_get_day_utc(double ms);
double scr_date_get_hours_local(double ms);
double scr_date_get_hours_utc(double ms);
double scr_date_get_minutes_local(double ms);
double scr_date_get_minutes_utc(double ms);
double scr_date_get_seconds_local(double ms);
double scr_date_get_seconds_utc(double ms);

/* ── numeric coercion + bitwise operators ─────────────────────────────
 * JS-exact ToInt32/ToUint32 semantics: NaN/±Infinity → 0, truncation
 * toward zero, modular wrap into 32 bits; the operation runs in 32-bit
 * space (shift counts mask to 5 bits, `>>` is an arithmetic shift spelled
 * portably — no C UB/implementation-defined shifts) and the result
 * returns to f64: `>>>` as Uint32, everything else as Int32.
 * ToUint32 and the bitwise operations live in scr_number.c. */
uint32_t scr_to_uint32(double d);
double scr_bit_and(double a, double b);
double scr_bit_or(double a, double b);
double scr_bit_xor(double a, double b);
double scr_bit_shl(double a, double b);
double scr_bit_shr(double a, double b);
double scr_bit_ushr(double a, double b);
double scr_bit_not(double a);

#endif /* SCR_NUMBER_H */
