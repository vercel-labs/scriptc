/* The standard library's intrinsics as ordinary checked-dynamic values.
 *
 * A JavaScript source that reads `Date.prototype`, `Array.prototype.push`,
 * `Object.getPrototypeOf([])` or `[].constructor` reads an object the
 * language defines: a prototype or constructor that exists before the
 * program runs, whose members are data properties with the attributes the
 * specification gives them. The runtime used to answer those reads from
 * hand-written tables in three units, one kind of intrinsic at a time, and
 * refused the rest. This unit builds every one of them from a table of the
 * pinned Node release's own objects (scr_js_intrinsics_table.h, written by
 * scripts/gen-intrinsics.mjs), so the object graph — which objects exist,
 * which member each holds, and how they link to each other — is Node's, not
 * ours.
 *
 * Every member is the value the runtime already has for it: a prototype
 * method is the invoke unit's interned builtin-method function
 * (scr_dyn_builtin_method), so `Date.prototype.getTime` and the `getTime` a
 * Date value answers are one function; a constructor is the interned
 * constructor value a source reading `Date` answers (scr_dyn_global_constructor),
 * so `Date.prototype.constructor === Date`. Members the runtime has no
 * implementation for are fenced functions that throw when called; they are
 * still the right object shape, `typeof` answer and attribute set.
 *
 * Objects the runtime already keeps as singletons — Object.prototype,
 * Array.prototype, Error.prototype — are filled in place, never replaced:
 * every reference the program took before the fill sees the members
 * afterwards, and `Object.prototype` stays one object. Fill marks an object
 * before it defines its members, so a member that names another intrinsic
 * (Date.prototype.constructor → Date → Date.prototype) resolves to the
 * object under construction instead of a second one.
 *
 * All state is thread-local, like the invoke unit's interned functions it is
 * built from, and released by one atexit handler. The frontend marks
 * dyn.intrinsic only for a program whose JavaScript source reads one of these
 * objects, and the graph links only into that program's intrinsicObjects
 * build, so typed programs keep their exact executables. */
#include "scr_runtime.h"
#include "scr_dyn_methods.h"

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* The graph is the build for the program fact intrinsicObjects (the frontend
 * marks dyn.intrinsic), and it implies the JavaScript object model. A build
 * with that fact carries the graph; a program with the object model for
 * another reason (a BigInt typed array selects it for bytes and json) links
 * the stub below instead. scr_json.c's object-model build asks the graph what
 * it filled, and a runtime with no graph has nothing to report. The guard
 * keeps the graph's code — and the generated table — out of every other
 * program, so its executable stays byte for byte what it was. */
#ifdef SCR_JS_INTRINSICS

#include "scr_js_intrinsics_table.h"

/* ── the generated table ─────────────────────────────────────────────── */

typedef struct {
  const char *owner;
  const char *key;
  const char *kind;
  const char *attributes;
  const char *a;
  const char *b;
} ScrJsIntrinsicRow;

static const ScrJsIntrinsicRow scr_js_rows[] = {
#define SCR_JS_ROW(owner, key, kind, attributes, a, b) { owner, key, kind, attributes, a, b },
  SCR_JS_INTRINSIC_ROWS(SCR_JS_ROW)
#undef SCR_JS_ROW
};
#define SCR_JS_ROW_COUNT (sizeof scr_js_rows / sizeof scr_js_rows[0])

static const char *const scr_js_object_ids[] = {
#define SCR_JS_OBJECT(id) id,
  SCR_JS_INTRINSIC_OBJECTS(SCR_JS_OBJECT)
#undef SCR_JS_OBJECT
};
#define SCR_JS_OBJECT_COUNT (sizeof scr_js_object_ids / sizeof scr_js_object_ids[0])

typedef struct {
  const char *object;
  const char *prototype;
} ScrJsIntrinsicProto;

static const ScrJsIntrinsicProto scr_js_protos[] = {
#define SCR_JS_PROTO(object, prototype) { object, prototype },
  SCR_JS_INTRINSIC_PROTOS(SCR_JS_PROTO)
#undef SCR_JS_PROTO
};
#define SCR_JS_PROTO_COUNT (sizeof scr_js_protos / sizeof scr_js_protos[0])

/* The kind column as one character; the table spells it out. */
enum {
  SCR_JS_METHOD = 'M',
  SCR_JS_ACCESSOR = 'A',
  SCR_JS_INTRINSIC = 'I',
  SCR_JS_NUMBER = 'N',
  SCR_JS_STRING = 'S',
  SCR_JS_BOOL = 'B',
  SCR_JS_SYMBOL = 'Y',
  SCR_JS_UNSCOPABLES = 'U',
  SCR_JS_UNDEFINED = 'D',
  SCR_JS_NULL = 'Z',
};

static char scr_js_kind_of(const char *kind) {
  static const struct { const char *name; char kind; } kinds[] = {
    { "METHOD", SCR_JS_METHOD },         { "ACCESSOR", SCR_JS_ACCESSOR },
    { "INTRINSIC", SCR_JS_INTRINSIC },   { "NUMBER", SCR_JS_NUMBER },
    { "STRING", SCR_JS_STRING },         { "BOOL", SCR_JS_BOOL },
    { "SYMBOL", SCR_JS_SYMBOL },         { "UNSCOPABLES", SCR_JS_UNSCOPABLES },
    { "UNDEFINED", SCR_JS_UNDEFINED },   { "NULL", SCR_JS_NULL },
  };
  for (size_t i = 0; i < sizeof kinds / sizeof kinds[0]; i++)
    if (strcmp(kinds[i].name, kind) == 0) return kinds[i].kind;
  return 0;
}

/* ── per-thread state ────────────────────────────────────────────────── */

/* One reference per built object, indexed like scr_js_object_ids. `filled`
 * is set when the object is registered — before its members are defined, so
 * a member that names it again answers the object being filled. The fill
 * depth is the fences' switch: the fill must be allowed to write what a
 * program never may. */
static SCR_TL ScrDyn *scr_js_objects[SCR_JS_OBJECT_COUNT];
static SCR_TL bool scr_js_filled[SCR_JS_OBJECT_COUNT];
static SCR_TL size_t scr_js_fill_depth;
static SCR_TL size_t scr_js_built_count;
static SCR_TL bool scr_js_registered;

static void scr_js_intrinsics_cleanup(void) {
  for (size_t i = 0; i < SCR_JS_OBJECT_COUNT; i++) {
    scr_dyn_release(scr_js_objects[i]);
    scr_js_objects[i] = NULL;
    scr_js_filled[i] = false;
  }
  scr_js_fill_depth = 0;
  scr_js_built_count = 0;
  scr_js_registered = false;
}

static void scr_js_register_cleanup(void) {
  if (scr_js_registered) return;
  scr_js_registered = true;
  scr_atexit(scr_js_intrinsics_cleanup);
}

/* ── lookups ─────────────────────────────────────────────────────────── */

static size_t scr_js_object_index(const char *id) {
  for (size_t i = 0; i < SCR_JS_OBJECT_COUNT; i++)
    if (strcmp(scr_js_object_ids[i], id) == 0) return i;
  return SIZE_MAX;
}

/* The index of a registered object, or SIZE_MAX. */
static size_t scr_js_value_index(const ScrDyn *object) {
  for (size_t i = 0; i < SCR_JS_OBJECT_COUNT; i++)
    if (scr_js_objects[i] == object) return i;
  return SIZE_MAX;
}

/* The table's rows are grouped by owner, and every row of an owner's block
 * belongs to the object with that id, so a member lookup is one block and a
 * handful of compares rather than a scan of all 719 rows: the fence runs on
 * every dynamic write of an intrinsic. */
static SCR_TL size_t scr_js_row_start[SCR_JS_OBJECT_COUNT];
static SCR_TL size_t scr_js_row_end[SCR_JS_OBJECT_COUNT];
static SCR_TL bool scr_js_rows_indexed;

static void scr_js_index_rows(void) {
  if (scr_js_rows_indexed) return;
  scr_js_rows_indexed = true;
  for (size_t i = 0; i < SCR_JS_ROW_COUNT;) {
    const char *owner = scr_js_rows[i].owner;
    size_t end = i + 1;
    while (end < SCR_JS_ROW_COUNT && strcmp(scr_js_rows[end].owner, owner) == 0) end++;
    size_t index = scr_js_object_index(owner);
    if (index != SIZE_MAX) {
      scr_js_row_start[index] = i;
      scr_js_row_end[index] = end;
    }
    i = end;
  }
}

/* Whether the table's member spelling `name` is the property key `key`: the
 * name itself for a string key, `Symbol.<name>` for the table's "@@name". */
static bool scr_js_names_key(const char *name, const ScrDyn *key) {
  if (name[0] == '@' && name[1] == '@') {
    if (key->kind != SCR_DYN_SYMBOL || !key->v.symbol.description) return false;
    ScrStr *description = key->v.symbol.description(key->v.symbol.value);
    if (!description) return false;
    size_t length = strlen(name + 2);
    bool same = description->len == length + 7 && memcmp(description->data, "Symbol.", 7) == 0 &&
                memcmp(description->data + 7, name + 2, length) == 0;
    scr_str_release(description);
    return same;
  }
  if (key->kind != SCR_DYN_STR) return false;
  size_t length = strlen(name);
  return key->v.str->len == length && memcmp(key->v.str->data, name, length) == 0;
}

/* The [[Prototype]] of the object named `id` as the table names it, or NULL
 * for one the table could not name (the generated header spells an unknown
 * one "?"). */
static const char *scr_js_prototype_id(const char *id) {
  for (size_t i = 0; i < SCR_JS_PROTO_COUNT; i++)
    if (strcmp(scr_js_protos[i].object, id) == 0) return scr_js_protos[i].prototype;
  return NULL;
}

/* ── member values ───────────────────────────────────────────────────── */

static bool scr_js_attr(const char *attributes, char attribute) {
  return attributes && strchr(attributes, attribute) != NULL;
}

/* The name part of a table's "name/length" column. */
static size_t scr_js_member_name_length(const char *spec) {
  const char *slash = strchr(spec, '/');
  return slash ? (size_t)(slash - spec) : strlen(spec);
}

/* The length part of a table's "name/length" column. */
static size_t scr_js_member_length(const char *spec) {
  const char *slash = strchr(spec, '/');
  return slash ? (size_t)strtoul(slash + 1, NULL, 10) : 0;
}

/* `key` as the property key the table names: a string key, or for the
 * table's "@@name" spelling the well-known symbol `Symbol.name`. +1. */
static ScrDyn *scr_js_key(const char *key) {
  if (key[0] == '@' && key[1] == '@') {
    ScrStr *name = scr_str_new(key + 2, strlen(key + 2));
    ScrSym *symbol = scr_sym_well_known(name);
    scr_str_release(name);
    ScrDyn *value = scr_dyn_new_symbol(symbol);
    scr_sym_release(symbol);
    return value;
  }
  ScrStr *text = scr_str_new(key, strlen(key));
  ScrDyn *value = scr_dyn_new_str(text);
  scr_str_release(text);
  return value;
}

/* Whether `object` already has its own `key`. The prototype objects keep
 * the members the runtime's own builders installed (Array.prototype's
 * callable adapters, Error.prototype's constructor), so the fill only adds
 * what is missing. */
static bool scr_js_own(const ScrDyn *object, const ScrDyn *key) {
  if (key->kind == SCR_DYN_SYMBOL) return scr_dyn_own_symbol_entry(object, key) != NULL;
  return scr_dyn_has_own(object, key->v.str);
}

/* Defines `key` on `target` as a data property with the table's attributes.
 * Takes `value`. */
static void scr_js_define(ScrDyn *target, ScrDyn *key, ScrDyn *value, const char *attributes) {
  ScrDyn *descriptor = scr_dyn_new_obj();
  scr_dyn_obj_set(descriptor, "value", 5, scr_dyn_retain(value));
  scr_dyn_obj_set(descriptor, "writable", 8, scr_dyn_new_bool(scr_js_attr(attributes, 'W')));
  scr_dyn_obj_set(descriptor, "enumerable", 10, scr_dyn_new_bool(scr_js_attr(attributes, 'E')));
  scr_dyn_obj_set(descriptor, "configurable", 12, scr_dyn_new_bool(scr_js_attr(attributes, 'C')));
  ScrDyn *defined = scr_dyn_define_property(target, key, descriptor);
  scr_dyn_release(descriptor);
  if (!defined) scr_trap("scriptc: writing a builtin intrinsic member failed\n");
  scr_dyn_release(defined);
  /* The target's property table holds its own reference. */
  scr_dyn_release(value);
}

/* Defines `key` on `target` as an accessor property with the table's
 * attributes. Takes both accessors (either may be NULL). */
static void scr_js_define_accessor(ScrDyn *target, ScrDyn *key, ScrDyn *getter, ScrDyn *setter,
                                   const char *attributes) {
  ScrDyn *descriptor = scr_dyn_new_obj();
  if (getter) scr_dyn_obj_set(descriptor, "get", 3, getter);
  if (setter) scr_dyn_obj_set(descriptor, "set", 3, setter);
  scr_dyn_obj_set(descriptor, "enumerable", 10, scr_dyn_new_bool(scr_js_attr(attributes, 'E')));
  scr_dyn_obj_set(descriptor, "configurable", 12, scr_dyn_new_bool(scr_js_attr(attributes, 'C')));
  ScrDyn *defined = scr_dyn_define_property(target, key, descriptor);
  scr_dyn_release(descriptor);
  if (!defined) scr_trap("scriptc: writing a builtin intrinsic accessor failed\n");
  scr_dyn_release(defined);
}

/* Defines `key` on `function` as the attribute set every built-in's `length`
 * and `name` has (non-writable, non-enumerable, configurable), taking one
 * reference to `value`. The function's own property table owns the value,
 * so it outlives the fill — the table's own strings are not NUL-terminated
 * and would dangle in the `name` a function answers. */
static void scr_js_define_data(ScrDyn *function, const char *key, size_t key_len, ScrDyn *value) {
  ScrStr *text = scr_str_new(key, key_len);
  ScrDyn *key_value = scr_dyn_new_str(text);
  scr_str_release(text);
  ScrDyn *descriptor = scr_dyn_new_obj();
  scr_dyn_obj_set(descriptor, "value", 5, scr_dyn_retain(value));
  scr_dyn_obj_set(descriptor, "writable", 8, scr_dyn_new_bool(false));
  scr_dyn_obj_set(descriptor, "enumerable", 10, scr_dyn_new_bool(false));
  scr_dyn_obj_set(descriptor, "configurable", 12, scr_dyn_new_bool(true));
  ScrDyn *defined = scr_dyn_define_property(function, key_value, descriptor);
  scr_dyn_release(defined);
  scr_dyn_release(descriptor);
  scr_dyn_release(key_value);
  scr_dyn_release(value);
}

/* The ECMAScript `length` of an interned member function, written on the
 * function itself — the same shape the standard-library prototype unit gives
 * its methods, so both answer the interface's length rather than the
 * dispatch arity. */
static void scr_js_define_length(ScrDyn *function, size_t length) {
  scr_js_define_data(function, "length", sizeof "length" - 1, scr_dyn_new_num((double)length));
}

/* The `name` a builtin accessor answers: the name part of the table's
 * "name/length" column ("get size"), NUL-terminated here because the table
 * does not terminate it. */
static void scr_js_define_accessor_name(ScrDyn *function, const char *spec) {
  if (spec[0] == '\0') return;
  size_t name_length = scr_js_member_name_length(spec);
  char name[96];
  if (name_length >= sizeof name) name_length = sizeof name - 1;
  memcpy(name, spec, name_length);
  name[name_length] = '\0';
  ScrStr *text = scr_str_new(name, name_length);
  ScrDyn *value = scr_dyn_new_str(text);
  scr_str_release(text);
  scr_js_define_data(function, "name", sizeof "name" - 1, value);
}

static ScrDyn *scr_js_intrinsic_sized(size_t index, const char *id);

/* The `__proto__` accessor's getter: the receiver's [[Prototype]]. A
 * primitive receiver's wrapper prototype is the one its own builder answers
 * (`scr_dyn_builtin_prototype`, `scr_js_wrapper.c`) behind the ordinary
 * Object.getPrototypeOf path, never a second intrinsic here. +1. */
static ScrDyn *scr_js_proto_get(ScrDyn *self) { return scr_dyn_get_prototype(self); }

/* The value the receiver's own internal slot answers for `key` when the
 * accessor reads one — `new Map().size`, a RegExp's `flags`, a typed view's
 * `byteLength`, a symbol's `description` — or NULL when the receiver carries
 * no such slot, which is the incompatible receiver. */
static ScrDyn *scr_js_accessor_slot_read(ScrDyn *self, const ScrJsIntrinsicRow *row) {
  if (row->key[0] == '@' && row->key[1] == '@') return NULL;
  ScrStr *key = scr_str_new(row->key, strlen(row->key));
  ScrDyn *result = NULL;
  switch (self->kind) {
  case SCR_DYN_HANDLE: result = scr_dyn_handle_key_get(self, key); break;
  case SCR_DYN_BYTES: result = scr_dyn_bytes_key_get(self, key); break;
  case SCR_DYN_SYMBOL: result = scr_dyn_symbol_get(self, key); break;
  default: break;
  }
  scr_str_release(key);
  if (result && result->kind == SCR_DYN_UNDEF) {
    scr_dyn_release(result);
    return NULL;
  }
  return result;
}

/* An accessor the table declares. A receiver that carries the internal slot
 * the accessor reads answers it; `Object.prototype.__proto__` is the
 * language's prototype accessor; anything else is Node's TypeError for a
 * receiver that lacks the slot. */
static ScrDyn *scr_js_accessor_call(ScrClosure *closure, ScrDyn *const *args, size_t argc, bool getter) {
  const ScrJsIntrinsicRow *row = &scr_js_rows[(size_t)closure->fn];
  ScrDyn *self = scr_dyn_this_get();
  if (strcmp(row->owner, "Object.prototype") == 0 && strcmp(row->key, "__proto__") == 0) {
    ScrDyn *result;
    if (getter) {
      result = scr_js_proto_get(self);
    } else {
      /* The setter answers undefined, whatever the assignment writes. */
      ScrDyn *set = scr_dyn_set_prototype(self, argc ? args[0] : scr_dyn_undefined());
      scr_dyn_release(set);
      result = scr_dyn_retain(scr_dyn_undefined());
    }
    scr_dyn_release(self);
    return result;
  }
  if (getter) {
    ScrDyn *slot = scr_js_accessor_slot_read(self, row);
    if (slot || scr_exc_pending()) {
      scr_dyn_release(self);
      return slot;
    }
  }
  char message[256];
  int length = snprintf(message, sizeof message, "Method %s %s.%s called on incompatible receiver ",
                        getter ? "get" : "set", row->owner, row->key);
  if (length < 0) length = 0;
  if ((size_t)length < sizeof message) {
    ScrStr *shown = scr_dyn_string_coerce_js(self);
    if (shown) {
      size_t room = sizeof message - (size_t)length;
      size_t copy = shown->len < room - 1 ? shown->len : room - 1;
      memcpy(message + length, shown->data, copy);
      length += (int)copy;
      scr_str_release(shown);
    }
    message[length] = '\0';
  }
  scr_dyn_release(self);
  scr_throw_error_msg(SCR_ERR_TYPE, message, (size_t)length);
  return NULL;
}

static ScrDyn *scr_js_getter_call(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  return scr_js_accessor_call(closure, args, argc, true);
}

static ScrDyn *scr_js_setter_call(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  return scr_js_accessor_call(closure, args, argc, false);
}

/* A fenced builtin: calling it throws the refusal the runtime answers for
 * the interface it stands for. Used for the constructor objects the runtime
 * does not intern (String, Number, Symbol, the typed arrays, ...), which
 * exist so `typeof C === "function"`, `C.prototype` and `C.name` answer,
 * and so `new C()` refuses instead of silently diverging. */
static ScrDyn *scr_js_fenced_call(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  (void)args;
  (void)argc;
  const char *name = closure->fn;
  char message[160];
  int length = snprintf(message, sizeof message, "'new %s' is not supported yet", name);
  scr_throw_error_msg_code(SCR_ERR_ERROR, message, length < 0 ? 0 : (size_t)length, "SC1090");
  return NULL;
}

static ScrDyn *scr_js_fenced_new(const char *name) {
  ScrClosure *closure = scr_closure_new((void *)name, 0);
  return scr_dyn_new_func(closure, scr_js_fenced_call, 1, "native:constructor", name);
}

/* A callable ordinary function for Function.prototype: called, it answers
 * undefined, as Node's does. */
static ScrDyn *scr_js_function_prototype_call(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  (void)closure;
  (void)args;
  (void)argc;
  return scr_dyn_retain(scr_dyn_undefined());
}

/* ── the object graph ────────────────────────────────────────────────── */

static ScrDyn *scr_js_build(size_t index);
/* The object named by a table id (+1); traps on an id the table lacks. */
static ScrDyn *scr_js_intrinsic_sized(size_t index, const char *id);

/* The prototype name a member is interned under: `Array.prototype.push` is
 * the invoke unit's "Array.push", the spelling a property read of an array
 * interns too, so both are one function. */
static void scr_js_method_owner(const char *owner, char *out, size_t room) {
  size_t length = strlen(owner);
  const char *suffix = ".prototype";
  size_t suffix_length = strlen(suffix);
  if (length > suffix_length && strcmp(owner + length - suffix_length, suffix) == 0)
    length -= suffix_length;
  if (length >= room) length = room - 1;
  memcpy(out, owner, length);
  out[length] = '\0';
}

/* Whether `id` names a prototype object rather than a constructor. */
static bool scr_js_id_is_prototype(const char *id) {
  size_t length = strlen(id);
  if (strstr(id, ".prototype") != NULL) return true;
  return length > 10 && strcmp(id + length - 10, "Prototype%") == 0;
}

/* The prototype object a program's own builder answers: `Number.prototype`
 * from the primitive-prototype unit and `Boolean.prototype` from the
 * wrapper unit, whose object is the one `new Boolean(v)` instances inherit
 * from and whose members run Node's brand check on a primitive boolean or a
 * Boolean wrapper receiver. A program with the object model links both
 * builders (the graph calls into them), so the graph adopts their objects
 * instead of building a second one: a prototype read, a primitive's
 * `Object.getPrototypeOf`, an instance's chain and a write through the
 * prototype all name one object. NULL for every other id; the table builds
 * those itself. +1. */
static ScrDyn *scr_js_builder_prototype(const char *id) {
  if (strcmp(id, "Number.prototype") == 0) {
    ScrStr *kind = scr_str_new("Number", sizeof "Number" - 1);
    ScrDyn *prototype = scr_dyn_builtin_prototype(kind);
    scr_str_release(kind);
    return prototype;
  }
  if (strcmp(id, "Boolean.prototype") == 0) {
    ScrDyn *constructor = scr_js_intrinsic_sized(scr_js_object_index("Boolean"), "Boolean");
    ScrDyn *prototype = scr_js_wrapper_boolean_prototype(constructor);
    scr_dyn_release(constructor);
    return prototype;
  }
  return NULL;
}

/* The object `id` names: the runtime's singleton when it has one, else the
 * interned constructor value, else — for Function.prototype — a callable
 * object, else an ordinary object. +1. */
static ScrDyn *scr_js_create(const char *id) {
  if (strcmp(id, "Object.prototype") == 0) return scr_dyn_object_prototype();
  if (strcmp(id, "Array.prototype") == 0) return scr_dyn_array_prototype_base();
  if (strcmp(id, "Error.prototype") == 0) return scr_dyn_error_prototype();
  if (strcmp(id, "Function.prototype") == 0)
    return scr_dyn_new_func(scr_closure_new(NULL, 0), scr_js_function_prototype_call, 0, "native:prototype", "");
  /* String, BigInt, Symbol and Date prototypes are built by this unit: one
   * intrinsic, one builder, so a write the program makes through the
   * prototype object is the object a read answers (§4.4).
   * Number and Boolean have their own builders (scr_js_builder_prototype),
   * whose objects the wrapper and primitive-prototype units also answer: the
   * graph adopts those objects here. */
  ScrDyn *builder = scr_js_builder_prototype(id);
  if (builder) return builder;
  if (!scr_js_id_is_prototype(id)) {
    ScrStr *name = scr_str_new(id, strlen(id));
    ScrDyn *constructor = scr_dyn_global_constructor_known(name) ? scr_dyn_global_constructor(name) : NULL;
    scr_str_release(name);
    if (constructor) return constructor;
    return scr_js_fenced_new(id);
  }
  return scr_dyn_new_obj();
}

/* ── the wrapper prototypes as receivers ─────────────────────────────── */

/* Node's Number, String and Boolean prototypes are wrapper objects around a
 * primitive (+0, "" and false), so a member called on the prototype object
 * itself runs on that value: `Number.prototype.toFixed(1)` is "0.0",
 * `Number.prototype == 0` is true, `String.prototype.valueOf()` is "".
 * Number.prototype and Boolean.prototype carry their own builders' members
 * (scr_dyn_builtin_prototype.c and scr_js_wrapper.c), which read the
 * primitive the prototype object wraps themselves. String.prototype's
 * members are this table's rows, the invoke unit's functions, which read the
 * receiver's primitive and refuse an object, so each of them is wrapped to
 * hand the member the primitive the prototype object wraps; every other
 * receiver keeps the member's own check. */
static SCR_TL size_t scr_js_wrapper_ids[3];
static SCR_TL bool scr_js_wrapper_ids_indexed;

static void scr_js_index_wrappers(void) {
  if (scr_js_wrapper_ids_indexed) return;
  scr_js_wrapper_ids_indexed = true;
  scr_js_wrapper_ids[0] = scr_js_object_index("Number.prototype");
  scr_js_wrapper_ids[1] = scr_js_object_index("String.prototype");
  scr_js_wrapper_ids[2] = scr_js_object_index("Boolean.prototype");
}

/* Whether `owner` is one of the three wrapper constructors. */
static bool scr_js_wrapper_owner(const char *owner) {
  return strcmp(owner, "Number") == 0 || strcmp(owner, "String") == 0 ||
         strcmp(owner, "Boolean") == 0;
}

/* The primitive `receiver` wraps (+1) when it is one of the three prototype
 * objects, else NULL. */
static ScrDyn *scr_js_wrapper_zero(const ScrDyn *receiver) {
  if (receiver->kind != SCR_DYN_OBJ) return NULL;
  scr_js_index_wrappers();
  size_t index = SIZE_MAX;
  for (size_t i = 0; i < 3; i++)
    if (scr_js_wrapper_ids[i] != SIZE_MAX && scr_js_objects[scr_js_wrapper_ids[i]] == receiver)
      index = i;
  if (index == SIZE_MAX) return NULL;
  if (index == 0) return scr_dyn_new_num(0);
  if (index == 2) return scr_dyn_new_bool(false);
  ScrStr *empty = scr_str_new("", 0);
  ScrDyn *value = scr_dyn_new_str(empty);
  scr_str_release(empty);
  return value;
}

/* A wrapped wrapper-prototype method: caps[0] the owner name, caps[1] the
 * method name, caps[2] the member function. */
static ScrDyn *scr_js_wrapper_member_call(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  /* Every read is +1, so the values are released below. */
  ScrStr *owner = scr_box_get_ref(closure->caps[0]);
  ScrStr *method = scr_box_get_ref(closure->caps[1]);
  ScrDyn *callee = scr_box_get_ref(closure->caps[2]);
  ScrDyn *receiver = scr_dyn_this_get();
  ScrDyn *wrapped = scr_js_wrapper_zero(receiver);
  ScrDyn *result;
  if (wrapped) {
    scr_dyn_this_push_dyn(wrapped);
    result = scr_dyn_call(callee, args, argc, method->data);
    scr_dyn_this_pop();
    scr_dyn_release(wrapped);
  } else {
    result = scr_dyn_call(callee, args, argc, method->data);
  }
  scr_dyn_release(receiver);
  scr_dyn_release(callee);
  scr_str_release(owner);
  scr_str_release(method);
  return result;
}

/* `callee` (owned, consumed) as the member value of a wrapper prototype. */
static ScrDyn *scr_js_wrapper_member(ScrDyn *callee, const ScrStr *owner, const ScrStr *method) {
  ScrClosure *closure = scr_closure_new(NULL, 3);
  closure->caps[0] = scr_box_new(SCR_BOX_STR);
  scr_box_set_ref(closure->caps[0], scr_str_retain((ScrStr *)owner));
  closure->caps[1] = scr_box_new(SCR_BOX_STR);
  scr_box_set_ref(closure->caps[1], scr_str_retain((ScrStr *)method));
  closure->caps[2] = scr_box_new_obj(scr_dyn_retain_v, scr_dyn_release_v, NULL);
  scr_box_set_ref(closure->caps[2], callee);
  return scr_dyn_new_func(closure, scr_js_wrapper_member_call, 0, "native:prototype", method->data);
}

/* The value of one member row, or NULL when the row defines nothing
 * (a constructor's `prototype`, which seeds the pair instead). */
static ScrDyn *scr_js_member_value(size_t index, const ScrJsIntrinsicRow *row) {
  ScrDyn *object = scr_js_objects[index];
  char kind = scr_js_kind_of(row->kind);
  switch (kind) {
  case SCR_JS_INTRINSIC:
    return scr_js_intrinsic_sized(scr_js_object_index(row->a), row->a);
  case SCR_JS_METHOD: {
    if (scr_js_id_is_prototype(row->owner)) {
      /* Function.prototype's members are the values a function value answers
       * (scr_dyn_fn_get): `Function.prototype.apply === f.apply`. */
      if (strcmp(row->owner, "Function.prototype") == 0 && strcmp(row->a, "apply") == 0)
        return scr_dyn_function_apply();
      char owner[96];
      scr_js_method_owner(row->owner, owner, sizeof owner);
      size_t method_length = scr_js_member_name_length(row->a);
      ScrStr *prototype = scr_str_new(owner, strlen(owner));
      ScrStr *method = scr_str_new(row->a, method_length);
      ScrDyn *value = scr_dyn_builtin_method(prototype, method);
      if (scr_js_wrapper_owner(owner)) value = scr_js_wrapper_member(value, prototype, method);
      scr_str_release(method);
      scr_str_release(prototype);
      scr_js_define_length(value, scr_js_member_length(row->a));
      return value;
    }
    /* A constructor's static: the interned builtin function the frontend
     * emits for it, whose call refuses an interface the runtime does not
     * implement. */
    char text[160];
    int text_length = snprintf(text, sizeof text, "%s.%s", row->owner, row->key);
    ScrStr *name = scr_str_new(text, text_length < 0 ? 0 : (size_t)text_length);
    ScrDyn *value = scr_dyn_builtin_function(name);
    scr_str_release(name);
    scr_js_define_length(value, scr_js_member_length(row->a));
    return value;
  }
  case SCR_JS_ACCESSOR: {
    ScrDyn *getter = NULL;
    ScrDyn *setter = NULL;
    if (row->a[0]) {
      getter = scr_dyn_new_func(scr_closure_new((void *)(uintptr_t)(row - scr_js_rows), 0), scr_js_getter_call,
                                (uint32_t)scr_js_member_length(row->a), "native:accessor", "");
      scr_js_define_accessor_name(getter, row->a);
    }
    if (row->b[0]) {
      setter = scr_dyn_new_func(scr_closure_new((void *)(uintptr_t)(row - scr_js_rows), 0), scr_js_setter_call,
                                (uint32_t)scr_js_member_length(row->b), "native:accessor", "");
      scr_js_define_accessor_name(setter, row->b);
    }
    ScrDyn *key = scr_js_key(row->key);
    scr_js_define_accessor(object, key, getter, setter, row->attributes);
    scr_dyn_release(key);
    return NULL;
  }
  case SCR_JS_NUMBER:
    return scr_dyn_new_num(strtod(row->a, NULL));
  case SCR_JS_STRING: {
    ScrStr *text = scr_str_new(row->a, strlen(row->a));
    ScrDyn *value = scr_dyn_new_str(text);
    scr_str_release(text);
    return value;
  }
  case SCR_JS_BOOL:
    return scr_dyn_new_bool(row->a[0] == 't');
  case SCR_JS_SYMBOL: {
    /* The table names the symbol by its description ("Symbol.iterator");
     * the value is the well-known symbol of that name. */
    const char *name = row->a;
    if (strncmp(name, "Symbol.", 7) == 0) name += 7;
    ScrStr *text = scr_str_new(name, strlen(name));
    ScrSym *symbol = scr_sym_well_known(text);
    scr_str_release(text);
    ScrDyn *value = scr_dyn_new_symbol(symbol);
    scr_sym_release(symbol);
    return value;
  }
  case SCR_JS_UNSCOPABLES: {
    ScrDyn *value = scr_dyn_new_obj();
    const char *names = row->a;
    while (*names) {
      const char *comma = strchr(names, ',');
      size_t length = comma ? (size_t)(comma - names) : strlen(names);
      if (length) scr_dyn_obj_set(value, names, length, scr_dyn_new_bool(true));
      if (!comma) break;
      names = comma + 1;
    }
    return value;
  }
  case SCR_JS_UNDEFINED:
    return scr_dyn_retain(scr_dyn_undefined());
  case SCR_JS_NULL:
    return scr_dyn_new_null();
  default:
    break;
  }
  return NULL;
}

/* Whether a present member must be replaced rather than kept: a constructor's
 * own `length` and `name` are the closure's, which is the dispatch arity and
 * the source name, not the interface's (`Date.length` is 7). Everything else
 * present is a value the runtime's own builders installed and a call reaches
 * directly, so it stays. */
static bool scr_js_replace_present(const ScrJsIntrinsicRow *row) {
  if (scr_js_id_is_prototype(row->owner)) return false;
  return strcmp(row->key, "length") == 0 || strcmp(row->key, "name") == 0;
}

/* Defines one member of the object at `index`. */
static void scr_js_fill_row(size_t index, const ScrJsIntrinsicRow *row) {
  ScrDyn *object = scr_js_objects[index];
  ScrDyn *key = scr_js_key(row->key);
  bool present = scr_js_own(object, key);
  if (present && !scr_js_replace_present(row)) {
    scr_dyn_release(key);
    return;
  }
  /* A constructor's `prototype` is the pair's other half: the same object,
   * non-writable, non-enumerable, non-configurable, seeded on the function
   * so both directions of the link agree. */
  if (scr_js_kind_of(row->kind) == SCR_JS_INTRINSIC && strcmp(row->key, "prototype") == 0 &&
      !scr_js_id_is_prototype(row->owner) && key->kind != SCR_DYN_SYMBOL) {
    ScrDyn *prototype = scr_js_intrinsic_sized(scr_js_object_index(row->a), row->a);
    scr_dyn_release(key);
    scr_dyn_fn_seed_prototype(object, prototype);
    return;
  }
  ScrDyn *value = scr_js_member_value(index, row);
  if (value) scr_js_define(object, key, value, row->attributes);
  scr_dyn_release(key);
}

/* Defines the members of the object at `index` from the table. The caller
 * holds the fill scope: the object is registered and marked filled before
 * this runs, so a member naming it answers it. */
static void scr_js_fill_object(size_t index) {
  const char *owner = scr_js_object_ids[index];
  for (size_t i = 0; i < sizeof scr_js_rows / sizeof scr_js_rows[0]; i++)
    if (strcmp(scr_js_rows[i].owner, owner) == 0)
      scr_js_fill_row(index, &scr_js_rows[i]);
}

/* Builds the object named by `id` (index `index`) and fills it: the object
 * is registered before its members are defined, so a member naming it again
 * answers it. +1 (the slot's reference plus one). */
static ScrDyn *scr_js_build(size_t index) {
  if (scr_js_filled[index]) return scr_dyn_retain(scr_js_objects[index]);
  scr_js_register_cleanup();
  const char *id = scr_js_object_ids[index];
  ScrDyn *object = scr_js_create(id);
  /* Creating a prototype can build it through its own members: the
   * constructor's `prototype` row is the pair's other half, so the fill of
   * that row registers and fills the prototype while this build is still
   * inside scr_js_create. The slot then already owns a reference and the
   * object is filled; this build hands its own reference to the caller
   * instead of storing it a second time. */
  if (scr_js_filled[index] && scr_js_objects[index] == object) return object;
  scr_js_objects[index] = object;
  scr_js_filled[index] = true;
  scr_js_built_count++;
  /* The fill scope covers the [[Prototype]] link too: the runtime's fences
   * refuse a program's writes to what it builds, and the fill is the one
   * writer allowed to make them. */
  scr_js_fill_depth++;
  /* The object's [[Prototype]] first, then its members. Array.prototype's
   * adapters install first too, so the fill keeps them and adds the rest. */
  if (index == scr_js_object_index("Array.prototype")) scr_dyn_release(scr_dyn_array_prototype());
  const char *prototype_id = scr_js_prototype_id(id);
  if (prototype_id && strcmp(prototype_id, "null") != 0 && strcmp(prototype_id, "?") != 0) {
    size_t prototype_index = scr_js_object_index(prototype_id);
    if (prototype_index != SIZE_MAX) {
      ScrDyn *prototype = scr_js_build(prototype_index);
      ScrDyn *linked = scr_dyn_set_prototype(object, prototype);
      scr_dyn_release(prototype);
      if (!linked) {
        char message[192];
        int length = snprintf(message, sizeof message,
                              "scriptc: linking builtin intrinsic %s failed (%s)\n", id, prototype_id);
        (void)length;
        scr_trap(message);
      }
      scr_dyn_release(linked);
    }
  }
  scr_js_fill_object(index);
  scr_js_fill_depth--;
  return scr_dyn_retain(object);
}

/* ── entry points ────────────────────────────────────────────────────── */

/* The object named by `id` (+1). `id` comes from the generated table the
 * frontend compiled against, so an unknown one is a compiler/runtime
 * mismatch. */
static ScrDyn *scr_js_intrinsic_sized(size_t index, const char *id) {
  if (index == SIZE_MAX) {
    char message[160];
    int length = snprintf(message, sizeof message, "scriptc: unknown builtin intrinsic %s\n", id);
    (void)length;
    scr_trap(message);
  }
  return scr_js_build(index);
}

ScrDyn *scr_js_intrinsic(const ScrStr *id) {
  return scr_js_intrinsic_sized(scr_js_object_index(id->data), id->data);
}

/* Whether the runtime has already filled `object` with its members. */
bool scr_js_intrinsic_filled(const ScrDyn *object) {
  if (!scr_js_built_count || !object) return false;
  size_t index = scr_js_value_index(object);
  return index != SIZE_MAX && scr_js_filled[index];
}

/* Whether a fill is running: the fences that keep a program from replacing
 * a builtin member are off while the runtime builds them. */
bool scr_js_intrinsic_filling(void) { return scr_js_fill_depth != 0; }

/* Whether the table names `key` as a member of the intrinsic `object` stands
 * for. The member-replacement fence (scr_json.c) refuses a program's write,
 * delete or redefinition of one: the member value is the runtime's interned
 * function, and every typed call site calls the native entry point, so a
 * replacement would look accepted and never be observed. A key the table
 * does not name — including one the program adds — is an ordinary property. */
bool scr_js_intrinsic_has_builtin_member(const ScrDyn *object, const ScrDyn *key) {
  if (!scr_js_built_count || !object || !key) return false;
  if (key->kind != SCR_DYN_STR && key->kind != SCR_DYN_SYMBOL) return false;
  size_t index = scr_js_value_index(object);
  if (index == SIZE_MAX) return false;
  scr_js_index_rows();
  for (size_t i = scr_js_row_start[index]; i < scr_js_row_end[index]; i++)
    if (scr_js_names_key(scr_js_rows[i].key, key)) return true;
  return false;
}

/* The table id a value the runtime keeps outside this unit stands for: an
 * interned builtin constructor (`Date`), which the frontend reads through
 * dyn.globalConstructor rather than through this unit, or one of the
 * Object.prototype, Array.prototype and Error.prototype singletons.
 * SIZE_MAX otherwise. */
static size_t scr_js_object_index_of_value(const ScrDyn *object) {
  if (object->kind == SCR_DYN_FUNC) {
    if (object->v.fn.class_obj || !object->v.fn.name || !object->v.fn.name[0]) return SIZE_MAX;
    /* The constructor test first: most functions are the program's, and the
     * id lookup scans the whole table. */
    ScrStr *name = scr_str_new(object->v.fn.name, strlen(object->v.fn.name));
    bool interned = scr_dyn_global_constructor_known(name);
    if (interned) {
      ScrDyn *constructor = scr_dyn_global_constructor(name);
      interned = constructor == object;
      scr_dyn_release(constructor);
    }
    scr_str_release(name);
    if (!interned) return SIZE_MAX;
    size_t index = scr_js_object_index(object->v.fn.name);
    return index != SIZE_MAX && !scr_js_id_is_prototype(scr_js_object_ids[index]) ? index : SIZE_MAX;
  }
  ScrDyn *singleton = scr_dyn_object_prototype();
  bool match = singleton == object;
  scr_dyn_release(singleton);
  if (match) return scr_js_object_index("Object.prototype");
  singleton = scr_dyn_array_prototype_base();
  match = singleton == object;
  scr_dyn_release(singleton);
  if (match) return scr_js_object_index("Array.prototype");
  singleton = scr_dyn_error_prototype();
  match = singleton == object;
  scr_dyn_release(singleton);
  return match ? scr_js_object_index("Error.prototype") : SIZE_MAX;
}

/* Fills the intrinsic `object` stands for — Object.prototype,
 * Array.prototype, Error.prototype — in place, so the singleton every other
 * unit answers is the intrinsic the table describes. Objects the table does
 * not name are left alone. */
void scr_js_intrinsics_fill(ScrDyn *object) {
  if (!object) return;
  size_t index = scr_js_value_index(object);
  if (index == SIZE_MAX) index = scr_js_object_index_of_value(object);
  if (index == SIZE_MAX) return;
  if (scr_js_filled[index]) return;
  scr_js_register_cleanup();
  scr_js_objects[index] = scr_dyn_retain(object);
  scr_js_filled[index] = true;
  scr_js_built_count++;
  scr_js_fill_depth++;
  scr_js_fill_object(index);
  scr_js_fill_depth--;
}

/* The [[Prototype]] the intrinsic graph gives `value` (+1), or NULL when the
 * value is not one the graph describes. Consulted where
 * scr_dyn_get_prototype would refuse: a native Date answers Date.prototype,
 * a function answers Function.prototype, an intrinsic object answers the
 * prototype the table links it to. */
ScrDyn *scr_js_intrinsic_prototype_of(const ScrDyn *value) {
  size_t index = scr_js_value_index(value);
  if (index != SIZE_MAX) {
    const char *prototype_id = scr_js_prototype_id(scr_js_object_ids[index]);
    if (!prototype_id) return NULL;
    if (strcmp(prototype_id, "null") == 0) return scr_dyn_new_null();
    if (strcmp(prototype_id, "?") == 0) return NULL;
    size_t prototype_index = scr_js_object_index(prototype_id);
    if (prototype_index == SIZE_MAX) return NULL;
    return scr_js_build(prototype_index);
  }
  switch (value->kind) {
  /* A primitive answers the prototype the table builds for it: the same
   * object `Number.prototype` reads, so a member the program writes there —
   * a new key, or one it replaced through a dynamic receiver — is the member
   * a dynamic read of a value finds. */
  case SCR_DYN_BOOL:
    return scr_js_intrinsic_sized(scr_js_object_index("Boolean.prototype"), "Boolean.prototype");
  case SCR_DYN_NUM:
    return scr_js_intrinsic_sized(scr_js_object_index("Number.prototype"), "Number.prototype");
  case SCR_DYN_STR:
    return scr_js_intrinsic_sized(scr_js_object_index("String.prototype"), "String.prototype");
  case SCR_DYN_BIGINT:
    return scr_js_intrinsic_sized(scr_js_object_index("BigInt.prototype"), "BigInt.prototype");
  case SCR_DYN_SYMBOL:
    return scr_js_intrinsic_sized(scr_js_object_index("Symbol.prototype"), "Symbol.prototype");
  case SCR_DYN_FUNC:
    return scr_js_intrinsic_sized(scr_js_object_index("Function.prototype"), "Function.prototype");
  case SCR_DYN_PROMISE:
    return scr_js_intrinsic_sized(scr_js_object_index("Promise.prototype"), "Promise.prototype");
  case SCR_DYN_HANDLE:
    switch (value->v.handle.tag) {
    case SCR_DYNH_DATE:
      return scr_js_intrinsic_sized(scr_js_object_index("Date.prototype"), "Date.prototype");
    case SCR_DYNH_REGEXP:
      return scr_js_intrinsic_sized(scr_js_object_index("RegExp.prototype"), "RegExp.prototype");
    case SCR_DYNH_MAP:
      return scr_js_intrinsic_sized(scr_js_object_index("Map.prototype"), "Map.prototype");
    case SCR_DYNH_SET:
      return scr_js_intrinsic_sized(scr_js_object_index("Set.prototype"), "Set.prototype");
    case SCR_DYNH_WEAK_MAP:
      return scr_js_intrinsic_sized(scr_js_object_index("WeakMap.prototype"), "WeakMap.prototype");
    case SCR_DYNH_WEAK_SET:
      return scr_js_intrinsic_sized(scr_js_object_index("WeakSet.prototype"), "WeakSet.prototype");
    case SCR_DYNH_ARRAY_BUFFER:
      return scr_js_intrinsic_sized(scr_js_object_index("ArrayBuffer.prototype"), "ArrayBuffer.prototype");
    case SCR_DYNH_SHARED_ARRAY_BUFFER:
      return scr_js_intrinsic_sized(scr_js_object_index("SharedArrayBuffer.prototype"),
                                    "SharedArrayBuffer.prototype");
    case SCR_DYNH_ITERATOR:
      return scr_js_intrinsic_sized(scr_js_object_index("Iterator.prototype"), "Iterator.prototype");
    case SCR_DYNH_FINALIZATION_REGISTRY:
      return scr_js_intrinsic_sized(scr_js_object_index("FinalizationRegistry.prototype"),
                                    "FinalizationRegistry.prototype");
    default:
      return NULL;
    }
  case SCR_DYN_BYTES: {
    const ScrBytes *bytes = value->v.bytes;
    if (bytes->is_data_view)
      return scr_js_intrinsic_sized(scr_js_object_index("DataView.prototype"), "DataView.prototype");
    const char *id = NULL;
    switch (bytes->elem) {
    case SCR_BYTES_I8: id = "Int8Array.prototype"; break;
    case SCR_BYTES_U8: id = "Uint8Array.prototype"; break;
    case SCR_BYTES_U8C: id = "Uint8ClampedArray.prototype"; break;
    case SCR_BYTES_I16: id = "Int16Array.prototype"; break;
    case SCR_BYTES_U16: id = "Uint16Array.prototype"; break;
    case SCR_BYTES_I32: id = "Int32Array.prototype"; break;
    case SCR_BYTES_U32: id = "Uint32Array.prototype"; break;
    case SCR_BYTES_F16: id = "Float16Array.prototype"; break;
    case SCR_BYTES_F32: id = "Float32Array.prototype"; break;
    case SCR_BYTES_F64: id = "Float64Array.prototype"; break;
    case SCR_BYTES_I64: id = "BigInt64Array.prototype"; break;
    case SCR_BYTES_U64: id = "BigUint64Array.prototype"; break;
    default: break;
    }
    if (!id) return NULL;
    return scr_js_intrinsic_sized(scr_js_object_index(id), id);
  }
  default:
    return NULL;
  }
}

#else /* SCR_JS_INTRINSICS */

/* The object model build of scr_json.c calls these five; without the graph
 * no object was ever filled, so the answers are the empty ones. */
void scr_js_intrinsics_fill(ScrDyn *object) {
  (void)object;
}

bool scr_js_intrinsic_filled(const ScrDyn *object) {
  (void)object;
  return false;
}

bool scr_js_intrinsic_filling(void) {
  return false;
}

bool scr_js_intrinsic_has_builtin_member(const ScrDyn *object, const ScrDyn *key) {
  (void)object;
  (void)key;
  return false;
}

ScrDyn *scr_js_intrinsic_prototype_of(const ScrDyn *value) {
  (void)value;
  return NULL;
}

#endif /* SCR_JS_INTRINSICS */
