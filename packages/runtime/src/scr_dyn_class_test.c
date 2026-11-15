/* The prototype read of a class test's walk: `value instanceof C`, for a
 * class of the program, compares each prototype on the value's chain with
 * the class's own.
 *
 * The walk asks a question that has an answer for every value, so this read
 * never refuses one. It decides which values have a chain a program class's
 * prototype can be on, and scr_dyn_get_prototype_for_identity (scr_json.c)
 * reads it: an object, an array or a function whose prototype the program
 * chose, a record's or an array's capsule (its view's prototype), and an
 * island object. Every other value has only builtin prototypes on its chain
 * (typed-array bytes, a native handle such as an ArrayBuffer, an iterator or
 * a URL, a generator object, a typed collection's capsule):
 * Object.setPrototypeOf refuses each of them, and no program class extends
 * the builtin ones (a class extending Date makes instances of its own). A
 * class instance's capsule is answered by its key before the walk starts,
 * and the compiled prototype read answers for the classes that have a
 * prototype of their own. So the walk ends there with null: not an
 * instance.
 *
 * A Proxy has its target's prototype unless its handler has a
 * getPrototypeOf trap, which is refused by name like the other traps the
 * runtime does not run.
 *
 * A unit of its own, selected only by programs that call
 * dyn.classTestPrototype: scr_json.c is linked by nearly every program, and
 * a string or a static added to that unit renumbers the unit's other
 * statics, so every executable would change for a read only class tests of
 * untyped values reach. */
#include "scr_runtime.h"

#include <string.h>

ScrDyn *scr_dyn_class_test_prototype(ScrDyn *object) {
  switch (object->kind) {
  case SCR_DYN_OBJ:
  case SCR_DYN_ARR:
  case SCR_DYN_FUNC:
    break;
  case SCR_DYN_PROXY: {
    ScrDyn *trap = scr_dyn_obj_read(object->v.proxy.handler, "getPrototypeOf", 14);
    bool none = !trap || trap->kind == SCR_DYN_UNDEF || trap->kind == SCR_DYN_NULL;
    scr_dyn_release(trap);
    if (scr_exc_pending()) return NULL;
    if (none) return scr_dyn_class_test_prototype(object->v.proxy.target);
    scr_dyn_proxy_unsupported("getPrototypeOf traps");
    return NULL;
  }
  case SCR_DYN_HANDLE:
    if (!scr_ni_dyn_handle(object)) return scr_dyn_new_null();
    break;
  case SCR_DYN_TYPED_REF: {
    /* A class instance's chain is the compiled class test's, except for an
     * instance Object.setPrototypeOf gave another prototype, which that
     * test declines: its chain continues from the replacement. */
    if (scr_dyn_prototype_replaced(object)) break;
    const char *key = object->v.typed_ref.type_key;
    if (strncmp(key, "record:", 7) && strncmp(key, "array<", 6)) return scr_dyn_new_null();
    break;
  }
  default:
    return scr_dyn_new_null();
  }
  return scr_dyn_get_prototype_for_identity(object);
}
