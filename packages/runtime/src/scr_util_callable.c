/* node:util's function helpers over the checked-dynamic tree: inherits,
 * deprecate, callbackify and debuglog. The returned wrappers are native
 * dyn functions whose closures hold the wrapped values, so they keep
 * Node's receiver forwarding, own properties and prototype links through
 * every boxing of the same function. The compiled call site converts a
 * wrapper back to the program's static function type when it has one.
 *
 * Warnings follow Node's emitWarning: deprecations are built at the call
 * and reported on the next tick (scr_warning_emit_deferred), which also
 * applies process.noDeprecation and process.throwDeprecation. debuglog
 * matches sections against NODE_DEBUG as the process started and writes
 * Node's "SECTION PID: message" lines, formatted by scr_insp_format, to
 * stderr. All arguments are borrowed. */
#include "scr_runtime.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static ScrBox *uc_box(ScrDyn *value /* moves in */) {
  ScrBox *box = scr_box_new_obj(scr_dyn_retain_v, scr_dyn_release_v, scr_dyn_trace_v);
  scr_box_set_ref(box, value);
  return box;
}

static ScrDyn *uc_cap(ScrClosure *closure, size_t index) {
  return scr_box_get_ref(closure->caps[index]); /* +1 */
}

static void uc_set_cap(ScrClosure *closure, size_t index, ScrDyn *value /* moves in */) {
  scr_box_set_ref(closure->caps[index], value);
}

static bool uc_nullish(const ScrDyn *value) {
  return value->kind == SCR_DYN_UNDEF || value->kind == SCR_DYN_NULL;
}

static bool uc_object(const ScrDyn *value) {
  switch (value->kind) {
  case SCR_DYN_OBJ:
  case SCR_DYN_ARR:
  case SCR_DYN_FUNC:
  case SCR_DYN_BYTES:
  case SCR_DYN_HANDLE:
  case SCR_DYN_PROMISE:
  case SCR_DYN_TYPED_REF:
  case SCR_DYN_PROXY:
    return true;
  default:
    return false;
  }
}

static void uc_type_error(const char *message) {
  scr_throw_error_msg(SCR_ERR_TYPE, message, strlen(message));
}

static void uc_fence(const char *message) {
  scr_throw_error_msg_code(SCR_ERR_ERROR, message, strlen(message), "SC2020");
}

/* `value[key]`: own and inherited members of object kinds, undefined for
 * primitives (whose prototypes carry none of the keys read here). +1, or
 * NULL with an exception pending. */
static ScrDyn *uc_get(const ScrDyn *value, const char *key) {
  size_t len = strlen(key);
  ScrDyn *result = NULL;
  if (value->kind == SCR_DYN_FUNC) {
    result = scr_dyn_fn_get(value, key, len);
  } else if (value->kind == SCR_DYN_TYPED_REF) {
    ScrDyn *view = scr_dyn_typed_ref_materialize(value);
    if (scr_exc_pending()) {
      scr_dyn_release(view);
      return NULL;
    }
    result = uc_get(view, key);
    scr_dyn_release(view);
    return result;
  } else if (value->kind == SCR_DYN_OBJ || value->kind == SCR_DYN_ARR || value->kind == SCR_DYN_PROXY) {
    result = scr_dyn_obj_read(value, key, len);
  } else {
    return scr_dyn_retain(scr_dyn_undefined());
  }
  if (!result && !scr_exc_pending()) result = scr_dyn_retain(scr_dyn_undefined());
  return result;
}

/* V8's rendering of a value inside a TypeError message: primitives as
 * strings, objects as #<Object>. */
static ScrStr *uc_v8_value(const ScrDyn *value) {
  if (value->kind == SCR_DYN_SYMBOL) return scr_insp_dyn((ScrDyn *)value, 0, 0);
  if (uc_object(value)) return scr_str_new("#<Object>", 9);
  ScrStr *text = scr_dyn_string_coerce_js(value);
  return text ? text : scr_str_new("", 0);
}

static void uc_v8_value_error(const char *prefix, const ScrDyn *value, const char *suffix) {
  ScrStr *text = uc_v8_value(value);
  ScrJsonBuf b;
  scr_jb_init(&b);
  scr_jb_puts(&b, prefix);
  scr_jb_put_str(&b, text);
  scr_jb_puts(&b, suffix);
  scr_str_release(text);
  scr_throw_error(SCR_ERR_TYPE, scr_jb_finish(&b));
}

/* Reflect.apply(fn, receiver, args) — the receiver is bound for the call's
 * synchronous extent, as for every dyn method call. +1 or NULL. */
static ScrDyn *uc_apply(ScrDyn *fn, ScrDyn *receiver, ScrDyn *const *args, size_t argc) {
  if (!scr_dyn_is_callable(fn)) {
    const char *kind = uc_object(fn) ? "an object" : fn->kind == SCR_DYN_NUM ? "a number"
      : fn->kind == SCR_DYN_STR ? "a string" : fn->kind == SCR_DYN_BOOL ? "a boolean"
      : fn->kind == SCR_DYN_NULL ? "an object" : fn->kind == SCR_DYN_SYMBOL ? "a symbol"
      : fn->kind == SCR_DYN_BIGINT ? "a bigint" : "a undefined";
    ScrStr *text = fn->kind == SCR_DYN_NULL ? scr_str_new("null", 4) : uc_v8_value(fn);
    ScrJsonBuf b;
    scr_jb_init(&b);
    scr_jb_puts(&b, "Function.prototype.apply was called on ");
    scr_jb_put_str(&b, text);
    scr_jb_puts(&b, ", which is ");
    scr_jb_puts(&b, kind);
    scr_jb_puts(&b, " and not a function");
    scr_str_release(text);
    scr_throw_error(SCR_ERR_TYPE, scr_jb_finish(&b));
    return NULL;
  }
  scr_dyn_this_push_dyn(receiver);
  ScrDyn *result = scr_dyn_call(fn, args, argc, "function");
  scr_dyn_this_pop();
  return result;
}

/* Object.defineProperty(target, key, descriptor) over a fresh descriptor;
 * the descriptor moves in. False with an exception pending on failure. */
static bool uc_define(ScrDyn *target, const char *key, ScrDyn *descriptor) {
  ScrStr *name = scr_str_new(key, strlen(key));
  ScrDyn *property = scr_dyn_new_str(name);
  scr_str_release(name);
  ScrDyn *defined = scr_dyn_define_property(target, property, descriptor);
  scr_dyn_release(property);
  scr_dyn_release(descriptor);
  if (!defined) return false;
  scr_dyn_release(defined);
  return true;
}

/* ── util.inherits ─────────────────────────────────────────────────────
 * Node 24's lib/util.js: nullish arguments and an undefined
 * superCtor.prototype throw ERR_INVALID_ARG_TYPE; then super_ becomes a
 * writable, configurable, non-enumerable own property and
 * ctor.prototype's prototype becomes superCtor.prototype. super_prototype
 * is superCtor.prototype (owned), or NULL when superCtor is no object. */
static void uc_inherits(ScrDyn *ctor, ScrDyn *super_ctor, ScrDyn *super_prototype) {
  if (super_prototype->kind == SCR_DYN_UNDEF) {
    scr_dyn_prop_type_fail("superCtor.prototype", "of type object", super_prototype);
    scr_dyn_release(super_prototype);
    return;
  }
  if (!uc_object(ctor)) {
    uc_type_error("Object.defineProperty called on non-object");
    scr_dyn_release(super_prototype);
    return;
  }
  ScrDyn *descriptor = scr_dyn_new_obj();
  scr_dyn_obj_set(descriptor, "value", 5, scr_dyn_retain(super_ctor));
  scr_dyn_obj_set(descriptor, "writable", 8, scr_dyn_new_bool(true));
  scr_dyn_obj_set(descriptor, "configurable", 12, scr_dyn_new_bool(true));
  if (!uc_define(ctor, "super_", descriptor)) {
    scr_dyn_release(super_prototype);
    return;
  }
  ScrDyn *prototype = uc_get(ctor, "prototype");
  if (prototype) {
    if (uc_nullish(prototype)) {
      uc_type_error("Object.setPrototypeOf called on null or undefined");
    } else if (!uc_object(super_prototype) && super_prototype->kind != SCR_DYN_NULL) {
      uc_v8_value_error("Object prototype may only be an Object or null: ", super_prototype, "");
    } else if (uc_object(prototype)) {
      scr_dyn_release(scr_dyn_set_prototype(prototype, super_prototype));
    }
    scr_dyn_release(prototype);
  }
  scr_dyn_release(super_prototype);
}

void scr_util_inherits(ScrDyn *ctor, ScrDyn *super_ctor) {
  if (uc_nullish(ctor)) {
    scr_dyn_arg_type_fail("ctor", "of type function", ctor);
    return;
  }
  if (uc_nullish(super_ctor)) {
    scr_dyn_arg_type_fail("superCtor", "of type function", super_ctor);
    return;
  }
  if ((ctor->kind == SCR_DYN_FUNC && ctor->v.fn.class_obj) ||
      (super_ctor->kind == SCR_DYN_FUNC && super_ctor->v.fn.class_obj)) {
    uc_fence("util.inherits over class constructors has no lowering; declare the subclass with extends");
    return;
  }
  ScrDyn *super_prototype = uc_get(super_ctor, "prototype");
  if (!super_prototype) return;
  uc_inherits(ctor, super_ctor, super_prototype);
}

/* util.inherits(ctor, C) where C is a compiled class whose prototype the
 * compiler exposes as super_prototype (borrowed): the class value's own
 * properties do not hold it. ctor itself may not be a class. */
void scr_util_inherits_prototype(ScrDyn *ctor, ScrDyn *super_ctor, ScrDyn *super_prototype) {
  if (uc_nullish(ctor)) {
    scr_dyn_arg_type_fail("ctor", "of type function", ctor);
    return;
  }
  if (ctor->kind == SCR_DYN_FUNC && ctor->v.fn.class_obj) {
    uc_fence("util.inherits over class constructors has no lowering; declare the subclass with extends");
    return;
  }
  uc_inherits(ctor, super_ctor, scr_dyn_retain(super_prototype));
}

/* ── util.deprecate ────────────────────────────────────────────────────
 * The wrapper warns once (and once per code across wrappers) before each
 * call reaches fn with the call's receiver and arguments; construction
 * reaches fn with the fresh receiver. codesWarned is process-wide, like
 * Node's. */
static SCR_TL ScrDyn *uc_codes_warned = NULL;

static void uc_codes_warned_teardown(void) {
  scr_dyn_release(uc_codes_warned);
  uc_codes_warned = NULL;
}

enum { UC_DEP_FN, UC_DEP_MSG, UC_DEP_CODE, UC_DEP_WARNED, UC_DEP_CAPS };

/* process.emitWarning(msg, type, code) as deprecate's emitter calls it:
 * a string message builds the warning, an Error is emitted as itself,
 * anything else throws Node's ERR_INVALID_ARG_TYPE at the call. */
static bool uc_emit(ScrDyn *msg, const char *type, const ScrStr *code) {
  if (!strcmp(type, "DeprecationWarning") && scr_process_deprecation_flag_on(0)) return true;
  ScrDyn *warning = NULL;
  if (msg->kind == SCR_DYN_STR) {
    warning = scr_warning_new(msg->v.str, type, code);
  } else if (scr_dyn_ref_is_error(msg)) {
    warning = scr_dyn_retain(msg);
  } else {
    scr_dyn_arg_type_fail("warning", "of type string or an instance of Error", msg);
    return false;
  }
  scr_warning_emit_deferred(warning);
  scr_dyn_release(warning);
  return true;
}

static bool uc_deprecation_warn(ScrClosure *closure) {
  if (scr_box_get_f64(closure->caps[UC_DEP_WARNED]) != 0) return true;
  scr_box_set_f64(closure->caps[UC_DEP_WARNED], 1);
  ScrDyn *msg = uc_cap(closure, UC_DEP_MSG);
  ScrDyn *code = uc_cap(closure, UC_DEP_CODE);
  bool ok = true;
  if (code->kind == SCR_DYN_STR && code->v.str->len == 19 &&
      memcmp(code->v.str->data, "ExperimentalWarning", 19) == 0) {
    ok = uc_emit(msg, "ExperimentalWarning", NULL);
  } else if (code->kind == SCR_DYN_STR) {
    if (!uc_codes_warned) {
      uc_codes_warned = scr_dyn_new_obj_null_proto();
      scr_atexit(uc_codes_warned_teardown);
    }
    const ScrStr *key = code->v.str;
    if (!scr_dyn_obj_get(uc_codes_warned, key->data, key->len)) {
      ok = uc_emit(msg, "DeprecationWarning", key);
      if (ok) scr_dyn_obj_set(uc_codes_warned, key->data, key->len, scr_dyn_new_bool(true));
    }
  } else {
    ok = uc_emit(msg, "DeprecationWarning", NULL);
  }
  scr_dyn_release(code);
  scr_dyn_release(msg);
  return ok;
}

static ScrDyn *uc_deprecated_call(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  if (!scr_process_deprecation_flag_on(0) && !uc_deprecation_warn(closure)) return NULL;
  ScrDyn *fn = uc_cap(closure, UC_DEP_FN);
  ScrDyn *receiver = scr_dyn_this_get();
  ScrDyn *result = uc_apply(fn, receiver, args, argc);
  scr_dyn_release(receiver);
  scr_dyn_release(fn);
  return result;
}

ScrDyn *scr_util_deprecate(ScrDyn *fn, ScrDyn *msg, ScrDyn *code, ScrDyn *options) {
  /* The `{ modifyPrototype } = {}` parameter binds before the body runs. */
  bool modify_prototype = true;
  if (options->kind == SCR_DYN_NULL) {
    uc_type_error("Cannot destructure property 'modifyPrototype' of "
                  "'(intermediate value)(intermediate value)(intermediate value)' as it is null.");
    return NULL;
  }
  if (uc_object(options)) {
    ScrDyn *modify = uc_get(options, "modifyPrototype");
    if (!modify) return NULL;
    if (modify->kind != SCR_DYN_UNDEF) modify_prototype = scr_dyn_truthy(modify);
    scr_dyn_release(modify);
  }
  if (code->kind != SCR_DYN_UNDEF && code->kind != SCR_DYN_STR) {
    scr_dyn_arg_type_fail("code", "of type string", code);
    return NULL;
  }
  if (fn->kind == SCR_DYN_FUNC && fn->v.fn.class_obj) {
    uc_fence("util.deprecate over class constructors has no lowering; deprecate a factory function instead");
    return NULL;
  }
  ScrClosure *closure = scr_closure_new(NULL, UC_DEP_CAPS);
  closure->function_kind = SCR_CLOSURE_KIND_OWN_PROTOTYPE;
  closure->caps[UC_DEP_FN] = uc_box(scr_dyn_retain(fn));
  closure->caps[UC_DEP_MSG] = uc_box(scr_dyn_retain(msg));
  closure->caps[UC_DEP_CODE] = uc_box(scr_dyn_retain(code));
  closure->caps[UC_DEP_WARNED] = scr_box_new(SCR_BOX_F64);
  ScrDyn *deprecated = scr_dyn_new_func(closure, uc_deprecated_call, 0, "native:util.deprecate", "deprecated");
  if (!modify_prototype) return deprecated;
  /* ObjectSetPrototypeOf(deprecated, fn), then the shared prototype and
   * fn's own length descriptor. */
  if (fn->kind != SCR_DYN_NULL && !uc_object(fn)) {
    uc_v8_value_error("Object prototype may only be an Object or null: ", fn, "");
    scr_dyn_release(deprecated);
    return NULL;
  }
  ScrDyn *linked = scr_dyn_set_prototype(deprecated, fn);
  if (!linked) {
    scr_dyn_release(deprecated);
    return NULL;
  }
  scr_dyn_release(linked);
  if (fn->kind == SCR_DYN_NULL) {
    uc_type_error("Cannot read properties of null (reading 'prototype')");
    scr_dyn_release(deprecated);
    return NULL;
  }
  ScrDyn *prototype = uc_get(fn, "prototype");
  if (!prototype) {
    scr_dyn_release(deprecated);
    return NULL;
  }
  if (scr_dyn_truthy(prototype)) {
    ScrStr *key = scr_str_new("prototype", 9);
    scr_dyn_key_set(deprecated, key, prototype);
    scr_str_release(key);
  }
  scr_dyn_release(prototype);
  if (scr_exc_pending()) {
    scr_dyn_release(deprecated);
    return NULL;
  }
  ScrStr *length_name = scr_str_new("length", 6);
  ScrDyn *length_key = scr_dyn_new_str(length_name);
  scr_str_release(length_name);
  ScrDyn *length = scr_dyn_get_own_property_descriptor(fn, length_key);
  scr_dyn_release(length_key);
  if (!length || (length->kind == SCR_DYN_OBJ && !uc_define(deprecated, "length", scr_dyn_retain(length)))) {
    scr_dyn_release(length);
    scr_dyn_release(deprecated);
    return NULL;
  }
  scr_dyn_release(length);
  return deprecated;
}

/* ── util.isArray and util._extend ─────────────────────────────────────
 * Node wraps both with its internal deprecate(): the first call while
 * deprecation warnings are on reports DEP0044 or DEP0060 on the next tick,
 * unless a util.deprecate wrapper already reported that code. */
static SCR_TL bool uc_is_array_warned = false;
static SCR_TL bool uc_extend_warned = false;

static bool uc_internal_deprecation(bool *warned, const char *message, const char *code) {
  if (scr_process_deprecation_flag_on(0) || *warned) return true;
  *warned = true;
  if (!uc_codes_warned) {
    uc_codes_warned = scr_dyn_new_obj_null_proto();
    scr_atexit(uc_codes_warned_teardown);
  }
  size_t code_len = strlen(code);
  if (scr_dyn_obj_get(uc_codes_warned, code, code_len)) return true;
  ScrStr *text = scr_str_new(message, strlen(message));
  ScrDyn *msg = scr_dyn_new_str(text);
  scr_str_release(text);
  ScrStr *key = scr_str_new(code, code_len);
  bool ok = uc_emit(msg, "DeprecationWarning", key);
  if (ok) scr_dyn_obj_set(uc_codes_warned, code, code_len, scr_dyn_new_bool(true));
  scr_str_release(key);
  scr_dyn_release(msg);
  return ok;
}

bool scr_util_is_array_deprecated(const ScrDyn *value) {
  if (!uc_internal_deprecation(&uc_is_array_warned,
                               "The `util.isArray` API is deprecated. Please use `Array.isArray()` instead.",
                               "DEP0044"))
    return false;
  return value->kind == SCR_DYN_ARR || scr_dyn_ref_is_array(value);
}

/* util._extend(target, source): source's own enumerable string keys,
 * assigned to target from the last key to the first; a source that is
 * null or not an object leaves target as it is. +1. */
ScrDyn *scr_util_extend(ScrDyn *target, ScrDyn *source) {
  if (!uc_internal_deprecation(&uc_extend_warned,
                               "The `util._extend` API is deprecated. Please use Object.assign() instead.",
                               "DEP0060"))
    return NULL;
  bool object = source->kind == SCR_DYN_OBJ || source->kind == SCR_DYN_ARR || source->kind == SCR_DYN_TYPED_REF ||
                source->kind == SCR_DYN_HANDLE || source->kind == SCR_DYN_BYTES || source->kind == SCR_DYN_PROMISE ||
                source->kind == SCR_DYN_PROXY;
  if (!object) return scr_dyn_retain(target);
  ScrDyn *keys = scr_dyn_obj_keys(source);
  if (!keys) return NULL;
  for (size_t i = keys->v.arr.len; i-- > 0 && !scr_exc_pending();) {
    ScrDyn *key = keys->v.arr.items[i];
    ScrDyn *value = scr_dyn_reflect_get(source, key, source);
    if (!value) break;
    scr_dyn_key_set(target, key->v.str, value);
    scr_dyn_release(value);
  }
  scr_dyn_release(keys);
  return scr_exc_pending() ? NULL : scr_dyn_retain(target);
}

/* ── util.callbackify ──────────────────────────────────────────────────
 * The wrapper pops the callback, binds it to the call's receiver and
 * calls original; the promise's settlement schedules the callback on the
 * next tick, so a throwing callback is an uncaught exception there. A
 * falsy rejection reason arrives wrapped in ERR_FALSY_VALUE_REJECTION
 * whose `reason` is the original value. */
/* process.nextTick(cb, null, value) or the rejection's cb(err). */
static void uc_callback_tick(ScrClosure *closure) {
  ScrDyn *cb = uc_cap(closure, 0);
  ScrDyn *err = uc_cap(closure, 1);
  ScrDyn *value = uc_cap(closure, 2);
  ScrDyn *args[2] = {err, value};
  size_t argc = (size_t)scr_box_get_f64(closure->caps[3]);
  ScrDyn *result = scr_dyn_call(cb, args, argc, "callback");
  scr_dyn_release(result);
  scr_dyn_release(value);
  scr_dyn_release(err);
  scr_dyn_release(cb);
}

static void uc_schedule_callback(ScrDyn *cb, ScrDyn *err /* moves in */, ScrDyn *value /* moves in */,
                                 size_t argc) {
  ScrClosure *tick = scr_closure_new((void *)uc_callback_tick, 4);
  tick->caps[0] = uc_box(scr_dyn_retain(cb));
  tick->caps[1] = uc_box(err);
  tick->caps[2] = uc_box(value);
  tick->caps[3] = scr_box_new(SCR_BOX_F64);
  scr_box_set_f64(tick->caps[3], (double)argc);
  scr_next_tick(tick);
}

static ScrDyn *uc_callbackify_fulfilled(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  ScrDyn *cb = uc_cap(closure, 0);
  uc_schedule_callback(cb, scr_dyn_new_null(), scr_dyn_retain(argc ? args[0] : scr_dyn_undefined()), 2);
  scr_dyn_release(cb);
  return scr_dyn_retain(scr_dyn_undefined());
}

static ScrDyn *uc_callbackify_rejected(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  ScrDyn *cb = uc_cap(closure, 0);
  ScrDyn *reason = argc ? args[0] : scr_dyn_undefined();
  ScrDyn *err;
  if (scr_dyn_truthy(reason)) {
    err = scr_dyn_retain(reason);
  } else {
    static const char message[] = "Promise was rejected with falsy value";
    ScrStr *text = scr_str_new(message, sizeof message - 1);
    ScrError *e = scr_error_new(SCR_ERR_ERROR, text);
    scr_str_release(text);
    scr_error_set_code(e, "ERR_FALSY_VALUE_REJECTION");
    scr_error_set_prop(e, "reason", 6, scr_dyn_retain(reason));
    err = scr_dyn_from_error(e);
    scr_error_release(e);
  }
  uc_schedule_callback(cb, err, scr_dyn_retain(scr_dyn_undefined()), 1);
  scr_dyn_release(cb);
  return scr_dyn_retain(scr_dyn_undefined());
}

static ScrDyn *uc_reaction(ScrDyn *cb, ScrDynThunk thunk) {
  ScrClosure *closure = scr_closure_new(NULL, 1);
  closure->caps[0] = uc_box(scr_dyn_retain(cb));
  return scr_dyn_new_func(closure, thunk, 1, "native:util.callbackify", "");
}

static void uc_last_argument_fail(const ScrDyn *got) {
  char detail[256];
  const char *received = scr_dyn_specific_type(got, detail, sizeof detail);
  ScrJsonBuf b;
  scr_jb_init(&b);
  scr_jb_puts(&b, "The last argument must be of type function. Received ");
  scr_jb_puts(&b, received);
  ScrStr *message = scr_jb_finish(&b);
  scr_throw_error_msg_code(SCR_ERR_TYPE, message->data, message->len, "ERR_INVALID_ARG_TYPE");
  scr_str_release(message);
}

static ScrDyn *uc_callbackified_call(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  ScrDyn *maybe_cb = argc ? args[argc - 1] : scr_dyn_undefined();
  if (maybe_cb->kind == SCR_DYN_PROXY && scr_dyn_is_callable(maybe_cb)) {
    uc_fence("util.callbackify callbacks that are Proxy values have no lowering");
    return NULL;
  }
  if (maybe_cb->kind != SCR_DYN_FUNC) {
    uc_last_argument_fail(maybe_cb);
    return NULL;
  }
  ScrDyn *receiver = scr_dyn_this_get();
  ScrDyn *bind_args[1] = {receiver};
  ScrDyn *cb = scr_dyn_bind(maybe_cb, bind_args, 1);
  ScrDyn *original = uc_cap(closure, 0);
  ScrDyn *returned = uc_apply(original, receiver, args, argc ? argc - 1 : 0);
  scr_dyn_release(original);
  scr_dyn_release(receiver);
  if (!returned) {
    scr_dyn_release(cb);
    return NULL;
  }
  ScrDyn *on_fulfilled = uc_reaction(cb, uc_callbackify_fulfilled);
  ScrDyn *on_rejected = uc_reaction(cb, uc_callbackify_rejected);
  scr_dyn_release(cb);
  ScrDyn *chained = NULL;
  ScrPromise *promise = scr_dyn_promise_of(returned);
  if (promise) {
    chained = scr_dyn_promise_then(promise, on_fulfilled, on_rejected, NULL);
  } else if (uc_nullish(returned)) {
    uc_type_error(returned->kind == SCR_DYN_NULL ? "Cannot read properties of null (reading 'then')"
                                                 : "Cannot read properties of undefined (reading 'then')");
  } else {
    ScrDyn *then = uc_get(returned, "then");
    if (then && scr_dyn_is_callable(then)) {
      ScrDyn *reactions[2] = {on_fulfilled, on_rejected};
      chained = uc_apply(then, returned, reactions, 2);
    } else if (then) {
      uc_type_error("ReflectApply(...).then is not a function");
    }
    scr_dyn_release(then);
  }
  scr_dyn_release(on_rejected);
  scr_dyn_release(on_fulfilled);
  scr_dyn_release(returned);
  if (!chained) return NULL;
  scr_dyn_release(chained);
  return scr_dyn_retain(scr_dyn_undefined());
}

ScrDyn *scr_util_callbackify(ScrDyn *original) {
  if (!scr_dyn_is_callable(original)) {
    scr_dyn_arg_type_fail("original", "of type function", original);
    return NULL;
  }
  ScrClosure *closure = scr_closure_new(NULL, 1);
  closure->function_kind = SCR_CLOSURE_KIND_OWN_PROTOTYPE;
  closure->caps[0] = uc_box(scr_dyn_retain(original));
  ScrDyn *callbackified =
    scr_dyn_new_func(closure, uc_callbackified_call, 0, "native:util.callbackify", "callbackified");
  /* original's own descriptors, with a numeric length one longer and a
   * string name suffixed "Callbackified". */
  ScrDyn *descriptors = scr_dyn_get_own_property_descriptors(original);
  if (!descriptors) {
    scr_dyn_release(callbackified);
    return NULL;
  }
  if (descriptors->kind == SCR_DYN_OBJ) {
    ScrDyn *length = scr_dyn_obj_get(descriptors, "length", 6);
    const ScrDyn *length_value = length && length->kind == SCR_DYN_OBJ ? scr_dyn_obj_get(length, "value", 5) : NULL;
    if (length_value && length_value->kind == SCR_DYN_NUM)
      scr_dyn_obj_set(length, "value", 5, scr_dyn_new_num(length_value->v.num + 1));
    ScrDyn *name = scr_dyn_obj_get(descriptors, "name", 4);
    const ScrDyn *name_value = name && name->kind == SCR_DYN_OBJ ? scr_dyn_obj_get(name, "value", 5) : NULL;
    if (name_value && name_value->kind == SCR_DYN_STR) {
      ScrStr *suffix = scr_str_new("Callbackified", 13);
      ScrStr *joined = scr_str_concat(name_value->v.str, suffix);
      scr_str_release(suffix);
      scr_dyn_obj_set(name, "value", 5, scr_dyn_new_str(joined));
      scr_str_release(joined);
    }
  }
  ScrDyn *defined = scr_dyn_define_props(callbackified, descriptors);
  scr_dyn_release(descriptors);
  if (!defined) {
    scr_dyn_release(callbackified);
    return NULL;
  }
  scr_dyn_release(defined);
  return callbackified;
}

/* ── util.debuglog ─────────────────────────────────────────────────────
 * The logger defers its NODE_DEBUG test to its first call or `enabled`
 * read. The first call also selects the section's shared implementation
 * (a writer for enabled sections, a no-op otherwise), hands it to the
 * callback with its own `enabled` getter, and forwards every later call
 * while the section is enabled. */
enum { UC_LOG_SET, UC_LOG_CB, UC_LOG_ENABLED, UC_LOG_DEBUG, UC_LOG_TESTED, UC_LOG_CAPS };

static SCR_TL ScrDyn *uc_debug_impls = NULL;
static SCR_TL ScrRegex *uc_debug_pattern = NULL;
static SCR_TL bool uc_debug_pattern_ready = false;

static void uc_debug_teardown(void) {
  scr_dyn_release(uc_debug_impls);
  uc_debug_impls = NULL;
  scr_regex_release(uc_debug_pattern);
  uc_debug_pattern = NULL;
  uc_debug_pattern_ready = false;
}

static void uc_debug_register(void) {
  static SCR_TL bool registered = false;
  if (registered) return;
  registered = true;
  scr_atexit(uc_debug_teardown);
}

/* initializeDebugEnv: ^name$ alternatives over the comma list, with '*'
 * as a wildcard and the other regexp syntax escaped, case-insensitive. */
static bool uc_debug_test(const ScrStr *section) {
  if (!uc_debug_pattern_ready) {
    uc_debug_pattern_ready = true;
    uc_debug_register();
    const char *env = scr_node_debug_initial();
    if (env && *env) {
      ScrJsonBuf pattern;
      scr_jb_init(&pattern);
      scr_jb_putc(&pattern, '^');
      for (const char *p = env; *p; p++) {
        if (strchr("|\\{}()[]^$+?.", *p)) {
          scr_jb_putc(&pattern, '\\');
          scr_jb_putc(&pattern, *p);
        } else if (*p == '*') {
          scr_jb_puts(&pattern, ".*");
        } else if (*p == ',') {
          scr_jb_puts(&pattern, "$|^");
        } else {
          scr_jb_putc(&pattern, *p);
        }
      }
      scr_jb_putc(&pattern, '$');
      ScrStr *source = scr_jb_finish(&pattern);
      ScrStr *flags = scr_str_new("i", 1);
      uc_debug_pattern = scr_regex_new(source, flags);
      scr_str_release(flags);
      scr_str_release(source);
      if (scr_exc_pending()) return false;
    }
  }
  return uc_debug_pattern != NULL && scr_regex_test(uc_debug_pattern, (ScrStr *)section);
}

static ScrDyn *uc_debug_write(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  bool colors = scr_getenv("FORCE_COLOR") ? scr_util_terminal_colors()
                                          : scr_process_is_tty(2) && scr_util_terminal_colors();
  ScrInspFormatOptions options;
  scr_insp_format_defaults(&options, "util.debuglog");
  options.colors = colors;
  ScrStr *message = scr_insp_format(args, argc, &options);
  if (!message) return NULL;
  ScrDyn *set = uc_cap(closure, 0);
  char pid[64];
  long id = (long)scr_process_pid();
  if (colors) snprintf(pid, sizeof pid, "\x1b[33m%ld\x1b[39m", id);
  else snprintf(pid, sizeof pid, "%ld", id);
  ScrJsonBuf line;
  scr_jb_init(&line);
  scr_jb_put_str(&line, set->v.str);
  scr_jb_putc(&line, ' ');
  scr_jb_puts(&line, pid);
  scr_jb_puts(&line, ": ");
  scr_jb_put_str(&line, message);
  scr_jb_putc(&line, '\n');
  ScrStr *text = scr_jb_finish(&line);
  scr_process_stderr_write(text);
  scr_str_release(text);
  scr_str_release(message);
  scr_dyn_release(set);
  return scr_exc_pending() ? NULL : scr_dyn_retain(scr_dyn_undefined());
}

static ScrDyn *uc_debug_noop(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  (void)closure; (void)args; (void)argc;
  return scr_dyn_retain(scr_dyn_undefined());
}

/* debuglogImpl: one implementation per upper-cased section. */
static ScrDyn *uc_debug_impl(bool enabled, ScrDyn *set) {
  uc_debug_register();
  if (!uc_debug_impls) uc_debug_impls = scr_dyn_new_obj_null_proto();
  const ScrStr *key = set->v.str;
  ScrDyn *impl = scr_dyn_obj_get(uc_debug_impls, key->data, key->len);
  if (impl) return scr_dyn_retain(impl);
  if (enabled) {
    if ((key->len == 4 && !memcmp(key->data, "HTTP", 4)) || (key->len == 5 && !memcmp(key->data, "HTTP2", 5))) {
      ScrJsonBuf warning;
      scr_jb_init(&warning);
      scr_jb_puts(&warning, "Setting the NODE_DEBUG environment variable to '");
      scr_jb_puts(&warning, key->len == 4 ? "http" : "http2");
      scr_jb_puts(&warning, "' can expose sensitive data (such as passwords, tokens and authentication headers) in the resulting log.");
      ScrStr *text = scr_jb_finish(&warning);
      scr_process_emit_warning_text(text);
      scr_str_release(text);
    }
    ScrClosure *closure = scr_closure_new(NULL, 1);
    closure->function_kind = SCR_CLOSURE_KIND_OWN_PROTOTYPE;
    closure->caps[0] = uc_box(scr_dyn_retain(set));
    impl = scr_dyn_new_func(closure, uc_debug_write, 0, "native:util.debuglog", "debug");
  } else {
    impl = scr_dyn_new_func(scr_closure_new(NULL, 0), uc_debug_noop, 0, "native:util.debuglog", "noop");
  }
  scr_dyn_obj_set(uc_debug_impls, key->data, key->len, scr_dyn_retain(impl));
  return impl;
}

/* init(): upper-case the section and test it. */
static bool uc_debug_init(ScrClosure *closure) {
  ScrDyn *set = uc_cap(closure, UC_LOG_SET);
  if (uc_nullish(set)) {
    scr_dyn_release(set);
    uc_type_error("String.prototype.toUpperCase called on null or undefined");
    return false;
  }
  ScrStr *text = scr_dyn_string_coerce_js(set);
  scr_dyn_release(set);
  if (!text) return false;
  ScrStr *upper = scr_str_to_upper(text);
  scr_str_release(text);
  uc_set_cap(closure, UC_LOG_SET, scr_dyn_new_str(upper));
  bool enabled = uc_debug_test(upper);
  scr_str_release(upper);
  if (scr_exc_pending()) return false;
  uc_set_cap(closure, UC_LOG_ENABLED, scr_dyn_new_bool(enabled));
  return true;
}

static ScrDyn *uc_enabled_getter(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  (void)args; (void)argc;
  return uc_cap(closure, 0);
}

static ScrDyn *uc_enabled_accessor(ScrBox *enabled) {
  ScrClosure *closure = scr_closure_new(NULL, 1);
  closure->caps[0] = scr_box_retain(enabled);
  return scr_dyn_new_func(closure, uc_enabled_getter, 0, "native:util.debuglog", "get");
}

static bool uc_define_enabled(ScrDyn *target, ScrDyn *getter /* moves in */) {
  ScrDyn *descriptor = scr_dyn_new_obj();
  scr_dyn_obj_set(descriptor, "get", 3, getter);
  scr_dyn_obj_set(descriptor, "configurable", 12, scr_dyn_new_bool(true));
  scr_dyn_obj_set(descriptor, "enumerable", 10, scr_dyn_new_bool(true));
  return uc_define(target, "enabled", descriptor);
}

static ScrDyn *uc_logger_call(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  ScrDyn *enabled = uc_cap(closure, UC_LOG_ENABLED);
  bool disabled = enabled->kind == SCR_DYN_BOOL && !enabled->v.b;
  scr_dyn_release(enabled);
  if (disabled) return scr_dyn_retain(scr_dyn_undefined());
  ScrDyn *debug = uc_cap(closure, UC_LOG_DEBUG);
  if (debug->kind == SCR_DYN_UNDEF) {
    /* The first call: select the implementation, then the callback. */
    if (!uc_debug_init(closure)) return NULL;
    enabled = uc_cap(closure, UC_LOG_ENABLED);
    ScrDyn *set = uc_cap(closure, UC_LOG_SET);
    debug = uc_debug_impl(enabled->v.b, set);
    scr_dyn_release(set);
    scr_dyn_release(enabled);
    uc_set_cap(closure, UC_LOG_DEBUG, scr_dyn_retain(debug));
    ScrDyn *cb = uc_cap(closure, UC_LOG_CB);
    if (cb->kind == SCR_DYN_FUNC) {
      bool ok = uc_define_enabled(debug, uc_enabled_accessor(closure->caps[UC_LOG_ENABLED]));
      ScrDyn *result = ok ? scr_dyn_call(cb, &debug, 1, "callback") : NULL;
      scr_dyn_release(result);
      if (!result) {
        scr_dyn_release(cb);
        scr_dyn_release(debug);
        return NULL;
      }
    }
    scr_dyn_release(cb);
  }
  ScrDyn *result = scr_dyn_call(debug, args, argc, "debug");
  scr_dyn_release(debug);
  return result;
}

static ScrDyn *uc_logger_enabled(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  (void)args; (void)argc;
  if (scr_box_get_f64(closure->caps[UC_LOG_TESTED]) == 0) {
    if (!uc_debug_init(closure)) return NULL;
    scr_box_set_f64(closure->caps[UC_LOG_TESTED], 1);
  }
  return uc_cap(closure, UC_LOG_ENABLED);
}

ScrDyn *scr_util_debuglog(ScrDyn *section, ScrDyn *callback) {
  ScrClosure *closure = scr_closure_new(NULL, UC_LOG_CAPS);
  closure->caps[UC_LOG_SET] = uc_box(scr_dyn_retain(section));
  closure->caps[UC_LOG_CB] = uc_box(scr_dyn_retain(callback));
  closure->caps[UC_LOG_ENABLED] = uc_box(scr_dyn_retain(scr_dyn_undefined()));
  closure->caps[UC_LOG_DEBUG] = uc_box(scr_dyn_retain(scr_dyn_undefined()));
  closure->caps[UC_LOG_TESTED] = scr_box_new(SCR_BOX_F64);
  /* The `enabled` getter shares the logger's state boxes. */
  ScrClosure *getter = scr_closure_new(NULL, UC_LOG_CAPS);
  for (size_t i = 0; i < UC_LOG_CAPS; i++) getter->caps[i] = scr_box_retain(closure->caps[i]);
  ScrDyn *logger = scr_dyn_new_func(closure, uc_logger_call, 0, "native:util.debuglog", "logger");
  ScrDyn *get = scr_dyn_new_func(getter, uc_logger_enabled, 0, "native:util.debuglog", "get");
  if (!uc_define_enabled(logger, get)) {
    scr_dyn_release(logger);
    return NULL;
  }
  return logger;
}

/* ── util.diff(actual, expected) ───────────────────────────────────────
 * Node's diff over strings (one entry per UTF-16 code unit) or arrays of
 * strings: identical values answer an empty array before validation;
 * otherwise each value must be a string or an array of strings
 * (ERR_INVALID_ARG_TYPE naming `actual`, `actual[i]`, ...), and the answer
 * is myersDiff's operation list reversed: [0, item] for kept items,
 * [1, item] for items of actual and [-1, item] for items of expected. */
typedef struct {
  ScrStr **items;
  size_t len;
} UcDiffSeq;

static void uc_diff_seq_free(UcDiffSeq *seq) {
  for (size_t i = 0; i < seq->len; i++) scr_str_release(seq->items[i]);
  free(seq->items);
  seq->items = NULL;
  seq->len = 0;
}

static bool uc_diff_input(const ScrDyn *value, const char *name, UcDiffSeq *out) {
  out->items = NULL;
  out->len = 0;
  if (value->kind == SCR_DYN_STR) {
    ScrStr *text = value->v.str;
    size_t len = (size_t)scr_str_utf16_len(text);
    out->items = malloc((len ? len : 1) * sizeof *out->items);
    if (!out->items) scr_trap("scriptc: out of memory\n");
    for (size_t i = 0; i < len; i++) out->items[out->len++] = scr_str_char_at(text, (double)i);
    return true;
  }
  ScrDyn *array = value->kind == SCR_DYN_TYPED_REF && scr_dyn_ref_is_array(value)
                      ? scr_dyn_typed_ref_materialize(value)
                      : value->kind == SCR_DYN_ARR ? scr_dyn_retain((ScrDyn *)value) : NULL;
  if (!array) {
    scr_dyn_arg_type_fail(name, "of type string", value);
    return false;
  }
  size_t len = array->v.arr.len;
  out->items = malloc((len ? len : 1) * sizeof *out->items);
  if (!out->items) scr_trap("scriptc: out of memory\n");
  for (size_t i = 0; i < len; i++) {
    const ScrDyn *item = array->v.arr.presence && !array->v.arr.presence[i] ? scr_dyn_undefined()
                                                                            : array->v.arr.items[i];
    if (item->kind != SCR_DYN_STR) {
      char element[64];
      snprintf(element, sizeof element, "%s[%zu]", name, i);
      scr_dyn_arg_type_fail(element, "of type string", item);
      scr_dyn_release(array);
      uc_diff_seq_free(out);
      return false;
    }
    out->items[out->len++] = scr_str_retain(item->v.str);
  }
  scr_dyn_release(array);
  return true;
}

static void uc_diff_push(ScrDyn *result, int op, ScrStr *item) {
  ScrDyn *entry = scr_dyn_new_arr();
  scr_dyn_arr_push(entry, scr_dyn_new_num((double)op));
  scr_dyn_arr_push(entry, scr_dyn_new_str(item));
  scr_dyn_arr_push(result, entry);
}

ScrDyn *scr_util_diff(ScrDyn *actual, ScrDyn *expected) {
  if (scr_dyn_strict_eq(actual, expected)) return scr_dyn_new_arr();
  UcDiffSeq a, e;
  if (!uc_diff_input(actual, "actual", &a)) return NULL;
  if (!uc_diff_input(expected, "expected", &e)) {
    uc_diff_seq_free(&a);
    return NULL;
  }
  size_t max = a.len + e.len;
  if (max > 2147483647u) {
    uc_diff_seq_free(&a);
    uc_diff_seq_free(&e);
    char message[160];
    int n = snprintf(message, sizeof message,
                     "The value of \"myersDiff input size\" is out of range. It must be < 2^31. Received %zu", max);
    scr_throw_error_msg_code(SCR_ERR_RANGE, message, (size_t)n, "ERR_OUT_OF_RANGE");
    return NULL;
  }
  /* Two distinct empty sequences: Node's myersDiff reads past its
   * one-element state, finds no end and answers undefined, which the
   * ArrayPrototypeReverse of util.diff rejects. The trace below would be read
   * out of bounds. */
  if (max == 0) {
    uc_diff_seq_free(&a);
    uc_diff_seq_free(&e);
    static const char message[] = "Cannot convert undefined or null to object";
    scr_throw_error_msg(SCR_ERR_TYPE, message, sizeof message - 1);
    return NULL;
  }
  size_t width = 2 * max + 1;
  int32_t *v = calloc(width, sizeof *v);
  int32_t **trace = malloc((max + 1) * sizeof *trace);
  if (!v || !trace) scr_trap("scriptc: out of memory\n");
  size_t levels = 0;
  bool done = false;
  for (size_t level = 0; level <= max && !done; level++) {
    trace[levels] = malloc(width * sizeof **trace);
    if (!trace[levels]) scr_trap("scriptc: out of memory\n");
    memcpy(trace[levels], v, width * sizeof *v);
    levels++;
    long d = (long)level;
    for (long k = -d; k <= d; k += 2) {
      size_t offset = (size_t)(k + (long)max);
      int32_t previous = offset > 0 ? v[offset - 1] : 0;
      int32_t next = offset + 1 < width ? v[offset + 1] : 0;
      long x = k == -d || (k != d && previous < next) ? next : (long)previous + 1;
      long y = x - k;
      while ((size_t)x < a.len && y >= 0 && (size_t)y < e.len && scr_str_eq(a.items[x], e.items[y])) {
        x++;
        y++;
      }
      v[offset] = (int32_t)x;
      if ((size_t)x >= a.len && y >= 0 && (size_t)y >= e.len) {
        done = true;
        break;
      }
    }
  }
  /* backtrack: the operations from the end, which the answer reverses. */
  ScrDyn *reversed = scr_dyn_new_arr();
  long x = (long)a.len, y = (long)e.len;
  for (long level = (long)levels - 1; level >= 0; level--) {
    const int32_t *row = trace[level];
    long k = x - y;
    size_t offset = (size_t)(k + (long)max);
    long prev_k;
    if (k == -level || (k != level && row[offset - 1] < row[offset + 1])) prev_k = k + 1;
    else prev_k = k - 1;
    long prev_x = row[(size_t)(prev_k + (long)max)];
    long prev_y = prev_x - prev_k;
    while (x > prev_x && y > prev_y) {
      uc_diff_push(reversed, 0, a.items[x - 1]);
      x--;
      y--;
    }
    if (level > 0) {
      if (x > prev_x) uc_diff_push(reversed, 1, a.items[--x]);
      else uc_diff_push(reversed, -1, e.items[--y]);
    }
  }
  for (size_t i = 0; i < levels; i++) free(trace[i]);
  free(trace);
  free(v);
  ScrDyn *result = scr_dyn_new_arr();
  for (size_t i = reversed->v.arr.len; i-- > 0;) scr_dyn_arr_push(result, scr_dyn_retain(reversed->v.arr.items[i]));
  scr_dyn_release(reversed);
  uc_diff_seq_free(&a);
  uc_diff_seq_free(&e);
  return result;
}
