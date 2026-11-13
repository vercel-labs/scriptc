#include "scr_runtime.h"

#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
#if !defined(_WIN32) && !defined(__wasi__)
#include <pthread.h>
#include <signal.h>
#endif
#ifdef _WIN32
#include <fcntl.h> /* _O_BINARY */
#include <io.h>    /* _setmode, _fileno */
#include <windows.h>
#endif

/* POSIX executables submit each JavaScript-visible stdout/stderr chunk with
 * write(2)/writev(2) on the descriptor itself. The C stream layer added a
 * copy, several stream calls per console line, and — for the unbuffered
 * stderr stream — one write(2) per argument, separator, and newline. Windows
 * (CRT text/binary modes, console code pages), WASI, and library artifacts
 * (whose host owns the process's C streams) keep the C stream path, now fed
 * one formatted chunk per call. */
#if !defined(_WIN32) && !defined(__wasi__) && !defined(SCR_LIB)
#define SCR_STDIO_DIRECT 1
#include <sys/uio.h>
#include <unistd.h>
#if defined(__linux__)
#include <stdio_ext.h> /* __fpending: glibc and musl */
#endif
#else
#define SCR_STDIO_DIRECT 0
#endif

/* Build-time stdout policy (`--stdout-buffering`). The program object defines
 * scr_stdout_buffering = 1, overriding this weak default; the runtime then
 * keeps JavaScript-visible stdout bytes in its own buffer when fd 1 is not a
 * terminal, and settles them where the runtime settles output (see
 * scr_stdout_settle). Off, every chunk is submitted before the call
 * returns. */
__attribute__((weak)) const unsigned char scr_stdout_buffering = 0;
static bool scr_stdout_buffered = false;

/* Set by scr_async.c at loop exhaustion; lives here (unconditionally) so
 * binaries that link the console without the async runtime still link, and
 * plain builds satisfy scr_async's reference. */
static SCR_TL long scr_abandoned_fibers = 0;
void scr_note_abandoned_fibers(long n) { scr_abandoned_fibers = n; }

bool scr_exit_frees(void) {
#if defined(SCR_RC_AUDIT) || defined(SCR_LSAN_IMMORTAL)
  return true;
#else
  if (!scr_context_is_main()) {
#ifdef SCR_WORKERS
    scr_context_note_script_end();
#endif
    return true;
  }
  static int forced = -1; /* the main thread reads it, once */
  if (forced < 0) {
    const char *value = getenv("SCRIPTC_EXIT_FREE");
    forced = value != NULL && value[0] == '1';
  }
  return forced != 0;
#endif
}

#ifndef SCR_LIB
#ifdef SCR_RC_AUDIT
extern long scr_str_live_count(void);     /* scr_string.c */
extern long scr_arr_live_count(void);     /* scr_array.c */
extern long scr_map_live_count(void);     /* scr_map.c */
extern long scr_box_live_count(void);     /* scr_closure.c */
extern long scr_closure_live_count(void); /* scr_closure.c */
extern long scr_obj_live_count(void);     /* scr_object.c */
extern long scr_obj_lifetime_count(void); /* scr_object.c */
extern long scr_union_live_count(void);   /* scr_union.c */
extern long scr_dyn_live_count(void);     /* scr_json.c */
extern long scr_bytes_live_count(void);   /* scr_bytes.c */

static void scr_rc_audit_at_exit(void) {
  scr_buffer_pool_reset(); /* the pool's own slab reference */
  /* atexit runs this before scr_flush_at_exit, and every audit message goes
   * to stderr: settle stdout first so a --stdout-buffering build keeps the
   * program's lines ahead of the audit's on a shared fd. */
  scr_stdout_settle();
  fflush(stdout);
  /* Fibers suspended forever at loop exhaustion (awaits nobody resolves —
   * Node exits 0 there too) still hold their stacks and owned values by
   * design; a strict audit would only report that deliberate abandonment. */
  if (scr_abandoned_fibers > 0) {
    fprintf(stderr, "scriptc RC audit skipped: %ld fiber(s) never resumed\n",
            scr_abandoned_fibers);
    return;
  }
  /* ProgramLifetime instances (@scriptc/types) are never freed, and neither
   * is anything they hold: a strict audit would only report that deliberate
   * retention. */
  long lifetime = scr_obj_lifetime_count();
  if (lifetime > 0) {
    fprintf(stderr, "scriptc RC audit skipped: %ld program-lifetime object(s) never freed\n",
            lifetime);
    return;
  }
  long strings = scr_str_live_count();
  long arrays = scr_arr_live_count();
  long maps = scr_map_live_count();
  long boxes = scr_box_live_count();
  long closures = scr_closure_live_count();
  long objects = scr_obj_live_count();
  long unions = scr_union_live_count();
  long dyns = scr_dyn_live_count();
  long bytes = scr_bytes_live_count();
  if (strings != 0 || arrays != 0 || maps != 0 || boxes != 0 || closures != 0 ||
      objects != 0 || unions != 0 || dyns != 0 || bytes != 0) {
    scr_stdout_settle();
    fflush(stdout);
    fprintf(stderr,
            "scriptc RC AUDIT FAILED: %ld heap string(s), %ld array(s), "
            "%ld map(s), %ld box(es), %ld closure(s), %ld object(s), "
            "%ld union(s), %ld dyn value(s), %ld bytes value(s) live at exit\n",
            strings, arrays, maps, boxes, closures, objects, unions, dyns,
            bytes);
    _Exit(99);
  }
}
#endif

static void scr_flush_at_exit(void) {
  /* --stdout-buffering bytes live in the runtime's buffer, not the C
   * stream's: settle them before the stream's own exit flush. */
  scr_stdout_settle();
  fflush(stdout);
}

static void scr_collect_cycles_at_exit(void) {
  if (scr_exit_frees()) scr_collect_cycles();
}

#ifdef _WIN32
static UINT scr_original_console_output_cp = 0;

static void scr_restore_console_output_cp(void) {
  if (scr_original_console_output_cp != 0) {
    (void)SetConsoleOutputCP(scr_original_console_output_cp);
  }
}

static void scr_enable_utf8_console_output(void) {
  DWORD mode;
  HANDLE out = GetStdHandle(STD_OUTPUT_HANDLE);
  HANDLE err = GetStdHandle(STD_ERROR_HANDLE);
  bool out_is_console = out != NULL && out != INVALID_HANDLE_VALUE &&
                        GetConsoleMode(out, &mode);
  bool err_is_console = err != NULL && err != INVALID_HANDLE_VALUE &&
                        GetConsoleMode(err, &mode);
  if (!out_is_console && !err_is_console) return;

  UINT original = GetConsoleOutputCP();
  if (original == 0 || original == CP_UTF8) return;
  if (!SetConsoleOutputCP(CP_UTF8)) return;

  /* The code page belongs to the shared console, not this process. Restore
   * it after every scriptc exit hook has finished writing. */
  scr_original_console_output_cp = original;
  if (atexit(scr_restore_console_output_cp) != 0) {
    (void)SetConsoleOutputCP(original);
    scr_original_console_output_cp = 0;
  }
}
#endif

void scr_runtime_abi_v48(void) {}

void scr_init(void) {
#ifdef SCR_WORKERS
  /* Generated inline exception polls read the active cell directly. */
  scr_exc_swap_cell(NULL);
  if (scr_context_is_main()) {
#endif
#ifdef _WIN32
  /* The CRT opens std streams in TEXT mode, which writes \n as \r\n. Node
   * on Windows does NOT translate — console.log emits \n whether stdout is
   * a pipe or the console (libuv writes the bytes as given) — so the
   * streams switch to binary here or every line would differ from the
   * oracle by a byte. stdin too: readFileSync(0) must see the bytes on the
   * pipe, not a CRLF-collapsed view. */
  _setmode(_fileno(stdout), _O_BINARY);
  _setmode(_fileno(stderr), _O_BINARY);
  _setmode(_fileno(stdin), _O_BINARY);
  /* Byte streams stay raw UTF-8. A real Windows console instead decodes
   * narrow writes through its output code page, which commonly starts as
   * CP437; select UTF-8 only while this process is attached and restore the
   * shared setting at exit. */
  scr_enable_utf8_console_output();
#endif
  /* A private formatting buffer coalesces the several stdio calls needed to
   * render one console line. Every JavaScript-visible stdout write flushes
   * before returning, so this buffer is never observable as delayed output:
   * Node hands each console.log/process.stdout.write chunk to its backing
   * stream immediately. */
  static char outbuf[1 << 16];
  setvbuf(stdout, outbuf, _IOFBF, sizeof outbuf);
#if SCR_STDIO_DIRECT
  /* --stdout-buffering: a destination that is not a terminal keeps its bytes
   * in the buffer above until it fills or the runtime settles them. A
   * terminal keeps one submission per call, as Node writes synchronously
   * there. */
  if (scr_stdout_buffering && !isatty(1)) scr_stdout_buffered = true;
#endif
#if !defined(_WIN32) && !defined(__wasi__)
  /* Node resets the signal dispositions it inherits before any program code
   * runs (src/node.cc, ResetSignalHandlers): an ignored signal goes back to
   * its default action, while a handler an embedder or an LD_PRELOAD
   * installed is kept. Without this a program launched by a shell or a CI
   * runner that ignores SIGTSTP can never suspend on Ctrl+Z — readline's
   * kill(getpid(), SIGTSTP) is discarded — and an inherited ignored SIGPIPE
   * or SIGXFSZ leaves the write failing instead of ending the process the
   * way Node does. Node's bound is kMaxSignal (32: NSIG is not reliable
   * across platforms). SIGPIPE and SIGXFSZ are then ignored again: a write
   * to a closed pipe or past RLIMIT_FSIZE fails with EPIPE or EFBIG, on any
   * thread, instead of ending the process. A process.on listener replaces
   * the disposition while it is registered (scr_events.c), and spawned
   * children start with both at their default actions (scr_spawn_command).
   *
   * The mask the launcher left behind goes first, as in Node: a blocked set
   * survives exec and follows the thread that called fork, so a program
   * started by a parent that blocked SIGTSTP never suspends on Ctrl+Z —
   * kill(getpid(), SIGTSTP) leaves the stop pending and the process keeps
   * running, which looks like a hung program to whoever waits for the stop.
   * Node replaces the set with an empty one and then blocks SIGUSR1, the
   * signal its inspector thread waits on (src/node.cc, PlatformInit, built
   * with the inspector); scriptc has no such thread, so the inherited set is
   * cleared and a program that wants a mask sets one itself. */
  sigset_t inherited_mask;
  sigemptyset(&inherited_mask);
  (void)pthread_sigmask(SIG_SETMASK, &inherited_mask, NULL);
  for (unsigned nr = 1; nr < 32; nr++) {
    if (nr == SIGKILL || nr == SIGSTOP) continue;
    struct sigaction act;
    memset(&act, 0, sizeof act);
    act.sa_handler = nr == SIGPIPE || nr == SIGXFSZ ? SIG_IGN : SIG_DFL;
    if (act.sa_handler == SIG_DFL) {
      /* Only an inherited SIG_IGN is replaced; a real handler stays. */
      struct sigaction old;
      if (sigaction((int)nr, NULL, &old) != 0) continue;
      if ((old.sa_flags & SA_SIGINFO) != 0 || old.sa_handler != SIG_IGN) continue;
    }
    (void)sigaction((int)nr, &act, NULL);
  }
#endif
#ifdef SCR_WORKERS
  }
#endif
  /* atexit is LIFO; registration order makes exit run: library cleanup
   * (registered later, in scr_lib_init) → 'exit' listeners and their cleanup
   * (registered by scr_events_install) → cycle collection → RC audit → flush
   * → the stdin terminal-mode restore → Windows console-code-page restore.
   * The final collection frees cycles the program dropped, so the audit (and
   * ASan's leak check) see them as freed, not leaked. The mode restore runs
   * after the 'exit' listeners and the flush, matching Node, where
   * atexit(ResetStdio) runs at libc exit after the listeners, so output a
   * listener writes still goes to the terminal in the mode the program left
   * it in. */
  scr_atexit(scr_process_stdin_restore_mode);
  scr_atexit(scr_flush_at_exit);
#ifdef SCR_RC_AUDIT
  scr_atexit(scr_rc_audit_at_exit);
#endif
  scr_atexit(scr_collect_cycles_at_exit);
}
#endif /* !SCR_LIB — a library artifact never touches host stdio modes/buffering and
        * registers no atexit handlers: scr_init and its exit hooks (the
        * audit's _Exit(99) included) are executable-lane machinery; the
        * library session reset lives in scr_library.c. */

/* ONE formatter for both console streams — console.error/warn print
 * byte-identically to console.log in Node (same inspect rendering), only
 * the stream differs. */
/* A real definition lets relocatable library links localize this hook;
 * a tentative common symbol stays externally visible on Mach-O. */
SCR_TL bool (*scr_stdio_write_hook)(int fd, const void *data, size_t len, int flags) = NULL;
SCR_TL bool (*scr_stdio_capture)(int fd, const void *data, size_t len) = NULL;

SCR_TL bool scr_stdin_fed = false;
SCR_TL void (*scr_stdin_fed_attach)(void) = NULL;
SCR_TL bool (*scr_stdin_fed_waiting)(void) = NULL;
static SCR_TL ScrBytes **scr_stdin_fed_q;
static SCR_TL size_t scr_stdin_fed_head, scr_stdin_fed_len, scr_stdin_fed_cap;
static SCR_TL bool scr_stdin_fed_end;

void scr_stdin_fed_push(ScrBytes *chunk) {
  if (scr_stdin_fed_end) {
    if (chunk) scr_bytes_release(chunk);
    return;
  }
  if (!chunk) {
    scr_stdin_fed_end = true;
    return;
  }
  if (scr_stdin_fed_head + scr_stdin_fed_len == scr_stdin_fed_cap) {
    if (scr_stdin_fed_head > 0) {
      memmove(scr_stdin_fed_q, scr_stdin_fed_q + scr_stdin_fed_head,
              scr_stdin_fed_len * sizeof *scr_stdin_fed_q);
      scr_stdin_fed_head = 0;
    }
    if (scr_stdin_fed_len == scr_stdin_fed_cap) {
      scr_stdin_fed_cap = scr_stdin_fed_cap ? scr_stdin_fed_cap * 2 : 8;
      scr_stdin_fed_q = realloc(scr_stdin_fed_q, scr_stdin_fed_cap * sizeof *scr_stdin_fed_q);
      if (!scr_stdin_fed_q) scr_trap("scriptc: out of memory\n");
    }
  }
  scr_stdin_fed_q[scr_stdin_fed_head + scr_stdin_fed_len++] = chunk;
}

ScrBytes *scr_stdin_fed_take(bool *ended) {
  if (scr_stdin_fed_len == 0) {
    *ended = scr_stdin_fed_end;
    return NULL;
  }
  *ended = false;
  ScrBytes *chunk = scr_stdin_fed_q[scr_stdin_fed_head++];
  if (--scr_stdin_fed_len == 0) scr_stdin_fed_head = 0;
  return chunk;
}

void scr_stdin_fed_clear(void) {
  for (size_t i = 0; i < scr_stdin_fed_len; i++)
    scr_bytes_release(scr_stdin_fed_q[scr_stdin_fed_head + i]);
  free(scr_stdin_fed_q);
  scr_stdin_fed_q = NULL;
  scr_stdin_fed_head = scr_stdin_fed_len = scr_stdin_fed_cap = 0;
  scr_stdin_fed_end = false;
  scr_stdin_fed = false;
  scr_stdin_fed_attach = NULL;
  scr_stdin_fed_waiting = NULL;
}

/* Lines up to this size render on the C stack (fiber stacks are 256 KiB). */
#define SCR_CONSOLE_STACK_LINE 2048

#if SCR_STDIO_DIRECT
/* --stdout-buffering keeps JavaScript-visible bytes here rather than in the C
 * stream's buffer. fflush(3) treats everything it asked the descriptor to take
 * as written, so a write interrupted by a handled signal — the runtime
 * installs its handlers without SA_RESTART — or a short write to a pipe
 * discards the remainder. The flush below submits through scr_fd_writev_all,
 * which retries EINTR and continues a short write, so a settle point publishes
 * the bytes it was given. */
static char scr_stdout_buffer[1 << 16];
static size_t scr_stdout_used = 0;

/* True when the C stdout buffer holds bytes: runtime-internal output that
 * went through stdio without flushing. A direct write must submit them
 * first so stdout keeps source order and merged (2>&1) redirections keep
 * stdout-before-stderr order. Unknown platforms flush unconditionally. */
static inline bool scr_stdout_pending(void) {
#if defined(__linux__)
  return __fpending(stdout) != 0;
#elif defined(__APPLE__)
  return (stdout->_flags & __SWR) && stdout->_bf._base && stdout->_p > stdout->_bf._base;
#else
  return true;
#endif
}

/* Submit every byte of iov[0..count) to fd. Short writes continue with the
 * remainder and EINTR retries. Any other failure (EAGAIN on a non-blocking
 * descriptor, EPIPE, EBADF, ...) returns its errno with the rest of the
 * chunk dropped — what the C stream flush did before. */
static int scr_fd_writev_all(int fd, struct iovec *iov, int count) {
  while (count > 0 && iov->iov_len == 0) iov++, count--;
  while (count > 0) {
    ssize_t written = count == 1 ? write(fd, iov->iov_base, iov->iov_len) : writev(fd, iov, count);
    if (written < 0) {
      if (errno == EINTR) continue;
      return errno ? errno : EIO;
    }
    if (written == 0) return EIO;
    size_t left = (size_t)written;
    while (count > 0 && left >= iov->iov_len) left -= iov->iov_len, iov++, count--;
    if (count > 0) {
      iov->iov_base = (char *)iov->iov_base + left;
      iov->iov_len -= left;
    }
  }
  return 0;
}

/* Worker executables run several runtime threads that all write to the
 * process descriptors. Hold the matching C stream's lock (recursive, so the
 * pending-stdout flush inside is fine) around each direct submission, so a
 * chunk that needs several write(2) calls, and the stdout flush that precedes
 * it, cannot interleave with another thread's output. */
static inline FILE *scr_fd_stream_lock(int fd) {
#ifdef SCR_WORKERS
  FILE *stream = fd == 2 ? stderr : stdout;
  flockfile(stream);
  return stream;
#else
  (void)fd;
  return NULL;
#endif
}

static inline void scr_fd_stream_unlock(FILE *stream) {
#ifdef SCR_WORKERS
  funlockfile(stream);
#else
  (void)stream;
#endif
}

/* Submit the runtime's buffered stdout bytes. The buffer is emptied before
 * the submission, so a failure drops the remainder exactly as the direct
 * path's submission of a chunk does. The caller holds the stdout stream
 * lock. */
static int scr_stdout_flush_locked(void) {
  size_t len = scr_stdout_used;
  if (len == 0) return 0;
  scr_stdout_used = 0;
  struct iovec iov = {scr_stdout_buffer, len};
  return scr_fd_writev_all(1, &iov, 1);
}

/* Append to the runtime's stdout buffer, submitting it when it fills. The
 * caller holds the stdout stream lock. */
static int scr_stdout_append_locked(const void *data, size_t len) {
  const char *bytes = data;
  while (len > 0) {
    if (scr_stdout_used == sizeof scr_stdout_buffer) {
      int error = scr_stdout_flush_locked();
      if (error) return error;
    }
    size_t room = sizeof scr_stdout_buffer - scr_stdout_used;
    size_t take = len < room ? len : room;
    memcpy(scr_stdout_buffer + scr_stdout_used, bytes, take);
    scr_stdout_used += take;
    bytes += take;
    len -= take;
  }
  return 0;
}

/* Publish everything stdout still holds — the runtime's buffer, then any
 * bytes the C stream kept — so the next chunk, on either stream, keeps
 * source order. A caller holding the stderr stream lock takes the stdout
 * lock inside, the order fflush(stdout) took before. */
static void scr_stdout_pending_flush(void) {
  if (scr_stdout_buffered) {
    FILE *out = scr_fd_stream_lock(1);
    (void)scr_stdout_flush_locked();
    scr_fd_stream_unlock(out);
  }
  if (scr_stdout_pending()) fflush(stdout);
}

/* Settle buffered JavaScript-visible stdout before an observable boundary:
 * a terminal keeps the per-call policy, and builds without the option never
 * buffer. The async, process, fs and trap units call this unconditionally,
 * so a configuration that cannot buffer defines a no-op. */
void scr_stdout_settle(void) {
  if (!scr_stdout_buffered) return;
  scr_stdout_pending_flush();
}
#else
void scr_stdout_settle(void) {}
#endif

/* Render args into line (capacity from scr_console_capacity): space-joined
 * with a trailing newline. Returns the byte count. Tags may carry
 * SCR_ARG_GLUE, so every kind test masks with SCR_ARG_KIND: a glued string
 * part must reserve its full length, exactly as scr_console_render copies
 * it. */
static size_t scr_console_capacity(size_t n, const ScrLogArg *args) {
  size_t capacity = 1;
  for (size_t i = 0; i < n; i++) {
    size_t length = (args[i].tag & SCR_ARG_KIND) == SCR_ARG_STR ? args[i].v.s->len : 32;
    if (length >= SIZE_MAX - capacity) scr_trap("scriptc: console output too large\n");
    capacity += length + 1;
  }
  return capacity;
}

/* *wide records a string argument that may hold a lone surrogate (only
 * once one may exist). Glued parts of one concatenation that complete a
 * surrogate pair across their seam render as the paired character. */
static size_t scr_console_render(char *line, size_t n, const ScrLogArg *args, bool *wide) {
  size_t used = 0;
  bool lone = scr_wtf8_any(), joins = false, maybe = false;
  for (size_t i = 0; i < n; i++) {
    const ScrLogArg *arg = &args[i];
    if (i && !(arg->tag & SCR_ARG_GLUE)) line[used++] = ' ';
    int kind = arg->tag & SCR_ARG_KIND;
    if (kind == SCR_ARG_STR) {
      if (lone && !arg->v.s->ascii) {
        maybe = true;
        joins |= scr_wtf8_joins(line, used, arg->v.s->data, arg->v.s->len);
      }
      memcpy(line + used, arg->v.s->data, arg->v.s->len);
      used += arg->v.s->len;
    } else if (kind == SCR_ARG_BOOL) {
      const char *text = arg->v.b ? "true" : "false";
      size_t length = arg->v.b ? 4 : 5;
      memcpy(line + used, text, length);
      used += length;
    } else if (kind == SCR_ARG_F64 && arg->v.f == 0 && signbit(arg->v.f)) {
      /* console.log renders numbers via inspect, which distinguishes -0
       * (String(-0) is "0", but console.log(-0) prints "-0"). A number
       * inside a concatenation (SCR_ARG_NUM) keeps String()'s "0". */
      memcpy(line + used, "-0", 2);
      used += 2;
    } else {
      used += scr_f64_to_str(arg->v.f, line + used);
    }
  }
  if (joins) used = scr_wtf8_fuse(line, used);
  line[used++] = '\n';
  *wide = maybe;
  return used;
}

/* The global console's group indentation: console.group installs its
 * indenting rewrite (scr_console_native.c) while a group is open, so
 * programs without groups carry none of it. Console instances never use
 * it. */
SCR_TL char *(*scr_console_indenter)(const char *line, size_t *used) = NULL;

/* Console methods submit one formatted chunk to their backing stream before
 * returning, as Node's console does: a caller observing a live child sees
 * this line before the next JS turn. With ignoreErrors (the global console,
 * and Console instances by default) a patched write receives the line and
 * an error handler, and what it throws is discarded; without it the write
 * receives only the line and its throw propagates, as in Node's
 * kWriteToConsole. */
static void scr_console_write(int fd, size_t n, const ScrLogArg *args, bool global, bool ignore_errors) {
#if SCR_STDIO_DIRECT
  /* A large single string goes out without a copy: string + newline in one
   * vectored write. */
  if (!scr_stdio_write_hook && !scr_stdio_capture && !(global && scr_console_indenter) && n == 1 &&
      (args[0].tag & SCR_ARG_KIND) == SCR_ARG_STR &&
      args[0].v.s->len >= SCR_CONSOLE_STACK_LINE) {
    char *owned;
    const char *bytes = scr_str_utf8(args[0].v.s, &owned);
    FILE *locked = scr_fd_stream_lock(fd);
    scr_stdout_pending_flush();
    struct iovec iov[2] = {{(void *)bytes, args[0].v.s->len}, {(void *)"\n", 1}};
    (void)scr_fd_writev_all(fd, iov, 2);
    scr_fd_stream_unlock(locked);
    scr_str_utf8_end(owned);
    return;
  }
#endif
  char stack[SCR_CONSOLE_STACK_LINE];
  size_t capacity = scr_console_capacity(n, args);
  char *line = capacity <= sizeof stack ? stack : malloc(capacity);
  if (!line) scr_trap("scriptc: out of memory\n");
  bool wide = false;
  size_t used = scr_console_render(line, n, args, &wide);
  if (global && scr_console_indenter) {
    char *indented = scr_console_indenter(line, &used);
    if (line != stack) free(line);
    line = indented;
  }
  if (scr_stdio_write_hook) {
    /* A patched write receives the JavaScript string, lone surrogates kept. */
    scr_stdio_write_hook(fd, line, used,
                         (wide ? SCR_STDIO_HOOK_WIDE : 0) | (ignore_errors ? SCR_STDIO_HOOK_CONSOLE : 0));
    if (ignore_errors && scr_exc_pending()) scr_exc_clear();
  } else {
    if (wide) scr_wtf8_to_utf8(line, used);
    (void)scr_stdio_write_raw(fd, line, used);
  }
  if (line != stack) free(line);
}

void scr_console_log(size_t n, const ScrLogArg *args) {
  scr_console_write(1, n, args, true, true);
}

/* console.error and console.warn. Runtime-internal stdout output that is
 * still buffered goes out first so it cannot cross this stderr line under a
 * merged redirection (2>&1); JavaScript-visible stdout writes have already
 * been submitted. */
void scr_console_error(size_t n, const ScrLogArg *args) {
  scr_console_write(2, n, args, true, true);
}

void scr_console_log_parts(size_t n, const ScrLogArg *args) {
  scr_console_write(1, n, args, true, true);
}

void scr_console_error_parts(size_t n, const ScrLogArg *args) {
  scr_console_write(2, n, args, true, true);
}

/* Whether the rendered arguments are empty. Render adds the line's final
 * newline, so an empty message renders as that one byte. */
static bool scr_console_message_empty(size_t n, const ScrLogArg *args) {
  if (n == 0) return true;
  char stack[SCR_CONSOLE_STACK_LINE];
  size_t capacity = scr_console_capacity(n, args);
  char *line = capacity <= sizeof stack ? stack : malloc(capacity);
  if (!line) scr_trap("scriptc: out of memory\n");
  bool wide = false;
  size_t used = scr_console_render(line, n, args, &wide);
  if (line != stack) free(line);
  return used <= 1;
}

/* console.trace: "Trace" with ": " and the formatted arguments on stderr,
 * then the frames the call captured, in ONE write (Node writes the
 * formatted Error's whole stack as one chunk). An empty message prints
 * "Trace" alone: Node's trace is an Error whose name it prints, and an
 * Error with an empty message renders as its name. The line goes through
 * the public writer, so group indentation applies as it does to
 * console.error. The frames are scriptc's own function and file text
 * (SEMANTICS.md divergence 11) — the same text a caught Error's stack
 * carries — so the line before them is Node's exactly and the frame block
 * is not. The capture happens before the write, as Node captures the
 * stack when console.trace runs: a patched write that changes
 * Error.stackTraceLimit cannot change this call's frames. Writes swallow
 * what a patched stream throws, as every console method does. Borrows the
 * arguments. */
void scr_console_trace(size_t n, const ScrLogArg *args) {
  ScrStr *frames = scr_stack_capture();
  bool empty = scr_console_message_empty(n, args);
  ScrLogArg *line = malloc((n + 2) * sizeof *line);
  if (!line) scr_trap("scriptc: out of memory\n");
  ScrStr *head = empty ? scr_str_new("Trace", 5) : scr_str_new("Trace: ", 7);
  line[0] = (ScrLogArg){.tag = SCR_ARG_STR, .v.s = head};
  for (size_t i = 0; i < n; i++) {
    line[i + 1] = args[i];
    /* No separator between the header and the first argument: "Trace: "
     * ends in one, and the empty message that prints "Trace" alone must
     * not leave a trailing space. */
    if (i == 0) line[i + 1].tag |= SCR_ARG_GLUE;
  }
  size_t total = n + 1;
  if (frames) {
    /* The frames' text opens with the newline that separates them from an
     * Error's header. */
    line[total++] = (ScrLogArg){.tag = SCR_ARG_STR | SCR_ARG_GLUE, .v.s = frames};
  }
  scr_console_write(2, total, line, true, true);
  scr_str_release(head);
  scr_str_release(frames);
  free(line);
}

/* The string-concatenation twin: the tags the caller passed carry the
 * GLUE and SCR_ARG_NUM bits the renderer already honors. */
void scr_console_trace_parts(size_t n, const ScrLogArg *args) {
  scr_console_trace(n, args);
}

/* A Console instance's line on process stdout (fd 1) or stderr (fd 2):
 * the global console's group indentation does not apply. */
void scr_console_write_fd(int fd, size_t n, const ScrLogArg *args, bool ignore_errors) {
  scr_console_write(fd == 2 ? 2 : 1, n, args, false, ignore_errors);
}

/* One JavaScript-visible raw write. Node's global console and process stream
 * methods hand each chunk to the backing stream when called; they do not
 * retain stdout until a later stderr write, a 64 KiB threshold, or process
 * exit. The runtime remains synchronous internally, so its backpressure
 * surface is still constantly true, but the bytes are observable promptly.
 * A build with `--stdout-buffering` opts out of that promptness on a
 * non-terminal destination (see scr_stdout_settle).
 *
 * Buffered runtime-internal stdout bytes go out first (for both streams) to
 * preserve stdout order and the merged-fd ordering convention. */
int scr_stdio_write_raw(int fd, const void *data, size_t len) {
  if (__builtin_expect(scr_stdio_capture != NULL, 0) && scr_stdio_capture(fd == 2 ? 2 : 1, data, len)) return 0;
#if SCR_STDIO_DIRECT
  if (scr_stdout_buffered && fd != 2) {
    /* Append to the runtime's buffer; it submits the bytes when it fills,
     * and scr_stdout_settle submits the rest at an observable boundary. The
     * stream lock keeps a worker's append from interleaving with another
     * thread's settle. */
    FILE *locked = scr_fd_stream_lock(1);
    int error = scr_stdout_append_locked(data, len);
    scr_fd_stream_unlock(locked);
    return error;
  }
  FILE *locked = scr_fd_stream_lock(fd == 2 ? 2 : 1);
  scr_stdout_pending_flush();
  struct iovec iov = {(void *)data, len};
  int result = len == 0 ? 0 : scr_fd_writev_all(fd == 2 ? 2 : 1, &iov, 1);
  scr_fd_stream_unlock(locked);
  return result;
#else
  FILE *out = fd == 2 ? stderr : stdout;
  if (fd == 2) fflush(stdout);
  if (len > 0 && fwrite(data, 1, len, out) != len) return errno ? errno : EIO;
  if (fflush(out) != 0) return errno ? errno : EIO;
  return 0;
#endif
}

/* A byte chunk (process.stdout.write(buffer), a stream piped to stdout). */
bool scr_stdio_write(int fd, const void *data, size_t len) {
  if (scr_stdio_write_hook) return scr_stdio_write_hook(fd, data, len, SCR_STDIO_HOOK_BYTES);
  (void)scr_stdio_write_raw(fd, data, len);
  return true;
}

/* A string chunk that is plain UTF-8. */
bool scr_stdio_write_text(int fd, const void *data, size_t len) {
  if (scr_stdio_write_hook) return scr_stdio_write_hook(fd, data, len, 0);
  (void)scr_stdio_write_raw(fd, data, len);
  return true;
}

/* A string chunk: a patched write receives the string itself; the stream
 * receives its UTF-8, each lone surrogate as U+FFFD. */
static __attribute__((noinline)) bool scr_stdio_write_wide(int fd, const ScrStr *s) {
  if (scr_stdio_write_hook) return scr_stdio_write_hook(fd, s->data, s->len, SCR_STDIO_HOOK_WIDE);
  char *owned;
  const char *bytes = scr_str_utf8(s, &owned);
  (void)scr_stdio_write_raw(fd, bytes, s->len);
  scr_str_utf8_end(owned);
  return true;
}

bool scr_stdio_write_str(int fd, const ScrStr *s) {
  if (__builtin_expect(scr_wtf8_any(), 0) && !s->ascii) return scr_stdio_write_wide(fd, s);
  return scr_stdio_write_text(fd, s->data, s->len);
}
