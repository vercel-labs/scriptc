#undef NDEBUG
#include "scr_rc.h"
#include <assert.h>
#include <stdio.h>

/* The rc word's encodings (scr_rc.h): the count in the low half, and the
 * program-lifetime bit, the frozen bit and the layout id in the high half.
 * Immortality is a count of all ones; a layout id survives it. */
static size_t word(uint32_t high, uint32_t count) {
  return ((size_t)high << 32) | count;
}

int main(void) {
#if SIZE_MAX > UINT32_MAX
  /* An ordinary object: no layout id, not frozen, not immortal. */
  size_t plain = word(0, 3);
  assert(scr_rc_layout_id(&plain) == 0 && !scr_rc_frozen(&plain) && !scr_rc_immortal(&plain));
  /* The whole-word immortal encoding has no layout id and is not frozen. */
  size_t immortal = SIZE_MAX;
  assert(scr_rc_layout_id(&immortal) == 0 && scr_rc_immortal(&immortal) && !scr_rc_frozen(&immortal));
  /* A program-lifetime record (llvm/classes.ts programLifetimeRc) and a
   * frozen record have no layout id. */
  size_t lifetime = word(SCR_RC_HIGH_LIFETIME, 0);
  assert(scr_rc_layout_id(&lifetime) == 0 && !scr_rc_immortal(&lifetime));
  size_t frozen = word(SCR_RC_HIGH_FROZEN, 2);
  assert(scr_rc_layout_id(&frozen) == 0 && scr_rc_frozen(&frozen));
  /* A class instance keeps its class id, which is its layout id, beside
   * its count, also once immortal, frozen or program-lifetime. */
  size_t instance = word(7, 1);
  assert(scr_rc_layout_id(&instance) == 7 && scr_rc_class_id(&instance) == 7);
  SCR_RC_COUNT(&instance) = SCR_RC_IMMORTAL;
  assert(scr_rc_immortal(&instance) && scr_rc_layout_id(&instance) == 7 && !scr_rc_frozen(&instance));
  size_t frozen_id = word(SCR_RC_HIGH_FROZEN | 9, 1);
  assert(scr_rc_layout_id(&frozen_id) == 9 && scr_rc_frozen(&frozen_id));
  size_t lifetime_id = word(SCR_RC_HIGH_LIFETIME | 11, UINT32_C(0x80000000));
  assert(scr_rc_layout_id(&lifetime_id) == 11 && !scr_rc_immortal(&lifetime_id));
  /* The largest layout id. */
  size_t top = word(SCR_RC_LAYOUT_ID_LIMIT - 1, 1);
  assert(scr_rc_layout_id(&top) == SCR_RC_LAYOUT_ID_LIMIT - 1);
#else
  size_t plain = 3, immortal = SIZE_MAX;
  assert(scr_rc_layout_id(&plain) == 0 && !scr_rc_immortal(&plain));
  assert(scr_rc_immortal(&immortal) && !scr_rc_frozen(&immortal));
#endif
  puts("rc word encodings");
  return 0;
}
