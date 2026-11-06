/* A CommonJS module's exports object as a checked-dynamic value
 * (cjs-exports-value.ts lowers `const m = require("./m.cjs")` used as a
 * value here). The compiled module system has no reflective exports object:
 * each export is a module global. This unit builds the object a requirer
 * sees when it holds the namespace itself (`exports.CST = cst`), from the
 * module's exported names and a compiled getter that answers an export's
 * current value by name.
 *
 * Node's CommonJS exports object is a plain, extensible object whose
 * properties are the exports, so this object has Object.prototype, the
 * export names as own enumerable accessors in the module's assignment
 * order, and no Symbol.toStringTag. A table literal's `__proto__` member
 * sets that prototype as the object is built (B.3.1): the exporting module
 * evaluated the initializer once when it built its table, and this object is
 * given that one value, so every holder shares the prototype and a mutation
 * through it persists.
 * Reads stay live: each accessor calls the compiled getter, so a value the
 * exporting module assigns after it finished evaluating is visible through
 * the object. One object per module keeps identity, and every holder of the
 * namespace sees the same object.
 *
 * The exports are read-only here: the compiler's export storage is a static
 * table, and a write through the object would not reach the exporting
 * module's own reads, so assignment keeps a named refusal. */
#include "scr_runtime.h"

#include <stdlib.h>
#include <string.h>

typedef struct ScrCjsExports {
  ScrStr *id;
  ScrDyn *object; /* retained for the program's lifetime */
  struct ScrCjsExports *next;
} ScrCjsExports;

static SCR_TL ScrCjsExports *scr_cjs_exports;
static SCR_TL bool scr_cjs_exports_cleanup_registered;

static void scr_cjs_exports_cleanup(void) {
  while (scr_cjs_exports) {
    ScrCjsExports *exports = scr_cjs_exports;
    scr_cjs_exports = exports->next;
    scr_str_release(exports->id);
    scr_dyn_release(exports->object);
    free(exports);
  }
}

/* An export's current value: the compiled getter takes the export name as a
 * dyn string and answers it +1. */
static ScrDyn *scr_cjs_exports_read(ScrClosure *clo, ScrDyn *const *args, size_t argc) {
  (void)args;
  (void)argc;
  ScrDyn *getter = scr_box_get_ref(clo->caps[0]);
  ScrDyn *name = scr_box_get_ref(clo->caps[1]);
  ScrDyn *argument = scr_dyn_retain(name);
  ScrDyn *value = scr_dyn_call(getter, &argument, 1, "module exports object");
  scr_dyn_release(argument);
  scr_dyn_release(name);
  scr_dyn_release(getter);
  return value;
}

/* Writing an export through the object would not reach the exporting
 * module's compiled reads, so it keeps a named refusal instead of a value
 * only this object would see. */
static ScrDyn *scr_cjs_exports_write(ScrClosure *clo, ScrDyn *const *args, size_t argc) {
  (void)args;
  (void)argc;
  ScrDyn *name = scr_box_get_ref(clo->caps[0]);
  ScrJsonBuf text;
  scr_jb_init(&text);
  scr_jb_puts(&text, "assigning to the CommonJS module export '");
  scr_jb_write(&text, name->v.str->data, name->v.str->len);
  scr_jb_puts(&text, "' through the module's exports object is not supported yet");
  ScrStr *message = scr_jb_finish(&text);
  scr_throw_error_msg(SCR_ERR_TYPE, message->data, message->len);
  scr_str_release(message);
  scr_dyn_release(name);
  return NULL;
}

/* `thunk` as a dynamic function over one or two captured dynamic values. */
static ScrDyn *scr_cjs_exports_fn(ScrDynThunk thunk, ScrDyn *first, ScrDyn *second) {
  ScrClosure *closure = scr_closure_new(NULL, second ? 2 : 1);
  closure->caps[0] = scr_box_new_obj(scr_dyn_retain_v, scr_dyn_release_v, scr_dyn_trace_v);
  scr_box_set_ref(closure->caps[0], scr_dyn_retain(first));
  if (second) {
    closure->caps[1] = scr_box_new_obj(scr_dyn_retain_v, scr_dyn_release_v, scr_dyn_trace_v);
    scr_box_set_ref(closure->caps[1], scr_dyn_retain(second));
  }
  return scr_dyn_new_func(closure, thunk, 0, "native:module exports", "module exports object");
}

/* The exports object: one own enumerable accessor per export, in `keys`
 * order, over a plain extensible object. */
static ScrDyn *scr_cjs_exports_build(ScrArr *keys, ScrDyn *getter) {
  ScrDyn *object = scr_dyn_new_obj();
  for (size_t i = 0; i < keys->len; i++) {
    ScrStr *key = scr_arr_get_ref(keys, (double)i); /* +1 */
    ScrDyn *name = scr_dyn_new_str(key);
    ScrDyn *read = scr_cjs_exports_fn(scr_cjs_exports_read, getter, name);
    ScrDyn *write = scr_cjs_exports_fn(scr_cjs_exports_write, name, NULL);
    /* set_accessor takes ownership of both thunks. */
    scr_dyn_obj_set_accessor(object, key->data, key->len, read, write);
    scr_dyn_release(name);
    scr_str_release(key);
  }
  return object;
}

/* The table literal's `__proto__` member (B.3.1) applied to the exports
 * object as it is built. `value` is the initializer's result, which the
 * exporting module evaluated once when it built its table, so this object
 * keeps that one prototype and a mutation through it stays visible to every
 * holder. A null value gives the object the null prototype; an object or
 * function becomes its prototype; every other value, primitives included,
 * leaves the prototype unchanged, as the literal does. Returns false with
 * the refusal pending. */
static bool scr_cjs_exports_apply_proto(ScrDyn *object, ScrDyn *value) {
  /* A namespace read that lands inside a require cycle can reach this
   * object before the exporting module's table statement stored its value;
   * the object keeps Object.prototype, as the exports holder Node answered
   * at that point did. */
  if (!value) return true;
  switch (value->kind) {
  case SCR_DYN_BOOL: case SCR_DYN_NUM: case SCR_DYN_STR: case SCR_DYN_SYMBOL:
  case SCR_DYN_BIGINT: case SCR_DYN_UNDEF:
    return true;
  default:
    break;
  }
  ScrDyn *applied = scr_dyn_set_prototype(object, value);
  if (!applied) return false;
  scr_dyn_release(applied);
  return true;
}

ScrDyn *scr_cjs_exports_value(ScrStr *id, ScrArr *keys, ScrDyn *getter, ScrDyn *proto) {
  for (ScrCjsExports *exports = scr_cjs_exports; exports; exports = exports->next) {
    if (exports->id->len == id->len && memcmp(exports->id->data, id->data, id->len) == 0)
      return scr_dyn_retain(exports->object);
  }
  if (!scr_cjs_exports_cleanup_registered) {
    scr_atexit(scr_cjs_exports_cleanup);
    scr_cjs_exports_cleanup_registered = true;
  }
  ScrDyn *object = scr_cjs_exports_build(keys, getter);
  if (!scr_cjs_exports_apply_proto(object, proto)) {
    scr_dyn_release(object);
    return NULL;
  }
  ScrCjsExports *exports = malloc(sizeof(*exports));
  if (!exports) scr_trap("scriptc: out of memory\n");
  *exports = (ScrCjsExports){ scr_str_retain(id), scr_dyn_retain(object), scr_cjs_exports };
  scr_cjs_exports = exports;
  return object;
}
