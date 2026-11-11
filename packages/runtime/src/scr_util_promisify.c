/* util.promisify over an untyped function. A truthy
 * original[util.promisify.custom] is the answer (Node returns it and marks
 * it with the key); otherwise the wrapper is a native dyn function: each
 * call creates a promise, calls the original with the call's receiver and
 * arguments plus an error-first callback, and answers the promise. Typed
 * functions keep the compiler's static wrapper; this unit links only into
 * programs that promisify an `any` value. All arguments are borrowed. */
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
 * caps[0] holds the wrapper's promise and caps[1] whether it has been
 * resolved. */
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

/* util.promisify.custom, as Node reads it: the registered
 * Symbol.for('nodejs.util.promisify.custom') (+1). NULL when the program
 * has no symbol support, where the property cannot exist. */
static ScrDyn *up_custom_key(void) {
  if (!scr_sym_for_fn) return NULL;
  ScrStr *name = scr_str_new("nodejs.util.promisify.custom", 28);
  ScrSym *symbol = scr_sym_for_fn(name);
  scr_str_release(name);
  ScrDyn *key = scr_dyn_new_symbol(symbol);
  scr_sym_release(symbol);
  return key;
}

/* target[key] = value as a non-writable, non-enumerable, configurable data
 * property (Node's ObjectDefineProperty descriptor for the custom key). */
static bool up_define_custom(ScrDyn *target, ScrDyn *key, ScrDyn *value) {
  ScrDyn *descriptor = scr_dyn_new_obj();
  scr_dyn_obj_set(descriptor, "value", 5, scr_dyn_retain(value));
  scr_dyn_obj_set(descriptor, "writable", 8, scr_dyn_new_bool(false));
  scr_dyn_obj_set(descriptor, "enumerable", 10, scr_dyn_new_bool(false));
  scr_dyn_obj_set(descriptor, "configurable", 12, scr_dyn_new_bool(true));
  ScrDyn *defined = scr_dyn_define_property(target, key, descriptor);
  scr_dyn_release(descriptor);
  if (!defined) return false;
  scr_dyn_release(defined);
  return true;
}

/* Node's validateFunction over the custom property: "The
 * \"util.promisify.custom\" property must be of type function. Received
 * ..." as ERR_INVALID_ARG_TYPE. */
static void up_custom_type_fail(const ScrDyn *custom) {
  char received[256];
  const ScrDyn *value = custom ? custom : scr_dyn_undefined();
  const char *tail = scr_dyn_specific_type(value, received, sizeof received);
  ScrJsonBuf message;
  scr_jb_init(&message);
  scr_jb_puts(&message, "The \"util.promisify.custom\" property must be of type function. Received ");
  scr_jb_puts(&message, tail);
  ScrStr *text = scr_jb_finish(&message);
  scr_throw_error_msg_code(SCR_ERR_TYPE, text->data, text->len, "ERR_INVALID_ARG_TYPE");
  scr_str_release(text);
}

/* util.promisify(original), Node's promisify outside the typed lowerings:
 * a truthy `original[util.promisify.custom]` IS the answer (it must be a
 * function, and takes the custom key itself); otherwise the wrapper calls
 * original with the call's receiver and arguments plus an error-first
 * callback and answers a promise, and takes the original's [[Prototype]],
 * the custom key with itself as its value, and the original's own property
 * descriptors (name, length, prototype and every other own member), in
 * Node's order. A function's [[Prototype]] is readable here only once the
 * program replaced it (scr_dyn_get_prototype answers plain functions with
 * its SC2020 fence); the wrapper is born with Function.prototype, which is
 * the original's there, so the fence is consumed and the step skipped. */
ScrDyn *scr_util_promisify(ScrDyn *original) {
  if (!scr_dyn_is_callable(original)) {
    scr_dyn_arg_type_fail("original", "of type function", original);
    return NULL;
  }
  ScrDyn *key = up_custom_key();
  if (key) {
    /* Node reads the property twice — once for the `if (original[k])`
     * test, then for the value it validates and answers — and a falsy
     * value is read once. A getter sees exactly that many reads. */
    ScrDyn *probe = scr_dyn_reflect_get(original, key, original); /* +1, or NULL */
    bool truthy = probe != NULL && scr_dyn_truthy(probe);
    scr_dyn_release(probe);
    if (scr_exc_pending()) {
      scr_dyn_release(key);
      return NULL;
    }
    if (truthy) {
      ScrDyn *custom = scr_dyn_reflect_get(original, key, original); /* +1, or NULL */
      if (scr_exc_pending()) {
        scr_dyn_release(custom);
        scr_dyn_release(key);
        return NULL;
      }
      if (!custom || !scr_dyn_is_callable(custom)) up_custom_type_fail(custom);
      else if (!up_define_custom(custom, key, custom)) {
        /* the define's exception is pending */
      }
      scr_dyn_release(key);
      if (!scr_exc_pending()) return custom;
      scr_dyn_release(custom);
      return NULL;
    }
  }
  ScrClosure *closure = scr_closure_new(NULL, 1);
  closure->caps[0] = up_box(scr_dyn_retain(original));
  ScrDyn *wrapper = scr_dyn_new_func(closure, up_call, 0, "native:util.promisify", "");
  if (original->kind == SCR_DYN_FUNC) {
    ScrDyn *prototype = scr_dyn_get_prototype(original); /* +1, or NULL with a fence */
    if (!prototype) {
      scr_exc_clear();
    } else {
      ScrDyn *applied = scr_dyn_set_prototype(wrapper, prototype);
      scr_dyn_release(prototype);
      if (!applied) {
        scr_dyn_release(key);
        scr_dyn_release(wrapper);
        return NULL;
      }
      scr_dyn_release(applied);
    }
  }
  if (key && !up_define_custom(wrapper, key, wrapper)) {
    scr_dyn_release(key);
    scr_dyn_release(wrapper);
    return NULL;
  }
  scr_dyn_release(key);
  ScrDyn *descriptors = scr_dyn_get_own_property_descriptors(original);
  if (!descriptors) {
    scr_dyn_release(wrapper);
    return NULL;
  }
  ScrDyn *defined = scr_dyn_define_props(wrapper, descriptors);
  scr_dyn_release(descriptors);
  if (!defined) {
    scr_dyn_release(wrapper);
    return NULL;
  }
  scr_dyn_release(defined);
  return wrapper;
}
