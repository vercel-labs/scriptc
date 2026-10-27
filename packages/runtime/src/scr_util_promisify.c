/* util.promisify over an untyped function. The wrapper is a native dyn
 * function: each call creates a promise, calls the original with the
 * call's receiver and arguments plus an error-first callback, and answers
 * the promise. Typed functions keep the compiler's static wrapper; this
 * unit links only into programs that promisify an `any` value. All
 * arguments are borrowed. */
#include "scr_runtime.h"

#include <stdlib.h>
#include <string.h>

static ScrBox *up_box(ScrDyn *value /* moves in */) {
  ScrBox *box = scr_box_new_obj(scr_dyn_retain_v, scr_dyn_release_v, scr_dyn_trace_v);
  scr_box_set_ref(box, value);
  return box;
}

static ScrDyn *up_cap(ScrClosure *closure, size_t index) {
  return scr_box_get_ref(closure->caps[index]); /* +1 */
}

/* ── util.promisify over an untyped function ────────────────────────────
 * The wrapper calls original with the call's receiver and arguments plus a
 * callback, and answers a promise the callback settles: a truthy first
 * argument rejects with it, otherwise the second argument fulfills. A
 * synchronous throw rejects, as Node's executor does. The first call
 * resolves the promise, as the executor's resolve and reject functions
 * do: a promise it fulfills with keeps the wrapper's promise pending
 * until it settles, and later calls and throws are ignored meanwhile.
 * util.promisify.custom functions are not consulted. caps[0] holds the
 * wrapper's promise and caps[1] whether it has been resolved. */
static ScrDyn *up_callback(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  if (scr_box_get_bool(closure->caps[1])) return scr_dyn_retain(scr_dyn_undefined());
  scr_box_set_bool(closure->caps[1], true);
  ScrDyn *settles = up_cap(closure, 0);
  ScrPromise *promise = scr_dyn_promise_of(settles);
  if (promise && scr_promise_is_pending(promise)) {
    ScrDyn *err = argc ? args[0] : scr_dyn_undefined();
    if (scr_dyn_truthy(err)) {
      scr_dyn_throw(scr_dyn_retain(err));
      scr_promise_reject_pending(promise);
    } else {
      scr_promise_resolve_dyn(promise, scr_dyn_retain(argc > 1 ? args[1] : scr_dyn_undefined()));
    }
  }
  scr_dyn_release(settles);
  return scr_dyn_retain(scr_dyn_undefined());
}

static ScrDyn *up_call(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  ScrDyn *original = up_cap(closure, 0);
  ScrDyn *receiver = scr_dyn_this_get();
  ScrPromise *promise = scr_promise_new();
  ScrDyn *result = scr_dyn_new_promise(promise);
  ScrClosure *settle = scr_closure_new(NULL, 2);
  settle->caps[0] = up_box(scr_dyn_retain(result));
  settle->caps[1] = scr_box_new(SCR_BOX_BOOL);
  ScrDyn *callback = scr_dyn_new_func(settle, up_callback, 2, "native:util.promisify", "");
  ScrDyn **full = malloc((argc + 1) * sizeof *full);
  if (!full) scr_trap("out of memory");
  for (size_t i = 0; i < argc; i++) full[i] = args[i];
  full[argc] = callback;
  scr_dyn_this_push_dyn(receiver);
  ScrDyn *returned = scr_dyn_call(original, full, argc + 1, "function");
  scr_dyn_this_pop();
  free(full);
  if (returned) {
    scr_dyn_release(returned);
  } else if (!scr_box_get_bool(settle->caps[1])) {
    scr_box_set_bool(settle->caps[1], true);
    scr_promise_reject_pending(promise);
  } else {
    scr_exc_clear();
  }
  scr_dyn_release(callback);
  scr_dyn_release(receiver);
  scr_dyn_release(original);
  scr_promise_release(promise);
  return result;
}

/* Node's promisify also copies the original's prototype and own property
 * descriptors onto the wrapper, consults util.promisify.custom, and marks
 * the wrapper with it. The plain case is a function whose only own
 * properties are name, length and prototype: the wrapper takes the name
 * and length descriptors. Other own properties (util.promisify.custom
 * among them) refuse with SC2020 rather than answering differently. The
 * wrapper's prototype is Function.prototype even when the original's was
 * replaced. */
static bool up_plain_original(ScrDyn *original) {
  ScrDyn *keys = scr_dyn_own_keys(original);
  if (!keys) return false;
  bool plain = true;
  double count = scr_dyn_arr_len(keys);
  for (double i = 0; i < count && plain; i++) {
    ScrDyn *key = scr_dyn_index_get(keys, i);
    if (!key) {
      plain = false;
      break;
    }
    plain = key->kind == SCR_DYN_STR &&
            ((key->v.str->len == 4 && memcmp(key->v.str->data, "name", 4) == 0) ||
             (key->v.str->len == 6 && memcmp(key->v.str->data, "length", 6) == 0) ||
             (key->v.str->len == 9 && memcmp(key->v.str->data, "prototype", 9) == 0));
    scr_dyn_release(key);
  }
  scr_dyn_release(keys);
  return plain;
}

/* wrapper[key] = original[key] as a non-writable, non-enumerable,
 * configurable data property, as getOwnPropertyDescriptors copies the
 * name and length of an ordinary function. */
static bool up_copy_descriptor(ScrDyn *wrapper, ScrDyn *original, const char *key) {
  ScrStr *name = scr_str_new(key, strlen(key));
  ScrDyn *property = scr_dyn_new_str(name);
  scr_str_release(name);
  ScrDyn *value = scr_dyn_fn_get(original, key, strlen(key));
  ScrDyn *descriptor = scr_dyn_new_obj();
  scr_dyn_obj_set(descriptor, "value", 5, value ? value : scr_dyn_retain(scr_dyn_undefined()));
  scr_dyn_obj_set(descriptor, "writable", 8, scr_dyn_new_bool(false));
  scr_dyn_obj_set(descriptor, "enumerable", 10, scr_dyn_new_bool(false));
  scr_dyn_obj_set(descriptor, "configurable", 12, scr_dyn_new_bool(true));
  ScrDyn *defined = scr_dyn_define_property(wrapper, property, descriptor);
  scr_dyn_release(descriptor);
  scr_dyn_release(property);
  if (!defined) return false;
  scr_dyn_release(defined);
  return true;
}

ScrDyn *scr_util_promisify(ScrDyn *original) {
  if (!scr_dyn_is_callable(original)) {
    scr_dyn_arg_type_fail("original", "of type function", original);
    return NULL;
  }
  if (!up_plain_original(original)) {
    if (scr_exc_pending()) return NULL;
    static const char message[] =
        "util.promisify over an untyped function with own properties (such as util.promisify.custom) "
        "is not supported yet";
    scr_throw_error_msg_code(SCR_ERR_ERROR, message, sizeof message - 1, "SC2020");
    return NULL;
  }
  ScrClosure *closure = scr_closure_new(NULL, 1);
  closure->caps[0] = up_box(scr_dyn_retain(original));
  ScrDyn *wrapper = scr_dyn_new_func(closure, up_call, 0, "native:util.promisify", "");
  if (!up_copy_descriptor(wrapper, original, "name") || !up_copy_descriptor(wrapper, original, "length")) {
    scr_dyn_release(wrapper);
    return NULL;
  }
  return wrapper;
}
