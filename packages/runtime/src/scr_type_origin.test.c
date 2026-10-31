/* Built by scr_type_origin.test.ts: a pending TypeError gains the
 * declaration note for an origin whose package name and selector carry
 * shell syntax; the test runs the suggested command through sh. */
#include "scr_runtime.h"

#include <stdio.h>
#include <string.h>

int main(int argc, char **argv) {
  if (argc != 3) return 2;
  /* package, version, range, selector, where, declared type */
  char origin[1024];
  snprintf(origin, sizeof origin, "%s\x1f" "1.0.0\x1f^1.0.0\x1f%s\x1findex.d.ts:3\x1fstring", argv[1],
           argv[2]);
  const char *text = "expected string at $, got undefined";
  ScrExcCell *cell = scr_exc_current_cell();
  cell->kind = SCR_EXC_OBJ;
  cell->payload = scr_error_new(SCR_ERR_TYPE, scr_str_new(text, strlen(text)));
  scr_type_origin_note(origin);
  ScrError *e = cell->payload;
  fwrite(e->message->data, 1, e->message->len, stdout);
  fputc('\n', stdout);
  return 0;
}
