/* Portable AbortController/AbortSignal use the same implementation as native
 * fetch, without its network transport, Web Streams, or global fetch setup. */

#define SCR_FETCH_SIGNAL_ONLY 1
#include "scr_fetch.c"

/* ── the test runner's t.signal ────────────────────────────────────────
 * The same native signal fetch uses, exposed to scr_test.c, which links
 * this unit only when a program reads t.signal (the abortSignal runtime
 * feature). The runner calls these through weak declarations, so a program
 * without this unit leaves them unresolved without a link error. */
ScrDyn *scr_test_abort_controller_new(void) { return scr_fetch_abort_controller_new(); }

ScrDyn *scr_test_abort_controller_signal(ScrDyn *controller) {
  if (controller == NULL || controller->kind != SCR_DYN_HANDLE ||
      controller->v.handle.tag != SCR_DYNH_ABORT_CONTROLLER)
    return scr_dyn_undefined();
  return scr_dyn_new_handle(controller->v.handle.ptr, SCR_DYNH_ABORT_SIGNAL);
}

void scr_test_abort_controller_abort(ScrDyn *controller) {
  if (controller == NULL || controller->kind != SCR_DYN_HANDLE ||
      controller->v.handle.tag != SCR_DYNH_ABORT_CONTROLLER)
    return;
  SfSignal *s = controller->v.handle.ptr;
  if (!s->aborted) sf_signal_abort_default(s, false);
}
