/* The string spares.
 *
 * scr_str_release keeps one released block per size class per thread: a
 * block of 512 bytes or more, up to SCR_STR_SPARE_MAX, in the small spare,
 * and one block over that limit in the large spare until the thread's next
 * string allocation. An allocation near the large block's size reuses it;
 * an allocation the small spare satisfies does not, and it must free the
 * large block rather than pin it. Both spares go back when the thread's
 * cleanup runs, which is process exit here: this test registers its own
 * exit handler before any spare exists, so it runs after the runtime's and
 * can see what that one left behind.
 *
 * Built without SCR_RC_AUDIT, which compiles the spares out.
 *
 * Exit 0 = all pass; prints each failure and exits 1 otherwise.
 */
#include "../src/scr_runtime.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifdef SCR_STR_TEST
size_t scr_str_test_large_spare_bytes(void);
size_t scr_str_test_small_spare_bytes(void);
#endif

#define SMALL 1024u
#define LARGE (2u << 20) /* over SCR_STR_SPARE_MAX */

static int failed;

static void check(bool condition, const char *message) {
  if (condition) return;
  fprintf(stderr, "string spare test failed: %s\n", message);
  failed++;
}

/* Runs after the runtime's cleanup, which registered later. */
static void at_exit_check(void) {
  size_t large = scr_str_test_large_spare_bytes(), small = scr_str_test_small_spare_bytes();
  if (large != 0 || small != 0) {
    fprintf(stderr, "string spare test failed: the exit cleanup left %zu large-spare bytes, "
                    "%zu small-spare bytes\n",
            large, small);
    _Exit(EXIT_FAILURE);
  }
  fputs("exit cleanup freed the spares\n", stderr);
}

static char *filled(char fill, size_t len) {
  char *buf = malloc(len + 1);
  if (!buf) {
    fputs("string spare test: out of memory\n", stderr);
    exit(EXIT_FAILURE);
  }
  memset(buf, fill, len);
  buf[len] = '\0';
  return buf;
}

int main(void) {
  atexit(at_exit_check);
  char *smallbuf = filled('a', SMALL);
  char *largebuf = filled('b', LARGE);
  ScrStr *small = scr_str_new(smallbuf, SMALL);
  scr_str_release(small); /* small spare */
  ScrStr *large = scr_str_new(largebuf, LARGE);
  scr_str_release(large); /* large spare */

  check(scr_str_test_large_spare_bytes() >= LARGE, "a released large block is kept");

  /* The next allocation of about the same size reuses it. */
  ScrStr *same = scr_str_alloc_raw(LARGE, LARGE);
  check(same == large, "the large spare supplies an allocation of its size");
  check(scr_str_test_large_spare_bytes() == 0, "a large-spare reuse empties the large spare");
  scr_str_release(same); /* large spare again */

  /* An allocation the small spare satisfies is not a reuse of the large
   * block, so the large spare is freed instead of staying resident. */
  ScrStr *next = scr_str_alloc_raw(SMALL, SMALL);
  check(next == small, "the small spare supplies an allocation of its size");
  check(scr_str_test_large_spare_bytes() == 0, "a small-spare reuse frees the large spare");
  scr_str_release(next); /* small spare again */

  /* A block still held when the process ends is freed by the cleanup. */
  ScrStr *held = scr_str_new(largebuf, LARGE);
  scr_str_release(held); /* large spare */
  check(scr_str_test_large_spare_bytes() >= LARGE, "the large block is kept until the process ends");

  free(smallbuf);
  free(largebuf);
  if (failed) {
    fprintf(stderr, "%d string spare checks failed\n", failed);
    return 1;
  }
  fputs("string spare checks passed\n", stderr);
  return 0;
}
