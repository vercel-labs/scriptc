/* util.promisify's custom function protocol, shared by the untyped
 * (scr_util_promisify.c) and typed (the frontend's promisify maker)
 * lowerings: Node reads original[util.promisify.custom] twice — the truthy
 * test, then the value it validates and answers — and marks the custom
 * function with the key. A truthy non-function value throws
 * ERR_INVALID_ARG_TYPE. The wrapper's own marking (and the descriptor copy
 * the untyped lowering adds) stays with each lowering. All arguments are
 * borrowed; answers are +1 handles or NULL with the exception pending. */
#include "scr_runtime.h"

#include <stdbool.h>

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

/* original[util.promisify.custom] when it is the answer: the truthy custom
 * function (+1, marked with the key), or the undefined value (+1) when the
 * property is absent or falsy — the answer is only ever tested for
 * truthiness, and a caller that must distinguish a throw reads the
 * exception cell. A truthy non-function throws Node's
 * ERR_INVALID_ARG_TYPE. Read by both promisify lowerings; the typed one
 * calls it over the boxed typed function before it builds the wrapper. */
ScrDyn *scr_util_promisify_custom(ScrDyn *original) {
  ScrDyn *key = up_custom_key();
  if (key == NULL) return scr_dyn_retain(scr_dyn_undefined());
  /* Node reads the property twice — once for the `if (original[k])` test,
   * then for the value it validates and answers — and a falsy value is read
   * once. A getter sees exactly that many reads. */
  ScrDyn *probe = scr_dyn_reflect_get(original, key, original); /* +1, or NULL */
  if (scr_exc_pending()) {
    scr_dyn_release(probe);
    scr_dyn_release(key);
    return NULL;
  }
  bool truthy = probe != NULL && scr_dyn_truthy(probe);
  scr_dyn_release(probe);
  if (!truthy) {
    scr_dyn_release(key);
    return scr_dyn_retain(scr_dyn_undefined());
  }
  ScrDyn *custom = scr_dyn_reflect_get(original, key, original); /* +1, or NULL */
  if (scr_exc_pending()) {
    scr_dyn_release(custom);
    scr_dyn_release(key);
    return NULL;
  }
  if (custom == NULL || !scr_dyn_is_callable(custom)) up_custom_type_fail(custom);
  else if (!up_define_custom(custom, key, custom)) {
    /* the define's exception is pending */
  }
  scr_dyn_release(key);
  if (!scr_exc_pending()) return custom;
  scr_dyn_release(custom);
  return NULL;
}

/* Marks a promisified wrapper with Node's private key and copies the
 * original's own property descriptors onto it, in Node's order: the
 * marking (wrapper[key] = wrapper, non-writable, non-enumerable,
 * configurable) first, then every own descriptor of the original — name,
 * length, prototype, the program's own members, and an own custom property
 * when it is falsy (a truthy one is the answer instead), which therefore
 * replaces the marking. Both promisify lowerings end their wrapper here.
 * Answers the same wrapper (+1), or NULL with the exception pending. */
ScrDyn *scr_util_promisify_mark(ScrDyn *wrapper, ScrDyn *original) {
  ScrDyn *key = up_custom_key();
  if (key != NULL) {
    if (!up_define_custom(wrapper, key, wrapper)) {
      scr_dyn_release(key);
      return NULL;
    }
    scr_dyn_release(key);
  }
  /* ObjectDefineProperties(fn, ObjectGetOwnPropertyDescriptors(original)):
   * the descriptor table is read first — Node's snapshot of every flag,
   * null-prototype values and all — then each own key (string and symbol,
   * in own-key order) is defined from it. scr_dyn_define_props does this
   * too, but lives in scr_dyn_invoke.c; the base object unit owns the
   * pieces, so a typed-promisify program does not link the invoke unit. */
  ScrDyn *descriptors = scr_dyn_get_own_property_descriptors(original); /* +1, or NULL */
  if (descriptors == NULL) return NULL;
  ScrDyn *keys = scr_dyn_own_keys(descriptors); /* +1, or NULL */
  if (keys == NULL) {
    scr_dyn_release(descriptors);
    return NULL;
  }
  size_t const count = keys->kind == SCR_DYN_ARR ? keys->v.arr.len : 0;
  for (size_t i = 0; i < count; i++) {
    ScrDyn *property = keys->v.arr.items[i];
    ScrDyn *descriptor = scr_dyn_get_own_property_descriptor(original, property); /* +1, or NULL */
    if (descriptor == NULL) {
      scr_dyn_release(keys);
      scr_dyn_release(descriptors);
      return NULL;
    }
    ScrDyn *defined = scr_dyn_define_property(wrapper, property, descriptor);
    scr_dyn_release(descriptor);
    if (defined == NULL) {
      scr_dyn_release(keys);
      scr_dyn_release(descriptors);
      return NULL;
    }
    scr_dyn_release(defined);
  }
  scr_dyn_release(keys);
  scr_dyn_release(descriptors);
  return scr_dyn_retain(wrapper);
}
