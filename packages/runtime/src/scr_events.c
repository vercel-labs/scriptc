/* Process events and stdin streaming — the OPTIONAL half of the event
 * loop: signal handlers (process.on/once/off of SIGINT/SIGTERM), the
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

/* ── process signal events (process.on("SIGINT" | "SIGTERM")) ─────────
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
  ScrClosure *cb; /* owned */
  bool once;
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

/* Classic signal numbers only (SIGINT 2 / SIGTERM 15 today; every POSIX
 * classic fits) — NSIG is not visible under strict _XOPEN_SOURCE. */
#define SCR_SIG_MAX 32

static ScrSigReg *scr_sig_regs = NULL;
static size_t scr_sig_watched = 0; /* watched signal COUNT (regs) */
static volatile sig_atomic_t scr_sig_flag[SCR_SIG_MAX];
static volatile sig_atomic_t scr_sig_any = 0;
static int scr_wake_pipe[2] = {-1, -1};

static void scr_sig_handler(int sig) {
  if (sig < 0 || sig >= SCR_SIG_MAX) return;
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
    for (size_t i = 0; i < reg->n; i++) scr_closure_release(reg->ls[i].cb);
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

void scr_signal_on(double signum, ScrClosure *cb /*moves*/, bool once) {
#ifdef __wasi__
  (void)signum;
  (void)once;
  scr_closure_release(cb);
  /* The compiler rejects this capability before linking. This guard keeps
   * the optional events unit honest if hand-authored IR reaches it. */
  scr_trap("scriptc: internal error: OS signal surface reached on WASI\n");
  return;
#else
  int sig = (int)signum;
  if (sig <= 0 || sig >= SCR_SIG_MAX) {
    scr_closure_release(cb); /* frontend only emits classic signals */
    return;
  }
  ScrSigReg *reg = scr_sig_regs;
  while (reg && reg->sig != sig) reg = reg->next;
  if (!reg) {
    reg = calloc(1, sizeof *reg);
    if (!reg) scr_events_oom();
    reg->sig = sig;
    reg->next = scr_sig_regs;
    scr_sig_regs = reg;
    scr_sig_watched++;
    scr_wake_pipe_init();
#ifdef _WIN32
    reg->prev = signal(sig, scr_sig_handler);
    if (reg->prev == SIG_ERR) reg->prev = SIG_DFL;
#else
    struct sigaction sa;
    memset(&sa, 0, sizeof sa);
    sa.sa_handler = scr_sig_handler;
    sigemptyset(&sa.sa_mask);
    sa.sa_flags = 0; /* NO SA_RESTART: idle sleeps must EINTR */
    sigaction(sig, &sa, &reg->prev);
#endif
  }
  if (reg->n == reg->cap) {
    reg->cap = reg->cap ? reg->cap * 2 : 2;
    reg->ls = realloc(reg->ls, reg->cap * sizeof *reg->ls);
    if (!reg->ls) scr_events_oom();
  }
  reg->ls[reg->n].cb = cb;
  reg->ls[reg->n].once = once;
  reg->n++;
#endif
}

static void scr_sig_reg_drop(ScrSigReg *reg) {
#ifdef _WIN32
  signal(reg->sig, reg->prev); /* default disposition back */
#elif defined(__wasi__)
  /* No signal disposition exists in WASI Preview 1. The compiler refuses
   * signal registrations, so this arm is only the cleanup safety net. */
#else
  sigaction(reg->sig, &reg->prev, NULL); /* default disposition back */
#endif
  ScrSigReg **link = &scr_sig_regs;
  while (*link != reg) link = &(*link)->next;
  *link = reg->next;
  scr_sig_watched--;
  free(reg->ls);
  free(reg);
}

void scr_signal_off(double signum, ScrClosure *cb /*borrowed*/) {
#ifdef __wasi__
  (void)signum;
  (void)cb;
  scr_trap("scriptc: internal error: OS signal surface reached on WASI\n");
  return;
#else
  int sig = (int)signum;
  ScrSigReg *reg = scr_sig_regs;
  while (reg && reg->sig != sig) reg = reg->next;
  if (!reg) return;
  for (size_t i = 0; i < reg->n; i++) {
    if (reg->ls[i].cb == cb) { /* first match, like Node's removeListener */
      scr_closure_release(reg->ls[i].cb);
      memmove(reg->ls + i, reg->ls + i + 1, (reg->n - i - 1) * sizeof *reg->ls);
      reg->n--;
      if (reg->n == 0) scr_sig_reg_drop(reg);
      return;
    }
  }
#endif
}

/* One dispatch pass: every flagged signal fires its listener SNAPSHOT
 * (Node emits over a copy — a listener removed mid-emit still runs for
 * this delivery; one added mid-emit waits for the next). `once` entries
 * leave the live list BEFORE their callback runs; an emptied list
 * restores the default disposition, so the next delivery of that signal
 * kills the process — Node-exact. A throw stops the pass and leaves the
 * exception for the loop. */
static void scr_signals_drain(void) {
  if (!scr_sig_any) return;
  scr_sig_any = 0;
  ScrSigReg *reg = scr_sig_regs;
  while (reg) {
    ScrSigReg *next = reg->next; /* reg may drop below */
    if (scr_sig_flag[reg->sig]) {
      scr_sig_flag[reg->sig] = 0;
      size_t n = reg->n;
      ScrSigListener *snap = malloc(n * sizeof *snap);
      if (!snap) scr_events_oom();
      for (size_t i = 0; i < n; i++) {
        snap[i] = reg->ls[i];
        scr_closure_retain(snap[i].cb);
      }
      bool dropped = false;
      for (size_t i = 0; i < n; i++) {
        if (snap[i].once && !dropped) {
          /* remove from the live list before invoking */
          for (size_t j = 0; j < reg->n; j++) {
            if (reg->ls[j].cb == snap[i].cb) {
              scr_closure_release(reg->ls[j].cb);
              memmove(reg->ls + j, reg->ls + j + 1, (reg->n - j - 1) * sizeof *reg->ls);
              reg->n--;
              break;
            }
          }
          if (reg->n == 0) {
            scr_sig_reg_drop(reg);
            dropped = true;
          }
        }
        if (!scr_exc_pending()) {
          ((void (*)(ScrClosure *))snap[i].cb->fn)(snap[i].cb);
        }
        scr_closure_release(snap[i].cb);
      }
      free(snap);
      if (scr_exc_pending()) return;
    }
    reg = next;
  }
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

static ScrStdinDataL *scr_stdin_data = NULL;
static size_t scr_stdin_ndata = 0, scr_stdin_data_cap = 0;
static ScrStdinEndL *scr_stdin_end = NULL;
static size_t scr_stdin_nend = 0, scr_stdin_end_cap = 0;
static ScrStdinErrL *scr_stdin_err = NULL;
static size_t scr_stdin_nerr = 0, scr_stdin_err_cap = 0;
static ScrPromise *scr_stdin_waiter = NULL; /* parked for-await next() */
static bool scr_stdin_eof = false;
static bool scr_stdin_destroyed = false;

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
         (scr_stdin_ndata > 0 || scr_stdin_waiter != NULL);
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
static void scr_stdin_service(void) {
  if (!scr_stdin_watching()) return;
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
    scr_stdin_finish(true); /* EOF: 'end' fires, iteration ends */
    return;
  }
  ScrBytes *chunk = scr_bytes_new(SCR_BYTES_U8, (double)n);
  memcpy(chunk->data, buf, (size_t)n);
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
  scr_bytes_release(chunk);
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

static ScrExitListener *scr_exit_ls = NULL;
static size_t scr_exit_n = 0, scr_exit_cap = 0;
static bool scr_exit_ran = false;

void scr_run_exit_listeners(double code) {
  if (scr_exit_ran) return; /* process.exit inside a listener: no recursion */
  scr_exit_ran = true;
  scr_process_in_exit = true; /* process._exiting — Node's flag */
  for (size_t i = 0; i < scr_exit_n; i++) {
    scr_exit_ls[i].fn(scr_exit_ls[i].cb, code);
    if (scr_exc_pending()) {
      /* Node: a throw in an 'exit' listener is fatal (exit code 7). */
      scr_exc_print_uncaught();
      fflush(stdout);
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
    if (scr_exit_ls[i].cb == cb) {
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
  return scr_sig_watched > 0 || scr_stdin_pending();
}

/* One dispatch pass at a loop turn: wake-pipe bytes are consumed (safe
 * any time), flagged signals fire, and stdin is probed/served. */
static void scr_events_dispatch(void) {
  scr_wake_pipe_drain();
  scr_signals_drain();
  if (scr_exc_pending()) return;
  scr_stdin_service();
}

/* Fds the loop's idle poll(2) should watch (POLLIN): the wake pipe while
 * any signal is watched, fd 0 while stdin has a consumer. */
static int scr_events_pollfds(int out[2]) {
  int n = 0;
  if (scr_sig_watched > 0 && scr_wake_pipe[0] >= 0) out[n++] = scr_wake_pipe[0];
  if (scr_stdin_pending()) out[n++] = 0;
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
  scr_sig_cleanup();
  scr_stdin_settle_done();
  scr_stdin_drop_listeners();
}

void scr_events_install(void) {
  static bool installed = false;
  if (installed) return;
  installed = true;
#ifdef __wasi__
  int stdin_flags = fcntl(0, F_GETFL, 0);
  if (stdin_flags >= 0) (void)fcntl(0, F_SETFL, stdin_flags | O_NONBLOCK);
#endif
  atexit(scr_events_cleanup_atexit);
  atexit(scr_exit_atexit);
  scr_loop_set_events(&scr_events_pending, &scr_events_watching, &scr_events_dispatch,
                       &scr_events_pollfds);
  scr_process_exit_hook = &scr_run_exit_listeners;
  scr_stdin_destroy_hook = &scr_stdin_destroy;
}
