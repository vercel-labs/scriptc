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
/* The interned member values, by kind and by position in the kind's member
 * table (the String table is the largest). One value per kind and member:
 * the prototype object's member, a primitive's member read and a wrapper
 * instance's member read are the same function object. */
#define SCR_JS_WRAPPER_MEMBER_SLOTS 64
static SCR_TL ScrDyn *scr_js_wrapper_member_values[3][SCR_JS_WRAPPER_MEMBER_SLOTS];
/* The prototypes on which this thread has installed the program's own `X`
 * closure as `constructor` (t262-da A2). The frontend emits the install at
 * every `X.prototype` read, so the mark, not the member's current value,
 * decides whether a read writes: a program that replaces the property
 * through an alias of the prototype (`const p = String.prototype;
 * p.constructor = 7;`) keeps its value across a later read, as it does in
 * Node. The slots are the prototypes the frontend installs on — one each
 * for String, Number, Boolean and BigInt — and the mark holds a reference
 * because the object is what a repeat read compares. */
#define SCR_JS_WRAPPER_INSTALL_SLOTS 4
static SCR_TL ScrDyn *scr_js_wrapper_installed[SCR_JS_WRAPPER_INSTALL_SLOTS];

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
  for (int kind = 0; kind < 3; kind++)
    for (int slot = 0; slot < SCR_JS_WRAPPER_MEMBER_SLOTS; slot++) {
      ScrDyn *member = scr_js_wrapper_member_values[kind][slot];
      scr_js_wrapper_member_values[kind][slot] = NULL;
      scr_dyn_release(member);
    }
  for (size_t i = 0; i < SCR_JS_WRAPPER_INSTALL_SLOTS; i++) {
    ScrDyn *installed = scr_js_wrapper_installed[i];
    scr_js_wrapper_installed[i] = NULL;
    scr_dyn_release(installed);
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
 * (at, slice, indexOf, lastIndexOf, includes, and replace in the
 * object-model build) run there; any other String
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
             strcmp(method, "includes") == 0 || strcmp(method, "replace") == 0) {
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
 * data property, the attributes of a builtin prototype member, and answers
 * whether the definition landed. A program can reach a wrapper prototype
 * through an alias, delete a member and prevent extensions before the first
 * ordinary read, so the insertion may be refused; a refused insertion has
 * no property to take attributes (scr_dyn_obj_index_of answers SIZE_MAX),
 * and the prototype stays as the program left it. */
static bool scr_js_wrapper_define_hidden(ScrDyn *object, const char *key, ScrDyn *value) {
  size_t len = strlen(key);
  bool present = scr_dyn_obj_index_of(object, key, len) != SIZE_MAX;
  if (!present && !scr_dyn_is_extensible(object)) {
    scr_dyn_release(value);
    return false;
  }
  scr_dyn_obj_set(object, key, len, value);
  size_t index = scr_dyn_obj_index_of(object, key, len);
  if (index == SIZE_MAX) return false;
  scr_dyn_obj_set_attrs_at(object, index, true, false, true);
  return true;
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
/* The member cache is indexed by position in a kind's table, and the String
 * table is the largest. */
_Static_assert(sizeof scr_js_wrapper_string_members / sizeof *scr_js_wrapper_string_members <=
                   SCR_JS_WRAPPER_MEMBER_SLOTS,
               "a wrapper member table must fit the member cache");

static const ScrJsWrapperMember *scr_js_wrapper_member_table(int kind) {
  return kind == SCR_JS_WRAPPER_STRING ? scr_js_wrapper_string_members
         : kind == SCR_JS_WRAPPER_NUMBER ? scr_js_wrapper_number_members
                                         : scr_js_wrapper_boolean_members;
}

/* The member a name answers: the Annex B trim aliases are the methods they
 * alias, so `trimLeft` is `trimStart` and `trimRight` is `trimEnd` (Node's
 * `String.prototype.trimLeft === String.prototype.trimStart`). Both spellings
 * reach one interned value, which carries the canonical name, so the
 * frontend's wrapper.isStringMethod recognizes either spelling's read. */
static const char *scr_js_wrapper_canonical_member(const char *name, size_t name_length,
                                                   size_t *canonical_length) {
  if (name_length == 8 && memcmp(name, "trimLeft", 8) == 0) {
    *canonical_length = 9;
    return "trimStart";
  }
  if (name_length == 9 && memcmp(name, "trimRight", 9) == 0) {
    *canonical_length = 7;
    return "trimEnd";
  }
  *canonical_length = name_length;
  return name;
}

/* The interned member value of `kind` for `name` (+1), or NULL when the
 * kind's prototype has no member of that name. The prototype object's
 * members, and every member read a primitive or a wrapper instance answers
 * through the graph, are these values: one member is one function object,
 * whichever way the program reached it, and it is the function the
 * frontend's wrapper.isStringMethod recognizes. */
static ScrDyn *scr_js_wrapper_member_lookup(int kind, const char *name, size_t name_length) {
  const ScrJsWrapperMember *members = scr_js_wrapper_member_table(kind);
  size_t index = 0;
  name = scr_js_wrapper_canonical_member(name, name_length, &name_length);
#ifdef SCR_JS_OBJECT_MODEL
  /* The members the builtin-method unit implements (String's trim family)
   * are that unit's interned values, so `String.prototype.trim` and
   * `''.trim` are one function object and a call through either runs the
   * method the language defines. This unit's own closure answers the member
   * only when the program links no builtin-method unit. */
  if (kind == SCR_JS_WRAPPER_STRING && scr_dyn_builtin_method_slot) {
    ScrDyn *value = scr_dyn_builtin_method_slot("String", name, name_length);
    if (value) return value;
  }
#endif
  for (const ScrJsWrapperMember *m = members; m->name; m++, index++) {
    if (strlen(m->name) != name_length || memcmp(m->name, name, name_length) != 0) continue;
    scr_js_wrapper_register_cleanup();
    if (!scr_js_wrapper_member_values[kind][index])
      scr_js_wrapper_member_values[kind][index] = scr_js_wrapper_method_value(m->name, kind, m->length);
    return scr_dyn_retain(scr_js_wrapper_member_values[kind][index]);
  }
  return NULL;
}

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

/* Seeds `constructor`'s own `prototype` with `prototype`, once. A program can
 * read `X.prototype` any number of times, and the wrapper unit seeds the same
 * closure when it builds this same object, so a repeated seeding has to be a
 * no-op: the row is read-only, and assigning it again would throw the
 * "Cannot assign to read only property" TypeError. */
static void scr_js_wrapper_seed_prototype(ScrDyn *constructor, ScrDyn *prototype) {
  ScrDyn *table = scr_dyn_function_properties_existing(constructor);
  bool seeded = table && scr_dyn_obj_get(table, "prototype", 9);
  scr_dyn_release(table);
  if (!seeded) scr_dyn_fn_seed_prototype(constructor, scr_dyn_retain(prototype));
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
  // The compiled constructor's `prototype` is this same object, as Node's
  // is, so `Object("x").constructor.prototype` is the prototype the boxed
  // value inherits from rather than undefined.
  scr_js_wrapper_seed_prototype(constructor, prototype);
  const ScrJsWrapperMember *members = scr_js_wrapper_member_table(kind);
  for (const ScrJsWrapperMember *m = members; m->name; m++) {
    /* The lookup's reference is the entry's: scr_dyn_obj_set takes
     * ownership of the value it is given, and the interned member keeps the
     * cache's own reference for the next read. */
    ScrDyn *member = scr_js_wrapper_member_lookup(kind, m->name, strlen(m->name));
    if (member) scr_js_wrapper_define_hidden(prototype, m->name, member);
  }
  scr_js_wrapper_prototypes[kind] = prototype;
  return prototype;
}

/* `Number.prototype` / `Boolean.prototype` read as a JavaScript value
 * (dyn.builtinPrototype): the wrapper unit's prototype object, so the
 * program that reads the value and the program's wrappers share ONE object
 * per kind. `kind` spells the constructor the frontend marked ("String",
 * "Number" or "Boolean"); `constructor` is that compiled constructor value
 * (borrowed), which receives the prototype. +1. */
ScrDyn *scr_dyn_builtin_prototype(const ScrStr *kind, ScrDyn *constructor) {
  for (int k = 0; k < 3; k++) {
    size_t len = strlen(scr_js_wrapper_names[k]);
    if (kind->len == len && memcmp(kind->data, scr_js_wrapper_names[k], len) == 0)
      return scr_dyn_retain(scr_js_wrapper_prototype(k, constructor));
  }
  scr_trap("scriptc: unknown builtin prototype kind\n");
  return NULL;
}

/* Boolean.prototype as a value in a JavaScript source (+1): the wrapper
 * unit's own prototype object, the one `new Boolean(v)` instances inherit
 * from, so a method read from it is the interned member above and accepts
 * a primitive boolean or a Boolean wrapper receiver. */
ScrDyn *scr_js_wrapper_boolean_prototype(ScrDyn *constructor) {
  return scr_dyn_retain(scr_js_wrapper_prototype(SCR_JS_WRAPPER_BOOLEAN, constructor));
}

/* Whether this thread has already installed a `constructor` on `prototype`. */
static bool scr_js_wrapper_install_seen(const ScrDyn *prototype) {
  for (size_t i = 0; i < SCR_JS_WRAPPER_INSTALL_SLOTS; i++)
    if (scr_js_wrapper_installed[i] == prototype) return true;
  return false;
}

/* Records the install on `prototype`. A repeat call with the same object is
 * the common case (every `X.prototype` read after the first), so it returns
 * before taking a reference; the list only grows once per prototype. */
static void scr_js_wrapper_install_mark(ScrDyn *prototype) {
  if (scr_js_wrapper_install_seen(prototype)) return;
  for (size_t i = 0; i < SCR_JS_WRAPPER_INSTALL_SLOTS; i++)
    if (!scr_js_wrapper_installed[i]) {
      scr_js_wrapper_installed[i] = scr_dyn_retain(prototype);
      return;
    }
  /* The frontend installs on four prototypes (INSTALLED_CONSTRUCTOR_OWNERS
   * in intrinsics.ts); a fifth needs a slot here rather than a silent
   * second install on the same object. */
  scr_trap("scriptc: wrapper prototype install list is full\n");
}

/* Installs `constructor` — the program's own String, Number, Boolean or
 * BigInt conversion closure, the value a read of that global answers — as the
 * `constructor` of the intrinsic prototype `prototype`, with the attributes
 * the table's row has (writable, non-enumerable, configurable), and seeds
 * the closure's `prototype` with the object. A program that reads
 * `X.prototype` therefore finds its own `X` at `X.prototype.constructor` and
 * in that property's descriptor, and a boxed value's `.constructor.prototype`
 * is the prototype it inherits from (t262-da A2). Returns `prototype`. +1. */
ScrDyn *scr_js_wrapper_install_constructor(ScrDyn *prototype, ScrDyn *constructor) {
  if (!prototype || !constructor || constructor->kind != SCR_DYN_FUNC)
    return scr_dyn_retain(prototype);
  /* Every `X.prototype` read emits this install, so the first one replaces
   * the table's `constructor` with the program's own `X` and marks the
   * object, and the seeding below is a no-op once the closure's `prototype`
   * exists. A later read leaves the member alone rather than re-installing:
   * the syntactic writes to these prototypes are refused by name
   * (fenceIntrinsicPrototypeWrite), but a program can reach the same object
   * through an alias and write it — `const p = String.prototype;
   * p.constructor = 7;` — and reading the prototype again must not undo
   * that, which it would if the decision compared the member against
   * `constructor` instead of asking whether the install already ran. */
  if (!scr_js_wrapper_install_seen(prototype)) {
    scr_js_wrapper_register_cleanup();
    if (scr_js_wrapper_define_hidden(prototype, "constructor", scr_dyn_retain(constructor)))
      scr_js_wrapper_install_mark(prototype);
  }
  scr_js_wrapper_seed_prototype(constructor, prototype);
  return scr_dyn_retain(prototype);
}

/* The prototype object the intrinsic table answers for `id` (+1), without
 * members: the table's fill defines them. Built on first use and shared with
 * `new String/Number/Boolean(v)`, so one intrinsic has one object, and the
 * object is a wrapper of "", 0 or false, which its members read as the
 * receiver's [[PrimitiveValue]] (t262-da A2). */
ScrDyn *scr_js_wrapper_intrinsic_prototype(const char *id) {
  int kind = SCR_JS_WRAPPER_BOOLEAN;
  if (strcmp(id, "String.prototype") == 0) kind = SCR_JS_WRAPPER_STRING;
  if (strcmp(id, "Number.prototype") == 0) kind = SCR_JS_WRAPPER_NUMBER;
  if (scr_js_wrapper_prototypes[kind]) return scr_dyn_retain(scr_js_wrapper_prototypes[kind]);
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
  scr_js_wrapper_prototypes[kind] = prototype;
  return scr_dyn_retain(prototype);
}

/* The interned member value of `kind` for `name` (+1), the answer the graph's
 * member provider gives for a wrapper prototype's member, or NULL when the
 * kind's prototype has no member of that name (String's `[Symbol.iterator]`).
 * The graph reaches it through a slot (scr_js_wrapper_member_slot), so a
 * program links this unit only when it names a wrapper. */
ScrDyn *scr_js_wrapper_member_for(double kind_number, const char *name, size_t name_length) {
  int kind = (int)kind_number;
  if (kind != SCR_JS_WRAPPER_STRING && kind != SCR_JS_WRAPPER_NUMBER && kind != SCR_JS_WRAPPER_BOOLEAN)
    return NULL;
  return scr_js_wrapper_member_lookup(kind, name, name_length);
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
 * (scr_js_wrapper_this_string), which is what the builtin does. The member
 * carries its canonical name, so the alias spellings ask for theirs. */
bool scr_js_wrapper_is_string_method(ScrDyn *member, ScrStr *name) {
  if (member->kind != SCR_DYN_FUNC || member->v.fn.thunk != scr_js_wrapper_method) return false;
  ScrDyn *member_name = scr_box_get_ref(member->v.fn.clo->caps[0]);
  ScrDyn *kind = scr_box_get_ref(member->v.fn.clo->caps[1]);
  size_t name_length = name->len;
  const char *canonical = scr_js_wrapper_canonical_member(name->data, name->len, &name_length);
  bool builtin = (int)kind->v.num == SCR_JS_WRAPPER_STRING &&
                 member_name->v.str->len == name_length &&
                 memcmp(member_name->v.str->data, canonical, name_length) == 0;
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

#ifdef SCR_JS_OBJECT_MODEL
/* The intrinsic graph reaches these two functions through slots (scr_dyn.h),
 * never by name, so a program links this unit only when it names a wrapper
 * prototype or creates a wrapper (t262-da A2). The initializer is the whole
 * of the wiring: it is data, so linking this unit adds nothing that runs at
 * load — a constructor would be a link root and would pull this unit's call
 * graph, and with it the dynamic tier, into every program that links the
 * first unit (t262-da W4). The graph's own zero fallback answers programs
 * that do not link this unit. */
ScrJsWrapperPrototypeSlot scr_js_wrapper_intrinsic_prototype_slot =
    scr_js_wrapper_intrinsic_prototype;
ScrJsWrapperMemberSlot scr_js_wrapper_member_slot = scr_js_wrapper_member_for;
/* The builtin-method unit's slot, which this unit reads for the String
 * members that unit implements. A program that names a wrapper without
 * linking that unit gets this zero fallback and answers its own closures. */
SCR_JS_SLOT_FALLBACK(ScrDynBuiltinMethodSlot, scr_dyn_builtin_method_slot);
#endif
