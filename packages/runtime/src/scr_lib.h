/* scriptc runtime — the standard library: process, modules, performance
 * timing and node:fs (scr_lib.c). Included by scr_runtime.h, which says where
 * new declarations go. */
#ifndef SCR_LIB_H
#define SCR_LIB_H

#include "scr_exception.h"

/* ── standard library: process + node:fs (scr_lib.c) ─────────────────
 * Called once at the top of main, right after scr_init: stashes argc/argv
 * (the interned process.argv array is built lazily on first read) and
 * registers an atexit cleanup that releases the library's interned values
 * BEFORE the RC audit runs (atexit is LIFO; scr_init registered the audit
 * earlier). scriptc argv shape: ["scriptc", argv[0], argv[1], ...] so
 * positions and length line up with Node's [node-path, script-path, ...args]
 * — the argv[0]/argv[1] VALUES diverge (see SEMANTICS.md).
 */
void scr_lib_init(int argc, char **argv);

/* +1 on the ONE interned argv array (identity and mutation semantics match
 * Node's stable process.argv). */
ScrArr *scr_process_argv(void);

/* CommonJS module graph introspection. Module values are process-lifetime
 * numeric handles into a registry populated by the generated program before
 * its entry initializer runs. Metadata arguments are borrowed; getters return
 * owned (+1) strings/arrays. Negative parent handles distinguish null (-1)
 * from undefined (-2); a cache miss is -1. */
void scr_module_registry_init(double count);
void scr_module_define(double module_id, ScrStr *filename, ScrStr *id,
                       ScrStr *path, ScrArr *paths, bool is_main);
void scr_module_enter(double module_id);
void scr_module_link(double parent_id, double child_id);
void scr_module_finish(double module_id);
void scr_module_fail(double module_id);
ScrStr *scr_module_filename(double module_id);
ScrStr *scr_module_id(double module_id);
ScrStr *scr_module_path(double module_id);
ScrArr *scr_module_paths(double module_id);
ScrArr *scr_module_children(double module_id);
double scr_module_parent(double module_id);
bool scr_module_loaded(double module_id);
double scr_module_cache_get(ScrStr *filename);
bool scr_module_cache_has(ScrStr *filename);
ScrArr *scr_module_cache_keys(void);

int scr_lib_arg_count(void);
const char *scr_lib_arg(int i);
/* Private self-reexec marker parsed and removed from process.argv by
 * scr_lib_init. False in an ordinary parent invocation. */
bool scr_lib_fork_info(double *target, uintptr_t *read_handle,
                       uintptr_t *write_handle);
/* True only for a child_process call whose command and first argument both
 * resolve to this executable — Node's process.execPath/process.argv[1]
 * self-reexec shape. Child argv builders collapse that known script marker;
 * direct startup never filters user arguments. */
bool scr_lib_should_collapse_reexec_arg(ScrStr *cmd, ScrArr *args);
ScrStr *scr_process_platform(void); /* +1 interned ("darwin", "linux", ...) */
ScrStr *scr_process_cwd(void);      /* +1 fresh (getcwd) */

bool scr_stdio_write(int fd, const void *data, size_t len);
bool scr_stdio_write_str(int fd, const ScrStr *s);
int scr_stdio_write_raw(int fd, const void *data, size_t len);
/* `wide` marks string bytes that may hold lone surrogates, which become
 * U+FFFD when they reach the stream itself. */
extern SCR_TL bool (*scr_stdio_write_hook)(int fd, const void *data, size_t len, bool wide);
/* A worker created with the stdout or stderr option: answers true when it
 * took the bytes for fd 1 or 2 instead of the process descriptor. */
extern SCR_TL bool (*scr_stdio_capture)(int fd, const void *data, size_t len);
/* A worker created with the stdin option: process.stdin reads the chunks
 * the parent writes to worker.stdin instead of fd 0. The worker's event
 * dispatch queues them (scr_stdin_fed_push; NULL ends the input) and the
 * stdin service takes them (+1, or NULL with *ended set once the input
 * ended). scr_stdin_fed_attach (the worker unit) starts that dispatch
 * when process.stdin is first used; scr_stdin_fed_waiting (the events
 * unit) says whether process.stdin still wants data, which keeps the
 * worker's loop waiting on its mailbox. */
extern SCR_TL bool scr_stdin_fed;
extern SCR_TL void (*scr_stdin_fed_attach)(void);
extern SCR_TL bool (*scr_stdin_fed_waiting)(void);
void scr_stdin_fed_push(struct ScrBytes *chunk /* moves; NULL ends the input */);
struct ScrBytes *scr_stdin_fed_take(bool *ended);
void scr_stdin_fed_clear(void);
/* process.stdout/.stderr .write — raw bytes (no newline or formatting; data
 * borrowed), promptly visible and ordered with console output. Constantly
 * true (the synchronous runtime never queues backpressure). */
bool scr_process_stdout_write(const ScrStr *data);
bool scr_process_stderr_write(const ScrStr *data);
/* The first-class WritableStream write: fd is the stream value itself
 * (1 = stdout, 2 = stderr — process.stdout/stderr reads mint it). */
bool scr_proc_stream_write(double fd, const ScrStr *data);
/* getenv(3) behind process.env.<NAME>: +1 fresh string when the variable is
 * set, NULL when absent. The compiler wraps the result into the interned
 * `string | undefined` union type-directedly (the runtime knows no tags);
 * the name is borrowed. Never throws. */
ScrStr *scr_env_get(const ScrStr *name);
/* setenv(3) behind process.env.NAME = v: later env reads and spawned
 * children observe the write, like Node. Both borrowed. Never throws. */
void scr_env_set(const ScrStr *name, const ScrStr *value);
void scr_env_unset(const ScrStr *name); /* delete process.env.NAME */
/* NODE_DEBUG as the process started (NULL when unset), for util.debuglog. */
const char *scr_node_debug_initial(void);
/* The whole environment as alternating [k, v, k, v, ...] strings in
 * environ order — the compiler's process.env snapshot builds its record
 * from this. +1 fresh array. Never throws. */
ScrArr *scr_env_pairs(void);
/* getpid(2) / getuid(2) — POSIX-only target, always answer. */
double scr_process_pid(void);
double scr_process_getuid(void);
double scr_process_getgid(void);
/* process.execPath: the running binary's own resolved absolute path
 * (_NSGetExecutablePath/readlink(/proc/self/exe) + realpath), interned on
 * first read; +1 per read. Node's value is the node executable's path —
 * SEMANTICS.md divergence 12 documents the difference. */
ScrStr *scr_process_exec_path(void);
/* process.arch: the binary's OWN architecture ("arm64", "x64") — Node's
 * answer for its own build on the same machine. +1 interned. */
ScrStr *scr_process_arch(void);
/* process.versions.node: the runtime's Node COMPATIBILITY TARGET — no
 * Node exists under a compiled binary, so this reports the version whose
 * semantics the runtime implements (SEMANTICS.md divergence 60). +1
 * interned. */
ScrStr *scr_process_versions_node(void);
ScrStr *scr_process_versions_openssl(void);
/* Stable native version dictionary (+1); node/openssl are compatibility
 * targets, matching the scalar getters above. */
ScrDyn *scr_process_versions(void);
/* process.kill with Node's exact semantics: int32 pid validation (the
 * ERR_INVALID_ARG_TYPE TypeError text), Node's signal-name table for the
 * named form (unknown names throw the ERR_UNKNOWN_SIGNAL TypeError),
 * signal 0 probes, kill(2) failure throws Node's `kill ESRCH`/`kill
 * EPERM` Error. Both return Node's constant true; the signal string is
 * borrowed. */
bool scr_process_kill(double pid, double signum);
bool scr_process_kill_named(double pid, const ScrStr *signal);
/* fflush stdout, then _Exit((int)code): no atexit handlers run — the RC
 * audit is deliberately skipped (exiting mid-program leaves live values). */
void scr_process_exit(double code);
/* Nonzero hands the address-space teardown after scr_process_exit to a
 * helper process (Linux, `--detached-exit`). scr_lib.c defines a weak 0;
 * the program object of such an executable defines it as 1. */
extern const unsigned char scr_detached_exit;
void scr_process_set_exit_code(double code);
double scr_process_exit_code_or_zero(void);
/* process._exiting: true once the exit sequence began (process.exit or
 * the exit-listener runner set the flag). Never throws. */
extern SCR_TL bool scr_process_in_exit;
bool scr_process_exiting(void);
/* umask(2): mask < 0 reads without setting; otherwise sets and answers
 * the previous mask. Never throws. */
double scr_process_umask(double mask);
/* The process introspection statics (scr_lib.c; Node's units). uptime:
 * fractional seconds since the binary's load-time anchor. The CPU clocks
 * answer microseconds; the *_diff forms subtract a prior sample, and
 * scr_cpu_prev_validate throws Node's ERR_INVALID_ARG_VALUE RangeError
 * (user first, then system) for negative/non-finite prev fields.
 * rusage(idx) answers one resourceUsage() field by canonical index.
 * available/constrained memory are libuv's numbers (0 where the platform
 * has no answer). scr_active_resources (scr_async.c) walks the loop's
 * own bookkeeping — 'Timeout'/'Immediate' strings, +1. */
double scr_process_uptime(void);
/* perf_hooks performance.now(): fractional ms since process start (the
 * uptime anchor — Node's timeOrigin for a compiled program). */
double scr_perf_now(void);
/* perf_hooks user timing (scr_perf.c): mark, measure, the getEntries
 * family and the clears take the call's dyn argument vector (borrowed)
 * and apply Node's validation and errors. mark and measure answer 1 and
 * the getters the entry count; the answered entries stay readable through
 * the scr_perf_entry_* accessors (index into the answer) until the next
 * timeline call. which: 0 getEntries, 1 getEntriesByName, 2
 * getEntriesByType. Accessor results are +1. */
double scr_perf_mark(ScrDyn *args);
double scr_perf_measure(ScrDyn *args);
double scr_perf_entries(ScrDyn *args, double which);
void scr_perf_clear_marks(ScrDyn *args);
void scr_perf_clear_measures(ScrDyn *args);
ScrStr *scr_perf_entry_name(double i);
ScrStr *scr_perf_entry_type(double i);
double scr_perf_entry_start(double i);
double scr_perf_entry_duration(double i);
ScrDyn *scr_perf_entry_detail(double i);
/* The entry objects themselves: entry_keep stores the program's object
 * for the last mark or measure (borrowed, retained), entry_ref answers
 * entry i's stored object (+1), so the getters return the same objects
 * mark() and measure() did. */
void scr_perf_entry_keep(ScrDyn *ref);
ScrDyn *scr_perf_entry_ref(double i);
uint64_t scr_hrtime_ns(void);
ScrDyn *scr_process_hrtime_value(void);
double scr_cpu_user(void);
double scr_cpu_system(void);
double scr_cpu_user_diff(double prev);
double scr_cpu_system_diff(double prev);
double scr_thread_cpu_user(void);
double scr_thread_cpu_system(void);
double scr_thread_cpu_user_diff(double prev);
double scr_thread_cpu_system_diff(double prev);
void scr_cpu_prev_validate(double user, double system);
double scr_process_rusage(double idx);
double scr_available_memory(void);
double scr_constrained_memory(void);
/* process.memoryUsage(): take samples rss and the runtime heap once;
 * field(k) reads that sample (k: 0 rss, 1 heapTotal, 2 heapUsed,
 * 3 external, 4 arrayBuffers). heapTotal is the bytes the runtime heap
 * holds from the system, heapUsed the bytes in live allocations, and
 * external/arrayBuffers are 0 (byte storage lives in the same heap).
 * memoryUsage.rss() is the resident set alone. An unreadable resident
 * set throws Node's uv_resident_set_memory error. */
void scr_process_memory_usage_take(void);
double scr_process_memory_usage_field(double k);
double scr_process_rss(void);
/* The runtime heap's footprint (scr_alloc.c): bytes held from the system
 * and bytes in live allocations, for the calling thread's allocator plus
 * the system allocator where it reports them. */
void scr_heap_stats(double *total, double *used);
/* process.ppid: the parent's pid at the time of the read. */
double scr_process_ppid(void);
/* process.title: libuv's process title — argv[0] until set; a set
 * truncates to the original argument area (POSIX) and becomes the name
 * ps shows, or the console title (Windows). "node" without arguments
 * (library sessions). +1 / borrowed. */
ScrStr *scr_process_title(void);
void scr_process_set_title(const ScrStr *title);
/* process.argv0: the original argv[0] the binary was started with. +1. */
ScrStr *scr_process_argv0(void);
/* process.release: the stable { name, lts, sourceUrl, headersUrl[,
 * libUrl] } object of the compatibility target's release. +1. */
ScrDyn *scr_process_release(void);
/* geteuid(2) / getegid(2) / getgroups(2) (with the effective gid added
 * when missing, like Node). Windows has no such members: the calls throw
 * the TypeError Node's missing member does. */
double scr_process_geteuid(void);
double scr_process_getegid(void);
ScrArr *scr_process_getgroups(void);
ScrArr *scr_active_resources(void);
/* chdir(2) — throws Node's fs-shaped error on failure (syscall "chdir"). */
void scr_process_chdir(ScrStr *dir);
/* net's process-wide happy-eyeballs attempt budget (default 250ms) — in
 * the core unit so the knob never links scr_net.c. Never throw. */
double scr_net_get_autosel_timeout(void);
void scr_net_set_autosel_timeout(double ms);

/* Synchronous fs, utf8-only (paths and contents are ScrStr bytes). All
 * ScrStr arguments are BORROWED; string/array results return +1. On
 * failure every function except scr_fs_exists THROWS through the exception
 * cell (scr_throw_str) a CATCHABLE string formatted like Node's common
 * error messages ("ENOENT: no such file or directory, open 'x'") and
 * returns a dummy (false/NULL) — callers are compiler-emitted pending
 * checks. scr_fs_exists mirrors Node's existsSync: errors become false,
 * never a throw. */
ScrStr *scr_fs_read_file(ScrStr *path);
/* realpath(3) (+1 fresh); failures throw with Node's realpathSync
 * spelling (syscall "lstat"). */
ScrStr *scr_fs_realpath(ScrStr *path);
ScrStr *scr_fs_realpath_promise(ScrStr *path);
void scr_fs_write_file(ScrStr *path, ScrStr *data);
void scr_fs_append_file(ScrStr *path, ScrStr *data);
bool scr_fs_exists(ScrStr *path);
void scr_fs_mkdir(ScrStr *path);
/* Files only, like Node's rmSync without `recursive` (a directory throws an
 * EISDIR-coded error; use scr_fs_rmdir for empty directories). */
void scr_fs_rm(ScrStr *path);
void scr_fs_rmdir(ScrStr *path);
ScrArr *scr_fs_readdir(ScrStr *path); /* names (byte order on POSIX, as libuv sorts), no "."/".." */

/* The fs option forms (same throw discipline). mkdir_recursive is Node's
 * recursive algorithm (existing-dir target is a no-op; errors report
 * Node's errno at Node's path). rm_opts is rmSync with the recursive/
 * force booleans: force swallows ENOENT, recursive removes trees
 * post-order, a directory without recursive keeps the EISDIR wording
 * divergence. mkdtemp appends the six X's and returns the created path
 * (+1). access takes the F_OK/R_OK/W_OK/X_OK bits. read_fd is a read(2)
 * loop to EOF (Node's readFileSync(fd) shape — the stdin pattern);
 * failures throw Node's no-path message ("EBADF: bad file descriptor,
 * read"). */
void scr_fs_mkdir_recursive(ScrStr *path);
void scr_fs_rm_opts(ScrStr *path, bool recursive, bool force);
/* The maxRetries/retryDelay form: retries EBUSY/EMFILE/ENFILE/ENOTEMPTY/
 * EPERM failures up to maxRetries times with Node's linear backoff
 * (retryDelay ms longer per try); everything else throws immediately. */
void scr_fs_rm_opts_retry(ScrStr *path, bool recursive, bool force, double max_retries, double retry_delay);
ScrStr *scr_fs_mkdtemp(ScrStr *prefix);
ScrStr *scr_fs_mkdtemp_async(ScrStr *prefix); /* the callback and promise error path */
void scr_fs_access(ScrStr *path, double mode);
ScrStr *scr_fs_read_fd(double fd);

/* The wider sync fs slice (same throw discipline; `.code` stamped like
 * the rest). unlink/chmod/chown wrap the syscalls 1:1. copyfile copies
 * contents into a created-or-truncated destination carrying the SOURCE's
 * mode; its errors quote both paths ("copyfile 'src' -> 'dest'", Node's
 * shape). write_file_mode is writeFileSync(p, data, { mode }) — the mode
 * applies at creation only. The mkdir *_mode twins take mkdirSync's
 * explicit mode (the recursive walk passes it to every directory it
 * creates). */
void scr_fs_unlink(ScrStr *path);
void scr_fs_chmod(ScrStr *path, double mode);
void scr_fs_chown(ScrStr *path, double uid, double gid);
void scr_fs_lchown(ScrStr *path, double uid, double gid);
void scr_fs_fchown(double fd, double uid, double gid);
/* Node's argument checks, shared by the sync, promise and callback forms
 * (the callback forms throw them at the call). False with the error
 * thrown. */
bool scr_fs_owner_id_valid(double id, const char *name);
bool scr_fs_access_mode_valid(double mode);
bool scr_fs_truncate_len_valid(double length);
void scr_fs_truncate(ScrStr *path, double length);
void scr_fs_copyfile(ScrStr *src, ScrStr *dest);
/* The two-path form of scr_fs_throw: "ENOENT: no such file or directory,
 * copyfile 'src' -> 'dest'", with path and dest own properties. */
void scr_fs_throw2(int e, const char *op, const ScrStr *src, const ScrStr *dest);
/* The error shapes Node's native fs bindings throw besides the libuv one
 * (scr_fs_throw): a THROW_ERR_* coded Error ("Error: message", own `code`,
 * no "[code]" in its name); an ErrnoException from a std::error_code
 * ("EEXIST, File exists 'path'", positive errno, keys errno, code, path,
 * syscall); and internal/errors.js's SystemError ("<prefix>: <syscall>
 * returned <errno name> (<message>) <path>", named SystemError, keys code,
 * info, errno, syscall, path). */
void scr_fs_throw_native_coded(const char *code, const char *message, size_t length);
void scr_fs_throw_errno_exception(int e, const char *syscall, const ScrStr *path);
void scr_fs_throw_system_error(const char *code, const char *prefix, int e, const char *syscall,
                               const ScrStr *message, const ScrStr *path);
void scr_fs_rename(ScrStr *oldpath, ScrStr *newpath);
/* The callback rename worker uses the non-throwing syscall seam off the
 * runtime thread, then materializes any Node-shaped Error back on the main
 * thread. raw returns 0 on success or a positive errno value on failure. */
int scr_fs_rename_raw(const ScrStr *oldpath, const ScrStr *newpath);
void scr_fs_rename_error(int error, const ScrStr *oldpath, const ScrStr *newpath);
void scr_fs_write_file_mode(ScrStr *path, ScrStr *data, double mode);
void scr_fs_mkdir_mode(ScrStr *path, double mode);
void scr_fs_mkdir_recursive_mode(ScrStr *path, double mode);
/* The same walk, answering the first directory created (+1) or NULL
 * when the path already existed (or on failure, the exception pending). */
ScrStr *scr_fs_mkdir_recursive_first(ScrStr *path, double mode);

/* Sequentially consistent integer operations and shared Int32 wait queues. */
typedef struct ScrBytes ScrBytes;
ScrStr *scr_atomics_wait(ScrBytes *, double, double, double);
double scr_atomics_notify(ScrBytes *, double, double);
double scr_atomics_op(ScrBytes *, double, double, double, double);

/* isatty(3) over an fd (0/1/2): a real boolean — false where Node's
 * non-TTY streams expose undefined (SEMANTICS.md). stdin_destroy is a
 * documented no-op. */
bool scr_process_is_tty(double fd);
void scr_process_stdin_destroy(void);
void scr_process_stdin_set_raw_mode(bool raw);

/* Terminal width for process.stdout/stderr.columns (fd 1/2):
 * ioctl(TIOCGWINSZ), -1 when the fd is not a TTY or the ioctl refuses —
 * the emitter wraps a non-negative width into the `number | undefined`
 * union's number arm and -1 into its undefined arm (Node's non-TTY
 * `.columns` is undefined). Never throws. */
double scr_process_columns(double fd);
/* Terminal height; same optional-number sentinel contract as columns. */
double scr_process_rows(double fd);

/* Stats values (statSync/lstatSync and their fs.promises twins): an immutable
 * snapshot of stat(2). scr_fs_stat follows symlinks; scr_fs_lstat does not.
 * Both THROW like the other sync calls. */
typedef struct ScrStats ScrStats;
typedef struct ScrFileHandle ScrFileHandle;
typedef struct ScrPromise ScrPromise; /* full section further down */

ScrStats *scr_fs_stat(ScrStr *path);  /* +1, or throws */
ScrStats *scr_fs_lstat(ScrStr *path); /* +1, or throws; NO follow (lstat) */
/* { throwIfNoEntry }: +1, or throws; with false, NULL when the entry is
 * missing (ENOENT/ENOTDIR) */
ScrStats *scr_fs_stat_probe(ScrStr *path, bool no_follow, bool throw_if_no_entry);
ScrStats *scr_fs_fstat(double fd); /* +1, or throws */
void scr_fs_fchmod(double fd, double mode);
void scr_fs_fsync(double fd);
void scr_fs_fdatasync(double fd);
void scr_fs_ftruncate(double fd, double length);
void scr_fs_utimes(ScrStr *path, double atime, double mtime, bool nofollow);
void scr_fs_invalid_path(const ScrDyn *value, const ScrStr *path);
void scr_fs_invalid_named_path(const ScrDyn *value, const ScrStr *path, const char *name);
/* A string path argument: false after throwing Node's ERR_INVALID_ARG_VALUE
 * when it holds a null byte (`name` is the argument's name). */
bool scr_fs_path_ok(const ScrStr *path, const char *name);
void scr_fs_futimes(double fd, double atime, double mtime);
void scr_fs_link(ScrStr *source, ScrStr *dest);
void scr_fs_symlink(ScrStr *target, ScrStr *destination, int kind);
int scr_fs_symlink_infer(ScrStr *absolute);
ScrBytes *scr_fs_readlink_bytes(ScrStr *path);
void scr_fs_link_checked(const ScrDyn *existing, const ScrDyn *destination);
void scr_fs_symlink_checked(const ScrDyn *target, const ScrDyn *destination, const ScrDyn *type);
void scr_fs_symlink_promise_checked(const ScrDyn *target, const ScrDyn *destination, const ScrDyn *type);
ScrDyn *scr_fs_readlink_checked(const ScrDyn *path, const ScrDyn *options, bool promise);
ScrDyn *scr_fs_readlink_dyn(const ScrDyn *path, const ScrDyn *options);
ScrDyn *scr_fs_statfs(ScrStr *path, bool bigint);
ScrDyn *scr_fs_statfs_checked(const ScrDyn *path, const ScrDyn *options);
ScrPromise *scr_fsp_statfs(const ScrDyn *path, const ScrDyn *options);
ScrStr *scr_fs_readlink_str(const ScrDyn *path, const ScrDyn *options);
ScrBytes *scr_fs_readlink_buffer(const ScrDyn *path, const ScrDyn *options);
ScrPromise *scr_fsp_link(const ScrDyn *existing, const ScrDyn *destination);
ScrPromise *scr_fsp_symlink(const ScrDyn *target, const ScrDyn *destination, const ScrDyn *type);
ScrPromise *scr_fsp_readlink_dyn(const ScrDyn *path, const ScrDyn *options);
ScrPromise *scr_fsp_readlink_str(const ScrDyn *path, const ScrDyn *options);
ScrPromise *scr_fsp_readlink_buffer(const ScrDyn *path, const ScrDyn *options);
ScrStats *scr_stats_retain(ScrStats *s);
void scr_stats_release(ScrStats *s);
void *scr_stats_retain_v(void *p);
void scr_stats_release_v(void *p);
bool scr_stats_is_file(ScrStats *s);
bool scr_stats_is_dir(ScrStats *s);
bool scr_stats_is_symlink(ScrStats *s); /* lstat snapshots only */
double scr_stats_dev(ScrStats *s);
double scr_stats_ino(ScrStats *s);
double scr_stats_size(ScrStats *s);
double scr_stats_blocks(ScrStats *s); /* allocated size in 512-byte units */
double scr_stats_nlink(ScrStats *s);
double scr_stats_atime_ms(ScrStats *s); /* ms with the sub-second fraction */
double scr_stats_mtime_ms(ScrStats *s); /* ms with the ns fraction */
double scr_stats_ctime_ms(ScrStats *s); /* ms with the ns fraction */
double scr_stats_birthtime_ms(ScrStats *s);
double scr_stats_mode(ScrStats *s);
double scr_stats_uid(ScrStats *s);
double scr_stats_gid(ScrStats *s);
double scr_stats_rdev(ScrStats *s);
double scr_stats_blksize(ScrStats *s);
/* The type tests Node derives from mode (false on Windows for FIFOs, block
 * devices and sockets). */
bool scr_stats_is_block_device(ScrStats *s);
bool scr_stats_is_character_device(ScrStats *s);
bool scr_stats_is_fifo(ScrStats *s);
bool scr_stats_is_socket(ScrStats *s);
/* The Date fields' time values: the *Ms value rounded, as Node's
 * dateFromMs does. */
double scr_stats_atime(ScrStats *s);
double scr_stats_mtime(ScrStats *s);
double scr_stats_ctime(ScrStats *s);
double scr_stats_birthtime(ScrStats *s);
/* fstat without throwing: +1, or NULL with *error set to the errno. */
ScrStats *scr_stats_of_fd(int fd, int *error);
/* Node's Stats (or BigIntStats) object for the snapshot: own fields in the
 * binding's order, lazy Date accessors and the type tests on the
 * prototypes. Borrows s; +1. */
ScrDyn *scr_stats_dyn(ScrStats *s, bool bigint);

/* fs/promises: the SAME sync operations, minting an already-settled
 * promise — success fulfills, failure REJECTS with the would-be thrown
 * error (catchable at the await, like Node). The syscall blocks the loop:
 * I/O never interleaves with timers/other fibers (SEMANTICS.md). Implemented in
 * scr_async.c beside the promise machinery (the runtime unit tests link
 * scr_lib.c without the fiber slice). */
ScrPromise *scr_fsp_read_file(ScrStr *path);
ScrPromise *scr_fsp_write_file(ScrStr *path, ScrStr *data);
ScrPromise *scr_fsp_write_file_mode(ScrStr *path, ScrStr *data, double mode);
ScrPromise *scr_fsp_mkdir(ScrStr *path);
ScrPromise *scr_fsp_mkdir_mode(ScrStr *path, double mode);
ScrPromise *scr_fsp_mkdir_recursive(ScrStr *path);
ScrPromise *scr_fsp_mkdir_recursive_mode(ScrStr *path, double mode);
ScrPromise *scr_fsp_unlink(ScrStr *path);
ScrPromise *scr_fsp_chmod(ScrStr *path, double mode);
ScrPromise *scr_fsp_chown(ScrStr *path, double uid, double gid);
ScrPromise *scr_fsp_lchown(ScrStr *path, double uid, double gid);
ScrPromise *scr_fsp_access(ScrStr *path, double mode);
ScrPromise *scr_fsp_append_file(ScrStr *path, ScrStr *data);
ScrPromise *scr_fsp_append_file_bytes(ScrStr *path, ScrBytes *data);
ScrPromise *scr_fsp_copyfile(ScrStr *src, ScrStr *dest);
ScrPromise *scr_fsp_mkdtemp(ScrStr *prefix);
ScrPromise *scr_fsp_read_file_encoded(ScrStr *path, ScrStr *encoding);
ScrPromise *scr_fsp_rmdir(ScrStr *path);
ScrPromise *scr_fsp_truncate(ScrStr *path, double length);
ScrPromise *scr_fsp_utimes(const ScrDyn *path, const ScrDyn *atime, const ScrDyn *mtime);
ScrPromise *scr_fsp_lutimes(const ScrDyn *path, const ScrDyn *atime, const ScrDyn *mtime);
ScrPromise *scr_fsp_readdir(ScrStr *path);
ScrPromise *scr_fsp_rm(ScrStr *path);
ScrPromise *scr_fsp_stat(ScrStr *path);
ScrPromise *scr_fsp_realpath(ScrStr *path);
ScrPromise *scr_fsp_lstat(ScrStr *path);
typedef struct ScrDir ScrDir; /* fs.Dir, declared with its operations in scr_os.h */
ScrPromise *scr_fsp_opendir(ScrStr *path, double buffer_size);
ScrPromise *scr_dir_close_promise(ScrDir *d);
ScrPromise *scr_fsp_rename(ScrStr *oldpath, ScrStr *newpath);
ScrPromise *scr_fsp_open(ScrStr *path, ScrStr *flags, double mode);
ScrPromise *scr_file_handle_close_promise(ScrFileHandle *h);
ScrPromise *scr_file_handle_utimes_promise(ScrFileHandle *h, const ScrDyn *atime, const ScrDyn *mtime);
ScrPromise *scr_file_handle_read_file_promise(ScrFileHandle *h, ScrStr *encoding);
ScrPromise *scr_file_handle_read_file_bytes_promise(ScrFileHandle *h, ScrStr *encoding);
ScrPromise *scr_file_handle_write_file_promise(ScrFileHandle *h, ScrStr *data, ScrStr *encoding);
ScrPromise *scr_file_handle_write_file_bytes_promise(ScrFileHandle *h, ScrBytes *data, ScrStr *encoding);
ScrPromise *scr_file_handle_stat_promise(ScrFileHandle *h);

/* Raw fd operations for worker-pool steps (scr_lib.c): no runtime state
 * and no exceptions; each answers its result or -errno. A negative
 * position uses the current file offset. flags are native open(2) bits. */
int scr_fs_raw_open(const char *path, int flags, int mode);
int64_t scr_fs_raw_read(int fd, void *data, size_t length, double position);
int64_t scr_fs_raw_write(int fd, const void *data, size_t length, double position);
int scr_fs_raw_fsync(int fd);
int scr_fs_raw_close(int fd);

/* Shared executable worker pool. `work` runs on one of four native worker
 * threads and must not touch runtime RC/exception state; `after` and
 * `destroy` run on the main runtime thread. WASI runs `work` on a later
 * loop turn. The payload is owned by the submission until destroy. */
typedef void (*ScrWorkFn)(void *payload);
void scr_work_submit(void *payload, ScrWorkFn work, ScrWorkFn after,
                     ScrWorkFn destroy);

/* fs.rename: the syscall is submitted to a native worker immediately and
 * its error-first callback fires on a later event-loop turn through an
 * emitted, program-shaped adapter. Both paths and the callback are borrowed
 * at entry; the callback MOVES into the operation. err is borrowed and NULL
 * on success. */
typedef void (*ScrFsRenameFn)(ScrClosure *cb, ScrError *err);
void scr_fs_rename_async(ScrStr *oldpath, ScrStr *newpath,
                         ScrClosure *cb /*moves*/, ScrFsRenameFn fn);
void scr_fs_rename_thunk0(ScrClosure *cb, ScrError *err);

#endif /* SCR_LIB_H */
