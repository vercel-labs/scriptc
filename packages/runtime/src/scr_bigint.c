/* Engine-free ECMAScript bigint values: arbitrary-precision signed
 * integers over little-endian limbs (64-bit limbs on 64-bit targets,
 * 32-bit limbs on 32-bit targets). Values are immutable once returned, so
 * an operation may return an operand instead of copying it. This unit is
 * linked only when typed IR contains bigint values. */
#include "scr_runtime.h"

#include <math.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#if UINTPTR_MAX > 0xffffffffu
typedef uint64_t bi_limb;
typedef unsigned __int128 bi_wide;
#define BI_LIMB_BITS 64
#else
typedef uint32_t bi_limb;
typedef uint64_t bi_wide;
#define BI_LIMB_BITS 32
#endif
#define BI_LIMB_MAX ((bi_limb)-1)

/* The compiler emits bigint literals as immortal statics with this layout
 * ({ size_t rc = SIZE_MAX, size_t len, i32 sign, u32 cap, limbs }, limbs
 * as wide as size_t, at least one) and reads len, sign and limb 0 of
 * 64-bit values inline, so keep the two in step. */
struct ScrBigInt {
  size_t rc;
  size_t len;   /* limbs in use; the top limb is nonzero */
  int32_t sign; /* -1, 0, +1; zero always has len == 0 */
  uint32_t cap; /* limbs allocated */
  bi_limb limb[];
};

_Static_assert(sizeof(bi_limb) == sizeof(size_t), "bigint limbs are pointer-sized");
_Static_assert(offsetof(ScrBigInt, limb) == 2 * sizeof(size_t) + 8, "bigint header layout");
_Static_assert(sizeof(ScrBigInt) % sizeof(bi_limb) == 0, "limbs follow the header directly");

/* Node 24's V8 accepts widths above this when the input already fits, but
 * refuses any operation that would materialize a wider BigInt. Like V8,
 * arithmetic checks its result length in limbs before computing it. */
#define BI_MAX_BITS ((size_t)1 << 30)
#define BI_MAX_LIMBS (BI_MAX_BITS / BI_LIMB_BITS)

/* Karatsuba pays off from this many limbs in the shorter operand (later
 * for squares, whose schoolbook loop is about twice as fast). */
#define BI_KARATSUBA_LIMBS (BI_LIMB_BITS == 64 ? 32 : 64)
#define BI_KARATSUBA_SQR_LIMBS (BI_LIMB_BITS == 64 ? 48 : 96)
/* Radix conversion splits values from this many limbs into halves. */
#define BI_DC_STRING_LIMBS (BI_LIMB_BITS == 64 ? 60 : 120)

static void bi_oom(void) { scr_trap("scriptc: out of memory\n"); }

static bool bi_max_size_exceeded(void) {
  static const char msg[] = "Maximum BigInt size exceeded";
  scr_throw_error_msg(SCR_ERR_RANGE, msg, sizeof msg - 1);
  return false;
}

/* The one zero value: immortal, so returning it never allocates. Like
 * every value it has a readable first limb (zero), so compiled code may
 * load limb 0 before looking at len. */
static bi_limb bi_zero_words[sizeof(ScrBigInt) / sizeof(bi_limb) + 1] = {SIZE_MAX};

static ScrBigInt *bi_zero(void) { return (ScrBigInt *)(void *)bi_zero_words; }

static void *bi_malloc(size_t n) {
  void *p = malloc(n ? n : 1);
  if (!p) bi_oom();
  return p;
}

static bi_limb *bi_limbs(size_t n) {
  if (n > SIZE_MAX / sizeof(bi_limb)) bi_oom();
  return bi_malloc(n * sizeof(bi_limb));
}

/* A mutable value with room for cap limbs. The caller writes the limbs
 * and either sets len/sign itself or finishes with bi_finish. */
static ScrBigInt *bi_alloc(size_t cap) {
  if (cap == 0) cap = 1;
  if (cap > UINT32_MAX || cap > (SIZE_MAX - sizeof(ScrBigInt)) / sizeof(bi_limb)) bi_oom();
  /* The runtime's small-block allocator: most values are a few limbs. */
  ScrBigInt *v = scr_mem_alloc(sizeof(ScrBigInt) + cap * sizeof(bi_limb));
  if (!v) bi_oom();
  v->rc = 1;
  v->len = 0;
  v->sign = 0;
  v->cap = (uint32_t)cap;
  return v;
}

/* Trim leading zero limbs from the first len limbs and set the sign; a
 * zero result becomes the shared zero. */
static ScrBigInt *bi_finish(ScrBigInt *v, size_t len, int sign) {
  while (len && v->limb[len - 1] == 0) len--;
  if (!len) {
    scr_mem_free(v);
    return bi_zero();
  }
  v->len = len;
  v->sign = sign;
  return v;
}

static ScrBigInt *bi_from_limbs(const bi_limb *limbs, size_t len, int sign) {
  while (len && limbs[len - 1] == 0) len--;
  if (!len) return bi_zero();
  ScrBigInt *v = bi_alloc(len);
  memcpy(v->limb, limbs, len * sizeof(bi_limb));
  v->len = len;
  v->sign = sign;
  return v;
}

static ScrBigInt *bi_u64_signed(uint64_t n, int sign) {
  if (!n) return bi_zero();
#if BI_LIMB_BITS == 64
  ScrBigInt *v = bi_alloc(1);
  v->limb[0] = n;
  v->len = 1;
#else
  ScrBigInt *v = bi_alloc(2);
  v->limb[0] = (bi_limb)n;
  v->limb[1] = (bi_limb)(n >> 32);
  v->len = v->limb[1] ? 2 : 1;
#endif
  v->sign = sign;
  return v;
}

static ScrBigInt *bi_u64(uint64_t n) { return bi_u64_signed(n, 1); }

/* Low 64 bits of the magnitude. */
static uint64_t bi_mag_u64(const ScrBigInt *v) {
  if (!v->len) return 0;
#if BI_LIMB_BITS == 64
  return v->limb[0];
#else
  return v->len > 1 ? ((uint64_t)v->limb[1] << 32) | v->limb[0] : v->limb[0];
#endif
}

/* Whether the magnitude fits in 64 bits. */
static bool bi_mag_fits_u64(const ScrBigInt *v) { return v->len <= 64 / BI_LIMB_BITS; }

ScrBigInt *scr_bigint_from_u64(uint64_t value) { return bi_u64(value); }

ScrBigInt *scr_bigint_from_i64(int64_t value) {
  /* Unsigned negation also handles INT64_MIN without signed overflow. */
  if (value < 0) return bi_u64_signed(UINT64_C(0) - (uint64_t)value, -1);
  return bi_u64((uint64_t)value);
}

ScrBigInt *scr_bigint_from_pointer(void *value) { return bi_u64((uintptr_t)value); }

uint64_t scr_bigint_to_u64(const ScrBigInt *value) {
  if (!value) return 0; /* callback throw paths return the ABI's zero value */
  uint64_t bits = bi_mag_u64(value);
  return value->sign < 0 ? UINT64_C(0) - bits : bits;
}

int64_t scr_bigint_to_i64(const ScrBigInt *value) {
  uint64_t bits = scr_bigint_to_u64(value);
  return bits <= INT64_MAX ? (int64_t)bits : -1 - (int64_t)(UINT64_MAX - bits);
}

bool scr_bigint_pointer_fits(const ScrBigInt *value) {
  return !value || (value->sign >= 0 && bi_mag_fits_u64(value) && bi_mag_u64(value) <= UINTPTR_MAX);
}

bool scr_bigint_u64_fits(const ScrBigInt *value) {
  return !value || (value->sign >= 0 && bi_mag_fits_u64(value));
}

bool scr_bigint_i64_fits(const ScrBigInt *value) {
  if (!value) return true;
  if (!bi_mag_fits_u64(value)) return false;
  uint64_t mag = bi_mag_u64(value);
  return value->sign < 0 ? mag <= (UINT64_C(1) << 63) : mag <= INT64_MAX;
}

void *scr_bigint_to_pointer(const ScrBigInt *value) { return (void *)(uintptr_t)scr_bigint_to_u64(value); }

ScrBigInt *scr_bigint_retain(ScrBigInt *v) {
  if (v && v->rc != SIZE_MAX) v->rc++;
  return v;
}

void scr_bigint_release(ScrBigInt *v) {
  if (v && v->rc != SIZE_MAX && --v->rc == 0) scr_mem_free(v);
}

void *scr_bigint_retain_v(void *v) { return scr_bigint_retain(v); }
void scr_bigint_release_v(void *v) { scr_bigint_release(v); }

/* ---- limb-array primitives ------------------------------------------- */

static unsigned bi_clz(bi_limb x) {
#if BI_LIMB_BITS == 64
  return (unsigned)__builtin_clzll(x);
#else
  return (unsigned)__builtin_clz(x);
#endif
}

static int bi_cmp_limbs(const bi_limb *a, size_t an, const bi_limb *b, size_t bn) {
  if (an != bn) return an < bn ? -1 : 1;
  for (size_t i = an; i-- > 0;) {
    if (a[i] != b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

/* x + y + carry_in (0 or 1), with the carry out in *carry: the add-with-
 * carry builtins compile to one adc chain. */
#if defined(__has_builtin)
#if __has_builtin(__builtin_addcll) && __has_builtin(__builtin_subcll) && \
    __has_builtin(__builtin_addc) && __has_builtin(__builtin_subc)
#define BI_HAVE_ADDC 1
#endif
#endif
static inline bi_limb bi_addc(bi_limb x, bi_limb y, bi_limb *carry) {
#if defined(BI_HAVE_ADDC) && BI_LIMB_BITS == 64
  unsigned long long c;
  bi_limb s = __builtin_addcll(x, y, *carry, &c);
  *carry = c;
  return s;
#elif defined(BI_HAVE_ADDC)
  unsigned c;
  bi_limb s = __builtin_addc(x, y, *carry, &c);
  *carry = c;
  return s;
#else
  bi_limb s = x + y;
  bi_limb c1 = s < x;
  bi_limb t = s + *carry;
  *carry = c1 | (t < s);
  return t;
#endif
}

/* x - y - borrow_in (0 or 1), with the borrow out in *borrow. */
static inline bi_limb bi_subc(bi_limb x, bi_limb y, bi_limb *borrow) {
#if defined(BI_HAVE_ADDC) && BI_LIMB_BITS == 64
  unsigned long long b;
  bi_limb d = __builtin_subcll(x, y, *borrow, &b);
  *borrow = b;
  return d;
#elif defined(BI_HAVE_ADDC)
  unsigned b;
  bi_limb d = __builtin_subc(x, y, *borrow, &b);
  *borrow = b;
  return d;
#else
  bi_limb d = x - y;
  bi_limb b1 = x < y;
  bi_limb t = d - *borrow;
  *borrow = b1 | (d < *borrow);
  return t;
#endif
}

/* r = a + b over n limbs; returns the carry. r may alias a or b. Four
 * limbs a pass keep the carry in one chain. */
static bi_limb bi_add_n(bi_limb *r, const bi_limb *a, const bi_limb *b, size_t n) {
  bi_limb carry = 0;
  size_t i = 0;
  for (; i + 8 <= n; i += 8) {
    r[i] = bi_addc(a[i], b[i], &carry);
    r[i + 1] = bi_addc(a[i + 1], b[i + 1], &carry);
    r[i + 2] = bi_addc(a[i + 2], b[i + 2], &carry);
    r[i + 3] = bi_addc(a[i + 3], b[i + 3], &carry);
    r[i + 4] = bi_addc(a[i + 4], b[i + 4], &carry);
    r[i + 5] = bi_addc(a[i + 5], b[i + 5], &carry);
    r[i + 6] = bi_addc(a[i + 6], b[i + 6], &carry);
    r[i + 7] = bi_addc(a[i + 7], b[i + 7], &carry);
  }
  for (; i < n; i++) r[i] = bi_addc(a[i], b[i], &carry);
  return carry;
}

/* r = a - b over n limbs; returns the borrow. r may alias a or b. */
static bi_limb bi_sub_n(bi_limb *r, const bi_limb *a, const bi_limb *b, size_t n) {
  bi_limb borrow = 0;
  size_t i = 0;
  for (; i + 8 <= n; i += 8) {
    r[i] = bi_subc(a[i], b[i], &borrow);
    r[i + 1] = bi_subc(a[i + 1], b[i + 1], &borrow);
    r[i + 2] = bi_subc(a[i + 2], b[i + 2], &borrow);
    r[i + 3] = bi_subc(a[i + 3], b[i + 3], &borrow);
    r[i + 4] = bi_subc(a[i + 4], b[i + 4], &borrow);
    r[i + 5] = bi_subc(a[i + 5], b[i + 5], &borrow);
    r[i + 6] = bi_subc(a[i + 6], b[i + 6], &borrow);
    r[i + 7] = bi_subc(a[i + 7], b[i + 7], &borrow);
  }
  for (; i < n; i++) r[i] = bi_subc(a[i], b[i], &borrow);
  return borrow;
}

/* r[0..an) = a + b with an >= bn; returns the carry. */
static bi_limb bi_add_ab(bi_limb *r, const bi_limb *a, size_t an, const bi_limb *b, size_t bn) {
  bi_limb carry = bi_add_n(r, a, b, bn);
  for (size_t i = bn; i < an; i++) {
    bi_limb t = a[i] + carry;
    carry = carry && t == 0;
    r[i] = t;
  }
  return carry;
}

/* r[0..an) = a - b for a >= b as numbers and an >= bn. */
static void bi_sub_ab(bi_limb *r, const bi_limb *a, size_t an, const bi_limb *b, size_t bn) {
  bi_limb borrow = bi_sub_n(r, a, b, bn);
  for (size_t i = bn; i < an; i++) {
    bi_limb x = a[i];
    r[i] = x - borrow;
    borrow = borrow && x == 0;
  }
}

/* r[0..rn) += a[0..an) for rn >= an; returns the carry out. */
static bi_limb bi_add_into(bi_limb *r, size_t rn, const bi_limb *a, size_t an) {
  bi_limb carry = bi_add_n(r, r, a, an);
  for (size_t i = an; carry && i < rn; i++) carry = ++r[i] == 0;
  return carry;
}

/* r[0..rn) -= a[0..an) for rn >= an; returns the borrow out. */
static bi_limb bi_sub_into(bi_limb *r, size_t rn, const bi_limb *a, size_t an) {
  bi_limb borrow = bi_sub_n(r, r, a, an);
  for (size_t i = an; borrow && i < rn; i++) borrow = r[i]-- == 0;
  return borrow;
}

/* r = a * m + carry over n limbs; returns the high limb. r may alias a.
 * Four limbs a pass: the four products, then one carry chain adding each
 * product's high limb into the next low limb. */
static bi_limb bi_mul1(bi_limb *r, const bi_limb *a, size_t n, bi_limb m, bi_limb carry) {
  size_t i = 0;
  for (; i + 4 <= n; i += 4) {
    bi_wide p0 = (bi_wide)a[i] * m, p1 = (bi_wide)a[i + 1] * m;
    bi_wide p2 = (bi_wide)a[i + 2] * m, p3 = (bi_wide)a[i + 3] * m;
    bi_limb c = 0;
    r[i] = bi_addc((bi_limb)p0, carry, &c);
    r[i + 1] = bi_addc((bi_limb)p1, (bi_limb)(p0 >> BI_LIMB_BITS), &c);
    r[i + 2] = bi_addc((bi_limb)p2, (bi_limb)(p1 >> BI_LIMB_BITS), &c);
    r[i + 3] = bi_addc((bi_limb)p3, (bi_limb)(p2 >> BI_LIMB_BITS), &c);
    carry = (bi_limb)(p3 >> BI_LIMB_BITS) + c;
  }
  for (; i < n; i++) {
    bi_wide p = (bi_wide)a[i] * m + carry;
    r[i] = (bi_limb)p;
    carry = (bi_limb)(p >> BI_LIMB_BITS);
  }
  return carry;
}

/* r += a * m over n limbs; returns the high limb. Four limbs a pass: one
 * carry chain forms the four product limbs, a second adds them to r. */
static bi_limb bi_addmul1(bi_limb *r, const bi_limb *a, size_t n, bi_limb m) {
  bi_limb carry = 0;
  size_t i = 0;
  for (; i + 4 <= n; i += 4) {
    bi_wide p0 = (bi_wide)a[i] * m, p1 = (bi_wide)a[i + 1] * m;
    bi_wide p2 = (bi_wide)a[i + 2] * m, p3 = (bi_wide)a[i + 3] * m;
    bi_limb c = 0, k = 0;
    bi_limb t0 = bi_addc((bi_limb)p0, carry, &c);
    bi_limb t1 = bi_addc((bi_limb)p1, (bi_limb)(p0 >> BI_LIMB_BITS), &c);
    bi_limb t2 = bi_addc((bi_limb)p2, (bi_limb)(p1 >> BI_LIMB_BITS), &c);
    bi_limb t3 = bi_addc((bi_limb)p3, (bi_limb)(p2 >> BI_LIMB_BITS), &c);
    r[i] = bi_addc(r[i], t0, &k);
    r[i + 1] = bi_addc(r[i + 1], t1, &k);
    r[i + 2] = bi_addc(r[i + 2], t2, &k);
    r[i + 3] = bi_addc(r[i + 3], t3, &k);
    /* r + a * m over these limbs stays below B^5, so this cannot wrap */
    carry = (bi_limb)(p3 >> BI_LIMB_BITS) + c + k;
  }
  for (; i < n; i++) {
    bi_wide p = (bi_wide)a[i] * m + r[i] + carry;
    r[i] = (bi_limb)p;
    carry = (bi_limb)(p >> BI_LIMB_BITS);
  }
  return carry;
}

/* r -= a * m over n limbs; returns the borrow limb. */
static bi_limb bi_submul1(bi_limb *r, const bi_limb *a, size_t n, bi_limb m) {
  bi_limb carry = 0;
  size_t i = 0;
  for (; i + 4 <= n; i += 4) {
    bi_wide p0 = (bi_wide)a[i] * m, p1 = (bi_wide)a[i + 1] * m;
    bi_wide p2 = (bi_wide)a[i + 2] * m, p3 = (bi_wide)a[i + 3] * m;
    bi_limb c = 0, k = 0;
    bi_limb t0 = bi_addc((bi_limb)p0, carry, &c);
    bi_limb t1 = bi_addc((bi_limb)p1, (bi_limb)(p0 >> BI_LIMB_BITS), &c);
    bi_limb t2 = bi_addc((bi_limb)p2, (bi_limb)(p1 >> BI_LIMB_BITS), &c);
    bi_limb t3 = bi_addc((bi_limb)p3, (bi_limb)(p2 >> BI_LIMB_BITS), &c);
    r[i] = bi_subc(r[i], t0, &k);
    r[i + 1] = bi_subc(r[i + 1], t1, &k);
    r[i + 2] = bi_subc(r[i + 2], t2, &k);
    r[i + 3] = bi_subc(r[i + 3], t3, &k);
    /* a * m + carry over these limbs stays below B^5: the borrow fits */
    carry = (bi_limb)(p3 >> BI_LIMB_BITS) + c + k;
  }
  for (; i < n; i++) {
    bi_wide p = (bi_wide)a[i] * m + carry;
    bi_limb lo = (bi_limb)p;
    carry = (bi_limb)(p >> BI_LIMB_BITS);
    bi_limb x = r[i];
    r[i] = x - lo;
    carry += x < lo;
  }
  return carry;
}

/* y[0..n) = the low n limbs of x << shift, for 0 < shift < BI_LIMB_BITS
 * and y disjoint from x. Each limb is formed from two source limbs with no
 * dependency between limbs, so the loop vectorizes. */
static void bi_lshift(bi_limb *restrict y, const bi_limb *restrict x, size_t n, unsigned shift) {
  unsigned back = BI_LIMB_BITS - shift;
  y[0] = x[0] << shift;
  for (size_t i = 1; i < n; i++) y[i] = (x[i] << shift) | (x[i - 1] >> back);
}

/* y[0..n) = x[0..n) >> shift, for 0 < shift < BI_LIMB_BITS and y disjoint
 * from x; like bi_lshift, each limb reads two source limbs. */
static void bi_rshift(bi_limb *restrict y, const bi_limb *restrict x, size_t n, unsigned shift) {
  unsigned back = BI_LIMB_BITS - shift;
  for (size_t i = 0; i + 1 < n; i++) y[i] = (x[i] >> shift) | (x[i + 1] << back);
  y[n - 1] = x[n - 1] >> shift;
}

/* Schoolbook product: r[0..an+bn) = a * b, r disjoint from a and b. */
static void bi_mul_school(bi_limb *r, const bi_limb *a, size_t an, const bi_limb *b, size_t bn) {
  r[an] = bi_mul1(r, a, an, b[0], 0);
  for (size_t j = 1; j < bn; j++) r[an + j] = bi_addmul1(r + j, a, an, b[j]);
}

/* Schoolbook square: r[0..2n) = a * a. Each off-diagonal product once,
 * doubled, plus the diagonal squares. */
static void bi_sqr_school(bi_limb *r, const bi_limb *a, size_t n) {
  if (n == 1) {
    bi_wide p = (bi_wide)a[0] * a[0];
    r[0] = (bi_limb)p;
    r[1] = (bi_limb)(p >> BI_LIMB_BITS);
    return;
  }
  r[0] = 0;
  r[n] = bi_mul1(r + 1, a + 1, n - 1, a[0], 0);
  for (size_t i = 1; i + 1 < n; i++) r[n + i] = bi_addmul1(r + 2 * i + 1, a + i + 1, n - i - 1, a[i]);
  r[2 * n - 1] = 0;
  bi_limb carry = 0;
  for (size_t i = 0; i < 2 * n; i++) {
    bi_limb x = r[i];
    r[i] = (x << 1) | carry;
    carry = x >> (BI_LIMB_BITS - 1);
  }
  bi_limb c = 0;
  for (size_t i = 0; i < n; i++) {
    bi_wide p = (bi_wide)a[i] * a[i];
    bi_wide lo = (bi_wide)r[2 * i] + (bi_limb)p + c;
    r[2 * i] = (bi_limb)lo;
    bi_wide hi = (bi_wide)r[2 * i + 1] + (bi_limb)(p >> BI_LIMB_BITS) + (bi_limb)(lo >> BI_LIMB_BITS);
    r[2 * i + 1] = (bi_limb)hi;
    c = (bi_limb)(hi >> BI_LIMB_BITS);
  }
}

static void bi_mul_limbs(bi_limb *r, const bi_limb *a, size_t an, const bi_limb *b, size_t bn);

/* Karatsuba for an >= bn > an / 2: split at h = an / 2 so both high
 * halves are nonempty, and fill r[0..an+bn). a == b squares. */
SCR_COLD static void bi_mul_karatsuba(bi_limb *r, const bi_limb *a, size_t an, const bi_limb *b, size_t bn) {
  bool square = a == b && an == bn;
  size_t h = an / 2;
  const bi_limb *a0 = a, *a1 = a + h, *b0 = b, *b1 = b + h;
  size_t a1n = an - h, b1n = bn - h;
  bi_mul_limbs(r, a0, h, b0, h);             /* z0 -> r[0..2h) */
  bi_mul_limbs(r + 2 * h, a1, a1n, b1, b1n); /* z2 -> r[2h..an+bn) */
  size_t san = a1n + 1, sbn = (b1n > h ? b1n : h) + 1, zn = san + sbn;
  bi_limb *sa = bi_limbs(san + (square ? 0 : sbn) + zn);
  bi_limb *sb = square ? sa : sa + san;
  bi_limb *z1 = sa + san + (square ? 0 : sbn);
  sa[a1n] = bi_add_ab(sa, a1, a1n, a0, h);
  if (!square) {
    if (b1n >= h) sb[b1n] = bi_add_ab(sb, b1, b1n, b0, h);
    else sb[h] = bi_add_ab(sb, b0, h, b1, b1n);
  }
  size_t sal = san, sbl = square ? san : sbn;
  while (sal && !sa[sal - 1]) sal--;
  while (sbl && !sb[sbl - 1]) sbl--;
  memset(z1, 0, zn * sizeof(bi_limb));
  if (!sal || !sbl) {
    /* a zero sum: the product stays zero */
  } else if (square) {
    bi_mul_limbs(z1, sa, sal, sa, sal);
  } else if (sal >= sbl) {
    bi_mul_limbs(z1, sa, sal, sb, sbl);
  } else {
    bi_mul_limbs(z1, sb, sbl, sa, sal);
  }
  /* z1 = (a0 + a1)(b0 + b1) - z0 - z2 = a0*b1 + a1*b0 */
  bi_sub_into(z1, zn, r, 2 * h);
  bi_sub_into(z1, zn, r + 2 * h, a1n + b1n);
  size_t z1n = zn;
  while (z1n && !z1[z1n - 1]) z1n--;
  if (z1n) bi_add_into(r + h, an + bn - h, z1, z1n);
  free(sa);
}

/* r[0..an+bn) = a * b for an >= bn >= 1; r disjoint from a and b. */
static void bi_mul_limbs(bi_limb *r, const bi_limb *a, size_t an, const bi_limb *b, size_t bn) {
  bool square = a == b && an == bn;
  if (bn < (square ? BI_KARATSUBA_SQR_LIMBS : BI_KARATSUBA_LIMBS)) {
    if (square) bi_sqr_school(r, a, an);
    else bi_mul_school(r, a, an, b, bn);
    return;
  }
  if (an < 2 * bn) {
    bi_mul_karatsuba(r, a, an, b, bn);
    return;
  }
  /* Unbalanced: multiply bn-limb slices of a and accumulate. */
  memset(r, 0, (an + bn) * sizeof(bi_limb));
  bi_limb *t = bi_limbs(2 * bn);
  for (size_t off = 0; off < an; off += bn) {
    size_t cn = an - off < bn ? an - off : bn;
    if (cn >= bn) bi_mul_limbs(t, a + off, cn, b, bn);
    else bi_mul_limbs(t, b, bn, a + off, cn);
    bi_add_into(r + off, an + bn - off, t, cn + bn);
  }
  free(t);
}

/* ---- division -------------------------------------------------------- */

/* A single-limb divisor shifted to have its top bit set, with the
 * reciprocal floor((B^2 - 1) / d) - B of Moller and Granlund, "Improved
 * division by invariant integers" (2011). 32-bit limbs divide natively. */
typedef struct {
  bi_limb d;
  bi_limb v;
  unsigned shift;
} bi_divisor;

static bi_divisor bi_divisor_of(bi_limb d) {
  bi_divisor dv;
  dv.shift = bi_clz(d);
  dv.d = d << dv.shift;
#if BI_LIMB_BITS == 64
  dv.v = (bi_limb)((((bi_wide)~dv.d) << 64 | BI_LIMB_MAX) / dv.d);
#else
  dv.v = 0;
#endif
  return dv;
}

/* (u1:u0) / d for u1 < d and d with its top bit set; *r gets the
 * remainder. */
static inline bi_limb bi_div21(bi_limb u1, bi_limb u0, bi_limb d, bi_limb v, bi_limb *r) {
#if BI_LIMB_BITS == 64
  bi_wide q = (bi_wide)v * u1 + (((bi_wide)u1 << 64) | u0);
  bi_limb q1 = (bi_limb)(q >> 64) + 1;
  bi_limb q0 = (bi_limb)q;
  bi_limb rr = u0 - q1 * d;
  if (rr > q0) {
    q1--;
    rr += d;
  }
  if (rr >= d) {
    q1++;
    rr -= d;
  }
  *r = rr;
  return q1;
#else
  (void)v;
  bi_wide n = ((bi_wide)u1 << 32) | u0;
  *r = (bi_limb)(n % d);
  return (bi_limb)(n / d);
#endif
}

/* q[0..n) = a / d (q may alias a, or be NULL for the remainder only);
 * returns a % d. */
static bi_limb bi_divrem1(bi_limb *q, const bi_limb *a, size_t n, const bi_divisor *dv) {
  unsigned s = dv->shift;
  bi_limb d = dv->d, v = dv->v, r = 0, qi;
  if (!s) {
    for (size_t i = n; i-- > 0;) {
      qi = bi_div21(r, a[i], d, v, &r);
      if (q) q[i] = qi;
    }
    return r;
  }
  r = a[n - 1] >> (BI_LIMB_BITS - s);
  for (size_t i = n; i-- > 0;) {
    bi_limb lo = (a[i] << s) | (i ? a[i - 1] >> (BI_LIMB_BITS - s) : 0);
    qi = bi_div21(r, lo, d, v, &r);
    if (q) q[i] = qi;
  }
  return r >> s;
}

/* Knuth's algorithm D (TAOCP 4.3.1) for an >= bn >= 2 with b's top limb
 * nonzero: q[0..an-bn+1) = a / b and, unless r is NULL, r[0..bn) = a % b. */
static void bi_divmod_knuth(bi_limb *q, bi_limb *r, const bi_limb *a, size_t an,
                            const bi_limb *b, size_t bn) {
  unsigned s = bi_clz(b[bn - 1]);
  bi_limb *un = bi_limbs(an + 1 + bn);
  bi_limb *vn = un + an + 1;
  if (s) {
    bi_lshift(vn, b, bn, s);
    bi_lshift(un, a, an, s);
    un[an] = a[an - 1] >> (BI_LIMB_BITS - s);
  } else {
    memcpy(vn, b, bn * sizeof(bi_limb));
    memcpy(un, a, an * sizeof(bi_limb));
    un[an] = 0;
  }
  bi_limb d1 = vn[bn - 1], d0 = vn[bn - 2];
  bi_divisor top = bi_divisor_of(d1);
  for (size_t j = an - bn + 1; j-- > 0;) {
    bi_limb u2 = un[j + bn], u1 = un[j + bn - 1], u0 = un[j + bn - 2];
    bi_limb qhat, rhat;
    bool rhat_big; /* rhat >= B: the estimate needs no further test */
    if (u2 >= d1) {
      qhat = BI_LIMB_MAX;
      rhat = u1 + d1;
      rhat_big = rhat < d1;
    } else {
      qhat = bi_div21(u2, u1, d1, top.v, &rhat);
      rhat_big = false;
    }
    while (!rhat_big && (bi_wide)qhat * d0 > (((bi_wide)rhat << BI_LIMB_BITS) | u0)) {
      qhat--;
      rhat += d1;
      rhat_big = rhat < d1;
    }
    bi_limb borrow = bi_submul1(un + j, vn, bn, qhat);
    if (un[j + bn] < borrow) {
      /* qhat was one too large: add the divisor back */
      un[j + bn] -= borrow;
      qhat--;
      un[j + bn] += bi_add_n(un + j, un + j, vn, bn);
    } else {
      un[j + bn] -= borrow;
    }
    q[j] = qhat;
  }
  if (r) {
    if (s) {
      bi_rshift(r, un, bn, s);
    } else {
      memcpy(r, un, bn * sizeof(bi_limb));
    }
  }
  free(un);
}

/* a / b for a and b of n >= 2 limbs each, b's top limb nonzero: the
 * quotient is one limb. Knuth's estimate comes from the top limbs as
 * they read normalized (three of a, two of b) and is the quotient or one
 * more, which one pass of a - qhat * b over the operands as they are
 * settles, with no normalized copies. r, unless NULL, receives the n
 * limbs of a % b. */
static bi_limb bi_div_qlimb(bi_limb *r, const bi_limb *a, const bi_limb *b, size_t n) {
  unsigned s = bi_clz(b[n - 1]);
  bi_limb d1 = b[n - 1], d0 = b[n - 2], u2 = 0, u1 = a[n - 1], u0 = a[n - 2];
  if (s) {
    unsigned t = BI_LIMB_BITS - s;
    bi_limb b3 = n >= 3 ? b[n - 3] : 0, a3 = n >= 3 ? a[n - 3] : 0;
    d1 = (d1 << s) | (d0 >> t);
    d0 = (d0 << s) | (b3 >> t);
    u2 = u1 >> t;
    u1 = (u1 << s) | (u0 >> t);
    u0 = (u0 << s) | (a3 >> t);
  }
  bi_limb qhat, rhat;
  bool rhat_big; /* rhat >= B: the estimate needs no further test */
  if (u2 >= d1) {
    qhat = BI_LIMB_MAX;
    rhat = u1 + d1;
    rhat_big = rhat < d1;
  } else {
    bi_divisor top = bi_divisor_of(d1);
    qhat = bi_div21(u2, u1, top.d, top.v, &rhat);
    rhat_big = false;
  }
  while (!rhat_big && (bi_wide)qhat * d0 > (((bi_wide)rhat << BI_LIMB_BITS) | u0)) {
    qhat--;
    rhat += d1;
    rhat_big = rhat < d1;
  }
  /* Without a remainder, the top limbs decide when they leave room:
   * a - qhat * b >= (rhat * B + u0 - qhat * d0) * B^(n-2) - qhat * B^(n-2)
   * as normalized, so a margin of at least qhat proves qhat. */
  if (!r && !rhat_big) {
    bi_wide top = ((bi_wide)rhat << BI_LIMB_BITS) | u0, sub = (bi_wide)qhat * d0;
    if (top - sub >= qhat) return qhat;
  } else if (!r) {
    return qhat; /* rhat >= B: the remainder exceeds B^(n-1) >= qhat * b's low part */
  }
  /* a - qhat * b: negative when the product's high limb or the borrow
   * reaches past a's n limbs */
  bi_limb carry = 0, borrow = 0;
  for (size_t i = 0; i < n; i++) {
    bi_wide p = (bi_wide)b[i] * qhat + carry;
    carry = (bi_limb)(p >> BI_LIMB_BITS);
    bi_limb d = bi_subc(a[i], (bi_limb)p, &borrow);
    if (r) r[i] = d;
  }
  if (carry || borrow) {
    qhat--;
    if (r) bi_add_n(r, r, b, n);
  }
  return qhat;
}

/* ---- comparisons and hashing ----------------------------------------- */

static int bi_cmp_abs(const ScrBigInt *a, const ScrBigInt *b) {
  return bi_cmp_limbs(a->limb, a->len, b->limb, b->len);
}

static int bi_cmp(const ScrBigInt *a, const ScrBigInt *b) {
  if (a->sign != b->sign) return a->sign < b->sign ? -1 : 1;
  if (!a->sign) return 0;
  int c = bi_cmp_abs(a, b);
  return a->sign < 0 ? -c : c;
}

bool scr_bigint_eq(ScrBigInt *a, ScrBigInt *b) {
  return a == b || (a->sign == b->sign && bi_cmp_abs(a, b) == 0);
}

uint64_t scr_bigint_hash(const ScrBigInt *value) {
  /* BigInts are immutable and normalized. Ignore capacity and ownership;
   * equal values made by parsing, arithmetic or conversion hash alike.
   * The hash runs over the magnitude's 32-bit words on every target. */
  uint64_t hash = UINT64_C(0xcbf29ce484222325) ^ (uint64_t)(value->sign + 1);
  for (size_t i = 0; i < value->len; i++) {
    bi_limb limb = value->limb[i];
    hash ^= (uint32_t)limb;
    hash *= UINT64_C(0x100000001b3);
#if BI_LIMB_BITS == 64
    if (i + 1 < value->len || limb >> 32) {
      hash ^= (uint32_t)(limb >> 32);
      hash *= UINT64_C(0x100000001b3);
    }
#endif
  }
  hash ^= hash >> 30;
  hash *= UINT64_C(0xbf58476d1ce4e5b9);
  hash ^= hash >> 27;
  hash *= UINT64_C(0x94d049bb133111eb);
  return hash ^ (hash >> 31);
}
double scr_bigint_cmp_f64(ScrBigInt *a, ScrBigInt *b) { return (double)bi_cmp(a, b); }
bool scr_bigint_truthy(ScrBigInt *v) { return v->sign != 0; }

/* ---- add / sub / mul ------------------------------------------------- */

/* sign * (|a| + |b|) */
static ScrBigInt *bi_add_mag(const ScrBigInt *a, const ScrBigInt *b, int sign) {
  if (a->len < b->len) {
    const ScrBigInt *t = a;
    a = b;
    b = t;
  }
  size_t n = a->len;
  if (n + 1 > BI_MAX_LIMBS) {
    bi_max_size_exceeded();
    return NULL;
  }
  ScrBigInt *r = bi_alloc(n + 1);
  r->limb[n] = bi_add_ab(r->limb, a->limb, n, b->limb, b->len);
  r->len = n + (r->limb[n] != 0);
  r->sign = sign;
  return r;
}

/* sign * (|a| - |b|) */
static ScrBigInt *bi_sub_mag(const ScrBigInt *a, const ScrBigInt *b, int sign) {
  int c = bi_cmp_abs(a, b);
  if (!c) return bi_zero();
  if (c < 0) {
    const ScrBigInt *t = a;
    a = b;
    b = t;
    sign = -sign;
  }
  ScrBigInt *r = bi_alloc(a->len);
  bi_sub_ab(r->limb, a->limb, a->len, b->limb, b->len);
  return bi_finish(r, a->len, sign);
}

/* as * x + bs * y for one-limb magnitudes: the common small case. */
static ScrBigInt *bi_add1(int as, bi_limb x, int bs, bi_limb y) {
  ScrBigInt *r;
  if (as == bs) {
    bi_limb sum = x + y;
    r = bi_alloc(2);
    r->limb[0] = sum;
    r->limb[1] = 1;
    r->len = 1 + (sum < x);
    r->sign = as;
    return r;
  }
  if (x == y) return bi_zero();
  r = bi_alloc(1);
  r->len = 1;
  r->limb[0] = x > y ? x - y : y - x;
  r->sign = x > y ? as : bs;
  return r;
}

ScrBigInt *scr_bigint_add(ScrBigInt *a, ScrBigInt *b) {
  if (a->len == 1 && b->len == 1) return bi_add1(a->sign, a->limb[0], b->sign, b->limb[0]);
  if (!a->sign) return scr_bigint_retain(b);
  if (!b->sign) return scr_bigint_retain(a);
  if (a->sign == b->sign) return bi_add_mag(a, b, a->sign);
  return bi_sub_mag(a, b, a->sign);
}

ScrBigInt *scr_bigint_neg(ScrBigInt *a) { return bi_from_limbs(a->limb, a->len, -a->sign); }

ScrBigInt *scr_bigint_sub(ScrBigInt *a, ScrBigInt *b) {
  if (a->len == 1 && b->len == 1) return bi_add1(a->sign, a->limb[0], -b->sign, b->limb[0]);
  if (!b->sign) return scr_bigint_retain(a);
  if (!a->sign) return scr_bigint_neg(b);
  if (a->sign != b->sign) return bi_add_mag(a, b, a->sign);
  return bi_sub_mag(a, b, a->sign);
}

ScrBigInt *scr_bigint_mul(ScrBigInt *a, ScrBigInt *b) {
  if (a->len == 1 && b->len == 1) {
    bi_wide p = (bi_wide)a->limb[0] * b->limb[0];
    ScrBigInt *r = bi_alloc(2);
    r->limb[0] = (bi_limb)p;
    r->limb[1] = (bi_limb)(p >> BI_LIMB_BITS);
    r->len = r->limb[1] ? 2 : 1;
    r->sign = a->sign * b->sign;
    return r;
  }
  if (!a->sign || !b->sign) return bi_zero();
  if (a->len < b->len) {
    ScrBigInt *t = a;
    a = b;
    b = t;
  }
  int sign = a->sign * b->sign;
  size_t n = a->len + b->len;
  if (n > BI_MAX_LIMBS) {
    bi_max_size_exceeded();
    return NULL;
  }
  if (b->len == 1) {
    bi_limb m = b->limb[0];
    if (m == 1) return sign == a->sign ? scr_bigint_retain(a) : bi_from_limbs(a->limb, a->len, sign);
    ScrBigInt *r = bi_alloc(n);
    r->limb[a->len] = bi_mul1(r->limb, a->limb, a->len, m, 0);
    r->len = a->len + (r->limb[a->len] != 0);
    r->sign = sign;
    return r;
  }
  ScrBigInt *r = bi_alloc(n);
  bi_mul_limbs(r->limb, a->limb, a->len, b->limb, b->len);
  return bi_finish(r, n, sign);
}

/* ---- div / mod ------------------------------------------------------- */

/* |a| / |b| and |a| % |b| for |a| >= |b| > 0, as non-negative values;
 * either output may be NULL when unwanted. */
static void bi_divmod_abs(const ScrBigInt *a, const ScrBigInt *b, ScrBigInt **qout, ScrBigInt **rout) {
  size_t an = a->len, bn = b->len;
  if (bn == 1) {
    bi_divisor dv = bi_divisor_of(b->limb[0]);
    ScrBigInt *q = qout ? bi_alloc(an) : NULL;
    bi_limb rem = bi_divrem1(q ? q->limb : NULL, a->limb, an, &dv);
    if (qout) *qout = bi_finish(q, an, 1);
    if (rout) *rout = bi_u64_signed(rem, 1);
    return;
  }
  if (an == bn) {
    ScrBigInt *r = rout ? bi_alloc(bn) : NULL;
    bi_limb q = bi_div_qlimb(r ? r->limb : NULL, a->limb, b->limb, bn);
    if (qout) *qout = bi_u64_signed(q, 1);
    if (rout) *rout = bi_finish(r, bn, 1);
    return;
  }
  size_t qn = an - bn + 1;
  ScrBigInt *q = bi_alloc(qn);
  ScrBigInt *r = rout ? bi_alloc(bn) : NULL;
  bi_divmod_knuth(q->limb, r ? r->limb : NULL, a->limb, an, b->limb, bn);
  if (qout) *qout = bi_finish(q, qn, 1);
  else scr_mem_free(q);
  if (rout) *rout = bi_finish(r, bn, 1);
}

static bool bi_div_zero(ScrBigInt *b) {
  if (b->sign) return false;
  static const char msg[] = "Division by zero";
  scr_throw_error_msg(SCR_ERR_RANGE, msg, sizeof msg - 1);
  return true;
}

ScrBigInt *scr_bigint_div(ScrBigInt *a, ScrBigInt *b) {
  if (bi_div_zero(b)) return NULL;
  if (bi_cmp_abs(a, b) < 0) return bi_zero();
  if (b->len == 1 && b->limb[0] == 1) return b->sign > 0 ? scr_bigint_retain(a) : scr_bigint_neg(a);
  ScrBigInt *q;
  bi_divmod_abs(a, b, &q, NULL);
  if (q->sign) q->sign = a->sign * b->sign;
  return q;
}

ScrBigInt *scr_bigint_mod(ScrBigInt *a, ScrBigInt *b) {
  if (bi_div_zero(b)) return NULL;
  if (bi_cmp_abs(a, b) < 0) return scr_bigint_retain(a);
  ScrBigInt *r;
  bi_divmod_abs(a, b, NULL, &r);
  if (r->sign) r->sign = a->sign;
  return r;
}

/* ---- shifts ---------------------------------------------------------- */

static size_t bi_bits(const ScrBigInt *a) {
  if (!a->len) return 0;
  size_t words = a->len - 1;
  if (words > (SIZE_MAX - BI_LIMB_BITS) / BI_LIMB_BITS) bi_oom();
  return words * BI_LIMB_BITS + (BI_LIMB_BITS - bi_clz(a->limb[a->len - 1]));
}

/* sign * (|a| << count) for a != 0. */
static ScrBigInt *bi_shl_abs(const ScrBigInt *a, size_t count, int sign) {
  size_t words = count / BI_LIMB_BITS;
  unsigned shift = (unsigned)(count % BI_LIMB_BITS);
  if (count > BI_MAX_BITS || a->len + words > BI_MAX_LIMBS) {
    bi_max_size_exceeded();
    return NULL;
  }
  size_t n = a->len + words;
  bool grow = shift && (a->limb[a->len - 1] >> (BI_LIMB_BITS - shift)) != 0;
  if (n + grow > BI_MAX_LIMBS) {
    bi_max_size_exceeded();
    return NULL;
  }
  ScrBigInt *r = bi_alloc(n + grow);
  memset(r->limb, 0, words * sizeof(bi_limb));
  if (!shift) {
    memcpy(r->limb + words, a->limb, a->len * sizeof(bi_limb));
  } else {
    bi_lshift(r->limb + words, a->limb, a->len, shift);
    if (grow) r->limb[n] = a->limb[a->len - 1] >> (BI_LIMB_BITS - shift);
  }
  r->len = n + grow;
  r->sign = sign;
  return r;
}

/* sign * (|a| >> count), noting whether any one bits were discarded. */
static ScrBigInt *bi_shr_abs(const ScrBigInt *a, size_t count, int sign, bool *discarded) {
  size_t words = count / BI_LIMB_BITS;
  unsigned shift = (unsigned)(count % BI_LIMB_BITS);
  *discarded = false;
  if (words >= a->len) {
    *discarded = a->sign != 0;
    return bi_zero();
  }
  for (size_t i = 0; i < words && !*discarded; i++) *discarded = a->limb[i] != 0;
  if (shift && (a->limb[words] & (((bi_limb)1 << shift) - 1))) *discarded = true;
  size_t n = a->len - words;
  ScrBigInt *r = bi_alloc(n);
  if (!shift) {
    memcpy(r->limb, a->limb + words, n * sizeof(bi_limb));
  } else {
    bi_rshift(r->limb, a->limb + words, n, shift);
  }
  return bi_finish(r, n, sign);
}

/* sign * (|a| + 1) */
static ScrBigInt *bi_inc_mag(const ScrBigInt *a, int sign) {
  size_t n = a->len;
  if (n + 1 > BI_MAX_LIMBS) {
    bi_max_size_exceeded();
    return NULL;
  }
  ScrBigInt *r = bi_alloc(n + 1);
  bi_limb carry = 1;
  for (size_t i = 0; i < n; i++) {
    bi_limb t = a->limb[i] + carry;
    carry = carry && t == 0;
    r->limb[i] = t;
  }
  r->limb[n] = carry;
  r->len = n + (carry != 0);
  r->sign = sign;
  return r;
}

/* sign * (|a| - 1) for a != 0 */
static ScrBigInt *bi_dec_mag(const ScrBigInt *a, int sign) {
  size_t n = a->len;
  ScrBigInt *r = bi_alloc(n);
  bi_limb borrow = 1;
  for (size_t i = 0; i < n; i++) {
    bi_limb x = a->limb[i];
    r->limb[i] = x - borrow;
    borrow = borrow && x == 0;
  }
  return bi_finish(r, n, sign);
}

static bool bi_count(const ScrBigInt *v, size_t *out) {
  if (!v->sign) {
    *out = 0;
    return true;
  }
  if (!bi_mag_fits_u64(v)) return false;
  uint64_t n = bi_mag_u64(v);
  if (n > SIZE_MAX) return false;
  *out = (size_t)n;
  return true;
}

static ScrBigInt *bi_shift(ScrBigInt *a, ScrBigInt *count, bool left) {
  if (a->len == 1 && a->sign > 0 && count->len == 1 && count->sign > 0 && count->limb[0] < BI_LIMB_BITS) {
    /* one positive limb by a constant-like count: the hashing case */
    unsigned k = (unsigned)count->limb[0];
    bi_limb x = a->limb[0];
    if (!left) return bi_u64_signed(x >> k, 1);
    bi_limb hi = k ? x >> (BI_LIMB_BITS - k) : 0;
    ScrBigInt *r = bi_alloc(2);
    r->limb[0] = x << k;
    r->limb[1] = hi;
    r->len = hi ? 2 : 1;
    r->sign = 1;
    return r;
  }
  bool direction = left ^ (count->sign < 0);
  size_t n;
  if (!a->sign) return bi_zero();
  if (!bi_count(count, &n)) {
    if (!direction) return a->sign < 0 ? bi_u64_signed(1, -1) : bi_zero();
    bi_max_size_exceeded();
    return NULL;
  }
  if (!n) return scr_bigint_retain(a);
  if (direction) return bi_shl_abs(a, n, a->sign);
  bool discarded;
  ScrBigInt *r = bi_shr_abs(a, n, a->sign, &discarded);
  if (a->sign >= 0 || !discarded) return r;
  /* Negative values round toward negative infinity. */
  ScrBigInt *rounded = bi_inc_mag(r, -1);
  scr_bigint_release(r);
  return rounded;
}

ScrBigInt *scr_bigint_shl(ScrBigInt *a, ScrBigInt *count) { return bi_shift(a, count, true); }
ScrBigInt *scr_bigint_shr(ScrBigInt *a, ScrBigInt *count) { return bi_shift(a, count, false); }

ScrBigInt *scr_bigint_pow(ScrBigInt *a, ScrBigInt *b) {
  if (b->sign < 0) {
    static const char msg[] = "undefined must be positive";
    scr_throw_error_msg(SCR_ERR_RANGE, msg, sizeof msg - 1);
    return NULL;
  }
  if (!b->sign) return bi_u64(1);
  if (!a->sign) return bi_zero();
  bool odd = b->limb[0] & 1;
  if (a->len == 1 && a->limb[0] == 1) return a->sign > 0 || odd ? scr_bigint_retain(a) : bi_u64(1);
  /* |a| >= 2, so the result has more than b bits. */
  size_t e;
  if (!bi_count(b, &e) || e > BI_MAX_BITS) {
    bi_max_size_exceeded();
    return NULL;
  }
  int sign = a->sign < 0 && odd ? -1 : 1;
  if (a->len == 1 && (a->limb[0] & (a->limb[0] - 1)) == 0) {
    /* a power of two: one shift */
    size_t k = BI_LIMB_BITS - 1 - bi_clz(a->limb[0]);
    if (e > BI_MAX_BITS / k) {
      bi_max_size_exceeded();
      return NULL;
    }
    ScrBigInt *one = bi_u64(1);
    ScrBigInt *r = bi_shl_abs(one, k * e, sign);
    scr_bigint_release(one);
    return r;
  }
  ScrBigInt *result = NULL;
  ScrBigInt *base = scr_bigint_retain(a);
  for (;;) {
    if (e & 1) {
      ScrBigInt *next = result ? scr_bigint_mul(result, base) : scr_bigint_retain(base);
      scr_bigint_release(result);
      result = next;
      if (!result) break;
    }
    e >>= 1;
    if (!e) break;
    ScrBigInt *next = scr_bigint_mul(base, base);
    scr_bigint_release(base);
    base = next;
    if (!base) {
      scr_bigint_release(result);
      result = NULL;
      break;
    }
  }
  scr_bigint_release(base);
  return result;
}

/* ---- bitwise operators ----------------------------------------------- */

/* Limb i of v's infinitely sign-extended two's complement, threading the
 * +1 carry of negative values through *carry (initially 1). */
static inline bi_limb bi_twos_limb(const ScrBigInt *v, size_t i, bi_limb *carry) {
  bi_limb m = i < v->len ? v->limb[i] : 0;
  if (v->sign >= 0) return m;
  bi_limb t = ~m + *carry;
  *carry = *carry && t == 0;
  return t;
}

static ScrBigInt *bi_bitop(ScrBigInt *a, ScrBigInt *b, char op) {
  if (a->sign > 0 && b->sign > 0 && a->len <= 2 && b->len <= 2) {
    /* non-negative values of at most two limbs: the fixed-width case */
    bi_limb a0 = a->limb[0], a1 = a->len > 1 ? a->limb[1] : 0;
    bi_limb b0 = b->limb[0], b1 = b->len > 1 ? b->limb[1] : 0;
    bi_limb r0 = op == '&' ? a0 & b0 : op == '|' ? a0 | b0 : a0 ^ b0;
    bi_limb r1 = op == '&' ? a1 & b1 : op == '|' ? a1 | b1 : a1 ^ b1;
    if (!r0 && !r1) return bi_zero();
    ScrBigInt *r = bi_alloc(2);
    r->limb[0] = r0;
    r->limb[1] = r1;
    r->len = r1 ? 2 : 1;
    r->sign = 1;
    return r;
  }
  if (a->sign >= 0 && b->sign >= 0) {
    if (op == '&') {
      size_t n = a->len < b->len ? a->len : b->len;
      if (!n) return bi_zero();
      ScrBigInt *r = bi_alloc(n);
      for (size_t i = 0; i < n; i++) r->limb[i] = a->limb[i] & b->limb[i];
      return bi_finish(r, n, 1);
    }
    if (!b->sign) return scr_bigint_retain(a);
    if (!a->sign) return scr_bigint_retain(b);
    if (a->len < b->len) {
      ScrBigInt *t = a;
      a = b;
      b = t;
    }
    size_t n = a->len;
    ScrBigInt *r = bi_alloc(n);
    if (op == '|') {
      for (size_t i = 0; i < b->len; i++) r->limb[i] = a->limb[i] | b->limb[i];
    } else {
      for (size_t i = 0; i < b->len; i++) r->limb[i] = a->limb[i] ^ b->limb[i];
    }
    memcpy(r->limb + b->len, a->limb + b->len, (n - b->len) * sizeof(bi_limb));
    return bi_finish(r, n, 1);
  }
  bool aneg = a->sign < 0, bneg = b->sign < 0;
  bool neg = op == '&' ? aneg && bneg : op == '|' ? aneg || bneg : aneg != bneg;
  size_t n = (a->len > b->len ? a->len : b->len) + 1;
  ScrBigInt *r = bi_alloc(n);
  bi_limb ca = 1, cb = 1, cr = 1;
  for (size_t i = 0; i < n; i++) {
    bi_limb x = bi_twos_limb(a, i, &ca), y = bi_twos_limb(b, i, &cb);
    bi_limb z = op == '&' ? x & y : op == '|' ? x | y : x ^ y;
    if (neg) {
      z = ~z + cr;
      cr = cr && z == 0;
    }
    r->limb[i] = z;
  }
  return bi_finish(r, n, neg ? -1 : 1);
}

ScrBigInt *scr_bigint_and(ScrBigInt *a, ScrBigInt *b) { return bi_bitop(a, b, '&'); }
ScrBigInt *scr_bigint_or(ScrBigInt *a, ScrBigInt *b) { return bi_bitop(a, b, '|'); }
ScrBigInt *scr_bigint_xor(ScrBigInt *a, ScrBigInt *b) { return bi_bitop(a, b, '^'); }

ScrBigInt *scr_bigint_not(ScrBigInt *a) {
  /* ~a == -a - 1 */
  if (a->sign >= 0) return bi_inc_mag(a, -1);
  return bi_dec_mag(a, 1);
}

/* ---- parsing --------------------------------------------------------- */

static int bi_digit(unsigned char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'z') return c - 'a' + 10;
  if (c >= 'A' && c <= 'Z') return c - 'A' + 10;
  return -1;
}

/* ECMAScript WhiteSpace + LineTerminator code points, matched over the
 * runtime's UTF-8 strings. libc isspace is locale-dependent and only sees
 * one byte, while StringToBigInt trims the full spec set. */
static size_t bi_space_prefix(const char *s, size_t n) {
  if (n == 0) return 0;
  unsigned char a = (unsigned char)s[0];
  if (a == 0x09 || a == 0x0a || a == 0x0b || a == 0x0c ||
      a == 0x0d || a == 0x20) return 1;
  if (n >= 2 && a == 0xc2 && (unsigned char)s[1] == 0xa0) return 2;
  if (n < 3) return 0;
  unsigned char b = (unsigned char)s[1];
  unsigned char c = (unsigned char)s[2];
  if (a == 0xe1 && b == 0x9a && c == 0x80) return 3; /* U+1680 */
  if (a == 0xe2 && b == 0x80 &&
      ((c >= 0x80 && c <= 0x8a) || c == 0xa8 || c == 0xa9 || c == 0xaf)) return 3;
  if (a == 0xe2 && b == 0x81 && c == 0x9f) return 3; /* U+205F */
  if (a == 0xe3 && b == 0x80 && c == 0x80) return 3; /* U+3000 */
  if (a == 0xef && b == 0xbb && c == 0xbf) return 3; /* U+FEFF */
  return 0;
}

static size_t bi_space_suffix(const char *s, size_t n) {
  if (n == 0) return 0;
  size_t start = n - 1;
  while (start > 0 && ((unsigned char)s[start] & 0xc0u) == 0x80u) start--;
  size_t width = bi_space_prefix(s + start, n - start);
  return width == n - start ? width : 0;
}

static ScrBigInt *bi_parse_fail(const ScrStr *s) {
  static const char pre[] = "Cannot convert ";
  static const char post[] = " to a BigInt";
  size_t n = sizeof pre - 1 + s->len + sizeof post - 1;
  char *msg = bi_malloc(n);
  memcpy(msg, pre, sizeof pre - 1);
  memcpy(msg + sizeof pre - 1, s->data, s->len);
  memcpy(msg + sizeof pre - 1 + s->len, post, sizeof post - 1);
  scr_throw_error_msg(SCR_ERR_SYNTAX, msg, n);
  free(msg);
  return NULL;
}

static ScrBigInt *bi_parse_invalid(const ScrStr *s, bool report_error) {
  return report_error ? bi_parse_fail(s) : NULL;
}

/* Whether `digits` significant digits in `radix` (2, 8, 10 or 16) can stay
 * within the size limit. It never forms digits * bits-per-digit, which
 * wraps on 32-bit targets: power-of-two digits carry exactly log2(radix)
 * bits each, and a decimal digit at least 3, so a longer text is too wide
 * (the parse also checks the exact result length). Every size computed
 * while parsing is at most digits * 4 / 32 + 2 limbs once this holds. */
bool scr_bigint_digits_fit(size_t digits, unsigned radix) {
  unsigned per = radix == 16 ? 4 : radix == 2 ? 1 : 3;
  return digits <= BI_MAX_BITS / per;
}

/* count validated digits of a power-of-two base (scr_bigint_digits_fit
 * holds): pack bits from the end. */
SCR_COLD static ScrBigInt *bi_parse_pow2(const char *p, size_t count, unsigned bits_per, int sign) {
  size_t bits = count * bits_per;
  size_t n = bits / BI_LIMB_BITS + 1;
  ScrBigInt *v = bi_alloc(n);
  memset(v->limb, 0, n * sizeof(bi_limb));
  size_t at = 0;
  for (size_t i = count; i-- > 0; at += bits_per) {
    bi_limb d = (bi_limb)bi_digit((unsigned char)p[i]);
    size_t w = at / BI_LIMB_BITS;
    unsigned o = (unsigned)(at % BI_LIMB_BITS);
    v->limb[w] |= d << o;
    if (o + bits_per > BI_LIMB_BITS) v->limb[w + 1] |= d >> (BI_LIMB_BITS - o);
  }
  return bi_finish(v, n, sign);
}

/* count validated decimal digits: groups of the most digits that fit a
 * limb, each one multiply-add over the value built so far, in place. */
static ScrBigInt *bi_parse_decimal(const char *p, size_t count, int sign) {
  const size_t per = BI_LIMB_BITS == 64 ? 19 : 9;
  ScrBigInt *v = bi_alloc(count / per + 2);
  size_t len = 0, i = 0;
  size_t take = count % per ? count % per : per;
  while (i < count) {
    bi_limb acc = 0, mul = 1;
    for (size_t k = 0; k < take; k++, i++) {
      acc = acc * 10 + (bi_limb)(p[i] - '0');
      mul *= 10;
    }
    bi_limb carry = bi_mul1(v->limb, v->limb, len, mul, acc);
    if (carry) v->limb[len++] = carry;
    take = per;
  }
  return bi_finish(v, len, sign);
}

static ScrBigInt *bi_parse_string(ScrStr *s, bool report_error) {
  size_t lo = 0, hi = s->len;
  size_t width;
  while (lo < hi && (width = bi_space_prefix(s->data + lo, hi - lo)) != 0) lo += width;
  while (hi > lo && (width = bi_space_suffix(s->data + lo, hi - lo)) != 0) hi -= width;
  if (lo == hi) return bi_zero();
  int sign = 1;
  bool signed_input = false;
  if (s->data[lo] == '+' || s->data[lo] == '-') {
    signed_input = true;
    if (s->data[lo++] == '-') sign = -1;
    if (lo == hi) return bi_parse_invalid(s, report_error);
  }
  unsigned base = 10;
  if (hi - lo >= 2 && s->data[lo] == '0') {
    char p = s->data[lo + 1];
    if (p == 'x' || p == 'X') base = 16;
    else if (p == 'o' || p == 'O') base = 8;
    else if (p == 'b' || p == 'B') base = 2;
    if (base != 10) {
      if (signed_input) return bi_parse_invalid(s, report_error);
      lo += 2;
      if (lo == hi) return bi_parse_invalid(s, report_error);
    }
  }
  for (size_t i = lo; i < hi; i++) {
    int d = bi_digit((unsigned char)s->data[i]);
    if (d < 0 || (unsigned)d >= base) return bi_parse_invalid(s, report_error);
  }
  while (lo < hi && s->data[lo] == '0') lo++; /* leading zeros carry nothing */
  if (lo == hi) return bi_zero();
  size_t count = hi - lo;
  if (!scr_bigint_digits_fit(count, base)) {
    bi_max_size_exceeded();
    return NULL;
  }
  const char *p = s->data + lo;
  ScrBigInt *v = base == 10 ? bi_parse_decimal(p, count, sign)
                            : bi_parse_pow2(p, count, base == 16 ? 4 : base == 8 ? 3 : 1, sign);
  if (v->len > BI_MAX_LIMBS) {
    scr_bigint_release(v);
    bi_max_size_exceeded();
    return NULL;
  }
  return v;
}

ScrBigInt *scr_bigint_parse(ScrStr *s) { return bi_parse_string(s, true); }

double scr_bigint_cmp_string(ScrBigInt *a, ScrStr *b) {
  ScrBigInt *parsed = bi_parse_string(b, false);
  if (!parsed) return 2;
  double result = scr_bigint_cmp_f64(a, parsed);
  scr_bigint_release(parsed);
  return result;
}

/* Abstract Equality's String/BigInt arm uses StringToBigInt without
 * surfacing its parse failure: an invalid string compares false instead
 * of throwing. BigInt(string) keeps the public throwing parser above. */
bool scr_bigint_eq_string(ScrBigInt *a, ScrStr *b) {
  ScrBigInt *parsed = bi_parse_string(b, false);
  if (!parsed) return false;
  bool equal = scr_bigint_eq(a, parsed);
  scr_bigint_release(parsed);
  return equal;
}

/* ---- Number conversions ---------------------------------------------- */

#define BI_TWO_64 18446744073709551616.0

ScrBigInt *scr_bigint_from_f64(double value) {
  if (value >= -9223372036854775808.0 && value < 9223372036854775808.0) {
    int64_t i = (int64_t)value;
    if ((double)i == value) return scr_bigint_from_i64(i);
  }
  if (!isfinite(value) || trunc(value) != value) {
    char num[64], msg[192];
    if (isnan(value)) strcpy(num, "NaN");
    else if (isinf(value)) strcpy(num, value < 0 ? "-Infinity" : "Infinity");
    else snprintf(num, sizeof num, "%.17g", value);
    int n = snprintf(msg, sizeof msg,
      "The number %s cannot be converted to a BigInt because it is not an integer", num);
    scr_throw_error_msg(SCR_ERR_RANGE, msg, (size_t)n);
    return NULL;
  }
  int sign = value < 0 ? -1 : 1;
  double mag = fabs(value);
  if (mag < BI_TWO_64) return bi_u64_signed((uint64_t)mag, sign);
  int exp;
  double frac = frexp(mag, &exp);
  ScrBigInt *v = bi_u64((uint64_t)ldexp(frac, 53));
  ScrBigInt *shifted = bi_shl_abs(v, (size_t)(exp - 53), sign);
  scr_bigint_release(v);
  return shifted;
}

double scr_bigint_cmp_number(ScrBigInt *a, double b) {
  if (isnan(b)) return 2;
  if (isinf(b)) return b > 0 ? -1 : 1;
  double integral = trunc(b);
  int cmp;
  if (bi_mag_fits_u64(a) && fabs(integral) < BI_TWO_64) {
    int bs = integral > 0 ? 1 : integral < 0 ? -1 : 0;
    if (a->sign != bs) {
      cmp = a->sign < bs ? -1 : 1;
    } else {
      uint64_t am = bi_mag_u64(a), bm = (uint64_t)fabs(integral);
      cmp = am == bm ? 0 : am < bm ? -1 : 1;
      if (a->sign < 0) cmp = -cmp;
    }
  } else {
    ScrBigInt *other = scr_bigint_from_f64(integral);
    cmp = bi_cmp(a, other);
    scr_bigint_release(other);
  }
  if (cmp != 0 || integral == b) return (double)cmp;
  return b > 0 ? -1 : 1;
}

/* 64 bits of the magnitude starting at bit pos (zero above the top). */
static uint64_t bi_extract64(const ScrBigInt *v, size_t pos) {
  uint64_t out = 0;
  unsigned got = 0;
  while (got < 64) {
    size_t p = pos + got, w = p / BI_LIMB_BITS;
    if (w >= v->len) break;
    unsigned o = (unsigned)(p % BI_LIMB_BITS);
    out |= (uint64_t)(v->limb[w] >> o) << got;
    got += BI_LIMB_BITS - o;
  }
  return out;
}

double scr_bigint_to_f64(ScrBigInt *v) {
  if (!v->sign) return 0;
  double out;
  if (bi_mag_fits_u64(v)) {
    out = (double)bi_mag_u64(v);
  } else {
    /* The top 64 bits with every lower one bit folded into bit 0, so the
     * one conversion below rounds half to even exactly. */
    size_t bits = bi_bits(v), low = bits - 64;
    uint64_t top = bi_extract64(v, low);
    size_t w = low / BI_LIMB_BITS;
    unsigned o = (unsigned)(low % BI_LIMB_BITS);
    bool sticky = o && (v->limb[w] & (((bi_limb)1 << o) - 1)) != 0;
    for (size_t i = 0; i < w && !sticky; i++) sticky = v->limb[i] != 0;
    out = ldexp((double)(top | sticky), low > 4096 ? 4096 : (int)low);
  }
  return v->sign < 0 ? -out : out;
}

/* ---- radix conversion ------------------------------------------------ */

static const char bi_digit_chars[] = "0123456789abcdefghijklmnopqrstuvwxyz";

typedef struct {
  unsigned radix;
  unsigned per;  /* digits per chunk */
  bi_limb chunk; /* radix ** per, the largest power that fits a limb */
  bi_divisor dv;
} bi_radix;

/* Writes x's digits ending at end: exactly width digits when pad, else
 * as few as possible (at least one). Returns the first digit. */
static char *bi_emit_limb(char *end, bi_limb x, unsigned radix, size_t width, bool pad) {
  char *at = end;
  do {
    *--at = bi_digit_chars[x % radix];
    x /= radix;
  } while (x);
  if (pad) while ((size_t)(end - at) < width) *--at = '0';
  return at;
}

/* Base case: repeated division of a scratch copy by the chunk. */
static char *bi_emit_base(char *end, const bi_limb *x, size_t n, const bi_radix *rx, size_t width, bool pad) {
  char *at = end;
  if (n) {
    bi_limb *tmp = bi_limbs(n);
    memcpy(tmp, x, n * sizeof(bi_limb));
    while (n > 1) {
      bi_limb rem = bi_divrem1(tmp, tmp, n, &rx->dv);
      while (n && tmp[n - 1] == 0) n--;
      at = bi_emit_limb(at, rem, rx->radix, rx->per, true);
    }
    if (n) at = bi_emit_limb(at, tmp[0], rx->radix, 0, false);
    free(tmp);
  }
  if (pad) while ((size_t)(end - at) < width) *--at = '0';
  return at;
}

typedef struct {
  bi_limb *limbs;
  size_t len;
} bi_span;

/* Divide and conquer over pows[k] = chunk ** (2 ** k): x = q * pows[k] + r,
 * r written as exactly per * 2^k digits below q's digits. */
SCR_COLD static char *bi_emit_dc(char *end, const bi_limb *x, size_t n, const bi_radix *rx,
                        const bi_span *pows, int k, size_t width, bool pad) {
  while (n && x[n - 1] == 0) n--;
  while (k >= 0 && bi_cmp_limbs(x, n, pows[k].limbs, pows[k].len) < 0) k--;
  if (k < 0 || n < BI_DC_STRING_LIMBS) return bi_emit_base(end, x, n, rx, width, pad);
  const bi_span *p = &pows[k];
  size_t qn = n - p->len + 1;
  bi_limb *q = bi_limbs(qn + p->len);
  bi_limb *r = q + qn;
  if (p->len == 1) {
    bi_divisor dv = bi_divisor_of(p->limbs[0]);
    r[0] = bi_divrem1(q, x, n, &dv);
  } else {
    bi_divmod_knuth(q, r, x, n, p->limbs, p->len);
  }
  size_t low_digits = (size_t)rx->per << k;
  bi_emit_dc(end, r, p->len, rx, pows, k - 1, low_digits, true);
  char *start = bi_emit_dc(end - low_digits, q, qn, rx, pows, k - 1,
                           pad ? width - low_digits : 0, pad);
  free(q);
  return start;
}

ScrStr *scr_bigint_to_string(ScrBigInt *v, double radix_value) {
  /* ToIntegerOrInfinity: 2.5 is radix 2, NaN is 0. */
  double whole = isnan(radix_value) ? 0 : trunc(radix_value);
  if (!(whole >= 2 && whole <= 36)) {
    static const char msg[] = "toString() radix argument must be between 2 and 36";
    scr_throw_error_msg(SCR_ERR_RANGE, msg, sizeof msg - 1);
    return NULL;
  }
  unsigned radix = (unsigned)whole;
  if (!v->sign) return scr_str_new("0", 1);
  if (v->len == 1) {
    char small[BI_LIMB_BITS + 2];
    char *end = small + sizeof small;
    char *at = bi_emit_limb(end, v->limb[0], radix, 0, false);
    if (v->sign < 0) *--at = '-';
    return scr_str_new(at, (size_t)(end - at));
  }
  size_t bits = bi_bits(v);
  if ((radix & (radix - 1)) == 0) {
    unsigned per = (unsigned)__builtin_ctz(radix);
    size_t digits = (bits + per - 1) / per;
    char *buf = bi_malloc(digits + 1);
    char *end = buf + digits + 1, *at = end;
    size_t pos = 0;
    for (size_t d = 0; d < digits; d++, pos += per) {
      size_t w = pos / BI_LIMB_BITS;
      unsigned o = (unsigned)(pos % BI_LIMB_BITS);
      bi_limb x = v->limb[w] >> o;
      if (o + per > BI_LIMB_BITS && w + 1 < v->len) x |= v->limb[w + 1] << (BI_LIMB_BITS - o);
      *--at = bi_digit_chars[x & (radix - 1)];
    }
    if (v->sign < 0) *--at = '-';
    ScrStr *out = scr_str_new(at, (size_t)(end - at));
    free(buf);
    return out;
  }
  bi_radix rx;
  rx.radix = radix;
  rx.per = 1;
  rx.chunk = radix;
  while (rx.chunk <= BI_LIMB_MAX / radix) {
    rx.chunk *= radix;
    rx.per++;
  }
  rx.dv = bi_divisor_of(rx.chunk);
  /* digits <= bits / log2(radix) + 1 <= bits / floor(log2(radix)) + 1 */
  unsigned lg = BI_LIMB_BITS - 1 - bi_clz(radix);
  size_t cap = bits / lg + 2;
  char *buf = bi_malloc(cap);
  char *end = buf + cap;
  char *at;
  if (v->len < BI_DC_STRING_LIMBS) {
    at = bi_emit_base(end, v->limb, v->len, &rx, 0, false);
  } else {
    bi_span pows[64];
    int k = 0;
    pows[0].limbs = bi_limbs(1);
    pows[0].limbs[0] = rx.chunk;
    pows[0].len = 1;
    while (k + 1 < 64 && pows[k].len * 2 - 1 <= v->len) {
      size_t pn = pows[k].len;
      bi_limb *sq = bi_limbs(2 * pn);
      bi_mul_limbs(sq, pows[k].limbs, pn, pows[k].limbs, pn);
      size_t sn = 2 * pn;
      while (sn && sq[sn - 1] == 0) sn--;
      k++;
      pows[k].limbs = sq;
      pows[k].len = sn;
    }
    at = bi_emit_dc(end, v->limb, v->len, &rx, pows, k, 0, false);
    for (int i = 0; i <= k; i++) free(pows[i].limbs);
  }
  if (v->sign < 0) *--at = '-';
  ScrStr *out = scr_str_new(at, (size_t)(end - at));
  free(buf);
  return out;
}

ScrStr *scr_bigint_inspect(ScrBigInt *v) {
  ScrStr *digits = scr_bigint_to_string(v, 10);
  if (!digits) return NULL;
  char *buf = bi_malloc(digits->len + 1);
  memcpy(buf, digits->data, digits->len);
  buf[digits->len] = 'n';
  ScrStr *out = scr_str_new(buf, digits->len + 1);
  free(buf);
  scr_str_release(digits);
  return out;
}

/* ---- BigInt.asIntN / asUintN ----------------------------------------- */

static bool bi_index(double bits, size_t *out) {
  if (bits == 64) {
    *out = 64;
    return true;
  }
  if (!isfinite(bits) || trunc(bits) != bits || bits < 0 || bits > 9007199254740991.0 || bits > (double)SIZE_MAX) {
    static const char msg[] = "Invalid value: not (convertible to) a safe integer";
    scr_throw_error_msg(SCR_ERR_RANGE, msg, sizeof msg - 1);
    return false;
  }
  *out = (size_t)bits;
  return true;
}

/* Whether |value| < 2^bits, without materializing the power or multiplying
 * the width. This is also the large-width fast path: Node returns a value
 * that already fits without allocating storage proportional to `bits`. */
static bool bi_abs_lt_pow2(const ScrBigInt *value, size_t bits) {
  size_t full = bits / BI_LIMB_BITS;
  unsigned high = (unsigned)(bits % BI_LIMB_BITS);
  if (value->len <= full) return true;
  if (!high || value->len != full + 1) return false;
  return value->limb[full] < ((bi_limb)1 << high);
}

/* Whether |value| == 2^bits. The inclusive signed lower bound
 * (-2^(bits-1)) needs this one extra case beyond bi_abs_lt_pow2. */
static bool bi_abs_eq_pow2(const ScrBigInt *value, size_t bits) {
  size_t word = bits / BI_LIMB_BITS;
  unsigned bit = (unsigned)(bits % BI_LIMB_BITS);
  if (value->len != word + 1 || value->limb[word] != ((bi_limb)1 << bit)) return false;
  for (size_t i = 0; i < word; i++) {
    if (value->limb[i] != 0) return false;
  }
  return true;
}

/* The low `bits` bits of value's two's complement; with as_signed, bit
 * (bits - 1) is the sign. Enforces Node's materialized-value limit. */
SCR_COLD static ScrBigInt *bi_truncate_twos(const ScrBigInt *value, size_t bits, bool as_signed) {
  if (bits > BI_MAX_BITS) {
    bi_max_size_exceeded();
    return NULL;
  }
  unsigned high = (unsigned)(bits % BI_LIMB_BITS);
  size_t n = bits / BI_LIMB_BITS + (high != 0);
  bi_limb mask = high ? ((bi_limb)1 << high) - 1 : BI_LIMB_MAX;
  ScrBigInt *r = bi_alloc(n);
  bi_limb carry = 1;
  for (size_t i = 0; i < n; i++) r->limb[i] = bi_twos_limb(value, i, &carry);
  r->limb[n - 1] &= mask;
  unsigned sign_bit = (unsigned)((bits - 1) % BI_LIMB_BITS);
  if (!as_signed || !((r->limb[n - 1] >> sign_bit) & 1)) return bi_finish(r, n, 1);
  /* negative: the magnitude is 2^bits - t, below 2^bits, so the mask
   * keeps it whole */
  bi_limb c = 1;
  for (size_t i = 0; i < n; i++) {
    bi_limb t = ~r->limb[i] + c;
    c = c && t == 0;
    r->limb[i] = t;
  }
  r->limb[n - 1] &= mask;
  return bi_finish(r, n, -1);
}

ScrBigInt *scr_bigint_as_uint_n(double bits_value, ScrBigInt *value) {
  size_t bits;
  if (!bi_index(bits_value, &bits)) return NULL;
  if (!bits) return bi_zero();
  if (value->sign >= 0 && bi_abs_lt_pow2(value, bits)) return scr_bigint_retain(value);
  if (bits <= 64) {
    uint64_t low = scr_bigint_to_u64(value);
    if (bits < 64) low &= (UINT64_C(1) << bits) - 1;
    return bi_u64(low);
  }
  return bi_truncate_twos(value, bits, false);
}

ScrBigInt *scr_bigint_as_int_n(double bits_value, ScrBigInt *value) {
  size_t bits;
  if (!bi_index(bits_value, &bits)) return NULL;
  if (!bits) return bi_zero();
  size_t magnitude_bits = bits - 1;
  bool fits = bi_abs_lt_pow2(value, magnitude_bits) ||
    (value->sign < 0 && bi_abs_eq_pow2(value, magnitude_bits));
  if (fits) return scr_bigint_retain(value);
  if (bits <= 64) {
    uint64_t low = scr_bigint_to_u64(value);
    if (bits < 64) {
      uint64_t m = (UINT64_C(1) << bits) - 1;
      low &= m;
      if (low >> (bits - 1)) low |= ~m;
    }
    return scr_bigint_from_i64((int64_t)low);
  }
  return bi_truncate_twos(value, bits, true);
}

int scr_bigint_mag64(const ScrBigInt *value, uint64_t *mag, uint32_t *words) {
  *mag = bi_mag_u64(value);
  /* in 64-bit words, without multiplying the limb count */
  size_t per = 64 / BI_LIMB_BITS;
  size_t n = value->len / per + (value->len % per != 0);
  *words = n > UINT32_MAX ? UINT32_MAX : (uint32_t)n;
  return value->sign;
}

ScrBigInt *scr_bigint_from_mag64(uint64_t mag, bool negative) {
  return bi_u64_signed(mag, negative ? -1 : 1);
}

/* Postfix tokens separated by spaces: "L<i>" pushes leaves[i]; "F<i>"
 * pushes BigInt(numbers[i]) (which may throw); + - * / % & | ^ apply the
 * binary operator; "<<k>" and "><k>" shift by k bits; "n" negates; "~"
 * complements; "u<k>" / "i<k>" apply asUintN / asIntN with width k. */
SCR_COLD ScrBigInt *scr_bigint_wrap_eval(const char *program, ScrBigInt *const *leaves,
                                         const double *numbers) {
  ScrBigInt *stack[64];
  size_t depth = 0;
  const char *p = program;
  ScrBigInt *r = NULL;
  while (*p) {
    char op = *p++;
    unsigned long k = 0;
    while (*p >= '0' && *p <= '9') k = k * 10 + (unsigned long)(*p++ - '0');
    if (*p == ' ') p++;
    if (op == 'L' || op == 'F') {
      if (depth == 64) scr_trap("scriptc: bigint program too deep\n");
      r = op == 'L' ? scr_bigint_retain(leaves[k]) : scr_bigint_from_f64(numbers[k]);
      if (!r) break;
      stack[depth++] = r;
      continue;
    }
    if (!depth) scr_trap("scriptc: malformed bigint program\n");
    ScrBigInt *top = stack[depth - 1];
    if (op == '<' || op == '>') {
      ScrBigInt *count = bi_u64(k);
      r = op == '<' ? scr_bigint_shl(top, count) : scr_bigint_shr(top, count);
      scr_bigint_release(count);
    } else if (op == 'n') {
      r = scr_bigint_neg(top);
    } else if (op == '~') {
      r = scr_bigint_not(top);
    } else if (op == 'u') {
      r = scr_bigint_as_uint_n((double)k, top);
    } else if (op == 'i') {
      r = scr_bigint_as_int_n((double)k, top);
    } else {
      if (depth < 2) scr_trap("scriptc: malformed bigint program\n");
      ScrBigInt *left = stack[depth - 2];
      r = op == '+' ? scr_bigint_add(left, top)
        : op == '-' ? scr_bigint_sub(left, top)
        : op == '*' ? scr_bigint_mul(left, top)
        : op == '/' ? scr_bigint_div(left, top)
        : op == '%' ? scr_bigint_mod(left, top)
        : op == '&' ? scr_bigint_and(left, top)
        : op == '|' ? scr_bigint_or(left, top)
        : scr_bigint_xor(left, top);
      scr_bigint_release(top);
      depth--;
      top = left;
    }
    scr_bigint_release(top);
    depth--;
    if (!r) break;
    stack[depth++] = r;
  }
  if (!r) {
    while (depth) scr_bigint_release(stack[--depth]);
    return NULL;
  }
  if (depth != 1) scr_trap("scriptc: malformed bigint program\n");
  return stack[0];
}

/* ---- Buffer / DataView ----------------------------------------------- */

static ScrBigInt *bi_from_u64_signed(uint64_t value, bool sign) {
  if (!sign || !(value & UINT64_C(0x8000000000000000))) return bi_u64(value);
  return bi_u64_signed(~value + 1, -1);
}

static void bi_grouped_decimal(const ScrBigInt *value, char **out, size_t *out_len) {
  ScrStr *plain = scr_bigint_to_string((ScrBigInt *)value, 10);
  size_t start = plain->len && plain->data[0] == '-' ? 1 : 0;
  size_t digits = plain->len - start;
  size_t groups = digits > 3 ? (digits - 1) / 3 : 0;
  char *buf = bi_malloc(plain->len + groups + 2);
  size_t src = 0, dst = 0;
  if (start) buf[dst++] = plain->data[src++];
  size_t first = digits % 3;
  if (!first) first = 3;
  memcpy(buf + dst, plain->data + src, first);
  src += first;
  dst += first;
  while (src < plain->len) {
    buf[dst++] = '_';
    memcpy(buf + dst, plain->data + src, 3);
    src += 3;
    dst += 3;
  }
  buf[dst++] = 'n';
  buf[dst] = 0;
  scr_str_release(plain);
  *out = buf;
  *out_len = dst;
}

static bool bi_buffer_value(const ScrBigInt *value, bool sign, uint64_t *out) {
  bool valid;
  uint64_t mag = bi_mag_u64(value);
  if (!bi_mag_fits_u64(value)) valid = false;
  else if (!sign) valid = value->sign >= 0;
  else if (value->sign >= 0) valid = mag <= INT64_MAX;
  else valid = mag <= (UINT64_C(1) << 63);
  if (valid) {
    *out = scr_bigint_to_u64(value);
    return true;
  }
  char *received;
  size_t received_len;
  bi_grouped_decimal(value, &received, &received_len);
  const char *range = sign ? ">= -(2n ** 63n) and < 2n ** 63n" : ">= 0n and < 2n ** 64n";
  size_t need = strlen(range) + received_len + 80;
  char *msg = bi_malloc(need);
  int n = snprintf(msg, need, "The value of \"value\" is out of range. It must be %s. Received %s", range, received);
  scr_throw_error_msg_code(SCR_ERR_RANGE, msg, (size_t)n, "ERR_OUT_OF_RANGE");
  free(received);
  free(msg);
  return false;
}

ScrBigInt *scr_bigint_buffer_read(ScrBytes *bytes, double offset, bool sign, bool le) {
  uint64_t value;
  if (!scr_bytes_read_u64_raw(bytes, offset, le, &value)) return NULL;
  return bi_from_u64_signed(value, sign);
}

double scr_bigint_buffer_write(ScrBytes *bytes, ScrBigInt *value, double offset, bool sign, bool le) {
  uint64_t raw;
  if (!bi_buffer_value(value, sign, &raw)) return 0;
  if (!scr_bytes_write_u64_raw(bytes, offset, le, raw)) return 0;
  return offset + 8;
}

ScrBigInt *scr_bigint_dataview_get(ScrBytes *bytes, double offset, bool sign, bool le) {
  uint64_t value;
  if (!scr_dataview_read_u64_raw(bytes, offset, le, &value)) return NULL;
  return bi_from_u64_signed(value, sign);
}

void scr_bigint_dataview_set(ScrBytes *bytes, double offset, ScrBigInt *value, bool le) {
  (void)scr_dataview_write_u64_raw(bytes, offset, le, scr_bigint_to_u64(value));
}
