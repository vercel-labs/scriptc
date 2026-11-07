/* Node islands: AbortSignal and AbortController across the boundary.
 * Links into programs that have Node islands and either native signals or
 * a native receiver of one.
 *
 * The receivers of a signal in an island test its brand: undici's fetch,
 * addEventListener's `signal` option, AbortSignal.any, events.once and
 * timers/promises all throw for anything but a real AbortSignal. So a
 * native signal crosses as a twin (scr_node_island_export.c): the island
 * holds a real AbortSignal of its own realm that the bootstrap made, and
 * the native signal crosses back as itself.
 *
 * The twin follows its native signal through an abort algorithm, the
 * mechanism AbortSignal.any's signals follow their sources with: when the
 * native signal aborts, the twin aborts with the same reason before the
 * native signal's own 'abort' listeners run. Both sides therefore answer
 * `aborted` and `reason` alike whenever a listener of either side runs. The
 * algorithm is not a listener: getEventListeners and listenerCount of the
 * native signal do not see it, it never keeps the program alive, and the
 * export table removes it with the twin.
 *
 * Listener order across the two sides is the one difference from Node,
 * where it is one signal with one list: here the island's listeners run
 * first, in their own registration order, and the native ones after them
 * (docs: limitations, "Abort listeners across native code and islands").
 *
 * An AbortController is the same native object as its signal under another
 * handle tag. Its twin is the controller of its signal's twin, whose abort()
 * aborts the native signal (scr_node_island_host.cjs).
 *
 * The other way, an AbortSignal the island made that reaches native code
 * meets receivers that test the native handle: fetch, AbortSignal.any,
 * events.once, timers/promises, a listener's `signal` option. It is adopted
 * by a native signal of its own, which the island's signal aborts through a
 * signal that follows it there (so the island's listener list stays as it
 * is). Native listeners run after the island's, as in the first direction. */
#define _XOPEN_SOURCE 700
#define _DARWIN_C_SOURCE 1
#include "scr_runtime.h"
#include "scr_abort_signal.h"
#include "scr_node_island.h"

#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#if !defined(_WIN32) && !defined(__wasi__)

const ScrDynHandleOps *scr_dyn_handle_ops_of(const ScrDyn *d); /* scr_json.c */

/* The native signal aborted: its twin hears the reason. */
static void nia_fire(SfSignalWatch *w, SfSignal *signal) {
  uint32_t id = (uint32_t)(uintptr_t)w->owner;
  free(w);
  scr_ni_twin_detached(id);
  /* The reason as the program reads it: a signal aborted with itself or its
   * controller as the reason answers that handle. */
  ScrDyn *reason = signal->reason_self ? scr_dyn_new_handle(signal, signal->reason_self_tag)
                                       : scr_dyn_retain(signal->reason);
  scr_ni_twin_tell(id, "abort", reason);
  scr_dyn_release(reason);
}

static void *nia_attach(uint32_t id, void *object) {
  SfSignal *signal = object;
  /* An aborted signal never changes again: its twin reads the state once. */
  if (signal->aborted) return NULL;
  SfSignalWatch *w = calloc(1, sizeof *w);
  if (w == NULL) scr_trap("scriptc: out of memory\n");
  w->source = signal;
  w->owner = (void *)(uintptr_t)id;
  w->fire = nia_fire;
  w->next = signal->watchers;
  signal->watchers = w;
  return w;
}

/* The export table still holds the signal: the watch leaves its list. */
static void nia_detach(void *attachment) {
  SfSignalWatch *w = attachment;
  if (w->source != NULL) {
    for (SfSignalWatch **at = &w->source->watchers; *at != NULL; at = &(*at)->next) {
      if (*at == w) {
        *at = w->next;
        break;
      }
    }
  }
  free(w);
}

/* A native signal for an island signal: a controller's signal, which only
 * nia_hear aborts. */
static ScrDyn *nia_adopt(void) {
  ScrDyn *controller = scr_fetch_abort_controller_new();
  ScrDyn *signal = scr_dyn_new_handle(controller->v.handle.ptr, SCR_DYNH_ABORT_SIGNAL);
  scr_dyn_release(controller);
  return signal;
}

/* The island signal aborted: its native signal aborts with the reason. */
static void nia_hear(void *object, const char *event, ScrDyn *value) {
  if (strcmp(event, "abort") != 0) return;
  ScrDyn *controller = scr_dyn_new_handle(object, SCR_DYNH_ABORT_CONTROLLER);
  ScrDyn *args[1] = {value};
  ScrDyn *answer = scr_dyn_handle_ops_of(controller)->invoke(object, controller, "abort", args, 1, "abort");
  scr_dyn_release(answer);
  scr_dyn_release(controller);
}

static ScrNiTwinClass nia_signal = {
    .tag = SCR_DYNH_ABORT_SIGNAL,
    .name = "AbortSignal",
    .attach = nia_attach,
    .detach = nia_detach,
    .adopt = nia_adopt,
    .hear = nia_hear,
};

static ScrNiTwinClass nia_controller = {
    .tag = SCR_DYNH_ABORT_CONTROLLER,
    .name = "AbortController",
    .shares_object = true,
};

__attribute__((constructor)) static void nia_install(void) {
  scr_ni_twin_register(&nia_signal);
  scr_ni_twin_register(&nia_controller);
}

#endif /* !_WIN32 && !__wasi__ */
