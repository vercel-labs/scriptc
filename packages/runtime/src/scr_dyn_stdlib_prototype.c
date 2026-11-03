/* The standard library's prototype objects as values — Date.prototype.
 *
 * A JavaScript source reading `Date.prototype` used to reach the
 * standard-library member fence: the checker types the read as a Date, and
 * there was no prototype object to hand out, so `Date.prototype
 * .hasOwnProperty("getTime")` and the rest of the interface's existence
 * tests could not compile at all. This unit builds the prototype object the
 * language defines — an ordinary object whose prototype is Object.prototype,
 * carrying the interface's methods as non-enumerable, writable, configurable
 * data properties plus its constructor — and answers it from one object per
 * thread, so every read is the same object (`Date.prototype ===
 * Date.prototype`).
 *
 * The method values are the invoke unit's interned builtin-method functions
 * (scr_dyn_builtin_method), which are what `Date.prototype.<method>` reads
 * already answer, so both spellings are the same function; the constructor's
 * `prototype` is seeded with this same object, so `Date.prototype
 * .constructor === Date` and `Date. prototype.getTime` agree with a Date
 * value's inherited members. A Date method called on the prototype object
 * itself reaches that same dispatch with a receiver that is not a Date
 * handle, so it throws the TypeError the language answers.
 *
 * The unit links only into programs that read one of these values in a
 * JavaScript source (the frontend marks dyn.stdlibPrototype there), so typed
 * programs keep their exact executables and no always-linked unit changes. */
#include "scr_runtime.h"
#include "scr_dyn_methods.h"

#include <string.h>

/* Date.prototype's interface: every method the standard defines, plus the two
 * Annex B ones (getYear, setYear), whose presence the existence tests assert.
 * Each member carries the ECMAScript `length` of the function it holds —
 * argument counts V8 answers too (the setters' optional fields do not count,
 * so setFullYear is 3 and setHours is 4). Symbol.toPrimitive is a symbol key
 * and has no checked-dynamic spelling yet.
 *
 * `method` names the interned invoke-unit function when it differs from the
 * property name: Annex B's toGMTString IS toUTCString in V8 — one interned
 * function under two non-enumerable keys, same identity and same `name`. */
typedef struct {
  const char *property;
  const char *method;
  size_t length;
} DynDatePrototypeMember;

static const DynDatePrototypeMember dyn_date_prototype_members[] = {
  {"toString", NULL, 0}, {"toDateString", NULL, 0}, {"toTimeString", NULL, 0},
  {"toISOString", NULL, 0}, {"toUTCString", NULL, 0}, {"toGMTString", "toUTCString", 0},
  {"toJSON", NULL, 1}, {"toLocaleString", NULL, 0}, {"toLocaleDateString", NULL, 0},
  {"toLocaleTimeString", NULL, 0}, {"valueOf", NULL, 0},
  {"getTime", NULL, 0}, {"getFullYear", NULL, 0}, {"getUTCFullYear", NULL, 0},
  {"getMonth", NULL, 0}, {"getUTCMonth", NULL, 0}, {"getDate", NULL, 0},
  {"getUTCDate", NULL, 0}, {"getDay", NULL, 0}, {"getUTCDay", NULL, 0},
  {"getHours", NULL, 0}, {"getUTCHours", NULL, 0}, {"getMinutes", NULL, 0},
  {"getUTCMinutes", NULL, 0}, {"getSeconds", NULL, 0}, {"getUTCSeconds", NULL, 0},
  {"getMilliseconds", NULL, 0}, {"getUTCMilliseconds", NULL, 0},
  {"getTimezoneOffset", NULL, 0}, {"getYear", NULL, 0},
  {"setTime", NULL, 1}, {"setMilliseconds", NULL, 1}, {"setUTCMilliseconds", NULL, 1},
  {"setSeconds", NULL, 2}, {"setUTCSeconds", NULL, 2}, {"setMinutes", NULL, 3},
  {"setUTCMinutes", NULL, 3}, {"setHours", NULL, 4}, {"setUTCHours", NULL, 4},
  {"setDate", NULL, 1}, {"setUTCDate", NULL, 1}, {"setMonth", NULL, 2},
  {"setUTCMonth", NULL, 2}, {"setFullYear", NULL, 3}, {"setUTCFullYear", NULL, 3},
  {"setYear", NULL, 1},
};

/* One prototype object per thread, thread-local like the invoke unit's
 * interned method table it is built from, and kept for the lifetime of the
 * program the way that table is. */
static SCR_TL ScrDyn *dyn_stdlib_prototype_date;

static void dyn_stdlib_prototype_cleanup(void) {
  scr_dyn_release(dyn_stdlib_prototype_date);
  dyn_stdlib_prototype_date = NULL;
}

/* Defines `value` (borrowed) on `target` as a non-enumerable, writable,
 * configurable data property named `name` — the shape every built-in
 * prototype method has. The descriptor is a plain object, and an omitted
 * `enumerable` byte is false. */
static void dyn_stdlib_define(ScrDyn *target, ScrStr *name, ScrDyn *value) {
  ScrDyn *descriptor = scr_dyn_new_obj();
  scr_dyn_obj_set(descriptor, "value", 5, scr_dyn_retain(value));
  scr_dyn_obj_set(descriptor, "writable", 8, scr_dyn_new_bool(true));
  scr_dyn_obj_set(descriptor, "configurable", 12, scr_dyn_new_bool(true));
  ScrDyn *key = scr_dyn_new_str(name); /* retains */
  ScrDyn *defined = scr_dyn_define_property(target, key, descriptor);
  scr_dyn_release(defined);
  scr_dyn_release(key);
  scr_dyn_release(descriptor);
}

/* `method`'s ECMAScript `length`: the argument count of the interface
 * function, as an own data property with the attributes every built-in
 * function's length has (non-writable, non-enumerable, configurable). The
 * invoke unit's interned method functions carry their dispatch arity instead
 * — dyn_builtin_method_call takes (this, ...args) — so the declared length is
 * written here, on the interned function itself, which keeps every spelling
 * of the same method (Date.prototype.setDate, the property the prototype
 * object holds) answering one value. */
static void dyn_stdlib_define_length(ScrDyn *method, size_t length) {
  ScrDyn *descriptor = scr_dyn_new_obj();
  scr_dyn_obj_set(descriptor, "value", 5, scr_dyn_new_num((double)length));
  scr_dyn_obj_set(descriptor, "writable", 8, scr_dyn_new_bool(false));
  scr_dyn_obj_set(descriptor, "enumerable", 10, scr_dyn_new_bool(false));
  scr_dyn_obj_set(descriptor, "configurable", 12, scr_dyn_new_bool(true));
  ScrStr *length_name = scr_str_new("length", sizeof "length" - 1);
  ScrDyn *key = scr_dyn_new_str(length_name); /* retains */
  scr_str_release(length_name);
  ScrDyn *defined = scr_dyn_define_property(method, key, descriptor);
  scr_dyn_release(defined);
  scr_dyn_release(key);
  scr_dyn_release(descriptor);
}

static ScrDyn *dyn_stdlib_prototype_build_date(const ScrStr *name) {
  ScrDyn *prototype = scr_dyn_new_obj(); /* an ordinary object: Object.prototype behind it */
  for (size_t i = 0; i < sizeof dyn_date_prototype_members / sizeof dyn_date_prototype_members[0]; i++) {
    const DynDatePrototypeMember *member = &dyn_date_prototype_members[i];
    const char *method_name = member->method ? member->method : member->property;
    ScrStr *method = scr_str_new(method_name, strlen(method_name));
    ScrDyn *value = scr_dyn_builtin_method(name, method);
    ScrStr *property = scr_str_new(member->property, strlen(member->property));
    dyn_stdlib_define(prototype, property, value);
    scr_str_release(property);
    dyn_stdlib_define_length(value, member->length);
    scr_dyn_release(value);
    scr_str_release(method);
  }
  /* Date.prototype.constructor, and the constructor's own `prototype`, are
   * this same object, so both directions of the link agree. */
  ScrDyn *ctor = scr_dyn_global_constructor(name);
  if (ctor) {
    ScrStr *constructor = scr_str_new("constructor", sizeof "constructor" - 1);
    dyn_stdlib_define(prototype, constructor, ctor);
    scr_str_release(constructor);
    scr_dyn_fn_seed_prototype(ctor, scr_dyn_retain(prototype));
    scr_dyn_release(ctor);
  }
  return prototype;
}

/* The prototype object of the named constructor, as a value;
 * dyn.stdlibPrototype's implementation. `name` is a string literal the
 * frontend emitted, so an unknown one is a compiler/runtime mismatch. */
ScrDyn *scr_dyn_stdlib_prototype(const ScrStr *name) {
  if (strcmp(name->data, "Date") != 0) {
    static const char message[] = "scriptc: unknown standard library prototype\n";
    scr_trap(message);
  }
  if (!dyn_stdlib_prototype_date) {
    dyn_stdlib_prototype_date = dyn_stdlib_prototype_build_date(name);
    scr_atexit(dyn_stdlib_prototype_cleanup);
  }
  return scr_dyn_retain(dyn_stdlib_prototype_date);
}
