/* The abort listener callback used by HTTP and stream adapters when the
 * event-target unit is present. Included by its optional callers only. */
#ifndef SCR_OPTIONAL_ABORT_LISTENER_H
#define SCR_OPTIONAL_ABORT_LISTENER_H

#include "scr_runtime.h"

#if defined(__APPLE__)
ScrAbortAddFn scr_optional_abort_listener(void);
#else
extern ScrDyn *scr_events_add_abort_listener(ScrDyn *, ScrDyn *) __attribute__((weak));
static inline ScrAbortAddFn scr_optional_abort_listener(void) {
  return scr_events_add_abort_listener;
}
#endif

#endif
