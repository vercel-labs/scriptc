/* Memory and string routines for the x86_64 musl lane (scr_musl.c).
 *
 * The musl lane links zig's libc, whose memset, memcmp, bcmp and strlen are
 * byte loops and whose memcpy and memmove use no string instructions. These
 * are SSE2 (the x86_64 baseline) for short and medium lengths and
 * `rep stosb` / `rep movsb` from SCR_MUSL_MEM_REP bytes, the length from
 * which those instructions are fast on CPUs with ERMS.
 *
 * The functions are prefixed so that the test (scr_musl_mem.test.c) can
 * compile them on any x86_64 host; scr_musl.c defines the libc names over
 * them. Each is built without builtins: the compiler must not turn their
 * loops back into calls to the functions they implement. */
#ifndef SCR_MUSL_MEM_H
#define SCR_MUSL_MEM_H

#include <emmintrin.h>
#include <stddef.h>
#include <stdint.h>

#define SCR_MUSL_MEM_REP ((size_t)2048)
#define SCR_MUSL_MEM_FN static inline __attribute__((no_builtin, always_inline))

typedef uint64_t scr_musl_u64u __attribute__((aligned(1), may_alias));
typedef uint32_t scr_musl_u32u __attribute__((aligned(1), may_alias));
typedef uint16_t scr_musl_u16u __attribute__((aligned(1), may_alias));

SCR_MUSL_MEM_FN void *scr_musl_memset(void *dst, int c, size_t n) {
  unsigned char *d = (unsigned char *)dst;
  uint64_t v = 0x0101010101010101ull * (unsigned char)c;
  if (n < 16) {
    if (n >= 8) {
      *(scr_musl_u64u *)d = v;
      *(scr_musl_u64u *)(d + n - 8) = v;
    } else if (n >= 4) {
      *(scr_musl_u32u *)d = (uint32_t)v;
      *(scr_musl_u32u *)(d + n - 4) = (uint32_t)v;
    } else if (n > 0) {
      d[0] = (unsigned char)c;
      d[n - 1] = (unsigned char)c;
      if (n == 3) d[1] = (unsigned char)c;
    }
    return dst;
  }
  if (n >= SCR_MUSL_MEM_REP) {
    __asm__ volatile("rep stosb" : "+D"(d), "+c"(n) : "a"(c) : "memory");
    return dst;
  }
  __m128i x = _mm_set1_epi8((char)c);
  _mm_storeu_si128((__m128i *)d, x);
  _mm_storeu_si128((__m128i *)(d + n - 16), x);
  /* Aligned stores between the two overlapping edge stores. */
  unsigned char *p = (unsigned char *)(((uintptr_t)d + 16) & ~(uintptr_t)15);
  for (unsigned char *end = d + n - 16; p < end; p += 16) _mm_store_si128((__m128i *)p, x);
  return dst;
}

/* Up to 32 bytes: every load happens before any store, so any overlap is
 * safe (memmove uses this too). */
SCR_MUSL_MEM_FN void scr_musl_copy_short(unsigned char *d, const unsigned char *s, size_t n) {
  if (n >= 16) {
    __m128i a = _mm_loadu_si128((const __m128i *)s);
    __m128i b = _mm_loadu_si128((const __m128i *)(s + n - 16));
    _mm_storeu_si128((__m128i *)d, a);
    _mm_storeu_si128((__m128i *)(d + n - 16), b);
  } else if (n >= 8) {
    uint64_t a = *(const scr_musl_u64u *)s, b = *(const scr_musl_u64u *)(s + n - 8);
    *(scr_musl_u64u *)d = a;
    *(scr_musl_u64u *)(d + n - 8) = b;
  } else if (n >= 4) {
    uint32_t a = *(const scr_musl_u32u *)s, b = *(const scr_musl_u32u *)(s + n - 4);
    *(scr_musl_u32u *)d = a;
    *(scr_musl_u32u *)(d + n - 4) = b;
  } else if (n >= 2) {
    uint16_t a = *(const scr_musl_u16u *)s, b = *(const scr_musl_u16u *)(s + n - 2);
    *(scr_musl_u16u *)d = a;
    *(scr_musl_u16u *)(d + n - 2) = b;
  } else if (n == 1) {
    d[0] = s[0];
  }
}

/* More than 32 bytes, forwards: the first and last 16 bytes are loaded
 * before the loop and stored after it, and the loop stores to aligned
 * destination blocks in between. Safe when the destination does not start
 * inside the source (memcpy, and memmove with d before s). */
SCR_MUSL_MEM_FN void scr_musl_copy_forward(unsigned char *d, const unsigned char *s, size_t n) {
  __m128i head = _mm_loadu_si128((const __m128i *)s);
  __m128i tail = _mm_loadu_si128((const __m128i *)(s + n - 16));
  for (size_t i = 16 - ((uintptr_t)d & 15); i < n - 16; i += 16)
    _mm_store_si128((__m128i *)(d + i), _mm_loadu_si128((const __m128i *)(s + i)));
  _mm_storeu_si128((__m128i *)d, head);
  _mm_storeu_si128((__m128i *)(d + n - 16), tail);
}

SCR_MUSL_MEM_FN void *scr_musl_memcpy(void *__restrict dst, const void *__restrict src, size_t n) {
  unsigned char *d = (unsigned char *)dst;
  const unsigned char *s = (const unsigned char *)src;
  if (n <= 32) {
    scr_musl_copy_short(d, s, n);
  } else if (n >= SCR_MUSL_MEM_REP) {
    __asm__ volatile("rep movsb" : "+D"(d), "+S"(s), "+c"(n) : : "memory");
  } else {
    scr_musl_copy_forward(d, s, n);
  }
  return dst;
}

SCR_MUSL_MEM_FN void *scr_musl_memmove(void *dst, const void *src, size_t n) {
  unsigned char *d = (unsigned char *)dst;
  const unsigned char *s = (const unsigned char *)src;
  if (n <= 32) {
    scr_musl_copy_short(d, s, n);
    return dst;
  }
  /* The destination does not start inside the source: copy forwards. */
  if ((uintptr_t)d - (uintptr_t)s >= n) {
    if (n >= SCR_MUSL_MEM_REP) {
      __asm__ volatile("rep movsb" : "+D"(d), "+S"(s), "+c"(n) : : "memory");
    } else {
      scr_musl_copy_forward(d, s, n);
    }
    return dst;
  }
  /* The destination starts inside the source: copy backwards, from the
   * last aligned destination block down, with the edges loaded first. */
  __m128i head = _mm_loadu_si128((const __m128i *)s);
  __m128i tail = _mm_loadu_si128((const __m128i *)(s + n - 16));
  for (ptrdiff_t j = (ptrdiff_t)((((uintptr_t)d + n - 16) & ~(uintptr_t)15) - (uintptr_t)d); j > 0;
       j -= 16)
    _mm_store_si128((__m128i *)(d + j), _mm_loadu_si128((const __m128i *)(s + j)));
  _mm_storeu_si128((__m128i *)(d + n - 16), tail);
  _mm_storeu_si128((__m128i *)d, head);
  return dst;
}

SCR_MUSL_MEM_FN int scr_musl_memcmp(const void *left, const void *right, size_t n) {
  const unsigned char *a = (const unsigned char *)left, *b = (const unsigned char *)right;
  if (n < 16) {
    for (size_t i = 0; i < n; i++)
      if (a[i] != b[i]) return (int)a[i] - (int)b[i];
    return 0;
  }
  /* 16-byte blocks, then one last block ending at n (it may overlap the
   * previous one, whose bytes are equal). */
  for (size_t i = 0;; i += 16) {
    if (i > n - 16) i = n - 16;
    __m128i x = _mm_loadu_si128((const __m128i *)(a + i));
    __m128i y = _mm_loadu_si128((const __m128i *)(b + i));
    unsigned diff = (unsigned)_mm_movemask_epi8(_mm_cmpeq_epi8(x, y)) ^ 0xffffu;
    if (diff != 0) {
      size_t k = i + (size_t)__builtin_ctz(diff);
      return (int)a[k] - (int)b[k];
    }
    if (i == n - 16) return 0;
  }
}

/* Aligned 16-byte loads never cross a page, so reading a whole block that
 * holds the terminator is safe; the bytes before the string are masked off. */
__attribute__((no_sanitize("address")))
SCR_MUSL_MEM_FN size_t scr_musl_strlen(const char *str) {
  const char *p = (const char *)((uintptr_t)str & ~(uintptr_t)15);
  __m128i zero = _mm_setzero_si128();
  unsigned mask = (unsigned)_mm_movemask_epi8(_mm_cmpeq_epi8(_mm_load_si128((const __m128i *)p), zero));
  mask >>= (uintptr_t)str & 15;
  if (mask != 0) return (size_t)__builtin_ctz(mask);
  for (;;) {
    p += 16;
    mask = (unsigned)_mm_movemask_epi8(_mm_cmpeq_epi8(_mm_load_si128((const __m128i *)p), zero));
    if (mask != 0) return (size_t)(p - str) + (size_t)__builtin_ctz(mask);
  }
}

#endif /* SCR_MUSL_MEM_H */
