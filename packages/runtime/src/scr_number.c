/* JS-exact double → string.
 *
 * ECMA-262 §6.1.6.1.20 (Number::toString, radix 10) requires the shortest
 * digit string s (with digit count k and scale n, so that the value is
 * s * 10^(n-k)) that round-trips to the exact double — among equally short
 * candidates the closest, ties to even — then fixed placement for
 * -6 < n <= 21 and exponential notation otherwise.
 *
 * Digit generation is Ryū (vendored, see ../vendor/ryu/README.md): d2d()
 * computes exactly that shortest/closest/ties-even digit string with pure
 * integer arithmetic — no snprintf/strtod probing, no locale dependence.
 * The ECMA placement logic below is ours and unchanged; only the digit
 * source moved. Byte-exactness vs Node is pinned by the oracle case file
 * and the 1M-double fuzz gate (packages/runtime/test/gen-number-cases.mjs).
 */
#include "scr_runtime.h"
#include "scr_numeric.h"

#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

/* Ryū d2s core, textually included so the build's runtime source list is
 * unchanged. Provides d2d(), d2d_small_int(), decimalLength17(), div10(). */
#include "../vendor/ryu/d2s.c"

/* ECMA ToUint32, shared by bitwise operators and split's limit: non-finite
 * values become zero, finite values truncate toward zero and wrap mod 2^32. */
uint32_t scr_to_uint32(double d) {
  return scr_numeric_to_u32(d);
}

/* ── bitwise operators ─────────────────────────────────────────────────
 * JS-exact (scr_runtime.h has the contract). ToUint32 is the primitive —
 * ToInt32 and the Int32-typed results are the same 32 bits reinterpreted
 * as two's complement, spelled portably (no implementation-defined
 * narrowing casts, no UB shifts of signed values).
 */

/* The 32 bits as a SIGNED (Int32) JS number. */
static double scr_bits_as_int32(uint32_t u) {
  return u >= UINT32_C(0x80000000)
             ? (double)(int32_t)(u - UINT32_C(0x80000000)) + (double)INT32_MIN
             : (double)u;
}

double scr_bit_and(double a, double b) {
  return scr_bits_as_int32(scr_to_uint32(a) & scr_to_uint32(b));
}

double scr_bit_or(double a, double b) {
  return scr_bits_as_int32(scr_to_uint32(a) | scr_to_uint32(b));
}

double scr_bit_xor(double a, double b) {
  return scr_bits_as_int32(scr_to_uint32(a) ^ scr_to_uint32(b));
}

double scr_bit_shl(double a, double b) {
  return scr_bits_as_int32(scr_to_uint32(a) << (scr_to_uint32(b) & 31u));
}

double scr_bit_shr(double a, double b) {
  uint32_t u = scr_to_uint32(a);
  uint32_t s = scr_to_uint32(b) & 31u;
  uint32_t r = u >> s;
  if ((u & UINT32_C(0x80000000)) != 0 && s != 0) {
    r |= ~(UINT32_C(0xffffffff) >> s); /* arithmetic shift: sign-fill */
  }
  return scr_bits_as_int32(r);
}

double scr_bit_ushr(double a, double b) {
  /* The one Uint32-typed result: (-1 >>> 0) === 4294967295. */
  return (double)(scr_to_uint32(a) >> (scr_to_uint32(b) & 31u));
}

double scr_bit_not(double a) {
  return scr_bits_as_int32(~scr_to_uint32(a));
}

/* SameValue on doubles is shared by Object.is and checked-value property
 * descriptors. Keep it in the numeric core so JSON values do not require
 * the optional standard-library module just to compare two numbers. */
bool scr_num_same_value(double a, double b) {
  if (a != a) return b != b;
  if (a == 0 && b == 0) return signbit(a) == signbit(b);
  return a == b;
}

/* The Ryū digit core, shared by the ECMA placement below and the Intl
 * en-US number formatter (scr_lib.c): the shortest round-tripping digit
 * string for a positive finite double — value = 0.digits × 10^n with no
 * trailing zeros. Returns k (the digit count, ≤ 17); digits is
 * NUL-terminated. Mirrors d2s_buffered_n's dispatch: the exact
 * small-integer fast path first (trailing decimal zeros folded into the
 * exponent), the full algorithm otherwise. */
int scr_f64_digits(double x, char digits[18], int *n_out) {
  uint64_t bits;
  memcpy(&bits, &x, sizeof bits);
  const uint64_t ieeeMantissa = bits & ((1ull << DOUBLE_MANTISSA_BITS) - 1);
  const uint32_t ieeeExponent =
      (uint32_t)(bits >> DOUBLE_MANTISSA_BITS); /* sign must be stripped */
  floating_decimal_64 v;
  if (d2d_small_int(ieeeMantissa, ieeeExponent, &v)) {
    for (;;) {
      const uint64_t q = div10(v.mantissa);
      const uint32_t r = ((uint32_t)v.mantissa) - 10 * ((uint32_t)q);
      if (r != 0) break;
      v.mantissa = q;
      ++v.exponent;
    }
  } else {
    v = d2d(ieeeMantissa, ieeeExponent);
  }

  /* Ryū's (mantissa, exponent) → ECMA's (digits, k, n): the k mantissa
   * digits have no trailing zeros, and value = 0.digits * 10^n. */
  int k = (int)decimalLength17(v.mantissa);
  *n_out = v.exponent + k;
  digits[k] = '\0';
  uint64_t m = v.mantissa;
  for (int i = k - 1; i >= 0; i--) {
    const uint64_t q = div10(m);
    digits[i] = (char)('0' + (uint32_t)m - 10 * (uint32_t)q);
    m = q;
  }
  return k;
}

size_t scr_f64_to_str(double x, char *buf) {
  if (isnan(x)) return (size_t)(stpcpy(buf, "NaN") - buf);
  if (x == 0) return (size_t)(stpcpy(buf, "0") - buf); /* covers -0 */
  if (isinf(x)) {
    return (size_t)(stpcpy(buf, x < 0 ? "-Infinity" : "Infinity") - buf);
  }

  char *out = buf;
  if (x < 0) {
    *out++ = '-';
    x = -x;
  }

  /* Every integer through 2^53-1 has an unambiguous exact decimal spelling.
   * Larger doubles keep the shortest-roundtrip algorithm: their rounded
   * integer value can differ from JavaScript's chosen decimal digits. */
  if (x <= 9007199254740991.0) {
    uint64_t integer = (uint64_t)x;
    if ((double)integer == x) {
      static const char pairs[] =
          "00010203040506070809" "10111213141516171819"
          "20212223242526272829" "30313233343536373839"
          "40414243444546474849" "50515253545556575859"
          "60616263646566676869" "70717273747576777879"
          "80818283848586878889" "90919293949596979899";
      char digits[16];
      char *begin = digits + sizeof digits;
      while (integer >= 100) {
        uint64_t quotient = integer / 100;
        unsigned remainder = (unsigned)(integer - quotient * 100);
        begin -= 2;
        memcpy(begin, pairs + remainder * 2, 2);
        integer = quotient;
      }
      if (integer < 10) *--begin = (char)('0' + integer);
      else {
        begin -= 2;
        memcpy(begin, pairs + integer * 2, 2);
      }
      size_t count = (size_t)(digits + sizeof digits - begin);
      memcpy(out, begin, count);
      out += count;
      *out = '\0';
      return (size_t)(out - buf);
    }
  }

  char digits[18];
  int n;
  int k = scr_f64_digits(x, digits, &n);

  if (k <= n && n <= 21) {
    /* Integer: digits followed by n-k zeros. */
    memcpy(out, digits, (size_t)k);
    out += k;
    for (int i = 0; i < n - k; i++) *out++ = '0';
  } else if (0 < n && n <= 21) {
    /* ddd.ddd */
    memcpy(out, digits, (size_t)n);
    out += n;
    *out++ = '.';
    memcpy(out, digits + n, (size_t)(k - n));
    out += k - n;
  } else if (-6 < n && n <= 0) {
    /* 0.000ddd */
    *out++ = '0';
    *out++ = '.';
    for (int i = 0; i < -n; i++) *out++ = '0';
    memcpy(out, digits, (size_t)k);
    out += k;
  } else {
    /* d.ddde±e — exponent is n-1, printed without leading zeros. */
    *out++ = digits[0];
    if (k > 1) {
      *out++ = '.';
      memcpy(out, digits + 1, (size_t)(k - 1));
      out += k - 1;
    }
    *out++ = 'e';
    int e = n - 1;
    *out++ = e < 0 ? '-' : '+';
    if (e < 0) e = -e;
    char etmp[8];
    int elen = 0;
    do {
      etmp[elen++] = (char)('0' + e % 10);
      e /= 10;
    } while (e > 0);
    while (elen > 0) *out++ = etmp[--elen];
  }
  *out = '\0';
  return (size_t)(out - buf);
}
