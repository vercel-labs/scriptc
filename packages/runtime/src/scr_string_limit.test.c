/* Node's maximum string length on every string-growth path. The limit is
 * forced small (-DSCR_STR_MAX_UNITS=64) so each builder crosses it with a
 * handful of bytes: the builder throws Node's catchable RangeError "Invalid
 * string length", hands the empty string back, and never traps. Prints one
 * line per check; the runner compares the output byte for byte. */
#include "scr_runtime.h"

#include <stdio.h>
#include <string.h>

static int failures;

static ScrStr *bytes_of(const char *text, size_t n) { return scr_str_new(text, n); }

/* The pending exception must be Node's RangeError with its message, and the
 * builder must have returned the empty string. */
static void check_range(const char *what, ScrStr *result) {
  ScrExcCell *cell = scr_exc_current_cell();
  bool ok = result != NULL && result->len == 0 && scr_exc_pending() && cell->kind == SCR_EXC_OBJ;
  if (ok) {
    ScrError *e = (ScrError *)cell->payload;
    ok = e->name != NULL && strcmp(e->name->data, "RangeError") == 0 && e->message != NULL &&
         strcmp(e->message->data, "Invalid string length") == 0;
  }
  printf("%s: %s\n", what, ok ? "RangeError" : "FAILED");
  if (!ok) failures++;
  if (scr_exc_pending()) scr_exc_clear();
  scr_str_release(result);
}

/* Inside the limit the same builder answers a string with no exception. */
static void check_fits(const char *what, ScrStr *result, size_t len) {
  bool ok = result != NULL && result->len == len && !scr_exc_pending();
  printf("%s: %s\n", what, ok ? "ok" : "FAILED");
  if (!ok) failures++;
  if (scr_exc_pending()) scr_exc_clear();
  scr_str_release(result);
}

int main(void) {
  ScrStr *a40 = bytes_of("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", 40);
  ScrStr *a60 = bytes_of("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", 60);
  ScrStr *a20 = bytes_of("aaaaaaaaaaaaaaaaaaaa", 20);
  ScrStr *sep = bytes_of("a", 1);

  check_fits("concat fits", scr_str_concat(a20, a20), 40);
  check_range("concat", scr_str_concat(a40, a40));
  check_range("concat move", scr_str_concat_move(scr_str_retain(a40), a40));

  ScrStr *parts[2] = {a40, a40};
  const double nums[2] = {0, 0};
  check_range("concat parts", scr_str_concat_parts(parts, 2));
  check_range("concat mixed", scr_str_concat_mixed(NULL, parts, nums, 2));
  check_range("concat mixed move", scr_str_concat_mixed_move(scr_str_retain(a40), parts, nums, 2));
  check_range("growth check", (scr_str_growth_check2(a40, a40), scr_str_empty_value()));
  check_range("growth check parts",
              (scr_str_growth_check_parts(NULL, parts, nums, 2), scr_str_empty_value()));
  check_range("growth check add",
              (scr_str_growth_check_add(a60, 8), scr_str_empty_value()));

  check_fits("repeat fits", scr_str_repeat(a20, 3), 60);
  check_range("repeat", scr_str_repeat(a20, 4));
  check_range("repeat huge", scr_str_repeat(a20, 1e15));

  check_fits("pad fits", scr_str_pad_start(a20, 60, sep), 60);
  check_range("padStart", scr_str_pad_start(a20, 65, sep));
  check_range("padEnd", scr_str_pad_end(a20, 1e9, sep));

  /* The JSON builder: a document past the limit throws from its finish, and
   * the buffer it held goes back. */
  {
    ScrJsonBuf b;
    scr_jb_init(&b);
    static const char fill[64] = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    scr_jb_write(&b, fill, sizeof fill);
    scr_jb_write(&b, fill, 1);
    check_range("json builder", scr_jb_finish(&b));
    scr_jb_init(&b);
    scr_jb_write(&b, fill, sizeof fill);
    check_fits("json builder fits", scr_jb_finish(&b), 64);
  }

  /* replace: a replacement that grows the subject past the limit. */
  check_range("replace", scr_str_replace_literal(a60, sep, a60, true));

  scr_str_release(a20);
  scr_str_release(a60);
  scr_str_release(a40);
  scr_str_release(sep);
  if (failures == 0) printf("string limit checks passed\n");
  return failures == 0 ? 0 : 1;
}
