/* scriptc runtime — child_process (scr_child.c). Included by scr_runtime.h,
 * which says where new declarations go. */
#ifndef SCR_CHILD_H
#define SCR_CHILD_H

#include "scr_lib.h"

/* ── child_process (scr_child.c) ─────────────────────────────────────
 * The synchronous slice: spawnSync as posix_spawnp + piped utf8 capture +
 * waitpid — blocks until the child is reaped (no zombie can outlive the
 * call). NEVER throws: spawn failure (nonexistent binary, EACCES) is data
 * — has_status false and empty outputs — like Node's `error` property
 * (Node types stdout/stderr null there; divergence in SEMANTICS.md).
 * A signal-killed child also has no status (Node's status: null). */
typedef struct ScrSpawnRes ScrSpawnRes;

ScrSpawnRes *scr_spawn_sync(ScrStr *cmd, ScrArr *args); /* +1, never throws */
/* The options form (cp.spawnSyncOpts): timeout_ms > 0 sends killsignal
 * (a signal NAME; "" = SIGTERM) at the deadline and the result carries
 * error: ETIMEDOUT + the signal — never a throw. stdio modes: stdin 0 =
 * /dev/null, 2 = inherit; stdout/stderr 0 = capture, 1 = ignore, 2 =
 * inherit (non-captured outputs read "" — the documented stance). */
ScrSpawnRes *scr_spawn_sync_opts(ScrStr *cmd, ScrArr *args, double timeout_ms,
                                  ScrStr *killsignal, double in_mode,
                                  double out_mode, double err_mode);
/* scr_spawn_sync_opts with an `env` option: [k,v,...] pairs replace the
 * child's environment (NULL inherits the parent's). */
ScrSpawnRes *scr_spawn_sync_env(ScrStr *cmd, ScrArr *args, double timeout_ms,
                                ScrStr *killsignal, double in_mode, double out_mode,
                                double err_mode, ScrArr *env_pairs);
/* The runtime-string stdio entry: the compiler proved the value is
 * "pipe" | "ignore" | "inherit" by type; the mode mapping happens here. */
ScrSpawnRes *scr_spawn_sync_stdio_str(ScrStr *cmd, ScrArr *args, double timeout_ms,
                                       ScrStr *killsignal, ScrStr *stdio);
/* execFileSync/execSync behind one entry: posix_spawn(p) + piped utf8
 * capture + waitpid with Node's exact error shapes — non-zero exit or
 * signal death throws Error("Command failed: <cmd>[\n<stderr>]"), spawn
 * failure throws "spawnSync <file> ENOENT", a timeout SIGTERMs the child
 * and throws "spawnSync <file> ETIMEDOUT" (messages only — Node's
 * status/stdout/stderr error properties don't exist, SEMANTICS.md).
 * shell=true runs /bin/sh -c (args must be ["-c", cmd]); has_input false
 * means the input option is ABSENT (stdin from /dev/null — Node's model
 * for an undefined member), true feeds the bytes to a stdin pipe ("" is
 * the pipe with immediate EOF); cwd "" inherits; has_env false inherits
 * environ, true REPLACES it with the [k,v,...] pairs; timeout_ms <= 0
 * disables; stdout_mode 1 captures / 0 ignores / 2 inherits the parent's
 * fd, plus bit 4 = the CHILD'S STDIN inherits (stdio "inherit"; the
 * flag rides stdout_mode because the signature predates it); stderr_mode
 * 0 captures AND echoes to the parent stderr after completion (Node's
 * no-stdio-option default), 1 captures only, 2 ignores, 3 inherits.
 * Result is the captured utf8 stdout (+1) — "" when nothing captures
 * (Node answers null there; discarded results cannot tell). A failure's
 * error carries Node's status, signal, output, pid, stdout and stderr;
 * `buffers` (no encoding option) makes those outputs Buffers. All args
 * borrowed. */
ScrStr *scr_exec_sync(ScrStr *cmd, ScrArr *args, bool shell, ScrStr *input,
                       bool has_input, ScrStr *cwd, bool has_env, ScrArr *env_pairs,
                       double timeout_ms, double stdout_mode, double stderr_mode,
                       bool buffers);
/* The promisified-execFile/exec capture (cp.execCapture; shell as for
 * scr_exec_sync — the /bin/sh -c argv): the same core in the
 * async shape — both streams captured (no echo), Node's ASYNC error
 * messages on the throw paths ("Command failed: <cmd>\n<stderr>" with the
 * unconditional newline, "spawn <file> <ERR>" with .code, timeouts as
 * ordinary SIGTERM command failures), each error with Node's code, killed,
 * signal, cmd, stdout and stderr properties. +1 ScrSpawnRes on success
 * (stdout + stderr; status unused). All args borrowed. */
ScrSpawnRes *scr_exec_capture(ScrStr *cmd, ScrArr *args, bool shell, ScrStr *cwd,
                               bool has_env, ScrArr *env_pairs, double timeout_ms);
ScrSpawnRes *scr_spawn_res_retain(ScrSpawnRes *r);
void scr_spawn_res_release(ScrSpawnRes *r);
void *scr_spawn_res_retain_v(void *p);
void scr_spawn_res_release_v(void *p);
bool scr_spawn_res_has_status(ScrSpawnRes *r);
double scr_spawn_res_status(ScrSpawnRes *r);
ScrStr *scr_spawn_res_stdout(ScrSpawnRes *r); /* +1 */
ScrStr *scr_spawn_res_stderr(ScrSpawnRes *r); /* +1 */
/* result.signal — the termination signal's name when a signal killed the
 * child (a timeout's killSignal included), the null arm otherwise; the
 * emitter wraps type-directedly over the has/get pair like status. */
bool scr_spawn_res_has_signal(ScrSpawnRes *r);
ScrStr *scr_spawn_res_signal(ScrSpawnRes *r); /* +1; has_signal only */
/* Node's `error` property: +1 %Error ("spawnSync <file> ENOENT", `code`
 * stamped) when the spawn itself failed, NULL otherwise (the undefined
 * arm — the emitter wraps type-directedly, the envGet convention). */
ScrError *scr_spawn_res_error(ScrSpawnRes *r);

/* argv construction shared by spawnSync and spawn: a NULL-terminated
 * vector borrowing the strings (alive while cmd/args are); free() the
 * vector only. */
char **scr_child_argv(ScrStr *cmd, ScrArr *args);

/* The asynchronous child: spawn starts it immediately (stdio all on
 * /dev/null — the compiler fences everything but { stdio: "ignore" })
 * and registers it with the event loop, which sweeps waitpid(WNOHANG) at
 * quiescence (scr_children_poll) and fires listeners at reap; between
 * turns the loop's sleep waits on a kqueue PROC filter, so an exit wakes
 * it immediately (scr_children_wait; ~1ms polling is the fallback). "exit"
 * fires once with the code (or none — signal death → the null arm);
 * "error" fires ONLY for spawn failure, and with no listener registered
 * it prints the error and exits 1 (Node's unhandled-'error' behavior).
 * Listener callbacks MOVE in and are released when the child settles; a
 * listener registered after settling is released and never fires. The
 * adapters bridge the runtime's fixed firing ABI to the callback's
 * compiled shape: exit_thunk0/err_thunk0 ignore the payload (zero-param
 * listeners), err_thunk_error constructs the %Error instance, and the
 * `(code: number | null)` shape is compiler-emitted (union tags are
 * program data). */
typedef struct ScrChild ScrChild;
/* A piped child-output stream (child.stdout / child.stderr — stdio mode
 * 3): refcounted like the child; 'data' fires one Buffer chunk per
 * read(2) (≤64KB, consumer-driven — no listener, no read: the pipe is
 * the buffer), 'end' fires once at EOF and always BEFORE the child's
 * own 'exit' (Node's pinned ordering; the settle path drains first). A
 * flowing stream (data consumer, not yet EOF) keeps the loop alive. */
typedef struct ScrChildStream ScrChildStream;
/* A piped child-input writer (child.stdin — stdio mode 3 on fd 0).
 * write copies borrowed string/bytes data into a nonblocking queue and
 * returns false once buffered data reaches the stream high-water mark;
 * drain fires when that queue empties. end closes after queued data and
 * then fires finish; destroy closes immediately without finish. Errors
 * are asynchronous and use the child error adapters. */
typedef struct ScrChildWriter ScrChildWriter;
/* The data adapter: the chunk arrives BORROWED (multiple listeners see
 * the same chunk); adapters retain what they keep. */
typedef void (*ScrChildStreamDataFn)(ScrClosure *cb, ScrBytes *chunk);
typedef void (*ScrChildStreamDataStrFn)(ScrClosure *cb, ScrStr *chunk);
/* signal_name: the termination signal's name (static storage) when a
 * signal killed the child, NULL otherwise — Node's second exit-listener
 * parameter; zero/one-param adapters ignore it. */
typedef void (*ScrChildExitFn)(ScrClosure *cb, bool has_code, double code,
                               const char *signal_name);
typedef void (*ScrChildErrFn)(ScrClosure *cb, ScrStr *msg);
/* execFile's fixed runtime firing ABI. error/stdout/stderr arrive as +1
 * values and MOVE through the compiler-emitted adapter into the callback
 * (or are released there when the callback omits a suffix). */
typedef void (*ScrExecFileFn)(ScrClosure *cb, ScrError *error,
                              ScrStr *stdout_value, ScrStr *stderr_value);
/* JSON IPC callback ABIs. Message values are borrowed checked-dynamic
 * trees; send errors are +1 and move through the adapter (NULL = success). */
typedef void (*ScrIpcMessageFn)(ScrClosure *cb, ScrDyn *message);
typedef void (*ScrIpcSendFn)(ScrClosure *cb, ScrError *error);

ScrChild *scr_spawn(ScrStr *cmd, ScrArr *args); /* +1, never throws */
ScrChild *scr_fork(double target, ScrArr *args, double in_mode,
                   double out_mode, double err_mode, bool has_env,
                   ScrArr *env_pairs, ScrStr *cwd); /* +1 */
/* The options form (cp.spawnOpts): PER-SLOT stdio modes — 0 = ignore
 * (/dev/null), 1 = inherit, 2 = fd (out/err only: out_fd/err_fd dup2
 * into the child's slot, the openSync daemon-log idiom), 3 = pipe
 * (stdin's write end becomes child.stdin; out/err read ends become the
 * child.stdout/stderr streams);
 * detached = POSIX_SPAWN_SETSID (own session/process group); shell runs
 * the complete command through /bin/sh -c or cmd.exe /d /s /c; env
 * REPLACES the child environment when has_env ([k,v,...] pairs); cwd ""
 * = inherit. */
ScrChild *scr_spawn_opts(ScrStr *cmd, ScrArr *args, double in_mode,
                          double out_mode, double err_mode, double out_fd,
                          double err_fd, bool detached, bool shell, bool has_env,
                         ScrArr *env_pairs, ScrStr *cwd);
/* Runtime options use the same spawn core; validation and explicit
 * unsupported-option refusals throw before starting a child. Borrows. */
ScrChild *scr_spawn_dynamic(ScrStr *cmd, ScrArr *args, const ScrDyn *options);
void scr_child_on_spawn(ScrChild *child, ScrClosure *cb); /* moves zero-argument callback */
/* The callback slice: file + args, default options. The returned child has
 * all three stdio slots piped; stdout/stderr are captured internally and
 * the callback moves into the child registry until settlement. With shell
 * (exec), args is ["-c", command] for /bin/sh and failure messages show
 * the command, as for scr_exec_sync. */
ScrChild *scr_exec_file(ScrStr *cmd, ScrArr *args, ScrClosure *cb /*moves*/,
                        ScrExecFileFn fn, bool shell);
ScrChild *scr_child_retain(ScrChild *c);
void scr_child_release(ScrChild *c);
void *scr_child_retain_v(void *p);
void scr_child_release_v(void *p);
void scr_child_on_exit(ScrChild *c, ScrClosure *cb /*moves*/, ScrChildExitFn fn);
void scr_child_on_close(ScrChild *c, ScrClosure *cb /*moves*/, ScrChildExitFn fn);
void scr_child_on_error(ScrChild *c, ScrClosure *cb /*moves*/, ScrChildErrFn fn);
bool scr_child_ipc_present(ScrChild *c);
bool scr_child_ipc_connected(ScrChild *c);
bool scr_child_ipc_send(ScrChild *c, ScrStr *json);
bool scr_child_ipc_send_cb(ScrChild *c, ScrStr *json,
                           ScrClosure *cb /*moves*/, ScrIpcSendFn fn);
void scr_child_ipc_disconnect(ScrChild *c);
void scr_child_ipc_on_message(ScrChild *c, ScrClosure *cb /*moves*/,
                              ScrIpcMessageFn fn, bool once);
void scr_child_ipc_on_disconnect(ScrChild *c, ScrClosure *cb /*moves*/,
                                 bool once);
double scr_process_fork_target(double target_count);
bool scr_process_ipc_connected(void);
/* Whether this fork child opened its channel (process.send's presence in
 * a program with fork targets; disconnecting keeps it). */
bool scr_process_ipc_open(void);
bool scr_process_ipc_send(ScrStr *json);
bool scr_process_ipc_send_cb(ScrStr *json, ScrClosure *cb /*moves*/,
                             ScrIpcSendFn fn);
void scr_process_ipc_disconnect(void);
void scr_process_ipc_on_message(ScrClosure *cb /*moves*/,
                                ScrIpcMessageFn fn, bool once);
void scr_process_ipc_on_disconnect(ScrClosure *cb /*moves*/, bool once);
void scr_child_exit_thunk0(ScrClosure *cb, bool has_code, double code,
                            const char *signal_name);
void scr_child_err_thunk0(ScrClosure *cb, ScrStr *msg);
void scr_child_err_thunk_error(ScrClosure *cb, ScrStr *msg);
/* The stream surface: child.stdout/stderr answer +1 handles (NULL when
 * the slot was not piped — Node's null); listeners MOVE in and release
 * at EOF/exit-cleanup (post-'end' registrations release immediately and
 * never fire, the stdin rule). The runtime-provided data adapters cover
 * zero-param, Buffer, and string shapes; setEncoding uses the shared
 * StringDecoder core so split multibyte sequences remain intact.
 * Union-param listeners get compiler-emitted Buffer adapters. */
ScrChildStream *scr_child_stream_retain(ScrChildStream *s);
void scr_child_stream_release(ScrChildStream *s);
void *scr_child_stream_retain_v(void *p);
void scr_child_stream_release_v(void *p);
ScrChildStream *scr_child_stdout(ScrChild *c); /* +1, or NULL */
ScrChildStream *scr_child_stderr(ScrChild *c); /* +1, or NULL */
void scr_child_stream_on_data(ScrChildStream *s, ScrClosure *cb /*moves*/,
                               ScrChildStreamDataFn fn, bool once);
void scr_child_stream_on_data_str(ScrChildStream *s, ScrClosure *cb /*moves*/,
                                   ScrChildStreamDataStrFn fn, bool once);
void scr_child_stream_on_end(ScrChildStream *s, ScrClosure *cb /*moves*/, bool once);
ScrChildStream *scr_child_stream_set_encoding(ScrChildStream *s, ScrStr *enc); /* +1 */
void scr_child_stream_thunk0(ScrClosure *cb, ScrBytes *chunk);
void scr_child_stream_thunk_bytes(ScrClosure *cb, ScrBytes *chunk);
void scr_child_stream_thunk_str(ScrClosure *cb, ScrStr *chunk);
ScrChildWriter *scr_child_writer_retain(ScrChildWriter *w);
void scr_child_writer_release(ScrChildWriter *w);
void *scr_child_writer_retain_v(void *p);
void scr_child_writer_release_v(void *p);
ScrChildWriter *scr_child_stdin(ScrChild *c); /* +1, or NULL */
bool scr_child_writer_write_string(ScrChildWriter *w, const ScrStr *data);
bool scr_child_writer_write_bytes(ScrChildWriter *w, const ScrBytes *data);
void scr_child_writer_end(ScrChildWriter *w);
void scr_child_writer_destroy(ScrChildWriter *w);
bool scr_child_writer_writable(ScrChildWriter *w);
void scr_child_writer_on_drain(ScrChildWriter *w, ScrClosure *cb /*moves*/, bool once);
void scr_child_writer_on_finish(ScrChildWriter *w, ScrClosure *cb /*moves*/, bool once);
void scr_child_writer_on_error(ScrChildWriter *w, ScrClosure *cb /*moves*/,
                               ScrChildErrFn fn, bool once);
/* The lifecycle members, Node's exact shapes (pinned by the corpus):
 * pid is undefined (has_pid false) exactly on spawn failure; exitCode is
 * null while running / after a signal death, the code after a normal
 * exit, -errno once a spawn failure settled; killed flips on any
 * successful kill() send (signal 0 included); kill answers false after
 * the reap or on spawn failure and throws the Unknown-signal TypeError
 * on bad names (may-throw); unref() drops the child from the loop's
 * keep-alive set (reffed_pending is the loop's liveness half; teardown
 * releases whatever the loop never reaped so the RC audit stays clean). */
bool scr_child_has_pid(ScrChild *c);
double scr_child_pid(ScrChild *c);
bool scr_child_has_exit_code(ScrChild *c);
double scr_child_exit_code(ScrChild *c);
bool scr_child_killed(ScrChild *c);
bool scr_child_kill(ScrChild *c, const ScrStr *signal);
bool scr_child_kill_num(ScrChild *c, double signum);
void scr_child_unref(ScrChild *c);
void scr_child_ref(ScrChild *c);
/* Installs ChildProcess's checked-dynamic handle identity bridge. Emitted
 * programs call this only when the child_process surface is present. */
void scr_child_dyn_install(void);
void scr_child_on_dyn(ScrChild *child, ScrStr *event, ScrDyn *listener); /* borrowed */
/* Own properties JavaScript adds to a child (scr_dyn_handle_props.c,
 * linked only by programs that add them). */
void scr_dyn_handle_props_install(void);
ScrDyn *scr_dyn_define_property_hp(ScrDyn *target, ScrDyn *key, ScrDyn *descriptor);
ScrDyn *scr_dyn_get_own_property_descriptor_hp(ScrDyn *target, ScrDyn *key);
ScrPromise *scr_dyn_promise_resolve_hp(ScrDyn *value, ScrDyn *reader);
void scr_child_on_dyn_hp(ScrChild *child, ScrStr *event, ScrDyn *listener);
/* Optional native-stream bridge. The table avoids a stream dependency
 * in programs that only use the child-process surface. */
/* readable/writable take the stream's class name (the constructor name
 * Node reports: Socket for child stdio, ReadableWorkerStdio and
 * WritableWorkerStdio for worker stdio). */
typedef struct ScrChildStreamOps {
  ScrStream *(*readable)(const char *cls);
  ScrStream *(*writable)(const char *cls, ScrClosure *, ScrStreamChunkInv, ScrClosure *,
      ScrStreamPlainInv);
  void *(*retain)(void *);
  void (*release)(void *);
  ScrTraceFn trace;
  bool (*push)(ScrStream *, ScrBytes *);
  bool (*end)(ScrStream *);
  void (*write_done)(ScrStream *, ScrError *);
  void (*final_done)(ScrStream *, ScrError *);
} ScrChildStreamOps;
extern const ScrChildStreamOps scr_stream_child_ops;
ScrDyn *scr_stream_dyn_view(ScrStream *stream); /* borrowed; +1 live method/property view */
void scr_child_dyn_streams_install(const ScrChildStreamOps *ops,
    ScrDyn *(*readable_box)(void *), ScrDyn *(*writable_box)(void *));
bool scr_children_reffed_pending(void);
void scr_children_teardown(void);
/* Node's signal-name table (scr_lib.c), shared with child.kill: the
 * resolved signal number, or -1 for names outside the table. */
int scr_signal_from_name(const ScrStr *signal);
/* The reverse walk (spawnSync's result.signal): Node's spelling for the
 * host number, NULL outside the table. Static storage. */
const char *scr_signal_name(int sig);
/* The loop's half: pending() joins the exhaustion test (a live child
 * keeps the process alive, like Node); poll() reaps and fires. wait()
 * takes the loop's quiescent sleep while children are pending — it blocks
 * on the child watch (kqueue on BSD, pidfd epoll on Linux) up to
 * max_wait_ms (the next timer deadline), so a
 * child's NOTE_EXIT wakes the loop immediately; it returns false (and the
 * loop falls back to the ~1ms polling cap) when it can't wake for every
 * pending child: non-kqueue platforms, spawn failures awaiting their
 * first-pass settle, or a child whose exit filter could not be armed. */
bool scr_children_pending(void);
/* Work already queued in userspace: dispatch can progress without another
 * pipe/exit notification. Connected channels and blocked writes are not ready. */
bool scr_children_ready(void);
bool scr_children_failed_pending(void);
void scr_children_poll(void);
bool scr_children_wait(double max_wait_ms);
/* The loop reaches the functions above through this table. The child
 * unit installs it with the first spawned child or IPC channel, so
 * programs that never create either do not link the unit. */
typedef struct ScrLoopChildren {
  bool (*pending)(void);
  bool (*ready)(void);
  bool (*reffed_pending)(void);
  bool (*failed_pending)(void);
  void (*poll)(void);
  bool (*wait)(double max_wait_ms);
  int (*wake_fd)(void);
  void (*teardown)(void);
} ScrLoopChildren;
void scr_loop_set_children(const ScrLoopChildren *hooks);

#endif /* SCR_CHILD_H */
