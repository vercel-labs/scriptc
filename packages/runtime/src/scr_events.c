/* Process events and stdin streaming — the OPTIONAL half of the event
 * loop: signal handlers (named process.on/once/off signal handlers), the
 * process 'exit' event, and the piped-stdin surface ('data'/'end'/'error'
 * listeners plus the for-await chunk source). This translation unit links
 * ONLY into binaries whose IR uses those surfaces (moduleUsesProcessEvents
 * — the scr_regex/scr_fetch/scr_zlib gating precedent), and the emitted
 * main calls scr_events_install() before %main, which points the loop's
 * nullable event hooks (scr_async.c) and scr_lib.c's process.exit /
 * stdin.destroy hooks here. Programs that never touch these surfaces pay
 * zero bytes and keep their exact historical link line. */
#define _XOPEN_SOURCE 700
#include "scr_runtime.h"

#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>
#ifdef _WIN32
/* The Windows arm: CRT signal() stands in for sigaction (msvcrt routes
 * Ctrl-C/Ctrl-Break through its own SetConsoleCtrlHandler onto a separate
 * thread and RESETS the disposition to SIG_DFL before each delivery — the
 * handler re-arms itself), the readability probe is PeekNamedPipe /
 * WaitForSingleObject instead of poll(2), and there is NO self-pipe: the
 * loop's win32 idle sleep is the capped nanosleep in scr_async.c, so the
 * handler's flag alone suffices and the cap bounds delivery latency.
 * read(2) on fd 0 is mingw's CRT read — fd 0 is already _O_BINARY
 * (scr_console.c's install). */
#include <io.h>
#include <unistd.h> /* mingw-w64 ships one: read */
#include <windows.h>
#elif defined(__wasi__)
#include <poll.h>
#include <unistd.h>
#else
#include <poll.h>
#include <unistd.h>
#endif

static void scr_events_oom(void) {
  fputs("scriptc: out of memory\n", stderr);
  abort();
}

#ifdef __wasi__
/* The native child unit normally owns these generic Error-listener adapters.
 * WASI cannot spawn children and therefore does not link that unit, while
 * stdin's error event intentionally shares the same adapter ABI. */
void scr_child_err_thunk0(ScrClosure *cb, ScrStr *msg) {
  (void)msg;
  ((void (*)(ScrClosure *))cb->fn)(cb);
}

void scr_child_err_thunk_error(ScrClosure *cb, ScrStr *msg) {
  ScrError *error = scr_error_new(0 /* Error */, msg);
  ((void (*)(ScrClosure *, ScrError *))cb->fn)(cb, error);
}
#endif

/* ── process signal events (process.on(name, listener)) ─────────
 * Classic self-pipe integration: a watched signal's sigaction handler
 * (installed WITHOUT SA_RESTART) sets a per-signal flag and writes one
 * byte into the wake pipe. The loop drains flags at every turn and the
 * idle sleeps either get EINTR'd by the handler (nanosleep, kevent) or
 * poll on the wake pipe directly, so a byte written before the sleep
 * entered still wakes it — no lost-wakeup race. Listeners run on the main
 * stack like timer callbacks (macrotasks). Node semantics matched:
 * watching a signal replaces its default disposition (Ctrl-C no longer
 * kills), removing the LAST listener restores it, `once` listeners are
 * removed BEFORE they run, and signal listeners do NOT keep the loop
 * alive — the exhaustion test ignores them, exactly Node. Multiple
 * deliveries between two loop turns coalesce into one dispatch (the
 * kernel coalesces pending non-RT signals the same way). */

typedef struct {
  ScrDyn *cb; /* owned; checked callable */
  ScrStr *name; /* aliases of one signum remain distinct event names */
  bool once;
  uint64_t id;
} ScrSigListener;

typedef struct ScrSigReg {
  int sig;
#if defined(_WIN32) || defined(__wasi__)
  void (*prev)(int); /* restored when the last listener leaves */
#else
  struct sigaction prev; /* restored when the last listener leaves */
#endif
  ScrSigListener *ls;
  size_t n, cap;
  struct ScrSigReg *next;
} ScrSigReg;

/* Every named classic POSIX signal fits; NSIG is hidden by strict
 * _XOPEN_SOURCE. Unknown SIG-prefixed names use the unwatched slot zero. */
#define SCR_SIG_MAX 32

static ScrSigReg *scr_sig_regs = NULL;
static uint64_t scr_sig_id = 0;
static size_t scr_sig_watched = 0; /* watched signal COUNT (regs) */
static volatile sig_atomic_t scr_sig_flag[SCR_SIG_MAX];
static volatile sig_atomic_t scr_sig_any = 0;
static int scr_wake_pipe[2] = {-1, -1};

static void scr_sig_handler(int sig) {
  if (sig <= 0 || sig >= SCR_SIG_MAX) return;
  int saved_errno = errno;
#ifdef _WIN32
  /* msvcrt reset the disposition to SIG_DFL before this call (SysV
   * semantics); re-arm so the next delivery reaches us too. Only ever
   * runs while a registration exists — dropping the last listener
   * restores the previous disposition below. */
  signal(sig, scr_sig_handler);
#endif
  scr_sig_flag[sig] = 1;
  scr_sig_any = 1;
  if (scr_wake_pipe[1] >= 0) {
    ssize_t ignored = write(scr_wake_pipe[1], "s", 1);
    (void)ignored; /* a full pipe still wakes the poller */
  }
  errno = saved_errno;
}

static void scr_sig_reg_drop(ScrSigReg *reg);

/* Half of the exit-time cleanup (registered by scr_events_install;
 * atexit LIFO puts it BEFORE the RC audit): releases signal listeners a
 * program legitimately leaves registered at exit — handlers installed for
 * the process's whole life (the long-lived CLI shape), like Node — so the audit
 * never mistakes them for leaks. */
static void scr_sig_cleanup(void) {
  while (scr_sig_regs) {
    ScrSigReg *reg = scr_sig_regs;
    for (size_t i = 0; i < reg->n; i++) {
      scr_dyn_release(reg->ls[i].cb);
      scr_str_release(reg->ls[i].name);
    }
    reg->n = 0;
    scr_sig_reg_drop(reg);
  }
}

static void scr_wake_pipe_init(void) {
#if defined(_WIN32) || defined(__wasi__)
  /* No self-pipe: the win32 loop never polls fds (scr_async.c's capped
   * nanosleep takes the idle sleep), so the handler's flag is the whole
   * wake path and the fds stay -1 — every pipe use below is guarded. */
  return;
#else
  if (scr_wake_pipe[0] >= 0) return;
  if (pipe(scr_wake_pipe) != 0) {
    scr_wake_pipe[0] = scr_wake_pipe[1] = -1;
    return; /* sleeps still wake via EINTR; only the tiny race widens */
  }
  for (int i = 0; i < 2; i++) {
    fcntl(scr_wake_pipe[i], F_SETFL, O_NONBLOCK);
    fcntl(scr_wake_pipe[i], F_SETFD, FD_CLOEXEC);
  }
#endif
}

static void scr_wake_pipe_drain(void) {
  if (scr_wake_pipe[0] < 0) return;
  char buf[64];
  while (read(scr_wake_pipe[0], buf, sizeof buf) > 0) {}
}

/* A computed process-event name is accepted here only for the signal
 * family. Other process-event families retain their explicit lowerings. */
static bool scr_signal_check(ScrStr *name, ScrDyn *cb) {
  if (cb->kind != SCR_DYN_FUNC) {
    const char *msg = "The \"listener\" argument must be of type function";
    scr_throw_error_msg_code(SCR_ERR_TYPE, msg, strlen(msg), "ERR_INVALID_ARG_TYPE");
    return false;
  }
  if (name->len < 3 || memcmp(name->data, "SIG", 3) != 0) {
    const char *msg = "scriptc: computed process event names currently support the SIG signal family";
    scr_throw_error_msg(SCR_ERR_ERROR, msg, strlen(msg));
    return false;
  }
  return true;
}

void scr_signal_on(ScrStr *name, ScrDyn *cb, bool once) {
  if (!scr_signal_check(name, cb)) return;
  if (!scr_context_is_main()) return;
#ifdef __wasi__
  (void)once;
  scr_trap("scriptc: internal error: OS signal surface reached on WASI\n");
#else
  int sig = scr_signal_from_name(name);
  if (sig < 0) sig = 0; /* e.g. SIGBREAK on POSIX: ordinary inert event */
  ScrSigReg *reg = scr_sig_regs;
  while (reg && reg->sig != sig) reg = reg->next;
  if (!reg) {
    reg = calloc(1, sizeof *reg);
    if (!reg) scr_events_oom();
    reg->sig = sig;
    if (sig > 0) {
      bool failed = sig >= SCR_SIG_MAX;
#ifdef _WIN32
      /* The Windows CRT rejects non-CRT signal numbers via its fatal
       * invalid-parameter handler. Keep these forms explicitly fenced. */
      if (sig != SIGINT && sig != SIGILL && sig != SIGABRT && sig != SIGFPE &&
          sig != SIGSEGV && sig != SIGTERM && sig != SIGBREAK) failed = true;
      if (!failed) {
        reg->prev = signal(sig, scr_sig_handler);
        failed = reg->prev == SIG_ERR;
      }
#else
      struct sigaction sa;
      memset(&sa, 0, sizeof sa);
      sa.sa_handler = scr_sig_handler;
      sigemptyset(&sa.sa_mask);
      if (!failed) failed = sigaction(sig, &sa, &reg->prev) != 0;
#endif
      if (failed) {
        free(reg);
        const char *msg = "uv_signal_start EINVAL";
        scr_throw_error_msg_code(SCR_ERR_ERROR, msg, strlen(msg), "EINVAL");
        return;
      }
      scr_sig_watched++;
      scr_wake_pipe_init();
    }
    reg->next = scr_sig_regs;
    scr_sig_regs = reg;
  }
  if (reg->n == reg->cap) {
    reg->cap = reg->cap ? reg->cap * 2 : 2;
    reg->ls = realloc(reg->ls, reg->cap * sizeof *reg->ls);
    if (!reg->ls) scr_events_oom();
  }
  reg->ls[reg->n++] = (ScrSigListener){scr_dyn_retain(cb), scr_str_retain(name), once, ++scr_sig_id};
#endif
}

static void scr_sig_reg_drop(ScrSigReg *reg) {
  if (reg->sig > 0) {
#ifdef _WIN32
    signal(reg->sig, reg->prev);
#elif !defined(__wasi__)
    sigaction(reg->sig, &reg->prev, NULL);
#endif
    scr_sig_watched--;
    scr_sig_flag[reg->sig] = 0;
  }
  ScrSigReg **link = &scr_sig_regs;
  while (*link != reg) link = &(*link)->next;
  *link = reg->next;
  free(reg->ls);
  free(reg);
}

static void scr_sig_remove(ScrSigReg *reg, size_t i) {
  scr_dyn_release(reg->ls[i].cb);
  scr_str_release(reg->ls[i].name);
  memmove(reg->ls + i, reg->ls + i + 1, (reg->n - i - 1) * sizeof *reg->ls);
  if (--reg->n == 0) scr_sig_reg_drop(reg);
}

void scr_signal_off(ScrStr *name, ScrDyn *cb) {
  if (!scr_signal_check(name, cb)) return;
  if (!scr_context_is_main()) return;
  int sig = scr_signal_from_name(name);
  if (sig < 0) sig = 0;
  ScrSigReg *reg = scr_sig_regs;
  while (reg && reg->sig != sig) reg = reg->next;
  if (!reg) return;
  /* EventEmitter removes the most recently registered matching listener. */
  for (size_t i = reg->n; i > 0; i--) {
    ScrSigListener *l = &reg->ls[i - 1];
    if (scr_str_eq(l->name, name) && scr_dyn_strict_eq(l->cb, cb)) {
      scr_sig_remove(reg, i - 1);
      return;
    }
  }
}

/* Snapshot all pending deliveries before invoking user code. No live
 * registry pointer survives a callback: off() can remove this signal or
 * another pending signal and free either registry. */
static void scr_signals_drain(void) {
  if (!scr_sig_any) return;
  scr_sig_any = 0;
  ScrSigListener *snap = NULL;
  size_t n = 0;
  for (ScrSigReg *reg = scr_sig_regs; reg; reg = reg->next) {
    if (reg->sig <= 0 || !scr_sig_flag[reg->sig]) continue;
    scr_sig_flag[reg->sig] = 0;
    snap = realloc(snap, (n + reg->n) * sizeof *snap);
    if (!snap) scr_events_oom();
    for (size_t i = 0; i < reg->n; i++) {
      snap[n] = reg->ls[i];
      scr_dyn_retain(snap[n].cb);
      scr_str_retain(snap[n].name);
      n++;
    }
  }
  for (size_t i = 0; i < n; i++) {
    if (!scr_exc_pending()) {
      if (snap[i].once) {
        for (ScrSigReg *reg = scr_sig_regs; reg; reg = reg->next) {
          bool found = false;
          for (size_t j = 0; j < reg->n; j++) {
            if (reg->ls[j].id == snap[i].id) {
              scr_sig_remove(reg, j);
              found = true;
              break;
            }
          }
          if (found) break;
        }
      }
      ScrDyn *args[2] = {scr_dyn_new_str(snap[i].name), scr_dyn_new_num(scr_signal_from_name(snap[i].name))};
      ScrDyn *result = scr_dyn_call(snap[i].cb, args, 2, "listener");
      scr_dyn_release(result);
      scr_dyn_release(args[0]);
      scr_dyn_release(args[1]);
    }
    scr_dyn_release(snap[i].cb);
    scr_str_release(snap[i].name);
  }
  free(snap);
}

/* ── process.stdin events and async iteration ─────────────────────────
 * The honest piped-stdin slice: 'data'/'end'/'error' listeners (on/once)
 * and the for-await chunk source. fd 0 is watched with poll(2) only
 * while a CONSUMER exists — a 'data' listener or a parked for-await
 * chunk promise — which is also the loop's keep-alive test: Node keeps
 * the process alive for a flowing stdin and lets it exit once nothing
 * consumes. One poll wake = one read(2) = one chunk (up to 64KB, like
 * libuv's pipe reads); EOF fires 'end' (once semantics respected),
 * settles a parked chunk promise with the EMPTY sentinel, and drops the
 * remaining listeners — after 'end' nothing fires again. destroy()
 * tears everything down the same way (Node's destroyed stream delivers
 * nothing more; a for-await running at destroy time ends instead of
 * throwing Node's premature-close error — documented divergence). A
 * read(2) failure fires 'error' listeners (the Error is built by the
 * child err adapters — same shape) and then ends the stream; with no
 * listener it is treated as EOF (piped fd 0 read errors are not
 * meaningfully reachable). */

typedef struct {
  ScrClosure *cb; /* owned */
  void (*fn)(ScrClosure *cb, ScrBytes *chunk); /* adapter: chunk borrowed */
  bool once;
} ScrStdinDataL;

typedef struct {
  ScrClosure *cb; /* owned */
  bool once;
} ScrStdinEndL;

typedef struct {
  ScrClosure *cb; /* owned */
  ScrChildErrFn fn; /* the child error adapters fit exactly */
  bool once;
} ScrStdinErrL;

static SCR_TL ScrStdinDataL *scr_stdin_data = NULL;
static SCR_TL size_t scr_stdin_ndata = 0, scr_stdin_data_cap = 0;
static SCR_TL ScrStdinEndL *scr_stdin_end = NULL;
static SCR_TL size_t scr_stdin_nend = 0, scr_stdin_end_cap = 0;
static SCR_TL ScrStdinErrL *scr_stdin_err = NULL;
static SCR_TL size_t scr_stdin_nerr = 0, scr_stdin_err_cap = 0;
static SCR_TL ScrPromise *scr_stdin_waiter = NULL; /* parked for-await next() */
static SCR_TL bool scr_stdin_eof = false;
static SCR_TL bool scr_stdin_destroyed = false;
static SCR_TL bool scr_stdin_paused = false;
static SCR_TL bool scr_stdin_resumed = false;
static SCR_TL bool scr_stdin_read_eof = false;
static SCR_TL ScrBytes *scr_stdin_buffer;
static SCR_TL size_t scr_stdin_read_demand;

void scr_stdin_on_data(ScrClosure *cb /*moves*/, void (*fn)(ScrClosure *, ScrBytes *),
                        bool once) {
  if (scr_stdin_eof || scr_stdin_destroyed) {
    scr_closure_release(cb); /* never fires again, like Node post-'end' */
    return;
  }
  if (scr_stdin_ndata == scr_stdin_data_cap) {
    scr_stdin_data_cap = scr_stdin_data_cap ? scr_stdin_data_cap * 2 : 2;
    scr_stdin_data = realloc(scr_stdin_data, scr_stdin_data_cap * sizeof *scr_stdin_data);
    if (!scr_stdin_data) scr_events_oom();
  }
  scr_stdin_data[scr_stdin_ndata].cb = cb;
  scr_stdin_data[scr_stdin_ndata].fn = fn;
  scr_stdin_data[scr_stdin_ndata].once = once;
  scr_stdin_ndata++;
}

void scr_stdin_on_end(ScrClosure *cb /*moves*/, bool once) {
  if (scr_stdin_eof || scr_stdin_destroyed) {
    scr_closure_release(cb);
    return;
  }
  if (scr_stdin_nend == scr_stdin_end_cap) {
    scr_stdin_end_cap = scr_stdin_end_cap ? scr_stdin_end_cap * 2 : 2;
    scr_stdin_end = realloc(scr_stdin_end, scr_stdin_end_cap * sizeof *scr_stdin_end);
    if (!scr_stdin_end) scr_events_oom();
  }
  scr_stdin_end[scr_stdin_nend].cb = cb;
  scr_stdin_end[scr_stdin_nend].once = once;
  scr_stdin_nend++;
}

void scr_stdin_on_error(ScrClosure *cb /*moves*/, ScrChildErrFn fn, bool once) {
  if (scr_stdin_eof || scr_stdin_destroyed) {
    scr_closure_release(cb);
    return;
  }
  if (scr_stdin_nerr == scr_stdin_err_cap) {
    scr_stdin_err_cap = scr_stdin_err_cap ? scr_stdin_err_cap * 2 : 2;
    scr_stdin_err = realloc(scr_stdin_err, scr_stdin_err_cap * sizeof *scr_stdin_err);
    if (!scr_stdin_err) scr_events_oom();
  }
  scr_stdin_err[scr_stdin_nerr].cb = cb;
  scr_stdin_err[scr_stdin_nerr].fn = fn;
  scr_stdin_err[scr_stdin_nerr].once = once;
  scr_stdin_nerr++;
}

/* Removal by closure identity — node:readline's close() detaches its
 * shared consumer so the loop stops waiting on fd 0 (Node's
 * pause-on-close). Safe mid-dispatch: the service pass runs over a
 * snapshot, exactly like the once-removal. No-op for unknown closures. */
void scr_stdin_remove_data(ScrClosure *cb) {
  for (size_t j = 0; j < scr_stdin_ndata; j++) {
    if (scr_stdin_data[j].cb == cb) {
      scr_closure_release(scr_stdin_data[j].cb);
      memmove(scr_stdin_data + j, scr_stdin_data + j + 1,
              (scr_stdin_ndata - j - 1) * sizeof *scr_stdin_data);
      scr_stdin_ndata--;
      return;
    }
  }
}

/* True once the stream can never deliver again (EOF seen, or destroyed) —
 * node:readline's created-after-the-end probe. */
bool scr_stdin_ended(void) { return scr_stdin_eof || scr_stdin_destroyed; }

/* The loop keep-alive/watch predicate: a consumer exists and the stream
 * can still deliver. 'end'/'error' listeners alone do not keep the loop
 * alive (a paused Node stdin with only those never flows — the process
 * exits with them registered). */
static bool scr_stdin_watching(void) {
  return !scr_stdin_eof && !scr_stdin_destroyed &&
         ((!scr_stdin_paused && (scr_stdin_ndata > 0 || scr_stdin_resumed)) ||
          scr_stdin_waiter != NULL ||
          (!scr_stdin_read_eof && scr_stdin_read_demand > (scr_stdin_buffer ? scr_stdin_buffer->len : 0)));
}

bool scr_stdin_pending(void) { return scr_stdin_watching(); }

static void scr_stdin_drop_listeners(void) {
  for (size_t i = 0; i < scr_stdin_ndata; i++) scr_closure_release(scr_stdin_data[i].cb);
  for (size_t i = 0; i < scr_stdin_nend; i++) scr_closure_release(scr_stdin_end[i].cb);
  for (size_t i = 0; i < scr_stdin_nerr; i++) scr_closure_release(scr_stdin_err[i].cb);
  free(scr_stdin_data);
  free(scr_stdin_end);
  free(scr_stdin_err);
  scr_stdin_data = NULL;
  scr_stdin_end = NULL;
  scr_stdin_err = NULL;
  scr_stdin_ndata = scr_stdin_nend = scr_stdin_nerr = 0;
  scr_stdin_data_cap = scr_stdin_end_cap = scr_stdin_err_cap = 0;
}

/* Settles the parked for-await promise with the empty DONE sentinel (a
 * POSIX read never delivers an empty data chunk, so the sentinel cannot
 * collide with real data). */
static void scr_stdin_settle_done(void) {
  if (!scr_stdin_waiter) return;
  ScrPromise *p = scr_stdin_waiter;
  scr_stdin_waiter = NULL;
  ScrBytes *empty = scr_bytes_new(SCR_BYTES_U8, 0);
  scr_promise_fulfill_ref(p, empty, scr_bytes_retain_v, scr_bytes_release_v, NULL);
  scr_promise_release(p);
}

/* EOF/teardown shared tail: 'end' fires (snapshot; once semantics are
 * moot — everything drops right after), the parked promise settles done,
 * and every listener is released. */
static void scr_stdin_finish(bool fire_end) {
  scr_stdin_eof = true;
  if (fire_end) {
    size_t n = scr_stdin_nend;
    ScrStdinEndL *snap = malloc(n * sizeof *snap);
    if (!snap) scr_events_oom();
    for (size_t i = 0; i < n; i++) {
      snap[i] = scr_stdin_end[i];
      scr_closure_retain(snap[i].cb);
    }
    for (size_t i = 0; i < n; i++) {
      if (!scr_exc_pending()) {
        ((void (*)(ScrClosure *))snap[i].cb->fn)(snap[i].cb);
      }
      scr_closure_release(snap[i].cb);
    }
    free(snap);
  }
  scr_stdin_settle_done();
  scr_stdin_drop_listeners();
}

/* process.stdin.destroy(): tear the stream down — nothing fires after,
 * the loop stops watching, and a parked for-await ends. */
void scr_stdin_destroy(void) {
  if (scr_stdin_destroyed) return;
  scr_stdin_destroyed = true;
  scr_bytes_release(scr_stdin_buffer);
  scr_stdin_buffer = NULL;
  scr_stdin_read_demand = 0;
  scr_stdin_settle_done();
  scr_stdin_drop_listeners();
}

/* The for-await chunk source: a +1 promise of the NEXT chunk (fulfilled
 * from the poll wake), or of the empty done sentinel at EOF/teardown.
 * One parked promise at a time — concurrent iterations of process.stdin
 * would share deliveries (nothing real does this). */
ScrPromise *scr_stdin_next_chunk(void) {
  if (scr_stdin_eof || scr_stdin_destroyed) {
    ScrPromise *p = scr_promise_new();
    ScrBytes *empty = scr_bytes_new(SCR_BYTES_U8, 0);
    scr_promise_fulfill_ref(p, empty, scr_bytes_retain_v, scr_bytes_release_v, NULL);
    return p;
  }
  if (!scr_stdin_waiter) scr_stdin_waiter = scr_promise_new();
  return scr_promise_retain(scr_stdin_waiter);
}

/* One service pass, called at loop turns while watching: a zero-timeout
 * poll probes readability (the idle sleep already waited on fd 0), one
 * read(2) takes what arrived, and the chunk goes to the 'data' listeners
 * (snapshot; `once` entries leave the live list before running) — or,
 * with no listener, to the parked for-await promise. Node's stream would
 * buffer a chunk nobody consumes; this slice never reads without a
 * consumer, so the pipe itself is the buffer (backpressure, not loss). */
static void scr_stdin_deliver(ScrBytes *chunk);

static void scr_stdin_service(void) {
  if (!scr_stdin_watching()) return;
  if (!scr_stdin_paused && scr_stdin_buffer) {
    ScrBytes *chunk = scr_stdin_buffer;
    scr_stdin_buffer = NULL;
    scr_stdin_deliver(chunk);
    scr_bytes_release(chunk);
    return;
  }
  if (scr_stdin_read_eof) {
    if (!scr_stdin_buffer) scr_stdin_finish(true);
    return;
  }
#ifdef _WIN32
  /* The poll(2)-probe's win32 spelling, by handle type: a PIPE (the
   * harness/ssh shape) answers PeekNamedPipe — bytes available, or a
   * FALSE return once the writer closed (broken pipe), where read(2)
   * below delivers the EOF; a CONSOLE answers a zero-timeout wait on the
   * input handle (cooked mode — a read may still block until Enter, the
   * interactive line-buffering Node's cooked stdin shows too); disk
   * files are always readable. A missing handle falls through to read,
   * whose 0/-1 ends the stream. */
  HANDLE h = GetStdHandle(STD_INPUT_HANDLE);
  if (h != NULL && h != INVALID_HANDLE_VALUE) {
    DWORD type = GetFileType(h);
    if (type == FILE_TYPE_PIPE) {
      DWORD avail = 0;
      if (PeekNamedPipe(h, NULL, 0, NULL, &avail, NULL) && avail == 0) return;
    } else if (type == FILE_TYPE_CHAR) {
      if (WaitForSingleObject(h, 0) != WAIT_OBJECT_0) return;
    }
  }
#elif defined(__wasi__)
  /* install() puts fd 0 in nonblocking mode, so a direct read is both the
   * readiness probe and the operation. This also observes a closed pipe on
   * WASI hosts whose poll_oneoff adapter does not report POLLHUP. */
#else
  struct pollfd pfd = {0 /* stdin */, POLLIN, 0};
  int rc = poll(&pfd, 1, 0);
  if (rc <= 0 || !(pfd.revents & (POLLIN | POLLHUP | POLLERR))) return;
#endif
  char buf[65536];
  ssize_t n = read(0, buf, sizeof buf);
  if (n < 0) {
    if (errno == EINTR || errno == EAGAIN) return;
    /* Real read failure: 'error' listeners get Node's Error shape via the
     * child adapters; the stream then ends silently (no 'end' after
     * 'error', like Node). No listener: treated as EOF. */
    if (scr_stdin_nerr > 0) {
      char msg[64];
      snprintf(msg, sizeof msg, "read E%d", errno);
      ScrStr *m = scr_str_new(msg, strlen(msg));
      size_t nl = scr_stdin_nerr;
      ScrStdinErrL *snap = malloc(nl * sizeof *snap);
      if (!snap) scr_events_oom();
      for (size_t i = 0; i < nl; i++) {
        snap[i] = scr_stdin_err[i];
        scr_closure_retain(snap[i].cb);
      }
      for (size_t i = 0; i < nl; i++) {
        if (!scr_exc_pending()) snap[i].fn(snap[i].cb, m);
        scr_closure_release(snap[i].cb);
      }
      free(snap);
      scr_str_release(m);
      scr_stdin_finish(false);
    } else {
      scr_stdin_finish(true);
    }
    return;
  }
  if (n == 0) {
    scr_stdin_read_eof = true;
    if (!scr_stdin_buffer) scr_stdin_finish(true);
    return;
  }
  ScrBytes *chunk = scr_bytes_new(SCR_BYTES_U8, (double)n);
  memcpy(chunk->data, buf, (size_t)n);
  if (scr_stdin_paused || (!scr_stdin_ndata && !scr_stdin_resumed && !scr_stdin_waiter)) {
    if (scr_stdin_buffer) {
      size_t before = scr_stdin_buffer->len;
      ScrBytes *joined = scr_bytes_new(SCR_BYTES_U8, (double)(before + (size_t)n));
      memcpy(joined->data, scr_stdin_buffer->data, before);
      memcpy(joined->data + before, buf, (size_t)n);
      scr_bytes_release(scr_stdin_buffer);
      scr_bytes_release(chunk);
      scr_stdin_buffer = joined;
    } else scr_stdin_buffer = chunk;
    return;
  }
  scr_stdin_deliver(chunk);
  scr_bytes_release(chunk);
}

static void scr_stdin_deliver(ScrBytes *chunk) {
  if (scr_stdin_ndata > 0) {
    size_t nd = scr_stdin_ndata;
    ScrStdinDataL *snap = malloc(nd * sizeof *snap);
    if (!snap) scr_events_oom();
    for (size_t i = 0; i < nd; i++) {
      snap[i] = scr_stdin_data[i];
      scr_closure_retain(snap[i].cb);
    }
    for (size_t i = 0; i < nd; i++) {
      if (snap[i].once) {
        for (size_t j = 0; j < scr_stdin_ndata; j++) {
          if (scr_stdin_data[j].cb == snap[i].cb) {
            scr_closure_release(scr_stdin_data[j].cb);
            memmove(scr_stdin_data + j, scr_stdin_data + j + 1,
                    (scr_stdin_ndata - j - 1) * sizeof *scr_stdin_data);
            scr_stdin_ndata--;
            break;
          }
        }
      }
      if (!scr_exc_pending()) snap[i].fn(snap[i].cb, chunk);
      scr_closure_release(snap[i].cb);
    }
    free(snap);
  } else if (scr_stdin_waiter) {
    ScrPromise *p = scr_stdin_waiter;
    scr_stdin_waiter = NULL;
    scr_promise_fulfill_ref(p, scr_bytes_retain(chunk), scr_bytes_retain_v,
                             scr_bytes_release_v, NULL);
    scr_promise_release(p);
  }
}

/* First-class process streams share the same fd identities and input loop
 * as direct process calls. Their method values are native closures, so a
 * saved write method can be invoked with .call after write is replaced. */
typedef struct {
  int fd;
  ScrDyn *write;
  ScrDyn **errors;
  bool *error_once;
  size_t nerrors;
  ScrDyn *write_error;
} ScrStdio;

static SCR_TL ScrStdio scr_stdio_streams[3] = {{.fd = 0}, {.fd = 1}, {.fd = 2}};
enum { STDIO_WRITE, STDIO_ON, STDIO_ONCE, STDIO_OFF, STDIO_PAUSE, STDIO_RESUME,
       STDIO_IS_PAUSED, STDIO_READ, STDIO_RAW, STDIO_DESTROY, STDIO_WINDOW_SIZE, STDIO_METHOD_COUNT };
static const char *const scr_stdio_names[] = {
  "write", "on", "once", "removeListener", "pause", "resume", "isPaused", "read", "setRawMode", "destroy", "getWindowSize"
};
static SCR_TL ScrDyn *scr_stdio_methods[STDIO_METHOD_COUNT];
static SCR_TL bool scr_stdio_initialized;
static SCR_TL bool scr_stdio_raw;

static ScrDyn *scr_stdio_refusal(const char *name) {
  char message[192];
  int length = snprintf(message, sizeof message, "Native process stream %s has no lowering [SC2020]", name);
  scr_throw_error_msg_code(SCR_ERR_ERROR, message, (size_t)length, "SC2020");
  return NULL;
}

static ScrDyn *scr_stdio_listener(ScrClosure *cb) { return scr_box_get_ref(cb->caps[0]); }

static void scr_stdio_fire(ScrClosure *cb, ScrDyn *arg, size_t argc) {
  ScrDyn *fn = scr_stdio_listener(cb);
  scr_dyn_this_push(&scr_stdio_streams[0], SCR_DYNH_STDIO);
  ScrDyn *result = scr_dyn_call(fn, &arg, argc, "stdin listener");
  scr_dyn_this_pop();
  scr_dyn_release(result);
  scr_dyn_release(fn);
}

static void scr_stdio_data(ScrClosure *cb, ScrBytes *bytes) {
  ScrDyn *chunk = scr_dyn_new_chunk(bytes);
  scr_stdio_fire(cb, chunk, 1);
  scr_dyn_release(chunk);
}
static void scr_stdio_end(ScrClosure *cb) { scr_stdio_fire(cb, NULL, 0); }
static void scr_stdio_error(ScrClosure *cb, ScrStr *message) {
  ScrError *error = scr_error_new(SCR_ERR_ERROR, message);
  ScrDyn *arg = scr_dyn_from_error(error);
  scr_error_release(error);
  scr_stdio_fire(cb, arg, 1);
  scr_dyn_release(arg);
}

static ScrClosure *scr_stdio_callback(ScrDyn *fn, void *fire) {
  ScrClosure *cb = scr_closure_new(fire, 1);
  cb->caps[0] = scr_box_new_obj(scr_dyn_retain_v, scr_dyn_release_v, scr_dyn_trace_v);
  scr_box_set_ref(cb->caps[0], scr_dyn_retain(fn));
  return cb;
}

static bool scr_stdio_matches(ScrClosure *cb, void *fire, ScrDyn *fn) {
  if (cb->fn != fire) return false;
  ScrDyn *registered = scr_stdio_listener(cb);
  bool matches = scr_dyn_strict_eq(registered, fn);
  scr_dyn_release(registered);
  return matches;
}

static void scr_stdio_write_done(ScrClosure *cb) {
  ScrDyn *fn = scr_stdio_listener(cb);
  ScrDyn *arg = scr_dyn_new_null();
  ScrDyn *result = scr_dyn_call(fn, &arg, 1, "write callback");
  scr_dyn_release(result);
  scr_dyn_release(fn);
  scr_dyn_release(arg);
}

static void scr_stdio_write_failed(ScrClosure *cb) {
  ScrDyn *callback = scr_box_get_ref(cb->caps[0]);
  ScrDyn *error = scr_box_get_ref(cb->caps[1]);
  ScrStdio *stream = &scr_stdio_streams[(int)scr_box_get_f64(cb->caps[2])];
  if (callback->kind == SCR_DYN_FUNC) {
    ScrDyn *result = scr_dyn_call(callback, &error, 1, "write callback");
    scr_dyn_release(result);
  }
  if (!scr_exc_pending()) {
    size_t count = stream->nerrors;
    ScrDyn **listeners = count ? malloc(count * sizeof *listeners) : NULL;
    if (count && !listeners) scr_events_oom();
    size_t kept = 0;
    for (size_t i = 0; i < count; i++) {
      listeners[i] = scr_dyn_retain(stream->errors[i]);
      if (stream->error_once[i]) scr_dyn_release(stream->errors[i]);
      else {
        stream->errors[kept] = stream->errors[i];
        stream->error_once[kept++] = false;
      }
    }
    stream->nerrors = kept;
    if (!count) scr_throw_ref(scr_dyn_retain(error), scr_dyn_retain_v, scr_dyn_release_v, scr_dyn_trace_v);
    for (size_t i = 0; i < count; i++) {
      if (!scr_exc_pending()) {
        scr_dyn_this_push(stream, SCR_DYNH_STDIO);
        ScrDyn *result = scr_dyn_call(listeners[i], &error, 1, "error listener");
        scr_dyn_this_pop();
        scr_dyn_release(result);
      }
      scr_dyn_release(listeners[i]);
    }
    free(listeners);
  }
  scr_dyn_release(callback);
  scr_dyn_release(error);
}

static void scr_stdio_queue_write_error(ScrStdio *stream, ScrDyn *callback, int code) {
  if (!stream->write_error) {
    const char *name = code == EPIPE ? "EPIPE" : code == EBADF ? "EBADF" : "EIO";
    char message[64];
    int length = snprintf(message, sizeof message, "write %s", name);
    ScrStr *text = scr_str_new(message, (size_t)length);
    ScrError *error = scr_error_new(SCR_ERR_ERROR, text);
    scr_str_release(text);
    scr_error_set_code(error, name);
    stream->write_error = scr_dyn_from_error(error);
    scr_error_release(error);
  }
  ScrClosure *cb = scr_closure_new((void *)scr_stdio_write_failed, 3);
  cb->caps[0] = scr_box_new_obj(scr_dyn_retain_v, scr_dyn_release_v, scr_dyn_trace_v);
  scr_box_set_ref(cb->caps[0], scr_dyn_retain(callback));
  cb->caps[1] = scr_box_new_obj(scr_dyn_retain_v, scr_dyn_release_v, scr_dyn_trace_v);
  scr_box_set_ref(cb->caps[1], scr_dyn_retain(stream->write_error));
  cb->caps[2] = scr_box_new(SCR_BOX_F64);
  scr_box_set_f64(cb->caps[2], stream->fd);
  scr_next_tick(cb);
}

static void scr_stdio_finish_read(void) {
  if (scr_stdin_read_eof && !scr_stdin_buffer && !scr_stdin_eof && !scr_stdin_destroyed)
    scr_stdin_finish(true);
}

static ScrDyn *scr_stdio_read(ScrDyn *size) {
  bool all = size->kind == SCR_DYN_UNDEF;
  if (!all && (size->kind != SCR_DYN_NUM || !isfinite(size->v.num) ||
      size->v.num < 0 || size->v.num > 1073741824 || floor(size->v.num) != size->v.num))
    return scr_stdio_refusal("read size");
  size_t available = scr_stdin_buffer ? scr_stdin_buffer->len : 0;
  size_t wanted = all ? available : (size_t)size->v.num;
  if (scr_stdin_read_eof && wanted > available) wanted = available;
  if (wanted == 0 || wanted > available) {
    if (!scr_stdin_eof && !scr_stdin_destroyed) {
      scr_stdin_read_demand = wanted > 65536 ? wanted : 65536;
      if (scr_stdin_read_eof) scr_next_tick_raw(scr_stdio_finish_read);
    }
    return scr_dyn_new_null();
  }
  ScrBytes *chunk = scr_bytes_slice(scr_stdin_buffer, 0, (double)wanted);
  ScrBytes *rest = wanted < available ? scr_bytes_slice(scr_stdin_buffer, (double)wanted, (double)available) : NULL;
  scr_bytes_release(scr_stdin_buffer);
  scr_stdin_buffer = rest;
  scr_stdin_read_demand = 65536;
  scr_stdin_deliver(chunk);
  ScrDyn *result = scr_dyn_new_chunk(chunk);
  scr_bytes_release(chunk);
  if (scr_stdin_read_eof && !rest) scr_next_tick_raw(scr_stdio_finish_read);
  return result;
}

static ScrDyn *scr_stdio_method(ScrClosure *cb, ScrDyn *const *args, size_t argc) {
  int method = (int)scr_box_get_f64(cb->caps[0]);
  ScrDyn *self = scr_dyn_this_get();
  if (self->kind != SCR_DYN_HANDLE || self->v.handle.tag != SCR_DYNH_STDIO) {
    scr_dyn_release(self);
    return scr_stdio_refusal("method receiver");
  }
  ScrStdio *stream = self->v.handle.ptr;
  ScrDyn *arg = argc ? args[0] : scr_dyn_undefined();
  ScrDyn *result = NULL;
  if (method == STDIO_WINDOW_SIZE && stream->fd != 0) {
    result = scr_dyn_new_arr();
    ScrDyn *columns = scr_dyn_new_num(scr_process_columns(stream->fd));
    ScrDyn *rows = scr_dyn_new_num(scr_process_rows(stream->fd));
    scr_dyn_arr_push(result, columns);
    scr_dyn_arr_push(result, rows);
  } else if (method == STDIO_WRITE && stream->fd != 0) {
    ScrDyn *encoding = argc > 1 ? args[1] : scr_dyn_undefined();
    ScrDyn *callback = argc > 2 ? args[2] : scr_dyn_undefined();
    if (encoding->kind == SCR_DYN_FUNC) { callback = encoding; encoding = scr_dyn_undefined(); }
    if (callback->kind != SCR_DYN_UNDEF && callback->kind != SCR_DYN_NULL && callback->kind != SCR_DYN_FUNC) {
      scr_dyn_arg_type_fail("cb", "of type function", callback);
      goto done;
    }
    ScrBytes *bytes = NULL;
    if (arg->kind == SCR_DYN_STR) {
      if (encoding->kind != SCR_DYN_UNDEF && encoding->kind != SCR_DYN_NULL && encoding->kind != SCR_DYN_STR) {
        result = scr_stdio_refusal("write encoding");
        goto done;
      }
      ScrStr *enc = encoding->kind == SCR_DYN_STR ? scr_str_retain(encoding->v.str) : scr_str_new("utf8", 4);
      bytes = scr_bytes_from_str(arg->v.str, enc);
      scr_str_release(enc);
    } else if (arg->kind == SCR_DYN_BYTES && arg->v.bytes->elem == SCR_BYTES_U8) {
      bytes = arg->v.bytes->shared ? scr_bytes_copy(arg->v.bytes) : scr_bytes_retain(arg->v.bytes);
    } else {
      scr_dyn_arg_type_fail("chunk", "of type string or an instance of Buffer, TypedArray, or DataView", arg);
      goto done;
    }
    if (!bytes) goto done;
    int error = scr_stdio_write_raw(stream->fd, bytes->data, bytes->len);
    scr_bytes_release(bytes);
    if (error) {
      scr_stdio_queue_write_error(stream, callback, error);
      result = scr_dyn_new_bool(false);
      goto done;
    }
    if (callback->kind == SCR_DYN_FUNC) scr_next_tick(scr_stdio_callback(callback, (void *)scr_stdio_write_done));
    result = scr_dyn_new_bool(true);
  } else if (method == STDIO_ON || method == STDIO_ONCE || method == STDIO_OFF) {
    ScrDyn *listener = argc > 1 ? args[1] : scr_dyn_undefined();
    if (listener->kind != SCR_DYN_FUNC) {
      scr_dyn_arg_type_fail("listener", "of type function", listener);
      goto done;
    }
    const char *event = arg->kind == SCR_DYN_STR ? arg->v.str->data : "";
    bool data = arg->kind == SCR_DYN_STR && arg->v.str->len == 4 && memcmp(event, "data", 4) == 0;
    bool end = arg->kind == SCR_DYN_STR && arg->v.str->len == 3 && memcmp(event, "end", 3) == 0;
    bool error = arg->kind == SCR_DYN_STR && arg->v.str->len == 5 && memcmp(event, "error", 5) == 0;
    if ((!data && !end && !error) || (stream->fd != 0 && !error)) {
      result = scr_stdio_refusal("event");
      goto done;
    }
    bool remove = method == STDIO_OFF, once = method == STDIO_ONCE;
    if (stream->fd == 0) {
      if (!remove) {
        if (data) scr_stdin_on_data(scr_stdio_callback(listener, (void *)scr_stdio_data), scr_stdio_data, once);
        if (end) scr_stdin_on_end(scr_stdio_callback(listener, (void *)scr_stdio_end), once);
        if (error) scr_stdin_on_error(scr_stdio_callback(listener, (void *)scr_stdio_error), scr_stdio_error, once);
      } else {
#define REMOVE_STDIO_LISTENER(list, count, fire) \
        for (size_t i = count; i > 0; i--) { \
          if (scr_stdio_matches(list[i - 1].cb, (void *)fire, listener)) { \
            scr_closure_release(list[i - 1].cb); \
            memmove(list + i - 1, list + i, (count - i) * sizeof *list); \
            count--; break; \
          } \
        }
        if (data) { REMOVE_STDIO_LISTENER(scr_stdin_data, scr_stdin_ndata, scr_stdio_data); }
        if (end) { REMOVE_STDIO_LISTENER(scr_stdin_end, scr_stdin_nend, scr_stdio_end); }
        if (error) { REMOVE_STDIO_LISTENER(scr_stdin_err, scr_stdin_nerr, scr_stdio_error); }
#undef REMOVE_STDIO_LISTENER
      }
    } else if (remove) {
      for (size_t i = stream->nerrors; i > 0; i--) {
        if (scr_dyn_strict_eq(stream->errors[i - 1], listener)) {
          scr_dyn_release(stream->errors[i - 1]);
          memmove(stream->errors + i - 1, stream->errors + i, (stream->nerrors - i) * sizeof *stream->errors);
          memmove(stream->error_once + i - 1, stream->error_once + i, (stream->nerrors - i) * sizeof *stream->error_once);
          stream->nerrors--; break;
        }
      }
    } else {
      stream->errors = realloc(stream->errors, (stream->nerrors + 1) * sizeof *stream->errors);
      stream->error_once = realloc(stream->error_once, (stream->nerrors + 1) * sizeof *stream->error_once);
      if (!stream->errors || !stream->error_once) scr_events_oom();
      stream->errors[stream->nerrors] = scr_dyn_retain(listener);
      stream->error_once[stream->nerrors++] = once;
    }
    result = scr_dyn_retain(self);
  } else if (stream->fd == 0 && (method == STDIO_PAUSE || method == STDIO_RESUME)) {
    scr_stdin_paused = method == STDIO_PAUSE;
    scr_stdin_resumed = method == STDIO_RESUME;
    result = scr_dyn_retain(self);
  } else if (stream->fd == 0 && method == STDIO_IS_PAUSED) {
    result = scr_dyn_new_bool(scr_stdin_paused);
  } else if (stream->fd == 0 && method == STDIO_READ) {
    result = scr_stdio_read(arg);
  } else if (stream->fd == 0 && method == STDIO_RAW) {
    scr_process_stdin_set_raw_mode(scr_dyn_truthy(arg));
    if (!scr_exc_pending()) { scr_stdio_raw = scr_dyn_truthy(arg); result = scr_dyn_retain(self); }
  } else if (stream->fd == 0 && method == STDIO_DESTROY && argc == 0) {
    scr_stdin_destroy();
    result = scr_dyn_retain(self);
  } else result = scr_stdio_refusal(scr_stdio_names[method]);
done:
  scr_dyn_release(self);
  return result;
}

static ScrDyn *scr_stdio_get(void *ptr, const char *key, size_t length) {
  ScrStdio *stream = ptr;
  if (length == 2 && memcmp(key, "fd", 2) == 0) return scr_dyn_new_num(stream->fd);
  if (length == 5 && memcmp(key, "isTTY", 5) == 0)
    return scr_process_is_tty(stream->fd) ? scr_dyn_new_bool(true) : scr_dyn_retain(scr_dyn_undefined());
  if ((length == 7 && memcmp(key, "columns", 7) == 0) || (length == 4 && memcmp(key, "rows", 4) == 0)) {
    double dimension = stream->fd == 0 ? -1 : length == 7 ? scr_process_columns(stream->fd) : scr_process_rows(stream->fd);
    return dimension < 0 ? scr_dyn_retain(scr_dyn_undefined()) : scr_dyn_new_num(dimension);
  }
  if (stream->fd == 0 && length == 14 && memcmp(key, "readableLength", 14) == 0)
    return scr_dyn_new_num(scr_stdin_buffer ? (double)scr_stdin_buffer->len : 0);
  if (stream->fd == 0 && length == 5 && memcmp(key, "isRaw", 5) == 0)
    return scr_process_is_tty(0) ? scr_dyn_new_bool(scr_stdio_raw) : scr_dyn_retain(scr_dyn_undefined());
  if (stream->fd == 0 && length == 9 && memcmp(key, "destroyed", 9) == 0) return scr_dyn_new_bool(scr_stdin_destroyed);
  if (length == 3 && memcmp(key, "off", 3) == 0) return scr_dyn_retain(scr_stdio_methods[STDIO_OFF]);
  if (length == 11 && memcmp(key, "addListener", 11) == 0) return scr_dyn_retain(scr_stdio_methods[STDIO_ON]);
  for (int i = 0; i < STDIO_METHOD_COUNT; i++) {
    if (strlen(scr_stdio_names[i]) != length || memcmp(key, scr_stdio_names[i], length) != 0) continue;
    if (i == STDIO_WINDOW_SIZE) return stream->fd != 0 && scr_process_is_tty(stream->fd) ? scr_dyn_retain(scr_stdio_methods[i]) : NULL;
    if (i == STDIO_WRITE) return stream->fd == 0 ? NULL : scr_dyn_retain(stream->write ? stream->write : scr_stdio_methods[i]);
    if (i == STDIO_RAW && !scr_process_is_tty(stream->fd)) return NULL;
    if (i >= STDIO_PAUSE && stream->fd != 0) return scr_stdio_refusal(scr_stdio_names[i]);
    return scr_dyn_retain(scr_stdio_methods[i]);
  }
  return NULL;
}

static bool scr_stdio_set(void *ptr, const char *key, size_t length, const ScrDyn *value) {
  ScrStdio *stream = ptr;
  if (stream->fd == 0 || length != 5 || memcmp(key, "write", 5) != 0) return false;
  ScrDyn *old = stream->write;
  stream->write = scr_dyn_retain((ScrDyn *)value);
  scr_dyn_release(old);
  return true;
}

static ScrDyn *scr_stdio_invoke(void *ptr, ScrDyn *self, const char *name,
                               ScrDyn *const *args, size_t argc, const char *what) {
  ScrDyn *fn = scr_stdio_get(ptr, name, strlen(name));
  if (scr_exc_pending()) return NULL;
  scr_dyn_this_push_dyn(self);
  ScrDyn *result = scr_dyn_call(fn ? fn : scr_dyn_undefined(), args, argc, what);
  scr_dyn_this_pop();
  scr_dyn_release(fn);
  return result;
}

static bool scr_stdio_intercept(int fd, const void *data, size_t length) {
  ScrStdio *stream = &scr_stdio_streams[fd == 2 ? 2 : 1];
  if (!stream->write || scr_dyn_strict_eq(stream->write, scr_stdio_methods[STDIO_WRITE])) {
    (void)scr_stdio_write_raw(fd, data, length);
    return true;
  }
  ScrStr *text = scr_str_new(data, length);
  ScrDyn *chunk = scr_dyn_new_str(text);
  scr_str_release(text);
  scr_dyn_this_push(stream, SCR_DYNH_STDIO);
  ScrDyn *fn = scr_dyn_retain(stream->write);
  ScrDyn *result = scr_dyn_call(fn, &chunk, 1, "write");
  scr_dyn_release(fn);
  scr_dyn_this_pop();
  bool accepted = result && scr_dyn_truthy(result);
  scr_dyn_release(result);
  scr_dyn_release(chunk);
  return accepted;
}

static void scr_stdio_cleanup(void) {
  scr_stdio_write_hook = NULL;
  for (int i = 0; i < 3; i++) {
    ScrStdio *stream = &scr_stdio_streams[i];
    scr_weak_dispose(stream);
    scr_dyn_release(stream->write);
    stream->write = NULL;
    scr_dyn_release(stream->write_error);
    stream->write_error = NULL;
    for (size_t j = 0; j < stream->nerrors; j++) scr_dyn_release(stream->errors[j]);
    free(stream->errors); free(stream->error_once);
    stream->errors = NULL; stream->error_once = NULL; stream->nerrors = 0;
  }
  for (int i = 0; i < STDIO_METHOD_COUNT; i++) {
    scr_dyn_release(scr_stdio_methods[i]);
    scr_stdio_methods[i] = NULL;
  }
  scr_stdio_initialized = false;
}

static void *scr_stdio_retain(void *ptr) { return ptr; }
static void scr_stdio_release(void *ptr) { (void)ptr; }

ScrDyn *scr_process_stdio(double fd) {
  if (!scr_stdio_initialized) {
    scr_stdio_initialized = true;
    static const ScrDynHandleOps ops = {
      .cls = "ProcessStream", .retain = scr_stdio_retain, .release = scr_stdio_release,
      .get = scr_stdio_get, .set = scr_stdio_set, .invoke = scr_stdio_invoke,
    };
    scr_dyn_handle_install(SCR_DYNH_STDIO, &ops);
    for (int i = 0; i < STDIO_METHOD_COUNT; i++) {
      ScrClosure *cb = scr_closure_new(NULL, 1);
      cb->caps[0] = scr_box_new(SCR_BOX_F64);
      scr_box_set_f64(cb->caps[0], i);
      scr_stdio_methods[i] = scr_dyn_new_func(cb, scr_stdio_method, i == STDIO_WRITE ? 3 : 1, "", scr_stdio_names[i]);
    }
    scr_stdio_write_hook = scr_stdio_intercept;
  }
  return scr_dyn_new_handle(&scr_stdio_streams[fd == 0 ? 0 : fd == 2 ? 2 : 1], SCR_DYNH_STDIO);
}

bool scr_dyn_process_stdio_is(const ScrDyn *value) {
  return value->kind == SCR_DYN_HANDLE && value->v.handle.tag == SCR_DYNH_STDIO;
}

double scr_dyn_process_stdio_fd(const ScrDyn *value, const ScrDynPath *path) {
  ScrStdio *stream = scr_dyn_handle_unbox(value, SCR_DYNH_STDIO, path, "ProcessStream");
  return stream ? stream->fd : 0;
}

/* ── the process 'exit' event ─────────────────────────────────────────
 * Listeners run SYNCHRONOUSLY when the process exits: at the end of a
 * normal run (the unit's atexit, registered by scr_events_install after
 * scr_init's hooks, so it runs BEFORE the RC audit/flush by LIFO) and
 * inside process.exit() (scr_lib.c calls through scr_process_exit_hook
 * before its deliberate _Exit — Node runs 'exit' listeners on explicit
 * exits too). The code argument: process.exit's real code on that path;
 * on the atexit path the hint kept in scr_async.c — 0 unless the
 * uncaught-exception or unhandled-rejection reporters marked the run as
 * failing (they set 1 exactly when main returns 1). Signal deaths skip
 * Node's 'exit' event alike. `once` and `off` follow the signal
 * registry's rules; anything a listener schedules can never run (the
 * loop is gone), exactly Node's contract. */

typedef struct {
  ScrClosure *cb; /* owned */
  void (*fn)(ScrClosure *cb, double code); /* adapter: 0-param or (code) */
  bool once;
} ScrExitListener;

static SCR_TL ScrExitListener *scr_exit_ls = NULL;
static SCR_TL size_t scr_exit_n = 0, scr_exit_cap = 0;
static SCR_TL bool scr_exit_ran = false;

void scr_run_exit_listeners(double code) {
  if (scr_exit_ran) return; /* process.exit inside a listener: no recursion */
  scr_exit_ran = true;
  scr_process_in_exit = true; /* process._exiting — Node's flag */
  for (size_t i = 0; i < scr_exit_n; i++) {
#ifdef SCR_WORKERS
    if (scr_context_stopping()) break;
#endif
    scr_exit_ls[i].fn(scr_exit_ls[i].cb, code);
#ifdef SCR_WORKERS
    if (scr_context_stopping()) break;
#endif
    if (scr_exc_pending()) {
      /* Node: a throw in an 'exit' listener is fatal (exit code 7). */
      scr_exc_print_uncaught();
      fflush(stdout);
#ifdef SCR_WORKERS
      if (!scr_context_is_main()) { scr_context_stop(7); break; }
#endif
      _Exit(7);
    }
  }
  for (size_t i = 0; i < scr_exit_n; i++) scr_closure_release(scr_exit_ls[i].cb);
  free(scr_exit_ls);
  scr_exit_ls = NULL;
  scr_exit_n = scr_exit_cap = 0;
  /* Ticks the listeners enqueued never run (Node drops the queue at
   * exit) — release them here or the RC audit counts them as leaks (the
   * loop's own teardown already ran, before these listeners). */
  scr_nticks_teardown();
}

void scr_process_on_exit(ScrClosure *cb /*moves*/, void (*fn)(ScrClosure *, double),
                          bool once) {
  if (scr_exit_ran) {
    scr_closure_release(cb);
    return;
  }
  if (scr_exit_n == scr_exit_cap) {
    scr_exit_cap = scr_exit_cap ? scr_exit_cap * 2 : 2;
    scr_exit_ls = realloc(scr_exit_ls, scr_exit_cap * sizeof *scr_exit_ls);
    if (!scr_exit_ls) scr_events_oom();
  }
  scr_exit_ls[scr_exit_n].cb = cb;
  scr_exit_ls[scr_exit_n].fn = fn;
  scr_exit_ls[scr_exit_n].once = once;
  scr_exit_n++;
}

void scr_process_off_exit(ScrClosure *cb /*borrowed*/) {
  for (size_t i = 0; i < scr_exit_n; i++) {
    if (scr_closure_identity_equal(scr_exit_ls[i].cb, cb)) {
      scr_closure_release(scr_exit_ls[i].cb);
      memmove(scr_exit_ls + i, scr_exit_ls + i + 1, (scr_exit_n - i - 1) * sizeof *scr_exit_ls);
      scr_exit_n--;
      return;
    }
  }
}

/* The runtime-provided exit listener adapters (the code is a plain
 * double — no program types needed). */
void scr_exit_thunk0(ScrClosure *cb, double code) {
  (void)code;
  ((void (*)(ScrClosure *))cb->fn)(cb);
}
void scr_exit_thunk_code(ScrClosure *cb, double code) {
  ((void (*)(ScrClosure *, double))cb->fn)(cb, code);
}

/* The runtime-provided stdin data adapters. */
void scr_stdin_data_thunk0(ScrClosure *cb, ScrBytes *chunk) {
  (void)chunk;
  ((void (*)(ScrClosure *))cb->fn)(cb);
}
void scr_stdin_data_thunk_bytes(ScrClosure *cb, ScrBytes *chunk) {
  /* The listener owns its +1 param per the universal convention. */
  ((void (*)(ScrClosure *, ScrBytes *))cb->fn)(cb, scr_bytes_retain(chunk));
}


/* ── the loop hooks (see scr_async.c) ─────────────────────────────────── */

static bool scr_events_pending(void) { return scr_stdin_pending(); }

static bool scr_events_watching(void) {
  return (scr_context_is_main() && scr_sig_watched > 0) || scr_stdin_pending();
}

/* One dispatch pass at a loop turn: wake-pipe bytes are consumed (safe
 * any time), flagged signals fire, and stdin is probed/served. */
static void scr_events_dispatch(void) {
  if (scr_context_is_main()) {
    scr_wake_pipe_drain();
    scr_signals_drain();
  }
  if (scr_exc_pending()) return;
  scr_stdin_service();
}

/* Fds the loop's idle poll(2) should watch (POLLIN): the wake pipe while
 * any signal is watched, fd 0 while stdin has a consumer. */
static int scr_events_pollfds(int out[2]) {
  int n = 0;
  if (scr_context_is_main() && scr_sig_watched > 0 && scr_wake_pipe[0] >= 0) out[n++] = scr_wake_pipe[0];
  if (scr_context_is_main() && scr_stdin_pending()) out[n++] = 0;
  return n;
}

/* The atexit half of the 'exit' event: normal termination reports the
 * abnormal-exit hint (0 unless the uncaught/unhandled reporters noted 1 —
 * exactly when main returns 1). */
static void scr_exit_atexit(void) { scr_run_exit_listeners((double)scr_exit_code_hint_get()); }

/* Exit-time registry cleanup: listeners a program leaves registered at
 * exit are Node-legitimate, not leaks — signal handlers for the process's
 * whole life, and stdin listeners for events that never came (the
 * data-wins-the-race shape leaves its once-'end'/'error' listeners
 * parked). Registered BEFORE the exit-event atexit, so by LIFO the 'exit'
 * listeners fire first, then everything releases, then the RC audit sees
 * a clean heap. */
static void scr_events_cleanup_atexit(void) {
  if (scr_context_is_main()) scr_sig_cleanup();
  scr_stdin_settle_done();
  scr_stdin_drop_listeners();
  scr_bytes_release(scr_stdin_buffer);
  scr_stdin_buffer = NULL;
  if (scr_stdio_initialized) scr_stdio_cleanup();
}

void scr_events_install(void) {
  static SCR_TL bool installed = false;
  if (installed) return;
  installed = true;
  if (!scr_context_is_main()) scr_stdin_read_eof = true;
#ifdef __wasi__
  int stdin_flags = fcntl(0, F_GETFL, 0);
  if (stdin_flags >= 0) (void)fcntl(0, F_SETFL, stdin_flags | O_NONBLOCK);
#endif
  scr_atexit(scr_events_cleanup_atexit);
  scr_atexit(scr_exit_atexit);
  scr_loop_set_events(&scr_events_pending, &scr_events_watching, &scr_events_dispatch,
                       &scr_events_pollfds);
  scr_process_exit_hook = &scr_run_exit_listeners;
  scr_stdin_destroy_hook = &scr_stdin_destroy;
}
