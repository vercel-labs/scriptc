/* Object.prototype's members on checked-dynamic values: the members a
 * value inherits from Object.prototype (`o.toString`, `o[key]` when the key
 * names one), the interned builtin constructors they answer for
 * `.constructor`, and Object.prototype's own methods as function values.
 *
 * Every dynamic read whose key may name an inherited member links this unit
 * (the frontend's dynInherited feature: constant keys naming one of the five
 * members, and every computed key, which may name one at run time), as does
 * the dyn-invoke unit, which reads the same values. It references only the
 * base units, so a program with computed dynamic reads links this and not
 * the method-dispatch unit.
 *
 * JavaScript reads `Object`, `Date`, `RegExp`, `Map`, `Set`, `Promise`,
 * `WeakMap` and `WeakSet` as interned functions, and the same functions
 * answer `.constructor` on the matching dynamic values, so
 * `o.constructor === Object` and `a.constructor === b.constructor` are
 * exact identity tests. `Object(v)` works through the stored value; calling
 * the others through it is fenced. */
#include "scr_runtime.h"

#include <stdio.h>
#include <string.h>

/* String constants live in named arrays in their own section rather than
 * in the unit's merged string pool. */
#if defined(__APPLE__)
#define SCR_DYN_COMPAT_STR __attribute__((section("__TEXT,__scr_dyn_compat")))
#elif defined(_WIN32)
#define SCR_DYN_COMPAT_STR
#else
#define SCR_DYN_COMPAT_STR __attribute__((section(".rodata.scr_dyn_compat")))
#endif
static const char dyn_s_error_tag[] SCR_DYN_COMPAT_STR = "[object Error]";
static const char dyn_s0[] SCR_DYN_COMPAT_STR = "calling the %s constructor%s through a stored value is not supported yet";
static const char dyn_s4[] SCR_DYN_COMPAT_STR = "propertyIsEnumerable";
static const char dyn_s6[] SCR_DYN_COMPAT_STR = "native:constructor";
static const char dyn_s8[] SCR_DYN_COMPAT_STR = " on a primitive";
static const char dyn_s9[] SCR_DYN_COMPAT_STR = "hasOwnProperty";
static const char dyn_s14[] SCR_DYN_COMPAT_STR = "constructor";
static const char dyn_s18[] SCR_DYN_COMPAT_STR = "toString";
static const char dyn_s21[] SCR_DYN_COMPAT_STR = "Promise";
static const char dyn_s22[] SCR_DYN_COMPAT_STR = "WeakMap";
static const char dyn_s23[] SCR_DYN_COMPAT_STR = "valueOf";
static const char dyn_s24[] SCR_DYN_COMPAT_STR = "WeakSet";
static const char dyn_s25[] SCR_DYN_COMPAT_STR = "RegExp";
static const char dyn_s26[] SCR_DYN_COMPAT_STR = "Object";
static const char dyn_s27[] SCR_DYN_COMPAT_STR = "SC2020";
static const char dyn_s29[] SCR_DYN_COMPAT_STR = "Date";
static const char dyn_s30[] SCR_DYN_COMPAT_STR = "Map";
static const char dyn_s31[] SCR_DYN_COMPAT_STR = "Set";
static const char dyn_s32[] SCR_DYN_COMPAT_STR = "";
static const char dyn_s35[] SCR_DYN_COMPAT_STR = "FinalizationRegistry";
static const char dyn_s36[] SCR_DYN_COMPAT_STR = "native:prototype";

/* Object.prototype.toString's tag: errors answer "[object Error]" (the
 * shared tag walk in scr_json.c answers "[object Object]" for them). */
ScrStr *scr_dyn_object_tag_of(const ScrDyn *d) {
  if (d->kind == SCR_DYN_OBJ && scr_dyn_err_instanceof(d, 0)) return scr_str_new(dyn_s_error_tag, sizeof dyn_s_error_tag - 1);
  return scr_dyn_object_tag(d);
}

/* ── Object.prototype's methods as function values ─────────────────────
 * One interned function per name (the dyn-invoke unit's builtin methods
 * answer these for the Object prototype), called with the receiver as
 * `this`. */
static SCR_TL ScrDyn *dyn_object_methods;

static void dyn_object_methods_cleanup(void) {
  scr_dyn_release(dyn_object_methods);
  dyn_object_methods = NULL;
}

static ScrDyn *dyn_object_method_call(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  ScrStr *method = scr_box_get_ref(closure->caps[0]);
  ScrDyn *receiver = scr_dyn_this_get();
  ScrDyn *result = NULL;
  ScrDyn *key = argc ? args[0] : scr_dyn_undefined();
  if (!strcmp(method->data, dyn_s18)) {
    ScrStr *tag = scr_dyn_object_tag_of(receiver);
    if (tag) { result = scr_dyn_new_str(tag); scr_str_release(tag); }
  } else if (!strcmp(method->data, dyn_s9)) {
    bool own = scr_dyn_has_own_computed(receiver, key);
    if (!scr_exc_pending()) result = scr_dyn_new_bool(own);
  } else if (!strcmp(method->data, dyn_s4)) {
    bool enumerable = scr_dyn_property_is_enumerable_computed(receiver, key);
    if (!scr_exc_pending()) result = scr_dyn_new_bool(enumerable);
  } else if (receiver->kind == SCR_DYN_NULL || receiver->kind == SCR_DYN_UNDEF) {
    static const char message[] = "Cannot convert undefined or null to object";
    scr_throw_error_msg(SCR_ERR_TYPE, message, sizeof message - 1);
  } else if (receiver->kind == SCR_DYN_OBJ || receiver->kind == SCR_DYN_ARR ||
      receiver->kind == SCR_DYN_FUNC || receiver->kind == SCR_DYN_HANDLE ||
      receiver->kind == SCR_DYN_TYPED_REF || receiver->kind == SCR_DYN_PROXY ||
      receiver->kind == SCR_DYN_PROMISE || receiver->kind == SCR_DYN_BYTES) result = scr_dyn_retain(receiver);
  else {
    ScrJsonBuf b;
    scr_jb_init(&b);
    scr_jb_puts(&b, "'Object.prototype.");
    scr_jb_puts(&b, method->data);
    scr_jb_puts(&b, "' on a dynamic value is not supported yet");
    scr_throw_error(SCR_ERR_ERROR, scr_jb_finish(&b));
  }
  scr_dyn_release(receiver);
  scr_str_release(method);
  return result;
}

ScrDyn *scr_dyn_object_prototype_method(const ScrStr *method) {
  if (!dyn_object_methods) {
    dyn_object_methods = scr_dyn_new_obj_null_proto();
    scr_atexit(dyn_object_methods_cleanup);
  }
  ScrDyn *value = scr_dyn_obj_get(dyn_object_methods, method->data, method->len);
  if (!value) {
    ScrClosure *closure = scr_closure_new(NULL, 1);
    closure->caps[0] = scr_box_new(SCR_BOX_STR);
    scr_box_set_ref(closure->caps[0], scr_str_retain((ScrStr *)method));
    size_t arity = !strcmp(method->data, dyn_s9) || !strcmp(method->data, dyn_s4) ? 1 : 0;
    value = scr_dyn_new_func(closure, dyn_object_method_call, arity, dyn_s36, method->data);
    scr_dyn_obj_set(dyn_object_methods, method->data, method->len, value);
  }
  return scr_dyn_retain(value);
}

/* ── The builtin constructors as dynamic values ──────────────────────── */
static const char *const dyn_global_ctor_names[] = {
  dyn_s26, dyn_s29, dyn_s25, dyn_s30, dyn_s31, dyn_s21, dyn_s22, dyn_s24, dyn_s35,
};
#define DYN_GLOBAL_CTORS (sizeof dyn_global_ctor_names / sizeof dyn_global_ctor_names[0])
static SCR_TL ScrDyn *dyn_global_ctors[DYN_GLOBAL_CTORS];
static SCR_TL bool dyn_global_ctors_registered;

static void dyn_global_ctors_cleanup(void) {
  for (size_t i = 0; i < DYN_GLOBAL_CTORS; i++) {
    scr_dyn_release(dyn_global_ctors[i]);
    dyn_global_ctors[i] = NULL;
  }
}

ScrDyn *scr_dyn_global_ctor_call(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  const char *name = closure->fn;
  bool object = strcmp(name, dyn_s26) == 0;
  if (object) {
    const ScrDyn *value = argc ? args[0] : scr_dyn_undefined();
    if (value->kind == SCR_DYN_UNDEF || value->kind == SCR_DYN_NULL) return scr_dyn_new_obj();
    if (value->kind != SCR_DYN_NUM && value->kind != SCR_DYN_STR && value->kind != SCR_DYN_BOOL &&
        value->kind != SCR_DYN_BIGINT && value->kind != SCR_DYN_SYMBOL) {
      return scr_dyn_retain((ScrDyn *)value);
    }
  }
  char message[128];
  int length = snprintf(message, sizeof message, dyn_s0,
                        name, object ? dyn_s8 : dyn_s32);
  scr_throw_error_msg_code(SCR_ERR_ERROR, message, (size_t)length, dyn_s27);
  return NULL;
}

/* `new` through these values (scr_dyn_global_construct.c, which builds
 * the collections and dates): installed at start by programs that construct
 * dynamic values and read inherited members, and by the dyn-invoke unit;
 * set once, before any thread starts. NULL leaves construction to the
 * ordinary path. */
bool (*scr_dyn_global_ctor_construct)(const ScrDyn *callee, const ScrDyn *args, ScrDyn **result) = NULL;

ScrDyn *scr_dyn_global_ctor(const char *name) {
  for (size_t i = 0; i < DYN_GLOBAL_CTORS; i++) {
    if (dyn_global_ctor_names[i][0] != name[0] || strcmp(dyn_global_ctor_names[i], name) != 0) continue;
    if (!dyn_global_ctors_registered) {
      dyn_global_ctors_registered = true;
      scr_atexit(dyn_global_ctors_cleanup);
      if (scr_dyn_global_ctor_construct) scr_dyn_global_construct_fn = scr_dyn_global_ctor_construct;
    }
    if (!dyn_global_ctors[i]) {
      /* Each constructor's own length: Object 1, Date 7, RegExp 2, Promise 1,
       * the collections 0, FinalizationRegistry 1. */
      uint32_t length = i == 0 || i == 5 || i == 8 ? 1 : i == 1 ? 7 : i == 2 ? 2 : 0;
      dyn_global_ctors[i] = scr_dyn_new_func(scr_closure_new((void *)dyn_global_ctor_names[i], 0),
                                             scr_dyn_global_ctor_call, length, dyn_s6,
                                             dyn_global_ctor_names[i]);
    }
    return scr_dyn_retain(dyn_global_ctors[i]);
  }
  return NULL;
}

/* Which Object.prototype members a value inherits when no nearer prototype
 * defines them: types with their own toString or valueOf keep theirs. */
enum { DYN_INHERIT_VALUE_OF = 1, DYN_INHERIT_TO_STRING = 2, DYN_INHERIT_OWN = 4, DYN_INHERIT_ALL = 7 };

static ScrDyn *dyn_inherited_from(const char *ctor, int methods, const ScrStr *key) {
  if (strcmp(key->data, dyn_s14) == 0) return ctor ? scr_dyn_global_ctor(ctor) : NULL;
  bool applies = (strcmp(key->data, dyn_s23) == 0 && (methods & DYN_INHERIT_VALUE_OF)) ||
                 (strcmp(key->data, dyn_s18) == 0 && (methods & DYN_INHERIT_TO_STRING)) ||
                 ((strcmp(key->data, dyn_s9) == 0 || strcmp(key->data, dyn_s4) == 0) &&
                  (methods & DYN_INHERIT_OWN));
  if (!applies) return NULL;
  return scr_dyn_object_prototype_method(key);
}

/* The inherited member `key` of `d` when its own chain does not define it,
 * or NULL (the read's undefined stands). */
static ScrDyn *dyn_inherited_member(const ScrDyn *d, const ScrStr *key) {
  switch (d->kind) {
  case SCR_DYN_TYPED_REF: {
    ScrDyn *view = scr_dyn_typed_ref_materialize(d);
    ScrDyn *member = view && !scr_exc_pending() ? dyn_inherited_member(view, key) : NULL;
    scr_dyn_release(view);
    return member;
  }
  case SCR_DYN_OBJ: {
    /* A plain object, or an Object.create chain ending in Object.prototype;
     * a member present anywhere on the chain (even as undefined) stands. */
    ScrDyn *object_prototype = scr_dyn_object_prototype();
    const ScrDyn *tail = d;
    bool present = false;
    for (const ScrDyn *link = d; link; link = link->prototype) {
      tail = link;
      if (link == object_prototype) break;
      if (link->kind != SCR_DYN_OBJ || scr_dyn_has_own(link, key)) {
        present = true;
        break;
      }
    }
    scr_dyn_release(object_prototype);
    if (present || (tail != object_prototype && tail->null_proto)) return NULL;
    /* Errors keep Error.prototype.toString and their constructor values. */
    if (scr_dyn_err_instanceof(d, 0)) return dyn_inherited_from(NULL, DYN_INHERIT_VALUE_OF | DYN_INHERIT_OWN, key);
    return dyn_inherited_from(dyn_s26, DYN_INHERIT_ALL, key);
  }
  case SCR_DYN_ARR:
    /* Array.prototype defines toString and answers constructor itself. */
    if (d->null_proto || d->prototype || scr_dyn_has_own(d, key)) return NULL;
    return dyn_inherited_from(NULL, DYN_INHERIT_VALUE_OF | DYN_INHERIT_OWN, key);
  case SCR_DYN_FUNC:
    /* Function.prototype defines toString and answers constructor itself. */
    if (scr_dyn_has_own(d, key)) return NULL;
    return dyn_inherited_from(NULL, DYN_INHERIT_VALUE_OF | DYN_INHERIT_OWN, key);
  case SCR_DYN_PROMISE:
    return dyn_inherited_from(dyn_s21, DYN_INHERIT_ALL, key);
  case SCR_DYN_HANDLE:
    switch (d->v.handle.tag) {
    case SCR_DYNH_DATE: return dyn_inherited_from(dyn_s29, DYN_INHERIT_OWN, key);
    case SCR_DYNH_REGEXP: return dyn_inherited_from(dyn_s25, DYN_INHERIT_VALUE_OF | DYN_INHERIT_OWN, key);
    case SCR_DYNH_MAP: return dyn_inherited_from(dyn_s30, DYN_INHERIT_ALL, key);
    case SCR_DYNH_SET: return dyn_inherited_from(dyn_s31, DYN_INHERIT_ALL, key);
    case SCR_DYNH_WEAK_MAP: return dyn_inherited_from(dyn_s22, DYN_INHERIT_ALL, key);
    case SCR_DYNH_WEAK_SET: return dyn_inherited_from(dyn_s24, DYN_INHERIT_ALL, key);
    default: return NULL;
    }
  default:
    return NULL;
  }
}

/* Object.prototype's own constructor and shared methods, read on the
 * prototype itself (`const { hasOwnProperty } = Object.prototype`, the
 * `proto.constructor` of an isPlainObject check): the member, or NULL when
 * `d` is another value and the ordinary read applies. */
ScrDyn *scr_dyn_object_prototype_member(const ScrDyn *d, const ScrStr *key) {
  ScrDyn *object_prototype = scr_dyn_object_prototype();
  bool prototype = d == object_prototype;
  scr_dyn_release(object_prototype);
  return prototype ? dyn_inherited_from(dyn_s26, DYN_INHERIT_ALL, key) : NULL;
}

/* A read of constructor/valueOf/toString/hasOwnProperty/
 * propertyIsEnumerable, by a constant key or a computed one: `read` is the
 * ordinary read's +1 result (NULL when it threw). Takes it; answers the inherited member in place of an
 * undefined read, the read otherwise. */
ScrDyn *scr_dyn_inherited_read(const ScrDyn *d, const ScrStr *key, ScrDyn *read) {
  if (!read || read->kind != SCR_DYN_UNDEF) return read;
  ScrDyn *member = dyn_inherited_member(d, key);
  if (scr_exc_pending()) {
    scr_dyn_release(member);
    scr_dyn_release(read);
    return NULL;
  }
  if (!member) return read;
  scr_dyn_release(read);
  return member;
}
