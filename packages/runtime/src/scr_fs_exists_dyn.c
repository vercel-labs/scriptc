/* fs.existsSync with a path value that is not statically a string: a Buffer
 * path, and every value whose type only the runtime knows (`any`).
 *
 * Node's existsSync takes a string, Buffer or URL and answers false for every
 * other value, reporting DEP0187 once. A string path keeps the ordinary
 * scr_fs_exists call; this unit holds the answer for the rest, and lives
 * apart from scr_lib.c so a program whose paths are always strings keeps the
 * historical link line: the report needs scr_async_dyn.c's deprecation flags
 * and warning queue. */
#include "scr_runtime.h"

/* The report is claimed on the first invalid value even while
 * process.noDeprecation suppresses it, exactly Node's deprecate() wrapper: a
 * later call with the flag cleared stays silent. */
static SCR_TL bool scr_fs_exists_dyn_reported = false;

static void scr_fs_exists_dyn_deprecate(void) {
  static const char text[] = "Passing invalid argument types to fs.existsSync is deprecated";
  ScrStr *message = scr_str_new(text, sizeof text - 1);
  ScrStr *code = scr_str_new("DEP0187", 7);
  ScrDyn *warning = scr_warning_new(message, "DeprecationWarning", code);
  scr_warning_emit_deferred(warning);
  scr_dyn_release(warning);
  scr_str_release(code);
  scr_str_release(message);
}

bool scr_fs_exists_value(ScrDyn *value) {
  if (value->kind == SCR_DYN_STR) return scr_fs_exists(value->v.str);
  if (scr_dyn_bytes_is(value, SCR_BYTES_U8)) {
    ScrBytes *bytes = value->v.bytes;
    ScrStr *path = scr_bytes_string(bytes, 0, bytes->len);
    bool found = scr_fs_exists(path);
    scr_str_release(path);
    return found;
  }
  if (!scr_fs_exists_dyn_reported) {
    scr_fs_exists_dyn_reported = true;
    scr_fs_exists_dyn_deprecate();
  }
  return false;
}
