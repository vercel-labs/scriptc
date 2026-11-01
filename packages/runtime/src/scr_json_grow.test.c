/* Growing a string that holds the allocator window's blocks and the
 * system allocator's, where the platform reports no usable size for the
 * latter (scr_alloc.c's scr_mem_realloc_ref, scr_json.c's scr_jb_finish).
 * The bytes already written stay. Built for the musl lane with a window
 * small enough for the test to leave it. Prints one line per check. */
#include "scr_runtime.h"

#include <stdio.h>
#include <string.h>

/* Whether p lies in the allocator window (any owner). */
static bool in_window(const void *p) { return (uintptr_t)p - scr_sa.base < scr_sa.span; }

static bool all_bytes(const char *p, size_t n, char c) {
  for (size_t i = 0; i < n; i++)
    if (p[i] != c) return false;
  return true;
}

int main(void) {
  /* A block the window cannot serve is the system allocator's: growing it
   * keeps the bytes it holds. */
  enum { N = 8 << 20, M = 16 << 20 };
  char *p = scr_mem_alloc_ref(N);
  if (!p) {
    printf("out of memory\n");
    return 1;
  }
  printf("block source: %s\n", in_window(p) ? "window" : "system");
  memset(p, 'a', N);
  p = scr_mem_realloc_ref(p, M);
  printf("grown block kept: %s\n", p && all_bytes(p, N, 'a') ? "yes" : "no");
  if (p) scr_mem_free(p);

  /* JSON output whose buffer leaves the window while it grows: the written
   * text is intact, with no bytes the growth did not set. */
  ScrJsonBuf b;
  scr_jb_init(&b);
  static char fill[1 << 20];
  memset(fill, 'a', sizeof fill);
  for (int i = 0; i < 10; i++) scr_jb_write(&b, fill, sizeof fill);
  ScrStr *s = scr_jb_finish(&b);
  printf("json output: %zu bytes, %s\n", s->len, s->len == 10u * sizeof fill && all_bytes(s->data, s->len, 'a')
                                                         ? "intact"
                                                         : "broken");
  scr_str_release(s);
  return 0;
}
