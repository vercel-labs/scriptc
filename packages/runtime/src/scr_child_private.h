/* The child unit's private layout, for the gated lifecycle unit.
 *
 * scr_child.c owns the implementation and every entry point the compiled
 * programs call; its `ScrChild`, state and entry types stay defined there,
 * unchanged, because that unit is always linked and its object must not
 * move. The gated scr_child_lifecycle.c unit (listener removal and
 * signalCode) reads the same registries, so it repeats the layout here.
 * This is not a public surface: nothing outside the child units includes
 * it, and the struct stays opaque (scr_child.h's typedef) to everything
 * else.
 *
 * Each platform arm below must stay field-for-field identical to the
 * definition in scr_child.c's matching arm; a field's position is
 * load-bearing for both units at once. */
#ifndef SCR_CHILD_PRIVATE_H
#define SCR_CHILD_PRIVATE_H

#include "scr_child.h"

#ifdef _WIN32

#include <windows.h>

typedef enum {
  SCR_CHILD_RUNNING = 0,
  SCR_CHILD_EXITED = 1,
  SCR_CHILD_SPAWN_FAILED = 2
} ScrChildState;

typedef struct {
  ScrClosure *cb;
  ScrChildExitFn fn;
} ScrChildExitEntry;

typedef struct {
  ScrClosure *cb;
  ScrChildErrFn fn;
} ScrChildErrEntry;

struct ScrChild {
  size_t rc;
  HANDLE proc; /* NULL after the reap (or spawn failure) */
  DWORD pid;
  ScrChildState state;
  bool settled;
  bool close_done;
  bool spawn_done;
  ScrClosure **spawn_cbs;
  size_t n_spawn, cap_spawn;
  bool has_code;
  bool killed;
  bool reffed;
  int spawn_uv_errno;       /* spawn failure: Node's exitCode (negative) */
  const char *spawn_errname; /* spawn failure: the `code` stamp */
  double code;
  const char *exit_signal; /* we killed it: the signal's name (static) */
  const char *kill_signal; /* recorded when kill() terminates the child */
  ScrStr *err_msg;         /* spawn failure only: "spawn <cmd> <ERRNAME>" */
  ScrChildExitEntry *exit_cbs;
  size_t n_exit, cap_exit;
  ScrChildExitEntry *close_cbs;
  size_t n_close, cap_close;
  ScrChildErrEntry *err_cbs;
  size_t n_err, cap_err;
  ScrClosure *exec_cb;
  ScrExecFileFn exec_fn;
  ScrStr *exec_display;
  ScrStr *exec_file; /* the spawned file and its arguments (+1 each), for */
  ScrArr *exec_args; /* a spawn failure's path and spawnargs */
  void (*exec_props)(struct ScrChild *c, ScrError *error); /* Node's error properties */
  ScrChildStream *out_stream;
  ScrChildStream *err_stream;
  ScrChildWriter *in_stream;
  ScrDyn *out_dyn, *err_dyn, *in_dyn;
  struct ScrIpc *ipc;
  /* The AsyncLocalStorage context of the spawn() call (+1, NULL outside
   * a store): 'spawn', 'error', 'exit' and 'close' run in it. */
  ScrAlsCtx *als;
  struct ScrChild *next; /* the pending registry */
};

#else /* !_WIN32 — the POSIX layout */

typedef enum {
  SCR_CHILD_RUNNING = 0,
  SCR_CHILD_EXITED = 1,      /* reaped; has_code/code valid */
  SCR_CHILD_SPAWN_FAILED = 2 /* err_msg valid */
} ScrChildState;

typedef struct {
  ScrClosure *cb;
  ScrChildExitFn fn;
} ScrChildExitEntry;

typedef struct {
  ScrClosure *cb;
  ScrChildErrFn fn;
} ScrChildErrEntry;

struct ScrChild {
  size_t rc;
  pid_t pid;
  ScrChildState state;
  bool settled;   /* terminal event delivered; listeners released */
  bool close_done;
  bool spawn_done;
  ScrClosure **spawn_cbs;
  size_t n_spawn, cap_spawn;
  bool unwatched; /* no kqueue NOTE_EXIT armed: the loop must poll for it */
  bool has_code;
  bool killed;    /* a kill() successfully sent a signal (Node's flag) */
  bool reffed;    /* keeps the loop alive; unref() clears it (Node) */
  int spawn_errno; /* spawn failure only: Node's exitCode is -errno there */
  double code;
  /* Signal death only: the terminating signal's name (static storage) —
   * Node's second exit-listener parameter. NULL for a normal exit. */
  const char *exit_signal;
  ScrStr *err_msg; /* spawn failure only: "spawn <cmd> <ERRNAME>" */
  ScrChildExitEntry *exit_cbs;
  size_t n_exit, cap_exit;
  ScrChildExitEntry *close_cbs;
  size_t n_close, cap_close;
  ScrChildErrEntry *err_cbs;
  size_t n_err, cap_err;
  ScrClosure *exec_cb;
  ScrExecFileFn exec_fn;
  ScrStr *exec_display;
  ScrStr *exec_file; /* the spawned file and its arguments (+1 each), for */
  ScrArr *exec_args; /* a spawn failure's path and spawnargs */
  void (*exec_props)(struct ScrChild *c, ScrError *error); /* Node's error properties */
  /* Piped stdio (stdio mode 3): the stream handles child.stdout /
   * child.stderr answer — owned (+1 each), NULL when not piped. */
  ScrChildStream *out_stream;
  ScrChildStream *err_stream;
  ScrChildWriter *in_stream;
  ScrDyn *out_dyn, *err_dyn, *in_dyn;
  struct ScrIpc *ipc;
  /* The AsyncLocalStorage context of the spawn() call (+1, NULL outside
   * a store): 'spawn', 'error', 'exit' and 'close' run in it. */
  ScrAlsCtx *als;
  struct ScrChild *next; /* the pending registry */
};

#endif /* _WIN32 */

#endif /* SCR_CHILD_PRIVATE_H */
