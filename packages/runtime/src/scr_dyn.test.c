/* White-box check for the object model's cross-unit slots (scr_dyn.h,
 * SCR_JS_SLOT_FALLBACK). Built by scr_dyn.test.ts alone, where the fallback
 * must leave the slot at NULL, and with scr_dyn_slot_provider.test.c, whose
 * strong definition must override it. The fallback is what keeps the read
 * below from faulting: a weak reference to a slot no unit provides leaves the
 * symbol at address zero on ELF, so testing the slot would load it from
 * address zero instead of answering NULL. */
#define SCR_JS_OBJECT_MODEL 1
#include "scr_dyn.h"
#include <stdio.h>

/* The graph's fallback, spelled as scr_js_intrinsics.c spells it. */
SCR_JS_SLOT_FALLBACK(ScrJsWrapperPrototypeSlot, scr_js_wrapper_intrinsic_prototype_slot);

int main(void) {
  if (scr_js_wrapper_intrinsic_prototype_slot)
    scr_js_wrapper_intrinsic_prototype_slot("String.prototype");
  else
    puts("fallback");
  return 0;
}
