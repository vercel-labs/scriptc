/* scriptc runtime — ECMAScript bigint values (scr_bigint.c). Included by
 * scr_runtime.h, which says where new declarations go. */
#ifndef SCR_BIGINT_H
#define SCR_BIGINT_H

#include "scr_lib.h"

/* ── ECMAScript bigint values (scr_bigint.c, linked on demand) ─────────
 * Immutable arbitrary-precision signed integers. The implementation uses
 * little-endian base-2^32 limbs, but callers see only value semantics:
 * equality and ordering compare numbers, never pointers. */
typedef struct ScrBigInt ScrBigInt;

ScrBigInt *scr_bigint_retain(ScrBigInt *v);
void scr_bigint_release(ScrBigInt *v);
void *scr_bigint_retain_v(void *v);
void scr_bigint_release_v(void *v);
ScrBigInt *scr_bigint_parse(ScrStr *text); /* borrowed text; +1 or throws */
ScrBigInt *scr_bigint_from_f64(double value); /* +1 or throws */
ScrBigInt *scr_bigint_from_u64(uint64_t value);
ScrBigInt *scr_bigint_from_i64(int64_t value);
ScrBigInt *scr_bigint_from_pointer(void *value);
uint64_t scr_bigint_to_u64(const ScrBigInt *value); /* low 64 bits, modulo 2^64 */
int64_t scr_bigint_to_i64(const ScrBigInt *value);
bool scr_bigint_pointer_fits(const ScrBigInt *value);
bool scr_bigint_u64_fits(const ScrBigInt *value);
bool scr_bigint_i64_fits(const ScrBigInt *value);
void *scr_bigint_to_pointer(const ScrBigInt *value); /* low pointer-width bits; raw address, borrowed */
ScrBigInt *scr_bigint_neg(ScrBigInt *value);
ScrBigInt *scr_bigint_not(ScrBigInt *value);
ScrBigInt *scr_bigint_add(ScrBigInt *a, ScrBigInt *b);
ScrBigInt *scr_bigint_sub(ScrBigInt *a, ScrBigInt *b);
ScrBigInt *scr_bigint_mul(ScrBigInt *a, ScrBigInt *b);
ScrBigInt *scr_bigint_div(ScrBigInt *a, ScrBigInt *b); /* throws on zero */
ScrBigInt *scr_bigint_mod(ScrBigInt *a, ScrBigInt *b); /* throws on zero */
ScrBigInt *scr_bigint_pow(ScrBigInt *a, ScrBigInt *b); /* throws on negative exponent */
ScrBigInt *scr_bigint_and(ScrBigInt *a, ScrBigInt *b);
ScrBigInt *scr_bigint_or(ScrBigInt *a, ScrBigInt *b);
ScrBigInt *scr_bigint_xor(ScrBigInt *a, ScrBigInt *b);
ScrBigInt *scr_bigint_shl(ScrBigInt *a, ScrBigInt *count);
ScrBigInt *scr_bigint_shr(ScrBigInt *a, ScrBigInt *count);
bool scr_bigint_eq(ScrBigInt *a, ScrBigInt *b);
uint64_t scr_bigint_hash(const ScrBigInt *value); /* normalized value, no allocation */
bool scr_bigint_eq_string(ScrBigInt *a, ScrStr *b); /* StringToBigInt failure is false */
double scr_bigint_cmp_string(ScrBigInt *a, ScrStr *b); /* 2 = invalid StringToBigInt */
double scr_bigint_cmp_f64(ScrBigInt *a, ScrBigInt *b); /* -1, 0, 1 */
double scr_bigint_cmp_number(ScrBigInt *a, double b); /* -1, 0, 1; 2 = NaN */
bool scr_bigint_truthy(ScrBigInt *value);
ScrStr *scr_bigint_to_string(ScrBigInt *value, double radix); /* +1 or throws */
ScrStr *scr_bigint_inspect(ScrBigInt *value); /* decimal plus trailing n; +1 */
double scr_bigint_to_f64(ScrBigInt *value);
ScrBigInt *scr_bigint_as_uint_n(double bits, ScrBigInt *value);
ScrBigInt *scr_bigint_as_int_n(double bits, ScrBigInt *value);
/* Small-value bigint trees the compiler evaluates in 64-bit registers:
 * mag64 stores the low 64 bits of the magnitude and its length in 64-bit
 * words, and returns the sign (-1, 0, 1); from_mag64 builds +-mag (+1).
 * wrap_eval is the exact fallback over a compiler-built postfix program
 * (leaves, and numbers for BigInt(number) operands); +1 or NULL with an
 * exception pending. */
int scr_bigint_mag64(const ScrBigInt *value, uint64_t *mag, uint32_t *words);
/* Whether a StringToBigInt text with this many significant digits in radix
 * 2, 8, 10 or 16 can fit the maximum BigInt size (no size arithmetic that
 * can wrap; the parser's guard before it allocates). */
bool scr_bigint_digits_fit(size_t digits, unsigned radix);
ScrBigInt *scr_bigint_from_mag64(uint64_t mag, bool negative);
ScrBigInt *scr_bigint_wrap_eval(const char *program, ScrBigInt *const *leaves, const double *numbers);
ScrBigInt *scr_bigint_buffer_read(ScrBytes *bytes, double offset, bool sign, bool le);
double scr_bigint_buffer_write(ScrBytes *bytes, ScrBigInt *value, double offset, bool sign, bool le);
/* writeBig(U)Int64's checkInt range test alone: false after throwing Node's
 * ERR_OUT_OF_RANGE. */
bool scr_bigint_buffer_check(const ScrBigInt *value, bool sign);
ScrBigInt *scr_bigint_dataview_get(ScrBytes *bytes, double offset, bool sign, bool le);
void scr_bigint_dataview_set(ScrBytes *bytes, double offset, ScrBigInt *value, bool le);

#endif /* SCR_BIGINT_H */
