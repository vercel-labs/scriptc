/* scriptc runtime — fs.watch (scr_watch.c) and fs.watchFile
 * (scr_watch_file.c). Included by scr_runtime.h, which says where new
 * declarations go. */
#ifndef SCR_WATCH_H
#define SCR_WATCH_H

#include "scr_bytes.h"
#include "scr_error.h"
#include "scr_lib.h"

/* ── fs.watch (scr_watch.c — compiled only when the program uses it;
 * design note atop the file). FSWatcher handles over the unit's own
 * event backend (kqueue EVFILT_VNODE on macOS/BSD, inotify on Linux):
 * refcounted, listeners MOVE in (released at
 * close/exit — the child ownership story), an open watcher keeps the
 * loop alive until close() (Node's persistent default). */
typedef struct ScrWatcher ScrWatcher;
/* The event adapter: the event name ("rename"/"change") and the entry
 * name (NULL when the platform names nothing) arrive BORROWED (static
 * storage); adapters build what their listener declared. */
typedef void (*ScrWatchFn)(ScrClosure *cb, const char *event, const char *filename);
/* The 'error' adapter: the ScrError arrives borrowed. */
typedef void (*ScrWatchErrFn)(ScrClosure *cb, ScrError *err);

ScrWatcher *scr_watcher_retain(ScrWatcher *w);
void scr_watcher_release(ScrWatcher *w);
void *scr_watcher_retain_v(void *p);
void scr_watcher_release_v(void *p);

/* fs.watch(path, listener?) — path borrowed, the callback (nullable)
 * MOVES. Opens the path NOW and THROWS Node's fs error when it cannot
 * ("ENOENT: ..., watch 'x'" — the polling-fallback catch shape). A
 * CHANGE listener that reads the filename (wants_name) on a macOS
 * directory watch has no lowering yet and THROWS [SC2020]. `persistent`
 * (Node's default true) is the watcher's initial loop liveness: a false
 * one does not keep the process alive, and ref()/unref() move it. +1. */
ScrWatcher *scr_fs_watch(ScrStr *path, ScrClosure *cb, ScrWatchFn fn, bool wants_name,
                         bool persistent);
void scr_watcher_close(ScrWatcher *w); /* idempotent */
/* watcher.ref()/watcher.unref(): loop-liveness toggles on an open watcher
 * (no-ops on a closed one, as Node's handle-less methods are). */
void scr_watcher_ref(ScrWatcher *w);
void scr_watcher_unref(ScrWatcher *w);
/* watcher.on/once/addListener/prependListener(event, listener): cb MOVES
 * in. On a closed watcher the listener is released at once (it can never
 * run). Directory watches on macOS cannot name entries (slice F3), so a
 * CHANGE listener that reads the filename (wants_name) THROWS there. */
void scr_watcher_on(ScrWatcher *w, double event, ScrClosure *cb, void *fn, bool once, bool prepend,
                    bool wants_name);
/* watcher.off/removeListener(event, listener): removes the most recently
 * added listener of that event whose closure is `cb` (pointer identity,
 * EventEmitter's rule); cb is borrowed. */
void scr_watcher_off(ScrWatcher *w, double event, ScrClosure *cb);
/* The runtime-provided listener adapters: the zero- and one-parameter
 * fs.watch shapes, and the zero-parameter 'error' listener. */
void scr_watch_thunk0(ScrClosure *cb, const char *event, const char *filename);
void scr_watch_thunk_event(ScrClosure *cb, const char *event, const char *filename);
void scr_watch_err_thunk0(ScrClosure *cb, ScrError *err);
void scr_watch_install(void);

/* ── fs.watchFile (scr_watch_file.c — same gating precedent: linked only
 * when the program uses it). Stat polling in Node's shape: one poller per
 * RESOLVED path, shared by every listener on it. */
typedef void (*ScrWatchFileFn)(ScrClosure *cb, ScrStats *current, ScrStats *previous);
/* fs.watchFile(path, { interval, persistent }, listener) — cb MOVES in;
 * the adapter calls the listener with (current, previous) Stats (+1 each).
 * The path is resolved (path.resolve) and keys the poller; a second call
 * on the same resolved path adds the listener and ignores its options. */
/* fs.watchFile returns a StatWatcher (+1): one handle per call over the
 * registration it added. ref()/unref() move that registration's loop
 * liveness; both are no-ops once fs.unwatchFile removed it. Node's
 * StatWatcher has no close() — unwatchFile is the removal API. */
typedef struct ScrStatWatcher ScrStatWatcher;
ScrStatWatcher *scr_fs_watch_file(ScrStr *path, double interval, bool persistent, ScrClosure *cb,
                                  ScrWatchFileFn fn);
ScrStatWatcher *scr_stat_watcher_retain(ScrStatWatcher *w);
void scr_stat_watcher_release(ScrStatWatcher *w);
void *scr_stat_watcher_retain_v(void *p);
void scr_stat_watcher_release_v(void *p);
void scr_stat_watcher_ref(ScrStatWatcher *w);
void scr_stat_watcher_unref(ScrStatWatcher *w);
/* fs.unwatchFile(path[, listener]) — cb borrowed, NULL removes every
 * listener; with none left the poller stops. */
void scr_fs_unwatch_file(ScrStr *path, ScrClosure *cb);
void scr_watch_file_thunk0(ScrClosure *cb, ScrStats *current, ScrStats *previous);
void scr_watch_file_thunk1(ScrClosure *cb, ScrStats *current, ScrStats *previous);
void scr_watch_file_thunk2(ScrClosure *cb, ScrStats *current, ScrStats *previous);
void scr_watch_file_install(void);

/* ── fsPromises.watch (scr_watch_async.c — linked only when the program
 * uses it): Node's async-iterable form, a queue over a scr_watch.c
 * watcher. The `for await` lowering awaits wait() and pops one entry with
 * take(); close() is the loop's finally. */
typedef struct ScrPromise ScrPromise;
typedef struct ScrWatchEvents ScrWatchEvents;
/* fsPromises.watch(path[, options]): opens the watch NOW (+1 state). A
 * path that fails validation or cannot be watched throws and answers NULL.
 * `max_queue` (options.maxQueue, 2048 at the call site) bounds the pending
 * entries; `overflow_error` picks Node's policy past the bound: the
 * iteration's ERR_FS_WATCH_QUEUE_OVERFLOW, or a dropped event and the
 * "fs.watch maxQueue exceeded" warning. */
ScrWatchEvents *scr_watch_events_new(ScrStr *path, bool persistent, double max_queue,
                                     bool overflow_error);
ScrWatchEvents *scr_watch_events_retain(ScrWatchEvents *st);
void scr_watch_events_release(ScrWatchEvents *st);
void *scr_watch_events_retain_v(void *p);
void scr_watch_events_release_v(void *p);
/* A bool promise (+1) settled when an entry is queued (true) or the state
 * closed (false); awaiting it is the loop's wait for the next event. */
ScrPromise *scr_watch_events_wait(ScrWatchEvents *st);
/* Pops the oldest entry as a +1 `{ eventType, filename }` object the
 * caller only asks for after a true wait(). */
ScrDyn *scr_watch_events_take(ScrWatchEvents *st);
void scr_watch_events_close(ScrWatchEvents *st); /* idempotent */
void scr_watch_events_install(void);

/* The loop-side registration (scr_async.c, always linked) — the net
 * hook's exact shape, one more nullable slot set. */
void scr_loop_set_watch(bool (*pending)(void), void (*dispatch)(void), int (*pollfd)(void));
/* The io-without-liveness slot (the net_io precedent): unref'd watchers
 * are still polled, but do not keep the loop alive. */
void scr_loop_set_watch_io(bool (*io)(void));

#endif /* SCR_WATCH_H */
