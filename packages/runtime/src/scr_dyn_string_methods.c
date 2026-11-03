/* String.prototype's trim family as function values.
 *
 * A JavaScript source reading `String.prototype.trim` (or the Annex B
 * trimLeft/trimRight aliases) fell through the checked-dynamic method table,
 * which has no trim entry, and evaluated the prototype object as a string
 * receiver: `expected string at $, got undefined`. This unit answers the
 * three methods as interned functions — one object per name and thread, the
 * way scr_dyn_invoke.c interns the pieces of the table it owns. They live
 * here rather than in that table because editing the invoke unit changes the
 * bytes of every program that links it; this unit links only into programs
 * that read one of these values (the frontend marks
 * dyn.stringMethodValue), so every other executable keeps its exact bytes.
 *
 * The methods are generic exactly as ECMA-262 22.1.3.32-34 define them:
 * RequireObjectCoercible(this), then ToString(this), then the trim. So
 * `trim.call(123)` is "123", an object's toString is observed, and a Symbol
 * is the "Cannot convert a Symbol value to a string" TypeError. Null and
 * undefined are the TypeError Node answers, naming the method.
 *
 * trimLeft IS trimStart and trimRight IS trimEnd (Annex B.2.3.14-15): both
 * spellings are one function object with the standard name and length. The
 * frontend canonicalizes the name before it reaches this unit. */
#include "scr_runtime.h"
#include "scr_dyn_methods.h"

#include <stdio.h>
#include <string.h>

/* The methods, with the `length` every one of them reports. */
static const struct { const char *name; } sm_methods[] = {
  {"trim"},
  {"trimStart"},
  {"trimEnd"},
};

#define SM_COUNT (sizeof sm_methods / sizeof sm_methods[0])

static SCR_TL ScrDyn *sm_values[SM_COUNT];

static void sm_values_cleanup(void) {
  for (size_t i = 0; i < SM_COUNT; i++) {
    scr_dyn_release(sm_values[i]);
    sm_values[i] = NULL;
  }
}

/** One trim method run on its receiver: caps[0] is the canonical name. */
static ScrDyn *sm_method_call(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  (void)args;
  (void)argc;
  ScrStr *method = scr_box_get_ref(closure->caps[0]);
  ScrDyn *receiver = scr_dyn_this_get();
  ScrDyn *result = NULL;
  if (receiver->kind == SCR_DYN_UNDEF || receiver->kind == SCR_DYN_NULL) {
    char message[64];
    snprintf(message, sizeof message, "String.prototype.%s called on null or undefined",
             method->data);
    scr_throw_error_msg(SCR_ERR_TYPE, message, strlen(message));
  } else {
    ScrStr *text = scr_dyn_string_coerce_js(receiver);
    if (text) {
      ScrStr *trimmed = !strcmp(method->data, "trimStart") ? scr_str_trim_start(text)
                        : !strcmp(method->data, "trimEnd") ? scr_str_trim_end(text)
                                                           : scr_str_trim(text);
      scr_str_release(text);
      if (trimmed) {
        result = scr_dyn_new_str(trimmed);
        scr_str_release(trimmed);
      }
    }
  }
  scr_dyn_release(receiver);
  scr_str_release(method);
  return result;
}

/** The method named `name` ("trim", "trimStart" or "trimEnd", the
 * canonical spellings the frontend emits) as an interned function; +1. */
ScrDyn *scr_dyn_string_method_value(const ScrStr *name) {
  size_t index = SM_COUNT;
  for (size_t i = 0; i < SM_COUNT; i++) {
    if (!strcmp(sm_methods[i].name, name->data)) {
      index = i;
      break;
    }
  }
  if (index == SM_COUNT) {
    /* The frontend marks only the names above; a fourth name is a compiler
     * bug rather than a program's mistake. */
    fprintf(stderr, "scriptc: invalid string trim method name\n");
    abort();
  }
  ScrDyn **slot = &sm_values[index];
  if (*slot) return scr_dyn_retain(*slot);
  ScrStr *method = scr_str_new(sm_methods[index].name, strlen(sm_methods[index].name));
  ScrClosure *closure = scr_closure_new(NULL, 1);
  closure->caps[0] = scr_box_new(SCR_BOX_STR);
  scr_box_set_ref(closure->caps[0], scr_str_retain(method));
  ScrDyn *value =
    scr_dyn_new_func(closure, sm_method_call, 0, "native:String.prototype", method->data);
  scr_str_release(method);
  *slot = value;
  scr_atexit(sm_values_cleanup);
  return scr_dyn_retain(value);
}
