/* fsPromises.watch — the async-iterable form of fs.watch. Node's
 * fs/promises watch (lib/internal/fs/watchers.js `watch`) owns an FSEvent
 * handle, queues { eventType, filename } entries in `onchange` and yields
 * them from an async generator: each `next()` waits for an entry, the
 * handle is closed in the generator's `finally`, and nothing else keeps the
 * loop alive once it closes. This unit is that queue over scr_watch.c's
 * watcher, shaped for the `for await` lowering instead of a generator:
 *
 * - fsPromises.watch(path, options) creates the watcher NOW (a bad path or
 *   an unopenable one throws the fs error at the loop, as Node's first
 *   next() does) and links this unit only when the program uses it.
 * - The loop awaits scr_watch_events_wait (a void promise settled when the
 *   queue is non-empty or the watcher closed) and then pops one entry with
 *   scr_watch_events_take, which the emitter turns into the iteration
 *   record; `false` with an empty queue ends the loop.
 * - Entry names arrive borrowed from the watcher adapter; the queue owns
 *   its own strings (+1 each) until take hands them out.
 * - close() is the generator's `finally`: it closes the watcher (off the
 *   loop's liveness), drops the queue and settles a waiting loop so it can
 *   see the end.
 * - The 2048-entry maxQueue default is not modelled: the queue grows while
 *   a body is slow, which only differs from Node's warning path for a
 *   program that never drains it. */
#include "scr_runtime.h"

#include <errno.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static void scr_watch_events_oom(void) {
  fputs("scriptc: out of memory\n", stderr);
  abort();
}

struct ScrWatchEvents {
  size_t rc;
  ScrWatcher *watcher;  /* +1: the scr_watch.c handle (NULL once closed) */
  ScrStr *fallback;     /* +1: the basename an unnamed event reports */
  ScrStr **events;      /* queue: the event name of each entry (+1 each) */
  ScrStr **names;       /* queue: the entry name of each entry (+1 each) */
  size_t head, n, cap;
  /* Node's bound on the pending entries (options.maxQueue, 2048 by
   * default): past it a new event either raises the iteration's error
   * (overflow: "error") or is dropped with a process warning
   * (overflow: "ignore"). */
  long max_queue;
  bool overflow_error;
  bool failed;          /* the queue was cleared into the overflow error */
  ScrPromise *waiter;   /* +1: the pending wait() promise, if one waits */
  ScrClosure *resolver; /* +1: its void resolver */
  bool closed;
  struct ScrWatchEvents *next; /* the open-state registry (+1 each) */
};

typedef struct ScrWatchEvents ScrWatchEvents;

static SCR_TL ScrWatchEvents *scr_watch_events_all = NULL;

ScrWatchEvents *scr_watch_events_retain(ScrWatchEvents *st) {
  if (st->rc != SIZE_MAX) st->rc++;
  return st;
}

void *scr_watch_events_retain_v(void *p) { return scr_watch_events_retain((ScrWatchEvents *)p); }

static void scr_watch_events_drop_queue(ScrWatchEvents *st) {
  for (size_t i = 0; i < st->n; i++) {
    scr_str_release(st->events[st->head + i]);
    scr_str_release(st->names[st->head + i]);
  }
  free(st->events);
  free(st->names);
  st->events = NULL;
  st->names = NULL;
  st->head = st->n = st->cap = 0;
}

void scr_watch_events_release(ScrWatchEvents *st) {
  if (!st || st->rc == SIZE_MAX) return;
  if (--st->rc == 0) {
    scr_watch_events_drop_queue(st);
    if (st->resolver != NULL) {
      scr_closure_release(st->resolver);
      scr_promise_release(st->waiter);
    }
    scr_watcher_release(st->watcher); /* NULL-tolerant */
    scr_str_release(st->fallback);
    free(st);
  }
}

void scr_watch_events_release_v(void *p) { scr_watch_events_release((ScrWatchEvents *)p); }

/* Settles the pending wait()` with whether an entry is queued (true) or
 * the state closed (false): the loop's await resumes and takes the entry,
 * or ends. */
static void scr_watch_events_settle(ScrWatchEvents *st, bool ready) {
  if (st->resolver == NULL) return;
  ScrClosure *resolver = st->resolver;
  st->resolver = NULL;
  scr_promise_release(st->waiter);
  st->waiter = NULL;
  ((void (*)(ScrClosure *, bool))resolver->fn)(resolver, ready);
  scr_closure_release(resolver);
}

static bool scr_watch_events_push(ScrWatchEvents *st, const char *event, const char *filename) {
  /* The bound comes before the growth: a consumer that falls behind cannot
   * make the queue grow without limit, whatever the writer does. False when
   * the entry was dropped, so the caller does not wake a waiting loop for
   * an entry it will not find. */
  if ((long)st->n >= st->max_queue) {
    if (st->overflow_error) {
      scr_watch_events_drop_queue(st);
      st->failed = true;
      scr_watch_events_settle(st, true);
    } else {
      /* Node's process warning for a dropped event; the report borrows the
       * message, so this unit releases it. */
      static const char text[] = "fs.watch maxQueue exceeded";
      ScrStr *message = scr_str_new(text, sizeof text - 1);
      scr_emit_warning("Warning", NULL, message);
      scr_str_release(message);
    }
    return false;
  }
  if (st->head + st->n == st->cap) {
    size_t cap = st->cap != 0 ? st->cap * 2 : 8;
    if (st->head != 0) {
      memmove(st->events, &st->events[st->head], st->n * sizeof *st->events);
      memmove(st->names, &st->names[st->head], st->n * sizeof *st->names);
      st->head = 0;
    } else {
      ScrStr **grownEvents = realloc(st->events, cap * sizeof *grownEvents);
      if (!grownEvents) scr_watch_events_oom();
      st->events = grownEvents;
      ScrStr **grownNames = realloc(st->names, cap * sizeof *grownNames);
      if (!grownNames) scr_watch_events_oom();
      st->names = grownNames;
      st->cap = cap;
    }
  }
  st->events[st->head + st->n] = scr_str_new(event, strlen(event));
  /* libuv leaves the name empty for a watch that cannot name the entry;
   * Node reports null, the iteration record reports the watch's basename. */
  const char *name = (filename != NULL && filename[0] != '\0') ? filename : NULL;
  st->names[st->head + st->n] =
      name != NULL ? scr_str_new(name, strlen(name)) : scr_str_retain(st->fallback);
  st->n++;
  return true;
}

/* The watcher's change listener (scr_watch.c's ScrWatchFn adapter): queues
 * the entry and wakes the loop. */
static void scr_watch_events_event(ScrClosure *cb, const char *event, const char *filename) {
  ScrWatchEvents *st = scr_box_get_ref(cb->caps[0]); /* +1 */
  if (st == NULL) return;
  if (!st->closed && scr_watch_events_push(st, event, filename)) {
    scr_watch_events_settle(st, true);
  }
  scr_watch_events_release(st);
}

static ScrStr *scr_watch_events_basename(ScrStr *path) {
  size_t n = path->len;
  const char *data = path->data;
  size_t start = 0;
  for (size_t i = n; i-- > 0;) {
    if (data[i] == '/') {
      start = i + 1;
      break;
    }
  }
  return scr_str_new(data + start, n - start);
}

/* fsPromises.watch(path, options): the iterator state, +1. The watcher is
 * created here, so a path that rejects the null-byte check or cannot be
 * opened throws and answers NULL. */
ScrWatchEvents *scr_watch_events_new(ScrStr *path, bool persistent, double max_queue,
                                     bool overflow_error) {
  /* options.maxQueue: Node's validateInteger, before the path is opened. */
  if (!isfinite(max_queue) || trunc(max_queue) != max_queue) {
    char recv[48], msg[160];
    scr_num_received(max_queue, recv);
    int len = snprintf(msg, sizeof msg,
                       "The value of \"options.maxQueue\" is out of range. It must be an integer. "
                       "Received %s",
                       recv);
    scr_throw_error_msg_code(SCR_ERR_RANGE, msg, (size_t)len, "ERR_OUT_OF_RANGE");
    return NULL;
  }
  ScrWatchEvents *st = calloc(1, sizeof *st);
  if (!st) scr_watch_events_oom();
  st->rc = 1;
  st->max_queue = (long)max_queue;
  st->overflow_error = overflow_error;
  st->fallback = scr_watch_events_basename(path);
  ScrClosure *cb = scr_closure_new((void *)scr_watch_events_event, 1);
  cb->caps[0] = scr_box_new_obj(scr_watch_events_retain_v, scr_watch_events_release_v, NULL);
  scr_box_set_ref(cb->caps[0], scr_watch_events_retain(st));
  ScrWatcher *watcher = scr_fs_watch(path, cb, scr_watch_events_event, true, persistent);
  if (watcher == NULL) {
    /* Exception pending: the closure (and its box reference) is gone. */
    scr_watch_events_release(st);
    return NULL;
  }
  st->watcher = watcher;
  st->next = scr_watch_events_all;
  scr_watch_events_all = scr_watch_events_retain(st); /* the registry's reference */
  return st;
}

/* The loop's per-iteration wait, +1: a bool promise answering whether an
 * entry is available (true) or the state closed (false), settled at once
 * when either already holds. */
ScrPromise *scr_watch_events_wait(ScrWatchEvents *st) {
  ScrPromise *p = scr_promise_new();
  ScrClosure *resolver = scr_make_resolve(p, 1 /* bool */);
  /* Ready means there is an entry to take or an overflow error the loop
   * must see: the burst that filled the queue may have arrived while the
   * body was awaiting other work, with no waiter to wake then. */
  if (st->n > 0 || st->closed || st->failed) {
    ((void (*)(ScrClosure *, bool))resolver->fn)(resolver, st->n > 0 || st->failed);
    scr_closure_release(resolver);
    return p;
  }
  st->waiter = scr_promise_retain(p);
  st->resolver = resolver;
  return p;
}

/* Pops the oldest entry as Node's iteration record — a +1
 * `{ eventType, filename }` object — or NULL when the queue is empty,
 * which ends the loop. The emitter narrows the NULL into the record or
 * null union the loop's binding names. */
ScrDyn *scr_watch_events_take(ScrWatchEvents *st) {
  if (st->failed) {
    /* Node's ERR_FS_WATCH_QUEUE_OVERFLOW: the iteration throws it where the
     * generator would have yielded, and the loop's finally closes the
     * watch. */
    st->failed = false;
    char msg[96];
    int len = snprintf(msg, sizeof msg, "fs.watch() queued more than %ld events", st->max_queue);
    scr_throw_error_msg_code(SCR_ERR_ERROR, msg, (size_t)len, "ERR_FS_WATCH_QUEUE_OVERFLOW");
    return NULL;
  }
  if (st->n == 0) return NULL;
  ScrStr *event = st->events[st->head];
  ScrStr *name = st->names[st->head];
  st->events[st->head] = NULL;
  st->names[st->head] = NULL;
  st->head++;
  if (--st->n == 0) st->head = 0;
  ScrDyn *record = scr_dyn_new_obj();
  /* scr_dyn_new_str keeps the caller's reference: the dyn owns its own and
   * the queue's two go back. */
  scr_dyn_obj_set(record, "eventType", 9, scr_dyn_new_str(event));
  scr_dyn_obj_set(record, "filename", 8, scr_dyn_new_str(name));
  scr_str_release(event);
  scr_str_release(name);
  return record;
}

/* The generator's `finally`: idempotent. Closes the watcher (off the
 * loop), drops the queued entries and wakes a waiting loop so it reaches
 * the empty queue and ends. */
void scr_watch_events_close(ScrWatchEvents *st) {
  if (st->closed) return;
  st->closed = true;
  scr_watch_events_drop_queue(st);
  if (st->watcher != NULL) {
    ScrWatcher *watcher = st->watcher;
    st->watcher = NULL;
    scr_watcher_close(watcher);
    scr_watcher_release(watcher);
  }
  scr_watch_events_settle(st, false);
  for (ScrWatchEvents **pp = &scr_watch_events_all; *pp != NULL; pp = &(*pp)->next) {
    if (*pp == st) {
      *pp = st->next;
      st->next = NULL;
      scr_watch_events_release(st); /* the registry's reference */
      break;
    }
  }
}

/* Exit-time cleanup: a loop a program leaves open (a throw that escapes the
 * for-await, an iterator kept past exit) closes here like the
 * fs.watchFile unit's cleanup. */
static void scr_watch_events_cleanup_atexit(void) {
  while (scr_watch_events_all != NULL) scr_watch_events_close(scr_watch_events_all);
}

/* The emitted main's install line — scr_watch_async.c links only when it is
 * emitted, the scr_watch.c gating precedent. scr_atexit is the runtime's
 * per-thread hook (scr_watch.c's own install shape): a worker drains its
 * cleanup stack before its TLS dies, where libc's atexit would run the
 * callback on the process-exit thread, long after the worker's registry
 * went away. */
void scr_watch_events_install(void) {
  static SCR_TL bool installed = false;
  if (installed) return;
  installed = true;
  scr_atexit(scr_watch_events_cleanup_atexit);
}
