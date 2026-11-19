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

#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
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

/* One directory of a recursive inotify watch: its descriptor and its path
 * RELATIVE to the watched root ("" for the root itself). The kernel reports
 * an event per directory, so the entry name a listener sees is this prefix
 * joined to the event's own name, the relative path Node reports. */
typedef struct ScrWatchSub {
  int wd;
  ScrStr *rel;
  struct ScrWatchSub *next;
} ScrWatchSub;

struct ScrWatcher {
  size_t rc;
  int fd;       /* -1 once closed, or after a failed reopen (no further events) */
  bool recursive; /* watch the whole directory subtree */
  ScrStr *abs_root; /* its canonical path: child paths must not move with the cwd */
#ifdef SCR_WATCH_DIR_NAMES_REFUSED
  bool is_dir;  /* the opened path is a directory (the F3 gap) */
#endif
#ifdef SCR_HAVE_INOTIFY
  int wd;       /* the inotify watch descriptor; -1 once dead (IN_IGNORED
                 * arrived or close() removed it) */
  ScrWatchSub *subs; /* the recursive tree's directory watches (NULL when
                      * the root watch is the only one) */
#endif
#if defined(__APPLE__)
  void *fse; /* the FSEvents stream of a recursive directory watch */
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
  bool reffed;  /* keeps the loop alive (Node's persistent default);
                 * unref() clears it, ref() sets it again */
  ScrStr *path; /* the watched path — the reopen-after-rename target */
  ScrWatchL *ls;
  size_t n, cap;
  struct ScrWatcher *next; /* the open-watcher registry (+1 each) */
};

static SCR_TL ScrWatcher *scr_watchers = NULL;
static SCR_TL size_t scr_watchers_open = 0;   /* every open (unclosed) watcher: io interest */
static SCR_TL size_t scr_watchers_reffed = 0; /* the reffed ones: the loop's liveness */

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

#if defined(__APPLE__)
/* ── the FSEvents arm for a recursive directory watch ──────────────────
 * kqueue watches one inode, so it can neither name an entry nor follow a
 * tree; Node-on-macOS implements a recursive watch with an FSEvents stream.
 * CoreServices is loaded with dlopen so the runtime archive carries no
 * framework link flag, which the compiler's link line does not have.
 * Events arrive on a private serial queue; the callback only copies the
 * paths and flags into a mutex-protected list and writes one byte to a
 * pipe registered on the unit's kqueue, so every watcher is touched on the
 * loop's own thread (the watcher registry is thread-local). CoreServices
 * and CoreFoundation ship with every macOS install. */

#include <dlfcn.h>
#include <pthread.h>
#include <stdint.h>

extern void *dispatch_queue_create(const char *label, void *attr);

static void scr_watch_fire(ScrWatcher *w, const char *event, const char *filename);

#define SCR_FSE_ITEM_CREATED 0x00000100u
#define SCR_FSE_ITEM_REMOVED 0x00000200u
#define SCR_FSE_ITEM_INODE_META_MOD 0x00000400u
#define SCR_FSE_ITEM_RENAMED 0x00000800u
#define SCR_FSE_ITEM_MODIFIED 0x00001000u
#define SCR_FSE_ITEM_FINDER_INFO_MOD 0x00002000u
#define SCR_FSE_ITEM_CHANGE_OWNER 0x00004000u
#define SCR_FSE_ITEM_XATTR_MOD 0x00008000u
#define SCR_FSE_ROOT_CHANGED 0x00000020u
#define SCR_FSE_MUST_SCAN_SUBDIRS 0x00000001u
#define SCR_FSE_USER_DROPPED 0x00000002u
#define SCR_FSE_KERNEL_DROPPED 0x00000004u
#define SCR_FSE_EVENT_IDS_WRAPPED 0x00000008u
#define SCR_FSE_CREATE_FILE_EVENTS 0x00000010u
#define SCR_FSE_CREATE_NO_DEFER 0x00000002u
#define SCR_FSE_CREATE_WATCH_ROOT 0x00000004u
#define SCR_FSE_UTF8 0x08000100u
#define SCR_FSE_SINCE_NOW UINT64_MAX

typedef void (*ScrFseCallback)(void *stream, void *info, size_t count, void *paths,
                               const uint32_t *flags, const uint64_t *ids);

typedef struct {
  bool ok;
  void *(*cf_string_create)(void *alloc, const uint8_t *bytes, long length, uint32_t encoding,
                            int external);
  void *(*cf_array_create)(void *alloc, const void *const *values, long count,
                           const void *callbacks);
  void (*cf_release)(void *value);
  const void *array_callbacks;
  void *(*stream_create)(void *alloc, ScrFseCallback cb, void *context, void *paths,
                         uint64_t since, double latency, uint32_t flags);
  void (*set_queue)(void *stream, void *queue);
  int (*start)(void *stream);
  void (*stop)(void *stream);
  void (*invalidate)(void *stream);
  void (*release)(void *stream);
} ScrFseApi;

static ScrFseApi scr_fse_api_state;
static bool scr_fse_loaded;
static void *scr_fse_queue;

typedef struct ScrFsePending {
  char *path;
  uint32_t flags;
  struct ScrFsePending *next;
} ScrFsePending;

static pthread_mutex_t scr_fse_mu = PTHREAD_MUTEX_INITIALIZER;
static ScrFsePending *scr_fse_pending;
static ScrFsePending *scr_fse_pending_tail;
static int scr_fse_pipe[2] = {-1, -1};
static char scr_fse_token; /* the kqueue udata that marks the wake pipe */

static void *scr_fse_sym(void *handle, const char *name) {
  return handle != NULL ? dlsym(handle, name) : NULL;
}

static bool scr_fse_load(void) {
  if (scr_fse_loaded) return scr_fse_api_state.ok;
  scr_fse_loaded = true;
  void *cs = dlopen("/System/Library/Frameworks/CoreServices.framework/CoreServices",
                    RTLD_LAZY | RTLD_LOCAL);
  if (cs == NULL)
    cs = dlopen(
        "/System/Library/Frameworks/CoreServices.framework/Frameworks/FSEvents.framework/FSEvents",
        RTLD_LAZY | RTLD_LOCAL);
  void *cf =
      dlopen("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation", RTLD_LAZY | RTLD_LOCAL);
  ScrFseApi *a = &scr_fse_api_state;
  a->cf_string_create =
      (void *(*)(void *, const uint8_t *, long, uint32_t, int))scr_fse_sym(cf, "CFStringCreateWithBytes");
  a->cf_array_create =
      (void *(*)(void *, const void *const *, long, const void *))scr_fse_sym(cf, "CFArrayCreate");
  a->cf_release = (void (*)(void *))scr_fse_sym(cf, "CFRelease");
  a->array_callbacks = scr_fse_sym(cf, "kCFTypeArrayCallBacks");
  a->stream_create = (void *(*)(void *, ScrFseCallback, void *, void *, uint64_t, double, uint32_t))
      scr_fse_sym(cs, "FSEventStreamCreate");
  a->set_queue =
      (void (*)(void *, void *))scr_fse_sym(cs, "FSEventStreamSetDispatchQueue");
  a->start = (int (*)(void *))scr_fse_sym(cs, "FSEventStreamStart");
  a->stop = (void (*)(void *))scr_fse_sym(cs, "FSEventStreamStop");
  a->invalidate = (void (*)(void *))scr_fse_sym(cs, "FSEventStreamInvalidate");
  a->release = (void (*)(void *))scr_fse_sym(cs, "FSEventStreamRelease");
  a->ok = cs != NULL && cf != NULL && a->array_callbacks != NULL && a->cf_string_create != NULL &&
          a->cf_array_create != NULL && a->cf_release != NULL && a->stream_create != NULL &&
          a->set_queue != NULL && a->start != NULL && a->stop != NULL && a->invalidate != NULL &&
          a->release != NULL;
  if (a->ok && scr_fse_queue == NULL)
    scr_fse_queue = dispatch_queue_create("scriptc.watch.fsevents", NULL);
  if (scr_fse_queue == NULL) a->ok = false;
  return a->ok;
}

/** Queues one delivery batch and wakes the loop. Runs on the stream's
 * serial queue; touches no watcher. */
static void scr_fse_callback(void *stream, void *info, size_t count, void *paths,
                             const uint32_t *flags, const uint64_t *ids) {
  (void)stream;
  (void)info;
  (void)ids;
  if (count == 0 || paths == NULL) return;
  char **names = (char **)paths;
  pthread_mutex_lock(&scr_fse_mu);
  for (size_t i = 0; i < count; i++) {
    if (names[i] == NULL) continue;
    size_t len = strlen(names[i]);
    ScrFsePending *p = malloc(sizeof *p);
    if (p == NULL) break;
    p->path = malloc(len + 1);
    if (p->path == NULL) {
      free(p);
      break;
    }
    memcpy(p->path, names[i], len + 1);
    p->flags = flags[i];
    p->next = NULL;
    if (scr_fse_pending_tail != NULL) scr_fse_pending_tail->next = p;
    else scr_fse_pending = p;
    scr_fse_pending_tail = p;
  }
  pthread_mutex_unlock(&scr_fse_mu);
  if (scr_fse_pipe[1] >= 0) {
    ssize_t ignored = write(scr_fse_pipe[1], "x", 1);
    (void)ignored;
  }
}

/** Opens the wake pipe (once) and registers its read end on the unit's
 * kqueue, so the loop's single poll descriptor serves both arms. */
static bool scr_fse_wake_pipe(void) {
  if (scr_fse_pipe[0] >= 0) return true;
  if (pipe(scr_fse_pipe) != 0) {
    scr_fse_pipe[0] = scr_fse_pipe[1] = -1;
    return false;
  }
  for (int i = 0; i < 2; i++) {
    fcntl(scr_fse_pipe[i], F_SETFL, O_NONBLOCK);
    fcntl(scr_fse_pipe[i], F_SETFD, FD_CLOEXEC);
  }
  if (scr_watch_kq < 0) scr_watch_kq = kqueue();
  if (scr_watch_kq < 0) return false;
  struct kevent ev;
  EV_SET(&ev, (uintptr_t)scr_fse_pipe[0], EVFILT_READ, EV_ADD | EV_CLEAR, 0, 0, &scr_fse_token);
  struct timespec zero = {0, 0};
  return kevent(scr_watch_kq, &ev, 1, NULL, 0, &zero) == 0;
}

/** Starts the stream for a recursive directory watch. False leaves the
 * watcher open, holding the loop, emitting nothing (the kqueue exhaustion
 * stance). */
static bool scr_fse_start(ScrWatcher *w) {
  ScrFseApi *a = &scr_fse_api_state;
  if (!scr_fse_load() || !scr_fse_wake_pipe()) return false;
  /* FSEvents needs an absolute path: the root's canonical spelling is
   * also the one events come back under. */
  const ScrStr *root = w->abs_root != NULL ? w->abs_root : w->path;
  void *path = a->cf_string_create(NULL, (const uint8_t *)root->data, (long)root->len, SCR_FSE_UTF8, 0);
  if (path == NULL) return false;
  const void *values[1] = {path};
  void *paths = a->cf_array_create(NULL, values, 1, a->array_callbacks);
  a->cf_release(path);
  if (paths == NULL) return false;
  uint32_t flags = SCR_FSE_CREATE_FILE_EVENTS | SCR_FSE_CREATE_NO_DEFER | SCR_FSE_CREATE_WATCH_ROOT;
  void *stream = a->stream_create(NULL, scr_fse_callback, NULL, paths, SCR_FSE_SINCE_NOW, 0.01, flags);
  a->cf_release(paths);
  if (stream == NULL) return false;
  a->set_queue(stream, scr_fse_queue);
  if (!a->start(stream)) {
    a->invalidate(stream);
    a->release(stream);
    return false;
  }
  w->fse = stream;
  return true;
}

static void scr_fse_stop(ScrWatcher *w) {
  if (w->fse == NULL) return;
  ScrFseApi *a = &scr_fse_api_state;
  a->stop(w->fse);
  a->invalidate(w->fse);
  a->release(w->fse);
  w->fse = NULL;
}

/** Delivers the queued batches to every recursive watcher whose root names
 * the event's path, on the loop's thread. The name is the path relative to
 * the root, which is what Node reports. */
static void scr_fse_drain(void) {
  if (scr_fse_pipe[0] >= 0) {
    char buf[256];
    while (read(scr_fse_pipe[0], buf, sizeof buf) > 0) {
    }
  }
  pthread_mutex_lock(&scr_fse_mu);
  ScrFsePending *list = scr_fse_pending;
  scr_fse_pending = NULL;
  scr_fse_pending_tail = NULL;
  pthread_mutex_unlock(&scr_fse_mu);
  while (list != NULL) {
    ScrFsePending *next = list->next;
    size_t plen = strlen(list->path);
    while (plen > 1 && list->path[plen - 1] == '/') list->path[--plen] = '\0';
    bool rename = (list->flags &
                   (SCR_FSE_ITEM_CREATED | SCR_FSE_ITEM_REMOVED | SCR_FSE_ITEM_RENAMED |
                    SCR_FSE_ROOT_CHANGED | SCR_FSE_MUST_SCAN_SUBDIRS | SCR_FSE_USER_DROPPED |
                    SCR_FSE_KERNEL_DROPPED | SCR_FSE_EVENT_IDS_WRAPPED)) != 0;
    bool change = (list->flags &
                   (SCR_FSE_ITEM_MODIFIED | SCR_FSE_ITEM_INODE_META_MOD |
                    SCR_FSE_ITEM_FINDER_INFO_MOD | SCR_FSE_ITEM_CHANGE_OWNER |
                    SCR_FSE_ITEM_XATTR_MOD)) != 0;
    if (rename || change) {
      for (ScrWatcher *w = scr_watchers; w != NULL; w = w->next) {
        if (w->closed || !w->recursive) continue;
        const char *roots[2] = {w->abs_root != NULL ? w->abs_root->data : NULL, w->path->data};
        for (int r = 0; r < 2; r++) {
          if (roots[r] == NULL) continue;
          size_t rlen = strlen(roots[r]);
          while (rlen > 1 && roots[r][rlen - 1] == '/') rlen--;
          if (plen <= rlen + 1) continue;
          if (memcmp(list->path, roots[r], rlen) != 0) continue;
          if (list->path[rlen] != '/') continue;
          scr_watch_fire(w, rename ? "rename" : "change", list->path + rlen + 1);
          if (scr_exc_pending()) return;
          break; /* one delivery per watcher per event, whichever spelling matched */
        }
      }
    }
    free(list->path);
    free(list);
    list = next;
  }
}
#endif /* __APPLE__ */

#ifdef SCR_HAVE_INOTIFY
static SCR_TL int scr_watch_ino = -1; /* created with the first watch */

/* libuv's subscription mask: name-level events for directory watches,
 * self events for the file case, IN_IGNORED arriving automatically. */
#define SCR_WATCH_IN_MASK                                                        \
  (IN_ATTRIB | IN_CREATE | IN_MODIFY | IN_DELETE | IN_DELETE_SELF |              \
   IN_MOVE_SELF | IN_MOVED_FROM | IN_MOVED_TO)

/** Registers one directory of a recursive watch. The kernel refcounts
 * inotify watches by PATH, so a directory another watcher already watches
 * shares its descriptor; each watcher keeps its own relative prefix. */
static void scr_watch_add_sub(ScrWatcher *w, const char *abs, const char *rel) {
  int wd = scr_watch_ino >= 0 ? inotify_add_watch(scr_watch_ino, abs, SCR_WATCH_IN_MASK) : -1;
  if (wd < 0) return;
  for (ScrWatchSub *known = w->subs; known != NULL; known = known->next) {
    if (strcmp(known->rel->data, rel) == 0) {
      known->wd = wd;
      return;
    }
  }
  ScrWatchSub *sub = malloc(sizeof *sub);
  if (!sub) scr_watch_oom();
  sub->wd = wd;
  sub->rel = scr_str_new(rel, strlen(rel));
  sub->next = w->subs;
  w->subs = sub;
}

/** Walks the directory at `abs` (whose prefix is `rel`) and registers every
 * directory below it. Symbolic links to directories are not followed: a
 * walk that followed them could cycle, and libuv's does not either. */
static void scr_watch_walk(ScrWatcher *w, const char *abs, const char *rel) {
  DIR *dir = opendir(abs);
  if (dir == NULL) return;
  struct dirent *ent;
  while ((ent = readdir(dir)) != NULL) {
    if (strcmp(ent->d_name, ".") == 0 || strcmp(ent->d_name, "..") == 0) continue;
    size_t alen = strlen(abs), nlen = strlen(ent->d_name);
    char *child = malloc(alen + 1 + nlen + 1);
    if (!child) scr_watch_oom();
    memcpy(child, abs, alen);
    child[alen] = '/';
    memcpy(child + alen + 1, ent->d_name, nlen + 1);
    struct stat st;
    if (lstat(child, &st) == 0 && S_ISDIR(st.st_mode)) {
      size_t rlen = strlen(rel);
      size_t clen = rlen + (rlen ? 1 : 0) + nlen;
      char *crel = malloc(clen + 1);
      if (!crel) scr_watch_oom();
      if (rlen) {
        memcpy(crel, rel, rlen);
        crel[rlen] = '/';
        memcpy(crel + rlen + 1, ent->d_name, nlen + 1);
      } else {
        memcpy(crel, ent->d_name, nlen + 1);
      }
      scr_watch_add_sub(w, child, crel);
      scr_watch_walk(w, child, crel);
      free(crel);
    }
    free(child);
  }
  closedir(dir);
}

/** The relative name of an event delivered to `sub`: the sub's prefix joined
 * to the entry name (Node's path relative to the watched root). `owned_out`
 * receives the allocation when the name did not fit `buf`. */
static const char *scr_watch_sub_name(const ScrWatchSub *sub, const char *name, char *buf,
                                      size_t cap, char **owned_out) {
  *owned_out = NULL;
  if (sub == NULL || sub->rel->len == 0 || name == NULL) return name;
  size_t rlen = sub->rel->len, nlen = strlen(name);
  if (rlen + 1 + nlen + 1 <= cap) {
    memcpy(buf, sub->rel->data, rlen);
    buf[rlen] = '/';
    memcpy(buf + rlen + 1, name, nlen + 1);
    return buf;
  }
  char *heap = malloc(rlen + 1 + nlen + 1);
  if (!heap) scr_watch_oom();
  memcpy(heap, sub->rel->data, rlen);
  heap[rlen] = '/';
  memcpy(heap + rlen + 1, name, nlen + 1);
  *owned_out = heap;
  return heap;
}

/** Forgets the sub entry for a directory that left the tree. The kernel
 * drops the descriptor with the inode, so no inotify_rm_watch is needed
 * here (and a shared peer keeps its own entry). */
static void scr_watch_drop_sub(ScrWatcher *w, const char *rel) {
  ScrWatchSub **link = &w->subs;
  while (*link != NULL) {
    ScrWatchSub *sub = *link;
    if (strcmp(sub->rel->data, rel) == 0) {
      *link = sub->next;
      scr_str_release(sub->rel);
      free(sub);
      return;
    }
    link = &sub->next;
  }
}

/** Whether an open watcher other than `except` holds `wd`, as its root or
 * as one of its recursive subdirectories. inotify refcounts by path, so a
 * descriptor two watchers share must survive the first one's close. */
static bool scr_watch_wd_shared(int wd, ScrWatcher *except) {
  for (ScrWatcher *w = scr_watchers; w != NULL; w = w->next) {
    if (w == except || w->closed) continue;
    if (w->wd == wd) return true;
    for (ScrWatchSub *sub = w->subs; sub != NULL; sub = sub->next)
      if (sub->wd == wd) return true;
  }
  return false;
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
  if (!ReadDirectoryChangesW(w->dh, w->buf, (DWORD)sizeof w->buf, w->recursive ? TRUE : FALSE,
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
#if defined(__APPLE__)
    scr_fse_stop(w);
#endif
#ifdef SCR_HAVE_RDCW
    scr_watch_backend_drop(w);
#endif
#ifdef SCR_HAVE_INOTIFY
    while (w->subs != NULL) {
      ScrWatchSub *sub = w->subs;
      w->subs = sub->next;
      scr_str_release(sub->rel);
      free(sub);
    }
#endif
    scr_str_release(w->abs_root);
    w->abs_root = NULL;
    scr_str_release(w->path);
    free(w);
  }
}

void *scr_watcher_retain_v(void *p) { return scr_watcher_retain((ScrWatcher *)p); }
void scr_watcher_release_v(void *p) { scr_watcher_release((ScrWatcher *)p); }

/* fs.watch(path, cb?) — opens the path NOW (throwing Node's fs error on
 * failure), registers the watcher with the loop, and arms the vnode
 * filter. cb (nullable) moves in as the first listener. Result +1. */
static void scr_watch_set_reffed(ScrWatcher *w, bool reffed);

ScrWatcher *scr_fs_watch(ScrStr *path, ScrClosure *cb /*moves, nullable*/, ScrWatchFn fn,
                         bool wants_name, bool persistent, bool recursive) {
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
  if (wants_name && is_dir && !recursive) {
    close(fd);
    if (cb != NULL) scr_closure_release(cb);
    scr_watch_refuse_dir_names();
    return NULL; /* exception pending */
  }
#endif
  ScrWatcher *w = calloc(1, sizeof *w);
  if (!w) scr_watch_oom();
  w->rc = 1;
  w->recursive = recursive;
  w->path = scr_str_retain(path);
  if (recursive) {
#if defined(_WIN32)
    /* Windows watches by directory handle and reports the entry name from
     * it, so it needs no canonical spelling (and the GNU CRT has no
     * realpath). */
    w->abs_root = NULL;
#else
    /* A recursive walk builds child paths long after the watch starts, so
     * it holds the root's canonical spelling: a later chdir must not move
     * where a new subdirectory's path resolves. */
    char resolved[PATH_MAX];
    const char *root = realpath(path->data, resolved) != NULL ? resolved : path->data;
    w->abs_root = scr_str_new(root, strlen(root));
#endif
  }
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
#if defined(__APPLE__)
  bool watched_subtree = false;
  if (recursive) {
    struct stat st;
    watched_subtree = fstat(fd, &st) == 0 && S_ISDIR(st.st_mode);
  }
  if (watched_subtree) {
    /* FSEvents owns the subtree; the opened descriptor only validated the
     * path, because kqueue would watch the one inode. */
    close(fd);
    w->fd = -1;
    (void)scr_fse_start(w);
  } else
#endif
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
#ifdef SCR_HAVE_INOTIFY
  if (recursive) {
    struct stat st;
    const char *root = w->abs_root != NULL ? w->abs_root->data : path->data;
    if (stat(root, &st) == 0 && S_ISDIR(st.st_mode)) scr_watch_walk(w, root, "");
  }
#endif
  w->next = scr_watchers;
  scr_watchers = scr_watcher_retain(w);
  scr_watchers_open++;
  scr_watch_set_reffed(w, persistent);
  return w;
}

/* The loop-liveness toggle behind Node's `persistent` option and
 * FSWatcher.ref()/unref(): a reffed open watcher keeps the loop alive, an
 * unref'd one does not (the loop still polls it while anything else keeps
 * the process running). Node's methods are no-ops on a closed watcher. */
static void scr_watch_set_reffed(ScrWatcher *w, bool reffed) {
  if (w->reffed == reffed) return;
  w->reffed = reffed;
  if (reffed) scr_watchers_reffed++;
  else scr_watchers_reffed--;
}

void scr_watcher_ref(ScrWatcher *w) {
  if (!w->closed) scr_watch_set_reffed(w, true);
}

void scr_watcher_unref(ScrWatcher *w) {
  if (!w->closed) scr_watch_set_reffed(w, false);
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
  scr_watch_set_reffed(w, false);
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
  /* inotify is refcounted by PATH: every watcher on one path shares its
   * descriptor, and a recursive watcher holds one for every directory in
   * its tree. Only the last open watcher on a descriptor removes it, so
   * closing one watcher leaves its peers delivering. The queued IN_IGNORED
   * a real removal produces finds no open watcher and is skipped; wd
   * numbers are issued cyclically, so it cannot collide with a watch
   * created afterwards. */
  if (w->wd >= 0) {
    if (!scr_watch_wd_shared(w->wd, w) && scr_watch_ino >= 0)
      (void)inotify_rm_watch(scr_watch_ino, w->wd);
    w->wd = -1;
  }
  for (ScrWatchSub *sub = w->subs; sub != NULL; sub = sub->next) {
    if (sub->wd >= 0 && !scr_watch_wd_shared(sub->wd, w) && scr_watch_ino >= 0)
      (void)inotify_rm_watch(scr_watch_ino, sub->wd);
    sub->wd = -1;
  }
#endif
#if defined(__APPLE__)
  scr_fse_stop(w);
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
  if (event == SCR_WATCH_EV_CHANGE && wants_name && w->is_dir && !w->recursive) {
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
static bool scr_watch_pending(void) { return scr_watchers_reffed > 0; }
/* Events from unref'd watchers still reach their listeners whenever the
 * loop runs for other work — they just do not hold it. */
static bool scr_watch_io(void) { return scr_watchers_open > 0; }

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
#if defined(__APPLE__)
      if (evs[i].udata == (void *)&scr_fse_token) {
        scr_fse_drain();
        if (scr_exc_pending()) return;
        continue;
      }
#endif
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
      /* inotify_add_watch is refcounted by PATH, so every watch on one
       * path shares a descriptor: deliver the event to each open watcher
       * holding it, not just the first (Node's per-FSWatcher delivery).
       * A listener may close another watcher as it runs — closed ones are
       * skipped, and close() drops the wd, so the walk stays honest. */
      /* libuv's mapping, probed against Linux Node: IN_ATTRIB/IN_MODIFY
       * fire "change"; every other delivered mask — IN_DELETE_SELF,
       * IN_MOVE_SELF, the name-level events, and IN_IGNORED itself —
       * fires "rename". */
      bool change = (e->mask & (IN_ATTRIB | IN_MODIFY)) != 0;
      bool ignored = (e->mask & IN_IGNORED) != 0;
      for (ScrWatcher *w = scr_watchers; w != NULL; w = w->next) {
        if (w->closed) continue;
        ScrWatchSub *sub = NULL;
        if (w->wd != e->wd) {
          for (sub = w->subs; sub != NULL; sub = sub->next)
            if (sub->wd == e->wd) break;
          if (sub == NULL) continue;
        }
        /* The kernel dropped the watch: no further events (no reopen),
         * like Node. */
        if (ignored) {
          if (sub == NULL) w->wd = -1;
            else sub->wd = -1;
        }
        /* libuv's filename rule: the entry name for a directory event,
         * the watched path's basename otherwise (uv__basename_r); a
         * recursive watch prefixes the SUBDIRECTORY that named the entry,
         * so the listener sees the path relative to the root. */
        char namebuf[1024];
        char *owned = NULL;
        const char *raw = e->len ? e->name : scr_watch_basename(w->path->data);
        const char *name = scr_watch_sub_name(sub, raw, namebuf, sizeof namebuf, &owned);
        if (w->recursive && e->len && (e->mask & IN_ISDIR) && !ignored) {
          /* A directory arriving in the tree gets watches for itself and
           * everything below it (a moved-in tree included); one leaving
           * loses them. */
          const char *base = w->abs_root != NULL ? w->abs_root->data : w->path->data;
          size_t alen = strlen(base), nlen = strlen(name);
          char *abs = malloc(alen + 1 + nlen + 1);
          if (!abs) scr_watch_oom();
          memcpy(abs, base, alen);
          abs[alen] = '/';
          memcpy(abs + alen + 1, name, nlen + 1);
          if (e->mask & (IN_CREATE | IN_MOVED_TO)) {
            scr_watch_add_sub(w, abs, name);
            scr_watch_walk(w, abs, name);
          } else if (e->mask & (IN_DELETE | IN_MOVED_FROM)) {
            scr_watch_drop_sub(w, name);
            if (scr_watch_ino >= 0 && !scr_watch_wd_shared(e->wd, w))
              (void)inotify_rm_watch(scr_watch_ino, e->wd);
          }
          free(abs);
        }
        scr_watch_fire(w, change ? "change" : "rename", name);
        /* A watched SUBDIRECTORY that itself moved away would otherwise
         * keep delivering events from its new place in the tree. */
        if (sub != NULL && (e->mask & (IN_MOVE_SELF | IN_DELETE_SELF))) {
          ScrStr *rel = scr_str_retain(sub->rel);
          scr_watch_drop_sub(w, rel->data);
          if (scr_watch_ino >= 0 && !scr_watch_wd_shared(e->wd, w))
            (void)inotify_rm_watch(scr_watch_ino, e->wd);
          scr_str_release(rel);
        }
        free(owned);
        if (scr_exc_pending()) return; /* the loop surfaces it */
      }
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
      scr_watch_set_reffed(w, false);
    }
#if defined(__APPLE__)
    scr_fse_stop(w);
#endif
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
  scr_loop_set_watch_io(&scr_watch_io);
}
