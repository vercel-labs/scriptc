/* The JSON builder's growth policy and a string's escape from the allocator
 * window. Built with a small window (-DSCR_SA_WINDOW_TEST_CHUNKS=1) and a
 * small policy (-DSCR_JB_GEOMETRIC_MAX/-DSCR_JB_STEP): doubling below the
 * policy bound and fixed steps above it, and a program that requires the
 * window (scr_sa_require_window, a compact-reference program) still builds a
 * string larger than the window, with the block outside it and every byte
 * kept. Prints one line per check. */
#include "scr_runtime.h"

#include <stdio.h>
#include <string.h>

static int failures;

static void check(const char *what, bool ok) {
  printf("%s: %s\n", what, ok ? "ok" : "FAILED");
  if (!ok) failures++;
}

static bool in_window(const void *p) { return (uintptr_t)p - scr_sa.base < scr_sa.span; }

static bool all_bytes(const char *p, size_t n, char c) {
  for (size_t i = 0; i < n; i++)
    if (p[i] != c) return false;
  return true;
}

int main(void) {
  /* Doubling below the policy bound, fixed steps above it, and no request
   * larger than what the append needs at the boundary. */
  {
    ScrJsonBuf b;
    scr_jb_init(&b);
    static char text[64];
    memset(text, 'a', sizeof text);
    scr_jb_write(&b, text, sizeof text); /* first allocation: 64 */
    check("first cap", b.cap == 64 && b.len == 64);
    for (size_t i = 0; i < 4032; i++) scr_jb_putc(&b, 'a'); /* doubling to 4096 */
    check("geometric cap", b.cap == 4096 && b.len == 4096);
    scr_jb_putc(&b, 'a'); /* the policy bound: one 4096 step */
    check("step cap", b.cap == 8192 && b.len == 4097);
    static char big[3 << 20];
    memset(big, 'b', sizeof big);
    scr_jb_write(&b, big, sizeof big); /* one 3 MiB append: fixed steps */
    size_t required = 4097 + sizeof big;
    check("one big append", b.cap >= required && b.cap - required < 4096);
    ScrStr *s = scr_jb_finish(&b);
    check("document intact", s->len == required && all_bytes(s->data, 4097, 'a') &&
                                 all_bytes(s->data + 4097, sizeof big, 'b'));
    scr_str_release(s);
  }

  /* A program whose compact classes keep references in 32-bit fields: the
   * window is required, and a string past the window still builds, its
   * block in the system allocator, grown and freed by address. A string is
   * never such a field's target (emitter.ts windowRefType), which makes the
   * fallback sound. */
  scr_sa_require_window();
  {
    enum { N = 6 << 20, M = 9 << 20 };
    ScrStr *s = scr_str_alloc_raw(0, N);
    check("string leaves the window", !in_window(s));
    memset(s->data, 'x', N);
    s->len = N;
    s = scr_str_regrow(s, M);
    check("grown past the window", !in_window(s) && s->len == N && all_bytes(s->data, N, 'x'));
    memset(s->data + N, 'y', M - N);
    s->len = M;
    s->data[M] = '\0';
    scr_str_release(s);

    /* The same through the JSON builder: a document past the window. */
    ScrJsonBuf b;
    scr_jb_init(&b);
    static char fill[1 << 20];
    memset(fill, 'z', sizeof fill);
    for (int i = 0; i < 6; i++) scr_jb_write(&b, fill, sizeof fill);
    ScrStr *doc = scr_jb_finish(&b);
    check("json past the window", doc->len == 6u << 20 && all_bytes(doc->data, doc->len, 'z'));
    scr_str_release(doc);
  }

  if (failures == 0) printf("json growth checks passed\n");
  return failures == 0 ? 0 : 1;
}
