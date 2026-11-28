/* scriptc runtime — node:worker_threads' Web Locks manager (scr_worker_locks.c). */
#ifndef SCR_WORKER_LOCKS_H
#define SCR_WORKER_LOCKS_H

#include "scr_async.h"
#include "scr_dyn.h"
#include "scr_string.h"

/* locks.request(name, options, callback): the request's promise (+1). The
 * name arrives already converted (the lowering's DOMString), `options` is
 * the checked-dynamic options object or NULL, and the callback is a
 * checked-dynamic function the manager calls while the lock is held. */
ScrPromise *scr_worker_locks_request(ScrStr *name, const ScrDyn *options, const ScrDyn *callback);
/* locks.query(): the calling thread's held and pending locks, a promise of
 * the { held, pending } snapshot (+1). */
ScrPromise *scr_worker_locks_query(void);

#endif
