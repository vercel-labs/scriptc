/* WebIDL interfaces over dyn handles (ScrDynHandleClass): the constructor
 * value of a handle tag, with a prototype that holds the tag's methods and
 * getters. Each member is brand-checked against the tag: on another
 * receiver a method or getter raises the class's ERR_INVALID_THIS TypeError,
 * or answers a promise rejected with it for the promise-valued ones, as
 * Node's implementations do. The constructor runs the class's construct
 * entry under `new`, throws Node's "Class constructor X cannot be invoked
 * without 'new'" TypeError when called, and throws the ERR_ILLEGAL_CONSTRUCTOR
 * TypeError for interfaces without a constructor (controllers).
 *
 * One constructor and one prototype per tag and thread, so every read of
 * the class value is the same function. */
#include "scr_runtime.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static SCR_TL const ScrDynHandleClass *hc_classes[SCR_DYNH_CAPACITY];
/* The class tag of another tag's handles + 1 (scr_dyn_handle_class_alias);
 * 0 = none. */
static SCR_TL uint16_t hc_aliases[SCR_DYNH_CAPACITY];
static SCR_TL ScrDyn *hc_ctors[SCR_DYNH_CAPACITY];
static SCR_TL ScrDyn *hc_prototypes[SCR_DYNH_CAPACITY];
static SCR_TL bool hc_teardown_registered;

static const ScrDynHandleOps *hc_ops(ScrDynHandleTag tag) {
  ScrDyn probe;
  probe.kind = SCR_DYN_HANDLE;
  probe.v.handle.tag = tag;
  probe.v.handle.ptr = NULL;
  return scr_dyn_handle_ops_of(&probe);
}

static ScrDyn *hc_string(const char *text) {
  ScrStr *s = scr_str_new(text, strlen(text));
  ScrDyn *d = scr_dyn_new_str(s);
  scr_str_release(s);
  return d;
}

/* Defines `name` on target as a data property with the given attributes;
 * the value moves in. */
static void hc_define(ScrDyn *target, const char *name, ScrDyn *value, bool writable, bool enumerable,
                      bool configurable) {
  ScrDyn *descriptor = scr_dyn_new_obj();
  scr_dyn_obj_set(descriptor, "value", 5, value);
  scr_dyn_obj_set(descriptor, "writable", 8, scr_dyn_new_bool(writable));
  scr_dyn_obj_set(descriptor, "enumerable", 10, scr_dyn_new_bool(enumerable));
  scr_dyn_obj_set(descriptor, "configurable", 12, scr_dyn_new_bool(configurable));
  ScrDyn *key = hc_string(name);
  ScrDyn *defined = scr_dyn_define_property(target, key, descriptor);
  scr_dyn_release(key);
  scr_dyn_release(descriptor);
  if (defined) scr_dyn_release(defined);
}

static void hc_invalid_this(const ScrDynHandleOps *ops) {
  const char *message = ops->invalid_this ? ops->invalid_this : "Illegal invocation";
  scr_throw_error_msg_code(SCR_ERR_TYPE, message, strlen(message), "ERR_INVALID_THIS");
}

static ScrDynHandleTag hc_tag_of(ScrClosure *closure) {
  return (ScrDynHandleTag)scr_box_get_f64(closure->caps[0]);
}

/* A getter: closure->fn is the accessor, caps[0] the tag. */
static ScrDyn *hc_getter(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  (void)args;
  (void)argc;
  const ScrDynHandleAccessor *accessor = closure->fn;
  ScrDynHandleTag tag = hc_tag_of(closure);
  const ScrDynHandleOps *ops = hc_ops(tag);
  ScrDyn *self = scr_dyn_this_get();
  ScrDyn *result = NULL;
  if (self->kind == SCR_DYN_HANDLE && self->v.handle.tag == tag) {
    result = ops->get(self->v.handle.ptr, accessor->name, strlen(accessor->name));
    if (!result && !scr_exc_pending()) result = scr_dyn_retain(scr_dyn_undefined());
  } else {
    hc_invalid_this(ops);
    if (accessor->rejects && ops->rejected) result = ops->rejected();
  }
  scr_dyn_release(self);
  return result;
}

/* The constructor: caps[0] is the tag. scr_dyn_construct calls it with a
 * fresh receiver whose prototype is the class's; any other receiver means
 * a call without `new`. */
static ScrDyn *hc_construct(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  ScrDynHandleTag tag = hc_tag_of(closure);
  const ScrDynHandleClass *klass = hc_classes[tag];
  ScrDyn *self = scr_dyn_this_get();
  bool constructing = false;
  if (self->kind == SCR_DYN_OBJ && hc_prototypes[tag]) {
    ScrDyn *prototype = scr_dyn_get_prototype(self);
    constructing = prototype && prototype == hc_prototypes[tag];
    if (prototype) scr_dyn_release(prototype);
    if (scr_exc_pending()) scr_exc_clear();
  }
  scr_dyn_release(self);
  if (!constructing) {
    size_t n = strlen(klass->name) + 64;
    char *message = malloc(n);
    if (!message) scr_trap("scriptc: out of memory\n");
    int len = snprintf(message, n, "Class constructor %s cannot be invoked without 'new'", klass->name);
    scr_throw_error_msg(SCR_ERR_TYPE, message, (size_t)len);
    free(message);
    return NULL;
  }
  if (!klass->construct) {
    static const char message[] = "Illegal constructor";
    scr_throw_error_msg_code(SCR_ERR_TYPE, message, sizeof message - 1, "ERR_ILLEGAL_CONSTRUCTOR");
    return NULL;
  }
  return klass->construct(args, argc);
}

static void hc_teardown(void) {
  for (size_t tag = 0; tag < SCR_DYNH_CAPACITY; tag++) {
    if (!hc_ctors[tag]) continue;
    /* prototype.constructor points back at the constructor. */
    ScrStr *key = scr_str_new("constructor", 11);
    scr_dyn_key_set(hc_prototypes[tag], key, scr_dyn_undefined());
    scr_str_release(key);
    if (scr_exc_pending()) scr_exc_clear();
  }
  for (size_t tag = 0; tag < SCR_DYNH_CAPACITY; tag++) {
    if (hc_prototypes[tag]) scr_dyn_release(hc_prototypes[tag]);
    if (hc_ctors[tag]) scr_dyn_release(hc_ctors[tag]);
    hc_prototypes[tag] = NULL;
    hc_ctors[tag] = NULL;
  }
}

static void hc_create(ScrDynHandleTag tag);

ScrDyn *scr_dyn_handle_class_prototype(ScrDynHandleTag tag) {
  if (!hc_prototypes[tag]) {
    if (!hc_classes[tag]) return NULL;
    hc_create(tag);
  }
  return scr_dyn_retain(hc_prototypes[tag]);
}

ScrDyn *scr_dyn_handle_class_method(ScrDynHandleTag tag, const char *name) {
  /* A member read on a handle answers the method's one function value; the
   * class's get answers no method name, so a handle without a referent
   * reads it. */
  ScrDyn probe;
  memset(&probe, 0, sizeof probe);
  probe.kind = SCR_DYN_HANDLE;
  probe.v.handle.tag = tag;
  ScrStr *key = scr_str_new(name, strlen(name));
  ScrDyn *value = scr_dyn_handle_key_get(&probe, key);
  scr_str_release(key);
  if (value && !scr_dyn_is_callable(value)) {
    scr_dyn_release(value);
    return NULL;
  }
  return value;
}

ScrDyn *scr_dyn_handle_class_member(ScrDynHandleTag tag, void *h, const char *key, size_t len) {
  const ScrDynHandleMethod *methods = hc_ops(tag)->methods;
  for (size_t i = 0; methods && methods[i].name; i++)
    if (strlen(methods[i].name) == len && memcmp(methods[i].name, key, len) == 0) return NULL;
  ScrDyn *prototype = scr_dyn_handle_class_prototype(tag);
  if (!prototype) return NULL;
  ScrStr *text = scr_str_new(key, len);
  ScrDyn *name = scr_dyn_new_str(text);
  scr_str_release(text);
  /* Handles compare by referent, so a fresh box over h is the receiver. */
  ScrDyn *receiver = scr_dyn_new_handle(h, tag);
  ScrDyn *value = scr_dyn_reflect_get(prototype, name, receiver);
  scr_dyn_release(receiver);
  scr_dyn_release(name);
  scr_dyn_release(prototype);
  if (value && value->kind == SCR_DYN_UNDEF) {
    scr_dyn_release(value);
    return NULL;
  }
  return value;
}

ScrDyn *scr_dyn_handle_class_method_call(const ScrDynHandleOps *ops, ScrDyn *self, const char *method,
                                         ScrDyn *const *args, size_t argc) {
  const ScrDynHandleClass *klass = hc_classes[self->v.handle.tag];
  if (klass && klass->method_invoke)
    return klass->method_invoke(self->v.handle.ptr, self, method, args, argc, method);
  return ops->invoke(self->v.handle.ptr, self, method, args, argc, method);
}

static void hc_define_method(ScrDyn *prototype, ScrDynHandleTag tag, const char *name) {
  ScrDyn *fn = scr_dyn_handle_class_method(tag, name);
  if (fn) hc_define(prototype, name, fn, true, true, true);
}

static void hc_define_getter(ScrDyn *prototype, ScrDynHandleTag tag, const ScrDynHandleAccessor *a) {
  ScrClosure *getter_closure = scr_closure_new((void *)a, 1);
  getter_closure->caps[0] = scr_box_new(SCR_BOX_F64);
  scr_box_set_f64(getter_closure->caps[0], (double)tag);
  ScrDyn *getter = scr_dyn_new_func(getter_closure, hc_getter, 0, "", a->name);
  scr_dyn_obj_set_accessor(prototype, a->name, strlen(a->name), getter, NULL);
}

static void hc_create(ScrDynHandleTag tag) {
  const ScrDynHandleOps *ops = hc_ops(tag);
  const ScrDynHandleClass *klass = hc_classes[tag];
  if (!klass) scr_trap("scriptc: internal error: dyn handle has no class value\n");
  ScrClosure *closure = scr_closure_new(NULL, 1);
  closure->function_kind = SCR_CLOSURE_KIND_OWN_PROTOTYPE;
  closure->caps[0] = scr_box_new(SCR_BOX_F64);
  scr_box_set_f64(closure->caps[0], (double)tag);
  ScrDyn *ctor = scr_dyn_new_func(closure, hc_construct, klass->length, "native:constructor", klass->name);
  ScrDyn *prototype = scr_dyn_new_obj();
  hc_ctors[tag] = ctor;
  hc_prototypes[tag] = prototype;
  hc_define(prototype, "constructor", scr_dyn_retain(ctor), true, false, true);
  hc_define(ctor, "prototype", scr_dyn_retain(prototype), false, false, false);
  if (klass->order) {
    for (const char *const *name = klass->order; *name; name++) {
      const ScrDynHandleAccessor *accessor = NULL;
      for (const ScrDynHandleAccessor *a = klass->accessors; a && a->name; a++)
        if (strcmp(a->name, *name) == 0) accessor = a;
      if (accessor) hc_define_getter(prototype, tag, accessor);
      else hc_define_method(prototype, tag, *name);
    }
  } else {
    for (const ScrDynHandleMethod *m = ops->methods; m && m->name; m++) hc_define_method(prototype, tag, m->name);
    for (const ScrDynHandleAccessor *a = klass->accessors; a && a->name; a++) hc_define_getter(prototype, tag, a);
  }
  for (const ScrDynHandleStatic *st = klass->statics; st && st->name; st++) {
    ScrDyn *fn = scr_dyn_new_func(scr_closure_new(NULL, 0), st->thunk, st->length, "", st->name);
    hc_define(ctor, st->name, fn, true, false, true);
  }
  if (scr_exc_pending()) scr_exc_clear();
  if (!hc_teardown_registered) {
    hc_teardown_registered = true;
    scr_atexit(hc_teardown);
  }
}

void scr_dyn_handle_class_alias(ScrDynHandleTag tag, ScrDynHandleTag klass_tag) {
  hc_aliases[tag] = (uint16_t)(klass_tag + 1);
}

ScrDynHandleTag scr_dyn_handle_class_tag_of(const ScrDyn *handle) {
  ScrDynHandleTag tag = handle->v.handle.tag;
  if (hc_classes[tag]) return tag;
  return hc_aliases[tag] ? (ScrDynHandleTag)(hc_aliases[tag] - 1) : SCR_DYNH_CAPACITY;
}

ScrDyn *scr_dyn_handle_class_prototype_of(const ScrDyn *handle) {
  ScrDynHandleTag tag = scr_dyn_handle_class_tag_of(handle);
  return tag == SCR_DYNH_CAPACITY ? NULL : scr_dyn_handle_class_prototype(tag);
}

void scr_dyn_handle_class_install(ScrDynHandleTag tag, const ScrDynHandleOps *ops, const ScrDynHandleClass *klass) {
  scr_dyn_handle_install(tag, ops);
  hc_classes[tag] = klass;
}

ScrDyn *scr_dyn_handle_class_value(ScrDynHandleTag tag) {
  if (!hc_ctors[tag]) hc_create(tag);
  return scr_dyn_retain(hc_ctors[tag]);
}
