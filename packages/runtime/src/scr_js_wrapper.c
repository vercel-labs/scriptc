/* Primitive wrapper objects: `new String(s)`, `new Number(n)`,
 * `new Boolean(b)` and ToObject of a primitive (`Object(p)`).
 *
 * A wrapper is an ordinary dictionary-mode object (SCR_DYN_OBJ). Its
 * prototype is this unit's String, Number or Boolean prototype object, and
 * its [[PrimitiveValue]] internal slot rides the object's source identity
 * (scr_dyn_new_obj_with_identity): a ScrJsWrapperSlot that only this unit's
 * accessor recognizes (scr_dyn_obj_source_cast), so no shared structure or
 * branch changes and a program that never creates a wrapper links nothing
 * of this unit. A String wrapper owns its index properties (non-writable,
 * enumerable, non-configurable) and `length` (non-writable, non-enumerable,
 * non-configurable), as Node's String exotic objects do.
 *
 * Every generic dynamic operation already handles that shape: ToPrimitive
 * finds valueOf and toString on the prototype, property reads and writes
 * honor the attributes, key listing orders the indices first, identity is
 * the object's, typeof answers "object" and ToBoolean true. The prototype
 * methods read the slot (thisStringValue, thisNumberValue,
 * thisBooleanValue) or, for the other String methods, apply ToString to the
 * receiver and call the method on the primitive. */
#include "scr_runtime.h"

#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

enum { SCR_JS_WRAPPER_STRING = 0, SCR_JS_WRAPPER_NUMBER = 1, SCR_JS_WRAPPER_BOOLEAN = 2 };

static const char *const scr_js_wrapper_names[3] = { "String", "Number", "Boolean" };

typedef struct ScrJsWrapperSlot {
  size_t rc;
  int kind;
  ScrDyn *primitive; /* owned */
  ScrDyn *object;    /* borrowed: the wrapper that owns this slot */
} ScrJsWrapperSlot;

static SCR_TL ScrDyn *scr_js_wrapper_prototypes[3];
static SCR_TL bool scr_js_wrapper_cleanup_registered;
/* The interned Boolean.prototype.valueOf (0) and toString (1) values read
 * as functions in a JavaScript source. */
static SCR_TL ScrDyn *scr_js_wrapper_boolean_methods[2];

static void *scr_js_wrapper_slot_retain(void *p) {
  ((ScrJsWrapperSlot *)p)->rc++;
  return p;
}

/* The source-identity accessor: `false` releases one reference (the
 * object's release protocol); `true` asks for the object view, which is the
 * wrapper itself (+1). Its address is the wrapper brand. */
static ScrDyn *scr_js_wrapper_slot_access(void *p, bool materialize) {
  ScrJsWrapperSlot *slot = p;
  if (materialize) return scr_dyn_retain(slot->object);
  if (--slot->rc == 0) {
    scr_dyn_release(slot->primitive);
    free(slot);
  }
  return NULL;
}

/* The wrapper slot of `d` (+1 reference), or NULL when `d` is not a
 * wrapper. */
static ScrJsWrapperSlot *scr_js_wrapper_slot_of(const ScrDyn *d) {
  return scr_dyn_obj_source_cast(d, scr_js_wrapper_slot_access, scr_js_wrapper_slot_retain);
}

static void scr_js_wrapper_slot_drop(ScrJsWrapperSlot *slot) {
  if (slot) scr_js_wrapper_slot_access(slot, false);
}

static void scr_js_wrapper_cleanup(void) {
  for (int i = 0; i < 3; i++) {
    ScrDyn *prototype = scr_js_wrapper_prototypes[i];
    scr_js_wrapper_prototypes[i] = NULL;
    scr_dyn_release(prototype);
  }
  for (int i = 0; i < 2; i++) {
    ScrDyn *method = scr_js_wrapper_boolean_methods[i];
    scr_js_wrapper_boolean_methods[i] = NULL;
    scr_dyn_release(method);
  }
}

static void scr_js_wrapper_register_cleanup(void) {
  if (scr_js_wrapper_cleanup_registered) return;
  scr_atexit(scr_js_wrapper_cleanup);
  scr_js_wrapper_cleanup_registered = true;
}

static void scr_js_wrapper_type_error(const char *method, int kind) {
  ScrJsonBuf text;
  scr_jb_init(&text);
  scr_jb_puts(&text, scr_js_wrapper_names[kind]);
  scr_jb_puts(&text, ".prototype.");
  scr_jb_puts(&text, method);
  scr_jb_puts(&text, " requires that 'this' be a");
  scr_jb_puts(&text, kind == SCR_JS_WRAPPER_STRING ? " String" : kind == SCR_JS_WRAPPER_NUMBER ? " Number" : " Boolean");
  ScrStr *message = scr_jb_finish(&text);
  scr_throw_error_msg(SCR_ERR_TYPE, message->data, message->len);
  scr_str_release(message);
}

/* thisStringValue / thisNumberValue / thisBooleanValue: the primitive of
 * `self` (+1) when it is that primitive or a wrapper of that kind, else
 * Node's TypeError naming `method` and NULL. */
static ScrDyn *scr_js_wrapper_this_value(const ScrDyn *self, int kind, const char *method) {
  ScrDynKind want = kind == SCR_JS_WRAPPER_STRING ? SCR_DYN_STR
                  : kind == SCR_JS_WRAPPER_NUMBER ? SCR_DYN_NUM : SCR_DYN_BOOL;
  if (self->kind == want) return scr_dyn_retain((ScrDyn *)self);
  ScrJsWrapperSlot *slot = scr_js_wrapper_slot_of(self);
  if (slot && slot->kind == kind) {
    ScrDyn *primitive = scr_dyn_retain(slot->primitive);
    scr_js_wrapper_slot_drop(slot);
    return primitive;
  }
  scr_js_wrapper_slot_drop(slot);
  scr_js_wrapper_type_error(method, kind);
  return NULL;
}

/* The ToIntegerOrInfinity-style numeric argument `i` (undefined when
 * absent); false with the conversion's exception pending. */
static bool scr_js_wrapper_number_arg(ScrDyn *const *args, size_t argc, size_t i, double *out,
                                      bool *present) {
  *present = i < argc && args[i]->kind != SCR_DYN_UNDEF;
  *out = 0;
  if (!*present) return true;
  return scr_dyn_number_coerce_js(args[i], out);
}

static ScrDyn *scr_js_wrapper_string_result(ScrStr *text) {
  if (!text) return NULL;
  ScrDyn *out = scr_dyn_new_str(text);
  scr_str_release(text);
  return out;
}

/* Method `method` of kind `kind` applied to its primitive receiver.
 * valueOf and String's toString answer the primitive; Number's methods
 * format through the runtime's number formatters; Boolean's toString
 * spells the value. The String methods the dynamic dispatch implements
 * (at, slice, indexOf, lastIndexOf, includes) run there; any other String
 * method called through its function value (`String.prototype.trim.call`,
 * a method value stored and called later) refuses, because the compiler
 * lowers those calls itself at their call sites. */
static ScrDyn *scr_js_wrapper_apply(int kind, const char *method, ScrDyn *primitive,
                                    ScrDyn *const *args, size_t argc) {
  if (strcmp(method, "valueOf") == 0) return scr_dyn_retain(primitive);
  if (kind == SCR_JS_WRAPPER_BOOLEAN) {
    const char *text = primitive->v.b ? "true" : "false";
    return scr_js_wrapper_string_result(scr_str_new(text, strlen(text)));
  }
  if (kind == SCR_JS_WRAPPER_NUMBER) {
    double x = primitive->v.num, digits;
    bool present;
    if (strcmp(method, "toString") == 0)
      return scr_js_wrapper_string_result(
          scr_num_to_string_radix(x, argc > 0 ? args[0] : scr_dyn_undefined()));
    if (!scr_js_wrapper_number_arg(args, argc, 0, &digits, &present)) return NULL;
    if (strcmp(method, "toFixed") == 0) {
      ScrStr *text = scr_num_to_fixed(x, digits);
      if (scr_exc_pending()) { scr_str_release(text); return NULL; }
      return scr_js_wrapper_string_result(text);
    }
    if (strcmp(method, "toPrecision") == 0) {
      ScrStr *text = scr_num_to_precision(x, digits, present);
      if (scr_exc_pending()) { scr_str_release(text); return NULL; }
      return scr_js_wrapper_string_result(text);
    }
    if (strcmp(method, "toExponential") == 0) {
      ScrStr *text = present ? scr_num_to_exponential_digits(x, digits) : scr_num_to_exponential(x);
      if (scr_exc_pending()) { scr_str_release(text); return NULL; }
      return scr_js_wrapper_string_result(text);
    }
  } else if (strcmp(method, "toString") == 0) {
    return scr_dyn_retain(primitive);
  } else if (strcmp(method, "at") == 0 || strcmp(method, "slice") == 0 ||
             strcmp(method, "indexOf") == 0 || strcmp(method, "lastIndexOf") == 0 ||
             strcmp(method, "includes") == 0) {
    return scr_dyn_invoke(primitive, method, args, argc, method);
  }
  ScrJsonBuf text;
  scr_jb_init(&text);
  scr_jb_puts(&text, scr_js_wrapper_names[kind]);
  scr_jb_puts(&text, ".prototype.");
  scr_jb_puts(&text, method);
  scr_jb_puts(&text, " called through its function value is not supported yet");
  ScrStr *message = scr_jb_finish(&text);
  scr_throw_error_msg_code(SCR_ERR_ERROR, message->data, message->len, "SC2020");
  scr_str_release(message);
  return NULL;
}

/* A prototype method: caps[0] holds the method name (a dyn string) and
 * caps[1] the kind (a dyn number). valueOf, and toString of Number and
 * Boolean and String, read the slot; Number's other methods run on
 * thisNumberValue; String's other methods run on ToString of a receiver
 * that is neither null nor undefined. Each then calls the method on the
 * primitive through the ordinary dynamic dispatch. */
static ScrDyn *scr_js_wrapper_method(ScrClosure *clo, ScrDyn *const *args, size_t argc) {
  ScrDyn *name = scr_box_get_ref(clo->caps[0]); /* +1 */
  ScrDyn *kind_box = scr_box_get_ref(clo->caps[1]);
  int kind = (int)kind_box->v.num;
  scr_dyn_release(kind_box);
  const char *method = name->v.str->data;
  ScrDyn *self = scr_dyn_this_get(); /* +1 */
  ScrDyn *primitive = NULL;
  bool slot_method = kind != SCR_JS_WRAPPER_STRING || strcmp(method, "valueOf") == 0 ||
                     strcmp(method, "toString") == 0;
  if (slot_method) {
    primitive = scr_js_wrapper_this_value(self, kind, method);
  } else if (self->kind == SCR_DYN_UNDEF || self->kind == SCR_DYN_NULL) {
    ScrJsonBuf text;
    scr_jb_init(&text);
    scr_jb_puts(&text, "String.prototype.");
    scr_jb_puts(&text, method);
    scr_jb_puts(&text, " called on null or undefined");
    ScrStr *message = scr_jb_finish(&text);
    scr_throw_error_msg(SCR_ERR_TYPE, message->data, message->len);
    scr_str_release(message);
  } else {
    ScrStr *text = scr_dyn_string_coerce_js(self);
    if (text) {
      primitive = scr_dyn_new_str(text);
      scr_str_release(text);
    }
  }
  scr_dyn_release(self);
  ScrDyn *result = primitive ? scr_js_wrapper_apply(kind, method, primitive, args, argc) : NULL;
  scr_dyn_release(primitive);
  scr_dyn_release(name);
  return result;
}

/* Boolean.prototype.valueOf/toString as the prototype's own method values
 * (`Boolean.prototype.valueOf.call(true)`, an instance's read, a value
 * stored on an object and called on a foreign receiver): thisBooleanValue
 * of the call's receiver, then the method on that primitive. A receiver
 * that is not a boolean — including a String or Number wrapper — throws
 * Node's brand-check TypeError naming `name`. */
static ScrDyn *scr_js_wrapper_boolean_method_call(ScrClosure *clo, ScrDyn *const *args, size_t argc) {
  ScrDyn *name = scr_box_get_ref(clo->caps[0]);
  ScrDyn *self = scr_dyn_this_get();
  ScrDyn *primitive = scr_js_wrapper_this_value(self, SCR_JS_WRAPPER_BOOLEAN, name->v.str->data);
  scr_dyn_release(self);
  ScrDyn *result =
      primitive ? scr_js_wrapper_apply(SCR_JS_WRAPPER_BOOLEAN, name->v.str->data, primitive, args, argc)
                : NULL;
  scr_dyn_release(primitive);
  scr_dyn_release(name);
  return result;
}

/* A new function value for Boolean's `name`. Its name string rides caps[0],
 * so the ScrDyn.fn name pointer stays valid as long as the function. */
static ScrDyn *scr_js_wrapper_boolean_method_create(const char *name) {
  ScrClosure *closure = scr_closure_new(NULL, 1);
  closure->caps[0] = scr_box_new_obj(scr_dyn_retain_v, scr_dyn_release_v, scr_dyn_trace_v);
  ScrStr *text = scr_str_new(name, strlen(name));
  ScrDyn *held = scr_dyn_new_str(text);
  scr_str_release(text);
  scr_box_set_ref(closure->caps[0], held);
  return scr_dyn_new_func(closure, scr_js_wrapper_boolean_method_call, 0, "native:wrapper",
                          held->v.str->data);
}

/* The interned function value for Boolean's `name` (+1). valueOf and
 * toString are the two members; any other name (the frontend emits none)
 * gets its own function, which refuses through scr_js_wrapper_apply. */
static ScrDyn *scr_js_wrapper_boolean_method_value(const char *name) {
  int index = strcmp(name, "valueOf") == 0 ? 0 : strcmp(name, "toString") == 0 ? 1 : -1;
  if (index < 0) return scr_js_wrapper_boolean_method_create(name);
  scr_js_wrapper_register_cleanup();
  if (!scr_js_wrapper_boolean_methods[index])
    scr_js_wrapper_boolean_methods[index] =
        scr_js_wrapper_boolean_method_create(index == 0 ? "valueOf" : "toString");
  return scr_dyn_retain(scr_js_wrapper_boolean_methods[index]);
}

/* Defines `key` on `object` as a non-enumerable, writable, configurable
 * data property, the attributes of a builtin prototype member. */
static void scr_js_wrapper_define_hidden(ScrDyn *object, const char *key, ScrDyn *value) {
  size_t len = strlen(key);
  scr_dyn_obj_set(object, key, len, value);
  scr_dyn_obj_set_attrs_at(object, scr_dyn_obj_index_of(object, key, len), true, false, true);
}

static ScrDyn *scr_js_wrapper_method_value(const char *name, int kind, uint32_t length) {
  /* Boolean's two members are the interned values a method-value read
   * answers, so `Boolean.prototype.valueOf` and a wrapper's own read are
   * the same function object. */
  if (kind == SCR_JS_WRAPPER_BOOLEAN) return scr_js_wrapper_boolean_method_value(name);
  ScrClosure *closure = scr_closure_new(NULL, 2);
  closure->caps[0] = scr_box_new_obj(scr_dyn_retain_v, scr_dyn_release_v, scr_dyn_trace_v);
  ScrStr *text = scr_str_new(name, strlen(name));
  scr_box_set_ref(closure->caps[0], scr_dyn_new_str(text));
  scr_str_release(text);
  closure->caps[1] = scr_box_new_obj(scr_dyn_retain_v, scr_dyn_release_v, scr_dyn_trace_v);
  scr_box_set_ref(closure->caps[1], scr_dyn_new_num((double)kind));
  return scr_dyn_new_func(closure, scr_js_wrapper_method, length, "native:wrapper", name);
}

/* The prototype members, with Node's `length` values. */
typedef struct { const char *name; uint32_t length; } ScrJsWrapperMember;

static const ScrJsWrapperMember scr_js_wrapper_string_members[] = {
  {"anchor", 1}, {"at", 1}, {"big", 0}, {"blink", 0}, {"bold", 0}, {"charAt", 1},
  {"charCodeAt", 1}, {"codePointAt", 1}, {"concat", 1}, {"endsWith", 1}, {"fixed", 0},
  {"fontcolor", 1}, {"fontsize", 1}, {"includes", 1}, {"indexOf", 1}, {"isWellFormed", 0},
  {"italics", 0}, {"lastIndexOf", 1}, {"link", 1}, {"localeCompare", 1}, {"match", 1},
  {"matchAll", 1}, {"normalize", 0}, {"padEnd", 1}, {"padStart", 1}, {"repeat", 1},
  {"replace", 2}, {"replaceAll", 2}, {"search", 1}, {"slice", 2}, {"small", 0},
  {"split", 2}, {"startsWith", 1}, {"strike", 0}, {"sub", 0}, {"substr", 2},
  {"substring", 2}, {"sup", 0}, {"toLocaleLowerCase", 0}, {"toLocaleUpperCase", 0},
  {"toLowerCase", 0}, {"toString", 0}, {"toUpperCase", 0}, {"toWellFormed", 0},
  {"trim", 0}, {"trimEnd", 0}, {"trimLeft", 0}, {"trimRight", 0}, {"trimStart", 0},
  {"valueOf", 0}, {NULL, 0},
};
static const ScrJsWrapperMember scr_js_wrapper_number_members[] = {
  {"toExponential", 1}, {"toFixed", 1}, {"toPrecision", 1}, {"toString", 1},
  {"valueOf", 0}, {"toLocaleString", 0}, {NULL, 0},
};
static const ScrJsWrapperMember scr_js_wrapper_boolean_members[] = {
  {"toString", 0}, {"valueOf", 0}, {NULL, 0},
};

/* An object with the [[PrimitiveValue]] slot of kind `kind` over
 * `primitive` (borrowed; already the converted primitive) and, for a
 * String, its index properties and `length`. Its prototype is still
 * Object.prototype. +1. */
static ScrDyn *scr_js_wrapper_object(int kind, ScrDyn *primitive) {
  ScrJsWrapperSlot *slot = malloc(sizeof *slot);
  if (!slot) scr_trap("scriptc: out of memory\n");
  *slot = (ScrJsWrapperSlot){ 0, kind, scr_dyn_retain(primitive), NULL };
  /* scr_dyn_new_obj_with_identity retains once: the object's reference. */
  ScrDyn *object = scr_dyn_new_obj_with_identity(slot, scr_js_wrapper_slot_retain, scr_js_wrapper_slot_access);
  slot->object = object;
  if (kind == SCR_JS_WRAPPER_STRING) {
    /* Each UTF-16 code unit is an own index property. */
    ScrStr *text = primitive->v.str;
    double units = scr_str_utf16_len(text);
    for (double i = 0; i < units; i++) {
      ScrStr *code_unit = scr_str_char_at(text, i); /* +1 */
      ScrDyn *unit = scr_dyn_new_str(code_unit);
      scr_str_release(code_unit);
      char key[32];
      int key_len = snprintf(key, sizeof key, "%.0f", i);
      scr_dyn_obj_set(object, key, (size_t)key_len, unit);
      scr_dyn_obj_set_attrs_at(object, scr_dyn_obj_index_of(object, key, (size_t)key_len), false, true, false);
    }
    scr_dyn_obj_set(object, "length", 6, scr_dyn_new_num(units));
    scr_dyn_obj_set_attrs_at(object, scr_dyn_obj_index_of(object, "length", 6), false, false, false);
  }
  return object;
}

/* The kind's prototype object (borrowed), built on first use with
 * `constructor` (the compiled constructor value) and the members above.
 * As in Node, it is itself a wrapper of "", 0 or false, so its valueOf
 * and toString answer that primitive; its own prototype is
 * Object.prototype. */
static ScrDyn *scr_js_wrapper_prototype(int kind, ScrDyn *constructor) {
  if (scr_js_wrapper_prototypes[kind]) return scr_js_wrapper_prototypes[kind];
  scr_js_wrapper_register_cleanup();
  ScrDyn *primitive;
  if (kind == SCR_JS_WRAPPER_STRING) {
    ScrStr *empty = scr_str_new("", 0);
    primitive = scr_dyn_new_str(empty);
    scr_str_release(empty);
  } else {
    primitive = kind == SCR_JS_WRAPPER_NUMBER ? scr_dyn_new_num(0) : scr_dyn_new_bool(false);
  }
  ScrDyn *prototype = scr_js_wrapper_object(kind, primitive);
  scr_dyn_release(primitive);
  scr_js_wrapper_define_hidden(prototype, "constructor", scr_dyn_retain(constructor));
  const ScrJsWrapperMember *members = kind == SCR_JS_WRAPPER_STRING ? scr_js_wrapper_string_members
                                    : kind == SCR_JS_WRAPPER_NUMBER ? scr_js_wrapper_number_members
                                    : scr_js_wrapper_boolean_members;
  for (const ScrJsWrapperMember *m = members; m->name; m++)
    scr_js_wrapper_define_hidden(prototype, m->name, scr_js_wrapper_method_value(m->name, kind, m->length));
  scr_js_wrapper_prototypes[kind] = prototype;
  return prototype;
}

/* Boolean.prototype as a value in a JavaScript source (+1): the wrapper
 * unit's own prototype object, the one `new Boolean(v)` instances inherit
 * from, so a method read from it is the interned member above and accepts
 * a primitive boolean or a Boolean wrapper receiver. */
ScrDyn *scr_js_wrapper_boolean_prototype(ScrDyn *constructor) {
  return scr_dyn_retain(scr_js_wrapper_prototype(SCR_JS_WRAPPER_BOOLEAN, constructor));
}

/* The wrapper of kind `kind` over `primitive` (borrowed; already the
 * converted primitive). +1. */
static ScrDyn *scr_js_wrapper_make(int kind, ScrDyn *primitive, ScrDyn *const constructors[3]) {
  ScrDyn *object = scr_js_wrapper_object(kind, primitive);
  object->prototype = scr_dyn_retain(scr_js_wrapper_prototype(kind, constructors[kind]));
  return object;
}

/* `new String(v)` / `new Number(v)` / `new Boolean(v)`: kind 0, 1 or 2;
 * `value` is the argument (the undefined value is converted like any
 * other: callers pass "", 0 or false for an omitted argument). The
 * constructors are the compiled String, Number and Boolean values. +1, or
 * NULL with the conversion's exception pending. All arguments borrowed. */
ScrDyn *scr_js_wrapper_new(double kind_number, ScrDyn *value, ScrDyn *string_ctor, ScrDyn *number_ctor,
                           ScrDyn *boolean_ctor) {
  int kind = (int)kind_number;
  ScrDyn *const constructors[3] = { string_ctor, number_ctor, boolean_ctor };
  ScrDyn *primitive = NULL;
  if (kind == SCR_JS_WRAPPER_STRING) {
    if (value->kind == SCR_DYN_SYMBOL) {
      static const char message[] = "Cannot convert a Symbol value to a string";
      scr_throw_error_msg(SCR_ERR_TYPE, message, sizeof message - 1);
      return NULL;
    }
    ScrStr *text = scr_dyn_string_coerce_js(value);
    if (!text) return NULL;
    primitive = scr_dyn_new_str(text);
    scr_str_release(text);
  } else if (kind == SCR_JS_WRAPPER_NUMBER) {
    double number = scr_dyn_number_constructor(value);
    if (scr_exc_pending()) return NULL;
    primitive = scr_dyn_new_num(number);
  } else {
    primitive = scr_dyn_new_bool(scr_dyn_truthy(value));
  }
  ScrDyn *object = scr_js_wrapper_make(kind, primitive, constructors);
  scr_dyn_release(primitive);
  return object;
}

/* ToObject: a wrapper for a string, number or boolean; the value itself
 * for an object; a fresh ordinary object for null and undefined (the
 * Object constructor's answer, not ToObject's TypeError). BigInt and Symbol
 * wrappers are refused. +1. */
ScrDyn *scr_js_wrapper_to_object(ScrDyn *value, ScrDyn *string_ctor, ScrDyn *number_ctor,
                                 ScrDyn *boolean_ctor) {
  ScrDyn *const constructors[3] = { string_ctor, number_ctor, boolean_ctor };
  switch (value->kind) {
  case SCR_DYN_STR: return scr_js_wrapper_make(SCR_JS_WRAPPER_STRING, value, constructors);
  case SCR_DYN_NUM: return scr_js_wrapper_make(SCR_JS_WRAPPER_NUMBER, value, constructors);
  case SCR_DYN_BOOL: return scr_js_wrapper_make(SCR_JS_WRAPPER_BOOLEAN, value, constructors);
  case SCR_DYN_UNDEF:
  case SCR_DYN_NULL: return scr_dyn_new_obj();
  case SCR_DYN_BIGINT:
  case SCR_DYN_SYMBOL: {
    static const char message[] = "Object() of a bigint or symbol is not supported yet";
    scr_throw_error_msg_code(SCR_ERR_ERROR, message, sizeof message - 1, "SC2020");
    return NULL;
  }
  default: return scr_dyn_retain(value);
  }
}

/* `value instanceof String/Number/Boolean`: the kind's prototype on the
 * value's prototype chain. A primitive is never an instance; a prototype
 * that was never built is on no chain. */
bool scr_js_wrapper_instance_of(ScrDyn *value, double kind_number) {
  ScrDyn *prototype = scr_js_wrapper_prototypes[(int)kind_number];
  if (!prototype || value->kind != SCR_DYN_OBJ) return false;
  for (const ScrDyn *current = value->prototype; current; current = current->prototype)
    if (current == prototype) return true;
  return false;
}

/* Object.prototype.toString: "[object String]", "[object Number]" or
 * "[object Boolean]" for a wrapper without an own or inherited
 * Symbol.toStringTag; the ordinary answer otherwise. +1. */
ScrStr *scr_js_wrapper_object_tag(ScrDyn *value) {
  ScrJsWrapperSlot *slot = scr_js_wrapper_slot_of(value);
  if (!slot) return scr_dyn_object_tag_of(value);
  int kind = slot->kind;
  scr_js_wrapper_slot_drop(slot);
  ScrStr *ordinary = scr_dyn_object_tag_of(value);
  if (!ordinary) return NULL;
  /* An explicit @@toStringTag wins over the builtin tag. */
  if (ordinary->len != 15 || memcmp(ordinary->data, "[object Object]", 15) != 0) return ordinary;
  scr_str_release(ordinary);
  const char *tag = kind == SCR_JS_WRAPPER_STRING ? "[object String]"
                  : kind == SCR_JS_WRAPPER_NUMBER ? "[object Number]" : "[object Boolean]";
  return scr_str_new(tag, strlen(tag));
}

/* util.types.isStringObject/isNumberObject/isBooleanObject/isBoxedPrimitive. */
bool scr_js_wrapper_type_is(ScrDyn *value, ScrStr *probe) {
  ScrJsWrapperSlot *slot = scr_js_wrapper_slot_of(value);
  if (!slot) return false;
  int kind = slot->kind;
  scr_js_wrapper_slot_drop(slot);
#define PROBE(name) (probe->len == sizeof(name) - 1 && memcmp(probe->data, name, sizeof(name) - 1) == 0)
  if (PROBE("isBoxedPrimitive")) return true;
  if (PROBE("isStringObject")) return kind == SCR_JS_WRAPPER_STRING;
  if (PROBE("isNumberObject")) return kind == SCR_JS_WRAPPER_NUMBER;
  if (PROBE("isBooleanObject")) return kind == SCR_JS_WRAPPER_BOOLEAN;
#undef PROBE
  return false;
}

/* The objects and arrays of a guarded value's graph still to search (a
 * stack), and the ones already reached (an open-addressing set of
 * addresses), each in inline storage until it outgrows it. */
typedef struct {
  const ScrDyn **stack;
  size_t depth, stack_cap;
  const ScrDyn **seen;
  size_t seen_count, seen_cap; /* seen_cap is a power of two */
  const ScrDyn *stack_inline[32];
  const ScrDyn *seen_inline[64];
} ScrJsWrapperWalk;

static size_t scr_js_wrapper_seen_slot(const ScrDyn *const *seen, size_t cap, const ScrDyn *value) {
  size_t i = ((uintptr_t)value >> 4) * 0x9E3779B97F4A7C15ull & (cap - 1);
  while (seen[i] && seen[i] != value) i = (i + 1) & (cap - 1);
  return i;
}

/* Adds an object or array to the search unless it was already reached. */
static void scr_js_wrapper_walk_reach(ScrJsWrapperWalk *walk, const ScrDyn *value) {
  if (!value || (value->kind != SCR_DYN_OBJ && value->kind != SCR_DYN_ARR)) return;
  size_t i = scr_js_wrapper_seen_slot(walk->seen, walk->seen_cap, value);
  if (walk->seen[i]) return;
  walk->seen[i] = value;
  if (++walk->seen_count * 2 > walk->seen_cap) {
    size_t cap = walk->seen_cap * 2;
    const ScrDyn **grown = calloc(cap, sizeof *grown);
    if (!grown) scr_trap("scriptc: out of memory\n");
    for (size_t j = 0; j < walk->seen_cap; j++)
      if (walk->seen[j]) grown[scr_js_wrapper_seen_slot(grown, cap, walk->seen[j])] = walk->seen[j];
    if (walk->seen != walk->seen_inline) free(walk->seen);
    walk->seen = grown;
    walk->seen_cap = cap;
  }
  if (walk->depth == walk->stack_cap) {
    size_t cap = walk->stack_cap * 2;
    const ScrDyn **grown = malloc(cap * sizeof *grown);
    if (!grown) scr_trap("scriptc: out of memory\n");
    memcpy(grown, walk->stack, walk->depth * sizeof *grown);
    if (walk->stack != walk->stack_inline) free(walk->stack);
    walk->stack = grown;
    walk->stack_cap = cap;
  }
  walk->stack[walk->depth++] = value;
}

/* Whether `value`'s own data graph (array elements, own data properties of
 * ordinary objects and arrays; accessors are not called) holds a wrapper.
 * Each object and array is searched once, so shared and cyclic references
 * end the search. */
static bool scr_js_wrapper_found(const ScrDyn *value) {
  if (value->kind != SCR_DYN_OBJ && value->kind != SCR_DYN_ARR) return false;
  ScrJsWrapperWalk walk;
  walk.stack = walk.stack_inline;
  walk.depth = 0;
  walk.stack_cap = sizeof walk.stack_inline / sizeof *walk.stack_inline;
  walk.seen = walk.seen_inline;
  walk.seen_count = 0;
  walk.seen_cap = sizeof walk.seen_inline / sizeof *walk.seen_inline;
  memset(walk.seen_inline, 0, sizeof walk.seen_inline);
  scr_js_wrapper_walk_reach(&walk, value);
  bool found = false;
  while (!found && walk.depth > 0) {
    const ScrDyn *current = walk.stack[--walk.depth];
    if (current->kind == SCR_DYN_OBJ) {
      ScrJsWrapperSlot *slot = scr_js_wrapper_slot_of(current);
      if (slot) {
        scr_js_wrapper_slot_drop(slot);
        found = true;
        break;
      }
      for (size_t i = 0; i < scr_dyn_obj_count(current); i++) {
        ScrDynProp prop = scr_dyn_obj_prop_at(current, i);
        if (!prop.accessor) scr_js_wrapper_walk_reach(&walk, prop.value);
      }
    } else {
      for (size_t i = 0; i < current->v.arr.len; i++) scr_js_wrapper_walk_reach(&walk, current->v.arr.items[i]);
    }
  }
  if (walk.stack != walk.stack_inline) free(walk.stack);
  if (walk.seen != walk.seen_inline) free(walk.seen);
  return found;
}

static void scr_js_wrapper_refuse(const ScrStr *consumer) {
  ScrJsonBuf text;
  scr_jb_init(&text);
  scr_jb_put_str(&text, consumer);
  scr_jb_puts(&text, " of a primitive wrapper object (new String/Number/Boolean or Object(primitive)) is not supported yet");
  ScrStr *message = scr_jb_finish(&text);
  scr_throw_error_msg_code(SCR_ERR_ERROR, message->data, message->len, "SC2020");
  scr_str_release(message);
}

/* The value (+1), or the not-supported Error and NULL when its own data
 * graph holds a wrapper: the consumer named by `consumer` cannot read the
 * [[PrimitiveValue]] slot yet. */
ScrDyn *scr_js_wrapper_guard(ScrDyn *value, ScrStr *consumer) {
  if (scr_js_wrapper_found(value)) {
    scr_js_wrapper_refuse(consumer);
    return NULL;
  }
  return scr_dyn_retain(value);
}

/* scr_js_wrapper_guard over each element of a list of dynamic values. */
ScrArr *scr_js_wrapper_guard_list(ScrArr *values, ScrStr *consumer) {
  for (size_t i = 0; i < values->len; i++) {
    ScrDyn *value = scr_arr_get_ref(values, (double)i); /* +1 */
    bool found = scr_js_wrapper_found(value);
    scr_dyn_release(value);
    if (found) {
      scr_js_wrapper_refuse(consumer);
      return NULL;
    }
  }
  return scr_arr_retain(values);
}

/* Whether `member`, the value a call read as the callee's member `name`,
 * is this unit's String.prototype method of that name: the compiler then
 * runs its own lowering of the method on ToString of the receiver
 * (scr_js_wrapper_this_string), which is what the builtin does. */
bool scr_js_wrapper_is_string_method(ScrDyn *member, ScrStr *name) {
  if (member->kind != SCR_DYN_FUNC || member->v.fn.thunk != scr_js_wrapper_method) return false;
  ScrDyn *member_name = scr_box_get_ref(member->v.fn.clo->caps[0]);
  ScrDyn *kind = scr_box_get_ref(member->v.fn.clo->caps[1]);
  bool builtin = (int)kind->v.num == SCR_JS_WRAPPER_STRING && member_name->v.str->len == name->len &&
                 memcmp(member_name->v.str->data, name->data, name->len) == 0;
  scr_dyn_release(kind);
  scr_dyn_release(member_name);
  return builtin;
}

/* The receiver of a String.prototype method: ToString of a value that is
 * neither undefined nor null (the method then sees the primitive). +1, or
 * NULL with the TypeError or the conversion's exception pending. */
ScrDyn *scr_js_wrapper_this_string(ScrDyn *value, ScrStr *name) {
  if (value->kind == SCR_DYN_UNDEF || value->kind == SCR_DYN_NULL) {
    ScrJsonBuf text;
    scr_jb_init(&text);
    scr_jb_puts(&text, "String.prototype.");
    scr_jb_put_str(&text, name);
    scr_jb_puts(&text, " called on null or undefined");
    ScrStr *message = scr_jb_finish(&text);
    scr_throw_error_msg(SCR_ERR_TYPE, message->data, message->len);
    scr_str_release(message);
    return NULL;
  }
  ScrStr *text = scr_dyn_string_coerce_js(value);
  if (!text) return NULL;
  ScrDyn *out = scr_dyn_new_str(text);
  scr_str_release(text);
  return out;
}
