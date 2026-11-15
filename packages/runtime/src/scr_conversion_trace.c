/* The report of failed checked conversions, linked only by executables
 * built with `--optimization dev` and without `--strip` (runtime feature
 * conversionTrace).
 *
 * A checked conversion throws a TypeError when a value does not have the
 * type the program gives it, where Node.js checks nothing. A program that
 * catches that TypeError without looking at it takes another path than it
 * does under Node.js, and nothing says why. In a dev build the cold
 * exception path of every checked conversion calls scr_conversion_trace
 * with the conversion's source position, as a stack frame line (the
 * compiler's frame-positions.ts writes both). With
 * SCRIPTC_CONVERSION_TRACE set in the environment, the pending TypeError
 * and that line go to stderr at the moment the conversion fails, whether
 * or not the program catches the error afterwards:
 *
 *   scriptc: checked conversion failed: TypeError: expected number at $.usage.total, got undefined
 *       at parse (/app/src/log.ts:17:12)
 *
 * The variable is read when the first conversion fails, so a program that
 * never fails one does no work for it, at start-up or later. Unset, empty
 * and "0" turn the report off. The error is left pending and unchanged. */
#include "scr_runtime.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

void scr_conversion_trace(const char *where) {
  /* Per thread, so worker threads that fail their first conversions at
   * the same time share nothing: each reads the environment once. */
  static SCR_TL int tracing = -1;
  if (tracing < 0) {
    const char *t = getenv("SCRIPTC_CONVERSION_TRACE");
    tracing = t != NULL && *t != 0 && strcmp(t, "0") != 0;
  }
  if (!tracing) return;
  ScrExcCell *cell = scr_exc_current_cell();
  /* A conversion fails with a TypeError. The cold path also runs for what
   * else can be pending there: the SyntaxError of a JSON.parse fused into
   * the conversion, an error a Node island raised while it was read. */
  if (cell->kind != SCR_EXC_OBJ || cell->payload == NULL || !scr_error_is(cell->payload)) return;
  ScrError *e = (ScrError *)cell->payload;
  if (e->vt != &scr_error_vts[SCR_ERR_TYPE]) return;
  ScrStr *text = scr_error_to_string(e);
  /* Keep the report after what the program already wrote to stdout. */
  scr_stdout_settle();
  fflush(stdout);
  fputs("scriptc: checked conversion failed: ", stderr);
  fwrite(text->data, 1, text->len, stderr);
  fputc('\n', stderr);
  fputs(where, stderr);
  fputc('\n', stderr);
  fflush(stderr);
  scr_str_release(text);
}
