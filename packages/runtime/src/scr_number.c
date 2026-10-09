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

/* Two-digit decimal spellings 00..99, for integer rendering. */
static const char pairs[] =
    "00010203040506070809" "10111213141516171819"
    "20212223242526272829" "30313233343536373839"
    "40414243444546474849" "50515253545556575859"
    "60616263646566676869" "70717273747576777879"
    "80818283848586878889" "90919293949596979899";

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

  /* Money-like values: x is the double nearest to m/100 for an integer m.
   * Then the decimal m/100 round-trips to x, and below 2^46 (ulp(x) <=
   * 2^-7 < 0.01) it is also the unique shortest spelling: every decimal
   * with fewer significant digits lies on the 0.1 grid, at least 0.01 away
   * from m/100 when m % 10 != 0, so it cannot share x's rounding interval
   * (width <= ulp(x)); two-digit candidates are 0.01 apart for the same
   * reason. m/100 is never a rounding midpoint (a dyadic m/100 is k/4,
   * exactly representable here), so tie rules do not matter. x >= 0.01
   * keeps it in fixed notation. The division is the proof: it is
   * correctly rounded, so equality means x IS the nearest double to m/100. */
  if (x < 70368744177664.0 /* 2^46 */) {
    uint64_t m = (uint64_t)(x * 100.0 + 0.5);
    if (m != 0 && (double)m / 100.0 == x) {
      uint64_t integer = m / 100;
      unsigned cents = (unsigned)(m - integer * 100);
      /* cents != 0: integral x took the exact-integer path above. */
      char digits[16];
      char *begin = digits + sizeof digits;
      do {
        uint64_t quotient = integer / 10;
        *--begin = (char)('0' + (unsigned)(integer - quotient * 10));
        integer = quotient;
      } while (integer != 0);
      size_t count = (size_t)(digits + sizeof digits - begin);
      memcpy(out, begin, count);
      out += count;
      *out++ = '.';
      *out++ = (char)('0' + cents / 10);
      if (cents % 10 != 0) *out++ = (char)('0' + cents % 10);
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

/* ── decimal string → double fast path ────────────────────────────────
 * scr_decimal_scan validates the WHOLE span p[0..n) as a decimal literal
 *   [+-]? (digits [. digits*] | . digits) ([eE][+-]? digits)?
 * (no Infinity, no whitespace) and returns -1 when it is not one, 1 with
 * *out set when Clinger's fast path applies, and 0 when the span is valid
 * but needs a correctly rounded strtod. Validation and accumulation share
 * one pass. When the significant digits form an integer m <= 2^53 and the
 * decimal exponent e satisfies |e| <= 22, m and 10^|e| are both exact
 * doubles, so one IEEE multiply or divide rounds the exact value m × 10^e
 * once: bit-identical to a correctly rounded strtod. Exponents a little
 * above 22 fold the excess into m while it stays exact. Zero mantissas are
 * ±0 whatever the exponent. Anything else answers 0: more than 19
 * significant digits, m > 2^53, or a large exponent. Assumes binary64
 * arithmetic without excess precision (FLT_EVAL_METHOD 0), as on every
 * scriptc target. */
static const double scr_pow10_exact[23] = {
    1e0,  1e1,  1e2,  1e3,  1e4,  1e5,  1e6,  1e7,  1e8,  1e9,  1e10, 1e11,
    1e12, 1e13, 1e14, 1e15, 1e16, 1e17, 1e18, 1e19, 1e20, 1e21, 1e22};

int scr_decimal_scan(const char *p, size_t n, double *out) {
  size_t i = 0;
  bool neg = false;
  if (i < n && (p[i] == '+' || p[i] == '-')) {
    neg = p[i] == '-';
    i++;
  }
  uint64_t m = 0;
  int nd = 0;        /* significant digits in m (leading zeros excluded) */
  int e10 = 0;       /* decimal exponent: fraction shift + explicit exponent */
  bool exact = true; /* false once a digit no longer fits m */
  size_t digits = 0; /* integer + fraction digits, zeros included */
  for (; i < n; i++) {
    unsigned d = (unsigned)(unsigned char)p[i] - '0';
    if (d > 9) break;
    digits++;
    if (m == 0 && d == 0) continue; /* leading integer zeros */
    if (nd == 19) {
      exact = false;
      continue;
    }
    m = m * 10 + d;
    nd++;
  }
  if (i < n && p[i] == '.') {
    for (i++; i < n; i++) {
      unsigned d = (unsigned)(unsigned char)p[i] - '0';
      if (d > 9) break;
      digits++;
      if (m == 0 && d == 0) { /* leading fraction zeros */
        e10--;
        continue;
      }
      if (nd == 19) {
        exact = false;
        continue;
      }
      m = m * 10 + d;
      nd++;
      e10--;
    }
  }
  if (digits == 0) return -1; /* ".", "+", "e5" */
  if (i < n && (p[i] == 'e' || p[i] == 'E')) {
    i++;
    bool eneg = false;
    if (i < n && (p[i] == '+' || p[i] == '-')) {
      eneg = p[i] == '-';
      i++;
    }
    size_t ed = i;
    int ev = 0;
    for (; i < n && p[i] >= '0' && p[i] <= '9'; i++) {
      if (ev < 100000) ev = ev * 10 + (p[i] - '0');
    }
    if (i == ed) return -1; /* "1e", "1e+": the exponent needs digits */
    e10 += eneg ? -ev : ev;
  }
  if (i != n) return -1; /* trailing garbage ("1_000", "1.2.3", "12px") */
  if (!exact) return 0;
  if (m == 0) {
    *out = neg ? -0.0 : 0.0;
    return 1;
  }
  if (m > (UINT64_C(1) << 53)) return 0;
  double v = (double)m; /* exact */
  if (e10 < 0) {
    if (e10 < -22) return 0;
    v /= scr_pow10_exact[-e10];
  } else if (e10 <= 22) {
    v *= scr_pow10_exact[e10];
  } else {
    /* m × 10^(e10-22) may still be an exact integer below 2^53. */
    if (e10 > 22 + 15) return 0;
    for (int k = e10 - 22; k > 0; k--) {
      if (m > (UINT64_C(1) << 53) / 10) return 0;
      m *= 10;
    }
    v = (double)m * 1e22;
  }
  *out = neg ? -v : v;
  return 1;
}

bool scr_decimal_fast(const char *p, size_t n, double *out) {
  return scr_decimal_scan(p, n, out) > 0;
}

/* ── Number.prototype.toFixed digits ──────────────────────────────────
 * toFixed(f) needs the exact binary value, not the shortest decimal that
 * round-trips to it: (1.005).toFixed(2) is "1.00". With abs(x) =
 * mantissa × 2^binary_exponent, the spec's n (the integer closest to
 * abs(x) × 10^f, ties toward the larger n) is
 *
 *     round_half_up(mantissa × 5^f × 2^(binary_exponent + f)).
 *
 * Fast path: f <= 22 keeps 5^f below 2^52, so mantissa × 5^f fits in 105
 * bits (a 64×64→128 multiply); a right shift with the dropped-half bit as
 * the round-up decision gives n exactly, and n < 2^64 renders without a
 * bignum. Everything else (f > 22, n >= 2^64, left shifts past 64 bits)
 * takes a tiny base-2^32 bignum: the largest value handled is below 1e21
 * with f = 100, so n < 1e121 (402 bits) fits sixteen limbs. */
static inline uint64_t scr_mul_u64(uint64_t a, uint64_t b, uint64_t *hi) {
#if defined(HAS_UINT128)
  uint128_t p = (uint128_t)a * b;
  *hi = (uint64_t)(p >> 64);
  return (uint64_t)p;
#else
  return umul128(a, b, hi);
#endif
}

/* n for f <= 22 when it fits 64 bits; false otherwise. */
static bool scr_fixed_fast(uint64_t mantissa, int binary_exp, int f, uint64_t *n_out) {
  static const uint64_t pow5[23] = {
      UINT64_C(1),
      UINT64_C(5),
      UINT64_C(25),
      UINT64_C(125),
      UINT64_C(625),
      UINT64_C(3125),
      UINT64_C(15625),
      UINT64_C(78125),
      UINT64_C(390625),
      UINT64_C(1953125),
      UINT64_C(9765625),
      UINT64_C(48828125),
      UINT64_C(244140625),
      UINT64_C(1220703125),
      UINT64_C(6103515625),
      UINT64_C(30517578125),
      UINT64_C(152587890625),
      UINT64_C(762939453125),
      UINT64_C(3814697265625),
      UINT64_C(19073486328125),
      UINT64_C(95367431640625),
      UINT64_C(476837158203125),
      UINT64_C(2384185791015625),
  };
  if (f > 22) return false;
  uint64_t hi;
  uint64_t lo = scr_mul_u64(mantissa, pow5[f], &hi); /* < 2^105 */
  int shift = binary_exp + f;
  if (shift >= 0) {
    if (hi != 0 || shift >= 64 || (shift > 0 && (lo >> (64 - shift)) != 0)) return false;
    *n_out = lo << shift;
    return true;
  }
  int right = -shift;
  if (right > 106) { /* the product is < 2^105: value < 1/2, n = 0 */
    *n_out = 0;
    return true;
  }
  /* round = bit (right-1); q = (hi:lo) >> right. */
  int rb = right - 1;
  uint64_t round = rb >= 64 ? (hi >> (rb - 64)) & 1 : (lo >> rb) & 1;
  uint64_t q;
  if (right >= 64) {
    q = right == 64 ? hi : hi >> (right - 64);
  } else {
    if ((hi >> right) != 0) return false; /* q needs more than 64 bits */
    q = (lo >> right) | (hi << (64 - right));
  }
  if (round && q == UINT64_MAX) return false;
  *n_out = q + round;
  return true;
}

#define SCR_FIXED_LIMBS 16
typedef struct {
  uint32_t limb[SCR_FIXED_LIMBS]; /* little-endian */
  int len;
} ScrFixedInt;

static void scr_fixed_normalize(ScrFixedInt *v) {
  while (v->len > 1 && v->limb[v->len - 1] == 0) v->len--;
}

static void scr_fixed_mul5(ScrFixedInt *v) {
  uint64_t carry = 0;
  for (int i = 0; i < v->len; i++) {
    uint64_t p = (uint64_t)v->limb[i] * 5 + carry;
    v->limb[i] = (uint32_t)p;
    carry = p >> 32;
  }
  if (carry != 0) v->limb[v->len++] = (uint32_t)carry;
}

static bool scr_fixed_bit(const ScrFixedInt *v, int bit) {
  int word = bit / 32;
  return word < v->len && ((v->limb[word] >> (bit % 32)) & 1u) != 0;
}

static void scr_fixed_shr(ScrFixedInt *v, int bits) {
  int words = bits / 32;
  int rem = bits % 32;
  if (words >= v->len) {
    v->limb[0] = 0;
    v->len = 1;
    return;
  }
  int n = v->len - words;
  for (int i = 0; i < n; i++) {
    uint32_t lo = v->limb[i + words] >> rem;
    uint32_t hi =
        rem != 0 && i + words + 1 < v->len
            ? v->limb[i + words + 1] << (32 - rem)
            : 0;
    v->limb[i] = lo | hi;
  }
  v->len = n;
  scr_fixed_normalize(v);
}

static void scr_fixed_shl(ScrFixedInt *v, int bits) {
  uint32_t out[SCR_FIXED_LIMBS] = {0};
  int words = bits / 32;
  int rem = bits % 32;
  for (int i = 0; i < v->len; i++) {
    int at = i + words;
    out[at] |= v->limb[i] << rem;
    if (rem != 0) out[at + 1] |= v->limb[i] >> (32 - rem);
  }
  int n = v->len + words + (rem != 0 ? 1 : 0);
  memcpy(v->limb, out, sizeof out);
  v->len = n;
  scr_fixed_normalize(v);
}

static void scr_fixed_inc(ScrFixedInt *v) {
  uint64_t carry = 1;
  for (int i = 0; i < v->len && carry != 0; i++) {
    uint64_t s = (uint64_t)v->limb[i] + carry;
    v->limb[i] = (uint32_t)s;
    carry = s >> 32;
  }
  if (carry != 0) v->limb[v->len++] = (uint32_t)carry;
}

/* Divide in place by 1e9; each quotient limb still fits uint32_t because
 * the carried remainder is below the divisor. Returns the remainder. */
static uint32_t scr_fixed_div1e9(ScrFixedInt *v) {
  uint64_t rem = 0;
  for (int i = v->len - 1; i >= 0; i--) {
    uint64_t cur = (rem << 32) | v->limb[i];
    v->limb[i] = (uint32_t)(cur / 1000000000u);
    rem = cur % 1000000000u;
  }
  scr_fixed_normalize(v);
  return (uint32_t)rem;
}

/* Writes the decimal digits of n (no leading zeros; "0" for zero) ending
 * just before `end`; returns the first digit. */
static char *scr_u64_digits_back(uint64_t n, char *end) {
  char *p = end;
  while (n >= 100) {
    uint64_t q = n / 100;
    p -= 2;
    memcpy(p, pairs + (n - q * 100) * 2, 2);
    n = q;
  }
  if (n >= 10) {
    p -= 2;
    memcpy(p, pairs + n * 2, 2);
  } else {
    *--p = (char)('0' + (unsigned)n);
  }
  return p;
}

size_t scr_f64_to_fixed(double x, int f, char *buf) {
  bool neg = x < 0; /* false for -0, exactly like the spec's sign arm */
  double a = neg ? -x : x;
  uint64_t bits;
  memcpy(&bits, &a, sizeof bits);
  uint64_t mantissa = bits & ((UINT64_C(1) << 52) - 1);
  int ieee_exp = (int)((bits >> 52) & 0x7ffu);
  int binary_exp;
  if (ieee_exp == 0) {
    binary_exp = -1074;
  } else {
    mantissa |= UINT64_C(1) << 52;
    binary_exp = ieee_exp - 1023 - 52;
  }

  /* digits[] holds the decimal expansion of n, right-aligned. */
  char digits[128];
  char *dend = digits + sizeof digits;
  char *dbeg;
  uint64_t n64;
  if (scr_fixed_fast(mantissa, binary_exp, f, &n64)) {
    dbeg = scr_u64_digits_back(n64, dend);
  } else {
    ScrFixedInt n = {{(uint32_t)mantissa, (uint32_t)(mantissa >> 32)}, 2};
    scr_fixed_normalize(&n);
    for (int i = 0; i < f; i++) scr_fixed_mul5(&n);
    int shift = binary_exp + f;
    if (shift >= 0) {
      scr_fixed_shl(&n, shift);
    } else {
      int right = -shift;
      bool round_up = scr_fixed_bit(&n, right - 1);
      scr_fixed_shr(&n, right);
      if (round_up) scr_fixed_inc(&n);
    }
    /* Base-1e9 chunks, least significant first; all but the leading
     * chunk render as exactly nine digits. */
    dbeg = dend;
    for (;;) {
      uint32_t chunk = scr_fixed_div1e9(&n);
      bool last = n.len == 1 && n.limb[0] == 0;
      char *stop = dbeg - 9;
      dbeg = scr_u64_digits_back(chunk, dbeg);
      if (last) break;
      while (dbeg > stop) *--dbeg = '0';
    }
  }
  int dlen = (int)(dend - dbeg);

  /* Place the decimal point f digits from the right, padding through
   * zero ("0.05"), with a leading "-" for negative x (even when n is 0). */
  char *o = buf;
  if (neg) *o++ = '-';
  int padded = dlen > f + 1 ? dlen : f + 1;
  int integer_digits = padded - f;
  int leading_zeros = padded - dlen;
  if (leading_zeros >= integer_digits) {
    /* 0.000ddd: the integer part is a single zero. */
    *o++ = '0';
    if (f != 0) {
      *o++ = '.';
      for (int i = integer_digits; i < leading_zeros; i++) *o++ = '0';
      memcpy(o, dbeg, (size_t)dlen);
      o += dlen;
    }
  } else {
    /* leading_zeros == 0 here: dlen >= f + 1. */
    memcpy(o, dbeg, (size_t)integer_digits);
    o += integer_digits;
    if (f != 0) {
      *o++ = '.';
      memcpy(o, dbeg + integer_digits, (size_t)f);
      o += f;
    }
  }
  *o = '\0';
  return (size_t)(o - buf);
}
