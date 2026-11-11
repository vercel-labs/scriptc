/* child_process — the synchronous slice: spawnSync as posix_spawn +
 * piped utf8 capture + waitpid.
 *
 * Node parity notes (SEMANTICS.md has the user-facing story):
 * - The command PATH-searches like Node's (the parent searches PATH and
 *   spawns the candidate; a command containing '/' spawns directly).
 *   `shell` (always with an empty args list — see DEP0190 below) runs the
 *   command line through /bin/sh -c instead.
 * - stdin is /dev/null (Node's spawnSync default reads nothing without
 *   `input`; `input` pipes that string instead); stdout/stderr are
 *   captured to strings, utf8 assumed — the compiler fences every other
 *   encoding.
 * - `status` is the exit code; a child killed by a signal has NO status
 *   (has_status = false → the compiler's `number | null` union takes the
 *   null arm), exactly Node's status: null there.
 * - Spawn FAILURE (nonexistent binary, EACCES) never throws, and a
 *   timeout kill never throws either: the result carries Node's `error`
 *   (code ENOENT/ETIMEDOUT, ETIMEDOUT with the killSignal name as
 *   `signal`), the shape scr_child_error_sync_fields stamps.
 * - No zombies: every successfully spawned child is waitpid()ed before
 *   this function returns, unconditionally.
 */
#include "scr_runtime.h"
#include <math.h>
#include <stdio.h>
#ifdef SCR_CHILD_STREAM_FLOW
#include "scr_child_flow.h"
#endif

/* The Node island build (scr_child.h, "a child process a Node island
 * made"): an entry point hands a handle whose `island` member is set to the
 * island's table before it reads a native field. Every other build, and the
 * Windows arm (islands are POSIX), compiles the guards away. */
#if defined(SCR_NODE_ISLANDS) && !defined(_WIN32)
#define SCR_CHILD_FOREIGN 1
#define SCR_IF_ISLAND(handle, ...) \
  do { \
    if ((handle)->island != NULL) { __VA_ARGS__; } \
  } while (0)
#else
#define SCR_IF_ISLAND(handle, ...) \
  do { \
  } while (0)
#endif

typedef struct ScrIpc ScrIpc;
static ScrIpc *scr_ipc_new(ScrChildStream *reader, ScrChildWriter *writer);
static ScrIpc *scr_ipc_retain(ScrIpc *ipc);
static void scr_ipc_release(ScrIpc *ipc);
static void scr_ipc_service(void);
static bool scr_ipc_pending(void);
static bool scr_ipc_close_ready(const ScrIpc *ipc);
static bool scr_ipc_close_dropped(const ScrIpc *ipc);
static void scr_ipc_deliver(void);
static void scr_ipc_settle(ScrIpc *ipc);
static void scr_child_fire_spawn(ScrChild *c);
static void scr_child_drop_spawn_listeners(ScrChild *c);
static void scr_child_loop_install(void);

static ScrArr *scr_fork_argv(double target, uintptr_t read_handle,
                             uintptr_t write_handle, ScrArr *args) {
  char marker[160];
  int marker_len = snprintf(
      marker, sizeof marker, "--scriptc-fork=%.0f,%llu,%llu", target,
      (unsigned long long)read_handle, (unsigned long long)write_handle);
  if (marker_len < 0 || (size_t)marker_len >= sizeof marker) {
    scr_trap("invalid fork startup marker");
  }
  size_t count = (size_t)scr_arr_len(args);
  ScrArr *out = scr_arr_new(SCR_ELEM_STR, count + 1);
  scr_arr_push_ref(out, scr_str_new(marker, (size_t)marker_len));
  for (size_t i = 0; i < count; i++) {
    scr_arr_push_ref(out, scr_arr_get_ref(args, (double)i));
  }
  return out;
}

static size_t scr_child_arg_start(ScrStr *cmd, ScrArr *args) {
  return scr_lib_should_collapse_reexec_arg(cmd, args) ? 1 : 0;
}

enum {
  SCR_CHILD_DATA_ZERO = 0,
  SCR_CHILD_DATA_BYTES = 1,
  SCR_CHILD_DATA_STRING = 2,
};

/* ── error properties (lib/child_process.js) ──────────────────────────
 * The own properties Node attaches to child_process errors, set on the
 * error's checked-dynamic node (scr_error_set_prop) in Node's key order. */

static ScrDyn *scr_child_dyn_cstr(const char *text) {
  ScrStr *s = scr_str_new(text, strlen(text));
  ScrDyn *d = scr_dyn_new_str(s);
  scr_str_release(s);
  return d;
}

static ScrDyn *scr_child_dyn_text_or_null(const char *text) {
  return text != NULL ? scr_child_dyn_cstr(text) : scr_dyn_new_null();
}

/* A spawn failure's errnoException fields: errno, code (already stamped),
 * syscall "<verb> <file>" and path come from the native system fields,
 * then spawnargs (the arguments after the file). Set before any other
 * property, so the node orders them first. */
static void scr_child_error_spawn_fields(ScrError *e, double uv_errno, const char *verb,
                                         ScrStr *file, ScrArr *args) {
  size_t cap = strlen(verb) + 1 + file->len + 1;
  char *call = malloc(cap);
  if (!call) scr_trap("scriptc: out of memory\n");
  int len = snprintf(call, cap, "%s %s", verb, file->data);
  e->system_errno = uv_errno;
  e->system_call = scr_str_new(call, (size_t)len);
  free(call);
  e->system_path = scr_str_retain(file);
  ScrDyn *spawnargs = scr_dyn_new_arr();
  size_t n = args != NULL ? (size_t)scr_arr_len(args) : 0;
  for (size_t i = 0; i < n; i++) {
    ScrStr *arg = (ScrStr *)scr_arr_get_ref(args, (double)i);
    scr_dyn_arr_push(spawnargs, scr_dyn_new_str(arg));
    scr_str_release(arg);
  }
  scr_error_set_prop(e, "spawnargs", 9, spawnargs);
}

#ifdef SCR_CHILD_ERR_FIELDS
/* Node copies the spawn argument list before running the child, so
 * `spawnargs` answers the values the call was given even when the program
 * rewrites its array after the call; a snapshot of the same values keeps
 * the two equal. +1; NULL for no arguments. */
static ScrArr *scr_child_snapshot_args(ScrArr *args) {
  return args != NULL ? scr_arr_slice(args, 0, (double)scr_arr_len(args)) : NULL;
}
#endif

/* exec/execFile's command failure: code (the exit status, or null after a
 * signal), killed and signal, before cmd. */
static void scr_child_error_exit_fields(ScrError *e, bool has_code, double code,
                                        const char *signal, bool killed) {
  scr_error_set_prop(e, "code", 4, has_code ? scr_dyn_new_num(code) : scr_dyn_new_null());
  scr_error_set_prop(e, "killed", 6, scr_dyn_new_bool(killed));
  scr_error_set_prop(e, "signal", 6, scr_child_dyn_text_or_null(signal));
}

/* The sync forms' spawn failure and timeout carry the error itself as
 * `error` (Node assigns the spawnSync result, whose error it is). */
static void scr_child_error_self(ScrError *e) {
  scr_error_set_prop(e, "error", 5, scr_dyn_from_error(e));
}

static void scr_child_error_cmd(ScrError *e, const char *cmd) {
  scr_error_set_prop(e, "cmd", 3, scr_child_dyn_cstr(cmd));
}

/* The promisified forms add the captured outputs. Borrows. */
static void scr_child_error_outputs(ScrError *e, ScrStr *out, ScrStr *err) {
  scr_error_set_prop(e, "stdout", 6, scr_dyn_new_str(out));
  scr_error_set_prop(e, "stderr", 6, scr_dyn_new_str(err));
}

/* A captured sync output as Node's result holds it: a Buffer, the utf8
 * string with an encoding option, or null for a stream that was not
 * piped. +1. */
static ScrDyn *scr_child_sync_output(const char *data, size_t len, bool piped, bool buffers) {
  if (!piped) return scr_dyn_new_null();
  if (!buffers) {
    ScrStr *s = scr_str_new(data, len);
    ScrDyn *d = scr_dyn_new_str(s);
    scr_str_release(s);
    return d;
  }
  ScrBytes *b = scr_bytes_new(SCR_BYTES_U8, (double)len);
  b->is_buffer = true;
  if (len) memcpy(b->data, data, len);
  ScrDyn *d = scr_dyn_new_buffer(b);
  scr_bytes_release(b);
  return d;
}

/* The spawnSync capture accessors (scr_spawn_res_stdout_bytes /
 * scr_spawn_res_stderr_bytes, and the one-Buffer-per-capture memo behind
 * them) live in scr_child_capture.c, a unit linked only by programs that
 * read an unencoded capture. Nothing in this unit names them: a unit of the
 * always-linked set may not reference an optional one, because a link of
 * that set alone (the runtime unit tests, and the precompiled pack's own
 * archive) would carry the undefined symbol — which is exactly what broke
 * every Windows program when the accessors lived here. */
/* execSync/execFileSync: the spawnSync result's status, signal, output,
 * pid, stdout and stderr. out/err move in (null for a stream that was not
 * piped); output is [null, stdout, stderr]. A child that never started
 * has a null output and undefined outputs. */
static void scr_child_error_sync_fields(ScrError *e, bool has_status, double status,
                                        const char *signal, double pid, bool started,
                                        ScrDyn *out, ScrDyn *err) {
  if (!started) {
    scr_dyn_release(out);
    scr_dyn_release(err);
    out = scr_dyn_retain(scr_dyn_undefined());
    err = scr_dyn_retain(scr_dyn_undefined());
  }
  scr_error_set_prop(e, "status", 6, has_status ? scr_dyn_new_num(status) : scr_dyn_new_null());
  scr_error_set_prop(e, "signal", 6, scr_child_dyn_text_or_null(signal));
  if (started) {
    ScrDyn *output = scr_dyn_new_arr();
    scr_dyn_arr_push(output, scr_dyn_new_null());
    scr_dyn_arr_push(output, scr_dyn_retain(out));
    scr_dyn_arr_push(output, scr_dyn_retain(err));
    scr_error_set_prop(e, "output", 6, output);
  } else {
    scr_error_set_prop(e, "output", 6, scr_dyn_new_null());
  }
  scr_error_set_prop(e, "pid", 3, scr_dyn_new_num(pid));
  scr_error_set_prop(e, "stdout", 6, out);
  scr_error_set_prop(e, "stderr", 6, err);
}

/* ── maxBuffer (lib/child_process.js, src/spawn_sync.cc) ───────────────
 * Every capturing form has a limit. Node's default is 1024 * 1024; a
 * program's own maxBuffer arrives through scr_child_max_buffer, which the
 * compiler calls after the capturing call's arguments are evaluated and
 * immediately before the call, so the next capture is the one it belongs
 * to. The synchronous forms count stdout and stderr together in bytes and
 * report ENOBUFS, 0 meaning no limit; exec and execFile limit each stream
 * in UTF-16 units of the decoded text and report
 * ERR_CHILD_PROCESS_STDIO_MAXBUFFER. */
#define SCR_CHILD_MAX_BUFFER_DEFAULT 1048576.0
static SCR_TL bool scr_child_max_armed;
static SCR_TL double scr_child_max_value;

/* validateMaxBuffer: a negative or NaN value throws Node's
 * ERR_OUT_OF_RANGE before anything spawns. `arm` makes the value the next
 * capture's limit; without it the call only validates (the promisified
 * forms validate where they are called and capture inside their helper). */
void scr_child_max_buffer(double max_buffer, bool arm) {
  if (!(max_buffer >= 0)) {
    char received[48];
    scr_num_received(max_buffer, received);
    char msg[160];
    int len = snprintf(msg, sizeof msg,
                       "The value of \"options.maxBuffer\" is out of range. It must be a "
                       "positive number. Received %s",
                       received);
    scr_throw_error_msg_code(SCR_ERR_RANGE, msg, (size_t)len, "ERR_OUT_OF_RANGE");
    return;
  }
  if (arm) {
    scr_child_max_armed = true;
    scr_child_max_value = max_buffer;
  }
}

/* The limit of the capture that starts now. */
static double scr_child_max_take(void) {
  double max_buffer = scr_child_max_armed ? scr_child_max_value : SCR_CHILD_MAX_BUFFER_DEFAULT;
  scr_child_max_armed = false;
  return max_buffer;
}

/* The bytes at the end of `data` that start a UTF-8 sequence the data
 * does not complete (0-3): the part a StringDecoder holds back until the
 * next chunk. */
static size_t scr_utf8_incomplete_tail(const uint8_t *data, size_t len) {
  for (size_t back = 1; back <= 3 && back <= len; back++) {
    uint8_t b = data[len - back];
    if ((b & 0xC0) == 0x80) continue;
    size_t need = (b & 0xE0) == 0xC0 ? 2 : (b & 0xF0) == 0xE0 ? 3 : (b & 0xF8) == 0xF0 ? 4 : 1;
    return need > back ? back : 0;
  }
  return 0;
}

/* One chunk of an exec/execFile capture under Node's per-stream check.
 * The chunk was appended to data[chunk_start..*len). Node decodes each
 * chunk as utf8, adds its byte length to the stream's total (*text_len),
 * and once the total exceeds maxBuffer keeps only `maxBuffer - previous
 * total` UTF-16 code units of that chunk's text. On that overflow the
 * capture is cut accordingly (*len shrinks; a split surrogate pair keeps
 * its high half as WTF-8) and the result is true. */
static bool scr_exec_limit_chunk(uint8_t *data, size_t *len, size_t chunk_start,
                                 double *text_len, double max_buffer) {
  size_t carried = scr_utf8_incomplete_tail(data, chunk_start);
  size_t text_start = chunk_start - carried;
  size_t text_end = *len - scr_utf8_incomplete_tail(data, *len);
  if (text_end < text_start) text_end = text_start;
  double before = *text_len;
  *text_len = before + (double)(text_end - text_start);
  if (!(*text_len > max_buffer)) return false;
  /* Node slices the chunk at `maxBuffer - previous total`, and a slice end
   * is truncated to an integer: a fractional limit keeps only whole units.
   * The previous total was within the limit, so `keep` is not negative and
   * below the chunk's length. */
  double keep = floor(max_buffer - before);
  double units = 0;
  size_t at = text_start;
  while (at < text_end && units < keep) {
    uint8_t b = data[at];
    size_t n = (b & 0xE0) == 0xC0 ? 2 : (b & 0xF0) == 0xE0 ? 3 : (b & 0xF8) == 0xF0 ? 4 : 1;
    if (at + n > text_end) n = 1;
    double u = n == 4 ? 2 : 1;
    if (units + u <= keep) {
      at += n;
      units += u;
      continue;
    }
    /* Exactly one unit left inside a complete astral character: Node's
     * slice keeps the lone high surrogate. */
    if (n != 4 || keep - units != 1) break;
    uint32_t cp = ((uint32_t)(b & 0x07) << 18) | ((uint32_t)(data[at + 1] & 0x3F) << 12) |
                  ((uint32_t)(data[at + 2] & 0x3F) << 6) | (uint32_t)(data[at + 3] & 0x3F);
    uint32_t hi = 0xD800 + ((cp - 0x10000) >> 10);
    data[at] = 0xED;
    data[at + 1] = (uint8_t)(0xA0 | ((hi >> 6) & 0x0F));
    data[at + 2] = (uint8_t)(0x80 | (hi & 0x3F));
    scr_wtf8_note();
    at += 3;
    break;
  }
  *len = at;
  return true;
}

/* exec's maxBuffer error (+1): a RangeError with Node's code, then cmd. */
static ScrError *scr_child_max_error(const char *stream, const char *display) {
  char msg[48];
  int len = snprintf(msg, sizeof msg, "%s maxBuffer length exceeded", stream);
  ScrStr *message = scr_str_new(msg, (size_t)len);
  ScrError *e = scr_error_new(SCR_ERR_RANGE, message);
  scr_str_release(message);
  scr_error_set_code(e, "ERR_CHILD_PROCESS_STDIO_MAXBUFFER");
  scr_child_error_cmd(e, display);
  return e;
}

/* exec/execFile's own limit on a child it just started (below, after
 * both arms): reads the pending maxBuffer and watches both captures. */
static void scr_exec_limit_install(ScrChild *c);

#ifdef _WIN32
/* ── Windows arm: real children via CreateProcessW ────────────────────
 * The POSIX arm below owns the corresponding implementation; this arm
 * reimplements the exported
 * surface over Win32 primitives, matching Node-on-Windows (libuv) and
 * verified against the windows-dev box's Node:
 * - Executable resolution ports libuv's search_path: a command with a
 *   path separator resolves against the effective cwd; a bare name
 *   searches cwd first (CreateProcess's legacy behavior, kept by libuv)
 *   then each PATH entry — trying the literal name only when it has an
 *   extension, then appending (never replacing) .com and .exe.
 *   Resolution failure is Node's ENOENT spawn failure.
 * - The command line is libuv's quote_cmd_arg algorithm, ported exactly:
 *   args without space/tab/quote ride verbatim, args with neither quote
 *   nor backslash just get wrapped, everything else takes the
 *   reverse-scan escape (backslash runs double only before a quote or
 *   the closing wrap; quotes escape with a backslash; "" for empty).
 * - A replaced env becomes a SORTED UTF-16 block (CompareStringOrdinal,
 *   ordinal case-insensitive on the key — libuv's env_strncmp) with
 *   libuv's required vars (SYSTEMROOT, PATH, TEMP, ...) copied from the
 *   parent when missing, so winsock and PATH-dependent children keep
 *   working; the child's PATH (its own, or the merged parent's) is what
 *   the executable search walks, like uv_spawn.
 * - stdio is HANDLE inheritance: anonymous pipes for capture and
 *   child.stdout/stderr (PeekNamedPipe polls readiness), an overlapped
 *   local named pipe for writable child.stdin, NUL for ignore, duplicated
 *   std handles for inherit, and _get_osfhandle for the fd form. The sync
 *   input feed retains its separate PIPE_NOWAIT path.
 * - There are no signals: kill/killSignal for SIGTERM/SIGKILL/SIGINT/
 *   SIGQUIT/SIGHUP is TerminateProcess(handle, 1) with the signal NAME
 *   reported on the result/exit event, libuv's uv_kill emulation (a
 *   killed child's status is null + the signal name; nothing else can
 *   die "to a signal"). Other names answer false (libuv: ENOSYS).
 * - The async family rides the loop's existing hooks: scr_children_wait
 *   waits on the child process HANDLES (WaitForMultipleObjects) so an
 *   exit wakes the quiescent sleep immediately; piped streams with a
 *   consumer and pending spawn failures DECLINE the wait, keeping the
 *   loop's ~1ms polling cap (pipe readability has no waitable handle),
 *   exactly the POSIX arm's unwatched fallback.
 * - async spawn({ shell: true }) resolves ComSpec (cmd.exe fallback) and
 *   uses Node's /d /s /c command line. execSync retains its older static
 *   /bin/sh lowering and remains separately fenced on Windows.
 * - libuv also assigns children to a kill-on-parent-death job object;
 *   this arm does not (a parent crash can orphan a running child — the
 *   sync cores always reap or kill before returning). */

#include <windows.h>

#include <io.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>

/* uv's emulated numbers for the rows mingw's signal.h lacks (the same
 * values scr_lib.c's name table uses). */
#ifndef SIGHUP
#define SIGHUP 1
#endif
#ifndef SIGQUIT
#define SIGQUIT 3
#endif
#ifndef SIGKILL
#define SIGKILL 9
#endif

static void scr_child_oom(void) {
  fputs("scriptc: out of memory\n", stderr);
  abort();
}

/* ── small helpers ───────────────────────────────────────────────────── */

/* utf8 (the runtime's strings) → malloc'd, NUL-terminated UTF-16. */
static WCHAR *scr_child_wide(const char *s, size_t len) {
  int n = len > 0 ? MultiByteToWideChar(CP_UTF8, 0, s, (int)len, NULL, 0) : 0;
  WCHAR *w = malloc(((size_t)n + 1) * sizeof(WCHAR));
  if (!w) scr_child_oom();
  if (n > 0) MultiByteToWideChar(CP_UTF8, 0, s, (int)len, w, n);
  w[n] = L'\0';
  return w;
}

/* Node's error-code names for the failures a spawn can hit (libuv's
 * sys-error translation, the reachable rows). */
static const char *scr_win_errname(DWORD err) {
  switch (err) {
  case ERROR_FILE_NOT_FOUND:
  case ERROR_PATH_NOT_FOUND:
  case ERROR_INVALID_NAME:
  case ERROR_DIRECTORY:
  case ERROR_BAD_PATHNAME:
    return "ENOENT";
  case ERROR_ACCESS_DENIED:
    return "EACCES";
  case ERROR_NOT_ENOUGH_MEMORY:
  case ERROR_OUTOFMEMORY:
    return "ENOMEM";
  case ERROR_BAD_EXE_FORMAT:
    return "EFTYPE"; /* libuv's map for a non-PE spawn target */
  default:
    return "EUNKNOWN";
  }
}

/* child.exitCode after a spawn-failure settle: Node flips it to the
 * NEGATIVE uv errno, whose values are Windows-specific (uv-errno.h). */
static int scr_win_uv_errno(const char *name) {
  if (strcmp(name, "ENOENT") == 0) return -4058;
  if (strcmp(name, "EACCES") == 0) return -4092;
  return -4094; /* UV_UNKNOWN */
}

/* ── libuv's quote_cmd_arg, ported exactly ───────────────────────────── */

/* Quotes one argument into `target` (caller sized it: 2*len + 2 worst
 * case); returns the next write position. The three tiers and the
 * reverse-scan escape are ported exactly from libuv — Windows Node builds
 * its child command lines with this exact function, so matching it IS
 * the parity story (CommandLineToArgvW round-trips every case). */
static WCHAR *scr_quote_cmd_arg(const WCHAR *source, WCHAR *target) {
  size_t len = wcslen(source);
  size_t i;
  int quote_hit;
  WCHAR *start;

  if (len == 0) {
    /* Need double quotation for empty argument. */
    *(target++) = L'"';
    *(target++) = L'"';
    return target;
  }

  if (NULL == wcspbrk(source, L" \t\"")) {
    /* No quotation needed. */
    wcsncpy(target, source, len);
    target += len;
    return target;
  }

  if (NULL == wcspbrk(source, L"\"\\")) {
    /* No embedded double quotes or backslashes: wrap in quote marks. */
    *(target++) = L'"';
    wcsncpy(target, source, len);
    target += len;
    *(target++) = L'"';
    return target;
  }

  /* The expensive way: reverse scan so a backslash doubles exactly when
   * a quote (or the closing wrap) follows it.
   *   hello"world    → "hello\"world"
   *   hello\world    → hello\world (tier 2 caught it — unreachable here)
   *   hello\"world   → "hello\\\"world"
   *   hello world\   → "hello world\\" */
  *(target++) = L'"';
  start = target;
  quote_hit = 1;
  for (i = len; i > 0; --i) {
    *(target++) = source[i - 1];
    if (quote_hit && source[i - 1] == L'\\') {
      *(target++) = L'\\';
    } else if (source[i - 1] == L'"') {
      quote_hit = 1;
      *(target++) = L'\\';
    } else {
      quote_hit = 0;
    }
  }
  target[0] = L'\0';
  _wcsrev(start);
  *(target++) = L'"';
  return target;
}

/* cmd + args → the full malloc'd command line (argv[0] is the command AS
 * TYPED — CreateProcessW's lpApplicationName carries the resolved path,
 * so the child's argv[0] stays the caller's spelling, like Node). */
static WCHAR *scr_child_cmdline(ScrStr *cmd, ScrArr *args) {
  size_t start = scr_child_arg_start(cmd, args);
  size_t n = (size_t)scr_arr_len(args) - start;
  size_t argc = n + 1;
  WCHAR **wargs = malloc(argc * sizeof(WCHAR *));
  if (!wargs) scr_child_oom();
  wargs[0] = scr_child_wide(cmd->data, cmd->len);
  for (size_t i = 0; i < n; i++) {
    ScrStr *s = (ScrStr *)scr_arr_get_ref(args, (double)(i + start));
    wargs[i + 1] = scr_child_wide(s->data, s->len);
    scr_str_release(s);
  }
  size_t total = 1; /* the terminator */
  for (size_t i = 0; i < argc; i++) total += wcslen(wargs[i]) * 2 + 3;
  WCHAR *dst = malloc(total * sizeof(WCHAR));
  if (!dst) scr_child_oom();
  WCHAR *pos = dst;
  for (size_t i = 0; i < argc; i++) {
    pos = scr_quote_cmd_arg(wargs[i], pos);
    *pos++ = i + 1 < argc ? L' ' : L'\0';
    free(wargs[i]);
  }
  free(wargs);
  return dst;
}

/* ── the environment block (libuv's make_program_env) ────────────────── */

/* Ordinal case-insensitive key comparison — libuv's env_strncmp: keys
 * run to the first '='; na < 0 means "find it in a". */
static int scr_env_keycmp(const WCHAR *a, int na, const WCHAR *b) {
  if (na < 0) {
    const WCHAR *a_eq = wcschr(a, L'=');
    na = a_eq != NULL ? (int)(a_eq - a) : (int)wcslen(a);
  }
  const WCHAR *b_eq = wcschr(b, L'=');
  int nb = b_eq != NULL ? (int)(b_eq - b) : (int)wcslen(b);
  return CompareStringOrdinal(a, na, b, nb, TRUE) - CSTR_EQUAL;
}

static int scr_env_qsortcmp(const void *a, const void *b) {
  return scr_env_keycmp(*(WCHAR *const *)a, -1, *(WCHAR *const *)b);
}

/* libuv's required vars: winsock fails to initialize without SYSTEMROOT,
 * PATH keeps executable search alive, TEMP feeds every temp-file API —
 * a replaced env inherits these from the parent when it does not set
 * them itself. Keys only (values fetched live). */
static const WCHAR *const scr_env_required[] = {
    L"HOMEDRIVE", L"HOMEPATH", L"LOGONSERVER",  L"PATH",     L"SYSTEMDRIVE",
    L"SYSTEMROOT", L"TEMP",    L"USERDOMAIN",   L"USERNAME", L"USERPROFILE",
};

/* [k,v,...] pairs → the sorted, double-NUL-terminated CreateProcessW
 * block (CREATE_UNICODE_ENVIRONMENT), required vars merged in. */
static WCHAR *scr_child_env_block(ScrArr *pairs) {
  size_t n = (size_t)scr_arr_len(pairs) / 2;
  size_t nreq = sizeof scr_env_required / sizeof scr_env_required[0];
  WCHAR **items = malloc((n + nreq) * sizeof(WCHAR *));
  if (!items) scr_child_oom();
  size_t count = 0;
  for (size_t i = 0; i < n; i++) {
    ScrStr *k = (ScrStr *)scr_arr_get_ref(pairs, (double)(2 * i));
    ScrStr *v = (ScrStr *)scr_arr_get_ref(pairs, (double)(2 * i + 1));
    WCHAR *kw = scr_child_wide(k->data, k->len);
    WCHAR *vw = scr_child_wide(v->data, v->len);
    size_t kl = wcslen(kw), vl = wcslen(vw);
    WCHAR *kv = malloc((kl + 1 + vl + 1) * sizeof(WCHAR));
    if (!kv) scr_child_oom();
    wmemcpy(kv, kw, kl);
    kv[kl] = L'=';
    wmemcpy(kv + kl + 1, vw, vl + 1);
    items[count++] = kv;
    free(kw);
    free(vw);
    scr_str_release(k);
    scr_str_release(v);
  }
  for (size_t r = 0; r < nreq; r++) {
    bool present = false;
    for (size_t i = 0; i < count && !present; i++) {
      present = scr_env_keycmp(scr_env_required[r], (int)wcslen(scr_env_required[r]), items[i]) == 0;
    }
    if (present) continue;
    DWORD need = GetEnvironmentVariableW(scr_env_required[r], NULL, 0);
    if (need == 0) continue; /* the parent lacks it too */
    size_t kl = wcslen(scr_env_required[r]);
    WCHAR *kv = malloc((kl + 1 + (size_t)need) * sizeof(WCHAR));
    if (!kv) scr_child_oom();
    wmemcpy(kv, scr_env_required[r], kl);
    kv[kl] = L'=';
    (void)GetEnvironmentVariableW(scr_env_required[r], kv + kl + 1, need);
    items[count++] = kv;
  }
  qsort(items, count, sizeof(WCHAR *), scr_env_qsortcmp);
  size_t total = 1; /* the block's extra terminator */
  for (size_t i = 0; i < count; i++) total += wcslen(items[i]) + 1;
  WCHAR *block = malloc(total * sizeof(WCHAR));
  if (!block) scr_child_oom();
  WCHAR *at = block;
  for (size_t i = 0; i < count; i++) {
    size_t len = wcslen(items[i]) + 1;
    wmemcpy(at, items[i], len);
    at += len;
    free(items[i]);
  }
  *at = L'\0';
  free(items);
  return block;
}

/* The child's PATH: its own block's entry when env was replaced (the
 * required-vars merge already pulled the parent's in when unset), the
 * parent's otherwise. malloc'd, NULL when absent everywhere. */
static WCHAR *scr_child_path(const WCHAR *env_block) {
  if (env_block != NULL) {
    for (const WCHAR *p = env_block; *p != L'\0'; p += wcslen(p) + 1) {
      if ((p[0] == L'P' || p[0] == L'p') && (p[1] == L'A' || p[1] == L'a') &&
          (p[2] == L'T' || p[2] == L't') && (p[3] == L'H' || p[3] == L'h') &&
          p[4] == L'=') {
        size_t len = wcslen(p + 5);
        WCHAR *out = malloc((len + 1) * sizeof(WCHAR));
        if (!out) scr_child_oom();
        wmemcpy(out, p + 5, len + 1);
        return out;
      }
    }
    return NULL;
  }
  DWORD need = GetEnvironmentVariableW(L"PATH", NULL, 0);
  if (need == 0) return NULL;
  WCHAR *out = malloc((size_t)need * sizeof(WCHAR));
  if (!out) scr_child_oom();
  (void)GetEnvironmentVariableW(L"PATH", out, need);
  return out;
}

/* ── libuv's search_path, ported ─────────────────────────────────────── */

/* Joins dir + name + ext against cwd (the drive-relative dance included)
 * and answers the malloc'd path when a non-directory file exists there. */
static WCHAR *scr_spath_join_test(const WCHAR *dir, size_t dir_len,
                                  const WCHAR *name, size_t name_len,
                                  const WCHAR *ext, size_t ext_len,
                                  const WCHAR *cwd, size_t cwd_len) {
  if (dir_len > 2 && ((dir[0] == L'\\' || dir[0] == L'/') &&
                      (dir[1] == L'\\' || dir[1] == L'/'))) {
    /* UNC path: ignore cwd. */
    cwd_len = 0;
  } else if (dir_len >= 1 && (dir[0] == L'/' || dir[0] == L'\\')) {
    /* Full path without drive letter: use cwd's drive only. */
    cwd_len = 2;
  } else if (dir_len >= 2 && dir[1] == L':' &&
             (dir_len < 3 || (dir[2] != L'/' && dir[2] != L'\\'))) {
    /* Relative path with drive letter (D:../file): replace the drive
     * letter with the full cwd when they agree, else the dir alone. */
    if (cwd_len < 2 || _wcsnicmp(cwd, dir, 2) != 0) {
      cwd_len = 0;
    } else {
      dir += 2;
      dir_len -= 2;
    }
  } else if (dir_len > 2 && dir[1] == L':') {
    /* Absolute path with drive letter: no cwd at all. */
    cwd_len = 0;
  }

  WCHAR *result = malloc((cwd_len + 1 + dir_len + 1 + name_len + 1 + ext_len + 1) * sizeof(WCHAR));
  if (!result) scr_child_oom();
  WCHAR *pos = result;
  wcsncpy(pos, cwd, cwd_len);
  pos += cwd_len;
  if (cwd_len && wcsrchr(L"\\/:", pos[-1]) == NULL) *pos++ = L'\\';
  wcsncpy(pos, dir, dir_len);
  pos += dir_len;
  if (dir_len && wcsrchr(L"\\/:", pos[-1]) == NULL) *pos++ = L'\\';
  wcsncpy(pos, name, name_len);
  pos += name_len;
  if (ext_len) {
    if (name_len && pos[-1] != L'.') *pos++ = L'.';
    wcsncpy(pos, ext, ext_len);
    pos += ext_len;
  }
  *pos = L'\0';

  DWORD attrs = GetFileAttributesW(result);
  if (attrs != INVALID_FILE_ATTRIBUTES && !(attrs & FILE_ATTRIBUTE_DIRECTORY)) {
    return result;
  }
  free(result);
  return NULL;
}

/* The literal name (only when it has an extension), then .com, then .exe
 * — appended, never replacing (libuv follows msvcrt's spawn here). */
static WCHAR *scr_spath_walk_ext(const WCHAR *dir, size_t dir_len,
                                 const WCHAR *name, size_t name_len,
                                 const WCHAR *cwd, size_t cwd_len,
                                 int name_has_ext) {
  WCHAR *result;
  if (name_has_ext) {
    result = scr_spath_join_test(dir, dir_len, name, name_len, L"", 0, cwd, cwd_len);
    if (result != NULL) return result;
  }
  result = scr_spath_join_test(dir, dir_len, name, name_len, L"com", 3, cwd, cwd_len);
  if (result != NULL) return result;
  return scr_spath_join_test(dir, dir_len, name, name_len, L"exe", 3, cwd, cwd_len);
}

/* file + cwd + PATH → the malloc'd absolute executable path, or NULL
 * (Node's ENOENT). A file containing a separator never walks PATH; a
 * bare name checks cwd first (CreateProcess's legacy order, kept by
 * libuv behind NeedCurrentDirectoryForExePathW) then each PATH slice,
 * quoted slices unwrapped, empty slices skipped. */
static WCHAR *scr_search_path(const WCHAR *file, const WCHAR *cwd, const WCHAR *path) {
  size_t file_len = wcslen(file);
  size_t cwd_len = wcslen(cwd);

  if (file_len == 0 || (file_len == 1 && file[0] == L'.')) return NULL;

  const WCHAR *file_name_start;
  for (file_name_start = file + file_len;
       file_name_start > file && file_name_start[-1] != L'\\' &&
       file_name_start[-1] != L'/' && file_name_start[-1] != L':';
       file_name_start--) {
  }
  int file_has_dir = file_name_start != file;
  const WCHAR *dot = wcschr(file_name_start, L'.');
  int name_has_ext = dot != NULL && dot[1] != L'\0';

  if (file_has_dir) {
    return scr_spath_walk_ext(file, (size_t)(file_name_start - file),
                              file_name_start, file_len - (size_t)(file_name_start - file),
                              cwd, cwd_len, name_has_ext);
  }

  WCHAR *result = NULL;
  if (NeedCurrentDirectoryForExePathW(L"")) {
    result = scr_spath_walk_ext(L"", 0, file, file_len, cwd, cwd_len, name_has_ext);
  }
  const WCHAR *dir_end = path;
  while (result == NULL) {
    if (dir_end == NULL || *dir_end == L'\0') break;
    /* Skip the separator dir_end points at. */
    if (dir_end != path || *path == L';') dir_end++;
    const WCHAR *dir_start = dir_end;
    if (*dir_start == L'"' || *dir_start == L'\'') {
      dir_end = wcschr(dir_start + 1, *dir_start);
      if (dir_end == NULL) dir_end = wcschr(dir_start, L'\0');
    }
    dir_end = wcschr(dir_end, L';');
    if (dir_end == NULL) dir_end = wcschr(dir_start, L'\0');
    if (dir_end - dir_start == 0) continue;
    const WCHAR *dir_path = dir_start;
    size_t dir_len = (size_t)(dir_end - dir_start);
    if (dir_path[0] == L'"' || dir_path[0] == L'\'') {
      ++dir_path;
      --dir_len;
    }
    if (dir_len > 0 && (dir_path[dir_len - 1] == L'"' || dir_path[dir_len - 1] == L'\'')) {
      --dir_len;
    }
    if (dir_len == 0) continue;
    result = scr_spath_walk_ext(dir_path, dir_len, file, file_len, cwd, cwd_len, name_has_ext);
  }
  return result;
}

/* ── process creation (shared by the sync cores and spawn) ───────────── */

typedef struct {
  /* in: the child's stdio handles (already inheritable; NULL = that
   * slot stays whatever CreateProcess gives a detached-from-console
   * child — callers always fill all three). */
  HANDLE in_child, out_child, err_child;
  const ScrStr *cwd; /* NULL: inherit */
  ScrArr *env_pairs; /* NULL: inherit */
  bool detached;
  /* out */
  HANDLE proc;
  DWORD pid;
  const char *errname; /* NULL = spawned */
} ScrWinSpawn;

static WCHAR *scr_child_shell_cmdline(const WCHAR *shell, const WCHAR *command) {
  size_t total = (wcslen(shell) * 2 + 3) + 11 + wcslen(command) + 2;
  WCHAR *line = malloc(total * sizeof(WCHAR));
  if (!line) scr_child_oom();
  WCHAR *at = scr_quote_cmd_arg(shell, line);
  const WCHAR prefix[] = L" /d /s /c \"";
  wmemcpy(at, prefix, sizeof prefix / sizeof prefix[0] - 1);
  at += sizeof prefix / sizeof prefix[0] - 1;
  size_t command_len = wcslen(command);
  wmemcpy(at, command, command_len);
  at += command_len;
  *at++ = L'"';
  *at = L'\0';
  return line;
}

static void scr_win_create_process(ScrStr *cmd, ScrArr *args, ScrWinSpawn *sp,
                                   bool shell) {
  sp->proc = NULL;
  sp->pid = 0;
  sp->errname = NULL;

  WCHAR *cwd_w;
  if (sp->cwd != NULL) {
    cwd_w = scr_child_wide(sp->cwd->data, sp->cwd->len);
  } else {
    DWORD need = GetCurrentDirectoryW(0, NULL);
    cwd_w = malloc((size_t)(need > 0 ? need : 1) * sizeof(WCHAR));
    if (!cwd_w) scr_child_oom();
    cwd_w[0] = L'\0';
    if (need > 0) (void)GetCurrentDirectoryW(need, cwd_w);
  }
  WCHAR *env_block = sp->env_pairs != NULL ? scr_child_env_block(sp->env_pairs) : NULL;
  WCHAR *path_w = scr_child_path(env_block);
  WCHAR *file_w;
  if (shell) {
    DWORD need = GetEnvironmentVariableW(L"ComSpec", NULL, 0);
    if (need == 0) {
      file_w = scr_child_wide("cmd.exe", 7);
    } else {
      file_w = malloc((size_t)need * sizeof(WCHAR));
      if (!file_w) scr_child_oom();
      (void)GetEnvironmentVariableW(L"ComSpec", file_w, need);
    }
  } else {
    file_w = scr_child_wide(cmd->data, cmd->len);
  }
  WCHAR *app = scr_search_path(file_w, cwd_w, path_w);
  if (app == NULL) {
    sp->errname = "ENOENT";
    free(file_w);
    free(path_w);
    free(env_block);
    free(cwd_w);
    return;
  }
  WCHAR *command_w = shell ? scr_child_wide(cmd->data, cmd->len) : NULL;
  WCHAR *cmdline = shell
      ? scr_child_shell_cmdline(file_w, command_w)
      : scr_child_cmdline(cmd, args);
  free(command_w);

  STARTUPINFOW si;
  memset(&si, 0, sizeof si);
  si.cb = sizeof si;
  si.dwFlags = STARTF_USESTDHANDLES;
  si.hStdInput = sp->in_child;
  si.hStdOutput = sp->out_child;
  si.hStdError = sp->err_child;
  DWORD flags = CREATE_UNICODE_ENVIRONMENT;
  if (sp->detached) flags |= DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP;

  PROCESS_INFORMATION pi;
  if (!CreateProcessW(app, cmdline, NULL, NULL, TRUE, flags, env_block,
                      sp->cwd != NULL ? cwd_w : NULL, &si, &pi)) {
    sp->errname = scr_win_errname(GetLastError());
  } else {
    CloseHandle(pi.hThread);
    sp->proc = pi.hProcess;
    sp->pid = pi.dwProcessId;
  }
  free(cmdline);
  free(app);
  free(file_w);
  free(path_w);
  free(env_block);
  free(cwd_w);
}

/* Inheritable stdio helpers. Every handle these mint is CLOSED by the
 * caller after CreateProcessW (the child holds its own copies). */
static HANDLE scr_win_nul(bool writable) {
  SECURITY_ATTRIBUTES sa = {sizeof(SECURITY_ATTRIBUTES), NULL, TRUE};
  HANDLE h = CreateFileW(L"NUL", writable ? GENERIC_WRITE : GENERIC_READ,
                         FILE_SHARE_READ | FILE_SHARE_WRITE, &sa, OPEN_EXISTING, 0, NULL);
  return h == INVALID_HANDLE_VALUE ? NULL : h;
}

static HANDLE scr_win_dup_inherit(HANDLE src) {
  if (src == NULL || src == INVALID_HANDLE_VALUE) return NULL;
  HANDLE out = NULL;
  if (!DuplicateHandle(GetCurrentProcess(), src, GetCurrentProcess(), &out, 0,
                       TRUE, DUPLICATE_SAME_ACCESS)) {
    return NULL;
  }
  return out;
}

/* A capture/stream pipe: child's end inheritable, parent's not. False =
 * pipe exhaustion (the caller degrades the slot to NUL). */
static bool scr_win_pipe(HANDLE *parent_end, HANDLE *child_end, bool child_writes) {
  SECURITY_ATTRIBUTES sa = {sizeof(SECURITY_ATTRIBUTES), NULL, TRUE};
  HANDLE rd = NULL, wr = NULL;
  if (!CreatePipe(&rd, &wr, &sa, 65536)) return false;
  *parent_end = child_writes ? rd : wr;
  *child_end = child_writes ? wr : rd;
  (void)SetHandleInformation(*parent_end, HANDLE_FLAG_INHERIT, 0);
  return true;
}

/* CreatePipe cannot make the parent end overlapped. A local one-instance
 * named pipe gives the child an ordinary inheritable read handle and the
 * parent a non-inheritable FILE_FLAG_OVERLAPPED write handle, so a full
 * stdin pipe never blocks the JavaScript thread. */
static LONG scr_win_stdin_pipe_seq = 0;
static bool scr_win_stdin_pipe(HANDLE *parent_end, HANDLE *child_end) {
  WCHAR name[128];
  LONG seq = InterlockedIncrement(&scr_win_stdin_pipe_seq);
  _snwprintf(name, sizeof name / sizeof name[0],
             L"\\\\.\\pipe\\scriptc-stdin-%lu-%ld",
             (unsigned long)GetCurrentProcessId(), (long)seq);
  name[sizeof name / sizeof name[0] - 1] = L'\0';

  SECURITY_ATTRIBUTES child_sa = {sizeof(SECURITY_ATTRIBUTES), NULL, TRUE};
  HANDLE rd = CreateNamedPipeW(
      name, PIPE_ACCESS_INBOUND,
      PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT,
      1, 65536, 65536, 0, &child_sa);
  if (rd == INVALID_HANDLE_VALUE) return false;

  HANDLE wr = CreateFileW(name, GENERIC_WRITE, 0, NULL, OPEN_EXISTING,
                          FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OVERLAPPED, NULL);
  if (wr == INVALID_HANDLE_VALUE) {
    CloseHandle(rd);
    return false;
  }
  if (!ConnectNamedPipe(rd, NULL) && GetLastError() != ERROR_PIPE_CONNECTED) {
    CloseHandle(wr);
    CloseHandle(rd);
    return false;
  }
  (void)SetHandleInformation(wr, HANDLE_FLAG_INHERIT, 0);
  *parent_end = wr;
  *child_end = rd;
  return true;
}

/* The reverse direction used by fork IPC: a non-inheritable synchronous
 * reader in the parent and an inheritable OVERLAPPED writer in the child. */
static bool scr_win_ipc_child_writer_pipe(HANDLE *parent_end,
                                          HANDLE *child_end) {
  WCHAR name[128];
  LONG seq = InterlockedIncrement(&scr_win_stdin_pipe_seq);
  _snwprintf(name, sizeof name / sizeof name[0],
             L"\\\\.\\pipe\\scriptc-ipc-%lu-%ld",
             (unsigned long)GetCurrentProcessId(), (long)seq);
  name[sizeof name / sizeof name[0] - 1] = L'\0';

  HANDLE rd = CreateNamedPipeW(
      name, PIPE_ACCESS_INBOUND,
      PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT,
      1, 65536, 65536, 0, NULL);
  if (rd == INVALID_HANDLE_VALUE) return false;
  SECURITY_ATTRIBUTES child_sa = {sizeof(SECURITY_ATTRIBUTES), NULL, TRUE};
  HANDLE wr = CreateFileW(name, GENERIC_WRITE, 0, &child_sa, OPEN_EXISTING,
                          FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OVERLAPPED, NULL);
  if (wr == INVALID_HANDLE_VALUE) {
    CloseHandle(rd);
    return false;
  }
  if (!ConnectNamedPipe(rd, NULL) && GetLastError() != ERROR_PIPE_CONNECTED) {
    CloseHandle(wr);
    CloseHandle(rd);
    return false;
  }
  (void)SetHandleInformation(rd, HANDLE_FLAG_INHERIT, 0);
  *parent_end = rd;
  *child_end = wr;
  return true;
}

/* ── capture buffers (the POSIX arm's shape) ─────────────────────────── */

typedef struct {
  char *data;
  size_t len, cap;
} ScrCapBuf;

static void scr_cap_init(ScrCapBuf *b) {
  b->cap = 4096;
  b->len = 0;
  b->data = malloc(b->cap);
  if (!b->data) scr_child_oom();
}

/* One read from a capture pipe: at most one chunk of what PeekNamedPipe
 * reports, so the caller checks maxBuffer and the deadline after every
 * chunk, as the POSIX arm does after every read. EOF (every writer closed
 * — ERROR_BROKEN_PIPE) closes the handle and flips *open_. Returns true
 * when anything changed. */
static bool scr_win_cap_pump(HANDLE h, ScrCapBuf *b, bool *open_) {
  DWORD avail = 0;
  if (!PeekNamedPipe(h, NULL, 0, NULL, &avail, NULL)) {
    CloseHandle(h);
    *open_ = false;
    return true;
  }
  if (avail == 0) return false;
  if (avail > 65536) avail = 65536;
  if (b->len + avail > b->cap) {
    while (b->len + avail > b->cap) b->cap *= 2;
    b->data = realloc(b->data, b->cap);
    if (!b->data) scr_child_oom();
  }
  DWORD got = 0;
  if (!ReadFile(h, b->data + b->len, avail, &got, NULL) || got == 0) {
    CloseHandle(h);
    *open_ = false;
    return true;
  }
  b->len += got;
  return true;
}

/* ── the synchronous run core ────────────────────────────────────────── */

typedef struct {
  const char *spawn_errname; /* NULL = the child ran (and was reaped) */
  bool timed_out;            /* the deadline TerminateProcess fired */
  DWORD exit_code;
  DWORD pid;                 /* the child's process id (0 when it never ran) */
  bool enobufs;              /* both outputs together passed maxBuffer */
  const char *over;          /* per-stream maxBuffer: the stream that passed it */
  bool killed_running;       /* the kill reached a child that had not exited */
  ScrCapBuf out, err; /* always initialized; caller frees */
} ScrWinSyncRes;

/* in_mode: 0 = NUL (Node's no-input default; an `input` string swaps in
 * a fed pipe), 2 = inherit. out/err_mode: 0 = capture, 1 = NUL, 2 =
 * inherit. timeout_ms > 0 arms the deadline: TerminateProcess(h, 1) —
 * libuv's kill emulation; the caller reports the killSignal's name. The
 * capture stops at maxBuffer: both outputs together, or each stream with
 * exec's cut when per_stream (the promisified forms). */
static void scr_win_run_sync(ScrStr *cmd, ScrArr *args, const ScrStr *input,
                             int in_mode, int out_mode, int err_mode,
                             const ScrStr *cwd, ScrArr *env_pairs,
                             double timeout_ms, bool per_stream, ScrWinSyncRes *res) {
  double max_buffer = scr_child_max_take();
  res->enobufs = false;
  res->over = NULL;
  res->killed_running = false;
  res->spawn_errname = NULL;
  res->timed_out = false;
  res->exit_code = 0;
  res->pid = 0;
  scr_cap_init(&res->out);
  scr_cap_init(&res->err);

  if (in_mode == 2 || out_mode == 2 || err_mode == 2) {
    /* Inherited stdio: flush the parent's buffers first so earlier logs
     * precede the child's writes (Node's practical ordering). */
    scr_stdout_settle();
    fflush(stdout);
    fflush(stderr);
  }

  HANDLE in_child = NULL, in_parent = NULL;
  HANDLE out_child = NULL, out_parent = NULL;
  HANDLE err_child = NULL, err_parent = NULL;
  if (input != NULL) {
    if (scr_win_pipe(&in_parent, &in_child, false)) {
      DWORD mode = PIPE_NOWAIT;
      (void)SetNamedPipeHandleState(in_parent, &mode, NULL, NULL);
    } else {
      in_child = scr_win_nul(false);
    }
  } else if (in_mode == 2) {
    in_child = scr_win_dup_inherit(GetStdHandle(STD_INPUT_HANDLE));
    if (in_child == NULL) in_child = scr_win_nul(false);
  } else {
    in_child = scr_win_nul(false);
  }
  if (out_mode == 0) {
    if (!scr_win_pipe(&out_parent, &out_child, true)) out_child = scr_win_nul(true);
  } else if (out_mode == 2) {
    out_child = scr_win_dup_inherit(GetStdHandle(STD_OUTPUT_HANDLE));
    if (out_child == NULL) out_child = scr_win_nul(true);
  } else {
    out_child = scr_win_nul(true);
  }
  if (err_mode == 0) {
    if (!scr_win_pipe(&err_parent, &err_child, true)) err_child = scr_win_nul(true);
  } else if (err_mode == 2) {
    err_child = scr_win_dup_inherit(GetStdHandle(STD_ERROR_HANDLE));
    if (err_child == NULL) err_child = scr_win_nul(true);
  } else {
    err_child = scr_win_nul(true);
  }

  ScrWinSpawn sp = {
      .in_child = in_child,
      .out_child = out_child,
      .err_child = err_child,
      .cwd = cwd,
      .env_pairs = env_pairs,
      .detached = false,
  };
  scr_win_create_process(cmd, args, &sp, false);
  if (in_child != NULL) CloseHandle(in_child);
  if (out_child != NULL) CloseHandle(out_child);
  if (err_child != NULL) CloseHandle(err_child);
  if (sp.errname != NULL) {
    if (in_parent != NULL) CloseHandle(in_parent);
    if (out_parent != NULL) CloseHandle(out_parent);
    if (err_parent != NULL) CloseHandle(err_parent);
    res->spawn_errname = sp.errname;
    return;
  }
  res->pid = sp.pid;

  /* Pump: drain both captures, feed stdin (PIPE_NOWAIT — a full pipe
   * writes short, never blocks), watch the deadline. The 1ms wait rides
   * the process handle so an exit ends the sleep immediately; pipes keep
   * draining after exit until every writer's copy closes (a grandchild
   * may hold one — the POSIX arm's discipline). */
  bool out_open = out_parent != NULL, err_open = err_parent != NULL;
  bool in_open = in_parent != NULL;
  size_t in_at = 0;
  char *input_owned = NULL;
  const char *input_bytes = in_open ? scr_str_utf8(input, &input_owned) : NULL;
  bool exited = false;
  double out_text = 0, err_text = 0;
  double deadline = timeout_ms > 0 ? scr_now_ms() + timeout_ms : 0;
  for (;;) {
    bool progress = false;
    bool kill_now = false;
    size_t out_before = res->out.len, err_before = res->err.len;
    if (out_open) progress |= scr_win_cap_pump(out_parent, &res->out, &out_open);
    if (err_open) progress |= scr_win_cap_pump(err_parent, &res->err, &err_open);
    if (!res->enobufs && res->over == NULL && !res->timed_out) {
      if (per_stream) {
        if (res->out.len > out_before &&
            scr_exec_limit_chunk((uint8_t *)res->out.data, &res->out.len, out_before, &out_text,
                                 max_buffer))
          res->over = "stdout";
        else if (res->err.len > err_before &&
                 scr_exec_limit_chunk((uint8_t *)res->err.data, &res->err.len, err_before,
                                      &err_text, max_buffer))
          res->over = "stderr";
        kill_now = res->over != NULL;
      } else if (max_buffer > 0 && (double)(res->out.len + res->err.len) > max_buffer) {
        res->enobufs = true;
        kill_now = true;
      }
    }
    if (in_open) {
      /* Small chunks: PIPE_NOWAIT's partial-write behavior is only
       * dependable for writes no larger than the pipe buffer. */
      DWORD want = input->len - in_at > 2048 ? 2048 : (DWORD)(input->len - in_at);
      DWORD wrote = 0;
      if (want == 0) {
        CloseHandle(in_parent);
        in_open = false;
      } else if (WriteFile(in_parent, input_bytes + in_at, want, &wrote, NULL)) {
        if (wrote > 0) {
          in_at += wrote;
          progress = true;
        }
        if (in_at >= input->len) {
          CloseHandle(in_parent);
          in_open = false;
        }
      } else {
        /* The child closed stdin early: fine, like Node. */
        CloseHandle(in_parent);
        in_open = false;
      }
    }
    if (deadline > 0 && !res->timed_out && !res->enobufs && res->over == NULL &&
        scr_now_ms() >= deadline) {
      res->timed_out = true;
      kill_now = true;
    }
    if (kill_now) {
      /* Node kills the child and closes every stdio pipe, so a grandchild
       * that holds one cannot keep the call waiting. */
      res->killed_running = !exited && WaitForSingleObject(sp.proc, 0) != WAIT_OBJECT_0;
      (void)TerminateProcess(sp.proc, 1); /* killed children exit 1 (uv) */
      if (out_open) CloseHandle(out_parent);
      if (err_open) CloseHandle(err_parent);
      if (in_open) CloseHandle(in_parent);
      out_open = err_open = in_open = false;
    }
    if (!exited) {
      exited = WaitForSingleObject(sp.proc, progress ? 0 : 1) == WAIT_OBJECT_0;
    } else if (!progress) {
      Sleep(1);
    }
    if (exited && !out_open && !err_open) break;
  }
  if (in_open) CloseHandle(in_parent);
  scr_str_utf8_end(input_owned);
  (void)GetExitCodeProcess(sp.proc, &res->exit_code);
  CloseHandle(sp.proc);
}

/* ── the spawnSync result value (the POSIX arm's container) ──────────── */

struct ScrSpawnRes {
  size_t rc;
  bool has_status;
  double status;
  ScrStr *out;
  ScrStr *err;
  const char *spawn_errname;
  ScrStr *cmd;
#ifdef SCR_CHILD_ERR_FIELDS
  /* Node's errnoException `errno` for that failure (negative, as libuv
   * reports it; 0 = no error) and the `spawnargs` Node carries after
   * `path`: the arguments after the file (+1; NULL when there is no
   * error). Both ride the result so `.error` answers Node's fields; the
   * build without the define keeps this struct and release path as they
   * were, so a program that never reads `.error` pays nothing. */
  double spawn_errno;
  ScrArr *args;
#endif
  const char *signal_name;
};

ScrSpawnRes *scr_spawn_res_retain(ScrSpawnRes *r) {
  if (r->rc != SIZE_MAX) r->rc++;
  return r;
}

void scr_spawn_res_release(ScrSpawnRes *r) {
  if (!r || r->rc == SIZE_MAX) return;
  if (--r->rc == 0) {
    scr_str_release(r->out);
    scr_str_release(r->err);
    scr_str_release(r->cmd); /* NULL-safe */
#ifdef SCR_CHILD_ERR_FIELDS
    if (r->args) scr_arr_release(r->args);
#endif
    free(r);
  }
}

void *scr_spawn_res_retain_v(void *p) { return scr_spawn_res_retain((ScrSpawnRes *)p); }
void scr_spawn_res_release_v(void *p) { scr_spawn_res_release((ScrSpawnRes *)p); }

bool scr_spawn_res_has_status(ScrSpawnRes *r) { return r->has_status; }
double scr_spawn_res_status(ScrSpawnRes *r) { return r->status; }
ScrStr *scr_spawn_res_stdout(ScrSpawnRes *r) { return scr_str_retain(r->out); }
ScrStr *scr_spawn_res_stderr(ScrSpawnRes *r) { return scr_str_retain(r->err); }
bool scr_spawn_res_has_signal(ScrSpawnRes *r) { return r->signal_name != NULL; }
ScrStr *scr_spawn_res_signal(ScrSpawnRes *r) {
  return scr_str_new(r->signal_name, strlen(r->signal_name));
}

ScrError *scr_spawn_res_error(ScrSpawnRes *r) {
  if (r->spawn_errname == NULL) return NULL;
  size_t cap = 10 + (r->cmd ? r->cmd->len : 0) + 1 + strlen(r->spawn_errname) + 1;
  char *msg = malloc(cap);
  if (!msg) scr_child_oom();
  snprintf(msg, cap, "spawnSync %s %s", r->cmd ? r->cmd->data : "", r->spawn_errname);
  ScrStr *m = scr_str_new(msg, strlen(msg));
  free(msg);
  ScrError *e = scr_error_new(0 /* Error */, m);
  scr_str_release(m);
  scr_error_set_code(e, r->spawn_errname);
#ifdef SCR_CHILD_ERR_FIELDS
  /* Node's errnoException fields: errno (libuv's code), syscall
   * "spawnSync <file>", path (the file) and spawnargs (the arguments
   * after it). A timeout carries them too — code ETIMEDOUT. */
  scr_child_error_spawn_fields(e, r->spawn_errno, "spawnSync", r->cmd, r->args);
#endif
  return e;
}

static ScrSpawnRes *scr_spawn_res_new(bool has_status, double status,
                                      ScrStr *out /*moved*/, ScrStr *err /*moved*/) {
  ScrSpawnRes *r = malloc(sizeof(ScrSpawnRes));
  if (!r) scr_child_oom();
  r->rc = 1;
  r->has_status = has_status;
  r->status = status;
  r->out = out;
  r->err = err;
  r->spawn_errname = NULL;
#ifdef SCR_CHILD_ERR_FIELDS
  r->spawn_errno = 0;
  r->args = NULL;
#endif
  r->cmd = NULL;
  r->signal_name = NULL;
  return r;
}

/* Kept for the header's contract (the POSIX arms share it); no Windows
 * caller — CreateProcessW takes the quoted command LINE instead. */
char **scr_child_argv(ScrStr *cmd, ScrArr *args) {
  size_t start = scr_child_arg_start(cmd, args);
  size_t n = (size_t)scr_arr_len(args) - start;
  char **argv = malloc((n + 2) * sizeof(char *));
  if (!argv) scr_child_oom();
  argv[0] = cmd->data;
  for (size_t i = 0; i < n; i++) {
    ScrStr *s = (ScrStr *)scr_arr_get_ref(args, (double)(i + start));
    argv[i + 1] = s->data;
    scr_str_release(s); /* borrow: the array's reference keeps it alive */
  }
  argv[n + 1] = NULL;
  return argv;
}

/* ── spawnSync ───────────────────────────────────────────────────────── */

/* The result of a capture past maxBuffer: error ENOBUFS beside what the
 * child did, its exit code when it had already exited and the kill signal
 * otherwise. */
static ScrSpawnRes *scr_win_enobufs_res(const ScrWinSyncRes *w, ScrStr *cmd, ScrArr *args,
                                        int killsig, ScrStr *out_s, ScrStr *err_s) {
  ScrSpawnRes *r = w->killed_running ? scr_spawn_res_new(false, 0, out_s, err_s)
                                     : scr_spawn_res_new(true, (double)w->exit_code, out_s, err_s);
  if (w->killed_running) {
    r->signal_name = scr_signal_name(killsig);
    if (r->signal_name == NULL) r->signal_name = "SIGTERM";
  }
  r->spawn_errname = "ENOBUFS";
  r->cmd = scr_str_retain(cmd);
#ifdef SCR_CHILD_ERR_FIELDS
  r->spawn_errno = -4060.0; /* libuv's UV_ENOBUFS (uv-errno.h) */
  r->args = scr_child_snapshot_args(args);
#else
  (void)args;
#endif
  return r;
}

static ScrSpawnRes *scr_spawn_sync_core(ScrStr *cmd, ScrArr *args, double timeout_ms,
                                        int killsig, int in_mode, int out_mode,
                                        int err_mode, ScrArr *env_pairs) {
  ScrWinSyncRes w;
  scr_win_run_sync(cmd, args, NULL, in_mode, out_mode, err_mode, NULL, env_pairs,
                   timeout_ms, false, &w);
  if (w.spawn_errname != NULL) {
    free(w.out.data);
    free(w.err.data);
    ScrSpawnRes *r = scr_spawn_res_new(false, 0, scr_str_new("", 0), scr_str_new("", 0));
    r->spawn_errname = w.spawn_errname;
    r->cmd = scr_str_retain(cmd);
#ifdef SCR_CHILD_ERR_FIELDS
    r->spawn_errno = (double)scr_win_uv_errno(w.spawn_errname);
    r->args = scr_child_snapshot_args(args);
#endif
    return r;
  }
  ScrStr *out_s = scr_str_new(w.out.data, w.out.len);
  ScrStr *err_s = scr_str_new(w.err.data, w.err.len);
  free(w.out.data);
  free(w.err.data);
  if (w.enobufs) return scr_win_enobufs_res(&w, cmd, args, killsig, out_s, err_s);
  if (!w.timed_out) {
    return scr_spawn_res_new(true, (double)w.exit_code, out_s, err_s);
  }
  /* Node's timeout shape: status null, signal = killSignal's name, error
   * ETIMEDOUT (the kill may have raced a normal exit; Node reports the
   * timeout either way). */
  ScrSpawnRes *r = scr_spawn_res_new(false, 0, out_s, err_s);
  r->signal_name = scr_signal_name(killsig);
  if (r->signal_name == NULL) r->signal_name = "SIGTERM";
  r->spawn_errname = "ETIMEDOUT";
  r->cmd = scr_str_retain(cmd);
#ifdef SCR_CHILD_ERR_FIELDS
  /* libuv's UV_ETIMEDOUT (uv-errno.h); scr_win_uv_errno maps the spawn
   * failure names and answers UV_UNKNOWN for the timeout's. */
  r->spawn_errno = -4039.0;
  r->args = scr_child_snapshot_args(args);
#endif
  return r;
}

ScrSpawnRes *scr_spawn_sync(ScrStr *cmd, ScrArr *args) {
  return scr_spawn_sync_core(cmd, args, 0, SIGTERM, 0, 0, 0, NULL);
}

ScrSpawnRes *scr_spawn_sync_opts(ScrStr *cmd, ScrArr *args, double timeout_ms,
                                 ScrStr *killsignal, double in_mode,
                                 double out_mode, double err_mode) {
  return scr_spawn_sync_env(cmd, args, timeout_ms, killsignal, in_mode, out_mode, err_mode,
                            NULL);
}

ScrSpawnRes *scr_spawn_sync_env(ScrStr *cmd, ScrArr *args, double timeout_ms,
                                ScrStr *killsignal, double in_mode, double out_mode,
                                double err_mode, ScrArr *env_pairs) {
  int killsig = SIGTERM;
  if (killsignal->len > 0) {
    int resolved = scr_signal_from_name(killsignal);
    if (resolved > 0) killsig = resolved;
  }
  return scr_spawn_sync_core(cmd, args, timeout_ms, killsig, (int)in_mode,
                             (int)out_mode, (int)err_mode, env_pairs);
}

ScrSpawnRes *scr_spawn_sync_stdio_str(ScrStr *cmd, ScrArr *args, double timeout_ms,
                                      ScrStr *killsignal, ScrStr *stdio) {
  double in_mode = 0, out_mode = 0, err_mode = 0; /* "pipe": the defaults */
  if (stdio->len == 7 && memcmp(stdio->data, "inherit", 7) == 0) {
    in_mode = 2;
    out_mode = 2;
    err_mode = 2;
  } else if (stdio->len == 6 && memcmp(stdio->data, "ignore", 6) == 0) {
    out_mode = 1;
    err_mode = 1;
  }
  return scr_spawn_sync_opts(cmd, args, timeout_ms, killsignal, in_mode, out_mode, err_mode);
}

/* ── execFileSync / execSync (the POSIX arm's message contracts) ─────── */

static char *scr_exec_display(ScrStr *cmd, ScrArr *args, bool shell) {
  if (shell) {
    ScrStr *c = (ScrStr *)scr_arr_get_ref(args, 1); /* ["-c", cmd] */
    char *out = malloc(c->len + 1);
    if (!out) scr_child_oom();
    memcpy(out, c->data, c->len + 1);
    scr_str_release(c);
    return out;
  }
  size_t n = (size_t)scr_arr_len(args);
  size_t total = cmd->len;
  for (size_t i = 0; i < n; i++) {
    ScrStr *s = (ScrStr *)scr_arr_get_ref(args, (double)i);
    total += 1 + s->len;
    scr_str_release(s);
  }
  char *out = malloc(total + 1);
  if (!out) scr_child_oom();
  memcpy(out, cmd->data, cmd->len);
  size_t at = cmd->len;
  for (size_t i = 0; i < n; i++) {
    ScrStr *s = (ScrStr *)scr_arr_get_ref(args, (double)i);
    out[at++] = ' ';
    memcpy(out + at, s->data, s->len);
    at += s->len;
    scr_str_release(s);
  }
  out[at] = '\0';
  return out;
}

static ScrError *scr_exec_failed_error(const char *display, const ScrCapBuf *err_cap,
                                       bool with_stderr, bool always_nl) {
  size_t dlen = strlen(display);
  size_t elen = with_stderr ? err_cap->len : 0;
  size_t cap = 16 + dlen + 1 + elen + 1;
  char *msg = malloc(cap);
  if (!msg) scr_child_oom();
  size_t at = (size_t)snprintf(msg, cap, "Command failed: %s", display);
  if (elen > 0 || always_nl) {
    msg[at++] = '\n';
    memcpy(msg + at, err_cap->data, elen);
    at += elen;
  }
  ScrStr *message = scr_str_new(msg, at);
  free(msg);
  ScrError *e = scr_error_new(SCR_ERR_ERROR, message);
  scr_str_release(message);
  return e;
}

/* Node's spawn-failure/timeout error with its errnoException fields
 * (errno is libuv's code for the name). +1. */
static ScrError *scr_exec_spawn_error(ScrStr *cmd, ScrArr *args, const char *errname,
                                      bool async_shape) {
  const char *verb = async_shape ? "spawn" : "spawnSync";
  size_t cap = 10 + cmd->len + 1 + strlen(errname) + 1;
  char *msg = malloc(cap);
  if (!msg) scr_child_oom();
  int len = snprintf(msg, cap, "%s %s %s", verb, cmd->data, errname);
  ScrStr *message = scr_str_new(msg, (size_t)len);
  free(msg);
  ScrError *e = scr_error_new(SCR_ERR_ERROR, message);
  scr_str_release(message);
  scr_error_set_code(e, errname);
  /* libuv's UV_ENOBUFS is not a spawn failure, so the table has no row for it. */
  double uv_errno = strcmp(errname, "ENOBUFS") == 0 ? -4060.0 : (double)scr_win_uv_errno(errname);
  scr_child_error_spawn_fields(e, uv_errno, verb, cmd, args);
  return e;
}

static void scr_exec_throw(ScrError *e /* moves */) {
  scr_throw_obj(e, &scr_error_retain_v, &scr_error_release_v, scr_error_trace_arg());
}

/* The shared exec body (sync + promisified shapes — the POSIX arm's
 * scr_exec_sync_core semantics over the win run core). */
static ScrStr *scr_exec_run(ScrStr *cmd, ScrArr *args, bool shell,
                            const ScrStr *input, const ScrStr *cwd,
                            ScrArr *env_pairs, double timeout_ms,
                            int stdout_mode, int stderr_mode, bool async_shape,
                            bool buffers, ScrStr **stderr_out) {
  /* stdio "inherit"'s stdin rides bit 4 of stdout_mode (scr_runtime.h). */
  bool stdin_inherit = (stdout_mode & 4) != 0;
  stdout_mode &= 3;
  bool cap_out = stdout_mode == 1;
  bool cap_err = stderr_mode == 0 || stderr_mode == 1;
  ScrWinSyncRes w;
  scr_win_run_sync(cmd, args, input, stdin_inherit ? 2 : 0,
                   cap_out ? 0 : (stdout_mode == 2 ? 2 : 1),
                   cap_err ? 0 : (stderr_mode == 3 ? 2 : 1), cwd,
                   env_pairs, timeout_ms, async_shape, &w);
  if (w.spawn_errname != NULL) {
    free(w.out.data);
    free(w.err.data);
    ScrError *e = scr_exec_spawn_error(cmd, args, w.spawn_errname, async_shape);
    if (async_shape) {
      char *display = scr_exec_display(cmd, args, shell);
      scr_child_error_cmd(e, display);
      free(display);
      ScrStr *empty = scr_str_new("", 0);
      scr_child_error_outputs(e, empty, empty);
      scr_str_release(empty);
    } else {
      scr_child_error_self(e);
      scr_child_error_sync_fields(e, false, 0, NULL, 0, false, NULL, NULL);
    }
    scr_exec_throw(e);
    return NULL;
  }
  /* Node's inheritStderr: no stdio option given → the captured stderr
   * echoes to the parent's stderr AFTER completion, success, failure or
   * timeout. */
  if (stderr_mode == 0 && w.err.len > 0) {
    scr_stdout_settle();
    fflush(stdout);
    fwrite(w.err.data, 1, w.err.len, stderr);
  }
  if (w.timed_out && !async_shape) {
    /* The SYNC forms throw Node's spawnSync ETIMEDOUT; the async shape
     * reports the kill's death as an ordinary command failure below,
     * exactly Node's promisified execFile. */
    ScrError *e = scr_exec_spawn_error(cmd, args, "ETIMEDOUT", false);
    scr_child_error_self(e);
    scr_child_error_sync_fields(e, false, 0, "SIGTERM", (double)w.pid, true,
                                scr_child_sync_output(w.out.data, w.out.len, cap_out, buffers),
                                scr_child_sync_output(w.err.data, w.err.len, cap_err, buffers));
    free(w.out.data);
    free(w.err.data);
    scr_exec_throw(e);
    return NULL;
  }
  if (w.enobufs) {
    /* The sync forms throw Node's spawnSync ENOBUFS with what the child
     * did: its exit code when it had already exited, the kill otherwise. */
    ScrError *e = scr_exec_spawn_error(cmd, args, "ENOBUFS", false);
    bool exited = !w.killed_running;
    scr_child_error_self(e);
    scr_child_error_sync_fields(e, exited, exited ? (double)w.exit_code : 0,
                                exited ? NULL : "SIGTERM", (double)w.pid, true,
                                scr_child_sync_output(w.out.data, w.out.len, cap_out, buffers),
                                scr_child_sync_output(w.err.data, w.err.len, cap_err, buffers));
    free(w.out.data);
    free(w.err.data);
    scr_exec_throw(e);
    return NULL;
  }
  if (w.over != NULL) {
    /* exec's maxBuffer error: cmd, then the outputs as cut. */
    char *display = scr_exec_display(cmd, args, shell);
    ScrError *e = scr_child_max_error(w.over, display);
    free(display);
    ScrStr *out_s = scr_str_new(w.out.data, w.out.len);
    ScrStr *err_s = scr_str_new(w.err.data, w.err.len);
    scr_child_error_outputs(e, out_s, err_s);
    scr_str_release(out_s);
    scr_str_release(err_s);
    free(w.out.data);
    free(w.err.data);
    scr_exec_throw(e);
    return NULL;
  }
  bool failed = w.exit_code != 0 || w.timed_out;
  if (failed) {
    char *display = scr_exec_display(cmd, args, shell);
    ScrError *e = scr_exec_failed_error(display, &w.err, cap_err, async_shape);
    /* libuv's kill emulation: a timed-out child died to the kill signal. */
    bool exited = !w.timed_out;
    if (async_shape) {
      scr_child_error_exit_fields(e, exited, (double)w.exit_code, exited ? NULL : "SIGTERM",
                                  w.timed_out);
      scr_child_error_cmd(e, display);
      ScrStr *out_s = scr_str_new(w.out.data, w.out.len);
      ScrStr *err_s = scr_str_new(w.err.data, w.err.len);
      scr_child_error_outputs(e, out_s, err_s);
      scr_str_release(out_s);
      scr_str_release(err_s);
    } else {
      scr_child_error_sync_fields(e, exited, (double)w.exit_code, exited ? NULL : "SIGTERM",
                                  (double)w.pid, true,
                                  scr_child_sync_output(w.out.data, w.out.len, cap_out, buffers),
                                  scr_child_sync_output(w.err.data, w.err.len, cap_err, buffers));
    }
    free(display);
    free(w.out.data);
    free(w.err.data);
    scr_exec_throw(e);
    return NULL;
  }
  if (async_shape && stderr_out != NULL) {
    *stderr_out = scr_str_new(w.err.data, w.err.len);
  }
  ScrStr *out_s = scr_str_new(w.out.data, w.out.len);
  free(w.out.data);
  free(w.err.data);
  return out_s;
}

ScrStr *scr_exec_sync(ScrStr *cmd, ScrArr *args, bool shell, ScrStr *input,
                      bool has_input, ScrStr *cwd, bool has_env, ScrArr *env_pairs,
                      double timeout_ms, double stdout_mode, double stderr_mode,
                      bool buffers) {
  return scr_exec_run(cmd, args, shell, has_input ? input : NULL,
                      cwd->len > 0 ? cwd : NULL, has_env ? env_pairs : NULL,
                      timeout_ms, (int)stdout_mode, (int)stderr_mode, false, buffers, NULL);
}

ScrSpawnRes *scr_exec_capture(ScrStr *cmd, ScrArr *args, bool shell, ScrStr *cwd,
                              bool has_env, ScrArr *env_pairs, double timeout_ms) {
  ScrStr *err_s = NULL;
  ScrStr *out_s = scr_exec_run(cmd, args, shell, NULL, cwd->len > 0 ? cwd : NULL,
                               has_env ? env_pairs : NULL, timeout_ms, 1, 1,
                               true, false, &err_s);
  if (out_s == NULL) return NULL; /* exception pending; dummy result */
  return scr_spawn_res_new(true, 0, out_s, err_s);
}

/* ── spawn: the asynchronous child + its event registry ──────────────────
 * The POSIX arm's design (see its block comment below), re-plumbed:
 * waitpid(WNOHANG) → WaitForSingleObject(h, 0) + GetExitCodeProcess,
 * kqueue/pidfd wakeups → WaitForMultipleObjects over process handles in
 * scr_children_wait, piped streams → PeekNamedPipe pumps under the
 * loop's ~1ms polling cap (anonymous-pipe readability has no waitable
 * handle, so consumer-owning streams decline the wait — the unwatched
 * fallback). Listener ordering, settle discipline, unref/teardown, and
 * the unhandled-'error' exit are copied unchanged. */

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

typedef struct {
  ScrClosure *cb; /* owned */
  ScrChildStreamDataFn fn;
  ScrChildStreamDataStrFn str_fn;
  unsigned kind;
  bool once;
} ScrChildStreamDataL;

typedef struct {
  ScrClosure *cb; /* owned */
  bool once;
} ScrChildStreamEndL;

struct ScrChildStream {
  size_t rc;
  HANDLE h; /* the pipe's read end; NULL after EOF or spawn failure */
  bool eof;
  bool close_wait;
  bool capture;
  ScrStr *encoding;
  double dec_pending;
  uint8_t *capture_data;
  size_t capture_len, capture_cap;
  ScrChildStreamDataL *data_ls;
  size_t n_data, cap_data;
  ScrChildStreamEndL *end_ls;
  size_t n_end, cap_end;
  /* The AsyncLocalStorage context of the spawn() call that created the
   * stream (+1, NULL outside a store): its events run in it, as Node's
   * pipe handles run theirs. */
  ScrAlsCtx *als;
#ifdef SCR_CHILD_STREAM_FLOW
  ScrChildFlow flow; /* pause()/resume() state (scr_child_flow.h) */
#endif
  struct ScrChildStream *next; /* the service registry (+1) */
};

struct ScrChildWriter {
  size_t rc;
  HANDLE h; /* overlapped parent write end; NULL once settled */
  HANDLE event;
  OVERLAPPED ov;
  bool write_pending;
  DWORD pending_len;
  bool writable;
  bool ending;
  bool finished;
  bool destroyed;
  bool need_drain;
  bool drain_pending;
  bool finish_pending;
  bool error_pending;
  uint8_t *buf;
  size_t off, len, cap;
  ScrStr *err_msg;
  const char *err_code; /* static storage */
  ScrChildStreamEndL *drain_ls;
  size_t n_drain, cap_drain;
  ScrChildStreamEndL *finish_ls;
  size_t n_finish, cap_finish;
  ScrChildErrEntry *err_ls;
  size_t n_write_err, cap_write_err;
  /* AsyncLocalStorage contexts (+1 each, NULL outside a store): the
   * latest write() call's, for 'drain' and 'error' (the spawn() call's
   * until the first write), and the end() call's, for 'finish'. */
  ScrAlsCtx *als;
  ScrAlsCtx *end_als;
  struct ScrChildWriter *next; /* the service registry (+1) */
};

static SCR_TL ScrChildStream *scr_child_streams = NULL;
static SCR_TL size_t scr_child_streams_watching = 0;
static SCR_TL ScrChildWriter *scr_child_writers = NULL;
static bool scr_child_writers_pending(void);
static void scr_child_writers_service(void);
static void scr_child_writer_child_settled(ScrChildWriter *w);

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
  ScrStr *spawnfile; /* ChildProcess.spawnfile: the file that was spawned */
  ScrArr *spawnargs; /* ChildProcess.spawnargs: the file followed by its arguments */
  void (*exec_props)(struct ScrChild *c, ScrError *error); /* Node's error properties */
  ScrChildStream *out_stream;
  ScrChildStream *err_stream;
  ScrChildWriter *in_stream;
  ScrDyn *out_dyn, *err_dyn, *in_dyn;
  ScrIpc *ipc;
  /* The AsyncLocalStorage context of the spawn() call (+1, NULL outside
   * a store): 'spawn', 'error', 'exit' and 'close' run in it. */
  ScrAlsCtx *als;
  struct ScrChild *next; /* the pending registry */
};

static SCR_TL ScrChild *scr_children = NULL;
static SCR_TL ScrChild *scr_children_closing = NULL;
static SCR_TL size_t scr_children_reffed_n = 0;
/* Pending children the handle wait can NOT represent — spawn failures
 * awaiting their first-pass settle. While any exist, scr_children_wait
 * declines and the loop keeps the ~1ms polling cap (the POSIX arm's
 * unwatched fallback, exactly). */
static SCR_TL size_t scr_children_unwatched = 0;

static void scr_child_drop_terminal_listeners(ScrChild *c) {
  scr_child_drop_spawn_listeners(c);
  for (size_t i = 0; i < c->n_exit; i++) scr_closure_release(c->exit_cbs[i].cb);
  for (size_t i = 0; i < c->n_err; i++) scr_closure_release(c->err_cbs[i].cb);
  free(c->exit_cbs);
  free(c->err_cbs);
  c->exit_cbs = NULL;
  c->err_cbs = NULL;
  c->n_exit = c->n_err = c->cap_exit = c->cap_err = 0;
  scr_closure_release(c->exec_cb);
  c->exec_cb = NULL;
  c->exec_fn = NULL;
}

static void scr_child_drop_close_listeners(ScrChild *c) {
  for (size_t i = 0; i < c->n_close; i++) scr_closure_release(c->close_cbs[i].cb);
  free(c->close_cbs);
  c->close_cbs = NULL;
  c->n_close = c->cap_close = 0;
}

static void scr_child_drop_listeners(ScrChild *c) {
  scr_child_drop_terminal_listeners(c);
  scr_child_drop_close_listeners(c);
}

ScrChild *scr_child_retain(ScrChild *c) {
  if (c->rc != SIZE_MAX) c->rc++;
  return c;
}

void scr_child_release(ScrChild *c) {
  if (!c || c->rc == SIZE_MAX) return;
  if (--c->rc == 0) {
    scr_child_drop_listeners(c); /* only reachable pre-settle via leaks */
    scr_str_release(c->err_msg);
    scr_str_release(c->exec_display);
    scr_str_release(c->exec_file);
    if (c->exec_args) scr_arr_release(c->exec_args);
    scr_str_release(c->spawnfile);
    if (c->spawnargs) scr_arr_release(c->spawnargs);
    scr_dyn_release(c->out_dyn);
    scr_dyn_release(c->err_dyn);
    scr_dyn_release(c->in_dyn);
    scr_child_stream_release(c->out_stream);
    scr_child_stream_release(c->err_stream);
    scr_child_writer_release(c->in_stream);
    scr_ipc_release(c->ipc);
    scr_als_ctx_release(c->als);
    if (c->proc != NULL) CloseHandle(c->proc);
    free(c);
  }
}

void *scr_child_retain_v(void *p) { return scr_child_retain((ScrChild *)p); }
void scr_child_release_v(void *p) { scr_child_release((ScrChild *)p); }

/* ── the stream slice (PeekNamedPipe pumps) ──────────────────────────── */

ScrChildStream *scr_child_stream_retain(ScrChildStream *s) {
  if (s->rc != SIZE_MAX) s->rc++;
  return s;
}

static void scr_child_stream_drop_listeners(ScrChildStream *s) {
  for (size_t i = 0; i < s->n_data; i++) scr_closure_release(s->data_ls[i].cb);
  for (size_t i = 0; i < s->n_end; i++) scr_closure_release(s->end_ls[i].cb);
  free(s->data_ls);
  free(s->end_ls);
  s->data_ls = NULL;
  s->end_ls = NULL;
  s->n_data = s->n_end = s->cap_data = s->cap_end = 0;
}

void scr_child_stream_release(ScrChildStream *s) {
  if (!s || s->rc == SIZE_MAX) return;
  if (--s->rc == 0) {
    scr_child_stream_drop_listeners(s); /* only reachable pre-'end' via leaks */
#ifdef SCR_CHILD_STREAM_FLOW
    scr_child_flow_free(s);
#endif
    if (s->h != NULL) CloseHandle(s->h);
    scr_str_release(s->encoding);
    free(s->capture_data);
    scr_als_ctx_release(s->als);
    free(s);
  }
}

void *scr_child_stream_retain_v(void *p) { return scr_child_stream_retain((ScrChildStream *)p); }
void scr_child_stream_release_v(void *p) { scr_child_stream_release((ScrChildStream *)p); }

/* True while the stream has a consumer and can still deliver. */
static bool scr_child_stream_watching(const ScrChildStream *s) {
#ifdef SCR_CHILD_STREAM_FLOW
  /* Paused or resumed: the stream reads until it holds the high-water mark,
   * with or without listeners (scr_child_flow.h). */
  if (s->flow.state != SCR_CHILD_FLOW_NONE)
    return !s->eof && s->h != NULL && (s->capture || s->flow.len < SCR_CHILD_FLOW_HWM);
#endif
  return !s->eof && s->h != NULL && (s->n_data > 0 || s->capture || s->close_wait);
}

#ifdef SCR_CHILD_STREAM_FLOW
#include "scr_child_flow_impl.h"
#endif

/* A fresh piped stream over the pipe's read end, registered with the
 * service registry (+1). NULL = the never-opened husk a degraded pipe
 * slot hands out (eof from birth, never registered). */
static ScrChildStream *scr_child_stream_new(HANDLE h) {
  ScrChildStream *s = calloc(1, sizeof *s);
  if (!s) scr_child_oom();
  s->rc = 1;
  s->als = scr_als_capture();
  s->h = h;
  if (h == NULL) {
    s->eof = true;
    return s;
  }
  s->next = scr_child_streams;
  scr_child_streams = scr_child_stream_retain(s);
  return s;
}

static void scr_child_stream_capture_begin(ScrChildStream *s) {
  if (s == NULL || s->eof || s->h == NULL || s->capture) return;
  bool was_watching = scr_child_stream_watching(s);
  s->capture = true;
  if (!was_watching) scr_child_streams_watching++;
}

static void scr_child_stream_close_wait(ScrChildStream *s) {
  if (s == NULL || s->eof || s->h == NULL || s->close_wait) return;
  bool was_watching = scr_child_stream_watching(s);
  s->close_wait = true;
  if (!was_watching) scr_child_streams_watching++;
}

static void scr_child_stream_capture_append(ScrChildStream *s, const char *data,
                                            size_t len) {
  if (!s->capture || len == 0) return;
  size_t need = s->capture_len + len;
  if (need > s->capture_cap) {
    size_t cap = s->capture_cap ? s->capture_cap : 256;
    while (cap < need) cap *= 2;
    uint8_t *grown = realloc(s->capture_data, cap);
    if (!grown) scr_child_oom();
    s->capture_data = grown;
    s->capture_cap = cap;
  }
  memcpy(s->capture_data + s->capture_len, data, len);
  s->capture_len = need;
}

static ScrStr *scr_child_stream_capture_value(ScrChildStream *s) {
  return s == NULL || s->capture_len == 0
      ? scr_str_new("", 0)
      : scr_str_new((const char *)s->capture_data, s->capture_len);
}

static void scr_child_stream_emit_in(ScrChildStream *s, ScrBytes *bytes, ScrStr *text);

/* 'data' runs in the spawn() call's context. */
static void scr_child_stream_emit(ScrChildStream *s, ScrBytes *bytes, ScrStr *text) {
  ScrAlsCtx *prev = scr_als_dispatch_enter(s->als);
  scr_child_stream_emit_in(s, bytes, text);
  scr_als_dispatch_leave(prev);
}

static void scr_child_stream_emit_in(ScrChildStream *s, ScrBytes *bytes, ScrStr *text) {
  size_t nd = s->n_data;
  if (nd == 0) return;
  ScrChildStreamDataL *snap = malloc(nd * sizeof *snap);
  if (!snap) scr_child_oom();
  for (size_t i = 0; i < nd; i++) {
    snap[i] = s->data_ls[i];
    scr_closure_retain(snap[i].cb);
  }
  for (size_t i = 0; i < nd; i++) {
    if (snap[i].once) {
      for (size_t j = 0; j < s->n_data; j++) {
        if (s->data_ls[j].cb == snap[i].cb) {
          scr_closure_release(s->data_ls[j].cb);
          memmove(s->data_ls + j, s->data_ls + j + 1,
                  (s->n_data - j - 1) * sizeof *s->data_ls);
          s->n_data--;
          if (s->n_data == 0 && !s->capture && !s->close_wait) {
            scr_child_streams_watching--;
          }
          break;
        }
      }
    }
    if (!scr_exc_pending()) {
      if (snap[i].kind == SCR_CHILD_DATA_ZERO) {
        ((void (*)(ScrClosure *))snap[i].cb->fn)(snap[i].cb);
      } else if (text != NULL && snap[i].kind == SCR_CHILD_DATA_STRING) {
        snap[i].str_fn(snap[i].cb, text);
      } else if (bytes != NULL && snap[i].kind == SCR_CHILD_DATA_BYTES) {
        snap[i].fn(snap[i].cb, bytes);
      } else {
        static const char msg[] =
            "child stream data listener type does not match setEncoding state";
        scr_throw_error_msg(SCR_ERR_TYPE, msg, sizeof msg - 1);
      }
    }
    scr_closure_release(snap[i].cb);
  }
  free(snap);
}

static void scr_child_stream_finish_in(ScrChildStream *s, bool fire_end);

/* A stream's 'end' runs in the spawn() call's context. */
static void scr_child_stream_finish(ScrChildStream *s, bool fire_end) {
  ScrAlsCtx *prev = scr_als_dispatch_enter(s->als);
  scr_child_stream_finish_in(s, fire_end);
  scr_als_dispatch_leave(prev);
}

static void scr_child_stream_finish_in(ScrChildStream *s, bool fire_end) {
#ifdef SCR_CHILD_STREAM_FLOW
  if (fire_end && scr_child_flow_defer_end(s)) return;
#endif
  if (fire_end && s->encoding != NULL && s->n_data > 0) {
    ScrStr *tail = scr_strdec_end(s->encoding, s->dec_pending);
    s->dec_pending = 0;
    if (tail->len > 0) scr_child_stream_emit(s, NULL, tail);
    scr_str_release(tail);
    if (scr_exc_pending()) fire_end = false;
  }
  if (scr_child_stream_watching(s)) scr_child_streams_watching--;
  s->eof = true;
  if (s->h != NULL) {
    CloseHandle(s->h);
    s->h = NULL;
  }
  if (fire_end) {
    size_t n = s->n_end;
    ScrChildStreamEndL *snap = malloc(n * sizeof *snap);
    if (!snap) scr_child_oom();
    for (size_t i = 0; i < n; i++) {
      snap[i] = s->end_ls[i];
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
  scr_child_stream_drop_listeners(s);
}

/* One read pump: while a consumer exists, PeekNamedPipe/ReadFile to
 * empty (one 'data' per ≤64KB chunk, the libuv pipe-read size) or EOF
 * (broken pipe: every writer closed). Returns true at EOF: the caller
 * finishes and unlinks. */
/* Ends a stream as a destroyed one ends: its handle is replaced by one
 * that is not a pipe, so the pump finishes the stream on its next pass and
 * the pipe's read end closes now. */
static void scr_exec_stream_cut(ScrChildStream *s) {
  if (s->eof || s->h == NULL) return;
  HANDLE nul = scr_win_nul(false);
  if (nul == NULL) return;
  CloseHandle(s->h);
  s->h = nul;
}

static bool scr_child_stream_pump(ScrChildStream *s) {
  while (scr_child_stream_watching(s)) {
    DWORD avail = 0;
    if (!PeekNamedPipe(s->h, NULL, 0, NULL, &avail, NULL)) return true;
    if (avail == 0) return false;
    if (avail > 65536) avail = 65536;
    char buf[65536];
    DWORD got = 0;
    if (!ReadFile(s->h, buf, avail, &got, NULL) || got == 0) return true;
    scr_child_stream_capture_append(s, buf, (size_t)got);
#ifdef SCR_CHILD_STREAM_FLOW
    if (scr_child_flow_take(s, buf, (size_t)got)) {
      if (scr_exc_pending()) return false;
      continue;
    }
#endif
    if (s->n_data == 0) continue;
    ScrBytes *chunk = scr_bytes_new(SCR_BYTES_U8, (double)got);
    chunk->is_buffer = true; /* Node delivers a Buffer */
    memcpy(chunk->data, buf, (size_t)got);
    ScrStr *text = NULL;
    if (s->encoding != NULL) {
      text = scr_strdec_write(s->encoding, s->dec_pending, chunk);
      s->dec_pending = scr_strdec_next(s->encoding, s->dec_pending, chunk);
    }
    if (text == NULL || text->len > 0) scr_child_stream_emit(s, text == NULL ? chunk : NULL, text);
    scr_str_release(text);
    scr_bytes_release(chunk);
    if (scr_exc_pending()) return false;
  }
  return false;
}

static void scr_child_streams_service(void) {
  ScrChildStream **link = &scr_child_streams;
  while (*link) {
    ScrChildStream *s = *link;
    bool ended = scr_child_stream_pump(s);
    if (ended) {
      *link = s->next;
      s->next = NULL;
      scr_child_stream_finish(s, true);
      scr_child_stream_release(s); /* the registry's reference */
    } else {
      link = &s->next;
    }
    if (scr_exc_pending()) return;
  }
}

/* The settle-path drain (Node's pinned ordering: stream 'end' before
 * 'exit'): pump one stream to EOF/empty right now; on EOF, finish and
 * unlink. Data still arriving with the child reaped means a grandchild
 * holds the write end — 'exit' proceeds and the stream keeps delivering
 * on later turns, exactly Node. */
static void scr_child_stream_drain_now(ScrChildStream *s) {
  if (s == NULL || !scr_child_stream_watching(s)) return;
  if (!scr_child_stream_pump(s)) return;
  ScrChildStream **link = &scr_child_streams;
  while (*link && *link != s) link = &(*link)->next;
  if (*link) {
    *link = s->next;
    s->next = NULL;
    scr_child_stream_finish(s, true);
    scr_child_stream_release(s);
  } else {
    scr_child_stream_finish(s, true); /* defensive: not registered */
  }
}

void scr_child_stream_on_data(ScrChildStream *s, ScrClosure *cb /*moves*/,
                              ScrChildStreamDataFn fn, bool once) {
#ifdef SCR_CHILD_STREAM_FLOW
  if (scr_child_flow_on_data(s, cb, fn, NULL, once)) return;
#endif
  if (s->eof || s->h == NULL) {
    scr_closure_release(cb);
    return;
  }
  bool was_watching = scr_child_stream_watching(s);
  if (s->n_data == s->cap_data) {
    s->cap_data = s->cap_data ? s->cap_data * 2 : 2;
    s->data_ls = realloc(s->data_ls, s->cap_data * sizeof *s->data_ls);
    if (!s->data_ls) scr_child_oom();
  }
  s->data_ls[s->n_data].cb = cb;
  s->data_ls[s->n_data].fn = fn;
  s->data_ls[s->n_data].str_fn = NULL;
  s->data_ls[s->n_data].kind = fn == &scr_child_stream_thunk0
      ? SCR_CHILD_DATA_ZERO
      : SCR_CHILD_DATA_BYTES;
  s->data_ls[s->n_data].once = once;
  s->n_data++;
  if (!was_watching) scr_child_streams_watching++;
}

void scr_child_stream_on_data_str(ScrChildStream *s, ScrClosure *cb /*moves*/,
                                  ScrChildStreamDataStrFn fn, bool once) {
#ifdef SCR_CHILD_STREAM_FLOW
  if (scr_child_flow_on_data(s, cb, NULL, fn, once)) return;
#endif
  if (s->eof || s->h == NULL) {
    scr_closure_release(cb);
    return;
  }
  bool was_watching = scr_child_stream_watching(s);
  if (s->n_data == s->cap_data) {
    s->cap_data = s->cap_data ? s->cap_data * 2 : 2;
    s->data_ls = realloc(s->data_ls, s->cap_data * sizeof *s->data_ls);
    if (!s->data_ls) scr_child_oom();
  }
  s->data_ls[s->n_data] = (ScrChildStreamDataL){
      .cb = cb, .fn = NULL, .str_fn = fn,
      .kind = SCR_CHILD_DATA_STRING, .once = once};
  s->n_data++;
  if (!was_watching) scr_child_streams_watching++;
}

ScrChildStream *scr_child_stream_set_encoding(ScrChildStream *s, ScrStr *enc) {
  scr_str_release(s->encoding);
  s->encoding = scr_str_retain(enc);
  s->dec_pending = 0;
#ifdef SCR_CHILD_STREAM_FLOW
  scr_child_flow_set_encoding(s);
#endif
  return scr_child_stream_retain(s);
}

void scr_child_stream_on_end(ScrChildStream *s, ScrClosure *cb /*moves*/, bool once) {
  (void)once; /* 'end' fires at most once; the flag changes nothing */
#ifdef SCR_CHILD_STREAM_FLOW
  if (scr_child_flow_on_end(s, cb, once)) return;
#endif
  if (s->eof || s->h == NULL) {
    scr_closure_release(cb);
    return;
  }
  if (s->n_end == s->cap_end) {
    s->cap_end = s->cap_end ? s->cap_end * 2 : 2;
    s->end_ls = realloc(s->end_ls, s->cap_end * sizeof *s->end_ls);
    if (!s->end_ls) scr_child_oom();
  }
  s->end_ls[s->n_end].cb = cb;
  s->end_ls[s->n_end].once = once;
  s->n_end++;
}

ScrChildStream *scr_child_stdout(ScrChild *c) {
  return c->out_stream ? scr_child_stream_retain(c->out_stream) : NULL;
}
ScrChildStream *scr_child_stderr(ScrChild *c) {
  return c->err_stream ? scr_child_stream_retain(c->err_stream) : NULL;
}

void scr_child_stream_thunk0(ScrClosure *cb, ScrBytes *chunk) {
  (void)chunk;
  ((void (*)(ScrClosure *))cb->fn)(cb);
}
void scr_child_stream_thunk_bytes(ScrClosure *cb, ScrBytes *chunk) {
  /* The listener owns its +1 param per the universal convention. */
  ((void (*)(ScrClosure *, ScrBytes *))cb->fn)(cb, scr_bytes_retain(chunk));
}
void scr_child_stream_thunk_str(ScrClosure *cb, ScrStr *chunk) {
  ((void (*)(ScrClosure *, ScrStr *))cb->fn)(cb, scr_str_retain(chunk));
}

/* ── the piped-input writer (overlapped named-pipe writes) ─────────── */

#define SCR_CHILD_WRITER_HWM 16384

static SCR_TL const char *scr_child_writer_err_code = NULL;

static void scr_child_writer_drop_zero_listeners(ScrChildWriter *w) {
  for (size_t i = 0; i < w->n_drain; i++) scr_closure_release(w->drain_ls[i].cb);
  for (size_t i = 0; i < w->n_finish; i++) scr_closure_release(w->finish_ls[i].cb);
  free(w->drain_ls);
  free(w->finish_ls);
  w->drain_ls = NULL;
  w->finish_ls = NULL;
  w->n_drain = w->cap_drain = 0;
  w->n_finish = w->cap_finish = 0;
}

static void scr_child_writer_drop_listeners(ScrChildWriter *w) {
  scr_child_writer_drop_zero_listeners(w);
  for (size_t i = 0; i < w->n_write_err; i++) scr_closure_release(w->err_ls[i].cb);
  free(w->err_ls);
  w->err_ls = NULL;
  w->n_write_err = w->cap_write_err = 0;
}

ScrChildWriter *scr_child_writer_retain(ScrChildWriter *w) {
  if (w->rc != SIZE_MAX) w->rc++;
  return w;
}

static void scr_child_writer_cancel(ScrChildWriter *w) {
  if (!w->write_pending || w->h == NULL) return;
  (void)CancelIoEx(w->h, &w->ov);
  (void)GetOverlappedResult(w->h, &w->ov, &w->pending_len, TRUE);
  w->write_pending = false;
}

void scr_child_writer_release(ScrChildWriter *w) {
  if (!w || w->rc == SIZE_MAX) return;
  if (--w->rc == 0) {
    scr_child_writer_cancel(w);
    if (w->h != NULL) CloseHandle(w->h);
    if (w->event != NULL) CloseHandle(w->event);
    free(w->buf);
    scr_str_release(w->err_msg);
    scr_child_writer_drop_listeners(w);
    scr_als_ctx_release(w->als);
    scr_als_ctx_release(w->end_als);
    free(w);
  }
}

void *scr_child_writer_retain_v(void *p) {
  return scr_child_writer_retain((ScrChildWriter *)p);
}
void scr_child_writer_release_v(void *p) {
  scr_child_writer_release((ScrChildWriter *)p);
}

static ScrChildWriter *scr_child_writer_new(HANDLE h) {
  ScrChildWriter *w = calloc(1, sizeof *w);
  if (!w) scr_child_oom();
  w->rc = 1;
  w->als = scr_als_capture();
  w->h = h;
  w->writable = h != NULL;
  w->destroyed = h == NULL;
  if (h != NULL) {
    w->event = CreateEventW(NULL, TRUE, FALSE, NULL);
    if (w->event == NULL) {
      CloseHandle(h);
      w->h = NULL;
      w->writable = false;
      w->destroyed = true;
      return w;
    }
    w->ov.hEvent = w->event;
    w->next = scr_child_writers;
    scr_child_writers = scr_child_writer_retain(w);
  }
  return w;
}

static void scr_child_writer_close(ScrChildWriter *w) {
  scr_child_writer_cancel(w);
  if (w->h != NULL) {
    CloseHandle(w->h);
    w->h = NULL;
  }
  w->writable = false;
}

static void scr_child_writer_clear_queue(ScrChildWriter *w) {
  free(w->buf);
  w->buf = NULL;
  w->off = w->len = w->cap = 0;
}

static size_t scr_child_writer_queued(const ScrChildWriter *w) {
  return w->len - w->off;
}

static void scr_child_writer_append(ScrChildWriter *w, const void *data, size_t len) {
  if (len == 0) return;
  size_t queued = scr_child_writer_queued(w);
  if (w->off > 0 && w->cap - w->len < len) {
    memmove(w->buf, w->buf + w->off, queued);
    w->off = 0;
    w->len = queued;
  }
  if (w->cap - w->len < len) {
    size_t cap = w->cap ? w->cap : 16384;
    while (cap - w->len < len) {
      if (cap > SIZE_MAX / 2) scr_child_oom();
      cap *= 2;
    }
    uint8_t *grown = realloc(w->buf, cap);
    if (!grown) scr_child_oom();
    w->buf = grown;
    w->cap = cap;
  }
  memcpy(w->buf + w->len, data, len);
  w->len += len;
}

static void scr_child_writer_fail(ScrChildWriter *w, const char *message,
                                  const char *code) {
  if (w->error_pending || (w->err_msg != NULL && w->destroyed)) return;
  scr_child_writer_close(w);
  scr_child_writer_clear_queue(w);
  w->ending = false;
  w->destroyed = true;
  w->need_drain = false;
  w->drain_pending = false;
  w->finish_pending = false;
  scr_str_release(w->err_msg);
  w->err_msg = scr_str_new(message, strlen(message));
  w->err_code = code;
  w->error_pending = true;
}

static void scr_child_writer_complete(ScrChildWriter *w) {
  scr_child_writer_close(w);
  w->ending = false;
  w->finish_pending = true;
}

static bool scr_child_writer_collect_write(ScrChildWriter *w) {
  if (!w->write_pending) return true;
  DWORD wrote = 0;
  if (!GetOverlappedResult(w->h, &w->ov, &wrote, FALSE)) {
    DWORD err = GetLastError();
    if (err == ERROR_IO_INCOMPLETE) return false;
    w->write_pending = false;
    scr_child_writer_fail(
        w, (err == ERROR_BROKEN_PIPE || err == ERROR_NO_DATA) ? "write EPIPE" : "write EIO",
        (err == ERROR_BROKEN_PIPE || err == ERROR_NO_DATA) ? "EPIPE" : "EIO");
    return false;
  }
  w->write_pending = false;
  if (wrote == 0) {
    scr_child_writer_fail(w, "write EPIPE", "EPIPE");
    return false;
  }
  w->off += (size_t)wrote;
  return true;
}

static void scr_child_writer_pump(ScrChildWriter *w) {
  if (!scr_child_writer_collect_write(w)) return;
  while (w->h != NULL && scr_child_writer_queued(w) > 0) {
    DWORD amount = scr_child_writer_queued(w) > 65536
                       ? 65536
                       : (DWORD)scr_child_writer_queued(w);
    DWORD wrote = 0;
    ResetEvent(w->event);
    w->ov.Internal = 0;
    w->ov.InternalHigh = 0;
    BOOL ok = WriteFile(w->h, w->buf + w->off, amount, &wrote, &w->ov);
    if (ok) {
      if (wrote == 0) {
        scr_child_writer_fail(w, "write EPIPE", "EPIPE");
        return;
      }
      w->off += (size_t)wrote;
      continue;
    }
    DWORD err = GetLastError();
    if (err == ERROR_IO_PENDING) {
      w->write_pending = true;
      w->pending_len = amount;
      return;
    }
    scr_child_writer_fail(
        w, (err == ERROR_BROKEN_PIPE || err == ERROR_NO_DATA) ? "write EPIPE" : "write EIO",
        (err == ERROR_BROKEN_PIPE || err == ERROR_NO_DATA) ? "EPIPE" : "EIO");
    return;
  }
  if (scr_child_writer_queued(w) == 0 && !w->write_pending) {
    w->off = w->len = 0;
    if (w->need_drain) {
      w->need_drain = false;
      w->drain_pending = true;
    }
    if (w->ending) scr_child_writer_complete(w);
  }
}

static bool scr_child_writer_write(ScrChildWriter *w, const void *data,
                                   size_t len) {
  scr_als_ctx_release(w->als);
  w->als = scr_als_capture();
  if (!w->writable) {
    scr_child_writer_fail(w, "write after end", "ERR_STREAM_WRITE_AFTER_END");
    return false;
  }
  scr_child_writer_append(w, data, len);
  /* libuv's overlapped pipe reports backpressure from the queued amount
   * before submission. WriteFile may complete eagerly; keep Node's 16 KiB
   * decision and schedule drain once the runtime queue empties. */
  bool ok = scr_child_writer_queued(w) < SCR_CHILD_WRITER_HWM;
  if (!ok) w->need_drain = true;
  scr_child_writer_pump(w);
  if (w->error_pending) return false;
  return ok;
}

bool scr_child_writer_write_string(ScrChildWriter *w, const ScrStr *data) {
  char *owned;
  const char *bytes = scr_str_utf8(data, &owned);
  bool r = scr_child_writer_write(w, bytes, data->len);
  scr_str_utf8_end(owned);
  return r;
}

bool scr_child_writer_write_bytes(ScrChildWriter *w, const ScrBytes *data) {
  SCR_BYTES_SNAPSHOT(data);
  return scr_child_writer_write(w, data->data, data->len);
}

void scr_child_writer_end(ScrChildWriter *w) {
  if (w->ending || w->finish_pending || w->finished || w->destroyed) return;
  scr_als_ctx_release(w->end_als);
  w->end_als = scr_als_capture();
  w->writable = false;
  w->ending = true;
  scr_child_writer_pump(w);
}

void scr_child_writer_destroy(ScrChildWriter *w) {
  if (w->finished || (w->destroyed && !w->error_pending)) return;
  scr_child_writer_close(w);
  scr_child_writer_clear_queue(w);
  w->ending = false;
  w->destroyed = true;
  w->need_drain = false;
  w->drain_pending = false;
  w->finish_pending = false;
  w->error_pending = false;
  scr_str_release(w->err_msg);
  w->err_msg = NULL;
  scr_child_writer_drop_listeners(w);
}

bool scr_child_writer_writable(ScrChildWriter *w) { return w->writable; }

static void scr_child_writer_add_zero(ScrChildStreamEndL **ls, size_t *n,
                                      size_t *cap, ScrClosure *cb, bool once) {
  if (*n == *cap) {
    *cap = *cap ? *cap * 2 : 2;
    *ls = realloc(*ls, *cap * sizeof **ls);
    if (!*ls) scr_child_oom();
  }
  (*ls)[*n] = (ScrChildStreamEndL){cb, once};
  (*n)++;
}

void scr_child_writer_on_drain(ScrChildWriter *w, ScrClosure *cb /*moves*/,
                               bool once) {
  if (w->finished || (w->destroyed && !w->drain_pending)) {
    scr_closure_release(cb);
    return;
  }
  scr_child_writer_add_zero(&w->drain_ls, &w->n_drain, &w->cap_drain, cb, once);
}

void scr_child_writer_on_finish(ScrChildWriter *w, ScrClosure *cb /*moves*/,
                                bool once) {
  if (w->finished || (w->destroyed && !w->finish_pending)) {
    scr_closure_release(cb);
    return;
  }
  scr_child_writer_add_zero(&w->finish_ls, &w->n_finish, &w->cap_finish, cb, once);
}

void scr_child_writer_on_error(ScrChildWriter *w, ScrClosure *cb /*moves*/,
                               ScrChildErrFn fn, bool once) {
  (void)once;
  if ((w->destroyed && !w->finished && !w->error_pending) ||
      (w->err_msg != NULL && !w->error_pending)) {
    scr_closure_release(cb);
    return;
  }
  if (w->n_write_err == w->cap_write_err) {
    w->cap_write_err = w->cap_write_err ? w->cap_write_err * 2 : 2;
    w->err_ls = realloc(w->err_ls, w->cap_write_err * sizeof *w->err_ls);
    if (!w->err_ls) scr_child_oom();
  }
  w->err_ls[w->n_write_err++] = (ScrChildErrEntry){cb, fn};
}

static void scr_child_writer_fire_drain_in(ScrChildWriter *w);

/* 'drain' runs in the latest write() call's context. */
static void scr_child_writer_fire_drain(ScrChildWriter *w) {
  ScrAlsCtx *prev = scr_als_dispatch_enter(w->als);
  scr_child_writer_fire_drain_in(w);
  scr_als_dispatch_leave(prev);
}

static void scr_child_writer_fire_drain_in(ScrChildWriter *w) {
  w->drain_pending = false;
  size_t n = w->n_drain;
  if (n == 0) return;
  ScrChildStreamEndL *snap = malloc(n * sizeof *snap);
  if (!snap) scr_child_oom();
  for (size_t i = 0; i < n; i++) {
    snap[i] = w->drain_ls[i];
    scr_closure_retain(snap[i].cb);
  }
  for (size_t i = 0; i < n; i++) {
    if (snap[i].once) {
      for (size_t j = 0; j < w->n_drain; j++) {
        if (w->drain_ls[j].cb != snap[i].cb) continue;
        scr_closure_release(w->drain_ls[j].cb);
        memmove(w->drain_ls + j, w->drain_ls + j + 1,
                (w->n_drain - j - 1) * sizeof *w->drain_ls);
        w->n_drain--;
        break;
      }
    }
    if (!scr_exc_pending()) ((void (*)(ScrClosure *))snap[i].cb->fn)(snap[i].cb);
    scr_closure_release(snap[i].cb);
  }
  free(snap);
}

static void scr_child_writer_fire_finish_in(ScrChildWriter *w);

/* 'finish' runs in the end() call's context. */
static void scr_child_writer_fire_finish(ScrChildWriter *w) {
  ScrAlsCtx *prev = scr_als_dispatch_enter(w->end_als);
  scr_child_writer_fire_finish_in(w);
  scr_als_dispatch_leave(prev);
}

static void scr_child_writer_fire_finish_in(ScrChildWriter *w) {
  w->finish_pending = false;
  w->finished = true;
  w->destroyed = true;
  size_t n = w->n_finish;
  ScrChildStreamEndL *snap = n ? malloc(n * sizeof *snap) : NULL;
  if (n && !snap) scr_child_oom();
  for (size_t i = 0; i < n; i++) {
    snap[i] = w->finish_ls[i];
    scr_closure_retain(snap[i].cb);
  }
  for (size_t i = 0; i < n; i++) {
    if (!scr_exc_pending()) ((void (*)(ScrClosure *))snap[i].cb->fn)(snap[i].cb);
    scr_closure_release(snap[i].cb);
  }
  free(snap);
  scr_child_writer_drop_zero_listeners(w);
}

static void scr_child_writer_fire_error_in(ScrChildWriter *w);

/* 'error' runs in the latest write() call's context. */
static void scr_child_writer_fire_error(ScrChildWriter *w) {
  ScrAlsCtx *prev = scr_als_dispatch_enter(w->als);
  scr_child_writer_fire_error_in(w);
  scr_als_dispatch_leave(prev);
}

static void scr_child_writer_fire_error_in(ScrChildWriter *w) {
  w->error_pending = false;
  if (w->n_write_err == 0) {
    scr_stdout_settle();
    fflush(stdout);
    fprintf(stderr, "Unhandled 'error' event: Error: %s\n", w->err_msg->data);
    _Exit(1);
  }
  size_t n = w->n_write_err;
  ScrChildErrEntry *snap = malloc(n * sizeof *snap);
  if (!snap) scr_child_oom();
  for (size_t i = 0; i < n; i++) {
    snap[i] = w->err_ls[i];
    scr_closure_retain(snap[i].cb);
  }
  scr_child_writer_err_code = w->err_code;
  for (size_t i = 0; i < n; i++) {
    if (!scr_exc_pending()) snap[i].fn(snap[i].cb, w->err_msg);
    scr_closure_release(snap[i].cb);
  }
  scr_child_writer_err_code = NULL;
  free(snap);
  scr_child_writer_drop_listeners(w);
}

static bool scr_child_writer_pending(const ScrChildWriter *w) {
  return w->write_pending || scr_child_writer_queued(w) > 0 ||
         w->drain_pending || w->finish_pending || w->error_pending;
}

/* Every queued byte reached the pipe; only listener events may remain. */
static bool scr_child_writer_flushed(const ScrChildWriter *w) {
  return !w->write_pending && scr_child_writer_queued(w) == 0 && !w->error_pending;
}

static bool scr_child_writers_pending(void) {
  for (ScrChildWriter *w = scr_child_writers; w; w = w->next) {
    if (scr_child_writer_pending(w)) return true;
  }
  return false;
}

/* The Windows sleep already switches on the writer's overlapped events and
 * its own polling cap; the POSIX-arm ready rule does not apply. */
static bool scr_child_writers_ready(void) { return false; }

static void scr_child_writers_service(void) {
  ScrChildWriter **link = &scr_child_writers;
  while (*link) {
    ScrChildWriter *w = *link;
    if (!w->destroyed && !w->finished) scr_child_writer_pump(w);
    if (w->error_pending) scr_child_writer_fire_error(w);
    if (!scr_exc_pending() && w->drain_pending) scr_child_writer_fire_drain(w);
    if (!scr_exc_pending() && w->finish_pending) scr_child_writer_fire_finish(w);
    bool done = (w->finished || w->destroyed) && !w->error_pending;
    if (done) {
      *link = w->next;
      w->next = NULL;
      scr_child_writer_release(w);
    } else {
      link = &w->next;
    }
    if (scr_exc_pending()) return;
  }
}

static void scr_child_writer_child_settled(ScrChildWriter *w) {
  if (!w || w->finished || w->finish_pending || w->destroyed) return;
  if (scr_child_writer_queued(w) > 0 || w->write_pending || w->ending) {
    scr_child_writer_fail(w, "write EPIPE", "EPIPE");
  } else {
    scr_child_writer_destroy(w);
  }
}

ScrChildWriter *scr_child_stdin(ScrChild *c) {
  return c->in_stream ? scr_child_writer_retain(c->in_stream) : NULL;
}

/* ── spawn ───────────────────────────────────────────────────────────── */

ScrChild *scr_spawn(ScrStr *cmd, ScrArr *args) {
  return scr_spawn_opts(cmd, args, 0, 0, 0, 0, 0, false, false, false, NULL, NULL);
}

/* PER-SLOT stdio modes (the POSIX arm's numbering): in 0 = ignore (NUL),
 * 1 = inherit, 3 = pipe; out/err 0 = ignore, 1 = inherit, 2 = fd,
 * 3 = pipe. */
/* Whether the shell path names cmd.exe (Node switches the switch form on
 * that test alone). */
static bool scr_child_shell_is_cmd(const ScrStr *s) {
  static const char name[] = "cmd.exe";
  size_t start = 0;
  for (size_t i = 0; i < s->len; i++)
    if (s->data[i] == '\\' || s->data[i] == '/') start = i + 1;
  if (s->len - start != sizeof name - 1) return false;
  for (size_t i = 0; i < sizeof name - 1; i++) {
    char ch = s->data[start + i];
    if (ch >= 'A' && ch <= 'Z') ch = (char)(ch - 'A' + 'a');
    if (ch != name[i]) return false;
  }
  return true;
}

/* %ComSpec%, or "cmd.exe" when it is unset: the shell Node runs a spawn
 * with shell: true through. */
static ScrStr *scr_child_comspec(void) {
  DWORD need = GetEnvironmentVariableW(L"ComSpec", NULL, 0);
  if (need == 0) return scr_str_new("cmd.exe", 7);
  WCHAR *wide = malloc((size_t)need * sizeof(WCHAR));
  if (!wide) scr_child_oom();
  DWORD used = GetEnvironmentVariableW(L"ComSpec", wide, need);
  ScrStr *out = NULL;
  if (used > 0 && used < need) {
    int bytes = WideCharToMultiByte(CP_UTF8, 0, wide, (int)used, NULL, 0, NULL, NULL);
    if (bytes > 0) {
      char *buf = malloc((size_t)bytes);
      if (!buf) scr_child_oom();
      WideCharToMultiByte(CP_UTF8, 0, wide, (int)used, buf, bytes, NULL, NULL);
      out = scr_str_new(buf, (size_t)bytes);
      free(buf);
    }
  }
  free(wide);
  return out != NULL ? out : scr_str_new("cmd.exe", 7);
}

/* Node's normalizeSpawnArguments result, kept for ChildProcess.spawnfile
 * and spawnargs. A direct spawn reports the command and its arguments. The
 * shell form joins the command and arguments into one command line and
 * reports the shell it runs: cmd.exe with /d /s /c and the quoted line, or
 * the named shell with -c and the line. */
static void scr_child_record_spawn(ScrChild *c, ScrStr *cmd, ScrArr *args, bool shell) {
  size_t n = (size_t)scr_arr_len(args);
  ScrArr *spawnargs = scr_arr_new(SCR_ELEM_STR, n + 1);
  if (shell) {
    ScrStr **parts = malloc((1 + 2 * n) * sizeof *parts);
    ScrStr *space = scr_str_new(" ", 1);
    if (!parts) scr_child_oom();
    parts[0] = cmd;
    for (size_t i = 0; i < n; i++) {
      parts[1 + 2 * i] = space;
      parts[2 + 2 * i] = scr_arr_get_ref(args, (double)i);
    }
    ScrStr *command = scr_str_concat_parts(parts, 1 + 2 * n);
    for (size_t i = 0; i < n; i++) scr_str_release(parts[2 + 2 * i]);
    scr_str_release(space);
    free(parts);
    ScrStr *file = scr_child_comspec();
    c->spawnfile = scr_str_retain(file);
    scr_arr_push_ref(spawnargs, file);
    if (scr_child_shell_is_cmd(file)) {
      ScrStr *quote = scr_str_new("\"", 1);
      ScrStr *quoted_parts[3] = {quote, command, quote};
      ScrStr *quoted = scr_str_concat_parts(quoted_parts, 3);
      scr_str_release(quote);
      scr_str_release(command);
      scr_arr_push_ref(spawnargs, scr_str_new("/d", 2));
      scr_arr_push_ref(spawnargs, scr_str_new("/s", 2));
      scr_arr_push_ref(spawnargs, scr_str_new("/c", 2));
      scr_arr_push_ref(spawnargs, quoted);
    } else {
      scr_arr_push_ref(spawnargs, scr_str_new("-c", 2));
      scr_arr_push_ref(spawnargs, command);
    }
  } else {
    c->spawnfile = scr_str_retain(cmd);
    scr_arr_push_ref(spawnargs, scr_str_retain(cmd));
    for (size_t i = 0; i < n; i++) scr_arr_push_ref(spawnargs, scr_arr_get_ref(args, (double)i));
  }
  c->spawnargs = spawnargs;
}

ScrChild *scr_spawn_opts(ScrStr *cmd, ScrArr *args, double in_mode,
                         double out_mode, double err_mode, double out_fd,
                         double err_fd, bool detached, bool shell, bool has_env,
                         ScrArr *env_pairs, ScrStr *cwd) {
  if ((int)out_mode == 1 || (int)err_mode == 1 || (int)out_mode == 2 || (int)err_mode == 2) {
    scr_stdout_settle();
    fflush(stdout);
    fflush(stderr);
  }
  ScrChild *c = calloc(1, sizeof(ScrChild));
  if (!c) scr_child_oom();
  c->rc = 1;
  c->als = scr_als_capture();
  scr_child_record_spawn(c, cmd, args, shell);

  /* Piped slots: the pipe NOW; a pipe failure degrades the slot to NUL
   * and the stream husk answers eof (fd exhaustion — nothing real). */
  HANDLE in_parent = NULL, in_child = NULL;
  HANDLE out_parent = NULL, out_child = NULL;
  HANDLE err_parent = NULL, err_child = NULL;
  int in_m = (int)in_mode, out_m = (int)out_mode, err_m = (int)err_mode;
  if (in_m == 3 && !scr_win_stdin_pipe(&in_parent, &in_child)) in_m = 0;
  if (out_m == 3 && !scr_win_pipe(&out_parent, &out_child, true)) out_m = 0;
  if (err_m == 3 && !scr_win_pipe(&err_parent, &err_child, true)) err_m = 0;

  if (in_child == NULL) {
    if (in_m == 1) in_child = scr_win_dup_inherit(GetStdHandle(STD_INPUT_HANDLE));
    if (in_child == NULL) in_child = scr_win_nul(false);
  }
  if (out_child == NULL) {
    if (out_m == 1) out_child = scr_win_dup_inherit(GetStdHandle(STD_OUTPUT_HANDLE));
    else if (out_m == 2) out_child = scr_win_dup_inherit((HANDLE)_get_osfhandle((int)out_fd));
    if (out_child == NULL) out_child = scr_win_nul(true);
  }
  if (err_child == NULL) {
    if (err_m == 1) err_child = scr_win_dup_inherit(GetStdHandle(STD_ERROR_HANDLE));
    else if (err_m == 2) err_child = scr_win_dup_inherit((HANDLE)_get_osfhandle((int)err_fd));
    if (err_child == NULL) err_child = scr_win_nul(true);
  }

  ScrWinSpawn sp = {
      .in_child = in_child,
      .out_child = out_child,
      .err_child = err_child,
      .cwd = cwd != NULL && cwd->len > 0 ? cwd : NULL,
      .env_pairs = has_env ? env_pairs : NULL,
      .detached = detached,
  };
  scr_win_create_process(cmd, args, &sp, shell);
  if (in_child != NULL) CloseHandle(in_child);
  if (out_child != NULL) CloseHandle(out_child);
  if (err_child != NULL) CloseHandle(err_child);

  /* Parent keeps only its side of each pipe. A failed spawn still exposes
   * the stream husks until the deferred child error settles them. */
  if (in_m == 3) c->in_stream = scr_child_writer_new(in_parent);
  if (out_m == 3) c->out_stream = scr_child_stream_new(out_parent);
  if (err_m == 3) c->err_stream = scr_child_stream_new(err_parent);

  if (sp.errname != NULL) {
    size_t len = 6 + cmd->len + 1 + strlen(sp.errname);
    char *msg = malloc(len + 1);
    if (!msg) scr_child_oom();
    snprintf(msg, len + 1, "spawn %s %s", cmd->data, sp.errname);
    c->state = SCR_CHILD_SPAWN_FAILED;
    c->spawn_errname = sp.errname;
    c->spawn_uv_errno = scr_win_uv_errno(sp.errname);
    c->err_msg = scr_str_new(msg, len);
    free(msg);
    /* Settles at the next quiescent pass; no exit handle will ever wake
     * the loop for it, so it counts as unwatched until then. */
    scr_children_unwatched++;
  } else {
    c->state = SCR_CHILD_RUNNING;
    c->proc = sp.proc;
    c->pid = sp.pid;
  }
  /* The registry's reference: dropped when the child settles. */
  c->reffed = true;
  scr_children_reffed_n++;
  c->next = scr_children;
  scr_children = scr_child_retain(c);
  scr_child_loop_install();
  return c;
}

ScrChild *scr_fork(double target, ScrArr *args, double in_mode,
                   double out_mode, double err_mode, bool has_env,
                   ScrArr *env_pairs, ScrStr *cwd) {
  HANDLE parent_write = NULL, child_read = NULL;
  HANDLE parent_read = NULL, child_write = NULL;
  if (!scr_win_stdin_pipe(&parent_write, &child_read) ||
      !scr_win_ipc_child_writer_pipe(&parent_read, &child_write)) {
    if (parent_write != NULL) CloseHandle(parent_write);
    if (child_read != NULL) CloseHandle(child_read);
    if (parent_read != NULL) CloseHandle(parent_read);
    if (child_write != NULL) CloseHandle(child_write);
    scr_trap("could not create fork IPC channel");
  }
  ScrArr *spawn_args = scr_fork_argv(
      target, (uintptr_t)child_read, (uintptr_t)child_write, args);
  ScrStr *command = scr_process_exec_path();
  ScrChild *child = scr_spawn_opts(
      command, spawn_args, in_mode, out_mode, err_mode, 0, 0, false,
      false, has_env, env_pairs, cwd);
  scr_str_release(command);
  scr_arr_release(spawn_args);
  CloseHandle(child_read);
  CloseHandle(child_write);
  if (child->state == SCR_CHILD_RUNNING) {
    child->ipc = scr_ipc_new(scr_child_stream_new(parent_read),
                             scr_child_writer_new(parent_write));
  } else {
    CloseHandle(parent_read);
    CloseHandle(parent_write);
  }
  return child;
}

/* Node's properties on the callback form's error. Reached only through
 * the hook scr_exec_file installs, so programs without the callback form
 * link none of the property code (the settle path is shared by every
 * child). */
static void scr_exec_file_error_props(ScrChild *c, ScrError *error) {
  if (c->state == SCR_CHILD_SPAWN_FAILED) {
    scr_child_error_spawn_fields(error, (double)c->spawn_uv_errno, "spawn", c->exec_file, c->exec_args);
  } else {
    scr_child_error_exit_fields(error, c->has_code, c->code, c->exit_signal, c->killed);
  }
  scr_child_error_cmd(error, c->exec_display->data);
}

static ScrError *scr_exec_file_error(ScrChild *c, ScrStr *stderr_value) {
  if (c->state == SCR_CHILD_SPAWN_FAILED) {
    ScrError *error = scr_error_new(0, c->err_msg);
    scr_error_set_code(error, c->spawn_errname);
    if (c->exec_props) c->exec_props(c, error);
    return error;
  }
  if (c->has_code && c->code == 0) return NULL;
  size_t cap = 16 + c->exec_display->len + 1 + stderr_value->len + 1;
  char *msg = malloc(cap);
  if (!msg) scr_child_oom();
  size_t at = (size_t)snprintf(msg, cap, "Command failed: %s", c->exec_display->data);
  msg[at++] = '\n';
  memcpy(msg + at, stderr_value->data, stderr_value->len);
  at += stderr_value->len;
  ScrStr *message = scr_str_new(msg, at);
  free(msg);
  ScrError *error = scr_error_new(0, message);
  scr_str_release(message);
  if (c->exec_props) c->exec_props(c, error);
  return error;
}

static void scr_exec_file_fire(ScrChild *c) {
  if (c->exec_cb == NULL || c->exec_fn == NULL) return;
  ScrStr *out = scr_child_stream_capture_value(c->out_stream);
  ScrStr *err = scr_child_stream_capture_value(c->err_stream);
  ScrError *error = scr_exec_file_error(c, err);
  c->exec_fn(c->exec_cb, error, out, err); /* error/out/err move */
}

ScrChild *scr_exec_file(ScrStr *cmd, ScrArr *args, ScrClosure *cb,
                        ScrExecFileFn fn, bool shell) {
  ScrStr *empty = scr_str_new("", 0);
  ScrChild *c = scr_spawn_opts(cmd, args, 3, 3, 3, 0, 0, false, false, false,
                               NULL, empty);
  scr_str_release(empty);
  c->exec_cb = cb;
  c->exec_fn = fn;
  c->exec_file = scr_str_retain(cmd);
  c->exec_args = scr_arr_retain(args);
  c->exec_props = &scr_exec_file_error_props;
  char *display = scr_exec_display(cmd, args, shell);
  c->exec_display = scr_str_new(display, strlen(display));
  free(display);
  scr_child_stream_capture_begin(c->out_stream);
  scr_child_stream_capture_begin(c->err_stream);
  scr_exec_limit_install(c);
  return c;
}

/* ── the lifecycle members ───────────────────────────────────────────── */

bool scr_child_has_pid(ScrChild *c) { return c->state != SCR_CHILD_SPAWN_FAILED; }
double scr_child_pid(ScrChild *c) { return (double)c->pid; }

bool scr_child_has_exit_code(ScrChild *c) {
  if (c->state == SCR_CHILD_EXITED) return c->has_code;
  return c->state == SCR_CHILD_SPAWN_FAILED && c->settled;
}
double scr_child_exit_code(ScrChild *c) {
  if (c->state == SCR_CHILD_SPAWN_FAILED) return (double)c->spawn_uv_errno;
  return c->code;
}

bool scr_child_killed(ScrChild *c) { return c->killed; }

ScrStr *scr_child_spawnfile(ScrChild *c) {
  return c->spawnfile ? scr_str_retain(c->spawnfile) : scr_str_new("", 0);
}
ScrArr *scr_child_spawnargs(ScrChild *c) {
  return c->spawnargs ? scr_arr_retain(c->spawnargs) : scr_arr_new(SCR_ELEM_STR, 0);
}

/* child.kill core: libuv's uv_kill emulation. SIGTERM/SIGKILL/SIGINT/
 * SIGQUIT/SIGHUP → TerminateProcess(h, 1) with the signal name recorded
 * for the exit event (Node's code null + signal); 0 probes liveness;
 * anything else answers false (libuv: ENOSYS — no error event wired,
 * the POSIX arm's unreachable-error stance). Node sets `killed` on ANY
 * successful send, signal 0 included. */
static bool scr_child_kill_signo(ScrChild *c, int signo) {
  if (c->state != SCR_CHILD_RUNNING || c->proc == NULL) return false;
  if (signo == 0) {
    if (WaitForSingleObject(c->proc, 0) == WAIT_OBJECT_0) return false; /* exited: ESRCH */
    c->killed = true;
    return true;
  }
  if (signo != SIGTERM && signo != SIGKILL && signo != SIGINT &&
      signo != SIGQUIT && signo != SIGHUP) {
    return false;
  }
  if (!TerminateProcess(c->proc, 1)) return false; /* already exited: ESRCH */
  c->kill_signal = scr_signal_name(signo);
  c->killed = true;
  return true;
}

bool scr_child_kill(ScrChild *c, const ScrStr *signal) {
  int signo = scr_signal_from_name(signal);
  if (signo < 0) {
    size_t cap = 16 + signal->len + 1;
    char *msg = malloc(cap);
    if (!msg) scr_child_oom();
    int len = snprintf(msg, cap, "Unknown signal: %s", signal->data);
    scr_throw_error_msg_code(SCR_ERR_TYPE, msg, (size_t)len, "ERR_UNKNOWN_SIGNAL");
    free(msg);
    return false;
  }
  return scr_child_kill_signo(c, signo);
}

bool scr_child_kill_num(ScrChild *c, double signum) {
  return scr_child_kill_signo(c, (int)signum);
}

void scr_child_unref(ScrChild *c) {
  if (c->reffed) {
    c->reffed = false;
    scr_children_reffed_n--; /* settle/teardown clear reffed first */
  }
}

bool scr_children_reffed_pending(void) {
  return scr_children_reffed_n > 0 || scr_child_streams_watching > 0 ||
         scr_child_writers_pending() || scr_ipc_pending();
}

void scr_children_teardown(void) {
#ifdef SCR_CHILD_STREAM_FLOW
  scr_child_flow_teardown();
#endif
  while (scr_child_streams != NULL) {
    ScrChildStream *s = scr_child_streams;
    scr_child_streams = s->next;
    s->next = NULL;
    scr_child_stream_finish(s, false);
    scr_child_stream_release(s);
  }
  while (scr_child_writers != NULL) {
    ScrChildWriter *w = scr_child_writers;
    scr_child_writers = w->next;
    w->next = NULL;
    scr_child_writer_destroy(w);
    scr_child_writer_release(w);
  }
  while (scr_children_closing != NULL) {
    ScrChild *c = scr_children_closing;
    scr_children_closing = c->next;
    c->next = NULL;
    c->close_done = true;
    scr_child_drop_listeners(c);
    scr_child_release(c);
  }
  while (scr_children != NULL) {
    ScrChild *c = scr_children;
    scr_children = c->next;
    c->next = NULL;
    c->settled = true; /* late listener registrations release immediately */
    if (c->reffed) {
      c->reffed = false;
      scr_children_reffed_n--;
    }
    if (c->state == SCR_CHILD_SPAWN_FAILED) scr_children_unwatched--;
    scr_child_drop_listeners(c);
    scr_child_release(c);
  }
}

void scr_child_on_exit(ScrChild *c, ScrClosure *cb /*moves*/, ScrChildExitFn fn) {
  if (c->settled) {
    scr_closure_release(cb); /* after the terminal event: never fires */
    return;
  }
  if (c->n_exit == c->cap_exit) {
    c->cap_exit = c->cap_exit ? c->cap_exit * 2 : 2;
    c->exit_cbs = realloc(c->exit_cbs, c->cap_exit * sizeof(*c->exit_cbs));
    if (!c->exit_cbs) scr_child_oom();
  }
  c->exit_cbs[c->n_exit].cb = cb;
  c->exit_cbs[c->n_exit].fn = fn;
  c->n_exit++;
}

void scr_child_on_close(ScrChild *c, ScrClosure *cb /*moves*/, ScrChildExitFn fn) {
  if (c->close_done) {
    scr_closure_release(cb);
    return;
  }
  if (c->n_close == c->cap_close) {
    c->cap_close = c->cap_close ? c->cap_close * 2 : 2;
    c->close_cbs = realloc(c->close_cbs, c->cap_close * sizeof *c->close_cbs);
    if (!c->close_cbs) scr_child_oom();
  }
  c->close_cbs[c->n_close++] = (ScrChildExitEntry){cb, fn};
  scr_child_stream_close_wait(c->out_stream);
  scr_child_stream_close_wait(c->err_stream);
}

/* A failed spawn's 'error' event carries Node's errnoException: one Error,
 * the same object for every listener, with errno, code, syscall
 * "spawn <file>", path and spawnargs (the arguments after the file), and a
 * message that names the file Node ran (the shell, for a shell spawn). The
 * settle path and the untyped handle table are linked by every program
 * that uses child_process, so they reach this only through the hook below.
 * A program that can register an 'error' listener installs it once at
 * start (scr_child_error_event_install, emitted for the childErrorEvent
 * program fact); every other program links none of the property code. +1.
 * The pointer has external linkage on purpose: a static one that the unit
 * stores once lets the compiler turn the settle path's call into a direct
 * reference to the builder, which links it into every program. */
ScrError *(*scr_child_spawn_error_hook)(ScrChild *c) = NULL;

static ScrError *scr_child_spawn_error(ScrChild *c) {
  const char *name = c->spawn_errname;
  size_t cap = 6 + c->spawnfile->len + 1 + strlen(name) + 1;
  char *text = malloc(cap);
  if (!text) scr_child_oom();
  int len = snprintf(text, cap, "spawn %s %s", c->spawnfile->data, name);
  ScrStr *message = scr_str_new(text, (size_t)len);
  free(text);
  ScrError *error = scr_error_new(SCR_ERR_ERROR, message);
  scr_str_release(message);
  scr_error_set_code(error, name);
  ScrArr *args = scr_arr_slice(c->spawnargs, 1, (double)scr_arr_len(c->spawnargs));
  scr_child_error_spawn_fields(error, (double)c->spawn_uv_errno, "spawn", c->spawnfile, args);
  scr_arr_release(args);
  return error;
}

void scr_child_error_event_install(void) { scr_child_spawn_error_hook = &scr_child_spawn_error; }

void scr_child_on_error(ScrChild *c, ScrClosure *cb /*moves*/, ScrChildErrFn fn) {
  if (c->settled) {
    scr_closure_release(cb);
    return;
  }
  if (c->n_err == c->cap_err) {
    c->cap_err = c->cap_err ? c->cap_err * 2 : 2;
    c->err_cbs = realloc(c->err_cbs, c->cap_err * sizeof(*c->err_cbs));
    if (!c->err_cbs) scr_child_oom();
  }
  c->err_cbs[c->n_err].cb = cb;
  c->err_cbs[c->n_err].fn = fn;
  c->n_err++;
}

/* ── the runtime-provided listener adapters (the POSIX arm's) ────────── */

void scr_child_exit_thunk0(ScrClosure *cb, bool has_code, double code,
                           const char *signal_name) {
  (void)has_code;
  (void)code;
  (void)signal_name;
  ((void (*)(ScrClosure *))cb->fn)(cb);
}

void scr_child_err_thunk0(ScrClosure *cb, ScrStr *msg) {
  (void)msg;
  ((void (*)(ScrClosure *))cb->fn)(cb);
}

static SCR_TL const char *scr_child_err_code = NULL;

/* The errno name embedded in an errnoException-style message — the
 * POSIX arm's parser, shared story (see its comment). */
static const char *scr_err_msg_code(const ScrStr *msg) { return scr_error_event_code(msg); }

void scr_child_err_thunk_error(ScrClosure *cb, ScrStr *msg) {
  if (scr_event_error_payload != NULL) {
    ((void (*)(ScrClosure *, ScrError *))cb->fn)(cb, scr_error_retain(scr_event_error_payload));
    return;
  }
  ScrError *e = scr_error_new(0 /* Error */, msg);
  if (scr_child_err_code != NULL) {
    scr_error_set_code(e, scr_child_err_code);
  } else if (scr_child_writer_err_code != NULL) {
    scr_error_set_code(e, scr_child_writer_err_code);
  } else {
    const char *code = scr_err_msg_code(msg);
    if (code != NULL) scr_error_set_code(e, code);
  }
  ((void (*)(ScrClosure *, ScrError *))cb->fn)(cb, e);
}

/* ── the loop's half (called from scr_async.c) ───────────────────────── */

bool scr_children_pending(void) {
  return scr_children != NULL || scr_children_closing != NULL ||
         scr_child_streams_watching > 0 ||
         scr_child_writers_pending() || scr_ipc_pending();
}

bool scr_children_failed_pending(void) {
  for (ScrChild *c = scr_children; c; c = c->next) {
    if ((c->state == SCR_CHILD_SPAWN_FAILED && !c->settled) ||
        (c->state == SCR_CHILD_RUNNING && !c->spawn_done)) return true;
  }
  return false;
}

static bool scr_child_close_ready(const ScrChild *c) {
  return (c->out_stream == NULL || c->out_stream->eof) &&
         (c->err_stream == NULL || c->err_stream->eof) &&
         scr_ipc_close_ready(c->ipc);
}

static void scr_child_fire_close_in(ScrChild *c);

/* 'close' runs in the spawn() call's context. */
static void scr_child_fire_close(ScrChild *c) {
  ScrAlsCtx *prev = scr_als_dispatch_enter(c->als);
  scr_child_fire_close_in(c);
  scr_als_dispatch_leave(prev);
}

static void scr_child_fire_close_in(ScrChild *c) {
  c->close_done = true;
  bool has_code = c->state == SCR_CHILD_SPAWN_FAILED ? true : c->has_code;
  double code = c->state == SCR_CHILD_SPAWN_FAILED
      ? (double)c->spawn_uv_errno
      : c->code;
  /* Node counts the channel toward 'close' only through its EOF read; a
   * channel disconnected from this side never reports one, so 'close'
   * never fires. */
  size_t n = scr_ipc_close_dropped(c->ipc) ? 0 : c->n_close;
  for (size_t i = 0; i < n; i++) {
    c->close_cbs[i].fn(c->close_cbs[i].cb, has_code, code, c->exit_signal);
    if (scr_exc_pending()) break;
  }
  scr_child_drop_close_listeners(c);
  scr_child_release(c); /* the closing/settle registry's reference */
}

static void scr_children_closing_poll(void) {
  ScrChild **link = &scr_children_closing;
  while (*link) {
    ScrChild *c = *link;
    if (scr_child_close_ready(c)) {
      *link = c->next;
      c->next = NULL;
      scr_child_fire_close(c);
      if (scr_exc_pending()) return;
    } else {
      link = &c->next;
    }
  }
}

/* No pollable wake fd on Windows (the loop's poll(2) branch is POSIX-
 * only); scr_children_wait below is the wakeup story. */
int scr_children_wake_fd(void) { return -1; }

/* The loop's quiescent sleep while children are pending: wait on the
 * child process HANDLES up to max_wait_ms — an exit ends the sleep
 * immediately and the next reap pass settles it. Declines (false: the
 * caller keeps the ~1ms polling cap) when a pending child has no
 * waitable handle (a spawn failure awaiting settle), a consumer-owning
 * stream needs pumping (pipe readability is poll-only), or the handle
 * table outgrows WaitForMultipleObjects. */
bool scr_children_wait(double max_wait_ms) {
  if (scr_children_unwatched > 0 || scr_child_streams_watching > 0 ||
      scr_child_writers_pending()) return false;
  HANDLE hs[MAXIMUM_WAIT_OBJECTS];
  DWORD n = 0;
  for (ScrChild *c = scr_children; c; c = c->next) {
    if (c->state != SCR_CHILD_RUNNING || c->proc == NULL) continue;
    if (n == MAXIMUM_WAIT_OBJECTS) return false;
    hs[n++] = c->proc;
  }
  if (n == 0) return false;
  if (!(max_wait_ms > 0)) max_wait_ms = 0;
  if (max_wait_ms > 2147483000.0) max_wait_ms = 2147483000.0;
  (void)WaitForMultipleObjects(n, hs, FALSE, (DWORD)(max_wait_ms + 0.999));
  return true;
}

/* Fires one settled child's terminal event — the POSIX arm's settle,
 * verbatim (streams drain first so 'end' precedes 'exit'; spawn
 * failures fire 'error' or die unhandled). */
static void scr_child_settle_in(ScrChild *c);

/* A child's terminal events run in its spawn() call's context. */
static void scr_child_settle(ScrChild *c) {
  ScrAlsCtx *prev = scr_als_dispatch_enter(c->als);
  scr_child_settle_in(c);
  scr_als_dispatch_leave(prev);
}

static void scr_child_settle_in(ScrChild *c) {
  if (c->reffed) {
    c->reffed = false;
    scr_children_reffed_n--;
  }
  if (c->state == SCR_CHILD_EXITED) {
    if (!c->spawn_done) scr_child_fire_spawn(c);
    if (!scr_exc_pending()) scr_child_stream_drain_now(c->out_stream);
    if (!scr_exc_pending()) scr_child_stream_drain_now(c->err_stream);
    if (!scr_exc_pending()) scr_ipc_settle(c->ipc);
  }
  if (!scr_exc_pending()) {
    scr_child_writer_child_settled(c->in_stream);
    scr_child_writers_service();
  }
  c->settled = true;
  if (scr_exc_pending()) {
    scr_child_drop_listeners(c);
    scr_child_release(c);
    return;
  }
  if (c->state == SCR_CHILD_SPAWN_FAILED) {
    if (c->n_err == 0 && c->exec_cb == NULL) {
      scr_stdout_settle();
      fflush(stdout);
      fprintf(stderr, "Unhandled 'error' event: Error: %s\n", c->err_msg->data);
      _Exit(1);
    }
    scr_child_err_code = c->spawn_errname;
    /* With an 'error' listener the event carries Node's error object
     * (scr_child_spawn_error); the adapters hand out the payload. */
    ScrError *spawn_error =
        scr_child_spawn_error_hook != NULL && c->n_err > 0 ? scr_child_spawn_error_hook(c) : NULL;
    ScrError *outer_payload = scr_event_error_payload;
    if (spawn_error != NULL) scr_event_error_payload = spawn_error;
    for (size_t i = 0; i < c->n_err; i++) {
      c->err_cbs[i].fn(c->err_cbs[i].cb, c->err_msg);
      if (scr_exc_pending()) break; /* the loop surfaces it */
    }
    if (spawn_error != NULL) {
      scr_event_error_payload = outer_payload;
      scr_error_release(spawn_error);
    }
    scr_child_err_code = NULL;
    if (!scr_exc_pending()) scr_exec_file_fire(c);
  } else {
    for (size_t i = 0; i < c->n_exit; i++) {
      c->exit_cbs[i].fn(c->exit_cbs[i].cb, c->has_code, c->code, c->exit_signal);
      if (scr_exc_pending()) break;
    }
#ifdef SCR_CHILD_STREAM_FLOW
    if (!scr_exc_pending() && c->exec_cb != NULL) {
      scr_child_flow_exec_flush(c->out_stream);
      if (!scr_exc_pending()) scr_child_flow_exec_flush(c->err_stream);
    }
#endif
    if (!scr_exc_pending()) scr_exec_file_fire(c);
  }
#ifdef SCR_CHILD_STREAM_FLOW
  if (!scr_exc_pending() && c->state == SCR_CHILD_EXITED) {
    scr_child_flow_exit(c->out_stream);
    scr_child_flow_exit(c->err_stream);
  }
#endif
  scr_child_drop_terminal_listeners(c);
  if (c->n_close == 0) {
    c->close_done = true;
    scr_child_release(c); /* the settle registry's reference */
  } else if (scr_child_close_ready(c)) {
    scr_child_fire_close(c);
  } else {
    c->next = scr_children_closing;
    scr_children_closing = c; /* transfer the settle registry's reference */
  }
}

/* One reap pass: streams service first (the pinned 'end'-before-'exit'
 * ordering), then every running child answers WaitForSingleObject(h, 0)
 * — the WNOHANG analogue; spawn failures settle on their first pass. */
void scr_children_poll(void) {
  for (ScrChild *c = scr_children; c; c = c->next) {
    if (c->state == SCR_CHILD_RUNNING && !c->spawn_done) scr_child_fire_spawn(c);
    if (scr_exc_pending()) return;
  }
  scr_ipc_service();
  if (scr_exc_pending()) return;
  scr_child_writers_service();
  if (scr_exc_pending()) return;
  scr_child_streams_service();
  if (scr_exc_pending()) return;
  /* Node's IPC read callback emits the messages it parsed, then on EOF
   * emits 'close' at once for a child that already exited, and defers
   * 'disconnect' to the next tick — all before this pass reaps. */
  scr_ipc_deliver();
  if (scr_exc_pending()) return;
  scr_children_closing_poll();
  if (scr_exc_pending()) return;
  scr_ipc_service();
  if (scr_exc_pending()) return;
  ScrChild **link = &scr_children;
  while (*link) {
    ScrChild *c = *link;
    bool settle = false;
    if (c->state == SCR_CHILD_SPAWN_FAILED) {
      scr_children_unwatched--;
      settle = true;
    } else {
      DWORD w = WaitForSingleObject(c->proc, 0);
      if (w == WAIT_OBJECT_0) {
        DWORD code = 0;
        (void)GetExitCodeProcess(c->proc, &code);
        CloseHandle(c->proc);
        c->proc = NULL;
        c->state = SCR_CHILD_EXITED;
        if (c->kill_signal != NULL) {
          /* We terminated it: Node's code null + the signal's name
           * (libuv's term_signal reporting). */
          c->has_code = false;
          c->code = 0;
          c->exit_signal = c->kill_signal;
        } else {
          c->has_code = true;
          c->code = (double)code;
        }
        settle = true;
      } else if (w == WAIT_FAILED) {
        /* An unwaitable handle: settle as a signal-style exit so the
         * loop can never spin forever (the POSIX ECHILD stance). */
        CloseHandle(c->proc);
        c->proc = NULL;
        c->state = SCR_CHILD_EXITED;
        c->has_code = false;
        c->code = 0;
        settle = true;
      }
    }
    if (settle) {
      *link = c->next; /* unlink BEFORE firing: callbacks may spawn */
      c->next = NULL;
      scr_child_settle(c);
      if (scr_exc_pending()) return;
    } else {
      link = &c->next;
    }
  }
}

#ifdef SCR_CHILD_CP_OPTIONS
/* ── the cwd/input slice (SCR_CHILD_CP_OPTIONS) ─────────────────────────
 * The Windows twin of the POSIX block at the end of this file: spawnSync
 * and the exec/execFile callback form take `cwd` and `input`, which the
 * win run core already implements for the exec forms. Built only into
 * programs whose IR names one of these entry points (the compiler's
 * childOptionExt feature); every other program keeps the default object,
 * byte for byte.
 *
 * `cwd` NULL or "" spawns in the parent's directory; `has_input` false
 * leaves fd 0 to the stdio mode, true pipes `input`. */
static ScrSpawnRes *scr_spawn_sync_core_ext(ScrStr *cmd, ScrArr *args, double timeout_ms,
                                            int killsig, int in_mode, int out_mode,
                                            int err_mode, ScrArr *env_pairs,
                                            ScrStr *cwd, ScrStr *input, bool has_input,
                                            bool shell) {
  ScrWinSyncRes w;
  /* `shell`: the command runs through cmd.exe /d /s /c, Node's Windows
   * shape. The compiler emits the form with an EMPTY args list only (a
   * non-empty one is Node's DEP0190 warning, which a native build cannot
   * report), so the command string IS the command line. */
  ScrStr *run_cmd = cmd;
  ScrArr *run_args = args;
  ScrArr *shell_args = NULL;
  if (shell) {
    const char *comspec = getenv("COMSPEC");
    if (comspec == NULL || *comspec == '\0') comspec = "cmd.exe";
    run_cmd = scr_str_new(comspec, strlen(comspec));
    shell_args = scr_arr_new(SCR_ELEM_STR, 4);
    scr_arr_push_ref(shell_args, scr_str_new("/d", 2));
    scr_arr_push_ref(shell_args, scr_str_new("/s", 2));
    scr_arr_push_ref(shell_args, scr_str_new("/c", 2));
    scr_arr_push_ref(shell_args, scr_str_retain(cmd));
    run_args = shell_args;
  }
  scr_win_run_sync(run_cmd, run_args, has_input ? input : NULL, in_mode, out_mode, err_mode,
                   cwd != NULL && cwd->len > 0 ? cwd : NULL, env_pairs, timeout_ms, false, &w);
  if (shell_args != NULL) {
    scr_str_release(run_cmd);
    scr_arr_release(shell_args);
  }
  if (w.spawn_errname != NULL) {
    free(w.out.data);
    free(w.err.data);
    ScrSpawnRes *r = scr_spawn_res_new(false, 0, scr_str_new("", 0), scr_str_new("", 0));
    r->spawn_errname = w.spawn_errname;
    r->cmd = scr_str_retain(cmd);
#ifdef SCR_CHILD_ERR_FIELDS
    r->spawn_errno = (double)scr_win_uv_errno(w.spawn_errname);
    r->args = scr_child_snapshot_args(args);
#endif
    return r;
  }
  ScrStr *out_s = scr_str_new(w.out.data, w.out.len);
  ScrStr *err_s = scr_str_new(w.err.data, w.err.len);
  free(w.out.data);
  free(w.err.data);
  if (w.enobufs) return scr_win_enobufs_res(&w, cmd, args, killsig, out_s, err_s);
  if (!w.timed_out) {
    return scr_spawn_res_new(true, (double)w.exit_code, out_s, err_s);
  }
  ScrSpawnRes *r = scr_spawn_res_new(false, 0, out_s, err_s);
  r->signal_name = scr_signal_name(killsig);
  if (r->signal_name == NULL) r->signal_name = "SIGTERM";
  r->spawn_errname = "ETIMEDOUT";
  r->cmd = scr_str_retain(cmd);
#ifdef SCR_CHILD_ERR_FIELDS
  r->spawn_errno = -4039.0;
  r->args = scr_child_snapshot_args(args);
#endif
  return r;
}

ScrSpawnRes *scr_spawn_sync_ext_env(ScrStr *cmd, ScrArr *args, double timeout_ms,
                                     ScrStr *killsignal, double in_mode, double out_mode,
                                     double err_mode, ScrStr *cwd, ScrStr *input,
                                     bool has_input, bool shell, ScrArr *env_pairs) {
  int killsig = SIGTERM;
  if (killsignal->len > 0) {
    int resolved = scr_signal_from_name(killsignal);
    if (resolved > 0) killsig = resolved;
  }
  return scr_spawn_sync_core_ext(cmd, args, timeout_ms, killsig, (int)in_mode,
                                 (int)out_mode, (int)err_mode, env_pairs, cwd, input,
                                 has_input, shell);
}

ScrSpawnRes *scr_spawn_sync_ext(ScrStr *cmd, ScrArr *args, double timeout_ms,
                                 ScrStr *killsignal, double in_mode, double out_mode,
                                 double err_mode, ScrStr *cwd, ScrStr *input,
                                 bool has_input, bool shell) {
  return scr_spawn_sync_ext_env(cmd, args, timeout_ms, killsignal, in_mode, out_mode,
                                err_mode, cwd, input, has_input, shell, NULL);
}

/* exec/execFile (the callback slice) with the `cwd` option. */
ScrChild *scr_exec_file_cwd(ScrStr *cmd, ScrArr *args, ScrClosure *cb /*moves*/,
                             ScrExecFileFn fn, bool shell, ScrStr *cwd) {
  ScrChild *c = scr_spawn_opts(cmd, args, 3, 3, 3, 0, 0, false, false, false, NULL, cwd);
  c->exec_cb = cb;
  c->exec_fn = fn;
  c->exec_file = scr_str_retain(cmd);
  c->exec_args = scr_arr_retain(args);
  c->exec_props = &scr_exec_file_error_props;
  char *display = scr_exec_display(cmd, args, shell);
  c->exec_display = scr_str_new(display, strlen(display));
  free(display);
  scr_child_stream_capture_begin(c->out_stream);
  scr_child_stream_capture_begin(c->err_stream);
  scr_exec_limit_install(c);
  return c;
}
#endif /* SCR_CHILD_CP_OPTIONS */

#else /* !_WIN32 — the POSIX implementation */

#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <spawn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

/* Child-exit wakeups without polling — the narrow seam scr_platform.h
 * points here for (this unit links into EVERY binary, so its plumbing
 * stays inline rather than pulling both poller backends onto every link
 * line). BSD: kqueue's PROC filter — the loop's quiescent sleep waits on
 * the kqueue fd and a NOTE_EXIT wakes it the moment a child dies; piped
 * stream read-ends ride the same kqueue as level-triggered read filters.
 * Linux: pidfd_open per spawned child registered EPOLLIN in a dedicated
 * epoll (a pidfd polls readable from exit until the reap CLOSES it —
 * scr_children_poll unwatches right after waitpid succeeds); stream
 * read-ends ride the same epoll, level-triggered like the kqueue arm.
 * Both arms deliver WAKEUPS ONLY (events drained and discarded; the
 * WNOHANG sweep stays the single reaping mechanism), and both fall back
 * to the portable ~1ms polling cap whenever any pending child cannot be
 * represented (spawn failures awaiting settle, a failed watch
 * registration — kqueue refuses zombies, pidfd_open can hit ENOSYS/
 * EMFILE). Everywhere else the polling path compiles alone. */
#if defined(__APPLE__) || defined(__FreeBSD__) || defined(__NetBSD__) || \
    defined(__OpenBSD__) || defined(__DragonFly__)
#define SCR_HAVE_KQUEUE 1
#include <sys/event.h>
#elif defined(__linux__)
#define SCR_CHILD_HAVE_PIDFD 1
#include <sys/epoll.h>
#if defined(__GLIBC__) && (__GLIBC__ > 2 || (__GLIBC__ == 2 && __GLIBC_MINOR__ >= 36))
#include <sys/pidfd.h> /* pidfd_open has a libc wrapper from glibc 2.36 */
#else
#include <sys/syscall.h>
static int pidfd_open(pid_t pid, unsigned int flags) {
  return (int)syscall(SYS_pidfd_open, pid, flags);
}
#endif
#endif

extern char **environ;

static void scr_child_oom(void) {
  fputs("scriptc: out of memory\n", stderr);
  abort();
}

static const char *scr_errname(int err); /* defined with the spawn slice */

/* ── the spawnSync result value ──────────────────────────────────────── */

struct ScrSpawnRes {
  size_t rc;
  bool has_status;  /* false: signal death or spawn failure (status null) */
  double status;
  ScrStr *out; /* captured stdout, utf8 */
  ScrStr *err; /* captured stderr, utf8 */
  /* Spawn failure (Node's `error` property): the errno name for the
   * message ("spawnSync <file> ENOENT") and `code` stamp — a timeout kill
   * rides the same slot as ETIMEDOUT. NULL = no error — the property
   * reads undefined, exactly Node. */
  const char *spawn_errname;
  ScrStr *cmd; /* +1, for the error message; NULL when spawn_errname is */
#ifdef SCR_CHILD_ERR_FIELDS
  /* Node's errnoException `errno` for that failure (negative, as libuv
   * reports it; 0 = no error), so `.error` answers the same fields the
   * sync throw does, and Node's `spawnargs` (+1; NULL when no error). */
  double spawn_errno;
  ScrArr *args;
#endif
  /* The termination signal's name (static storage; "SIGTERM", ...) when a
   * signal killed the child — a timeout's killSignal included — NULL for
   * a normal exit or spawn failure. Node's result.signal. */
  const char *signal_name;
};

ScrSpawnRes *scr_spawn_res_retain(ScrSpawnRes *r) {
  if (r->rc != SIZE_MAX) r->rc++;
  return r;
}

void scr_spawn_res_release(ScrSpawnRes *r) {
  if (!r || r->rc == SIZE_MAX) return;
  if (--r->rc == 0) {
    scr_str_release(r->out);
    scr_str_release(r->err);
    scr_str_release(r->cmd); /* NULL-safe */
#ifdef SCR_CHILD_ERR_FIELDS
    if (r->args) scr_arr_release(r->args);
#endif
    free(r);
  }
}

void *scr_spawn_res_retain_v(void *p) { return scr_spawn_res_retain((ScrSpawnRes *)p); }
void scr_spawn_res_release_v(void *p) { scr_spawn_res_release((ScrSpawnRes *)p); }

bool scr_spawn_res_has_status(ScrSpawnRes *r) { return r->has_status; }
double scr_spawn_res_status(ScrSpawnRes *r) { return r->status; }
ScrStr *scr_spawn_res_stdout(ScrSpawnRes *r) { return scr_str_retain(r->out); }
ScrStr *scr_spawn_res_stderr(ScrSpawnRes *r) { return scr_str_retain(r->err); }
bool scr_spawn_res_has_signal(ScrSpawnRes *r) { return r->signal_name != NULL; }
ScrStr *scr_spawn_res_signal(ScrSpawnRes *r) {
  return scr_str_new(r->signal_name, strlen(r->signal_name));
}

/* The `error` property: a fresh +1 %Error ("spawnSync <file> ENOENT",
 * `code` stamped — Node's uv errnoException) when the spawn itself
 * failed, NULL (the undefined arm, wrapped type-directedly by the
 * emitter) otherwise. Constructed per read; Node reuses one object, but
 * the difference is only `===` identity between two reads of `.error`,
 * which nothing narrows on. */
ScrError *scr_spawn_res_error(ScrSpawnRes *r) {
  if (r->spawn_errname == NULL) return NULL;
  size_t cap = 10 + (r->cmd ? r->cmd->len : 0) + 1 + strlen(r->spawn_errname) + 1;
  char *msg = malloc(cap);
  if (!msg) scr_child_oom();
  snprintf(msg, cap, "spawnSync %s %s", r->cmd ? r->cmd->data : "", r->spawn_errname);
  ScrStr *m = scr_str_new(msg, strlen(msg));
  free(msg);
  ScrError *e = scr_error_new(0 /* Error */, m);
  scr_str_release(m);
  scr_error_set_code(e, r->spawn_errname);
#ifdef SCR_CHILD_ERR_FIELDS
  /* Node's errnoException fields: errno (libuv's code), syscall
   * "spawnSync <file>", path (the file) and spawnargs (the arguments
   * after it). A timeout carries them too — code ETIMEDOUT. */
  scr_child_error_spawn_fields(e, r->spawn_errno, "spawnSync", r->cmd, r->args);
#endif
  return e;
}

/* ── argv construction (shared with spawn in scr_async.c's slice) ─────── */

/* Builds a NULL-terminated argv from the command + one string[] — the
 * strings are BORROWED from their containers (alive for the whole spawn;
 * the +1 from scr_arr_get_ref is dropped immediately because the array
 * keeps its own reference). A string holding a lone surrogate is copied
 * into the same block as UTF-8 (U+FFFD for each), as Node encodes it.
 * Free with free() (one block). */
char **scr_child_argv(ScrStr *cmd, ScrArr *args) {
  size_t start = scr_child_arg_start(cmd, args);
  size_t n = (size_t)scr_arr_len(args) - start;
  size_t extra = scr_str_has_surrogate(cmd) ? cmd->len + 1 : 0;
  for (size_t i = 0; i < n; i++) {
    ScrStr *s = (ScrStr *)scr_arr_get_ref(args, (double)(i + start));
    if (scr_str_has_surrogate(s)) extra += s->len + 1;
    scr_str_release(s); /* borrow: the array's reference keeps it alive */
  }
  char **argv = malloc((n + 2) * sizeof(char *) + extra);
  if (!argv) scr_child_oom();
  char *copies = (char *)(argv + n + 2);
  for (size_t i = 0; i <= n; i++) {
    ScrStr *s = i ? (ScrStr *)scr_arr_get_ref(args, (double)(i - 1 + start)) : scr_str_retain(cmd);
    argv[i] = s->data;
    if (scr_str_has_surrogate(s)) {
      memcpy(copies, s->data, s->len + 1);
      scr_wtf8_to_utf8(copies, s->len);
      argv[i] = copies;
      copies += s->len + 1;
    }
    scr_str_release(s);
  }
  argv[n + 1] = NULL;
  return argv;
}

/* ── capture buffers ─────────────────────────────────────────────────── */

typedef struct {
  char *data;
  size_t len, cap;
} ScrCapBuf;

static void scr_cap_init(ScrCapBuf *b) {
  b->cap = 4096;
  b->len = 0;
  b->data = malloc(b->cap);
  if (!b->data) scr_child_oom();
}

/* Reads once from fd into the buffer; returns false on EOF (or error —
 * a broken pipe reads as end of capture, like libuv treats it). */
static bool scr_cap_read(ScrCapBuf *b, int fd) {
  if (b->len + 4096 > b->cap) {
    b->cap *= 2;
    b->data = realloc(b->data, b->cap);
    if (!b->data) scr_child_oom();
  }
  ssize_t got = read(fd, b->data + b->len, b->cap - b->len);
  if (got <= 0) return false;
  b->len += (size_t)got;
  return true;
}

/* Closes a capture pipe's end once (-1 afterwards). */
static void scr_cap_close(int *fd) {
  if (*fd >= 0) close(*fd);
  *fd = -1;
}

/* ── spawnSync ───────────────────────────────────────────────────────── */

static ScrSpawnRes *scr_spawn_res_new(bool has_status, double status,
                                       ScrStr *out /*moved*/, ScrStr *err /*moved*/) {
  ScrSpawnRes *r = malloc(sizeof(ScrSpawnRes));
  if (!r) scr_child_oom();
  r->rc = 1;
  r->has_status = has_status;
  r->status = status;
  r->out = out;
  r->err = err;
  r->spawn_errname = NULL;
#ifdef SCR_CHILD_ERR_FIELDS
  r->spawn_errno = 0;
  r->args = NULL;
#endif
  r->cmd = NULL;
  r->signal_name = NULL;
  return r;
}

/* The parameterized spawnSync core. stdio modes: stdin 0 = /dev/null
 * (Node's no-input default AND "ignore"/"pipe"-without-input — all read
 * nothing), 2 = inherit; stdout/stderr 0 = capture (the pipe), 1 =
 * ignore (/dev/null; the result string reads ""), 2 = inherit (""
 * likewise — Node types those null; the "" stance is spawnSync's
 * documented divergence). timeout_ms > 0 sends `killsig` at the deadline
 * and the result carries error: ETIMEDOUT + the signal — never a throw,
 * Node's spawnSync shape. */
static char **scr_exec_envp(ScrArr *pairs);
static void scr_exec_envp_free(char **envp);

/* posix_spawn for the child_process spawns, never posix_spawnp. Node
 * reaches a child through libuv, which resolves the command itself: a name
 * with a '/' runs as given; otherwise each entry of the command's PATH (a
 * replacement environment's `envp`, or this process's when `envp` is NULL;
 * an empty entry is the current directory), or of the default path when
 * there is no PATH, is tried in order, and a candidate whose spawn fails
 * with ENOENT, ENOTDIR or EACCES (a missing file, or a script whose
 * interpreter is missing) moves on to the next entry. The last such
 * failure is EACCES if any candidate was denied, else ENOENT. Relative
 * entries are resolved by the child, which starts in `cwd`. Returns
 * posix_spawn's error number.
 *
 * posix_spawnp is avoided because Apple's answers a spurious ENOENT when
 * a chdir file action is staged and the command is relative, even though
 * the child is spawned: resolving the command here and spawning the
 * candidate directly keeps a `cwd` with a relative command working. */
static int scr_spawn_resolved(pid_t *pid, const char *file, const posix_spawn_file_actions_t *fa,
                              const posix_spawnattr_t *attr, char *const *argv,
                              char *const *envp) {
  char *const *env = envp != NULL ? envp : environ;
  if (strchr(file, '/')) return posix_spawn(pid, file, fa, attr, argv, env);
  const char *path = "/usr/bin:/bin";
  for (char *const *e = env; *e; e++) {
    if (strncmp(*e, "PATH=", 5) == 0) {
      path = *e + 5;
      break;
    }
  }
  size_t file_len = strlen(file);
  bool denied = false;
  for (const char *dir = path;;) {
    const char *end = strchr(dir, ':');
    size_t dir_len = end ? (size_t)(end - dir) : strlen(dir);
    const char *prefix = dir_len ? dir : ".";
    size_t prefix_len = dir_len ? dir_len : 1;
    char *candidate = malloc(prefix_len + 1 + file_len + 1);
    if (!candidate) scr_child_oom();
    memcpy(candidate, prefix, prefix_len);
    candidate[prefix_len] = '/';
    memcpy(candidate + prefix_len + 1, file, file_len + 1);
    int err = posix_spawn(pid, candidate, fa, attr, argv, env);
    free(candidate);
    if (err == EACCES) denied = true;
    else if (err != ENOENT && err != ENOTDIR) return err;
    if (!end) break;
    dir = end + 1;
  }
  return denied ? EACCES : ENOENT;
}

/* The highest standard signal number. Linux and Darwin both number the
 * standard signals 1..31; Linux's real-time signals start above them. */
#define SCR_CHILD_LAST_STANDARD_SIGNAL 31

/* scr_spawn_resolved with the signal state a child of Node starts with,
 * whatever state this process has: every standard signal at its default
 * action and an empty signal mask. An exec keeps ignored dispositions and
 * the mask, so without this a child would inherit SIGPIPE and SIGXFSZ
 * ignored (scr_init), any signal this process was itself started with
 * ignored or blocked (SIGINT and SIGQUIT in a background job of a
 * non-interactive shell, SIGHUP under nohup), and could then not be ended
 * by that signal. The dispositions of real-time signals are inherited, as
 * under Node; the mask is emptied for them too. Every launch of the
 * child_process functions comes through here. `attr` may be NULL. */
static int scr_spawn_command(pid_t *pid, const char *file, const posix_spawn_file_actions_t *fa,
                             posix_spawnattr_t *attr, char *const *argv, char *const *envp,
                             const char *cwd) {
  (void)cwd; /* the file actions change into it before the exec */
  /* A process that ignores SIGCHLD keeps no exit status for its children:
   * the kernel reaps them and waitpid answers ECHILD. A program started
   * that way (its parent ignored SIGCHLD and the exec kept it) would report
   * a null exit code for every child, so the default action, which keeps
   * the status, is restored before a child exists. A listener's handler is
   * neither and stays. */
  struct sigaction reaping;
  if (sigaction(SIGCHLD, NULL, &reaping) == 0 && !(reaping.sa_flags & SA_SIGINFO) &&
      reaping.sa_handler == SIG_IGN) {
    memset(&reaping, 0, sizeof reaping);
    reaping.sa_handler = SIG_DFL;
    sigemptyset(&reaping.sa_mask);
    (void)sigaction(SIGCHLD, &reaping, NULL);
  }
  posix_spawnattr_t local;
  if (attr == NULL) {
    posix_spawnattr_init(&local);
    attr = &local;
  }
  sigset_t defaults, unblocked;
  sigemptyset(&defaults);
  for (int number = 1; number <= SCR_CHILD_LAST_STANDARD_SIGNAL; number++) {
    /* SIGKILL and SIGSTOP have no disposition to set. */
    if (number != SIGKILL && number != SIGSTOP) sigaddset(&defaults, number);
  }
  sigemptyset(&unblocked);
  short flags = 0;
  (void)posix_spawnattr_getflags(attr, &flags);
  (void)posix_spawnattr_setsigdefault(attr, &defaults);
  (void)posix_spawnattr_setsigmask(attr, &unblocked);
  (void)posix_spawnattr_setflags(
      attr, (short)(flags | POSIX_SPAWN_SETSIGDEF | POSIX_SPAWN_SETSIGMASK));
  int err = scr_spawn_resolved(pid, file, fa, attr, argv, envp);
  if (attr == &local) posix_spawnattr_destroy(&local);
  return err;
}

/* env_pairs: NULL inherits the parent's environment; else [k,v,...]
 * replaces it, as Node's `env` option does, and the command is looked up
 * on the replacement's PATH (scr_spawn_command). */
static ScrSpawnRes *scr_spawn_sync_core(ScrStr *cmd, ScrArr *args, double timeout_ms,
                                         int killsig, int in_mode, int out_mode,
                                         int err_mode, ScrArr *env_pairs) {
  double max_buffer = scr_child_max_take();
  if (out_mode == 2 || err_mode == 2) {
    /* Inherited output fds: flush the parent's buffers first so earlier
     * logs precede the child's writes (Node's practical ordering). */
    scr_stdout_settle();
    fflush(stdout);
    fflush(stderr);
  }
  int outfd[2] = {-1, -1}, errfd[2] = {-1, -1};
  bool cap_out = out_mode == 0, cap_err = err_mode == 0;
  if ((cap_out && pipe(outfd) != 0) || (cap_err && pipe(errfd) != 0)) {
    fputs("scriptc: pipe() failed\n", stderr);
    abort();
  }

  posix_spawn_file_actions_t fa;
  posix_spawn_file_actions_init(&fa);
  if (in_mode != 2) {
    posix_spawn_file_actions_addopen(&fa, 0, "/dev/null", O_RDONLY, 0);
  }
  if (cap_out) {
    posix_spawn_file_actions_adddup2(&fa, outfd[1], 1);
    posix_spawn_file_actions_addclose(&fa, outfd[0]);
    posix_spawn_file_actions_addclose(&fa, outfd[1]);
  } else if (out_mode == 1) {
    posix_spawn_file_actions_addopen(&fa, 1, "/dev/null", O_WRONLY, 0);
  }
  if (cap_err) {
    posix_spawn_file_actions_adddup2(&fa, errfd[1], 2);
    posix_spawn_file_actions_addclose(&fa, errfd[0]);
    posix_spawn_file_actions_addclose(&fa, errfd[1]);
  } else if (err_mode == 1) {
    posix_spawn_file_actions_addopen(&fa, 2, "/dev/null", O_WRONLY, 0);
  }

  char **argv = scr_child_argv(cmd, args);
  char **envp = env_pairs != NULL ? scr_exec_envp(env_pairs) : NULL;
  pid_t pid = -1;
  int spawn_err = scr_spawn_command(&pid, cmd->data, &fa, NULL, argv, envp, NULL);
  posix_spawn_file_actions_destroy(&fa);
  free(argv);
  scr_exec_envp_free(envp);
  if (cap_out) close(outfd[1]);
  if (cap_err) close(errfd[1]);

  if (spawn_err != 0) {
    /* Node: status null, error ENOENT/EACCES/... — never a throw. The
     * errno rides the result for the `error` property read. */
    if (cap_out) close(outfd[0]);
    if (cap_err) close(errfd[0]);
    ScrSpawnRes *r = scr_spawn_res_new(false, 0, scr_str_new("", 0), scr_str_new("", 0));
    r->spawn_errname = scr_errname(spawn_err);
    r->cmd = scr_str_retain(cmd);
#ifdef SCR_CHILD_ERR_FIELDS
    r->spawn_errno = -(double)spawn_err;
    r->args = scr_child_snapshot_args(args);
#endif
    return r;
  }

  /* Drain BOTH pipes together (a child filling one while we block on the
   * other would deadlock a sequential read); the poll deadline implements
   * the timeout, exactly the exec core's discipline. */
  ScrCapBuf out, err;
  scr_cap_init(&out);
  scr_cap_init(&err);
  bool out_open = cap_out, err_open = cap_err;
  bool timed_out = false;
  bool enobufs = false; /* the outputs together passed maxBuffer */
  double deadline = timeout_ms > 0 ? scr_now_ms() + timeout_ms : 0;
  while (out_open || err_open) {
    struct pollfd fds[2];
    nfds_t n = 0;
    if (out_open) { fds[n].fd = outfd[0]; fds[n].events = POLLIN; n++; }
    if (err_open) { fds[n].fd = errfd[0]; fds[n].events = POLLIN; n++; }
    int wait = -1;
    if (deadline > 0 && !timed_out) {
      double left = deadline - scr_now_ms();
      wait = left > 0 ? (int)(left + 0.999) : 0;
    }
    int rc = poll(fds, n, wait);
    if (rc < 0) {
      if (errno == EINTR) continue;
      break;
    }
    bool kill_now = false;
    if (deadline > 0 && !timed_out && scr_now_ms() >= deadline) {
      timed_out = true;
      kill_now = true;
    }
    for (nfds_t i = 0; rc > 0 && !kill_now && i < n; i++) {
      if (!(fds[i].revents & (POLLIN | POLLHUP | POLLERR))) continue;
      if (out_open && fds[i].fd == outfd[0]) out_open = scr_cap_read(&out, outfd[0]);
      else if (err_open && fds[i].fd == errfd[0]) err_open = scr_cap_read(&err, errfd[0]);
      if (max_buffer > 0 && (double)(out.len + err.len) > max_buffer) {
        enobufs = true;
        kill_now = true;
      }
    }
    if (kill_now) {
      /* Node kills the child and closes every stdio pipe (spawn_sync.cc's
       * Kill), so a grandchild that holds one cannot keep the call
       * waiting past the deadline or the limit. */
      kill(pid, killsig);
      scr_cap_close(&outfd[0]);
      scr_cap_close(&errfd[0]);
      out_open = err_open = false;
    }
  }
  scr_cap_close(&outfd[0]);
  scr_cap_close(&errfd[0]);

  /* Reap. With nothing captured the deadline lives here: WNOHANG-poll
   * until the child exits or the timeout kill fires (the exec core's
   * pipes-drained-daemon discipline). */
  int st = 0;
  pid_t reaped = -1;
  if (deadline > 0 && !timed_out && !enobufs) {
    for (;;) {
      reaped = waitpid(pid, &st, WNOHANG);
      if (reaped == pid || (reaped < 0 && errno != EINTR)) break;
      if (scr_now_ms() >= deadline) {
        timed_out = true;
        kill(pid, killsig);
        break;
      }
      struct timespec ts = {0, 500000}; /* 0.5ms */
      nanosleep(&ts, NULL);
    }
  }
  if (reaped != pid) {
    do {
      reaped = waitpid(pid, &st, 0);
    } while (reaped < 0 && errno == EINTR);
  }

  ScrStr *out_s = scr_str_new(out.data, out.len);
  ScrStr *err_s = scr_str_new(err.data, err.len);
  free(out.data);
  free(err.data);
  ScrSpawnRes *r;
  if (WIFEXITED(st) && !timed_out) {
    r = scr_spawn_res_new(true, (double)WEXITSTATUS(st), out_s, err_s);
  } else {
    /* Killed by a signal (the timeout's included): Node's status null,
     * signal = the terminating signal's name. */
    r = scr_spawn_res_new(false, 0, out_s, err_s);
    if (WIFSIGNALED(st)) r->signal_name = scr_signal_name(WTERMSIG(st));
    if (timed_out) {
      /* Node: error ETIMEDOUT + signal = killSignal (the kill may have
       * raced a normal exit; Node reports the timeout either way). */
      if (r->signal_name == NULL) r->signal_name = scr_signal_name(killsig);
      r->spawn_errname = "ETIMEDOUT";
      r->cmd = scr_str_retain(cmd);
#ifdef SCR_CHILD_ERR_FIELDS
      r->spawn_errno = -(double)ETIMEDOUT;
      r->args = scr_child_snapshot_args(args);
#endif
    }
  }
  if (enobufs && !timed_out) {
    /* Node: error ENOBUFS beside what the child did after the kill, its
     * exit code when it had already exited and the signal otherwise. */
    r->spawn_errname = "ENOBUFS";
    r->cmd = scr_str_retain(cmd);
#ifdef SCR_CHILD_ERR_FIELDS
    r->spawn_errno = -(double)ENOBUFS;
    r->args = scr_child_snapshot_args(args);
#endif
  }
  return r;
}

ScrSpawnRes *scr_spawn_sync(ScrStr *cmd, ScrArr *args) {
  return scr_spawn_sync_core(cmd, args, 0, SIGTERM, 0, 0, 0, NULL);
}

/* The options entry (cp.spawnSyncOpts): killSignal as a NAME ("" = the
 * SIGTERM default — the compiler already validated the literal against
 * Node's table by fencing non-literals; an unknown name here falls back
 * to SIGTERM defensively), modes as doubles (the IR's scalar). */
ScrSpawnRes *scr_spawn_sync_opts(ScrStr *cmd, ScrArr *args, double timeout_ms,
                                  ScrStr *killsignal, double in_mode,
                                  double out_mode, double err_mode) {
  return scr_spawn_sync_env(cmd, args, timeout_ms, killsignal, in_mode, out_mode, err_mode,
                            NULL);
}

ScrSpawnRes *scr_spawn_sync_env(ScrStr *cmd, ScrArr *args, double timeout_ms,
                                ScrStr *killsignal, double in_mode, double out_mode,
                                double err_mode, ScrArr *env_pairs) {
  int killsig = SIGTERM;
  if (killsignal->len > 0) {
    int resolved = scr_signal_from_name(killsignal);
    if (resolved > 0) killsig = resolved;
  }
  return scr_spawn_sync_core(cmd, args, timeout_ms, killsig, (int)in_mode,
                             (int)out_mode, (int)err_mode, env_pairs);
}

/* The runtime-string stdio entry (cp.spawnSyncStdioStr): the compiler
 * proved the value's TYPE is a union of "pipe"/"ignore"/"inherit"
 * literals (the defaultRunner idiom `stdio: options?.stdio ?? "pipe"`),
 * so mapping to the three modes happens here at the call. */
ScrSpawnRes *scr_spawn_sync_stdio_str(ScrStr *cmd, ScrArr *args, double timeout_ms,
                                       ScrStr *killsignal, ScrStr *stdio) {
  double in_mode = 0, out_mode = 0, err_mode = 0; /* "pipe": the defaults */
  if (stdio->len == 7 && memcmp(stdio->data, "inherit", 7) == 0) {
    in_mode = 2; out_mode = 2; err_mode = 2;
  } else if (stdio->len == 6 && memcmp(stdio->data, "ignore", 6) == 0) {
    out_mode = 1; err_mode = 1;
  }
  return scr_spawn_sync_opts(cmd, args, timeout_ms, killsignal, in_mode, out_mode, err_mode);
}

/* ── execFileSync / execSync ──────────────────────────────────────────
 * One parameterized core (scr_exec_sync) behind both: posix_spawn(p) +
 * piped utf8 capture + waitpid, with the option slice portless-class CLIs
 * actually pass — cwd, env replacement, stdin input, per-fd stdio modes,
 * and a SIGTERM timeout. Node semantics, matched exactly:
 * - Non-zero exit (or signal death) THROWS an Error whose message is
 *   Node's checkExecSyncError text: "Command failed: <cmd>" with the
 *   captured stderr appended on its own line when there is any.
 * - Spawn failure throws "spawnSync <file> ENOENT" (Node routes the
 *   uv_spawn error through the same thrower).
 * - Timeout kills with SIGTERM and throws "spawnSync <file> ETIMEDOUT".
 * - Default stdio ECHOES the captured stderr to the parent's stderr after
 *   the child completes (Node's inheritStderr flag — the capture is
 *   unconditional); an explicit stdio option turns that off, and an
 *   "ignore" stderr slot discards it entirely (nothing in the message).
 * - The thrown error carries Node's own properties: status, signal,
 *   output, pid, stdout and stderr (Buffers, or strings with an encoding
 *   option), after the errnoException fields on a spawn failure or a
 *   timeout.
 * The result is the captured utf8 stdout (+1). */

typedef struct {
  bool shell;          /* argv = /bin/sh -c <cmd> */
  const ScrStr *input; /* NULL/absent: stdin from /dev/null */
  const ScrStr *cwd;   /* NULL: inherit */
  ScrArr *env_pairs;   /* NULL: inherit; else [k,v,...] REPLACES environ */
  double timeout_ms;   /* <= 0: none */
  int stdout_mode;     /* 1 capture (default), 0 ignore, 2 inherit */
  int stderr_mode;     /* 0 capture+echo (default), 1 capture, 2 ignore, 3 inherit */
  bool stdin_inherit;  /* stdio "inherit": the child keeps the parent's fd 0 */
  /* The promisified-execFile shape (Node's async execFile, pinned by
   * oracle): failure messages read "Command failed: <cmd>\n<stderr>" with
   * the newline UNCONDITIONAL (the sync form appends only when stderr is
   * non-empty), spawn failure reads "spawn <file> <ERR>" (not spawnSync)
   * with `code` stamped, and a timeout is NOT ETIMEDOUT — the SIGTERM
   * lands and the death reports as an ordinary command failure, exactly
   * Node's promisified behavior. */
  bool async_shape;
  /* The sync forms' error outputs are Buffers (no encoding option). */
  bool buffers;
  /* async_shape success: the captured stderr string (+1) lands here. */
  ScrStr **stderr_out;
} ScrExecOpts;

/* Node's message-command: the shell form shows the command string, the
 * file form joins file + args with spaces. */
static char *scr_exec_display(ScrStr *cmd, ScrArr *args, bool shell) {
  if (shell) {
    ScrStr *c = (ScrStr *)scr_arr_get_ref(args, 1); /* ["-c", cmd] */
    char *out = malloc(c->len + 1);
    if (!out) scr_child_oom();
    memcpy(out, c->data, c->len + 1);
    scr_str_release(c);
    return out;
  }
  size_t n = (size_t)scr_arr_len(args);
  size_t total = cmd->len;
  for (size_t i = 0; i < n; i++) {
    ScrStr *s = (ScrStr *)scr_arr_get_ref(args, (double)i);
    total += 1 + s->len;
    scr_str_release(s);
  }
  char *out = malloc(total + 1);
  if (!out) scr_child_oom();
  memcpy(out, cmd->data, cmd->len);
  size_t at = cmd->len;
  for (size_t i = 0; i < n; i++) {
    ScrStr *s = (ScrStr *)scr_arr_get_ref(args, (double)i);
    out[at++] = ' ';
    memcpy(out + at, s->data, s->len);
    at += s->len;
    scr_str_release(s);
  }
  out[at] = '\0';
  return out;
}

/* Builds a NULL-terminated envp from [k,v,...] pairs ("k=v" strings, each
 * malloc'd). Free with scr_exec_envp_free. */
static char **scr_exec_envp(ScrArr *pairs) {
  size_t n = (size_t)scr_arr_len(pairs) / 2;
  char **envp = malloc((n + 1) * sizeof(char *));
  if (!envp) scr_child_oom();
  for (size_t i = 0; i < n; i++) {
    ScrStr *k = (ScrStr *)scr_arr_get_ref(pairs, (double)(2 * i));
    ScrStr *v = (ScrStr *)scr_arr_get_ref(pairs, (double)(2 * i + 1));
    char *kv = malloc(k->len + 1 + v->len + 1);
    if (!kv) scr_child_oom();
    memcpy(kv, k->data, k->len);
    kv[k->len] = '=';
    memcpy(kv + k->len + 1, v->data, v->len + 1);
    if (!k->ascii || !v->ascii) scr_wtf8_to_utf8(kv, k->len + 1 + v->len);
    envp[i] = kv;
    scr_str_release(k);
    scr_str_release(v);
  }
  envp[n] = NULL;
  return envp;
}

static void scr_exec_envp_free(char **envp) {
  if (!envp) return;
  for (size_t i = 0; envp[i]; i++) free(envp[i]);
  free(envp);
}

/* The Command-failed error (+1; the caller adds its properties).
 * always_nl is the async shape: Node's promisified execFile appends
 * "\n<stderr>" unconditionally (a trailing newline on empty stderr),
 * where the sync form appends only when stderr is non-empty. */
static ScrError *scr_exec_failed_error(const char *display, const ScrCapBuf *err_cap,
                                       bool with_stderr, bool always_nl) {
  size_t dlen = strlen(display);
  size_t elen = with_stderr ? err_cap->len : 0;
  size_t cap = 16 + dlen + 1 + elen + 1;
  char *msg = malloc(cap);
  if (!msg) scr_child_oom();
  size_t at = (size_t)snprintf(msg, cap, "Command failed: %s", display);
  if (elen > 0 || always_nl) {
    msg[at++] = '\n';
    memcpy(msg + at, err_cap->data, elen);
    at += elen;
  }
  ScrStr *message = scr_str_new(msg, at);
  free(msg);
  ScrError *e = scr_error_new(SCR_ERR_ERROR, message);
  scr_str_release(message);
  return e;
}

/* "spawnSync <file> <ERRNAME>" — Node's uv-error for spawn failures,
 * timeouts and a capture past maxBuffer (+1): `code` is the errno name,
 * and the errnoException fields (errno, syscall, path, spawnargs) follow. */
static ScrError *scr_exec_spawn_error(ScrStr *cmd, ScrArr *args, int errnum, bool async_shape) {
  const char *errname = errnum == ENOBUFS ? "ENOBUFS" : scr_errname(errnum);
  const char *verb = async_shape ? "spawn" : "spawnSync";
  size_t cap = 10 + cmd->len + 1 + strlen(errname) + 1;
  char *msg = malloc(cap);
  if (!msg) scr_child_oom();
  int len = snprintf(msg, cap, "%s %s %s", verb, cmd->data, errname);
  ScrStr *message = scr_str_new(msg, (size_t)len);
  free(msg);
  ScrError *e = scr_error_new(SCR_ERR_ERROR, message);
  scr_str_release(message);
  scr_error_set_code(e, errname);
  scr_child_error_spawn_fields(e, -(double)errnum, verb, cmd, args);
  return e;
}

static void scr_exec_throw(ScrError *e /* moves */) {
  scr_throw_obj(e, &scr_error_retain_v, &scr_error_release_v, scr_error_trace_arg());
}

/* After a read into buf (which held `before` bytes): whether the capture
 * just passed maxBuffer. The async shape limits each stream and cuts it
 * where Node's exec does; the sync forms limit both streams together, 0
 * meaning no limit (spawn_sync.cc). */
static bool scr_exec_capture_over(const ScrExecOpts *o, double max_buffer, ScrCapBuf *buf,
                                  size_t before, double *text_len, const ScrCapBuf *other) {
  if (o->async_shape)
    return scr_exec_limit_chunk((uint8_t *)buf->data, &buf->len, before, text_len, max_buffer);
  return max_buffer > 0 && (double)(buf->len + other->len) > max_buffer;
}

ScrStr *scr_exec_sync_core(ScrStr *cmd, ScrArr *args, const ScrExecOpts *o) {
  double max_buffer = scr_child_max_take();
  int outfd[2] = {-1, -1}, errfd[2] = {-1, -1}, infd[2] = {-1, -1};
  bool cap_out = o->stdout_mode == 1;
  bool cap_err = o->stderr_mode == 0 || o->stderr_mode == 1;
  if (o->stdout_mode == 2 || o->stderr_mode == 3) {
    /* Inherited output fds: flush the parent's buffers first so earlier
     * logs precede the child's writes (Node's practical ordering). */
    scr_stdout_settle();
    fflush(stdout);
    fflush(stderr);
  }
  bool has_input = o->input != NULL;
  if ((cap_out && pipe(outfd) != 0) || (cap_err && pipe(errfd) != 0) ||
      (has_input && pipe(infd) != 0)) {
    fputs("scriptc: pipe() failed\n", stderr);
    abort();
  }

  posix_spawn_file_actions_t fa;
  posix_spawn_file_actions_init(&fa);
  if (has_input) {
    posix_spawn_file_actions_adddup2(&fa, infd[0], 0);
    posix_spawn_file_actions_addclose(&fa, infd[0]);
    posix_spawn_file_actions_addclose(&fa, infd[1]);
  } else if (!o->stdin_inherit) {
    posix_spawn_file_actions_addopen(&fa, 0, "/dev/null", O_RDONLY, 0);
  } /* inherit: no action — the child keeps the parent's fd 0 */
  if (cap_out) {
    posix_spawn_file_actions_adddup2(&fa, outfd[1], 1);
    posix_spawn_file_actions_addclose(&fa, outfd[0]);
    posix_spawn_file_actions_addclose(&fa, outfd[1]);
  } else if (o->stdout_mode != 2) {
    posix_spawn_file_actions_addopen(&fa, 1, "/dev/null", O_WRONLY, 0);
  } /* mode 2 (inherit): the child keeps the parent's fd 1 */
  if (cap_err) {
    posix_spawn_file_actions_adddup2(&fa, errfd[1], 2);
    posix_spawn_file_actions_addclose(&fa, errfd[0]);
    posix_spawn_file_actions_addclose(&fa, errfd[1]);
  } else if (o->stderr_mode != 3) {
    posix_spawn_file_actions_addopen(&fa, 2, "/dev/null", O_WRONLY, 0);
  } /* mode 3 (inherit): the child keeps the parent's fd 2 */
#if defined(__APPLE__) || defined(__GLIBC__) || defined(SCR_MUSL)
  if (o->cwd != NULL) {
    posix_spawn_file_actions_addchdir_np(&fa, o->cwd->data);
  }
#endif

  char **argv = scr_child_argv(cmd, args);
  char **envp = o->env_pairs != NULL ? scr_exec_envp(o->env_pairs) : NULL;
  pid_t pid = -1;
  int spawn_err = scr_spawn_command(&pid, cmd->data, &fa, NULL, argv, envp,
                                    o->cwd != NULL ? o->cwd->data : NULL);
  posix_spawn_file_actions_destroy(&fa);
  free(argv);
  scr_exec_envp_free(envp);
  if (cap_out) close(outfd[1]);
  if (cap_err) close(errfd[1]);
  if (has_input) close(infd[0]);

  if (spawn_err != 0) {
    if (cap_out) close(outfd[0]);
    if (cap_err) close(errfd[0]);
    if (has_input) close(infd[1]);
    /* execSync's ENOENT is the SHELL missing — can't happen; the file
     * form reports Node's spawnSync error. */
    ScrError *e = scr_exec_spawn_error(cmd, args, spawn_err, o->async_shape);
    if (o->async_shape) {
      char *display = scr_exec_display(cmd, args, o->shell);
      scr_child_error_cmd(e, display);
      free(display);
      ScrStr *empty = scr_str_new("", 0);
      scr_child_error_outputs(e, empty, empty);
      scr_str_release(empty);
    } else {
      scr_child_error_self(e);
      scr_child_error_sync_fields(e, false, 0, NULL, 0, false, NULL, NULL);
    }
    scr_exec_throw(e);
    return NULL;
  }

  /* Feed stdin and drain both outputs together (either alone can fill and
   * deadlock a sequential loop); the poll deadline implements timeout. */
  if (has_input) fcntl(infd[1], F_SETFL, O_NONBLOCK);
  ScrCapBuf out, err;
  scr_cap_init(&out);
  scr_cap_init(&err);
  bool out_open = cap_out, err_open = cap_err, in_open = has_input;
  size_t in_at = 0;
  char *input_owned = NULL;
  const char *input = has_input ? scr_str_utf8(o->input, &input_owned) : NULL;
  bool timed_out = false;
  bool enobufs = false;    /* the sync forms: both outputs together passed maxBuffer */
  const char *over = NULL; /* the async shape: the stream that passed it */
  double out_text = 0, err_text = 0;
  double deadline = o->timeout_ms > 0 ? scr_now_ms() + o->timeout_ms : 0;
  while (out_open || err_open || in_open) {
    struct pollfd fds[3];
    nfds_t n = 0;
    if (out_open) { fds[n].fd = outfd[0]; fds[n].events = POLLIN; n++; }
    if (err_open) { fds[n].fd = errfd[0]; fds[n].events = POLLIN; n++; }
    if (in_open) { fds[n].fd = infd[1]; fds[n].events = POLLOUT; n++; }
    int wait = -1;
    if (deadline > 0 && !timed_out) {
      double left = deadline - scr_now_ms();
      wait = left > 0 ? (int)(left + 0.999) : 0;
    }
    int rc = poll(fds, n, wait);
    if (rc < 0) {
      if (errno == EINTR) continue;
      break;
    }
    bool kill_now = false;
    if (deadline > 0 && !timed_out && scr_now_ms() >= deadline) {
      /* Node's timeout: killSignal (SIGTERM default) to the child. */
      timed_out = true;
      kill_now = true;
    }
    for (nfds_t i = 0; rc > 0 && !kill_now && i < n; i++) {
      if (fds[i].revents == 0) continue;
      if (out_open && fds[i].fd == outfd[0]) {
        if (fds[i].revents & (POLLIN | POLLHUP | POLLERR)) {
          size_t before = out.len;
          out_open = scr_cap_read(&out, outfd[0]);
          if (scr_exec_capture_over(o, max_buffer, &out, before, &out_text, &err)) {
            if (o->async_shape) over = "stdout";
            else enobufs = true;
            kill_now = true;
          }
        }
      } else if (err_open && fds[i].fd == errfd[0]) {
        if (fds[i].revents & (POLLIN | POLLHUP | POLLERR)) {
          size_t before = err.len;
          err_open = scr_cap_read(&err, errfd[0]);
          if (scr_exec_capture_over(o, max_buffer, &err, before, &err_text, &out)) {
            if (o->async_shape) over = "stderr";
            else enobufs = true;
            kill_now = true;
          }
        }
      } else if (in_open && fds[i].fd == infd[1]) {
        if (fds[i].revents & (POLLERR | POLLHUP)) {
          close(infd[1]);
          in_open = false; /* child closed stdin early: fine, like Node */
        } else if (fds[i].revents & POLLOUT) {
          ssize_t wrote = write(infd[1], input + in_at, o->input->len - in_at);
          if (wrote > 0) in_at += (size_t)wrote;
          else if (wrote < 0 && errno != EINTR && errno != EAGAIN) {
            close(infd[1]);
            in_open = false;
          }
          if (in_at >= o->input->len) {
            close(infd[1]);
            in_open = false;
          }
        }
      }
    }
    if (kill_now) {
      /* Node kills the child and closes every stdio pipe, so a grandchild
       * that holds one cannot keep the call waiting (spawn_sync.cc's Kill,
       * and exec's kill, which destroys both streams). */
      kill(pid, SIGTERM);
      scr_cap_close(&outfd[0]);
      scr_cap_close(&errfd[0]);
      if (in_open) close(infd[1]);
      out_open = err_open = in_open = false;
    }
  }
  scr_cap_close(&outfd[0]);
  scr_cap_close(&errfd[0]);
  if (in_open) close(infd[1]);
  scr_str_utf8_end(input_owned);

  /* Reap. A live deadline still applies here: a child that closed its
   * stdio but keeps running (the pipes-drained daemon shape) must still be
   * killed at the timeout, so the wait polls WNOHANG until then. */
  int st = 0;
  pid_t reaped = -1;
  if (deadline > 0 && !timed_out && !enobufs && over == NULL) {
    for (;;) {
      reaped = waitpid(pid, &st, WNOHANG);
      if (reaped == pid || (reaped < 0 && errno != EINTR)) break;
      if (scr_now_ms() >= deadline) {
        timed_out = true;
        kill(pid, SIGTERM);
        break;
      }
      struct timespec ts = {0, 500000}; /* 0.5ms */
      nanosleep(&ts, NULL);
    }
  }
  if (reaped != pid) {
    do {
      reaped = waitpid(pid, &st, 0);
    } while (reaped < 0 && errno == EINTR);
  }

  /* Node's inheritStderr: no stdio option given → the captured stderr
   * echoes to the parent's stderr AFTER completion, success, failure or
   * timeout. */
  if (o->stderr_mode == 0 && err.len > 0) {
    scr_stdout_settle();
    fflush(stdout);
    fwrite(err.data, 1, err.len, stderr);
  }
  bool exited = WIFEXITED(st) && !(timed_out && !o->async_shape);
  const char *signal = WIFSIGNALED(st) ? scr_signal_name(WTERMSIG(st)) : NULL;
  if (timed_out && !o->async_shape) {
    /* The SYNC forms throw Node's spawnSync ETIMEDOUT (signal = the kill
     * signal even when the child raced it); the async shape reports the
     * SIGTERM death as an ordinary command failure below, exactly Node's
     * promisified execFile. */
    ScrError *e = scr_exec_spawn_error(cmd, args, ETIMEDOUT, false);
    scr_child_error_self(e);
    scr_child_error_sync_fields(e, false, 0, signal != NULL ? signal : "SIGTERM", (double)pid,
                                true, scr_child_sync_output(out.data, out.len, cap_out, o->buffers),
                                scr_child_sync_output(err.data, err.len, cap_err, o->buffers));
    free(out.data);
    free(err.data);
    scr_exec_throw(e);
    return NULL;
  }
  if (enobufs) {
    /* The sync forms throw Node's spawnSync ENOBUFS with what the child
     * did after the kill: its exit code when it had already exited, the
     * signal otherwise. */
    ScrError *e = scr_exec_spawn_error(cmd, args, ENOBUFS, false);
    scr_child_error_self(e);
    scr_child_error_sync_fields(e, exited, exited ? (double)WEXITSTATUS(st) : 0, signal,
                                (double)pid, true,
                                scr_child_sync_output(out.data, out.len, cap_out, o->buffers),
                                scr_child_sync_output(err.data, err.len, cap_err, o->buffers));
    free(out.data);
    free(err.data);
    scr_exec_throw(e);
    return NULL;
  }
  if (over != NULL) {
    /* exec's maxBuffer error: cmd, then the outputs as cut. */
    char *display = scr_exec_display(cmd, args, o->shell);
    ScrError *e = scr_child_max_error(over, display);
    free(display);
    ScrStr *out_s = scr_str_new(out.data, out.len);
    ScrStr *err_s = scr_str_new(err.data, err.len);
    scr_child_error_outputs(e, out_s, err_s);
    scr_str_release(out_s);
    scr_str_release(err_s);
    free(out.data);
    free(err.data);
    scr_exec_throw(e);
    return NULL;
  }
  bool failed = !exited || WEXITSTATUS(st) != 0;
  if (failed) {
    char *display = scr_exec_display(cmd, args, o->shell);
    ScrError *e = scr_exec_failed_error(display, &err, cap_err, o->async_shape);
    if (o->async_shape) {
      scr_child_error_exit_fields(e, exited, exited ? (double)WEXITSTATUS(st) : 0, signal,
                                  timed_out);
      scr_child_error_cmd(e, display);
      ScrStr *out_s = scr_str_new(out.data, out.len);
      ScrStr *err_s = scr_str_new(err.data, err.len);
      scr_child_error_outputs(e, out_s, err_s);
      scr_str_release(out_s);
      scr_str_release(err_s);
    } else {
      scr_child_error_sync_fields(e, exited, exited ? (double)WEXITSTATUS(st) : 0, signal,
                                  (double)pid, true,
                                  scr_child_sync_output(out.data, out.len, cap_out, o->buffers),
                                  scr_child_sync_output(err.data, err.len, cap_err, o->buffers));
    }
    free(display);
    free(out.data);
    free(err.data);
    scr_exec_throw(e);
    return NULL;
  }
  if (o->async_shape && o->stderr_out != NULL) {
    *o->stderr_out = scr_str_new(err.data, err.len);
  }
  ScrStr *out_s = scr_str_new(out.data, out.len);
  free(out.data);
  free(err.data);
  return out_s;
}

/* The libCall entry: modes as doubles (the IR's scalar), input as string +
 * presence flag (Node's exact member reading: an absent/undefined input
 * means NO stdin pipe — /dev/null — while "" pipes EMPTY stdin, the child
 * reading immediate EOF from the pipe), absent cwd as "" ("" is never a
 * valid cwd), env as has_env + pairs (an EMPTY env option is legal Node —
 * it means an empty environment). */
ScrStr *scr_exec_sync(ScrStr *cmd, ScrArr *args, bool shell, ScrStr *input,
                       bool has_input, ScrStr *cwd, bool has_env, ScrArr *env_pairs,
                       double timeout_ms, double stdout_mode, double stderr_mode,
                       bool buffers) {
  ScrExecOpts o = {
      .shell = shell,
      .input = has_input ? input : NULL,
      .cwd = cwd->len > 0 ? cwd : NULL,
      .env_pairs = has_env ? env_pairs : NULL,
      .timeout_ms = timeout_ms,
      /* stdio "inherit"'s stdin rides bit 4 of stdout_mode (the libCall
       * signature predates the mode; see scr_runtime.h). */
      .stdout_mode = (int)stdout_mode & 3,
      .stderr_mode = (int)stderr_mode,
      .stdin_inherit = ((int)stdout_mode & 4) != 0,
      .buffers = buffers,
  };
  return scr_exec_sync_core(cmd, args, &o);
}

/* The promisified-execFile/exec capture (cp.execCapture; shell as for
 * scr_exec_sync — the /bin/sh -c argv): the SAME exec core
 * in the async shape — both streams captured (no echo), Node's async
 * messages on the throw paths (the compiler's interned async helper turns
 * the throw into the rejection). Success answers a +1 ScrSpawnRes reusing
 * the spawnSync result container (status unused — a failure threw). */
ScrSpawnRes *scr_exec_capture(ScrStr *cmd, ScrArr *args, bool shell, ScrStr *cwd,
                               bool has_env, ScrArr *env_pairs, double timeout_ms) {
  ScrStr *err_s = NULL;
  ScrExecOpts o = {
      .shell = shell,
      .input = NULL,
      .cwd = cwd->len > 0 ? cwd : NULL,
      .env_pairs = has_env ? env_pairs : NULL,
      .timeout_ms = timeout_ms,
      .stdout_mode = 1,
      .stderr_mode = 1,
      .async_shape = true,
      .stderr_out = &err_s,
  };
  ScrStr *out_s = scr_exec_sync_core(cmd, args, &o);
  if (out_s == NULL) return NULL; /* exception pending; dummy result */
  return scr_spawn_res_new(true, 0, out_s, err_s);
}

/* ── spawn: the asynchronous child + its event registry ──────────────────
 *
 * spawn(cmd, args, { stdio: "ignore" }) starts the child IMMEDIATELY
 * (posix_spawn, all three stdio fds on /dev/null) and registers it with
 * the loop: scr_async.c polls scr_children_poll() at quiescence, which
 * waitpid(WNOHANG)s every running child and fires listeners when one is
 * reaped. Node semantics, matched exactly:
 * - "exit" fires once with the exit code, or NO code (→ the null arm)
 *   when the child died to a signal.
 * - "error" fires ONLY for spawn failure (the binary could not be
 *   spawned); a spawn failure never fires "exit".
 * - An "error" event with no registered listener prints the error and
 *   exits 1 (the unhandled-'error' EventEmitter behavior).
 * - The loop keeps the process alive until every child is reaped —
 *   scr_children_pending() is part of its exhaustion test.
 * Wakeup: every spawned child is registered with a kqueue PROC filter
 * (NOTE_EXIT), and the loop's quiescent sleep waits on that kqueue
 * (scr_children_wait) so an exit wakes it immediately — the reap itself
 * stays the WNOHANG sweep below, which the wakeup merely triggers. When
 * kqueue is unavailable (non-kqueue platforms, or a child whose filter
 * registration failed because it already exited), the loop falls back to
 * the original ~1ms polling cap until that child settles.
 *
 * Ownership/cycles: the child holds its listeners (+1 each, moved in)
 * only until the terminal event fires — settling releases every
 * listener, so a listener capturing its own child cannot cycle past the
 * reap, and children allocate lean (no trace header). A listener
 * registered after settling is released immediately and never fires
 * (Node: listeners added after 'exit' emitted don't fire). */

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

/* ── piped child output (child.stdout / child.stderr) ────────────────────
 *
 * spawn with stdio ["ignore", "pipe", "pipe"] gives the child fresh pipes
 * for fds 1/2 and the parent a ScrChildStream handle per piped fd —
 * refcounted like the child itself (the child holds one reference so
 * child.stdout answers for the handle's whole life; the service registry
 * holds another until EOF). The stdin-consumer pattern in reverse:
 * - The pipe's read end is NONBLOCKING and read ONLY while a 'data'
 *   listener exists (no consumer = no read: the pipe itself is the
 *   buffer, backpressure exactly like a paused Node stream).
 * - One service pass reads to EAGAIN/EOF, firing one 'data' per read(2)
 *   chunk (≤64KB — libuv's pipe reads chunk the same way, pinned against
 *   Node's out(65536)... sequence).
 * - EOF fires 'end' once, drops the listeners, closes the fd, and leaves
 *   the registry; nothing fires after (listeners registered post-'end'
 *   release immediately — the stdin slice's rule).
 * - ORDERING, pinned against Node: a child's stream 'end' events fire
 *   BEFORE its 'exit' — the settle path drains consumer-owning streams
 *   to EOF/EAGAIN before the exit listeners run. EAGAIN with the child
 *   reaped means another process still holds the write end (a detached
 *   grandchild): 'exit' fires and the stream keeps delivering on later
 *   turns, exactly Node.
 * - LIVENESS: a stream with a 'data' consumer that has not hit EOF holds
 *   the loop alive (Node's flowing-pipe keep-alive); 'end' listeners
 *   alone do not. Wakeups ride the child kqueue: the read end is armed
 *   LEVEL-TRIGGERED (no EV_CLEAR — scr_children_wait's drain discards
 *   events, and a level filter keeps the kqueue readable while unread
 *   data sits in the pipe, so no wakeup is ever lost) when the first
 *   consumer attaches; an arm failure counts into the unwatched-children
 *   fallback (the ~1ms polling cap). */

typedef struct {
  ScrClosure *cb; /* owned */
  ScrChildStreamDataFn fn;
  ScrChildStreamDataStrFn str_fn;
  unsigned kind;
  bool once;
} ScrChildStreamDataL;

typedef struct {
  ScrClosure *cb; /* owned */
  bool once;
} ScrChildStreamEndL;

struct ScrChildStream {
  size_t rc;
  int fd;   /* the pipe's read end; -1 after EOF or spawn failure */
  bool eof; /* 'end' delivered (or the stream never opened) */
  bool close_wait;
  bool capture;
  ScrStr *encoding;
  double dec_pending;
  uint8_t *capture_data;
  size_t capture_len, capture_cap;
  bool armed;     /* EVFILT_READ registered on the child kqueue */
  bool arm_queued; /* registers at the loop's next poll (scr_child_arm_queue) */
  uint32_t arm_seq; /* names this registration in the kernel's events */
  uint32_t born;    /* creation order among the thread's streams */
  unsigned long eof_pass; /* the pass (scr_children_pass) that ended it */
  bool uncounted; /* counted into scr_children_unwatched (arm failure) */
  bool short_read_yields; /* a short read ends this pass's reads */
  unsigned long short_read_pass;
  ScrChildStreamDataL *data_ls;
  size_t n_data, cap_data;
  ScrChildStreamEndL *end_ls;
  size_t n_end, cap_end;
  /* The AsyncLocalStorage context of the spawn() call that created the
   * stream (+1, NULL outside a store): its events run in it, as Node's
   * pipe handles run theirs. */
  ScrAlsCtx *als;
#ifdef SCR_CHILD_STREAM_FLOW
  ScrChildFlow flow; /* pause()/resume() state (scr_child_flow.h) */
#endif
  struct ScrChildStream *next; /* the service registry (+1) */
#ifdef SCR_CHILD_FOREIGN
  void *island; /* a Node island's stream: every entry point goes to scr_child_island_ops */
#endif
};

struct ScrChildWriter {
  size_t rc;
  int fd; /* the pipe's nonblocking write end; -1 once settled */
  bool writable;
  bool ending;
  bool finished;
  bool destroyed;
  bool need_drain;
  bool drain_pending;
  bool finish_pending;
  bool error_pending;
  bool armed;     /* EVFILT_WRITE registered on the child watch */
  bool uncounted; /* counted into scr_children_unwatched (arm failure) */
  uint8_t *buf;
  size_t off, len, cap;
  ScrStr *err_msg;
  const char *err_code; /* static storage */
  ScrChildStreamEndL *drain_ls;
  size_t n_drain, cap_drain;
  ScrChildStreamEndL *finish_ls;
  size_t n_finish, cap_finish;
  ScrChildErrEntry *err_ls;
  size_t n_write_err, cap_write_err;
  /* AsyncLocalStorage contexts (+1 each, NULL outside a store): the
   * latest write() call's, for 'drain' and 'error' (the spawn() call's
   * until the first write), and the end() call's, for 'finish'. */
  ScrAlsCtx *als;
  ScrAlsCtx *end_als;
  struct ScrChildWriter *next; /* the service registry (+1) */
#ifdef SCR_CHILD_FOREIGN
  void *island; /* a Node island's stream: every entry point goes to scr_child_island_ops */
#endif
};

static SCR_TL ScrChildStream *scr_child_streams = NULL;
/* Streams created so far, and how many of them existed at the loop's last
 * poll (the order of a turn's stream events, below). */
static SCR_TL uint32_t scr_child_streams_born = 0, scr_child_streams_polled_born = 0;
/* Streams with a live consumer (data listener, not yet EOF): the loop's
 * keep-alive and service predicate. */
static SCR_TL size_t scr_child_streams_watching = 0;
static SCR_TL ScrChildWriter *scr_child_writers = NULL;
static bool scr_child_writers_pending(void);
static void scr_child_writers_service(void);
static void scr_child_writer_child_settled(ScrChildWriter *w);
static void scr_child_writer_dearm(ScrChildWriter *w);
static bool scr_child_writers_blocked(void);
static bool scr_child_writers_ready(void);
/* Registers the streams that asked for their read filter since the last
 * poll (scr_child_streams_arm_flush, set by the thread's first stream that
 * asks; per thread, like the queue it flushes, so worker threads do not
 * share a write). The wait and the wake fd reach it through this pointer,
 * and the pointer has external linkage, on purpose: a direct call, or a
 * static pointer the compiler can see through, puts the registration code
 * in front of the wait in this object, and with it the unit's first mention
 * of the libc functions it calls. The linker orders an executable's imports
 * by first mention, so every program that links any part of this unit would
 * change. */
SCR_TL void (*scr_child_streams_arm_flush_hook)(void) = NULL;
/* How many events one poll of the child watch takes. Streams past that
 * wait for the next poll: their filters are level-triggered, and the
 * kernel queue keeps their order. */
#define SCR_CHILD_READY_MAX 64
static void scr_child_streams_polled(const void *events, int n);

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
  ScrStr *spawnfile; /* ChildProcess.spawnfile: the file that was spawned */
  ScrArr *spawnargs; /* ChildProcess.spawnargs: the file followed by its arguments */
  void (*exec_props)(struct ScrChild *c, ScrError *error); /* Node's error properties */
  /* Piped stdio (stdio mode 3): the stream handles child.stdout /
   * child.stderr answer — owned (+1 each), NULL when not piped. */
  ScrChildStream *out_stream;
  ScrChildStream *err_stream;
  ScrChildWriter *in_stream;
  ScrDyn *out_dyn, *err_dyn, *in_dyn;
  ScrIpc *ipc;
  /* The AsyncLocalStorage context of the spawn() call (+1, NULL outside
   * a store): 'spawn', 'error', 'exit' and 'close' run in it. */
  ScrAlsCtx *als;
  struct ScrChild *next; /* the pending registry */
#ifdef SCR_CHILD_FOREIGN
  void *island; /* a Node island's child: every entry point goes to scr_child_island_ops */
#endif
};

#ifdef SCR_CHILD_FOREIGN
/* The handles of a child a Node island made: no pipe, no pid, in no
 * registry. scr_node_island_child.c makes them and sets the table. */
const ScrChildIslandOps *scr_child_island_ops = NULL;

ScrChild *scr_child_island_new(void *island) {
  ScrChild *c = calloc(1, sizeof *c);
  if (!c) scr_trap("scriptc: out of memory\n");
  c->rc = 1;
  c->island = island;
  return c;
}

ScrChildStream *scr_child_stream_island_new(void *island) {
  ScrChildStream *s = calloc(1, sizeof *s);
  if (!s) scr_trap("scriptc: out of memory\n");
  s->rc = 1;
  s->fd = -1;
  s->island = island;
  return s;
}

ScrChildWriter *scr_child_writer_island_new(void *island) {
  ScrChildWriter *w = calloc(1, sizeof *w);
  if (!w) scr_trap("scriptc: out of memory\n");
  w->rc = 1;
  w->fd = -1;
  w->island = island;
  return w;
}
#endif

static SCR_TL ScrChild *scr_children = NULL; /* unsettled children (registry +1) */
static SCR_TL ScrChild *scr_children_closing = NULL; /* exited, waiting for stdio EOF */
static SCR_TL size_t scr_children_reffed_n = 0; /* unsettled AND reffed (liveness) */
static SCR_TL unsigned long scr_children_pass = 0; /* reap passes run */

/* Children the kqueue can NOT wake the loop for (spawn failures awaiting
 * their first-pass settle, exit-filter registration failures, every child
 * on a non-kqueue platform): while any exist, scr_children_wait refuses
 * and the loop keeps the polling cap for them. */
static SCR_TL size_t scr_children_unwatched = 0;

#ifdef SCR_HAVE_KQUEUE
static SCR_TL int scr_child_kq = -1; /* created with the first spawn; lives forever */

/* Arms NOTE_EXIT for a freshly spawned pid. False = the child cannot be
 * watched (it already exited and EVFILT_PROC refuses zombies — the very
 * next WNOHANG sweep reaps it). EV_ONESHOT: the kernel drops the filter at
 * delivery; a reaped-before-consumed event is a harmless spurious wakeup. */
static bool scr_child_watch(pid_t pid) {
  if (scr_child_kq < 0) {
    scr_child_kq = kqueue();
    if (scr_child_kq < 0) return false;
  }
  struct kevent ev;
  EV_SET(&ev, (uintptr_t)pid, EVFILT_PROC, EV_ADD | EV_ONESHOT, NOTE_EXIT, 0, NULL);
  struct timespec zero = {0, 0};
  return kevent(scr_child_kq, &ev, 1, NULL, 0, &zero) == 0;
}

/* The reap already consumed the wakeup — EV_ONESHOT dropped the filter at
 * delivery, so there is nothing to release. */
static void scr_child_unwatch(pid_t pid) { (void)pid; }
#endif

#ifdef SCR_CHILD_HAVE_PIDFD
static SCR_TL int scr_child_ep = -1; /* created with the first spawn; lives forever */

/* pid -> pidfd, so the reap can CLOSE the pidfd (it polls readable from
 * exit until closed — kqueue's ONESHOT drop has no epoll analogue). A
 * handful of entries at the corpus's scale; linear is fine. */
typedef struct {
  pid_t pid;
  int pidfd;
} ScrChildPidfd;

static SCR_TL ScrChildPidfd *scr_child_pidfds = NULL;
static SCR_TL size_t scr_child_pidfds_n = 0, scr_child_pidfds_cap = 0;

/* Arms an exit wakeup for a freshly spawned pid: pidfd_open registered
 * EPOLLIN. False = the child cannot be watched (ENOSYS on pre-5.3
 * kernels, EMFILE) — the caller keeps the polling cap for it. A pidfd
 * opens fine on a zombie and polls readable at once, so the unwatched
 * set is rarer here than kqueue's refuses-zombies case. */
static bool scr_child_watch(pid_t pid) {
  if (scr_child_ep < 0) {
    scr_child_ep = epoll_create1(EPOLL_CLOEXEC);
    if (scr_child_ep < 0) return false;
  }
  int pfd = pidfd_open(pid, 0);
  if (pfd < 0) return false;
  if (scr_child_pidfds_n == scr_child_pidfds_cap) {
    size_t cap = scr_child_pidfds_cap == 0 ? 8 : scr_child_pidfds_cap * 2;
    ScrChildPidfd *grown = realloc(scr_child_pidfds, cap * sizeof *grown);
    if (grown == NULL) {
      close(pfd);
      return false;
    }
    scr_child_pidfds = grown;
    scr_child_pidfds_cap = cap;
  }
  struct epoll_event ev = {.events = EPOLLIN, .data = {.fd = pfd}};
  if (epoll_ctl(scr_child_ep, EPOLL_CTL_ADD, pfd, &ev) != 0) {
    close(pfd);
    return false;
  }
  scr_child_pidfds[scr_child_pidfds_n++] = (ScrChildPidfd){pid, pfd};
  return true;
}

/* After waitpid reaped the pid: deregister and close its pidfd, or it
 * would keep the epoll readable forever. */
static void scr_child_unwatch(pid_t pid) {
  for (size_t i = 0; i < scr_child_pidfds_n; i++) {
    if (scr_child_pidfds[i].pid != pid) continue;
    (void)epoll_ctl(scr_child_ep, EPOLL_CTL_DEL, scr_child_pidfds[i].pidfd, NULL);
    close(scr_child_pidfds[i].pidfd);
    scr_child_pidfds[i] = scr_child_pidfds[scr_child_pidfds_n - 1];
    scr_child_pidfds_n--;
    return;
  }
}
#endif

#if !defined(SCR_HAVE_KQUEUE) && !defined(SCR_CHILD_HAVE_PIDFD)
static void scr_child_unwatch(pid_t pid) { (void)pid; }
#endif

/* The loop's quiescent sleep while children are pending: waits on the
 * kqueue up to max_wait_ms (the next timer deadline) — a child's NOTE_EXIT
 * wakes it immediately, and the caller's next reap pass settles the child.
 * Returns false when this can't wake for every pending child (no kqueue,
 * or an unwatched child exists): the caller falls back to the ~1ms polling
 * cap instead. Exit events are wakeups only — the WNOHANG sweep stays the
 * single reaping mechanism — and the streams the wait reports are the
 * next pass's, in the order reported (scr_child_streams_polled). */
/* The pollable child-exit wake fd for the loop's poll(2) sleep (a kqueue
 * fd reads as ready while events are pending): valid only when the kqueue
 * can wake for EVERY pending child — same condition as scr_children_wait.
 * -1 tells the caller to keep the ~1ms reap cap instead. */
int scr_children_wake_fd(void) {
  /* Streams whose first consumer attached this turn join the watch now,
   * before the sleep that must wake for them. */
  if (scr_child_streams_arm_flush_hook != NULL) scr_child_streams_arm_flush_hook();
  /* A writer's queued bytes ride the same watch (its writability filter),
   * so only a writer the watch could not arm keeps the polling cap. */
  if (scr_child_writers_blocked()) return -1;
#ifdef SCR_HAVE_KQUEUE
  if (scr_child_kq < 0 || scr_children_unwatched > 0) return -1;
  return scr_child_kq;
#elif defined(SCR_CHILD_HAVE_PIDFD)
  if (scr_child_ep < 0 || scr_children_unwatched > 0) return -1;
  return scr_child_ep; /* readable while any pidfd/stream event pends */
#else
  return -1;
#endif
}

bool scr_children_wait(double max_wait_ms) {
  if (scr_child_streams_arm_flush_hook != NULL) scr_child_streams_arm_flush_hook(); /* as the wake fd */
  if (scr_child_writers_blocked()) return false;
#ifdef SCR_HAVE_KQUEUE
  if (scr_child_kq < 0 || scr_children_unwatched > 0) return false;
  if (!(max_wait_ms > 0)) max_wait_ms = 0;
  struct timespec ts = {(time_t)(max_wait_ms / 1000.0),
                        (long)((max_wait_ms - (double)((time_t)(max_wait_ms / 1000.0)) * 1000.0) * 1e6)};
  struct kevent evs[SCR_CHILD_READY_MAX];
  /* EINTR: a spurious pass. */
  scr_child_streams_polled(evs, kevent(scr_child_kq, NULL, 0, evs, SCR_CHILD_READY_MAX, &ts));
  return true;
#elif defined(SCR_CHILD_HAVE_PIDFD)
  if (scr_child_ep < 0 || scr_children_unwatched > 0) return false;
  if (!(max_wait_ms > 0)) max_wait_ms = 0;
  double capped = max_wait_ms > 2147483000.0 ? 2147483000.0 : max_wait_ms;
  struct epoll_event evs[SCR_CHILD_READY_MAX];
  /* Exit events are wakeups only, exactly like the kqueue arm's;
   * level-triggered pidfds stay readable until the reap closes them, so
   * nothing is lost. EINTR: a spurious pass. */
  scr_child_streams_polled(
      evs, epoll_wait(scr_child_ep, evs, SCR_CHILD_READY_MAX, (int)(capped + 0.999)));
  return true;
#else
  (void)max_wait_ms;
  return false;
#endif
}

static void scr_child_drop_terminal_listeners(ScrChild *c) {
  scr_child_drop_spawn_listeners(c);
  for (size_t i = 0; i < c->n_exit; i++) scr_closure_release(c->exit_cbs[i].cb);
  for (size_t i = 0; i < c->n_err; i++) scr_closure_release(c->err_cbs[i].cb);
  free(c->exit_cbs);
  free(c->err_cbs);
  c->exit_cbs = NULL;
  c->err_cbs = NULL;
  c->n_exit = c->n_err = c->cap_exit = c->cap_err = 0;
  scr_closure_release(c->exec_cb);
  c->exec_cb = NULL;
  c->exec_fn = NULL;
}

static void scr_child_drop_close_listeners(ScrChild *c) {
  for (size_t i = 0; i < c->n_close; i++) scr_closure_release(c->close_cbs[i].cb);
  free(c->close_cbs);
  c->close_cbs = NULL;
  c->n_close = c->cap_close = 0;
}

static void scr_child_drop_listeners(ScrChild *c) {
  scr_child_drop_terminal_listeners(c);
  scr_child_drop_close_listeners(c);
}

ScrChild *scr_child_retain(ScrChild *c) {
  if (c->rc != SIZE_MAX) c->rc++;
  return c;
}

void scr_child_release(ScrChild *c) {
  if (!c || c->rc == SIZE_MAX) return;
  if (--c->rc == 0) {
    SCR_IF_ISLAND(c, scr_child_island_ops->drop(c->island));
    scr_child_drop_listeners(c); /* only reachable pre-settle via leaks */
    scr_str_release(c->err_msg);
    scr_str_release(c->exec_display);
    scr_str_release(c->exec_file);
    if (c->exec_args) scr_arr_release(c->exec_args);
    scr_str_release(c->spawnfile);
    if (c->spawnargs) scr_arr_release(c->spawnargs);
    scr_dyn_release(c->out_dyn);
    scr_dyn_release(c->err_dyn);
    scr_dyn_release(c->in_dyn);
    scr_child_stream_release(c->out_stream);
    scr_child_stream_release(c->err_stream);
    scr_child_writer_release(c->in_stream);
    scr_ipc_release(c->ipc);
    scr_als_ctx_release(c->als);
    free(c);
  }
}

void *scr_child_retain_v(void *p) { return scr_child_retain((ScrChild *)p); }
void scr_child_release_v(void *p) { scr_child_release((ScrChild *)p); }

/* Node's error-code names for the spawn failures posix_spawn can
 * report (libuv reports the same POSIX names). */
static const char *scr_errname(int err) {
  switch (err) {
  case ENOENT: return "ENOENT";
  case EACCES: return "EACCES";
  case EPERM: return "EPERM";
  case ENOTDIR: return "ENOTDIR";
  case ENOEXEC: return "ENOEXEC";
  case ELOOP: return "ELOOP";
  case ENAMETOOLONG: return "ENAMETOOLONG";
  case E2BIG: return "E2BIG";
  case ENOMEM: return "ENOMEM";
  case EAGAIN: return "EAGAIN";
  case EIO: return "EIO";
  case EINVAL: return "EINVAL";
  case ETIMEDOUT: return "ETIMEDOUT";
  default: return "EUNKNOWN";
  }
}

/* ── the stream slice's implementation ─────────────────────────────── */

ScrChildStream *scr_child_stream_retain(ScrChildStream *s) {
  if (s->rc != SIZE_MAX) s->rc++;
  return s;
}

static void scr_child_stream_drop_listeners(ScrChildStream *s) {
  for (size_t i = 0; i < s->n_data; i++) scr_closure_release(s->data_ls[i].cb);
  for (size_t i = 0; i < s->n_end; i++) scr_closure_release(s->end_ls[i].cb);
  free(s->data_ls);
  free(s->end_ls);
  s->data_ls = NULL;
  s->end_ls = NULL;
  s->n_data = s->n_end = s->cap_data = s->cap_end = 0;
}

void scr_child_stream_release(ScrChildStream *s) {
  if (!s || s->rc == SIZE_MAX) return;
  if (--s->rc == 0) {
    SCR_IF_ISLAND(s, scr_child_island_ops->drop(s->island));
    scr_child_stream_drop_listeners(s); /* only reachable pre-'end' via leaks */
#ifdef SCR_CHILD_STREAM_FLOW
    scr_child_flow_free(s);
#endif
    if (s->fd >= 0) close(s->fd);
    scr_str_release(s->encoding);
    free(s->capture_data);
    scr_als_ctx_release(s->als);
    free(s);
  }
}

void *scr_child_stream_retain_v(void *p) { return scr_child_stream_retain((ScrChildStream *)p); }
void scr_child_stream_release_v(void *p) { scr_child_stream_release((ScrChildStream *)p); }

static void scr_child_stream_dearm(ScrChildStream *s);
static void scr_child_stream_arm(ScrChildStream *s);

/* True while the stream has a consumer and can still deliver. */
static bool scr_child_stream_watching(const ScrChildStream *s) {
#ifdef SCR_CHILD_STREAM_FLOW
  /* Paused or resumed: the stream reads until it holds the high-water mark,
   * with or without listeners (scr_child_flow.h). */
  if (s->flow.state != SCR_CHILD_FLOW_NONE)
    return !s->eof && s->fd >= 0 && (s->capture || s->flow.len < SCR_CHILD_FLOW_HWM);
#endif
  return !s->eof && s->fd >= 0 && (s->n_data > 0 || s->capture || s->close_wait);
}

#ifdef SCR_CHILD_STREAM_FLOW
#include "scr_child_flow_impl.h"
#endif

/* A fresh piped stream over the pipe's read end (nonblocking, cloexec);
 * registered with the service registry (+1). fd < 0 = the never-opened
 * husk a failed spawn hands out (eof from birth, never registered). */
static ScrChildStream *scr_child_stream_new(int fd) {
  ScrChildStream *s = calloc(1, sizeof *s);
  if (!s) scr_child_oom();
  s->rc = 1;
  s->als = scr_als_capture();
  s->fd = fd;
  if (fd < 0) {
    s->eof = true;
    return s;
  }
  fcntl(fd, F_SETFL, O_NONBLOCK);
  fcntl(fd, F_SETFD, FD_CLOEXEC);
  s->born = ++scr_child_streams_born;
  s->next = scr_child_streams;
  scr_child_streams = scr_child_stream_retain(s);
  return s;
}

static void scr_child_stream_capture_begin(ScrChildStream *s) {
  if (s == NULL || s->eof || s->fd < 0 || s->capture) return;
  bool was_watching = scr_child_stream_watching(s);
  s->capture = true;
  if (!was_watching) {
    scr_child_streams_watching++;
    scr_child_stream_arm(s);
  }
}

static void scr_child_stream_close_wait(ScrChildStream *s) {
  if (s == NULL || s->eof || s->fd < 0 || s->close_wait) return;
  bool was_watching = scr_child_stream_watching(s);
  s->close_wait = true;
  if (!was_watching) {
    scr_child_streams_watching++;
    scr_child_stream_arm(s);
  }
}

static void scr_child_stream_capture_append(ScrChildStream *s, const char *data,
                                            size_t len) {
  if (!s->capture || len == 0) return;
  size_t need = s->capture_len + len;
  if (need > s->capture_cap) {
    size_t cap = s->capture_cap ? s->capture_cap : 256;
    while (cap < need) cap *= 2;
    uint8_t *grown = realloc(s->capture_data, cap);
    if (!grown) scr_child_oom();
    s->capture_data = grown;
    s->capture_cap = cap;
  }
  memcpy(s->capture_data + s->capture_len, data, len);
  s->capture_len = need;
}

static ScrStr *scr_child_stream_capture_value(ScrChildStream *s) {
  return s == NULL || s->capture_len == 0
      ? scr_str_new("", 0)
      : scr_str_new((const char *)s->capture_data, s->capture_len);
}

static void scr_child_stream_emit_posix_in(ScrChildStream *s, ScrBytes *bytes, ScrStr *text);

/* 'data' runs in the spawn() call's context. */
static void scr_child_stream_emit_posix(ScrChildStream *s, ScrBytes *bytes, ScrStr *text) {
  ScrAlsCtx *prev = scr_als_dispatch_enter(s->als);
  scr_child_stream_emit_posix_in(s, bytes, text);
  scr_als_dispatch_leave(prev);
}

static void scr_child_stream_emit_posix_in(ScrChildStream *s, ScrBytes *bytes, ScrStr *text) {
  size_t nd = s->n_data;
  if (nd == 0) return;
  ScrChildStreamDataL *snap = malloc(nd * sizeof *snap);
  if (!snap) scr_child_oom();
  for (size_t i = 0; i < nd; i++) {
    snap[i] = s->data_ls[i];
    scr_closure_retain(snap[i].cb);
  }
  for (size_t i = 0; i < nd; i++) {
    if (snap[i].once) {
      for (size_t j = 0; j < s->n_data; j++) {
        if (s->data_ls[j].cb == snap[i].cb) {
          scr_closure_release(s->data_ls[j].cb);
          memmove(s->data_ls + j, s->data_ls + j + 1,
                  (s->n_data - j - 1) * sizeof *s->data_ls);
          s->n_data--;
          if (s->n_data == 0 && !s->capture && !s->close_wait) {
            scr_child_streams_watching--;
            scr_child_stream_dearm(s);
            if (s->uncounted) {
              s->uncounted = false;
              scr_children_unwatched--;
            }
          }
          break;
        }
      }
    }
    if (!scr_exc_pending()) {
      if (snap[i].kind == SCR_CHILD_DATA_ZERO) {
        ((void (*)(ScrClosure *))snap[i].cb->fn)(snap[i].cb);
      } else if (text != NULL && snap[i].kind == SCR_CHILD_DATA_STRING) {
        snap[i].str_fn(snap[i].cb, text);
      } else if (bytes != NULL && snap[i].kind == SCR_CHILD_DATA_BYTES) {
        snap[i].fn(snap[i].cb, bytes);
      } else {
        static const char msg[] =
            "child stream data listener type does not match setEncoding state";
        scr_throw_error_msg(SCR_ERR_TYPE, msg, sizeof msg - 1);
      }
    }
    scr_closure_release(snap[i].cb);
  }
  free(snap);
}

/* EOF/error tail: 'end' fires over a snapshot, everything drops, the fd
 * closes (deleting its kqueue filter), and the liveness/fallback counters
 * settle. The caller unlinks from the registry and releases its ref. */
static void scr_child_stream_finish_in(ScrChildStream *s, bool fire_end);

/* A stream's 'end' runs in the spawn() call's context. */
static void scr_child_stream_finish(ScrChildStream *s, bool fire_end) {
  ScrAlsCtx *prev = scr_als_dispatch_enter(s->als);
  scr_child_stream_finish_in(s, fire_end);
  scr_als_dispatch_leave(prev);
}

static void scr_child_stream_finish_in(ScrChildStream *s, bool fire_end) {
#ifdef SCR_CHILD_STREAM_FLOW
  if (fire_end && scr_child_flow_defer_end(s)) return;
#endif
  if (fire_end && s->encoding != NULL && s->n_data > 0) {
    ScrStr *tail = scr_strdec_end(s->encoding, s->dec_pending);
    s->dec_pending = 0;
    if (tail->len > 0) scr_child_stream_emit_posix(s, NULL, tail);
    scr_str_release(tail);
    if (scr_exc_pending()) fire_end = false;
  }
  if (scr_child_stream_watching(s)) scr_child_streams_watching--;
  if (s->uncounted) {
    s->uncounted = false;
    scr_children_unwatched--;
  }
  s->eof = true;
  s->eof_pass = scr_children_pass;
  if (s->fd >= 0) {
    close(s->fd);
    s->fd = -1;
  }
  if (fire_end) {
    size_t n = s->n_end;
    ScrChildStreamEndL *snap = malloc(n * sizeof *snap);
    if (!snap) scr_child_oom();
    for (size_t i = 0; i < n; i++) {
      snap[i] = s->end_ls[i];
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
  scr_child_stream_drop_listeners(s);
}

/* One read pump: while a consumer exists, read(2) to EAGAIN/EOF, one
 * 'data' per chunk (snapshot; `once` entries leave the live list before
 * running — the stdin service's discipline). Returns true when the
 * stream hit EOF (or a read error — piped read errors are not
 * meaningfully reachable, treated as EOF like the stdin slice's
 * no-listener path): the caller finishes and unlinks it. */
/* Ends a stream as a destroyed one ends: its descriptor is replaced by
 * one at end of file, so the pump finishes the stream on its next read and
 * the pipe's read end closes now (a grandchild that still writes gets
 * EPIPE, as under Node). */
static void scr_exec_stream_cut(ScrChildStream *s) {
  if (s->eof || s->fd < 0) return;
  int nul = open("/dev/null", O_RDONLY | O_CLOEXEC);
  if (nul < 0) return;
  (void)dup2(nul, s->fd);
  close(nul);
}

static bool scr_child_stream_pump(ScrChildStream *s) {
  if (s->short_read_yields && s->short_read_pass == scr_children_pass) return false;
  while (scr_child_stream_watching(s)) {
    char buf[65536];
    ssize_t n = read(s->fd, buf, sizeof buf);
    if (n < 0) {
      if (errno == EINTR) continue;
      return errno != EAGAIN;
    }
    if (n == 0) return true;
    scr_child_stream_capture_append(s, buf, (size_t)n);
#ifdef SCR_CHILD_STREAM_FLOW
    if (scr_child_flow_take(s, buf, (size_t)n)) {
      if (scr_exc_pending()) return false;
      continue;
    }
#endif
    if (s->n_data == 0) continue;
    ScrBytes *chunk = scr_bytes_new(SCR_BYTES_U8, (double)n);
    chunk->is_buffer = true; /* Node delivers a Buffer */
    memcpy(chunk->data, buf, (size_t)n);
    ScrStr *text = NULL;
    if (s->encoding != NULL) {
      text = scr_strdec_write(s->encoding, s->dec_pending, chunk);
      s->dec_pending = scr_strdec_next(s->encoding, s->dec_pending, chunk);
    }
    if (text == NULL || text->len > 0) {
      scr_child_stream_emit_posix(s, text == NULL ? chunk : NULL, text);
    }
    scr_str_release(text);
    scr_bytes_release(chunk);
    if (scr_exc_pending()) return false;
    if (s->short_read_yields && (size_t)n < sizeof buf) {
      s->short_read_pass = scr_children_pass;
      return false;
    }
  }
  return false;
}

/* ── the order of a turn's stream events ─────────────────────────────────
 *
 * Node hands out a turn's I/O in the order its kernel queue reports it:
 * libuv polls once per turn and walks the array epoll_wait (kevent on BSD)
 * filled, running each descriptor's callback in that order (uv__io_poll).
 * The kernel appends a descriptor to that queue when it becomes readable,
 * or, when it already was readable, when it is registered. libuv registers
 * a descriptor at its next poll after reading started, in the order reading
 * started, and Node starts reading a child's pipes when spawn() creates
 * them, stdout before stderr, whether or not anyone listens. So two pipes
 * that fill while the loop sleeps come back in the order they filled, and
 * two pipes that filled before the loop next polled (the program computed
 * after spawn(), or the child was quicker than the program's way back to
 * the loop) come back in the order they were created: stdout before
 * stderr, an older child's before a newer one's. That second half is an
 * accident of registration, not a documented order, and programs observe
 * it: a child that writes stderr and then stdout while its parent computes
 * is delivered stdout first, also when stderr's listener was attached
 * first.
 *
 * Both halves are matched here on purpose, by doing what libuv does with
 * the same kernel object. A stream's read filter is registered at the
 * loop's next poll after its first consumer attached (the queue below),
 * never at the attach itself, and streams created since the last poll
 * register in creation order. The loop's poll is its wait
 * (scr_children_wait), and the pass after it serves the streams that wait
 * reported, in the order reported; a pass with no wait before it polls for
 * itself. A stream no poll reported is not read in that pass. Before, a
 * pass read every watched stream in the registry's order, newest first,
 * which served stderr ahead of stdout whenever both were readable.
 *
 * A stream whose first consumer attaches after a poll has passed is where
 * the two part: Node has been reading it into the stream's buffer and
 * hands that over at the attach, in attach order; here the pipe is the
 * buffer, and such streams register in attach order, ahead of the streams
 * created since.
 *
 * One poll per pass matters. The Linux queue moves a level-triggered
 * descriptor it has just reported behind any descriptor that became ready
 * while it was reporting, so a second poll over streams the first one
 * reported and nobody read can return them in the other order. Every
 * stream a poll reports is therefore served before the next poll.
 *
 * Each registration carries a number, so an event names one registration
 * of one stream: a descriptor closed and opened again between a poll and
 * its pass does not hand its event to the stream that now owns the number.
 * A stream the kernel queue could not take (a failed registration, a
 * platform with neither queue) has no place in that order; the pass reads
 * those after, in registry order, as it always did. */

typedef struct {
  int fd;
  uint32_t seq; /* the registration's number (ScrChildStream.arm_seq) */
} ScrChildReady;

/* Streams whose first consumer attached since the loop last polled, in
 * attach order (+1 each); the flush puts them in registration order. */
static SCR_TL ScrChildStream **scr_child_arm_queue = NULL;
static SCR_TL size_t scr_child_arm_queue_n = 0, scr_child_arm_queue_cap = 0;
static SCR_TL uint32_t scr_child_arm_seq = 0;
/* True while the flush registers the queue: scr_child_stream_arm then
 * registers the stream it is given instead of queueing it. */
static SCR_TL bool scr_child_arm_registering = false;
static void scr_child_streams_arm_flush(void);

/* What the loop's last wait reported, for the pass that follows it; n < 0
 * when no wait ran since the last pass. */
static SCR_TL ScrChildReady scr_child_polled[SCR_CHILD_READY_MAX];
static SCR_TL int scr_child_polled_n = -1;

/* The streams among `n` events of the child watch, in the events' order.
 * Exit and writability events on the same watch name no stream: they are
 * wakeups, and stay until the reap and the writer service consume their
 * cause. */
static int scr_child_streams_among(const void *events, int n, ScrChildReady *out) {
  int found = 0;
#ifdef SCR_HAVE_KQUEUE
  const struct kevent *evs = events;
  for (int i = 0; i < n; i++) {
    if (evs[i].filter != EVFILT_READ || evs[i].udata == NULL) continue;
    out[found++] = (ScrChildReady){(int)evs[i].ident, (uint32_t)(uintptr_t)evs[i].udata};
  }
#elif defined(SCR_CHILD_HAVE_PIDFD)
  const struct epoll_event *evs = events;
  for (int i = 0; i < n; i++) {
    uint32_t seq = (uint32_t)(evs[i].data.u64 >> 32);
    if (seq == 0) continue; /* a pidfd or a writer: registered by fd alone */
    out[found++] = (ScrChildReady){(int)(uint32_t)evs[i].data.u64, seq};
  }
#else
  (void)events;
  (void)n;
  (void)out;
#endif
  return found;
}

/* The loop's wait hands over what it was woken with. */
static void scr_child_streams_polled(const void *events, int n) {
  scr_child_polled_n = scr_child_streams_among(events, n, scr_child_polled);
}

/* Where a queued stream registers: one that existed at the last poll keeps
 * its place in attach order, ahead of the streams created since, which go
 * in creation order (the note above). */
static uint32_t scr_child_stream_arm_rank(const ScrChildStream *s) {
  return s->born <= scr_child_streams_polled_born ? 0 : s->born;
}

/* The loop is about to poll: the queued streams register. One whose last
 * consumer left, or that ended, since it was queued is skipped. */
static void scr_child_streams_arm_flush(void) {
  ScrChildStream **queue = scr_child_arm_queue;
  size_t n = scr_child_arm_queue_n;
  for (size_t i = 1; i < n; i++) { /* stable; the queue is a handful */
    ScrChildStream *s = queue[i];
    uint32_t rank = scr_child_stream_arm_rank(s);
    size_t j = i;
    for (; j > 0 && scr_child_stream_arm_rank(queue[j - 1]) > rank; j--) queue[j] = queue[j - 1];
    queue[j] = s;
  }
  scr_child_arm_registering = true;
  for (size_t i = 0; i < n; i++) {
    ScrChildStream *s = queue[i];
    if (s->arm_queued) {
      s->arm_queued = false;
      scr_child_stream_arm(s);
    }
    scr_child_stream_release(s);
  }
  scr_child_arm_registering = false;
  scr_child_arm_queue_n = 0;
  scr_child_streams_polled_born = scr_child_streams_born;
}

/* Polls the child watch without waiting: the streams it reports, in its
 * order. */
static int scr_child_streams_poll_now(ScrChildReady *out) {
  scr_child_streams_arm_flush();
#ifdef SCR_HAVE_KQUEUE
  if (scr_child_kq < 0) return 0;
  struct kevent evs[SCR_CHILD_READY_MAX];
  struct timespec zero = {0, 0};
  return scr_child_streams_among(
      evs, kevent(scr_child_kq, NULL, 0, evs, SCR_CHILD_READY_MAX, &zero), out);
#elif defined(SCR_CHILD_HAVE_PIDFD)
  if (scr_child_ep < 0) return 0;
  struct epoll_event evs[SCR_CHILD_READY_MAX];
  return scr_child_streams_among(evs, epoll_wait(scr_child_ep, evs, SCR_CHILD_READY_MAX, 0), out);
#else
  (void)out;
  return 0;
#endif
}

/* The settle-path drain (Node's pinned ordering: stream 'end' before
 * 'exit'): pump one stream to EOF/EAGAIN right now; on EOF, finish it
 * and unlink it from the registry. EAGAIN with the child reaped means a
 * grandchild still holds the write end — 'exit' proceeds and the stream
 * keeps delivering on later turns, exactly Node. */
static void scr_child_stream_drain_now(ScrChildStream *s) {
  if (s == NULL || !scr_child_stream_watching(s)) return;
  if (!scr_child_stream_pump(s)) return;
  ScrChildStream **link = &scr_child_streams;
  while (*link && *link != s) link = &(*link)->next;
  if (*link) {
    *link = s->next;
    s->next = NULL;
    scr_child_stream_finish(s, true);
    scr_child_stream_release(s);
  } else {
    scr_child_stream_finish(s, true); /* defensive: not registered */
  }
}

/* The stream an event names, or NULL when that registration is gone (the
 * stream ended or lost its last consumer earlier in the pass). */
static ScrChildStream *scr_child_stream_ready_find(ScrChildReady ready) {
  for (ScrChildStream *s = scr_child_streams; s != NULL; s = s->next) {
    if (s->armed && s->fd == ready.fd && s->arm_seq == ready.seq) return s;
  }
  return NULL;
}

/* Pumps the streams a poll reported, in its order. EOF finishes and
 * unlinks a stream (scr_child_stream_drain_now). */
static void scr_child_streams_serve(const ScrChildReady *ready, int n) {
  for (int i = 0; i < n; i++) {
    scr_child_stream_drain_now(scr_child_stream_ready_find(ready[i]));
    if (scr_exc_pending()) return;
  }
}

/* The pass's stream service: the streams of the loop's poll (the note
 * above), then the streams no poll can report, in registry order. */
static void scr_child_streams_service(void) {
  int polled = scr_child_polled_n;
  scr_child_polled_n = -1;
  if (scr_child_streams_watching == 0) return;
  ScrChildReady ready[SCR_CHILD_READY_MAX];
  if (polled >= 0) {
    memcpy(ready, scr_child_polled, (size_t)polled * sizeof *ready);
  } else {
    polled = scr_child_streams_poll_now(ready);
  }
  scr_child_streams_serve(ready, polled);
  if (scr_exc_pending() || scr_children_unwatched == 0) return;
  /* `uncounted` marks the streams the queue could not take. A stream that
   * is only waiting for the next poll to register is not one of them. */
  for (ScrChildStream *s = scr_child_streams; s != NULL;) {
    ScrChildStream *next = s->next; /* a listener adds streams at the head only */
    if (s->uncounted) scr_child_stream_drain_now(s);
    if (scr_exc_pending()) return;
    s = next;
  }
}

/* An exiting child's two streams, when both may still hold output: the
 * child wrote to both and exited after this pass's poll, so the settle
 * path is the first to see them, and its own drains would take stdout
 * first whatever was written first. One more poll gives the kernel's
 * order; it is served whole, other children's streams included, because a
 * reported stream must be read before the next poll (the note above). */
static void scr_child_streams_settle_order(ScrChildStream *a, ScrChildStream *b) {
  if (a == NULL || b == NULL || !scr_child_stream_watching(a) || !scr_child_stream_watching(b))
    return;
  ScrChildReady ready[SCR_CHILD_READY_MAX];
  scr_child_streams_serve(ready, scr_child_streams_poll_now(ready));
}

/* Drops the read filter when the LAST consumer leaves (a once-listener
 * removal): a level-triggered filter over an unread pipe would otherwise
 * wake every idle sleep for data nobody consumes. */
static void scr_child_stream_dearm(ScrChildStream *s) {
  s->arm_queued = false; /* a registration that had not happened yet */
  if (!s->armed) return;
  s->armed = false;
#ifdef SCR_HAVE_KQUEUE
  if (scr_child_kq >= 0 && s->fd >= 0) {
    struct kevent ev;
    EV_SET(&ev, (uintptr_t)s->fd, EVFILT_READ, EV_DELETE, 0, 0, NULL);
    struct timespec zero = {0, 0};
    (void)kevent(scr_child_kq, &ev, 1, NULL, 0, &zero);
  }
#elif defined(SCR_CHILD_HAVE_PIDFD)
  if (scr_child_ep >= 0 && s->fd >= 0) {
    (void)epoll_ctl(scr_child_ep, EPOLL_CTL_DEL, s->fd, NULL);
  }
#endif
}

/* A consumer-owning stream wants its read filter. It joins the queue, and
 * the loop's next poll registers the queue (scr_child_streams_arm_flush),
 * as libuv registers a handle that started reading; called from that
 * flush, this registers the level-triggered filter (see the design note:
 * no EV_CLEAR — level readiness keeps the watch readable while unread data
 * sits in the pipe, so no wakeup is lost). A registration failure joins
 * the unwatched fallback so the loop keeps the ~1ms polling cap for the
 * stream. */
static void scr_child_stream_arm(ScrChildStream *s) {
  if (s->armed || s->fd < 0) return;
  if (!scr_child_arm_registering) {
    if (s->arm_queued) return;
    if (scr_child_arm_queue_n == scr_child_arm_queue_cap) {
      size_t cap = scr_child_arm_queue_cap ? scr_child_arm_queue_cap * 2 : 8;
      ScrChildStream **grown = realloc(scr_child_arm_queue, cap * sizeof *grown);
      if (!grown) scr_child_oom();
      scr_child_arm_queue = grown;
      scr_child_arm_queue_cap = cap;
    }
    scr_child_arm_queue[scr_child_arm_queue_n++] = scr_child_stream_retain(s);
    s->arm_queued = true;
    scr_child_streams_arm_flush_hook = &scr_child_streams_arm_flush;
    return;
  }
  uint32_t seq = ++scr_child_arm_seq;
  if (seq == 0) seq = ++scr_child_arm_seq; /* 0: an event that names no stream */
#ifdef SCR_HAVE_KQUEUE
  if (scr_child_kq < 0) scr_child_kq = kqueue();
  if (scr_child_kq >= 0) {
    struct kevent ev;
    EV_SET(&ev, (uintptr_t)s->fd, EVFILT_READ, EV_ADD, 0, 0, (void *)(uintptr_t)seq);
    struct timespec zero = {0, 0};
    if (kevent(scr_child_kq, &ev, 1, NULL, 0, &zero) == 0) {
      s->armed = true;
      s->arm_seq = seq;
      return;
    }
  }
#elif defined(SCR_CHILD_HAVE_PIDFD)
  /* Level-triggered EPOLLIN, exactly the kqueue arm's level filter. */
  if (scr_child_ep < 0) scr_child_ep = epoll_create1(EPOLL_CLOEXEC);
  if (scr_child_ep >= 0) {
    struct epoll_event ev = {.events = EPOLLIN,
                             .data = {.u64 = ((uint64_t)seq << 32) | (uint32_t)s->fd}};
    if (epoll_ctl(scr_child_ep, EPOLL_CTL_ADD, s->fd, &ev) == 0) {
      s->armed = true;
      s->arm_seq = seq;
      return;
    }
  }
#else
  (void)seq;
#endif
  if (!s->uncounted) {
    s->uncounted = true;
    scr_children_unwatched++;
  }
}

/* stream.on/once("data", cb): the consumer that makes the pipe flow (and
 * keeps the loop alive). Post-'end' registrations release immediately
 * and never fire, the stdin rule. */
void scr_child_stream_on_data(ScrChildStream *s, ScrClosure *cb /*moves*/,
                               ScrChildStreamDataFn fn, bool once) {
  SCR_IF_ISLAND(s, scr_child_island_ops->on(s->island, SCR_CHILD_EV_DATA, cb, (void *)fn, once); return);
#ifdef SCR_CHILD_STREAM_FLOW
  if (scr_child_flow_on_data(s, cb, fn, NULL, once)) return;
#endif
  if (s->eof || s->fd < 0) {
    scr_closure_release(cb);
    return;
  }
  bool was_watching = scr_child_stream_watching(s);
  if (s->n_data == s->cap_data) {
    s->cap_data = s->cap_data ? s->cap_data * 2 : 2;
    s->data_ls = realloc(s->data_ls, s->cap_data * sizeof *s->data_ls);
    if (!s->data_ls) scr_child_oom();
  }
  s->data_ls[s->n_data].cb = cb;
  s->data_ls[s->n_data].fn = fn;
  s->data_ls[s->n_data].str_fn = NULL;
  s->data_ls[s->n_data].kind = fn == &scr_child_stream_thunk0
      ? SCR_CHILD_DATA_ZERO
      : SCR_CHILD_DATA_BYTES;
  s->data_ls[s->n_data].once = once;
  s->n_data++;
  if (!was_watching) {
    scr_child_streams_watching++;
    scr_child_stream_arm(s);
  }
}

void scr_child_stream_on_data_str(ScrChildStream *s, ScrClosure *cb /*moves*/,
                                  ScrChildStreamDataStrFn fn, bool once) {
  SCR_IF_ISLAND(s, scr_child_island_ops->on(s->island, SCR_CHILD_EV_DATA_STR, cb, (void *)fn, once); return);
#ifdef SCR_CHILD_STREAM_FLOW
  if (scr_child_flow_on_data(s, cb, NULL, fn, once)) return;
#endif
  if (s->eof || s->fd < 0) {
    scr_closure_release(cb);
    return;
  }
  bool was_watching = scr_child_stream_watching(s);
  if (s->n_data == s->cap_data) {
    s->cap_data = s->cap_data ? s->cap_data * 2 : 2;
    s->data_ls = realloc(s->data_ls, s->cap_data * sizeof *s->data_ls);
    if (!s->data_ls) scr_child_oom();
  }
  s->data_ls[s->n_data] = (ScrChildStreamDataL){
      .cb = cb, .fn = NULL, .str_fn = fn,
      .kind = SCR_CHILD_DATA_STRING, .once = once};
  s->n_data++;
  if (!was_watching) {
    scr_child_streams_watching++;
    scr_child_stream_arm(s);
  }
}

ScrChildStream *scr_child_stream_set_encoding(ScrChildStream *s, ScrStr *enc) {
  SCR_IF_ISLAND(s, scr_child_island_ops->set_encoding(s->island, enc); return scr_child_stream_retain(s));
  scr_str_release(s->encoding);
  s->encoding = scr_str_retain(enc);
  s->dec_pending = 0;
#ifdef SCR_CHILD_STREAM_FLOW
  scr_child_flow_set_encoding(s);
#endif
  return scr_child_stream_retain(s);
}

/* stream.on/once("end", cb): fires once at EOF; alone it neither reads
 * nor keeps the loop alive (the stdin rule). */
void scr_child_stream_on_end(ScrChildStream *s, ScrClosure *cb /*moves*/, bool once) {
  SCR_IF_ISLAND(s, scr_child_island_ops->on(s->island, SCR_CHILD_EV_END, cb, NULL, once); return);
  (void)once; /* 'end' fires at most once; the flag changes nothing */
#ifdef SCR_CHILD_STREAM_FLOW
  if (scr_child_flow_on_end(s, cb, once)) return;
#endif
  if (s->eof || s->fd < 0) {
    scr_closure_release(cb);
    return;
  }
  if (s->n_end == s->cap_end) {
    s->cap_end = s->cap_end ? s->cap_end * 2 : 2;
    s->end_ls = realloc(s->end_ls, s->cap_end * sizeof *s->end_ls);
    if (!s->end_ls) scr_child_oom();
  }
  s->end_ls[s->n_end].cb = cb;
  s->end_ls[s->n_end].once = once;
  s->n_end++;
}

/* child.stdout / child.stderr — +1 handle, or NULL when the slot was not
 * piped (Node's null there). */
ScrChildStream *scr_child_stdout(ScrChild *c) {
  SCR_IF_ISLAND(c, scr_child_island_ops->stdio(c));
  return c->out_stream ? scr_child_stream_retain(c->out_stream) : NULL;
}
ScrChildStream *scr_child_stderr(ScrChild *c) {
  SCR_IF_ISLAND(c, scr_child_island_ops->stdio(c));
  return c->err_stream ? scr_child_stream_retain(c->err_stream) : NULL;
}

/* The runtime-provided data adapters (the stdin pair's shapes — local to
 * this unit so piped children never require scr_events.c to link). */
void scr_child_stream_thunk0(ScrClosure *cb, ScrBytes *chunk) {
  (void)chunk;
  ((void (*)(ScrClosure *))cb->fn)(cb);
}
void scr_child_stream_thunk_bytes(ScrClosure *cb, ScrBytes *chunk) {
  /* The listener owns its +1 param per the universal convention. */
  ((void (*)(ScrClosure *, ScrBytes *))cb->fn)(cb, scr_bytes_retain(chunk));
}
void scr_child_stream_thunk_str(ScrClosure *cb, ScrStr *chunk) {
  ((void (*)(ScrClosure *, ScrStr *))cb->fn)(cb, scr_str_retain(chunk));
}

/* ── the piped-input writer ─────────────────────────────────────────── */

#define SCR_CHILD_WRITER_HWM 65536

static SCR_TL const char *scr_child_writer_err_code = NULL;

static void scr_child_writer_drop_zero_listeners(ScrChildWriter *w) {
  for (size_t i = 0; i < w->n_drain; i++) scr_closure_release(w->drain_ls[i].cb);
  for (size_t i = 0; i < w->n_finish; i++) scr_closure_release(w->finish_ls[i].cb);
  free(w->drain_ls);
  free(w->finish_ls);
  w->drain_ls = NULL;
  w->finish_ls = NULL;
  w->n_drain = w->cap_drain = 0;
  w->n_finish = w->cap_finish = 0;
}

static void scr_child_writer_drop_listeners(ScrChildWriter *w) {
  scr_child_writer_drop_zero_listeners(w);
  for (size_t i = 0; i < w->n_write_err; i++) scr_closure_release(w->err_ls[i].cb);
  free(w->err_ls);
  w->err_ls = NULL;
  w->n_write_err = w->cap_write_err = 0;
}

ScrChildWriter *scr_child_writer_retain(ScrChildWriter *w) {
  if (w->rc != SIZE_MAX) w->rc++;
  return w;
}

void scr_child_writer_release(ScrChildWriter *w) {
  if (!w || w->rc == SIZE_MAX) return;
  if (--w->rc == 0) {
    SCR_IF_ISLAND(w, scr_child_island_ops->drop(w->island));
    scr_child_writer_dearm(w);
    if (w->fd >= 0) close(w->fd);
    free(w->buf);
    scr_str_release(w->err_msg);
    scr_child_writer_drop_listeners(w);
    scr_als_ctx_release(w->als);
    scr_als_ctx_release(w->end_als);
    free(w);
  }
}

void *scr_child_writer_retain_v(void *p) {
  return scr_child_writer_retain((ScrChildWriter *)p);
}
void scr_child_writer_release_v(void *p) {
  scr_child_writer_release((ScrChildWriter *)p);
}

static ScrChildWriter *scr_child_writer_new(int fd) {
  ScrChildWriter *w = calloc(1, sizeof *w);
  if (!w) scr_child_oom();
  w->rc = 1;
  w->als = scr_als_capture();
  w->fd = fd;
  w->writable = fd >= 0;
  w->destroyed = fd < 0;
  if (fd >= 0) {
    fcntl(fd, F_SETFL, O_NONBLOCK);
    fcntl(fd, F_SETFD, FD_CLOEXEC);
    w->next = scr_child_writers;
    scr_child_writers = scr_child_writer_retain(w);
  }
  return w;
}

/* Drops the writability filter (a no-op when none is armed): the writer
 * has nothing queued for the pipe, so a ready-for-write pipe must not keep
 * waking the loop. */
static void scr_child_writer_dearm(ScrChildWriter *w) {
  if (!w->armed) return;
  w->armed = false;
#ifdef SCR_HAVE_KQUEUE
  if (scr_child_kq >= 0 && w->fd >= 0) {
    struct kevent ev;
    EV_SET(&ev, (uintptr_t)w->fd, EVFILT_WRITE, EV_DELETE, 0, 0, NULL);
    struct timespec zero = {0, 0};
    (void)kevent(scr_child_kq, &ev, 1, NULL, 0, &zero);
  }
#elif defined(SCR_CHILD_HAVE_PIDFD)
  if (scr_child_ep >= 0 && w->fd >= 0) {
    (void)epoll_ctl(scr_child_ep, EPOLL_CTL_DEL, w->fd, NULL);
  }
#endif
}

/* Arms the level-triggered writability filter for a writer with bytes
 * still queued: a pipe that cannot take them (EAGAIN) is what makes the
 * loop's sleep wait, and the filter wakes it as soon as room appears —
 * the read filters' shape, on the write end. An arm failure joins the
 * unwatched fallback so the loop keeps the ~1ms polling cap for it. */
static void scr_child_writer_arm(ScrChildWriter *w) {
  if (w->armed || w->fd < 0) return;
#ifdef SCR_HAVE_KQUEUE
  if (scr_child_kq < 0) scr_child_kq = kqueue();
  if (scr_child_kq >= 0) {
    struct kevent ev;
    EV_SET(&ev, (uintptr_t)w->fd, EVFILT_WRITE, EV_ADD, 0, 0, NULL);
    struct timespec zero = {0, 0};
    if (kevent(scr_child_kq, &ev, 1, NULL, 0, &zero) == 0) {
      w->armed = true;
      if (w->uncounted) {
        w->uncounted = false;
        scr_children_unwatched--;
      }
      return;
    }
  }
#elif defined(SCR_CHILD_HAVE_PIDFD)
  if (scr_child_ep < 0) scr_child_ep = epoll_create1(EPOLL_CLOEXEC);
  if (scr_child_ep >= 0) {
    struct epoll_event ev = {.events = EPOLLOUT, .data = {.fd = w->fd}};
    if (epoll_ctl(scr_child_ep, EPOLL_CTL_ADD, w->fd, &ev) == 0) {
      w->armed = true;
      if (w->uncounted) {
        w->uncounted = false;
        scr_children_unwatched--;
      }
      return;
    }
  }
#endif
  if (!w->uncounted) {
    w->uncounted = true;
    scr_children_unwatched++;
  }
}

static void scr_child_writer_close(ScrChildWriter *w) {
  scr_child_writer_dearm(w);
  if (w->uncounted) {
    w->uncounted = false;
    scr_children_unwatched--;
  }
  if (w->fd >= 0) {
    close(w->fd);
    w->fd = -1;
  }
  w->writable = false;
}

static void scr_child_writer_clear_queue(ScrChildWriter *w) {
  free(w->buf);
  w->buf = NULL;
  w->off = w->len = w->cap = 0;
}

static size_t scr_child_writer_queued(const ScrChildWriter *w) {
  return w->len - w->off;
}

static void scr_child_writer_append(ScrChildWriter *w, const void *data, size_t len) {
  if (len == 0) return;
  size_t queued = scr_child_writer_queued(w);
  if (w->off > 0 && w->cap - w->len < len) {
    memmove(w->buf, w->buf + w->off, queued);
    w->off = 0;
    w->len = queued;
  }
  if (w->cap - w->len < len) {
    size_t cap = w->cap ? w->cap : 16384;
    while (cap - w->len < len) {
      if (cap > SIZE_MAX / 2) scr_child_oom();
      cap *= 2;
    }
    uint8_t *grown = realloc(w->buf, cap);
    if (!grown) scr_child_oom();
    w->buf = grown;
    w->cap = cap;
  }
  memcpy(w->buf + w->len, data, len);
  w->len += len;
}

/* A pipe write must return EPIPE to the stream instead of terminating the
 * process with SIGPIPE. Block it only around this call and consume only a
 * signal generated by this write, preserving an already-pending signal. */
static ssize_t scr_child_writer_write_once(int fd, const void *data, size_t len) {
#ifdef SIGPIPE
  sigset_t set, old, pending;
  sigemptyset(&set);
  sigaddset(&set, SIGPIPE);
  if (pthread_sigmask(SIG_BLOCK, &set, &old) == 0) {
    bool known = sigpending(&pending) == 0;
    bool had = known && sigismember(&pending, SIGPIPE) == 1;
    ssize_t n = write(fd, data, len);
    int write_errno = errno;
    if (n < 0 && write_errno == EPIPE && known && !had &&
        sigpending(&pending) == 0 && sigismember(&pending, SIGPIPE) == 1) {
      int caught = 0;
      int wait_err;
      do {
        wait_err = sigwait(&set, &caught);
      } while (wait_err == EINTR);
    }
    (void)pthread_sigmask(SIG_SETMASK, &old, NULL);
    errno = write_errno;
    return n;
  }
#endif
  return write(fd, data, len);
}

static void scr_child_writer_fail(ScrChildWriter *w, const char *message,
                                  const char *code) {
  if (w->error_pending || (w->err_msg != NULL && w->destroyed)) return;
  scr_child_writer_close(w);
  scr_child_writer_clear_queue(w);
  w->ending = false;
  w->destroyed = true;
  w->need_drain = false;
  w->drain_pending = false;
  w->finish_pending = false;
  scr_str_release(w->err_msg);
  w->err_msg = scr_str_new(message, strlen(message));
  w->err_code = code;
  w->error_pending = true;
}

static void scr_child_writer_complete(ScrChildWriter *w) {
  scr_child_writer_close(w);
  w->ending = false;
  w->finish_pending = true;
}

static void scr_child_writer_pump(ScrChildWriter *w) {
  while (w->fd >= 0 && scr_child_writer_queued(w) > 0) {
    ssize_t n = scr_child_writer_write_once(
        w->fd, w->buf + w->off, scr_child_writer_queued(w));
    if (n > 0) {
      w->off += (size_t)n;
      continue;
    }
    if (n < 0 && errno == EINTR) continue;
    if (n < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) {
      /* Bytes stay queued: wake on the pipe's writability, not on the
       * loop's polling cap. */
      scr_child_writer_arm(w);
      return;
    }
    if (n < 0 && errno == EPIPE) {
      scr_child_writer_fail(w, "write EPIPE", "EPIPE");
    } else {
      scr_child_writer_fail(w, "write EIO", "EIO");
    }
    return;
  }
  scr_child_writer_dearm(w);
  if (scr_child_writer_queued(w) == 0) {
    w->off = w->len = 0;
    if (w->need_drain) {
      w->need_drain = false;
      w->drain_pending = true;
    }
    if (w->ending) scr_child_writer_complete(w);
  }
}

static bool scr_child_writer_write(ScrChildWriter *w, const void *data,
                                   size_t len) {
  scr_als_ctx_release(w->als);
  w->als = scr_als_capture();
  if (!w->writable) {
    scr_child_writer_fail(w, "write after end", "ERR_STREAM_WRITE_AFTER_END");
    return false;
  }
  scr_child_writer_append(w, data, len);
#ifdef __APPLE__
  /* libuv does not partially try-write an oversized Darwin pipe chunk,
   * so Node decides backpressure from the queued chunk before submitting
   * it. The kernel write below is more eager; preserve Node's decision. */
  bool ok = scr_child_writer_queued(w) <= SCR_CHILD_WRITER_HWM;
  if (!ok) w->need_drain = true;
#endif
  scr_child_writer_pump(w);
  if (w->error_pending) return false;
#ifndef __APPLE__
  bool ok = scr_child_writer_queued(w) < SCR_CHILD_WRITER_HWM;
  if (!ok) w->need_drain = true;
#endif
  return ok;
}

bool scr_child_writer_write_string(ScrChildWriter *w, const ScrStr *data) {
  SCR_IF_ISLAND(w, return scr_child_island_ops->write(w->island, data, NULL));
  char *owned;
  const char *bytes = scr_str_utf8(data, &owned);
  bool r = scr_child_writer_write(w, bytes, data->len);
  scr_str_utf8_end(owned);
  return r;
}

bool scr_child_writer_write_bytes(ScrChildWriter *w, const ScrBytes *data) {
  SCR_IF_ISLAND(w, return scr_child_island_ops->write(w->island, NULL, data));
  SCR_BYTES_SNAPSHOT(data);
  return scr_child_writer_write(w, data->data, data->len);
}

void scr_child_writer_end(ScrChildWriter *w) {
  SCR_IF_ISLAND(w, scr_child_island_ops->call(w->island, "end"); return);
  if (w->ending || w->finish_pending || w->finished || w->destroyed) return;
  scr_als_ctx_release(w->end_als);
  w->end_als = scr_als_capture();
  w->writable = false;
  w->ending = true;
  scr_child_writer_pump(w);
}

void scr_child_writer_destroy(ScrChildWriter *w) {
  SCR_IF_ISLAND(w, scr_child_island_ops->call(w->island, "destroy"); return);
  if (w->finished || (w->destroyed && !w->error_pending)) return;
  scr_child_writer_close(w);
  scr_child_writer_clear_queue(w);
  w->ending = false;
  w->destroyed = true;
  w->need_drain = false;
  w->drain_pending = false;
  w->finish_pending = false;
  w->error_pending = false;
  scr_str_release(w->err_msg);
  w->err_msg = NULL;
  scr_child_writer_drop_listeners(w);
}

bool scr_child_writer_writable(ScrChildWriter *w) {
  SCR_IF_ISLAND(w, return scr_child_island_ops->boolean(w->island, SCR_CHILD_PROP_WRITABLE));
  return w->writable;
}

static void scr_child_writer_add_zero(ScrChildStreamEndL **ls, size_t *n,
                                      size_t *cap, ScrClosure *cb, bool once) {
  if (*n == *cap) {
    *cap = *cap ? *cap * 2 : 2;
    *ls = realloc(*ls, *cap * sizeof **ls);
    if (!*ls) scr_child_oom();
  }
  (*ls)[*n] = (ScrChildStreamEndL){cb, once};
  (*n)++;
}

void scr_child_writer_on_drain(ScrChildWriter *w, ScrClosure *cb /*moves*/,
                               bool once) {
  SCR_IF_ISLAND(w, scr_child_island_ops->on(w->island, SCR_CHILD_EV_DRAIN, cb, NULL, once); return);
  if (w->finished || (w->destroyed && !w->drain_pending)) {
    scr_closure_release(cb);
    return;
  }
  scr_child_writer_add_zero(&w->drain_ls, &w->n_drain, &w->cap_drain, cb, once);
}

void scr_child_writer_on_finish(ScrChildWriter *w, ScrClosure *cb /*moves*/,
                                bool once) {
  SCR_IF_ISLAND(w, scr_child_island_ops->on(w->island, SCR_CHILD_EV_FINISH, cb, NULL, once); return);
  if (w->finished || (w->destroyed && !w->finish_pending)) {
    scr_closure_release(cb);
    return;
  }
  scr_child_writer_add_zero(&w->finish_ls, &w->n_finish, &w->cap_finish, cb, once);
}

void scr_child_writer_on_error(ScrChildWriter *w, ScrClosure *cb /*moves*/,
                               ScrChildErrFn fn, bool once) {
  SCR_IF_ISLAND(w, scr_child_island_ops->on(w->island, SCR_CHILD_EV_WRITE_ERROR, cb, (void *)fn, once);
                return);
  (void)once; /* a writer emits at most one terminal error */
  if ((w->destroyed && !w->finished && !w->error_pending) ||
      (w->err_msg != NULL && !w->error_pending)) {
    scr_closure_release(cb);
    return;
  }
  if (w->n_write_err == w->cap_write_err) {
    w->cap_write_err = w->cap_write_err ? w->cap_write_err * 2 : 2;
    w->err_ls = realloc(w->err_ls, w->cap_write_err * sizeof *w->err_ls);
    if (!w->err_ls) scr_child_oom();
  }
  w->err_ls[w->n_write_err++] = (ScrChildErrEntry){cb, fn};
}

static void scr_child_writer_fire_drain_in(ScrChildWriter *w);

/* 'drain' runs in the latest write() call's context. */
static void scr_child_writer_fire_drain(ScrChildWriter *w) {
  ScrAlsCtx *prev = scr_als_dispatch_enter(w->als);
  scr_child_writer_fire_drain_in(w);
  scr_als_dispatch_leave(prev);
}

static void scr_child_writer_fire_drain_in(ScrChildWriter *w) {
  w->drain_pending = false;
  size_t n = w->n_drain;
  if (n == 0) return;
  ScrChildStreamEndL *snap = malloc(n * sizeof *snap);
  if (!snap) scr_child_oom();
  for (size_t i = 0; i < n; i++) {
    snap[i] = w->drain_ls[i];
    scr_closure_retain(snap[i].cb);
  }
  for (size_t i = 0; i < n; i++) {
    if (snap[i].once) {
      for (size_t j = 0; j < w->n_drain; j++) {
        if (w->drain_ls[j].cb != snap[i].cb) continue;
        scr_closure_release(w->drain_ls[j].cb);
        memmove(w->drain_ls + j, w->drain_ls + j + 1,
                (w->n_drain - j - 1) * sizeof *w->drain_ls);
        w->n_drain--;
        break;
      }
    }
    if (!scr_exc_pending()) ((void (*)(ScrClosure *))snap[i].cb->fn)(snap[i].cb);
    scr_closure_release(snap[i].cb);
  }
  free(snap);
}

static void scr_child_writer_fire_finish_in(ScrChildWriter *w);

/* 'finish' runs in the end() call's context. */
static void scr_child_writer_fire_finish(ScrChildWriter *w) {
  ScrAlsCtx *prev = scr_als_dispatch_enter(w->end_als);
  scr_child_writer_fire_finish_in(w);
  scr_als_dispatch_leave(prev);
}

static void scr_child_writer_fire_finish_in(ScrChildWriter *w) {
  w->finish_pending = false;
  w->finished = true;
  w->destroyed = true;
  size_t n = w->n_finish;
  ScrChildStreamEndL *snap = n ? malloc(n * sizeof *snap) : NULL;
  if (n && !snap) scr_child_oom();
  for (size_t i = 0; i < n; i++) {
    snap[i] = w->finish_ls[i];
    scr_closure_retain(snap[i].cb);
  }
  for (size_t i = 0; i < n; i++) {
    if (!scr_exc_pending()) ((void (*)(ScrClosure *))snap[i].cb->fn)(snap[i].cb);
    scr_closure_release(snap[i].cb);
  }
  free(snap);
  scr_child_writer_drop_zero_listeners(w);
}

static void scr_child_writer_fire_error_in(ScrChildWriter *w);

/* 'error' runs in the latest write() call's context. */
static void scr_child_writer_fire_error(ScrChildWriter *w) {
  ScrAlsCtx *prev = scr_als_dispatch_enter(w->als);
  scr_child_writer_fire_error_in(w);
  scr_als_dispatch_leave(prev);
}

static void scr_child_writer_fire_error_in(ScrChildWriter *w) {
  w->error_pending = false;
  if (w->n_write_err == 0) {
    scr_stdout_settle();
    fflush(stdout);
    fprintf(stderr, "Unhandled 'error' event: Error: %s\n", w->err_msg->data);
    _Exit(1);
  }
  size_t n = w->n_write_err;
  ScrChildErrEntry *snap = malloc(n * sizeof *snap);
  if (!snap) scr_child_oom();
  for (size_t i = 0; i < n; i++) {
    snap[i] = w->err_ls[i];
    scr_closure_retain(snap[i].cb);
  }
  scr_child_writer_err_code = w->err_code;
  for (size_t i = 0; i < n; i++) {
    if (!scr_exc_pending()) snap[i].fn(snap[i].cb, w->err_msg);
    scr_closure_release(snap[i].cb);
  }
  scr_child_writer_err_code = NULL;
  free(snap);
  scr_child_writer_drop_listeners(w);
}

static bool scr_child_writer_pending(const ScrChildWriter *w) {
  return scr_child_writer_queued(w) > 0 || w->drain_pending ||
         w->finish_pending || w->error_pending;
}

/* Every queued byte reached the pipe; only listener events may remain. */
static bool scr_child_writer_flushed(const ScrChildWriter *w) {
  return scr_child_writer_queued(w) == 0 && !w->error_pending;
}

static bool scr_child_writers_pending(void) {
  for (ScrChildWriter *w = scr_child_writers; w; w = w->next) {
    if (scr_child_writer_pending(w)) return true;
  }
  return false;
}

/* Bytes queued for a pipe with no wake filter: only the loop's polling
 * cap can move them, so the quiescent sleep must keep the cap. */
static bool scr_child_writers_blocked(void) {
  for (ScrChildWriter *w = scr_child_writers; w; w = w->next) {
    if (scr_child_writer_queued(w) > 0 && !w->armed) return true;
  }
  return false;
}

/* Writer work the loop can dispatch right now: nothing left queued for
 * the pipe, a listener event waiting ('drain', 'finish', or the 'error' a
 * failed write left pending). No fd wakes the loop for it — without this
 * each one costs a polling-cap sleep. */
static bool scr_child_writers_ready(void) {
  for (ScrChildWriter *w = scr_child_writers; w; w = w->next) {
    if (scr_child_writer_queued(w) == 0 &&
        (w->drain_pending || w->finish_pending || w->error_pending))
      return true;
  }
  return false;
}

static void scr_child_writers_service(void) {
  ScrChildWriter **link = &scr_child_writers;
  while (*link) {
    ScrChildWriter *w = *link;
    if (!w->destroyed && !w->finished) scr_child_writer_pump(w);
    if (w->error_pending) scr_child_writer_fire_error(w);
    if (!scr_exc_pending() && w->drain_pending) scr_child_writer_fire_drain(w);
    if (!scr_exc_pending() && w->finish_pending) scr_child_writer_fire_finish(w);
    bool done = (w->finished || w->destroyed) && !w->error_pending;
    if (done) {
      *link = w->next;
      w->next = NULL;
      scr_child_writer_release(w); /* the registry's reference */
    } else {
      link = &w->next;
    }
    if (scr_exc_pending()) return;
  }
}

static void scr_child_writer_child_settled(ScrChildWriter *w) {
  if (!w || w->finished || w->finish_pending || w->destroyed) return;
  if (scr_child_writer_queued(w) > 0 || w->ending) {
    scr_child_writer_fail(w, "write EPIPE", "EPIPE");
  } else {
    scr_child_writer_destroy(w);
  }
}

ScrChildWriter *scr_child_stdin(ScrChild *c) {
  SCR_IF_ISLAND(c, scr_child_island_ops->stdio(c));
  return c->in_stream ? scr_child_writer_retain(c->in_stream) : NULL;
}

ScrChild *scr_spawn(ScrStr *cmd, ScrArr *args) {
  return scr_spawn_opts(cmd, args, 0, 0, 0, 0, 0, false, false, false, NULL, NULL);
}

/* Node's normalizeSpawnArguments result, kept for ChildProcess.spawnfile
 * and spawnargs. A direct spawn reports the command and its arguments. The
 * shell form joins the command and arguments into one command line and
 * reports "/bin/sh" with -c and the line. */
static void scr_child_record_spawn(ScrChild *c, ScrStr *cmd, ScrArr *args, bool shell) {
  size_t n = (size_t)scr_arr_len(args);
  ScrArr *spawnargs = scr_arr_new(SCR_ELEM_STR, n + 1);
  if (shell) {
    ScrStr **parts = malloc((1 + 2 * n) * sizeof *parts);
    ScrStr *space = scr_str_new(" ", 1);
    if (!parts) scr_child_oom();
    parts[0] = cmd;
    for (size_t i = 0; i < n; i++) {
      parts[1 + 2 * i] = space;
      parts[2 + 2 * i] = scr_arr_get_ref(args, (double)i);
    }
    ScrStr *command = scr_str_concat_parts(parts, 1 + 2 * n);
    for (size_t i = 0; i < n; i++) scr_str_release(parts[2 + 2 * i]);
    scr_str_release(space);
    free(parts);
    c->spawnfile = scr_str_new("/bin/sh", 7);
    scr_arr_push_ref(spawnargs, scr_str_retain(c->spawnfile));
    scr_arr_push_ref(spawnargs, scr_str_new("-c", 2));
    scr_arr_push_ref(spawnargs, command);
  } else {
    c->spawnfile = scr_str_retain(cmd);
    scr_arr_push_ref(spawnargs, scr_str_retain(cmd));
    for (size_t i = 0; i < n; i++) scr_arr_push_ref(spawnargs, scr_arr_get_ref(args, (double)i));
  }
  c->spawnargs = spawnargs;
}

/* The options core behind cp.spawn/cp.spawnOpts. PER-SLOT stdio modes:
 * 0 = ignore (/dev/null), 1 = inherit (the parent's fd), 2 = fd (out/err
 * only — out_fd/err_fd dup2 into the child's slot, Node's stdio fd form:
 * the daemon-log idiom ["ignore", logFd, logFd]), 3 = pipe (fd 0's write
 * end becomes child.stdin; fd 1/2 read ends become child.stdout/stderr).
 * detached gives the
 * child its own session (POSIX_SPAWN_SETSID → setsid(2), the libuv
 * implementation of Node's flag). env_pairs, when has_env, REPLACES the
 * child environment ([k,v,...] like the exec core's); cwd (NULL/"" =
 * inherit) chdirs the child. Spawn failure stays an event, never a
 * throw. */
ScrChild *scr_spawn_opts(ScrStr *cmd, ScrArr *args, double in_mode,
                          double out_mode, double err_mode, double out_fd,
                          double err_fd, bool detached, bool shell, bool has_env,
                          ScrArr *env_pairs, ScrStr *cwd) {
  if ((int)out_mode == 1 || (int)err_mode == 1 || (int)out_mode == 2 || (int)err_mode == 2) {
    /* Inherited or fd-redirected stdio: flush the parent's buffered
     * output first so everything logged BEFORE the spawn lands before
     * anything the child writes to the same destinations (Node's
     * practical ordering). */
    scr_stdout_settle();
    fflush(stdout);
    fflush(stderr);
  }
  ScrChild *c = calloc(1, sizeof(ScrChild));
  if (!c) scr_child_oom();
  c->rc = 1;
  c->als = scr_als_capture();
  scr_child_record_spawn(c, cmd, args, shell);

  /* Piped slots: pipe(2) NOW, both ends cloexec (the file action's dup2
   * clears the flag on the child's copy — every other descriptor closes
   * at exec). A pipe failure degrades the slot to /dev/null — nothing
   * real hits it (fd exhaustion), and the stream husk answers eof. */
  int in_pipe[2] = {-1, -1};
  int out_pipe[2] = {-1, -1};
  int err_pipe[2] = {-1, -1};
  if ((int)in_mode == 3 && pipe(in_pipe) != 0) {
    in_pipe[0] = in_pipe[1] = -1;
    in_mode = 0;
  }
  if ((int)out_mode == 3 && pipe(out_pipe) != 0) {
    out_pipe[0] = out_pipe[1] = -1;
    out_mode = 0;
  }
  if ((int)err_mode == 3 && pipe(err_pipe) != 0) {
    err_pipe[0] = err_pipe[1] = -1;
    err_mode = 0;
  }
  for (int i = 0; i < 2; i++) {
    if (in_pipe[i] >= 0) fcntl(in_pipe[i], F_SETFD, FD_CLOEXEC);
    if (out_pipe[i] >= 0) fcntl(out_pipe[i], F_SETFD, FD_CLOEXEC);
    if (err_pipe[i] >= 0) fcntl(err_pipe[i], F_SETFD, FD_CLOEXEC);
  }

  posix_spawn_file_actions_t fa;
  posix_spawn_file_actions_init(&fa);
  if ((int)in_mode == 0) {
    posix_spawn_file_actions_addopen(&fa, 0, "/dev/null", O_RDONLY, 0);
  } else if ((int)in_mode == 3) {
    posix_spawn_file_actions_adddup2(&fa, in_pipe[0], 0);
  } /* 1 = inherit: no redirection */
  if ((int)out_mode == 0) {
    posix_spawn_file_actions_addopen(&fa, 1, "/dev/null", O_WRONLY, 0);
  } else if ((int)out_mode == 2) {
    posix_spawn_file_actions_adddup2(&fa, (int)out_fd, 1);
  } else if ((int)out_mode == 3) {
    posix_spawn_file_actions_adddup2(&fa, out_pipe[1], 1);
  }
  if ((int)err_mode == 0) {
    posix_spawn_file_actions_addopen(&fa, 2, "/dev/null", O_WRONLY, 0);
  } else if ((int)err_mode == 2) {
    posix_spawn_file_actions_adddup2(&fa, (int)err_fd, 2);
  } else if ((int)err_mode == 3) {
    posix_spawn_file_actions_adddup2(&fa, err_pipe[1], 2);
  }
#if defined(__APPLE__) || defined(__GLIBC__) || defined(SCR_MUSL)
  if (cwd != NULL && cwd->len > 0) {
    posix_spawn_file_actions_addchdir_np(&fa, cwd->data);
  }
#endif
  posix_spawnattr_t at;
  posix_spawnattr_init(&at);
#ifdef POSIX_SPAWN_SETSID
  if (detached) posix_spawnattr_setflags(&at, POSIX_SPAWN_SETSID);
#else
  (void)detached; /* hosts without the flag: the child stays attached */
#endif
  char *shell_argv[] = {(char *)"/bin/sh", (char *)"-c", cmd->data, NULL};
  char **argv = shell ? shell_argv : scr_child_argv(cmd, args);
  char **envp = has_env && env_pairs != NULL ? scr_exec_envp(env_pairs) : NULL;
  pid_t pid = -1;
  const char *file = shell ? "/bin/sh" : cmd->data;
  int spawn_err = scr_spawn_command(&pid, file, &fa, &at, argv, envp,
                                    cwd != NULL && cwd->len > 0 ? cwd->data : NULL);
  posix_spawnattr_destroy(&at);
  posix_spawn_file_actions_destroy(&fa);
  if (!shell) free(argv);
  scr_exec_envp_free(envp);

  /* Parent keeps only its side of each pipe. A failed spawn still exposes
   * the stream husks until the deferred child error settles them. */
  if (in_pipe[0] >= 0) close(in_pipe[0]);
  if (out_pipe[1] >= 0) close(out_pipe[1]);
  if (err_pipe[1] >= 0) close(err_pipe[1]);
  if ((int)in_mode == 3) c->in_stream = scr_child_writer_new(in_pipe[1]);
  if ((int)out_mode == 3) c->out_stream = scr_child_stream_new(out_pipe[0]);
  if ((int)err_mode == 3) c->err_stream = scr_child_stream_new(err_pipe[0]);

  if (spawn_err != 0) {
    /* Node: `Error: spawn <cmd> <ERRNAME>` on the "error" event. */
    const char *name = scr_errname(spawn_err);
    size_t len = 6 + cmd->len + 1 + strlen(name);
    char *msg = malloc(len + 1);
    if (!msg) scr_child_oom();
    snprintf(msg, len + 1, "spawn %s %s", cmd->data, name);
    c->state = SCR_CHILD_SPAWN_FAILED;
    c->spawn_errno = spawn_err;
    c->err_msg = scr_str_new(msg, len);
    free(msg);
    /* Settles at the next quiescent pass; no exit event will ever wake the
     * loop for it, so it counts as unwatched until then. */
    c->unwatched = true;
    scr_children_unwatched++;
  } else {
    c->state = SCR_CHILD_RUNNING;
    c->pid = pid;
#if defined(SCR_HAVE_KQUEUE) || defined(SCR_CHILD_HAVE_PIDFD)
    c->unwatched = !scr_child_watch(pid);
#else
    c->unwatched = true;
#endif
    if (c->unwatched) scr_children_unwatched++;
  }
  /* The registry's reference: dropped when the child settles. The registry
   * is in spawn order: a pass fires 'spawn', and the 'exit' of children it
   * reaps together, oldest child first, as Node does (libuv's exit pass
   * walks its process queue in spawn order, uv__wait_children). */
  c->reffed = true;
  scr_children_reffed_n++;
  ScrChild **tail = &scr_children;
  while (*tail) tail = &(*tail)->next;
  *tail = scr_child_retain(c);
  scr_child_loop_install();
  return c;
}

ScrChild *scr_fork(double target, ScrArr *args, double in_mode,
                   double out_mode, double err_mode, bool has_env,
                   ScrArr *env_pairs, ScrStr *cwd) {
  int parent_to_child[2] = {-1, -1};
  int child_to_parent[2] = {-1, -1};
  if (pipe(parent_to_child) != 0 || pipe(child_to_parent) != 0) {
    if (parent_to_child[0] >= 0) close(parent_to_child[0]);
    if (parent_to_child[1] >= 0) close(parent_to_child[1]);
    if (child_to_parent[0] >= 0) close(child_to_parent[0]);
    if (child_to_parent[1] >= 0) close(child_to_parent[1]);
    scr_trap("could not create fork IPC channel");
  }
  fcntl(parent_to_child[1], F_SETFD, FD_CLOEXEC);
  fcntl(child_to_parent[0], F_SETFD, FD_CLOEXEC);
  fcntl(parent_to_child[0], F_SETFD, 0);
  fcntl(child_to_parent[1], F_SETFD, 0);

  ScrArr *spawn_args = scr_fork_argv(
      target, (uintptr_t)parent_to_child[0],
      (uintptr_t)child_to_parent[1], args);
  ScrStr *command = scr_process_exec_path();
  ScrChild *child = scr_spawn_opts(
      command, spawn_args, in_mode, out_mode, err_mode, 0, 0, false,
      false, has_env, env_pairs, cwd);
  scr_str_release(command);
  scr_arr_release(spawn_args);
  close(parent_to_child[0]);
  close(child_to_parent[1]);
  if (child->state == SCR_CHILD_RUNNING) {
    ScrChildStream *reader = scr_child_stream_new(child_to_parent[0]);
#ifdef SCR_HAVE_KQUEUE
    /* libuv's kqueue backend reports no hangup with a read event, so a
     * short read ends Node's read callback and the EOF behind it waits
     * for the next loop iteration, after that iteration reaps the
     * child. A child that writes its last message, closes the channel,
     * and exits therefore reaches 'exit' before 'disconnect'. */
    reader->short_read_yields = true;
#endif
    child->ipc = scr_ipc_new(reader, scr_child_writer_new(parent_to_child[1]));
  } else {
    close(child_to_parent[0]);
    close(parent_to_child[1]);
  }
  return child;
}

/* Node's properties on the callback form's error. Reached only through
 * the hook scr_exec_file installs, so programs without the callback form
 * link none of the property code (the settle path is shared by every
 * child). */
static void scr_exec_file_error_props(ScrChild *c, ScrError *error) {
  if (c->state == SCR_CHILD_SPAWN_FAILED) {
    scr_child_error_spawn_fields(error, -(double)c->spawn_errno, "spawn", c->exec_file, c->exec_args);
  } else {
    scr_child_error_exit_fields(error, c->has_code, c->code, c->exit_signal, c->killed);
  }
  scr_child_error_cmd(error, c->exec_display->data);
}

static ScrError *scr_exec_file_error(ScrChild *c, ScrStr *stderr_value) {
  if (c->state == SCR_CHILD_SPAWN_FAILED) {
    ScrError *error = scr_error_new(0, c->err_msg);
    scr_error_set_code(error, scr_errname(c->spawn_errno));
    if (c->exec_props) c->exec_props(c, error);
    return error;
  }
  if (c->has_code && c->code == 0) return NULL;
  size_t cap = 16 + c->exec_display->len + 1 + stderr_value->len + 1;
  char *msg = malloc(cap);
  if (!msg) scr_child_oom();
  size_t at = (size_t)snprintf(msg, cap, "Command failed: %s", c->exec_display->data);
  msg[at++] = '\n';
  memcpy(msg + at, stderr_value->data, stderr_value->len);
  at += stderr_value->len;
  ScrStr *message = scr_str_new(msg, at);
  free(msg);
  ScrError *error = scr_error_new(0, message);
  scr_str_release(message);
  if (c->exec_props) c->exec_props(c, error);
  return error;
}

static void scr_exec_file_fire(ScrChild *c) {
  if (c->exec_cb == NULL || c->exec_fn == NULL) return;
  ScrStr *out = scr_child_stream_capture_value(c->out_stream);
  ScrStr *err = scr_child_stream_capture_value(c->err_stream);
  ScrError *error = scr_exec_file_error(c, err);
  c->exec_fn(c->exec_cb, error, out, err); /* error/out/err move */
}

ScrChild *scr_exec_file(ScrStr *cmd, ScrArr *args, ScrClosure *cb,
                        ScrExecFileFn fn, bool shell) {
  ScrStr *empty = scr_str_new("", 0);
  ScrChild *c = scr_spawn_opts(cmd, args, 3, 3, 3, 0, 0, false, false, false,
                               NULL, empty);
  scr_str_release(empty);
  c->exec_cb = cb;
  c->exec_fn = fn;
  c->exec_file = scr_str_retain(cmd);
  c->exec_args = scr_arr_retain(args);
  c->exec_props = &scr_exec_file_error_props;
  char *display = scr_exec_display(cmd, args, shell);
  c->exec_display = scr_str_new(display, strlen(display));
  free(display);
  scr_child_stream_capture_begin(c->out_stream);
  scr_child_stream_capture_begin(c->err_stream);
  scr_exec_limit_install(c);
  return c;
}

/* ── the lifecycle members (child.pid/exitCode/killed/kill/unref) ──────── */

/* child.pid — undefined exactly when the spawn failed (Node's shape). */
bool scr_child_has_pid(ScrChild *c) {
  SCR_IF_ISLAND(c, double pid; return scr_child_island_ops->number(c->island, SCR_CHILD_PROP_PID, &pid));
  return c->state != SCR_CHILD_SPAWN_FAILED;
}
double scr_child_pid(ScrChild *c) {
  SCR_IF_ISLAND(c, double pid = 0; scr_child_island_ops->number(c->island, SCR_CHILD_PROP_PID, &pid);
                return pid);
  return (double)c->pid;
}

/* child.exitCode — null while running and for a signal death; the exit
 * code after a normal exit; -errno once a spawn failure SETTLED (Node
 * flips it when the "error" event fires — before that it reads null). */
bool scr_child_has_exit_code(ScrChild *c) {
  SCR_IF_ISLAND(c, double code;
                return scr_child_island_ops->number(c->island, SCR_CHILD_PROP_EXIT_CODE, &code));
  if (c->state == SCR_CHILD_EXITED) return c->has_code;
  return c->state == SCR_CHILD_SPAWN_FAILED && c->settled;
}
double scr_child_exit_code(ScrChild *c) {
  SCR_IF_ISLAND(c, double code = 0; scr_child_island_ops->number(c->island, SCR_CHILD_PROP_EXIT_CODE, &code);
                return code);
  if (c->state == SCR_CHILD_SPAWN_FAILED) return -(double)c->spawn_errno;
  return c->code;
}

bool scr_child_killed(ScrChild *c) {
  SCR_IF_ISLAND(c, return scr_child_island_ops->boolean(c->island, SCR_CHILD_PROP_KILLED));
  return c->killed;
}

ScrStr *scr_child_spawnfile(ScrChild *c) {
  SCR_IF_ISLAND(c, ScrStr *file = scr_child_island_ops->string(c->island, SCR_CHILD_PROP_SPAWNFILE);
                return file ? file : scr_str_new("", 0));
  return c->spawnfile ? scr_str_retain(c->spawnfile) : scr_str_new("", 0);
}
ScrArr *scr_child_spawnargs(ScrChild *c) {
  SCR_IF_ISLAND(c, return scr_child_island_ops->spawnargs(c->island));
  return c->spawnargs ? scr_arr_retain(c->spawnargs) : scr_arr_new(SCR_ELEM_STR, 0);
}

/* child.kill core, numeric signal already resolved: kill(2) while the
 * handle is live (spawned, not yet reaped — a zombie counts, exactly
 * Node's window, which closes when 'exit' is emitted), false after the
 * reap or on spawn failure (Node's null-handle answer). A kill(2) failure
 * answers false too — Node also emits 'error' there, but for a child WE
 * spawned ESRCH can't happen before the reap and EPERM can't happen at
 * all, so the event is unreachable and stays unwired. Node sets `killed`
 * on ANY successful send, signal 0 included (pinned against Node). */
static bool scr_child_kill_signo(ScrChild *c, int signo) {
  if (c->state != SCR_CHILD_RUNNING) return false;
  if (kill(c->pid, signo) != 0) return false;
  c->killed = true;
  return true;
}

/* child.kill(name?) — the name resolves through Node's signal table
 * (scr_signal_from_name; unknown names throw the ERR_UNKNOWN_SIGNAL
 * TypeError BEFORE the handle check, like Node). */
bool scr_child_kill(ScrChild *c, const ScrStr *signal) {
  SCR_IF_ISLAND(c, return scr_child_island_ops->kill(c->island, signal, 0));
  int signo = scr_signal_from_name(signal);
  if (signo < 0) {
    size_t cap = 16 + signal->len + 1;
    char *msg = malloc(cap);
    if (!msg) scr_child_oom();
    int len = snprintf(msg, cap, "Unknown signal: %s", signal->data);
    scr_throw_error_msg_code(SCR_ERR_TYPE, msg, (size_t)len, "ERR_UNKNOWN_SIGNAL");
    free(msg);
    return false;
  }
  return scr_child_kill_signo(c, signo);
}

/* child.kill(number) — the numeric form passes through (0 probes). */
bool scr_child_kill_num(ScrChild *c, double signum) {
  SCR_IF_ISLAND(c, return scr_child_island_ops->kill(c->island, NULL, signum));
  return scr_child_kill_signo(c, (int)signum);
}

/* child.unref() — drops the child from the loop's keep-alive set (Node's
 * semantics: the process may exit while the child runs). The child is
 * still REAPED whenever the loop runs for other reasons; one the loop
 * never reaps is left to the OS at process exit (init reparents it — no
 * zombie outlives the parent). */
void scr_child_unref(ScrChild *c) {
  SCR_IF_ISLAND(c, scr_child_island_ops->call(c->island, "unref"); return);
  if (c->reffed) {
    c->reffed = false;
    scr_children_reffed_n--; /* settle/teardown clear reffed first */
  }
}

/* The loop's liveness half: true while some UNSETTLED, REFFED child
 * exists (unref'd children never keep the process alive), or a piped
 * stream still flows for a consumer (Node's flowing-pipe keep-alive —
 * it may outlive the child's own settle when a grandchild holds the
 * write end). */
bool scr_children_reffed_pending(void) {
  return scr_children_reffed_n > 0 || scr_child_streams_watching > 0 ||
         scr_child_writers_pending() || scr_ipc_pending();
}

/* Loop-exhaustion teardown (the scr_timers_teardown twin): the loop may
 * exit with unref'd children still running — release the registry's
 * references (listeners never fire; Node's process-exit behavior) so the
 * RC audit stays clean. */
void scr_children_teardown(void) {
#ifdef SCR_CHILD_STREAM_FLOW
  scr_child_flow_teardown();
#endif
  /* Streams the loop abandons (a data consumer over a pipe whose child
   * was unref'd, exception exits): release the registry's references so
   * the RC audit stays clean; listeners never fire again. */
  while (scr_child_streams != NULL) {
    ScrChildStream *s = scr_child_streams;
    scr_child_streams = s->next;
    s->next = NULL;
    scr_child_stream_finish(s, false);
    scr_child_stream_release(s);
  }
  for (size_t i = 0; i < scr_child_arm_queue_n; i++) {
    scr_child_arm_queue[i]->arm_queued = false;
    scr_child_stream_release(scr_child_arm_queue[i]);
  }
  free(scr_child_arm_queue);
  scr_child_arm_queue = NULL;
  scr_child_arm_queue_n = scr_child_arm_queue_cap = 0;
  while (scr_child_writers != NULL) {
    ScrChildWriter *w = scr_child_writers;
    scr_child_writers = w->next;
    w->next = NULL;
    scr_child_writer_destroy(w);
    scr_child_writer_release(w);
  }
  while (scr_children_closing != NULL) {
    ScrChild *c = scr_children_closing;
    scr_children_closing = c->next;
    c->next = NULL;
    c->close_done = true;
    scr_child_drop_listeners(c);
    scr_child_release(c);
  }
  while (scr_children != NULL) {
    ScrChild *c = scr_children;
    scr_children = c->next;
    c->next = NULL;
    c->settled = true; /* late listener registrations release immediately */
    if (c->reffed) {
      c->reffed = false;
      scr_children_reffed_n--;
    }
    if (c->unwatched) {
      c->unwatched = false;
      scr_children_unwatched--;
    }
    scr_child_drop_listeners(c);
    scr_child_release(c);
  }
#ifdef SCR_WORKERS
  /* Watchers belong to the script context, which can end long before the
   * process. Release their OS handles and reusable pid index at loop exit. */
#ifdef SCR_HAVE_KQUEUE
  if (scr_child_kq >= 0) close(scr_child_kq);
  scr_child_kq = -1;
#endif
#ifdef SCR_CHILD_HAVE_PIDFD
  for (size_t i = 0; i < scr_child_pidfds_n; i++) close(scr_child_pidfds[i].pidfd);
  free(scr_child_pidfds);
  scr_child_pidfds = NULL;
  scr_child_pidfds_n = scr_child_pidfds_cap = 0;
  if (scr_child_ep >= 0) close(scr_child_ep);
  scr_child_ep = -1;
#endif
#endif
}

void scr_child_on_exit(ScrChild *c, ScrClosure *cb /*moves*/, ScrChildExitFn fn) {
  SCR_IF_ISLAND(c, scr_child_island_ops->on(c->island, SCR_CHILD_EV_EXIT, cb, (void *)fn, false); return);
  if (c->settled) {
    scr_closure_release(cb); /* after the terminal event: never fires */
    return;
  }
  if (c->n_exit == c->cap_exit) {
    c->cap_exit = c->cap_exit ? c->cap_exit * 2 : 2;
    c->exit_cbs = realloc(c->exit_cbs, c->cap_exit * sizeof(*c->exit_cbs));
    if (!c->exit_cbs) scr_child_oom();
  }
  c->exit_cbs[c->n_exit].cb = cb;
  c->exit_cbs[c->n_exit].fn = fn;
  c->n_exit++;
}

void scr_child_on_close(ScrChild *c, ScrClosure *cb /*moves*/, ScrChildExitFn fn) {
  SCR_IF_ISLAND(c, scr_child_island_ops->on(c->island, SCR_CHILD_EV_CLOSE, cb, (void *)fn, false); return);
  if (c->close_done) {
    scr_closure_release(cb);
    return;
  }
  if (c->n_close == c->cap_close) {
    c->cap_close = c->cap_close ? c->cap_close * 2 : 2;
    c->close_cbs = realloc(c->close_cbs, c->cap_close * sizeof *c->close_cbs);
    if (!c->close_cbs) scr_child_oom();
  }
  c->close_cbs[c->n_close++] = (ScrChildExitEntry){cb, fn};
  scr_child_stream_close_wait(c->out_stream);
  scr_child_stream_close_wait(c->err_stream);
}

/* A failed spawn's 'error' event carries Node's errnoException: one Error,
 * the same object for every listener, with errno, code, syscall
 * "spawn <file>", path and spawnargs (the arguments after the file), and a
 * message that names the file Node ran (the shell, for a shell spawn). The
 * settle path and the untyped handle table are linked by every program
 * that uses child_process, so they reach this only through the hook below.
 * A program that can register an 'error' listener installs it once at
 * start (scr_child_error_event_install, emitted for the childErrorEvent
 * program fact); every other program links none of the property code. +1.
 * The pointer has external linkage on purpose: a static one that the unit
 * stores once lets the compiler turn the settle path's call into a direct
 * reference to the builder, which links it into every program. */
ScrError *(*scr_child_spawn_error_hook)(ScrChild *c) = NULL;

static ScrError *scr_child_spawn_error(ScrChild *c) {
  const char *name = scr_errname(c->spawn_errno);
  size_t cap = 6 + c->spawnfile->len + 1 + strlen(name) + 1;
  char *text = malloc(cap);
  if (!text) scr_child_oom();
  int len = snprintf(text, cap, "spawn %s %s", c->spawnfile->data, name);
  ScrStr *message = scr_str_new(text, (size_t)len);
  free(text);
  ScrError *error = scr_error_new(SCR_ERR_ERROR, message);
  scr_str_release(message);
  scr_error_set_code(error, name);
  ScrArr *args = scr_arr_slice(c->spawnargs, 1, (double)scr_arr_len(c->spawnargs));
  scr_child_error_spawn_fields(error, -(double)c->spawn_errno, "spawn", c->spawnfile, args);
  scr_arr_release(args);
  return error;
}

void scr_child_error_event_install(void) { scr_child_spawn_error_hook = &scr_child_spawn_error; }

void scr_child_on_error(ScrChild *c, ScrClosure *cb /*moves*/, ScrChildErrFn fn) {
  SCR_IF_ISLAND(c, scr_child_island_ops->on(c->island, SCR_CHILD_EV_ERROR, cb, (void *)fn, false); return);
  if (c->settled) {
    scr_closure_release(cb);
    return;
  }
  if (c->n_err == c->cap_err) {
    c->cap_err = c->cap_err ? c->cap_err * 2 : 2;
    c->err_cbs = realloc(c->err_cbs, c->cap_err * sizeof(*c->err_cbs));
    if (!c->err_cbs) scr_child_oom();
  }
  c->err_cbs[c->n_err].cb = cb;
  c->err_cbs[c->n_err].fn = fn;
  c->n_err++;
}

/* ── the runtime-provided listener adapters ──────────────────────────── */

/* A zero-param exit listener: the code and signal are ignored. */
void scr_child_exit_thunk0(ScrClosure *cb, bool has_code, double code,
                            const char *signal_name) {
  (void)has_code;
  (void)code;
  (void)signal_name;
  ((void (*)(ScrClosure *))cb->fn)(cb);
}

/* A zero-param error listener: the message is ignored. */
void scr_child_err_thunk0(ScrClosure *cb, ScrStr *msg) {
  (void)msg;
  ((void (*)(ScrClosure *))cb->fn)(cb);
}

/* The errno name of the child whose error listeners are FIRING — set by
 * scr_child_settle around its error pass so the thunk below can stamp
 * Node's `code` on the constructed error (the thunk signature is shared
 * with scr_net.c's error events, which parse theirs out of the message
 * below). NULL outside a spawn-failure settle. */
static SCR_TL const char *scr_child_err_code = NULL;

/* [.code on event errors — net/http/dgram parity with spawn failures]
 * The message's code (scr_error_event_code: the errno name an
 * errnoException-style message embeds, or scr_error_message_code's
 * table). Fallback only: an explicit context wins. */
static const char *scr_err_msg_code(const ScrStr *msg) { return scr_error_event_code(msg); }

/* An (err: Error) listener: constructs the %Error instance from the
 * message (borrowed; scr_error_new retains its copy) — the listener owns
 * the +1 error param per the universal convention. `code` stamps from the
 * settle context (spawn failures) or the message's own embedded errno name
 * (net/http/dgram 'error' events — see scr_err_msg_code). */
void scr_child_err_thunk_error(ScrClosure *cb, ScrStr *msg) {
  if (scr_event_error_payload != NULL) {
    ((void (*)(ScrClosure *, ScrError *))cb->fn)(cb, scr_error_retain(scr_event_error_payload));
    return;
  }
  ScrError *e = scr_error_new(0 /* Error */, msg);
  if (scr_child_err_code != NULL) {
    scr_error_set_code(e, scr_child_err_code);
  } else if (scr_child_writer_err_code != NULL) {
    scr_error_set_code(e, scr_child_writer_err_code);
  } else {
    const char *code = scr_err_msg_code(msg);
    if (code != NULL) scr_error_set_code(e, code);
  }
  ((void (*)(ScrClosure *, ScrError *))cb->fn)(cb, e);
}

/* ── the loop's half (called from scr_async.c) ───────────────────────── */

bool scr_children_pending(void) {
  return scr_children != NULL || scr_children_closing != NULL ||
         scr_child_streams_watching > 0 ||
         scr_child_writers_pending() || scr_ipc_pending();
}

/* True while an UNSETTLED spawn failure sits in the registry: its 'error'
 * is a next-tick-shaped event Node delivers regardless of ref state (an
 * unref'd failed spawn still crashes an error-listener-less program), so
 * the loop's only-unref'd-children exit gate must not skip it. */
bool scr_children_failed_pending(void) {
  for (ScrChild *c = scr_children; c; c = c->next) {
    if ((c->state == SCR_CHILD_SPAWN_FAILED && !c->settled) ||
        (c->state == SCR_CHILD_RUNNING && !c->spawn_done)) return true;
  }
  return false;
}

/* True for an output pipe that ended in the pass that is running. */
static bool scr_child_stream_ended_now(const ScrChildStream *s) {
  return s != NULL && s->eof && s->eof_pass == scr_children_pass;
}

static bool scr_child_close_ready(const ScrChild *c) {
  return (c->out_stream == NULL || c->out_stream->eof) &&
         (c->err_stream == NULL || c->err_stream->eof) &&
         scr_ipc_close_ready(c->ipc);
}

static void scr_child_fire_close_in(ScrChild *c);

/* 'close' runs in the spawn() call's context. */
static void scr_child_fire_close(ScrChild *c) {
  ScrAlsCtx *prev = scr_als_dispatch_enter(c->als);
  scr_child_fire_close_in(c);
  scr_als_dispatch_leave(prev);
}

static void scr_child_fire_close_in(ScrChild *c) {
  c->close_done = true;
  bool has_code = c->state == SCR_CHILD_SPAWN_FAILED ? true : c->has_code;
  double code = c->state == SCR_CHILD_SPAWN_FAILED
      ? -(double)c->spawn_errno
      : c->code;
  /* Node counts the channel toward 'close' only through its EOF read; a
   * channel disconnected from this side never reports one, so 'close'
   * never fires. */
  size_t n = scr_ipc_close_dropped(c->ipc) ? 0 : c->n_close;
  for (size_t i = 0; i < n; i++) {
    c->close_cbs[i].fn(c->close_cbs[i].cb, has_code, code, c->exit_signal);
    if (scr_exc_pending()) break;
  }
  scr_child_drop_close_listeners(c);
  scr_child_release(c); /* the closing/settle registry's reference */
}

static void scr_children_closing_poll(void) {
  ScrChild **link = &scr_children_closing;
  while (*link) {
    ScrChild *c = *link;
    if (scr_child_close_ready(c)) {
      *link = c->next;
      c->next = NULL;
      scr_child_fire_close(c);
      if (scr_exc_pending()) return;
    } else {
      link = &c->next;
    }
  }
}

/* Fires one settled child's terminal event. The child is already off the
 * registry; drops the listeners and the registry's reference. The pinned
 * ordering runs first: consumer-owning piped streams drain to EOF/EAGAIN
 * so their 'end' events fire BEFORE 'exit' (Node-exact — verified: data*,
 * end, then exit for every output shape). */
static void scr_child_settle_in(ScrChild *c);

/* A child's terminal events run in its spawn() call's context. */
static void scr_child_settle(ScrChild *c) {
  ScrAlsCtx *prev = scr_als_dispatch_enter(c->als);
  scr_child_settle_in(c);
  scr_als_dispatch_leave(prev);
}

static void scr_child_settle_in(ScrChild *c) {
  if (c->reffed) {
    c->reffed = false;
    scr_children_reffed_n--;
  }
  if (c->unwatched) {
    c->unwatched = false;
    scr_children_unwatched--;
  }
  /* Streams first, settled after: an exit listener registered from a
   * draining 'data'/'end' callback still fires below, like Node's. The
   * SPAWN-FAILURE path skips the drain — Node fires 'error' first and
   * the streams' immediate EOF delivers 'end' on the next turn. A child
   * spawned during this pass can exit before the next pass fires 'spawn';
   * Node emits 'spawn' before any data or 'exit', so it fires here first. */
  if (c->state == SCR_CHILD_EXITED) {
    if (!c->spawn_done) scr_child_fire_spawn(c);
    if (!scr_exc_pending()) scr_child_streams_settle_order(c->out_stream, c->err_stream);
    if (!scr_exc_pending()) scr_child_stream_drain_now(c->out_stream);
    if (!scr_exc_pending()) scr_child_stream_drain_now(c->err_stream);
    if (!scr_exc_pending()) scr_ipc_settle(c->ipc);
  }
  if (!scr_exc_pending()) {
    scr_child_writer_child_settled(c->in_stream);
    scr_child_writers_service();
  }
  c->settled = true;
  if (scr_exc_pending()) {
    /* A data/end listener threw: the loop surfaces it (the exit event is
     * lost with the process, like Node's crash-on-uncaught). */
    scr_child_drop_listeners(c);
    scr_child_release(c);
    return;
  }
  if (c->state == SCR_CHILD_SPAWN_FAILED) {
    if (c->n_err == 0 && c->exec_cb == NULL) {
      /* Node: an 'error' event with no listener is an uncaught throw.
       * _Exit skips atexit handlers (the RC audit above all) on purpose —
       * the loop dies mid-turn with frames and registries still live,
       * exactly like process.exit(). */
      scr_stdout_settle();
      fflush(stdout);
      fprintf(stderr, "Unhandled 'error' event: Error: %s\n", c->err_msg->data);
      _Exit(1);
    }
    /* Node's spawn-failure error is an errnoException: `code` carries the
     * errno name. The thunk reads this while the pass runs. */
    scr_child_err_code = scr_errname(c->spawn_errno);
    /* With an 'error' listener the event carries Node's error object
     * (scr_child_spawn_error); the adapters hand out the payload. */
    ScrError *spawn_error =
        scr_child_spawn_error_hook != NULL && c->n_err > 0 ? scr_child_spawn_error_hook(c) : NULL;
    ScrError *outer_payload = scr_event_error_payload;
    if (spawn_error != NULL) scr_event_error_payload = spawn_error;
    for (size_t i = 0; i < c->n_err; i++) {
      c->err_cbs[i].fn(c->err_cbs[i].cb, c->err_msg);
      if (scr_exc_pending()) break; /* the loop surfaces it */
    }
    if (spawn_error != NULL) {
      scr_event_error_payload = outer_payload;
      scr_error_release(spawn_error);
    }
    scr_child_err_code = NULL;
    if (!scr_exc_pending()) scr_exec_file_fire(c);
  } else {
    for (size_t i = 0; i < c->n_exit; i++) {
      c->exit_cbs[i].fn(c->exit_cbs[i].cb, c->has_code, c->code, c->exit_signal);
      if (scr_exc_pending()) break;
    }
#ifdef SCR_CHILD_STREAM_FLOW
    if (!scr_exc_pending() && c->exec_cb != NULL) {
      scr_child_flow_exec_flush(c->out_stream);
      if (!scr_exc_pending()) scr_child_flow_exec_flush(c->err_stream);
    }
#endif
    if (!scr_exc_pending()) scr_exec_file_fire(c);
  }
#ifdef SCR_CHILD_STREAM_FLOW
  if (!scr_exc_pending() && c->state == SCR_CHILD_EXITED) {
    scr_child_flow_exit(c->out_stream);
    scr_child_flow_exit(c->err_stream);
  }
#endif
  scr_child_drop_terminal_listeners(c);
  if (c->n_close == 0) {
    c->close_done = true;
    scr_child_release(c); /* the settle registry's reference */
  } else if (scr_child_close_ready(c) && !scr_child_stream_ended_now(c->out_stream) &&
             !scr_child_stream_ended_now(c->err_stream)) {
    /* Nothing to wait for: no output pipe, or pipes that ended in an
     * earlier pass. 'close' follows 'exit' at once, in Node as well. */
    scr_child_fire_close(c);
  } else {
    /* 'close' waits for the output pipes to end, and when they ended in
     * this pass, for the end of the pass's sweep, where the closing list
     * fires newest first. Node's order for children whose pipes end and
     * that exit in one turn is every 'exit' in spawn order and then the
     * 'close' events in reverse: a pipe's 'close' comes from libuv's
     * closing queue, which runs after the turn's callbacks, last closed
     * first. */
    c->next = scr_children_closing;
    scr_children_closing = c; /* transfer the settle registry's reference */
  }
}

/* The events Node queues for its next tick when spawn() returns: 'spawn'
 * for a child that started, 'error' for one that did not (the settle
 * path). They fire in spawn order, the registry's order, and ahead of the
 * I/O that follows: a failed spawn's 'error' comes before its pipes' 'end',
 * which is a read of the pipe like any other. */
static void scr_children_next_tick_events(void) {
  ScrChild **link = &scr_children;
  while (*link) {
    ScrChild *c = *link;
    if (c->state == SCR_CHILD_SPAWN_FAILED) {
      *link = c->next; /* unlink BEFORE firing: callbacks may spawn */
      c->next = NULL;
      scr_child_settle(c);
    } else {
      if (c->state == SCR_CHILD_RUNNING && !c->spawn_done) scr_child_fire_spawn(c);
      link = &c->next;
    }
    if (scr_exc_pending()) return;
  }
}

/* One reap pass: the next-tick events of the children spawned since the
 * last one, then piped streams service (arrived chunks fire their 'data'
 * listeners; a pipe that hit EOF fires 'end' — before any 'exit' this pass
 * delivers, the pinned ordering), the next-tick events of what those
 * listeners spawned, then waitpid(WNOHANG) every running child. Listeners
 * run synchronously on the main stack, like timer callbacks — a throw
 * stops the pass and leaves the exception pending for the loop. */
void scr_children_poll(void) {
  scr_children_pass++;
  scr_children_next_tick_events();
  if (scr_exc_pending()) return;
  scr_ipc_service();
  if (scr_exc_pending()) return;
  scr_child_writers_service();
  if (scr_exc_pending()) return;
  scr_child_streams_service();
  if (scr_exc_pending()) return;
  scr_children_next_tick_events();
  if (scr_exc_pending()) return;
  /* Node's IPC read callback emits the messages it parsed, then on EOF
   * emits 'close' at once for a child that already exited, and defers
   * 'disconnect' to the next tick — all before this pass reaps. */
  scr_ipc_deliver();
  if (scr_exc_pending()) return;
  scr_children_closing_poll();
  if (scr_exc_pending()) return;
  scr_ipc_service();
  if (scr_exc_pending()) return;
  /* A child that a listener spawns during the sweep joins the registry's
   * tail and is swept with the rest: a spawn failure among the new ones
   * fires its 'error' in this pass, after the listener that spawned it. */
  ScrChild **link = &scr_children;
  while (*link) {
    ScrChild *c = *link;
    bool settle = false;
    if (c->state == SCR_CHILD_SPAWN_FAILED) {
      settle = true;
    } else {
      int st = 0;
      pid_t got = waitpid(c->pid, &st, WNOHANG);
      if (got == c->pid) {
        scr_child_unwatch(c->pid); /* Linux: the reaped pidfd must close */
        c->state = SCR_CHILD_EXITED;
        if (WIFEXITED(st)) {
          c->has_code = true;
          c->code = (double)WEXITSTATUS(st);
        } else {
          c->has_code = false; /* signal death: Node's code null */
          c->code = 0;
          if (WIFSIGNALED(st)) c->exit_signal = scr_signal_name(WTERMSIG(st));
        }
        settle = true;
      } else if (got < 0 && errno != EINTR) {
        /* ECHILD or another wait failure: nothing to reap — settle as a
         * signal-style exit so the loop can never spin forever. */
        scr_child_unwatch(c->pid);
        c->state = SCR_CHILD_EXITED;
        c->has_code = false;
        c->code = 0;
        settle = true;
      }
    }
    if (settle) {
      *link = c->next; /* unlink BEFORE firing: callbacks may spawn */
      c->next = NULL;
      scr_child_settle(c);
      if (scr_exc_pending()) return;
    } else {
      link = &c->next;
    }
  }
  /* The children this sweep settled whose pipes have ended (see the
   * settle path's last branch). */
  scr_children_closing_poll();
}

#ifdef SCR_CHILD_CP_OPTIONS
/* ── the cwd/input slice (SCR_CHILD_CP_OPTIONS) ─────────────────────────
 * spawnSync and the exec/execFile callback form take the `cwd` and `input`
 * options — the two members the exec core below already implements, and
 * the only ones the parameterized sync core above lacks. They live in this
 * build only: programs whose IR names one of these entry points (the
 * compiler's childOptionExt feature) link it, and every other program
 * keeps the default object, byte for byte.
 *
 * `cwd` NULL or "" spawns in the parent's directory; `input` with
 * has_input false leaves fd 0 to the stdio mode (an "inherit" slot keeps
 * the parent's stdin, otherwise /dev/null), true pipes the string and
 * closes it — Node's reading of the member, where `input: undefined` is an
 * ABSENT option and "" pipes an empty stdin. */
static ScrSpawnRes *scr_spawn_sync_core_ext(ScrStr *cmd, ScrArr *args, double timeout_ms,
                                            int killsig, int in_mode, int out_mode,
                                            int err_mode, ScrArr *env_pairs,
                                            ScrStr *cwd, ScrStr *input, bool has_input,
                                            bool shell) {
  double max_buffer = scr_child_max_take();
  bool use_cwd = cwd != NULL && cwd->len > 0;
  if (out_mode == 2 || err_mode == 2) {
    /* Inherited output fds: flush the parent's buffers first so earlier
     * logs precede the child's writes (Node's practical ordering). */
    scr_stdout_settle();
    fflush(stdout);
    fflush(stderr);
  }
  int outfd[2] = {-1, -1}, errfd[2] = {-1, -1}, infd[2] = {-1, -1};
  bool cap_out = out_mode == 0, cap_err = err_mode == 0;
  if ((cap_out && pipe(outfd) != 0) || (cap_err && pipe(errfd) != 0) ||
      (has_input && pipe(infd) != 0)) {
    fputs("scriptc: pipe() failed\n", stderr);
    abort();
  }

  posix_spawn_file_actions_t fa;
  posix_spawn_file_actions_init(&fa);
  if (has_input) {
    posix_spawn_file_actions_adddup2(&fa, infd[0], 0);
    posix_spawn_file_actions_addclose(&fa, infd[0]);
    posix_spawn_file_actions_addclose(&fa, infd[1]);
  } else if (in_mode != 2) {
    posix_spawn_file_actions_addopen(&fa, 0, "/dev/null", O_RDONLY, 0);
  } /* in_mode 2 (inherit): the child keeps the parent's fd 0 */
  if (cap_out) {
    posix_spawn_file_actions_adddup2(&fa, outfd[1], 1);
    posix_spawn_file_actions_addclose(&fa, outfd[0]);
    posix_spawn_file_actions_addclose(&fa, outfd[1]);
  } else if (out_mode == 1) {
    posix_spawn_file_actions_addopen(&fa, 1, "/dev/null", O_WRONLY, 0);
  }
  if (cap_err) {
    posix_spawn_file_actions_adddup2(&fa, errfd[1], 2);
    posix_spawn_file_actions_addclose(&fa, errfd[0]);
    posix_spawn_file_actions_addclose(&fa, errfd[1]);
  } else if (err_mode == 1) {
    posix_spawn_file_actions_addopen(&fa, 2, "/dev/null", O_WRONLY, 0);
  }
#if defined(__APPLE__) || defined(__GLIBC__) || defined(SCR_MUSL)
  if (use_cwd) posix_spawn_file_actions_addchdir_np(&fa, cwd->data);
#endif

  char **argv = scr_child_argv(cmd, args);
  /* `shell`: the command line through /bin/sh -c (the async spawn's exact
   * shape), so the command's quoting and operators apply. The form is
   * emitted with an EMPTY args list only (Node's DEP0190 warns otherwise,
   * and a native build has no warning channel), so the command string IS
   * the command line. */
  const char *file = cmd->data;
  if (shell) {
    free(argv);
    argv = malloc(4 * sizeof(char *));
    if (!argv) scr_child_oom();
    argv[0] = (char *)"/bin/sh";
    argv[1] = (char *)"-c";
    argv[2] = cmd->data;
    argv[3] = NULL;
    file = "/bin/sh";
  }
  char **envp = env_pairs != NULL ? scr_exec_envp(env_pairs) : NULL;
  pid_t pid = -1;
  int spawn_err = scr_spawn_command(&pid, file, &fa, NULL, argv, envp,
                                    use_cwd ? cwd->data : NULL);
  posix_spawn_file_actions_destroy(&fa);
  free(argv);
  scr_exec_envp_free(envp);
  if (cap_out) close(outfd[1]);
  if (cap_err) close(errfd[1]);
  if (has_input) close(infd[0]);

  if (spawn_err != 0) {
    /* Node: status null, error ENOENT/EACCES/... — never a throw. A cwd
     * that does not exist reports ENOENT here, exactly like Node (the
     * addchdir_np failure surfaces as the spawn error). */
    if (cap_out) close(outfd[0]);
    if (cap_err) close(errfd[0]);
    if (has_input) close(infd[1]);
    ScrSpawnRes *r = scr_spawn_res_new(false, 0, scr_str_new("", 0), scr_str_new("", 0));
    r->spawn_errname = scr_errname(spawn_err);
    r->cmd = scr_str_retain(cmd);
#ifdef SCR_CHILD_ERR_FIELDS
    r->spawn_errno = -(double)spawn_err;
    r->args = scr_child_snapshot_args(args);
#endif
    return r;
  }

  /* Feed stdin and drain both outputs together (either alone can fill and
   * deadlock a sequential loop); the poll deadline implements timeout. */
  if (has_input) fcntl(infd[1], F_SETFL, O_NONBLOCK);
  ScrCapBuf out, err;
  scr_cap_init(&out);
  scr_cap_init(&err);
  bool out_open = cap_out, err_open = cap_err, in_open = has_input;
  size_t in_at = 0;
  char *input_owned = NULL;
  const char *in_data = has_input ? scr_str_utf8(input, &input_owned) : NULL;
  size_t in_len = has_input ? input->len : 0;
  bool timed_out = false;
  bool enobufs = false; /* the outputs together passed maxBuffer */
  double deadline = timeout_ms > 0 ? scr_now_ms() + timeout_ms : 0;
  while (out_open || err_open || in_open) {
    struct pollfd fds[3];
    nfds_t n = 0;
    if (out_open) { fds[n].fd = outfd[0]; fds[n].events = POLLIN; n++; }
    if (err_open) { fds[n].fd = errfd[0]; fds[n].events = POLLIN; n++; }
    if (in_open) { fds[n].fd = infd[1]; fds[n].events = POLLOUT; n++; }
    int wait = -1;
    if (deadline > 0 && !timed_out) {
      double left = deadline - scr_now_ms();
      wait = left > 0 ? (int)(left + 0.999) : 0;
    }
    int rc = poll(fds, n, wait);
    if (rc < 0) {
      if (errno == EINTR) continue;
      break;
    }
    bool kill_now = false;
    if (deadline > 0 && !timed_out && scr_now_ms() >= deadline) {
      timed_out = true;
      kill_now = true;
    }
    for (nfds_t i = 0; rc > 0 && !kill_now && i < n; i++) {
      if (fds[i].revents == 0) continue;
      if (out_open && fds[i].fd == outfd[0]) {
        if (fds[i].revents & (POLLIN | POLLHUP | POLLERR)) out_open = scr_cap_read(&out, outfd[0]);
      } else if (err_open && fds[i].fd == errfd[0]) {
        if (fds[i].revents & (POLLIN | POLLHUP | POLLERR)) err_open = scr_cap_read(&err, errfd[0]);
      } else if (in_open && fds[i].fd == infd[1]) {
        if (fds[i].revents & (POLLERR | POLLHUP)) {
          close(infd[1]);
          in_open = false; /* the child closed stdin early: fine, like Node */
        } else if (fds[i].revents & POLLOUT) {
          ssize_t wrote = write(infd[1], in_data + in_at, in_len - in_at);
          if (wrote > 0) in_at += (size_t)wrote;
          else if (wrote < 0 && errno != EINTR && errno != EAGAIN) {
            close(infd[1]);
            in_open = false;
          }
          if (in_at >= in_len) {
            close(infd[1]);
            in_open = false;
          }
        }
      }
      if (max_buffer > 0 && (double)(out.len + err.len) > max_buffer) {
        enobufs = true;
        kill_now = true;
      }
    }
    if (kill_now) {
      /* Node kills the child and closes every stdio pipe (spawn_sync.cc's
       * Kill), so a grandchild that holds one cannot keep the call
       * waiting past the deadline or the limit. */
      kill(pid, killsig);
      scr_cap_close(&outfd[0]);
      scr_cap_close(&errfd[0]);
      if (in_open) close(infd[1]);
      out_open = err_open = in_open = false;
    }
  }
  scr_cap_close(&outfd[0]);
  scr_cap_close(&errfd[0]);
  if (in_open) close(infd[1]);
  scr_str_utf8_end(input_owned);

  /* Reap. With nothing captured the deadline lives here: WNOHANG-poll
   * until the child exits or the timeout kill fires. */
  int st = 0;
  pid_t reaped = -1;
  if (deadline > 0 && !timed_out && !enobufs) {
    for (;;) {
      reaped = waitpid(pid, &st, WNOHANG);
      if (reaped == pid || (reaped < 0 && errno != EINTR)) break;
      if (scr_now_ms() >= deadline) {
        timed_out = true;
        kill(pid, killsig);
        break;
      }
      struct timespec ts = {0, 500000}; /* 0.5ms */
      nanosleep(&ts, NULL);
    }
  }
  if (reaped != pid) {
    do {
      reaped = waitpid(pid, &st, 0);
    } while (reaped < 0 && errno == EINTR);
  }

  ScrStr *out_s = scr_str_new(out.data, out.len);
  ScrStr *err_s = scr_str_new(err.data, err.len);
  free(out.data);
  free(err.data);
  ScrSpawnRes *r;
  if (WIFEXITED(st) && !timed_out) {
    r = scr_spawn_res_new(true, (double)WEXITSTATUS(st), out_s, err_s);
  } else {
    r = scr_spawn_res_new(false, 0, out_s, err_s);
    if (WIFSIGNALED(st)) r->signal_name = scr_signal_name(WTERMSIG(st));
    if (timed_out) {
      if (r->signal_name == NULL) r->signal_name = scr_signal_name(killsig);
      r->spawn_errname = "ETIMEDOUT";
      r->cmd = scr_str_retain(cmd);
#ifdef SCR_CHILD_ERR_FIELDS
      r->spawn_errno = -(double)ETIMEDOUT;
      r->args = scr_child_snapshot_args(args);
#endif
    }
  }
  if (enobufs && !timed_out) {
    r->spawn_errname = "ENOBUFS";
    r->cmd = scr_str_retain(cmd);
#ifdef SCR_CHILD_ERR_FIELDS
    r->spawn_errno = -(double)ENOBUFS;
    r->args = scr_child_snapshot_args(args);
#endif
  }
  return r;
}

/* cp.spawnSyncExt: the options entry with cwd + input (the parameterized
 * core's contract otherwise: killSignal as a NAME, "" = SIGTERM), and
 * cp.spawnSyncExtEnv, the same with the env replacement pairs. */
ScrSpawnRes *scr_spawn_sync_ext_env(ScrStr *cmd, ScrArr *args, double timeout_ms,
                                     ScrStr *killsignal, double in_mode, double out_mode,
                                     double err_mode, ScrStr *cwd, ScrStr *input,
                                     bool has_input, bool shell, ScrArr *env_pairs) {
  int killsig = SIGTERM;
  if (killsignal->len > 0) {
    int resolved = scr_signal_from_name(killsignal);
    if (resolved > 0) killsig = resolved;
  }
  return scr_spawn_sync_core_ext(cmd, args, timeout_ms, killsig, (int)in_mode,
                                 (int)out_mode, (int)err_mode, env_pairs, cwd, input,
                                 has_input, shell);
}

ScrSpawnRes *scr_spawn_sync_ext(ScrStr *cmd, ScrArr *args, double timeout_ms,
                                 ScrStr *killsignal, double in_mode, double out_mode,
                                 double err_mode, ScrStr *cwd, ScrStr *input,
                                 bool has_input, bool shell) {
  return scr_spawn_sync_ext_env(cmd, args, timeout_ms, killsignal, in_mode, out_mode,
                                err_mode, cwd, input, has_input, shell, NULL);
}

/* exec/execFile (the callback slice) with the `cwd` option: scr_exec_file's
 * registration over the spawn core's cwd argument. */
ScrChild *scr_exec_file_cwd(ScrStr *cmd, ScrArr *args, ScrClosure *cb /*moves*/,
                             ScrExecFileFn fn, bool shell, ScrStr *cwd) {
  ScrChild *c = scr_spawn_opts(cmd, args, 3, 3, 3, 0, 0, false, false, false, NULL, cwd);
  c->exec_cb = cb;
  c->exec_fn = fn;
  c->exec_file = scr_str_retain(cmd);
  c->exec_args = scr_arr_retain(args);
  c->exec_props = &scr_exec_file_error_props;
  char *display = scr_exec_display(cmd, args, shell);
  c->exec_display = scr_str_new(display, strlen(display));
  free(display);
  scr_child_stream_capture_begin(c->out_stream);
  scr_child_stream_capture_begin(c->err_stream);
  scr_exec_limit_install(c);
  return c;
}
#endif /* SCR_CHILD_CP_OPTIONS */

#endif /* !_WIN32 */

/* ── exec/execFile's maxBuffer (the callback forms) ─────────────────────
 * Node's exec listens to 'data' on the child's stdout and stderr, counts
 * each stream, and at the limit cuts the chunk, destroys both streams,
 * kills the child and hands the callback a RangeError. The same here: a
 * data listener per stream counts what the capture holds, and the
 * program's callback is called through scr_exec_limit_fire, which swaps
 * that error in. Everything is installed by scr_exec_file on its own
 * child, so the stream pump and the settle path stay as they are for
 * every other child. */
typedef struct {
  size_t rc;
  ScrChild *child;     /* borrowed while the child holds the callback wrapper; NULL after */
  double max_buffer;
  double text_len[2];  /* Node's count per stream: stdout, stderr */
  size_t seen[2];      /* the capture bytes already counted */
  ScrError *over;      /* the maxBuffer error once a stream passed the limit (+1) */
  ScrClosure *cb;      /* the program's callback (+1) and its adapter */
  ScrExecFileFn fn;
} ScrExecLimit;

static void *scr_exec_limit_retain_v(void *p) {
  ((ScrExecLimit *)p)->rc++;
  return p;
}

static void scr_exec_limit_release_v(void *p) {
  ScrExecLimit *l = p;
  if (--l->rc > 0) return;
  if (l->over) scr_error_release(l->over);
  scr_closure_release(l->cb);
  free(l);
}

/* The wrapper's reference: once the child lets go of it, the child may be
 * freed, so the listeners stop looking at it. */
static void scr_exec_limit_release_owner(void *p) {
  ((ScrExecLimit *)p)->child = NULL;
  scr_exec_limit_release_v(p);
}

/* A zero-argument 'data' listener (scr_child_stream_thunk0's kind), which
 * hears every chunk whatever encoding the program sets on the stream; the
 * capture already holds the chunk. */
static void scr_exec_limit_data(ScrClosure *cb) {
  ScrExecLimit *l = scr_box_get_ref(cb->caps[0]);
  int which = (int)scr_box_get_f64(cb->caps[1]);
  ScrChild *c = l->child;
  ScrChildStream *s = c == NULL ? NULL : which == 0 ? c->out_stream : c->err_stream;
  if (s != NULL && l->over == NULL && s->capture && s->capture_len > l->seen[which]) {
    bool over = scr_exec_limit_chunk(s->capture_data, &s->capture_len, l->seen[which],
                                     &l->text_len[which], l->max_buffer);
    l->seen[which] = s->capture_len;
    if (over) {
      l->over = scr_child_max_error(which == 0 ? "stdout" : "stderr", c->exec_display->data);
      ScrChildStream *streams[2] = {c->out_stream, c->err_stream};
      for (int i = 0; i < 2; i++) {
        if (streams[i] == NULL) continue;
#ifdef SCR_CHILD_STREAM_FLOW
        /* A stream with a flow state reads for its capture or below its
         * high-water mark, not for its listeners (scr_child_stream_watching):
         * its capture stays on, so the cut is read and the stream ends. */
        if (streams[i]->flow.state == SCR_CHILD_FLOW_NONE)
#endif
        streams[i]->capture = streams[i]->n_data == 0; /* a listener keeps it watched */
        scr_exec_stream_cut(streams[i]);
      }
      (void)scr_child_kill_num(c, (double)SIGTERM);
    }
  }
  scr_exec_limit_release_v(l);
}

/* The callback as the child calls it (error, stdout and stderr move): the
 * maxBuffer error replaces the exit's. */
static void scr_exec_limit_fire(ScrClosure *wrap, ScrError *error, ScrStr *out, ScrStr *err) {
  ScrExecLimit *l = scr_box_get_ref(wrap->caps[0]);
  if (l->over != NULL) {
    if (error) scr_error_release(error);
    error = l->over;
    l->over = NULL;
  }
  l->fn(l->cb, error, out, err);
  scr_exec_limit_release_v(l);
}

static void scr_exec_limit_install(ScrChild *c) {
  ScrExecLimit *l = calloc(1, sizeof *l);
  if (!l) scr_child_oom();
  l->rc = 1;
  l->child = c;
  l->max_buffer = scr_child_max_take();
  l->cb = c->exec_cb;
  l->fn = c->exec_fn;
  ScrClosure *wrap = scr_closure_new((void *)&scr_exec_limit_fire, 1);
  wrap->caps[0] = scr_box_new_obj(&scr_exec_limit_retain_v, &scr_exec_limit_release_owner, NULL);
  scr_box_set_ref(wrap->caps[0], l);
  c->exec_cb = wrap;
  c->exec_fn = &scr_exec_limit_fire;
  for (int which = 0; which < 2; which++) {
    ScrChildStream *s = which == 0 ? c->out_stream : c->err_stream;
    if (s == NULL) continue;
    ScrClosure *listener = scr_closure_new((void *)&scr_exec_limit_data, 2);
    listener->caps[0] = scr_box_new_obj(&scr_exec_limit_retain_v, &scr_exec_limit_release_v, NULL);
    scr_box_set_ref(listener->caps[0], scr_exec_limit_retain_v(l));
    listener->caps[1] = scr_box_new(SCR_BOX_F64);
    scr_box_set_f64(listener->caps[1], which);
    scr_child_stream_on_data(s, listener, &scr_child_stream_thunk0, false);
  }
}

/* ── the spawnSync result in the checked-dynamic tree ──────────────────
 * A SpawnSyncReturns boxes as a HANDLE by REFERENCE (identity, no copy):
 * a dynamic wrapper hands the same result out, and the typed slot unwraps
 * it through the tag check. A plain object that merely LOOKS like a
 * spawn result is not one and fails the check (the checked-cast stance).
 * Its members answer the accessors above; a call through the value is the
 * usual "narrow first" fence. */
static ScrDyn *scr_spawn_res_dyn_invoke(void *h, ScrDyn *self, const char *method,
                                        ScrDyn *const *args, size_t argc, const char *what) {
  (void)h;
  (void)self;
  (void)method;
  (void)args;
  (void)argc;
  (void)what;
  static const char msg[] =
      "spawnSync result methods through an 'unknown' value are not supported yet — narrow the value first";
  scr_throw_error_msg_code(SCR_ERR_ERROR, msg, sizeof msg - 1, "SC2020");
  return NULL;
}

static ScrDyn *scr_spawn_res_dyn_str(ScrStr *s) {
  ScrDyn *d = scr_dyn_new_str(s);
  scr_str_release(s);
  return d;
}

static ScrDyn *scr_spawn_res_dyn_get(void *h, const char *key, size_t len) {
  ScrSpawnRes *r = h;
  if (len == 6 && memcmp(key, "status", 6) == 0) {
    return scr_spawn_res_has_status(r) ? scr_dyn_new_num(scr_spawn_res_status(r))
                                       : scr_dyn_new_null();
  }
  if (len == 6 && memcmp(key, "stdout", 6) == 0) return scr_spawn_res_dyn_str(scr_spawn_res_stdout(r));
  if (len == 6 && memcmp(key, "stderr", 6) == 0) return scr_spawn_res_dyn_str(scr_spawn_res_stderr(r));
  if (len == 6 && memcmp(key, "signal", 6) == 0) {
    return scr_spawn_res_has_signal(r) ? scr_spawn_res_dyn_str(scr_spawn_res_signal(r))
                                       : scr_dyn_new_null();
  }
  if (len == 5 && memcmp(key, "error", 5) == 0) {
    ScrError *e = scr_spawn_res_error(r);
    if (!e) return NULL; /* the undefined arm, like Node */
    ScrDyn *d = scr_dyn_from_error(e);
    scr_error_release(e);
    return d;
  }
  return NULL;
}

static bool scr_spawn_res_dyn_set(void *h, const char *key, size_t len, const ScrDyn *value) {
  (void)h;
  (void)key;
  (void)len;
  (void)value;
  return false;
}

static void scr_spawn_res_dyn_install(void) {
  static SCR_TL bool installed;
  if (installed) return;
  installed = true;
  static const ScrDynHandleOps ops = {
      .cls = "SpawnSyncReturns",
      .retain = scr_spawn_res_retain_v,
      .release = scr_spawn_res_release_v,
      .invoke = scr_spawn_res_dyn_invoke,
      .get = scr_spawn_res_dyn_get,
      .set = scr_spawn_res_dyn_set,
  };
  scr_dyn_handle_install(SCR_DYNH_SPAWN_RES, &ops);
}

ScrDyn *scr_spawn_res_to_dyn(ScrSpawnRes *r) {
  scr_spawn_res_dyn_install();
  return scr_dyn_new_handle(r, SCR_DYNH_SPAWN_RES);
}

static void scr_child_drop_spawn_listeners(ScrChild *c) {
  for (size_t i = 0; i < c->n_spawn; i++) scr_closure_release(c->spawn_cbs[i]);
  free(c->spawn_cbs);
  c->spawn_cbs = NULL;
  c->n_spawn = c->cap_spawn = 0;
}

void scr_child_ref(ScrChild *c) {
  SCR_IF_ISLAND(c, scr_child_island_ops->call(c->island, "ref"); return);
  if (!c->settled && !c->reffed) {
    c->reffed = true;
    scr_children_reffed_n++;
  }
}

void scr_child_on_spawn(ScrChild *c, ScrClosure *cb) {
  SCR_IF_ISLAND(c, scr_child_island_ops->on(c->island, SCR_CHILD_EV_SPAWN, cb, NULL, false); return);
  if (c->spawn_done || c->settled) { scr_closure_release(cb); return; }
  if (c->n_spawn == c->cap_spawn) {
    c->cap_spawn = c->cap_spawn ? c->cap_spawn * 2 : 2;
    ScrClosure **grown = realloc(c->spawn_cbs, c->cap_spawn * sizeof *grown);
    if (!grown) scr_trap("scriptc: out of memory\n");
    c->spawn_cbs = grown;
  }
  c->spawn_cbs[c->n_spawn++] = cb;
}

/* Success is observable on the next loop pass, before any data or exit
 * event. Detaching the snapshot keeps listeners registered by a callback
 * from participating in an event that has already started. */
static void scr_child_fire_spawn_in(ScrChild *c);

/* 'spawn' runs in the spawn() call's context. */
static void scr_child_fire_spawn(ScrChild *c) {
  ScrAlsCtx *prev = scr_als_dispatch_enter(c->als);
  scr_child_fire_spawn_in(c);
  scr_als_dispatch_leave(prev);
}

static void scr_child_fire_spawn_in(ScrChild *c) {
  c->spawn_done = true;
  ScrClosure **callbacks = c->spawn_cbs;
  size_t count = c->n_spawn;
  c->spawn_cbs = NULL;
  c->n_spawn = c->cap_spawn = 0;
  for (size_t i = 0; i < count; i++) {
    if (!scr_exc_pending()) ((void (*)(ScrClosure *))callbacks[i]->fn)(callbacks[i]);
    scr_closure_release(callbacks[i]);
  }
  free(callbacks);
}

/* ── Node's argument checks before a child starts ───────────────────────
 *
 * child_process validates what it hands to the operating system before it
 * starts a process (normalizeSpawnArguments and normalizeExecArgs in
 * lib/child_process.js): the file or command, each argument, the working
 * directory and each environment key and value hold no NUL, because the
 * operating system reads each of them up to the first one, and the file is
 * not empty. Each failure is Node's ERR_INVALID_ARG_VALUE TypeError. */

/* util.inspect's rendering of a string, as ERR_INVALID_ARG_VALUE prints
 * the received value: a string longer than 76 UTF-16 units is quoted line
 * by line (split after each line feed, joined by " +\n  "), and the text
 * is cut to 128 units plus "...". +1. */
static ScrStr *scr_child_arg_received(ScrStr *s /*borrowed*/) {
  ScrStr *text;
  if (scr_str_utf16_len(s) <= 76) {
    text = scr_str_inspect_quoted(s, false);
  } else {
    ScrJsonBuf b;
    scr_jb_init(&b);
    size_t start = 0;
    while (start < s->len) {
      const char *nl = memchr(s->data + start, '\n', s->len - start);
      size_t end = nl != NULL ? (size_t)(nl - s->data) + 1 : s->len;
      ScrStr *line = scr_str_new(s->data + start, end - start);
      ScrStr *quoted = scr_str_inspect_quoted(line, false);
      if (start > 0) scr_jb_puts(&b, " +\n  ");
      scr_jb_put_str(&b, quoted);
      scr_str_release(quoted);
      scr_str_release(line);
      start = end;
    }
    text = scr_jb_finish(&b);
  }
  if (scr_str_utf16_len(text) > 128) {
    ScrStr *head = scr_str_slice(text, 0, 128);
    ScrStr *dots = scr_str_new("...", 3);
    scr_str_release(text);
    text = scr_str_concat(head, dots);
    scr_str_release(head);
    scr_str_release(dots);
  }
  return text;
}

/* Throws ERR_INVALID_ARG_VALUE for `value` under the name name[0..len):
 * "The argument '<name>' <reason>. Received <value>", with "property" for
 * a dotted name, as errors.js chooses. */
static void scr_child_arg_fail(const char *name, size_t len, const char *reason,
                               ScrStr *value /*borrowed*/) {
  ScrStr *received = scr_child_arg_received(value);
  ScrJsonBuf b;
  scr_jb_init(&b);
  scr_jb_puts(&b, memchr(name, '.', len) != NULL ? "The property '" : "The argument '");
  scr_jb_write(&b, name, len);
  scr_jb_puts(&b, "' ");
  scr_jb_puts(&b, reason);
  scr_jb_puts(&b, ". Received ");
  scr_jb_put_str(&b, received);
  scr_str_release(received);
  ScrStr *msg = scr_jb_finish(&b);
  scr_throw_error_msg_code(SCR_ERR_TYPE, msg->data, msg->len, "ERR_INVALID_ARG_VALUE");
  scr_str_release(msg);
}

static bool scr_child_arg_has_nul(const ScrStr *s) {
  return memchr(s->data, '\0', s->len) != NULL;
}

static const char SCR_CHILD_NO_NUL[] = "must be a string without null bytes";

/* The file or command, then each argument. `form` says where Node's
 * `file` or `command` is: 0, `cmd` is the file and `args` its arguments;
 * 1, the shell form of exec and execSync, whose command is args[1] (the
 * launch is /bin/sh -c command); 2, the same launch for execFile with
 * shell: true, whose args[1] is Node's file; 3, fork, which has no file to
 * check and whose arguments follow the module path in the list Node
 * spawns, so args[i] is Node's args[i + 1]. False with the exception
 * pending. */
static bool scr_child_check_file_args(int form, ScrStr *cmd /*borrowed*/, ScrArr *args /*borrowed*/) {
  size_t n = (size_t)scr_arr_len(args);
  ScrStr *file = form == 0                           ? scr_str_retain(cmd)
                 : (form == 1 || form == 2) && n > 1 ? (ScrStr *)scr_arr_get_ref(args, 1)
                                                     : NULL;
  if (file != NULL) {
    bool nul = scr_child_arg_has_nul(file);
    if (nul) {
      if (form == 1) scr_child_arg_fail("command", 7, SCR_CHILD_NO_NUL, file);
      else scr_child_arg_fail("file", 4, SCR_CHILD_NO_NUL, file);
    } else if (file->len == 0) {
      scr_child_arg_fail("file", 4, "cannot be empty", file);
    }
    bool bad = nul || file->len == 0;
    scr_str_release(file);
    if (bad) return false;
  }
  if (form != 0 && form != 3) return true;
  for (size_t i = 0; i < n; i++) {
    ScrStr *arg = (ScrStr *)scr_arr_get_ref(args, (double)i);
    bool nul = scr_child_arg_has_nul(arg);
    if (nul) {
      char name[40];
      int len = snprintf(name, sizeof name, "args[%zu]", form == 3 ? i + 1 : i);
      scr_child_arg_fail(name, (size_t)len, SCR_CHILD_NO_NUL, arg);
    }
    scr_str_release(arg);
    if (nul) return false;
  }
  return true;
}

/* options.cwd, as getValidatedPath checks it. */
static bool scr_child_check_cwd(ScrStr *cwd /*borrowed, nullable*/) {
  if (cwd == NULL || !scr_child_arg_has_nul(cwd)) return true;
  scr_child_arg_fail("options.cwd", 11, "must be a string, Uint8Array, or URL without null bytes", cwd);
  return false;
}

/* One environment entry: the key, then the value, both under the name
 * options.env['<key>']. */
static bool scr_child_check_env_entry(ScrStr *key /*borrowed*/, ScrStr *value /*borrowed*/) {
  ScrStr *bad = scr_child_arg_has_nul(key) ? key : scr_child_arg_has_nul(value) ? value : NULL;
  if (bad == NULL) return true;
  ScrJsonBuf b;
  scr_jb_init(&b);
  scr_jb_puts(&b, "options.env['");
  scr_jb_write(&b, key->data, key->len);
  scr_jb_puts(&b, "']");
  ScrStr *name = scr_jb_finish(&b);
  scr_child_arg_fail(name->data, name->len, SCR_CHILD_NO_NUL, bad);
  scr_str_release(name);
  return false;
}

/* cp.checkArgs: the checks above over one launch's values, in Node's
 * order: the file or command and the arguments, the working directory
 * ("" when the option is absent), then the environment's [key, value, ...]
 * pairs (empty when the child inherits ours). Throws before the launch
 * that follows it; all arguments are borrowed. */
void scr_child_check_args(double form, ScrStr *cmd, ScrArr *args, ScrArr *env_pairs, ScrStr *cwd) {
  if (!scr_child_check_file_args((int)form, cmd, args) || !scr_child_check_cwd(cwd)) return;
  size_t n = env_pairs != NULL ? (size_t)scr_arr_len(env_pairs) : 0;
  for (size_t i = 0; i + 1 < n; i += 2) {
    ScrStr *key = (ScrStr *)scr_arr_get_ref(env_pairs, (double)i);
    ScrStr *value = (ScrStr *)scr_arr_get_ref(env_pairs, (double)(i + 1));
    bool ok = scr_child_check_env_entry(key, value);
    scr_str_release(key);
    scr_str_release(value);
    if (!ok) return;
  }
}

/* Options produced by JavaScript helpers use the same native spawn core
 * as inline options. Materialize typed views only for normalization;
 * descriptor reads still execute getters and propagate their exceptions. */
static ScrDyn *scr_spawn_option(const ScrDyn *options, const char *name) {
  if (options->kind == SCR_DYN_TYPED_REF) {
    ScrDyn *view = scr_dyn_typed_ref_materialize(options);
    if (!view) return NULL;
    ScrDyn *value = scr_spawn_option(view, name);
    scr_dyn_release(view);
    return value;
  }
  return scr_dyn_obj_read(options, name, strlen(name));
}

static void scr_spawn_refuse(const char *feature) {
  ScrJsonBuf message;
  scr_jb_init(&message);
  scr_jb_puts(&message, "spawn with ");
  scr_jb_puts(&message, feature);
  scr_jb_puts(&message, " has no native lowering");
  ScrStr *text = scr_jb_finish(&message);
  scr_throw_error_msg_code(SCR_ERR_ERROR, text->data, text->len, "SC2020");
  scr_str_release(text);
}

static bool scr_spawn_stdio_mode(const ScrDyn *value, int slot,
                                double *mode, double *fd) {
  if (value->kind == SCR_DYN_UNDEF || value->kind == SCR_DYN_NULL) {
    *mode = 3;
    return true;
  }
  if (value->kind == SCR_DYN_STR) {
    const ScrStr *s = value->v.str;
    if (s->len == 4 && !memcmp(s->data, "pipe", 4)) { *mode = 3; return true; }
    if (s->len == 6 && !memcmp(s->data, "ignore", 6)) { *mode = 0; return true; }
    if (s->len == 7 && !memcmp(s->data, "inherit", 7)) { *mode = 1; return true; }
  }
  if (slot > 0 && value->kind == SCR_DYN_NUM && isfinite(value->v.num) &&
      value->v.num >= 0 && value->v.num <= 2147483647 && floor(value->v.num) == value->v.num) {
    *mode = 2;
    *fd = value->v.num;
    return true;
  }
  scr_spawn_refuse("this stdio slot");
  return false;
}

ScrChild *scr_spawn_dynamic(ScrStr *cmd, ScrArr *args, const ScrDyn *options) {
  ScrDyn *view = options->kind == SCR_DYN_TYPED_REF
    ? scr_dyn_typed_ref_materialize(options) : scr_dyn_retain((ScrDyn *)options);
  ScrDyn *stdio = NULL, *value = NULL, *env = NULL, *keys = NULL;
  ScrArr *pairs = NULL;
  ScrStr *cwd = NULL;
  ScrChild *child = NULL;
  bool detached = false, shell = false, has_env = false;
  double modes[3] = {3, 3, 3}, fds[3] = {0, 0, 0};
  if (!view) goto done;
  /* Node checks the file and the arguments before it reads the options */
  if (!scr_child_check_file_args(0, cmd, args)) goto done;
  if (view->kind != SCR_DYN_UNDEF &&
      (view->kind == SCR_DYN_NULL || !scr_dyn_is_object(view))) {
    scr_dyn_arg_type_fail("options", "of type object", view);
    goto done;
  }
  if (view->kind == SCR_DYN_UNDEF) {
    scr_dyn_release(view);
    view = scr_dyn_new_obj();
  }

  /* Retain explicit boundaries for native process features that the
   * inline lowering does not implement either. Undefined is an omission. */
  static const char *const unsupported[] = {
    "uid", "gid", "argv0", "signal", "timeout", "killSignal",
  };
  for (size_t i = 0; i < sizeof unsupported / sizeof unsupported[0]; i++) {
    value = scr_spawn_option(view, unsupported[i]);
    if (!value || scr_exc_pending()) goto done;
    if (value->kind != SCR_DYN_UNDEF) {
      scr_spawn_refuse(unsupported[i]);
      goto done;
    }
    scr_dyn_release(value); value = NULL;
  }
  value = scr_spawn_option(view, "windowsVerbatimArguments");
  if (!value || scr_exc_pending()) goto done;
  if (scr_dyn_truthy(value)) { scr_spawn_refuse("windowsVerbatimArguments"); goto done; }
  scr_dyn_release(value); value = NULL;

  cwd = scr_str_new("", 0);
  value = scr_spawn_option(view, "cwd");
  if (!value || scr_exc_pending()) goto done;
  if (value->kind != SCR_DYN_UNDEF && value->kind != SCR_DYN_NULL) {
    if (value->kind != SCR_DYN_STR) {
      scr_dyn_prop_type_fail("options.cwd", "of type string or an instance of Buffer or URL", value);
      goto done;
    }
    scr_str_release(cwd); cwd = scr_str_retain(value->v.str);
    if (!scr_child_check_cwd(cwd)) goto done;
  }
  scr_dyn_release(value); value = NULL;
  static const char *const booleans[] = {"detached", "shell", "windowsHide"};
  for (size_t i = 0; i < sizeof booleans / sizeof booleans[0]; i++) {
    value = scr_spawn_option(view, booleans[i]);
    if (!value || scr_exc_pending()) goto done;
    if (value->kind != SCR_DYN_UNDEF) {
      if (i == 1 && value->kind == SCR_DYN_STR) {
        scr_spawn_refuse("a custom shell executable");
        goto done;
      }
      if (value->kind != SCR_DYN_BOOL) {
        char name[40]; snprintf(name, sizeof name, "options.%s", booleans[i]);
        scr_dyn_prop_type_fail(name, i == 1 ? "of type boolean or string" : "of type boolean", value);
        goto done;
      }
      if (i == 0) detached = value->v.b;
      else if (i == 1) shell = value->v.b;
    }
    scr_dyn_release(value); value = NULL;
  }
  if (shell && scr_arr_len(args) != 0) {
    scr_spawn_refuse("shell enabled and separate arguments");
    goto done;
  }
  stdio = scr_spawn_option(view, "stdio");
  if (!stdio || scr_exc_pending()) goto done;
  if (stdio->kind == SCR_DYN_TYPED_REF) {
    ScrDyn *expanded = scr_dyn_typed_ref_materialize(stdio);
    scr_dyn_release(stdio); stdio = expanded;
    if (!stdio) goto done;
  }
  if (stdio->kind == SCR_DYN_ARR) {
    if (stdio->v.arr.len > 3) { scr_spawn_refuse("additional stdio descriptors"); goto done; }
    for (int i = 0; i < 3; i++) {
      value = scr_dyn_arr_at(stdio, i);
      if (!scr_spawn_stdio_mode(value, i, &modes[i], &fds[i])) goto done;
      scr_dyn_release(value); value = NULL;
    }
  } else if (stdio->kind == SCR_DYN_STR || stdio->kind == SCR_DYN_UNDEF || stdio->kind == SCR_DYN_NULL) {
    if (!scr_spawn_stdio_mode(stdio, 0, &modes[0], &fds[0])) goto done;
    modes[1] = modes[2] = modes[0];
  } else { scr_spawn_refuse("this stdio option"); goto done; }

  pairs = scr_arr_new(SCR_ELEM_STR, 8);
  env = scr_spawn_option(view, "env");
  if (!env || scr_exc_pending()) goto done;
  if (env->kind == SCR_DYN_TYPED_REF) {
    ScrDyn *expanded = scr_dyn_typed_ref_materialize(env);
    scr_dyn_release(env); env = expanded;
    if (!env) goto done;
  }
  if (env->kind != SCR_DYN_UNDEF && env->kind != SCR_DYN_NULL) {
    has_env = true;
    keys = scr_dyn_for_in_keys(env);
    if (!keys || scr_exc_pending()) goto done;
    for (size_t i = 0; i < keys->v.arr.len; i++) {
      ScrStr *key = keys->v.arr.items[i]->v.str;
      /* the key's own length: it may hold a NUL, which the check refuses */
      value = scr_dyn_obj_read(env, key->data, key->len);
      if (!value || scr_exc_pending()) goto done;
      if (value->kind != SCR_DYN_UNDEF) {
        ScrStr *text = scr_dyn_string_coerce_js(value);
        if (!text) goto done;
        scr_arr_push_ref(pairs, scr_str_retain(key));
        scr_arr_push_ref(pairs, text);
        if (!scr_child_check_env_entry(key, text)) goto done;
      }
      scr_dyn_release(value); value = NULL;
    }
  }
  child = scr_spawn_opts(cmd, args, modes[0], modes[1], modes[2],
    fds[1], fds[2], detached, shell, has_env, pairs, cwd);
done:
  scr_dyn_release(view);
  scr_dyn_release(stdio);
  scr_dyn_release(value);
  scr_dyn_release(env);
  scr_dyn_release(keys);
  scr_arr_release(pairs);
  scr_str_release(cwd);
  return child;
}

/* ── fork JSON IPC (shared by Windows and POSIX) ────────────────────── */

typedef struct {
  ScrClosure *cb;
  ScrIpcMessageFn fn;
  bool once;
} ScrIpcMessageEntry;

typedef struct {
  ScrClosure *cb;
  bool once;
} ScrIpcDisconnectEntry;

typedef struct {
  ScrClosure *cb;
  ScrIpcSendFn fn;
  ScrAlsCtx *ctx; /* the send() call's context (+1): the callback runs in it */
} ScrIpcSendEntry;

struct ScrIpc {
  size_t rc;
  bool connected;
  bool armed;
  bool local_closing;
  bool disconnect_pending;
  bool disconnect_emitted;
  bool eof_pending;    /* the reader hit EOF behind undelivered messages */
  bool eof;            /* the remote end's close was observed */
  bool closed_locally; /* disconnect() closed the reader before any EOF */
  bool registered;
  ScrChildStream *reader;
  ScrChildWriter *writer;
  ScrClosure *writer_error_cb; /* borrowed from writer->err_ls */
  uint8_t *buffer;
  size_t buffer_len, buffer_cap;
  ScrDyn **pending;
  size_t n_pending, cap_pending;
  ScrIpcMessageEntry *message_ls;
  size_t n_message, cap_message;
  ScrIpcDisconnectEntry *disconnect_ls;
  size_t n_disconnect, cap_disconnect;
  ScrIpcSendEntry *send_cbs;
  size_t n_send, cap_send;
  ScrStr *send_error;
  /* The context the channel was created in (+1): 'message' and
   * 'disconnect' run in it. */
  ScrAlsCtx *als;
  struct ScrIpc *next;
};

static SCR_TL ScrIpc *scr_ipcs = NULL;
static SCR_TL ScrIpc *scr_process_ipc = NULL;
static SCR_TL double scr_process_fork_id = -2;
static SCR_TL bool scr_ipc_cleanup_registered = false;

static ScrIpc *scr_ipc_retain(ScrIpc *ipc) {
  if (ipc && ipc->rc != SIZE_MAX) ipc->rc++;
  return ipc;
}

static void scr_ipc_drop_writer_error(ScrIpc *ipc) {
  if (!ipc->writer_error_cb) return;
  for (size_t i = 0; i < ipc->writer->n_write_err; i++) {
    if (ipc->writer->err_ls[i].cb != ipc->writer_error_cb) continue;
    scr_closure_release(ipc->writer->err_ls[i].cb);
    memmove(ipc->writer->err_ls + i, ipc->writer->err_ls + i + 1,
            (ipc->writer->n_write_err - i - 1) * sizeof(*ipc->writer->err_ls));
    ipc->writer->n_write_err--;
    break;
  }
  ipc->writer_error_cb = NULL;
}

static void scr_ipc_release(ScrIpc *ipc) {
  if (!ipc || ipc->rc == SIZE_MAX) return;
  if (--ipc->rc != 0) return;
  scr_ipc_drop_writer_error(ipc);
  scr_child_stream_release(ipc->reader);
  scr_child_writer_release(ipc->writer);
  for (size_t i = 0; i < ipc->n_pending; i++) scr_dyn_release(ipc->pending[i]);
  for (size_t i = 0; i < ipc->n_message; i++) scr_closure_release(ipc->message_ls[i].cb);
  for (size_t i = 0; i < ipc->n_disconnect; i++) scr_closure_release(ipc->disconnect_ls[i].cb);
  for (size_t i = 0; i < ipc->n_send; i++) {
    scr_closure_release(ipc->send_cbs[i].cb);
    scr_als_ctx_release(ipc->send_cbs[i].ctx);
  }
  scr_str_release(ipc->send_error);
  scr_als_ctx_release(ipc->als);
  free(ipc->buffer);
  free(ipc->pending);
  free(ipc->message_ls);
  free(ipc->disconnect_ls);
  free(ipc->send_cbs);
  free(ipc);
}

static void *scr_ipc_retain_v(void *p) { return scr_ipc_retain((ScrIpc *)p); }
static void scr_ipc_release_v(void *p) { scr_ipc_release((ScrIpc *)p); }

static ScrIpc *scr_ipc_from_closure(ScrClosure *cb) {
  return (ScrIpc *)scr_box_get_ref(cb->caps[0]);
}

static ScrClosure *scr_ipc_closure(ScrIpc *ipc, void *fn) {
  ScrClosure *cb = scr_closure_new(fn, 1);
  ScrBox *box = scr_box_new_obj(&scr_ipc_retain_v, &scr_ipc_release_v, NULL);
  scr_box_set_ref(box, scr_ipc_retain(ipc));
  cb->caps[0] = box;
  return cb;
}

static void scr_ipc_global_cleanup(void) {
  while (scr_ipcs != NULL) {
    ScrIpc *ipc = scr_ipcs;
    scr_ipcs = ipc->next;
    ipc->next = NULL;
    ipc->registered = false;
    scr_ipc_drop_writer_error(ipc);
    scr_child_stream_finish(ipc->reader, false);
    scr_child_writer_destroy(ipc->writer);
    scr_ipc_release(ipc);
  }
  scr_ipc_release(scr_process_ipc);
  scr_process_ipc = NULL;
  scr_process_fork_id = -2;
}

static void scr_ipc_queue_message(ScrIpc *ipc, ScrDyn *message /*moves*/) {
  if (ipc->n_pending == ipc->cap_pending) {
    ipc->cap_pending = ipc->cap_pending ? ipc->cap_pending * 2 : 4;
    ipc->pending = realloc(ipc->pending, ipc->cap_pending * sizeof(*ipc->pending));
    if (!ipc->pending) scr_trap("out of memory");
  }
  ipc->pending[ipc->n_pending++] = message;
}

static void scr_ipc_stream_data(ScrClosure *closure, ScrBytes *chunk) {
  ScrIpc *ipc = scr_ipc_from_closure(closure);
  size_t need = ipc->buffer_len + chunk->len;
  if (need > ipc->buffer_cap) {
    size_t cap = ipc->buffer_cap ? ipc->buffer_cap : 256;
    while (cap < need) cap *= 2;
    ipc->buffer = realloc(ipc->buffer, cap);
    if (!ipc->buffer) scr_trap("out of memory");
    ipc->buffer_cap = cap;
  }
  scr_bytes_read(chunk, 0, ipc->buffer + ipc->buffer_len, chunk->len);
  ipc->buffer_len = need;
  size_t consumed = 0;
  for (size_t i = 0; i < ipc->buffer_len; i++) {
    if (ipc->buffer[i] != '\n') continue;
    ScrStr *line = scr_str_new((const char *)ipc->buffer + consumed, i - consumed);
    ScrDyn *message = scr_json_parse(line);
    scr_str_release(line);
    if (scr_exc_pending()) break;
    scr_ipc_queue_message(ipc, message);
    consumed = i + 1;
  }
  if (consumed > 0) {
    memmove(ipc->buffer, ipc->buffer + consumed, ipc->buffer_len - consumed);
    ipc->buffer_len -= consumed;
  }
  scr_ipc_release(ipc);
}

static void scr_ipc_mark_disconnected(ScrIpc *ipc, bool write_failed,
                                      ScrStr *message) {
  ipc->connected = false;
  ipc->local_closing = false;
  if (write_failed && ipc->send_error == NULL) {
    ipc->send_error = message
        ? scr_str_retain(message)
        : scr_str_new("Channel closed", sizeof("Channel closed") - 1);
  }
  /* A finished writer ignores destroy, but still owns its error listener. */
  scr_ipc_drop_writer_error(ipc);
  scr_child_writer_destroy(ipc->writer);
  ipc->disconnect_pending = true;
}

static void scr_ipc_stream_end(ScrClosure *closure) {
  ScrIpc *ipc = scr_ipc_from_closure(closure);
  ipc->eof_pending = true;
  scr_ipc_release(ipc);
}

static void scr_ipc_writer_error(ScrClosure *closure, ScrStr *message) {
  ScrIpc *ipc = scr_ipc_from_closure(closure);
  ipc->writer_error_cb = NULL; /* writer fire drops its listener registry */
  scr_ipc_mark_disconnected(ipc, true, message);
  scr_ipc_release(ipc);
}

static void scr_ipc_arm(ScrIpc *ipc) {
  if (ipc->armed || ipc->disconnect_emitted) return;
  ipc->armed = true;
  scr_child_stream_on_data(
      ipc->reader, scr_ipc_closure(ipc, (void *)&scr_ipc_stream_data),
      &scr_ipc_stream_data, false);
  scr_child_stream_on_end(
      ipc->reader, scr_ipc_closure(ipc, (void *)&scr_ipc_stream_end), false);
}

static ScrIpc *scr_ipc_new(ScrChildStream *reader, ScrChildWriter *writer) {
  ScrIpc *ipc = calloc(1, sizeof(*ipc));
  if (!ipc) scr_trap("out of memory");
  ipc->rc = 1;
  ipc->als = scr_als_capture();
  ipc->connected = true;
  ipc->reader = reader;
  ipc->writer = writer;
  ipc->registered = true;
  ipc->next = scr_ipcs;
  scr_ipcs = scr_ipc_retain(ipc); /* service-registry reference */
  scr_child_loop_install();
  ipc->writer_error_cb = scr_ipc_closure(ipc, (void *)&scr_ipc_writer_error);
  scr_child_writer_on_error(writer, ipc->writer_error_cb,
                            &scr_ipc_writer_error, false);
  if (!scr_ipc_cleanup_registered) {
    scr_ipc_cleanup_registered = true;
    scr_atexit(scr_ipc_global_cleanup);
  }
  return ipc;
}

static void scr_ipc_register(ScrIpc *ipc) {
  if (ipc->registered) return;
  ipc->registered = true;
  ipc->next = scr_ipcs;
  scr_ipcs = scr_ipc_retain(ipc);
}

static void scr_ipc_add_send(ScrIpc *ipc, ScrClosure *cb, ScrIpcSendFn fn) {
  if (ipc->n_send == ipc->cap_send) {
    ipc->cap_send = ipc->cap_send ? ipc->cap_send * 2 : 2;
    ipc->send_cbs = realloc(ipc->send_cbs, ipc->cap_send * sizeof(*ipc->send_cbs));
    if (!ipc->send_cbs) scr_trap("out of memory");
  }
  ipc->send_cbs[ipc->n_send++] = (ScrIpcSendEntry){cb, fn, scr_als_capture()};
}

static bool scr_ipc_send(ScrIpc *ipc, ScrStr *json, ScrClosure *cb,
                         ScrIpcSendFn fn) {
  if (!ipc || !ipc->connected) {
    if (cb) {
      if (ipc) {
        scr_ipc_add_send(ipc, cb, fn);
        if (ipc->send_error == NULL) {
          ipc->send_error = scr_str_new("Channel closed", sizeof("Channel closed") - 1);
        }
        scr_ipc_register(ipc);
      } else {
        ScrStr *message = scr_str_new("Channel closed", sizeof("Channel closed") - 1);
        ScrError *error = scr_error_new(0, message);
        scr_str_release(message);
        scr_error_set_code(error, "ERR_IPC_CHANNEL_CLOSED");
        fn(cb, error);
        scr_closure_release(cb);
      }
    }
    return false;
  }
  char *framed = malloc(json->len + 1);
  if (!framed) scr_trap("out of memory");
  memcpy(framed, json->data, json->len);
  framed[json->len] = '\n';
  ScrStr *line = scr_str_new(framed, json->len + 1);
  free(framed);
  bool ok = scr_child_writer_write_string(ipc->writer, line);
  scr_str_release(line);
  if (cb) scr_ipc_add_send(ipc, cb, fn);
  return ok;
}

static void scr_ipc_disconnect(ScrIpc *ipc) {
  if (!ipc || !ipc->connected) return;
  ipc->connected = false;
  ipc->local_closing = true;
  scr_child_writer_end(ipc->writer);
}

static void scr_ipc_add_message(ScrIpc *ipc, ScrClosure *cb,
                                ScrIpcMessageFn fn, bool once) {
  if (!ipc || ipc->disconnect_emitted) {
    scr_closure_release(cb);
    return;
  }
  if (ipc->n_message == ipc->cap_message) {
    ipc->cap_message = ipc->cap_message ? ipc->cap_message * 2 : 2;
    ipc->message_ls = realloc(ipc->message_ls, ipc->cap_message * sizeof(*ipc->message_ls));
    if (!ipc->message_ls) scr_trap("out of memory");
  }
  ipc->message_ls[ipc->n_message++] = (ScrIpcMessageEntry){cb, fn, once};
  scr_ipc_arm(ipc);
}

static void scr_ipc_add_disconnect(ScrIpc *ipc, ScrClosure *cb, bool once) {
  if (!ipc || ipc->disconnect_emitted) {
    scr_closure_release(cb);
    return;
  }
  if (ipc->n_disconnect == ipc->cap_disconnect) {
    ipc->cap_disconnect = ipc->cap_disconnect ? ipc->cap_disconnect * 2 : 2;
    ipc->disconnect_ls = realloc(
        ipc->disconnect_ls, ipc->cap_disconnect * sizeof(*ipc->disconnect_ls));
    if (!ipc->disconnect_ls) scr_trap("out of memory");
  }
  ipc->disconnect_ls[ipc->n_disconnect++] = (ScrIpcDisconnectEntry){cb, once};
  scr_ipc_arm(ipc);
}

static void scr_ipc_remove_message_once(ScrIpc *ipc, ScrClosure *cb) {
  for (size_t i = 0; i < ipc->n_message; i++) {
    if (ipc->message_ls[i].cb != cb || !ipc->message_ls[i].once) continue;
    scr_closure_release(ipc->message_ls[i].cb);
    memmove(ipc->message_ls + i, ipc->message_ls + i + 1,
            (ipc->n_message - i - 1) * sizeof(*ipc->message_ls));
    ipc->n_message--;
    return;
  }
}

static void scr_ipc_fire_messages_in(ScrIpc *ipc);

/* 'message' runs in the channel's creation context. */
static void scr_ipc_fire_messages(ScrIpc *ipc) {
  ScrAlsCtx *prev = scr_als_dispatch_enter(ipc->als);
  scr_ipc_fire_messages_in(ipc);
  scr_als_dispatch_leave(prev);
}

static void scr_ipc_fire_messages_in(ScrIpc *ipc) {
  while (ipc->n_pending > 0 && ipc->n_message > 0 && !scr_exc_pending()) {
    ScrDyn *message = ipc->pending[0];
    memmove(ipc->pending, ipc->pending + 1,
            (ipc->n_pending - 1) * sizeof(*ipc->pending));
    ipc->n_pending--;
    size_t count = ipc->n_message;
    ScrIpcMessageEntry *snapshot = malloc(count * sizeof(*snapshot));
    if (!snapshot) scr_trap("out of memory");
    for (size_t i = 0; i < count; i++) {
      snapshot[i] = ipc->message_ls[i];
      scr_closure_retain(snapshot[i].cb);
    }
    for (size_t i = 0; i < count; i++) {
      if (snapshot[i].once) scr_ipc_remove_message_once(ipc, snapshot[i].cb);
      if (!scr_exc_pending()) snapshot[i].fn(snapshot[i].cb, message);
      scr_closure_release(snapshot[i].cb);
    }
    free(snapshot);
    scr_dyn_release(message);
  }
}

static void scr_ipc_fire_send_callbacks(ScrIpc *ipc) {
  bool failed = ipc->send_error != NULL;
  if (!failed && scr_child_writer_pending(ipc->writer)) return;
  size_t count = ipc->n_send;
  if (count == 0) return;
  ScrIpcSendEntry *snapshot = ipc->send_cbs;
  ipc->send_cbs = NULL;
  ipc->n_send = ipc->cap_send = 0;
  for (size_t i = 0; i < count; i++) {
    ScrError *error = NULL;
    if (failed) {
      error = scr_error_new(0, ipc->send_error);
      scr_error_set_code(error, "ERR_IPC_CHANNEL_CLOSED");
    }
    ScrAlsCtx *prev = scr_als_dispatch_enter(snapshot[i].ctx);
    if (!scr_exc_pending()) snapshot[i].fn(snapshot[i].cb, error);
    else scr_error_release(error);
    scr_als_dispatch_leave(prev);
    scr_closure_release(snapshot[i].cb);
    scr_als_ctx_release(snapshot[i].ctx);
  }
  free(snapshot);
  scr_str_release(ipc->send_error);
  ipc->send_error = NULL;
}

static void scr_ipc_fire_disconnect_in(ScrIpc *ipc);

/* 'disconnect' runs in the channel's creation context. */
static void scr_ipc_fire_disconnect(ScrIpc *ipc) {
  ScrAlsCtx *prev = scr_als_dispatch_enter(ipc->als);
  scr_ipc_fire_disconnect_in(ipc);
  scr_als_dispatch_leave(prev);
}

static void scr_ipc_fire_disconnect_in(ScrIpc *ipc) {
  if (!ipc->disconnect_pending || ipc->disconnect_emitted) return;
  ipc->disconnect_pending = false;
  ipc->disconnect_emitted = true;
  size_t count = ipc->n_disconnect;
  ScrIpcDisconnectEntry *snapshot = ipc->disconnect_ls;
  ipc->disconnect_ls = NULL;
  ipc->n_disconnect = ipc->cap_disconnect = 0;
  for (size_t i = 0; i < count; i++) {
    if (!scr_exc_pending()) ((void (*)(ScrClosure *))snapshot[i].cb->fn)(snapshot[i].cb);
    scr_closure_release(snapshot[i].cb);
  }
  free(snapshot);
  for (size_t i = 0; i < ipc->n_message; i++) scr_closure_release(ipc->message_ls[i].cb);
  free(ipc->message_ls);
  ipc->message_ls = NULL;
  ipc->n_message = ipc->cap_message = 0;
  for (size_t i = 0; i < ipc->n_pending; i++) scr_dyn_release(ipc->pending[i]);
  ipc->n_pending = 0;
}

/* Node handles a read's EOF after emitting the messages that read
 * parsed: those handlers still see the channel connected, and one that
 * calls disconnect() closes the channel before the EOF is observed. */
static void scr_ipc_finish_eof(ScrIpc *ipc) {
  if (!ipc->eof_pending || (ipc->n_pending > 0 && ipc->n_message > 0)) return;
  ipc->eof_pending = false;
  if (ipc->local_closing || ipc->closed_locally) return;
  ipc->eof = true;
  scr_ipc_mark_disconnected(ipc, scr_child_writer_pending(ipc->writer), NULL);
}

static void scr_ipc_service_one(ScrIpc *ipc) {
  scr_ipc_fire_send_callbacks(ipc);
  if (!scr_exc_pending()) scr_ipc_fire_messages(ipc);
  if (!scr_exc_pending()) scr_ipc_finish_eof(ipc);
  /* Node's disconnect() closes the channel on the next tick; the written
   * messages are already in the pipe by then. */
  if (!scr_exc_pending() && ipc->local_closing &&
      scr_child_writer_flushed(ipc->writer)) {
    ipc->local_closing = false;
    scr_ipc_drop_writer_error(ipc);
    if (!ipc->eof) ipc->closed_locally = true;
    scr_child_stream_finish(ipc->reader, false);
    ipc->disconnect_pending = true;
  }
  if (!scr_exc_pending()) scr_ipc_fire_disconnect(ipc);
}

static void scr_ipc_service(void) {
  ScrIpc **link = &scr_ipcs;
  while (*link) {
    ScrIpc *ipc = *link;
    scr_ipc_service_one(ipc);
    if (ipc->disconnect_emitted && ipc->n_send == 0) {
      *link = ipc->next;
      ipc->next = NULL;
      ipc->registered = false;
      scr_ipc_release(ipc); /* service-registry reference */
    } else {
      link = &ipc->next;
    }
    if (scr_exc_pending()) return;
  }
}

static bool scr_ipc_pending(void) {
  for (ScrIpc *ipc = scr_ipcs; ipc != NULL; ipc = ipc->next) {
    if (ipc->n_send > 0 || ipc->disconnect_pending || ipc->local_closing ||
        ipc->eof_pending || (ipc->n_pending > 0 && ipc->n_message > 0)) {
      return true;
    }
  }
  return false;
}

/* Messages parsed by this pass's reads, delivered before anything else
 * the pass observes (Node emits them from the read callback itself). */
static void scr_ipc_deliver(void) {
  for (ScrIpc *ipc = scr_ipcs; ipc != NULL && !scr_exc_pending(); ipc = ipc->next) {
    scr_ipc_fire_messages(ipc);
    if (!scr_exc_pending()) scr_ipc_finish_eof(ipc);
  }
}

/* The reaped child's channel: everything it wrote before exiting is
 * readable now, so read it and deliver its messages, and the
 * 'disconnect' an EOF read schedules, before 'exit'. */
static void scr_ipc_settle(ScrIpc *ipc) {
  if (ipc == NULL || !ipc->armed) return;
  scr_child_stream_drain_now(ipc->reader);
  if (!scr_exc_pending()) scr_ipc_service_one(ipc);
}

/* Node's 'close' waits for the channel's EOF read, not for 'disconnect':
 * a child that exited first gets 'close' from the EOF read itself, a tick
 * before 'disconnect'. */
static bool scr_ipc_close_ready(const ScrIpc *ipc) {
  return ipc == NULL || !ipc->armed || ipc->eof || ipc->closed_locally;
}

static bool scr_ipc_close_dropped(const ScrIpc *ipc) {
  return ipc != NULL && (ipc->closed_locally || ipc->local_closing);
}

bool scr_children_ready(void) {
  for (ScrIpc *ipc = scr_ipcs; ipc != NULL; ipc = ipc->next) {
    if (ipc->disconnect_pending || ipc->eof_pending ||
        (ipc->n_pending > 0 && ipc->n_message > 0)) {
      return true;
    }
    bool writer_pending = scr_child_writer_pending(ipc->writer);
    if (ipc->n_send > 0 && (ipc->send_error != NULL || !writer_pending)) {
      return true;
    }
    if (ipc->local_closing && scr_child_writer_flushed(ipc->writer)) return true;
  }
  /* A child writer whose queued bytes all reached the pipe has a listener
   * event ('drain', 'finish', the write's 'error') that only a service
   * pass delivers — no fd wakes the loop for it. */
  return scr_child_writers_ready();
}

double scr_process_fork_target(double target_count) {
  if (scr_process_fork_id != -2) return scr_process_fork_id;
  double target = -1;
  uintptr_t read_handle = 0, write_handle = 0;
  if (!scr_lib_fork_info(&target, &read_handle, &write_handle)) {
    scr_process_fork_id = -1;
    return -1;
  }
  if (!isfinite(target) || target < 0 || trunc(target) != target ||
      target >= target_count) {
    scr_trap("invalid fork target");
  }
#ifdef _WIN32
  ScrChildStream *reader = scr_child_stream_new((HANDLE)read_handle);
  ScrChildWriter *writer = scr_child_writer_new((HANDLE)write_handle);
#else
  ScrChildStream *reader = scr_child_stream_new((int)read_handle);
  ScrChildWriter *writer = scr_child_writer_new((int)write_handle);
#endif
  scr_process_ipc = scr_ipc_new(reader, writer);
  scr_process_fork_id = target;
  return target;
}

/* The child was created with an IPC channel; it keeps it until it is freed. */
bool scr_child_ipc_present(ScrChild *c) {
  SCR_IF_ISLAND(c, return scr_child_island_ops->boolean(c->island, SCR_CHILD_PROP_CHANNEL));
  return c->ipc != NULL;
}

bool scr_child_ipc_connected(ScrChild *c) {
  SCR_IF_ISLAND(c, return scr_child_island_ops->boolean(c->island, SCR_CHILD_PROP_CONNECTED));
  return c->ipc != NULL && c->ipc->connected;
}
bool scr_child_ipc_send(ScrChild *c, ScrStr *json) {
  SCR_IF_ISLAND(c, return scr_child_island_ops->send(c->island, json, NULL, NULL));
  return scr_ipc_send(c->ipc, json, NULL, NULL);
}
bool scr_child_ipc_send_cb(ScrChild *c, ScrStr *json, ScrClosure *cb,
                           ScrIpcSendFn fn) {
  SCR_IF_ISLAND(c, return scr_child_island_ops->send(c->island, json, cb, fn));
  return scr_ipc_send(c->ipc, json, cb, fn);
}
void scr_child_ipc_disconnect(ScrChild *c) {
  SCR_IF_ISLAND(c, scr_child_island_ops->call(c->island, "disconnect"); return);
  scr_ipc_disconnect(c->ipc);
}
void scr_child_ipc_on_message(ScrChild *c, ScrClosure *cb,
                              ScrIpcMessageFn fn, bool once) {
  SCR_IF_ISLAND(c, scr_child_island_ops->on(c->island, SCR_CHILD_EV_MESSAGE, cb, (void *)fn, once); return);
  scr_ipc_add_message(c->ipc, cb, fn, once);
}
void scr_child_ipc_on_disconnect(ScrChild *c, ScrClosure *cb, bool once) {
  SCR_IF_ISLAND(c, scr_child_island_ops->on(c->island, SCR_CHILD_EV_DISCONNECT, cb, NULL, once); return);
  scr_ipc_add_disconnect(c->ipc, cb, once);
}

bool scr_process_ipc_connected(void) {
  return scr_process_ipc != NULL && scr_process_ipc->connected;
}
bool scr_process_ipc_open(void) { return scr_process_ipc != NULL; }
bool scr_process_ipc_send(ScrStr *json) {
  return scr_ipc_send(scr_process_ipc, json, NULL, NULL);
}
bool scr_process_ipc_send_cb(ScrStr *json, ScrClosure *cb,
                             ScrIpcSendFn fn) {
  return scr_ipc_send(scr_process_ipc, json, cb, fn);
}
void scr_process_ipc_disconnect(void) { scr_ipc_disconnect(scr_process_ipc); }
void scr_process_ipc_on_message(ScrClosure *cb, ScrIpcMessageFn fn,
                                bool once) {
  scr_ipc_add_message(scr_process_ipc, cb, fn, once);
}
void scr_process_ipc_on_disconnect(ScrClosure *cb, bool once) {
  scr_ipc_add_disconnect(scr_process_ipc, cb, once);
}

static SCR_TL const ScrChildStreamOps *scr_child_stream_ops;
static SCR_TL ScrDyn *(*scr_child_readable_box)(void *);
static SCR_TL ScrDyn *(*scr_child_writable_box)(void *);

void scr_child_dyn_streams_install(const ScrChildStreamOps *ops,
    ScrDyn *(*readable_box)(void *), ScrDyn *(*writable_box)(void *)) {
  scr_child_stream_ops = ops;
  scr_child_readable_box = readable_box;
  scr_child_writable_box = writable_box;
}

static ScrClosure *scr_child_bridge_callback(void *stream, void *fire) {
  ScrClosure *cb = scr_closure_new(fire, 1);
  cb->caps[0] = scr_box_new_obj(scr_child_stream_ops->retain,
      scr_child_stream_ops->release, scr_child_stream_ops->trace);
  scr_box_set_ref(cb->caps[0], scr_child_stream_ops->retain(stream));
  return cb;
}
static void scr_child_bridge_data(ScrClosure *cb, ScrBytes *chunk) {
  ScrStream *stream = scr_box_get_ref(cb->caps[0]);
  scr_child_stream_ops->push(stream, chunk);
  scr_child_stream_ops->release(stream);
}
static void scr_child_bridge_end(ScrClosure *cb) {
  ScrStream *stream = scr_box_get_ref(cb->caps[0]);
  scr_child_stream_ops->end(stream);
  scr_child_stream_ops->release(stream);
}
static ScrDyn *scr_child_bridge_readable(ScrChildStream *reader, ScrDyn **cached) {
  if (!reader) return scr_dyn_new_null();
  if (!scr_child_stream_ops) {
    static const char message[] = "ChildProcess standard streams require the native stream surface";
    scr_throw_error_msg_code(SCR_ERR_ERROR, message, sizeof message - 1, "SC2020");
    return NULL;
  }
  if (!*cached) {
    ScrStream *stream = scr_child_stream_ops->readable("Socket");
    scr_child_stream_on_data(reader, scr_child_bridge_callback(stream, (void *)scr_child_bridge_data),
        scr_child_bridge_data, false);
    scr_child_stream_on_end(reader, scr_child_bridge_callback(stream, (void *)scr_child_bridge_end), false);
    *cached = scr_child_readable_box(stream);
    scr_child_stream_ops->release(stream);
  }
  return scr_dyn_retain(*cached);
}
static void scr_child_bridge_write_error(ScrClosure *, ScrStr *);
static void scr_child_bridge_final_error(ScrClosure *, ScrStr *);
static void scr_child_bridge_write_drained(ScrClosure *);
static void scr_child_bridge_final_finished(ScrClosure *);

/* Each pending native stream operation owns its callback until the pipe
 * actually drains or closes. Remove the alternate completion listener
 * before finishing the operation, which may synchronously start another. */
static void scr_child_bridge_remove_error(ScrChildWriter *writer, ScrChildErrFn fn) {
  for (size_t i = writer->n_write_err; i > 0; i--) {
    if (writer->err_ls[i - 1].fn != fn) continue;
    scr_closure_release(writer->err_ls[i - 1].cb);
    memmove(writer->err_ls + i - 1, writer->err_ls + i,
        (writer->n_write_err - i) * sizeof *writer->err_ls);
    writer->n_write_err--;
  }
}
static void scr_child_bridge_remove_zero(ScrChildStreamEndL *listeners, size_t *count, void *fn) {
  for (size_t i = *count; i > 0; i--) {
    if (listeners[i - 1].cb->fn != fn) continue;
    scr_closure_release(listeners[i - 1].cb);
    memmove(listeners + i - 1, listeners + i, (*count - i) * sizeof *listeners);
    (*count)--;
  }
}
static ScrClosure *scr_child_bridge_operation(ScrStream *stream, ScrChildWriter *writer, void *fn) {
  ScrClosure *cb = scr_closure_new(fn, 2);
  cb->caps[0] = scr_box_new_obj(scr_child_stream_ops->retain,
      scr_child_stream_ops->release, scr_child_stream_ops->trace);
  cb->caps[1] = scr_box_new_obj(scr_child_writer_retain_v, scr_child_writer_release_v, NULL);
  scr_box_set_ref(cb->caps[0], scr_child_stream_ops->retain(stream));
  scr_box_set_ref(cb->caps[1], scr_child_writer_retain(writer));
  return cb;
}
static void scr_child_bridge_write_drained(ScrClosure *cb) {
  ScrStream *stream = scr_box_get_ref(cb->caps[0]);
  ScrChildWriter *writer = scr_box_get_ref(cb->caps[1]);
  scr_child_bridge_remove_error(writer, scr_child_bridge_write_error);
  scr_child_stream_ops->write_done(stream, NULL);
  scr_child_writer_release(writer);
  scr_child_stream_ops->release(stream);
}
static void scr_child_bridge_final_finished(ScrClosure *cb) {
  ScrStream *stream = scr_box_get_ref(cb->caps[0]);
  ScrChildWriter *writer = scr_box_get_ref(cb->caps[1]);
  scr_child_bridge_remove_error(writer, scr_child_bridge_final_error);
  scr_child_stream_ops->final_done(stream, NULL);
  scr_child_writer_release(writer);
  scr_child_stream_ops->release(stream);
}
static void scr_child_bridge_operation_error(ScrClosure *cb, ScrStr *message, bool final) {
  ScrStream *stream = scr_box_get_ref(cb->caps[0]);
  ScrChildWriter *writer = scr_box_get_ref(cb->caps[1]);
  if (final) scr_child_bridge_remove_zero(writer->finish_ls, &writer->n_finish, (void *)scr_child_bridge_final_finished);
  else scr_child_bridge_remove_zero(writer->drain_ls, &writer->n_drain, (void *)scr_child_bridge_write_drained);
  ScrError *error = scr_error_new(SCR_ERR_ERROR, message);
  if (writer->err_code) scr_error_set_code(error, writer->err_code);
  if (final) scr_child_stream_ops->final_done(stream, error);
  else scr_child_stream_ops->write_done(stream, error);
  scr_child_writer_release(writer);
  scr_child_stream_ops->release(stream);
}
static void scr_child_bridge_write_error(ScrClosure *cb, ScrStr *message) {
  scr_child_bridge_operation_error(cb, message, false);
}
static void scr_child_bridge_final_error(ScrClosure *cb, ScrStr *message) {
  scr_child_bridge_operation_error(cb, message, true);
}
/* The failure the writer is holding, as the bridged stream reports it: the
 * stream's completion takes its own Error (the writer keeps its message for
 * the listeners registered on it). */
static ScrError *scr_child_bridge_failure(ScrChildWriter *writer) {
  ScrError *error = scr_error_new(SCR_ERR_ERROR, writer->err_msg);
  if (writer->err_code) scr_error_set_code(error, writer->err_code);
  return error;
}

/* Takes the writer's pending failure: the bridged stream already completed
 * its write with the error, so the writer has no listener left to answer —
 * a registered listener keeps the failure from becoming the unhandled-
 * 'error' exit. */
static void scr_child_bridge_write_taken(ScrClosure *cb, ScrStr *message) {
  (void)message;
  ScrStream *stream = scr_box_get_ref(cb->caps[0]);
  ScrChildWriter *writer = scr_box_get_ref(cb->caps[1]);
  scr_child_writer_release(writer);
  scr_child_stream_ops->release(stream);
}

static void scr_child_bridge_write(ScrClosure *cb, ScrStream *stream, ScrBytes *chunk) {
  ScrChildWriter *writer = scr_box_get_ref(cb->caps[0]);
  SCR_IF_ISLAND(writer,
                scr_child_island_ops->bridge_write(writer->island, stream, chunk, scr_child_stream_ops);
                scr_child_writer_release(writer); return);
  scr_child_writer_write_bytes(writer, chunk);
  bool pending = scr_child_writer_queued(writer) > 0;
#ifdef _WIN32
  pending = pending || writer->write_pending;
#endif
  if (writer->error_pending || (writer->destroyed && writer->err_msg != NULL)) {
    /* The pipe failed inside this write — a reader that closed its end
     * answers EPIPE at once — or an earlier failure already closed it:
     * Node's write answers false, and the completion callback and the
     * 'error' event wait for a tick, exactly what completing the stream's
     * write with the failure does. */
    scr_child_writer_on_error(writer,
        scr_child_bridge_operation(stream, writer, (void *)scr_child_bridge_write_taken),
        scr_child_bridge_write_taken, true);
    scr_child_stream_ops->write_done(stream, scr_child_bridge_failure(writer));
  } else if (pending) {
    scr_child_writer_on_error(writer,
        scr_child_bridge_operation(stream, writer, (void *)scr_child_bridge_write_error),
        scr_child_bridge_write_error, true);
    writer->need_drain = true;
    scr_child_writer_on_drain(writer,
        scr_child_bridge_operation(stream, writer, (void *)scr_child_bridge_write_drained), true);
  } else scr_child_stream_ops->write_done(stream, NULL);
  scr_child_writer_release(writer);
}
static void scr_child_bridge_final(ScrClosure *cb, ScrStream *stream) {
  ScrChildWriter *writer = scr_box_get_ref(cb->caps[0]);
  SCR_IF_ISLAND(writer, scr_child_island_ops->bridge_final(writer->island, stream, scr_child_stream_ops);
                scr_child_writer_release(writer); return);
  scr_child_writer_on_error(writer,
      scr_child_bridge_operation(stream, writer, (void *)scr_child_bridge_final_error),
      scr_child_bridge_final_error, true);
  scr_child_writer_on_finish(writer,
      scr_child_bridge_operation(stream, writer, (void *)scr_child_bridge_final_finished), true);
  scr_child_writer_end(writer);
  scr_child_writer_release(writer);
}
static ScrClosure *scr_child_writer_bridge_callback(ScrChildWriter *writer, void *fire) {
  ScrClosure *cb = scr_closure_new(fire, 1);
  cb->caps[0] = scr_box_new_obj(scr_child_writer_retain_v, scr_child_writer_release_v, NULL);
  scr_box_set_ref(cb->caps[0], scr_child_writer_retain(writer));
  return cb;
}
static ScrDyn *scr_child_bridge_writable(ScrChildWriter *writer, ScrDyn **cached) {
  if (!writer) return scr_dyn_new_null();
  if (!scr_child_stream_ops) {
    static const char message[] = "ChildProcess standard streams require the native stream surface";
    scr_throw_error_msg_code(SCR_ERR_ERROR, message, sizeof message - 1, "SC2020");
    return NULL;
  }
  if (!*cached) {
    ScrStream *stream = scr_child_stream_ops->writable("Socket",
        scr_child_writer_bridge_callback(writer, (void *)scr_child_bridge_write), scr_child_bridge_write,
        scr_child_writer_bridge_callback(writer, (void *)scr_child_bridge_final), scr_child_bridge_final);
    *cached = scr_child_writable_box(stream);
    scr_child_stream_ops->release(stream);
  }
  return scr_dyn_retain(*cached);
}

/* ── checked-dynamic ChildProcess dispatch ──────────────────────────── */
static void scr_child_dyn_fire(ScrClosure *cb, ScrDyn *const *args, size_t argc) {
  ScrDyn *fn = scr_box_get_ref(cb->caps[0]);
  ScrDyn *self = scr_box_get_ref(cb->caps[1]);
  scr_dyn_this_push_dyn(self);
  ScrDyn *result = scr_dyn_call(fn, args, argc, "child listener");
  scr_dyn_this_pop();
  scr_dyn_release(result);
  scr_dyn_release(self);
  scr_dyn_release(fn);
}

static void scr_child_dyn_spawn(ScrClosure *cb) { scr_child_dyn_fire(cb, NULL, 0); }
static void scr_child_dyn_exit(ScrClosure *cb, bool has_code, double code, const char *signal) {
  ScrDyn *args[2] = { has_code ? scr_dyn_new_num(code) : scr_dyn_new_null(),
    signal ? NULL : scr_dyn_new_null() };
  if (signal) {
    ScrStr *name = scr_str_new(signal, strlen(signal));
    args[1] = scr_dyn_new_str(name);
    scr_str_release(name);
  }
  scr_child_dyn_fire(cb, args, 2);
  scr_dyn_release(args[0]);
  scr_dyn_release(args[1]);
}
static void scr_child_dyn_error(ScrClosure *cb, ScrStr *message) {
  ScrError *error;
  if (scr_event_error_payload != NULL) {
    /* A failed spawn's error object, shared by every listener. */
    error = scr_error_retain(scr_event_error_payload);
  } else {
    error = scr_error_new(SCR_ERR_ERROR, message);
    if (scr_child_err_code) scr_error_set_code(error, scr_child_err_code);
    else if (scr_child_writer_err_code) scr_error_set_code(error, scr_child_writer_err_code);
  }
  ScrDyn *arg = scr_dyn_from_error(error);
  scr_error_release(error);
  scr_child_dyn_fire(cb, &arg, 1);
  scr_dyn_release(arg);
}

static ScrClosure *scr_child_dyn_listener(ScrDyn *fn, ScrDyn *self, void *fire) {
  ScrClosure *cb = scr_closure_new(fire, 2);
  cb->caps[0] = scr_box_new_obj(scr_dyn_retain_v, scr_dyn_release_v, scr_dyn_trace_v);
  cb->caps[1] = scr_box_new_obj(scr_dyn_retain_v, scr_dyn_release_v, scr_dyn_trace_v);
  scr_box_set_ref(cb->caps[0], scr_dyn_retain(fn));
  scr_box_set_ref(cb->caps[1], scr_dyn_retain(self));
  return cb;
}

static bool scr_child_dyn_matches(ScrClosure *cb, void *fire, const ScrDyn *fn) {
  if (cb->fn != fire) return false;
  ScrDyn *listener = scr_box_get_ref(cb->caps[0]);
  bool matches = scr_dyn_strict_eq(listener, fn);
  scr_dyn_release(listener);
  return matches;
}

static ScrDyn *scr_child_dyn_invoke(
    void *h, ScrDyn *self, const char *method,
    ScrDyn *const *args, size_t argc, const char *what) {
  (void)what;
  ScrChild *child = h;
  if (!strcmp(method, "ref") || !strcmp(method, "unref")) {
    if (!strcmp(method, "ref")) scr_child_ref(child); else scr_child_unref(child);
    /* Node's ChildProcess answers undefined here (a socket, a server and
     * a timer answer themselves). */
    return scr_dyn_retain(scr_dyn_undefined());
  }
  if (!strcmp(method, "kill")) {
    const ScrDyn *signal = argc ? args[0] : scr_dyn_undefined();
    bool killed;
    if (signal->kind == SCR_DYN_NUM) killed = scr_child_kill_num(child, signal->v.num);
    else if (signal->kind == SCR_DYN_STR) killed = scr_child_kill(child, signal->v.str);
    else if (signal->kind == SCR_DYN_UNDEF) {
      ScrStr *name = scr_str_new("SIGTERM", 7);
      killed = scr_child_kill(child, name);
      scr_str_release(name);
    } else { scr_dyn_arg_type_fail("signal", "of type string or number", signal); return NULL; }
    return scr_exc_pending() ? NULL : scr_dyn_new_bool(killed);
  }
  bool remove = !strcmp(method, "removeListener") || !strcmp(method, "off");
  if (!strcmp(method, "on") || !strcmp(method, "once") || !strcmp(method, "addListener") || remove) {
    const ScrDyn *event = argc ? args[0] : scr_dyn_undefined();
    ScrDyn *listener = argc > 1 ? args[1] : scr_dyn_undefined();
    if (listener->kind != SCR_DYN_FUNC) scr_dyn_arg_type_fail("listener", "of type function", listener);
    if (scr_exc_pending()) return NULL;
    if (event->kind != SCR_DYN_STR) { scr_dyn_arg_type_fail("event", "of type string", event); return NULL; }
    const ScrStr *name = event->v.str;
    bool spawn = name->len == 5 && !memcmp(name->data, "spawn", 5);
    bool exit = name->len == 4 && !memcmp(name->data, "exit", 4);
    bool close = name->len == 5 && !memcmp(name->data, "close", 5);
    bool error = name->len == 5 && !memcmp(name->data, "error", 5);
    if (spawn || exit || close || error) {
      void *fire = spawn ? (void *)scr_child_dyn_spawn : error ? (void *)scr_child_dyn_error : (void *)scr_child_dyn_exit;
      if (remove) {
        if (spawn) {
          for (size_t i = child->n_spawn; i > 0; i--) if (scr_child_dyn_matches(child->spawn_cbs[i-1], fire, listener)) {
            scr_closure_release(child->spawn_cbs[i-1]);
            memmove(child->spawn_cbs+i-1, child->spawn_cbs+i, (child->n_spawn-i)*sizeof *child->spawn_cbs);
            child->n_spawn--; break;
          }
        } else if (error) {
          for (size_t i = child->n_err; i > 0; i--) if (scr_child_dyn_matches(child->err_cbs[i-1].cb, fire, listener)) {
            scr_closure_release(child->err_cbs[i-1].cb);
            memmove(child->err_cbs+i-1, child->err_cbs+i, (child->n_err-i)*sizeof *child->err_cbs);
            child->n_err--; break;
          }
        } else {
          ScrChildExitEntry *entries = close ? child->close_cbs : child->exit_cbs;
          size_t *count = close ? &child->n_close : &child->n_exit;
          for (size_t i = *count; i > 0; i--) if (scr_child_dyn_matches(entries[i-1].cb, fire, listener)) {
            scr_closure_release(entries[i-1].cb);
            memmove(entries+i-1, entries+i, (*count-i)*sizeof *entries);
            (*count)--; break;
          }
        }
      } else {
        ScrClosure *cb = scr_child_dyn_listener(listener, self, fire);
        if (spawn) scr_child_on_spawn(child, cb);
        else if (error) scr_child_on_error(child, cb, scr_child_dyn_error);
        else if (close) scr_child_on_close(child, cb, scr_child_dyn_exit);
        else scr_child_on_exit(child, cb, scr_child_dyn_exit);
      }
      return scr_dyn_retain(self);
    }
  }
  static const char msg[] = "This ChildProcess method or event has no native lowering";
  scr_throw_error_msg_code(SCR_ERR_ERROR, msg, sizeof msg - 1, "SC2020");
  return NULL;
}

static ScrDyn *scr_child_dyn_get(void *h, const char *key, size_t key_len) {
  ScrChild *child = (ScrChild *)h;
  SCR_IF_ISLAND(child, scr_child_island_ops->stdio(child));
  if (key_len == 6 && !memcmp(key, "stdout", 6)) return scr_child_bridge_readable(child->out_stream, &child->out_dyn);
  if (key_len == 6 && !memcmp(key, "stderr", 6)) return scr_child_bridge_readable(child->err_stream, &child->err_dyn);
  if (key_len == 5 && !memcmp(key, "stdin", 5)) return scr_child_bridge_writable(child->in_stream, &child->in_dyn);
  if (key_len == 6 && memcmp(key, "killed", 6) == 0) {
    return scr_dyn_new_bool(scr_child_killed(child));
  }
  if (key_len == 3 && memcmp(key, "pid", 3) == 0) {
    return scr_child_has_pid(child)
        ? scr_dyn_new_num(scr_child_pid(child))
        : scr_dyn_retain(scr_dyn_undefined());
  }
  if (key_len == 8 && memcmp(key, "exitCode", 8) == 0) {
    return scr_child_has_exit_code(child)
        ? scr_dyn_new_num(scr_child_exit_code(child))
        : scr_dyn_new_null();
  }
  return NULL;
}

static bool scr_child_dyn_set(
    void *h, const char *key, size_t key_len, const ScrDyn *value) {
  (void)h;
  (void)key;
  (void)key_len;
  (void)value;
  return false;
}

static const ScrDynHandleOps scr_child_dyn_ops = {
  "ChildProcess",
  &scr_child_retain_v,
  &scr_child_release_v,
  &scr_child_dyn_invoke,
  &scr_child_dyn_get,
  &scr_child_dyn_set,
  NULL,
};

void scr_child_dyn_install(void) {
  scr_dyn_handle_install(SCR_DYNH_CHILD, &scr_child_dyn_ops);
}

static const ScrLoopChildren scr_child_loop_hooks = {
  &scr_children_pending,
  &scr_children_ready,
  &scr_children_reffed_pending,
  &scr_children_failed_pending,
  &scr_children_poll,
  &scr_children_wait,
  &scr_children_wake_fd,
  &scr_children_teardown,
};

/* Points the loop at the child unit (once per thread, like the
 * registries) when the first child or IPC channel is created. */
static void scr_child_loop_install(void) {
  static SCR_TL bool installed = false;
  if (installed) return;
  installed = true;
  scr_loop_set_children(&scr_child_loop_hooks);
}

void scr_child_on_dyn(ScrChild *child, ScrStr *event, ScrDyn *listener) {
  SCR_IF_ISLAND(child, scr_child_island_ops->on_dyn(child->island, event, listener); return);
  scr_child_dyn_install();
  ScrDyn *self = scr_dyn_new_handle(child, SCR_DYNH_CHILD);
  ScrDyn *name = scr_dyn_new_str(event);
  ScrDyn *args[] = { name, listener };
  ScrDyn *result = scr_child_dyn_invoke(child, self, "on", args, 2, "child listener");
  scr_dyn_release(result);
  scr_dyn_release(name);
  scr_dyn_release(self);
}
