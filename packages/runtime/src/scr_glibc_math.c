/* The libm functions that glibc executables reach without calling a Math
 * transcendental: floor, ceil, trunc and round (LLVM's rounding intrinsics
 * on x86-64 before SSE4.1, and the runtime's own calls), fmod (the %
 * operator), sqrt (Math.sqrt's call for a negative argument), and ldexp,
 * scalbn and frexp, which glibc exports from both libc and libm (the link
 * would otherwise take them from libm). Each is exactly specified, so these
 * definitions answer what glibc's do, the NaN payloads of NaN inputs
 * included. Defining them in the executable lets a program that uses no
 * other libm function link without libm.so (-lm is linked as needed),
 * which saves loading it at startup. Library builds keep the embedder's
 * libm. */

#include <stdint.h>
#include <string.h>

#if defined(__GLIBC__) && !defined(SCR_LIB)

/* The sanitizer runtime calls some of these functions while it initializes,
 * and the dynamic loader calls the resolvers before that: none of the code
 * here carries sanitizer instrumentation. no_sanitize("thread") alone keeps
 * ThreadSanitizer's function entry and exit calls, which crash before its
 * runtime initializes; disable_sanitizer_instrumentation removes them. */
#pragma clang attribute push(__attribute__((no_sanitize("address", "undefined", "thread"), disable_sanitizer_instrumentation)), apply_to = function)

static inline uint64_t sgm_bits(double d) {
  uint64_t bits;
  memcpy(&bits, &d, sizeof bits);
  return bits;
}

static inline double sgm_double(uint64_t bits) {
  double d;
  memcpy(&d, &bits, sizeof d);
  return d;
}

#define SGM_SIGN (UINT64_C(1) << 63)

/* Hidden: the executable's own references bind to these definitions, which
 * are not exported (libc.so and libm.so define the same names), so section
 * GC drops the ones a program does not call. */
#define SGM_DEFINE __attribute__((visibility("hidden")))

/* Values of magnitude below 2^52 round through an integer conversion: the
 * truncated value, stepped by one when the rounding direction needs it, with
 * the value's sign so that a zero result keeps it (ceil(-0.5) is -0). */
static inline int sgm_small(double x) { return __builtin_fabs(x) < 0x1p52; }

/* The unbiased exponent; 1024 for the infinities and NaN. Values with an
 * exponent of 52 or more are integers already. */
static inline int sgm_exponent(uint64_t bits) { return (int)((bits >> 52) & 0x7FF) - 1023; }

static double sgm_floor(double x) {
  if (sgm_small(x)) {
    double t = (double)(int64_t)x;
    return __builtin_copysign(t > x ? t - 1.0 : t, x);
  }
  uint64_t bits = sgm_bits(x);
  int e = sgm_exponent(bits);
  if (e >= 52) return e == 1024 ? x + x : x;
  if (e < 0) {
    if ((bits << 1) == 0) return x;
    return bits & SGM_SIGN ? -1.0 : 0.0;
  }
  uint64_t fraction = (UINT64_C(1) << (52 - e)) - 1;
  if ((bits & fraction) == 0) return x;
  if (bits & SGM_SIGN) bits += fraction;
  return sgm_double(bits & ~fraction);
}

static double sgm_ceil(double x) {
  if (sgm_small(x)) {
    double t = (double)(int64_t)x;
    return __builtin_copysign(t < x ? t + 1.0 : t, x);
  }
  uint64_t bits = sgm_bits(x);
  int e = sgm_exponent(bits);
  if (e >= 52) return e == 1024 ? x + x : x;
  if (e < 0) {
    if ((bits << 1) == 0) return x;
    return bits & SGM_SIGN ? -0.0 : 1.0;
  }
  uint64_t fraction = (UINT64_C(1) << (52 - e)) - 1;
  if ((bits & fraction) == 0) return x;
  if (!(bits & SGM_SIGN)) bits += fraction;
  return sgm_double(bits & ~fraction);
}

static double sgm_trunc(double x) {
  if (sgm_small(x)) return __builtin_copysign((double)(int64_t)x, x);
  uint64_t bits = sgm_bits(x);
  int e = sgm_exponent(bits);
  if (e >= 52) return e == 1024 ? x + x : x;
  if (e < 0) return sgm_double(bits & SGM_SIGN);
  uint64_t fraction = (UINT64_C(1) << (52 - e)) - 1;
  return sgm_double(bits & ~fraction);
}

#if defined(__x86_64__)
#include <cpuid.h>
#include <smmintrin.h>

/* glibc selects SSE4.1's rounding instruction for floor, ceil and trunc when
 * the CPU has it, and so do these: the same results, with no call into the
 * integer path. */
__attribute__((target("sse4.1"))) static double sgm_floor_sse41(double x) {
  return _mm_cvtsd_f64(_mm_floor_sd(_mm_set_sd(x), _mm_set_sd(x)));
}
__attribute__((target("sse4.1"))) static double sgm_ceil_sse41(double x) {
  return _mm_cvtsd_f64(_mm_ceil_sd(_mm_set_sd(x), _mm_set_sd(x)));
}
__attribute__((target("sse4.1"))) static double sgm_trunc_sse41(double x) {
  return _mm_cvtsd_f64(_mm_round_sd(_mm_set_sd(x), _mm_set_sd(x), _MM_FROUND_TO_ZERO | _MM_FROUND_NO_EXC));
}

static int sgm_has_sse41(void) {
  unsigned eax, ebx, ecx, edx;
  return __get_cpuid(1, &eax, &ebx, &ecx, &edx) && (ecx & bit_SSE4_1) != 0;
}

typedef double (*SgmUnary)(double);
static SgmUnary sgm_resolve_floor(void) { return sgm_has_sse41() ? sgm_floor_sse41 : sgm_floor; }
static SgmUnary sgm_resolve_ceil(void) { return sgm_has_sse41() ? sgm_ceil_sse41 : sgm_ceil; }
static SgmUnary sgm_resolve_trunc(void) { return sgm_has_sse41() ? sgm_trunc_sse41 : sgm_trunc; }
SGM_DEFINE double floor(double x) __attribute__((ifunc("sgm_resolve_floor")));
SGM_DEFINE double ceil(double x) __attribute__((ifunc("sgm_resolve_ceil")));
SGM_DEFINE double trunc(double x) __attribute__((ifunc("sgm_resolve_trunc")));
#else
SGM_DEFINE double floor(double x) { return sgm_floor(x); }
SGM_DEFINE double ceil(double x) { return sgm_ceil(x); }
SGM_DEFINE double trunc(double x) { return sgm_trunc(x); }
#endif

/* Math.sqrt is LLVM's sqrt libcall: the square root instruction inline, and
 * a call to sqrt for a negative argument, where libm would set errno. This
 * definition answers that call with the same instruction. */
SGM_DEFINE double sqrt(double x) {
#if defined(__x86_64__)
  return _mm_cvtsd_f64(_mm_sqrt_sd(_mm_set_sd(x), _mm_set_sd(x)));
#elif defined(__aarch64__)
  double r;
  __asm__("fsqrt %d0, %d1" : "=w"(r) : "w"(x));
  return r;
#else
  return __builtin_sqrt(x);
#endif
}

/* Halfway cases round away from zero. */
SGM_DEFINE double round(double x) {
  uint64_t bits = sgm_bits(x);
  int e = sgm_exponent(bits);
  if (e >= 52) return e == 1024 ? x + x : x;
  if (e < 0) {
    uint64_t sign = bits & SGM_SIGN;
    return e == -1 ? sgm_double(sign | sgm_bits(1.0)) : sgm_double(sign);
  }
  uint64_t fraction = (UINT64_C(1) << (52 - e)) - 1;
  if ((bits & fraction) == 0) return x;
  bits += UINT64_C(1) << (51 - e);
  return sgm_double(bits & ~fraction);
}

/* The significand of a finite nonzero double as an integer below 2^53, and
 * its exponent so that the value's magnitude is significand * 2^exponent. */
static inline uint64_t sgm_significand(uint64_t bits, int *exponent) {
  int biased = (int)((bits >> 52) & 0x7FF);
  uint64_t significand = bits & ((UINT64_C(1) << 52) - 1);
  if (biased == 0) {
    *exponent = -1074;
    return significand;
  }
  *exponent = biased - 1075;
  return significand | (UINT64_C(1) << 52);
}

/* x - n*y for the integer n = trunc(x/y), which is exact: the remainder
 * comes from shift-and-subtract over the significands. NaN, an infinite x
 * and a zero y answer (x*y)/(x*y), as glibc's fmod does. */
SGM_DEFINE double fmod(double x, double y) {
  uint64_t xb = sgm_bits(x), yb = sgm_bits(y);
  uint64_t xmag = xb & ~SGM_SIGN, ymag = yb & ~SGM_SIGN;
  uint64_t infinity = UINT64_C(0x7FF0000000000000);
  if (ymag == 0 || xmag >= infinity || ymag > infinity) return (x * y) / (x * y);
  if (xmag < ymag) return x;
  if (xmag == ymag) return 0.0 * x;
  int ex, ey;
  uint64_t mx = sgm_significand(xb, &ex);
  uint64_t my = sgm_significand(yb, &ey);
  /* Normalize both to 53 significant bits, so the loop below shifts one
   * exponent step at a time. */
  while (mx < (UINT64_C(1) << 52)) {
    mx <<= 1;
    ex--;
  }
  while (my < (UINT64_C(1) << 52)) {
    my <<= 1;
    ey--;
  }
  for (; ex > ey; ex--) {
    if (mx >= my) mx -= my;
    if (mx == 0) return 0.0 * x;
    mx <<= 1;
  }
  if (mx >= my) mx -= my;
  if (mx == 0) return 0.0 * x;
  /* The remainder is mx * 2^ey, below y: rebuild it as a double. */
  while (mx < (UINT64_C(1) << 52)) {
    mx <<= 1;
    ey--;
  }
  uint64_t result;
  if (ey + 1075 >= 1) {
    result = ((uint64_t)(ey + 1075) << 52) | (mx & ((UINT64_C(1) << 52) - 1));
  } else {
    result = mx >> (1 - (ey + 1075));
  }
  return sgm_double(result | (xb & SGM_SIGN));
}

/* x * 2^n, rounded once. Exponents beyond one double's range scale in
 * steps; the step toward the subnormals stays 53 bits above the smallest
 * normal so that only the last multiplication rounds. */
SGM_DEFINE double scalbn(double x, int n) {
  if (n > 1023) {
    x *= 0x1p1023;
    n -= 1023;
    if (n > 1023) {
      x *= 0x1p1023;
      n -= 1023;
      if (n > 1023) n = 1023;
    }
  } else if (n < -1022) {
    x *= 0x1p-1022 * 0x1p53;
    n += 1022 - 53;
    if (n < -1022) {
      x *= 0x1p-1022 * 0x1p53;
      n += 1022 - 53;
      if (n < -1022) n = -1022;
    }
  }
  return x * sgm_double((uint64_t)(0x3FF + n) << 52);
}

SGM_DEFINE double ldexp(double x, int n) { return scalbn(x, n); }

/* The significand in [0.5, 1) and the power of two: x = significand * 2^e.
 * Zero, the infinities and NaN answer themselves with e = 0. */
SGM_DEFINE double frexp(double x, int *e) {
  uint64_t bits = sgm_bits(x);
  int biased = (int)((bits >> 52) & 0x7FF);
  if (biased == 0) {
    if ((bits << 1) == 0) {
      *e = 0;
      return x;
    }
    x = frexp(x * 0x1p64, e);
    *e -= 64;
    return x;
  }
  if (biased == 0x7FF) {
    *e = 0;
    return x;
  }
  *e = biased - 1022;
  return sgm_double((bits & ~(UINT64_C(0x7FF) << 52)) | (UINT64_C(0x3FE) << 52));
}

#pragma clang attribute pop

#endif
