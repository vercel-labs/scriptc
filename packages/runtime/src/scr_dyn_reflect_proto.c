/* Reflect.getPrototypeOf's target check: unlike Object.getPrototypeOf, it
 * rejects every primitive (null and undefined included) instead of boxing.
 *
 * A unit of its own, selected only by programs that call
 * dyn.reflectGetPrototypeTarget: scr_json.c is linked by nearly every
 * program, and a function added to that unit moves every symbol the linker
 * lays out after it (sections are laid out by name, so the function's place
 * in the source does not matter), so every executable would change for a
 * check only Reflect.getPrototypeOf programs reach.
 *
 * The primitive test repeats scr_json.c's static scr_dyn_primitive_kind
 * rather than sharing it: exporting the helper out of the always-linked unit
 * would move its layout just the same. */
#include "scr_runtime.h"

static bool scr_dyn_reflect_primitive(const ScrDyn *value) {
  switch (value->kind) {
  case SCR_DYN_UNDEF:
  case SCR_DYN_NULL:
  case SCR_DYN_BOOL:
  case SCR_DYN_NUM:
  case SCR_DYN_STR:
  case SCR_DYN_BIGINT:
  case SCR_DYN_SYMBOL:
    return true;
  default:
    return false;
  }
}

void scr_dyn_reflect_get_prototype_target(const ScrDyn *target) {
  if (!scr_dyn_reflect_primitive(target)) return;
  static const char message[] = "Reflect.getPrototypeOf called on non-object";
  scr_throw_error_msg(SCR_ERR_TYPE, message, sizeof message - 1);
}
