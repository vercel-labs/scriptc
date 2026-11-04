/* Number.prototype and Boolean.prototype as values.
 *
 * A JavaScript source reading `Number.prototype` or `Boolean.prototype`
 * used to fall through to an ordinary member read of the constructor
 * value, which answered undefined: there was no prototype object to read.
 * This unit builds the two prototype objects the way the language defines
 * them — an ordinary object whose prototype is Object.prototype, carrying
 * the kind's methods as non-enumerable, writable, configurable data
 * properties — and answers them from one box per thread, so every read is
 * the same object (`Number.prototype === Number.prototype`).
 *
 * A method called on the prototype object itself runs on the kind's empty
 * primitive (`Number.prototype.toString(2)` is "0", `Boolean.prototype
 * .valueOf()` is false), which is what Node's Number and Boolean prototype
 * objects are: wrappers around +0 and false. The methods are not generic,
 * so any other receiver — a plain object, null, a primitive of the other
 * kind — is the TypeError Node answers.
 *
 * The unit links only into programs that read those values in a JavaScript
 * source (the frontend marks dyn.builtinPrototype there), so typed programs
 * keep their exact executables and no always-linked unit changes.
 *
 * Wrapper objects (`new Number(1)`, the primitiveWrapper unit) build a
 * prototype object of their own for their instances' chain. A program that
 * does both should see ONE object: when that unit lands, this builder
 * should answer its prototype for a program that links it rather than
 * building a second one. */
#include "scr_runtime.h"
#include "scr_dyn_methods.h"

#include <stdio.h>
#include <string.h>

/* The methods each prototype declares, with Node's `length` values. */
static const struct { const char *name; uint32_t length; } bp_number_methods[] = {
  {"toString", 1},
  {"toFixed", 1},
  {"toExponential", 1},
  {"toPrecision", 1},
  {"valueOf", 0},
};
static const struct { const char *name; uint32_t length; } bp_boolean_methods[] = {
  {"toString", 0},
  {"valueOf", 0},
};

static SCR_TL ScrDyn *bp_number_prototype;
static SCR_TL ScrDyn *bp_boolean_prototype;

static void bp_prototypes_cleanup(void) {
  scr_dyn_release(bp_number_prototype);
  scr_dyn_release(bp_boolean_prototype);
  bp_number_prototype = NULL;
  bp_boolean_prototype = NULL;
}

/** A prototype method of the kind: caps[0] is the kind's name ("Number" or
 * "Boolean") and caps[1] the method name. The method runs on the receiver's
 * primitive value as `this`: the receiver itself when the call passed a
 * primitive of the kind (`Number.prototype.toString.call(255)`), else the
 * empty primitive (+0 / false) the prototype object wraps, which is its
 * [[PrimitiveValue]] in Node too. Boolean's two methods are answered here,
 * since the checked-dynamic dispatch keeps no Boolean prototype table. */
/** The prototype methods are not generic: each one reads the receiver's
 * [[NumberData]] / [[BooleanData]], so only a primitive of the kind or its
 * prototype object — the wrapper around +0 / false — is a valid `this`.
 * Anything else, another primitive included, is a TypeError in Node. */
static void bp_bad_this(const ScrStr *kind, const ScrStr *method) {
  char message[128];
  snprintf(message, sizeof message, "%s.prototype.%s requires that 'this' be a %s",
           kind->data, method->data, kind->data);
  scr_throw_error_msg(SCR_ERR_TYPE, message, strlen(message));
}

static ScrDyn *bp_method_call(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  /* Both reads are +1, so the two strings are released below. */
  ScrStr *kind = scr_box_get_ref(closure->caps[0]);
  ScrStr *method = scr_box_get_ref(closure->caps[1]);
  ScrDyn *receiver = scr_dyn_this_get();
  ScrDyn *result = NULL;
  if (!strcmp(kind->data, "Boolean")) {
    if (receiver->kind != SCR_DYN_BOOL && receiver != bp_boolean_prototype) {
      bp_bad_this(kind, method);
      scr_dyn_release(receiver);
      scr_str_release(kind);
      scr_str_release(method);
      return NULL;
    }
    bool value = receiver->kind == SCR_DYN_BOOL ? receiver->v.b : false;
    if (!strcmp(method->data, "valueOf")) {
      result = scr_dyn_new_bool(value);
    } else {
      const char *text = value ? "true" : "false";
      ScrStr *string = scr_str_new(text, strlen(text));
      result = scr_dyn_new_str(string);
      scr_str_release(string);
    }
  } else if (receiver->kind != SCR_DYN_NUM && receiver != bp_number_prototype) {
    bp_bad_this(kind, method);
    scr_dyn_release(receiver);
    scr_str_release(kind);
    scr_str_release(method);
    return NULL;
  } else {
    ScrDyn *self = receiver->kind == SCR_DYN_NUM ? scr_dyn_retain(receiver) : scr_dyn_new_num(0);
    if (!strcmp(method->data, "toString")) {
      /* Number.prototype.toString is the radix form, which the number
       * dispatch answers through its own helper rather than as a method. */
      ScrStr *value = scr_dyn_to_string_argument(self, argc ? args[0] : scr_dyn_undefined(), method);
      if (value) {
        result = scr_dyn_new_str(value);
        scr_str_release(value);
      }
    } else {
      result = scr_dyn_invoke(self, method->data, args, argc, method->data);
    }
    scr_dyn_release(self);
  }
  scr_dyn_release(receiver);
  scr_str_release(kind);
  scr_str_release(method);
  return result;
}

/** Defines one non-enumerable data property on `object`: the attributes
 * every built-in method has ({ writable, configurable }, not enumerable). */
static void bp_define(ScrDyn *object, const char *name, size_t name_len, ScrDyn *value) {
  ScrDyn *descriptor = scr_dyn_new_obj();
  scr_dyn_obj_set(descriptor, "value", 5, value);
  scr_dyn_obj_set(descriptor, "writable", 8, scr_dyn_new_bool(true));
  scr_dyn_obj_set(descriptor, "configurable", 12, scr_dyn_new_bool(true));
  ScrStr *key = scr_str_new(name, name_len);
  ScrDyn *key_value = scr_dyn_new_str(key);
  ScrDyn *defined = scr_dyn_define_property(object, key_value, descriptor);
  scr_dyn_release(defined);
  scr_dyn_release(key_value);
  scr_dyn_release(descriptor);
  scr_str_release(key);
}

/** The kind's prototype object, built on first use; +1, one per thread (the
 * slot keeps its own reference, as `scr_dyn_array_prototype_base` does).
 * `kind` is "Number" or "Boolean" (the only two the frontend marks). */
ScrDyn *scr_dyn_builtin_prototype(const ScrStr *kind) {
  bool number = !strcmp(kind->data, "Number");
  ScrDyn **slot = number ? &bp_number_prototype : &bp_boolean_prototype;
  if (*slot) return scr_dyn_retain(*slot);
  ScrDyn *prototype = scr_dyn_new_obj();
  *slot = prototype;
  scr_atexit(bp_prototypes_cleanup);
  ScrStr *kind_str = scr_str_new(kind->data, strlen(kind->data));
  const struct { const char *name; uint32_t length; } *methods =
    number ? bp_number_methods : bp_boolean_methods;
  size_t count = number ? sizeof bp_number_methods / sizeof bp_number_methods[0]
                        : sizeof bp_boolean_methods / sizeof bp_boolean_methods[0];
  for (size_t i = 0; i < count; i++) {
    ScrStr *name = scr_str_new(methods[i].name, strlen(methods[i].name));
    ScrClosure *closure = scr_closure_new(NULL, 2);
    closure->caps[0] = scr_box_new(SCR_BOX_STR);
    closure->caps[1] = scr_box_new(SCR_BOX_STR);
    scr_box_set_ref(closure->caps[0], scr_str_retain(kind_str));
    scr_box_set_ref(closure->caps[1], scr_str_retain(name));
    ScrDyn *method = scr_dyn_new_func(closure, bp_method_call, methods[i].length,
      number ? "native:Number.prototype" : "native:Boolean.prototype", methods[i].name);
    bp_define(prototype, methods[i].name, strlen(methods[i].name), method);
    scr_str_release(name);
  }
  scr_str_release(kind_str);
  return scr_dyn_retain(prototype);
}
