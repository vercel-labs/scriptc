/* scriptc runtime — the native AbortSignal's state (scr_fetch.c, and its
 * signal-only build scr_abort.c). Internal: for the signal's own unit and
 * for scr_node_island_abort.c, which pairs a signal with its twin in a Node
 * island through the watcher list. */
#ifndef SCR_ABORT_SIGNAL_H
#define SCR_ABORT_SIGNAL_H

#include "scr_runtime.h"

typedef struct SfSignal SfSignal;
typedef struct SfSignalWatch SfSignalWatch;

/* An abort algorithm: runs once, when its source aborts, after the source's
 * state changed and before the source's 'abort' listeners. It is not a
 * listener: getEventListeners and listenerCount never see it. The source
 * unlinks a watch before it fires it; a watch that never fired is unlinked
 * by its owner before the owner lets go of the source. */
struct SfSignalWatch {
  SfSignal *source; /* weak; NULL after the source fires */
  void *owner;      /* owner keeps source alive */
  void (*fire)(SfSignalWatch *, SfSignal *);
  SfSignalWatch *next;
};

struct SfSignal {
  size_t rc;
  bool aborted;
  ScrDyn *reason;
  ScrError *error_reason;
  bool reason_self;
  ScrDynHandleTag reason_self_tag;
  bool reason_tracked;
  SfSignal *reason_next;
  ScrEventTargetCore core; /* listeners and the onabort attribute */
  SfSignalWatch *watchers;
  SfSignal **sources;
  SfSignalWatch **source_watches;
  size_t source_count;
  double timer_id;
};

#endif /* SCR_ABORT_SIGNAL_H */
