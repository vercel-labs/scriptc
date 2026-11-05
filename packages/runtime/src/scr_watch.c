/* fs.watch — the OPTIONAL file-watching half of the event loop: FSWatcher
 * handles over the unit's own kqueue (EVFILT_VNODE on an O_EVTONLY fd).
 * This translation unit links ONLY into binaries whose IR uses fs.watch
 * (moduleUsesFsWatch — the scr_events/scr_net gating precedent), and the
 * emitted main calls scr_watch_install() before %main, which points the
 * loop's nullable watch hooks (scr_async.c) here. Watch-free programs pay
 * zero bytes and keep their exact link line.
 *
 * Semantics, matched against Node on macOS and pinned by corpus:
 * - fs.watch(path, cb) THROWS Node's fs error synchronously when the path
 *   cannot be opened ("ENOENT: no such file or directory, watch 'x'" —
 *   the portless polling-fallback catch shape).
 * - The callback fires with "change" (NOTE_WRITE/EXTEND/ATTRIB) or
 *   "rename" (NOTE_RENAME/DELETE/REVOKE — rename wins when a drain
 *   coalesces both, libuv's precedence).
 * - An open watcher KEEPS THE LOOP ALIVE until close() (Node's persistent
 *   default; unref has no lowering — nothing exercises it).
 * - close() is idempotent: the fd closes (dropping its kqueue filter),
 *   listeners release, nothing fires again.
 *
 * Platform honesty: kqueue watches the INODE behind the opened fd, not
 * the name — the same stance as libuv's kqueue backend. A
 * rewrite-in-place (writeFileSync truncate, append) delivers "change"
 * reliably. A replace-by-rename delivers ONE "rename" for the old inode,
 * after which this unit REOPENS the path best-effort: when a new file
 * took the name (the atomic-rewrite idiom), watching continues on the
 * new inode; when the name is gone, the watcher stays registered but
 * stops emitting events (Node's kqueue backend stops the same way — its
 * FSEvents backend on macOS would keep reporting, a documented divergence).
 *
 * The Linux arm is inotify, matched against Linux Node (the differential
 * container's oracle — probed, not assumed): one inotify fd for the
 * unit, one wd per watcher, libuv's exact event mapping — a mask with
 * IN_ATTRIB or IN_MODIFY fires "change", ANY other delivered mask fires
 * "rename", including IN_DELETE_SELF and the trailing IN_IGNORED (Linux
 * Node really does fire two 'rename's for an unlink, and a leading
 * 'change' for the link-count IN_ATTRIB). After IN_IGNORED the wd is
 * dead and the watcher stops emitting events but stays open (holds the loop) until
 * close() — Node does NOT reopen on Linux, so neither does this arm; the
 * kqueue reopen dance is macOS-only, exactly like libuv. The wd → watcher
 * route trusts the kernel's cyclic wd allocation (idr_alloc_cyclic): a
 * close()-queued IN_IGNORED can never collide with a freshly issued wd.
 *
 * The Windows arm is ReadDirectoryChangesW (see the SCR_HAVE_RDCW block
 * below): directory-handle watching by NAME, so replace-by-rename keeps
 * delivering without any reopen dance — Node-on-Windows's own stance.
 *
 * Event COALESCING is delivery-granular everywhere: one drain pass may
 * merge what Node reports as two events — corpus programs observe "fired
 * at least once", never exact counts. */
#define _XOPEN_SOURCE 700
#define _DARWIN_C_SOURCE 1
#include "scr_runtime.h"

#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#if defined(__APPLE__) || defined(__FreeBSD__) || defined(__NetBSD__) || \
    defined(__OpenBSD__) || defined(__DragonFly__)
#define SCR_HAVE_KQUEUE 1
#include <sys/event.h>
#include <sys/param.h>
/* Darwin directory watches deliver through FSEvents in libuv, which names
 * entries; the kqueue arm watches the directory inode and cannot. Until
 * slice F3 lands FSEvents, a listener that reads the filename has no
 * lowering there. */
#if defined(__APPLE__)
#define SCR_WATCH_DIR_NAMES_REFUSED 1
#endif
#elif defined(__linux__)
#define SCR_HAVE_INOTIFY 1
#include <sys/inotify.h>
#elif defined(_WIN32)
/* The Windows arm is ReadDirectoryChangesW, libuv's exact shape: a FILE
 * watch opens its PARENT directory and filters deliveries by basename, a
 * DIRECTORY watch opens the path itself (non-recursive, fs.watch's
 * default); one overlapped read per watcher is outstanding at a time,
 * its manual-reset event polled at dispatch (the loop's win32 idle sleep
 * caps while watchers pend — scr_async.c). Action mapping matches libuv:
 * FILE_ACTION_MODIFIED fires "change", every other action (added/
 * removed/renamed either direction) fires "rename". Directory-handle
 * watching survives replace-by-rename without the kqueue reopen dance —
 * the NAME is watched, not the inode, which is Node-on-Windows's own
 * stance. */
#define SCR_HAVE_RDCW 1
#include <stdalign.h>
#include <windows.h>
#endif

#ifndef O_EVTONLY
#define O_EVTONLY O_RDONLY /* non-macOS: a plain read fd watches fine */
#endif

static void scr_watch_oom(void) {
  fputs("scriptc: out of memory\n", stderr);
  abort();
}

enum { SCR_WATCH_EV_CHANGE = 0, SCR_WATCH_EV_ERROR = 1, SCR_WATCH_EV_CLOSE = 2 };

/* One registered listener: the event it answers, its adapter, and whether
 * it is one-shot (once/prependOnceListener — removed before it runs). */
typedef struct {
  ScrClosure *cb; /* owned */
  void *fn;       /* CHANGE: ScrWatchFn; ERROR: ScrWatchErrFn; CLOSE: NULL (zero-arg call) */
  uint8_t event;
  bool once;
} ScrWatchL;

/* The 'close' emission: the moved-out listeners, called once on the next
 * tick in registration order. The batch owns them, so a watcher released
 * before the tick leaves nothing dangling. */
typedef struct {
  size_t rc;
  ScrWatchL *ls;
  size_t n;
} ScrWatchCloseBatch;

static void *scr_watch_batch_retain(void *p);
static void scr_watch_batch_release(void *p);

struct ScrWatcher {
  size_t rc;
  int fd;       /* -1 once closed, or after a failed reopen (no further events) */
#ifdef SCR_WATCH_DIR_NAMES_REFUSED
  bool is_dir;  /* the opened path is a directory (the F3 gap) */
#endif
#ifdef SCR_HAVE_INOTIFY
  int wd;       /* the inotify watch descriptor; -1 once dead (IN_IGNORED
                 * arrived or close() removed it) */
#endif
#ifdef SCR_HAVE_RDCW
  HANDLE dh;       /* the watched directory handle; INVALID once closed or
                    * after a failed reissue (no further events) */
  OVERLAPPED ovl;  /* the one outstanding ReadDirectoryChangesW; hEvent is
                    * a manual-reset event polled at dispatch */
  wchar_t *filter; /* file watches: the watched basename (UTF-16, ordinal
                    * case-insensitive compare); NULL for directory watches */
  bool inflight;   /* a read is outstanding (ovl/buf are the kernel's) */
  alignas(DWORD) char buf[4096]; /* FILE_NOTIFY_INFORMATION entries */
#endif
  bool closed;  /* close() called: off the liveness count, listeners gone */
  ScrStr *path; /* the watched path — the reopen-after-rename target */
  ScrWatchL *ls;
  size_t n, cap;
  struct ScrWatcher *next; /* the open-watcher registry (+1 each) */
};

static SCR_TL ScrWatcher *scr_watchers = NULL;
static SCR_TL size_t scr_watchers_open = 0; /* liveness: open (unclosed) watchers */

static void scr_watch_close_tick(ScrClosure *cb);

#if defined(SCR_HAVE_INOTIFY) || defined(SCR_HAVE_KQUEUE)
/* libuv's uv__basename_r: the part after the last '/', or the whole path. */
static const char *scr_watch_basename(const char *path) {
  const char *slash = strrchr(path, '/');
  return slash ? slash + 1 : path;
}
#endif

#if defined(SCR_WATCH_DIR_NAMES_REFUSED)
static void scr_watch_refuse_dir_names(void) {
  const char *m =
      "fs.watch of a directory with a listener that reads the filename has no lowering on macOS yet [SC2020]";
  scr_throw_error_msg_code(SCR_ERR_ERROR, m, strlen(m), "SC2020");
}
#endif

#ifdef SCR_HAVE_KQUEUE
static SCR_TL int scr_watch_kq = -1; /* created with the first watch; lives forever */

/* Arms the vnode filter for a watcher's current fd. EV_CLEAR: state resets
 * at delivery, so an unserviced event never busy-spins the idle poll (the
 * dispatch drain is the single consumer). */
static bool scr_watch_arm(ScrWatcher *w) {
  if (scr_watch_kq < 0) {
    scr_watch_kq = kqueue();
    if (scr_watch_kq < 0) return false;
  }
  struct kevent ev;
  EV_SET(&ev, (uintptr_t)w->fd, EVFILT_VNODE, EV_ADD | EV_CLEAR,
         NOTE_WRITE | NOTE_EXTEND | NOTE_ATTRIB | NOTE_RENAME | NOTE_DELETE | NOTE_REVOKE,
         0, w);
  struct timespec zero = {0, 0};
  return kevent(scr_watch_kq, &ev, 1, NULL, 0, &zero) == 0;
}
#endif

#ifdef SCR_HAVE_INOTIFY
static SCR_TL int scr_watch_ino = -1; /* created with the first watch */

/* libuv's subscription mask: name-level events for directory watches,
 * self events for the file case, IN_IGNORED arriving automatically. */
#define SCR_WATCH_IN_MASK                                                        \
  (IN_ATTRIB | IN_CREATE | IN_MODIFY | IN_DELETE | IN_DELETE_SELF |              \
   IN_MOVE_SELF | IN_MOVED_FROM | IN_MOVED_TO)

static ScrWatcher *scr_watch_by_wd(int wd) {
  if (wd < 0) return NULL;
  for (ScrWatcher *w = scr_watchers; w != NULL; w = w->next) {
    if (!w->closed && w->wd == wd) return w;
  }
  return NULL;
}
#endif

#ifdef SCR_HAVE_RDCW
static wchar_t *scr_watch_widen(const char *s) {
  int n = MultiByteToWideChar(CP_UTF8, 0, s, -1, NULL, 0);
  if (n <= 0) return NULL;
  wchar_t *w = malloc((size_t)n * sizeof *w);
  if (!w) scr_watch_oom();
  MultiByteToWideChar(CP_UTF8, 0, s, -1, w, n);
  return w;
}

/* Issues the next overlapped read. False leaves the watcher without events
 * (the kqueue arm's exhaustion stance): open, holding the loop, emitting
 * nothing. */
static bool scr_watch_issue(ScrWatcher *w) {
  ResetEvent(w->ovl.hEvent);
  if (!ReadDirectoryChangesW(w->dh, w->buf, (DWORD)sizeof w->buf, FALSE,
                             FILE_NOTIFY_CHANGE_FILE_NAME | FILE_NOTIFY_CHANGE_DIR_NAME |
                                 FILE_NOTIFY_CHANGE_ATTRIBUTES | FILE_NOTIFY_CHANGE_SIZE |
                                 FILE_NOTIFY_CHANGE_LAST_WRITE | FILE_NOTIFY_CHANGE_CREATION |
                                 FILE_NOTIFY_CHANGE_SECURITY,
                             NULL, &w->ovl, NULL)) {
    return false;
  }
  w->inflight = true;
  return true;
}

/* Tears down the win32 backend state — close(), the leak path in
 * release(), and the atexit cleanup all funnel here; idempotent. */
static void scr_watch_backend_drop(ScrWatcher *w) {
  if (w->dh != INVALID_HANDLE_VALUE) {
    CancelIo(w->dh); /* the queued completion dies with the handle */
    CloseHandle(w->dh);
    w->dh = INVALID_HANDLE_VALUE;
  }
  if (w->ovl.hEvent != NULL) {
    CloseHandle(w->ovl.hEvent);
    w->ovl.hEvent = NULL;
  }
  w->inflight = false;
  free(w->filter);
  w->filter = NULL;
}
#endif

ScrWatcher *scr_watcher_retain(ScrWatcher *w) {
  if (w->rc != SIZE_MAX) w->rc++;
  return w;
}

static void scr_watcher_drop_listeners(ScrWatcher *w) {
  for (size_t i = 0; i < w->n; i++) scr_closure_release(w->ls[i].cb);
  free(w->ls);
  w->ls = NULL;
  w->n = w->cap = 0;
}

void scr_watcher_release(ScrWatcher *w) {
  if (!w || w->rc == SIZE_MAX) return;
  if (--w->rc == 0) {
    scr_watcher_drop_listeners(w); /* only reachable pre-close via leaks */
    if (w->fd >= 0) close(w->fd);
#ifdef SCR_HAVE_RDCW
    scr_watch_backend_drop(w);
#endif
    scr_str_release(w->path);
    free(w);
  }
}

void *scr_watcher_retain_v(void *p) { return scr_watcher_retain((ScrWatcher *)p); }
void scr_watcher_release_v(void *p) { scr_watcher_release((ScrWatcher *)p); }

/* fs.watch(path, cb?) — opens the path NOW (throwing Node's fs error on
 * failure), registers the watcher with the loop, and arms the vnode
 * filter. cb (nullable) moves in as the first listener. Result +1. */
ScrWatcher *scr_fs_watch(ScrStr *path, ScrClosure *cb /*moves, nullable*/, ScrWatchFn fn,
                         bool wants_name) {
  /* getValidatedPath: a null byte throws ERR_INVALID_ARG_VALUE before the
   * path reaches the platform call. */
  if (!scr_fs_path_ok(path, "path")) {
    if (cb != NULL) scr_closure_release(cb);
    return NULL; /* exception pending */
  }
#ifdef SCR_HAVE_INOTIFY
  /* The wd IS the validation: Node's Linux throw comes straight from
   * inotify_add_watch's errno, the same message shape as the open below. */
  if (scr_watch_ino < 0) scr_watch_ino = inotify_init1(IN_NONBLOCK | IN_CLOEXEC);
  int wd = scr_watch_ino >= 0 ? inotify_add_watch(scr_watch_ino, path->data, SCR_WATCH_IN_MASK)
                              : -1;
  if (wd < 0) {
    if (cb != NULL) scr_closure_release(cb);
    scr_fs_throw(errno, "watch", path);
    return NULL; /* exception pending */
  }
#elif defined(SCR_HAVE_RDCW)
  /* Existence is the validation (Node's win32 throw): a missing path is
   * the synchronous ENOENT. A file watch then opens the PARENT directory
   * and remembers the basename to filter deliveries by. */
  wchar_t *wpath = scr_watch_widen(path->data);
  DWORD attrs = wpath != NULL ? GetFileAttributesW(wpath) : INVALID_FILE_ATTRIBUTES;
  if (attrs == INVALID_FILE_ATTRIBUTES) {
    free(wpath);
    if (cb != NULL) scr_closure_release(cb);
    scr_fs_throw(ENOENT, "watch", path);
    return NULL; /* exception pending */
  }
  wchar_t *wfilter = NULL;
  if ((attrs & FILE_ATTRIBUTE_DIRECTORY) == 0) {
    wchar_t *base = NULL;
    for (wchar_t *p = wpath; *p != L'\0'; p++)
      if (*p == L'\\' || *p == L'/') base = p;
    if (base != NULL) {
      wfilter = _wcsdup(base + 1);
      if (wfilter == NULL) scr_watch_oom();
      *base = L'\0'; /* wpath is now the parent directory */
    } else {
      wfilter = wpath; /* bare name: watch the cwd, filter by it */
      wpath = _wcsdup(L".");
      if (wpath == NULL) scr_watch_oom();
    }
  }
  HANDLE dh = CreateFileW(wpath, FILE_LIST_DIRECTORY,
                          FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, NULL,
                          OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OVERLAPPED,
                          NULL);
  free(wpath);
  if (dh == INVALID_HANDLE_VALUE) {
    free(wfilter);
    if (cb != NULL) scr_closure_release(cb);
    scr_fs_throw(ENOENT, "watch", path);
    return NULL; /* exception pending */
  }
#else
  int fd = open(path->data, O_EVTONLY | O_NONBLOCK | O_CLOEXEC);
  if (fd < 0) {
    if (cb != NULL) scr_closure_release(cb);
    scr_fs_throw(errno, "watch", path);
    return NULL; /* exception pending */
  }
#endif
#ifdef SCR_WATCH_DIR_NAMES_REFUSED
  /* The path opened: a DIRECTORY watch on macOS has no name source before
   * F3, so a listener that reads the filename is refused HERE, before the
   * watcher is registered. */
  bool is_dir = false;
  {
    struct stat st;
    if (fstat(fd, &st) == 0 && S_ISDIR(st.st_mode)) is_dir = true;
  }
  if (wants_name && is_dir) {
    close(fd);
    if (cb != NULL) scr_closure_release(cb);
    scr_watch_refuse_dir_names();
    return NULL; /* exception pending */
  }
#endif
  ScrWatcher *w = calloc(1, sizeof *w);
  if (!w) scr_watch_oom();
  w->rc = 1;
  w->path = scr_str_retain(path);
  if (cb != NULL) {
    w->ls = malloc(sizeof *w->ls);
    if (!w->ls) scr_watch_oom();
    w->ls[0].cb = cb;
    w->ls[0].fn = fn;
    w->ls[0].event = SCR_WATCH_EV_CHANGE;
    w->ls[0].once = false;
    w->n = w->cap = 1;
  }
#ifdef SCR_WATCH_DIR_NAMES_REFUSED
  w->is_dir = is_dir;
#endif
#ifdef SCR_HAVE_INOTIFY
  w->fd = -1; /* inotify holds the watch; there is no per-watcher fd */
  w->wd = wd;
#elif defined(SCR_HAVE_KQUEUE)
  w->fd = fd;
  if (!scr_watch_arm(w)) {
    /* Filter refused (kqueue exhaustion): the watcher exists but never
     * fires — Node's kqueue backend surfaces this as a throw; the honest
     * cheap stance here is silence plus liveness, and nothing real hits
     * it. */
    close(w->fd);
    w->fd = -1;
  }
#elif defined(SCR_HAVE_RDCW)
  w->fd = -1;
  w->dh = dh;
  w->filter = wfilter;
  w->ovl.hEvent = CreateEventW(NULL, TRUE, FALSE, NULL);
  if (w->ovl.hEvent == NULL || !scr_watch_issue(w)) {
    /* the kqueue exhaustion stance: open, holding the loop, emitting no events */
    scr_watch_backend_drop(w);
  }
#else
  close(fd); /* no backend: open validated the path; no events exist */
  w->fd = -1;
#endif
  w->next = scr_watchers;
  scr_watchers = scr_watcher_retain(w);
  scr_watchers_open++;
  return w;
}

/* watcher.close() — idempotent: drops the filter (closing the fd deletes
 * its knote AND its queued events), the listeners, and the liveness
 * count. The registry's reference is NOT released here: a listener may
 * close its own watcher while the dispatch drain still holds the pointer
 * in its current event batch — the sweep between batches (and the atexit
 * cleanup) unlinks closed watchers at safe points instead. */
void scr_watcher_close(ScrWatcher *w) {
  if (w->closed) return;
  w->closed = true;
  /* The 'close' listeners leave the LIVE list and run on the next tick,
   * in registration order, exactly once (Node emits 'close' after the
   * first close() returns). */
  ScrWatchL *closes = NULL;
  size_t ncloses = 0;
  if (w->n > 0) {
    closes = malloc(w->n * sizeof *closes);
    if (!closes) scr_watch_oom();
    size_t kept = 0;
    for (size_t i = 0; i < w->n; i++) {
      if (w->ls[i].event == SCR_WATCH_EV_CLOSE) closes[ncloses++] = w->ls[i];
      else w->ls[kept++] = w->ls[i];
    }
    w->n = kept;
  }
#ifdef SCR_HAVE_INOTIFY
  if (w->wd >= 0) {
    /* The queued IN_IGNORED this rm produces finds no open watcher and is
     * skipped; wd numbers are issued cyclically, so it cannot collide
     * with a watch created afterwards. */
    if (scr_watch_ino >= 0) (void)inotify_rm_watch(scr_watch_ino, w->wd);
    w->wd = -1;
  }
#endif
#ifdef SCR_HAVE_RDCW
  scr_watch_backend_drop(w);
#endif
  if (w->fd >= 0) {
    close(w->fd);
    w->fd = -1;
  }
  scr_watcher_drop_listeners(w);
  scr_watchers_open--;
  if (ncloses > 0) {
    ScrWatchCloseBatch *batch = malloc(sizeof *batch);
    if (!batch) scr_watch_oom();
    batch->rc = 1; /* the box owns it */
    batch->ls = closes;
    batch->n = ncloses;
    ScrClosure *tick = scr_closure_new((void *)scr_watch_close_tick, 1);
    tick->caps[0] =
        scr_box_new_obj(scr_watch_batch_retain, scr_watch_batch_release, NULL);
    scr_box_set_ref(tick->caps[0], batch);
    scr_next_tick(tick);
  } else {
    free(closes);
  }
}

/* Unlinks and releases closed watchers — called only where no fetched
 * event batch can still point at them. */
static void scr_watch_sweep(void) {
  ScrWatcher **link = &scr_watchers;
  while (*link) {
    ScrWatcher *w = *link;
    if (w->closed) {
      *link = w->next;
      w->next = NULL;
      scr_watcher_release(w); /* the registry's reference */
    } else {
      link = &w->next;
    }
  }
}

/* The runtime-provided listener adapters. */
void scr_watch_thunk0(ScrClosure *cb, const char *event, const char *filename) {
  (void)event;
  (void)filename;
  ((void (*)(ScrClosure *))cb->fn)(cb);
}
void scr_watch_thunk_event(ScrClosure *cb, const char *event, const char *filename) {
  (void)filename;
  /* The listener owns its +1 param per the universal convention. */
  ScrStr *e = scr_str_new(event, strlen(event));
  ((void (*)(ScrClosure *, ScrStr *))cb->fn)(cb, e);
}
/* The zero-parameter 'error' listener: the error itself is dropped. */
void scr_watch_err_thunk0(ScrClosure *cb, ScrError *err) {
  (void)err;
  ((void (*)(ScrClosure *))cb->fn)(cb);
}

/* watcher.on/once/addListener/prependListener(event, listener). A closed
 * watcher can never fire again, so the listener leaves at once. */
void scr_watcher_on(ScrWatcher *w, double event, ScrClosure *cb, void *fn, bool once, bool prepend,
                    bool wants_name) {
  if (w->closed) {
    scr_closure_release(cb);
    return;
  }
#ifdef SCR_WATCH_DIR_NAMES_REFUSED
  if (event == SCR_WATCH_EV_CHANGE && wants_name && w->is_dir) {
    scr_closure_release(cb);
    scr_watch_refuse_dir_names();
    return;
  }
#else
  (void)wants_name;
#endif
  if (w->n == w->cap) {
    size_t cap = w->cap == 0 ? 1 : w->cap * 2;
    ScrWatchL *grown = realloc(w->ls, cap * sizeof *grown);
    if (!grown) scr_watch_oom();
    w->ls = grown;
    w->cap = cap;
  }
  ScrWatchL entry = {cb, fn, (uint8_t)event, once};
  if (prepend) {
    memmove(w->ls + 1, w->ls, w->n * sizeof *w->ls);
    w->ls[0] = entry;
  } else {
    w->ls[w->n] = entry;
  }
  w->n++;
}

/* watcher.off/removeListener(event, listener): the most recently added
 * listener of that event with the same closure identity leaves. */
void scr_watcher_off(ScrWatcher *w, double event, ScrClosure *cb) {
  for (size_t i = w->n; i > 0; i--) {
    ScrWatchL *l = &w->ls[i - 1];
    if (l->event != (uint8_t)event || l->cb != cb) continue;
    scr_closure_release(l->cb);
    memmove(l, l + 1, (w->n - i) * sizeof *w->ls);
    w->n--;
    return;
  }
}

static void *scr_watch_batch_retain(void *p) {
  ScrWatchCloseBatch *b = p;
  if (b->rc != SIZE_MAX) b->rc++;
  return b;
}

static void scr_watch_batch_release(void *p) {
  ScrWatchCloseBatch *b = p;
  if (!b || b->rc == SIZE_MAX) return;
  if (--b->rc != 0) return;
  for (size_t i = 0; i < b->n; i++) scr_closure_release(b->ls[i].cb);
  free(b->ls);
  free(b);
}

static void scr_watch_close_tick(ScrClosure *cb) {
  ScrWatchCloseBatch *b = scr_box_get_ref(cb->caps[0]);
  if (b == NULL) return;
  for (size_t i = 0; i < b->n; i++) {
    if (!scr_exc_pending()) ((void (*)(ScrClosure *))b->ls[i].cb->fn)(b->ls[i].cb);
  }
  scr_watch_batch_release(b);
}

/* Fires one watcher's CHANGE listeners with the event name and the entry
 * name (NULL when the platform named nothing). The snapshot follows the
 * existing shape — a listener closing the watcher mid-emit still finishes
 * this delivery — and a one-shot listener leaves the LIVE list before it
 * runs (EventEmitter's rule). */
static void scr_watch_fire(ScrWatcher *w, const char *event, const char *filename) {
  if (w->n == 0) return;
  ScrWatchL *snap = malloc(w->n * sizeof *snap);
  if (!snap) scr_watch_oom();
  size_t n = 0, kept = 0;
  for (size_t i = 0; i < w->n; i++) {
    ScrWatchL l = w->ls[i];
    if (l.event != SCR_WATCH_EV_CHANGE) {
      w->ls[kept++] = l;
      continue;
    }
    snap[n++] = l;
    scr_closure_retain(l.cb);
    if (!l.once) w->ls[kept++] = l;
    else scr_closure_release(l.cb); /* the live list's own reference leaves now */
  }
  w->n = kept;
  for (size_t i = 0; i < n; i++) {
    if (!scr_exc_pending()) ((ScrWatchFn)snap[i].fn)(snap[i].cb, event, filename);
    scr_closure_release(snap[i].cb);
  }
  free(snap);
}

/* ── the loop hooks (scr_async.c) ────────────────────────────────────── */

/* Liveness: every un-closed watcher holds the loop (Node's persistent
 * default) — a watcher with no event source (fd < 0) included, exactly
 * like Node's. */
static bool scr_watch_pending(void) { return scr_watchers_open > 0; }

static int scr_watch_pollfd(void) {
#ifdef SCR_HAVE_KQUEUE
  return scr_watch_kq;
#elif defined(SCR_HAVE_INOTIFY)
  return scr_watch_ino; /* readable while events pend, like a kqueue fd */
#else
  return -1; /* win32: nothing pollable — the loop's capped sleep serves */
#endif
}

static void scr_watch_dispatch(void) {
#ifdef SCR_HAVE_KQUEUE
  if (scr_watch_kq < 0) {
    scr_watch_sweep();
    return;
  }
  for (;;) {
    scr_watch_sweep();
    struct kevent evs[64];
    struct timespec zero = {0, 0};
    int n = kevent(scr_watch_kq, NULL, 0, evs, 64, &zero);
    if (n <= 0) return;
    for (int i = 0; i < n; i++) {
      ScrWatcher *w = (ScrWatcher *)evs[i].udata;
      if (w == NULL || w->closed || w->fd < 0) continue;
      uint32_t ff = evs[i].fflags;
      bool rename = (ff & (NOTE_RENAME | NOTE_DELETE | NOTE_REVOKE)) != 0;
      /* The entry name BEFORE the reopen dance closes the old fd: kqueue
       * names the watched inode by its CURRENT path (libuv's
       * F_GETPATH rule). A directory watch names the directory itself —
       * only the zero/one-parameter listeners, which ignore it, see it. */
      const char *name = NULL;
#ifdef F_GETPATH
      char pathbuf[MAXPATHLEN];
      if (w->fd >= 0 && fcntl(w->fd, F_GETPATH, pathbuf) == 0)
        name = scr_watch_basename(pathbuf);
#endif
      if (rename) {
        /* The inode left the name: reopen best-effort so the atomic
         * replace-by-rename idiom keeps delivering on the new file. The
         * OLD fd closes first (its filter dies with it) — a coalesced
         * change on the old inode is superseded by the rename. */
        close(w->fd);
        w->fd = open(w->path->data, O_EVTONLY | O_NONBLOCK | O_CLOEXEC);
        if (w->fd >= 0 && !scr_watch_arm(w)) {
          close(w->fd);
          w->fd = -1;
        }
        scr_watch_fire(w, "rename", name);
      } else if (ff & (NOTE_WRITE | NOTE_EXTEND | NOTE_ATTRIB)) {
        scr_watch_fire(w, "change", name);
      }
      if (scr_exc_pending()) return; /* the loop surfaces it */
    }
    if (scr_loop_has_ready()) return; /* microtasks interleave first */
  }
#elif defined(SCR_HAVE_INOTIFY)
  if (scr_watch_ino < 0) {
    scr_watch_sweep();
    return;
  }
  for (;;) {
    scr_watch_sweep();
    char buf[4096] __attribute__((aligned(__alignof__(struct inotify_event))));
    ssize_t n = read(scr_watch_ino, buf, sizeof buf);
    if (n <= 0) return; /* EAGAIN/EINTR: the next turn retries */
    for (char *p = buf; p < buf + n;) {
      const struct inotify_event *e = (const struct inotify_event *)p;
      p += sizeof *e + e->len;
      ScrWatcher *w = scr_watch_by_wd(e->wd);
      if (w == NULL) continue; /* closed, or a stale post-close IN_IGNORED */
      /* libuv's mapping, probed against Linux Node: IN_ATTRIB/IN_MODIFY
       * fire "change"; every other delivered mask — IN_DELETE_SELF,
       * IN_MOVE_SELF, the name-level events, and IN_IGNORED itself —
       * fires "rename". */
      bool change = (e->mask & (IN_ATTRIB | IN_MODIFY)) != 0;
      if (e->mask & IN_IGNORED) w->wd = -1; /* the kernel dropped the watch:
                                             * no further events (no reopen), like Node */
      /* libuv's filename rule: the entry name for a directory event, the
       * watched path's basename otherwise (uv__basename_r). */
      const char *name = e->len ? e->name : scr_watch_basename(w->path->data);
      scr_watch_fire(w, change ? "change" : "rename", name);
      if (scr_exc_pending()) return; /* the loop surfaces it */
    }
    if (scr_loop_has_ready()) return; /* microtasks interleave first */
  }
#elif defined(SCR_HAVE_RDCW)
  scr_watch_sweep();
  for (ScrWatcher *w = scr_watchers; w != NULL; w = w->next) {
    if (w->closed || w->dh == INVALID_HANDLE_VALUE || !w->inflight) continue;
    if (WaitForSingleObject(w->ovl.hEvent, 0) != WAIT_OBJECT_0) continue;
    DWORD bytes = 0;
    BOOL ok = GetOverlappedResult(w->dh, &w->ovl, &bytes, FALSE);
    w->inflight = false;
    /* Deliver from THIS buffer before reissuing (the reissue hands buf
     * back to the kernel). libuv's action mapping: MODIFIED is "change",
     * everything else — added, removed, renamed either direction — is
     * "rename". File watches filter by basename (ordinal,
     * case-insensitive — NTFS name matching); zero bytes is the
     * overflow notification, delivered as a filterless "rename" burst
     * signal the same way libuv degrades. */
    if (ok && bytes == 0) {
      scr_watch_fire(w, "rename", NULL); /* the overflow notification names nothing */
      if (scr_exc_pending()) return;
    } else if (ok) {
      char *p = w->buf;
      for (;;) {
        FILE_NOTIFY_INFORMATION *e = (FILE_NOTIFY_INFORMATION *)p;
        size_t wlen = e->FileNameLength / sizeof(WCHAR); /* not NUL-terminated */
        bool match =
            w->filter == NULL ||
            CompareStringOrdinal(e->FileName, (int)wlen, w->filter, -1, TRUE) == CSTR_EQUAL;
        if (match) {
          char stackbuf[1024];
          char *heap = NULL;
          char *namebuf = stackbuf;
          size_t namecap = sizeof stackbuf;
          if (wlen * 4 + 1 > namecap) {
            heap = malloc(wlen * 4 + 1);
            if (!heap) scr_watch_oom();
            namebuf = heap;
            namecap = wlen * 4 + 1;
          }
          int nbytes = WideCharToMultiByte(CP_UTF8, 0, e->FileName, (int)wlen, namebuf,
                                           (int)namecap - 1, NULL, NULL);
          char *name = NULL;
          if (nbytes > 0) {
            namebuf[nbytes] = '\0';
            name = namebuf;
          }
          scr_watch_fire(w, e->Action == FILE_ACTION_MODIFIED ? "change" : "rename", name);
          free(heap);
          if (scr_exc_pending()) return;
          if (w->closed) break; /* a listener closed its own watcher */
        }
        if (e->NextEntryOffset == 0) break;
        p += e->NextEntryOffset;
      }
    }
    if (!w->closed && w->dh != INVALID_HANDLE_VALUE && !scr_watch_issue(w)) {
      /* TODO(windows): EPERM 'error' event — Node emits one when the
       * watched directory disappears (GetOverlappedResult fails with
       * ERROR_ACCESS_DENIED, libuv's UV_EPERM). Unverified on Windows;
       * the watcher stops emitting, like the kqueue exhaustion stance. */
      scr_watch_backend_drop(w); /* reissue refused: no further events, like kqueue exhaustion */
    }
  }
  scr_watch_sweep();
#endif
}

/* Exit-time registry cleanup (the events/net-unit precedent): watchers a
 * program legitimately leaves open at exit release their listeners and
 * registry references so the RC audit sees a clean heap. */
static void scr_watch_cleanup_atexit(void) {
  while (scr_watchers) {
    ScrWatcher *w = scr_watchers;
    scr_watchers = w->next;
    w->next = NULL;
    if (!w->closed) {
      w->closed = true;
      scr_watchers_open--;
    }
#ifdef SCR_HAVE_RDCW
    scr_watch_backend_drop(w);
#endif
    if (w->fd >= 0) {
      close(w->fd);
      w->fd = -1;
    }
    scr_watcher_drop_listeners(w);
    scr_watcher_release(w);
  }
#ifdef SCR_WORKERS
#ifdef SCR_HAVE_KQUEUE
  if (scr_watch_kq >= 0) close(scr_watch_kq);
  scr_watch_kq = -1;
#endif
#ifdef SCR_HAVE_INOTIFY
  if (scr_watch_ino >= 0) close(scr_watch_ino);
  scr_watch_ino = -1;
#endif
#endif
}

void scr_watch_install(void) {
  static SCR_TL bool installed = false;
  if (installed) return;
  installed = true;
  scr_atexit(scr_watch_cleanup_atexit);
  scr_loop_set_watch(&scr_watch_pending, &scr_watch_dispatch, &scr_watch_pollfd);
}
