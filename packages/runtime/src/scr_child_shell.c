/* child_process — the shell command line of a call that passes separate
 * arguments together with `shell: true`.
 *
 * Node's normalizeSpawnArguments (lib/child_process.js) runs such a call as
 * `file + " " + args.join(" ")` through the shell: the arguments are
 * concatenated, never escaped. The first call of the process that does so
 * with a non-empty list reports DEP0190 through process.emitWarning, and
 * every later one stays silent (the module's emittedDEP0190Already).
 *
 * A separate runtime unit, selected only by programs that name its entry
 * (the compiler's childShellLine feature), so an executable that does not
 * keeps byte-identical code from scr_child.c: adding a function there
 * changes that unit's `.eh_frame` contribution, which the linker carries
 * into every program that links it.
 */
#include "scr_runtime.h"
#include "scr_child.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* Node's emittedDEP0190Already: per realm, so per thread here. */
static SCR_TL bool scr_child_shell_args_warned = false;

/* process.emitWarning(message, "DeprecationWarning", "DEP0190"): reported
 * on the next tick, dropped under process.noDeprecation, and thrown from
 * its own tick under process.throwDeprecation. Node sets its flag whether
 * or not the warning was dropped. */
static void scr_child_shell_args_warn(void) {
  if (scr_child_shell_args_warned) return;
  scr_child_shell_args_warned = true;
  static const char text[] =
      "Passing args to a child process with shell option true can lead to security "
      "vulnerabilities, as the arguments are not escaped, only concatenated.";
  ScrStr *message = scr_str_new(text, sizeof text - 1);
  ScrStr *code = scr_str_new("DEP0190", 7);
  ScrDyn *warning = scr_warning_new(message, "DeprecationWarning", code);
  scr_str_release(code);
  scr_str_release(message);
  scr_warning_emit_deferred(warning);
  scr_dyn_release(warning);
}

/* cp.shellLine(file, args): the command line a shell-enabled call runs.
 * An empty list is the file itself, with no warning. Borrows both; +1. */
ScrStr *scr_child_shell_line(ScrStr *file, ScrArr *args) {
  size_t n = (size_t)scr_arr_len(args);
  if (n == 0) return scr_str_retain(file);
  scr_child_shell_args_warn();
  size_t len = file->len;
  for (size_t i = 0; i < n; i++) {
    ScrStr *arg = (ScrStr *)scr_arr_get_ref(args, (double)i);
    len += 1 + arg->len;
    scr_str_release(arg); /* borrow: the array's reference keeps it alive */
  }
  char *line = malloc(len > 0 ? len : 1);
  if (!line) {
    fputs("scriptc: out of memory\n", stderr);
    abort();
  }
  size_t at = file->len;
  memcpy(line, file->data, file->len);
  for (size_t i = 0; i < n; i++) {
    ScrStr *arg = (ScrStr *)scr_arr_get_ref(args, (double)i);
    line[at++] = ' ';
    memcpy(line + at, arg->data, arg->len);
    at += arg->len;
    scr_str_release(arg);
  }
  ScrStr *joined = scr_str_new(line, len);
  free(line);
  return joined;
}
