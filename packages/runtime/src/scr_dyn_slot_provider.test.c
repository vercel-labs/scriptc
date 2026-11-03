/* The providing unit for scr_dyn.test.c: the strong definition a linked
 * wrapper unit carries (scr_js_wrapper.c), which must override the reader's
 * weak fallback. */
#define SCR_JS_OBJECT_MODEL 1
#include "scr_dyn.h"
#include <stdio.h>

static ScrDyn *provided(const char *id) {
  printf("provided %s\n", id);
  return NULL;
}

ScrJsWrapperPrototypeSlot scr_js_wrapper_intrinsic_prototype_slot = provided;
