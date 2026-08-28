/* util.inspect over island `any` values — the one translation unit that
 * references BOTH the inspect engine (scr_inspect.c) and the island
 * (scr_island.c), so native-toolchain.ts links it exactly when a --dynamic build's IR
 * carries insp.* libCalls (each half alone stays independent: static
 * inspect builds never pull engine symbols, inspect-free dynamic builds
 * never pull the renderer).
 *
 * The runtime tag is all the static world has for `any`: the scalar
 * kinds render byte-exactly (numbers through the -0-aware formatter,
 * strings through the quoting ladder, boolean/null/undefined as their
 * literals); composites — objects, arrays, functions — THROW a catchable
 * TypeError instead of approximating (their shape lives in the engine;
 * SEMANTICS.md). Callers are compiler-emitted pending checks. */
#include "scr_runtime.h"

#include <stdio.h>
#include <string.h>

ScrStr *scr_insp_jsval(ScrJsval *v, double recurse, double depth) {
  (void)recurse;
  (void)depth;
  if (scr_jsval_is_undefined(v)) return scr_str_new("undefined", 9);
  if (scr_jsval_is_nullish(v)) return scr_str_new("null", 4);
  ScrStr *ty = scr_jsval_typeof(v);
  if (ty && strcmp(ty->data, "number") == 0) {
    scr_str_release(ty);
    double x = 0;
    if (!scr_jsval_exit_f64(v, &x)) return NULL; /* typeof proved number */
    return scr_insp_f64(x);
  }
  if (ty && strcmp(ty->data, "string") == 0) {
    scr_str_release(ty);
    ScrStr *s = scr_jsval_exit_str(v);
    if (!s) return NULL;
    ScrStr *out = scr_insp_str(s);
    scr_str_release(s);
    return out;
  }
  if (ty && strcmp(ty->data, "boolean") == 0) {
    scr_str_release(ty);
    return scr_jsval_truthy(v) ? scr_str_new("true", 4) : scr_str_new("false", 5);
  }
  char buf[192];
  int n = snprintf(buf, sizeof buf,
                   "util.inspect of a composite 'any' value (typeof '%s') is not supported "
                   "yet — validate with 'as <type>' first",
                   ty ? ty->data : "unknown");
  if (ty) scr_str_release(ty);
  scr_throw_error_msg(SCR_ERR_TYPE, buf, (size_t)n);
  return NULL;
}
