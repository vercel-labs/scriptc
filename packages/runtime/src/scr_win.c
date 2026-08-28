/* win32 libc shims — the POSIX/BSD functions the runtime calls that
 * mingw-w64's CRT does not provide (declared in scr_runtime.h's _WIN32
 * block). Compiled into win32-target builds only (native-toolchain.ts adds this TU and
 * -ladvapi32 for windows triples); an empty TU anywhere else, so POSIX
 * builds cannot change by a byte. */
#ifdef _WIN32

#include "scr_runtime.h"

#include <ctype.h>
#include <stdio.h>
#include <stdlib.h>
#include <time.h>
#include <windows.h>

/* POSIX.1-2008 stpcpy: strcpy returning the END of the copy — scr_number.c
 * (untouchable by project rule; ryu-adjacent) builds "e+"/"e-" exponent
 * tails with it. */
char *stpcpy(char *dst, const char *src) {
  size_t n = strlen(src);
  memcpy(dst, src, n + 1);
  return dst + n;
}

/* arc4random_buf over RtlGenRandom (advapi32's SystemFunction036) — the
 * kernel CSPRNG behind rand_s and BCryptGenRandom, available everywhere
 * without a bcrypt link. Failure aborts: like the BSD/glibc original, the
 * callers (Math.random, crypto.randomUUID/randomBytes) have no error arm
 * and returning predictable bytes is never acceptable. */
BOOLEAN NTAPI SystemFunction036(PVOID buffer, ULONG length);

void arc4random_buf(void *buf, size_t n) {
  unsigned char *p = buf;
  while (n > 0) {
    ULONG step = n > 0x7fffffffUL ? 0x7fffffffUL : (ULONG)n;
    if (!SystemFunction036(p, step)) {
      fputs("scriptc: RtlGenRandom failed\n", stderr);
      abort();
    }
    p += step;
    n -= step;
  }
}

/* POSIX gmtime_r: the win32 CRT's gmtime already answers from per-thread
 * storage, so the reentrant spelling is a copy-out (scr_http.c's Date
 * header formatter is the caller). */
struct tm *gmtime_r(const time_t *t, struct tm *out) {
  struct tm *g = gmtime(t);
  if (g == NULL) return NULL;
  *out = *g;
  return out;
}

/* GNU/BSD strcasestr — scr_http.c's Connection-token scan. Naive
 * quadratic scan like the musl original; header values are tiny. */
char *strcasestr(const char *hay, const char *needle) {
  size_t n = strlen(needle);
  if (n == 0) return (char *)hay;
  for (; *hay != '\0'; hay++) {
    size_t i = 0;
    while (i < n && hay[i] != '\0' &&
           tolower((unsigned char)hay[i]) == tolower((unsigned char)needle[i]))
      i++;
    if (i == n) return (char *)hay;
  }
  return NULL;
}

#else /* !_WIN32 */

/* Empty TU off-Windows: native-toolchain.ts only compiles this file for windows triples,
 * but an accidental link elsewhere must stay harmless. */
typedef int scr_win_unused;

#endif /* _WIN32 */
