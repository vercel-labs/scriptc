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
 * An empty list is the file itself, with no warning. A list is empty by its
 * length, and Array.prototype.join reads a hole as the empty string, so a
 * sparse list still warns and each hole leaves its separator in the line
 * (`["a", , "b"]` runs `file a  b`). Borrows both; +1. */
ScrStr *scr_child_shell_line(ScrStr *file, ScrArr *args) {
  size_t n = (size_t)scr_arr_len(args);
  if (n == 0) return scr_str_retain(file);
  scr_child_shell_args_warn();
  size_t len = file->len;
  for (size_t i = 0; i < n; i++) {
    /* Borrowed, NULL for a hole: the array's reference keeps it alive. */
    const ScrStr *arg = scr_arr_peek_ref(args, (double)i);
    len += 1 + (arg != NULL ? arg->len : 0);
  }
  char *line = malloc(len > 0 ? len : 1);
  if (!line) {
    fputs("scriptc: out of memory\n", stderr);
    abort();
  }
  size_t at = file->len;
  memcpy(line, file->data, file->len);
  for (size_t i = 0; i < n; i++) {
    const ScrStr *arg = scr_arr_peek_ref(args, (double)i);
    line[at++] = ' ';
    if (arg == NULL) continue;
    memcpy(line + at, arg->data, arg->len);
    at += arg->len;
  }
  ScrStr *joined = scr_str_new(line, len);
  free(line);
  return joined;
}

/* cp.checkShellArgs: cp.checkArgs for a launch that may join its arguments
 * into a shell line. Node's validateArgumentsNullCheck reads a hole as
 * undefined, which is not a string with a NUL, and the join above reads it
 * as the empty string; scr_child_check_args reads every element as a
 * string. So a sparse list is checked through a dense copy whose holes are
 * empty strings, which keeps each argument's index for the error's name.
 * Borrows all its arguments. */
void scr_child_shell_check_args(double form, ScrStr *cmd, ScrArr *args, ScrArr *env_pairs,
                                ScrStr *cwd) {
  size_t n = (size_t)scr_arr_len(args);
  size_t dense = 0;
  while (dense < n && scr_arr_peek_ref(args, (double)dense) != NULL) dense++;
  if (dense == n) {
    scr_child_check_args(form, cmd, args, env_pairs, cwd);
    return;
  }
  ScrArr *filled = scr_arr_new(SCR_ELEM_STR, n);
  for (size_t i = 0; i < n; i++) {
    ScrStr *arg = (ScrStr *)scr_arr_peek_ref(args, (double)i);
    scr_arr_push_ref(filled, arg != NULL ? scr_str_retain(arg) : scr_str_empty_value());
  }
  scr_child_check_args(form, cmd, filled, env_pairs, cwd);
  scr_arr_release(filled);
}
