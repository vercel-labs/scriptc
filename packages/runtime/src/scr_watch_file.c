/* fs.watchFile / fs.unwatchFile — the stat-polling half of the OPTIONAL
 * file-watching surface: one libuv-shaped poller (uv_fs_poll) per RESOLVED
 * path, shared by every listener registered on it, re-arming a one-shot
 * timer every `interval` ms. This translation unit links ONLY into binaries
 * whose IR uses fs.watchFile/fs.unwatchFile (the scr_watch.c gating
 * precedent), and the emitted main calls scr_watch_file_install() before
 * %main, which registers the exit cleanup. Polling-free programs pay zero
 * bytes and keep their exact link line.
 *
 * Semantics, matched against Node (libuv's poll_cb + Node's StatWatcher)
 * and pinned by corpus:
 * - The FIRST poll only records the baseline: a successful first stat
 *   emits nothing (libuv's busy_polling == 0), a failing first stat emits
 *   ONE change with both sides all-zero (Node's kZeroStats).
 * - Thereafter a stat failure emits once per distinct errno; a success
 *   after a failure, or a success whose snapshot differs (ctime, mtime,
 *   birthtime, size, mode, uid, gid, ino, dev), emits (current,
 *   previous), where previous is the last SUCCESSFUL snapshot.
 * - Node's onchange suppression: with no status reported yet, a status of
 *   -1 whose nlink matches the previous snapshot reports nothing.
 * - watchFile on a path that already has a poller ADDS the listener and
 *   ignores its options; the first call's interval and persistent stand.
 * - unwatchFile(path, listener) removes the LAST listener registered with
 *   that closure (pointer identity, Node's rule); unwatchFile(path)
 *   removes every listener. The last removal stops the poller (its timer
 *   clears), which is what lets the process exit.
 * - An emit works on a snapshot of the listeners with retained closures,
 *   so a listener may unwatch itself or others mid-emit — the corpus's
 *   own shape.
 * - persistent: false unrefs the poll timer: the poller still fires while
 *   the loop runs for something else, but never holds the process open. */
#include "scr_runtime.h"

#include <errno.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static void scr_watch_file_oom(void) {
  fputs("scriptc: out of memory\n", stderr);
  abort();
}

/* One registered listener: the closure (owned) and its (current,
 * previous) adapter. */
typedef struct {
  ScrClosure *cb; /* owned */
  ScrWatchFileFn fn;
} ScrWatchFileL;

struct ScrWatchFiler {
  size_t rc;
  ScrStr *path;     /* the resolved path (+1): the registry key and the stat target */
  double interval;  /* the first call's interval, reused for every poll */
  bool persistent;
  int state;        /* libuv's busy_polling: 0 before the first poll, 1 after
                     * a success, -errno after a failure */
  int node_status;  /* Node's kOldStatus: -1 until a change is reported */
  ScrStats *last;   /* the last successful snapshot (+1), NULL = none yet */
  ScrWatchFileL *ls;
  size_t n, cap;
  double timer;     /* the armed poll timer's handle; 0 when none is armed */
  ScrClosure *pollCb; /* the re-armed poll closure (+1); NULL once stopped */
  struct ScrWatchFiler *next; /* the poller registry (+1 each) */
};

typedef struct ScrWatchFiler ScrWatchFiler;

static SCR_TL ScrWatchFiler *scr_watch_filers = NULL; /* the registry (+1 each) */

static ScrWatchFiler *scr_watch_file_retain(ScrWatchFiler *p) {
  if (p->rc != SIZE_MAX) p->rc++;
  return p;
}

static void *scr_watch_file_retain_v(void *p) { return scr_watch_file_retain((ScrWatchFiler *)p); }

static void scr_watch_file_release(ScrWatchFiler *p) {
  if (!p || p->rc == SIZE_MAX) return;
  if (--p->rc == 0) {
    for (size_t i = 0; i < p->n; i++) scr_closure_release(p->ls[i].cb);
    free(p->ls);
    if (p->timer != 0) {
      scr_clear_interval(p->timer);
      p->timer = 0;
    }
    scr_closure_release(p->pollCb);
    scr_stats_release(p->last);
    scr_str_release(p->path);
    free(p);
  }
}

static void scr_watch_file_release_v(void *p) { scr_watch_file_release((ScrWatchFiler *)p); }

/* path.resolve over the one argument: the poller's key AND the stat target,
 * so `./x` and `/abs/x` share one poller, exactly like Node's
 * resolve-and-match. */
static ScrStr *scr_watch_file_resolve(ScrStr *path) {
  ScrArr *parts = scr_arr_new(SCR_ELEM_STR, 1);
  scr_arr_push_ref(parts, scr_str_retain(path));
  ScrStr *resolved = scr_path_resolve(parts);
  scr_arr_release(parts);
  return resolved;
}

static ScrWatchFiler *scr_watch_file_find(ScrStr *resolved) {
  for (ScrWatchFiler *p = scr_watch_filers; p != NULL; p = p->next) {
    if (scr_str_eq(p->path, resolved)) return p;
  }
  return NULL;
}

/* Arms the next poll: the first one at 0 (libuv stats on a later loop
 * turn, never synchronously), then one per interval. */
static void scr_watch_file_arm(ScrWatchFiler *p, double ms) {
  p->timer = scr_set_timeout_handle(scr_closure_retain(p->pollCb), ms);
  if (!p->persistent) scr_timer_unref(p->timer);
}

/* libuv's poll comparison: ctime, mtime and birthtime (the *_ms doubles
 * carry the nanosecond fraction, so a sub-millisecond change still
 * differs), size, mode, uid, gid, ino and dev. `uv_stat_t`'s flags and gen
 * have no ScrStats field, so they are not compared (libuv does). A NULL
 * side (no successful snapshot yet) never compares equal. */
static bool scr_stats_same(ScrStats *a, ScrStats *b) {
  if (a == NULL || b == NULL) return false;
  return scr_stats_ctime_ms(a) == scr_stats_ctime_ms(b) &&
         scr_stats_mtime_ms(a) == scr_stats_mtime_ms(b) &&
         scr_stats_birthtime_ms(a) == scr_stats_birthtime_ms(b) &&
         scr_stats_size(a) == scr_stats_size(b) && scr_stats_mode(a) == scr_stats_mode(b) &&
         scr_stats_uid(a) == scr_stats_uid(b) && scr_stats_gid(a) == scr_stats_gid(b) &&
         scr_stats_ino(a) == scr_stats_ino(b) && scr_stats_dev(a) == scr_stats_dev(b);
}

/* Emits one change: `cur` is the fresh snapshot (NULL = all-zero),
 * `prev` the last successful one (NULL = all-zero), `new_status` Node's
 * status for this poll (0 success, -errno failure). Listeners run in
 * registration order off a snapshot, each with its own +1 Stats refs. */
static void scr_watch_file_emit(ScrWatchFiler *p, ScrStats *cur, ScrStats *prev, int new_status) {
  double ncur = cur != NULL ? scr_stats_nlink(cur) : 0;
  double nprev = prev != NULL ? scr_stats_nlink(prev) : 0;
  if (p->node_status == -1 && new_status == -1 && ncur == nprev) return;
  p->node_status = new_status;
  if (p->n == 0) return;
  ScrStats *c = cur != NULL ? scr_stats_retain(cur) : scr_stats_zero();
  ScrStats *v = prev != NULL ? scr_stats_retain(prev) : scr_stats_zero();
  ScrWatchFileL *snap = malloc(p->n * sizeof *snap);
  if (!snap) {
    scr_stats_release(c);
    scr_stats_release(v);
    scr_watch_file_oom();
  }
  memcpy(snap, p->ls, p->n * sizeof *snap);
  size_t n = p->n;
  for (size_t i = 0; i < n; i++) scr_closure_retain(snap[i].cb);
  for (size_t i = 0; i < n; i++) {
    if (!scr_exc_pending()) snap[i].fn(snap[i].cb, scr_stats_retain(c), scr_stats_retain(v));
    scr_closure_release(snap[i].cb);
  }
  free(snap);
  scr_stats_release(c);
  scr_stats_release(v);
}

/* The timer's body: stat, decide (libuv's poll_cb then Node's onchange),
 * and re-arm unless a listener stopped the poller. */
static void scr_watch_file_poll(ScrClosure *cb) {
  ScrWatchFiler *p = scr_box_get_ref(cb->caps[0]);
  if (p == NULL) return;
  p->timer = 0; /* the loop consumed this arm */
  int err = 0;
  ScrStats *cur = scr_stats_poll_path(p->path, &err);
  if (cur == NULL) {
    if (p->state != -err) {
      scr_watch_file_emit(p, NULL, p->last, -err);
      p->state = -err;
    }
  } else {
    if (p->state != 0 && (p->state < 0 || !scr_stats_same(p->last, cur)))
      scr_watch_file_emit(p, cur, p->last, 0);
    scr_stats_release(p->last);
    p->last = scr_stats_retain(cur);
    p->state = 1;
  }
  scr_stats_release(cur); /* NULL-tolerant */
  /* A listener may have unwatched the last listener (unwatchFile stops
   * the poller): only a poller with listeners re-arms. */
  if (p->n > 0 && p->pollCb != NULL && !scr_exc_pending()) scr_watch_file_arm(p, p->interval);
  scr_watch_file_release(p);
}

static void scr_watch_file_add(ScrWatchFiler *p, ScrClosure *cb /*moves*/, ScrWatchFileFn fn) {
  if (p->n == p->cap) {
    size_t cap = p->cap != 0 ? p->cap * 2 : 4;
    ScrWatchFileL *grown = realloc(p->ls, cap * sizeof *grown);
    if (!grown) {
      scr_closure_release(cb);
      scr_watch_file_oom();
    }
    p->ls = grown;
    p->cap = cap;
  }
  p->ls[p->n].cb = cb;
  p->ls[p->n].fn = fn;
  p->n++;
}

/* Stops a poller: clears its timer, unlinks it from the registry, and
 * breaks the poll-closure cycle (closure → box → poller) so the last
 * external reference frees the poller. Safe from inside a listener: the
 * poll frame's own reference keeps `p` alive. */
static void scr_watch_file_stop(ScrWatchFiler *p) {
  scr_watch_file_retain(p); /* the frame's reference */
  if (p->timer != 0) {
    scr_clear_interval(p->timer);
    p->timer = 0;
  }
  for (ScrWatchFiler **pp = &scr_watch_filers; *pp != NULL; pp = &(*pp)->next) {
    if (*pp == p) {
      *pp = p->next;
      p->next = NULL;
      scr_watch_file_release(p); /* the registry's reference */
      break;
    }
  }
  ScrClosure *pollCb = p->pollCb;
  p->pollCb = NULL;
  scr_closure_release(pollCb); /* drops the box's reference */
  scr_watch_file_release(p);
}

/* StatWatcher's validateUint32(interval, 'interval'): false after throwing
 * Node's ERR_OUT_OF_RANGE RangeError. */
static bool scr_watch_file_interval_ok(double interval) {
  bool integer = isfinite(interval) && trunc(interval) == interval;
  if (integer && interval >= 0 && interval <= 4294967295.0) return true;
  char recv[48], msg[160];
  scr_num_received(interval, recv);
  int len = snprintf(msg, sizeof msg,
                     "The value of \"interval\" is out of range. It must be %s. Received %s",
                     integer ? ">= 0 && <= 4294967295" : "an integer", recv);
  scr_throw_error_msg_code(SCR_ERR_RANGE, msg, (size_t)len, "ERR_OUT_OF_RANGE");
  return false;
}

/* fs.watchFile(path, interval, persistent, listener) — the listener MOVES
 * in. A path holding a null byte throws Node's ERR_INVALID_ARG_VALUE. A
 * second call on the same resolved path adds the listener to the existing
 * poller and ignores its options (Node's rule); a new poller first checks
 * `interval` as a uint32, and registers nothing when that throws. */
void scr_fs_watch_file(ScrStr *path, double interval, bool persistent, ScrClosure *cb,
                       ScrWatchFileFn fn) {
  if (!scr_fs_path_ok(path, "path")) {
    scr_closure_release(cb);
    return; /* exception pending */
  }
  ScrStr *resolved = scr_watch_file_resolve(path);
  ScrWatchFiler *existing = scr_watch_file_find(resolved);
  if (existing != NULL) {
    scr_str_release(resolved);
    scr_watch_file_add(existing, cb, fn);
    return;
  }
  if (!scr_watch_file_interval_ok(interval)) {
    scr_str_release(resolved);
    scr_closure_release(cb);
    return; /* exception pending */
  }
  ScrWatchFiler *p = malloc(sizeof *p);
  if (!p) {
    scr_str_release(resolved);
    scr_closure_release(cb);
    scr_watch_file_oom();
  }
  p->rc = 1;
  p->path = resolved;
  p->interval = interval;
  p->persistent = persistent;
  p->state = 0;
  p->node_status = -1;
  p->last = NULL;
  p->ls = NULL;
  p->n = p->cap = 0;
  p->timer = 0;
  /* The poll closure captures the poller through a box, which retains it
   * from here on (the cycle scr_watch_file_stop breaks). */
  p->pollCb = scr_closure_new((void *)scr_watch_file_poll, 1);
  p->pollCb->caps[0] =
      scr_box_new_obj(scr_watch_file_retain_v, scr_watch_file_release_v, NULL);
  scr_box_set_ref(p->pollCb->caps[0], p);
  scr_watch_file_add(p, cb, fn);
  p->next = scr_watch_filers;
  scr_watch_filers = p;
  scr_watch_file_retain(p); /* the registry's reference */
  scr_watch_file_arm(p, 0);
  /* The creating reference moved into the box (scr_box_set_ref moves, it
   * does not retain): the box and the registry are the two owners. */
}

/* fs.unwatchFile(path[, listener]) — `cb` is borrowed (pointer identity);
 * NULL removes every listener on the resolved path. Removing the last one
 * stops the poller. A path holding a null byte throws Node's
 * ERR_INVALID_ARG_VALUE. */
void scr_fs_unwatch_file(ScrStr *path, ScrClosure *cb) {
  if (!scr_fs_path_ok(path, "path")) return; /* exception pending */
  ScrStr *resolved = scr_watch_file_resolve(path);
  ScrWatchFiler *p = scr_watch_file_find(resolved);
  scr_str_release(resolved);
  if (p == NULL) return;
  if (cb != NULL) {
    /* The LAST listener registered with this closure goes (Node's rule). */
    for (size_t i = p->n; i-- > 0;) {
      if (p->ls[i].cb == cb) {
        scr_closure_release(p->ls[i].cb);
        memmove(&p->ls[i], &p->ls[i + 1], (p->n - i - 1) * sizeof *p->ls);
        p->n--;
        break;
      }
    }
  } else {
    for (size_t i = 0; i < p->n; i++) scr_closure_release(p->ls[i].cb);
    p->n = 0;
  }
  if (p->n == 0) scr_watch_file_stop(p);
}

/* ── the runtime-provided listener adapters ───────────────────────────
 * The adapter receives +1 references and the listener owns those it takes
 * (the universal convention scr_watch_thunk_event follows); the adapter
 * releases the ones its listener has no parameter for. */
void scr_watch_file_thunk0(ScrClosure *cb, ScrStats *current, ScrStats *previous) {
  scr_stats_release(current);
  scr_stats_release(previous);
  ((void (*)(ScrClosure *))cb->fn)(cb);
}

void scr_watch_file_thunk1(ScrClosure *cb, ScrStats *current, ScrStats *previous) {
  scr_stats_release(previous);
  ((void (*)(ScrClosure *, ScrStats *))cb->fn)(cb, current);
}

void scr_watch_file_thunk2(ScrClosure *cb, ScrStats *current, ScrStats *previous) {
  ((void (*)(ScrClosure *, ScrStats *, ScrStats *))cb->fn)(cb, current, previous);
}

/* Exit-time registry cleanup (the scr_watch.c precedent): pollers a program
 * legitimately leaves running at exit release their listeners and timers,
 * so the RC audit sees a clean heap. */
static void scr_watch_file_cleanup_atexit(void) {
  while (scr_watch_filers != NULL) scr_watch_file_stop(scr_watch_filers);
}

void scr_watch_file_install(void) {
  static SCR_TL bool installed = false;
  if (installed) return;
  installed = true;
  scr_atexit(scr_watch_file_cleanup_atexit);
}
