/* win32 libc shims — the POSIX/BSD functions the runtime calls that
 * mingw-w64's CRT does not provide (declared in scr_runtime.h's _WIN32
 * block). Compiled into win32-target builds only (cc.ts adds this TU and
 * -ladvapi32 for windows triples); an empty TU anywhere else, so POSIX
 * builds cannot change by a byte. */
#ifdef _WIN32

#include "scr_runtime.h"

#include <ctype.h>
#include <stdio.h>
#include <stdlib.h>
#include <time.h>
#include <windows.h>

/* ── MSVC POSIX shims ────────────────────────────────────────────────
 * mingw-w64 provides POSIX headers/functions (unistd.h, dirent.h,
 * clock_gettime, nanosleep). MSVC's CRT does not — these shims
 * bridge the gap so the runtime compiles under both toolchains. */
#ifdef _MSC_VER

#ifndef CLOCK_REALTIME
#define CLOCK_REALTIME 0
#endif
#ifndef CLOCK_MONOTONIC
#define CLOCK_MONOTONIC 1
#endif

int clock_gettime(int clk_id, struct timespec *ts) {
  (void)clk_id;
  /* QueryPerformanceCounter is the only high-res monotonic clock on
   * Windows; its epoch is arbitrary but monotonic — sufficient for
   * elapsed-time measurements.  For CLOCK_REALTIME we use
   * GetSystemTimeAsFileTime which is UTC since 1601. */
  if (clk_id == CLOCK_REALTIME) {
    FILETIME ft;
    GetSystemTimeAsFileTime(&ft);
    ULARGE_INTEGER li;
    li.LowPart = ft.dwLowDateTime;
    li.HighPart = ft.dwHighDateTime;
    /* FILETIME is 100-ns intervals since 1601-01-01.
     * Unix epoch offset: 11644473600 seconds = 116444736000000000 * 100ns. */
    li.QuadPart -= 116444736000000000ULL;
    ts->tv_sec  = (time_t)(li.QuadPart / 10000000ULL);
    ts->tv_nsec = (long)((li.QuadPart % 10000000ULL) * 100);
    return 0;
  }
  /* CLOCK_MONOTONIC — QueryPerformanceCounter. */
  static LARGE_INTEGER freq = {0};
  if (freq.QuadPart == 0) QueryPerformanceFrequency(&freq);
  LARGE_INTEGER now;
  QueryPerformanceCounter(&now);
  ts->tv_sec  = (time_t)(now.QuadPart / freq.QuadPart);
  ts->tv_nsec = (long)((now.QuadPart % freq.QuadPart) * 1000000000LL / freq.QuadPart);
  return 0;
}

int nanosleep(const struct timespec *req, struct timespec *rem) {
  if (rem) { rem->tv_sec = 0; rem->tv_nsec = 0; }
  /* Sleep takes milliseconds; ceil to avoid sleeping too short. */
  DWORD ms = (DWORD)(req->tv_sec * 1000 + (req->tv_nsec + 999999) / 1000000);
  if (ms == 0) ms = 1; /* Sleep(0) yields the timeslice */
  Sleep(ms);
  return 0;
}

/* Minimal <dirent.h> shim for MSVC — provides opendir/readdir/closedir
 * and the d_type constants over FindFirstFileW/FindNextFileW.  Enough
 * for scr_lib.c's readdir loops; not a full POSIX emulation. */
#include <wchar.h>

struct dirent {
  char d_name[260];
  unsigned char d_type;
};

enum { DT_REG = 8, DT_DIR = 4 };

typedef struct {
  HANDLE          hFind;
  WIN32_FIND_DATAW fdata;
  struct dirent   entry;
  int             first;
} DIR;

DIR *opendir(const char *path) {
  DIR *d = (DIR *)malloc(sizeof *d);
  if (!d) return NULL;
  /* Build wildcard path: "path\*" */
  wchar_t wpath[MAX_PATH * 2];
  MultiByteToWideChar(CP_UTF8, 0, path, -1, wpath, MAX_PATH);
  wcscat(wpath, L"\\*");
  d->hFind = FindFirstFileW(wpath, &d->fdata);
  d->first = 1;
  if (d->hFind == INVALID_HANDLE_VALUE) { free(d); return NULL; }
  return d;
}

struct dirent *readdir(DIR *d) {
  for (;;) {
    if (d->first) { d->first = 0; }
    else if (!FindNextFileW(d->hFind, &d->fdata)) { return NULL; }
    /* Skip . and .. */
    if (d->fdata.cFileName[0] == L'.' &&
        (d->fdata.cFileName[1] == L'\0' ||
         (d->fdata.cFileName[1] == L'.' && d->fdata.cFileName[2] == L'\0')))
      continue;
    WideCharToMultiByte(CP_UTF8, 0, d->fdata.cFileName, -1,
                        d->entry.d_name, sizeof d->entry.d_name, NULL, NULL);
    d->entry.d_name[sizeof d->entry.d_name - 1] = '\0';
    d->entry.d_type = (d->fdata.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY)
                      ? DT_DIR : DT_REG;
    return &d->entry;
  }
}

int closedir(DIR *d) {
  if (!d) return -1;
  if (d->hFind != INVALID_HANDLE_VALUE) FindClose(d->hFind);
  free(d);
  return 0;
}

#endif /* _MSC_VER */

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

/* Empty TU off-Windows: cc.ts only compiles this file for windows triples,
 * but an accidental link elsewhere must stay harmless. */
typedef int scr_win_unused;

#endif /* _WIN32 */
