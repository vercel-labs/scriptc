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
 * directory watch has no lowering yet and THROWS [SC2020]. +1. */
ScrWatcher *scr_fs_watch(ScrStr *path, ScrClosure *cb, ScrWatchFn fn, bool wants_name);
void scr_watcher_close(ScrWatcher *w); /* idempotent */
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
void scr_fs_watch_file(ScrStr *path, double interval, bool persistent, ScrClosure *cb,
                       ScrWatchFileFn fn);
/* fs.unwatchFile(path[, listener]) — cb borrowed, NULL removes every
 * listener; with none left the poller stops. */
void scr_fs_unwatch_file(ScrStr *path, ScrClosure *cb);
void scr_watch_file_thunk0(ScrClosure *cb, ScrStats *current, ScrStats *previous);
void scr_watch_file_thunk1(ScrClosure *cb, ScrStats *current, ScrStats *previous);
void scr_watch_file_thunk2(ScrClosure *cb, ScrStats *current, ScrStats *previous);
void scr_watch_file_install(void);

/* The loop-side registration (scr_async.c, always linked) — the net
 * hook's exact shape, one more nullable slot set. */
void scr_loop_set_watch(bool (*pending)(void), void (*dispatch)(void), int (*pollfd)(void));

#endif /* SCR_WATCH_H */
