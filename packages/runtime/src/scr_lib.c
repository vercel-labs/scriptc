/* Standard library: the process global + synchronous node:fs (scr_runtime.h
 * has the API contract). Everything here is called through compiler-emitted
 * `libCall` IR.
 *
 * - process.argv is ONE interned array, built lazily on first read and
 *   retained per read — identity (`process.argv === process.argv`) and
 *   mutation persistence match Node's stable process.argv. The atexit
 *   cleanup registered by scr_lib_init releases the interned values before
 *   the RC audit runs (atexit is LIFO; scr_init registered the audit
 *   first), so they never count as leaks.
 * - fs failures THROW through the exception cell (scr_throw_error — the
 *   payload is a catchable Error instance whose message is shaped like
 *   Node's fs error messages) and return a dummy; the compiler emits
 *   pending checks after every fs call (the MAY_THROW_LIB_FNS seed).
 *   scr_fs_exists never throws, like Node's existsSync.
 */
#include "scr_runtime.h"
#include "scr_system_errors.h"

#include <ctype.h>
#ifdef SCR_WORKERS
#include <stdatomic.h>
static atomic_uint scr_process_mask;
static void scr_process_mask_init(void);
#endif
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <math.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#if defined(__linux__)
#include <sys/vfs.h>
#elif defined(__APPLE__) || defined(__FreeBSD__)
#include <sys/mount.h>
#elif !defined(_WIN32) && !defined(__wasi__)
#include <sys/statvfs.h>
#endif
#include <time.h>

#ifdef _WIN32
/* ── the Windows arm's system surface ─────────────────────────────────
 * mingw-w64's CRT covers most of sync fs (open/read/write/stat/dirent —
 * the seams below note what it lacks: d_type, lstat, two-arg mkdir,
 * mkdtemp, O_SYNC) and the Win32 API covers the process/os surface
 * (GetTempPathA, GetUserNameA, RtlGetVersion, GetConsoleScreenBufferInfo).
 * What has NO arm yet is stubbed honestly at its seam: process.kill and
 * getuid/getgid (needs-design: OpenProcess/TerminateProcess vs Node's
 * uv_kill; no uids exist on Windows — Node omits the members there),
 * setRawMode's raw arm (mechanical: SetConsoleMode).
 * os.networkInterfaces HAS its arm: GetAdaptersAddresses below, libuv's
 * exact row selection. */
#include <direct.h>  /* _mkdir */
#include <io.h>      /* _isatty, _access, open/read/write/close */
#include <process.h> /* getpid */
#include <unistd.h>  /* mingw-w64 ships one: getcwd, access, isatty, ... */
#include <winsock2.h> /* BEFORE windows.h (which pulls winsock 1 otherwise) */
#include <ws2tcpip.h> /* inet_ntop, sockaddr_in6 */
#include <iphlpapi.h> /* GetAdaptersAddresses (os.networkInterfaces) */
#include <windows.h>
#include <winioctl.h> /* FSCTL_GET_REPARSE_POINT */
#define PSAPI_VERSION 2 /* K32GetProcessMemoryInfo, in kernel32 */
#include <psapi.h>
#include <lmcons.h>  /* UNLEN for GetUserNameA */
#include "scr_win_stats.h"

static WCHAR *scr_fs_win_wide(const ScrStr *path);
static int scr_fs_win_errno(DWORD error);
static bool scr_stats_is_link_tag(DWORD tag);
static bool scr_stats_link_target(HANDLE h, DWORD tag, double *size_out, ScrStr **text_out);

static ScrStr *scr_fs_win_utf8(const WCHAR *text, size_t length) {
  if (length > INT_MAX) { SetLastError(ERROR_FILENAME_EXCED_RANGE); return NULL; }
  int size = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, text, (int)length, NULL, 0, NULL, NULL);
  if (size <= 0) return length == 0 ? scr_str_new("", 0) : NULL;
  char *bytes = malloc((size_t)size);
  if (!bytes) scr_trap("scriptc: out of memory\n");
  if (WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, text, (int)length, bytes, size, NULL, NULL) != size) {
    DWORD error = GetLastError();
    free(bytes);
    SetLastError(error);
    return NULL;
  }
  ScrStr *result = scr_str_new(bytes, (size_t)size);
  free(bytes);
  return result;
}

/* The CRT has no symlink view, so its internal lstat users degrade to stat.
 * The public Stats path below bypasses this seam and opens the final component
 * as a reparse point for lstatSync, matching Node's no-follow split. */
#define lstat stat

/* Windows has no directory mode bits; the CRT mkdir takes one argument. */
#define scr_sys_mkdir(p, m) ((void)(m), mkdir(p))

/* openSync's "rs"/"sa" flags: no O_SYNC on the CRT — degrade to non-sync
 * opens (Node on Windows maps O_SYNC to FILE_FLAG_WRITE_THROUGH; the
 * difference is durability, not observable output). */
#define O_SYNC 0

#ifndef INET6_ADDRSTRLEN
#define INET6_ADDRSTRLEN 46 /* ws2tcpip.h's value; only sizes the row bufs */
#endif

#else /* !_WIN32 */

#include <arpa/inet.h>
#include <ifaddrs.h>
#include <net/if.h>
#include <netinet/in.h>
#include <pthread.h>
#include <pwd.h>
#include <sys/ioctl.h>
#include <sys/socket.h>
#include <sys/utsname.h>
#include <termios.h>
#include <unistd.h>
#if defined(__APPLE__) || defined(__FreeBSD__) || defined(__OpenBSD__) || defined(__NetBSD__)
#include <net/if_dl.h>
#elif defined(__linux__)
#include <inttypes.h>
#include <netpacket/packet.h>
#include <sys/sysinfo.h>
#endif
#if defined(__linux__)
#include <sched.h> /* sched_getaffinity, CPU_COUNT (os.availableParallelism) */
#include <sys/prctl.h> /* PR_SET_NAME (process.title) */
#include <sys/syscall.h> /* SYS_statx (fs stats) */
#ifndef SYS_statx
#if defined(__x86_64__)
#define SYS_statx 332
#elif defined(__aarch64__)
#define SYS_statx 291 /* the generic syscall table */
#endif
#endif
#ifndef AT_EMPTY_PATH
#define AT_EMPTY_PATH 0x1000
#endif
#elif defined(__APPLE__)
#include <sys/sysctl.h> /* sysctlbyname (os.availableParallelism) */
#endif

#define scr_sys_mkdir(p, m) mkdir((p), (m))

extern char **environ; /* env snapshot (scr_env_pairs) */

#endif /* _WIN32 */

/* O_BINARY: Windows-only (CRT text mode would translate \n on fd writes);
 * zero elsewhere so the POSIX open flags are unchanged. */
#ifndef O_BINARY
#define O_BINARY 0
#endif

/* ── process ─────────────────────────────────────────────────────────── */

static SCR_TL int scr_lib_argc = 0;
static SCR_TL char **scr_lib_argv = NULL;
static SCR_TL char **scr_lib_argv_owned = NULL;
#if defined(_WIN32) && !defined(SCR_LIB)
static SCR_TL char *scr_lib_argv_utf8 = NULL;
#endif
static SCR_TL bool scr_lib_has_fork = false;
/* A leading Node runtime flag taken out of process.argv (scr_lib_take_flag),
 * which process.execArgv reports; NULL without one. */
static SCR_TL const char *scr_lib_exec_flag = NULL;
#if defined(_WIN32) && !defined(SCR_LIB)
/* The flag's index in the original Windows command line, -1 without one. */
static SCR_TL int scr_lib_exec_flag_index = -1;
#endif
#if !defined(_WIN32) && !defined(__wasi__) && !defined(SCR_LIB)
static void scr_title_init(int argc, char **argv);
#endif
static SCR_TL double scr_lib_fork_target_id = -1;
static SCR_TL uintptr_t scr_lib_fork_read_handle = 0;
static SCR_TL uintptr_t scr_lib_fork_write_handle = 0;
static SCR_TL ScrArr *scr_argv_arr = NULL;    /* interned process.argv */
static SCR_TL ScrStr *scr_platform_str = NULL; /* interned process.platform */
static SCR_TL ScrStr *scr_exec_path_str = NULL; /* interned process.execPath */
static SCR_TL ScrStr *scr_arch_str = NULL;      /* interned process.arch */
static SCR_TL ScrStr *scr_versions_node_str = NULL; /* interned process.versions.node */
static SCR_TL ScrStr *scr_versions_openssl_str = NULL; /* interned process.versions.openssl */

typedef struct {
  ScrStr *filename;
  ScrStr *id;
  ScrStr *path;
  ScrArr *paths;
  ScrArr *children;
  double parent;
  size_t cache_order;
  bool in_cache;
  bool loaded;
  bool is_main;
} ScrModuleRecord;

static SCR_TL ScrModuleRecord *scr_module_records = NULL;
static SCR_TL size_t scr_module_record_count = 0;
static SCR_TL size_t scr_module_next_cache_order = 1;

static void scr_module_registry_cleanup(void) {
  for (size_t i = 0; i < scr_module_record_count; i++) {
    ScrModuleRecord *m = &scr_module_records[i];
    scr_str_release(m->filename);
    scr_str_release(m->id);
    scr_str_release(m->path);
    scr_arr_release(m->paths);
    scr_arr_release(m->children);
  }
  free(scr_module_records);
  scr_module_records = NULL;
  scr_module_record_count = 0;
  scr_module_next_cache_order = 1;
}

/* Keep lazy process values out of the startup cleanup root.  The executable
 * linker can discard an otherwise-unused getter, but an unconditional atexit
 * callback that mentions every cache would still retain each cache cell (and
 * its symbol) in a tiny hello-world.  Each getter below instead registers its
 * own cleanup only when the value is first materialized.  That is equivalent
 * at process exit and retains the RC-audit cleanup guarantee for the values a
 * program actually observes. */
static void scr_lib_cleanup(void) {
  scr_module_registry_cleanup();
  scr_arr_release(scr_argv_arr);
  scr_argv_arr = NULL;
  free(scr_lib_argv_owned);
  scr_lib_argv_owned = NULL;
#if defined(_WIN32) && !defined(SCR_LIB)
  free(scr_lib_argv_utf8);
  scr_lib_argv_utf8 = NULL;
#endif
  scr_lib_argc = 0;
  scr_lib_argv = NULL;
  scr_lib_has_fork = false;
  scr_lib_fork_target_id = -1;
  scr_lib_fork_read_handle = 0;
  scr_lib_fork_write_handle = 0;
}

static void scr_process_platform_cleanup(void) {
  scr_str_release(scr_platform_str);
  scr_platform_str = NULL;
}

static void scr_process_exec_path_cleanup(void) {
  scr_str_release(scr_exec_path_str);
  scr_exec_path_str = NULL;
}

static void scr_process_arch_cleanup(void) {
  scr_str_release(scr_arch_str);
  scr_arch_str = NULL;
}

static void scr_process_versions_node_cleanup(void) {
  scr_str_release(scr_versions_node_str);
  scr_versions_node_str = NULL;
}

static void scr_process_versions_openssl_cleanup(void) {
  scr_str_release(scr_versions_openssl_str);
  scr_versions_openssl_str = NULL;
}

static bool scr_lib_same_executable_arg(const char *a, const char *b) {
  if (strcmp(a, b) == 0) return true;
  char resolved_a[PATH_MAX], resolved_b[PATH_MAX];
#ifdef _WIN32
  const char *use_a = _fullpath(resolved_a, a, sizeof resolved_a) != NULL ? resolved_a : a;
  const char *use_b = _fullpath(resolved_b, b, sizeof resolved_b) != NULL ? resolved_b : b;
  return _stricmp(use_a, use_b) == 0;
#else
  const char *use_a = realpath(a, resolved_a) != NULL ? resolved_a : a;
  const char *use_b = realpath(b, resolved_b) != NULL ? resolved_b : b;
  return strcmp(use_a, use_b) == 0;
#endif
}

#if defined(_WIN32) && !defined(SCR_LIB)
/* C main's narrow argv has already lost characters outside the active ANSI
 * code page. Recover the original Unicode command line before publishing
 * process.argv to either execution tier. Keep this lazy: programs that do
 * not read arguments need no converted strings or shell32 initialization.
 * Load the documented OS parser from System32 without adding an executable-
 * only shell dependency to the embedding runtime's link contract. */
static void scr_lib_prepare_utf8_argv(void) {
#ifdef SCR_WORKERS
  /* Worker arguments were copied as UTF-8 before their native thread began. */
  if (!scr_context_is_main()) return;
#endif
  if (scr_lib_argv == NULL || scr_lib_argv_utf8 != NULL) return;
  HMODULE shell = LoadLibraryExW(L"shell32.dll", NULL, LOAD_LIBRARY_SEARCH_SYSTEM32);
  if (shell == NULL) scr_trap("could not load Windows command-line parser");
  typedef LPWSTR *(WINAPI *ScrParseCommandLine)(LPCWSTR, int *);
  ScrParseCommandLine parse = (ScrParseCommandLine)(void *)GetProcAddress(shell, "CommandLineToArgvW");
  if (parse == NULL) {
    FreeLibrary(shell);
    scr_trap("Windows command-line parser is unavailable");
  }
  int count = 0;
  LPWSTR *wide = parse(GetCommandLineW(), &count);
  FreeLibrary(shell);
  if (wide == NULL || count < 1) scr_trap("could not parse Windows command line");
  size_t bytes = 0;
  for (int i = 0; i < count; i++) {
    int size = WideCharToMultiByte(CP_UTF8, 0, wide[i], -1, NULL, 0, NULL, NULL);
    if (size == 0 || bytes > SIZE_MAX - (size_t)size) {
      LocalFree(wide);
      scr_trap("could not encode Windows argument");
    }
    bytes += (size_t)size;
  }
  char *text = malloc(bytes);
  char **args = calloc((size_t)count + 1, sizeof(char *));
  if (text == NULL || args == NULL) {
    free(text); free(args); LocalFree(wide);
    scr_trap("out of memory");
  }
  char *next = text;
  int used = 0;
  for (int i = 0; i < count; i++) {
    // scr_lib_init already consumed this private ASCII fork marker. Do not
    // reintroduce it when replacing the narrow argument storage.
    if (i == 1 && scr_lib_has_fork) continue;
    if (i == scr_lib_exec_flag_index) continue;
    int size = WideCharToMultiByte(CP_UTF8, 0, wide[i], -1, NULL, 0, NULL, NULL);
    if (size == 0 || WideCharToMultiByte(CP_UTF8, 0, wide[i], -1, next, size, NULL, NULL) != size) {
      free(text); free(args); LocalFree(wide);
      scr_trap("could not encode Windows argument");
    }
    args[used++] = next;
    next += size;
  }
  LocalFree(wide);
  free(scr_lib_argv_owned);
  scr_lib_argv_owned = args;
  scr_lib_argv_utf8 = text;
  scr_lib_argv = args;
  scr_lib_argc = used;
}
#endif

/* A child_process call spelling Node's self-reexec shape:
 * spawn(process.execPath, [process.argv[1], ...args]). The parent still
 * knows these two path-like arguments are the executable and script marker,
 * so its argv builder can collapse the marker without guessing from an
 * unrelated child's raw user arguments. Library sessions have no argv and
 * always answer false. */
bool scr_lib_should_collapse_reexec_arg(ScrStr *cmd, ScrArr *args) {
  if (scr_lib_arg_count() < 1 || scr_arr_len(args) < 1) return false;
  ScrStr *first = (ScrStr *)scr_arr_get_ref(args, 0);
  bool collapse = scr_lib_same_executable_arg(cmd->data, scr_lib_argv[0]) &&
                  scr_lib_same_executable_arg(first->data, scr_lib_argv[0]);
  scr_str_release(first);
  return collapse;
}

#ifndef SCR_LIB
/* Executable lane only: a library artifact has no argv and registers no
 * atexit handlers (the emitted library init never calls this; keeping it out
 * the archive's objects free of any atexit reference — the K8 ambient
 * audit's bar). */
void scr_lib_init(int argc, char **argv) {
#ifdef SCR_WORKERS
  if (scr_context_is_main()) scr_process_mask_init();
#endif
  scr_lib_argc = argc;
  scr_lib_argv = argv;
  if (argc >= 2 && strncmp(argv[1], "--scriptc-fork=", 15) == 0) {
    unsigned long long target = 0, read_handle = 0, write_handle = 0;
    char tail = '\0';
    if (sscanf(argv[1] + 15, "%llu,%llu,%llu%c", &target, &read_handle,
               &write_handle, &tail) == 3) {
      scr_lib_has_fork = true;
      scr_lib_fork_target_id = (double)target;
      scr_lib_fork_read_handle = (uintptr_t)read_handle;
      scr_lib_fork_write_handle = (uintptr_t)write_handle;
      scr_lib_argv_owned = malloc((size_t)argc * sizeof(char *));
      if (!scr_lib_argv_owned) scr_trap("out of memory");
      scr_lib_argv_owned[0] = argv[0];
      for (int i = 2; i < argc; i++) scr_lib_argv_owned[i - 1] = argv[i];
      scr_lib_argv_owned[argc - 1] = NULL;
      scr_lib_argc = argc - 1;
      scr_lib_argv = scr_lib_argv_owned;
    }
  }
#if !defined(_WIN32) && !defined(__wasi__)
#ifdef SCR_WORKERS
  if (scr_context_is_main())
#endif
    scr_title_init(argc, argv);
#endif
  scr_atexit(scr_lib_cleanup);
}
#endif /* !SCR_LIB */

#ifdef SCR_LIB
/* Library builds never call scr_lib_init (a library artifact has no argv and registers no
 * atexit handlers); the interned process values above still intern lazily
 * on first read, so the library reset seam releases them here instead —
 * scr_library_reset (scr_library.c) calls this every session reset. */
void scr_lib_session_cleanup(void) {
  scr_lib_cleanup();
  scr_process_platform_cleanup();
  scr_process_exec_path_cleanup();
  scr_process_arch_cleanup();
  scr_process_versions_node_cleanup();
  scr_process_versions_openssl_cleanup();
}
#endif

static size_t scr_module_index(double module_id) {
  if (!isfinite(module_id) || module_id < 0 || trunc(module_id) != module_id ||
      module_id >= (double)scr_module_record_count) {
    scr_trap("invalid CommonJS module handle");
  }
  return (size_t)module_id;
}

static ScrModuleRecord *scr_module_record(double module_id) {
  return &scr_module_records[scr_module_index(module_id)];
}

void scr_module_registry_init(double count_value) {
  if (!isfinite(count_value) || count_value < 0 || trunc(count_value) != count_value ||
      count_value > (double)SIZE_MAX) {
    scr_trap("invalid CommonJS module registry size");
  }
  scr_module_registry_cleanup();
  scr_module_record_count = (size_t)count_value;
  if (scr_module_record_count == 0) return;
  scr_module_records = (ScrModuleRecord *)calloc(scr_module_record_count, sizeof(*scr_module_records));
  if (!scr_module_records) scr_trap("out of memory");
  for (size_t i = 0; i < scr_module_record_count; i++) {
    scr_module_records[i].parent = -1;
  }
}

void scr_module_define(double module_id, ScrStr *filename, ScrStr *id,
                       ScrStr *path, ScrArr *paths, bool is_main) {
  ScrModuleRecord *m = scr_module_record(module_id);
  scr_str_release(m->filename);
  scr_str_release(m->id);
  scr_str_release(m->path);
  scr_arr_release(m->paths);
  scr_arr_release(m->children);
  m->filename = scr_str_retain(filename);
  m->id = scr_str_retain(id);
  m->path = scr_str_retain(path);
  m->paths = scr_arr_retain(paths);
  m->children = scr_arr_new(SCR_ELEM_F64, 4);
  m->parent = is_main ? -1 : -2;
  m->cache_order = 0;
  m->in_cache = false;
  m->loaded = false;
  m->is_main = is_main;
}

void scr_module_enter(double module_id) {
  ScrModuleRecord *m = scr_module_record(module_id);
  if (!m->in_cache) {
    m->in_cache = true;
    m->cache_order = scr_module_next_cache_order++;
  }
  m->loaded = false;
}

void scr_module_link(double parent_id, double child_id) {
  ScrModuleRecord *parent = scr_module_record(parent_id);
  ScrModuleRecord *child = scr_module_record(child_id);
  if (!child->is_main && child->parent < 0) child->parent = parent_id;
  if (!scr_arr_includes_f64(parent->children, child_id)) {
    scr_arr_push_f64(parent->children, child_id);
  }
}

void scr_module_finish(double module_id) {
  ScrModuleRecord *m = scr_module_record(module_id);
  m->loaded = true;
}

void scr_module_fail(double module_id) {
  ScrModuleRecord *m = scr_module_record(module_id);
  if (m->parent >= 0) {
    ScrModuleRecord *parent = scr_module_record(m->parent);
    double at = scr_arr_index_of_f64(parent->children, module_id);
    if (at >= 0) {
      ScrArr *removed = scr_arr_splice(parent->children, at, 1);
      scr_arr_release(removed);
    }
  }
  m->parent = m->is_main ? -1 : -2;
  m->cache_order = 0;
  m->in_cache = false;
  m->loaded = false;
}

ScrStr *scr_module_filename(double module_id) {
  return scr_str_retain(scr_module_record(module_id)->filename);
}

ScrStr *scr_module_id(double module_id) {
  return scr_str_retain(scr_module_record(module_id)->id);
}

ScrStr *scr_module_path(double module_id) {
  return scr_str_retain(scr_module_record(module_id)->path);
}

ScrArr *scr_module_paths(double module_id) {
  return scr_arr_retain(scr_module_record(module_id)->paths);
}

ScrArr *scr_module_children(double module_id) {
  return scr_arr_retain(scr_module_record(module_id)->children);
}

double scr_module_parent(double module_id) {
  return scr_module_record(module_id)->parent;
}

bool scr_module_loaded(double module_id) {
  return scr_module_record(module_id)->loaded;
}

static bool scr_module_filename_equal(const ScrModuleRecord *m, const ScrStr *filename) {
  return m->filename && m->filename->len == filename->len &&
         memcmp(m->filename->data, filename->data, filename->len) == 0;
}

double scr_module_cache_get(ScrStr *filename) {
  for (size_t i = 0; i < scr_module_record_count; i++) {
    const ScrModuleRecord *m = &scr_module_records[i];
    if (m->in_cache && scr_module_filename_equal(m, filename)) return (double)i;
  }
  return -1;
}

bool scr_module_cache_has(ScrStr *filename) {
  return scr_module_cache_get(filename) >= 0;
}

ScrArr *scr_module_cache_keys(void) {
  ScrArr *keys = scr_arr_new(SCR_ELEM_STR, scr_module_record_count);
  for (size_t order = 1; order < scr_module_next_cache_order; order++) {
    for (size_t i = 0; i < scr_module_record_count; i++) {
      ScrModuleRecord *m = &scr_module_records[i];
      if (m->in_cache && m->cache_order == order) {
        scr_arr_push_ref(keys, scr_str_retain(m->filename));
        break;
      }
    }
  }
  return keys;
}

int scr_lib_arg_count(void) {
#if defined(_WIN32) && !defined(SCR_LIB)
  scr_lib_prepare_utf8_argv();
#endif
  return scr_lib_argc;
}
const char *scr_lib_arg(int i) {
#if defined(_WIN32) && !defined(SCR_LIB)
  scr_lib_prepare_utf8_argv();
#endif
  return scr_lib_argv[i];
}

bool scr_lib_take_flag(const char *flag) {
  if (scr_lib_argc < 2 || strcmp(scr_lib_argv[1], flag) != 0) return false;
  char **args = malloc((size_t)scr_lib_argc * sizeof(char *));
  if (!args) scr_trap("out of memory");
  args[0] = scr_lib_argv[0];
  for (int i = 2; i < scr_lib_argc; i++) args[i - 1] = scr_lib_argv[i];
  args[scr_lib_argc - 1] = NULL;
  free(scr_lib_argv_owned);
  scr_lib_argv_owned = args;
  scr_lib_argv = args;
  scr_lib_argc--;
#if defined(_WIN32) && !defined(SCR_LIB)
  scr_lib_exec_flag_index = scr_lib_has_fork ? 2 : 1;
#endif
  scr_lib_exec_flag = flag;
  return true;
}

ScrArr *scr_process_exec_argv(void) {
  ScrArr *arr = scr_arr_new(SCR_ELEM_STR, 1);
  if (scr_lib_exec_flag)
    scr_arr_push_ref(arr, scr_str_new(scr_lib_exec_flag, strlen(scr_lib_exec_flag)));
  return arr;
}

bool scr_lib_fork_info(double *target, uintptr_t *read_handle,
                       uintptr_t *write_handle) {
  if (!scr_lib_has_fork) return false;
  *target = scr_lib_fork_target_id;
  *read_handle = scr_lib_fork_read_handle;
  *write_handle = scr_lib_fork_write_handle;
  return true;
}

ScrArr *scr_process_argv(void) {
  if (!scr_argv_arr) {
    /* ["scriptc", argv[0], argv[1], ...]: positions and length line up
     * with Node's [node-path, script-path, ...args]; the argv[0]/argv[1]
     * VALUES diverge (SEMANTICS.md). */
    int argc = scr_lib_arg_count();
    scr_argv_arr = scr_arr_new(SCR_ELEM_STR, (size_t)argc + 1);
    scr_arr_push_ref(scr_argv_arr, scr_str_new("scriptc", 7));
    for (int i = 0; i < argc; i++) {
      const char *a = scr_lib_arg(i);
      scr_arr_push_ref(scr_argv_arr, scr_str_new(a, strlen(a)));
    }
  }
  return scr_arr_retain(scr_argv_arr);
}

ScrStr *scr_process_platform(void) {
  if (!scr_platform_str) {
#if defined(__APPLE__)
    scr_platform_str = scr_str_new("darwin", 6);
#elif defined(__linux__)
    scr_platform_str = scr_str_new("linux", 5);
#elif defined(__wasi__)
    scr_platform_str = scr_str_new("wasi", 4);
#elif defined(_WIN32)
    scr_platform_str = scr_str_new("win32", 5);
#else
    scr_platform_str = scr_str_new("unknown", 7);
#endif
#ifndef SCR_LIB
    scr_atexit(scr_process_platform_cleanup);
#endif
  }
  return scr_str_retain(scr_platform_str);
}

/* process.arch — the compiled binary's OWN architecture, spelled the way
 * Node spells its own build's arch. Interned like process.platform. */
ScrStr *scr_process_arch(void) {
  if (!scr_arch_str) {
#if defined(__wasm32__)
    scr_arch_str = scr_str_new("wasm32", 6);
#elif defined(__wasm64__)
    scr_arch_str = scr_str_new("wasm64", 6);
#elif defined(__aarch64__) || defined(_M_ARM64)
    scr_arch_str = scr_str_new("arm64", 5);
#elif defined(__x86_64__) || defined(_M_X64)
    scr_arch_str = scr_str_new("x64", 3);
#else
    scr_arch_str = scr_str_new("unknown", 7);
#endif
#ifndef SCR_LIB
    scr_atexit(scr_process_arch_cleanup);
#endif
  }
  return scr_str_retain(scr_arch_str);
}

/* process.versions.node — the runtime's Node COMPATIBILITY TARGET. There
 * is no Node under a compiled binary; this is the version whose semantics
 * SEMANTICS.md verifies the runtime against (divergence 60, the execPath
 * stance: answer for the world that actually exists). */
#define SCR_NODE_COMPAT_VERSION "24.22.0"
ScrStr *scr_process_versions_node(void) {
  if (!scr_versions_node_str) {
    scr_versions_node_str =
        scr_str_new(SCR_NODE_COMPAT_VERSION, sizeof(SCR_NODE_COMPAT_VERSION) - 1);
#ifndef SCR_LIB
    scr_atexit(scr_process_versions_node_cleanup);
#endif
  }
  return scr_str_retain(scr_versions_node_str);
}

/* process.versions.openssl — the compat target's crypto-provider version
 * string (the versions.node stance): Boolean(process.versions.openssl) is
 * Node's own "is crypto available" idiom, and the runtime DOES ship a
 * crypto module (mbedTLS-backed; unsupported members fence at their call
 * sites). Reading undefined here made every hasCrypto test self-skip —
 * measuring nothing (SEMANTICS.md; the divergence entry documents that
 * the string names the compat target's OpenSSL, not a linked library). */
#define SCR_OPENSSL_COMPAT_VERSION "3.5.8"
ScrStr *scr_process_versions_openssl(void) {
  if (!scr_versions_openssl_str) {
    scr_versions_openssl_str =
        scr_str_new(SCR_OPENSSL_COMPAT_VERSION, sizeof(SCR_OPENSSL_COMPAT_VERSION) - 1);
#ifndef SCR_LIB
    scr_atexit(scr_process_versions_openssl_cleanup);
#endif
  }
  return scr_str_retain(scr_versions_openssl_str);
}

static SCR_TL ScrDyn *scr_versions_object;

static void scr_versions_object_cleanup(void) {
  scr_dyn_release(scr_versions_object);
  scr_versions_object = NULL;
}

ScrDyn *scr_process_versions(void) {
  if (!scr_versions_object) {
    scr_versions_object = scr_dyn_new_obj();
    ScrStr *node = scr_process_versions_node();
    ScrStr *openssl = scr_process_versions_openssl();
    scr_dyn_obj_set(scr_versions_object, "node", 4, scr_dyn_new_str(node));
    scr_dyn_obj_set(scr_versions_object, "openssl", 7, scr_dyn_new_str(openssl));
    scr_str_release(node);
    scr_str_release(openssl);
    for (size_t i = 0; i < scr_versions_object->v.obj.len; i++) {
      scr_versions_object->v.obj.entries[i].writable = false;
    }
    scr_atexit(&scr_versions_object_cleanup);
  }
  return scr_dyn_retain(scr_versions_object);
}

/* process.execPath — the running binary's own resolved absolute path,
 * exactly what Node computes for ITS executable (uv_exepath + realpath):
 * _NSGetExecutablePath on macOS, /proc/self/exe on Linux, argv[0] as the
 * last resort. Interned like process.platform; +1 per read. */
ScrStr *scr_process_exec_path(void) {
  if (!scr_exec_path_str) {
    char raw[4096];
    raw[0] = '\0';
#if defined(__APPLE__)
    uint32_t size = sizeof(raw);
    extern int _NSGetExecutablePath(char *buf, uint32_t *bufsize);
    if (_NSGetExecutablePath(raw, &size) != 0) raw[0] = '\0';
#elif defined(__linux__)
    ssize_t got = readlink("/proc/self/exe", raw, sizeof(raw) - 1);
    if (got > 0) raw[got] = '\0';
    else raw[0] = '\0';
#elif defined(_WIN32)
    /* uv_exepath's source of truth on Windows; already absolute, and
     * spelled with backslashes like Node's own execPath there. */
    DWORD got = GetModuleFileNameA(NULL, raw, sizeof(raw) - 1);
    raw[got < sizeof(raw) ? got : 0] = '\0';
#endif
    if (raw[0] == '\0' && scr_lib_argc > 0) {
      snprintf(raw, sizeof(raw), "%s", scr_lib_argv[0]);
    }
    char resolved[PATH_MAX];
#ifdef _WIN32
    const char *use = _fullpath(resolved, raw, sizeof resolved) != NULL ? resolved : raw;
#else
    const char *use = realpath(raw, resolved) != NULL ? resolved : raw;
#endif
    scr_exec_path_str = scr_str_new(use, strlen(use));
#ifndef SCR_LIB
    scr_atexit(scr_process_exec_path_cleanup);
#endif
  }
  return scr_str_retain(scr_exec_path_str);
}

ScrStr *scr_env_get(const ScrStr *name) {
#ifdef SCR_WORKERS
  if (!scr_context_is_main()) {
    const char *value = scr_context_getenv(name->data);
    return value ? scr_str_new(value, strlen(value)) : NULL;
  }
#endif
  /* ScrStr data is NUL-terminated (like the fs paths below). A fresh copy
   * per read: getenv's buffer is not ours to alias, and Node's process.env
   * reads snapshot the value too. Absent → NULL (the compiler's undefined
   * arm), never a throw. */
#ifdef _WIN32
  /* The WIN32 environment, not the CRT's startup snapshot — libuv's choice
   * too, and the one CreateProcess children inherit. Case-insensitive,
   * like Node's process.env on Windows. */
  DWORD need = GetEnvironmentVariableA(name->data, NULL, 0);
  if (need == 0) return NULL; /* absent (an empty value still needs its NUL) */
  char *buf = malloc(need);
  if (!buf) {
    scr_trap("scriptc: out of memory\n");
  }
  DWORD got = GetEnvironmentVariableA(name->data, buf, need);
  ScrStr *s = scr_str_new(buf, got);
  free(buf);
  return s;
#else
  const char *v = scr_getenv(name->data);
  return v ? scr_str_new(v, strlen(v)) : NULL;
#endif
}

/* util.debuglog matches sections against NODE_DEBUG as the process
 * started, so the first write to that variable records the value it
 * replaces. */
static SCR_TL bool scr_node_debug_captured = false;
static SCR_TL char *scr_node_debug_value = NULL;

static void scr_node_debug_teardown(void) {
  free(scr_node_debug_value);
  scr_node_debug_value = NULL;
}

const char *scr_node_debug_initial(void) {
  if (!scr_node_debug_captured) {
    scr_node_debug_captured = true;
    const char *value = scr_getenv("NODE_DEBUG");
    if (value) {
      size_t len = strlen(value);
      scr_node_debug_value = malloc(len + 1);
      if (!scr_node_debug_value) scr_trap("scriptc: out of memory\n");
      memcpy(scr_node_debug_value, value, len + 1);
      scr_atexit(scr_node_debug_teardown);
    }
  }
  return scr_node_debug_value;
}

static void scr_node_debug_capture(const ScrStr *name) {
  if (name->len == 10 && memcmp(name->data, "NODE_DEBUG", 10) == 0) (void)scr_node_debug_initial();
}

/* Counts writes and deletes of process.env.TZ. The local-time getters keep
 * their last conversion for the generation it was made in. */
#ifdef SCR_WORKERS
static atomic_uint scr_date_tz_generation;
#else
static unsigned scr_date_tz_generation;
#endif

/* After a write or delete of the process's TZ, local time follows the new
 * value, as in Node: tzset(3) rereads it for later localtime calls. */
static void scr_env_tz_changed(const ScrStr *name) {
  /* Compared by character: a string literal would join the merged
   * read-only strings of every program that links this file. */
  if (name->len != 2 || name->data[0] != 'T' || name->data[1] != 'Z') return;
#if !defined(_WIN32) && !defined(__wasi__)
  tzset();
#endif
  scr_date_tz_generation++;
}

/* process.env.NAME = v — setenv(3): later scr_env_get reads and spawned
 * children (posix_spawn inherits environ) observe the write, like Node.
 * Both args borrowed (NUL-terminated ScrStr data); setenv copies. */
void scr_env_set(const ScrStr *name, const ScrStr *value) {
  scr_node_debug_capture(name);
  /* The environment holds UTF-8: a lone surrogate is stored as U+FFFD. */
  char *name_owned, *value_owned;
  const char *k = scr_str_utf8(name, &name_owned), *v = scr_str_utf8(value, &value_owned);
#ifdef SCR_WORKERS
  if (scr_context_env_set(k, v)) goto done;
#endif
#ifdef _WIN32
  /* The WIN32 environment (see scr_env_get): an empty value stays a
   * present-but-empty variable, and children inherit the write. */
  SetEnvironmentVariableA(k, v);
#else
  setenv(k, v, 1);
#endif
  scr_env_tz_changed(name);
#ifdef SCR_WORKERS
done:
#endif
  scr_str_utf8_end(name_owned);
  scr_str_utf8_end(value_owned);
}

/* `delete process.env.NAME` — unsetenv(3): later reads answer absent and
 * spawned children lose the variable, like Node. Borrowed. */
void scr_env_unset(const ScrStr *name) {
  scr_node_debug_capture(name);
#ifdef SCR_WORKERS
  if (scr_context_env_set(name->data, NULL)) return;
#endif
#ifdef _WIN32
  SetEnvironmentVariableA(name->data, NULL);
#else
  unsetenv(name->data);
#endif
  scr_env_tz_changed(name);
}

static ScrStr *scr_fs_read_file_core(ScrStr *path, bool env_file, size_t *ascii);

/* Node's dotenv parser trims ASCII space/tab/newline and removes every CR,
 * including CR inside quoted values. Quoted values can span lines; only
 * double quotes expand backslash-n. Preserve the pinned parser's ordering
 * of empty-value and export-prefix handling, including its unusual forms. */
static bool scr_env_space(char c) { return c == ' ' || c == '\t' || c == '\n'; }

static void scr_env_trim(const char *text, size_t *start, size_t *end) {
  while (*start < *end && scr_env_space(text[*start])) (*start)++;
  while (*end > *start && scr_env_space(text[*end - 1])) (*end)--;
}

static void scr_env_store(ScrDyn *out, const char *text, size_t ks, size_t ke,
                          size_t vs, size_t ve, bool expand) {
  ScrJsonBuf value;
  scr_jb_init(&value);
  for (size_t i = vs; i < ve; i++) {
    if (expand && text[i] == '\\' && i + 1 < ve && text[i + 1] == 'n') {
      scr_jb_putc(&value, '\n');
      i++;
    } else scr_jb_putc(&value, text[i]);
  }
  ScrStr *s = scr_jb_finish(&value);
  scr_dyn_obj_set(out, text + ks, ke - ks, scr_dyn_new_str(s));
  scr_str_release(s);
}

static int scr_env_entry_order(const void *left, const void *right) {
  const ScrDynEntry *a = *(const ScrDynEntry *const *)left;
  const ScrDynEntry *b = *(const ScrDynEntry *const *)right;
  size_t n = a->key_len < b->key_len ? a->key_len : b->key_len;
  int cmp = memcmp(a->key, b->key, n);
  return cmp ? cmp : (a->key_len > b->key_len) - (a->key_len < b->key_len);
}

static ScrDyn *scr_env_parse_content(const ScrStr *input, bool ordinary) {
  char *text = malloc(input->len + 1);
  if (!text) scr_trap("scriptc: out of memory\n");
  size_t end = 0;
  for (size_t i = 0; i < input->len; i++) if (input->data[i] != '\r') text[end++] = input->data[i];
  text[end] = '\0';
  size_t pos = 0;
  scr_env_trim(text, &pos, &end);
  ScrDyn *entries = scr_dyn_new_obj_null_proto();
  while (pos < end) {
    if (text[pos] == '\n' || text[pos] == '#') {
      while (pos < end && text[pos] != '\n') pos++;
      if (pos < end) pos++;
      continue;
    }
    size_t equal = pos;
    while (equal < end && text[equal] != '=' && text[equal] != '\n') equal++;
    if (equal == end) break;
    if (text[equal] == '\n') {
      pos = equal + 1;
      scr_env_trim(text, &pos, &end);
      continue;
    }
    size_t ks = pos, ke = equal;
    scr_env_trim(text, &ks, &ke);
    pos = equal + 1;
    if (pos == end || text[pos] == '\n') {
      scr_env_store(entries, text, ks, ke, pos, pos, false);
      continue;
    }
    scr_env_trim(text, &pos, &end);
    if (ks == ke) continue;
    if (ke - ks >= 7 && memcmp(text + ks, "export ", 7) == 0) {
      ks += 7;
      scr_env_trim(text, &ks, &ke);
    }
    if (pos == end) {
      scr_env_store(entries, text, ks, ke, pos, pos, false);
      break;
    }
    char quote = text[pos];
    if (quote == '\'' || quote == '"' || quote == '`') {
      size_t closing = pos + 1;
      while (closing < end && text[closing] != quote) closing++;
      if (closing < end) {
        scr_env_store(entries, text, ks, ke, pos + 1, closing, quote == '"');
        pos = closing + 1;
        while (pos < end && text[pos] != '\n') pos++;
        if (pos < end) pos++;
        continue;
      }
      size_t newline = pos;
      while (newline < end && text[newline] != '\n') newline++;
      scr_env_store(entries, text, ks, ke, pos, newline, false);
      pos = newline < end ? newline + 1 : end;
    } else {
      size_t newline = pos;
      while (newline < end && text[newline] != '\n') newline++;
      size_t vs = pos, ve = pos;
      while (ve < newline && text[ve] != '#') ve++;
      scr_env_trim(text, &vs, &ve);
      scr_env_store(entries, text, ks, ke, vs, ve, false);
      pos = newline < end ? newline + 1 : end;
    }
    scr_env_trim(text, &pos, &end);
  }
  free(text);
  /* Node's std::map orders UTF-8 keys before installing object properties.
   * Ordinary objects ignore string-valued __proto__ assignments; loading
   * the native environment retains that name as an ordinary variable. */
  size_t count = entries->v.obj.len;
  const ScrDynEntry **sorted = count ? malloc(count * sizeof(*sorted)) : NULL;
  if (count && !sorted) scr_trap("scriptc: out of memory\n");
  for (size_t i = 0; i < count; i++) sorted[i] = &entries->v.obj.entries[i];
  if (count > 1) qsort(sorted, count, sizeof(*sorted), scr_env_entry_order);
  ScrDyn *result = ordinary ? scr_dyn_new_obj() : scr_dyn_new_obj_null_proto();
  for (size_t i = 0; i < count; i++) {
    const ScrDynEntry *entry = sorted[i];
    if (ordinary && entry->key_len == 9 && memcmp(entry->key, "__proto__", 9) == 0) continue;
    if (!ordinary) {
      scr_dyn_obj_set(result, entry->key, entry->key_len, scr_dyn_retain(entry->value));
      continue;
    }
    /* Convert sorted entries to JS strings after parsing. */
    ScrStr *key = scr_str_from_utf8_lossy((const uint8_t *)entry->key, entry->key_len);
    const ScrStr *raw = entry->value->v.str;
    ScrStr *value = scr_str_from_utf8_lossy((const uint8_t *)raw->data, raw->len);
    scr_dyn_obj_set(result, key->data, key->len, scr_dyn_new_str(value));
    scr_str_release(key);
    scr_str_release(value);
  }
  free(sorted);
  scr_dyn_release(entries);
  return result;
}

ScrDyn *scr_util_parse_env(const ScrDyn *content) {
  if (content->kind != SCR_DYN_STR) {
    scr_dyn_arg_type_fail("content", "of type string", content);
    return NULL;
  }
  /* The parser works on UTF-8, as Node's does: a lone surrogate in the
   * string arrives as U+FFFD. */
  ScrStr *text = scr_str_to_well_formed(content->v.str);
  ScrDyn *entries = scr_env_parse_content(text, true);
  scr_str_release(text);
  return entries;
}

void scr_fs_invalid_named_path(const ScrDyn *value, const ScrStr *path, const char *name) {
  ScrJsonBuf b;
  scr_jb_init(&b);
  scr_jb_puts(&b, "The argument '");
  scr_jb_puts(&b, name);
  scr_jb_puts(&b, "' must be a string, Uint8Array, or URL without null bytes. Received ");
  if (value && value->kind == SCR_DYN_BYTES) {
    const ScrBytes *bytes = value->v.bytes;
    SCR_BYTES_SNAPSHOT(bytes);
    if (value->buffer) {
      scr_jb_puts(&b, "<Buffer");
      for (size_t i = 0; i < bytes->len; i++) {
        char hex[4];
        snprintf(hex, sizeof hex, " %02x", bytes->data[i]);
        scr_jb_puts(&b, hex);
      }
      scr_jb_putc(&b, '>');
    } else {
      char length[48];
      snprintf(length, sizeof length, "Uint8Array(%zu) [ ", bytes->len);
      scr_jb_puts(&b, length);
      for (size_t i = 0; i < bytes->len; i++) {
        char number[8];
        snprintf(number, sizeof number, "%s%u", i ? ", " : "", bytes->data[i]);
        scr_jb_puts(&b, number);
      }
      scr_jb_puts(&b, " ]");
    }
  } else {
    ScrStr *shown = scr_str_inspect_quoted(path, true);
    scr_jb_put_str(&b, shown);
    scr_str_release(shown);
  }
  ScrStr *message = scr_jb_finish(&b);
  scr_throw_error_msg_code(SCR_ERR_TYPE, message->data, message->len, "ERR_INVALID_ARG_VALUE");
  scr_str_release(message);
}

void scr_fs_invalid_path(const ScrDyn *value, const ScrStr *path) {
  scr_fs_invalid_named_path(value, path, "path");
}

bool scr_fs_path_ok(const ScrStr *path, const char *name) {
  if (!memchr(path->data, 0, path->len)) return true;
  scr_fs_invalid_named_path(NULL, path, name);
  return false;
}

void scr_fs_check_path(ScrStr *path, ScrStr *name) {
  (void)scr_fs_path_ok(path, name->data);
}

void scr_process_load_env_file(const ScrDyn *value) {
  ScrStr *path;
  if (value->kind == SCR_DYN_UNDEF || value->kind == SCR_DYN_NULL) path = scr_str_new("./.env", 6);
  else if (value->kind == SCR_DYN_STR) path = scr_str_retain(value->v.str);
  else if (scr_dyn_native_url_is(value)) path = scr_url_to_path(value->v.handle.ptr);
  else if (scr_dyn_bytes_is(value, SCR_BYTES_U8)) path = scr_bytes_string(value->v.bytes, 0, value->v.bytes->len);
  else {
    scr_dyn_arg_type_fail("path", "of type string or an instance of Buffer or URL", value);
    return;
  }
  if (!path) return;
  if (memchr(path->data, 0, path->len)) {
    scr_fs_invalid_path(value, path);
    scr_str_release(path);
    return;
  }
  ScrStr *content = scr_fs_read_file_core(path, true, NULL);
  scr_str_release(path);
  if (!content) return;
  ScrDyn *entries = scr_env_parse_content(content, false);
  scr_str_release(content);
  for (size_t i = 0; i < entries->v.obj.len; i++) {
    const ScrDynEntry *entry = &entries->v.obj.entries[i];
    /* Node normalizes each raw sorted entry immediately before checking
     * the environment. Distinct invalid byte keys can normalize alike;
     * the first absent name wins, rather than the last parsed entry. */
    ScrStr *key = scr_str_from_utf8_lossy((const uint8_t *)entry->key, entry->key_len);
    ScrStr *existing = scr_env_get(key);
    if (!existing) {
      const ScrStr *raw = entry->value->v.str;
      ScrStr *value = scr_str_from_utf8_lossy((const uint8_t *)raw->data, raw->len);
      scr_env_set(key, value);
      scr_str_release(value);
    }
    scr_str_release(existing);
    scr_str_release(key);
  }
  scr_dyn_release(entries);
}

/* The whole environment as one fresh string[] of alternating
 * [k0, v0, k1, v1, ...] entries in environ order — the raw material of the
 * compiler's process.env snapshot record (insertion order = environ order,
 * which is Node's own Object.keys(process.env) order). Entries without '='
 * (not producible by setenv) are skipped; the value is everything after
 * the FIRST '='. +1 array. */
ScrArr *scr_env_pairs(void) {
#ifdef SCR_WORKERS
  ScrArr *local = scr_context_env_pairs();
  if (local) return local;
#endif
  ScrArr *out = scr_arr_new(SCR_ELEM_STR, 0);
#ifdef _WIN32
  /* The WIN32 environment block (see scr_env_get): NUL-separated
   * "K=V" entries, double-NUL terminated. Entries whose first byte is
   * '=' are the hidden per-drive cwd variables ("=C:=..."), which libuv
   * (and so Node's process.env) also skips. */
  char *block = GetEnvironmentStringsA();
  if (block != NULL) {
    for (char *e = block; *e != '\0'; e += strlen(e) + 1) {
      const char *eq = strchr(e, '=');
      if (!eq || eq == e) continue;
      scr_arr_push_ref(out, scr_str_new(e, (size_t)(eq - e)));
      scr_arr_push_ref(out, scr_str_new(eq + 1, strlen(eq + 1)));
    }
    FreeEnvironmentStringsA(block);
  }
#else
  for (char **e = environ; *e != NULL; e++) {
    const char *eq = strchr(*e, '=');
    if (!eq || eq == *e) continue;
    scr_arr_push_ref(out, scr_str_new(*e, (size_t)(eq - *e)));
    scr_arr_push_ref(out, scr_str_new(eq + 1, strlen(eq + 1)));
  }
#endif
  return out;
}

/* ── process.pid / process.getuid / process.kill ─────────────────────── */

double scr_process_pid(void) { return (double)getpid(); }

#if defined(_WIN32) || defined(__wasi__)
/* No uids/gids exist on Windows: Node's process object simply has no
 * getuid/getgid members there, so a call is the property-access TypeError
 * below — thrown catchably, exactly what `process.getuid()` does under
 * Windows Node. WASI has no uid/gid process model either. */
double scr_process_getuid(void) {
  scr_throw_error_msg(SCR_ERR_TYPE, "process.getuid is not a function", 32);
  return 0;
}

double scr_process_getgid(void) {
  scr_throw_error_msg(SCR_ERR_TYPE, "process.getgid is not a function", 32);
  return 0;
}
#else
double scr_process_getuid(void) { return (double)getuid(); }

double scr_process_getgid(void) { return (double)getgid(); }
#endif

/* Node's signal-name table (the names uv exposes), resolved to the HOST's
 * numbers via the POSIX constants. Node accepts names with the SIG prefix
 * only. On Windows the C runtime defines only the ANSI six (INT, ILL,
 * ABRT, FPE, SEGV, TERM) plus SIGBREAK — libuv fills in the numbers below
 * for the handful more it emulates, and Node's os.constants.signals shows
 * exactly that union, so the same defines keep the two tables' Windows
 * rows Node-identical; every other row #ifdefs away like SIGIO/SIGINFO
 * always did. */
#ifdef _WIN32
#define SIGHUP 1    /* uv's emulated numbers (uv-win.h) */
#define SIGQUIT 3
#define SIGKILL 9
#define SIGWINCH 28
#endif

static int scr_signal_by_name(const char *name) {
  static const struct { const char *name; int sig; } SIGS[] = {
      {"SIGHUP", SIGHUP},   {"SIGINT", SIGINT},       {"SIGQUIT", SIGQUIT},
      {"SIGILL", SIGILL},   {"SIGABRT", SIGABRT},
      {"SIGIOT", SIGABRT},  {"SIGFPE", SIGFPE},
      {"SIGKILL", SIGKILL}, {"SIGSEGV", SIGSEGV},
      {"SIGTERM", SIGTERM}, {"SIGWINCH", SIGWINCH},
#ifdef SIGTRAP
      {"SIGTRAP", SIGTRAP},
#endif
#ifdef SIGBUS
      {"SIGBUS", SIGBUS},
#endif
#ifdef SIGUSR1
      {"SIGUSR1", SIGUSR1}, {"SIGUSR2", SIGUSR2},
#endif
#ifdef SIGPIPE
      {"SIGPIPE", SIGPIPE},
#endif
#ifdef SIGALRM
      {"SIGALRM", SIGALRM},
#endif
#ifdef SIGCHLD
      {"SIGCHLD", SIGCHLD}, {"SIGCONT", SIGCONT},
      {"SIGSTOP", SIGSTOP}, {"SIGTSTP", SIGTSTP},     {"SIGTTIN", SIGTTIN},
      {"SIGTTOU", SIGTTOU}, {"SIGURG", SIGURG},       {"SIGXCPU", SIGXCPU},
      {"SIGXFSZ", SIGXFSZ}, {"SIGVTALRM", SIGVTALRM}, {"SIGPROF", SIGPROF},
      {"SIGSYS", SIGSYS},
#endif
#ifdef SIGBREAK
      {"SIGBREAK", SIGBREAK},
#endif
#ifdef SIGIO
      {"SIGIO", SIGIO},
#endif
#ifdef SIGINFO
      {"SIGINFO", SIGINFO},
#endif
  };
  for (size_t i = 0; i < sizeof SIGS / sizeof SIGS[0]; i++) {
    if (strcmp(SIGS[i].name, name) == 0) return SIGS[i].sig;
  }
  return -1;
}

/* The table above for other units (scr_child.c's child.kill shares Node's
 * one signal-name story): the resolved number, or -1 for unknown names. */
int scr_signal_from_name(const ScrStr *signal) {
  return strlen(signal->data) == signal->len ? scr_signal_by_name(signal->data) : -1;
}

/* The reverse walk, for spawnSync's result.signal: the FIRST name with
 * the number wins (SIGABRT precedes its SIGIOT alias — Node's spelling),
 * NULL for numbers outside the table. Static storage; never freed. */
const char *scr_signal_name(int sig) {
  static const struct { const char *name; int signo; } SIGS[] = {
      {"SIGHUP", SIGHUP},   {"SIGINT", SIGINT},       {"SIGQUIT", SIGQUIT},
      {"SIGILL", SIGILL},
#ifdef SIGTRAP
      {"SIGTRAP", SIGTRAP},
#endif
      {"SIGABRT", SIGABRT},
#ifdef SIGBUS
      {"SIGBUS", SIGBUS},
#endif
      {"SIGFPE", SIGFPE},   {"SIGKILL", SIGKILL},
#ifdef SIGUSR1
      {"SIGUSR1", SIGUSR1},
#endif
      {"SIGSEGV", SIGSEGV},
#ifdef SIGUSR2
      {"SIGUSR2", SIGUSR2},
#endif
#ifdef SIGPIPE
      {"SIGPIPE", SIGPIPE},
#endif
#ifdef SIGALRM
      {"SIGALRM", SIGALRM},
#endif
      {"SIGTERM", SIGTERM},
#ifdef SIGCHLD
      {"SIGCHLD", SIGCHLD}, {"SIGCONT", SIGCONT},     {"SIGSTOP", SIGSTOP},
      {"SIGTSTP", SIGTSTP}, {"SIGTTIN", SIGTTIN},     {"SIGTTOU", SIGTTOU},
      {"SIGURG", SIGURG},   {"SIGXCPU", SIGXCPU},     {"SIGXFSZ", SIGXFSZ},
      {"SIGVTALRM", SIGVTALRM}, {"SIGPROF", SIGPROF},
#endif
      {"SIGWINCH", SIGWINCH},
#ifdef SIGSYS
      {"SIGSYS", SIGSYS},
#endif
#ifdef SIGBREAK
      {"SIGBREAK", SIGBREAK},
#endif
#ifdef SIGIO
      {"SIGIO", SIGIO},
#endif
#ifdef SIGINFO
      {"SIGINFO", SIGINFO},
#endif
  };
  for (size_t i = 0; i < sizeof SIGS / sizeof SIGS[0]; i++) {
    if (SIGS[i].signo == sig) return SIGS[i].name;
  }
  return NULL;
}

/* Node validates the pid as an int32 BEFORE kill(2) and throws the
 * ERR_INVALID_ARG_TYPE TypeError with this exact (odd) wording. */
static bool scr_kill_pid_check(double pid) {
  if (pid >= -2147483648.0 && pid <= 2147483647.0 && pid == (double)(long long)pid) {
    return true; /* NaN fails both range comparisons */
  }
  char num[32];
  scr_f64_to_str(pid, num);
  char msg[96];
  int len = snprintf(msg, sizeof msg,
                     "The \"pid\" argument must be of type number. "
                     "Received type number (%s)",
                     num);
  scr_throw_error_msg(SCR_ERR_TYPE, msg, (size_t)len);
  return false;
}

/* The shared kill(2) tail: signal 0 probes; failure throws Node's terse
 * `kill ESRCH` / `kill EPERM` Error. Returns Node's constant true.
 * Windows: uv_kill's behavior — signal 0 opens the process to probe
 * liveness, anything else is TerminateProcess (no signal exists to
 * deliver; the target dies with exit code 1, exactly Node-on-Windows's
 * process.kill). ESRCH/EPERM map from the open failure. */
#ifdef _WIN32
static int scr_win_kill(int pid, int sig) {
  HANDLE h = OpenProcess(
      sig == 0 ? PROCESS_QUERY_LIMITED_INFORMATION : PROCESS_TERMINATE,
      FALSE, (DWORD)pid);
  if (h == NULL) {
    errno = GetLastError() == ERROR_ACCESS_DENIED ? EPERM : ESRCH;
    return -1;
  }
  BOOL ok = sig == 0 ? TRUE : TerminateProcess(h, 1);
  CloseHandle(h);
  if (!ok) {
    errno = EPERM;
    return -1;
  }
  return 0;
}
#define scr_sys_kill(pid, sig) scr_win_kill((int)(pid), (sig))
#elif defined(__wasi__)
static int scr_wasi_kill(int pid, int sig) {
  (void)pid;
  (void)sig;
  errno = ENOSYS;
  return -1;
}
#define scr_sys_kill(pid, sig) scr_wasi_kill((int)(pid), (sig))
#else
#define scr_sys_kill(pid, sig) kill((pid_t)(pid), (sig))
#endif

static bool scr_kill_send(int pid, int sig) {
  if (scr_sys_kill(pid, sig) == 0) return true;
  const char *name = errno == ESRCH   ? "ESRCH"
                     : errno == EPERM ? "EPERM"
                     : errno == EINVAL ? "EINVAL"
                                       : NULL;
  char msg[32];
  int len;
  if (name) {
    len = snprintf(msg, sizeof msg, "kill %s", name);
    /* Node's errnoException carries code = the errno name. */
    scr_throw_error_msg_code(SCR_ERR_ERROR, msg, (size_t)len, name);
  } else {
    len = snprintf(msg, sizeof msg, "kill E%d", errno);
    scr_throw_error_msg(SCR_ERR_ERROR, msg, (size_t)len);
  }
  return false;
}

bool scr_process_kill(double pid, double signum) {
  if (!scr_kill_pid_check(pid)) return false;
  return scr_kill_send((int)pid, (int)signum);
}

bool scr_process_kill_named(double pid, const ScrStr *signal) {
  if (!scr_kill_pid_check(pid)) return false;
  int sig = scr_signal_by_name(signal->data);
  if (sig < 0) {
    /* Node's ERR_UNKNOWN_SIGNAL TypeError. */
    size_t cap = 16 + signal->len + 1;
    char *msg = malloc(cap);
    if (!msg) {
      scr_trap("scriptc: out of memory\n");
    }
    int len = snprintf(msg, cap, "Unknown signal: %s", signal->data);
    scr_throw_error_msg(SCR_ERR_TYPE, msg, (size_t)len);
    free(msg);
    return false;
  }
  return scr_kill_send((int)pid, sig);
}

ScrStr *scr_process_cwd(void) {
#ifdef _WIN32
  DWORD size = GetCurrentDirectoryW(0, NULL);
  if (!size) scr_trap("scriptc: process.cwd() failed\n");
  WCHAR *wide = malloc((size_t)size * sizeof *wide);
  if (!wide) scr_trap("scriptc: out of memory\n");
  DWORD length = GetCurrentDirectoryW(size, wide);
  ScrStr *result = length > 0 && length < size ? scr_fs_win_utf8(wide, length) : NULL;
  free(wide);
  if (!result) scr_trap("scriptc: process.cwd() failed\n");
  return result;
#else
  char buf[4096];
  if (!getcwd(buf, sizeof buf)) {
    scr_trap("scriptc: process.cwd() failed\n");
  }
  return scr_str_new(buf, strlen(buf));
#endif
}

/* The raw byte writes use the SAME stdio stream as console, and each call
 * flushes before returning so live consumers see Node's source order without
 * an observable C buffering delay. The boolean is Node's backpressure signal
 * — this synchronous runtime has no queued backpressure, so it is constantly
 * true. */
bool scr_process_stdout_write(const ScrStr *data) {
  return scr_stdio_write_str(1, data);
}

bool scr_process_stderr_write(const ScrStr *data) {
  return scr_stdio_write_str(2, data);
}

/* The FIRST-CLASS stream write (`output.write(line)` where output is a
 * WritableStream-typed value — the prefixStream idiom): the value is the
 * stream's fd (1 or 2, minted by the process.stdout/stderr reads), and
 * the write dispatches onto the exact stdout/stderr paths above so
 * prompt submission and ordering stay identical. */
bool scr_proc_stream_write(double fd, const ScrStr *data) {
  return (int)fd == 2 ? scr_process_stderr_write(data) : scr_process_stdout_write(data);
}

/* ── os ──────────────────────────────────────────────────────────────
 * os.platform() lowers to scr_process_platform (one implementation).
 * homedir/tmpdir follow libuv's POSIX rules, which Node delegates to.
 */

#ifdef _WIN32
/* uv_os_homedir on Windows: %USERPROFILE% first, then the profile
 * directory API. The env var covers every real session; abort matches
 * the POSIX arm's stance on the unreachable failure. */
ScrStr *scr_os_homedir(void) {
  const char *home = scr_getenv("USERPROFILE");
  if (home && home[0] != '\0') return scr_str_new(home, strlen(home));
  scr_trap("scriptc: os.homedir() failed\n");
}

ScrStr *scr_os_user_name(void) {
  char buf[UNLEN + 1];
  DWORD n = sizeof buf;
  if (!GetUserNameA(buf, &n) || n == 0) {
    scr_trap("scriptc: os.userInfo() failed\n");
  }
  return scr_str_new(buf, n - 1); /* n counts the NUL */
}

ScrStr *scr_os_user_shell(void) {
  /* Node's userInfo().shell is null on Windows; the scriptc surface types
   * it string, so the closest honest spelling is "" (divergence noted in
   * the windows report). */
  return scr_str_new("", 0);
}

ScrStr *scr_os_user_homedir(void) {
  return scr_os_homedir(); /* uv_os_get_passwd reuses uv_os_homedir on win */
}

ScrStr *scr_os_release(void) {
  /* uv_os_uname on Windows: RtlGetVersion (the un-lied-to GetVersionEx),
   * rendered "major.minor.build" — Node answers e.g. "10.0.26100". */
  typedef LONG(WINAPI * RtlGetVersionFn)(PRTL_OSVERSIONINFOW);
  RTL_OSVERSIONINFOW info;
  memset(&info, 0, sizeof info);
  info.dwOSVersionInfoSize = sizeof info;
  HMODULE ntdll = GetModuleHandleA("ntdll.dll");
  RtlGetVersionFn fn =
      ntdll ? (RtlGetVersionFn)(void *)GetProcAddress(ntdll, "RtlGetVersion") : NULL;
  if (fn == NULL || fn(&info) != 0) {
    scr_trap("scriptc: os.release() failed\n");
  }
  char buf[64];
  int len = snprintf(buf, sizeof buf, "%lu.%lu.%lu", (unsigned long)info.dwMajorVersion,
                     (unsigned long)info.dwMinorVersion, (unsigned long)info.dwBuildNumber);
  return scr_str_new(buf, (size_t)len);
}

ScrStr *scr_os_type(void) {
  /* uv_os_uname's sysname on Windows is the constant "Windows_NT". */
  return scr_str_new("Windows_NT", 10);
}

double scr_os_available_parallelism(void) {
  /* uv_available_parallelism on Windows: GetSystemInfo's processor count. */
  SYSTEM_INFO info;
  GetSystemInfo(&info);
  return info.dwNumberOfProcessors < 1 ? 1 : (double)info.dwNumberOfProcessors;
}

double scr_os_totalmem(void) {
  MEMORYSTATUSEX ms;
  memset(&ms, 0, sizeof ms);
  ms.dwLength = sizeof ms;
  if (!GlobalMemoryStatusEx(&ms)) return 0;
  return (double)ms.ullTotalPhys;
}

ScrStr *scr_os_tmpdir(void) {
  /* GetTempPathA is libuv's source (TMP → TEMP → USERPROFILE → windir),
   * with Node's one-trailing-separator trim. */
  char buf[MAX_PATH + 2];
  DWORD n = GetTempPathA(sizeof buf, buf);
  if (n == 0 || n >= sizeof buf) {
    scr_trap("scriptc: os.tmpdir() failed\n");
  }
  size_t len = n;
  if (len > 1 && (buf[len - 1] == '\\' || buf[len - 1] == '/')) len--;
  return scr_str_new(buf, len);
}
#elif defined(__wasi__)
/* WASI has an inherited environment but no passwd database, uname, or
 * physical-memory query. Keep the useful environment-backed answers and
 * spell the platform explicitly for the rest. */
ScrStr *scr_os_homedir(void) {
  const char *home = scr_getenv("HOME");
  return scr_str_new(home ? home : "", home ? strlen(home) : 0);
}
ScrStr *scr_os_user_name(void) {
  const char *user = scr_getenv("USER");
  return scr_str_new(user ? user : "", user ? strlen(user) : 0);
}
ScrStr *scr_os_user_shell(void) { return scr_str_new("", 0); }
ScrStr *scr_os_user_homedir(void) { return scr_os_homedir(); }
ScrStr *scr_os_release(void) { return scr_str_new("", 0); }
ScrStr *scr_os_type(void) { return scr_str_new("WASI", 4); }
double scr_os_totalmem(void) { return 0; }
/* WASI modules run on one thread of execution. */
double scr_os_available_parallelism(void) { return 1; }
/* The guest temp namespace is stable across hosts. `scriptc run` preopens
 * the host's /tmp at this path; other WASI hosts can provide the same
 * capability without leaking a host-specific TMPDIR into the module. */
ScrStr *scr_os_tmpdir(void) { return scr_str_new("/tmp", 4); }
#else
ScrStr *scr_os_homedir(void) {
  /* uv_os_homedir: $HOME when set (even empty is "set" only if non-NULL;
   * libuv requires non-empty), else the passwd entry. */
  const char *home = scr_getenv("HOME");
  if (home && home[0] != '\0') return scr_str_new(home, strlen(home));
  struct passwd pw;
  struct passwd *result = NULL;
  char buf[8192];
  if (getpwuid_r(getuid(), &pw, buf, sizeof buf, &result) != 0 || !result || !result->pw_dir) {
    scr_trap("scriptc: os.homedir() failed\n");
  }
  return scr_str_new(result->pw_dir, strlen(result->pw_dir));
}

/* The os.userInfo() field trio — uv_os_get_passwd's slices. One passwd
 * lookup per call (three calls per userInfo record — cheap, no caching
 * to invalidate). Failure aborts: Node throws a system error there, but
 * no compiled program path reaches it for the running uid. */
static const struct passwd *scr_os_passwd(char *buf, size_t cap, struct passwd *pw) {
  struct passwd *result = NULL;
  if (getpwuid_r(getuid(), pw, buf, cap, &result) != 0 || !result) {
    scr_trap("scriptc: os.userInfo() failed\n");
  }
  return result;
}

ScrStr *scr_os_user_name(void) {
  struct passwd pw;
  char buf[8192];
  const struct passwd *r = scr_os_passwd(buf, sizeof buf, &pw);
  return scr_str_new(r->pw_name, strlen(r->pw_name));
}

ScrStr *scr_os_user_shell(void) {
  struct passwd pw;
  char buf[8192];
  const struct passwd *r = scr_os_passwd(buf, sizeof buf, &pw);
  const char *sh = r->pw_shell ? r->pw_shell : "";
  return scr_str_new(sh, strlen(sh));
}

ScrStr *scr_os_user_homedir(void) {
  /* The PASSWD home (pw_dir) — Node's userInfo().homedir, distinct from
   * os.homedir()'s $HOME-first cascade. */
  struct passwd pw;
  char buf[8192];
  const struct passwd *r = scr_os_passwd(buf, sizeof buf, &pw);
  return scr_str_new(r->pw_dir, strlen(r->pw_dir));
}

ScrStr *scr_os_release(void) {
  /* uname(2)'s release field — Node's uv_os_uname()-backed answer. */
  struct utsname u;
  if (uname(&u) != 0) {
    scr_trap("scriptc: os.release() failed\n");
  }
  return scr_str_new(u.release, strlen(u.release));
}

ScrStr *scr_os_type(void) {
  /* uname(2)'s sysname field ("Darwin", "Linux") — Node's os.type(). */
  struct utsname u;
  if (uname(&u) != 0) {
    scr_trap("scriptc: os.type() failed\n");
  }
  return scr_str_new(u.sysname, strlen(u.sysname));
}

#ifdef __linux__
/* libuv's uv__slurp: one read of at most cap - 1 bytes of path into buf
 * (NUL-terminated); false when the file cannot be opened or read. A single
 * read, like libuv, so a long /proc/self/cgroup is cut where Node cuts it. */
static bool scr_os_slurp(const char *path, char *buf, size_t cap) {
  int fd = open(path, O_RDONLY | O_CLOEXEC);
  if (fd < 0) return false;
  ssize_t n;
  do
    n = read(fd, buf, cap - 1);
  while (n < 0 && errno == EINTR);
  close(fd);
  if (n < 0) return false;
  buf[n] = '\0';
  return true;
}

/* libuv's uv__get_constrained_cpu (1.51): the CPU quota of the process's
 * cgroup in whole CPUs. For cgroup v2 it walks cpu.max from the process's
 * cgroup up to the root; like libuv, the last level with a numeric limit
 * (the outermost) decides. Returns false when there is no answer. */
static bool scr_os_cgroup_cpu_quota(long long *quota) {
  char cgroup[1024];
  if (!scr_os_slurp("/proc/self/cgroup", cgroup, sizeof cgroup)) return false;
  if (strncmp(cgroup, "0::/", 4) == 0) {
    static const char mount[] = "/sys/fs/cgroup";
    const char *trimmed = cgroup + 4;
    int size = (int)strcspn(trimmed, "\n");
    char path[256], file[256], buf[1024], value[16];
    snprintf(path, sizeof path, "%s/%.*s/cgroup.controllers", mount, size, trimmed);
    if (!scr_os_slurp(path, buf, sizeof buf)) return false;
    snprintf(path, sizeof path, "%s/%.*s", mount, size, trimmed);
    while (strncmp(path, mount, sizeof mount - 1) == 0) {
      long long limit, period;
      snprintf(file, sizeof file, "%s/cpu.max", path);
      if (scr_os_slurp(file, value, sizeof value) && strncmp(value, "max", 3) != 0 &&
          sscanf(value, "%lld %lld", &limit, &period) == 2 && period != 0)
        *quota = limit / period;
      char *slash = strrchr(path, '/');
      if (slash == NULL || strcmp(path, mount) == 0) break;
      *slash = '\0';
    }
    return true;
  }
  char *cpu = strstr(cgroup, ":cpu,");
  if (cpu == NULL) return false;
  cpu += sizeof ":cpu," - 1;
  int size = (int)strcspn(cpu, "\n");
  char path[256], buf[64];
  long long per_period, period;
  snprintf(path, sizeof path, "/sys/fs/cgroup/%.*s/cpu.cfs_quota_us", size, cpu);
  if (!scr_os_slurp(path, buf, sizeof buf) || sscanf(buf, "%lld", &per_period) != 1) return false;
  snprintf(path, sizeof path, "/sys/fs/cgroup/%.*s/cpu.cfs_period_us", size, cpu);
  if (!scr_os_slurp(path, buf, sizeof buf) || sscanf(buf, "%lld", &period) != 1 || period == 0)
    return false;
  *quota = per_period / period;
  return true;
}
#endif

double scr_os_available_parallelism(void) {
  /* uv_available_parallelism (libuv 1.51, Node's os.availableParallelism):
   * the CPUs this process may run on (Linux: its affinity mask, then any
   * smaller cgroup CPU quota; Darwin: hw.activecpu, hw.logicalcpu, hw.ncpu),
   * else the online processors; at least 1. */
  long rc = -1;
#if defined(__linux__)
  cpu_set_t set;
  memset(&set, 0, sizeof set);
  if (sched_getaffinity(0, sizeof set, &set) == 0) rc = CPU_COUNT(&set);
#elif defined(__APPLE__)
  static const char *const mib[] = {"hw.activecpu", "hw.logicalcpu", "hw.ncpu"};
  for (size_t i = 0; i < sizeof mib / sizeof mib[0]; i++) {
    int nprocs = 0;
    size_t len = sizeof nprocs;
    if (sysctlbyname(mib[i], &nprocs, &len, NULL, 0) == 0 && len == sizeof nprocs && nprocs > 0) {
      rc = nprocs;
      break;
    }
  }
#endif
  if (rc < 0) rc = sysconf(_SC_NPROCESSORS_ONLN);
#if defined(__linux__)
  /* A quota below one CPU truncates to 0 and is ignored, not clamped to 1:
   * libuv (1.51 through 1.52) applies only `quota > 0 && quota < rc`, so
   * Node then answers the affinity count. */
  long long quota = 0;
  if (scr_os_cgroup_cpu_quota(&quota) && quota > 0 && quota < rc) rc = (long)quota;
#endif
  return rc < 1 ? 1 : (double)rc;
}

double scr_os_totalmem(void) {
  /* Total physical memory in bytes (sysconf pages × page size — Darwin
   * and Linux both answer _SC_PHYS_PAGES). */
  long pages = sysconf(_SC_PHYS_PAGES);
  long psize = sysconf(_SC_PAGE_SIZE);
  if (pages <= 0 || psize <= 0) return 0;
  return (double)pages * (double)psize;
}

ScrStr *scr_os_tmpdir(void) {
  /* Node's env cascade, with ONE trailing slash trimmed (never down to
   * nothing: "/" stays "/"). */
  const char *dir = scr_getenv("TMPDIR");
  if (!dir || dir[0] == '\0') dir = scr_getenv("TMP");
  if (!dir || dir[0] == '\0') dir = scr_getenv("TEMP");
  if (!dir || dir[0] == '\0') dir = "/tmp";
  size_t len = strlen(dir);
  if (len > 1 && dir[len - 1] == '/') len--;
  return scr_str_new(dir, len);
}
#endif /* _WIN32 */

/* ── os.networkInterfaces(): the getifaddrs(3) snapshot ────────────────
 * Row selection and field semantics follow libuv (src/unix/bsd-ifaddrs.c),
 * which Node delegates to: an entry contributes a row iff its interface is
 * IFF_UP && IFF_RUNNING, its address is present, and its family is
 * AF_INET/AF_INET6; `internal` is IFF_LOOPBACK; MACs come from the
 * interface's link-level sibling entry (AF_LINK/AF_PACKET, matched by
 * name), all-zeros when there is none; cidr is Node's lib/os.js
 * computation — address/<contiguous netmask prefix>, null when the netmask
 * is non-contiguous (never in practice). Row order is getifaddrs
 * enumeration order, which is also Node's — but Node guarantees no order,
 * so consumers should compare structurally. The emitter walks the snapshot
 * through the accessors below and builds the typed record inline; a
 * getifaddrs failure (effectively unreachable) yields an empty snapshot
 * where Node would throw ERR_SYSTEM_ERROR. */

typedef struct ScrIfaddrRow {
  char name[64];
  char address[INET6_ADDRSTRLEN];
  char netmask[INET6_ADDRSTRLEN];
  char cidr[INET6_ADDRSTRLEN + 5]; /* address + "/128" */
  bool has_cidr;
  char mac[18]; /* "aa:bb:cc:dd:ee:ff" */
  bool internal;
  bool ipv6;
  double scopeid;
} ScrIfaddrRow;

struct ScrIfaddrs {
  size_t n;
  ScrIfaddrRow *rows;
};

#ifdef _WIN32
/* The Windows arm mirrors libuv's uv_interface_addresses (src/win/util.c),
 * which Node delegates to: GetAdaptersAddresses(AF_UNSPEC, INCLUDE_PREFIX
 * + the SKIP_* flags libuv passes), an adapter contributes rows iff
 * OperStatus == IfOperStatusUp and it has a unicast address, the row name
 * is the adapter's FriendlyName (UTF-8), `internal` is the software-
 * loopback interface type, MAC comes from PhysicalAddress (all-zeros when
 * absent — the loopback), the netmask is built from each unicast
 * address's OnLinkPrefixLength, and scopeid is the v6 sockaddr's. cidr is
 * the shared prefix computation below (always contiguous here by
 * construction). A snapshot failure yields the empty dict, the historical
 * stance. */
ScrIfaddrs *scr_os_ifaddrs(void) {
  ScrIfaddrs *s = calloc(1, sizeof *s);
  if (!s) scr_trap("scriptc: out of memory\n");
  ULONG flags = GAA_FLAG_INCLUDE_PREFIX | GAA_FLAG_SKIP_ANYCAST | GAA_FLAG_SKIP_MULTICAST |
                GAA_FLAG_SKIP_DNS_SERVER;
  ULONG size = 16 * 1024;
  IP_ADAPTER_ADDRESSES *adapters = NULL;
  for (int tries = 0; tries < 4; tries++) {
    adapters = realloc(adapters, size);
    if (!adapters) scr_trap("scriptc: out of memory\n");
    ULONG rc = GetAdaptersAddresses(AF_UNSPEC, flags, NULL, adapters, &size);
    if (rc == ERROR_SUCCESS) break;
    if (rc != ERROR_BUFFER_OVERFLOW) {
      free(adapters);
      s->rows = calloc(1, sizeof *s->rows);
      if (!s->rows) scr_trap("scriptc: out of memory\n");
      return s; /* empty snapshot */
    }
  }
  size_t count = 0;
  for (IP_ADAPTER_ADDRESSES *a = adapters; a != NULL; a = a->Next) {
    if (a->OperStatus != IfOperStatusUp || a->FirstUnicastAddress == NULL) continue;
    for (IP_ADAPTER_UNICAST_ADDRESS *u = a->FirstUnicastAddress; u != NULL; u = u->Next) {
      int fam = u->Address.lpSockaddr->sa_family;
      if (fam == AF_INET || fam == AF_INET6) count++;
    }
  }
  s->rows = calloc(count ? count : 1, sizeof *s->rows);
  if (!s->rows) scr_trap("scriptc: out of memory\n");
  for (IP_ADAPTER_ADDRESSES *a = adapters; a != NULL; a = a->Next) {
    if (a->OperStatus != IfOperStatusUp || a->FirstUnicastAddress == NULL) continue;
    char name[64] = "";
    WideCharToMultiByte(CP_UTF8, 0, a->FriendlyName, -1, name, sizeof name - 1, NULL, NULL);
    char mac[18];
    if (a->PhysicalAddressLength == 6) {
      snprintf(mac, sizeof mac, "%02x:%02x:%02x:%02x:%02x:%02x", a->PhysicalAddress[0],
               a->PhysicalAddress[1], a->PhysicalAddress[2], a->PhysicalAddress[3],
               a->PhysicalAddress[4], a->PhysicalAddress[5]);
    } else {
      snprintf(mac, sizeof mac, "00:00:00:00:00:00");
    }
    bool internal = a->IfType == IF_TYPE_SOFTWARE_LOOPBACK;
    for (IP_ADAPTER_UNICAST_ADDRESS *u = a->FirstUnicastAddress; u != NULL; u = u->Next) {
      int fam = u->Address.lpSockaddr->sa_family;
      if (fam != AF_INET && fam != AF_INET6) continue;
      if (s->n == count) break; /* the topology raced the two passes */
      ScrIfaddrRow *row = &s->rows[s->n++];
      snprintf(row->name, sizeof row->name, "%s", name);
      memcpy(row->mac, mac, sizeof mac);
      row->internal = internal;
      unsigned prefix = u->OnLinkPrefixLength;
      if (fam == AF_INET6) {
        const struct sockaddr_in6 *sa = (const struct sockaddr_in6 *)u->Address.lpSockaddr;
        row->ipv6 = true;
        row->scopeid = (double)sa->sin6_scope_id;
        inet_ntop(AF_INET6, (void *)&sa->sin6_addr, row->address, sizeof row->address);
        unsigned char mask[16];
        if (prefix > 128) prefix = 128;
        for (size_t i = 0; i < 16; i++) {
          unsigned bits = prefix > 8 * i ? prefix - 8 * i : 0;
          mask[i] = bits >= 8 ? 0xff : (unsigned char)(0xff00 >> bits);
        }
        inet_ntop(AF_INET6, mask, row->netmask, sizeof row->netmask);
        row->has_cidr = true;
        snprintf(row->cidr, sizeof row->cidr, "%s/%u", row->address, prefix);
      } else {
        const struct sockaddr_in *sa = (const struct sockaddr_in *)u->Address.lpSockaddr;
        inet_ntop(AF_INET, (void *)&sa->sin_addr, row->address, sizeof row->address);
        if (prefix > 32) prefix = 32;
        uint32_t mask = prefix == 0 ? 0 : 0xffffffffu << (32 - prefix);
        struct in_addr m;
        m.s_addr = htonl(mask);
        inet_ntop(AF_INET, (void *)&m, row->netmask, sizeof row->netmask);
        row->has_cidr = true;
        snprintf(row->cidr, sizeof row->cidr, "%s/%u", row->address, prefix);
      }
    }
  }
  free(adapters);
  return s;
}
#else
/* libuv's uv__ifaddr_exclude for the address pass, plus the explicit
 * INET/INET6 family filter (the only families Node's binding reports). */
static bool scr_ifaddr_row_ok(const struct ifaddrs *ent) {
  if (!((ent->ifa_flags & IFF_UP) && (ent->ifa_flags & IFF_RUNNING))) return false;
  if (ent->ifa_addr == NULL) return false;
  int fam = ent->ifa_addr->sa_family;
  return fam == AF_INET || fam == AF_INET6;
}

/* Node's getCIDR (lib/os.js): the netmask's contiguous 1-bit prefix.
 * Returns -1 for a non-contiguous mask (cidr is then null). */
static int scr_netmask_prefix(const unsigned char *bytes, size_t len) {
  int ones = 0;
  bool zero_seen = false;
  for (size_t i = 0; i < len; i++) {
    unsigned char b = bytes[i];
    for (int bit = 7; bit >= 0; bit--) {
      if (b & (1u << bit)) {
        if (zero_seen) return -1; /* a 1 after a 0: split mask */
        ones++;
      } else {
        zero_seen = true;
      }
    }
  }
  return ones;
}

ScrIfaddrs *scr_os_ifaddrs(void) {
  ScrIfaddrs *s = calloc(1, sizeof *s);
  if (!s) scr_trap("scriptc: out of memory\n");
  struct ifaddrs *addrs = NULL;
  if (getifaddrs(&addrs) != 0) return s;
  size_t count = 0;
  for (struct ifaddrs *ent = addrs; ent != NULL; ent = ent->ifa_next) {
    if (scr_ifaddr_row_ok(ent)) count++;
  }
  s->rows = calloc(count ? count : 1, sizeof *s->rows);
  if (!s->rows) scr_trap("scriptc: out of memory\n");
  for (struct ifaddrs *ent = addrs; ent != NULL; ent = ent->ifa_next) {
    if (!scr_ifaddr_row_ok(ent)) continue;
    ScrIfaddrRow *row = &s->rows[s->n++];
    snprintf(row->name, sizeof row->name, "%s", ent->ifa_name);
    snprintf(row->mac, sizeof row->mac, "00:00:00:00:00:00");
    row->internal = (ent->ifa_flags & IFF_LOOPBACK) != 0;
    unsigned char maskbytes[16];
    size_t masklen = 0;
    if (ent->ifa_addr->sa_family == AF_INET6) {
      const struct sockaddr_in6 *sa = (const struct sockaddr_in6 *)ent->ifa_addr;
      row->ipv6 = true;
      row->scopeid = (double)sa->sin6_scope_id;
      inet_ntop(AF_INET6, &sa->sin6_addr, row->address, sizeof row->address);
      /* A NULL netmask stays zeroed, exactly libuv's memset — "::"/0. */
      struct in6_addr mask;
      memset(&mask, 0, sizeof mask);
      if (ent->ifa_netmask != NULL) {
        mask = ((const struct sockaddr_in6 *)ent->ifa_netmask)->sin6_addr;
      }
      inet_ntop(AF_INET6, &mask, row->netmask, sizeof row->netmask);
      memcpy(maskbytes, &mask, 16);
      masklen = 16;
    } else {
      const struct sockaddr_in *sa = (const struct sockaddr_in *)ent->ifa_addr;
      inet_ntop(AF_INET, &sa->sin_addr, row->address, sizeof row->address);
      struct in_addr mask;
      memset(&mask, 0, sizeof mask);
      if (ent->ifa_netmask != NULL) {
        mask = ((const struct sockaddr_in *)ent->ifa_netmask)->sin_addr;
      }
      inet_ntop(AF_INET, &mask, row->netmask, sizeof row->netmask);
      memcpy(maskbytes, &mask, 4);
      masklen = 4;
    }
    int prefix = scr_netmask_prefix(maskbytes, masklen);
    if (prefix >= 0) {
      row->has_cidr = true;
      snprintf(row->cidr, sizeof row->cidr, "%s/%d", row->address, prefix);
    }
  }
  /* MAC pass: the link-level sibling entry, matched by interface name —
   * every row of that interface gets its physical address. */
  for (struct ifaddrs *ent = addrs; ent != NULL; ent = ent->ifa_next) {
    if (!((ent->ifa_flags & IFF_UP) && (ent->ifa_flags & IFF_RUNNING))) continue;
    if (ent->ifa_addr == NULL) continue;
    const unsigned char *phys = NULL;
#if defined(__APPLE__) || defined(__FreeBSD__) || defined(__OpenBSD__) || defined(__NetBSD__)
    if (ent->ifa_addr->sa_family == AF_LINK) {
      const struct sockaddr_dl *sdl = (const struct sockaddr_dl *)ent->ifa_addr;
      if (sdl->sdl_alen == 6) phys = (const unsigned char *)LLADDR(sdl);
    }
#elif defined(__linux__)
    if (ent->ifa_addr->sa_family == AF_PACKET) {
      const struct sockaddr_ll *sll = (const struct sockaddr_ll *)ent->ifa_addr;
      if (sll->sll_halen == 6) phys = sll->sll_addr;
    }
#endif
    if (!phys) continue;
    for (size_t i = 0; i < s->n; i++) {
      if (strcmp(s->rows[i].name, ent->ifa_name) != 0) continue;
      snprintf(s->rows[i].mac, sizeof s->rows[i].mac, "%02x:%02x:%02x:%02x:%02x:%02x",
               phys[0], phys[1], phys[2], phys[3], phys[4], phys[5]);
    }
  }
  freeifaddrs(addrs);
  return s;
}
#endif /* _WIN32 */

size_t scr_os_ifaddrs_count(const ScrIfaddrs *s) { return s->n; }
ScrStr *scr_os_ifaddrs_name(const ScrIfaddrs *s, size_t i) {
  return scr_str_new(s->rows[i].name, strlen(s->rows[i].name));
}
ScrStr *scr_os_ifaddrs_address(const ScrIfaddrs *s, size_t i) {
  return scr_str_new(s->rows[i].address, strlen(s->rows[i].address));
}
ScrStr *scr_os_ifaddrs_netmask(const ScrIfaddrs *s, size_t i) {
  return scr_str_new(s->rows[i].netmask, strlen(s->rows[i].netmask));
}
ScrStr *scr_os_ifaddrs_family(const ScrIfaddrs *s, size_t i) {
  return s->rows[i].ipv6 ? scr_str_new("IPv6", 4) : scr_str_new("IPv4", 4);
}
ScrStr *scr_os_ifaddrs_mac(const ScrIfaddrs *s, size_t i) {
  return scr_str_new(s->rows[i].mac, strlen(s->rows[i].mac));
}
bool scr_os_ifaddrs_internal(const ScrIfaddrs *s, size_t i) { return s->rows[i].internal; }
bool scr_os_ifaddrs_ipv6(const ScrIfaddrs *s, size_t i) { return s->rows[i].ipv6; }
/* +1 cidr string, or NULL for the null arm (split netmask). */
ScrStr *scr_os_ifaddrs_cidr(const ScrIfaddrs *s, size_t i) {
  if (!s->rows[i].has_cidr) return NULL;
  return scr_str_new(s->rows[i].cidr, strlen(s->rows[i].cidr));
}
double scr_os_ifaddrs_scopeid(const ScrIfaddrs *s, size_t i) { return s->rows[i].scopeid; }
void scr_os_ifaddrs_free(ScrIfaddrs *s) {
  free(s->rows);
  free(s);
}

/* The events-unit hooks (scr_events.c fills them at install; NULL in
 * event-free binaries and in the standalone runtime C tests). */
SCR_TL void (*scr_process_exit_hook)(double code) = NULL;
SCR_TL void (*scr_warning_emit_hook)(const char *name, const char *code, ScrStr *message) = NULL;
SCR_TL bool scr_warning_trace_hint_shown = false;
SCR_TL void (*scr_stdin_destroy_hook)(void) = NULL;

/* process.exitCode's validation: a safe integer, or a RangeError
 * (ERR_OUT_OF_RANGE). Node converts valid codes to signed int32 for
 * exitCode and exit listeners; the OS observes the low eight bits. */
static bool scr_process_exit_code_of(double code, int *out) {
  if (!isfinite(code) || trunc(code) != code) {
    char recv[48], msg[160];
    scr_num_received(code, recv);
    int len = snprintf(msg, sizeof msg,
                       "The value of \"code\" is out of range. It must be an integer. Received %s", recv);
    scr_throw_error_msg_code(SCR_ERR_RANGE, msg, (size_t)len, "ERR_OUT_OF_RANGE");
    return false;
  }
  if (fabs(code) > 9007199254740991.0) {
    char recv[48], msg[192];
    scr_num_received(code, recv);
    int len = snprintf(msg, sizeof msg,
                       "The value of \"code\" is out of range. It must be >= -9007199254740991 && <= 9007199254740991. Received %s", recv);
    scr_throw_error_msg_code(SCR_ERR_RANGE, msg, (size_t)len, "ERR_OUT_OF_RANGE");
    return false;
  }
  double low = fmod(code, 4294967296.0);
  if (low < 0) low += 4294967296.0;
  int64_t signed_code = (int64_t)low;
  if (signed_code > INT_MAX) signed_code -= 4294967296LL;
  *out = (int)signed_code;
  return true;
}

void scr_process_set_exit_code(double code) {
  int converted;
  if (scr_process_exit_code_of(code, &converted)) scr_exit_code_note(converted);
}

double scr_process_exit_code_or_zero(void) {
  return (double)scr_exit_code_hint_get();
}

static SCR_TL bool scr_exit_code_assigned = false;

void scr_process_set_exit_code_tracked(double code) {
  int converted;
  if (!scr_process_exit_code_of(code, &converted)) return;
  scr_exit_code_note(converted);
  scr_exit_code_assigned = true;
}

bool scr_process_has_exit_code(void) {
  return scr_exit_code_assigned || scr_exit_code_hint_get() != 0;
}

#if defined(__linux__)
#include <sched.h>
#include <signal.h>
#include <sys/syscall.h>
#ifndef SYS_close_range
#define SYS_close_range 436 /* the generic syscall table: x86_64 and aarch64 */
#endif

/* Detached teardown (`scriptc build --detached-exit`): the kernel frees an
 * exiting process's memory on its critical path, 30-40 ms per GB of 4 KiB
 * pages, before its parent sees it exit. A helper process that shares the
 * address space (CLONE_VM) and holds no descriptor but the read end of a
 * pipe keeps the memory alive past the exit, then exits itself and frees it
 * off the parent's critical path (the latency mold's --fork hides). The
 * kernel releases an exiting process's memory (exit_mm) before its files
 * (exit_files), so EOF on the pipe means the helper holds the last
 * reference. The helper keeps the executable mapped and the memory charged
 * to the cgroup until then, so a program opts in at build time: the program
 * object then defines scr_detached_exit = 1, overriding this weak default. */
__attribute__((weak)) const unsigned char scr_detached_exit = 0;
static char scr_teardown_stack[16384] __attribute__((aligned(64)));

static int scr_teardown_main(void *arg) {
  int fd = (int)(intptr_t)arg;
  /* Raw syscalls only: the helper runs on the exiting thread's TLS. */
  if (fd > 0) (void)syscall(SYS_close_range, 0u, (unsigned)fd - 1u, 0u);
  (void)syscall(SYS_close_range, (unsigned)fd + 1u, ~0u, 0u);
  char c;
  while (syscall(SYS_read, fd, &c, 1) != 0) {
  }
  syscall(SYS_exit, 0);
  return 0;
}

static void scr_detach_teardown(void) {
  if (!scr_detached_exit) return;
  int fds[2];
  if (pipe2(fds, O_CLOEXEC) != 0) return;
  sigset_t all, old;
  sigfillset(&all);
  pthread_sigmask(SIG_SETMASK, &all, &old);
  pid_t pid = clone(scr_teardown_main, scr_teardown_stack + sizeof scr_teardown_stack, CLONE_VM | SIGCHLD,
                    (void *)(intptr_t)fds[0]);
  pthread_sigmask(SIG_SETMASK, &old, NULL);
  (void)close(fds[0]);
  if (pid < 0) (void)close(fds[1]);
  /* fds[1] stays open until the process's files are released. */
}
#endif

#if defined(__linux__)
/* LLVM's profile writer. Instrumented builds (--profile-generate) link the
 * profile runtime, which writes the profile from an atexit handler that the
 * _Exit below skips, so the exit writes it first. Every other build leaves the
 * weak reference null. */
extern int __llvm_profile_write_file(void) __attribute__((weak));
#endif

void scr_process_exit(double code) {
  /* process.exit(code) assigns process.exitCode first, so a code that is
   * not a safe integer throws its RangeError and the program continues. */
  int converted;
  if (!scr_process_exit_code_of(code, &converted)) return;
  code = converted;
  /* Node runs 'exit' listeners on explicit process.exit() too — they run
   * HERE, synchronously, before the teardown-free exit below. The hook is
   * non-NULL only when the events unit is linked (scr_events.c). */
  scr_process_in_exit = true;
  if (scr_process_exit_hook != NULL) scr_process_exit_hook(code);
#ifdef SCR_WORKERS
  if (!scr_context_is_main()) {
    /* A nested exit or a failing exit listener already selected its code. */
    if (!scr_context_stopping()) scr_context_stop((int)code);
    return;
  }
#endif
  /* _Exit skips atexit handlers on purpose: no further code runs (matching
   * Node), and the RC audit is meaningless mid-program (live values are
   * expected). scr_init's flush-at-exit is also skipped — flush here. */
  fflush(stdout);
#if defined(__linux__)
  if (__llvm_profile_write_file != NULL) (void)__llvm_profile_write_file();
  scr_detach_teardown();
#endif
  _Exit((int)code);
}

/* ── the process introspection statics ────────────────────────────────
 * process.uptime/cpuUsage/threadCpuUsage/resourceUsage/availableMemory/
 * constrainedMemory — plain reads of the process's own clocks and
 * counters in Node's units. uptime anchors at load time (a constructor-
 * attribute monotonic stamp — the binary's own start, which is what
 * "the current Node.js process" means for a compiled program). */
#ifdef _WIN32
#if (defined(SCR_LIB) && defined(SCR_THREAD_INSTANCES)) || defined(SCR_WORKERS)
/* The uptime anchor belongs to the host PROCESS, not to a library
 * instance. InitOnce keeps the lazy Windows spelling race-free when
 * several thread instances ask for the clock concurrently. */
static INIT_ONCE scr_uptime_once = INIT_ONCE_STATIC_INIT;
static double scr_uptime_t0_ms;
static BOOL CALLBACK scr_uptime_anchor_once(PINIT_ONCE once, PVOID param,
                                             PVOID *ctx) {
  (void)once;
  (void)param;
  (void)ctx;
  scr_uptime_t0_ms = (double)GetTickCount64();
  return TRUE;
}
static void scr_uptime_anchor_init(void) {
  InitOnceExecuteOnce(&scr_uptime_once, scr_uptime_anchor_once, NULL, NULL);
}
#else
static SCR_TL double scr_uptime_t0_ms;
static void scr_uptime_anchor_init(void) { scr_uptime_t0_ms = (double)GetTickCount64(); }
#endif
static double scr_uptime_now_ms(void) { return (double)GetTickCount64(); }
#else
#include <sys/resource.h>
#include <sys/time.h>
#ifdef __APPLE__
#include <mach/mach.h>
#endif
/* A load-time, process-wide anchor: the constructor runs on only the
 * initial thread, while thread-instanced archives are entered from worker
 * threads whose TLS slots would otherwise stay zero. It is immutable once
 * main starts, so sharing it adds no cross-instance mutable state. */
static double scr_uptime_t0_ms;
static double scr_uptime_now_ms(void) {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return (double)ts.tv_sec * 1000.0 + (double)ts.tv_nsec / 1e6;
}
__attribute__((constructor)) static void scr_uptime_anchor_init(void) {
  scr_uptime_t0_ms = scr_uptime_now_ms();
}
#endif

double scr_process_uptime(void) {
#if defined(_WIN32) && ((defined(SCR_LIB) && defined(SCR_THREAD_INSTANCES)) || defined(SCR_WORKERS))
  scr_uptime_anchor_init();
#elif defined(_WIN32)
  if (scr_uptime_t0_ms == 0) scr_uptime_anchor_init();
#endif
  return (scr_uptime_now_ms() - scr_uptime_t0_ms) / 1000.0;
}

/* perf_hooks performance.now(): milliseconds since the process's own
 * start (Node's timeOrigin anchor), fractional — the same monotonic
 * clock and anchor as uptime, in Node's performance.now units. */
double scr_perf_now(void) {
#if defined(_WIN32) && ((defined(SCR_LIB) && defined(SCR_THREAD_INSTANCES)) || defined(SCR_WORKERS))
  scr_uptime_anchor_init();
#elif defined(_WIN32)
  if (scr_uptime_t0_ms == 0) scr_uptime_anchor_init();
#endif
  return scr_uptime_now_ms() - scr_uptime_t0_ms;
}

uint64_t scr_hrtime_ns(void) {
#ifdef _WIN32
  LARGE_INTEGER counter, frequency;
  QueryPerformanceCounter(&counter);
  QueryPerformanceFrequency(&frequency);
  uint64_t whole = (uint64_t)(counter.QuadPart / frequency.QuadPart);
  uint64_t remainder = (uint64_t)(counter.QuadPart % frequency.QuadPart);
  return whole * UINT64_C(1000000000) + remainder * UINT64_C(1000000000) / (uint64_t)frequency.QuadPart;
#else
  struct timespec time;
  clock_gettime(CLOCK_MONOTONIC, &time);
  return (uint64_t)time.tv_sec * UINT64_C(1000000000) + (uint64_t)time.tv_nsec;
#endif
}

#ifdef _WIN32
/* GetProcessTimes/GetThreadTimes answer 100ns units; Node reports µs. */
static double scr_filetime_us(FILETIME ft) {
  ULARGE_INTEGER v;
  v.LowPart = ft.dwLowDateTime;
  v.HighPart = ft.dwHighDateTime;
  return (double)(v.QuadPart / 10);
}

/* A filesystem FILETIME is 100ns ticks since 1601. Match libuv's split into
 * Unix seconds + nanoseconds before doing Node's millisecond arithmetic; the
 * split matters for the last-bit rounding of dates far from the epoch. */
static void scr_filetime_timespec(FILETIME ft, int64_t *sec_out, int64_t *nsec_out) {
  ULARGE_INTEGER raw;
  raw.LowPart = ft.dwLowDateTime;
  raw.HighPart = ft.dwHighDateTime;
  int64_t ticks = (int64_t)raw.QuadPart - INT64_C(116444736000000000);
  int64_t sec = ticks / INT64_C(10000000);
  int64_t rem = ticks % INT64_C(10000000);
  if (rem < 0) {
    sec--;
    rem += INT64_C(10000000);
  }
  *sec_out = sec;
  *nsec_out = rem * 100;
}
double scr_cpu_user(void) {
  FILETIME c, e, k, u;
  if (!GetProcessTimes(GetCurrentProcess(), &c, &e, &k, &u)) return 0;
  return scr_filetime_us(u);
}
double scr_cpu_system(void) {
  FILETIME c, e, k, u;
  if (!GetProcessTimes(GetCurrentProcess(), &c, &e, &k, &u)) return 0;
  return scr_filetime_us(k);
}
double scr_thread_cpu_user(void) {
  FILETIME c, e, k, u;
  if (!GetThreadTimes(GetCurrentThread(), &c, &e, &k, &u)) return 0;
  return scr_filetime_us(u);
}
double scr_thread_cpu_system(void) {
  FILETIME c, e, k, u;
  if (!GetThreadTimes(GetCurrentThread(), &c, &e, &k, &u)) return 0;
  return scr_filetime_us(k);
}
#else
static double scr_tv_us(struct timeval tv) {
  return (double)tv.tv_sec * 1e6 + (double)tv.tv_usec;
}
double scr_cpu_user(void) {
  struct rusage ru;
  if (getrusage(RUSAGE_SELF, &ru) != 0) return 0;
  return scr_tv_us(ru.ru_utime);
}
double scr_cpu_system(void) {
  struct rusage ru;
  if (getrusage(RUSAGE_SELF, &ru) != 0) return 0;
  return scr_tv_us(ru.ru_stime);
}
#if defined(RUSAGE_THREAD)
double scr_thread_cpu_user(void) {
  struct rusage ru;
  if (getrusage(RUSAGE_THREAD, &ru) != 0) return 0;
  return scr_tv_us(ru.ru_utime);
}
double scr_thread_cpu_system(void) {
  struct rusage ru;
  if (getrusage(RUSAGE_THREAD, &ru) != 0) return 0;
  return scr_tv_us(ru.ru_stime);
}
#elif defined(__APPLE__)
double scr_thread_cpu_user(void) {
  thread_basic_info_data_t info;
  mach_msg_type_number_t count = THREAD_BASIC_INFO_COUNT;
  if (thread_info(mach_thread_self(), THREAD_BASIC_INFO, (thread_info_t)&info, &count) != KERN_SUCCESS) return 0;
  return (double)info.user_time.seconds * 1e6 + (double)info.user_time.microseconds;
}
double scr_thread_cpu_system(void) {
  thread_basic_info_data_t info;
  mach_msg_type_number_t count = THREAD_BASIC_INFO_COUNT;
  if (thread_info(mach_thread_self(), THREAD_BASIC_INFO, (thread_info_t)&info, &count) != KERN_SUCCESS) return 0;
  return (double)info.system_time.seconds * 1e6 + (double)info.system_time.microseconds;
}
#else
/* No per-thread clock on this platform: the process clocks stand in (a
 * single-threaded binary's thread IS the process). */
double scr_thread_cpu_user(void) { return scr_cpu_user(); }
double scr_thread_cpu_system(void) { return scr_cpu_system(); }
#endif
#endif

/* The prev-argument validation: Node checks prevValue.user then
 * prevValue.system and throws the ERR_INVALID_ARG_VALUE RangeError with
 * the received number, catchably. (The frontend guarantees numbers —
 * non-number shapes keep compile fences.) */
static void scr_cpu_prev_check_field(const char *name, double v) {
  if (v >= 0 && v <= 1.7976931348623157e308 && v == v) return; /* finite, non-negative */
  char num[32];
  size_t nlen = scr_f64_to_str(v, num);
  num[nlen] = 0;
  char msg[128];
  int len = snprintf(msg, sizeof msg, "The property 'prevValue.%s' is invalid. Received %s", name, num);
  scr_throw_error_msg_code(SCR_ERR_RANGE, msg, (size_t)len, "ERR_INVALID_ARG_VALUE");
}

void scr_cpu_prev_validate(double user, double system) {
  scr_cpu_prev_check_field("user", user);
  if (scr_exc_pending()) return;
  scr_cpu_prev_check_field("system", system);
}

double scr_cpu_user_diff(double prev) { return scr_cpu_user() - prev; }
double scr_cpu_system_diff(double prev) { return scr_cpu_system() - prev; }
double scr_thread_cpu_user_diff(double prev) { return scr_thread_cpu_user() - prev; }
double scr_thread_cpu_system_diff(double prev) { return scr_thread_cpu_system() - prev; }

/* process.resourceUsage(): one field by canonical index — Node's names,
 * order, and units (CPU times in µs; maxRSS in kilobytes — uv divides
 * Darwin's bytes by 1024; the rest are getrusage's own counters, zero
 * where the platform never fills them). */
double scr_process_rusage(double idx) {
#if defined(_WIN32) || defined(__wasi__)
  /* uv fills only the CPU times and page-fault/maxRSS slice on Windows;
   * everything else answers 0 — Node's own shape there. */
  switch ((int)idx) {
    case 0: return scr_cpu_user();
    case 1: return scr_cpu_system();
    default: return 0;
  }
#else
  struct rusage ru;
  if (getrusage(RUSAGE_SELF, &ru) != 0) return 0;
  switch ((int)idx) {
    case 0: return scr_tv_us(ru.ru_utime);      /* userCPUTime */
    case 1: return scr_tv_us(ru.ru_stime);      /* systemCPUTime */
    case 2:                                     /* maxRSS (kilobytes) */
#ifdef __APPLE__
      return (double)(ru.ru_maxrss / 1024);
#else
      return (double)ru.ru_maxrss;
#endif
    case 3: return (double)ru.ru_ixrss;         /* sharedMemorySize */
    case 4: return (double)ru.ru_idrss;         /* unsharedDataSize */
    case 5: return (double)ru.ru_isrss;         /* unsharedStackSize */
    case 6: return (double)ru.ru_minflt;        /* minorPageFault */
    case 7: return (double)ru.ru_majflt;        /* majorPageFault */
    case 8: return (double)ru.ru_nswap;         /* swappedOut */
    case 9: return (double)ru.ru_inblock;       /* fsRead */
    case 10: return (double)ru.ru_oublock;      /* fsWrite */
    case 11: return (double)ru.ru_msgsnd;       /* ipcSent */
    case 12: return (double)ru.ru_msgrcv;       /* ipcReceived */
    case 13: return (double)ru.ru_nsignals;     /* signalsCount */
    case 14: return (double)ru.ru_nvcsw;        /* voluntaryContextSwitches */
    case 15: return (double)ru.ru_nivcsw;       /* involuntaryContextSwitches */
    default: return 0;
  }
#endif
}

/* process.availableMemory()/constrainedMemory() — libuv's numbers
 * (uv_get_constrained_memory, uv_get_available_memory; libuv 1.51,
 * src/unix/linux.c). On Linux the constraint is the process's own cgroup,
 * named by /proc/self/cgroup: cgroup v2 reads memory.max and memory.high
 * under /sys/fs/cgroup/<path>, v1 memory.limit_in_bytes and
 * memory.soft_limit_in_bytes under /sys/fs/cgroup/memory/<path> (falling
 * back to the controller's root). The answer is the smaller of the two;
 * "max" (and v1's page-aligned LONG_MAX) reads as UINT64_MAX, an unreadable
 * file as 0, which makes the answer 0. Available memory under a constraint
 * at most the total is the constraint minus the cgroup's current usage;
 * otherwise MemAvailable. */
#if defined(__linux__)
/* uv__slurp: up to len - 1 bytes, NUL-terminated; false when unreadable. */
static bool scr_uv_slurp(const char *path, char *buf, size_t len) {
  int fd = open(path, O_RDONLY | O_CLOEXEC);
  if (fd < 0) return false;
  ssize_t n;
  do n = read(fd, buf, len - 1);
  while (n == -1 && errno == EINTR);
  close(fd);
  if (n < 0) return false;
  buf[n] = 0;
  return true;
}

/* uv__read_uint64. */
static uint64_t scr_uv_read_uint64(const char *path) {
  char buf[32];
  uint64_t v = 0;
  if (scr_uv_slurp(path, buf, sizeof buf) && sscanf(buf, "%" SCNu64, &v) != 1 && strcmp(buf, "max\n") == 0)
    v = UINT64_MAX;
  return v;
}

/* uv__cgroup1_find_memory_controller: the memory controller's path without
 * its leading slash, and its length in *n; NULL when there is none. */
static const char *scr_uv_cgroup1_memory(const char *buf, int *n) {
  const char *p = strchr(buf, ':');
  while (p != NULL && strncmp(p, ":memory:", 8) != 0) {
    p = strchr(p, '\n');
    if (p != NULL) p = strchr(p, ':');
  }
  if (p != NULL) {
    p += strlen(":memory:/");
    *n = (int)strcspn(p, "\n");
  }
  return p;
}

/* uv__get_cgroup_constrained_memory over /proc/self/cgroup's contents. */
static uint64_t scr_uv_cgroup_constrained(const char *buf) {
  char path[4097];
  uint64_t high = 0, max = 0;
  int n = 0;
  if (strncmp(buf, "0::/", 4) != 0) {
    const char *p = scr_uv_cgroup1_memory(buf, &n);
    bool found = false;
    if (p != NULL) {
      snprintf(path, sizeof path, "/sys/fs/cgroup/memory/%.*s/memory.soft_limit_in_bytes", n, p);
      high = scr_uv_read_uint64(path);
      snprintf(path, sizeof path, "/sys/fs/cgroup/memory/%.*s/memory.limit_in_bytes", n, p);
      max = scr_uv_read_uint64(path);
      found = high != 0 && max != 0;
    }
    if (!found) {
      high = scr_uv_read_uint64("/sys/fs/cgroup/memory/memory.soft_limit_in_bytes");
      max = scr_uv_read_uint64("/sys/fs/cgroup/memory/memory.limit_in_bytes");
    }
    uint64_t cgroup1_max = (uint64_t)(LONG_MAX & ~(sysconf(_SC_PAGESIZE) - 1));
    if (high == cgroup1_max) high = UINT64_MAX;
    if (max == cgroup1_max) max = UINT64_MAX;
  } else {
    const char *p = buf + 4;
    n = (int)strcspn(p, "\n");
    snprintf(path, sizeof path, "/sys/fs/cgroup/%.*s/memory.max", n, p);
    max = scr_uv_read_uint64(path);
    snprintf(path, sizeof path, "/sys/fs/cgroup/%.*s/memory.high", n, p);
    high = scr_uv_read_uint64(path);
  }
  if (high == 0 || max == 0) return 0;
  return high < max ? high : max;
}

/* uv__read_proc_meminfo: a /proc/meminfo field in bytes, or 0. */
static uint64_t scr_uv_meminfo(const char *what) {
  char buf[4096];
  if (!scr_uv_slurp("/proc/meminfo", buf, sizeof buf)) return 0;
  const char *p = strstr(buf, what);
  if (p == NULL) return 0;
  uint64_t kb = 0;
  sscanf(p + strlen(what), "%" SCNu64 " kB", &kb);
  return kb * 1024;
}
#endif

double scr_constrained_memory(void) {
#if defined(__linux__)
  char buf[1024];
  if (!scr_uv_slurp("/proc/self/cgroup", buf, sizeof buf)) return 0;
  return (double)scr_uv_cgroup_constrained(buf);
#else
  return 0;
#endif
}

double scr_available_memory(void) {
#if defined(_WIN32)
  MEMORYSTATUSEX ms;
  memset(&ms, 0, sizeof ms);
  ms.dwLength = sizeof ms;
  if (!GlobalMemoryStatusEx(&ms)) return 0;
  return (double)ms.ullAvailPhys;
#elif defined(__APPLE__)
  /* uv_get_available_memory falls back to the free-memory number on
   * Darwin (vm_statistics' free pages). */
  vm_statistics64_data_t vm;
  mach_msg_type_number_t count = HOST_VM_INFO64_COUNT;
  if (host_statistics64(mach_host_self(), HOST_VM_INFO64, (host_info64_t)&vm, &count) != KERN_SUCCESS) return 0;
  return (double)vm.free_count * (double)vm_page_size;
#elif defined(__linux__)
  /* uv_get_available_memory; its free-memory fallback is MemAvailable, then
   * sysinfo's freeram. */
  char buf[1024];
  if (!scr_uv_slurp("/proc/self/cgroup", buf, sizeof buf)) return 0;
  uint64_t free_memory = scr_uv_meminfo("MemAvailable:");
  if (free_memory == 0) {
    struct sysinfo info;
    if (sysinfo(&info) == 0) free_memory = (uint64_t)info.freeram * info.mem_unit;
  }
  uint64_t constrained = scr_uv_cgroup_constrained(buf);
  if (constrained == 0) return (double)free_memory;
  uint64_t total = scr_uv_meminfo("MemTotal:");
  if (total == 0) {
    struct sysinfo info;
    if (sysinfo(&info) == 0) total = (uint64_t)info.totalram * info.mem_unit;
  }
  if (constrained > total) return (double)free_memory;
  char path[4097];
  uint64_t current;
  if (strncmp(buf, "0::/", 4) != 0) {
    int n = 0;
    const char *p = scr_uv_cgroup1_memory(buf, &n);
    current = 0;
    if (p != NULL) {
      snprintf(path, sizeof path, "/sys/fs/cgroup/memory/%.*s/memory.usage_in_bytes", n, p);
      current = scr_uv_read_uint64(path);
    }
    if (current == 0) current = scr_uv_read_uint64("/sys/fs/cgroup/memory/memory.usage_in_bytes");
  } else {
    snprintf(path, sizeof path, "/sys/fs/cgroup/%.*s/memory.current", (int)strcspn(buf + 4, "\n"), buf + 4);
    current = scr_uv_read_uint64(path);
  }
  /* Usage can exceed the limit for short bursts. */
  return constrained < current ? 0 : (double)(constrained - current);
#else
  return 0;
#endif
}

/* ── process.memoryUsage / ppid / title / argv0 / release ─────────────── */

/* uv_resident_set_memory: /proc/self/stat's rss pages on Linux, the task's
 * resident size on Darwin, the working set on Windows. False when the
 * platform has no answer or the read failed. */
static bool scr_resident_set(double *out) {
#if defined(__linux__)
  char buf[1024];
  if (!scr_uv_slurp("/proc/self/stat", buf, sizeof buf)) return false;
  const char *s = strrchr(buf, ')');
  if (s == NULL) return false;
  for (int i = 1; i <= 22; i++) {
    s = strchr(s + 1, ' ');
    if (s == NULL) return false;
  }
  errno = 0;
  long pages = strtol(s, NULL, 10);
  if (pages < 0 || errno != 0) return false;
  *out = (double)pages * (double)getpagesize();
  return true;
#elif defined(__APPLE__)
  mach_task_basic_info_data_t info;
  mach_msg_type_number_t count = MACH_TASK_BASIC_INFO_COUNT;
  if (task_info(mach_task_self(), MACH_TASK_BASIC_INFO, (task_info_t)&info, &count) != KERN_SUCCESS)
    return false;
  *out = (double)info.resident_size;
  return true;
#elif defined(_WIN32)
  PROCESS_MEMORY_COUNTERS pmc;
  if (!K32GetProcessMemoryInfo(GetCurrentProcess(), &pmc, sizeof pmc)) return false;
  *out = (double)pmc.WorkingSetSize;
  return true;
#else
  return false;
#endif
}

static SCR_TL double scr_memory_usage_sample[5];

double scr_process_rss(void) {
  double rss = 0;
  if (!scr_resident_set(&rss)) scr_fs_throw(EINVAL, "uv_resident_set_memory", NULL);
  return rss;
}

void scr_process_memory_usage_take(void) {
  double rss = 0;
  if (!scr_resident_set(&rss)) {
    scr_fs_throw(EINVAL, "uv_resident_set_memory", NULL);
    return;
  }
  double total = 0, used = 0;
  scr_heap_stats(&total, &used);
  scr_memory_usage_sample[0] = rss;
  scr_memory_usage_sample[1] = total;
  scr_memory_usage_sample[2] = used;
  scr_memory_usage_sample[3] = 0;
  scr_memory_usage_sample[4] = 0;
}

double scr_process_memory_usage_field(double k) {
  return k >= 0 && k < 5 ? scr_memory_usage_sample[(int)k] : 0;
}

/* uv_os_getppid: getppid(2); on Windows the basic-information record's
 * parent id, -1 when it cannot be read. */
double scr_process_ppid(void) {
#if defined(_WIN32)
  typedef struct {
    LONG exit_status;
    PVOID peb;
    ULONG_PTR affinity;
    LONG priority;
    ULONG_PTR pid;
    ULONG_PTR parent;
  } ScrBasicInfo;
  typedef LONG(WINAPI * QueryFn)(HANDLE, int, PVOID, ULONG, PULONG);
  HMODULE ntdll = GetModuleHandleA("ntdll.dll");
  QueryFn query = ntdll ? (QueryFn)(void *)GetProcAddress(ntdll, "NtQueryInformationProcess") : NULL;
  ScrBasicInfo info;
  if (query == NULL || query(GetCurrentProcess(), 0, &info, sizeof info, NULL) < 0) return -1;
  return (double)info.parent;
#elif defined(__wasi__)
  return 0;
#else
  return (double)getppid();
#endif
}

/* process.title, libuv's model. On POSIX (unix/proctitle.c) the title
 * starts as argv[0]; a set writes into the memory that held the original
 * arguments, truncated to that area, so ps shows the new name. The
 * arguments move to a heap copy first, which process.argv and argv0 keep
 * reading. On Windows the title is the console title (win/util.c): read
 * from the console until set, and a set that the console refuses leaves
 * the title unchanged. Without arguments (library sessions) or a console,
 * the title reads "node", Node's default. The title is process-wide. */
#if defined(_WIN32)
static SRWLOCK scr_title_lock = SRWLOCK_INIT;
#define SCR_TITLE_LOCK() AcquireSRWLockExclusive(&scr_title_lock)
#define SCR_TITLE_UNLOCK() ReleaseSRWLockExclusive(&scr_title_lock)
static char *scr_title_text; /* the last title set, UTF-8 */
#elif !defined(__wasi__)
static pthread_mutex_t scr_title_lock = PTHREAD_MUTEX_INITIALIZER;
#define SCR_TITLE_LOCK() pthread_mutex_lock(&scr_title_lock)
#define SCR_TITLE_UNLOCK() pthread_mutex_unlock(&scr_title_lock)
static char *scr_title_area;   /* argv[0]'s original storage */
static size_t scr_title_cap;   /* bytes of the original argument area */
static size_t scr_title_len;
static char **scr_title_argv;  /* the original pointer table */
static char **scr_title_owned; /* the main thread's shifted copy, if any */
static int scr_title_argc;
static char *scr_title_moved;  /* heap copy of the arguments, once moved */
#endif

#if !defined(_WIN32) && !defined(__wasi__)
#ifndef SCR_LIB
static void scr_title_init(int argc, char **argv) {
  if (argc <= 0 || scr_title_area != NULL) return;
  size_t last = strlen(argv[argc - 1]) + 1;
  scr_title_area = argv[0];
  scr_title_len = strlen(argv[0]);
  scr_title_cap = (size_t)(argv[argc - 1] + last - argv[0]);
  scr_title_argv = argv;
  scr_title_argc = argc;
  scr_title_owned = scr_lib_argv_owned;
}
#endif

/* Moves every argument string out of the area (lock held). The pointer
 * tables are updated in place, so every later argument read sees the
 * copies. */
static void scr_title_move_args(void) {
  if (scr_title_moved) return;
  size_t size = 0;
  for (int i = 0; i < scr_title_argc; i++) size += strlen(scr_title_argv[i]) + 1;
  char *copy = malloc(size);
  if (!copy) scr_trap("scriptc: out of memory\n");
  char *next = copy;
  const char *lo = scr_title_area, *hi = scr_title_area + scr_title_cap;
  for (int i = 0; i < scr_title_argc; i++) {
    char *old = scr_title_argv[i];
    size_t n = strlen(old) + 1;
    memcpy(next, old, n);
    if (scr_title_owned) {
      for (int j = 0; scr_title_owned[j]; j++)
        if (scr_title_owned[j] == old) scr_title_owned[j] = next;
    }
    if (old >= lo && old < hi) scr_title_argv[i] = next;
    next += n;
  }
  scr_title_moved = copy;
}
#endif

ScrStr *scr_process_title(void) {
#if defined(_WIN32)
  ScrStr *out = NULL;
  SCR_TITLE_LOCK();
  if (scr_title_text) out = scr_str_new(scr_title_text, strlen(scr_title_text));
  SCR_TITLE_UNLOCK();
  if (out) return out;
  WCHAR *wide = malloc(8192 * sizeof(WCHAR));
  if (!wide) scr_trap("scriptc: out of memory\n");
  DWORD n = GetConsoleTitleW(wide, 8192);
  if (n != 0) out = scr_fs_win_utf8(wide, n);
  free(wide);
  return out ? out : scr_str_new("node", 4);
#elif defined(__wasi__)
  return scr_str_new("node", 4);
#else
  SCR_TITLE_LOCK();
  ScrStr *out = scr_title_area ? scr_str_new(scr_title_area, scr_title_len) : scr_str_new("node", 4);
  SCR_TITLE_UNLOCK();
  return out;
#endif
}

void scr_process_set_title(const ScrStr *title) {
  /* Node passes the title through Utf8Value: lone surrogates become
   * U+FFFD, and the C string ends at the first NUL. */
  ScrStr *text = scr_str_to_well_formed((ScrStr *)title);
  size_t len = strnlen(text->data, text->len);
#if defined(_WIN32)
  int units = MultiByteToWideChar(CP_UTF8, 0, text->data, (int)len, NULL, 0);
  WCHAR *wide = calloc((size_t)units + 1, sizeof(WCHAR));
  char *copy = malloc(len + 1);
  if (!wide || !copy) scr_trap("scriptc: out of memory\n");
  if (units) MultiByteToWideChar(CP_UTF8, 0, text->data, (int)len, wide, units);
  if (units >= 8192) wide[8191] = L'\0';
  memcpy(copy, text->data, len);
  copy[len] = '\0';
  if (SetConsoleTitleW(wide)) {
    SCR_TITLE_LOCK();
    free(scr_title_text);
    scr_title_text = copy;
    copy = NULL;
    SCR_TITLE_UNLOCK();
  }
  free(copy);
  free(wide);
#elif !defined(__wasi__)
  SCR_TITLE_LOCK();
  if (scr_title_area) {
    scr_title_move_args();
    if (len >= scr_title_cap) len = scr_title_cap ? scr_title_cap - 1 : 0;
    memcpy(scr_title_area, text->data, len);
    memset(scr_title_area + len, 0, scr_title_cap - len);
    scr_title_len = len;
#if defined(__linux__)
    prctl(PR_SET_NAME, scr_title_area);
#elif defined(__APPLE__)
    pthread_setname_np(scr_title_area);
#endif
  }
  SCR_TITLE_UNLOCK();
#else
  (void)len;
#endif
  scr_str_release(text);
}

ScrStr *scr_process_argv0(void) {
  if (scr_lib_arg_count() < 1) return scr_str_new("", 0);
  const char *a = scr_lib_arg(0);
  return scr_str_new(a, strlen(a));
}

static SCR_TL ScrDyn *scr_release_object;

static void scr_release_object_cleanup(void) {
  scr_dyn_release(scr_release_object);
  scr_release_object = NULL;
}

/* node_metadata.cc's release record for the compatibility target: an LTS
 * line, the release download URLs, and on Windows the import library. */
ScrDyn *scr_process_release(void) {
  if (!scr_release_object) {
#define SCR_RELEASE_PREFIX "https://nodejs.org/download/release/v" SCR_NODE_COMPAT_VERSION "/"
#define SCR_RELEASE_FILE SCR_RELEASE_PREFIX "node-v" SCR_NODE_COMPAT_VERSION
    static const char *const fields[][2] = {
        {"name", "node"},
        {"lts", "Krypton"},
        {"sourceUrl", SCR_RELEASE_FILE ".tar.gz"},
        {"headersUrl", SCR_RELEASE_FILE "-headers.tar.gz"},
    };
    scr_release_object = scr_dyn_new_obj();
    for (size_t i = 0; i < sizeof fields / sizeof fields[0]; i++) {
      ScrStr *value = scr_str_new(fields[i][1], strlen(fields[i][1]));
      scr_dyn_obj_set(scr_release_object, fields[i][0], strlen(fields[i][0]), scr_dyn_new_str(value));
      scr_str_release(value);
    }
#ifdef _WIN32
    ScrStr *arch = scr_process_arch();
    char lib[160];
    int n = snprintf(lib, sizeof lib, SCR_RELEASE_PREFIX "win-%.*s/node.lib", (int)arch->len, arch->data);
    scr_str_release(arch);
    ScrStr *value = scr_str_new(lib, (size_t)n);
    scr_dyn_obj_set(scr_release_object, "libUrl", 6, scr_dyn_new_str(value));
    scr_str_release(value);
#endif
#undef SCR_RELEASE_FILE
#undef SCR_RELEASE_PREFIX
    for (size_t i = 0; i < scr_release_object->v.obj.len; i++) {
      scr_release_object->v.obj.entries[i].writable = false;
      scr_release_object->v.obj.entries[i].configurable = false;
    }
    scr_atexit(&scr_release_object_cleanup);
  }
  return scr_dyn_retain(scr_release_object);
}

#if defined(_WIN32) || defined(__wasi__)
double scr_process_geteuid(void) {
  scr_throw_error_msg(SCR_ERR_TYPE, "process.geteuid is not a function", 33);
  return 0;
}

double scr_process_getegid(void) {
  scr_throw_error_msg(SCR_ERR_TYPE, "process.getegid is not a function", 33);
  return 0;
}

ScrArr *scr_process_getgroups(void) {
  scr_throw_error_msg(SCR_ERR_TYPE, "process.getgroups is not a function", 35);
  return scr_arr_new(SCR_ELEM_F64, 0);
}
#else
double scr_process_geteuid(void) { return (double)geteuid(); }

double scr_process_getegid(void) { return (double)getegid(); }

/* node_credentials.cc GetGroups: the supplementary groups, then the
 * effective gid when the list lacks it. */
ScrArr *scr_process_getgroups(void) {
  int n = getgroups(0, NULL);
  gid_t *groups = n > 0 ? malloc((size_t)n * sizeof *groups) : NULL;
  if (n > 0 && !groups) scr_trap("scriptc: out of memory\n");
  if (n < 0 || (n > 0 && (n = getgroups(n, groups)) < 0)) {
    int e = errno;
    free(groups);
    scr_fs_throw(e, "getgroups", NULL);
    return scr_arr_new(SCR_ELEM_F64, 0);
  }
  gid_t egid = getegid();
  bool has = false;
  ScrArr *out = scr_arr_new(SCR_ELEM_F64, (size_t)n + 1);
  for (int i = 0; i < n; i++) {
    has = has || groups[i] == egid;
    scr_arr_push_f64(out, (double)groups[i]);
  }
  if (!has) scr_arr_push_f64(out, (double)egid);
  free(groups);
  return out;
}
#endif

/* process._exiting — true once the exit sequence began (set above and by
 * scr_run_exit_listeners in scr_events.c; the flag lives HERE so reading
 * it never forces the events unit into the link). */
SCR_TL bool scr_process_in_exit = false;

bool scr_process_exiting(void) { return scr_process_in_exit; }

#ifdef SCR_WORKERS
/* Initialize before workers start. Reading through the cached process value
 * avoids temporarily clearing the OS mask while another thread creates a file. */
static void scr_process_mask_init(void) {
#ifdef _WIN32
  int current, ignored;
  _umask_s(0, &current);
  _umask_s(current, &ignored);
#else
  unsigned current = umask(0);
  umask((mode_t)current);
#endif
  atomic_store_explicit(&scr_process_mask, (unsigned)current, memory_order_relaxed);
}
#endif

/* umask(2): mask < 0 reads without setting (set 0, restore — umask has no
 * read-only form); otherwise sets and answers the previous mask. */
double scr_process_umask(double mask) {
#ifdef SCR_WORKERS
  if (mask < 0) return atomic_load_explicit(&scr_process_mask, memory_order_relaxed);
  if (!scr_context_is_main()) {
    static const char message[] = "Setting process.umask() is not supported in workers";
    scr_throw_error_msg_code(SCR_ERR_ERROR, message, sizeof message - 1, "ERR_WORKER_UNSUPPORTED_OPERATION");
    return 0;
  }
  atomic_store_explicit(&scr_process_mask, (unsigned)mask, memory_order_relaxed);
#endif
#ifdef _WIN32
  /* Node on Windows accepts umask() calls; only the low bits matter. */
  int prev;
  if (mask < 0) {
    _umask_s(0, &prev);
    int ignored;
    _umask_s(prev, &ignored);
  } else {
    _umask_s((int)mask, &prev);
  }
  return (double)prev;
#elif defined(__wasi__)
  static SCR_TL mode_t current = 022;
  mode_t prev = current;
  if (mask >= 0) current = (mode_t)mask;
  return (double)prev;
#else
  mode_t prev;
  if (mask < 0) {
    prev = umask(0);
    umask(prev);
  } else {
    prev = umask((mode_t)mask);
  }
  return (double)prev;
#endif
}

void scr_process_chdir(ScrStr *dir) {
#ifdef SCR_WORKERS
  if (!scr_context_is_main()) {
    static const char message[] = "process.chdir() is not supported in workers";
    scr_throw_error_msg_code(SCR_ERR_TYPE, message, sizeof message - 1, "ERR_WORKER_UNSUPPORTED_OPERATION");
    return;
  }
#endif
#ifdef _WIN32
  WCHAR *wide = scr_fs_win_wide(dir);
  BOOL changed = wide && SetCurrentDirectoryW(wide);
  DWORD error = changed ? ERROR_SUCCESS : GetLastError();
  free(wide);
  if (!changed) scr_fs_throw(scr_fs_win_errno(error), "chdir", dir);
#else
  if (chdir(dir->data) != 0) scr_fs_throw(errno, "chdir", dir);
#endif
}

/* net's process-wide happy-eyeballs attempt budget (Node's
 * getDefaultAutoSelectFamilyAttemptTimeout pair, default 250ms). Lives in
 * the core unit so the knob never forces scr_net.c into the link. */
static SCR_TL double scr_net_autosel_timeout_ms = 250;

double scr_net_get_autosel_timeout(void) { return scr_net_autosel_timeout_ms; }

/* Node's setDefaultAutoSelectFamilyAttemptTimeout: validateInt32(value,
 * 'value', 1), then the sub-10ms floor (Node clamps small budgets to
 * 10ms). Throws ERR_OUT_OF_RANGE catchably. */
void scr_net_set_autosel_timeout(double ms) {
  char recv[48], msg[160];
  if (!(isfinite(ms) && trunc(ms) == ms)) {
    scr_num_received(ms, recv);
    int len = snprintf(msg, sizeof msg,
                       "The value of \"value\" is out of range. It must be an integer. Received %s", recv);
    scr_throw_error_msg_code(SCR_ERR_RANGE, msg, (size_t)len, "ERR_OUT_OF_RANGE");
    return;
  }
  if (ms < 1 || ms > 2147483647.0) {
    scr_num_received(ms, recv);
    int len = snprintf(msg, sizeof msg,
                       "The value of \"value\" is out of range. It must be >= 1 && <= 2147483647. Received %s", recv);
    scr_throw_error_msg_code(SCR_ERR_RANGE, msg, (size_t)len, "ERR_OUT_OF_RANGE");
    return;
  }
  scr_net_autosel_timeout_ms = ms < 10 ? 10 : ms;
}

/* ── fs error formatting ─────────────────────────────────────────────
 * Node's fs errors read "<ERRNO>: <text>, <syscall> '<path>'"
 * ("ENOENT: no such file or directory, open 'x'"). The common errnos get
 * Node's (libuv's) exact lowercase text; anything exotic falls back to
 * "E<num>: <strerror>, <op> '<path>'" — close enough, and the corpus can
 * only observe messages through the runtime C tests anyway (the supported
 * catch form is bindingless).
 */

static const char *scr_errno_name(int e, char *fallback, size_t cap) {
  switch (e) {
  case ENOENT: return "ENOENT";
  case EEXIST: return "EEXIST";
  case EACCES: return "EACCES";
  case EBUSY: return "EBUSY";
  case EINVAL: return "EINVAL";
  case EIO: return "EIO";
  case ENAMETOOLONG: return "ENAMETOOLONG";
  case ENOMEM: return "ENOMEM";
  case ENOSPC: return "ENOSPC";
  case ENOTDIR: return "ENOTDIR";
  case EISDIR: return "EISDIR";
  case ENOTEMPTY: return "ENOTEMPTY";
  case EPERM: return "EPERM";
  case EROFS: return "EROFS";
  case EXDEV: return "EXDEV";
  case EBADF: return "EBADF";
  case EAGAIN: return "EAGAIN";
  case EFBIG: return "EFBIG";
  case EPIPE: return "EPIPE";
  case ESPIPE: return "ESPIPE";
  case ELOOP: return "ELOOP";
  case ENOSYS: return "ENOSYS";
  case ENOTSUP: return "ENOTSUP";
  default:
    snprintf(fallback, cap, "E%d", e);
    return fallback;
  }
}

static const char *scr_errno_text(int e) {
  switch (e) {
  case ENOENT: return "no such file or directory";
  case EEXIST: return "file already exists";
  case EACCES: return "permission denied";
  case EBUSY: return "resource busy or locked";
  case EINVAL: return "invalid argument";
  case EIO: return "i/o error";
  case ENAMETOOLONG: return "name too long";
  case ENOMEM: return "not enough memory";
  case ENOSPC: return "no space left on device";
  case ENOTDIR: return "not a directory";
  case EISDIR: return "illegal operation on a directory";
  case ENOTEMPTY: return "directory not empty";
  case EPERM: return "operation not permitted";
  case EROFS: return "read-only file system";
  case EXDEV: return "cross-device link not permitted";
  case EBADF: return "bad file descriptor";
  case EAGAIN: return "resource temporarily unavailable";
  case EFBIG: return "file too large";
  case EPIPE: return "broken pipe";
  case ESPIPE: return "invalid seek";
  case ELOOP: return "too many levels of symbolic links";
  case ENOSYS: return "function not implemented";
  default: return strerror(e);
  }
}

/* Node on WINDOWS reports fs error paths ABSOLUTIZED and backslashed
 * (its fs binding hands the Windows API namespaced absolute paths and the
 * error keeps that spelling): open("no.bin") fails with "... open
 * 'C:\cwd\no.bin'". _fullpath reproduces exactly that resolution. POSIX
 * Node reports the path as given — the passthrough arm. */
#ifdef _WIN32
static const char *scr_fs_err_path(const ScrStr *path, char buf[PATH_MAX]) {
  return _fullpath(buf, path->data, PATH_MAX) != NULL ? buf : path->data;
}
#else
static const char *scr_fs_err_path(const ScrStr *path, char buf[PATH_MAX]) {
  (void)buf;
  return path->data;
}
#endif

/* Exported (scr_runtime.h): scr_bytes.c's fs Buffer forms share it. */
/* Keep metadata on the error itself until it crosses a checked-value
 * boundary. Failed operations do not populate the process identity cache. */
static ScrError *scr_fs_error_details(int e, const char *name, const char *message, size_t length,
                                      const char *op, const ScrStr *path, const ScrStr *dest) {
  double number = e > 0 ? -e : e;
#define SCR_FS_ERRNO_VALUE(code, text) if (strcmp(name, #code) == 0) number = SCR_NODE_UV__##code;
  SCR_NODE_UV_ERRNO_MAP(SCR_FS_ERRNO_VALUE)
#undef SCR_FS_ERRNO_VALUE
  ScrStr *text = scr_str_new(message, length);
  ScrError *error = scr_error_new(SCR_ERR_ERROR, text);
  scr_str_release(text);
  scr_error_set_code(error, name);
  error->system_errno = number;
  error->system_call = scr_str_new(op, strlen(op));
  error->system_path = path ? scr_str_retain((ScrStr *)path) : NULL;
  error->system_dest = dest ? scr_str_retain((ScrStr *)dest) : NULL;
  return error;
}

static void scr_fs_throw_details(int e, const char *name, const char *message, size_t length,
                                 const char *op, const ScrStr *path, const ScrStr *dest) {
  ScrError *error = scr_fs_error_details(e, name, message, length, op, path, dest);
  scr_throw_obj(error, &scr_error_retain_v, &scr_error_release_v, scr_error_trace_arg());
}

ScrError *scr_fs_error(int e, const char *op, const ScrStr *path) {
#ifdef _WIN32
  /* The CRT lands ERROR_ACCESS_DENIED in errno as EACCES; libuv's
   * uv_translate_sys_error maps the same Win32 error to EPERM, so that
   * is the code Node throws (a read-only file's write open, chmod on a
   * held file). Translate at the throw seam so every fs op agrees with
   * the Windows oracle. */
  if (e == EACCES) e = EPERM;
#endif
  char namebuf[16];
  const char *name = scr_errno_name(e, namebuf, sizeof namebuf);
  const char *text = scr_errno_text(e);
  char pathbuf[PATH_MAX];
  const char *shown = path ? scr_fs_err_path(path, pathbuf) : "";
  size_t cap = strlen(name) + strlen(text) + strlen(op) + strlen(shown) + 8;
  char *msg = malloc(cap);
  if (!msg) {
    scr_trap("scriptc: out of memory\n");
  }
  int len = path
    ? snprintf(msg, cap, "%s: %s, %s '%s'", name, text, op, shown)
    : snprintf(msg, cap, "%s: %s, %s", name, text, op);
  ScrError *error = scr_fs_error_details(e, name, msg, (size_t)len, op, path, NULL);
  free(msg);
  return error;
}

/* Set while scr_fs_stat_probe runs: a missing entry (ENOENT, ENOTDIR) is
 * not thrown, so the probe answers undefined without building the error. */
static SCR_TL bool scr_fs_probing = false;

void scr_fs_throw(int e, const char *op, const ScrStr *path) {
  if (scr_fs_probing && (e == ENOENT || e == ENOTDIR)) return;
  ScrError *error = scr_fs_error(e, op, path);
  scr_throw_obj(error, &scr_error_retain_v, &scr_error_release_v, scr_error_trace_arg());
}

/* A native binding's coded Error (Node's THROW_ERR_* macros): "Error:
 * message" with an own `code`, and no "[code]" in its name. */
void scr_fs_throw_native_coded(const char *code, const char *message, size_t length) {
  ScrStr *text = scr_str_new(message, length);
  ScrError *error = scr_error_new(SCR_ERR_ERROR, text);
  scr_str_release(text);
  scr_error_set_code(error, code);
  error->native_plain = true;
  scr_throw_obj(error, &scr_error_retain_v, &scr_error_release_v, scr_error_trace_arg());
}

/* Node's ErrnoException (env->ThrowErrnoException, used for std::error_code
 * failures): "EEXIST, File exists 'path'" with errno (the positive errno),
 * code, path and syscall. */
void scr_fs_throw_errno_exception(int e, const char *syscall, const ScrStr *path) {
  char namebuf[16];
  const char *name = scr_errno_name(e, namebuf, sizeof namebuf);
  const char *text = strerror(e);
  size_t cap = strlen(name) + strlen(text) + (path ? path->len : 0) + 8;
  char *msg = malloc(cap);
  if (!msg) scr_trap("scriptc: out of memory\n");
  int len = path ? snprintf(msg, cap, "%s, %s '%s'", name, text, path->data) : snprintf(msg, cap, "%s, %s", name, text);
  ScrStr *message = scr_str_new(msg, (size_t)len);
  free(msg);
  ScrError *error = scr_error_new(SCR_ERR_ERROR, message);
  scr_str_release(message);
  scr_error_set_code(error, name);
  error->system_errno = e;
  error->system_call = scr_str_new(syscall, strlen(syscall));
  error->system_path = path ? scr_str_retain((ScrStr *)path) : NULL;
  error->errno_order = true;
  scr_throw_obj(error, &scr_error_retain_v, &scr_error_release_v, scr_error_trace_arg());
}

/* Node's SystemError (internal/errors.js) with a { message, path, syscall,
 * errno, code } context: "<prefix>: <syscall> returned <errno name>
 * (<message>) <path>", named SystemError, with code, info, errno, syscall
 * and path own properties. */
void scr_fs_throw_system_error(const char *code, const char *prefix, int e, const char *syscall,
                               const ScrStr *message, const ScrStr *path) {
  char namebuf[16];
  const char *name = scr_errno_name(e, namebuf, sizeof namebuf);
  size_t cap = strlen(prefix) + strlen(syscall) + strlen(name) + message->len + (path ? path->len : 0) + 32;
  char *msg = malloc(cap);
  if (!msg) scr_trap("scriptc: out of memory\n");
  int len = snprintf(msg, cap, "%s: %s returned %s (%s)", prefix, syscall, name, message->data);
  if (path) len += snprintf(msg + len, cap - (size_t)len, " %s", path->data);
  ScrStr *text = scr_str_new(msg, (size_t)len);
  free(msg);
  ScrError *error = scr_error_new(SCR_ERR_ERROR, text);
  scr_str_release(text);
  scr_str_release(error->name);
  error->name = scr_str_new("SystemError", 11);
  error->name_present = true;
  scr_error_set_code(error, code);
  error->system_errno = e;
  error->system_call = scr_str_new(syscall, strlen(syscall));
  error->system_path = path ? scr_str_retain((ScrStr *)path) : NULL;
  error->system_message = scr_str_retain((ScrStr *)message);
  error->system_code = scr_str_new(name, strlen(name));
  scr_throw_obj(error, &scr_error_retain_v, &scr_error_release_v, scr_error_trace_arg());
}

/* ── fs operations ───────────────────────────────────────────────────── */

static FILE *scr_fs_fopen(const ScrStr *path, const char *mode) {
#ifdef _WIN32
  WCHAR *wide = scr_fs_win_wide(path);
  if (!wide) { errno = scr_fs_win_errno(GetLastError()); return NULL; }
  WCHAR wide_mode[4] = {0};
  size_t length = strlen(mode);
  if (length >= 4) scr_trap("scriptc: invalid internal file mode\n");
  for (size_t i = 0; i < length; i++) wide_mode[i] = (WCHAR)mode[i];
  FILE *file = _wfopen(wide, wide_mode);
  int error = errno;
  free(wide);
  errno = error;
  return file;
#else
  return fopen(path->data, mode);
#endif
}

/* File sizes are hints, never EOF. Pseudo-files, pipes and concurrently
 * changing files still read to EOF; descriptor reads keep their position
 * and ownership. Limit individual reads for the CRT and small ssize_t. */
typedef struct {
  ScrStr *text;
  uint8_t *bytes;
  size_t len, cap;
  size_t ascii; /* text: length of the proven-ASCII prefix */
} ScrFileRead;

static size_t scr_file_read_hint(FILE *stream, int fd) {
  if (stream) fd = fileno(stream);
#ifdef _WIN32
  struct _stat64 st;
  if (_fstat64(fd, &st) != 0 || !S_ISREG(st.st_mode) || st.st_size <= 0) return 4096;
  int64_t position = stream ? 0 : _lseeki64(fd, 0, SEEK_CUR);
#else
  struct stat st;
  if (fstat(fd, &st) != 0 || !S_ISREG(st.st_mode) || st.st_size <= 0) return 4096;
  off_t position = stream ? 0 : lseek(fd, 0, SEEK_CUR);
#endif
  if (position < 0 || position >= st.st_size) return 4096;
  uintmax_t remaining = (uintmax_t)st.st_size - (uintmax_t)position;
  /* A bounded initial allocation also tolerates sparse files that shrink
   * between metadata and the first read without reserving their full size. */
  size_t limit = 64 * 1024 * 1024;
  return remaining > limit ? limit : (size_t)remaining;
}

static uint8_t *scr_file_read_data(ScrFileRead *out) {
  return out->text ? (uint8_t *)out->text->data : out->bytes;
}

static void scr_file_read_grow(ScrFileRead *out) {
  size_t limit = SIZE_MAX - sizeof(ScrStr) - 1;
  if (out->cap >= limit) scr_trap("scriptc: file too large\n");
  size_t cap = out->cap > limit / 2 ? limit : out->cap * 2;
  if (out->text) {
    out->text->len = out->len;
    out->text = scr_str_regrow(out->text, cap);
  } else {
    uint8_t *grown = realloc(out->bytes, cap);
    if (!grown) scr_trap("scriptc: out of memory\n");
    out->bytes = grown;
  }
  out->cap = cap;
}

/* Fill the final allocation. At a full capacity, probe one byte before
 * growing so an exact-size regular file never doubles its retained space. */
static int scr_file_read_all(FILE *stream, int fd, bool text, ScrFileRead *out) {
  *out = (ScrFileRead){0};
  out->cap = scr_file_read_hint(stream, fd);
  if (text) {
    out->text = scr_str_alloc_raw(0, out->cap);
    out->cap = out->text->cap;
    out->text->data[0] = '\0';
  } else {
    out->bytes = malloc(out->cap);
    if (!out->bytes) scr_trap("scriptc: out of memory\n");
  }
  for (;;) {
    uint8_t extra;
    bool full = out->len == out->cap;
    size_t room = full ? 1 : out->cap - out->len;
    if (room > 512 * 1024) room = 512 * 1024;
    uint8_t *dest = full ? &extra : scr_file_read_data(out) + out->len;
    size_t count;
    int error = 0;
    if (stream) {
      count = fread(dest, 1, room, stream);
      if (ferror(stream)) error = errno ? errno : EIO;
    } else {
      ssize_t n = read(fd, dest, room);
      if (n < 0) { count = 0; error = errno; }
      else count = (size_t)n;
    }
    if (count) {
      if (full) {
        scr_file_read_grow(out);
        scr_file_read_data(out)[out->len] = extra;
        dest = scr_file_read_data(out) + out->len;
      }
      /* Text reads scan each chunk for ASCII while it is still in cache,
       * so a whole-file UTF-8 check usually has nothing left to do. */
      if (out->text && out->ascii == out->len)
        out->ascii += scr_bytes_ascii_span((const char *)dest, count);
      out->len += count;
    }
    if (error == EINTR) {
      if (stream) clearerr(stream);
      continue;
    }
    if (error) {
      /* Raw strings must be safe for the normal cache-aware destructor. */
      if (out->text) { out->text->len = out->len; out->text->data[out->len] = '\0'; }
      scr_str_release(out->text);
      free(out->bytes);
      *out = (ScrFileRead){0};
      return error;
    }
    if (!count) break;
  }
  if (out->text) { out->text->len = out->len; out->text->data[out->len] = '\0'; }
  // Do not retain a large hint after truncation or a tiny pipe result.
  if (out->cap > 256 && out->len < out->cap / 2) {
    if (out->text) out->text = scr_str_regrow(out->text, out->len);
    else {
      uint8_t *trimmed = realloc(out->bytes, out->len ? out->len : 1);
      if (trimmed) out->bytes = trimmed;
    }
  }
  return 0;
}

static ScrStr *scr_fs_read_file_core(ScrStr *path, bool env_file, size_t *ascii) {
  FILE *f = scr_fs_fopen(path, "rb");
  if (!f) {
    scr_fs_throw(errno, "open", path);
    return NULL;
  }
  ScrFileRead out;
  int error = scr_file_read_all(f, -1, true, &out);
  fclose(f);
  if (error) {
    if (env_file) {
      ScrJsonBuf b;
      scr_jb_init(&b);
      scr_jb_puts(&b, "Contents of '");
      scr_jb_put_str(&b, path);
      scr_jb_puts(&b, "' should be a valid string.");
      ScrStr *message = scr_jb_finish(&b);
      scr_throw_error_msg_code(SCR_ERR_TYPE, message->data, message->len, "ERR_INVALID_ARG_TYPE");
      scr_str_release(message);
    } else scr_fs_throw(error, "read", path);
    return NULL;
  }
  if (ascii) *ascii = out.ascii;
  return out.text;
}

ScrBytes *scr_fs_read_file_bytes(ScrStr *path) {
  if (!scr_fs_path_ok(path, "path")) return NULL;
  FILE *f = scr_fs_fopen(path, "rb");
  if (!f) { scr_fs_throw(errno, "open", path); return NULL; }
  ScrFileRead out;
  int error = scr_file_read_all(f, -1, false, &out);
  fclose(f);
  if (error) { scr_fs_throw(error, "read", path); return NULL; }
  return scr_bytes_take_data(out.bytes, out.len);
}

/* readFileSync(path, "utf8") and fs.promises.readFile(path, "utf8"): the
 * file is read straight into string storage and decoded in place (Node's
 * Buffer utf8 decode: U+FFFD per malformed subpart, a BOM is kept). */
ScrStr *scr_fs_read_file(ScrStr *path) {
  if (!scr_fs_path_ok(path, "path")) return NULL;
  size_t ascii = 0;
  ScrStr *raw = scr_fs_read_file_core(path, false, &ascii);
  return raw ? scr_str_adopt_utf8_lossy(raw, ascii) : NULL;
}

static ScrStr *scr_fs_realpath_common(ScrStr *path, const char *op) {
  if (!scr_fs_path_ok(path, "path")) return NULL;
#ifdef _WIN32
  WCHAR *wide = scr_fs_win_wide(path);
  if (!wide) {
    scr_fs_throw(scr_fs_win_errno(GetLastError()), op, path);
    return NULL;
  }
  HANDLE handle = CreateFileW(wide, FILE_READ_ATTRIBUTES,
                              FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                              NULL, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS, NULL);
  free(wide);
  if (handle == INVALID_HANDLE_VALUE) {
    scr_fs_throw(scr_fs_win_errno(GetLastError()), op, path);
    return NULL;
  }
  DWORD needed = GetFinalPathNameByHandleW(handle, NULL, 0, FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
  if (needed == 0) {
    DWORD error = GetLastError();
    CloseHandle(handle);
    scr_fs_throw(scr_fs_win_errno(error), op, path);
    return NULL;
  }
  WCHAR *resolved = malloc(((size_t)needed + 1) * sizeof *resolved);
  if (!resolved) {
    CloseHandle(handle);
    scr_trap("scriptc: out of memory\n");
  }
  DWORD length = GetFinalPathNameByHandleW(handle, resolved, needed + 1,
                                           FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
  DWORD error = length == 0 ? GetLastError() : length > needed ? ERROR_INSUFFICIENT_BUFFER : ERROR_SUCCESS;
  CloseHandle(handle);
  if (error != ERROR_SUCCESS) {
    free(resolved);
    scr_fs_throw(scr_fs_win_errno(error), op, path);
    return NULL;
  }
  size_t prefix = 0;
  bool unc = false;
  if (length >= 8 && wcsncmp(resolved, L"\\\\?\\UNC\\", 8) == 0) {
    prefix = 8;
    unc = true;
  } else if (length >= 4 && wcsncmp(resolved, L"\\\\?\\", 4) == 0) {
    prefix = 4;
  }
  int utf8_len = WideCharToMultiByte(CP_UTF8, 0, resolved + prefix,
                                     (int)(length - prefix), NULL, 0, NULL, NULL);
  if (utf8_len <= 0) {
    error = GetLastError();
    free(resolved);
    scr_fs_throw(scr_fs_win_errno(error), op, path);
    return NULL;
  }
  size_t extra = unc ? 2 : 0;
  char *utf8 = malloc(extra + (size_t)utf8_len);
  if (!utf8) {
    free(resolved);
    scr_trap("scriptc: out of memory\n");
  }
  if (unc) { utf8[0] = '\\'; utf8[1] = '\\'; }
  (void)WideCharToMultiByte(CP_UTF8, 0, resolved + prefix, (int)(length - prefix),
                            utf8 + extra, utf8_len, NULL, NULL);
  ScrStr *result = scr_str_new(utf8, extra + (size_t)utf8_len);
  free(utf8);
  free(resolved);
  return result;
#else
  char buf[PATH_MAX];
  if (realpath(path->data, buf) == NULL) {
    scr_fs_throw(errno, op, path);
    return NULL;
  }
  return scr_str_new(buf, strlen(buf));
#endif
}

ScrStr *scr_fs_realpath(ScrStr *path) {
  return scr_fs_realpath_common(path, "lstat");
}

ScrStr *scr_fs_realpath_promise(ScrStr *path) {
  return scr_fs_realpath_common(path, "realpath");
}

static void scr_fs_write_common(ScrStr *path, ScrStr *data, const char *mode) {
  if (!scr_fs_path_ok(path, "path")) return;
  FILE *f = scr_fs_fopen(path, mode);
  if (!f) {
    scr_fs_throw(errno, "open", path);
    return;
  }
  char *owned;
  const char *bytes = scr_str_utf8(data, &owned);
  if (data->len > 0 && fwrite(bytes, 1, data->len, f) != data->len) {
    int e = errno;
    fclose(f);
    scr_str_utf8_end(owned);
    scr_fs_throw(e, "write", path);
    return;
  }
  scr_str_utf8_end(owned);
  if (fclose(f) != 0) scr_fs_throw(errno, "close", path);
}

void scr_fs_write_file(ScrStr *path, ScrStr *data) {
  scr_fs_write_common(path, data, "wb");
}

/* writeFileSync(p, data, { mode }): the mode is open(2)'s O_CREAT
 * argument — it applies at CREATION only (umask applying), and an
 * existing file keeps its permissions, exactly Node (which never chmods
 * here). Same error shapes as the plain form. */
void scr_fs_write_file_mode(ScrStr *path, ScrStr *data, double mode) {
  if (!scr_fs_path_ok(path, "path")) return;
  char recv[48], msg[176];
  scr_num_received(mode, recv);
  if (!(isfinite(mode) && trunc(mode) == mode)) {
    int len = snprintf(msg, sizeof msg,
                       "The value of \"mode\" is out of range. It must be an integer. Received %s",
                       recv);
    scr_throw_error_msg_code(SCR_ERR_RANGE, msg, (size_t)len, "ERR_OUT_OF_RANGE");
    return;
  }
  if (mode < 0 || mode > 4294967295.0) {
    int len = snprintf(msg, sizeof msg,
                       "The value of \"mode\" is out of range. It must be >= 0 && <= 4294967295. Received %s",
                       recv);
    scr_throw_error_msg_code(SCR_ERR_RANGE, msg, (size_t)len, "ERR_OUT_OF_RANGE");
    return;
  }
  /* O_BINARY: zero on POSIX; on Windows it keeps the CRT from translating
   * \n in these byte-exact writes (fopen's "wb" path already does). */
  int fd = open(path->data, O_WRONLY | O_CREAT | O_TRUNC | O_BINARY, (mode_t)mode);
  if (fd < 0) {
    scr_fs_throw(errno, "open", path);
    return;
  }
  char *owned;
  const char *bytes = scr_str_utf8(data, &owned);
  size_t at = 0;
  while (at < data->len) {
    ssize_t wrote = write(fd, bytes + at, data->len - at);
    if (wrote < 0) {
      if (errno == EINTR) continue;
      int e = errno;
      close(fd);
      scr_str_utf8_end(owned);
      scr_fs_throw(e, "write", path);
      return;
    }
    at += (size_t)wrote;
  }
  scr_str_utf8_end(owned);
  if (close(fd) != 0) scr_fs_throw(errno, "close", path);
}

void scr_fs_append_file(ScrStr *path, ScrStr *data) {
  scr_fs_write_common(path, data, "ab");
}

bool scr_fs_exists(ScrStr *path) {
  /* Like Node's existsSync: any failure (missing, EACCES on a parent, a
   * path with a null byte, ...) is simply false — never a throw. */
  if (memchr(path->data, 0, path->len)) return false;
  return access(path->data, F_OK) == 0;
}

void scr_fs_mkdir(ScrStr *path) {
  if (!scr_fs_path_ok(path, "path")) return;
  if (scr_sys_mkdir(path->data, 0777) != 0) scr_fs_throw(errno, "mkdir", path);
}

/* mkdirSync(p, { mode }) non-recursive: mkdir(2) with the explicit mode
 * (umask applies, exactly as in Node — mode is the syscall argument;
 * Windows has no directory modes and drops it, like Node there). */
void scr_fs_mkdir_mode(ScrStr *path, double mode) {
  if (!scr_fs_path_ok(path, "path")) return;
  if (scr_sys_mkdir(path->data, (mode_t)mode) != 0) scr_fs_throw(errno, "mkdir", path);
}

#ifdef _WIN32
/* The CRT's stat follows junctions. Recognize real link reparse records
 * before unlink/rm dispatch so a tree walk never descends into their targets.
 * Return 1 for a removed link, 0 for an ordinary entry, -1 on failure. */
static int scr_fs_win_remove_link(const char *path, size_t len) {
  ScrStr *text = scr_str_new(path, len);
  WCHAR *wide = scr_fs_win_wide(text);
  scr_str_release(text);
  if (!wide) { errno = scr_fs_win_errno(GetLastError()); return -1; }
  DWORD attributes = GetFileAttributesW(wide);
  if (attributes == INVALID_FILE_ATTRIBUTES || !(attributes & FILE_ATTRIBUTE_REPARSE_POINT)) { free(wide); return 0; }
  HANDLE h = CreateFileW(wide, FILE_READ_ATTRIBUTES,
    FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, NULL, OPEN_EXISTING,
    FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, NULL);
  if (h == INVALID_HANDLE_VALUE) { DWORD error = GetLastError(); free(wide); errno = scr_fs_win_errno(error); return -1; }
  FILE_ATTRIBUTE_TAG_INFO tagged;
  if (!GetFileInformationByHandleEx(h, FileAttributeTagInfo, &tagged, sizeof tagged)) {
    DWORD error = GetLastError(); CloseHandle(h); free(wide); errno = scr_fs_win_errno(error); return -1;
  }
  double size;
  bool link = scr_stats_is_link_tag(tagged.ReparseTag);
  // Mount-point tags also represent mounted volumes. Only junction payloads
  // are links; keep the existing ordinary-directory behavior for volumes.
  if (link && tagged.ReparseTag == IO_REPARSE_TAG_MOUNT_POINT) link = scr_stats_link_target(h, tagged.ReparseTag, &size, NULL);
  CloseHandle(h);
  if (!link) { free(wide); return 0; }
  BOOL ok = attributes & FILE_ATTRIBUTE_DIRECTORY ? RemoveDirectoryW(wide) : DeleteFileW(wide);
  DWORD error = ok ? 0 : GetLastError();
  free(wide);
  if (!ok) { errno = scr_fs_win_errno(error); return -1; }
  return 1;
}
#endif

void scr_fs_unlink(ScrStr *path) {
  if (!scr_fs_path_ok(path, "path")) return;
#ifdef _WIN32
  int link = scr_fs_win_remove_link(path->data, path->len);
  if (link != 0) { if (link < 0) scr_fs_throw(errno, "unlink", path); return; }
#endif
  if (unlink(path->data) != 0) scr_fs_throw(errno, "unlink", path);
}

void scr_fs_chmod(ScrStr *path, double mode) {
  if (!scr_fs_path_ok(path, "path")) return;
  if (chmod(path->data, (mode_t)mode) != 0) scr_fs_throw(errno, "chmod", path);
}

static void scr_fs_throw_nopath(int e, const char *op);
static bool scr_fs_write_fd_valid(double fd);

/* Node's validateInteger(id, name, -1, 2 ** 32 - 1) for uid and gid. False
 * with the RangeError thrown. */
bool scr_fs_owner_id_valid(double id, const char *name) {
  bool integer = isfinite(id) && trunc(id) == id;
  if (integer && id >= -1 && id <= 4294967295.0) return true;
  char received[48], msg[192];
  scr_num_received(id, received);
  int n = snprintf(msg, sizeof msg, "The value of \"%s\" is out of range. It must be %s. Received %s", name,
                   integer ? ">= -1 && <= 4294967295" : "an integer", received);
  scr_throw_error_msg_code(SCR_ERR_RANGE, msg, (size_t)n, "ERR_OUT_OF_RANGE");
  return false;
}

/* chown, lchown (path, no follow) and fchown (fd >= 0, path NULL). libuv's
 * Windows forms are unconditional no-op successes — Node's calls "work" and
 * change nothing there; WASI likewise has no ownership model. Node passes
 * the ids straight to the syscall; -1 is the POSIX "leave unchanged" value
 * and rides the same int cast. */
static void scr_fs_chown_op(ScrStr *path, double fd, bool no_follow, double uid, double gid) {
  if (!scr_fs_owner_id_valid(uid, "uid") || !scr_fs_owner_id_valid(gid, "gid")) return;
  /* The binding checks fchown's fd after the ids. */
  if (!path && !scr_fs_write_fd_valid(fd)) return;
#if defined(_WIN32) || defined(__wasi__)
  (void)path; (void)fd; (void)no_follow;
#else
  uid_t owner = (uid_t)(int64_t)uid;
  gid_t group = (gid_t)(int64_t)gid;
  if (!path) {
    if (fchown((int)fd, owner, group) != 0) scr_fs_throw_nopath(errno, "fchown");
  } else if ((no_follow ? lchown(path->data, owner, group) : chown(path->data, owner, group)) != 0) {
    scr_fs_throw(errno, no_follow ? "lchown" : "chown", path);
  }
#endif
}

void scr_fs_chown(ScrStr *path, double uid, double gid) { scr_fs_chown_op(path, -1, false, uid, gid); }
void scr_fs_lchown(ScrStr *path, double uid, double gid) { scr_fs_chown_op(path, -1, true, uid, gid); }
void scr_fs_fchown(double fd, double uid, double gid) { scr_fs_chown_op(NULL, fd, false, uid, gid); }

/* fs.openSync(path, flags) → the raw fd (as f64) — the pair behind
 * spawn's fd-stdio form (openSync → stdio: ["ignore", fd, fd] →
 * closeSync). flags is Node's string grammar; an unknown flag throws
 * Node's ERR_INVALID_ARG_VALUE TypeError text, an open(2) failure the
 * usual Node-shaped fs error. Mode is Node's 0666 default (the numeric
 * third argument is a compile fence). */
double scr_fs_open(ScrStr *path, ScrStr *flags) {
  if (!scr_fs_path_ok(path, "path")) return 0;
  const char *f = flags->data;
  int of;
  if (strcmp(f, "r") == 0) of = O_RDONLY;
  else if (strcmp(f, "rs") == 0 || strcmp(f, "sr") == 0) of = O_RDONLY | O_SYNC;
  else if (strcmp(f, "r+") == 0) of = O_RDWR;
  else if (strcmp(f, "rs+") == 0 || strcmp(f, "sr+") == 0) of = O_RDWR | O_SYNC;
  else if (strcmp(f, "w") == 0) of = O_TRUNC | O_CREAT | O_WRONLY;
  else if (strcmp(f, "wx") == 0 || strcmp(f, "xw") == 0) of = O_TRUNC | O_CREAT | O_WRONLY | O_EXCL;
  else if (strcmp(f, "w+") == 0) of = O_TRUNC | O_CREAT | O_RDWR;
  else if (strcmp(f, "wx+") == 0 || strcmp(f, "xw+") == 0) of = O_TRUNC | O_CREAT | O_RDWR | O_EXCL;
  else if (strcmp(f, "a") == 0) of = O_APPEND | O_CREAT | O_WRONLY;
  else if (strcmp(f, "ax") == 0 || strcmp(f, "xa") == 0) of = O_APPEND | O_CREAT | O_WRONLY | O_EXCL;
  else if (strcmp(f, "as") == 0 || strcmp(f, "sa") == 0) of = O_APPEND | O_CREAT | O_WRONLY | O_SYNC;
  else if (strcmp(f, "a+") == 0) of = O_APPEND | O_CREAT | O_RDWR;
  else if (strcmp(f, "ax+") == 0 || strcmp(f, "xa+") == 0) of = O_APPEND | O_CREAT | O_RDWR | O_EXCL;
  else if (strcmp(f, "as+") == 0 || strcmp(f, "sa+") == 0) of = O_APPEND | O_CREAT | O_RDWR | O_SYNC;
  else {
    char msg[128];
    int len = snprintf(msg, sizeof msg, "The argument 'flags' is invalid. Received '%s'", f);
    scr_throw_error_msg(SCR_ERR_TYPE, msg, (size_t)len);
    return 0;
  }
  int fd = open(path->data, of | O_BINARY, 0666);
  if (fd < 0) {
    scr_fs_throw(errno, "open", path);
    return 0;
  }
  return (double)fd;
}

/* fs.openSync(path, fs.constants.O_* [, mode]). The compiler passes a
 * platform-independent mask for inline flag expressions; native flags are
 * chosen here so cross-compiled programs retain the target's values. */
double scr_fs_open_numeric(ScrStr *path, double flags, double mode) {
  if (!scr_fs_path_ok(path, "path")) return 0;
  int bits = (int)flags;
  int access = bits & 3;
  if (access == 3 || !(isfinite(mode) && trunc(mode) == mode && mode >= 0 && mode <= 4294967295.0)) {
    scr_throw_error_msg(SCR_ERR_RANGE, "Invalid open flags or mode", 26);
    return 0;
  }
  int native = access == 1 ? O_WRONLY : access == 2 ? O_RDWR : O_RDONLY;
  if (bits & 4) native |= O_CREAT;
  if (bits & 8) native |= O_EXCL;
  if (bits & 64) native |= O_TRUNC;
  if (bits & 128) native |= O_APPEND;
#ifdef _WIN32
  /* The CRT cannot open a reparse point without following it. Fail closed
   * until a handle-based no-follow open is available on this target. */
  if (bits & 16) {
    scr_fs_throw(ENOSYS, "open", path);
    return 0;
  }
#else
  if (bits & 16) native |= O_NOFOLLOW;
  if (bits & 32) native |= O_NONBLOCK;
#endif
  int fd = open(path->data, native | O_BINARY, (mode_t)mode);
  if (fd < 0) {
    scr_fs_throw(errno, "open", path);
    return 0;
  }
  return (double)fd;
}

static void scr_fs_throw_nopath(int e, const char *op);
static bool scr_fs_write_fd_valid(double fd);

double scr_fs_open_native(ScrStr *path, double flags, double mode) {
  if (!scr_fs_path_ok(path, "path")) return 0;
#ifdef _WIN32
  WCHAR *wide = scr_fs_win_wide(path);
  if (!wide) { scr_fs_throw(scr_fs_win_errno(GetLastError()), "open", path); return 0; }
  int fd = _wopen(wide, (int)flags | O_BINARY, (int)mode);
  free(wide);
#else
  int fd = open(path->data, (int)flags | O_BINARY, (mode_t)mode);
#endif
  if (fd < 0) { scr_fs_throw(errno, "open", path); return 0; }
  return (double)fd;
}

void scr_fs_fchmod(double fd, double mode) {
#ifdef _WIN32
  (void)fd;
  (void)mode;
  /* The CRT cannot enforce Unix permission bits through a descriptor.
   * A no-op success would misrepresent a security-sensitive operation. */
  scr_fs_throw_nopath(ENOSYS, "fchmod");
#else
  if (fchmod((int)fd, (mode_t)mode) != 0) scr_fs_throw_nopath(errno, "fchmod");
#endif
}

void scr_fs_fsync(double fd) {
#ifdef _WIN32
  if (_commit((int)fd) != 0) scr_fs_throw_nopath(errno, "fsync");
#else
  if (fsync((int)fd) != 0) scr_fs_throw_nopath(errno, "fsync");
#endif
}

void scr_fs_fdatasync(double fd) {
  if (!scr_fs_write_fd_valid(fd)) return;
#if defined(_WIN32)
  if (_commit((int)fd) != 0) scr_fs_throw_nopath(errno, "fdatasync");
#elif defined(__APPLE__)
  /* macOS/libuv implements fdatasync with fsync. */
  if (fsync((int)fd) != 0) scr_fs_throw_nopath(errno, "fdatasync");
#else
  if (fdatasync((int)fd) != 0) scr_fs_throw_nopath(errno, "fdatasync");
#endif
}

/* Node's validateInteger(len, 'len'). False with the RangeError thrown. */
bool scr_fs_truncate_len_valid(double length) {
  if (isfinite(length) && trunc(length) == length &&
      length >= -9007199254740991.0 && length <= 9007199254740991.0) return true;
  char received[48], msg[192];
  scr_num_received(length, received);
  const char *bound = isfinite(length) && trunc(length) == length
    ? ">= -9007199254740991 && <= 9007199254740991" : "an integer";
  int n = snprintf(msg, sizeof msg,
    "The value of \"len\" is out of range. It must be %s. Received %s", bound, received);
  scr_throw_error_msg_code(SCR_ERR_RANGE, msg, (size_t)n, "ERR_OUT_OF_RANGE");
  return false;
}

void scr_fs_ftruncate(double fd, double length) {
  if (!scr_fs_write_fd_valid(fd)) return;
  if (!scr_fs_truncate_len_valid(length)) return;
  if (length < 0) length = 0;
#ifdef _WIN32
  int error = (int)_chsize_s((int)fd, (__int64)length);
  if (error) scr_fs_throw_nopath(error, "ftruncate");
#else
  if (ftruncate((int)fd, (off_t)length) != 0) scr_fs_throw_nopath(errno, "ftruncate");
#endif
}

/* truncateSync and fsp.truncate: open(path, 'r+'), then ftruncate's len
 * check and clamp, then close. Node's order, so an open failure wins over
 * an invalid len. */
void scr_fs_truncate(ScrStr *path, double length) {
  if (!scr_fs_path_ok(path, "path")) return;
  ScrStr *flags = scr_str_new("r+", 2);
  double fd = scr_fs_open(path, flags);
  scr_str_release(flags);
  if (scr_exc_pending()) return;
  scr_fs_ftruncate(fd, length);
  close((int)fd);
}

#ifdef _WIN32
static bool scr_fs_set_times(HANDLE handle, double access, double modified) {
  FILETIME atime, mtime, now;
  if (isinf(access) || isinf(modified)) GetSystemTimeAsFileTime(&now);
  double values[2] = { access, modified };
  FILETIME *files[2] = { &atime, &mtime };
  for (size_t i = 0; i < 2; i++) {
    if (isnan(values[i])) { files[i] = NULL; continue; }
    if (isinf(values[i])) { *files[i] = now; continue; }
    double ticks = values[i] * 10000000.0 + 116444736000000000.0;
    if (ticks < -9223372036854775808.0 || ticks >= 9223372036854775808.0) {
      SetLastError(ERROR_INVALID_PARAMETER);
      return false;
    }
    int64_t time = (int64_t)ticks;
    files[i]->dwLowDateTime = (DWORD)(uint64_t)time;
    files[i]->dwHighDateTime = (DWORD)((uint64_t)time >> 32);
  }
  return SetFileTime(handle, NULL, files[0], files[1]) != 0;
}

static DWORD scr_fs_set_path_times(WCHAR *path, double atime, double mtime, bool nofollow) {
  DWORD flags = FILE_FLAG_BACKUP_SEMANTICS | (nofollow ? FILE_FLAG_OPEN_REPARSE_POINT : 0);
  HANDLE handle = CreateFileW(path, FILE_WRITE_ATTRIBUTES,
    FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, NULL, OPEN_EXISTING, flags, NULL);
  if (handle == INVALID_HANDLE_VALUE) return GetLastError();
  DWORD error = scr_fs_set_times(handle, atime, mtime) ? 0 : GetLastError();
  CloseHandle(handle);
  return error;
}
#else
/* Match the pinned libuv conversion: nanosecond truncation, normalized
 * negative fractions, and the special current/unchanged time sentinels. */
static bool scr_fs_timespec(double time, struct timespec *out) {
  if (isinf(time)) { *out = (struct timespec){ 0, UTIME_NOW }; return true; }
  if (isnan(time)) { *out = (struct timespec){ 0, UTIME_OMIT }; return true; }
  if (time < -9223372036854775808.0 || time >= 9223372036854775808.0) return false;
  out->tv_sec = (time_t)time;
  out->tv_nsec = (long)((time - (double)out->tv_sec) * 1000000000.0);
  if (out->tv_nsec < 0) { out->tv_nsec += 1000000000; out->tv_sec--; }
  return true;
}
#endif

void scr_fs_utimes(ScrStr *path, double atime, double mtime, bool nofollow) {
  if (!scr_fs_path_ok(path, "path")) return;
  const char *op = nofollow ? "lutime" : "utime";
#ifdef _WIN32
  WCHAR *wide = scr_fs_win_wide(path);
  if (!wide) { scr_fs_throw(scr_fs_win_errno(GetLastError()), op, path); return; }
  DWORD error = scr_fs_set_path_times(wide, atime, mtime, nofollow);
  if (nofollow && (error == ERROR_SYMLINK_NOT_SUPPORTED || error == ERROR_NOT_A_REPARSE_POINT))
    error = scr_fs_set_path_times(wide, atime, mtime, false);
  free(wide);
  if (error) scr_fs_throw(scr_fs_win_errno(error), op, path);
#else
  struct timespec times[2];
  if (!scr_fs_timespec(atime, &times[0]) || !scr_fs_timespec(mtime, &times[1])) { scr_fs_throw(EINVAL, op, path); return; }
  if (utimensat(AT_FDCWD, path->data, times, nofollow ? AT_SYMLINK_NOFOLLOW : 0) != 0) scr_fs_throw(errno, op, path);
#endif
}

void scr_fs_futimes(double fd, double atime, double mtime) {
#ifdef _WIN32
  HANDLE handle = (HANDLE)_get_osfhandle((int)fd);
  if (handle == INVALID_HANDLE_VALUE) { scr_fs_throw_nopath(EBADF, "futime"); return; }
  if (!scr_fs_set_times(handle, atime, mtime)) scr_fs_throw_nopath(scr_fs_win_errno(GetLastError()), "futime");
#else
  struct timespec times[2];
  if (!scr_fs_timespec(atime, &times[0]) || !scr_fs_timespec(mtime, &times[1])) { scr_fs_throw_nopath(EINVAL, "futime"); return; }
  if (futimens((int)fd, times) != 0) scr_fs_throw_nopath(errno, "futime");
#endif
}

/* fs.closeSync(fd) — close(2); failure throws Node's path-less fs error
 * shape ("EBADF: bad file descriptor, close"). */

/* Offset-preserving read for fs.readSync's numeric-position form. POSIX
 * supplies pread(2). Windows follows libuv's synchronous-handle recipe:
 * ReadFile with an OVERLAPPED byte offset, then restore the handle position
 * because synchronous ReadFile updates it even when OVERLAPPED is present. */
static ssize_t scr_fs_pread(int fd, void *data, size_t length, double position) {
#ifdef _WIN32
  HANDLE handle = (HANDLE)_get_osfhandle(fd);
  if (handle == INVALID_HANDLE_VALUE) {
    errno = EBADF;
    return -1;
  }

  OVERLAPPED overlapped;
  memset(&overlapped, 0, sizeof overlapped);
  LARGE_INTEGER at;
  at.QuadPart = (LONGLONG)position;
  overlapped.Offset = at.LowPart;
  overlapped.OffsetHigh = at.HighPart;

  LARGE_INTEGER zero;
  LARGE_INTEGER original;
  zero.QuadPart = 0;
  BOOL restore = SetFilePointerEx(handle, zero, &original, FILE_CURRENT);
  DWORD got = 0;
  DWORD want = length > (size_t)UINT32_MAX ? UINT32_MAX : (DWORD)length;
  BOOL ok = ReadFile(handle, data, want, &got, &overlapped);
  DWORD error = ok ? ERROR_SUCCESS : GetLastError();
  if (restore) (void)SetFilePointerEx(handle, original, NULL, FILE_BEGIN);
  /* ReadFile may report a terminal status after still filling part of the
   * caller's buffer (notably ERROR_MORE_DATA for a message-mode pipe).
   * libuv/Node return those bytes and surface the status on the next read. */
  if (ok || got > 0 || error == ERROR_HANDLE_EOF || error == ERROR_BROKEN_PIPE) {
    return (ssize_t)got;
  }

  /* The read-specific subset of libuv's Win32-to-errno translation. */
  switch (error) {
    case ERROR_INVALID_HANDLE:
    case ERROR_ACCESS_DENIED:
      errno = EBADF;
      break;
    case ERROR_INVALID_FUNCTION:
    case ERROR_INVALID_PARAMETER:
      errno = EINVAL;
      break;
    case ERROR_NOT_ENOUGH_MEMORY:
    case ERROR_OUTOFMEMORY:
      errno = ENOMEM;
      break;
    case ERROR_OPERATION_ABORTED:
      errno = EINTR;
      break;
    default:
      errno = EIO;
      break;
  }
  return -1;
#else
  return pread(fd, data, length, (off_t)position);
#endif
}

/* Offset-preserving write for fs.writeSync's numeric-position forms. The
 * Windows arm mirrors scr_fs_pread: WriteFile receives an OVERLAPPED offset
 * and the CRT descriptor's current position is restored before returning. */
static ssize_t scr_fs_pwrite(int fd, const void *data, size_t length, double position) {
#ifdef _WIN32
  HANDLE handle = (HANDLE)_get_osfhandle(fd);
  if (handle == INVALID_HANDLE_VALUE) {
    errno = EBADF;
    return -1;
  }

  OVERLAPPED overlapped;
  memset(&overlapped, 0, sizeof overlapped);
  LARGE_INTEGER at;
  at.QuadPart = (LONGLONG)position;
  overlapped.Offset = at.LowPart;
  overlapped.OffsetHigh = at.HighPart;

  LARGE_INTEGER zero;
  LARGE_INTEGER original;
  zero.QuadPart = 0;
  BOOL restore = SetFilePointerEx(handle, zero, &original, FILE_CURRENT);
  DWORD wrote = 0;
  DWORD want = length > (size_t)UINT32_MAX ? UINT32_MAX : (DWORD)length;
  BOOL ok = WriteFile(handle, data, want, &wrote, &overlapped);
  DWORD error = ok ? ERROR_SUCCESS : GetLastError();
  if (restore) (void)SetFilePointerEx(handle, original, NULL, FILE_BEGIN);
  if (ok || wrote > 0) return (ssize_t)wrote;

  switch (error) {
    case ERROR_INVALID_HANDLE:
    case ERROR_ACCESS_DENIED:
      errno = EBADF;
      break;
    case ERROR_INVALID_FUNCTION:
    case ERROR_INVALID_PARAMETER:
      errno = EINVAL;
      break;
    case ERROR_DISK_FULL:
    case ERROR_HANDLE_DISK_FULL:
      errno = ENOSPC;
      break;
    case ERROR_FILE_TOO_LARGE:
      errno = EFBIG;
      break;
    case ERROR_BROKEN_PIPE:
    case ERROR_NO_DATA:
      errno = EPIPE;
      break;
    case ERROR_NOT_ENOUGH_MEMORY:
    case ERROR_OUTOFMEMORY:
      errno = ENOMEM;
      break;
    case ERROR_OPERATION_ABORTED:
      errno = EINTR;
      break;
    default:
      errno = EIO;
      break;
  }
  return -1;
#else
  return pwrite(fd, data, length, (off_t)position);
#endif
}

static bool scr_fs_write_fd_valid(double fd) {
  char msg[160];
  char recv[48];
  scr_num_received(fd, recv);
  if (!(isfinite(fd) && trunc(fd) == fd)) {
    int len = snprintf(msg, sizeof msg,
                       "The value of \"fd\" is out of range. It must be an integer. Received %s",
                       recv);
    scr_throw_error_msg_code(SCR_ERR_RANGE, msg, (size_t)len, "ERR_OUT_OF_RANGE");
    return false;
  }
  if (fd < 0 || fd > 2147483647.0) {
    int len = snprintf(msg, sizeof msg,
                       "The value of \"fd\" is out of range. It must be >= 0 && <= 2147483647. Received %s",
                       recv);
    scr_throw_error_msg_code(SCR_ERR_RANGE, msg, (size_t)len, "ERR_OUT_OF_RANGE");
    return false;
  }
  return true;
}

/* write(2) raises SIGPIPE before returning EPIPE when a pipe/socket peer has
 * closed; write(2)/pwrite(2) likewise raise SIGXFSZ before returning EFBIG at
 * RLIMIT_FSIZE. Node turns both into catchable fs errors. Do the same per
 * calling thread rather than changing process dispositions (which spawned
 * children would inherit). Consume only a signal freshly generated by this
 * call, preserving any signal that was already pending. */
static ssize_t scr_fs_write_once(int fd, const void *data, size_t length,
                                 bool positioned, double position) {
#if defined(_WIN32) || defined(__wasi__)
  return positioned
    ? scr_fs_pwrite(fd, data, length, position)
    : write(fd, data, length);
#else
  sigset_t write_set, old_set, pending;
  sigemptyset(&write_set);
#ifdef SIGPIPE
  sigaddset(&write_set, SIGPIPE);
#endif
#ifdef SIGXFSZ
  sigaddset(&write_set, SIGXFSZ);
#endif
  if (pthread_sigmask(SIG_BLOCK, &write_set, &old_set) != 0) {
    return positioned
      ? scr_fs_pwrite(fd, data, length, position)
      : write(fd, data, length);
  }

  bool pending_known = sigpending(&pending) == 0;
#ifdef SIGPIPE
  bool had_pipe = pending_known && sigismember(&pending, SIGPIPE) == 1;
#endif
#ifdef SIGXFSZ
  bool had_xfsz = pending_known && sigismember(&pending, SIGXFSZ) == 1;
#endif
  ssize_t n = positioned
    ? scr_fs_pwrite(fd, data, length, position)
    : write(fd, data, length);
  int write_errno = errno;

  int generated = 0;
  if (n < 0 && pending_known && sigpending(&pending) == 0) {
#ifdef SIGPIPE
    if (write_errno == EPIPE && !had_pipe && sigismember(&pending, SIGPIPE) == 1) {
      generated = SIGPIPE;
    }
#endif
#ifdef SIGXFSZ
    if (write_errno == EFBIG && !had_xfsz && sigismember(&pending, SIGXFSZ) == 1) {
      generated = SIGXFSZ;
    }
#endif
  }
  if (generated != 0) {
    sigset_t generated_set;
    sigemptyset(&generated_set);
    sigaddset(&generated_set, generated);
    int caught = 0;
    int wait_err;
    do {
      wait_err = sigwait(&generated_set, &caught);
    } while (wait_err == EINTR);
  }

  (void)pthread_sigmask(SIG_SETMASK, &old_set, NULL);
  errno = write_errno;
  return n;
#endif
}

static double scr_fs_write_bytes(double fd, const void *data, size_t length,
                                 double position) {
  if (!scr_fs_write_fd_valid(fd)) return 0;
  /* Node/libuv treats every position other than a safe nonnegative integer
   * as the current-offset sentinel for writes (unlike readSync, it does not
   * throw for negative/fractional positions). */
  bool positioned = isfinite(position) && trunc(position) == position &&
                    position >= 0 && position <= 9007199254740991.0;
  ssize_t n;
  do {
    n = scr_fs_write_once((int)fd, data, length, positioned, position);
  } while (n < 0 && errno == EINTR);
  if (n < 0) {
    int e = errno;
    char namebuf[16];
    const char *name = scr_errno_name(e, namebuf, sizeof namebuf);
    const char *text = scr_errno_text(e);
    char msg[160];
    int len = snprintf(msg, sizeof msg, "%s: %s, write", name, text);
    scr_fs_throw_details(e, name, msg, (size_t)len, "write", NULL, NULL);
    return 0;
  }
  return (double)n;
}

/* fs.writeSync(fd, buffer, offset, length[, position]) — validates the
 * caller window before touching the descriptor, then submits one write like
 * Node/libuv. Positioned writes do not advance the descriptor. */
double scr_fs_write_sync(double fd, ScrBytes *buf, double offset, double length,
                         double position) {
  SCR_BYTES_SNAPSHOT(buf);
  size_t bytelen = buf->len; /* frontend admits u8 buffers only */
  char msg[160];
  char recv[48];
  scr_num_received(offset, recv);
  if (!(isfinite(offset) && trunc(offset) == offset)) {
    int len = snprintf(msg, sizeof msg,
                       "The value of \"offset\" is out of range. It must be an integer. Received %s",
                       recv);
    scr_throw_error_msg_code(SCR_ERR_RANGE, msg, (size_t)len, "ERR_OUT_OF_RANGE");
    return 0;
  }
  if (offset < 0 || offset > 9007199254740991.0) {
    int len = snprintf(msg, sizeof msg,
                       "The value of \"offset\" is out of range. It must be >= 0 && <= 9007199254740991. Received %s",
                       recv);
    scr_throw_error_msg_code(SCR_ERR_RANGE, msg, (size_t)len, "ERR_OUT_OF_RANGE");
    return 0;
  }
  if (offset > (double)bytelen) {
    int len = snprintf(msg, sizeof msg,
                       "The value of \"offset\" is out of range. It must be <= %zu. Received %s",
                       bytelen, recv);
    scr_throw_error_msg_code(SCR_ERR_RANGE, msg, (size_t)len, "ERR_OUT_OF_RANGE");
    return 0;
  }

  scr_num_received(length, recv);
  if (length < 0) {
    int len = snprintf(msg, sizeof msg,
                       "The value of \"length\" is out of range. It must be >= 0. Received %s",
                       recv);
    scr_throw_error_msg_code(SCR_ERR_RANGE, msg, (size_t)len, "ERR_OUT_OF_RANGE");
    return 0;
  }
  size_t off = (size_t)offset;
  if (length > (double)(bytelen - off)) {
    int len = snprintf(msg, sizeof msg,
                       "The value of \"length\" is out of range. It must be <= %zu. Received %s",
                       bytelen - off, recv);
    scr_throw_error_msg_code(SCR_ERR_RANGE, msg, (size_t)len, "ERR_OUT_OF_RANGE");
    return 0;
  }
  if (!(isfinite(length) && trunc(length) == length)) {
    int len = snprintf(msg, sizeof msg,
                       "The value of \"length\" is out of range. It must be an integer. Received %s",
                       recv);
    scr_throw_error_msg_code(SCR_ERR_RANGE, msg, (size_t)len, "ERR_OUT_OF_RANGE");
    return 0;
  }
  return scr_fs_write_bytes(fd, buf->data + off, (size_t)length, position);
}

double scr_fs_write_str_sync(double fd, ScrStr *data, double position,
                             ScrStr *encoding) {
  (void)encoding; /* frontend proves utf8; the argument still evaluates */
  char *owned;
  const char *bytes = scr_str_utf8(data, &owned);
  double wrote = scr_fs_write_bytes(fd, bytes, data->len, position);
  scr_str_utf8_end(owned);
  return wrote;
}

/* fs.readSync(fd, buffer, offset, length[, position]) — the buffer form.
 * Node validates offset/length against the buffer before reading and
 * throws ERR_OUT_OF_RANGE; here the checks clamp to the same contract and
 * throw the RangeError shape. Position -1 means the fd's current offset;
 * nonnegative positions do not advance it. Returns the byte count the OS
 * reports; errors carry the errno name like the other fd operations. */
double scr_fs_read_sync(double fd, ScrBytes *buf, double offset, double length,
                        double position) {
  size_t bytelen = buf->len; /* u8 buffers: elem count == byte count */
  char msg[160];
  int mlen;
  /* Node's exact texts: offset validates against MAX_SAFE_INTEGER's range
   * form, length against the remaining window (validateOffset vs the
   * buffer-bounds check in fs.readSync). */
  char numbuf[40];
  if (!(isfinite(offset) && trunc(offset) == offset)) {
    char recv[48];
    scr_num_received(offset, recv);
    mlen = snprintf(msg, sizeof msg,
                    "The value of \"offset\" is out of range. It must be an integer. Received %s",
                    recv);
    scr_throw_error_msg_code(SCR_ERR_RANGE, msg, (size_t)mlen, "ERR_OUT_OF_RANGE");
    return 0;
  }
  if (offset < 0 || offset > 9007199254740991.0) {
    numbuf[scr_f64_to_str(offset, numbuf)] = 0;
    mlen = snprintf(msg, sizeof msg,
                    "The value of \"offset\" is out of range. It must be >= 0 && <= 9007199254740991. Received %s",
                    numbuf);
    scr_throw_error_msg_code(SCR_ERR_RANGE, msg, (size_t)mlen, "ERR_OUT_OF_RANGE");
    return 0;
  }
  if (!(isfinite(position) && trunc(position) == position)) {
    char recv[48];
    scr_num_received(position, recv);
    mlen = snprintf(msg, sizeof msg,
                    "The value of \"position\" is out of range. It must be an integer. Received %s",
                    recv);
    scr_throw_error_msg_code(SCR_ERR_RANGE, msg, (size_t)mlen, "ERR_OUT_OF_RANGE");
    return 0;
  }
  if (position < -1 || position > 9007199254740991.0) {
    char recv[48];
    scr_num_received(position, recv);
    mlen = snprintf(msg, sizeof msg,
                    "The value of \"position\" is out of range. It must be >= -1 && <= 9007199254740991. Received %s",
                    recv);
    scr_throw_error_msg_code(SCR_ERR_RANGE, msg, (size_t)mlen, "ERR_OUT_OF_RANGE");
    return 0;
  }
  /* Node returns after the offset and position validation when the
   * requested length normalizes to zero: buffer-window bounds and fd are
   * not consulted. Preserve the existing size_t coercion's [0, 1) case. */
  if (length >= 0 && length < 1) return 0;
  if (offset > (double)bytelen) {
    numbuf[scr_f64_to_str(offset, numbuf)] = 0;
    mlen = snprintf(msg, sizeof msg,
                    "The value of \"offset\" is out of range. It must be >= 0 && <= 9007199254740991. Received %s",
                    numbuf);
    scr_throw_error_msg_code(SCR_ERR_RANGE, msg, (size_t)mlen, "ERR_OUT_OF_RANGE");
    return 0;
  }
  size_t off = (size_t)offset;
  if (length < 0 || (double)length > (double)(bytelen - off)) {
    numbuf[scr_f64_to_str(length, numbuf)] = 0;
    mlen = snprintf(msg, sizeof msg,
                    "The value of \"length\" is out of range. It must be <= %zu. Received %s",
                    bytelen - off, numbuf);
    scr_throw_error_msg_code(SCR_ERR_RANGE, msg, (size_t)mlen, "ERR_OUT_OF_RANGE");
    return 0;
  }
  size_t want = (size_t)length;
  uint8_t *bounce = buf->shared ? malloc(want ? want : 1) : NULL;
  if (buf->shared && !bounce) scr_trap("scriptc: out of memory\n");
  uint8_t *destination = bounce ? bounce : buf->data + off;
  ssize_t n = position == -1
    ? read((int)fd, destination, want)
    : scr_fs_pread((int)fd, destination, want, position);
  int read_error = errno;
  if (bounce) {
    if (n > 0) scr_bytes_write(buf, off, bounce, (size_t)n);
    free(bounce);
  }
  errno = read_error;
  if (n < 0) {
    int e = errno;
    char namebuf[16];
    const char *name = scr_errno_name(e, namebuf, sizeof namebuf);
    const char *text = scr_errno_text(e);
    char msg[160];
    int len = snprintf(msg, sizeof msg, "%s: %s, read", name, text);
    scr_fs_throw_details(e, name, msg, (size_t)len, "read", NULL, NULL);
    return 0;
  }
  return (double)n;
}

/* Gather/scatter one contiguous window around ONE kernel operation. Multiple
 * scalar calls would change short I/O and pipe atomicity. This portable seam
 * also preserves positioned I/O on targets without preadv/pwritev. */
double scr_fs_read_zero(double fd, double position) {
  if (!scr_fs_write_fd_valid(fd)) return 0;
  uint8_t dummy;
  ssize_t n = position < 0 ? read((int)fd, &dummy, 0)
    : scr_fs_pread((int)fd, &dummy, 0, position);
  if (n < 0) scr_fs_throw_nopath(errno, "read");
  return 0;
}

static double scr_fs_vector_sync(double fd, ScrArr *buffers, double position,
                                 bool writing) {
  size_t count = (size_t)scr_arr_len(buffers);
  if (writing && count == 0) return 0;
  if (!scr_fs_write_fd_valid(fd)) return 0;
  if (count == 0) { scr_fs_throw_nopath(EINVAL, "read"); return 0; }
  size_t length = 0;
  for (size_t i = 0; i < count; i++) {
    ScrBytes *buf = scr_arr_get_ref(buffers, (double)i);
    size_t n = buf->len;
    scr_bytes_release(buf);
    if (n > SIZE_MAX - length) scr_trap("scriptc: vector I/O size overflow\n");
    length += n;
  }
  uint8_t *data = malloc(length ? length : 1);
  if (!data) scr_trap("scriptc: out of memory\n");
  if (writing) {
    size_t at = 0;
    for (size_t i = 0; i < count; i++) {
      ScrBytes *buf = scr_arr_get_ref(buffers, (double)i);
      scr_bytes_read(buf, 0, data + at, buf->len);
      at += buf->len;
      scr_bytes_release(buf);
    }
  }
  ScrBytes window = {SIZE_MAX, length, SCR_BYTES_U8, data, NULL};
  position = isfinite(position) && position >= 0 && position <= 9007199254740991.0
    ? trunc(position) : -1;
  double transferred = writing
    ? scr_fs_write_sync(fd, &window, 0, (double)length, position)
    : length == 0 ? scr_fs_read_zero(fd, position)
      : scr_fs_read_sync(fd, &window, 0, (double)length, position);
  if (!writing && !scr_exc_pending()) {
    size_t at = 0, remaining = (size_t)transferred;
    for (size_t i = 0; i < count && remaining; i++) {
      ScrBytes *buf = scr_arr_get_ref(buffers, (double)i);
      size_t n = buf->len < remaining ? buf->len : remaining;
      scr_bytes_write(buf, 0, data + at, n);
      at += n;
      remaining -= n;
      scr_bytes_release(buf);
    }
  }
  free(data);
  return transferred;
}

double scr_fs_readv_sync(double fd, ScrArr *buffers, double position) {
  return scr_fs_vector_sync(fd, buffers, position, false);
}

double scr_fs_writev_sync(double fd, ScrArr *buffers, double position) {
  return scr_fs_vector_sync(fd, buffers, position, true);
}

void scr_fs_close(double fd) {
  if (close((int)fd) != 0) {
    int e = errno;
    char namebuf[16];
    const char *name = scr_errno_name(e, namebuf, sizeof namebuf);
    const char *text = scr_errno_text(e);
    char msg[160];
    int len = snprintf(msg, sizeof msg, "%s: %s, close", name, text);
    scr_fs_throw_details(e, name, msg, (size_t)len, "close", NULL, NULL);
  }
}

/* Raw fd operations for the fs streams' worker-pool steps: no runtime
 * state, no exceptions. Each answers its result, or -errno. A negative
 * position reads or writes at the current file offset. */
int scr_fs_raw_open(const char *path, int flags, int mode) {
  int fd = open(path, flags | O_BINARY, (mode_t)mode);
  return fd < 0 ? -errno : fd;
}

int64_t scr_fs_raw_read(int fd, void *data, size_t length, double position) {
  ssize_t n = position >= 0 ? scr_fs_pread(fd, data, length, position) : read(fd, data, length);
  return n < 0 ? -errno : n;
}

int64_t scr_fs_raw_write(int fd, const void *data, size_t length, double position) {
  ssize_t n = scr_fs_write_once(fd, data, length, position >= 0, position);
  return n < 0 ? -errno : n;
}

int scr_fs_raw_fsync(int fd) {
#ifdef _WIN32
  return _commit(fd) != 0 ? -errno : 0;
#else
  return fsync(fd) != 0 ? -errno : 0;
#endif
}

int scr_fs_raw_close(int fd) {
  return close(fd) != 0 ? -errno : 0;
}

/* The two-path fs error shape — Node's copyfile errors quote both ends:
 * "ENOENT: no such file or directory, copyfile 'src' -> 'dest'". */
void scr_fs_throw2(int e, const char *op, const ScrStr *src, const ScrStr *dest) {
  char namebuf[16];
  const char *name = scr_errno_name(e, namebuf, sizeof namebuf);
  const char *text = scr_errno_text(e);
  char srcbuf[PATH_MAX], destbuf[PATH_MAX];
  const char *shown_src = scr_fs_err_path(src, srcbuf);
  const char *shown_dest = scr_fs_err_path(dest, destbuf);
  size_t cap = strlen(name) + strlen(text) + strlen(op) + strlen(shown_src) + strlen(shown_dest) + 16;
  char *msg = malloc(cap);
  if (!msg) {
    scr_trap("scriptc: out of memory\n");
  }
  int len = snprintf(msg, cap, "%s: %s, %s '%s' -> '%s'", name, text, op, shown_src, shown_dest);
  scr_fs_throw_details(e, name, msg, (size_t)len, op, src, dest);
  free(msg);
}

void scr_fs_link(ScrStr *source, ScrStr *dest) {
  if (!scr_fs_path_ok(source, "existingPath")) return;
  if (!scr_fs_path_ok(dest, "newPath")) return;
#ifdef _WIN32
  WCHAR *from = scr_fs_win_wide(source);
  WCHAR *to = scr_fs_win_wide(dest);
  if (!from || !to) {
    DWORD error = GetLastError();
    free(from); free(to);
    scr_fs_throw2(scr_fs_win_errno(error), "link", source, dest);
    return;
  }
  BOOL ok = CreateHardLinkW(to, from, NULL);
  DWORD error = ok ? 0 : GetLastError();
  free(from); free(to);
  if (!ok) scr_fs_throw2(scr_fs_win_errno(error), "link", source, dest);
#else
  if (link(source->data, dest->data) != 0) scr_fs_throw2(errno, "link", source, dest);
#endif
}

/* copyFileSync(src, dest): contents copied into a created-or-truncated
 * destination carrying the SOURCE's permission bits — libuv's
 * uv_fs_copyfile behavior behind Node's copyFileSync (umask applies at
 * creation, like any open(2)). Every failure throws catchably with the
 * two-path message and the syscall name Node reports ("copyfile"). */
void scr_fs_copyfile(ScrStr *src, ScrStr *dest) {
  if (!scr_fs_path_ok(src, "src")) return;
  if (!scr_fs_path_ok(dest, "dest")) return;
  int in = open(src->data, O_RDONLY | O_BINARY);
  if (in < 0) {
    scr_fs_throw2(errno, "copyfile", src, dest);
    return;
  }
  struct stat st;
  if (fstat(in, &st) != 0) {
    int e = errno;
    close(in);
    scr_fs_throw2(e, "copyfile", src, dest);
    return;
  }
  int out = open(dest->data, O_WRONLY | O_CREAT | O_TRUNC | O_BINARY, st.st_mode & 07777);
  if (out < 0) {
    int e = errno;
    close(in);
    scr_fs_throw2(e, "copyfile", src, dest);
    return;
  }
  char buf[65536];
  for (;;) {
    ssize_t got = read(in, buf, sizeof buf);
    if (got < 0) {
      if (errno == EINTR) continue;
      int e = errno;
      close(in);
      close(out);
      scr_fs_throw2(e, "copyfile", src, dest);
      return;
    }
    if (got == 0) break;
    ssize_t at = 0;
    while (at < got) {
      ssize_t wrote = write(out, buf + at, (size_t)(got - at));
      if (wrote < 0) {
        if (errno == EINTR) continue;
        int e = errno;
        close(in);
        close(out);
        scr_fs_throw2(e, "copyfile", src, dest);
        return;
      }
      at += wrote;
    }
  }
  close(in);
  if (close(out) != 0) scr_fs_throw2(errno, "copyfile", src, dest);
}

/* renameSync(old, new): rename(2), Node's two-path error shape ("ENOENT:
 * no such file or directory, rename 'a' -> 'b'"). Windows must bypass
 * the CRT's rename(): it refuses an existing destination and cannot move
 * directories between parents, while Node/libuv uses MoveFileExW with
 * MOVEFILE_REPLACE_EXISTING. Runtime strings are UTF-8, so feed the wide
 * Win32 API rather than the active-code-page `A` form. */
#ifdef _WIN32
static WCHAR *scr_fs_win_wide(const ScrStr *path) {
  if (path->len > INT_MAX) {
    SetLastError(ERROR_FILENAME_EXCED_RANGE);
    return NULL;
  }
  int n = path->len > 0
    ? MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS,
                          path->data, (int)path->len, NULL, 0)
    : 0;
  if (path->len > 0 && n == 0) return NULL;
  WCHAR *wide = malloc(((size_t)n + 1) * sizeof *wide);
  if (!wide) {
    SetLastError(ERROR_NOT_ENOUGH_MEMORY);
    return NULL;
  }
  if (n > 0) {
    (void)MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS,
                              path->data, (int)path->len, wide, n);
  }
  wide[n] = L'\0';
  return wide;
}

/* The reachable fs subset of libuv's uv_translate_sys_error table. */
static int scr_fs_win_errno(DWORD error) {
  switch (error) {
  case ERROR_ALREADY_EXISTS:
  case ERROR_FILE_EXISTS:
    return EEXIST;
  case ERROR_LOCK_VIOLATION:
  case ERROR_PIPE_BUSY:
  case ERROR_SHARING_VIOLATION:
    return EBUSY;
  case ERROR_INVALID_FUNCTION:
    return EISDIR;
  case ERROR_INSUFFICIENT_BUFFER:
  case ERROR_INVALID_DATA:
  case ERROR_INVALID_PARAMETER:
    return EINVAL;
  case ERROR_BUFFER_OVERFLOW:
  case ERROR_FILENAME_EXCED_RANGE:
    return ENAMETOOLONG;
  case ERROR_NOT_ENOUGH_MEMORY:
  case ERROR_OUTOFMEMORY:
    return ENOMEM;
  case ERROR_CANNOT_MAKE:
  case ERROR_DISK_FULL:
  case ERROR_HANDLE_DISK_FULL:
    return ENOSPC;
  case ERROR_DIR_NOT_EMPTY:
    return ENOTEMPTY;
  case ERROR_ACCESS_DENIED:
  case ERROR_PRIVILEGE_NOT_HELD:
    return EPERM;
  case ERROR_WRITE_PROTECT:
    return EROFS;
  case ERROR_NOT_SAME_DEVICE:
    return EXDEV;
  case ERROR_BAD_PATHNAME:
  case ERROR_DIRECTORY:
  case ERROR_FILE_NOT_FOUND:
  case ERROR_INVALID_DRIVE:
  case ERROR_INVALID_NAME:
  case ERROR_PATH_NOT_FOUND:
    return ENOENT;
  default:
    return EIO;
  }
}
#endif

int scr_fs_rename_raw(const ScrStr *oldpath, const ScrStr *newpath) {
#ifdef _WIN32
  WCHAR *oldwide = scr_fs_win_wide(oldpath);
  if (!oldwide) return scr_fs_win_errno(GetLastError());
  WCHAR *newwide = scr_fs_win_wide(newpath);
  if (!newwide) {
    DWORD error = GetLastError();
    free(oldwide);
    return scr_fs_win_errno(error);
  }
  BOOL ok = MoveFileExW(oldwide, newwide, MOVEFILE_REPLACE_EXISTING);
  DWORD error = ok ? ERROR_SUCCESS : GetLastError();
  free(oldwide);
  free(newwide);
  return ok ? 0 : scr_fs_win_errno(error);
#else
  return rename(oldpath->data, newpath->data) == 0 ? 0 : errno;
#endif
}

void scr_fs_rename_error(int error, const ScrStr *oldpath, const ScrStr *newpath) {
  scr_fs_throw2(error, "rename", oldpath, newpath);
}

void scr_fs_rename(ScrStr *oldpath, ScrStr *newpath) {
  if (!scr_fs_path_ok(oldpath, "oldPath")) return;
  if (!scr_fs_path_ok(newpath, "newPath")) return;
  int error = scr_fs_rename_raw(oldpath, newpath);
  if (error != 0) scr_fs_rename_error(error, oldpath, newpath);
}

static int scr_rm_unlink(const char *path, size_t len);

/* Node's ERR_FS_EISDIR for rm on a directory without `recursive`. */
static void scr_fs_rm_throw_eisdir(const ScrStr *path) {
  ScrStr *message = scr_str_new("is a directory", 14);
  scr_fs_throw_system_error("ERR_FS_EISDIR", "Path is a directory", EISDIR, "rm", message, path);
  scr_str_release(message);
}

void scr_fs_rm(ScrStr *path) {
  if (!scr_fs_path_ok(path, "path")) return;
#ifdef _WIN32
  int link = scr_fs_win_remove_link(path->data, path->len);
  if (link != 0) { if (link < 0) scr_fs_throw(errno, "unlink", path); return; }
#endif
  /* Node's rmSync: lstat first (a missing path reports the lstat syscall),
   * refuse directories (ERR_FS_EISDIR: removing one requires `recursive`),
   * then unlink. */
  struct stat st;
  if (lstat(path->data, &st) != 0) {
    scr_fs_throw(errno, "lstat", path);
    return;
  }
  if (S_ISDIR(st.st_mode)) {
    scr_fs_rm_throw_eisdir(path);
    return;
  }
  if (scr_rm_unlink(path->data, path->len) != 0) scr_fs_throw(errno, "unlink", path);
}

void scr_fs_rmdir(ScrStr *path) {
  if (!scr_fs_path_ok(path, "path")) return;
  if (rmdir(path->data) != 0) scr_fs_throw(errno, "rmdir", path);
}

/* ── fs option forms ─────────────────────────────────────────────────
 * mkdirSync(p, { recursive: true }), rmSync(p, { recursive, force }),
 * mkdtempSync(prefix), accessSync(p, mode), and the readFileSync(fd)
 * forms — the slice real CLIs use. All throw catchably like the rest of
 * sync fs, with Node's errno/path shapes (verified against Node). */

/* Node's recursive mkdir algorithm: try mkdir; EEXIST is fine iff the
 * path is a directory (a file target throws EEXIST at that path); ENOENT
 * creates the parent first and retries. ENOTDIR past a file reports the
 * FULL requested path, like Node. `path` is a NUL-terminated mutable
 * buffer of `len` bytes. */
/* The path separators the RECURSIVE walk recognizes: win32 targets take
 * both slashes (the path module hands out backslashed paths there);
 * POSIX '/' only — a backslash is an ordinary filename byte. */
static bool scr_fs_sep(char c) {
#ifdef _WIN32
  if (c == '\\') return true;
#endif
  return c == '/';
}

static void scr_mkdir_rec(char *path, size_t len, mode_t mode) {
  if (scr_sys_mkdir(path, mode) == 0) return;
  int e = errno;
  struct stat st;
  if (e == EEXIST) {
    if (stat(path, &st) == 0 && S_ISDIR(st.st_mode)) return;
  } else if (e == ENOENT) {
    /* Parent: trim trailing separators, the last component, then the
     * separator run before it (keep "/" itself). */
    size_t i = len;
    while (i > 0 && scr_fs_sep(path[i - 1])) i--;
    while (i > 0 && !scr_fs_sep(path[i - 1])) i--;
    while (i > 1 && scr_fs_sep(path[i - 1])) i--;
    if (i > 0 && i < len) {
      char saved = path[i];
      path[i] = 0;
#ifdef _WIN32
      /* POSIX mkdir answers ENOTDIR itself when a path component is a
       * FILE; the CRT answers ENOENT for that too. Node on Windows still
       * reports ENOTDIR with the full requested path — recover the
       * distinction from the parent's stat before recursing. */
      if (stat(path, &st) == 0 && !S_ISDIR(st.st_mode)) {
        path[i] = saved;
        ScrStr *full = scr_str_new(path, len);
        scr_fs_throw(ENOTDIR, "mkdir", full);
        scr_str_release(full);
        return;
      }
#endif
      scr_mkdir_rec(path, i, mode);
      path[i] = saved;
      if (scr_exc_pending()) return;
      if (scr_sys_mkdir(path, mode) == 0) return;
      e = errno;
      if (e == EEXIST && stat(path, &st) == 0 && S_ISDIR(st.st_mode)) return;
    }
  }
  ScrStr *p = scr_str_new(path, len);
  scr_fs_throw(e, "mkdir", p);
  scr_str_release(p);
}

void scr_fs_mkdir_recursive(ScrStr *path) {
  if (!scr_fs_path_ok(path, "path")) return;
  char *buf = malloc(path->len + 1);
  if (!buf) {
    scr_trap("scriptc: out of memory\n");
  }
  memcpy(buf, path->data, path->len + 1); /* ScrStr data is NUL-terminated */
  scr_mkdir_rec(buf, path->len, 0777);
  free(buf);
}

/* mkdirSync(p, { recursive: true, mode }): Node passes the mode to every
 * directory the walk creates (existing ones keep theirs). */
void scr_fs_mkdir_recursive_mode(ScrStr *path, double mode) {
  if (!scr_fs_path_ok(path, "path")) return;
  char *buf = malloc(path->len + 1);
  if (!buf) {
    scr_trap("scriptc: out of memory\n");
  }
  memcpy(buf, path->data, path->len + 1);
  scr_mkdir_rec(buf, path->len, (mode_t)mode);
  free(buf);
}

/* mkdir(p, { recursive: true })'s answer, Node's MKDirpSync first path:
 * the first directory its walk creates, or NULL when the path already
 * existed. Node tries mkdir on the path and, on ENOENT, on the path cut
 * before its last separator, repeatedly; the first mkdir that succeeds
 * (its kernel parent exists) is the answer, spelled as cut. Creates the
 * path like scr_fs_mkdir_recursive_mode (the exception pending on
 * failure). */
static bool scr_fs_mkdirp_exists(char *buf, size_t len) {
  char saved = buf[len];
  buf[len] = 0;
  struct stat st;
  int rc = len == 0 ? stat(".", &st) : stat(buf, &st);
  int e = errno;
  buf[len] = saved;
  return rc == 0 || e != ENOENT;
}

ScrStr *scr_fs_mkdir_recursive_first(ScrStr *path, double mode) {
  if (!scr_fs_path_ok(path, "path")) return NULL;
  char *buf = malloc(path->len + 1);
  if (!buf) {
    scr_trap("scriptc: out of memory\n");
  }
  memcpy(buf, path->data, path->len + 1);
  size_t cur = path->len, first = 0;
  while (cur > 0 && !scr_fs_mkdirp_exists(buf, cur)) {
    first = cur;
    /* The kernel's parent: trailing separators dropped, then the last
     * component and the separators before it ("/" stays). */
    size_t k = cur;
    while (k > 1 && scr_fs_sep(buf[k - 1])) k--;
    while (k > 0 && !scr_fs_sep(buf[k - 1])) k--;
    while (k > 1 && scr_fs_sep(buf[k - 1])) k--;
    if (scr_fs_mkdirp_exists(buf, k)) break;
    /* ENOENT: Node retries with the path cut before its last separator. */
    size_t cut = cur;
    while (cut > 0 && !scr_fs_sep(buf[cut - 1])) cut--;
    if (cut == 0) break;
    cur = cut - 1;
  }
  scr_mkdir_rec(buf, path->len, (mode_t)mode);
  free(buf);
  if (scr_exc_pending() || first == 0) return NULL;
  return scr_str_new(path->data, first);
}

/* First failure of an rm walk, recorded instead of thrown so the retry
 * form can decide (retryable errno + attempts left → sleep and go again)
 * before anything reaches the exception cell. `path` is +1 when err != 0;
 * the throwers release it after scr_fs_throw. */
typedef struct {
  int err;
  const char *op;
  ScrStr *path;
} ScrRmFail;

/* Throws the recorded failure and releases its path. */
static void scr_rm_fail_throw(ScrRmFail *f) {
  if (f->err == EISDIR && strcmp(f->op, "rm") == 0) scr_fs_rm_throw_eisdir(f->path);
  else scr_fs_throw(f->err, f->op, f->path);
  scr_str_release(f->path);
}

static void scr_rm_fail_set(ScrRmFail *f, int err, const char *op, const char *path, size_t len) {
  if (f->err != 0) return; /* first failure wins, exactly like the old unwind */
  f->err = err;
  f->op = op;
  f->path = scr_str_new(path, len);
}

static int scr_rm_unlink(const char *path, size_t len) {
  if (unlink(path) == 0) return 0;
#ifdef _WIN32
  /* Node's Windows removal clears a file's read-only attribute before
   * retrying. Private staged runtime objects intentionally use mode 0400. */
  const int original = errno;
  if (original != EACCES && original != EPERM) return -1;
  ScrStr *text = scr_str_new(path, len);
  WCHAR *wide = scr_fs_win_wide(text);
  scr_str_release(text);
  if (!wide) { errno = original; return -1; }
  const DWORD attributes = GetFileAttributesW(wide);
  if (attributes != INVALID_FILE_ATTRIBUTES && (attributes & FILE_ATTRIBUTE_READONLY) &&
      SetFileAttributesW(wide, attributes & ~FILE_ATTRIBUTE_READONLY)) {
    if (DeleteFileW(wide)) { free(wide); return 0; }
    const DWORD error = GetLastError();
    SetFileAttributesW(wide, attributes);
    free(wide);
    errno = scr_fs_win_errno(error);
    return -1;
  }
  free(wide);
  errno = original;
#else
  (void)len;
#endif
  return -1;
}

/* Post-order tree removal for rmSync's recursive form. Stops at (and
 * records) the first failure, with the failing path and syscall name. */
static void scr_rm_tree_e(const char *path, size_t len, ScrRmFail *f) {
#ifdef _WIN32
  int link = scr_fs_win_remove_link(path, len);
  if (link != 0) { if (link < 0) scr_rm_fail_set(f, errno, "unlink", path, len); return; }
#endif
  struct stat st;
  if (lstat(path, &st) != 0) {
    scr_rm_fail_set(f, errno, "lstat", path, len);
    return;
  }
  if (!S_ISDIR(st.st_mode)) {
    if (scr_rm_unlink(path, len) != 0) scr_rm_fail_set(f, errno, "unlink", path, len);
    return;
  }
  DIR *d = opendir(path);
  if (!d) {
    scr_rm_fail_set(f, errno, "scandir", path, len);
    return;
  }
  const struct dirent *ent;
  while ((ent = readdir(d)) != NULL) {
    if (strcmp(ent->d_name, ".") == 0 || strcmp(ent->d_name, "..") == 0) continue;
    size_t namelen = strlen(ent->d_name);
    char *child = malloc(len + 1 + namelen + 1);
    if (!child) {
      scr_trap("scriptc: out of memory\n");
    }
    memcpy(child, path, len);
    child[len] = '/';
    memcpy(child + len + 1, ent->d_name, namelen + 1);
    scr_rm_tree_e(child, len + 1 + namelen, f);
    free(child);
    if (f->err != 0) {
      closedir(d);
      return;
    }
  }
  closedir(d);
  if (rmdir(path) != 0) scr_rm_fail_set(f, errno, "rmdir", path, len);
}

/* One rm attempt (the shared core of both option forms): lstat dispatch,
 * force's ENOENT swallow, the non-recursive directory rejection, and the
 * tree walk — failures recorded in `f`, never thrown. */
static void scr_fs_rm_attempt(ScrStr *path, bool recursive, bool force, ScrRmFail *f) {
#ifdef _WIN32
  int link = scr_fs_win_remove_link(path->data, path->len);
  if (link != 0) { if (link < 0) scr_rm_fail_set(f, errno, "unlink", path->data, path->len); return; }
#endif
  struct stat st;
  if (lstat(path->data, &st) != 0) {
    if (force && errno == ENOENT) return; /* Node: force swallows ENOENT */
    scr_rm_fail_set(f, errno, "lstat", path->data, path->len);
    return;
  }
  if (S_ISDIR(st.st_mode)) {
    if (!recursive) {
      scr_rm_fail_set(f, EISDIR, "rm", path->data, path->len);
      return;
    }
    scr_rm_tree_e(path->data, path->len, f);
    return;
  }
  if (scr_rm_unlink(path->data, path->len) != 0) scr_rm_fail_set(f, errno, "unlink", path->data, path->len);
}

void scr_fs_rm_opts(ScrStr *path, bool recursive, bool force) {
  if (!scr_fs_path_ok(path, "path")) return;
  ScrRmFail f = {0, NULL, NULL};
  scr_fs_rm_attempt(path, recursive, force, &f);
  if (f.err != 0) scr_rm_fail_throw(&f);
}

/* Node's validateRmdirOptions range checks: retryDelay is an int32 >= 0,
 * then maxRetries is a uint32 (ERR_OUT_OF_RANGE). */
bool scr_fs_rm_retry_options_ok(double max_retries, double retry_delay) {
  return scr_bytes_validate_off("options.retryDelay", retry_delay, 2147483647.0) &&
         scr_bytes_validate_off("options.maxRetries", max_retries, 4294967295.0);
}

/* rmSync(p, { recursive, force, maxRetries, retryDelay }): Node retries
 * the operation on EBUSY/EMFILE/ENFILE/ENOTEMPTY/EPERM up to maxRetries
 * times, waiting retryDelay ms LONGER on each try (linear backoff — the
 * fs.rmSync documented semantics). Everything else throws immediately
 * with the failing path, exactly like the plain options form. rmSync
 * validates the options before the path. */
void scr_fs_rm_opts_retry(ScrStr *path, bool recursive, bool force, double max_retries, double retry_delay) {
  if (!scr_fs_rm_retry_options_ok(max_retries, retry_delay)) return;
  if (!scr_fs_path_ok(path, "path")) return;
  long tries = max_retries > 0 ? (long)max_retries : 0;
  double delay_ms = retry_delay > 0 ? retry_delay : 0;
  ScrRmFail f = {0, NULL, NULL};
  for (long attempt = 0;; attempt++) {
    f.err = 0;
    f.op = NULL;
    if (f.path) {
      scr_str_release(f.path);
      f.path = NULL;
    }
    scr_fs_rm_attempt(path, recursive, force, &f);
    if (f.err == 0) return;
    bool retryable = f.err == EBUSY || f.err == EMFILE || f.err == ENFILE ||
                     f.err == ENOTEMPTY || f.err == EPERM;
    if (!retryable || attempt >= tries) break;
    double ms = delay_ms * (double)(attempt + 1);
    if (ms > 0) {
      struct timespec ts;
      ts.tv_sec = (time_t)(ms / 1000.0);
      ts.tv_nsec = (long)((ms - (double)ts.tv_sec * 1000.0) * 1000000.0);
      nanosleep(&ts, NULL);
    }
  }
  scr_rm_fail_throw(&f);
}

#if defined(_WIN32) || defined(__wasi__)
/* No mkdtemp in the Windows CRT or WASI libc: libuv's own fallback shape — six random
 * [a-z0-9] name characters from the CSPRNG, retried on EEXIST. */
static char *scr_portable_mkdtemp(char *tmpl) {
  static const char cs[] = "abcdefghijklmnopqrstuvwxyz0123456789";
  size_t len = strlen(tmpl);
  for (int tries = 0; tries < 32; tries++) {
    unsigned char r[6];
    arc4random_buf(r, sizeof r);
    for (size_t i = 0; i < 6; i++) tmpl[len - 6 + i] = cs[r[i] % 36];
    if (scr_sys_mkdir(tmpl, 0777) == 0) return tmpl;
    if (errno != EEXIST) break;
  }
  memcpy(tmpl + len - 6, "XXXXXX", 6); /* the error message shows the template */
  return NULL;
}
#define mkdtemp scr_portable_mkdtemp
#endif

/* Node's sync error reports the template, X's included: mkdtemp
 * '/nope/x-XXXXXX'. The callback and promise errors report the request's
 * path, which is the template as mkdtemp(3) left it (glibc leaves the last
 * name it tried; musl restores the X's). */
static ScrStr *scr_fs_mkdtemp_op(ScrStr *prefix, bool sync) {
  if (!scr_fs_path_ok(prefix, "prefix")) return NULL;
  char *tmpl = malloc(prefix->len + 7);
  if (!tmpl) {
    scr_trap("scriptc: out of memory\n");
  }
  memcpy(tmpl, prefix->data, prefix->len);
  memcpy(tmpl + prefix->len, "XXXXXX", 7);
  if (!mkdtemp(tmpl)) {
    int e = errno;
    if (sync) memcpy(tmpl + prefix->len, "XXXXXX", 6);
    ScrStr *shown = scr_str_new(tmpl, prefix->len + 6);
    scr_fs_throw(e, "mkdtemp", shown);
    scr_str_release(shown);
    free(tmpl);
    return NULL;
  }
  ScrStr *out = scr_str_new(tmpl, prefix->len + 6);
  free(tmpl);
  return out;
}

ScrStr *scr_fs_mkdtemp(ScrStr *prefix) { return scr_fs_mkdtemp_op(prefix, true); }
ScrStr *scr_fs_mkdtemp_async(ScrStr *prefix) { return scr_fs_mkdtemp_op(prefix, false); }

/* Node's GetValidFileMode for access(): a finite number whose int32 value
 * lies in F_OK .. R_OK | W_OK | X_OK. False with the RangeError thrown. */
bool scr_fs_access_mode_valid(double mode) {
  static const char not_finite[] = "mode is out of range";
  static const char range[] = "mode is out of range: >= 0 && <= 7";
  if (!isfinite(mode)) {
    scr_throw_error_msg_code(SCR_ERR_RANGE, not_finite, sizeof not_finite - 1, "ERR_OUT_OF_RANGE");
    return false;
  }
  int32_t m = (int32_t)scr_to_uint32(mode);
  if (m >= 0 && m <= 7) return true;
  scr_throw_error_msg_code(SCR_ERR_RANGE, range, sizeof range - 1, "ERR_OUT_OF_RANGE");
  return false;
}

void scr_fs_access(ScrStr *path, double mode) {
  if (!scr_fs_path_ok(path, "path")) return;
  if (!scr_fs_access_mode_valid(mode)) return;
  int m = (int32_t)scr_to_uint32(mode);
#ifdef _WIN32
  /* The CRT access() rejects X_OK (there is no execute bit); Node on
   * Windows treats X_OK as F_OK, so mask it down to the R/W bits. */
  m &= 6;
#endif
  if (access(path->data, m) != 0) scr_fs_throw(errno, "access", path);
}

/* The no-path variant of the fs error shape — Node's fd reads report
 * "EBADF: bad file descriptor, read" with no quoted path. */
static void scr_fs_throw_nopath(int e, const char *op) {
  char namebuf[16];
  const char *name = scr_errno_name(e, namebuf, sizeof namebuf);
  const char *text = scr_errno_text(e);
  char msg[256];
  int len = snprintf(msg, sizeof msg, "%s: %s, %s", name, text, op);
  scr_fs_throw_details(e, name, msg, (size_t)len, op, NULL, NULL);
}

ScrStr *scr_fs_read_fd(double fd) {
  ScrFileRead out;
  int error = scr_file_read_all(NULL, (int)fd, true, &out);
  if (error) { scr_fs_throw_nopath(error, "read"); return NULL; }
  return scr_str_adopt_utf8_lossy(out.text, out.ascii);
}

ScrBytes *scr_fs_read_fd_bytes(double fd) {
  ScrFileRead out;
  int error = scr_file_read_all(NULL, (int)fd, false, &out);
  if (error) { scr_fs_throw_nopath(error, "read"); return NULL; }
  return scr_bytes_take_data(out.bytes, out.len);
}

/* ── the tty probes ──────────────────────────────────────────────────── */

bool scr_process_is_tty(double fd) {
  if (!isfinite(fd) || fd < 0 || fd > INT_MAX || trunc(fd) != fd) return false;
  return isatty((int)fd) != 0;
}

/* Terminal geometry for process.stdout/stderr.columns/rows: ioctl(TIOCGWINSZ) on
 * the stream's fd, exactly Node's tty.WriteStream source of truth. A
 * non-TTY stream, or a terminal that refuses the ioctl, answers -1 and
 * the emitter's union construction turns that into the undefined arm —
 * Node's missing geometry on non-TTY streams. */
static double scr_process_dimension(double fd, bool rows) {
  if (!isatty((int)fd)) return -1;
#ifdef _WIN32
  /* The console buffer's visible window — libuv's uv_tty_get_winsize. */
  HANDLE h = (HANDLE)_get_osfhandle((int)fd);
  CONSOLE_SCREEN_BUFFER_INFO info;
  if (h == INVALID_HANDLE_VALUE || !GetConsoleScreenBufferInfo(h, &info)) return -1;
  return rows ? (double)(info.srWindow.Bottom - info.srWindow.Top + 1)
              : (double)(info.srWindow.Right - info.srWindow.Left + 1);
#elif defined(__wasi__)
  (void)rows;
  return -1;
#else
  struct winsize ws;
  if (ioctl((int)fd, TIOCGWINSZ, &ws) != 0) return -1;
  return rows ? (double)ws.ws_row : (double)ws.ws_col;
#endif
}

double scr_process_columns(double fd) { return scr_process_dimension(fd, false); }
double scr_process_rows(double fd) { return scr_process_dimension(fd, true); }

/* process.stdin.setRawMode(mode). TTY stdin: libuv's UV_TTY_MODE_RAW
 * termios flag set — exactly what Node's setRawMode(true) applies — and
 * setRawMode(false) restores the termios saved at the first raw entry
 * (libuv's orig_termios), a no-op when raw mode was never entered.
 * NON-TTY stdin: Node's process.stdin is a Socket with no setRawMode
 * member at all, so the call throws Node's exact catchable TypeError. */
#ifdef _WIN32
static SCR_TL DWORD scr_stdin_cooked;
static SCR_TL bool scr_stdin_cooked_saved = false;

void scr_process_stdin_set_raw_mode(bool raw) {
  if (!isatty(0)) {
    const char msg[] = "process.stdin.setRawMode is not a function";
    scr_throw_error_msg(SCR_ERR_TYPE, msg, sizeof msg - 1);
    return;
  }
  /* libuv's uv_tty_set_mode(UV_TTY_MODE_RAW) console half: drop line
   * buffering, echo, and Ctrl-C cooking; restore the entry mode on the
   * way back — the termios save/restore shape, translated. */
  HANDLE h = (HANDLE)_get_osfhandle(0);
  DWORD mode;
  if (h == INVALID_HANDLE_VALUE || !GetConsoleMode(h, &mode)) return;
  if (raw) {
    if (!scr_stdin_cooked_saved) {
      scr_stdin_cooked = mode;
      scr_stdin_cooked_saved = true;
    }
    mode &= ~(DWORD)(ENABLE_LINE_INPUT | ENABLE_ECHO_INPUT | ENABLE_PROCESSED_INPUT);
    (void)SetConsoleMode(h, mode);
  } else if (scr_stdin_cooked_saved) {
    (void)SetConsoleMode(h, scr_stdin_cooked);
  }
}
#elif defined(__wasi__)
void scr_process_stdin_set_raw_mode(bool raw) {
  (void)raw;
  const char msg[] = "process.stdin.setRawMode is not a function";
  scr_throw_error_msg(SCR_ERR_TYPE, msg, sizeof msg - 1);
}
#else
static SCR_TL struct termios scr_stdin_cooked;
static SCR_TL bool scr_stdin_cooked_saved = false;

void scr_process_stdin_set_raw_mode(bool raw) {
  if (!isatty(0)) {
    const char msg[] = "process.stdin.setRawMode is not a function";
    scr_throw_error_msg(SCR_ERR_TYPE, msg, sizeof msg - 1);
    return;
  }
  if (raw) {
    struct termios t;
    if (tcgetattr(0, &t) != 0) return;
    if (!scr_stdin_cooked_saved) {
      scr_stdin_cooked = t;
      scr_stdin_cooked_saved = true;
    }
    /* libuv uv__tty_make_raw (UV_TTY_MODE_RAW) */
    t.c_iflag &= (tcflag_t)~(BRKINT | ICRNL | INPCK | ISTRIP | IXON);
    t.c_oflag |= (tcflag_t)ONLCR;
    t.c_cflag |= (tcflag_t)CS8;
    t.c_lflag &= (tcflag_t)~(ECHO | ICANON | IEXTEN | ISIG);
    t.c_cc[VMIN] = 1;
    t.c_cc[VTIME] = 0;
    (void)tcsetattr(0, TCSADRAIN, &t);
  } else if (scr_stdin_cooked_saved) {
    (void)tcsetattr(0, TCSADRAIN, &scr_stdin_cooked);
  }
}
#endif /* _WIN32 */

/* Node's destroy() tears down the stream: the events unit (scr_events.c)
 * drops every stdin listener, stops watching fd 0, and ends a running
 * for-await — nothing fires after, and the loop stops keeping the
 * process alive for stdin. With the events unit not linked there is
 * nothing to tear down and the call is a no-op, as before. */
void scr_process_stdin_destroy(void) {
  if (scr_stdin_destroy_hook != NULL) scr_stdin_destroy_hook();
}

/* ── Stats values ────────────────────────────────────────────────────
 * An immutable snapshot of one stat(2) result: libuv's integers and its four
 * timestamps. statSync THROWS like the other sync fs calls; the promise form
 * rejects (see the fsp section). scr_stats_dyn builds Node's Stats and
 * BigIntStats objects from the same snapshot. */

/* The integers in the order Node's binding reports them. */
enum {
  SCR_STATS_DEV,
  SCR_STATS_MODE,
  SCR_STATS_NLINK,
  SCR_STATS_UID,
  SCR_STATS_GID,
  SCR_STATS_RDEV,
  SCR_STATS_BLKSIZE,
  SCR_STATS_INO,
  SCR_STATS_SIZE,
  SCR_STATS_BLOCKS,
  SCR_STATS_FIELDS
};

/* The timestamps, each kept as seconds + nanoseconds. */
enum { SCR_STATS_ATIME, SCR_STATS_MTIME, SCR_STATS_CTIME, SCR_STATS_BIRTHTIME };

struct ScrStats {
  size_t rc;
  bool is_file;
  bool is_dir;
  bool is_symlink; /* lstat only — a followed stat never sees one */
  uint64_t fields[SCR_STATS_FIELDS]; /* blocks counts 512-byte units */
  int64_t sec[4];
  int64_t nsec[4];
};

ScrStats *scr_stats_retain(ScrStats *s) {
  if (s->rc != SIZE_MAX) s->rc++;
  return s;
}

void scr_stats_release(ScrStats *s) {
  if (!s || s->rc == SIZE_MAX) return;
  if (--s->rc == 0) scr_mem_free(s);
}

void *scr_stats_retain_v(void *p) { return scr_stats_retain(p); }
void scr_stats_release_v(void *p) { scr_stats_release(p); }

/* The S_IFMT type bits, spelled out because Windows lacks some macros. */
#define SCR_STATS_IFMT 0xF000u
#define SCR_STATS_IFIFO 0x1000u
#define SCR_STATS_IFCHR 0x2000u
#define SCR_STATS_IFDIR 0x4000u
#define SCR_STATS_IFBLK 0x6000u
#define SCR_STATS_IFREG 0x8000u
#define SCR_STATS_IFLNK 0xA000u
#define SCR_STATS_IFSOCK 0xC000u

static bool scr_stats_type_is(const ScrStats *s, unsigned type) {
#ifdef _WIN32
  /* Node answers false for the types Windows does not have. */
  if (type == SCR_STATS_IFIFO || type == SCR_STATS_IFBLK || type == SCR_STATS_IFSOCK) return false;
#endif
  return (s->fields[SCR_STATS_MODE] & SCR_STATS_IFMT) == type;
}

bool scr_stats_is_file(ScrStats *s) { return s->is_file; }
bool scr_stats_is_dir(ScrStats *s) { return s->is_dir; }
bool scr_stats_is_symlink(ScrStats *s) { return s->is_symlink; }
bool scr_stats_is_block_device(ScrStats *s) { return scr_stats_type_is(s, SCR_STATS_IFBLK); }
bool scr_stats_is_character_device(ScrStats *s) { return scr_stats_type_is(s, SCR_STATS_IFCHR); }
bool scr_stats_is_fifo(ScrStats *s) { return scr_stats_type_is(s, SCR_STATS_IFIFO); }
bool scr_stats_is_socket(ScrStats *s) { return scr_stats_type_is(s, SCR_STATS_IFSOCK); }
double scr_stats_dev(ScrStats *s) { return (double)s->fields[SCR_STATS_DEV]; }
double scr_stats_mode(ScrStats *s) { return (double)s->fields[SCR_STATS_MODE]; }
double scr_stats_nlink(ScrStats *s) { return (double)s->fields[SCR_STATS_NLINK]; }
double scr_stats_uid(ScrStats *s) { return (double)s->fields[SCR_STATS_UID]; }
double scr_stats_gid(ScrStats *s) { return (double)s->fields[SCR_STATS_GID]; }
double scr_stats_rdev(ScrStats *s) { return (double)s->fields[SCR_STATS_RDEV]; }
double scr_stats_blksize(ScrStats *s) { return (double)s->fields[SCR_STATS_BLKSIZE]; }
double scr_stats_ino(ScrStats *s) { return (double)s->fields[SCR_STATS_INO]; }
double scr_stats_size(ScrStats *s) { return (double)s->fields[SCR_STATS_SIZE]; }
double scr_stats_blocks(ScrStats *s) { return (double)s->fields[SCR_STATS_BLOCKS]; }

/* Node's msFromTimeSpec: seconds * 1000 + nanoseconds / 1e6. */
static double scr_stats_ms(const ScrStats *s, int which) {
  return (double)s->sec[which] * 1000.0 + (double)s->nsec[which] / 1e6;
}

double scr_stats_atime_ms(ScrStats *s) { return scr_stats_ms(s, SCR_STATS_ATIME); }
double scr_stats_mtime_ms(ScrStats *s) { return scr_stats_ms(s, SCR_STATS_MTIME); }
double scr_stats_ctime_ms(ScrStats *s) { return scr_stats_ms(s, SCR_STATS_CTIME); }
double scr_stats_birthtime_ms(ScrStats *s) { return scr_stats_ms(s, SCR_STATS_BIRTHTIME); }

/* Math.round: the nearest integer, halves toward +Infinity. */
static double scr_stats_round(double ms) {
  double low = floor(ms);
  return ms - low >= 0.5 ? low + 1 : low;
}

/* The Date fields: Node rounds the millisecond value before new Date(). */
double scr_stats_atime(ScrStats *s) { return scr_date_new_ms(scr_stats_round(scr_stats_ms(s, SCR_STATS_ATIME))); }
double scr_stats_mtime(ScrStats *s) { return scr_date_new_ms(scr_stats_round(scr_stats_ms(s, SCR_STATS_MTIME))); }
double scr_stats_ctime(ScrStats *s) { return scr_date_new_ms(scr_stats_round(scr_stats_ms(s, SCR_STATS_CTIME))); }
double scr_stats_birthtime(ScrStats *s) { return scr_date_new_ms(scr_stats_round(scr_stats_ms(s, SCR_STATS_BIRTHTIME))); }

/* Small-object blocks: a stat-and-test loop recycles one block instead of
 * calling the system allocator per call. */
static ScrStats *scr_stats_new(void) {
  ScrStats *s = scr_mem_calloc(sizeof(ScrStats));
  if (!s) {
    scr_trap("scriptc: out of memory\n");
  }
  s->rc = 1;
  return s;
}

static void scr_stats_set_time(ScrStats *s, int which, int64_t sec, int64_t nsec) {
  s->sec[which] = sec;
  s->nsec[which] = nsec;
}

#ifdef _WIN32
static void scr_stats_set_filetime(ScrStats *s, int which, FILETIME ft) {
  scr_filetime_timespec(ft, &s->sec[which], &s->nsec[which]);
}

/* libuv's Windows mode: the entry type plus read for everyone, and write
 * unless the entry is read-only. */
static uint64_t scr_stats_win_mode(unsigned type, bool read_only) {
  return type | (read_only ? 0444u : 0666u);
}

/* The CRT fallback is deliberately complete: callers either get every field
 * from this one stat() result or every field from one Win32 handle below,
 * never a snapshot spliced across two path resolutions. */
static ScrStats *scr_stats_of_crt(const struct stat *st) {
  ScrStats *s = scr_stats_new();
  s->is_file = S_ISREG(st->st_mode);
  s->is_dir = S_ISDIR(st->st_mode);
  s->is_symlink = false;
  s->fields[SCR_STATS_DEV] = (uint64_t)st->st_dev;
  /* Character devices and pipes carry only their type bits in libuv. */
  unsigned type = (unsigned)st->st_mode & SCR_STATS_IFMT;
  s->fields[SCR_STATS_MODE] = type == SCR_STATS_IFREG || type == SCR_STATS_IFDIR
    ? scr_stats_win_mode(type, !(st->st_mode & 0200))
    : type;
  s->fields[SCR_STATS_NLINK] = (uint64_t)st->st_nlink;
  s->fields[SCR_STATS_BLKSIZE] = 4096;
  s->fields[SCR_STATS_INO] = (uint64_t)st->st_ino;
  s->fields[SCR_STATS_SIZE] = st->st_size <= 0 ? 0 : (uint64_t)st->st_size;
  s->fields[SCR_STATS_BLOCKS] = st->st_size <= 0 ? 0 : ((uint64_t)st->st_size + 511) >> 9;
  scr_stats_set_time(s, SCR_STATS_ATIME, (int64_t)st->st_atime, 0);
  scr_stats_set_time(s, SCR_STATS_MTIME, (int64_t)st->st_mtime, 0);
  /* The CRT's st_ctime is the creation time. */
  scr_stats_set_time(s, SCR_STATS_CTIME, (int64_t)st->st_ctime, 0);
  scr_stats_set_time(s, SCR_STATS_BIRTHTIME, (int64_t)st->st_ctime, 0);
  return s;
}

static ScrStats *scr_stats_crt_fallback(const ScrStr *path, const char *op) {
  struct stat st;
  if (stat(path->data, &st) != 0) {
    scr_fs_throw(errno, op, path);
    return NULL;
  }
  return scr_stats_of_crt(&st);
}

/* Resolve ordinary disk paths once and populate every public field from the
 * resulting handle. Splitting size/type across CRT stat() and a later
 * CreateFile call can mix two entries when another process replaces path. */
static bool scr_stats_is_link_tag(DWORD tag) {
  return tag == IO_REPARSE_TAG_SYMLINK ||
         tag == IO_REPARSE_TAG_MOUNT_POINT ||
         tag == IO_REPARSE_TAG_APPEXECLINK ||
         tag == UINT32_C(0xA000001D); /* IO_REPARSE_TAG_LX_SYMLINK */
}

static double scr_stats_utf16_len(const WCHAR *text, size_t len) {
  if (len == 0) return 0;
  if (len > INT_MAX) return -1;
  int bytes = WideCharToMultiByte(
    CP_UTF8, 0, text, (int)len, NULL, 0, NULL, NULL);
  return bytes > 0 ? (double)bytes : -1;
}

typedef struct {
  ULONG tag;
  USHORT data_len;
  USHORT reserved;
  union {
    struct {
      USHORT substitute_offset;
      USHORT substitute_len;
      USHORT print_offset;
      USHORT print_len;
      ULONG flags;
      WCHAR path[1];
    } symlink;
    struct {
      USHORT substitute_offset;
      USHORT substitute_len;
      USHORT print_offset;
      USHORT print_len;
      WCHAR path[1];
    } mount;
    struct {
      unsigned char bytes[1];
    } generic;
  } body;
} ScrStatsReparseData;

/* Node/libuv reports a Windows link's target-text length as st_size. The
 * ordinary handle information does not carry that value, so read the reparse
 * payload while the no-follow handle is live. */
static bool scr_stats_link_target(HANDLE h, DWORD tag, double *size_out, ScrStr **text_out) {
  union {
    ScrStatsReparseData align;
    unsigned char bytes[MAXIMUM_REPARSE_DATA_BUFFER_SIZE];
  } storage;
  DWORD used;
  if (!DeviceIoControl(h, FSCTL_GET_REPARSE_POINT, NULL, 0,
                       storage.bytes, sizeof storage.bytes, &used, NULL)) return false;
  ScrStatsReparseData *data = (ScrStatsReparseData *)storage.bytes;
  const size_t body_offset = offsetof(ScrStatsReparseData, body);
  if (used < body_offset || data->data_len > used - body_offset ||
      data->tag != tag) return false;

  const WCHAR *target;
  size_t len;
  if (tag == IO_REPARSE_TAG_SYMLINK) {
    const size_t fixed = offsetof(ScrStatsReparseData, body.symlink.path) -
      body_offset;
    size_t offset = data->body.symlink.substitute_offset;
    size_t bytes = data->body.symlink.substitute_len;
    if (data->data_len < fixed || ((offset | bytes) & 1) != 0 ||
        offset > data->data_len - fixed ||
        bytes > data->data_len - fixed - offset) return false;
    target = (const WCHAR *)((const unsigned char *)data->body.symlink.path +
      offset);
    len = bytes / sizeof(WCHAR);
  } else if (tag == IO_REPARSE_TAG_MOUNT_POINT) {
    const size_t fixed = offsetof(ScrStatsReparseData, body.mount.path) -
      body_offset;
    size_t offset = data->body.mount.substitute_offset;
    size_t bytes = data->body.mount.substitute_len;
    if (data->data_len < fixed || ((offset | bytes) & 1) != 0 ||
        offset > data->data_len - fixed ||
        bytes > data->data_len - fixed - offset) return false;
    target = (const WCHAR *)((const unsigned char *)data->body.mount.path +
      offset);
    len = bytes / sizeof(WCHAR);
    _Static_assert(sizeof(WCHAR) == sizeof(uint16_t),
                   "Windows reparse payloads use UTF-16 code units");
    if (!scr_win_stats_mount_target_is_junction(
          (const uint16_t *)target, len)) return false;
  } else if (tag == UINT32_C(0xA000001D)) {
    /* WSL's LX symlink payload is a version word followed by UTF-8 bytes. */
    if (data->data_len < sizeof(ULONG)) return false;
    *size_out = (double)(data->data_len - sizeof(ULONG));
    if (text_out) *text_out = scr_str_new((const char *)data->body.generic.bytes + sizeof(ULONG), data->data_len - sizeof(ULONG));
    return true;
  } else {
    /* App execution links carry a counted UTF-16 string list; the third
     * string is the target path. */
    if (tag != IO_REPARSE_TAG_APPEXECLINK ||
        data->data_len < sizeof(ULONG)) return false;
    const unsigned char *raw = data->body.generic.bytes;
    ULONG count;
    memcpy(&count, raw, sizeof count);
    if (count < 3 || ((data->data_len - sizeof count) & 1) != 0) return false;
    target = (const WCHAR *)(raw + sizeof count);
    size_t chars = (data->data_len - sizeof count) / sizeof(WCHAR);
    for (size_t item = 0; item < 2; item++) {
      size_t part = 0;
      while (part < chars && target[part] != L'\0') part++;
      if (part == 0 || part == chars) return false;
      target += part + 1;
      chars -= part + 1;
    }
    len = 0;
    while (len < chars && target[len] != L'\0') len++;
    if (len == 0 || len == chars || len < 3 ||
        !((target[0] >= L'A' && target[0] <= L'Z') ||
          (target[0] >= L'a' && target[0] <= L'z')) ||
        target[1] != L':' || target[2] != L'\\') return false;
    double size = scr_stats_utf16_len(target, len);
    if (size < 0) return false;
    *size_out = size;
    if (text_out) {
      *text_out = scr_fs_win_utf8(target, len);
      if (!*text_out) return false;
    }
    return true;
  }

  /* Undo the NT namespace prefix CreateSymbolicLinkW stores for absolute
   * DOS/UNC targets, matching libuv's readlink normalization. */
  if (len >= 4 && target[0] == L'\\' && target[1] == L'?' &&
      target[2] == L'?' && target[3] == L'\\') {
    if (len >= 6 && target[5] == L':' &&
        ((target[4] >= L'A' && target[4] <= L'Z') ||
         (target[4] >= L'a' && target[4] <= L'z')) &&
        (len == 6 || target[6] == L'\\')) {
      target += 4;
      len -= 4;
    } else if (len >= 8 &&
               (target[4] == L'U' || target[4] == L'u') &&
               (target[5] == L'N' || target[5] == L'n') &&
               (target[6] == L'C' || target[6] == L'c') &&
               target[7] == L'\\') {
      target += 6;
      len -= 6;
    }
  }
  double size = scr_stats_utf16_len(target, len);
  if (size < 0) return false;
  *size_out = size;
  if (text_out) {
    *text_out = scr_fs_win_utf8(target, len);
    if (!*text_out) return false;
  }
  return true;
}

static ScrStats *scr_stats_of_path(const ScrStr *path, const char *op,
                                   bool no_follow) {
  WCHAR *wide = scr_fs_win_wide(path);
  if (!wide) return scr_stats_crt_fallback(path, op);

  DWORD flags = FILE_FLAG_BACKUP_SEMANTICS;
  if (no_follow) flags |= FILE_FLAG_OPEN_REPARSE_POINT;
  HANDLE h = CreateFileW(wide, FILE_READ_ATTRIBUTES,
                         FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                         NULL, OPEN_EXISTING, flags, NULL);
  if (h == INVALID_HANDLE_VALUE) {
    DWORD error = GetLastError();
    DWORD attributes = GetFileAttributesW(wide);
    free(wide);
    /* CRT stat can report the link entry when its target cannot be opened,
     * hiding dangling links and Windows file/directory type mismatches.
     * libuv preserves the failed follow operation for reparse points. */
    if (!no_follow && attributes != INVALID_FILE_ATTRIBUTES &&
        (attributes & FILE_ATTRIBUTE_REPARSE_POINT)) {
      scr_fs_throw(scr_fs_win_errno(error), op, path);
      return NULL;
    }
    return scr_stats_crt_fallback(path, op);
  }
  free(wide);

  DWORD file_type = GetFileType(h);
  if (file_type != FILE_TYPE_DISK) {
    CloseHandle(h);
    return scr_stats_crt_fallback(path, op);
  }
  BY_HANDLE_FILE_INFORMATION basic;
  if (!GetFileInformationByHandle(h, &basic)) {
    CloseHandle(h);
    return scr_stats_crt_fallback(path, op);
  }
  bool is_link = false;
  double link_size = -1;
  if (no_follow && (basic.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT)) {
    FILE_ATTRIBUTE_TAG_INFO tagged;
    if (!GetFileInformationByHandleEx(
          h, FileAttributeTagInfo, &tagged, sizeof tagged) ||
        !scr_stats_is_link_tag(tagged.ReparseTag)) {
      /* Reparse points are a general interception mechanism. Node/libuv
       * follows non-link tags even for lstat, so reopen the resolved target. */
      CloseHandle(h);
      return scr_stats_of_path(path, op, false);
    }
    if (!scr_stats_link_target(h, tagged.ReparseTag, &link_size, NULL)) {
      /* A mount-point tag may name a mounted volume rather than a junction.
       * libuv treats those (and malformed/unsupported link payloads) as
       * ordinary reparse points and retries with the final component
       * followed. Do not classify from the tag alone. */
      CloseHandle(h);
      return scr_stats_of_path(path, op, false);
    }
    is_link = true;
  }
  FILE_STANDARD_INFO standard;
  bool have_standard = GetFileInformationByHandleEx(
    h, FileStandardInfo, &standard, sizeof standard);
  FILE_BASIC_INFO times;
  bool have_times = GetFileInformationByHandleEx(
    h, FileBasicInfo, &times, sizeof times);
  CloseHandle(h);

  bool is_dir = (basic.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
  uint64_t size = ((uint64_t)basic.nFileSizeHigh << 32) | basic.nFileSizeLow;
  ScrStats *s = scr_stats_new();
  s->is_file = !is_link && (have_standard ? !standard.Directory : !is_dir);
  s->is_dir = !is_link && (have_standard ? standard.Directory : is_dir);
  s->is_symlink = is_link;
  s->fields[SCR_STATS_DEV] = basic.dwVolumeSerialNumber;
  s->fields[SCR_STATS_MODE] = scr_stats_win_mode(
    is_link ? SCR_STATS_IFLNK : s->is_dir ? SCR_STATS_IFDIR : SCR_STATS_IFREG,
    (basic.dwFileAttributes & FILE_ATTRIBUTE_READONLY) != 0);
  s->fields[SCR_STATS_NLINK] = have_standard ? standard.NumberOfLinks : basic.nNumberOfLinks;
  s->fields[SCR_STATS_BLKSIZE] = 4096;
  s->fields[SCR_STATS_INO] = ((uint64_t)basic.nFileIndexHigh << 32) | basic.nFileIndexLow;
  s->fields[SCR_STATS_SIZE] = is_link && link_size >= 0 ? (uint64_t)link_size : s->is_dir ? 0
    : have_standard ? (uint64_t)standard.EndOfFile.QuadPart : size;
  s->fields[SCR_STATS_BLOCKS] = have_standard
    ? (uint64_t)standard.AllocationSize.QuadPart >> 9
    : size == 0 ? 0 : (size + 511) >> 9;
  scr_stats_set_filetime(s, SCR_STATS_ATIME, basic.ftLastAccessTime);
  scr_stats_set_filetime(s, SCR_STATS_MTIME, basic.ftLastWriteTime);
  scr_stats_set_filetime(s, SCR_STATS_BIRTHTIME, basic.ftCreationTime);
  if (have_times) {
    FILETIME changed;
    changed.dwLowDateTime = times.ChangeTime.LowPart;
    changed.dwHighDateTime = times.ChangeTime.HighPart;
    scr_stats_set_filetime(s, SCR_STATS_CTIME, changed);
  } else {
    scr_stats_set_time(s, SCR_STATS_CTIME, s->sec[SCR_STATS_MTIME], s->nsec[SCR_STATS_MTIME]);
  }
  return s;
}

/* An open descriptor: the CRT snapshot, completed from the Win32 handle the
 * way libuv's fstat reads it. */
static ScrStats *scr_stats_of_fd_win(int fd, const struct stat *st) {
  ScrStats *out = scr_stats_of_crt(st);
  HANDLE os_handle = (HANDLE)_get_osfhandle(fd);
  if (os_handle == INVALID_HANDLE_VALUE) return out;
  BY_HANDLE_FILE_INFORMATION basic;
  if (GetFileInformationByHandle(os_handle, &basic)) {
    out->fields[SCR_STATS_DEV] = basic.dwVolumeSerialNumber;
    out->fields[SCR_STATS_INO] = ((uint64_t)basic.nFileIndexHigh << 32) | basic.nFileIndexLow;
    out->fields[SCR_STATS_NLINK] = basic.nNumberOfLinks;
    out->fields[SCR_STATS_MODE] = scr_stats_win_mode(
      out->is_dir ? SCR_STATS_IFDIR : SCR_STATS_IFREG,
      (basic.dwFileAttributes & FILE_ATTRIBUTE_READONLY) != 0);
    scr_stats_set_filetime(out, SCR_STATS_ATIME, basic.ftLastAccessTime);
    scr_stats_set_filetime(out, SCR_STATS_MTIME, basic.ftLastWriteTime);
    scr_stats_set_filetime(out, SCR_STATS_BIRTHTIME, basic.ftCreationTime);
  }
  FILE_BASIC_INFO times;
  if (GetFileInformationByHandleEx(os_handle, FileBasicInfo, &times, sizeof times)) {
    FILETIME changed;
    changed.dwLowDateTime = times.ChangeTime.LowPart;
    changed.dwHighDateTime = times.ChangeTime.HighPart;
    scr_stats_set_filetime(out, SCR_STATS_CTIME, changed);
  }
  FILE_STANDARD_INFO standard;
  if (GetFileInformationByHandleEx(os_handle, FileStandardInfo, &standard, sizeof standard)) {
    out->fields[SCR_STATS_BLOCKS] = (uint64_t)standard.AllocationSize.QuadPart >> 9;
    out->fields[SCR_STATS_NLINK] = standard.NumberOfLinks;
  }
  return out;
}
#else
/* libuv's uv__to_stat: macOS, FreeBSD and NetBSD report a creation time;
 * elsewhere birthtime repeats the change time. */
static ScrStats *scr_stats_of(const struct stat *st) {
  ScrStats *s = scr_stats_new();
  s->is_file = S_ISREG(st->st_mode);
  s->is_dir = S_ISDIR(st->st_mode);
  s->is_symlink = S_ISLNK(st->st_mode);
  s->fields[SCR_STATS_DEV] = (uint64_t)st->st_dev;
  s->fields[SCR_STATS_MODE] = (uint64_t)st->st_mode;
  s->fields[SCR_STATS_NLINK] = (uint64_t)st->st_nlink;
  s->fields[SCR_STATS_UID] = (uint64_t)st->st_uid;
  s->fields[SCR_STATS_GID] = (uint64_t)st->st_gid;
  s->fields[SCR_STATS_RDEV] = (uint64_t)st->st_rdev;
  s->fields[SCR_STATS_BLKSIZE] = (uint64_t)st->st_blksize;
  s->fields[SCR_STATS_INO] = (uint64_t)st->st_ino;
  s->fields[SCR_STATS_SIZE] = (uint64_t)st->st_size;
  s->fields[SCR_STATS_BLOCKS] = (uint64_t)st->st_blocks;
#if defined(__APPLE__)
  scr_stats_set_time(s, SCR_STATS_ATIME, st->st_atimespec.tv_sec, st->st_atimespec.tv_nsec);
  scr_stats_set_time(s, SCR_STATS_MTIME, st->st_mtimespec.tv_sec, st->st_mtimespec.tv_nsec);
  scr_stats_set_time(s, SCR_STATS_CTIME, st->st_ctimespec.tv_sec, st->st_ctimespec.tv_nsec);
  scr_stats_set_time(s, SCR_STATS_BIRTHTIME, st->st_birthtimespec.tv_sec, st->st_birthtimespec.tv_nsec);
#else
  scr_stats_set_time(s, SCR_STATS_ATIME, st->st_atim.tv_sec, st->st_atim.tv_nsec);
  scr_stats_set_time(s, SCR_STATS_MTIME, st->st_mtim.tv_sec, st->st_mtim.tv_nsec);
  scr_stats_set_time(s, SCR_STATS_CTIME, st->st_ctim.tv_sec, st->st_ctim.tv_nsec);
#if defined(__FreeBSD__) || defined(__NetBSD__)
  scr_stats_set_time(s, SCR_STATS_BIRTHTIME, st->st_birthtim.tv_sec, st->st_birthtim.tv_nsec);
#else
  scr_stats_set_time(s, SCR_STATS_BIRTHTIME, st->st_ctim.tv_sec, st->st_ctim.tv_nsec);
#endif
#endif
  return s;
}

#if defined(__linux__) && defined(SYS_statx)
/* The kernel's struct statx (include/uapi/linux/stat.h). libuv reads stat
 * results through statx, which also reports the creation time. */
typedef struct {
  int64_t tv_sec;
  uint32_t tv_nsec;
  int32_t reserved;
} ScrStatxTime;

typedef struct {
  uint32_t mask;
  uint32_t blksize;
  uint64_t attributes;
  uint32_t nlink;
  uint32_t uid;
  uint32_t gid;
  uint16_t mode;
  uint16_t spare0;
  uint64_t ino;
  uint64_t size;
  uint64_t blocks;
  uint64_t attributes_mask;
  ScrStatxTime atime, btime, ctime, mtime;
  uint32_t rdev_major, rdev_minor;
  uint32_t dev_major, dev_minor;
  uint64_t spare[14];
} ScrStatx;

_Static_assert(sizeof(ScrStatx) == 256, "struct statx is 256 bytes");

/* glibc's and musl's makedev encoding, which libuv applies to statx. */
static uint64_t scr_stats_makedev(uint64_t major, uint64_t minor) {
  return ((major & 0xfffff000u) << 32) | ((major & 0xfffu) << 8) |
         ((minor & 0xffffff00u) << 12) | (minor & 0xffu);
}

static SCR_TL bool scr_stats_no_statx = false;

static ScrStats *scr_stats_of_statx(const ScrStatx *sx) {
  ScrStats *s = scr_stats_new();
  unsigned type = sx->mode & SCR_STATS_IFMT;
  s->is_file = type == SCR_STATS_IFREG;
  s->is_dir = type == SCR_STATS_IFDIR;
  s->is_symlink = type == SCR_STATS_IFLNK;
  s->fields[SCR_STATS_DEV] = scr_stats_makedev(sx->dev_major, sx->dev_minor);
  s->fields[SCR_STATS_MODE] = sx->mode;
  s->fields[SCR_STATS_NLINK] = sx->nlink;
  s->fields[SCR_STATS_UID] = sx->uid;
  s->fields[SCR_STATS_GID] = sx->gid;
  s->fields[SCR_STATS_RDEV] = scr_stats_makedev(sx->rdev_major, sx->rdev_minor);
  s->fields[SCR_STATS_BLKSIZE] = sx->blksize;
  s->fields[SCR_STATS_INO] = sx->ino;
  s->fields[SCR_STATS_SIZE] = sx->size;
  s->fields[SCR_STATS_BLOCKS] = sx->blocks;
  scr_stats_set_time(s, SCR_STATS_ATIME, sx->atime.tv_sec, sx->atime.tv_nsec);
  scr_stats_set_time(s, SCR_STATS_MTIME, sx->mtime.tv_sec, sx->mtime.tv_nsec);
  scr_stats_set_time(s, SCR_STATS_CTIME, sx->ctime.tv_sec, sx->ctime.tv_nsec);
  scr_stats_set_time(s, SCR_STATS_BIRTHTIME, sx->btime.tv_sec, sx->btime.tv_nsec);
  return s;
}
#endif

/* stat, lstat, or fstat when path is NULL, as libuv runs them: statx on
 * Linux, else the classic call. NULL with *error set on failure. */
static ScrStats *scr_stats_posix(const char *path, int fd, bool no_follow, int *error) {
#if defined(__linux__) && defined(SYS_statx)
  if (!scr_stats_no_statx) {
    ScrStatx sx;
    /* STATX_BASIC_STATS | STATX_BTIME */
    long rc = path ? syscall(SYS_statx, AT_FDCWD, path, no_follow ? AT_SYMLINK_NOFOLLOW : 0, 0xfffu, &sx)
                   : syscall(SYS_statx, fd, "", AT_EMPTY_PATH, 0xfffu, &sx);
    if (rc == 0) return scr_stats_of_statx(&sx);
    if (rc == -1 && errno != EINVAL && errno != EPERM && errno != ENOSYS && errno != EOPNOTSUPP) {
      *error = errno;
      return NULL;
    }
    /* A seccomp filter or an old kernel: libuv uses stat from then on. */
    scr_stats_no_statx = true;
  }
#endif
  struct stat st;
  int rc = path ? (no_follow ? lstat(path, &st) : stat(path, &st)) : fstat(fd, &st);
  if (rc != 0) {
    *error = errno;
    return NULL;
  }
  return scr_stats_of(&st);
}
#endif

/* Symbolic link targets are stored verbatim on POSIX. Windows junctions
 * instead carry an absolute NT path in a bounded mount-point reparse record. */
#ifdef _WIN32
static DWORD scr_fs_win_junction(const WCHAR *target, const WCHAR *destination) {
  size_t len = wcslen(target);
  /* libuv permits drive-absolute junctions, not UNC mount targets. */
  size_t skip = len >= 4 && !wcsncmp(target, L"\\\\?\\", 4) ? 4 : 0;
  const WCHAR *plain = target + skip;
  size_t chars = len - skip;
  if (chars < 3 || !((plain[0] >= L'A' && plain[0] <= L'Z') || (plain[0] >= L'a' && plain[0] <= L'z')) || plain[1] != L':' || plain[2] != L'\\') return ERROR_INVALID_PARAMETER;
  size_t fixed = offsetof(ScrStatsReparseData, body.mount.path);
  size_t total = fixed + (4 + chars + 1 + chars + 1) * sizeof(WCHAR);
  if (total > MAXIMUM_REPARSE_DATA_BUFFER_SIZE) return ERROR_FILENAME_EXCED_RANGE;
  ScrStatsReparseData *data = calloc(1, total);
  if (!data) return ERROR_NOT_ENOUGH_MEMORY;
  data->tag = IO_REPARSE_TAG_MOUNT_POINT;
  data->data_len = (USHORT)(total - offsetof(ScrStatsReparseData, body));
  data->body.mount.substitute_offset = 0;
  data->body.mount.substitute_len = (USHORT)((4 + chars) * sizeof(WCHAR));
  data->body.mount.print_offset = (USHORT)((4 + chars + 1) * sizeof(WCHAR));
  data->body.mount.print_len = (USHORT)(chars * sizeof(WCHAR));
  memcpy(data->body.mount.path, L"\\??\\", 4 * sizeof(WCHAR));
  memcpy(data->body.mount.path + 4, plain, chars * sizeof(WCHAR));
  memcpy(data->body.mount.path + 4 + chars + 1, plain, chars * sizeof(WCHAR));
  DWORD error = 0, used;
  bool created = CreateDirectoryW(destination, NULL) != 0;
  HANDLE h = INVALID_HANDLE_VALUE;
  if (!created) error = GetLastError();
  else {
    h = CreateFileW(destination, GENERIC_WRITE, 0, NULL, OPEN_EXISTING,
                    FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, NULL);
    if (h == INVALID_HANDLE_VALUE) error = GetLastError();
    else if (!DeviceIoControl(h, FSCTL_SET_REPARSE_POINT, data, (DWORD)total, NULL, 0, &used, NULL)) error = GetLastError();
  }
  if (h != INVALID_HANDLE_VALUE) CloseHandle(h);
  if (error && created) RemoveDirectoryW(destination);
  free(data);
  return error;
}
#endif

#ifdef _WIN32
/* libuv keeps this fallback for later calls once Windows rejects the flag. */
static SCR_TL DWORD scr_fs_symlink_usermode_flag = 0x2; /* ALLOW_UNPRIVILEGED_CREATE */
#endif

int scr_fs_symlink_infer(ScrStr *absolute) {
#ifdef _WIN32
  WCHAR *probe = scr_fs_win_wide(absolute);
  DWORD attributes = probe ? GetFileAttributesW(probe) : INVALID_FILE_ATTRIBUTES;
  free(probe);
  return attributes != INVALID_FILE_ATTRIBUTES && (attributes & FILE_ATTRIBUTE_DIRECTORY) ? 1 : 0;
#else
  (void)absolute;
  return 0;
#endif
}

void scr_fs_symlink(ScrStr *target, ScrStr *destination, int kind) {
  if (!scr_fs_path_ok(target, "target")) return;
  if (!scr_fs_path_ok(destination, "path")) return;
#ifdef _WIN32
  static ScrArrOps str_ops = { scr_str_retain_v, scr_str_release_v, NULL };
  ScrArr *parts = scr_arr_new_ops(&str_ops, 3);
  scr_arr_push_ref(parts, scr_str_retain(destination));
  scr_arr_push_ref(parts, scr_str_new("..", 2));
  scr_arr_push_ref(parts, scr_str_retain(target));
  ScrStr *absolute = scr_path_win32_resolve(parts);
  scr_arr_release(parts);
  if (kind == -1) kind = scr_fs_symlink_infer(absolute);
  ScrStr *stored;
  if (kind == 2) stored = scr_path_win32_to_namespaced_path(absolute);
  else if (scr_path_win32_is_absolute(target)) stored = scr_path_win32_to_namespaced_path(target);
  else {
    char *text = malloc(target->len ? target->len : 1);
    if (!text) scr_trap("scriptc: out of memory\n");
    for (size_t i = 0; i < target->len; i++) text[i] = target->data[i] == '/' ? '\\' : target->data[i];
    stored = scr_str_new(text, target->len);
    free(text);
  }
  scr_str_release(absolute);
  /* Node's binding namespaces the link path before passing it to libuv. */
  ScrStr *link_path = scr_path_win32_to_namespaced_path(destination);
  WCHAR *from = scr_fs_win_wide(stored), *to = scr_fs_win_wide(link_path);
  DWORD error = !from || !to ? GetLastError() : 0;
  if (!error && kind == 2) error = scr_fs_win_junction(from, to);
  else if (!error) {
    DWORD flags = (kind == 1 ? SYMBOLIC_LINK_FLAG_DIRECTORY : 0) | scr_fs_symlink_usermode_flag;
    if (!CreateSymbolicLinkW(to, from, flags)) {
      error = GetLastError();
      if (error == ERROR_INVALID_PARAMETER && scr_fs_symlink_usermode_flag) {
        scr_fs_symlink_usermode_flag = 0;
        error = CreateSymbolicLinkW(to, from, flags & ~0x2u) ? 0 : GetLastError();
      }
    }
  }
  free(from); free(to); scr_str_release(stored); scr_str_release(link_path);
  if (error) scr_fs_throw2(scr_fs_win_errno(error), "symlink", target, destination);
#else
  (void)kind;
  if (symlink(target->data, destination->data) != 0) scr_fs_throw2(errno, "symlink", target, destination);
#endif
}

/* Keep the unsigned libuv statfs representation before selecting Number or
 * BigInt. Free-space counts are live snapshots, not cached volume metadata. */
ScrDyn *scr_fs_statfs(ScrStr *path, bool bigint) {
  if (!scr_fs_path_ok(path, "path")) return NULL;
  uint64_t fields[8];
#if defined(_WIN32)
  ScrStr *syscall_path = scr_path_win32_to_namespaced_path(path);
  WCHAR *wide = scr_fs_win_wide(syscall_path);
  scr_str_release(syscall_path);
  if (!wide) { scr_fs_throw(scr_fs_win_errno(GetLastError()), "statfs", path); return NULL; }
  /* libuv opens the path and reads FileFsFullSizeInformation from the
   * volume that holds it; files and directories both resolve that way. */
  HANDLE handle = CreateFileW(wide, FILE_READ_ATTRIBUTES,
    FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, NULL, OPEN_EXISTING,
    FILE_FLAG_BACKUP_SEMANTICS, NULL);
  free(wide);
  if (handle == INVALID_HANDLE_VALUE) {
    scr_fs_throw(scr_fs_win_errno(GetLastError()), "statfs", path);
    return NULL;
  }
  struct {
    LARGE_INTEGER total;
    LARGE_INTEGER caller_available;
    LARGE_INTEGER actual_available;
    ULONG sectors_per_unit;
    ULONG bytes_per_sector;
  } info;
  struct {
    union { LONG status; PVOID pointer; } u;
    ULONG_PTR information;
  } io_status;
  typedef LONG(NTAPI * QueryVolumeFn)(HANDLE, void *, void *, ULONG, int);
  typedef ULONG(NTAPI * StatusToDosFn)(LONG);
  HMODULE ntdll = GetModuleHandleA("ntdll.dll");
  QueryVolumeFn query =
    ntdll ? (QueryVolumeFn)(void *)GetProcAddress(ntdll, "NtQueryVolumeInformationFile") : NULL;
  StatusToDosFn to_dos =
    ntdll ? (StatusToDosFn)(void *)GetProcAddress(ntdll, "RtlNtStatusToDosError") : NULL;
  /* FileFsFullSizeInformation is FS_INFORMATION_CLASS value 7. */
  LONG status = query ? query(handle, &io_status, &info, (ULONG)sizeof info, 7) : (LONG)0xC0000002L;
  CloseHandle(handle);
  /* NT_ERROR: the two severity bits are both set. */
  if (((ULONG)status >> 30) == 3) {
    DWORD error = to_dos ? (DWORD)to_dos(status) : ERROR_NOT_SUPPORTED;
    scr_fs_throw(scr_fs_win_errno(error), "statfs", path);
    return NULL;
  }
  fields[0] = 0;
  fields[1] = fields[2] = (uint64_t)info.sectors_per_unit * info.bytes_per_sector;
  fields[3] = (uint64_t)info.total.QuadPart;
  fields[4] = (uint64_t)info.actual_available.QuadPart;
  fields[5] = (uint64_t)info.caller_available.QuadPart;
  fields[6] = fields[7] = 0;
#elif defined(__wasi__)
  (void)path; (void)bigint;
  static const char message[] = "Filesystem capacity queries have no native WASI syscall";
  scr_throw_error_msg_code(SCR_ERR_ERROR, message, sizeof message - 1, "SC2020");
  return NULL;
#else
#if defined(__linux__) || defined(__APPLE__) || defined(__FreeBSD__)
  struct statfs snapshot;
  if (statfs(path->data, &snapshot) != 0) { scr_fs_throw(errno, "statfs", path); return NULL; }
  fields[0] = (uint64_t)snapshot.f_type;
#else
  struct statvfs snapshot;
  if (statvfs(path->data, &snapshot) != 0) { scr_fs_throw(errno, "statfs", path); return NULL; }
  fields[0] = 0;
#endif
  fields[1] = (uint64_t)snapshot.f_bsize;
  /* libuv reports f_frsize on Linux and repeats f_bsize elsewhere. */
#if defined(__linux__)
  fields[2] = (uint64_t)snapshot.f_frsize;
#else
  fields[2] = (uint64_t)snapshot.f_bsize;
#endif
  fields[3] = (uint64_t)snapshot.f_blocks;
  fields[4] = (uint64_t)snapshot.f_bfree;
  fields[5] = (uint64_t)snapshot.f_bavail;
  fields[6] = (uint64_t)snapshot.f_files;
  fields[7] = (uint64_t)snapshot.f_ffree;
#endif
  static const char *names[] = { "type", "bsize", "frsize", "blocks", "bfree", "bavail", "files", "ffree" };
  ScrDyn *result = scr_dyn_new_obj();
  for (size_t i = 0; i < 8; i++) {
    ScrDyn *value;
    if (bigint) {
      ScrBigInt *number = scr_bigint_from_u64(fields[i]);
      value = scr_dyn_new_bigint(number);
      scr_bigint_release(number);
    } else value = scr_dyn_new_num((double)fields[i]);
    scr_dyn_obj_set(result, names[i], strlen(names[i]), value);
  }
  return result;
}

ScrBytes *scr_fs_readlink_bytes(ScrStr *path) {
  if (!scr_fs_path_ok(path, "path")) return NULL;
#ifdef _WIN32
  WCHAR *wide = scr_fs_win_wide(path);
  if (!wide) { scr_fs_throw(scr_fs_win_errno(GetLastError()), "readlink", path); return NULL; }
  HANDLE h = CreateFileW(wide, 0, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, NULL, OPEN_EXISTING,
                        FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS, NULL);
  free(wide);
  if (h == INVALID_HANDLE_VALUE) { scr_fs_throw(scr_fs_win_errno(GetLastError()), "readlink", path); return NULL; }
  FILE_ATTRIBUTE_TAG_INFO tagged;
  ScrStr *text = NULL;
  double size;
  bool ok = GetFileInformationByHandleEx(h, FileAttributeTagInfo, &tagged, sizeof tagged) &&
    scr_stats_link_target(h, tagged.ReparseTag, &size, &text);
  CloseHandle(h);
  if (!ok || !text) { scr_str_release(text); scr_fs_throw(EINVAL, "readlink", path); return NULL; }
  ScrBytes *bytes = scr_bytes_from_data((const uint8_t *)text->data, text->len);
  scr_str_release(text);
  return bytes;
#else
  size_t capacity = 256;
  uint8_t *text = NULL;
  for (;;) {
    uint8_t *grown = realloc(text, capacity);
    if (!grown) { free(text); scr_trap("scriptc: out of memory\n"); }
    text = grown;
    ssize_t size = readlink(path->data, (char *)text, capacity);
    if (size < 0) { int error = errno; free(text); scr_fs_throw(error, "readlink", path); return NULL; }
    if ((size_t)size < capacity) {
      ScrBytes *bytes = scr_bytes_from_data(text, (size_t)size);
      free(text);
      return bytes;
    }
    if (capacity > SIZE_MAX / 2) { free(text); scr_fs_throw(ENAMETOOLONG, "readlink", path); return NULL; }
    capacity *= 2;
  }
#endif
}

ScrStats *scr_fs_stat(ScrStr *path) {
  if (!scr_fs_path_ok(path, "path")) return NULL;
#ifdef _WIN32
  return scr_stats_of_path(path, "stat", false);
#else
  int error = 0;
  ScrStats *s = scr_stats_posix(path->data, -1, false, &error); /* follows symlinks */
  if (!s) scr_fs_throw(error, "stat", path);
  return s;
#endif
}

ScrStats *scr_fs_lstat(ScrStr *path) {
  if (!scr_fs_path_ok(path, "path")) return NULL;
#ifdef _WIN32
  return scr_stats_of_path(path, "lstat", true);
#else
  int error = 0;
  ScrStats *s = scr_stats_posix(path->data, -1, true, &error); /* no follow */
  if (!s) scr_fs_throw(error, "lstat", path);
  return s;
#endif
}

/* statSync / lstatSync(path, { throwIfNoEntry }): with false, NULL (undefined)
 * when the entry or a parent directory is missing, as Node's binding
 * answers for ENOENT and ENOTDIR (a dangling link's stat included); other
 * failures throw as statSync does. */
ScrStats *scr_fs_stat_probe(ScrStr *path, bool no_follow, bool throw_if_no_entry) {
  if (throw_if_no_entry) return no_follow ? scr_fs_lstat(path) : scr_fs_stat(path);
  bool outer = scr_fs_probing;
  scr_fs_probing = true;
  ScrStats *s = no_follow ? scr_fs_lstat(path) : scr_fs_stat(path);
  scr_fs_probing = outer;
  return s;
}

ScrStats *scr_stats_of_fd(int fd, int *error) {
#ifdef _WIN32
  struct stat st;
  if (fstat(fd, &st) != 0) {
    *error = errno;
    return NULL;
  }
  return scr_stats_of_fd_win(fd, &st);
#else
  return scr_stats_posix(NULL, fd, false, error);
#endif
}

ScrStats *scr_fs_fstat(double fd) {
  int error = 0;
  ScrStats *s = scr_stats_of_fd((int)fd, &error);
  if (!s) scr_fs_throw_nopath(error, "fstat");
  return s;
}

/* ── Stats objects ───────────────────────────────────────────────────
 * Node's Stats and BigIntStats over a snapshot. The integers and the *Ms
 * fields (and BigIntStats' *Ns fields) are own properties in the binding's
 * order. Stats.prototype holds _checkModeProperty and lazy atime, mtime,
 * ctime and birthtime accessors, which define an own Date the first time
 * they run. The type tests (isFile, ...) sit on StatsBase.prototype and go
 * through this._checkModeProperty(S_IF...), which reads this.mode. */

static SCR_TL ScrDyn *scr_stats_base_proto = NULL;
static SCR_TL ScrDyn *scr_stats_protos[2] = { NULL, NULL }; /* Stats, BigIntStats */

static const char *const scr_stats_date_names[4] = { "atime", "mtime", "ctime", "birthtime" };

/* Object.defineProperty(target, name, { value, writable } or { get, set },
 * enumerable, configurable: true). value, get and set move in. */
static bool scr_stats_define(ScrDyn *target, const char *name, ScrDyn *value, ScrDyn *get, ScrDyn *set, bool enumerable) {
  ScrDyn *descriptor = scr_dyn_new_obj();
  if (value) {
    scr_dyn_obj_set(descriptor, "value", 5, value);
    scr_dyn_obj_set(descriptor, "writable", 8, scr_dyn_new_bool(true));
  }
  if (get) scr_dyn_obj_set(descriptor, "get", 3, get);
  if (set) scr_dyn_obj_set(descriptor, "set", 3, set);
  scr_dyn_obj_set(descriptor, "enumerable", 10, scr_dyn_new_bool(enumerable));
  scr_dyn_obj_set(descriptor, "configurable", 12, scr_dyn_new_bool(true));
  ScrStr *text = scr_str_new(name, strlen(name));
  ScrDyn *key = scr_dyn_new_str(text);
  scr_str_release(text);
  ScrDyn *defined = scr_dyn_define_property(target, key, descriptor);
  scr_dyn_release(key);
  scr_dyn_release(descriptor);
  if (!defined) return false;
  scr_dyn_release(defined);
  return true;
}

/* `this` for a prototype member, or NULL with Node's TypeError when the
 * receiver is undefined or null and a property read would throw. */
static ScrDyn *scr_stats_receiver(const char *reading) {
  ScrDyn *self = scr_dyn_this_get();
  if (self->kind != SCR_DYN_UNDEF && self->kind != SCR_DYN_NULL) return self;
  char message[96];
  int n = snprintf(message, sizeof message, "Cannot read properties of %s (reading '%s')",
                   self->kind == SCR_DYN_UNDEF ? "undefined" : "null", reading);
  scr_dyn_release(self);
  scr_throw_error_msg(SCR_ERR_TYPE, message, (size_t)n);
  return NULL;
}

/* The lazy Date getter: setOwnProperty(this, name, new Date(Math.round(
 * Number(this.<name>Ms)))). */
static ScrDyn *scr_stats_date_get(int which) {
  char ms_name[16];
  int len = snprintf(ms_name, sizeof ms_name, "%sMs", scr_stats_date_names[which]);
  ScrDyn *self = scr_stats_receiver(ms_name);
  if (!self) return NULL;
  ScrDyn *ms = scr_dyn_obj_read(self, ms_name, (size_t)len);
  double number = ms ? scr_dyn_number_constructor(ms) : NAN;
  scr_dyn_release(ms);
  ScrDyn *date = NULL;
  if (!scr_exc_pending()) {
    ScrDyn *arguments = scr_dyn_new_arr();
    scr_dyn_arr_push(arguments, scr_dyn_new_num(scr_stats_round(number)));
    date = scr_dyn_native_date_new(arguments);
    scr_dyn_release(arguments);
  }
  if (date && !scr_stats_define(self, scr_stats_date_names[which], scr_dyn_retain(date), NULL, NULL, true)) {
    scr_dyn_release(date);
    date = NULL;
  }
  scr_dyn_release(self);
  return date;
}

/* The setter: setOwnProperty(this, name, value). */
static ScrDyn *scr_stats_date_set(int which, ScrDyn *const *args, size_t argc) {
  ScrDyn *self = scr_dyn_this_get();
  bool ok = scr_stats_define(self, scr_stats_date_names[which],
                             scr_dyn_retain(argc > 0 ? args[0] : scr_dyn_undefined()), NULL, NULL, true);
  scr_dyn_release(self);
  return ok ? scr_dyn_retain(scr_dyn_undefined()) : NULL;
}

#define SCR_STATS_DATE_ACCESSORS(index)                                                        \
  static ScrDyn *scr_stats_date_get_##index(ScrClosure *closure, ScrDyn *const *args, size_t argc) { \
    (void)closure;                                                                             \
    (void)args;                                                                                \
    (void)argc;                                                                                \
    return scr_stats_date_get(index);                                                          \
  }                                                                                            \
  static ScrDyn *scr_stats_date_set_##index(ScrClosure *closure, ScrDyn *const *args, size_t argc) { \
    (void)closure;                                                                             \
    return scr_stats_date_set(index, args, argc);                                              \
  }
SCR_STATS_DATE_ACCESSORS(0)
SCR_STATS_DATE_ACCESSORS(1)
SCR_STATS_DATE_ACCESSORS(2)
SCR_STATS_DATE_ACCESSORS(3)
#undef SCR_STATS_DATE_ACCESSORS

static const ScrDynThunk scr_stats_date_getters[4] = {
  scr_stats_date_get_0, scr_stats_date_get_1, scr_stats_date_get_2, scr_stats_date_get_3,
};
static const ScrDynThunk scr_stats_date_setters[4] = {
  scr_stats_date_set_0, scr_stats_date_set_1, scr_stats_date_set_2, scr_stats_date_set_3,
};

/* _checkModeProperty(property): (this.mode & S_IFMT) === property, with
 * BigInt operands on BigIntStats. */
static ScrDyn *scr_stats_check_mode(ScrDyn *const *args, size_t argc, bool bigint) {
  const ScrDyn *property = argc > 0 ? args[0] : scr_dyn_undefined();
#ifdef _WIN32
  if (property->kind == SCR_DYN_NUM &&
      (property->v.num == SCR_STATS_IFIFO || property->v.num == SCR_STATS_IFBLK || property->v.num == SCR_STATS_IFSOCK))
    return scr_dyn_new_bool(false);
#endif
  ScrDyn *self = scr_stats_receiver("mode");
  if (!self) return NULL;
  ScrDyn *mode = scr_dyn_obj_read(self, "mode", 4);
  scr_dyn_release(self);
  if (!mode) return NULL;
  ScrDyn *mask;
  if (bigint) {
    ScrBigInt *value = scr_bigint_from_u64(SCR_STATS_IFMT);
    mask = scr_dyn_new_bigint(value);
    scr_bigint_release(value);
  } else mask = scr_dyn_new_num(SCR_STATS_IFMT);
  ScrStr *operation = scr_str_new("&", 1);
  ScrDyn *masked = scr_dyn_bitwise(mode, mask, operation);
  scr_str_release(operation);
  scr_dyn_release(mask);
  scr_dyn_release(mode);
  if (!masked) return NULL;
  ScrDyn *expected = NULL;
  if (bigint) {
    ScrBigInt *value = scr_dyn_bigint_constructor(property);
    if (value) {
      expected = scr_dyn_new_bigint(value);
      scr_bigint_release(value);
    }
  } else expected = scr_dyn_retain((ScrDyn *)property);
  ScrDyn *result = expected ? scr_dyn_new_bool(scr_dyn_strict_eq(masked, expected)) : NULL;
  scr_dyn_release(expected);
  scr_dyn_release(masked);
  return result;
}

static ScrDyn *scr_stats_check_mode_number(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  (void)closure;
  return scr_stats_check_mode(args, argc, false);
}

static ScrDyn *scr_stats_check_mode_bigint(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  (void)closure;
  return scr_stats_check_mode(args, argc, true);
}

/* isFile() and the other type tests: this._checkModeProperty(S_IF...). */
static ScrDyn *scr_stats_type_test(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  (void)args;
  (void)argc;
  ScrDyn *self = scr_stats_receiver("_checkModeProperty");
  if (!self) return NULL;
  ScrDyn *check = scr_dyn_obj_read(self, "_checkModeProperty", 18);
  ScrDyn *result = NULL;
  if (check) {
    ScrDyn *type = scr_dyn_new_num(scr_box_get_f64(closure->caps[0]));
    scr_dyn_this_push_dyn(self);
    result = scr_dyn_call(check, &type, 1, "this._checkModeProperty");
    scr_dyn_this_pop();
    scr_dyn_release(type);
    scr_dyn_release(check);
  }
  scr_dyn_release(self);
  return result;
}

/* The prototypes' constructor members are only named; calling one has no
 * lowering. The type tests and _checkModeProperty are anonymous functions in
 * Node (assigned function expressions), so they carry no name. */
static ScrDyn *scr_stats_constructor(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  (void)closure;
  (void)args;
  (void)argc;
  static const char message[] = "Calling the fs.Stats constructors has no lowering";
  scr_throw_error_msg_code(SCR_ERR_ERROR, message, sizeof message - 1, "SC2020");
  return NULL;
}

static ScrDyn *scr_stats_method(ScrDynThunk thunk, uint32_t arity, const char *name, double type) {
  ScrClosure *closure = scr_closure_new(NULL, 1);
  closure->caps[0] = scr_box_new(SCR_BOX_F64);
  scr_box_set_f64(closure->caps[0], type);
  return scr_dyn_new_func(closure, thunk, arity, "native:fs.Stats", name);
}

static void scr_stats_protos_teardown(void) {
  for (size_t i = 0; i < 2; i++) {
    if (!scr_stats_protos[i]) continue;
    scr_stats_protos[i]->v.obj.class_name = NULL;
    scr_dyn_release(scr_stats_protos[i]);
    scr_stats_protos[i] = NULL;
  }
  if (scr_stats_base_proto) {
    scr_stats_base_proto->v.obj.class_name = NULL;
    scr_dyn_release(scr_stats_base_proto);
    scr_stats_base_proto = NULL;
  }
}

static ScrDyn *scr_stats_prototype(bool bigint) {
  if (scr_stats_protos[bigint]) return scr_stats_protos[bigint];
  if (!scr_stats_base_proto) {
    static const struct {
      const char *name;
      unsigned type;
    } tests[] = {
      { "isDirectory", SCR_STATS_IFDIR },
      { "isFile", SCR_STATS_IFREG },
      { "isBlockDevice", SCR_STATS_IFBLK },
      { "isCharacterDevice", SCR_STATS_IFCHR },
      { "isSymbolicLink", SCR_STATS_IFLNK },
      { "isFIFO", SCR_STATS_IFIFO },
      { "isSocket", SCR_STATS_IFSOCK },
    };
    ScrDyn *base = scr_dyn_new_obj();
    base->v.obj.class_name = "StatsBase";
    scr_stats_define(base, "constructor", scr_stats_method(scr_stats_constructor, 10, "StatsBase", 0), NULL, NULL, false);
    for (size_t i = 0; i < sizeof tests / sizeof tests[0]; i++)
      scr_dyn_obj_set(base, tests[i].name, strlen(tests[i].name),
                      scr_stats_method(scr_stats_type_test, 0, NULL, tests[i].type));
    scr_stats_base_proto = base;
    scr_atexit(scr_stats_protos_teardown);
  }
  const char *name = bigint ? "BigIntStats" : "Stats";
  ScrDyn *proto = scr_dyn_new_obj();
  proto->v.obj.class_name = name;
  proto->prototype = scr_dyn_retain(scr_stats_base_proto);
  scr_stats_define(proto, "constructor", scr_stats_method(scr_stats_constructor, 14, name, 0), NULL, NULL, false);
  for (int i = 0; i < 4; i++)
    scr_stats_define(proto, scr_stats_date_names[i], NULL,
                     scr_stats_method(scr_stats_date_getters[i], 0, "get", 0),
                     scr_stats_method(scr_stats_date_setters[i], 1, "set", 0), true);
  scr_dyn_obj_set(proto, "_checkModeProperty", 18,
                  scr_stats_method(bigint ? scr_stats_check_mode_bigint : scr_stats_check_mode_number, 1, NULL, 0));
  scr_stats_protos[bigint] = proto;
  return proto;
}

static ScrDyn *scr_stats_bigint_dyn(ScrBigInt *value /* moves */) {
  ScrDyn *boxed = scr_dyn_new_bigint(value);
  scr_bigint_release(value);
  return boxed;
}

ScrDyn *scr_stats_dyn(ScrStats *s, bool bigint) {
  static const char *const names[SCR_STATS_FIELDS] = {
    "dev", "mode", "nlink", "uid", "gid", "rdev", "blksize", "ino", "size", "blocks",
  };
  ScrDyn *object = scr_dyn_new_obj();
  object->prototype = scr_dyn_retain(scr_stats_prototype(bigint));
  for (size_t i = 0; i < SCR_STATS_FIELDS; i++) {
    /* The binding's BigInt64Array holds the integers as signed values. */
    ScrDyn *value = bigint ? scr_stats_bigint_dyn(scr_bigint_from_i64((int64_t)s->fields[i]))
                           : scr_dyn_new_num((double)s->fields[i]);
    scr_dyn_obj_set(object, names[i], strlen(names[i]), value);
  }
  ScrDyn *ns[4] = { NULL, NULL, NULL, NULL };
  for (int i = 0; i < 4; i++) {
    char name[16];
    int len = snprintf(name, sizeof name, "%sMs", scr_stats_date_names[i]);
    if (!bigint) {
      scr_dyn_obj_set(object, name, (size_t)len, scr_dyn_new_num(scr_stats_ms(s, i)));
      continue;
    }
    /* nsFromTimeSpecBigInt, then the millisecond quotient. */
    ScrBigInt *sec = scr_bigint_from_i64(s->sec[i]);
    ScrBigInt *billion = scr_bigint_from_i64(1000000000);
    ScrBigInt *scaled = scr_bigint_mul(sec, billion);
    ScrBigInt *nsec = scr_bigint_from_i64(s->nsec[i]);
    ScrBigInt *total = scr_bigint_add(scaled, nsec);
    ScrBigInt *million = scr_bigint_from_i64(1000000);
    ScrBigInt *ms = scr_bigint_div(total, million);
    scr_bigint_release(sec);
    scr_bigint_release(billion);
    scr_bigint_release(scaled);
    scr_bigint_release(nsec);
    scr_bigint_release(million);
    scr_dyn_obj_set(object, name, (size_t)len, scr_stats_bigint_dyn(ms));
    ns[i] = scr_stats_bigint_dyn(total);
  }
  for (int i = 0; bigint && i < 4; i++) {
    char name[16];
    int len = snprintf(name, sizeof name, "%sNs", scr_stats_date_names[i]);
    scr_dyn_obj_set(object, name, (size_t)len, ns[i]);
  }
  return object;
}

/* The names of one scandir listing: byte order on POSIX (libuv sorts),
 * the directory's own order on Windows (libuv does not). */
ScrArr *scr_fs_readdir(ScrStr *path) {
  if (!scr_fs_path_ok(path, "path")) return NULL;
  ScrScandir *scan = scr_fs_scandir(path);
  if (!scan) return NULL;
  ScrArr *arr = scr_arr_new(SCR_ELEM_STR, scr_fs_scandir_count(scan));
  for (size_t i = 0; i < scr_fs_scandir_count(scan); i++) scr_arr_push_ref(arr, scr_fs_scandir_name(scan, i));
  scr_fs_scandir_free(scan);
  return arr;
}

/* ── the withFileTypes scandir snapshot ──────────────────────────────
 * One readdir pass capturing name + entry kind for the emitter's Dirent
 * assembly (scr_runtime.h has the contract). Kinds are libuv's UV_DIRENT
 * encoding; DT_UNKNOWN (filesystems that don't fill d_type) falls back
 * to lstat(2) on the joined path — Node's own getDirents rule (a failed
 * lstat leaves 0/unknown: every is*() probe answers false, like Node's
 * Dirent over an UNKNOWN row it could not stat). */

struct ScrScandir {
  size_t len, cap;
  ScrStr **names;
  unsigned char *kinds;
};

#ifndef _WIN32
/* libuv's uv_fs_scandir sorts entries with strcmp on POSIX hosts, so
 * readdir, readdirSync and fs/promises readdir list names in byte order. */
typedef struct {
  ScrStr *name;
  unsigned char kind;
} ScrScandirEntry;

static int scr_fs_scandir_cmp(const void *a, const void *b) {
  const ScrStr *x = ((const ScrScandirEntry *)a)->name, *y = ((const ScrScandirEntry *)b)->name;
  size_t n = x->len < y->len ? x->len : y->len;
  int c = memcmp(x->data, y->data, n);
  return c ? c : (x->len > y->len) - (x->len < y->len);
}

static void scr_fs_scandir_sort(ScrScandir *s) {
  if (s->len < 2) return;
  ScrScandirEntry *rows = malloc(s->len * sizeof *rows);
  if (!rows) scr_trap("scriptc: out of memory\n");
  for (size_t i = 0; i < s->len; i++) rows[i] = (ScrScandirEntry){s->names[i], s->kinds[i]};
  qsort(rows, s->len, sizeof *rows, scr_fs_scandir_cmp);
  for (size_t i = 0; i < s->len; i++) {
    s->names[i] = rows[i].name;
    s->kinds[i] = rows[i].kind;
  }
  free(rows);
}

static unsigned char scr_dirent_kind_of_mode(mode_t m) {
  if (S_ISREG(m)) return 1;
  if (S_ISDIR(m)) return 2;
#ifdef S_ISLNK /* no symlink/socket bits in the CRT's stat */
  if (S_ISLNK(m)) return 3;
#endif
  if (S_ISFIFO(m)) return 4;
#ifdef S_ISSOCK
  if (S_ISSOCK(m)) return 5;
#endif
  if (S_ISCHR(m)) return 6;
  if (S_ISBLK(m)) return 7;
  return 0;
}
#endif

#ifdef _WIN32
static ScrScandir *scr_fs_scandir_windows(ScrStr *path) {
  WCHAR *wide = scr_fs_win_wide(path);
  if (!wide) { scr_fs_throw(scr_fs_win_errno(GetLastError()), "scandir", path); return NULL; }
  DWORD attrs = GetFileAttributesW(wide);
  if (attrs == INVALID_FILE_ATTRIBUTES || !(attrs & FILE_ATTRIBUTE_DIRECTORY)) {
    int error = attrs == INVALID_FILE_ATTRIBUTES ? scr_fs_win_errno(GetLastError()) : ENOTDIR;
    free(wide);
    scr_fs_throw(error, "scandir", path);
    return NULL;
  }
  size_t length = wcslen(wide);
  WCHAR *pattern = realloc(wide, (length + 3) * sizeof *wide);
  if (!pattern) { free(wide); scr_trap("scriptc: out of memory\n"); }
  if (length && pattern[length - 1] != L'\\' && pattern[length - 1] != L'/') pattern[length++] = L'\\';
  pattern[length++] = L'*';
  pattern[length] = 0;
  WIN32_FIND_DATAW entry;
  HANDLE search = FindFirstFileW(pattern, &entry);
  DWORD error = search == INVALID_HANDLE_VALUE ? GetLastError() : ERROR_SUCCESS;
  free(pattern);
  if (search == INVALID_HANDLE_VALUE && error != ERROR_FILE_NOT_FOUND) {
    scr_fs_throw(scr_fs_win_errno(error), "scandir", path);
    return NULL;
  }
  ScrScandir *scan = calloc(1, sizeof *scan);
  if (!scan) { if (search != INVALID_HANDLE_VALUE) FindClose(search); scr_trap("scriptc: out of memory\n"); }
  if (search == INVALID_HANDLE_VALUE) return scan;
  do {
    if (wcscmp(entry.cFileName, L".") == 0 || wcscmp(entry.cFileName, L"..") == 0) continue;
    ScrStr *name = scr_fs_win_utf8(entry.cFileName, wcslen(entry.cFileName));
    if (!name) {
      error = GetLastError();
      FindClose(search);
      scr_fs_scandir_free(scan);
      scr_fs_throw(scr_fs_win_errno(error), "scandir", path);
      return NULL;
    }
    if (scan->len == scan->cap) {
      scan->cap = scan->cap ? scan->cap * 2 : 8;
      scan->names = realloc(scan->names, scan->cap * sizeof *scan->names);
      scan->kinds = realloc(scan->kinds, scan->cap);
      if (!scan->names || !scan->kinds) scr_trap("scriptc: out of memory\n");
    }
    scan->names[scan->len] = name;
    scan->kinds[scan->len++] = (entry.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) &&
        scr_stats_is_link_tag(entry.dwReserved0) ? 3 :
        (entry.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) ? 2 : 1;
  } while (FindNextFileW(search, &entry));
  error = GetLastError();
  FindClose(search);
  if (error != ERROR_NO_MORE_FILES) {
    scr_fs_scandir_free(scan);
    scr_fs_throw(scr_fs_win_errno(error), "scandir", path);
    return NULL;
  }
  return scan;
}
#endif

ScrScandir *scr_fs_scandir(ScrStr *path) {
  if (!scr_fs_path_ok(path, "path")) return NULL;
#ifdef _WIN32
  return scr_fs_scandir_windows(path);
#else
  DIR *d = opendir(path->data);
  if (!d) {
    scr_fs_throw(errno, "scandir", path); /* Node reports scandir */
    return NULL;
  }
  ScrScandir *s = malloc(sizeof *s);
  if (!s) {
    scr_trap("scriptc: out of memory\n");
  }
  s->len = 0;
  s->cap = 8;
  s->names = malloc(s->cap * sizeof *s->names);
  s->kinds = malloc(s->cap);
  if (!s->names || !s->kinds) {
    scr_trap("scriptc: out of memory\n");
  }
  const struct dirent *ent;
  while ((ent = readdir(d)) != NULL) {
    if (strcmp(ent->d_name, ".") == 0 || strcmp(ent->d_name, "..") == 0) continue;
    unsigned char kind;
#ifdef DT_REG
    switch (ent->d_type) {
      case DT_REG: kind = 1; break;
      case DT_DIR: kind = 2; break;
      case DT_LNK: kind = 3; break;
      case DT_FIFO: kind = 4; break;
      case DT_SOCK: kind = 5; break;
      case DT_CHR: kind = 6; break;
      case DT_BLK: kind = 7; break;
      default: { /* DT_UNKNOWN: the lstat fallback */
        char buf[4096];
        int w = snprintf(buf, sizeof buf, "%s/%s", path->data, ent->d_name);
        struct stat st;
        kind = (w > 0 && (size_t)w < sizeof buf && lstat(buf, &st) == 0)
                   ? scr_dirent_kind_of_mode(st.st_mode)
                   : 0;
        break;
      }
    }
#else
    { /* mingw dirent has no d_type: every row takes the stat fallback
       * (lstat degrades to stat on Windows — see the include seam). */
      char buf[4096];
      int w = snprintf(buf, sizeof buf, "%s/%s", path->data, ent->d_name);
      struct stat st;
      kind = (w > 0 && (size_t)w < sizeof buf && lstat(buf, &st) == 0)
                 ? scr_dirent_kind_of_mode(st.st_mode)
                 : 0;
    }
#endif
    if (s->len == s->cap) {
      s->cap *= 2;
      s->names = realloc(s->names, s->cap * sizeof *s->names);
      s->kinds = realloc(s->kinds, s->cap);
      if (!s->names || !s->kinds) {
        scr_trap("scriptc: out of memory\n");
      }
    }
    s->names[s->len] = scr_str_new(ent->d_name, strlen(ent->d_name));
    s->kinds[s->len] = kind;
    s->len++;
  }
  closedir(d);
  scr_fs_scandir_sort(s);
  return s;
#endif
}

size_t scr_fs_scandir_count(const ScrScandir *s) { return s ? s->len : 0; }

ScrStr *scr_fs_scandir_name(const ScrScandir *s, size_t i) {
  return scr_str_retain(s->names[i]);
}

double scr_fs_scandir_type(const ScrScandir *s, size_t i) { return (double)s->kinds[i]; }

void scr_fs_scandir_free(ScrScandir *s) {
  if (!s) return;
  for (size_t i = 0; i < s->len; i++) scr_str_release(s->names[i]);
  free(s->names);
  free(s->kinds);
  free(s);
}

/* ── fs.Dir ──────────────────────────────────────────────────────────
 * opendirSync and fs.promises.opendir: one open directory stream handing
 * out an entry at a time in OS order, like libuv's uv_fs_readdir (no "."
 * or ".."). Entry kinds use the scandir encoding above. A closed Dir
 * throws ERR_DIR_CLOSED; releasing the last reference closes the stream. */

struct ScrDir {
  size_t rc;
  ScrStr *path;
  bool closed;
#ifdef _WIN32
  HANDLE search;
  WIN32_FIND_DATAW entry;
  bool pending; /* entry holds the next unread result */
#else
  DIR *stream;
#endif
};

static void scr_dir_close_stream(ScrDir *d) {
#ifdef _WIN32
  if (d->search != INVALID_HANDLE_VALUE) FindClose(d->search);
  d->search = INVALID_HANDLE_VALUE;
  d->pending = false;
#else
  if (d->stream) closedir(d->stream);
  d->stream = NULL;
#endif
}

ScrDir *scr_dir_retain(ScrDir *d) {
  if (d->rc != SIZE_MAX) d->rc++;
  return d;
}

void scr_dir_release(ScrDir *d) {
  if (!d || d->rc == SIZE_MAX || --d->rc) return;
  scr_dir_close_stream(d);
  scr_str_release(d->path);
  free(d);
}

void *scr_dir_retain_v(void *p) { return scr_dir_retain(p); }
void scr_dir_release_v(void *p) { scr_dir_release(p); }

ScrStr *scr_dir_path(ScrDir *d) { return scr_str_retain(d->path); }

static void scr_dir_closed(void) {
  static const char message[] = "Directory handle was closed";
  scr_throw_error_msg_code(SCR_ERR_ERROR, message, sizeof message - 1, "ERR_DIR_CLOSED");
}

/* Node opens the directory, then checks options.bufferSize (a uint32 of at
 * least 1) and closes the handle when it fails. Its opendir errors name the
 * syscall but no path. */
static bool scr_dir_buffer_size_valid(double size) {
  bool integer = isfinite(size) && trunc(size) == size;
  if (integer && size >= 1 && size <= 4294967295.0) return true;
  char received[48], msg[192];
  scr_num_received(size, received);
  int n = snprintf(msg, sizeof msg, "The value of \"options.bufferSize\" is out of range. It must be %s. Received %s",
                   integer ? ">= 1 && <= 4294967295" : "an integer", received);
  scr_throw_error_msg_code(SCR_ERR_RANGE, msg, (size_t)n, "ERR_OUT_OF_RANGE");
  return false;
}

/* A Dir in an 'unknown' slot: path reads and closeSync() calls; the other
 * members throw the "not supported yet" Error. */
static ScrDyn *scr_dir_dyn_invoke(void *h, ScrDyn *self, const char *method, ScrDyn *const *args, size_t argc,
                                  const char *what) {
  (void)self;
  (void)args;
  (void)argc;
  (void)what;
  if (strcmp(method, "closeSync") == 0) {
    scr_dir_close(h);
    return scr_exc_pending() ? NULL : scr_dyn_retain(scr_dyn_undefined());
  }
  static const char msg[] = "Dir method calls through an 'unknown' value are not supported yet — narrow the value to Dir first";
  scr_throw_error_msg(SCR_ERR_ERROR, msg, sizeof msg - 1);
  return NULL;
}

static ScrDyn *scr_dir_dyn_get(void *h, const char *key, size_t len) {
  if (len != 4 || memcmp(key, "path", 4) != 0) return NULL;
  ScrStr *path = scr_dir_path(h);
  ScrDyn *out = scr_dyn_new_str(path);
  scr_str_release(path);
  return out;
}

static bool scr_dir_dyn_set(void *h, const char *key, size_t len, const ScrDyn *value) {
  (void)h;
  (void)key;
  (void)len;
  (void)value;
  return false;
}

static void scr_dir_dyn_install(void) {
  static SCR_TL bool installed;
  if (installed) return;
  installed = true;
  static const ScrDynHandleOps ops = {
      .cls = "Dir",
      .retain = scr_dir_retain_v,
      .release = scr_dir_release_v,
      .invoke = scr_dir_dyn_invoke,
      .get = scr_dir_dyn_get,
      .set = scr_dir_dyn_set,
  };
  scr_dyn_handle_install(SCR_DYNH_DIR, &ops);
}

ScrDir *scr_fs_opendir(ScrStr *path, double buffer_size) {
  if (!scr_fs_path_ok(path, "path")) return NULL;
  scr_dir_dyn_install();
  ScrDir *d = calloc(1, sizeof *d);
  if (!d) scr_trap("scriptc: out of memory\n");
  d->rc = 1;
#ifdef _WIN32
  d->search = INVALID_HANDLE_VALUE;
  WCHAR *wide = scr_fs_win_wide(path);
  int error = 0;
  DWORD attributes = wide ? GetFileAttributesW(wide) : INVALID_FILE_ATTRIBUTES;
  if (!wide || attributes == INVALID_FILE_ATTRIBUTES) error = scr_fs_win_errno(GetLastError());
  else if (!(attributes & FILE_ATTRIBUTE_DIRECTORY)) error = ENOTDIR;
  if (!error) {
    size_t length = wcslen(wide);
    WCHAR *pattern = realloc(wide, (length + 3) * sizeof *wide);
    if (!pattern) scr_trap("scriptc: out of memory\n");
    wide = pattern;
    if (length && pattern[length - 1] != L'\\' && pattern[length - 1] != L'/') pattern[length++] = L'\\';
    pattern[length++] = L'*';
    pattern[length] = 0;
    d->search = FindFirstFileW(pattern, &d->entry);
    DWORD last = d->search == INVALID_HANDLE_VALUE ? GetLastError() : ERROR_SUCCESS;
    if (d->search != INVALID_HANDLE_VALUE) d->pending = true;
    else if (last != ERROR_FILE_NOT_FOUND) error = scr_fs_win_errno(last);
  }
  free(wide);
  if (error) {
    free(d);
    scr_fs_throw_nopath(error, "opendir");
    return NULL;
  }
#else
  d->stream = opendir(path->data);
  if (!d->stream) {
    int error = errno;
    free(d);
    scr_fs_throw_nopath(error, "opendir");
    return NULL;
  }
#endif
  if (!scr_dir_buffer_size_valid(buffer_size)) {
    scr_dir_close_stream(d);
    free(d);
    return NULL;
  }
  d->path = scr_str_retain(path);
  return d;
}

#ifndef _WIN32
/* The entry kind from d_type, with Node's lstat fallback for DT_UNKNOWN. */
static unsigned char scr_dir_entry_kind(const ScrDir *d, const struct dirent *ent) {
#ifdef DT_REG
  switch (ent->d_type) {
    case DT_REG: return 1;
    case DT_DIR: return 2;
    case DT_LNK: return 3;
    case DT_FIFO: return 4;
    case DT_SOCK: return 5;
    case DT_CHR: return 6;
    case DT_BLK: return 7;
    default: break;
  }
#endif
  char buf[4096];
  int w = snprintf(buf, sizeof buf, "%s/%s", d->path->data, ent->d_name);
  struct stat st;
  return w > 0 && (size_t)w < sizeof buf && lstat(buf, &st) == 0 ? scr_dirent_kind_of_mode(st.st_mode) : 0;
}
#endif

/* The next entry: true with a +1 name and its kind, false at the end (or
 * with ERR_DIR_CLOSED thrown). */
bool scr_dir_read(ScrDir *d, ScrStr **name, double *kind) {
  *name = NULL;
  *kind = 0;
  if (d->closed) {
    scr_dir_closed();
    return false;
  }
#ifdef _WIN32
  while (d->pending) {
    WIN32_FIND_DATAW entry = d->entry;
    d->pending = FindNextFileW(d->search, &d->entry) != 0;
    if (wcscmp(entry.cFileName, L".") == 0 || wcscmp(entry.cFileName, L"..") == 0) continue;
    ScrStr *text = scr_fs_win_utf8(entry.cFileName, wcslen(entry.cFileName));
    if (!text) {
      scr_fs_throw_nopath(scr_fs_win_errno(GetLastError()), "scandir");
      return false;
    }
    *name = text;
    *kind = (entry.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) && scr_stats_is_link_tag(entry.dwReserved0) ? 3
            : (entry.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) ? 2 : 1;
    return true;
  }
  return false;
#else
  for (;;) {
    errno = 0;
    const struct dirent *ent = readdir(d->stream);
    if (!ent) {
      if (errno) scr_fs_throw_nopath(errno, "scandir");
      return false;
    }
    if (strcmp(ent->d_name, ".") == 0 || strcmp(ent->d_name, "..") == 0) continue;
    *name = scr_str_new(ent->d_name, strlen(ent->d_name));
    *kind = scr_dir_entry_kind(d, ent);
    return true;
  }
#endif
}

void scr_dir_close(ScrDir *d) {
  if (d->closed) {
    scr_dir_closed();
    return;
  }
  d->closed = true;
  scr_dir_close_stream(d);
}

/* ── node:crypto ─────────────────────────────────────────────────────
 * Randomness comes from arc4random_buf. Hash/Hmac/PBKDF2 follow below;
 * Buffer allocation itself lives in scr_bytes_io.c, while this unit owns
 * the shared digest implementation and utility validation ladders. */

/* ── the scalar Math statics ─────────────────────────────────────────
 * Math.min/max at two arguments: the ECMA folds — C's fmin/fmax are NOT
 * these (they return the non-NaN operand where JS lets NaN poison, and
 * leave the ±0 order unspecified). Math.random(): a uniform double in
 * [0,1) at the spec's 53-bit granularity, drawn from arc4random_buf —
 * the same CSPRNG behind the crypto lowerings. Same distribution as
 * Node's, necessarily a different sequence (SEMANTICS.md 62); range and
 * granularity are pinned differentially by invariant, not by bytes. */

double scr_math_min(double a, double b) {
  if (isnan(a) || isnan(b)) return (double)NAN;
  if (a == 0.0 && b == 0.0) return signbit(a) ? a : b; /* -0 wins */
  return a < b ? a : b;
}

double scr_math_max(double a, double b) {
  if (isnan(a) || isnan(b)) return (double)NAN;
  if (a == 0.0 && b == 0.0) return signbit(a) ? b : a; /* +0 wins */
  return a > b ? a : b;
}

/* Math.round: ECMA half-toward-+Infinity. NOT C round() (half away from
 * zero: round(-1.5) is -2 where JS answers -1) and NOT floor(x + 0.5)
 * (the float ADD drifts at the epsilon boundary: 0.49999999999999994 +
 * 0.5 == 1.0 in doubles where the exact sum is below one — JS answers
 * 0). x - floor(x) is EXACT for doubles (Sterbenz), so the fraction
 * comparison decides losslessly; results in (-0.5, 0] keep the sign (JS:
 * Math.round(-0.3) is -0). */
double scr_math_round(double x) {
  if (isnan(x) || isinf(x) || x == 0.0) return x;
  double f = floor(x);
  double diff = x - f;
  double r = diff < 0.5 ? f : f + 1.0;
  return (r == 0.0 && x < 0.0) ? -0.0 : r;
}

/* IEEE pow(±1, ±Infinity) and pow(1, NaN) return 1; ECMAScript requires
 * NaN. The other special cases, including signed zero and odd integer
 * powers, follow libm. */
double scr_math_pow(double base, double exponent) {
  if (isnan(exponent) || (isinf(exponent) && fabs(base) == 1.0)) return NAN;
  /* 2 ** n for an integer n in the double range is an exact power of two,
   * the value pow returns; its bits are the exponent alone. */
  if (base == 2.0 && exponent >= -1074.0 && exponent <= 1023.0) {
    int32_t n = (int32_t)exponent;
    if ((double)n == exponent) {
      uint64_t bits = n >= -1022 ? (uint64_t)(n + 1023) << 52 : UINT64_C(1) << (n + 1074);
      double result;
      memcpy(&result, &bits, sizeof result);
      return result;
    }
  }
  return pow(base, exponent);
}

double scr_math_clz32(double x) {
  uint32_t bits = scr_to_uint32(x);
  if (bits == 0) return 32.0;
  unsigned count = 0;
  while ((bits & UINT32_C(0x80000000)) == 0) {
    bits <<= 1;
    count++;
  }
  return (double)count;
}

double scr_math_fround(double x) {
  return (double)(float)x;
}

double scr_math_imul(double a, double b) {
  uint32_t bits = scr_to_uint32(a) * scr_to_uint32(b);
  return bits >= UINT32_C(0x80000000)
             ? (double)(uint64_t)bits - 4294967296.0
             : (double)bits;
}

double scr_math_random(void) {
  uint64_t r;
  arc4random_buf(&r, sizeof r);
  /* The top 53 bits scaled by 2^-53: every representable k/2^53 in [0,1)
   * is equally likely — V8's own construction. */
  return (double)(r >> 11) * 0x1.0p-53;
}


/* randomBytes(n).toString(enc): n truncates like Node's (1.5 → 1 byte);
 * out-of-range n THROWS Node's RangeError verbatim. enc is "hex" or
 * "base64" (the compiler fences other encodings at the call site). */
ScrStr *scr_crypto_random_string(double n, ScrStr *enc) {
  if (!(n >= 0 && n <= 2147483647)) {
    char num[32];
    size_t numlen = scr_f64_to_str(n, num);
    char msg[128];
    int mlen = snprintf(msg, sizeof msg,
                        "The value of \"size\" is out of range. It must be >= 0 && <= 2147483647. Received %.*s",
                        (int)numlen, num);
    scr_throw_error_msg_code(SCR_ERR_RANGE, msg, (size_t)mlen, "ERR_OUT_OF_RANGE");
    return NULL;
  }
  size_t size = (size_t)n;
  unsigned char *bytes = malloc(size ? size : 1);
  if (!bytes) {
    scr_trap("scriptc: out of memory\n");
  }
  arc4random_buf(bytes, size);
  ScrStr *out;
  if (enc->len == 3 && memcmp(enc->data, "hex", 3) == 0) {
    static const char hex[] = "0123456789abcdef";
    char *buf = malloc(size * 2 + 1);
    if (!buf) {
      scr_trap("scriptc: out of memory\n");
    }
    for (size_t i = 0; i < size; i++) {
      buf[i * 2] = hex[bytes[i] >> 4];
      buf[i * 2 + 1] = hex[bytes[i] & 0x0f];
    }
    out = scr_str_new(buf, size * 2);
    free(buf);
  } else {
    /* base64, standard alphabet, '=' padded — Buffer.toString("base64"). */
    static const char b64[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    size_t outlen = (size + 2) / 3 * 4;
    char *buf = malloc(outlen + 1);
    if (!buf) {
      scr_trap("scriptc: out of memory\n");
    }
    size_t o = 0;
    for (size_t i = 0; i < size; i += 3) {
      unsigned v = (unsigned)bytes[i] << 16;
      if (i + 1 < size) v |= (unsigned)bytes[i + 1] << 8;
      if (i + 2 < size) v |= (unsigned)bytes[i + 2];
      buf[o++] = b64[(v >> 18) & 63];
      buf[o++] = b64[(v >> 12) & 63];
      buf[o++] = i + 1 < size ? b64[(v >> 6) & 63] : '=';
      buf[o++] = i + 2 < size ? b64[v & 63] : '=';
    }
    out = scr_str_new(buf, o);
    free(buf);
  }
  free(bytes);
  return out;
}

static const uint32_t scr_sha256_k[64] = {
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
    0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
    0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
    0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
    0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
    0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
    0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2};

static uint32_t scr_sha256_rotr(uint32_t x, unsigned n) {
  return (x >> n) | (x << (32 - n));
}

SCR_DIGEST_ALIGNED static void scr_sha256_block(uint32_t h[8], const unsigned char *p) {
  uint32_t w[64];
  for (int i = 0; i < 16; i++) {
    w[i] = ((uint32_t)p[i * 4] << 24) | ((uint32_t)p[i * 4 + 1] << 16) |
           ((uint32_t)p[i * 4 + 2] << 8) | (uint32_t)p[i * 4 + 3];
  }
  for (int i = 16; i < 64; i++) {
    uint32_t s0 = scr_sha256_rotr(w[i - 15], 7) ^ scr_sha256_rotr(w[i - 15], 18) ^ (w[i - 15] >> 3);
    uint32_t s1 = scr_sha256_rotr(w[i - 2], 17) ^ scr_sha256_rotr(w[i - 2], 19) ^ (w[i - 2] >> 10);
    w[i] = w[i - 16] + s0 + w[i - 7] + s1;
  }
  uint32_t a = h[0], b = h[1], c = h[2], d = h[3];
  uint32_t e = h[4], f = h[5], g = h[6], hh = h[7];
  for (int i = 0; i < 64; i++) {
    uint32_t s1 = scr_sha256_rotr(e, 6) ^ scr_sha256_rotr(e, 11) ^ scr_sha256_rotr(e, 25);
    uint32_t ch = (e & f) ^ (~e & g);
    uint32_t t1 = hh + s1 + ch + scr_sha256_k[i] + w[i];
    uint32_t s0 = scr_sha256_rotr(a, 2) ^ scr_sha256_rotr(a, 13) ^ scr_sha256_rotr(a, 22);
    uint32_t maj = (a & b) ^ (a & c) ^ (b & c);
    uint32_t t2 = s0 + maj;
    hh = g; g = f; f = e; e = d + t1;
    d = c; c = b; b = a; a = t1 + t2;
  }
  h[0] += a; h[1] += b; h[2] += c; h[3] += d;
  h[4] += e; h[5] += f; h[6] += g; h[7] += hh;
}

static void scr_sha1_block(uint32_t h[5], const unsigned char *p);

/* ── SHA-NI kernels (x86-64) ──────────────────────────────────────────
 * On CPUs with the SHA extensions, SHA-256 and SHA-1 process their
 * blocks with SHA256RNDS2/SHA1RNDS4 and the message-schedule
 * instructions; other CPUs and targets use the portable blocks above.
 * The CPU check runs once and is cached. */
#if defined(__x86_64__) && (defined(__clang__) || defined(__GNUC__))
#include <cpuid.h>
#include <immintrin.h>
#define SCR_SHA_NI 1

static int scr_sha_ni_state; /* 0 unknown, 1 available, 2 absent */

static bool scr_sha_ni(void) {
  if (scr_sha_ni_state == 0) {
    unsigned a, b, c, d;
    bool ok = __get_cpuid(1, &a, &b, &c, &d) && (c & bit_SSSE3) && (c & bit_SSE4_1) &&
              __get_cpuid_count(7, 0, &a, &b, &c, &d) && (b & bit_SHA);
    scr_sha_ni_state = ok ? 1 : 2;
  }
  return scr_sha_ni_state == 1;
}

__attribute__((target("sha,ssse3,sse4.1")))
static void scr_sha256_blocks_ni(uint32_t h[8], const unsigned char *p, size_t blocks) {
  const __m128i mask = _mm_set_epi64x(0x0c0d0e0f08090a0bULL, 0x0405060700010203ULL);
  __m128i tmp = _mm_shuffle_epi32(_mm_loadu_si128((const __m128i *)&h[0]), 0xB1); /* CDAB */
  __m128i state1 = _mm_shuffle_epi32(_mm_loadu_si128((const __m128i *)&h[4]), 0x1B); /* EFGH */
  __m128i state0 = _mm_alignr_epi8(tmp, state1, 8);    /* ABEF */
  state1 = _mm_blend_epi16(state1, tmp, 0xF0);         /* CDGH */
  for (; blocks != 0; blocks--, p += 64) {
    __m128i abef = state0, cdgh = state1;
    /* m[i & 3] holds W for the four rounds of group i; a slot gets
     * SHA256MSG1 once its neighbor is loaded, and SHA256MSG2 forms the
     * next words from it. */
    __m128i m[4];
#pragma GCC unroll 16
    for (int i = 0; i < 16; i++) {
      __m128i w;
      if (i < 4) {
        w = _mm_shuffle_epi8(_mm_loadu_si128((const __m128i *)(p + 16 * i)), mask);
      } else {
        w = _mm_add_epi32(m[i & 3], _mm_alignr_epi8(m[(i - 1) & 3], m[(i - 2) & 3], 4));
        w = _mm_sha256msg2_epu32(w, m[(i - 1) & 3]);
      }
      __m128i wk = _mm_add_epi32(w, _mm_loadu_si128((const __m128i *)&scr_sha256_k[4 * i]));
      state1 = _mm_sha256rnds2_epu32(state1, state0, wk);
      state0 = _mm_sha256rnds2_epu32(state0, state1, _mm_shuffle_epi32(wk, 0x0E));
      if (i >= 2 && i <= 13) m[(i - 2) & 3] = _mm_sha256msg1_epu32(m[(i - 2) & 3], m[(i - 1) & 3]);
      m[i & 3] = w;
    }
    state0 = _mm_add_epi32(state0, abef);
    state1 = _mm_add_epi32(state1, cdgh);
  }
  tmp = _mm_shuffle_epi32(state0, 0x1B);            /* FEBA */
  state1 = _mm_shuffle_epi32(state1, 0xB1);         /* DCHG */
  state0 = _mm_blend_epi16(tmp, state1, 0xF0);      /* DCBA */
  state1 = _mm_alignr_epi8(state1, tmp, 8);         /* ABEF */
  _mm_storeu_si128((__m128i *)&h[0], state0);
  _mm_storeu_si128((__m128i *)&h[4], state1);
}

__attribute__((target("sha,ssse3,sse4.1")))
static inline __m128i scr_sha1_rounds(__m128i abcd, __m128i e, int f) {
  switch (f) {
  case 0: return _mm_sha1rnds4_epu32(abcd, e, 0);
  case 1: return _mm_sha1rnds4_epu32(abcd, e, 1);
  case 2: return _mm_sha1rnds4_epu32(abcd, e, 2);
  default: return _mm_sha1rnds4_epu32(abcd, e, 3);
  }
}

__attribute__((target("sha,ssse3,sse4.1")))
static void scr_sha1_blocks_ni(uint32_t h[5], const unsigned char *p, size_t blocks) {
  const __m128i mask = _mm_set_epi64x(0x0001020304050607ULL, 0x08090a0b0c0d0e0fULL);
  __m128i abcd = _mm_shuffle_epi32(_mm_loadu_si128((const __m128i *)h), 0x1B);
  __m128i e0 = _mm_set_epi32((int)h[4], 0, 0, 0);
  for (; blocks != 0; blocks--, p += 64) {
    __m128i abcd_save = abcd, e_save = e0;
    __m128i m[4], e[2];
#pragma GCC unroll 4
    for (int i = 0; i < 4; i++) m[i] = _mm_shuffle_epi8(_mm_loadu_si128((const __m128i *)(p + 16 * i)), mask);
    e[0] = _mm_add_epi32(e0, m[0]);
    e[1] = abcd;
    abcd = scr_sha1_rounds(abcd, e[0], 0);
    /* Group g: E from the previous group's ABCD plus W[g], twenty rounds
     * per function. m[g & 3] holds W[g]; SHA1MSG1, XOR and SHA1MSG2 build
     * the words three, two and one groups ahead. */
#pragma GCC unroll 20
    for (int g = 1; g < 20; g++) {
      __m128i *cur = &e[g & 1];
      *cur = _mm_sha1nexte_epu32(*cur, m[g & 3]);
      e[(g + 1) & 1] = abcd;
      if (g >= 3 && g <= 18) m[(g + 1) & 3] = _mm_sha1msg2_epu32(m[(g + 1) & 3], m[g & 3]);
      abcd = scr_sha1_rounds(abcd, *cur, g / 5);
      if (g >= 1 && g <= 16) m[(g - 1) & 3] = _mm_sha1msg1_epu32(m[(g - 1) & 3], m[g & 3]);
      if (g >= 2 && g <= 17) m[(g - 2) & 3] = _mm_xor_si128(m[(g - 2) & 3], m[g & 3]);
    }
    e0 = _mm_sha1nexte_epu32(e[0], e_save);
    abcd = _mm_add_epi32(abcd, abcd_save);
  }
  _mm_storeu_si128((__m128i *)h, _mm_shuffle_epi32(abcd, 0x1B));
  h[4] = (uint32_t)_mm_extract_epi32(e0, 3);
}
#endif

static void scr_sha256_blocks(uint32_t h[8], const unsigned char *p, size_t blocks) {
#ifdef SCR_SHA_NI
  if (scr_sha_ni()) {
    scr_sha256_blocks_ni(h, p, blocks);
    return;
  }
#endif
  for (; blocks != 0; blocks--, p += 64) scr_sha256_block(h, p);
}

static void scr_sha1_blocks(uint32_t h[5], const unsigned char *p, size_t blocks) {
#ifdef SCR_SHA_NI
  if (scr_sha_ni()) {
    scr_sha1_blocks_ni(h, p, blocks);
    return;
  }
#endif
  for (; blocks != 0; blocks--, p += 64) scr_sha1_block(h, p);
}

typedef struct ScrSha256Ctx {
  uint32_t h[8];
  uint64_t bytes;
  unsigned char tail[64];
  size_t tail_len;
} ScrSha256Ctx;

static void scr_sha256_init(ScrSha256Ctx *ctx) {
  static const uint32_t initial[8] = {
      0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
      0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19};
  memcpy(ctx->h, initial, sizeof initial);
  ctx->bytes = 0;
  ctx->tail_len = 0;
}

static void scr_sha256_update(ScrSha256Ctx *ctx, const unsigned char *data, size_t len) {
  ctx->bytes += len;
  if (ctx->tail_len != 0) {
    size_t take = 64 - ctx->tail_len;
    if (take > len) take = len;
    memcpy(ctx->tail + ctx->tail_len, data, take);
    ctx->tail_len += take;
    data += take;
    len -= take;
    if (ctx->tail_len == 64) {
      scr_sha256_blocks(ctx->h, ctx->tail, 1);
      ctx->tail_len = 0;
    }
  }
  if (len >= 64) {
    size_t blocks = len / 64;
    scr_sha256_blocks(ctx->h, data, blocks);
    data += blocks * 64;
    len -= blocks * 64;
  }
  if (len != 0) {
    memcpy(ctx->tail, data, len);
    ctx->tail_len = len;
  }
}

/* Final block(s): the 0x80 terminator, zero padding, and 64-bit
 * big-endian bit length. Finalization reads a snapshot so Hash.copy()
 * remains a plain context copy and one-shot callers share this path. */
static size_t scr_sha256_final(const ScrSha256Ctx *source, unsigned char out[32]) {
  ScrSha256Ctx ctx = *source;
  unsigned char tail[128];
  size_t rem = ctx.tail_len;
  memcpy(tail, ctx.tail, rem);
  tail[rem] = 0x80;
  size_t pad = (rem + 1 + 8 <= 64) ? 64 : 128;
  memset(tail + rem + 1, 0, pad - rem - 1 - 8);
  uint64_t bits = ctx.bytes * 8;
  for (int b = 0; b < 8; b++) tail[pad - 1 - b] = (unsigned char)(bits >> (8 * b));
  scr_sha256_blocks(ctx.h, tail, pad / 64);
  for (int j = 0; j < 8; j++) {
    for (int b = 0; b < 4; b++) out[j * 4 + b] = (unsigned char)(ctx.h[j] >> (24 - 8 * b));
  }
  return 32;
}

/* ── SHA-1 (FIPS 180-4) — the RFC 6455 Sec-WebSocket-Accept hash ────── */

SCR_DIGEST_ALIGNED static void scr_sha1_block(uint32_t h[5], const unsigned char *p) {
  uint32_t w[80];
  for (int i = 0; i < 16; i++) {
    w[i] = ((uint32_t)p[i * 4] << 24) | ((uint32_t)p[i * 4 + 1] << 16) |
           ((uint32_t)p[i * 4 + 2] << 8) | (uint32_t)p[i * 4 + 3];
  }
  for (int i = 16; i < 80; i++) {
    uint32_t x = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16];
    w[i] = (x << 1) | (x >> 31);
  }
  uint32_t a = h[0], b = h[1], c = h[2], d = h[3], e = h[4];
  for (int i = 0; i < 80; i++) {
    uint32_t f, k;
    if (i < 20) { f = (b & c) | (~b & d); k = 0x5a827999; }
    else if (i < 40) { f = b ^ c ^ d; k = 0x6ed9eba1; }
    else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8f1bbcdc; }
    else { f = b ^ c ^ d; k = 0xca62c1d6; }
    uint32_t t = ((a << 5) | (a >> 27)) + f + e + k + w[i];
    e = d; d = c; c = ((b << 30) | (b >> 2)); b = a; a = t;
  }
  h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e;
}

typedef struct ScrSha1Ctx {
  uint32_t h[5];
  uint64_t bytes;
  unsigned char tail[64];
  size_t tail_len;
} ScrSha1Ctx;

static void scr_sha1_init(ScrSha1Ctx *ctx) {
  static const uint32_t initial[5] = {
      0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0};
  memcpy(ctx->h, initial, sizeof initial);
  ctx->bytes = 0;
  ctx->tail_len = 0;
}

static void scr_sha1_update(ScrSha1Ctx *ctx, const unsigned char *data, size_t len) {
  ctx->bytes += len;
  if (ctx->tail_len != 0) {
    size_t take = 64 - ctx->tail_len;
    if (take > len) take = len;
    memcpy(ctx->tail + ctx->tail_len, data, take);
    ctx->tail_len += take;
    data += take;
    len -= take;
    if (ctx->tail_len == 64) {
      scr_sha1_blocks(ctx->h, ctx->tail, 1);
      ctx->tail_len = 0;
    }
  }
  if (len >= 64) {
    size_t blocks = len / 64;
    scr_sha1_blocks(ctx->h, data, blocks);
    data += blocks * 64;
    len -= blocks * 64;
  }
  if (len != 0) {
    memcpy(ctx->tail, data, len);
    ctx->tail_len = len;
  }
}

static size_t scr_sha1_final(const ScrSha1Ctx *source, unsigned char out[32]) {
  ScrSha1Ctx ctx = *source;
  unsigned char tail[128];
  size_t rem = ctx.tail_len;
  memcpy(tail, ctx.tail, rem);
  tail[rem] = 0x80;
  size_t pad = (rem + 1 + 8 <= 64) ? 64 : 128;
  memset(tail + rem + 1, 0, pad - rem - 1 - 8);
  uint64_t bits = ctx.bytes * 8;
  for (int b = 0; b < 8; b++) tail[pad - 1 - b] = (unsigned char)(bits >> (8 * b));
  scr_sha1_blocks(ctx.h, tail, pad / 64);
  for (int j = 0; j < 5; j++) {
    for (int b = 0; b < 4; b++) out[j * 4 + b] = (unsigned char)(ctx.h[j] >> (24 - 8 * b));
  }
  return 20;
}

static size_t scr_sha1_digest(const unsigned char *data, size_t len, unsigned char out[32]) {
  ScrSha1Ctx ctx;
  scr_sha1_init(&ctx);
  scr_sha1_update(&ctx, data, len);
  return scr_sha1_final(&ctx, out);
}

static bool scr_digest_name_is(const char *name, size_t len, const char *literal);

static const char *const scr_crypto_encoding_names[] = {
    "hex", "base64", "base64url", "utf8", "latin1", "ascii", "utf16le",
};
enum { SCR_CRYPTO_HEX, SCR_CRYPTO_BASE64, SCR_CRYPTO_UTF8 = 3 };

/* Node's normalizeEncoding(): the index of a Buffer encoding's canonical
 * name, compared case-insensitively ("" is utf8), or -1 for a name it does
 * not know. */
static int scr_crypto_encoding(const char *name, size_t len) {
  if (len == 3 && memcmp(name, "hex", 3) == 0) return SCR_CRYPTO_HEX;
  if (len == 6 && memcmp(name, "base64", 6) == 0) return SCR_CRYPTO_BASE64;
  static const struct {
    const char *from;
    unsigned char to;
  } map[] = {
      {"hex", 0},    {"base64", 1}, {"base64url", 2}, {"utf8", 3},    {"utf-8", 3},
      {"latin1", 4}, {"binary", 4}, {"ascii", 5},     {"utf16le", 6}, {"utf-16le", 6},
      {"ucs2", 6},   {"ucs-2", 6},  {"", 3},
  };
  for (size_t i = 0; i < sizeof map / sizeof map[0]; i++) {
    if (scr_digest_name_is(name, len, map[i].from)) return map[i].to;
  }
  return -1;
}

/* Digest bytes as a string in a Buffer encoding (scr_crypto_encoding's
 * index). */
static ScrStr *scr_digest_encode(const unsigned char *d, size_t n, int enc) {
  if (n <= 64 && enc == SCR_CRYPTO_HEX) {
    static const char hex[] = "0123456789abcdef";
    char buf[128];
    for (size_t i = 0; i < n; i++) {
      buf[i * 2] = hex[d[i] >> 4];
      buf[i * 2 + 1] = hex[d[i] & 0x0f];
    }
    return scr_str_new(buf, n * 2);
  }
  if (n <= 64 && enc == SCR_CRYPTO_BASE64) {
    /* Standard alphabet, '=' padded: Buffer.toString("base64"). */
    static const char b64[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    char buf[88];
    size_t o = 0;
    for (size_t i = 0; i < n; i += 3) {
      unsigned v = (unsigned)d[i] << 16;
      if (i + 1 < n) v |= (unsigned)d[i + 1] << 8;
      if (i + 2 < n) v |= (unsigned)d[i + 2];
      buf[o++] = b64[(v >> 18) & 63];
      buf[o++] = b64[(v >> 12) & 63];
      buf[o++] = i + 1 < n ? b64[(v >> 6) & 63] : '=';
      buf[o++] = i + 2 < n ? b64[v & 63] : '=';
    }
    return scr_str_new(buf, o);
  }
  ScrBytes view = {.rc = 1, .len = n, .elem = SCR_BYTES_U8, .data = (unsigned char *)d};
  const char *canonical = scr_crypto_encoding_names[enc];
  ScrStr *name = scr_str_new(canonical, strlen(canonical));
  ScrStr *result = scr_bytes_to_str(&view, name);
  scr_str_release(name);
  return result;
}

/* ── MD5 (RFC 1321) ───────────────────────────────────────────────── */

/* The 64 steps are unrolled with their message word, constant and
 * rotation inlined. a + m + K does not depend on the previous step, so
 * each step's critical path is the round function of b, an add, the
 * rotate and the add of b. G is written as (b & d) + (c & ~d) (the two
 * terms share no bits) so that its c & ~d half joins that early sum. The
 * empty asm statement keeps the compiler from moving the constant's add
 * after the round function, which puts it back on the critical path. */
#if (defined(__GNUC__) || defined(__clang__)) && !defined(__wasm__)
#define SCR_MD5_PIN(v) __asm__("" : "+r"(v))
#else
#define SCR_MD5_PIN(v) ((void)0)
#endif
#define SCR_MD5_F(b, c, d) ((d) ^ ((b) & ((c) ^ (d))))
#define SCR_MD5_H(b, c, d) ((b) ^ (c) ^ (d))
#define SCR_MD5_I(b, c, d) ((c) ^ ((b) | ~(d)))
#define SCR_MD5_STEP(f, a, b, c, d, xk, s)        \
  do {                                            \
    (a) += (xk);                                  \
    SCR_MD5_PIN(a);                               \
    (a) += f((b), (c), (d));                      \
    (a) = ((a) << (s) | (a) >> (32 - (s))) + (b); \
  } while (0)
#define SCR_MD5_GSTEP(a, b, c, d, xk, s)          \
  do {                                            \
    (a) += ((c) & ~(d)) + (xk);                   \
    SCR_MD5_PIN(a);                               \
    (a) += (b) & (d);                             \
    (a) = ((a) << (s) | (a) >> (32 - (s))) + (b); \
  } while (0)

SCR_DIGEST_ALIGNED static void scr_md5_blocks(uint32_t h[4], const unsigned char *p, size_t blocks) {
  uint32_t a = h[0], b = h[1], c = h[2], d = h[3];
  for (; blocks != 0; blocks--, p += 64) {
    uint32_t m[16];
    for (int i = 0; i < 16; i++) {
      m[i] = (uint32_t)p[i * 4] | ((uint32_t)p[i * 4 + 1] << 8) |
             ((uint32_t)p[i * 4 + 2] << 16) | ((uint32_t)p[i * 4 + 3] << 24);
    }
    uint32_t a0 = a, b0 = b, c0 = c, d0 = d;
    SCR_MD5_STEP(SCR_MD5_F, a, b, c, d, m[0] + 0xd76aa478u, 7);
    SCR_MD5_STEP(SCR_MD5_F, d, a, b, c, m[1] + 0xe8c7b756u, 12);
    SCR_MD5_STEP(SCR_MD5_F, c, d, a, b, m[2] + 0x242070dbu, 17);
    SCR_MD5_STEP(SCR_MD5_F, b, c, d, a, m[3] + 0xc1bdceeeu, 22);
    SCR_MD5_STEP(SCR_MD5_F, a, b, c, d, m[4] + 0xf57c0fafu, 7);
    SCR_MD5_STEP(SCR_MD5_F, d, a, b, c, m[5] + 0x4787c62au, 12);
    SCR_MD5_STEP(SCR_MD5_F, c, d, a, b, m[6] + 0xa8304613u, 17);
    SCR_MD5_STEP(SCR_MD5_F, b, c, d, a, m[7] + 0xfd469501u, 22);
    SCR_MD5_STEP(SCR_MD5_F, a, b, c, d, m[8] + 0x698098d8u, 7);
    SCR_MD5_STEP(SCR_MD5_F, d, a, b, c, m[9] + 0x8b44f7afu, 12);
    SCR_MD5_STEP(SCR_MD5_F, c, d, a, b, m[10] + 0xffff5bb1u, 17);
    SCR_MD5_STEP(SCR_MD5_F, b, c, d, a, m[11] + 0x895cd7beu, 22);
    SCR_MD5_STEP(SCR_MD5_F, a, b, c, d, m[12] + 0x6b901122u, 7);
    SCR_MD5_STEP(SCR_MD5_F, d, a, b, c, m[13] + 0xfd987193u, 12);
    SCR_MD5_STEP(SCR_MD5_F, c, d, a, b, m[14] + 0xa679438eu, 17);
    SCR_MD5_STEP(SCR_MD5_F, b, c, d, a, m[15] + 0x49b40821u, 22);
    SCR_MD5_GSTEP(a, b, c, d, m[1] + 0xf61e2562u, 5);
    SCR_MD5_GSTEP(d, a, b, c, m[6] + 0xc040b340u, 9);
    SCR_MD5_GSTEP(c, d, a, b, m[11] + 0x265e5a51u, 14);
    SCR_MD5_GSTEP(b, c, d, a, m[0] + 0xe9b6c7aau, 20);
    SCR_MD5_GSTEP(a, b, c, d, m[5] + 0xd62f105du, 5);
    SCR_MD5_GSTEP(d, a, b, c, m[10] + 0x02441453u, 9);
    SCR_MD5_GSTEP(c, d, a, b, m[15] + 0xd8a1e681u, 14);
    SCR_MD5_GSTEP(b, c, d, a, m[4] + 0xe7d3fbc8u, 20);
    SCR_MD5_GSTEP(a, b, c, d, m[9] + 0x21e1cde6u, 5);
    SCR_MD5_GSTEP(d, a, b, c, m[14] + 0xc33707d6u, 9);
    SCR_MD5_GSTEP(c, d, a, b, m[3] + 0xf4d50d87u, 14);
    SCR_MD5_GSTEP(b, c, d, a, m[8] + 0x455a14edu, 20);
    SCR_MD5_GSTEP(a, b, c, d, m[13] + 0xa9e3e905u, 5);
    SCR_MD5_GSTEP(d, a, b, c, m[2] + 0xfcefa3f8u, 9);
    SCR_MD5_GSTEP(c, d, a, b, m[7] + 0x676f02d9u, 14);
    SCR_MD5_GSTEP(b, c, d, a, m[12] + 0x8d2a4c8au, 20);
    SCR_MD5_STEP(SCR_MD5_H, a, b, c, d, m[5] + 0xfffa3942u, 4);
    SCR_MD5_STEP(SCR_MD5_H, d, a, b, c, m[8] + 0x8771f681u, 11);
    SCR_MD5_STEP(SCR_MD5_H, c, d, a, b, m[11] + 0x6d9d6122u, 16);
    SCR_MD5_STEP(SCR_MD5_H, b, c, d, a, m[14] + 0xfde5380cu, 23);
    SCR_MD5_STEP(SCR_MD5_H, a, b, c, d, m[1] + 0xa4beea44u, 4);
    SCR_MD5_STEP(SCR_MD5_H, d, a, b, c, m[4] + 0x4bdecfa9u, 11);
    SCR_MD5_STEP(SCR_MD5_H, c, d, a, b, m[7] + 0xf6bb4b60u, 16);
    SCR_MD5_STEP(SCR_MD5_H, b, c, d, a, m[10] + 0xbebfbc70u, 23);
    SCR_MD5_STEP(SCR_MD5_H, a, b, c, d, m[13] + 0x289b7ec6u, 4);
    SCR_MD5_STEP(SCR_MD5_H, d, a, b, c, m[0] + 0xeaa127fau, 11);
    SCR_MD5_STEP(SCR_MD5_H, c, d, a, b, m[3] + 0xd4ef3085u, 16);
    SCR_MD5_STEP(SCR_MD5_H, b, c, d, a, m[6] + 0x04881d05u, 23);
    SCR_MD5_STEP(SCR_MD5_H, a, b, c, d, m[9] + 0xd9d4d039u, 4);
    SCR_MD5_STEP(SCR_MD5_H, d, a, b, c, m[12] + 0xe6db99e5u, 11);
    SCR_MD5_STEP(SCR_MD5_H, c, d, a, b, m[15] + 0x1fa27cf8u, 16);
    SCR_MD5_STEP(SCR_MD5_H, b, c, d, a, m[2] + 0xc4ac5665u, 23);
    SCR_MD5_STEP(SCR_MD5_I, a, b, c, d, m[0] + 0xf4292244u, 6);
    SCR_MD5_STEP(SCR_MD5_I, d, a, b, c, m[7] + 0x432aff97u, 10);
    SCR_MD5_STEP(SCR_MD5_I, c, d, a, b, m[14] + 0xab9423a7u, 15);
    SCR_MD5_STEP(SCR_MD5_I, b, c, d, a, m[5] + 0xfc93a039u, 21);
    SCR_MD5_STEP(SCR_MD5_I, a, b, c, d, m[12] + 0x655b59c3u, 6);
    SCR_MD5_STEP(SCR_MD5_I, d, a, b, c, m[3] + 0x8f0ccc92u, 10);
    SCR_MD5_STEP(SCR_MD5_I, c, d, a, b, m[10] + 0xffeff47du, 15);
    SCR_MD5_STEP(SCR_MD5_I, b, c, d, a, m[1] + 0x85845dd1u, 21);
    SCR_MD5_STEP(SCR_MD5_I, a, b, c, d, m[8] + 0x6fa87e4fu, 6);
    SCR_MD5_STEP(SCR_MD5_I, d, a, b, c, m[15] + 0xfe2ce6e0u, 10);
    SCR_MD5_STEP(SCR_MD5_I, c, d, a, b, m[6] + 0xa3014314u, 15);
    SCR_MD5_STEP(SCR_MD5_I, b, c, d, a, m[13] + 0x4e0811a1u, 21);
    SCR_MD5_STEP(SCR_MD5_I, a, b, c, d, m[4] + 0xf7537e82u, 6);
    SCR_MD5_STEP(SCR_MD5_I, d, a, b, c, m[11] + 0xbd3af235u, 10);
    SCR_MD5_STEP(SCR_MD5_I, c, d, a, b, m[2] + 0x2ad7d2bbu, 15);
    SCR_MD5_STEP(SCR_MD5_I, b, c, d, a, m[9] + 0xeb86d391u, 21);
    a += a0; b += b0; c += c0; d += d0;
  }
  h[0] = a; h[1] = b; h[2] = c; h[3] = d;
}

typedef struct ScrMd5Ctx {
  uint32_t h[4];
  uint64_t bytes;
  unsigned char tail[64];
  size_t tail_len;
} ScrMd5Ctx;

static void scr_md5_init(ScrMd5Ctx *ctx) {
  static const uint32_t initial[4] = {
      0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476};
  memcpy(ctx->h, initial, sizeof initial);
  ctx->bytes = 0;
  ctx->tail_len = 0;
}

static void scr_md5_update(ScrMd5Ctx *ctx, const unsigned char *data, size_t len) {
  ctx->bytes += len;
  if (ctx->tail_len != 0) {
    size_t take = 64 - ctx->tail_len;
    if (take > len) take = len;
    memcpy(ctx->tail + ctx->tail_len, data, take);
    ctx->tail_len += take;
    data += take;
    len -= take;
    if (ctx->tail_len == 64) {
      scr_md5_blocks(ctx->h, ctx->tail, 1);
      ctx->tail_len = 0;
    }
  }
  if (len >= 64) {
    size_t blocks = len / 64;
    scr_md5_blocks(ctx->h, data, blocks);
    data += blocks * 64;
    len -= blocks * 64;
  }
  if (len != 0) {
    memcpy(ctx->tail, data, len);
    ctx->tail_len = len;
  }
}

static size_t scr_md5_final(const ScrMd5Ctx *source, unsigned char out[32]) {
  ScrMd5Ctx ctx = *source;
  unsigned char tail[128];
  size_t rem = ctx.tail_len;
  memcpy(tail, ctx.tail, rem);
  tail[rem] = 0x80;
  size_t pad = (rem + 1 + 8 <= 64) ? 64 : 128;
  memset(tail + rem + 1, 0, pad - rem - 1 - 8);
  uint64_t bits = ctx.bytes * 8;
  for (int b = 0; b < 8; b++) tail[pad - 8 + b] = (unsigned char)(bits >> (8 * b));
  scr_md5_blocks(ctx.h, tail, pad / 64);
  for (int j = 0; j < 4; j++) {
    for (int b = 0; b < 4; b++) out[j * 4 + b] = (unsigned char)(ctx.h[j] >> (8 * b));
  }
  return 16;
}

/* SHA-384/SHA-512, FIPS 180-4. The 128-byte blocks and HMAC pads differ
 * from SHA-256; the digest dispatcher keeps that distinction explicit. */
typedef struct ScrSha512Ctx {
  uint64_t h[8];
  uint64_t bytes;
  unsigned char tail[128];
  size_t tail_len;
} ScrSha512Ctx;

static const uint64_t scr_sha512_k[80] = {
  UINT64_C(0x428a2f98d728ae22), UINT64_C(0x7137449123ef65cd), UINT64_C(0xb5c0fbcfec4d3b2f),
  UINT64_C(0xe9b5dba58189dbbc), UINT64_C(0x3956c25bf348b538), UINT64_C(0x59f111f1b605d019),
  UINT64_C(0x923f82a4af194f9b), UINT64_C(0xab1c5ed5da6d8118), UINT64_C(0xd807aa98a3030242),
  UINT64_C(0x12835b0145706fbe), UINT64_C(0x243185be4ee4b28c), UINT64_C(0x550c7dc3d5ffb4e2),
  UINT64_C(0x72be5d74f27b896f), UINT64_C(0x80deb1fe3b1696b1), UINT64_C(0x9bdc06a725c71235),
  UINT64_C(0xc19bf174cf692694), UINT64_C(0xe49b69c19ef14ad2), UINT64_C(0xefbe4786384f25e3),
  UINT64_C(0x0fc19dc68b8cd5b5), UINT64_C(0x240ca1cc77ac9c65), UINT64_C(0x2de92c6f592b0275),
  UINT64_C(0x4a7484aa6ea6e483), UINT64_C(0x5cb0a9dcbd41fbd4), UINT64_C(0x76f988da831153b5),
  UINT64_C(0x983e5152ee66dfab), UINT64_C(0xa831c66d2db43210), UINT64_C(0xb00327c898fb213f),
  UINT64_C(0xbf597fc7beef0ee4), UINT64_C(0xc6e00bf33da88fc2), UINT64_C(0xd5a79147930aa725),
  UINT64_C(0x06ca6351e003826f), UINT64_C(0x142929670a0e6e70), UINT64_C(0x27b70a8546d22ffc),
  UINT64_C(0x2e1b21385c26c926), UINT64_C(0x4d2c6dfc5ac42aed), UINT64_C(0x53380d139d95b3df),
  UINT64_C(0x650a73548baf63de), UINT64_C(0x766a0abb3c77b2a8), UINT64_C(0x81c2c92e47edaee6),
  UINT64_C(0x92722c851482353b), UINT64_C(0xa2bfe8a14cf10364), UINT64_C(0xa81a664bbc423001),
  UINT64_C(0xc24b8b70d0f89791), UINT64_C(0xc76c51a30654be30), UINT64_C(0xd192e819d6ef5218),
  UINT64_C(0xd69906245565a910), UINT64_C(0xf40e35855771202a), UINT64_C(0x106aa07032bbd1b8),
  UINT64_C(0x19a4c116b8d2d0c8), UINT64_C(0x1e376c085141ab53), UINT64_C(0x2748774cdf8eeb99),
  UINT64_C(0x34b0bcb5e19b48a8), UINT64_C(0x391c0cb3c5c95a63), UINT64_C(0x4ed8aa4ae3418acb),
  UINT64_C(0x5b9cca4f7763e373), UINT64_C(0x682e6ff3d6b2b8a3), UINT64_C(0x748f82ee5defb2fc),
  UINT64_C(0x78a5636f43172f60), UINT64_C(0x84c87814a1f0ab72), UINT64_C(0x8cc702081a6439ec),
  UINT64_C(0x90befffa23631e28), UINT64_C(0xa4506cebde82bde9), UINT64_C(0xbef9a3f7b2c67915),
  UINT64_C(0xc67178f2e372532b), UINT64_C(0xca273eceea26619c), UINT64_C(0xd186b8c721c0c207),
  UINT64_C(0xeada7dd6cde0eb1e), UINT64_C(0xf57d4f7fee6ed178), UINT64_C(0x06f067aa72176fba),
  UINT64_C(0x0a637dc5a2c898a6), UINT64_C(0x113f9804bef90dae), UINT64_C(0x1b710b35131c471b),
  UINT64_C(0x28db77f523047d84), UINT64_C(0x32caab7b40c72493), UINT64_C(0x3c9ebe0a15c9bebc),
  UINT64_C(0x431d67c49c100d4c), UINT64_C(0x4cc5d4becb3e42b6), UINT64_C(0x597f299cfc657e2a),
  UINT64_C(0x5fcb6fab3ad6faec), UINT64_C(0x6c44198c4a475817),
};

static uint64_t scr_sha512_rotr(uint64_t x, unsigned n) {
  return (x >> n) | (x << (64 - n));
}

#define SCR_SHA512_BSIG0(x) \
  (scr_sha512_rotr(x, 28) ^ scr_sha512_rotr(x, 34) ^ scr_sha512_rotr(x, 39))
#define SCR_SHA512_BSIG1(x) \
  (scr_sha512_rotr(x, 14) ^ scr_sha512_rotr(x, 18) ^ scr_sha512_rotr(x, 41))
#define SCR_SHA512_SSIG0(x) (scr_sha512_rotr(x, 1) ^ scr_sha512_rotr(x, 8) ^ ((x) >> 7))
#define SCR_SHA512_SSIG1(x) (scr_sha512_rotr(x, 19) ^ scr_sha512_rotr(x, 61) ^ ((x) >> 6))

/* One round with the eight working variables passed in rotated order, so
 * an unrolled sequence of rounds needs no register moves. */
#define SCR_SHA512_ROUND(a, b, c, d, e, f, g, h, k, w)                                  \
  do {                                                                                  \
    uint64_t t1 = (h) + SCR_SHA512_BSIG1(e) + ((g) ^ ((e) & ((f) ^ (g)))) + (k) + (w); \
    (d) += t1;                                                                          \
    (h) = t1 + SCR_SHA512_BSIG0(a) + (((a) & (b)) | ((c) & ((a) | (b))));               \
  } while (0)

static uint64_t scr_sha512_load(const unsigned char *p) {
  uint64_t v = 0;
  for (size_t b = 0; b < 8; b++) v = (v << 8) | p[b];
  return v;
}

/* The message schedule is kept as a 16-word ring and extended 16 words
 * at a time between groups of 16 rounds. */
SCR_DIGEST_ALIGNED static void scr_sha512_blocks_portable(uint64_t state[8], const unsigned char *p,
                                                          size_t blocks) {
  uint64_t a = state[0], b = state[1], c = state[2], d = state[3];
  uint64_t e = state[4], f = state[5], g = state[6], h = state[7];
  for (; blocks != 0; blocks--, p += 128) {
    uint64_t w[16];
    for (size_t i = 0; i < 16; i++) w[i] = scr_sha512_load(p + i * 8);
    for (size_t i = 0; i < 80; i += 16) {
      if (i != 0) {
        for (size_t j = 0; j < 16; j++) {
          w[j] += SCR_SHA512_SSIG1(w[(j + 14) & 15]) + w[(j + 9) & 15] +
                  SCR_SHA512_SSIG0(w[(j + 1) & 15]);
        }
      }
      const uint64_t *k = scr_sha512_k + i;
      SCR_SHA512_ROUND(a, b, c, d, e, f, g, h, k[0], w[0]);
      SCR_SHA512_ROUND(h, a, b, c, d, e, f, g, k[1], w[1]);
      SCR_SHA512_ROUND(g, h, a, b, c, d, e, f, k[2], w[2]);
      SCR_SHA512_ROUND(f, g, h, a, b, c, d, e, k[3], w[3]);
      SCR_SHA512_ROUND(e, f, g, h, a, b, c, d, k[4], w[4]);
      SCR_SHA512_ROUND(d, e, f, g, h, a, b, c, k[5], w[5]);
      SCR_SHA512_ROUND(c, d, e, f, g, h, a, b, k[6], w[6]);
      SCR_SHA512_ROUND(b, c, d, e, f, g, h, a, k[7], w[7]);
      SCR_SHA512_ROUND(a, b, c, d, e, f, g, h, k[8], w[8]);
      SCR_SHA512_ROUND(h, a, b, c, d, e, f, g, k[9], w[9]);
      SCR_SHA512_ROUND(g, h, a, b, c, d, e, f, k[10], w[10]);
      SCR_SHA512_ROUND(f, g, h, a, b, c, d, e, k[11], w[11]);
      SCR_SHA512_ROUND(e, f, g, h, a, b, c, d, k[12], w[12]);
      SCR_SHA512_ROUND(d, e, f, g, h, a, b, c, k[13], w[13]);
      SCR_SHA512_ROUND(c, d, e, f, g, h, a, b, k[14], w[14]);
      SCR_SHA512_ROUND(b, c, d, e, f, g, h, a, k[15], w[15]);
    }
    a = state[0] += a; b = state[1] += b; c = state[2] += c; d = state[3] += d;
    e = state[4] += e; f = state[5] += f; g = state[6] += g; h = state[7] += h;
  }
}

#ifdef SCR_SHA_NI
/* ── SHA-512 kernels (x86-64) ─────────────────────────────────────────
 * With AVX2 and BMI2, the message schedule is computed two words at a
 * time in vector registers, interleaved with the scalar rounds, and the
 * rounds rotate with RORX. With AVX-512VL the schedule uses vector
 * rotates and three-input XOR. The CPU and OS state checks run once and
 * are cached. */
static int scr_sha512_x86_state; /* 0 unknown, 1 portable, 2 AVX2, 3 AVX-512VL */

static int scr_sha512_x86(void) {
  if (scr_sha512_x86_state == 0) {
    unsigned a, b, c, d;
    int kind = 1;
    if (__get_cpuid(1, &a, &b, &c, &d) && (c & bit_OSXSAVE) && (c & bit_AVX)) {
      unsigned lo, hi;
      __asm__ volatile("xgetbv" : "=a"(lo), "=d"(hi) : "c"(0));
      (void)hi;
      /* XMM and YMM state enabled. */
      if ((lo & 6) == 6 && __get_cpuid_count(7, 0, &a, &b, &c, &d) && (b & bit_AVX2) &&
          (b & bit_BMI2)) {
        kind = 2;
        /* Opmask, ZMM0-15 upper halves and ZMM16-31 state enabled. */
        if ((b & bit_AVX512F) && (b & bit_AVX512VL) && (lo & 0xe0) == 0xe0) kind = 3;
      }
    }
    scr_sha512_x86_state = kind;
  }
  return scr_sha512_x86_state;
}

__attribute__((target("avx2,bmi2"))) static inline __m128i scr_sha512_ssig0_avx2(__m128i x) {
  return _mm_xor_si128(_mm_xor_si128(_mm_or_si128(_mm_srli_epi64(x, 1), _mm_slli_epi64(x, 63)),
                                     _mm_or_si128(_mm_srli_epi64(x, 8), _mm_slli_epi64(x, 56))),
                       _mm_srli_epi64(x, 7));
}

__attribute__((target("avx2,bmi2"))) static inline __m128i scr_sha512_ssig1_avx2(__m128i x) {
  return _mm_xor_si128(_mm_xor_si128(_mm_or_si128(_mm_srli_epi64(x, 19), _mm_slli_epi64(x, 45)),
                                     _mm_or_si128(_mm_srli_epi64(x, 61), _mm_slli_epi64(x, 3))),
                       _mm_srli_epi64(x, 6));
}

__attribute__((target("avx512f,avx512vl,bmi2"))) static inline __m128i
scr_sha512_ssig0_avx512(__m128i x) {
  return _mm_ternarylogic_epi64(_mm_ror_epi64(x, 1), _mm_ror_epi64(x, 8), _mm_srli_epi64(x, 7),
                                0x96);
}

__attribute__((target("avx512f,avx512vl,bmi2"))) static inline __m128i
scr_sha512_ssig1_avx512(__m128i x) {
  return _mm_ternarylogic_epi64(_mm_ror_epi64(x, 19), _mm_ror_epi64(x, 61), _mm_srli_epi64(x, 6),
                                0x96);
}

/* A round for the vector kernels. wk is the schedule word plus its
 * constant. Maj(a, b, c) is ((a ^ b) & (b ^ c)) ^ b, where b ^ c is the
 * previous round's a ^ b. The empty asm statements keep the compiler from
 * reassociating the additions: adding Sigma1(e) last keeps the sum of h,
 * wk and Ch off the dependency chain through e. */
#define SCR_SHA512_PIN(v) __asm__("" : "+r"(v))
#define SCR_SHA512_ROUND_WK(a, b, c, d, e, f, g, h, wk, ab, bc) \
  do {                                                          \
    uint64_t t1 = (h) + (wk);                                   \
    SCR_SHA512_PIN(t1);                                         \
    t1 += (g) ^ ((e) & ((f) ^ (g)));                            \
    SCR_SHA512_PIN(t1);                                         \
    t1 += SCR_SHA512_BSIG1(e);                                  \
    SCR_SHA512_PIN(t1);                                         \
    (d) += t1;                                                  \
    (ab) = (a) ^ (b);                                           \
    uint64_t m = t1 + (((ab) & (bc)) ^ (b));                    \
    SCR_SHA512_PIN(m);                                          \
    (h) = m + SCR_SHA512_BSIG0(a);                              \
  } while (0)

/* Words 2j and 2j+1 of the schedule, in the ring slot of words 2j-16 and
 * 2j-15, and their sum with the round constants into wk. */
#define SCR_SHA512_SCHEDULE(j, ssig0, ssig1)                                                     \
  do {                                                                                           \
    if ((j) < 40) {                                                                              \
      __m128i s15 = _mm_alignr_epi8(w[((j) + 1) & 7], w[(j) & 7], 8);                           \
      __m128i s7 = _mm_alignr_epi8(w[((j) + 5) & 7], w[((j) + 4) & 7], 8);                      \
      __m128i next = _mm_add_epi64(_mm_add_epi64(w[(j) & 7], ssig0(s15)),                       \
                                   _mm_add_epi64(s7, ssig1(w[((j) + 7) & 7])));                 \
      w[(j) & 7] = next;                                                                         \
      _mm_store_si128((__m128i *)&wk[(j) * 2],                                                   \
                      _mm_add_epi64(next, _mm_loadu_si128((const __m128i *)&scr_sha512_k[(j) * 2]))); \
    }                                                                                            \
  } while (0)

/* Rounds 2i to 2i+7 compute the schedule words 2i+16 to 2i+23. */
#define SCR_SHA512_VECTOR_BODY(ssig0, ssig1)                                                   \
  const __m128i bswap = _mm_set_epi64x(0x08090a0b0c0d0e0fULL, 0x0001020304050607ULL);         \
  uint64_t a = state[0], b = state[1], c = state[2], d = state[3];                             \
  uint64_t e = state[4], f = state[5], g = state[6], h = state[7];                             \
  for (; blocks != 0; blocks--, p += 128) {                                                    \
    __m128i w[8];                                                                              \
    uint64_t wk[80] __attribute__((aligned(16)));                                              \
    _Pragma("GCC unroll 8") for (int i = 0; i < 8; i++) {                                      \
      w[i] = _mm_shuffle_epi8(_mm_loadu_si128((const __m128i *)(p + i * 16)), bswap);          \
      _mm_store_si128((__m128i *)&wk[i * 2],                                                   \
                      _mm_add_epi64(w[i], _mm_loadu_si128((const __m128i *)&scr_sha512_k[i * 2]))); \
    }                                                                                          \
    uint64_t x = b ^ c, y;                                                                     \
    _Pragma("GCC unroll 10") for (int i = 0; i < 40; i += 4) {                                 \
      SCR_SHA512_SCHEDULE(i + 8, ssig0, ssig1);                                                \
      SCR_SHA512_ROUND_WK(a, b, c, d, e, f, g, h, wk[2 * i + 0], y, x);                        \
      SCR_SHA512_ROUND_WK(h, a, b, c, d, e, f, g, wk[2 * i + 1], x, y);                        \
      SCR_SHA512_SCHEDULE(i + 9, ssig0, ssig1);                                                \
      SCR_SHA512_ROUND_WK(g, h, a, b, c, d, e, f, wk[2 * i + 2], y, x);                        \
      SCR_SHA512_ROUND_WK(f, g, h, a, b, c, d, e, wk[2 * i + 3], x, y);                        \
      SCR_SHA512_SCHEDULE(i + 10, ssig0, ssig1);                                               \
      SCR_SHA512_ROUND_WK(e, f, g, h, a, b, c, d, wk[2 * i + 4], y, x);                        \
      SCR_SHA512_ROUND_WK(d, e, f, g, h, a, b, c, wk[2 * i + 5], x, y);                        \
      SCR_SHA512_SCHEDULE(i + 11, ssig0, ssig1);                                               \
      SCR_SHA512_ROUND_WK(c, d, e, f, g, h, a, b, wk[2 * i + 6], y, x);                        \
      SCR_SHA512_ROUND_WK(b, c, d, e, f, g, h, a, wk[2 * i + 7], x, y);                        \
    }                                                                                          \
    a = state[0] += a; b = state[1] += b; c = state[2] += c; d = state[3] += d;                \
    e = state[4] += e; f = state[5] += f; g = state[6] += g; h = state[7] += h;                \
  }

__attribute__((target("avx2,bmi2"), aligned(64))) static void
scr_sha512_blocks_avx2(uint64_t state[8], const unsigned char *p, size_t blocks) {
  SCR_SHA512_VECTOR_BODY(scr_sha512_ssig0_avx2, scr_sha512_ssig1_avx2)
}

__attribute__((target("avx512f,avx512vl,bmi2"), aligned(64))) static void
scr_sha512_blocks_avx512(uint64_t state[8], const unsigned char *p, size_t blocks) {
  SCR_SHA512_VECTOR_BODY(scr_sha512_ssig0_avx512, scr_sha512_ssig1_avx512)
}
#endif


#if defined(__aarch64__) && (defined(__clang__) || defined(__GNUC__)) && !defined(_WIN32)
/* ── SHA-512 kernel (arm64) ───────────────────────────────────────────
 * On CPUs with the SHA-512 extension (FEAT_SHA512), the blocks run with
 * SHA512H, SHA512H2, SHA512SU0 and SHA512SU1; other CPUs use the portable
 * blocks. The CPU check runs once and is cached. */
#include <arm_neon.h>
#if defined(__APPLE__)
#include <sys/sysctl.h>
#else
#include <sys/auxv.h>
#endif
#define SCR_SHA512_ARM 1
#if defined(__clang__)
#define SCR_SHA512_ARM_TARGET __attribute__((target("sha3")))
#else
#define SCR_SHA512_ARM_TARGET __attribute__((target("+sha3")))
#endif

static int scr_sha512_arm_state; /* 0 unknown, 1 available, 2 absent */

static bool scr_sha512_arm(void) {
  if (scr_sha512_arm_state == 0) {
    bool ok;
#if defined(__APPLE__)
    int value = 0;
    size_t size = sizeof value;
    ok = sysctlbyname("hw.optional.armv8_2_sha512", &value, &size, NULL, 0) == 0 && value != 0;
#else
    ok = (getauxval(AT_HWCAP) & (1ul << 21)) != 0; /* HWCAP_SHA512 */
#endif
    scr_sha512_arm_state = ok ? 1 : 2;
  }
  return scr_sha512_arm_state == 1;
}

/* Two rounds per step. With the state pairs in the roles (A, B, C, D) =
 * (ab, cd, ef, gh), a step computes I = SHA512H(swap(K + W) + D, ext(C, D),
 * ext(B, C)), D = SHA512H2(I, B, A) and B += I; the roles then rotate to
 * (D, A, B, C). */
#define SCR_SHA512_ARM_STEP(A, B, C, D, msg, k)                                                \
  do {                                                                                         \
    uint64x2_t kw = vaddq_u64((msg), vld1q_u64(k));                                            \
    uint64x2_t sum = vaddq_u64(vextq_u64(kw, kw, 1), (D));                                     \
    uint64x2_t i = vsha512hq_u64(sum, vextq_u64((C), (D), 1), vextq_u64((B), (C), 1));         \
    (D) = vsha512h2q_u64(i, (B), (A));                                                         \
    (B) = vaddq_u64((B), i);                                                                   \
  } while (0)

/* Message words 2j and 2j+1 from the eight pairs before them. */
#define SCR_SHA512_ARM_SCHEDULE(m0, m1, m4, m5, m7) \
  (m0) = vsha512su1q_u64(vsha512su0q_u64((m0), (m1)), (m7), vextq_u64((m4), (m5), 1))

SCR_SHA512_ARM_TARGET static void scr_sha512_blocks_arm(uint64_t state[8], const unsigned char *p,
                                                         size_t blocks) {
  uint64x2_t ab = vld1q_u64(&state[0]), cd = vld1q_u64(&state[2]);
  uint64x2_t ef = vld1q_u64(&state[4]), gh = vld1q_u64(&state[6]);
  for (; blocks != 0; blocks--, p += 128) {
    uint64x2_t ab0 = ab, cd0 = cd, ef0 = ef, gh0 = gh;
    uint64x2_t m0 = vreinterpretq_u64_u8(vrev64q_u8(vld1q_u8(p + 0)));
    uint64x2_t m1 = vreinterpretq_u64_u8(vrev64q_u8(vld1q_u8(p + 16)));
    uint64x2_t m2 = vreinterpretq_u64_u8(vrev64q_u8(vld1q_u8(p + 32)));
    uint64x2_t m3 = vreinterpretq_u64_u8(vrev64q_u8(vld1q_u8(p + 48)));
    uint64x2_t m4 = vreinterpretq_u64_u8(vrev64q_u8(vld1q_u8(p + 64)));
    uint64x2_t m5 = vreinterpretq_u64_u8(vrev64q_u8(vld1q_u8(p + 80)));
    uint64x2_t m6 = vreinterpretq_u64_u8(vrev64q_u8(vld1q_u8(p + 96)));
    uint64x2_t m7 = vreinterpretq_u64_u8(vrev64q_u8(vld1q_u8(p + 112)));
    const uint64_t *k = scr_sha512_k;
    for (int i = 0; i < 5; i++, k += 16) {
      SCR_SHA512_ARM_STEP(ab, cd, ef, gh, m0, k + 0);
      SCR_SHA512_ARM_STEP(gh, ab, cd, ef, m1, k + 2);
      SCR_SHA512_ARM_STEP(ef, gh, ab, cd, m2, k + 4);
      SCR_SHA512_ARM_STEP(cd, ef, gh, ab, m3, k + 6);
      SCR_SHA512_ARM_STEP(ab, cd, ef, gh, m4, k + 8);
      SCR_SHA512_ARM_STEP(gh, ab, cd, ef, m5, k + 10);
      SCR_SHA512_ARM_STEP(ef, gh, ab, cd, m6, k + 12);
      SCR_SHA512_ARM_STEP(cd, ef, gh, ab, m7, k + 14);
      if (i == 4) break;
      SCR_SHA512_ARM_SCHEDULE(m0, m1, m4, m5, m7);
      SCR_SHA512_ARM_SCHEDULE(m1, m2, m5, m6, m0);
      SCR_SHA512_ARM_SCHEDULE(m2, m3, m6, m7, m1);
      SCR_SHA512_ARM_SCHEDULE(m3, m4, m7, m0, m2);
      SCR_SHA512_ARM_SCHEDULE(m4, m5, m0, m1, m3);
      SCR_SHA512_ARM_SCHEDULE(m5, m6, m1, m2, m4);
      SCR_SHA512_ARM_SCHEDULE(m6, m7, m2, m3, m5);
      SCR_SHA512_ARM_SCHEDULE(m7, m0, m3, m4, m6);
    }
    ab = vaddq_u64(ab, ab0);
    cd = vaddq_u64(cd, cd0);
    ef = vaddq_u64(ef, ef0);
    gh = vaddq_u64(gh, gh0);
  }
  vst1q_u64(&state[0], ab);
  vst1q_u64(&state[2], cd);
  vst1q_u64(&state[4], ef);
  vst1q_u64(&state[6], gh);
}
#endif

static void scr_sha512_blocks(uint64_t h[8], const unsigned char *p, size_t blocks) {
#ifdef SCR_SHA_NI
  switch (scr_sha512_x86()) {
  case 3:
    scr_sha512_blocks_avx512(h, p, blocks);
    return;
  case 2:
    scr_sha512_blocks_avx2(h, p, blocks);
    return;
  default:
    break;
  }
#endif
#ifdef SCR_SHA512_ARM
  if (scr_sha512_arm()) {
    scr_sha512_blocks_arm(h, p, blocks);
    return;
  }
#endif
  scr_sha512_blocks_portable(h, p, blocks);
}

static void scr_sha512_init(ScrSha512Ctx *ctx, bool sha384) {
  static const uint64_t initial512[8] = {
    UINT64_C(0x6a09e667f3bcc908), UINT64_C(0xbb67ae8584caa73b),
    UINT64_C(0x3c6ef372fe94f82b), UINT64_C(0xa54ff53a5f1d36f1),
    UINT64_C(0x510e527fade682d1), UINT64_C(0x9b05688c2b3e6c1f),
    UINT64_C(0x1f83d9abfb41bd6b), UINT64_C(0x5be0cd19137e2179)};
  static const uint64_t initial384[8] = {
    UINT64_C(0xcbbb9d5dc1059ed8), UINT64_C(0x629a292a367cd507),
    UINT64_C(0x9159015a3070dd17), UINT64_C(0x152fecd8f70e5939),
    UINT64_C(0x67332667ffc00b31), UINT64_C(0x8eb44a8768581511),
    UINT64_C(0xdb0c2e0d64f98fa7), UINT64_C(0x47b5481dbefa4fa4)};
  memcpy(ctx->h, sha384 ? initial384 : initial512, sizeof ctx->h);
  ctx->bytes = 0;
  ctx->tail_len = 0;
}

static void scr_sha512_update(ScrSha512Ctx *ctx, const unsigned char *data, size_t len) {
  ctx->bytes += len;
  if (ctx->tail_len != 0) {
    size_t take = 128 - ctx->tail_len;
    if (take > len) take = len;
    memcpy(ctx->tail + ctx->tail_len, data, take);
    ctx->tail_len += take;
    data += take;
    len -= take;
    if (ctx->tail_len == 128) {
      scr_sha512_blocks(ctx->h, ctx->tail, 1);
      ctx->tail_len = 0;
    }
  }
  if (len >= 128) {
    size_t blocks = len / 128;
    scr_sha512_blocks(ctx->h, data, blocks);
    data += blocks * 128;
    len -= blocks * 128;
  }
  if (len != 0) {
    memcpy(ctx->tail, data, len);
    ctx->tail_len = len;
  }
}

static size_t scr_sha512_final(const ScrSha512Ctx *source, unsigned char out[64], bool sha384) {
  ScrSha512Ctx ctx = *source;
  unsigned char tail[256] = {0};
  memcpy(tail, ctx.tail, ctx.tail_len);
  tail[ctx.tail_len] = 0x80;
  size_t pad = ctx.tail_len < 112 ? 128 : 256;
  uint64_t low = ctx.bytes << 3, high = ctx.bytes >> 61;
  for (size_t b = 0; b < 8; b++) {
    tail[pad - 1 - b] = (unsigned char)(low >> (8 * b));
    tail[pad - 9 - b] = (unsigned char)(high >> (8 * b));
  }
  scr_sha512_blocks(ctx.h, tail, pad / 128);
  size_t len = sha384 ? 48 : 64;
  for (size_t i = 0; i < len; i++) out[i] = (unsigned char)(ctx.h[i / 8] >> (56 - 8 * (i % 8)));
  return len;
}

typedef enum ScrDigestAlg {
  SCR_DIGEST_MD5,
  SCR_DIGEST_SHA1,
  SCR_DIGEST_SHA224,
  SCR_DIGEST_SHA256,
  SCR_DIGEST_SHA384,
  SCR_DIGEST_SHA512,
  SCR_DIGEST_SHA256_192,
  SCR_DIGEST_SHA512_224,
  SCR_DIGEST_SHA512_256,
  SCR_DIGEST_SHA3_224,
  SCR_DIGEST_SHA3_256,
  SCR_DIGEST_SHA3_384,
  SCR_DIGEST_SHA3_512,
  SCR_DIGEST_KECCAK_224,
  SCR_DIGEST_KECCAK_256,
  SCR_DIGEST_KECCAK_384,
  SCR_DIGEST_KECCAK_512,
  SCR_DIGEST_SHAKE128,
  SCR_DIGEST_SHAKE256,
  SCR_DIGEST_KECCAK_KMAC128,
  SCR_DIGEST_KECCAK_KMAC256,
  SCR_DIGEST_RIPEMD160,
  SCR_DIGEST_BLAKE2B512,
  SCR_DIGEST_BLAKE2S256,
  SCR_DIGEST_SM3,
  SCR_DIGEST_MD5_SHA1,
} ScrDigestAlg;

/* Per algorithm: digest bytes (an XOF's default output length), HMAC
 * block bytes, and for the Keccak family its sponge rate and domain
 * padding. */
typedef struct {
  unsigned char size;
  unsigned char block;
  unsigned char rate;
  unsigned char pad;
  bool xof;
} ScrDigestInfo;

static const ScrDigestInfo scr_digest_info[] = {
    [SCR_DIGEST_MD5] = {16, 64, 0, 0, false},
    [SCR_DIGEST_SHA1] = {20, 64, 0, 0, false},
    [SCR_DIGEST_SHA224] = {28, 64, 0, 0, false},
    [SCR_DIGEST_SHA256] = {32, 64, 0, 0, false},
    [SCR_DIGEST_SHA384] = {48, 128, 0, 0, false},
    [SCR_DIGEST_SHA512] = {64, 128, 0, 0, false},
    [SCR_DIGEST_SHA256_192] = {24, 64, 0, 0, false},
    [SCR_DIGEST_SHA512_224] = {28, 128, 0, 0, false},
    [SCR_DIGEST_SHA512_256] = {32, 128, 0, 0, false},
    [SCR_DIGEST_SHA3_224] = {28, 144, 144, 0x06, false},
    [SCR_DIGEST_SHA3_256] = {32, 136, 136, 0x06, false},
    [SCR_DIGEST_SHA3_384] = {48, 104, 104, 0x06, false},
    [SCR_DIGEST_SHA3_512] = {64, 72, 72, 0x06, false},
    [SCR_DIGEST_KECCAK_224] = {28, 144, 144, 0x01, false},
    [SCR_DIGEST_KECCAK_256] = {32, 136, 136, 0x01, false},
    [SCR_DIGEST_KECCAK_384] = {48, 104, 104, 0x01, false},
    [SCR_DIGEST_KECCAK_512] = {64, 72, 72, 0x01, false},
    [SCR_DIGEST_SHAKE128] = {16, 168, 168, 0x1f, true},
    [SCR_DIGEST_SHAKE256] = {32, 136, 136, 0x1f, true},
    [SCR_DIGEST_KECCAK_KMAC128] = {32, 168, 168, 0x04, true},
    [SCR_DIGEST_KECCAK_KMAC256] = {64, 136, 136, 0x04, true},
    [SCR_DIGEST_RIPEMD160] = {20, 64, 0, 0, false},
    [SCR_DIGEST_BLAKE2B512] = {64, 128, 0, 0, false},
    [SCR_DIGEST_BLAKE2S256] = {32, 64, 0, 0, false},
    [SCR_DIGEST_SM3] = {32, 64, 0, 0, false},
    [SCR_DIGEST_MD5_SHA1] = {36, 64, 0, 0, false},
};

typedef struct ScrDigestCtx {
  ScrDigestAlg alg;
  union {
    ScrMd5Ctx md5;
    ScrSha1Ctx sha1;
    ScrSha256Ctx sha256;
    ScrSha512Ctx sha512;
    ScrKeccakCtx keccak;
    ScrRipemd160Ctx ripemd160;
    ScrBlake2bCtx blake2b;
    ScrBlake2sCtx blake2s;
    ScrSm3Ctx sm3;
    struct {
      ScrMd5Ctx md5;
      ScrSha1Ctx sha1;
    } md5_sha1;
  } state;
} ScrDigestCtx;

static unsigned char scr_ascii_lower(unsigned char c) {
  return c >= 'A' && c <= 'Z' ? (unsigned char)(c + ('a' - 'A')) : c;
}

static bool scr_digest_name_is(const char *name, size_t len, const char *literal) {
  size_t n = strlen(literal);
  if (len != n) return false;
  for (size_t i = 0; i < n; i++) {
    if (scr_ascii_lower((unsigned char)name[i]) != (unsigned char)literal[i]) return false;
  }
  return true;
}

/* OpenSSL's names for the digests Node 24 lists in crypto.getHashes(),
 * with its provider aliases and object identifiers. Lookup is
 * case-insensitive, like OpenSSL's. */
#define SCR_DIGEST_NAME(name, alg) {name, sizeof name - 1, alg}
static const struct {
  const char *name;
  unsigned char len;
  ScrDigestAlg alg;
} scr_digest_names[] = {
    /* The names most programs use come first. */
    SCR_DIGEST_NAME("sha256", SCR_DIGEST_SHA256), SCR_DIGEST_NAME("sha1", SCR_DIGEST_SHA1),
    SCR_DIGEST_NAME("md5", SCR_DIGEST_MD5), SCR_DIGEST_NAME("sha512", SCR_DIGEST_SHA512),
    SCR_DIGEST_NAME("sha384", SCR_DIGEST_SHA384), SCR_DIGEST_NAME("sha224", SCR_DIGEST_SHA224),
    SCR_DIGEST_NAME("ssl3-md5", SCR_DIGEST_MD5), SCR_DIGEST_NAME("rsa-md5", SCR_DIGEST_MD5),
    SCR_DIGEST_NAME("md5withrsaencryption", SCR_DIGEST_MD5),
    SCR_DIGEST_NAME("1.2.840.113549.2.5", SCR_DIGEST_MD5),
    SCR_DIGEST_NAME("sha-1", SCR_DIGEST_SHA1), SCR_DIGEST_NAME("ssl3-sha1", SCR_DIGEST_SHA1),
    SCR_DIGEST_NAME("rsa-sha1", SCR_DIGEST_SHA1), SCR_DIGEST_NAME("rsa-sha1-2", SCR_DIGEST_SHA1),
    SCR_DIGEST_NAME("sha1withrsaencryption", SCR_DIGEST_SHA1),
    SCR_DIGEST_NAME("1.3.14.3.2.26", SCR_DIGEST_SHA1),
    SCR_DIGEST_NAME("sha-224", SCR_DIGEST_SHA224), SCR_DIGEST_NAME("sha2-224", SCR_DIGEST_SHA224),
    SCR_DIGEST_NAME("rsa-sha224", SCR_DIGEST_SHA224),
    SCR_DIGEST_NAME("sha224withrsaencryption", SCR_DIGEST_SHA224),
    SCR_DIGEST_NAME("2.16.840.1.101.3.4.2.4", SCR_DIGEST_SHA224),
    SCR_DIGEST_NAME("sha-256", SCR_DIGEST_SHA256), SCR_DIGEST_NAME("sha2-256", SCR_DIGEST_SHA256),
    SCR_DIGEST_NAME("rsa-sha256", SCR_DIGEST_SHA256),
    SCR_DIGEST_NAME("sha256withrsaencryption", SCR_DIGEST_SHA256),
    SCR_DIGEST_NAME("2.16.840.1.101.3.4.2.1", SCR_DIGEST_SHA256),
    SCR_DIGEST_NAME("sha256-192", SCR_DIGEST_SHA256_192),
    SCR_DIGEST_NAME("sha-256/192", SCR_DIGEST_SHA256_192),
    SCR_DIGEST_NAME("sha2-256/192", SCR_DIGEST_SHA256_192),
    SCR_DIGEST_NAME("sha-384", SCR_DIGEST_SHA384), SCR_DIGEST_NAME("sha2-384", SCR_DIGEST_SHA384),
    SCR_DIGEST_NAME("rsa-sha384", SCR_DIGEST_SHA384),
    SCR_DIGEST_NAME("sha384withrsaencryption", SCR_DIGEST_SHA384),
    SCR_DIGEST_NAME("2.16.840.1.101.3.4.2.2", SCR_DIGEST_SHA384),
    SCR_DIGEST_NAME("sha-512", SCR_DIGEST_SHA512), SCR_DIGEST_NAME("sha2-512", SCR_DIGEST_SHA512),
    SCR_DIGEST_NAME("rsa-sha512", SCR_DIGEST_SHA512),
    SCR_DIGEST_NAME("sha512withrsaencryption", SCR_DIGEST_SHA512),
    SCR_DIGEST_NAME("2.16.840.1.101.3.4.2.3", SCR_DIGEST_SHA512),
    SCR_DIGEST_NAME("sha512-224", SCR_DIGEST_SHA512_224),
    SCR_DIGEST_NAME("sha-512/224", SCR_DIGEST_SHA512_224),
    SCR_DIGEST_NAME("sha2-512/224", SCR_DIGEST_SHA512_224),
    SCR_DIGEST_NAME("rsa-sha512/224", SCR_DIGEST_SHA512_224),
    SCR_DIGEST_NAME("sha512-224withrsaencryption", SCR_DIGEST_SHA512_224),
    SCR_DIGEST_NAME("2.16.840.1.101.3.4.2.5", SCR_DIGEST_SHA512_224),
    SCR_DIGEST_NAME("sha512-256", SCR_DIGEST_SHA512_256),
    SCR_DIGEST_NAME("sha-512/256", SCR_DIGEST_SHA512_256),
    SCR_DIGEST_NAME("sha2-512/256", SCR_DIGEST_SHA512_256),
    SCR_DIGEST_NAME("rsa-sha512/256", SCR_DIGEST_SHA512_256),
    SCR_DIGEST_NAME("sha512-256withrsaencryption", SCR_DIGEST_SHA512_256),
    SCR_DIGEST_NAME("2.16.840.1.101.3.4.2.6", SCR_DIGEST_SHA512_256),
    SCR_DIGEST_NAME("sha3-224", SCR_DIGEST_SHA3_224),
    SCR_DIGEST_NAME("rsa-sha3-224", SCR_DIGEST_SHA3_224),
    SCR_DIGEST_NAME("id-rsassa-pkcs1-v1_5-with-sha3-224", SCR_DIGEST_SHA3_224),
    SCR_DIGEST_NAME("2.16.840.1.101.3.4.2.7", SCR_DIGEST_SHA3_224),
    SCR_DIGEST_NAME("sha3-256", SCR_DIGEST_SHA3_256),
    SCR_DIGEST_NAME("rsa-sha3-256", SCR_DIGEST_SHA3_256),
    SCR_DIGEST_NAME("id-rsassa-pkcs1-v1_5-with-sha3-256", SCR_DIGEST_SHA3_256),
    SCR_DIGEST_NAME("2.16.840.1.101.3.4.2.8", SCR_DIGEST_SHA3_256),
    SCR_DIGEST_NAME("sha3-384", SCR_DIGEST_SHA3_384),
    SCR_DIGEST_NAME("rsa-sha3-384", SCR_DIGEST_SHA3_384),
    SCR_DIGEST_NAME("id-rsassa-pkcs1-v1_5-with-sha3-384", SCR_DIGEST_SHA3_384),
    SCR_DIGEST_NAME("2.16.840.1.101.3.4.2.9", SCR_DIGEST_SHA3_384),
    SCR_DIGEST_NAME("sha3-512", SCR_DIGEST_SHA3_512),
    SCR_DIGEST_NAME("rsa-sha3-512", SCR_DIGEST_SHA3_512),
    SCR_DIGEST_NAME("id-rsassa-pkcs1-v1_5-with-sha3-512", SCR_DIGEST_SHA3_512),
    SCR_DIGEST_NAME("2.16.840.1.101.3.4.2.10", SCR_DIGEST_SHA3_512),
    SCR_DIGEST_NAME("keccak-224", SCR_DIGEST_KECCAK_224),
    SCR_DIGEST_NAME("keccak-256", SCR_DIGEST_KECCAK_256),
    SCR_DIGEST_NAME("keccak-384", SCR_DIGEST_KECCAK_384),
    SCR_DIGEST_NAME("keccak-512", SCR_DIGEST_KECCAK_512),
    SCR_DIGEST_NAME("shake128", SCR_DIGEST_SHAKE128),
    SCR_DIGEST_NAME("shake-128", SCR_DIGEST_SHAKE128),
    SCR_DIGEST_NAME("2.16.840.1.101.3.4.2.11", SCR_DIGEST_SHAKE128),
    SCR_DIGEST_NAME("shake256", SCR_DIGEST_SHAKE256),
    SCR_DIGEST_NAME("shake-256", SCR_DIGEST_SHAKE256),
    SCR_DIGEST_NAME("2.16.840.1.101.3.4.2.12", SCR_DIGEST_SHAKE256),
    SCR_DIGEST_NAME("keccak-kmac-128", SCR_DIGEST_KECCAK_KMAC128),
    SCR_DIGEST_NAME("keccak-kmac128", SCR_DIGEST_KECCAK_KMAC128),
    SCR_DIGEST_NAME("keccak-kmac-256", SCR_DIGEST_KECCAK_KMAC256),
    SCR_DIGEST_NAME("keccak-kmac256", SCR_DIGEST_KECCAK_KMAC256),
    SCR_DIGEST_NAME("ripemd160", SCR_DIGEST_RIPEMD160),
    SCR_DIGEST_NAME("ripemd-160", SCR_DIGEST_RIPEMD160),
    SCR_DIGEST_NAME("ripemd", SCR_DIGEST_RIPEMD160),
    SCR_DIGEST_NAME("rmd160", SCR_DIGEST_RIPEMD160),
    SCR_DIGEST_NAME("rsa-ripemd160", SCR_DIGEST_RIPEMD160),
    SCR_DIGEST_NAME("ripemd160withrsa", SCR_DIGEST_RIPEMD160),
    SCR_DIGEST_NAME("1.3.36.3.2.1", SCR_DIGEST_RIPEMD160),
    SCR_DIGEST_NAME("blake2b512", SCR_DIGEST_BLAKE2B512),
    SCR_DIGEST_NAME("blake2b-512", SCR_DIGEST_BLAKE2B512),
    SCR_DIGEST_NAME("1.3.6.1.4.1.1722.12.2.1.16", SCR_DIGEST_BLAKE2B512),
    SCR_DIGEST_NAME("blake2s256", SCR_DIGEST_BLAKE2S256),
    SCR_DIGEST_NAME("blake2s-256", SCR_DIGEST_BLAKE2S256),
    SCR_DIGEST_NAME("1.3.6.1.4.1.1722.12.2.2.8", SCR_DIGEST_BLAKE2S256),
    SCR_DIGEST_NAME("sm3", SCR_DIGEST_SM3), SCR_DIGEST_NAME("rsa-sm3", SCR_DIGEST_SM3),
    SCR_DIGEST_NAME("sm3withrsaencryption", SCR_DIGEST_SM3),
    SCR_DIGEST_NAME("1.2.156.10197.1.401", SCR_DIGEST_SM3),
    SCR_DIGEST_NAME("md5-sha1", SCR_DIGEST_MD5_SHA1),
};
#undef SCR_DIGEST_NAME

/* The RSA signature aliases resolve through OpenSSL's object table, which
 * needs an exact match; the provider names and object identifiers also
 * match with trailing spaces. */
static bool scr_digest_name_exact_only(const char *literal) {
  size_t n = strlen(literal);
  static const char suffix[] = "withrsaencryption";
  return strncmp(literal, "rsa-", 4) == 0 || strncmp(literal, "id-rsassa-", 10) == 0 ||
         strcmp(literal, "ripemd160withrsa") == 0 ||
         (n > sizeof suffix - 1 && strcmp(literal + n - (sizeof suffix - 1), suffix) == 0);
}

/* Node passes the name to OpenSSL as a C string, so it ends at the first
 * NUL. Node maps "dss1" and "DSS1" to SHA-1 before the lookup. */
static bool scr_digest_alg(const char *name, size_t len, ScrDigestAlg *out) {
  const char *nul = memchr(name, '\0', len);
  if (nul) len = (size_t)(nul - name);
  if ((len == 4 && memcmp(name, "dss1", 4) == 0) || (len == 4 && memcmp(name, "DSS1", 4) == 0)) {
    *out = SCR_DIGEST_SHA1;
    return true;
  }
  size_t trimmed = len;
  while (trimmed > 0 && name[trimmed - 1] == ' ') trimmed--;
  for (size_t i = 0; i < sizeof scr_digest_names / sizeof scr_digest_names[0]; i++) {
    size_t n = scr_digest_names[i].len;
    if (n != len && n != trimmed) continue;
    const char *literal = scr_digest_names[i].name;
    if (scr_digest_name_is(name, len, literal) ||
        (trimmed != len && scr_digest_name_is(name, trimmed, literal) &&
         !scr_digest_name_exact_only(literal))) {
      *out = scr_digest_names[i].alg;
      return true;
    }
  }
  return false;
}

bool scr_digest_known(const char *name, size_t len) {
  ScrDigestAlg alg;
  return scr_digest_alg(name, len, &alg);
}

/* createHash() and crypto.hash() also accept "dss1" in any case. */
static bool scr_hash_alg(const char *name, size_t len, ScrDigestAlg *out) {
  if (scr_digest_alg(name, len, out)) return true;
  const char *nul = memchr(name, '\0', len);
  if (nul) len = (size_t)(nul - name);
  if (!scr_digest_name_is(name, len, "dss1")) return false;
  *out = SCR_DIGEST_SHA1;
  return true;
}

static void scr_digest_init(ScrDigestCtx *ctx, ScrDigestAlg alg) {
  ctx->alg = alg;
  switch (alg) {
    case SCR_DIGEST_MD5: scr_md5_init(&ctx->state.md5); break;
    case SCR_DIGEST_SHA1: scr_sha1_init(&ctx->state.sha1); break;
    case SCR_DIGEST_SHA224: {
      static const uint32_t initial[8] = {
        0xc1059ed8, 0x367cd507, 0x3070dd17, 0xf70e5939,
        0xffc00b31, 0x68581511, 0x64f98fa7, 0xbefa4fa4};
      scr_sha256_init(&ctx->state.sha256);
      memcpy(ctx->state.sha256.h, initial, sizeof initial);
      break;
    }
    case SCR_DIGEST_SHA256:
    case SCR_DIGEST_SHA256_192: scr_sha256_init(&ctx->state.sha256); break;
    case SCR_DIGEST_SHA384: scr_sha512_init(&ctx->state.sha512, true); break;
    case SCR_DIGEST_SHA512: scr_sha512_init(&ctx->state.sha512, false); break;
    case SCR_DIGEST_SHA512_224:
    case SCR_DIGEST_SHA512_256: {
      /* FIPS 180-4 section 5.3.6's SHA-512/t initial values. */
      static const uint64_t iv224[8] = {
          0x8c3d37c819544da2ULL, 0x73e1996689dcd4d6ULL, 0x1dfab7ae32ff9c82ULL, 0x679dd514582f9fcfULL,
          0x0f6d2b697bd44da8ULL, 0x77e36f7304c48942ULL, 0x3f9d85a86a1d36c8ULL, 0x1112e6ad91d692a1ULL};
      static const uint64_t iv256[8] = {
          0x22312194fc2bf72cULL, 0x9f555fa3c84c64c2ULL, 0x2393b86b6f53b151ULL, 0x963877195940eabdULL,
          0x96283ee2a88effe3ULL, 0xbe5e1e2553863992ULL, 0x2b0199fc2c85b8aaULL, 0x0eb72ddc81c52ca2ULL};
      scr_sha512_init(&ctx->state.sha512, false);
      memcpy(ctx->state.sha512.h, alg == SCR_DIGEST_SHA512_224 ? iv224 : iv256, sizeof iv224);
      break;
    }
    case SCR_DIGEST_RIPEMD160: scr_ripemd160_init(&ctx->state.ripemd160); break;
    case SCR_DIGEST_BLAKE2B512: scr_blake2b_init(&ctx->state.blake2b); break;
    case SCR_DIGEST_BLAKE2S256: scr_blake2s_init(&ctx->state.blake2s); break;
    case SCR_DIGEST_SM3: scr_sm3_init(&ctx->state.sm3); break;
    case SCR_DIGEST_MD5_SHA1:
      scr_md5_init(&ctx->state.md5_sha1.md5);
      scr_sha1_init(&ctx->state.md5_sha1.sha1);
      break;
    default: /* the Keccak family */
      scr_keccak_init(&ctx->state.keccak, scr_digest_info[alg].rate, scr_digest_info[alg].pad);
      break;
  }
}

static void scr_digest_update(ScrDigestCtx *ctx, const unsigned char *data, size_t len) {
  switch (ctx->alg) {
    case SCR_DIGEST_MD5: scr_md5_update(&ctx->state.md5, data, len); break;
    case SCR_DIGEST_SHA1: scr_sha1_update(&ctx->state.sha1, data, len); break;
    case SCR_DIGEST_SHA224:
    case SCR_DIGEST_SHA256:
    case SCR_DIGEST_SHA256_192: scr_sha256_update(&ctx->state.sha256, data, len); break;
    case SCR_DIGEST_SHA384:
    case SCR_DIGEST_SHA512:
    case SCR_DIGEST_SHA512_224:
    case SCR_DIGEST_SHA512_256: scr_sha512_update(&ctx->state.sha512, data, len); break;
    case SCR_DIGEST_RIPEMD160: scr_ripemd160_update(&ctx->state.ripemd160, data, len); break;
    case SCR_DIGEST_BLAKE2B512: scr_blake2b_update(&ctx->state.blake2b, data, len); break;
    case SCR_DIGEST_BLAKE2S256: scr_blake2s_update(&ctx->state.blake2s, data, len); break;
    case SCR_DIGEST_SM3: scr_sm3_update(&ctx->state.sm3, data, len); break;
    case SCR_DIGEST_MD5_SHA1:
      scr_md5_update(&ctx->state.md5_sha1.md5, data, len);
      scr_sha1_update(&ctx->state.md5_sha1.sha1, data, len);
      break;
    default: scr_keccak_update(&ctx->state.keccak, data, len); break;
  }
}

static size_t scr_digest_final(const ScrDigestCtx *ctx, unsigned char out[64]) {
  switch (ctx->alg) {
    case SCR_DIGEST_MD5: return scr_md5_final(&ctx->state.md5, out);
    case SCR_DIGEST_SHA1: return scr_sha1_final(&ctx->state.sha1, out);
    case SCR_DIGEST_SHA224: scr_sha256_final(&ctx->state.sha256, out); return 28;
    case SCR_DIGEST_SHA256: return scr_sha256_final(&ctx->state.sha256, out);
    case SCR_DIGEST_SHA256_192: scr_sha256_final(&ctx->state.sha256, out); return 24;
    case SCR_DIGEST_SHA384: return scr_sha512_final(&ctx->state.sha512, out, true);
    case SCR_DIGEST_SHA512: return scr_sha512_final(&ctx->state.sha512, out, false);
    case SCR_DIGEST_SHA512_224: scr_sha512_final(&ctx->state.sha512, out, false); return 28;
    case SCR_DIGEST_SHA512_256: scr_sha512_final(&ctx->state.sha512, out, false); return 32;
    case SCR_DIGEST_RIPEMD160: scr_ripemd160_final(&ctx->state.ripemd160, out); return 20;
    case SCR_DIGEST_BLAKE2B512: scr_blake2b_final(&ctx->state.blake2b, out); return 64;
    case SCR_DIGEST_BLAKE2S256: scr_blake2s_final(&ctx->state.blake2s, out); return 32;
    case SCR_DIGEST_SM3: scr_sm3_final(&ctx->state.sm3, out); return 32;
    case SCR_DIGEST_MD5_SHA1:
      scr_md5_final(&ctx->state.md5_sha1.md5, out);
      scr_sha1_final(&ctx->state.md5_sha1.sha1, out + 16);
      return 36;
    default:
      scr_keccak_final(&ctx->state.keccak, out, scr_digest_info[ctx->alg].size);
      return scr_digest_info[ctx->alg].size;
  }
  return 0;
}

static void scr_crypto_zero(void *ptr, size_t len) {
#if defined(__GNUC__) || defined(__clang__)
  /* The empty asm takes the pointer and clobbers memory, so the compiler
   * keeps the memset of storage that is not read again. */
  memset(ptr, 0, len);
  __asm__ __volatile__("" : : "r"(ptr) : "memory");
#else
  volatile unsigned char *p = ptr;
  while (len-- != 0) *p++ = 0;
#endif
}

static void scr_hmac_init(ScrDigestCtx *inner, ScrDigestCtx *outer, ScrDigestAlg alg,
                          const unsigned char *key, size_t keylen) {
  unsigned char kblock[168] = {0};
  size_t block_len = scr_digest_info[alg].block;
  unsigned char kd[64];
  if (keylen > block_len) {
    ScrDigestCtx key_hash;
    scr_digest_init(&key_hash, alg);
    scr_digest_update(&key_hash, key, keylen);
    size_t n = scr_digest_final(&key_hash, kd);
    memcpy(kblock, kd, n);
    scr_crypto_zero(&key_hash, sizeof key_hash);
    scr_crypto_zero(kd, sizeof kd);
  } else if (keylen != 0) {
    memcpy(kblock, key, keylen);
  }
  unsigned char ipad[168];
  unsigned char opad[168];
  for (size_t i = 0; i < block_len; i++) {
    ipad[i] = (unsigned char)(kblock[i] ^ 0x36);
    opad[i] = (unsigned char)(kblock[i] ^ 0x5c);
  }
  scr_digest_init(inner, alg);
  scr_digest_update(inner, ipad, block_len);
  scr_digest_init(outer, alg);
  scr_digest_update(outer, opad, block_len);
  scr_crypto_zero(kblock, sizeof kblock);
  scr_crypto_zero(ipad, block_len);
  scr_crypto_zero(opad, block_len);
}

static size_t scr_hmac_final(const ScrDigestCtx *inner, const ScrDigestCtx *outer,
                             unsigned char out[64]) {
  unsigned char inner_digest[64];
  size_t inner_len = scr_digest_final(inner, inner_digest);
  ScrDigestCtx final_outer = *outer;
  scr_digest_update(&final_outer, inner_digest, inner_len);
  size_t n = scr_digest_final(&final_outer, out);
  scr_crypto_zero(inner_digest, sizeof inner_digest);
  scr_crypto_zero(&final_outer, sizeof final_outer);
  return n;
}

size_t scr_crypto_digest_raw(const char *alg, const unsigned char *data, size_t len,
                             unsigned char out[64]) {
  ScrDigestAlg kind;
  if (!scr_digest_alg(alg, strlen(alg), &kind)) return 0;
  ScrDigestCtx ctx;
  scr_digest_init(&ctx, kind);
  scr_digest_update(&ctx, data, len);
  return scr_digest_final(&ctx, out);
}

size_t scr_crypto_hmac_raw(const char *alg, const unsigned char *key, size_t keylen,
                           const unsigned char *data, size_t len, unsigned char out[64]) {
  ScrDigestAlg kind;
  if (!scr_digest_alg(alg, strlen(alg), &kind)) return 0;
  ScrDigestCtx inner, outer;
  scr_hmac_init(&inner, &outer, kind, key, keylen);
  scr_digest_update(&inner, data, len);
  size_t n = scr_hmac_final(&inner, &outer, out);
  scr_crypto_zero(&inner, sizeof inner);
  scr_crypto_zero(&outer, sizeof outer);
  return n;
}

struct ScrCryptoHash {
  size_t rc;
  bool finalized;
  bool hmac;
  /* The digest was computed, by digest() or by the stream's flush. Node's
   * native handle keeps it, so a Hash flushed as a stream answers one more
   * digest() with it, and every later update fails. */
  bool digested;
  size_t out_len; /* digest bytes; an XOF's options.outputLength */
  ScrDigestCtx inner;
  ScrDigestCtx outer;
  /* The computed digest (Hash only): inline up to 64 bytes, else heap. */
  unsigned char cached_inline[64];
  unsigned char *cached;
  size_t cached_len;
  /* The Transform this value reads and writes as a stream (scr_stream.c),
   * created on first stream use; owned, released through stream_release.
   * The stream's steps find this value through stream_box, which holds it
   * without a reference and is cleared when the value is freed. While the
   * stream is a pipe destination or pipeline stage, held is set and the
   * value holds one reference to itself, so a pipe keeps it alive until
   * the stream flushes or is destroyed. */
  void *stream;
  void (*stream_release)(void *);
  ScrBox *stream_box;
  bool held;
  /* The stream was destroyed and released: it keeps no listeners alive. */
  bool stream_closed;
};

static void scr_crypto_digest_unsupported(void) {
  static const char msg[] = "Digest method not supported";
  scr_throw_error_msg(SCR_ERR_ERROR, msg, sizeof msg - 1);
}

static void scr_crypto_invalid_digest(const ScrStr *alg) {
  static const char prefix[] = "Invalid digest: ";
  const size_t prefix_len = sizeof prefix - 1;
  if (alg->len > SIZE_MAX - prefix_len) scr_trap("scriptc: out of memory\n");
  const size_t msg_len = prefix_len + alg->len;
  char *msg = malloc(msg_len);
  if (!msg) scr_trap("scriptc: out of memory\n");
  memcpy(msg, prefix, prefix_len);
  memcpy(msg + prefix_len, alg->data, alg->len);
  scr_throw_error_msg_code(SCR_ERR_TYPE, msg, msg_len,
                           "ERR_CRYPTO_INVALID_DIGEST");
  free(msg);
}

static void scr_crypto_hash_digest_unsupported(const ScrStr *alg) {
  static const char prefix[] = "Digest method ";
  static const char suffix[] = " is not supported";
  const size_t prefix_len = sizeof prefix - 1;
  const size_t suffix_len = sizeof suffix - 1;
  if (alg->len > SIZE_MAX - prefix_len ||
      suffix_len > SIZE_MAX - prefix_len - alg->len) {
    scr_trap("scriptc: out of memory\n");
  }
  const size_t msg_len = prefix_len + alg->len + suffix_len;
  char *msg = malloc(msg_len);
  if (!msg) scr_trap("scriptc: out of memory\n");
  memcpy(msg, prefix, prefix_len);
  memcpy(msg + prefix_len, alg->data, alg->len);
  memcpy(msg + prefix_len + alg->len, suffix, suffix_len);
  scr_throw_error_msg(SCR_ERR_ERROR, msg, msg_len);
  free(msg);
}

/* `len` bytes of an XOF's output. */
static void scr_digest_final_xof(const ScrDigestCtx *ctx, unsigned char *out, size_t len) {
  scr_keccak_final(&ctx->state.keccak, out, len);
}

/* OpenSSL refuses an XOF as HMAC's digest without queueing an error, and
 * Node reports that as its empty-error message. */
static bool scr_crypto_hmac_digest_ok(ScrDigestAlg alg) {
  if (!scr_digest_info[alg].xof) return true;
  static const char msg[] = "error:00000000:lib(0)::reason(0)";
  scr_throw_error_msg(SCR_ERR_ERROR, msg, sizeof msg - 1);
  return false;
}

static void scr_crypto_hash_finalized(void) {
  static const char msg[] = "Digest already called";
  scr_throw_error_msg_code(SCR_ERR_ERROR, msg, sizeof msg - 1,
                           "ERR_CRYPTO_HASH_FINALIZED");
}

static void scr_crypto_hash_update_failed(void) {
  static const char msg[] = "Hash update failed";
  scr_throw_error_msg_code(SCR_ERR_ERROR, msg, sizeof msg - 1,
                           "ERR_CRYPTO_HASH_UPDATE_FAILED");
}

/* update() may run: Node throws ERR_CRYPTO_HASH_FINALIZED after digest(),
 * and ERR_CRYPTO_HASH_UPDATE_FAILED when only a stream flush computed the
 * digest. */
static bool scr_crypto_hash_updatable(const ScrCryptoHash *hash) {
  if (hash->finalized) {
    scr_crypto_hash_finalized();
    return false;
  }
  if (hash->digested) {
    scr_crypto_hash_update_failed();
    return false;
  }
  return true;
}

static void scr_crypto_hash_cache(ScrCryptoHash *hash, const unsigned char *digest, size_t len) {
  if (hash->hmac) return;
  hash->cached = len <= sizeof hash->cached_inline ? hash->cached_inline : malloc(len);
  if (!hash->cached) scr_trap("scriptc: out of memory\n");
  memcpy(hash->cached, digest, len);
  hash->cached_len = len;
}

static ScrCryptoHash *scr_crypto_hash_alloc(ScrDigestAlg alg, bool hmac,
                                            const unsigned char *key, size_t keylen) {
  ScrCryptoHash *hash = calloc(1, sizeof *hash);
  if (!hash) scr_trap("scriptc: out of memory\n");
  hash->rc = 1;
  hash->hmac = hmac;
  hash->out_len = scr_digest_info[alg].size;
  if (hmac) scr_hmac_init(&hash->inner, &hash->outer, alg, key, keylen);
  else scr_digest_init(&hash->inner, alg);
  return hash;
}

ScrCryptoHash *scr_crypto_hash_new(ScrStr *alg) {
  ScrDigestAlg kind;
  if (!scr_hash_alg(alg->data, alg->len, &kind)) {
    scr_crypto_digest_unsupported();
    return NULL;
  }
  return scr_crypto_hash_alloc(kind, false, NULL, 0);
}

ScrCryptoHash *scr_crypto_hmac_new_str(ScrStr *alg, ScrStr *key) {
  ScrDigestAlg kind;
  if (!scr_digest_alg(alg->data, alg->len, &kind)) {
    scr_crypto_invalid_digest(alg);
    return NULL;
  }
  if (!scr_crypto_hmac_digest_ok(kind)) return NULL;
  char *owned;
  const char *bytes = scr_str_utf8(key, &owned);
  ScrCryptoHash *r = scr_crypto_hash_alloc(kind, true, (const unsigned char *)bytes, key->len);
  scr_str_utf8_end(owned);
  return r;
}

ScrCryptoHash *scr_crypto_hmac_new_bytes(ScrStr *alg, ScrBytes *key) {
  SCR_BYTES_SNAPSHOT(key);
  ScrDigestAlg kind;
  if (!scr_digest_alg(alg->data, alg->len, &kind)) {
    scr_crypto_invalid_digest(alg);
    return NULL;
  }
  if (!scr_crypto_hmac_digest_ok(kind)) return NULL;
  return scr_crypto_hash_alloc(kind, true, key->data,
                               key->len * scr_bytes_elem_size(key->elem));
}

ScrCryptoHash *scr_crypto_hash_retain(ScrCryptoHash *hash) {
  if (hash && hash->rc != SIZE_MAX) hash->rc++;
  return hash;
}

void scr_crypto_hash_release(ScrCryptoHash *hash) {
  if (!hash || hash->rc == SIZE_MAX) return;
  if (--hash->rc == 0) {
    /* Clearing the box detaches the stream (scr_crypto_hash_stream_detach),
     * then the value releases its reference to it. */
    void *stream = hash->stream;
    void (*stream_release)(void *) = hash->stream_release;
    if (hash->stream_box) scr_box_set_ref(hash->stream_box, NULL);
    if (stream) stream_release(stream);
    if (hash->cached && hash->cached != hash->cached_inline) {
      scr_crypto_zero(hash->cached, hash->cached_len);
      free(hash->cached);
    }
    scr_crypto_zero(hash, sizeof *hash);
    free(hash);
  }
}

void *scr_crypto_hash_retain_v(void *p) { return scr_crypto_hash_retain(p); }
void scr_crypto_hash_release_v(void *p) { scr_crypto_hash_release(p); }

/* Node's TypeError for calling a missing member: "<what> is not a
 * function", where `what` is the callee's source text, of any length. */
static void scr_lib_throw_not_a_function(const char *what) {
  ScrJsonBuf b;
  scr_jb_init(&b);
  scr_jb_puts(&b, what);
  scr_jb_puts(&b, " is not a function");
  scr_throw_error(SCR_ERR_TYPE, scr_jb_finish(&b));
}

/* Hash and Hmac values seen as 'unknown' are native handles. update(),
 * digest() and Hash's copy() dispatch through the handle, called or read
 * as values; the other members Node defines on a Hash or Hmac (the
 * Transform and emitter surface) throw a coded SC2020 error, and other
 * names read as undefined, as they do in Node. The member names are one
 * NUL-separated char array, which the linker drops from programs that
 * never box a Hash (an array of string pointers keeps the strings in the
 * unit's shared string section). */
static const char scr_crypto_hash_dyn_members[] =
    "_destroy\0_events\0_eventsCount\0_final\0_flush\0_maxListeners\0_options\0_read\0"
    "_readableState\0_transform\0_undestroy\0_writableState\0_write\0_writev\0addListener\0"
    "allowHalfOpen\0closed\0compose\0constructor\0cork\0destroy\0destroyed\0digest\0drop\0"
    "emit\0end\0errored\0eventNames\0every\0filter\0find\0flatMap\0forEach\0getMaxListeners\0"
    "isPaused\0iterator\0listenerCount\0listeners\0map\0off\0on\0once\0pause\0pipe\0"
    "prependListener\0prependOnceListener\0push\0rawListeners\0read\0readable\0"
    "readableAborted\0readableBuffer\0readableDidRead\0readableEncoding\0readableEnded\0"
    "readableFlowing\0readableHighWaterMark\0readableLength\0readableObjectMode\0reduce\0"
    "removeAllListeners\0removeListener\0resume\0setDefaultEncoding\0setEncoding\0"
    "setMaxListeners\0some\0take\0toArray\0uncork\0unpipe\0unshift\0update\0wrap\0writable\0"
    "writableBuffer\0writableCorked\0writableEnded\0writableFinished\0writableHighWaterMark\0"
    "writableLength\0writableNeedDrain\0writableObjectMode\0write\0";

static bool scr_crypto_hash_dyn_member(const ScrCryptoHash *hash, const char *key, size_t len) {
  if (len == 4 && memcmp(key, "copy", 4) == 0) return !hash->hmac;
  for (const char *name = scr_crypto_hash_dyn_members; *name; name += strlen(name) + 1)
    if (strlen(name) == len && memcmp(name, key, len) == 0) return true;
  return false;
}

static void scr_crypto_hash_dyn_unsupported(const ScrCryptoHash *hash) {
  static const char hash_msg[] =
      "Hash members other than update(), digest() and copy() have no lowering on an 'unknown' "
      "value; cast the value to Hash first";
  static const char hmac_msg[] =
      "Hmac members other than update() and digest() have no lowering on an 'unknown' value; "
      "cast the value to Hmac first";
  if (hash->hmac) scr_throw_error_msg_code(SCR_ERR_ERROR, hmac_msg, sizeof hmac_msg - 1, "SC2020");
  else scr_throw_error_msg_code(SCR_ERR_ERROR, hash_msg, sizeof hash_msg - 1, "SC2020");
}

/* The method values: update() is one function for Hash and Hmac, as in
 * Node; digest() is one per class, and copy() is Hash's. */
enum { SCR_HASH_DYN_UPDATE, SCR_HASH_DYN_HASH_DIGEST, SCR_HASH_DYN_HMAC_DIGEST, SCR_HASH_DYN_COPY };
static const char *const scr_crypto_hash_dyn_method_names[] = {"update", "digest", "digest", "copy"};
static SCR_TL ScrDyn *scr_crypto_hash_dyn_methods[4];
static SCR_TL bool scr_crypto_hash_dyn_methods_registered;

static void scr_crypto_hash_dyn_methods_cleanup(void) {
  for (size_t i = 0; i < 4; i++) {
    ScrDyn *method = scr_crypto_hash_dyn_methods[i];
    scr_crypto_hash_dyn_methods[i] = NULL;
    scr_dyn_release(method);
  }
}

static int scr_crypto_hash_dyn_method_index(const ScrCryptoHash *hash, const char *key, size_t len) {
  if (len == 6 && memcmp(key, "update", 6) == 0) return SCR_HASH_DYN_UPDATE;
  if (len == 6 && memcmp(key, "digest", 6) == 0)
    return hash->hmac ? SCR_HASH_DYN_HMAC_DIGEST : SCR_HASH_DYN_HASH_DIGEST;
  if (len == 4 && memcmp(key, "copy", 4) == 0 && !hash->hmac) return SCR_HASH_DYN_COPY;
  return -1;
}

/* Runs method `index` on `hash`; `self` is the receiving box, which
 * update() answers. */
static ScrDyn *scr_crypto_hash_dyn_run(ScrCryptoHash *hash, ScrDyn *self, int index,
                                       ScrDyn *const *args, size_t argc) {
  ScrDyn *undefined = scr_dyn_undefined();
  ScrDyn *first = argc > 0 ? args[0] : undefined;
  ScrDyn *second = argc > 1 ? args[1] : undefined;
  ScrDyn *result = NULL;
  if (index == SCR_HASH_DYN_UPDATE) {
    ScrCryptoHash *updated = scr_crypto_hash_update_dyn(hash, first, second);
    if (updated) {
      scr_crypto_hash_release(updated);
      result = scr_dyn_retain(self);
    }
  } else if (index == SCR_HASH_DYN_COPY) {
    ScrCryptoHash *copy = scr_crypto_hash_copy_opts(hash, first);
    if (copy) {
      result = scr_dyn_new_handle(copy, SCR_DYNH_HASH);
      scr_crypto_hash_release(copy);
    }
  } else {
    result = scr_crypto_hash_digest_dyn(hash, first);
  }
  scr_dyn_release(undefined);
  return result;
}

static ScrDyn *scr_crypto_hash_dyn_method_call(ScrClosure *clo, ScrDyn *const *args, size_t argc) {
  int index = (int)scr_box_get_f64(clo->caps[0]);
  ScrDyn *self = scr_dyn_this_get();
  bool hash_this = self->kind == SCR_DYN_HANDLE && self->v.handle.tag == SCR_DYNH_HASH;
  bool hmac_this = self->kind == SCR_DYN_HANDLE && self->v.handle.tag == SCR_DYNH_HMAC;
  bool valid = index == SCR_HASH_DYN_UPDATE ? hash_this || hmac_this
               : index == SCR_HASH_DYN_HMAC_DIGEST ? hmac_this
                                                   : hash_this;
  ScrDyn *result = NULL;
  if (valid) {
    result = scr_crypto_hash_dyn_run(self->v.handle.ptr, self, index, args, argc);
  } else {
    static const char msg[] =
        "Hash and Hmac methods called with a receiver other than their own Hash or Hmac have no "
        "lowering";
    scr_throw_error_msg_code(SCR_ERR_ERROR, msg, sizeof msg - 1, "SC2020");
  }
  scr_dyn_release(self);
  return result;
}

static ScrDyn *scr_crypto_hash_dyn_method_value(int index) {
  if (!scr_crypto_hash_dyn_methods_registered) {
    scr_crypto_hash_dyn_methods_registered = true;
    scr_atexit(scr_crypto_hash_dyn_methods_cleanup);
  }
  if (!scr_crypto_hash_dyn_methods[index]) {
    ScrClosure *clo = scr_closure_new(NULL, 1);
    clo->caps[0] = scr_box_new(SCR_BOX_F64);
    scr_box_set_f64(clo->caps[0], (double)index);
    uint32_t arity = index == SCR_HASH_DYN_UPDATE ? 2 : 1;
    scr_crypto_hash_dyn_methods[index] = scr_dyn_new_func(
        clo, scr_crypto_hash_dyn_method_call, arity, "", scr_crypto_hash_dyn_method_names[index]);
  }
  return scr_dyn_retain(scr_crypto_hash_dyn_methods[index]);
}

static ScrDyn *scr_crypto_hash_dyn_invoke(void *h, ScrDyn *self, const char *method,
                                          ScrDyn *const *args, size_t argc, const char *what) {
  ScrCryptoHash *hash = h;
  size_t len = strlen(method);
  int index = scr_crypto_hash_dyn_method_index(hash, method, len);
  if (index >= 0) return scr_crypto_hash_dyn_run(hash, self, index, args, argc);
  if (scr_crypto_hash_dyn_member(hash, method, len)) {
    scr_crypto_hash_dyn_unsupported(hash);
    return NULL;
  }
  scr_lib_throw_not_a_function(what);
  return NULL;
}

static ScrDyn *scr_crypto_hash_dyn_get(void *h, const char *key, size_t len) {
  int index = scr_crypto_hash_dyn_method_index(h, key, len);
  if (index >= 0) return scr_crypto_hash_dyn_method_value(index);
  if (scr_crypto_hash_dyn_member(h, key, len)) scr_crypto_hash_dyn_unsupported(h);
  return NULL;
}

static bool scr_crypto_hash_dyn_set(void *h, const char *key, size_t len, const ScrDyn *value) {
  (void)h;
  (void)key;
  (void)len;
  (void)value;
  return false;
}

static void scr_crypto_hash_dyn_install(void) {
  static SCR_TL bool installed;
  if (installed) return;
  installed = true;
  static const ScrDynHandleOps hash_ops = {
      .cls = "Hash",
      .retain = scr_crypto_hash_retain_v,
      .release = scr_crypto_hash_release_v,
      .invoke = scr_crypto_hash_dyn_invoke,
      .get = scr_crypto_hash_dyn_get,
      .set = scr_crypto_hash_dyn_set,
  };
  static const ScrDynHandleOps hmac_ops = {
      .cls = "Hmac",
      .retain = scr_crypto_hash_retain_v,
      .release = scr_crypto_hash_release_v,
      .invoke = scr_crypto_hash_dyn_invoke,
      .get = scr_crypto_hash_dyn_get,
      .set = scr_crypto_hash_dyn_set,
  };
  scr_dyn_handle_install(SCR_DYNH_HASH, &hash_ops);
  scr_dyn_handle_install(SCR_DYNH_HMAC, &hmac_ops);
}

ScrDyn *scr_crypto_hash_to_dyn(ScrCryptoHash *hash) {
  scr_crypto_hash_dyn_install();
  return scr_dyn_new_handle(hash, hash->hmac ? SCR_DYNH_HMAC : SCR_DYNH_HASH);
}

static ScrCryptoHash *scr_crypto_hash_update_raw(ScrCryptoHash *hash,
                                                 const unsigned char *data, size_t len) {
  if (!scr_crypto_hash_updatable(hash)) return NULL;
  scr_digest_update(&hash->inner, data, len);
  return scr_crypto_hash_retain(hash);
}

ScrCryptoHash *scr_crypto_hash_update_str(ScrCryptoHash *hash, ScrStr *data) {
  char *owned;
  const char *bytes = scr_str_utf8(data, &owned);
  ScrCryptoHash *r = scr_crypto_hash_update_raw(hash, (const unsigned char *)bytes, data->len);
  scr_str_utf8_end(owned);
  return r;
}

ScrCryptoHash *scr_crypto_hash_update_bytes(ScrCryptoHash *hash, ScrBytes *data) {
  SCR_BYTES_SNAPSHOT(data);
  return scr_crypto_hash_update_raw(hash, data->data,
                                    data->len * scr_bytes_elem_size(data->elem));
}

/* copy() may run. After a stream flush, Node copies the finished
 * OpenSSL context, whose later updates and digests fail with OpenSSL
 * error-queue codes; that copy has no lowering. */
static bool scr_crypto_hash_copyable(const ScrCryptoHash *hash) {
  if (hash->finalized) {
    scr_crypto_hash_finalized();
    return false;
  }
  if (hash->digested) {
    static const char msg[] = "copy() of a Hash whose stream has flushed its digest has no lowering";
    scr_throw_error_msg_code(SCR_ERR_ERROR, msg, sizeof msg - 1, "SC2020");
    return false;
  }
  return true;
}

static ScrCryptoHash *scr_crypto_hash_clone(const ScrCryptoHash *hash) {
  ScrCryptoHash *copy = malloc(sizeof *copy);
  if (!copy) scr_trap("scriptc: out of memory\n");
  *copy = *hash;
  copy->rc = 1;
  copy->cached = NULL;
  copy->cached_len = 0;
  copy->stream = NULL;
  copy->stream_release = NULL;
  copy->stream_box = NULL;
  copy->held = false;
  copy->stream_closed = false;
  copy->out_len = scr_digest_info[copy->inner.alg].size;
  return copy;
}

ScrCryptoHash *scr_crypto_hash_copy(ScrCryptoHash *hash) {
  if (!scr_crypto_hash_copyable(hash)) return NULL;
  return scr_crypto_hash_clone(hash);
}

static bool scr_crypto_integer(double value, const char *name, double max);

/* Computes the digest into `out` (hash->out_len bytes) and marks it
 * computed. A Hash keeps a copy for a later digest() or flush. */
static size_t scr_crypto_hash_compute(ScrCryptoHash *hash, unsigned char *out) {
  hash->digested = true;
  if (hash->hmac) return scr_hmac_final(&hash->inner, &hash->outer, out);
  size_t n;
  if (scr_digest_info[hash->inner.alg].xof) {
    scr_digest_final_xof(&hash->inner, out, hash->out_len);
    n = hash->out_len;
  } else {
    n = scr_digest_final(&hash->inner, out);
  }
  scr_crypto_hash_cache(hash, out, n);
  return n;
}

/* The digest into `out`, which holds hash->out_len bytes. Returns the
 * byte count, or 0: with the error pending for a finalized Hash, and
 * without one for a repeated Hmac.digest(), which Node answers empty. */
static size_t scr_crypto_hash_finish(ScrCryptoHash *hash, unsigned char *out) {
  if (hash->finalized) {
    if (hash->hmac) return 0;
    scr_crypto_hash_finalized();
    return 0;
  }
  hash->finalized = true;
  if (hash->digested) {
    /* A stream flush computed it; Node's handle answers it again. */
    memcpy(out, hash->cached, hash->cached_len);
    return hash->cached_len;
  }
  return scr_crypto_hash_compute(hash, out);
}

/* Digest storage: the stack for the fixed-length digests, the heap for a
 * longer XOF output. */
static unsigned char *scr_crypto_digest_space(size_t len, unsigned char stack[64]) {
  if (len <= 64) return stack;
  unsigned char *space = malloc(len);
  if (!space) scr_trap("scriptc: out of memory\n");
  return space;
}

static void scr_crypto_digest_space_end(unsigned char *space, size_t len, unsigned char stack[64]) {
  scr_crypto_zero(space, len);
  if (space != stack) free(space);
}

static void scr_crypto_encoding_unlowered(void) {
  static const char message[] = "A digest with this output encoding returns a Buffer, which this call's string type cannot hold";
  scr_throw_error_msg_code(SCR_ERR_ERROR, message, sizeof message - 1, "SC2020");
}

/* digest(encoding) where the compiler proved a string result: `enc` is a
 * Buffer encoding name. */
ScrStr *scr_crypto_hash_digest_string(ScrCryptoHash *hash, ScrStr *enc) {
  int encoding = scr_crypto_encoding(enc->data, enc->len);
  if (encoding < 0) {
    if (hash->finalized && !hash->hmac) scr_crypto_hash_finalized();
    else if (hash->finalized) return scr_str_new("", 0);
    else scr_crypto_encoding_unlowered();
    return NULL;
  }
  unsigned char stack[64];
  unsigned char *digest = scr_crypto_digest_space(hash->out_len, stack);
  size_t n = scr_crypto_hash_finish(hash, digest);
  ScrStr *result = n != 0 ? scr_digest_encode(digest, n, encoding)
                          : scr_exc_pending() ? NULL : scr_str_new("", 0);
  if (digest == stack) scr_crypto_zero(stack, sizeof stack);
  else scr_crypto_digest_space_end(digest, hash->out_len, stack);
  return result;
}

ScrBytes *scr_crypto_hash_digest_buffer(ScrCryptoHash *hash) {
  unsigned char stack[64];
  unsigned char *digest = scr_crypto_digest_space(hash->out_len, stack);
  size_t n = scr_crypto_hash_finish(hash, digest);
  ScrBytes *result = NULL;
  if (n != 0 || !scr_exc_pending()) {
    result = scr_bytes_new(SCR_BYTES_U8, (double)n);
    if (n != 0) memcpy(result->data, digest, n);
  }
  scr_crypto_digest_space_end(digest, hash->out_len, stack);
  return result;
}

/* ── Hash and Hmac as streams ─────────────────────────────────────────
 * The Transform behind a Hash used as a stream (scr_stream.c) writes and
 * flushes through these. Node's _transform updates the native handle and
 * reports ERR_CRYPTO_HASH_UPDATE_FAILED once the digest was computed;
 * Hash's _flush pushes the digest without finalizing the Hash, and
 * Hmac's finalizes it. */
void *scr_crypto_hash_stream_get(ScrCryptoHash *hash) { return hash->stream; }

void scr_crypto_hash_stream_set(ScrCryptoHash *hash, void *stream, void (*release)(void *),
                                ScrBox *box) {
  hash->stream = stream;
  hash->stream_release = release;
  hash->stream_box = box;
}

/* The box's release: the box lets go of the value, either because the
 * value is being freed or because the stream was torn down first. */
void scr_crypto_hash_stream_detach(void *value) {
  ScrCryptoHash *hash = value;
  hash->stream = NULL;
  hash->stream_release = NULL;
  hash->stream_box = NULL;
}

/* After the stream is destroyed, the value lets go of it, so listeners
 * that capture the value do not keep the pair alive. */
void scr_crypto_hash_stream_close(ScrCryptoHash *hash) {
  void *stream = hash->stream;
  void (*stream_release)(void *) = hash->stream_release;
  if (hash->stream_box) scr_box_set_ref(hash->stream_box, NULL);
  hash->stream_closed = true;
  if (stream) stream_release(stream);
}

bool scr_crypto_hash_is_hmac(const ScrCryptoHash *hash) { return hash->hmac; }

bool scr_crypto_hash_stream_usable(const ScrCryptoHash *hash) {
  if (!hash->stream_closed) return true;
  static const char msg[] = "Stream use of a Hash or Hmac after its stream closed has no lowering";
  scr_throw_error_msg_code(SCR_ERR_ERROR, msg, sizeof msg - 1, "SC2020");
  return false;
}

void scr_crypto_hash_stream_hold(ScrCryptoHash *hash) {
  if (hash->held) return;
  hash->held = true;
  scr_crypto_hash_retain(hash);
}

void scr_crypto_hash_stream_unhold(ScrCryptoHash *hash) {
  if (!hash->held) return;
  hash->held = false;
  scr_crypto_hash_release(hash);
}

bool scr_crypto_hash_stream_write(ScrCryptoHash *hash, ScrBytes *chunk) {
  if (hash->digested) return false;
  SCR_BYTES_SNAPSHOT(chunk);
  scr_digest_update(&hash->inner, chunk->data, chunk->len * scr_bytes_elem_size(chunk->elem));
  return true;
}

ScrBytes *scr_crypto_hash_stream_flush(ScrCryptoHash *hash) {
  unsigned char stack[64];
  unsigned char *digest = scr_crypto_digest_space(hash->out_len, stack);
  size_t n = 0;
  if (hash->hmac) {
    /* After digest(), Node's Hmac handle answers an empty digest. */
    if (!hash->finalized) {
      hash->finalized = true;
      n = scr_crypto_hash_compute(hash, digest);
    }
  } else if (hash->digested) {
    n = hash->cached_len;
    memcpy(digest, hash->cached, n);
  } else {
    n = scr_crypto_hash_compute(hash, digest);
  }
  ScrBytes *result = scr_bytes_new(SCR_BYTES_U8, (double)n);
  result->is_buffer = true;
  if (n != 0) memcpy(result->data, digest, n);
  scr_crypto_digest_space_end(digest, hash->out_len, stack);
  return result;
}

static ScrDyn *scr_crypto_dyn_str(ScrStr *text) {
  if (!text) return NULL;
  ScrDyn *result = scr_dyn_new_str(text);
  scr_str_release(text);
  return result;
}

static ScrDyn *scr_crypto_dyn_buffer(const unsigned char *data, size_t len) {
  ScrBytes *bytes = scr_bytes_new(SCR_BYTES_U8, (double)len);
  if (len != 0) memcpy(bytes->data, data, len);
  bytes->is_buffer = true;
  ScrDyn *result = scr_dyn_new_bytes(bytes);
  scr_bytes_release(bytes);
  return result;
}

/* Hash.prototype.digest / Hmac.prototype.digest over any value: a truthy
 * outputEncoding goes through String(), and a name Node does not know
 * gives a Buffer. */
ScrDyn *scr_crypto_hash_digest_dyn(ScrCryptoHash *hash, ScrDyn *enc) {
  if (hash->finalized && !hash->hmac) {
    scr_crypto_hash_finalized();
    return NULL;
  }
  bool truthy = scr_dyn_truthy(enc);
  if (hash->finalized) {
    /* Node answers Buffer.from("").toString(outputEncoding), or the
     * empty Buffer for a falsy encoding or "buffer". */
    bool buffer = !truthy || (enc->kind == SCR_DYN_STR && enc->v.str->len == 6 &&
                              memcmp(enc->v.str->data, "buffer", 6) == 0);
    return buffer ? scr_crypto_dyn_buffer(NULL, 0) : scr_crypto_dyn_str(scr_str_new("", 0));
  }
  int encoding = -1;
  if (truthy) {
    ScrStr *text = enc->kind == SCR_DYN_STR ? scr_str_retain(enc->v.str) : scr_dyn_string_coerce_js(enc);
    if (!text) return NULL;
    if (text->len != 0) encoding = scr_crypto_encoding(text->data, text->len);
    scr_str_release(text);
  }
  unsigned char stack[64];
  unsigned char *digest = scr_crypto_digest_space(hash->out_len, stack);
  size_t n = scr_crypto_hash_finish(hash, digest);
  ScrDyn *result = encoding >= 0 ? scr_crypto_dyn_str(scr_digest_encode(digest, n, encoding))
                                 : scr_crypto_dyn_buffer(digest, n);
  scr_crypto_digest_space_end(digest, hash->out_len, stack);
  return result;
}

/* update(data, inputEncoding) for string data. Node checks that hex data
 * has an even length, then decodes with the encoding, using UTF-8 for a
 * name it does not know. */
ScrCryptoHash *scr_crypto_hash_update_enc(ScrCryptoHash *hash, ScrStr *data, ScrStr *enc) {
  if (!scr_crypto_hash_updatable(hash)) return NULL;
  int encoding = scr_crypto_encoding(enc->data, enc->len);
  if (encoding == SCR_CRYPTO_HEX) {
    double units = scr_str_utf16_len(data);
    if (fmod(units, 2.0) != 0) {
      char reason[96];
      snprintf(reason, sizeof reason, "is invalid for data of length %.0f", units);
      ScrDyn *value = scr_crypto_dyn_str(scr_str_retain(enc));
      scr_dyn_arg_value_fail("encoding", reason, value);
      scr_dyn_release(value);
      return NULL;
    }
  }
  if (encoding < 0 || encoding == SCR_CRYPTO_UTF8) return scr_crypto_hash_update_str(hash, data);
  const char *name = scr_crypto_encoding_names[encoding];
  ScrStr *canonical = scr_str_new(name, strlen(name));
  ScrBytes *bytes = scr_bytes_from_str(data, canonical);
  scr_str_release(canonical);
  if (!bytes) return NULL;
  ScrCryptoHash *result = scr_crypto_hash_update_raw(hash, bytes->data, bytes->len);
  scr_crypto_zero(bytes->data, bytes->len);
  scr_bytes_release(bytes);
  return result;
}

static const char scr_crypto_data_types[] =
    "of type string or an instance of Buffer, TypedArray, or DataView";

/* update(data, inputEncoding) over any values. */
ScrCryptoHash *scr_crypto_hash_update_dyn(ScrCryptoHash *hash, ScrDyn *data, ScrDyn *enc) {
  if (!scr_crypto_hash_updatable(hash)) return NULL;
  if (data->kind == SCR_DYN_TYPED_REF) {
    ScrDyn *value = scr_dyn_typed_ref_materialize(data);
    if (!value) return NULL;
    ScrCryptoHash *result = scr_crypto_hash_update_dyn(hash, value, enc);
    scr_dyn_release(value);
    return result;
  }
  if (data->kind == SCR_DYN_STR) {
    /* A non-string encoding is UTF-8 in both of Node's checks. */
    if (enc->kind == SCR_DYN_STR) return scr_crypto_hash_update_enc(hash, data->v.str, enc->v.str);
    return scr_crypto_hash_update_str(hash, data->v.str);
  }
  if (data->kind == SCR_DYN_BYTES) return scr_crypto_hash_update_bytes(hash, data->v.bytes);
  scr_dyn_arg_type_fail("data", scr_crypto_data_types, data);
  return NULL;
}

/* validateUint32(value, name). */
static bool scr_crypto_uint32(const ScrDyn *value, const char *name, double *out) {
  if (value->kind != SCR_DYN_NUM) {
    if (strchr(name, '.')) scr_dyn_prop_type_fail(name, "of type number", value);
    else scr_dyn_arg_type_fail(name, "of type number", value);
    return false;
  }
  if (!scr_crypto_integer(value->v.num, name, 4294967295.0)) return false;
  *out = value->v.num + 0.0;
  return true;
}

/* typeof value === "object" && value !== null. */
static bool scr_crypto_is_object(const ScrDyn *value) {
  switch (value->kind) {
    case SCR_DYN_OBJ:
    case SCR_DYN_ARR:
    case SCR_DYN_BYTES:
    case SCR_DYN_HANDLE:
    case SCR_DYN_PROMISE:
    case SCR_DYN_TYPED_REF:
      return true;
    default:
      return false;
  }
}

/* An own option, or NULL when absent or undefined. Options other than
 * plain objects carry none of the digest options; the entry points
 * materialize typed objects first. */
static const ScrDyn *scr_crypto_option(const ScrDyn *options, const char *key) {
  if (options->kind != SCR_DYN_OBJ) return NULL;
  const ScrDyn *value = scr_dyn_obj_get(options, key, strlen(key));
  return value && value->kind != SCR_DYN_UNDEF ? value : NULL;
}

/* Node's normalizeCShakeParameter(): a string or ArrayBuffer/view without
 * NUL bytes. Node 24.22 then refuses every digest these options reach. */
static bool scr_crypto_cshake_param(const ScrDyn *value, const char *name) {
  const unsigned char *bytes;
  size_t len;
  bool buffer;
  ScrBytes *source = NULL;
  if (value->kind == SCR_DYN_STR) {
    bytes = (const unsigned char *)value->v.str->data;
    len = value->v.str->len;
    buffer = true;
  } else if (value->kind == SCR_DYN_BYTES) {
    bytes = value->v.bytes->data;
    len = (size_t)scr_bytes_byte_len(value->v.bytes);
    buffer = value->v.bytes->is_buffer;
  } else if (scr_buffer_storage_is(value)) {
    source = scr_bytes_buffer_source(value);
    if (!source) return false;
    bytes = source->data;
    len = source->len;
    buffer = false;
  } else {
    scr_dyn_prop_type_fail(
        name, "of type string or an instance of ArrayBuffer, Buffer, TypedArray, or DataView", value);
    return false;
  }
  bool nul = len != 0 && memchr(bytes, 0, len) != NULL;
  if (nul && buffer) {
    /* util.inspect's Buffer form, which shows the first 50 bytes. */
    ScrJsonBuf b;
    scr_jb_init(&b);
    scr_jb_puts(&b, "The property '");
    scr_jb_puts(&b, name);
    scr_jb_puts(&b, "' must not contain NUL bytes. Received <Buffer");
    size_t shown = len < 50 ? len : 50;
    for (size_t i = 0; i < shown; i++) {
      char hex[4];
      snprintf(hex, sizeof hex, " %02x", bytes[i]);
      scr_jb_puts(&b, hex);
    }
    if (len > shown) {
      char more[64];
      snprintf(more, sizeof more, " ... %zu more byte%s", len - shown, len - shown == 1 ? "" : "s");
      scr_jb_puts(&b, more);
    }
    scr_jb_puts(&b, ">");
    ScrStr *message = scr_jb_finish(&b);
    scr_throw_error_msg_code(SCR_ERR_TYPE, message->data, message->len, "ERR_INVALID_ARG_VALUE");
    scr_str_release(message);
  } else if (nul) {
    static const char message[] = "A digest option with NUL bytes in a view other than a Buffer has no native lowering";
    scr_throw_error_msg_code(SCR_ERR_ERROR, message, sizeof message - 1, "SC2020");
  }
  if (source) scr_bytes_release(source);
  return !nul;
}

/* The functionName and customization options, validated in Node's order.
 * Sets `present` when either is given. */
static bool scr_crypto_cshake_options(const ScrDyn *options, bool *present) {
  *present = false;
  static const char *const keys[2][2] = {{"functionName", "options.functionName"},
                                         {"customization", "options.customization"}};
  for (int i = 0; i < 2; i++) {
    const ScrDyn *value = scr_crypto_option(options, keys[i][0]);
    if (!value) continue;
    if (!scr_crypto_cshake_param(value, keys[i][1])) return false;
    *present = true;
  }
  return true;
}

/* OpenSSL's EVP_R_NOT_XOF_OR_INVALID_LENGTH, with Node's library, reason
 * and code properties. */
static void scr_crypto_not_xof(void) {
  static const char message[] = "error:030000B2:digital envelope routines::not XOF or invalid length";
  static const char code[] = "ERR_OSSL_EVP_NOT_XOF_OR_INVALID_LENGTH";
  ScrStr *text = scr_str_new(message, sizeof message - 1);
  ScrError *e = scr_error_new(SCR_ERR_ERROR, text);
  scr_str_release(text);
  scr_error_set_prop(e, "library", 7, scr_crypto_dyn_str(scr_str_new("digital envelope routines", 25)));
  scr_error_set_prop(e, "reason", 6, scr_crypto_dyn_str(scr_str_new("not XOF or invalid length", 25)));
  scr_error_set_code(e, code);
  scr_error_set_prop(e, "code", 4, scr_crypto_dyn_str(scr_str_new(code, sizeof code - 1)));
  scr_throw_obj(e, &scr_error_retain_v, &scr_error_release_v, scr_error_trace_arg());
}

/* options.outputLength when `options` is an object. */
static bool scr_crypto_output_length(const ScrDyn *options, const char *name, bool *present,
                                     double *length) {
  *present = false;
  if (!scr_crypto_is_object(options)) return true;
  const ScrDyn *value = scr_crypto_option(options, "outputLength");
  if (!value) return true;
  if (!scr_crypto_uint32(value, name, length)) return false;
  *present = true;
  return true;
}

/* createHash(algorithm, options). */
ScrCryptoHash *scr_crypto_hash_new_opts(ScrStr *alg, ScrDyn *options) {
  if (options->kind == SCR_DYN_TYPED_REF) {
    ScrDyn *value = scr_dyn_typed_ref_materialize(options);
    if (!value) return NULL;
    ScrCryptoHash *result = scr_crypto_hash_new_opts(alg, value);
    scr_dyn_release(value);
    return result;
  }
  bool has_length, cshake = false;
  double length;
  if (!scr_crypto_output_length(options, "options.outputLength", &has_length, &length)) return NULL;
  if (!scr_crypto_cshake_options(options, &cshake)) return NULL;
  ScrDigestAlg kind;
  if (!scr_hash_alg(alg->data, alg->len, &kind) || cshake) {
    scr_crypto_digest_unsupported();
    return NULL;
  }
  if (has_length && !scr_digest_info[kind].xof && length != scr_digest_info[kind].size) {
    scr_crypto_not_xof();
    return NULL;
  }
  ScrCryptoHash *hash = scr_crypto_hash_alloc(kind, false, NULL, 0);
  if (has_length) hash->out_len = (size_t)length;
  return hash;
}

/* createHmac(algorithm, key, options): Node's options.encoding and
 * prepareSecretKey checks (a KeyObject's bytes are the key), then the
 * digest lookup. */
ScrCryptoHash *scr_crypto_hmac_new_dyn(ScrStr *alg, ScrDyn *key, ScrDyn *options) {
  if (options->kind == SCR_DYN_TYPED_REF) {
    ScrDyn *value = scr_dyn_typed_ref_materialize(options);
    if (!value) return NULL;
    ScrCryptoHash *result = scr_crypto_hmac_new_dyn(alg, key, value);
    scr_dyn_release(value);
    return result;
  }
  const ScrStr *encoding = NULL;
  const ScrDyn *option = scr_crypto_option(options, "encoding");
  if (option && option->kind != SCR_DYN_NULL) {
    if (option->kind != SCR_DYN_STR) {
      scr_dyn_prop_type_fail("options.encoding", "of type string", option);
      return NULL;
    }
    encoding = option->v.str;
  }
  if (key->kind == SCR_DYN_TYPED_REF) {
    ScrDyn *value = scr_dyn_typed_ref_materialize(key);
    if (!value) return NULL;
    ScrCryptoHash *result = scr_crypto_hmac_new_dyn(alg, value, options);
    scr_dyn_release(value);
    return result;
  }
  ScrBytes *bytes;
  size_t key_object_len;
  const unsigned char *key_object = scr_key_object_bytes(key, &key_object_len);
  if (key_object) {
    bytes = scr_bytes_new(SCR_BYTES_U8, (double)key_object_len);
    if (key_object_len) memcpy(bytes->data, key_object, key_object_len);
  } else if (scr_crypto_is_key_object(key)) {
    /* A private or public KeyObject: scr_pki.c reports Node's error. */
    scr_crypto_reject_asymmetric_secret(key);
    return NULL;
  } else if (key->kind == SCR_DYN_STR) {
    ScrStr *utf8 = encoding ? NULL : scr_str_new("utf8", 4);
    bytes = scr_bytes_from_str_checked(key->v.str, encoding ? encoding : utf8);
    if (utf8) scr_str_release(utf8);
  } else if (key->kind == SCR_DYN_BYTES || scr_buffer_storage_is(key)) {
    bytes = scr_bytes_buffer_source(key);
  } else {
    scr_dyn_arg_type_fail("key",
                          "of type string or an instance of ArrayBuffer, Buffer, TypedArray, "
                          "DataView, KeyObject, or CryptoKey",
                          key);
    return NULL;
  }
  if (!bytes) return NULL;
  ScrCryptoHash *result = NULL;
  ScrDigestAlg kind;
  if (!scr_digest_alg(alg->data, alg->len, &kind)) scr_crypto_invalid_digest(alg);
  else if (scr_crypto_hmac_digest_ok(kind))
    result = scr_crypto_hash_alloc(kind, true, bytes->data, (size_t)scr_bytes_byte_len(bytes));
  scr_bytes_release(bytes);
  return result;
}

/* hash.copy(options). A copy without outputLength has the default
 * length, as in Node. */
ScrCryptoHash *scr_crypto_hash_copy_opts(ScrCryptoHash *hash, ScrDyn *options) {
  if (options->kind == SCR_DYN_TYPED_REF) {
    ScrDyn *value = scr_dyn_typed_ref_materialize(options);
    if (!value) return NULL;
    ScrCryptoHash *result = scr_crypto_hash_copy_opts(hash, value);
    scr_dyn_release(value);
    return result;
  }
  if (!scr_crypto_hash_copyable(hash)) return NULL;
  bool has_length;
  double length;
  if (!scr_crypto_output_length(options, "options.outputLength", &has_length, &length)) return NULL;
  ScrDigestAlg kind = hash->inner.alg;
  if (has_length && !scr_digest_info[kind].xof && length != scr_digest_info[kind].size) {
    scr_crypto_not_xof();
    return NULL;
  }
  ScrCryptoHash *copy = scr_crypto_hash_copy(hash);
  if (copy && has_length) copy->out_len = (size_t)length;
  return copy;
}

static ScrStr *scr_hash_digest_raw(const ScrStr *alg, const unsigned char *data, size_t len,
                                    const ScrStr *enc) {
  ScrDigestAlg kind;
  if (!scr_hash_alg(alg->data, alg->len, &kind)) {
    scr_crypto_hash_digest_unsupported(alg);
    return NULL;
  }
  int encoding = scr_crypto_encoding(enc->data, enc->len);
  if (encoding < 0) {
    scr_crypto_encoding_unlowered();
    return NULL;
  }
  unsigned char d[64];
  ScrDigestCtx ctx;
  scr_digest_init(&ctx, kind);
  scr_digest_update(&ctx, data, len);
  size_t n = scr_digest_final(&ctx, d);
  ScrStr *result = scr_digest_encode(d, n, encoding);
  scr_crypto_zero(d, sizeof d);
  return result;
}

/* Strings hash their UTF-8 bytes (Node's default input encoding — ScrStr
 * storage IS utf8, so the bytes are the string's own). `enc` is an output
 * encoding name. Borrowed; +1. */
ScrStr *scr_crypto_hash_digest_str(ScrStr *alg, ScrStr *data, ScrStr *enc) {
  char *owned;
  const char *bytes = scr_str_utf8(data, &owned);
  ScrStr *r = scr_hash_digest_raw(alg, (const unsigned char *)bytes, data->len, enc);
  scr_str_utf8_end(owned);
  return r;
}

ScrStr *scr_crypto_hash_digest_bytes(ScrStr *alg, ScrBytes *data, ScrStr *enc) {
  SCR_BYTES_SNAPSHOT(data);
  return scr_hash_digest_raw(alg, data->data, data->len * scr_bytes_elem_size(data->elem), enc);
}

/* crypto.hash() with every option: the digest of `len` bytes as a
 * string in `encoding`, or as a Buffer when `encoding` is -1. */
static ScrDyn *scr_hash_oneshot_raw(const ScrStr *alg, const unsigned char *data, size_t len,
                                     int encoding, bool cshake, bool has_length,
                                     double length) {
  ScrDigestAlg kind;
  if (!scr_hash_alg(alg->data, alg->len, &kind)) {
    scr_crypto_hash_digest_unsupported(alg);
    return NULL;
  }
  if (cshake) {
    static const char message[] = "Digest options are not supported";
    scr_throw_error_msg(SCR_ERR_ERROR, message, sizeof message - 1);
    return NULL;
  }
  const ScrDigestInfo *info = &scr_digest_info[kind];
  if (has_length && !info->xof && length != info->size) {
    ScrJsonBuf b;
    scr_jb_init(&b);
    char count[32];
    snprintf(count, sizeof count, "%.0f", length);
    scr_jb_puts(&b, "Output length ");
    scr_jb_puts(&b, count);
    scr_jb_puts(&b, " is invalid for ");
    scr_jb_put_str(&b, alg);
    scr_jb_puts(&b, ", which does not support XOF");
    ScrStr *message = scr_jb_finish(&b);
    scr_throw_error_msg(SCR_ERR_ERROR, message->data, message->len);
    scr_str_release(message);
    return NULL;
  }
  size_t out_len = has_length ? (size_t)length : info->size;
  unsigned char stack[64];
  unsigned char *digest = scr_crypto_digest_space(out_len, stack);
  ScrDigestCtx ctx;
  scr_digest_init(&ctx, kind);
  scr_digest_update(&ctx, data, len);
  if (info->xof) scr_digest_final_xof(&ctx, digest, out_len);
  else scr_digest_final(&ctx, digest);
  scr_crypto_zero(&ctx, sizeof ctx);
  ScrDyn *result = encoding >= 0
                       ? scr_crypto_dyn_str(scr_digest_encode(digest, out_len, encoding))
                       : scr_crypto_dyn_buffer(digest, out_len);
  scr_crypto_digest_space_end(digest, out_len, stack);
  return result;
}

/* crypto.hash(algorithm, input, options) over any input and options, in
 * Node's validation order. */
ScrDyn *scr_crypto_hash_oneshot(ScrStr *alg, ScrDyn *input, ScrDyn *options) {
  if (input->kind == SCR_DYN_TYPED_REF || options->kind == SCR_DYN_TYPED_REF) {
    bool data = input->kind == SCR_DYN_TYPED_REF;
    ScrDyn *value = scr_dyn_typed_ref_materialize(data ? input : options);
    if (!value) return NULL;
    ScrDyn *result = data ? scr_crypto_hash_oneshot(alg, value, options)
                          : scr_crypto_hash_oneshot(alg, input, value);
    scr_dyn_release(value);
    return result;
  }
  if (input->kind != SCR_DYN_STR && input->kind != SCR_DYN_BYTES) {
    scr_dyn_arg_type_fail("input", "of type string or an instance of Buffer, TypedArray, or DataView",
                          input);
    return NULL;
  }
  const ScrDyn *encoding = NULL;
  bool has_length = false, cshake = false;
  double length = 0;
  const ScrDyn *length_value = NULL;
  if (options->kind == SCR_DYN_STR) {
    encoding = options;
  } else if (options->kind != SCR_DYN_UNDEF) {
    if (options->kind == SCR_DYN_ARR || !scr_crypto_is_object(options)) {
      scr_dyn_arg_type_fail("options", "of type object", options);
      return NULL;
    }
    length_value = scr_crypto_option(options, "outputLength");
    encoding = scr_crypto_option(options, "outputEncoding");
    if (!scr_crypto_cshake_options(options, &cshake)) return NULL;
  }
  int name = SCR_CRYPTO_HEX;
  if (encoding && encoding->kind != SCR_DYN_NULL &&
      !(encoding->kind == SCR_DYN_STR && encoding->v.str->len == 3 &&
        memcmp(encoding->v.str->data, "hex", 3) == 0)) {
    if (encoding->kind != SCR_DYN_STR) {
      scr_dyn_arg_type_fail("outputEncoding", "of type string", encoding);
      return NULL;
    }
    const ScrStr *text = encoding->v.str;
    name = scr_crypto_encoding(text->data, text->len);
    if (name < 0 && !scr_digest_name_is(text->data, text->len, "buffer")) {
      scr_dyn_arg_value_fail("outputEncoding", NULL, encoding);
      return NULL;
    }
  }
  if (length_value) {
    if (!scr_crypto_uint32(length_value, "outputLength", &length)) return NULL;
    has_length = true;
  }
  if (input->kind == SCR_DYN_STR) {
    ScrStr *data = input->v.str;
    char *owned;
    const char *bytes = scr_str_utf8(data, &owned);
    ScrDyn *result = scr_hash_oneshot_raw(alg, (const unsigned char *)bytes, data->len, name,
                                          cshake, has_length, length);
    scr_str_utf8_end(owned);
    return result;
  }
  ScrBytes *data = input->v.bytes;
  SCR_BYTES_SNAPSHOT(data);
  return scr_hash_oneshot_raw(alg, data->data, (size_t)scr_bytes_byte_len(data), name, cshake,
                              has_length, length);
}

bool scr_crypto_timing_safe_equal(ScrBytes *left, ScrBytes *right) {
  SCR_BYTES_SNAPSHOT(left);
  SCR_BYTES_SNAPSHOT(right);
  size_t left_len = left->len * scr_bytes_elem_size(left->elem);
  size_t right_len = right->len * scr_bytes_elem_size(right->elem);
  if (left_len != right_len) {
    static const char msg[] = "Input buffers must have the same byte length";
    scr_throw_error_msg_code(SCR_ERR_RANGE, msg, sizeof msg - 1,
                             "ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH");
    return false;
  }
  unsigned char diff = 0;
  for (size_t i = 0; i < left_len; i++) diff |= left->data[i] ^ right->data[i];
  return diff == 0;
}

/* A timingSafeEqual argument as a view: any TypedArray, DataView or
 * Buffer, or a u8 view over an ArrayBuffer or SharedArrayBuffer. +1, or
 * NULL with Node's ERR_INVALID_ARG_TYPE pending. */
static ScrBytes *scr_timing_view(const ScrDyn *value, const char *name) {
  if (value->kind == SCR_DYN_TYPED_REF) {
    ScrDyn *materialized = scr_dyn_typed_ref_materialize(value);
    if (!materialized) return NULL;
    ScrBytes *view = scr_timing_view(materialized, name);
    scr_dyn_release(materialized);
    return view;
  }
  if (value->kind == SCR_DYN_BYTES) return scr_bytes_retain(value->v.bytes);
  if (scr_buffer_storage_is(value)) return scr_bytes_buffer_source(value);
  char message[128];
  int n = snprintf(message, sizeof message,
                   "The \"%s\" argument must be an instance of ArrayBuffer, Buffer, TypedArray, or DataView.",
                   name);
  scr_throw_error_msg_code(SCR_ERR_TYPE, message, (size_t)n, "ERR_INVALID_ARG_TYPE");
  return NULL;
}

/* timingSafeEqual(buf1, buf2) over any values, checked in Node's order:
 * buf1, buf2, then the byte lengths. */
bool scr_crypto_timing_safe_equal_dyn(ScrDyn *left, ScrDyn *right) {
  ScrBytes *a = scr_timing_view(left, "buf1");
  if (!a) return false;
  ScrBytes *b = scr_timing_view(right, "buf2");
  bool equal = b && scr_crypto_timing_safe_equal(a, b);
  scr_bytes_release(a);
  if (b) scr_bytes_release(b);
  return equal;
}

/* ERR_OUT_OF_RANGE's Received value: integers beyond 2^32 take Node's
 * underscore separators. */
static void scr_crypto_received(double value, char out[64]) {
  if (isfinite(value) && floor(value) == value && fabs(value) > 4294967296.0) {
    char digits[40];
    snprintf(digits, sizeof digits, "%.0f", value);
    size_t len = strlen(digits), o = 0, start = digits[0] == '-' ? 1 : 0;
    for (size_t i = 0; i < len; i++) {
      if (i > start && (len - i) % 3 == 0) out[o++] = '_';
      out[o++] = digits[i];
    }
    out[o] = '\0';
    return;
  }
  size_t n = scr_f64_to_str(value, out);
  out[n] = '\0';
}

static void scr_crypto_out_of_range(const char *name, const char *requirement, double value) {
  char received[64], message[256];
  scr_crypto_received(value, received);
  int n = snprintf(message, sizeof message, "The value of \"%s\" is out of range. It must be %s. Received %s",
                   name, requirement, received);
  scr_throw_error_msg_code(SCR_ERR_RANGE, message, (size_t)n, "ERR_OUT_OF_RANGE");
}

/* Node's assertOffset and assertSize: offset and size count elements and
 * are checked and returned in bytes, truncated to uint32. */
static bool scr_random_offset(double offset, double element, double length, double *out) {
  offset *= element;
  double max = length < 2147483647.0 ? length : 2147483647.0;
  if (isnan(offset) || offset > max || offset < 0) {
    char requirement[64];
    snprintf(requirement, sizeof requirement, ">= 0 && <= %.0f", max);
    scr_crypto_out_of_range("offset", requirement, offset);
    return false;
  }
  *out = (double)(uint32_t)offset;
  return true;
}

static bool scr_random_size(double size, double element, double offset, double length, double *out) {
  size *= element;
  if (isnan(size) || size > 2147483647.0 || size < 0) {
    scr_crypto_out_of_range("size", ">= 0 && <= 2147483647", size);
    return false;
  }
  if (size + offset > length) {
    char requirement[64];
    snprintf(requirement, sizeof requirement, "<= %.0f", length);
    scr_crypto_out_of_range("size + offset", requirement, size + offset);
    return false;
  }
  *out = (double)(uint32_t)size;
  return true;
}

/* Random bytes into [offset, offset + size) of a view's memory. */
static void scr_random_write(ScrBytes *bytes, size_t offset, size_t size) {
  if (size == 0) return;
  if (bytes->shared) {
    uint8_t *random = malloc(size);
    if (!random) scr_trap("scriptc: out of memory\n");
    arc4random_buf(random, size);
    scr_bytes_write(bytes, offset, random, size);
    free(random);
  } else {
    arc4random_buf(bytes->data + offset, size);
  }
}

/* randomFillSync's checks and fill over a view; `size` NULL fills to the
 * end. False with the error pending. */
static bool scr_random_fill_view(ScrBytes *bytes, double offset, const double *size,
                                 size_t *filled) {
  double element = (double)scr_bytes_elem_size(bytes->elem);
  double length = scr_bytes_byte_len(bytes);
  double start, count;
  if (!scr_random_offset(offset, element, length, &start)) return false;
  if (size) {
    if (!scr_random_size(*size, element, start, length, &count)) return false;
  } else {
    count = length - start;
  }
  scr_random_write(bytes, (size_t)start, (size_t)count);
  if (filled) *filled = (size_t)count;
  return true;
}

ScrBytes *scr_crypto_random_fill(ScrBytes *bytes, double offset, double size) {
  if (!scr_random_fill_view(bytes, offset, &size, NULL)) return NULL;
  return scr_bytes_retain(bytes);
}

ScrBytes *scr_crypto_random_fill_rest(ScrBytes *bytes, double offset) {
  if (!scr_random_fill_view(bytes, offset, NULL, NULL)) return NULL;
  return scr_bytes_retain(bytes);
}

/* The view a randomFill buffer argument names: a TypedArray, DataView or
 * Buffer, or a u8 view over an ArrayBuffer or SharedArrayBuffer. +1, or
 * NULL with Node's ERR_INVALID_ARG_TYPE pending. */
static ScrBytes *scr_random_buffer(const ScrDyn *buf) {
  if (buf->kind == SCR_DYN_BYTES) return scr_bytes_retain(buf->v.bytes);
  if (scr_buffer_storage_is(buf)) return scr_bytes_buffer_source(buf);
  scr_dyn_arg_type_fail("buf", "an instance of ArrayBuffer or ArrayBufferView", buf);
  return NULL;
}

/* validateNumber(value, name). */
static bool scr_random_number(const ScrDyn *value, const char *name, double *out) {
  if (value->kind != SCR_DYN_NUM) {
    scr_dyn_arg_type_fail(name, "of type number", value);
    return false;
  }
  *out = value->v.num;
  return true;
}

/* randomFillSync(buf, offset, size) over any values; returns buf. */
ScrDyn *scr_crypto_random_fill_sync_dyn(ScrDyn *buf, ScrDyn *offset, ScrDyn *size) {
  if (buf->kind == SCR_DYN_TYPED_REF) {
    ScrDyn *value = scr_dyn_typed_ref_materialize(buf);
    if (!value) return NULL;
    ScrDyn *result = scr_crypto_random_fill_sync_dyn(value, offset, size);
    scr_dyn_release(value);
    return result;
  }
  ScrBytes *view = scr_random_buffer(buf);
  if (!view) return NULL;
  double start = 0, count = 0;
  bool ok = (offset->kind == SCR_DYN_UNDEF || scr_random_number(offset, "offset", &start)) &&
            (size->kind == SCR_DYN_UNDEF || scr_random_number(size, "size", &count)) &&
            scr_random_fill_view(view, start, size->kind == SCR_DYN_UNDEF ? NULL : &count, NULL);
  scr_bytes_release(view);
  return ok ? scr_dyn_retain(buf) : NULL;
}

/* randomFill(buf[, offset[, size]], callback)'s arguments: `form` is the
 * argument count before the callback (1, 2 or 3), or 4 for an offset with
 * an undefined size, which fills to the end. Node sizes a fill whose
 * callback takes the offset's place by buf.length (elements; a DataView
 * or ArrayBuffer has none and fills to the end), and one whose callback
 * takes the size's place by length minus offset. Returns the byte count,
 * or -1 with the error pending. */
double scr_crypto_random_fill_args(ScrBytes *view, bool typed_array, double offset, double size,
                                   int form) {
  double element = (double)scr_bytes_elem_size(view->elem);
  double length = scr_bytes_byte_len(view);
  double elements = typed_array ? (double)view->len : NAN;
  bool has_size = true;
  if (form == 1) {
    offset = 0;
    size = elements;
    has_size = typed_array;
  } else if (form == 2) {
    size = (typed_array ? elements : length) - offset;
  } else if (form == 4) {
    has_size = false;
  }
  double start, count;
  if (!scr_random_offset(offset, element, length, &start)) return -1;
  if (has_size) {
    if (!scr_random_size(size, element, start, length, &count)) return -1;
  } else {
    count = length - start;
  }
  scr_random_write(view, (size_t)start, (size_t)count);
  return count;
}

/* ── randomInt ─────────────────────────────────────────────────────── */

/* randomInt draws from a 6 KiB cache, six bytes per attempt, as Node's
 * does: the sync form refills it in place, and the callback form waits
 * for an asynchronous refill, so a callback settles on the next tick or
 * after a refill when Node's does. Consumed bytes are cleared. */
#define SCR_RANDOM_INT_CACHE 1024
static SCR_TL unsigned char scr_random_int_cache[6 * SCR_RANDOM_INT_CACHE];
static SCR_TL unsigned scr_random_int_left = 0;

void scr_crypto_random_int_refill(void) {
  arc4random_buf(scr_random_int_cache, sizeof scr_random_int_cache);
  scr_random_int_left = SCR_RANDOM_INT_CACHE;
}

/* Node's validation. Sets the range; false with the error pending. */
bool scr_crypto_random_int_check(double min, double max, bool min_given, double *range) {
  if (!isfinite(min) || floor(min) != min || fabs(min) > 9007199254740991.0) {
    ScrDyn *value = scr_dyn_new_num(min);
    scr_dyn_arg_type_fail("min", "a safe integer", value);
    scr_dyn_release(value);
    return false;
  }
  if (!isfinite(max) || floor(max) != max || fabs(max) > 9007199254740991.0) {
    ScrDyn *value = scr_dyn_new_num(max);
    scr_dyn_arg_type_fail("max", "a safe integer", value);
    scr_dyn_release(value);
    return false;
  }
  if (max <= min) {
    char min_text[64], requirement[96];
    scr_crypto_received(min, min_text);
    snprintf(requirement, sizeof requirement, "greater than the value of \"min\" (%s)", min_text);
    scr_crypto_out_of_range("max", requirement, max);
    return false;
  }
  *range = max - min;
  if (!(*range <= 281474976710655.0)) {
    scr_crypto_out_of_range(min_given ? "max - min" : "max", "<= 281474976710655", *range);
    return false;
  }
  return true;
}

/* Attempts from the cache until one is accepted (true) or the cache is
 * empty (false). */
bool scr_crypto_random_int_try(double min, double range, double *out) {
  const uint64_t rand_max = (UINT64_C(1) << 48) - 1;
  const uint64_t span = (uint64_t)range;
  const uint64_t limit = rand_max - (rand_max % span);
  while (scr_random_int_left != 0) {
    unsigned char *p = scr_random_int_cache + 6 * (SCR_RANDOM_INT_CACHE - scr_random_int_left);
    scr_random_int_left--;
    uint64_t x = 0;
    for (int i = 0; i < 6; i++) x = (x << 8) | p[i];
    scr_crypto_zero(p, 6);
    if (x < limit) {
      *out = (double)(x % span) + min;
      return true;
    }
  }
  return false;
}

static double scr_random_int_sync(double min, double max, bool min_given) {
  double range, value;
  if (!scr_crypto_random_int_check(min, max, min_given, &range)) return 0;
  for (;;) {
    if (scr_random_int_left == 0) scr_crypto_random_int_refill();
    if (scr_crypto_random_int_try(min, range, &value)) return value;
  }
}

double scr_crypto_random_int(double min, double max) { return scr_random_int_sync(min, max, true); }

double scr_crypto_random_int_max(double max) { return scr_random_int_sync(0, max, false); }

/* ── randomUUID / randomUUIDv7 ─────────────────────────────────────── */

static ScrStr *scr_uuid_string(unsigned char b[16], unsigned char version) {
  b[6] = (unsigned char)((b[6] & 0x0f) | version);
  b[8] = (unsigned char)((b[8] & 0x3f) | 0x80); /* variant 10xx */
  char out[37];
  static const char hex[] = "0123456789abcdef";
  size_t o = 0;
  for (size_t i = 0; i < 16; i++) {
    if (i == 4 || i == 6 || i == 8 || i == 10) out[o++] = '-';
    out[o++] = hex[b[i] >> 4];
    out[o++] = hex[b[i] & 0x0f];
  }
  return scr_str_new(out, 36);
}

/* randomUUID and randomUUIDv7 take 16 bytes at a time from a batch of
 * 128 UUIDs' worth, as Node does; disableEntropyCache draws fresh bytes.
 * Consumed bytes are cleared. */
#define SCR_UUID_BATCH 128
static SCR_TL unsigned char scr_uuid_batch[16 * SCR_UUID_BATCH];
static SCR_TL unsigned scr_uuid_left = 0;

static void scr_uuid_bytes(unsigned char out[16], bool cached) {
  if (!cached) {
    arc4random_buf(out, 16);
    return;
  }
  if (scr_uuid_left == 0) {
    arc4random_buf(scr_uuid_batch, sizeof scr_uuid_batch);
    scr_uuid_left = SCR_UUID_BATCH;
  }
  unsigned char *p = scr_uuid_batch + 16 * (SCR_UUID_BATCH - scr_uuid_left);
  scr_uuid_left--;
  memcpy(out, p, 16);
  scr_crypto_zero(p, 16);
}

ScrStr *scr_crypto_random_uuid(void) {
  unsigned char b[16];
  scr_uuid_bytes(b, true);
  return scr_uuid_string(b, 0x40);
}

/* The options both UUID functions take: validateObject, then
 * options.disableEntropyCache, which must be a boolean and bypasses the
 * batch. */
static bool scr_uuid_options(ScrDyn *options, bool *cached) {
  *cached = true;
  if (options->kind == SCR_DYN_UNDEF) return true;
  if (options->kind == SCR_DYN_TYPED_REF) {
    ScrDyn *value = scr_dyn_typed_ref_materialize(options);
    if (!value) return false;
    bool ok = scr_uuid_options(value, cached);
    scr_dyn_release(value);
    return ok;
  }
  if (options->kind == SCR_DYN_ARR || options->kind == SCR_DYN_NULL || !scr_crypto_is_object(options)) {
    scr_dyn_arg_type_fail("options", "of type object", options);
    return false;
  }
  ScrDyn *flag = scr_dyn_obj_read(options, "disableEntropyCache", 19);
  bool ok = !flag || flag->kind == SCR_DYN_UNDEF || flag->kind == SCR_DYN_BOOL;
  if (!ok) scr_dyn_prop_type_fail("options.disableEntropyCache", "of type boolean", flag);
  if (ok && flag && flag->kind == SCR_DYN_BOOL && flag->v.b) *cached = false;
  if (flag) scr_dyn_release(flag);
  return ok;
}

ScrStr *scr_crypto_random_uuid_opts(ScrDyn *options) {
  bool cached;
  if (!scr_uuid_options(options, &cached)) return NULL;
  unsigned char b[16];
  scr_uuid_bytes(b, cached);
  return scr_uuid_string(b, 0x40);
}

/* A version 7 UUID: the 48-bit Unix time in milliseconds, then random
 * bits, as Node writes it. */
ScrStr *scr_crypto_random_uuid_v7(ScrDyn *options) {
  bool cached;
  if (!scr_uuid_options(options, &cached)) return NULL;
  unsigned char b[16];
  scr_uuid_bytes(b, cached);
  uint64_t now = (uint64_t)scr_date_now();
  for (int i = 0; i < 6; i++) b[i] = (unsigned char)(now >> (40 - 8 * i));
  return scr_uuid_string(b, 0x70);
}

/* ── KeyObject (secret keys) ──────────────────────────────────────────
 * node:crypto's SecretKeyObject as a native dyn handle over the key bytes:
 * createSecretKey, generateKey/generateKeySync for "hmac" and "aes", the
 * type and symmetricKeySize getters, export() and equals(). createHmac and
 * hkdf take these keys. The bytes are cleared when the last reference
 * goes. */
typedef struct ScrKeyObject {
  size_t rc;
  size_t len;
  unsigned char data[];
} ScrKeyObject;

static void *scr_key_object_retain(void *p) {
  ScrKeyObject *key = p;
  if (key->rc != SIZE_MAX) key->rc++;
  return key;
}

static void scr_key_object_release(void *p) {
  ScrKeyObject *key = p;
  if (!key || key->rc == SIZE_MAX || --key->rc != 0) return;
  scr_crypto_zero(key->data, key->len);
  free(key);
}

static void scr_key_object_install(void);

static ScrDyn *scr_key_object_new(const unsigned char *data, size_t len) {
  scr_key_object_install();
  ScrKeyObject *key = malloc(sizeof *key + (len ? len : 1));
  if (!key) scr_trap("scriptc: out of memory\n");
  key->rc = 1;
  key->len = len;
  if (len) memcpy(key->data, data, len);
  ScrDyn *box = scr_dyn_new_handle(key, SCR_DYNH_KEY_OBJECT);
  scr_key_object_release(key);
  return box;
}

/* The key bytes of a KeyObject value, or NULL for any other value. */
const unsigned char *scr_key_object_bytes(const ScrDyn *value, size_t *len) {
  if (value->kind != SCR_DYN_HANDLE || value->v.handle.tag != SCR_DYNH_KEY_OBJECT) return NULL;
  const ScrKeyObject *key = value->v.handle.ptr;
  *len = key->len;
  return key->data;
}

void (*scr_crypto_reject_asymmetric_secret)(const ScrDyn *key) = NULL;

/* `value instanceof KeyObject`: a secret key, or a private or public key
 * (scr_pki.c, matched by its handle tags so this unit does not link it). */
bool scr_crypto_is_key_object(const ScrDyn *value) {
  size_t len;
  if (value->kind == SCR_DYN_HANDLE &&
      (value->v.handle.tag == SCR_DYNH_PRIVATE_KEY || value->v.handle.tag == SCR_DYNH_PUBLIC_KEY))
    return true;
  return scr_key_object_bytes(value, &len) != NULL;
}

static void scr_key_object_type_fail(const char *name, const ScrDyn *value) {
  scr_dyn_arg_type_fail(name, "an instance of KeyObject", value);
}

/* The property flavor of ERR_INVALID_ARG_VALUE: "The property 'x' must be
 * one of: ...". */
static void scr_crypto_property_one_of(const char *name, const char *choices, const ScrDyn *value) {
  char rendered[160], message[320];
  const char *text = scr_dyn_inspect_lite(value, rendered, sizeof rendered);
  int n = snprintf(message, sizeof message, "The property '%s' must be one of: %s. Received %s", name,
                   choices, text);
  scr_throw_error_msg_code(SCR_ERR_TYPE, message, (size_t)n, "ERR_INVALID_ARG_VALUE");
}

/* keyObject.export(options): a copy of the bytes, or a JWK with kty
 * "oct" and the base64url key. */
static ScrDyn *scr_key_object_export(const ScrKeyObject *key, const ScrDyn *options) {
  if (options && options->kind == SCR_DYN_TYPED_REF) {
    ScrDyn *value = scr_dyn_typed_ref_materialize(options);
    if (!value) return NULL;
    ScrDyn *result = scr_key_object_export(key, value);
    scr_dyn_release(value);
    return result;
  }
  bool jwk = false;
  if (options && options->kind != SCR_DYN_UNDEF) {
    if (options->kind == SCR_DYN_ARR || options->kind == SCR_DYN_NULL || !scr_crypto_is_object(options)) {
      scr_dyn_arg_type_fail("options", "of type object", options);
      return NULL;
    }
    ScrDyn *format = scr_dyn_obj_read(options, "format", 6);
    bool ok = !format || format->kind == SCR_DYN_UNDEF;
    if (!ok && format->kind == SCR_DYN_STR) {
      const ScrStr *text = format->v.str;
      if (text->len == 6 && memcmp(text->data, "buffer", 6) == 0) ok = true;
      if (text->len == 3 && memcmp(text->data, "jwk", 3) == 0) ok = jwk = true;
    }
    if (!ok) scr_crypto_property_one_of("options.format", "undefined, 'buffer', 'jwk'", format);
    if (format) scr_dyn_release(format);
    if (!ok) return NULL;
  }
  if (!jwk) return scr_crypto_dyn_buffer(key->data, key->len);
  ScrDyn *out = scr_dyn_new_obj();
  scr_dyn_obj_set(out, "kty", 3, scr_crypto_dyn_str(scr_str_new("oct", 3)));
  ScrBytes view = {.rc = 1, .len = key->len, .elem = SCR_BYTES_U8, .data = (unsigned char *)key->data};
  ScrStr *name = scr_str_new("base64url", 9);
  scr_dyn_obj_set(out, "k", 1, scr_crypto_dyn_str(scr_bytes_to_str(&view, name)));
  scr_str_release(name);
  return out;
}

static ScrDyn *scr_key_object_invoke(void *h, ScrDyn *self, const char *method, ScrDyn *const *args,
                                     size_t argc, const char *what) {
  (void)self;
  const ScrKeyObject *key = h;
  if (strcmp(method, "export") == 0) return scr_key_object_export(key, argc ? args[0] : NULL);
  if (strcmp(method, "equals") == 0) {
    size_t len;
    const unsigned char *other = argc ? scr_key_object_bytes(args[0], &len) : NULL;
    if (!other) {
      ScrDyn *undefined = scr_dyn_undefined();
      scr_key_object_type_fail("otherKeyObject", argc ? args[0] : undefined);
      scr_dyn_release(undefined);
      return NULL;
    }
    bool equal = len == key->len;
    unsigned char diff = 0;
    for (size_t i = 0; equal && i < len; i++) diff |= other[i] ^ key->data[i];
    return scr_dyn_new_bool(equal && diff == 0);
  }
  if (strcmp(method, "toCryptoKey") == 0) {
    static const char message[] = "KeyObject.toCryptoKey() needs WebCrypto CryptoKey values, which have no native lowering";
    scr_throw_error_msg_code(SCR_ERR_ERROR, message, sizeof message - 1, "SC2020");
    return NULL;
  }
  scr_lib_throw_not_a_function(what);
  return NULL;
}

static ScrDyn *scr_key_object_get(void *h, const char *name, size_t len) {
  const ScrKeyObject *key = h;
  if (len == 4 && memcmp(name, "type", 4) == 0) return scr_crypto_dyn_str(scr_str_new("secret", 6));
  if (len == 16 && memcmp(name, "symmetricKeySize", 16) == 0) return scr_dyn_new_num((double)key->len);
  return NULL;
}

/* The getters have no setters; Node's strict-mode TypeError names the
 * prototype that defines each one. */
static bool scr_key_object_set(void *h, const char *name, size_t len, const ScrDyn *value) {
  (void)h;
  (void)value;
  const char *holder = len == 4 && memcmp(name, "type", 4) == 0 ? "KeyObject"
                       : len == 16 && memcmp(name, "symmetricKeySize", 16) == 0 ? "SecretKeyObject"
                                                                                : NULL;
  if (!holder) return false;
  char message[160];
  int n = snprintf(message, sizeof message, "Cannot set property %.*s of #<%s> which has only a getter",
                   (int)len, name, holder);
  scr_throw_error_msg(SCR_ERR_TYPE, message, (size_t)n);
  return true;
}

static ScrDyn *scr_key_object_inspect_view(void *h) {
  (void)h;
  return scr_dyn_new_obj();
}

static const ScrDynHandleOps scr_key_object_ops = {
    .cls = "SecretKeyObject",
    .retain = scr_key_object_retain,
    .release = scr_key_object_release,
    .invoke = scr_key_object_invoke,
    .get = scr_key_object_get,
    .set = scr_key_object_set,
    .inspect_view = scr_key_object_inspect_view,
    .json_empty_object = true,
    .to_string_tag = "KeyObject",
    .inspect_view_empty = true,
};

static void scr_key_object_install(void) {
  static SCR_TL bool installed;
  if (installed) return;
  installed = true;
  scr_dyn_handle_install(SCR_DYNH_KEY_OBJECT, &scr_key_object_ops);
}

/* createSecretKey(key[, encoding]): a string decodes with a string
 * encoding (UTF-8 otherwise); views, ArrayBuffers and SharedArrayBuffers
 * are copied. */
ScrDyn *scr_crypto_create_secret_key(ScrDyn *key, ScrDyn *encoding) {
  if (key->kind == SCR_DYN_TYPED_REF) {
    ScrDyn *value = scr_dyn_typed_ref_materialize(key);
    if (!value) return NULL;
    ScrDyn *result = scr_crypto_create_secret_key(value, encoding);
    scr_dyn_release(value);
    return result;
  }
  ScrBytes *bytes;
  if (key->kind == SCR_DYN_STR) {
    bool named = encoding->kind == SCR_DYN_STR;
    ScrStr *utf8 = named ? NULL : scr_str_new("utf8", 4);
    bytes = scr_bytes_from_str_checked(key->v.str, named ? encoding->v.str : utf8);
    if (utf8) scr_str_release(utf8);
  } else if (key->kind == SCR_DYN_BYTES || scr_buffer_storage_is(key)) {
    bytes = scr_bytes_buffer_source(key);
  } else {
    scr_dyn_arg_type_fail("key", "an instance of ArrayBuffer, Buffer, TypedArray, or DataView", key);
    return NULL;
  }
  if (!bytes) return NULL;
  ScrDyn *result = scr_key_object_new(bytes->data, (size_t)scr_bytes_byte_len(bytes));
  scr_bytes_release(bytes);
  return result;
}

/* generateKeySync(type, options) for "hmac" (options.length in bits,
 * 8 to 2^31 - 1, rounded down to whole bytes) and "aes" (128, 192 or
 * 256), checked in Node's order. */
ScrDyn *scr_crypto_generate_key_sync(ScrDyn *type, ScrDyn *options) {
  if (type->kind != SCR_DYN_STR) {
    scr_dyn_arg_type_fail("type", "of type string", type);
    return NULL;
  }
  if (options->kind == SCR_DYN_TYPED_REF) {
    ScrDyn *value = scr_dyn_typed_ref_materialize(options);
    if (!value) return NULL;
    ScrDyn *result = scr_crypto_generate_key_sync(type, value);
    scr_dyn_release(value);
    return result;
  }
  if (options->kind == SCR_DYN_ARR || options->kind == SCR_DYN_NULL || !scr_crypto_is_object(options)) {
    scr_dyn_arg_type_fail("options", "of type object", options);
    return NULL;
  }
  const ScrStr *name = type->v.str;
  bool hmac = name->len == 4 && memcmp(name->data, "hmac", 4) == 0;
  bool aes = name->len == 3 && memcmp(name->data, "aes", 3) == 0;
  if (!hmac && !aes) {
    char reason[] = "must be a supported key type";
    scr_dyn_arg_value_fail("type", reason, type);
    return NULL;
  }
  ScrDyn *length = scr_dyn_obj_read(options, "length", 6);
  ScrDyn *undefined = length ? NULL : scr_dyn_undefined();
  const ScrDyn *value = length ? length : undefined;
  double bits = value->kind == SCR_DYN_NUM ? value->v.num : NAN;
  bool ok;
  if (hmac) {
    ok = value->kind == SCR_DYN_NUM;
    if (!ok) scr_dyn_prop_type_fail("options.length", "of type number", value);
    else if (!isfinite(bits) || floor(bits) != bits) {
      scr_crypto_out_of_range("options.length", "an integer", bits);
      ok = false;
    } else if (bits < 8 || bits > 2147483647.0) {
      scr_crypto_out_of_range("options.length", ">= 8 && <= 2147483647", bits);
      ok = false;
    }
  } else {
    ok = value->kind == SCR_DYN_NUM && (bits == 128 || bits == 192 || bits == 256);
    if (!ok) scr_crypto_property_one_of("options.length", "128, 192, 256", value);
  }
  if (length) scr_dyn_release(length);
  if (undefined) scr_dyn_release(undefined);
  if (!ok) return NULL;
  size_t len = (size_t)(bits / 8);
  unsigned char *data = malloc(len ? len : 1);
  if (!data) scr_trap("scriptc: out of memory\n");
  arc4random_buf(data, len);
  ScrDyn *result = scr_key_object_new(data, len);
  scr_crypto_zero(data, len);
  free(data);
  return result;
}

/* hkdf's key: a KeyObject's bytes as a fresh u8 Buffer. */
ScrBytes *scr_crypto_key_object_input(ScrDyn *key) {
  size_t len;
  const unsigned char *data = scr_key_object_bytes(key, &len);
  if (!data) {
    scr_key_object_type_fail("key", key);
    return NULL;
  }
  ScrBytes *bytes = scr_bytes_new(SCR_BYTES_U8, (double)len);
  if (len) memcpy(bytes->data, data, len);
  return bytes;
}

static ScrBytes *scr_crypto_pbkdf2_raw(const unsigned char *password, size_t password_len,
                                      const unsigned char *salt, size_t salt_len,
                                      uint32_t iterations, size_t keylen,
                                      ScrDigestAlg alg) {
  ScrDigestCtx empty;
  unsigned char empty_digest[64];
  scr_digest_init(&empty, alg);
  size_t digest_len = scr_digest_final(&empty, empty_digest);
  scr_crypto_zero(empty_digest, sizeof empty_digest);
  ScrBytes *result = scr_bytes_new(SCR_BYTES_U8, (double)keylen);
  unsigned char *block = malloc(salt_len + 4);
  if (!block) scr_trap("scriptc: out of memory\n");
  memcpy(block, salt, salt_len);
  size_t blocks = (keylen + digest_len - 1) / digest_len;
  /* The keyed inner and outer states are computed once and copied for
   * each HMAC. */
  ScrDigestCtx keyed_inner, outer, inner;
  scr_hmac_init(&keyed_inner, &outer, alg, password, password_len);
  for (size_t index = 1; index <= blocks; index++) {
    block[salt_len] = (unsigned char)(index >> 24);
    block[salt_len + 1] = (unsigned char)(index >> 16);
    block[salt_len + 2] = (unsigned char)(index >> 8);
    block[salt_len + 3] = (unsigned char)index;
    unsigned char u[64], accum[64];
    inner = keyed_inner;
    scr_digest_update(&inner, block, salt_len + 4);
    scr_hmac_final(&inner, &outer, u);
    memcpy(accum, u, digest_len);
    for (uint32_t round = 1; round < iterations; round++) {
      inner = keyed_inner;
      scr_digest_update(&inner, u, digest_len);
      scr_hmac_final(&inner, &outer, u);
      for (size_t i = 0; i < digest_len; i++) accum[i] ^= u[i];
    }
    size_t offset = (index - 1) * digest_len;
    size_t take = keylen - offset < digest_len ? keylen - offset : digest_len;
    memcpy(result->data + offset, accum, take);
    scr_crypto_zero(u, sizeof u);
    scr_crypto_zero(accum, sizeof accum);
  }
  scr_crypto_zero(&keyed_inner, sizeof keyed_inner);
  scr_crypto_zero(&inner, sizeof inner);
  scr_crypto_zero(&outer, sizeof outer);
  scr_crypto_zero(block, salt_len + 4);
  free(block);
  return result;
}

/* Argument errors throw. A job that fails, as Node's PBKDF2 job does for
 * an empty key or an XOF digest, returns NULL and sets `failure`, which
 * the synchronous form throws and the callback form passes to the
 * callback. */
ScrBytes *scr_crypto_pbkdf2_job(ScrBytes *password, ScrBytes *salt, double iterations,
                                double keylen, ScrStr *digest, const char **failure) {
  *failure = NULL;
  SCR_BYTES_SNAPSHOT(password);
  SCR_BYTES_SNAPSHOT(salt);
  if (!isfinite(iterations) || floor(iterations) != iterations ||
      iterations < 1 || iterations > 2147483647.0) {
    char value[64], msg[176];
    size_t value_len = scr_f64_to_str(iterations, value);
    int n = snprintf(msg, sizeof msg,
                     "The value of \"iterations\" is out of range. It must be >= 1 && <= 2147483647. Received %.*s",
                     (int)value_len, value);
    scr_throw_error_msg_code(SCR_ERR_RANGE, msg, (size_t)n, "ERR_OUT_OF_RANGE");
    return NULL;
  }
  if (!isfinite(keylen) || floor(keylen) != keylen || keylen < 0 || keylen > 2147483647.0) {
    char value[64], msg[176];
    size_t value_len = scr_f64_to_str(keylen, value);
    int n = snprintf(msg, sizeof msg,
                     "The value of \"keylen\" is out of range. It must be >= 0 && <= 2147483647. Received %.*s",
                     (int)value_len, value);
    scr_throw_error_msg_code(SCR_ERR_RANGE, msg, (size_t)n, "ERR_OUT_OF_RANGE");
    return NULL;
  }
  ScrDigestAlg alg;
  if (!scr_digest_alg(digest->data, digest->len, &alg)) {
    scr_crypto_invalid_digest(digest);
    return NULL;
  }
  if (keylen == 0) {
    *failure = "Deriving bits failed";
    return NULL;
  }
  if (scr_digest_info[alg].xof) {
    *failure = "error:1C8000B7:Provider routines::xof digests not allowed";
    return NULL;
  }
  return scr_crypto_pbkdf2_raw(password->data,
      password->len * scr_bytes_elem_size(password->elem), salt->data,
      salt->len * scr_bytes_elem_size(salt->elem), (uint32_t)iterations,
      (size_t)keylen, alg);
}

ScrBytes *scr_crypto_pbkdf2(ScrBytes *password, ScrBytes *salt,
                            double iterations, double keylen, ScrStr *digest) {
  const char *failure;
  ScrBytes *result = scr_crypto_pbkdf2_job(password, salt, iterations, keylen, digest, &failure);
  if (failure) scr_throw_error_msg(SCR_ERR_ERROR, failure, strlen(failure));
  return result;
}

/* RFC 5869 HKDF and RFC 7914 scrypt share the digest core in both
 * execution tiers. Sensitive scratch storage is cleared before release. */
static bool scr_crypto_integer(double value, const char *name, double max) {
  if (isfinite(value) && floor(value) == value && value >= 0 && value <= max) return true;
  char received[64], requirement[80], message[256];
  size_t n = scr_f64_to_str(value, received);
  received[n] = '\0';
  if (!isfinite(value) || floor(value) != value) {
    snprintf(requirement, sizeof requirement, "an integer");
  } else {
    snprintf(requirement, sizeof requirement, ">= 0 && <= %.0f", max);
    if (fabs(value) > 4294967296.0) {
      char digits[40];
      snprintf(digits, sizeof digits, "%.0f", value);
      size_t len = strlen(digits), out = 0, start = digits[0] == '-' ? 1 : 0;
      for (size_t i = 0; i < len; i++) {
        if (i > start && (len - i) % 3 == 0) received[out++] = '_';
        received[out++] = digits[i];
      }
      received[out] = '\0';
    }
  }
  int len = snprintf(message, sizeof message,
      "The value of \"%s\" is out of range. It must be %s. Received %s", name, requirement, received);
  scr_throw_error_msg_code(SCR_ERR_RANGE, message, (size_t)len, "ERR_OUT_OF_RANGE");
  return false;
}

ScrBytes *scr_crypto_hkdf_bytes(ScrStr *digest, ScrBytes *ikm, ScrBytes *salt,
                                ScrBytes *info, double keylen) {
  SCR_BYTES_SNAPSHOT(ikm);
  SCR_BYTES_SNAPSHOT(salt);
  SCR_BYTES_SNAPSHOT(info);
  if (!scr_crypto_integer(keylen, "length", 9007199254740991.0)) return NULL;
  size_t info_len = info->len * scr_bytes_elem_size(info->elem);
  if (info_len > 1024) {
    char message[192];
    int len = snprintf(message, sizeof message,
        "The value of \"info\" is out of range. It must be must not contain more than 1024 bytes. Received %zu", info_len);
    scr_throw_error_msg_code(SCR_ERR_RANGE, message, (size_t)len, "ERR_OUT_OF_RANGE");
    return NULL;
  }
  ScrDigestAlg alg;
  if (!scr_digest_alg(digest->data, digest->len, &alg)) {
    scr_crypto_invalid_digest(digest);
    return NULL;
  }
  ScrDigestCtx inner, outer;
  unsigned char prk[64], t[64];
  scr_hmac_init(&inner, &outer, alg, salt->data, salt->len * scr_bytes_elem_size(salt->elem));
  scr_digest_update(&inner, ikm->data, ikm->len * scr_bytes_elem_size(ikm->elem));
  size_t hash_len = scr_hmac_final(&inner, &outer, prk);
  if (keylen > 255 * hash_len) {
    scr_crypto_zero(prk, sizeof prk);
    scr_crypto_zero(&inner, sizeof inner);
    scr_crypto_zero(&outer, sizeof outer);
    scr_throw_error_msg_code(SCR_ERR_RANGE, "Invalid key length", 18, "ERR_CRYPTO_INVALID_KEYLEN");
    return NULL;
  }
  if (scr_digest_info[alg].xof) {
    /* OpenSSL's HKDF refuses an XOF; callers report the empty result as
     * Node's "Deriving bits failed". */
    scr_crypto_zero(prk, sizeof prk);
    scr_crypto_zero(&inner, sizeof inner);
    scr_crypto_zero(&outer, sizeof outer);
    return scr_bytes_new(SCR_BYTES_U8, 0);
  }
  ScrBytes *result = scr_bytes_new(SCR_BYTES_U8, keylen);
  size_t offset = 0, previous_len = 0;
  for (unsigned counter = 1; offset < (size_t)keylen; counter++) {
    scr_hmac_init(&inner, &outer, alg, prk, hash_len);
    scr_digest_update(&inner, t, previous_len);
    scr_digest_update(&inner, info->data, info_len);
    unsigned char byte = (unsigned char)counter;
    scr_digest_update(&inner, &byte, 1);
    scr_hmac_final(&inner, &outer, t);
    size_t take = (size_t)keylen - offset;
    if (take > hash_len) take = hash_len;
    memcpy(result->data + offset, t, take);
    offset += take;
    previous_len = hash_len;
  }
  scr_crypto_zero(prk, sizeof prk);
  scr_crypto_zero(t, sizeof t);
  scr_crypto_zero(&inner, sizeof inner);
  scr_crypto_zero(&outer, sizeof outer);
  return result;
}

ScrDyn *scr_crypto_hkdf(ScrStr *digest, ScrBytes *ikm, ScrBytes *salt,
                       ScrBytes *info, double keylen) {
  ScrBytes *bytes = scr_crypto_hkdf_bytes(digest, ikm, salt, info, keylen);
  if (!bytes) return NULL;
  if (bytes->len == 0) {
    scr_bytes_release(bytes);
    scr_throw_error_msg(SCR_ERR_ERROR, "Deriving bits failed", 20);
    return NULL;
  }
  ScrDyn *result = scr_array_buffer_from_bytes(bytes);
  scr_bytes_release(bytes);
  return result;
}

static uint32_t scr_scrypt_rotl(uint32_t x, unsigned n) {
  return (x << n) | (x >> (32 - n));
}

/* Salsa20/8 core, RFC 7914 section 3. Unsigned arithmetic supplies the
 * specified reduction modulo 2^32 without signed-overflow UB. */
static void scr_scrypt_salsa(uint32_t block[16]) {
  uint32_t x[16];
  memcpy(x, block, sizeof x);
  for (unsigned round = 0; round < 8; round += 2) {
#define SCR_SALSA(a, b, c, n) x[a] ^= scr_scrypt_rotl(x[b] + x[c], n)
    SCR_SALSA(4,0,12,7); SCR_SALSA(8,4,0,9); SCR_SALSA(12,8,4,13); SCR_SALSA(0,12,8,18);
    SCR_SALSA(9,5,1,7); SCR_SALSA(13,9,5,9); SCR_SALSA(1,13,9,13); SCR_SALSA(5,1,13,18);
    SCR_SALSA(14,10,6,7); SCR_SALSA(2,14,10,9); SCR_SALSA(6,2,14,13); SCR_SALSA(10,6,2,18);
    SCR_SALSA(3,15,11,7); SCR_SALSA(7,3,15,9); SCR_SALSA(11,7,3,13); SCR_SALSA(15,11,7,18);
    SCR_SALSA(1,0,3,7); SCR_SALSA(2,1,0,9); SCR_SALSA(3,2,1,13); SCR_SALSA(0,3,2,18);
    SCR_SALSA(6,5,4,7); SCR_SALSA(7,6,5,9); SCR_SALSA(4,7,6,13); SCR_SALSA(5,4,7,18);
    SCR_SALSA(11,10,9,7); SCR_SALSA(8,11,10,9); SCR_SALSA(9,8,11,13); SCR_SALSA(10,9,8,18);
    SCR_SALSA(12,15,14,7); SCR_SALSA(13,12,15,9); SCR_SALSA(14,13,12,13); SCR_SALSA(15,14,13,18);
#undef SCR_SALSA
  }
  for (size_t i = 0; i < 16; i++) block[i] += x[i];
  scr_crypto_zero(x, sizeof x);
}

static void scr_scrypt_blockmix(uint32_t *x, uint32_t *y, size_t r) {
  uint32_t block[16];
  memcpy(block, x + (2 * r - 1) * 16, sizeof block);
  for (size_t i = 0; i < 2 * r; i++) {
    for (size_t k = 0; k < 16; k++) block[k] ^= x[i * 16 + k];
    scr_scrypt_salsa(block);
    size_t dest = (i / 2 + (i % 2) * r) * 16;
    memcpy(y + dest, block, sizeof block);
  }
  memcpy(x, y, 128 * r);
  scr_crypto_zero(block, sizeof block);
}

static bool scr_scrypt_params(double n, double r, double p, double maxmem, size_t *memory) {
  uint64_t N = (uint64_t)n, R = (uint64_t)r, P = (uint64_t)p;
  if (N < 2 || (N & (N - 1)) != 0) {
    scr_throw_error_msg_code(SCR_ERR_RANGE, "Invalid scrypt params", 21, "ERR_CRYPTO_INVALID_SCRYPT_PARAMS");
    return false;
  }
  /* Match Node's OpenSSL 3 scrypt guard, including X/Y working buffers
   * and the initial PBKDF2 output; check every product before allocation. */
  bool overflow = R == 0 || P == 0 || P > UINT64_C(0x3fffffff) / R;
  if (!overflow && R <= 3 && N >= (UINT64_C(1) << (16 * R))) overflow = true;
  uint64_t b = overflow ? 0 : 128 * R * P;
  if (b > INT32_MAX || R > UINT64_MAX / 128 / (N + 2)) overflow = true;
  uint64_t v = overflow ? 0 : 128 * R * (N + 2);
  if (overflow || b > UINT64_MAX - v || b + v > (uint64_t)maxmem || b + v > SIZE_MAX) {
    static const char message[] = "Invalid scrypt params: error:030000AC:digital envelope routines::memory limit exceeded";
    scr_throw_error_msg_code(SCR_ERR_RANGE, message, sizeof message - 1, "ERR_CRYPTO_INVALID_SCRYPT_PARAMS");
    return false;
  }
  *memory = (size_t)(b + v);
  return true;
}

ScrBytes *scr_crypto_scrypt_derive(ScrBytes *password, ScrBytes *salt, double keylen,
                                  double n, double r, double p, double maxmem) {
  SCR_BYTES_SNAPSHOT(password);
  SCR_BYTES_SNAPSHOT(salt);
  if (!scr_crypto_integer(keylen, "keylen", 2147483647.0) ||
      !scr_crypto_integer(n, "N", 4294967295.0) || !scr_crypto_integer(r, "r", 4294967295.0) ||
      !scr_crypto_integer(p, "p", 4294967295.0) || !scr_crypto_integer(maxmem, "maxmem", 9007199254740991.0)) return NULL;
  if (n == 0) n = 16384;
  if (r == 0) r = 8;
  if (p == 0) p = 1;
  if (maxmem == 0) maxmem = 33554432;
  size_t memory;
  if (!scr_scrypt_params(n, r, p, maxmem, &memory)) return NULL;
  if (keylen == 0) return scr_bytes_new(SCR_BYTES_U8, 0);
  size_t words = 32 * (size_t)r, block_len = words * sizeof(uint32_t);
  size_t b_len = block_len * (size_t)p;
  ScrBytes *b = scr_crypto_pbkdf2_raw(password->data, password->len * scr_bytes_elem_size(password->elem),
      salt->data, salt->len * scr_bytes_elem_size(salt->elem), 1, b_len, SCR_DIGEST_SHA256);
  uint32_t *work = malloc(memory - b_len);
  if (!work) { scr_bytes_release(b); scr_trap("scriptc: out of memory\n"); }
  uint32_t *x = work, *y = x + words, *v = y + words;
  for (size_t part = 0; part < (size_t)p; part++) {
    unsigned char *bytes = b->data + part * block_len;
    for (size_t i = 0; i < words; i++) {
      x[i] = (uint32_t)bytes[i * 4] | ((uint32_t)bytes[i * 4 + 1] << 8) |
             ((uint32_t)bytes[i * 4 + 2] << 16) | ((uint32_t)bytes[i * 4 + 3] << 24);
    }
    for (size_t i = 0; i < (size_t)n; i++) {
      memcpy(v + i * words, x, block_len);
      scr_scrypt_blockmix(x, y, (size_t)r);
    }
    for (size_t i = 0; i < (size_t)n; i++) {
      size_t j = (size_t)x[words - 16] & ((size_t)n - 1);
      for (size_t k = 0; k < words; k++) x[k] ^= v[j * words + k];
      scr_scrypt_blockmix(x, y, (size_t)r);
    }
    for (size_t i = 0; i < words; i++) {
      for (size_t k = 0; k < 4; k++) bytes[i * 4 + k] = (unsigned char)(x[i] >> (8 * k));
    }
  }
  ScrBytes *result = scr_crypto_pbkdf2_raw(password->data, password->len * scr_bytes_elem_size(password->elem),
      b->data, b_len, 1, (size_t)keylen, SCR_DIGEST_SHA256);
  scr_crypto_zero(b->data, b_len);
  scr_bytes_release(b);
  scr_crypto_zero(work, memory - b_len);
  free(work);
  return result;
}

static ScrDyn *scr_scrypt_read_option(ScrDyn *options, const char *name) {
  if (options->kind != SCR_DYN_TYPED_REF) return scr_dyn_obj_read(options, name, strlen(name));
  ScrDyn *view = scr_dyn_typed_ref_materialize(options);
  if (!view) return NULL;
  ScrDyn *value = scr_dyn_obj_read(view, name, strlen(name));
  scr_dyn_release(view);
  return value;
}

static bool scr_scrypt_option(ScrDyn *options, const char *name, double max, double *out, bool *present) {
  ScrDyn *value = scr_scrypt_read_option(options, name);
  if (scr_exc_pending()) return false;
  *present = value && value->kind != SCR_DYN_UNDEF;
  if (*present) {
    scr_dyn_release(value);
    value = scr_scrypt_read_option(options, name);
    if (scr_exc_pending()) return false;
    if (value->kind != SCR_DYN_NUM) {
      scr_dyn_arg_type_fail(name, "number", value);
      scr_dyn_release(value);
      return false;
    }
    *out = value->v.num;
    bool valid = scr_crypto_integer(*out, name, max);
    scr_dyn_release(value);
    return valid;
  }
  scr_dyn_release(value);
  return true;
}

ScrBytes *scr_crypto_scrypt(ScrBytes *password, ScrBytes *salt, double keylen, ScrDyn *options) {
  if (!scr_crypto_integer(keylen, "keylen", 2147483647.0)) return NULL;
  double values[4] = {16384, 8, 1, 33554432};
  if (options && scr_dyn_truthy(options)) {
    const char *names[3] = {"N", "r", "p"};
    const char *aliases[3] = {"cost", "blockSize", "parallelization"};
    for (size_t i = 0; i < 3; i++) {
      bool primary, alias;
      if (!scr_scrypt_option(options, names[i], 4294967295.0, &values[i], &primary)) return NULL;
      // Node reads the alias to test presence before checking the conflict.
      ScrDyn *alias_value = scr_scrypt_read_option(options, aliases[i]);
      if (scr_exc_pending()) return NULL;
      alias = alias_value && alias_value->kind != SCR_DYN_UNDEF;
      if (primary && alias) {
        char message[160];
        int len = snprintf(message, sizeof message, "Option \"%s\" cannot be used in combination with option \"%s\"", names[i], aliases[i]);
        scr_dyn_release(alias_value);
        scr_throw_error_msg_code(SCR_ERR_TYPE, message, (size_t)len, "ERR_INCOMPATIBLE_OPTION_PAIR");
        return NULL;
      }
      if (alias) {
        scr_dyn_release(alias_value);
        alias_value = scr_scrypt_read_option(options, aliases[i]);
        if (scr_exc_pending()) return NULL;
        if (alias_value->kind != SCR_DYN_NUM) {
          scr_dyn_arg_type_fail(aliases[i], "number", alias_value);
          scr_dyn_release(alias_value);
          return NULL;
        }
        values[i] = alias_value->v.num;
        if (!scr_crypto_integer(values[i], aliases[i], 4294967295.0)) {
          scr_dyn_release(alias_value);
          return NULL;
        }
      }
      scr_dyn_release(alias_value);
    }
    bool present;
    if (!scr_scrypt_option(options, "maxmem", 9007199254740991.0, &values[3], &present)) return NULL;
  }
  return scr_crypto_scrypt_derive(password, salt, keylen, values[0], values[1], values[2], values[3]);
}

/* The composed `new crypto.X509Certificate(data).fingerprint` read, fused
 * by the compiler (no certificate handle exists). Node's .fingerprint IS
 * the SHA-1 of the certificate's DER bytes, uppercase colon-separated —
 * pinned against Node. Accepts what Node's constructor accepts from the
 * fs.readFileSync idiom: PEM (the armor's base64 body decodes to DER,
 * Node-leniently — whitespace skipped) or raw DER (a leading SEQUENCE
 * tag). Anything else throws Node's exact PEM error (Error, code
 * ERR_OSSL_PEM_NO_START_LINE). Input borrowed; result +1. */
static ScrStr *scr_x509_fingerprint_raw(const uint8_t *in, size_t n);

ScrStr *scr_crypto_x509_fingerprint(ScrBytes *data) {
  SCR_BYTES_SNAPSHOT(data);
  return scr_x509_fingerprint_raw(data->data, data->len * scr_bytes_elem_size(data->elem));
}

/* The string-input form (readFileSync(path, "utf-8") — PEM text; ScrStr
 * storage IS the bytes). */
ScrStr *scr_crypto_x509_fingerprint_str(ScrStr *pem) {
  return scr_x509_fingerprint_raw((const uint8_t *)pem->data, pem->len);
}

/* PEM armor → DER (or raw-DER passthrough), the shared front half of
 * every X509Certificate member. On success `*der`/`*der_len` hold the
 * certificate bytes and `*decoded` the malloc'd base64 buffer to free
 * (NULL for raw-DER input); unparseable input throws Node's exact PEM
 * error and answers false with the exception pending. */
static bool scr_x509_der(const uint8_t *in, size_t n, const uint8_t **der, size_t *der_len,
                          uint8_t **decoded) {
  static const char begin[] = "-----BEGIN CERTIFICATE-----";
  static const char end[] = "-----END CERTIFICATE-----";
  *der = NULL;
  *der_len = 0;
  *decoded = NULL;
  /* PEM: base64-decode the armor's body. */
  const uint8_t *b = NULL;
  for (size_t i = 0; i + sizeof begin - 1 <= n; i++) {
    if (memcmp(in + i, begin, sizeof begin - 1) == 0) {
      b = in + i + sizeof begin - 1;
      break;
    }
  }
  if (b != NULL) {
    const uint8_t *stop = in + n;
    for (const uint8_t *p = b; p + sizeof end - 1 <= in + n; p++) {
      if (memcmp(p, end, sizeof end - 1) == 0) {
        stop = p;
        break;
      }
    }
    uint8_t *out = malloc(((size_t)(stop - b) / 4 + 1) * 3 + 3);
    if (!out) {
      scr_trap("scriptc: out of memory\n");
    }
    size_t o = 0;
    unsigned acc = 0;
    int have = 0;
    for (const uint8_t *p = b; p < stop; p++) {
      int v;
      uint8_t c = *p;
      if (c >= 'A' && c <= 'Z') v = c - 'A';
      else if (c >= 'a' && c <= 'z') v = c - 'a' + 26;
      else if (c >= '0' && c <= '9') v = c - '0' + 52;
      else if (c == '+') v = 62;
      else if (c == '/') v = 63;
      else continue; /* whitespace, '=' */
      acc = (acc << 6) | (unsigned)v;
      if (++have == 4) {
        out[o++] = (uint8_t)(acc >> 16);
        out[o++] = (uint8_t)(acc >> 8);
        out[o++] = (uint8_t)acc;
        acc = 0;
        have = 0;
      }
    }
    if (have == 2) out[o++] = (uint8_t)(acc >> 4);
    else if (have == 3) {
      out[o++] = (uint8_t)(acc >> 10);
      out[o++] = (uint8_t)(acc >> 2);
    }
    *decoded = out;
    *der = out;
    *der_len = o;
    return true;
  }
  if (n > 0 && in[0] == 0x30) {
    /* Raw DER: the certificate SEQUENCE. */
    *der = in;
    *der_len = n;
    return true;
  }
  scr_throw_error_msg_code(SCR_ERR_ERROR,
                            "error:0480006C:PEM routines::no start line",
                            42, "ERR_OSSL_PEM_NO_START_LINE");
  return false; /* exception pending */
}

static ScrStr *scr_x509_fingerprint_raw(const uint8_t *in, size_t n) {
  const uint8_t *der;
  size_t der_len;
  uint8_t *decoded;
  if (!scr_x509_der(in, n, &der, &der_len, &decoded)) return NULL;
  unsigned char digest[32];
  size_t dn = scr_sha1_digest(der, der_len, digest);
  free(decoded);
  char buf[64];
  static const char hex[] = "0123456789ABCDEF";
  size_t o = 0;
  for (size_t i = 0; i < dn; i++) {
    if (i > 0) buf[o++] = ':';
    buf[o++] = hex[digest[i] >> 4];
    buf[o++] = hex[digest[i] & 0x0f];
  }
  return scr_str_new(buf, o);
}

/* ── the certificate's Validity window (validFrom / validTo) ─────────────
 *
 * A minimal DER walk to TBSCertificate.validity: Certificate ::= SEQUENCE
 * { tbsCertificate SEQUENCE { version [0] OPTIONAL, serialNumber INTEGER,
 * signature SEQUENCE, issuer, validity SEQUENCE { notBefore, notAfter },
 * ... } }. Each Time is UTCTime (YYMMDDHHMMSSZ; RFC 5280's 50-year pivot)
 * or GeneralizedTime (YYYYMMDDHHMMSSZ), rendered in Node's exact
 * ASN1_TIME_print shape: "Jul  1 00:00:00 2026 GMT" (%2d space-padded
 * day). Truncated/non-Zulu encodings (RFC 5280 forbids them in certs)
 * and walk failures answer OpenSSL's "Bad time value". */

/* Reads one DER TL header at p (before end): tag to *tag, content length
 * to *len, and answers the content pointer (NULL on malformed/overlong). */
static const uint8_t *scr_der_tl(const uint8_t *p, const uint8_t *end, uint8_t *tag, size_t *len) {
  if (p == NULL || end - p < 2) return NULL;
  *tag = p[0];
  uint8_t l0 = p[1];
  const uint8_t *content = p + 2;
  size_t l;
  if (l0 < 0x80) {
    l = l0;
  } else {
    size_t nb = l0 & 0x7f;
    if (nb == 0 || nb > sizeof(size_t) || end - content < (ptrdiff_t)nb) return NULL;
    l = 0;
    for (size_t i = 0; i < nb; i++) l = (l << 8) | content[i];
    content += nb;
  }
  if ((size_t)(end - content) < l) return NULL;
  *tag = p[0];
  *len = l;
  return content;
}

/* Formats one Time element (UTCTime/GeneralizedTime content bytes) in
 * ASN1_TIME_print's shape into buf; answers the length (0 = bad value). */
static size_t scr_x509_time_print(uint8_t tag, const uint8_t *t, size_t n, char buf[32]) {
  static const char *mon[12] = {"Jan", "Feb", "Mar", "Apr", "May", "Jun",
                                "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"};
  int year, mo, day, hh, mm, ss;
  const uint8_t *d = t;
  size_t need = tag == 0x17 ? 13 : 15; /* ...HHMMSSZ, Zulu only */
  if (n != need || t[n - 1] != 'Z') return 0;
  for (size_t i = 0; i + 1 < n; i++) {
    if (t[i] < '0' || t[i] > '9') return 0;
  }
#define SCR_DER_2D(p) (((p)[0] - '0') * 10 + ((p)[1] - '0'))
  if (tag == 0x17) {
    year = SCR_DER_2D(d);
    year += year < 50 ? 2000 : 1900; /* RFC 5280's UTCTime pivot */
    d += 2;
  } else {
    year = SCR_DER_2D(d) * 100;
    d += 2;
    year += SCR_DER_2D(d);
    d += 2;
  }
  mo = SCR_DER_2D(d); d += 2;
  day = SCR_DER_2D(d); d += 2;
  hh = SCR_DER_2D(d); d += 2;
  mm = SCR_DER_2D(d); d += 2;
  ss = SCR_DER_2D(d);
#undef SCR_DER_2D
  if (mo < 1 || mo > 12) return 0;
  int r = snprintf(buf, 32, "%s %2d %02d:%02d:%02d %d GMT", mon[mo - 1], day, hh, mm, ss, year);
  return r > 0 ? (size_t)r : 0;
}

static ScrStr *scr_x509_validity_raw(const uint8_t *in, size_t n, bool want_to) {
  const uint8_t *der;
  size_t der_len;
  uint8_t *decoded;
  if (!scr_x509_der(in, n, &der, &der_len, &decoded)) return NULL;
  static const char bad[] = "Bad time value";
  const uint8_t *end = der + der_len;
  uint8_t tag;
  size_t len;
  char buf[32];
  size_t blen = 0;
  /* Certificate SEQUENCE → tbsCertificate SEQUENCE */
  const uint8_t *p = scr_der_tl(der, end, &tag, &len);
  if (p && tag == 0x30) {
    end = p + len;
    p = scr_der_tl(p, end, &tag, &len);
  } else {
    p = NULL;
  }
  if (p && tag == 0x30) {
    const uint8_t *tbs_end = p + len;
    /* [0] version (optional), serialNumber, signature, issuer */
    const uint8_t *q = p;
    for (int skip = 0; skip < 4 && q != NULL; skip++) {
      const uint8_t *c = scr_der_tl(q, tbs_end, &tag, &len);
      if (!c) { q = NULL; break; }
      if (skip == 0 && tag != 0xA0) {
        /* no version field: this element is already serialNumber */
        skip++;
      }
      q = c + len;
    }
    /* validity SEQUENCE { notBefore, notAfter } */
    const uint8_t *v = scr_der_tl(q, tbs_end, &tag, &len);
    if (v && tag == 0x30) {
      const uint8_t *v_end = v + len;
      const uint8_t *t1 = scr_der_tl(v, v_end, &tag, &len);
      if (t1 && (tag == 0x17 || tag == 0x18)) {
        if (!want_to) {
          blen = scr_x509_time_print(tag, t1, len, buf);
        } else {
          const uint8_t *t2 = scr_der_tl(t1 + len, v_end, &tag, &len);
          if (t2 && (tag == 0x17 || tag == 0x18)) {
            blen = scr_x509_time_print(tag, t2, len, buf);
          }
        }
      }
    }
  }
  free(decoded);
  if (blen == 0) return scr_str_new(bad, sizeof bad - 1);
  return scr_str_new(buf, blen);
}

ScrStr *scr_crypto_x509_valid_from(ScrBytes *data) {
  SCR_BYTES_SNAPSHOT(data);
  return scr_x509_validity_raw(data->data, data->len * scr_bytes_elem_size(data->elem), false);
}

ScrStr *scr_crypto_x509_valid_from_str(ScrStr *pem) {
  return scr_x509_validity_raw((const uint8_t *)pem->data, pem->len, false);
}

ScrStr *scr_crypto_x509_valid_to(ScrBytes *data) {
  SCR_BYTES_SNAPSHOT(data);
  return scr_x509_validity_raw(data->data, data->len * scr_bytes_elem_size(data->elem), true);
}

ScrStr *scr_crypto_x509_valid_to_str(ScrStr *pem) {
  return scr_x509_validity_raw((const uint8_t *)pem->data, pem->len, true);
}

/* ── String surface (fromCharCode) ────────────────────────────────────── */

/* String.fromCharCode core over n UTF-16 code units read through
 * `unit(src, i)` (already ToUint16'd): combine adjacent surrogate pairs,
 * keep other surrogates lone, WTF-8 encode. */
static ScrStr *scr_str_from_units(size_t n, uint32_t (*unit)(void *, size_t), void *src) {
  if (n == 1) return scr_str_from_char_code_one((double)unit(src, 0));
  /* Up to 64 units encode on the stack (3 bytes per UTF-16 unit at most). */
  char small[64 * 3 + 1];
  char *out = n <= 64 ? small : malloc(n * 3 + 1);
  if (!out) {
    scr_trap("scriptc: out of memory\n");
  }
  size_t o = 0;
  for (size_t i = 0; i < n; i++) {
    uint32_t cp = unit(src, i);
    if (cp >= 0xD800 && cp <= 0xDBFF && i + 1 < n) {
      uint32_t lo = unit(src, i + 1);
      if (lo >= 0xDC00 && lo <= 0xDFFF) {
        cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00);
        i++;
      }
    }
    o += scr_wtf8_put(out + o, cp);
  }
  ScrStr *s = scr_str_new(out, o);
  if (out != small) free(out);
  return s;
}

static uint32_t scr_fcc_units_unit(void *src, size_t i) {
  return scr_to_uint32(((const double *)src)[i]) & 0xFFFFu;
}

/* String.fromCharCode(c0, ..., cn-1) with the codes in a caller's array. */
ScrStr *scr_str_from_char_codes(const double *codes, size_t n) {
  return scr_str_from_units(n, scr_fcc_units_unit, (void *)codes);
}

static uint32_t scr_fcc_arr_unit(void *src, size_t i) {
  return scr_to_uint32(scr_arr_get_f64((ScrArr *)src, (double)i)) & 0xFFFFu;
}

/* String.fromCharCode(...codes) over ONE packed f64[]. */
ScrStr *scr_str_from_char_code(ScrArr *codes) {
  return scr_str_from_units(codes->len, scr_fcc_arr_unit, codes);
}

static uint32_t scr_fcc_bytes_unit(void *src, size_t i) {
  return scr_to_uint32(scr_bytes_get((const ScrBytes *)src, (double)i)) & 0xFFFFu;
}

/* String.fromCharCode(...bytes) — a spread typed array/Buffer source (the
 * magic-number ASCII probe: String.fromCharCode(...data.slice(4, 8))).
 * u8 elements are plain code units; u32/f32 elements ride the same
 * ToUint16 the packed-array form applies. */
ScrStr *scr_str_from_char_code_bytes(ScrBytes *codes) {
  return scr_str_from_units(codes->len, scr_fcc_bytes_unit, codes);
}

static double scr_fcp_array_value(void *source, size_t i) {
  return scr_arr_get_number((ScrArr *)source, (double)i);
}

static double scr_fcp_bytes_value(void *source, size_t i) {
  return scr_bytes_get((const ScrBytes *)source, (double)i);
}

static ScrStr *scr_str_from_points(size_t n, double (*value)(void *, size_t), void *source) {
  /* Validate before allocating the result. The frontend supplies numeric
   * elements, so these reads invoke no user conversions. */
  for (size_t i = 0; i < n; i++) {
    double point = value(source, i);
    if (!isfinite(point) || point < 0 || point > 0x10ffff || trunc(point) != point) {
      char number[64], message[96];
      size_t len = scr_f64_to_str(point, number);
      int size = snprintf(message, sizeof message, "Invalid code point %.*s", (int)len, number);
      scr_throw_error_msg(SCR_ERR_RANGE, message, (size_t)size);
      return NULL;
    }
  }
  if (n > (SIZE_MAX - 1) / 4) scr_trap("scriptc: out of memory\n");
  char *out = malloc(n * 4 + 1);
  if (!out) scr_trap("scriptc: out of memory\n");
  size_t offset = 0;
  for (size_t i = 0; i < n; i++) {
    uint32_t point = (uint32_t)value(source, i);
    if (point >= 0xd800 && point <= 0xdbff && i + 1 < n) {
      uint32_t next = (uint32_t)value(source, i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        point = 0x10000 + ((point - 0xd800) << 10) + (next - 0xdc00);
        i++;
      }
    }
    offset += scr_wtf8_put(out + offset, point);
  }
  ScrStr *result = scr_str_new(out, offset);
  free(out);
  return result;
}

ScrStr *scr_str_from_code_point(ScrArr *codes) {
  return scr_str_from_points(codes->len, scr_fcp_array_value, codes);
}

ScrStr *scr_str_from_code_point_bytes(ScrBytes *codes) {
  return scr_str_from_points(codes->len, scr_fcp_bytes_value, codes);
}

/* ── Date, the read-only value slice ───────────────────────────────────
 * Values are TimeClip'd epoch-millisecond scalars. Identity/mutation are
 * frontend-fenced; construction, storage, getters, and ISO formatting
 * observe exactly this payload. */

SCR_TL const double *scr_date_mock_now = NULL;

double scr_date_now(void) {
  struct timespec ts;
  clock_gettime(CLOCK_REALTIME, &ts);
  /* Node's Date.now() is integer milliseconds. */
  return floor((double)ts.tv_sec * 1000.0 + (double)ts.tv_nsec / 1e6);
}

/* Date's TimeClip: non-finite/out-of-range values become Invalid Date,
 * finite values truncate toward zero, and -0 normalizes to +0. */
double scr_date_new_ms(double ms) {
  if (!isfinite(ms) || fabs(ms) > 8640000000000000.0) return NAN;
  double clipped = trunc(ms);
  return clipped == 0 ? 0 : clipped;
}

double scr_date_get_time(double ms) { return ms; }

/* Node's Date.prototype.toISOString over a millisecond time value:
 * TimeClip's ToInteger truncation, proleptic Gregorian civil-from-days
 * (Howard Hinnant's algorithm), YYYY-MM-DDTHH:mm:ss.sssZ with expanded
 * ±YYYYYY years outside 0–9999, and Node's "Invalid time value"
 * RangeError on NaN / out-of-range values — verified against Node over
 * epoch, negative, fractional, boundary (±8.64e15), and expanded-year
 * inputs. */
ScrStr *scr_date_to_iso(double ms) {
  if (!(fabs(ms) <= 8640000000000000.0)) { /* NaN and out of range */
    scr_throw_error_msg(SCR_ERR_RANGE, "Invalid time value", 18);
    return NULL;
  }
  double t = trunc(ms);
  double dayd = floor(t / 86400000.0);
  long long msday = (long long)(t - dayd * 86400000.0);
  long long z = (long long)dayd + 719468;
  long long era = (z >= 0 ? z : z - 146096) / 146097;
  unsigned long long doe = (unsigned long long)(z - era * 146097);
  unsigned long long yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
  long long y = (long long)yoe + era * 400;
  unsigned long long doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
  unsigned long long mp = (5 * doy + 2) / 153;
  unsigned long long d = doy - (153 * mp + 2) / 5 + 1;
  unsigned long long m = mp < 10 ? mp + 3 : mp - 9;
  if (m <= 2) y += 1;
  int hh = (int)(msday / 3600000), mi = (int)(msday / 60000 % 60),
      ss = (int)(msday / 1000 % 60), sss = (int)(msday % 1000);
  char buf[40];
  int len;
  if (y < 0) {
    len = snprintf(buf, sizeof buf, "-%06lld-%02llu-%02lluT%02d:%02d:%02d.%03dZ", -y, m, d, hh, mi, ss, sss);
  } else if (y > 9999) {
    len = snprintf(buf, sizeof buf, "+%06lld-%02llu-%02lluT%02d:%02d:%02d.%03dZ", y, m, d, hh, mi, ss, sss);
  } else {
    len = snprintf(buf, sizeof buf, "%04lld-%02llu-%02lluT%02d:%02d:%02d.%03dZ", y, m, d, hh, mi, ss, sss);
  }
  return scr_str_new(buf, (size_t)len);
}

/* Node's Date.prototype.toUTCString over a stored (TimeClip'd) time
 * value: "Www, DD Mmm YYYY HH:mm:ss GMT", a "-" and at least four digits
 * for negative years, and "Invalid Date" for NaN. Never throws. +1.
 * The text is assembled from function-local arrays rather than string
 * literals: literals would land in this unit's shared mergeable string
 * section and grow every executable, while these arrays are removed with
 * the function by --gc-sections when a program never calls it. */
ScrStr *scr_date_to_utc_string(double ms) {
  /* Sized without the terminating NUL, so none is a C string the
   * compiler could move into a mergeable string section. */
  static const char invalid[12] = "Invalid Date";
  static const char weekdays[21] = "SunMonTueWedThuFriSat";
  static const char months[36] = "JanFebMarAprMayJunJulAugSepOctNovDec";
  if (!(fabs(ms) <= 8640000000000000.0)) return scr_str_new(invalid, sizeof invalid);
  double t = trunc(ms);
  double dayd = floor(t / 86400000.0);
  long long msday = (long long)(t - dayd * 86400000.0);
  long long days = (long long)dayd;
  int weekday = (int)(((days + 4) % 7 + 7) % 7);
  long long z = days + 719468;
  long long era = (z >= 0 ? z : z - 146096) / 146097;
  unsigned long long doe = (unsigned long long)(z - era * 146097);
  unsigned long long yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
  long long y = (long long)yoe + era * 400;
  unsigned long long doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
  unsigned long long mp = (5 * doy + 2) / 153;
  unsigned long long d = doy - (153 * mp + 2) / 5 + 1;
  unsigned long long m = mp < 10 ? mp + 3 : mp - 9;
  if (m <= 2) y += 1;
  int hh = (int)(msday / 3600000), mi = (int)(msday / 60000 % 60),
      ss = (int)(msday / 1000 % 60);
  char buf[40];
  size_t n = 0;
  memcpy(buf, weekdays + 3 * weekday, 3);
  n = 3;
  buf[n++] = ',';
  buf[n++] = ' ';
  buf[n++] = (char)('0' + d / 10);
  buf[n++] = (char)('0' + d % 10);
  buf[n++] = ' ';
  memcpy(buf + n, months + 3 * (m - 1), 3);
  n += 3;
  buf[n++] = ' ';
  if (y < 0) buf[n++] = '-';
  unsigned long long year = (unsigned long long)(y < 0 ? -y : y);
  char digits[20];
  size_t count = 0;
  do {
    digits[count++] = (char)('0' + year % 10);
    year /= 10;
  } while (year > 0);
  while (count < 4) digits[count++] = '0';
  while (count > 0) buf[n++] = digits[--count];
  int parts[3] = {hh, mi, ss};
  for (int i = 0; i < 3; i++) {
    buf[n++] = i == 0 ? ' ' : ':';
    buf[n++] = (char)('0' + parts[i] / 10);
    buf[n++] = (char)('0' + parts[i] % 10);
  }
  buf[n++] = ' ';
  buf[n++] = 'G';
  buf[n++] = 'M';
  buf[n++] = 'T';
  return scr_str_new(buf, n);
}

/* ── new Date(dateString).getTime() ──────────────────────────────────────
 *
 * The BOUNDED date-string parse, the fast path: two grammars answer a time
 * value directly; scr_date_parse falls back to V8's full parser
 * (scr_date_parse_v8 below), which also answers everything they accept,
 * for the strings they reject.
 *
 *   1. The ASN1_TIME_print shape X509Certificate.validFrom/validTo answer
 *      ("Jul  1 00:00:00 2026 GMT", "Jul 17 17:52:11 2026 GMT") — the
 *      portless cert-expiry read. Month names match case-insensitively;
 *      one or two spaces precede the day (%2d's padding).
 *   2. ECMA's own date-time string format with an EXPLICIT offset:
 *      YYYY[-MM[-DD]] date-only forms (UTC, per the spec) and full
 *      date-times YYYY-MM-DDTHH:mm[:ss[.sss]] ending in Z or ±HH:MM.
 *      Offset-less date-times are LOCAL time in JS; they take the
 *      fallback, which converts them in the host zone.
 */

/* Howard Hinnant's days_from_civil (the to_iso walk inverted). */
static double scr_days_from_civil(long long y, int m, int d) {
  y -= m <= 2;
  long long era = (y >= 0 ? y : y - 399) / 400;
  unsigned long long yoe = (unsigned long long)(y - era * 400);
  unsigned long long doy = (unsigned long long)((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5 + d - 1);
  unsigned long long doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
  return (double)(era * 146097 + (long long)doe - 719468);
}

static double scr_date_make_ms(long long y, int mo, int d, int hh, int mi, int ss, int ms) {
  /* V8 accepts days 1..31 in every month and ROLLS OVER past the month's
   * end (Feb 30 → Mar 2) — days_from_civil extrapolates linearly, so the
   * rollover falls out; day 0 and 32+ are NaN, like V8. */
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return NAN;
  if (hh > 24 || mi > 59 || ss > 59 || (hh == 24 && (mi || ss || ms))) return NAN;
  double t = scr_days_from_civil(y, mo, d) * 86400000.0 +
             hh * 3600000.0 + mi * 60000.0 + ss * 1000.0 + ms;
  return t;
}

static double scr_date_ms_of(long long y, int mo, int d, int hh, int mi, int ss, int ms) {
  return scr_date_new_ms(scr_date_make_ms(y, mo, d, hh, mi, ss, ms));
}

static bool scr_date_digits(const char **p, const char *end, int n, int *out) {
  int v = 0;
  if (end - *p < n) return false;
  for (int i = 0; i < n; i++) {
    char c = (*p)[i];
    if (c < '0' || c > '9') return false;
    v = v * 10 + (c - '0');
  }
  *p += n;
  *out = v;
  return true;
}

double scr_date_parse_get_time(ScrStr *s) {
  const char *p = s->data;
  const char *end = s->data + s->len;
  static const char *mon[12] = {"Jan", "Feb", "Mar", "Apr", "May", "Jun",
                                "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"};
  /* Grammar 1: "MMM [D]D HH:MM:SS YYYY GMT" (ASN1_TIME_print). */
  if (end - p > 3 && ((p[0] >= 'A' && p[0] <= 'Z') || (p[0] >= 'a' && p[0] <= 'z'))) {
    int mo = 0;
    for (int i = 0; i < 12; i++) {
      if (tolower((unsigned char)p[0]) == tolower((unsigned char)mon[i][0]) &&
          tolower((unsigned char)p[1]) == tolower((unsigned char)mon[i][1]) &&
          tolower((unsigned char)p[2]) == tolower((unsigned char)mon[i][2])) {
        mo = i + 1;
        break;
      }
    }
    if (mo == 0) return NAN;
    p += 3;
    if (p < end && *p == ' ') p++;
    if (p < end && *p == ' ') p++; /* %2d's padding space */
    int d = 0, hh, mi, ss, y;
    if (!scr_date_digits(&p, end, 1, &d)) return NAN;
    int d2;
    if (p < end && *p >= '0' && *p <= '9' && scr_date_digits(&p, end, 1, &d2)) d = d * 10 + d2;
    if (p >= end || *p++ != ' ') return NAN;
    if (!scr_date_digits(&p, end, 2, &hh) || p >= end || *p++ != ':') return NAN;
    if (!scr_date_digits(&p, end, 2, &mi) || p >= end || *p++ != ':') return NAN;
    if (!scr_date_digits(&p, end, 2, &ss) || p >= end || *p++ != ' ') return NAN;
    if (!scr_date_digits(&p, end, 4, &y)) return NAN;
    if (end - p != 4 || memcmp(p, " GMT", 4) != 0) return NAN;
    return scr_date_ms_of(y, mo, d, hh, mi, ss, 0);
  }
  /* Grammar 2: ECMA's date-time string format. */
  {
    int y, mo = 1, d = 1, hh = 0, mi = 0, ss = 0, ms = 0;
    bool sign_year = p < end && (*p == '+' || *p == '-');
    long long yy;
    if (sign_year) {
      int y6;
      bool neg = *p == '-';
      p++;
      if (!scr_date_digits(&p, end, 6, &y6)) return NAN;
      if (neg && y6 == 0) return NAN; /* ECMA forbids expanded -000000 */
      yy = neg ? -(long long)y6 : y6;
    } else {
      if (!scr_date_digits(&p, end, 4, &y)) return NAN;
      yy = y;
    }
    if (p < end && *p == '-') {
      p++;
      if (!scr_date_digits(&p, end, 2, &mo)) return NAN;
      if (p < end && *p == '-') {
        p++;
        if (!scr_date_digits(&p, end, 2, &d)) return NAN;
      }
    }
    if (p == end) return scr_date_ms_of(yy, mo, d, 0, 0, 0, 0); /* date-only: UTC */
    if (*p++ != 'T') return NAN;
    if (!scr_date_digits(&p, end, 2, &hh) || p >= end || *p++ != ':') return NAN;
    if (!scr_date_digits(&p, end, 2, &mi)) return NAN;
    if (p < end && *p == ':') {
      p++;
      if (!scr_date_digits(&p, end, 2, &ss)) return NAN;
      if (p < end && *p == '.') {
        p++;
        if (!scr_date_digits(&p, end, 3, &ms)) return NAN;
      }
    }
    if (p == end) return NAN; /* offset-less date-time: LOCAL in JS — the divergence */
    double off = 0;
    if (*p == 'Z') {
      p++;
    } else if (*p == '+' || *p == '-') {
      bool neg = *p == '-';
      int oh, om;
      p++;
      if (!scr_date_digits(&p, end, 2, &oh) || p >= end || *p++ != ':') return NAN;
      if (!scr_date_digits(&p, end, 2, &om)) return NAN;
      if (oh > 23 || om > 59) return NAN;
      off = (oh * 60 + om) * 60000.0;
      if (neg) off = -off;
    } else {
      return NAN;
    }
    if (p != end) return NAN;
    /* MakeDate can lie just beyond the TimeClip boundary while the
     * explicit offset brings the final UTC instant back into range. The
     * spec clips only after that offset has been applied. */
    double t = scr_date_make_ms(yy, mo, d, hh, mi, ss, ms);
    return scr_date_new_ms(t - off);
  }
}

static double scr_date_parse_v8(ScrStr *s);

/* Date.parse and new Date(string): the bounded grammars answer first; only
 * a string they reject reaches V8's full parser, so the timestamps they
 * accept cost nothing more. */
double scr_date_parse(ScrStr *s) {
  double t = scr_date_parse_get_time(s);
  return isnan(t) ? scr_date_parse_v8(s) : t;
}

/* Date.UTC(year, month, date, hours, minutes, seconds, ms) — the spec's
 * MakeDay/MakeTime/TimeClip pipeline over ALREADY-NUMBER arguments (tsc
 * pins them; the frontend completes omitted trailing arguments with the
 * spec's defaults: month 0, date 1, time parts 0). ToIntegerOrInfinity is
 * trunc on finite values; any non-finite part is NaN. Years 0–99 map to
 * 1900+year (the spec's MakeFullYear), out-of-range months ROLL into the
 * year (Date.UTC(2017, 13) is Feb 2018) and any integer date offsets from
 * day 1 of that month — days_from_civil extrapolates linearly, so both
 * rollovers fall out. V8 bounds MakeDay's input year to ±1e6 and input
 * month to ±1e7 before normalizing the month (kMaxYear/kMinYear and
 * kMaxMonth/kMinMonth, date.h); Node answers NaN past either bound even
 * when the two inputs would normalize back into range. Never throws. */
double scr_date_utc(double y, double mo, double d,
                    double h, double mi, double s, double ms) {
  if (!isfinite(y) || !isfinite(mo) || !isfinite(d) || !isfinite(h) ||
      !isfinite(mi) || !isfinite(s) || !isfinite(ms)) {
    return NAN;
  }
  y = trunc(y);
  mo = trunc(mo);
  d = trunc(d);
  h = trunc(h);
  mi = trunc(mi);
  s = trunc(s);
  ms = trunc(ms);
  if (fabs(y) > 1000000.0 || fabs(mo) > 10000000.0) return NAN;
  if (y >= 0 && y <= 99) y += 1900;
  double ym = y + floor(mo / 12.0);
  int mn = (int)(mo - floor(mo / 12.0) * 12.0); /* 0..11 */
  double days = scr_days_from_civil((long long)ym, mn + 1, 1) + (d - 1.0);
  double t = days * 86400000.0 + h * 3600000.0 + mi * 60000.0 + s * 1000.0 + ms;
  if (fabs(t) > 8640000000000000.0) return NAN; /* TimeClip */
  return t == 0 ? 0 : t; /* normalize -0 (TimeClip's +0) */
}

/* ── Date calendar getters ────────────────────────────────────────────
 * UTC fields use the same proleptic-Gregorian walk as toISOString, so the
 * whole Date range is portable. Local fields use the host timezone via
 * localtime, exactly the environment the sibling Node process observes;
 * a libc that cannot represent an extreme instant answers NaN rather than
 * inventing a zone. */

typedef struct ScrDateParts {
  long long year;
  int month, date, day, hours, minutes, seconds, milliseconds;
  double timezone_offset;
} ScrDateParts;

/* Calendar decomposition itself also serves LocalTime(t), which can lie
 * just outside TimeClip's UTC interval after applying a zone offset at an
 * endpoint. The checked wrapper is the public UTC-getter gate; the inner
 * walk accepts those bounded local-time values too. */
static void scr_date_utc_parts_unchecked(double t, ScrDateParts *out) {
  /* t is an integral number of milliseconds within about 2^53. */
  long long tms = (long long)t;
  long long day = tms / 86400000, msday = tms % 86400000;
  if (msday < 0) {
    msday += 86400000;
    day--;
  }
  long long z = day + 719468;
  long long era = (z >= 0 ? z : z - 146096) / 146097;
  unsigned long long doe = (unsigned long long)(z - era * 146097);
  unsigned long long yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
  long long y = (long long)yoe + era * 400;
  unsigned long long doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
  unsigned long long mp = (5 * doy + 2) / 153;
  unsigned long long d = doy - (153 * mp + 2) / 5 + 1;
  unsigned long long m = mp < 10 ? mp + 3 : mp - 9;
  if (m <= 2) y++;
  long long wday = (day + 4) % 7;
  if (wday < 0) wday += 7;
  out->year = y;
  out->month = (int)m - 1;
  out->date = (int)d;
  out->day = (int)wday;
  out->hours = (int)(msday / 3600000);
  out->minutes = (int)(msday / 60000 % 60);
  out->seconds = (int)(msday / 1000 % 60);
  out->milliseconds = (int)(msday % 1000);
  out->timezone_offset = 0;
}

/* The thread's last UTC decomposition: reading several UTC fields of one
 * Date (getUTCFullYear, getUTCMonth, ...) decomposes it once. */
typedef struct {
  bool valid;
  double ms;
  ScrDateParts parts;
} ScrDateUtcCache;
static SCR_TL ScrDateUtcCache scr_date_utc_cache;

static bool scr_date_utc_parts(double ms, ScrDateParts *out) {
  if (!isfinite(ms) || fabs(ms) > 8640000000000000.0) return false;
  double clipped = trunc(ms);
  ScrDateUtcCache *c = &scr_date_utc_cache;
  if (c->valid && c->ms == clipped) {
    *out = c->parts;
    return true;
  }
  scr_date_utc_parts_unchecked(clipped, out);
  c->valid = true;
  c->ms = clipped;
  c->parts = *out;
  return true;
}

static bool scr_date_localtime(double secd, struct tm *out) {
  time_t sec = (time_t)secd;
  if ((double)sec != secd) return false;
#ifdef _WIN32
  return localtime_s(out, &sec) == 0;
#else
  return localtime_r(&sec, out) != NULL;
#endif
}

/* The thread's last local conversion: reading several local fields of one
 * Date (getFullYear, getMonth, getDate, getHours, ...) converts it once.
 * A change of process.env.TZ starts a new generation. */
typedef struct {
  bool valid;
  unsigned generation;
  double ms;
  ScrDateParts parts;
} ScrDateLocalCache;
static SCR_TL ScrDateLocalCache scr_date_local_cache;

static bool scr_date_local_parts_uncached(double clipped, ScrDateParts *out);

/* The local zone's offset at an instant, cached the way Node's V8 date cache
 * (src/date/date.cc, DateCache::LocalOffsetInMs) caches it, so the answers
 * match Node's in every order of reads. V8 keeps 32 segments of instants with
 * one offset each and takes an offset that matches 19 days apart as constant
 * in between (kDefaultTimeZoneOffsetDeltaInMs). A zone that changed its offset
 * twice within 19 days (America/Argentina/Tucuman in June 2004) breaks that
 * assumption, and Node's answers between the two changes then depend on the
 * order of the reads; this cache gives the same answers for the same order
 * (corpus date-zone-intervals.ts). Segments hold offsets only, as V8's do;
 * zone names decide daylight time at the instant (scr_date_zone_name). */
#define SCR_DATE_ZONE_DELTA_MS (19LL * 86400000LL)
#define SCR_DATE_ZONE_SEGMENTS 32
typedef struct {
  long long start_ms, end_ms; /* empty when start_ms > end_ms */
  double offset;              /* local minus UTC, seconds */
  int last_used;
} ScrDateZoneSegment;
typedef struct {
  bool valid;
  unsigned generation;
  int usage;
  ScrDateZoneSegment segments[SCR_DATE_ZONE_SEGMENTS];
  ScrDateZoneSegment *before, *after;
} ScrDateZoneCache;
static SCR_TL ScrDateZoneCache scr_date_zone_cache;

static bool scr_date_zone_offset(double clipped, double *offset, bool *isdst);

static void scr_date_zone_clear(ScrDateZoneSegment *segment) {
  segment->start_ms = 0;
  segment->end_ms = -1;
  segment->offset = 0;
  segment->last_used = 0;
}

static bool scr_date_zone_empty(const ScrDateZoneSegment *segment) {
  return segment->start_ms > segment->end_ms;
}

static void scr_date_zone_reset(ScrDateZoneCache *z, unsigned generation) {
  for (int i = 0; i < SCR_DATE_ZONE_SEGMENTS; i++) scr_date_zone_clear(&z->segments[i]);
  z->usage = 0;
  z->before = &z->segments[0];
  z->after = &z->segments[1];
  z->valid = true;
  z->generation = generation;
}

/* V8's LeastRecentlyUsedCacheItem: the least recently used segment other
 * than `skip`, cleared. */
static ScrDateZoneSegment *scr_date_zone_lru(ScrDateZoneCache *z, ScrDateZoneSegment *skip) {
  ScrDateZoneSegment *result = NULL;
  for (int i = 0; i < SCR_DATE_ZONE_SEGMENTS; i++) {
    ScrDateZoneSegment *s = &z->segments[i];
    if (s == skip) continue;
    if (!result || result->last_used > s->last_used) result = s;
  }
  scr_date_zone_clear(result);
  return result;
}

/* V8's ProbeCache: the segment starting at or before `t` and the one after. */
static void scr_date_zone_probe(ScrDateZoneCache *z, long long t) {
  ScrDateZoneSegment *before = NULL, *after = NULL;
  for (int i = 0; i < SCR_DATE_ZONE_SEGMENTS; i++) {
    ScrDateZoneSegment *s = &z->segments[i];
    if (scr_date_zone_empty(s)) continue;
    if (s->start_ms <= t) {
      if (!before || before->start_ms < s->start_ms) before = s;
    } else if (t < s->end_ms) {
      if (!after || after->end_ms > s->end_ms) after = s;
    }
  }
  if (!before) before = scr_date_zone_empty(z->before) ? z->before : scr_date_zone_lru(z, after);
  if (!after)
    after = scr_date_zone_empty(z->after) && before != z->after ? z->after : scr_date_zone_lru(z, before);
  z->before = before;
  z->after = after;
}

/* V8's ExtendTheAfterSegment. */
static void scr_date_zone_extend_after(ScrDateZoneCache *z, long long t, double offset) {
  ScrDateZoneSegment *after = z->after;
  if (!scr_date_zone_empty(after) && after->offset == offset &&
      after->start_ms - SCR_DATE_ZONE_DELTA_MS <= t && t <= after->end_ms) {
    after->start_ms = t;
    return;
  }
  if (!scr_date_zone_empty(after)) after = z->after = scr_date_zone_lru(z, z->before);
  after->start_ms = after->end_ms = t;
  after->offset = offset;
  after->last_used = ++z->usage;
}

static bool scr_date_zone_lookup(double clipped, double *offset) {
  bool isdst; /* scr_date_zone_offset's flag, unused here */
  ScrDateZoneCache *z = &scr_date_zone_cache;
  unsigned generation = scr_date_tz_generation;
  if (!z->valid || z->generation != generation) scr_date_zone_reset(z, generation);
  long long t = (long long)clipped;
  if (z->usage >= INT_MAX - 10) {
    z->usage = 0;
    for (int i = 0; i < SCR_DATE_ZONE_SEGMENTS; i++) scr_date_zone_clear(&z->segments[i]);
  }
  ScrDateZoneSegment *before = z->before;
  if (before->start_ms <= t && t <= before->end_ms) {
    before->last_used = ++z->usage;
    *offset = before->offset;
    return true;
  }
  scr_date_zone_probe(z, t);
  before = z->before;
  if (scr_date_zone_empty(before)) {
    if (!scr_date_zone_offset(clipped, offset, &isdst)) return false;
    before->start_ms = before->end_ms = t;
    before->offset = *offset;
    before->last_used = ++z->usage;
    return true;
  }
  if (t <= before->end_ms) {
    before->last_used = ++z->usage;
    *offset = before->offset;
    return true;
  }
  if (t - SCR_DATE_ZONE_DELTA_MS > before->end_ms) {
    if (!scr_date_zone_offset(clipped, offset, &isdst)) return false;
    scr_date_zone_extend_after(z, t, *offset);
    ScrDateZoneSegment *swap = z->before;
    z->before = z->after;
    z->after = swap;
    return true;
  }
  before->last_used = ++z->usage;
  long long ahead = before->end_ms + SCR_DATE_ZONE_DELTA_MS;
  if (scr_date_zone_empty(z->after) || ahead <= z->after->start_ms) {
    double ahead_offset;
    if (!scr_date_zone_offset((double)ahead, &ahead_offset, &isdst)) return false;
    scr_date_zone_extend_after(z, ahead, ahead_offset);
  } else {
    z->after->last_used = ++z->usage;
  }
  ScrDateZoneSegment *after = z->after;
  if (before->offset == after->offset) {
    before->end_ms = after->end_ms;
    scr_date_zone_clear(after);
    *offset = before->offset;
    return true;
  }
  /* Binary search for the change point, giving up after five probes (the
   * last one reads `t` itself). */
  for (int i = 4; i >= 0; i--) {
    long long delta = after->start_ms - before->end_ms;
    long long middle = i == 0 ? t : before->end_ms + delta / 2;
    if (!scr_date_zone_offset((double)middle, offset, &isdst)) return false;
    if (before->offset == *offset) {
      before->end_ms = middle;
      if (t <= before->end_ms) return true;
    } else {
      after->start_ms = middle;
      if (t >= after->start_ms) {
        ScrDateZoneSegment *swap = z->before;
        z->before = z->after;
        z->after = swap;
        return true;
      }
    }
  }
  return true;
}

static bool scr_date_local_parts(double ms, ScrDateParts *out) {
  if (!isfinite(ms) || fabs(ms) > 8640000000000000.0) return false;
  double clipped = trunc(ms);
  ScrDateLocalCache *c = &scr_date_local_cache;
  unsigned generation = scr_date_tz_generation;
  if (c->valid && c->ms == clipped && c->generation == generation) {
    *out = c->parts;
    return true;
  }
  if (!scr_date_local_parts_uncached(clipped, out)) return false;
  c->valid = true;
  c->generation = generation;
  c->ms = clipped;
  c->parts = *out;
  return true;
}

static bool scr_date_local_parts_uncached(double clipped, ScrDateParts *out) {
  double local_offset;
  if (!scr_date_zone_lookup(clipped, &local_offset)) return false;
  scr_date_utc_parts_unchecked(clipped + local_offset * 1000.0, out);
  double timezone_offset = trunc(-local_offset / 60.0);
  out->timezone_offset = timezone_offset == 0 ? 0 : timezone_offset;
  return true;
}

/* The local zone's offset (local minus UTC, in seconds) and DST flag at a
 * clipped instant, from the host's localtime. */
static bool scr_date_zone_offset(double clipped, double *offset, bool *isdst) {
  long long cms = (long long)clipped;
  double secd = (double)(cms / 1000 - (cms % 1000 < 0));
  struct tm tmv;
  double basis_secd = secd;
  if (!scr_date_localtime(basis_secd, &tmv)) {
    /* Windows' _localtime64_s rejects pre-epoch instants and years after
     * 3001 even though both are valid ECMAScript Dates. Query the host's
     * zone rule at a calendar-equivalent surrogate year in 2000..2399:
     * Gregorian weekdays/leap years repeat every 400 years. This keeps
     * every valid Date finite; the OS-vs-Node historical-rule difference
     * remains the documented timezone-data divergence. */
    ScrDateParts utc;
    scr_date_utc_parts_unchecked(clipped, &utc);
    long long cycle_year = (utc.year - 2000) % 400;
    if (cycle_year < 0) cycle_year += 400;
    long long surrogate_year = 2000 + cycle_year;
    basis_secd =
      scr_days_from_civil(surrogate_year, utc.month + 1, utc.date) * 86400.0 +
      utc.hours * 3600.0 + utc.minutes * 60.0 + utc.seconds;
    if (!scr_date_localtime(basis_secd, &tmv)) return false;
  }
  /* Treat the local broken-down fields as UTC. Its distance from the real
   * (or surrogate) epoch second is the zone offset. Apply that offset to
   * the original instant and use the portable Gregorian walk for its
   * fields; Date#getTimezoneOffset uses the
   * opposite sign (UTC - local), in whole minutes. Historical local-mean
   * offsets can contain seconds, which JavaScript truncates toward zero. */
  double local_as_utc =
    scr_days_from_civil((long long)tmv.tm_year + 1900, tmv.tm_mon + 1, tmv.tm_mday) * 86400.0 +
    tmv.tm_hour * 3600.0 + tmv.tm_min * 60.0 + tmv.tm_sec;
  *offset = local_as_utc - basis_secd;
  *isdst = tmv.tm_isdst > 0;
  return true;
}

static bool scr_date_parts(double ms, bool utc, ScrDateParts *out) {
  return utc ? scr_date_utc_parts(ms, out) : scr_date_local_parts(ms, out);
}

#define SCR_DATE_PART_GETTER(name, field)                                    \
  double scr_date_get_##name(double ms, bool utc) {                          \
    ScrDateParts p;                                                           \
    return scr_date_parts(ms, utc, &p) ? (double)p.field : NAN;              \
  }                                                                           \
  double scr_date_get_##name##_local(double ms) {                            \
    return scr_date_get_##name(ms, false);                                    \
  }                                                                           \
  double scr_date_get_##name##_utc(double ms) {                              \
    return scr_date_get_##name(ms, true);                                     \
  }

SCR_DATE_PART_GETTER(full_year, year)
SCR_DATE_PART_GETTER(month, month)
SCR_DATE_PART_GETTER(date, date)
SCR_DATE_PART_GETTER(day, day)
SCR_DATE_PART_GETTER(hours, hours)
SCR_DATE_PART_GETTER(minutes, minutes)
SCR_DATE_PART_GETTER(seconds, seconds)

#undef SCR_DATE_PART_GETTER

double scr_date_get_milliseconds(double ms) {
  ScrDateParts p;
  return scr_date_utc_parts(ms, &p) ? (double)p.milliseconds : NAN;
}

double scr_date_get_timezone_offset(double ms) {
  ScrDateParts p;
  return scr_date_local_parts(ms, &p) ? p.timezone_offset : NAN;
}

/* ── Local time to UTC, and the year/month field constructor ───────────
 * The spec's UTC(t) over the host zone: t is a local wall-clock time
 * value. The offset in effect a day before and a day after t brackets any
 * transition (none come closer together than that in tzdata). A time in
 * a DST overlap has two instants and answers the earlier; a time in a gap
 * has none and is read with the offset BEFORE the transition, exactly
 * V8's ICU getOffsetFromLocal(FORMER, FORMER). Offsets come from the same
 * localtime/surrogate-year walk as the local getters, so a Date built
 * from local fields reads those fields back. */

/* The host zone's offset (local - UTC) in ms at UTC instant `ms` (an
 * integral time value within about ±8.65e15). */
static bool scr_date_offset_at(double ms, double *out) {
  long long cms = (long long)ms;
  double secd = (double)(cms / 1000 - (cms % 1000 < 0));
  struct tm tmv;
  double basis_secd = secd;
  if (!scr_date_localtime(basis_secd, &tmv)) {
    ScrDateParts utc;
    scr_date_utc_parts_unchecked(ms, &utc);
    long long cycle_year = (utc.year - 2000) % 400;
    if (cycle_year < 0) cycle_year += 400;
    basis_secd =
      scr_days_from_civil(2000 + cycle_year, utc.month + 1, utc.date) * 86400.0 +
      utc.hours * 3600.0 + utc.minutes * 60.0 + utc.seconds;
    if (!scr_date_localtime(basis_secd, &tmv)) return false;
  }
  double local_as_utc =
    scr_days_from_civil((long long)tmv.tm_year + 1900, tmv.tm_mon + 1, tmv.tm_mday) * 86400.0 +
    tmv.tm_hour * 3600.0 + tmv.tm_min * 60.0 + tmv.tm_sec;
  *out = (local_as_utc - basis_secd) * 1000.0;
  return true;
}

static volatile const double scr_date_day_ms = 86400000.0;

static double scr_date_local_to_utc(double t) {
  double before, after, at_first, at_second, day = scr_date_day_ms;
  if (!scr_date_offset_at(t - day, &before) || !scr_date_offset_at(t + day, &after)) {
    return NAN;
  }
  double first = t - before;
  if (!scr_date_offset_at(first, &at_first)) return NAN;
  if (before == after) {
    if (at_first == before) return first;
    /* Two transitions inside the window: settle on the instant's own offset. */
    double again = t - at_first, at_again;
    if (scr_date_offset_at(again, &at_again) && at_again == at_first) return again;
    return first;
  }
  double second = t - after;
  if (!scr_date_offset_at(second, &at_second)) return NAN;
  bool first_ok = at_first == before, second_ok = at_second == after;
  if (first_ok && second_ok) return first < second ? first : second; /* overlap */
  if (second_ok && !first_ok) return second;
  return first; /* the earlier offset's instant, or a gap */
}

/* V8's MakeDay (date.cc): bounds the UNtruncated year and month, then
 * truncates (FastD2I) and normalizes the month into the year. */
static double scr_date_v8_make_day(double year, double month, double date) {
  if (!(fabs(year) <= 1000000.0 && fabs(month) <= 10000000.0 && isfinite(date))) return NAN;
  int y = (int)year, m = (int)month;
  y += m / 12;
  m %= 12;
  if (m < 0) {
    m += 12;
    y -= 1;
  }
  static const int year_delta = 399999;
  static const int base_day = 365 * (1970 + year_delta) + (1970 + year_delta) / 4 -
                              (1970 + year_delta) / 100 + (1970 + year_delta) / 400;
  int day_from_year = 365 * (y + year_delta) + (y + year_delta) / 4 -
                      (y + year_delta) / 100 + (y + year_delta) / 400 - base_day;
  static const int common[12] = {0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334};
  static const int leap[12] = {0, 31, 60, 91, 121, 152, 182, 213, 244, 274, 305, 335};
  bool is_leap = !((y % 4 != 0) || (y % 100 == 0 && y % 400 != 0));
  day_from_year += is_leap ? leap[m] : common[m];
  return (double)(day_from_year - 1) + trunc(date);
}

static double scr_date_v8_make_time(double h, double m, double s, double ms) {
  if (!isfinite(h) || !isfinite(m) || !isfinite(s) || !isfinite(ms)) return NAN;
  return trunc(h) * 3600000.0 + trunc(m) * 60000.0 + trunc(s) * 1000.0 + trunc(ms);
}

/* V8's bound on a local time value before UTC(t): TimeClip's range plus
 * ten days. Read from memory so the value stays in its own section instead
 * of this unit's shared constant pool, which every program linking the
 * unit carries. */
static volatile const double scr_date_local_limit = 8640000864000000.0;

/* MakeDate over local fields, then UTC(t) and TimeClip. V8 refuses a local
 * time value more than ten days past TimeClip's range before converting. */
static double scr_date_from_local(double day, double time) {
  if (!isfinite(day) || !isfinite(time)) return NAN;
  double t = time + day * 86400000.0;
  if (!(fabs(t) <= scr_date_local_limit)) return NAN;
  return scr_date_new_ms(scr_date_local_to_utc(trunc(t)));
}

/* new Date(year, monthIndex[, date[, hours[, minutes[, seconds[, ms]]]]])
 * over already-number arguments (the frontend completes omitted trailing
 * arguments with date 1 and time parts 0): years 0–99 map to 1900+year,
 * fields roll over through MakeDay/MakeTime, and the local time converts
 * to UTC in the host zone. Never throws. */
double scr_date_new_local(double y, double mo, double d,
                          double h, double mi, double s, double ms) {
  if (!isnan(y)) {
    double yi = trunc(y);
    if (yi >= 0 && yi <= 99) y = 1900 + yi;
  }
  return scr_date_from_local(scr_date_v8_make_day(y, mo, d), scr_date_v8_make_time(h, mi, s, ms));
}

/* ── V8's date-string parser, the fallback ─────────────────────────────
 * scr_date_parse answers the bounded grammars directly and asks
 * this parser only when they produce NaN. It follows V8's DateParser
 * (dateparser.cc, dateparser-inl.h) step for step: the ES5 date-time
 * format first, then the Safari-compatible legacy grammar for whatever
 * is left (RFC 1123/2822 HTTP dates, Date#toString output, "Jan 2, 2024",
 * "2024/01/02 10:00", ...). Strings are read as UTF-16 code units, and a
 * NUL unit ends the input, as in V8. A date without a zone is local time. */

enum {
  SCR_DT_INVALID = -6, SCR_DT_UNKNOWN = -5, SCR_DT_SPACE = -4,
  SCR_DT_NUMBER = -3, SCR_DT_SYMBOL = -2, SCR_DT_END = -1,
  /* keyword tags are their keyword type (>= 0) */
  SCR_DK_WORD = 0, SCR_DK_MONTH = 1, SCR_DK_ZONE = 2, SCR_DK_T = 3, SCR_DK_AMPM = 4,
};
#define SCR_DT_NONE INT_MAX

typedef struct {
  int tag, length, value;
} ScrDateTok;

typedef struct {
  const unsigned char *p, *end;
  uint32_t ch, low;
  ScrDateTok next;
} ScrDateScan;

static void scr_date_scan_advance(ScrDateScan *in) {
  if (in->low) {
    in->ch = in->low;
    in->low = 0;
    return;
  }
  if (in->p >= in->end) {
    in->ch = 0;
    return;
  }
  const unsigned char *p = in->p;
  size_t left = (size_t)(in->end - p);
  uint32_t cp = p[0];
  size_t n = 1;
  if (cp >= 0xF0 && left >= 4) {
    cp = ((cp & 0x07u) << 18) | ((p[1] & 0x3Fu) << 12) | ((p[2] & 0x3Fu) << 6) | (p[3] & 0x3Fu);
    n = 4;
  } else if (cp >= 0xE0 && left >= 3) {
    cp = ((cp & 0x0Fu) << 12) | ((p[1] & 0x3Fu) << 6) | (p[2] & 0x3Fu);
    n = 3;
  } else if (cp >= 0xC0 && left >= 2) {
    cp = ((cp & 0x1Fu) << 6) | (p[1] & 0x3Fu);
    n = 2;
  } else if (cp >= 0x80) {
    cp = 0xFFFD;
  }
  in->p += n;
  if (cp > 0xFFFF) {
    cp -= 0x10000;
    in->ch = 0xD800 + (cp >> 10);
    in->low = 0xDC00 + (cp & 0x3FF);
  } else {
    in->ch = cp;
  }
}

/* ECMAScript WhiteSpace, and WhiteSpace or LineTerminator. */
static bool scr_date_is_space(uint32_t c) {
  return c == 0x09 || c == 0x0B || c == 0x0C || c == 0x20 || c == 0xA0 || c == 0xFEFF ||
         c == 0x1680 || (c >= 0x2000 && c <= 0x200A) || c == 0x202F || c == 0x205F ||
         c == 0x3000;
}

static bool scr_date_is_space_or_newline(uint32_t c) {
  return scr_date_is_space(c) || c == 0x0A || c == 0x0D || c == 0x2028 || c == 0x2029;
}

static const struct {
  char prefix[3];
  signed char type, value;
} scr_date_keywords[] = {
  {{'j', 'a', 'n'}, SCR_DK_MONTH, 1}, {{'f', 'e', 'b'}, SCR_DK_MONTH, 2},
  {{'m', 'a', 'r'}, SCR_DK_MONTH, 3}, {{'a', 'p', 'r'}, SCR_DK_MONTH, 4},
  {{'m', 'a', 'y'}, SCR_DK_MONTH, 5}, {{'j', 'u', 'n'}, SCR_DK_MONTH, 6},
  {{'j', 'u', 'l'}, SCR_DK_MONTH, 7}, {{'a', 'u', 'g'}, SCR_DK_MONTH, 8},
  {{'s', 'e', 'p'}, SCR_DK_MONTH, 9}, {{'o', 'c', 't'}, SCR_DK_MONTH, 10},
  {{'n', 'o', 'v'}, SCR_DK_MONTH, 11}, {{'d', 'e', 'c'}, SCR_DK_MONTH, 12},
  {{'a', 'm', 0}, SCR_DK_AMPM, 0}, {{'p', 'm', 0}, SCR_DK_AMPM, 12},
  {{'u', 't', 0}, SCR_DK_ZONE, 0}, {{'u', 't', 'c'}, SCR_DK_ZONE, 0},
  {{'z', 0, 0}, SCR_DK_ZONE, 0}, {{'g', 'm', 't'}, SCR_DK_ZONE, 0},
  {{'c', 'd', 't'}, SCR_DK_ZONE, -5}, {{'c', 's', 't'}, SCR_DK_ZONE, -6},
  {{'e', 'd', 't'}, SCR_DK_ZONE, -4}, {{'e', 's', 't'}, SCR_DK_ZONE, -5},
  {{'m', 'd', 't'}, SCR_DK_ZONE, -6}, {{'m', 's', 't'}, SCR_DK_ZONE, -7},
  {{'p', 'd', 't'}, SCR_DK_ZONE, -7}, {{'p', 's', 't'}, SCR_DK_ZONE, -8},
  {{'t', 0, 0}, SCR_DK_T, 0},
};

static ScrDateTok scr_date_scan_token(ScrDateScan *in) {
  ScrDateTok t;
  t.tag = SCR_DT_UNKNOWN;
  t.length = 1;
  t.value = -1;
  uint32_t c = in->ch;
  if (c == 0) {
    t.tag = SCR_DT_END;
    return t;
  }
  if (c >= '0' && c <= '9') {
    /* Leading zeros count toward the length; past nine significant
     * digits the value stops growing but the digits are consumed. */
    int n = 0, digits = 0, length = 0;
    while (in->ch == '0') {
      scr_date_scan_advance(in);
      length++;
    }
    while (in->ch >= '0' && in->ch <= '9') {
      if (digits < 9) n = n * 10 + (int)(in->ch - '0');
      digits++;
      length++;
      scr_date_scan_advance(in);
    }
    t.tag = SCR_DT_NUMBER;
    t.value = n;
    t.length = length;
    return t;
  }
  if (c == ':' || c == '-' || c == '+' || c == '.' || c == ')') {
    scr_date_scan_advance(in);
    t.tag = SCR_DT_SYMBOL;
    t.value = (int)c;
    return t;
  }
  if (c >= 'A' && !scr_date_is_space(c)) {
    uint32_t prefix[3];
    prefix[0] = prefix[1] = prefix[2] = 0;
    int length = 0;
    while (in->ch >= 'A' && !scr_date_is_space(in->ch)) {
      if (length < 3) prefix[length] = in->ch | 0x20;
      length++;
      scr_date_scan_advance(in);
    }
    t.tag = SCR_DK_WORD;
    t.value = 0;
    t.length = length;
    for (size_t i = 0; i < sizeof scr_date_keywords / sizeof scr_date_keywords[0]; i++) {
      const char *k = scr_date_keywords[i].prefix;
      if (prefix[0] == (uint32_t)(unsigned char)k[0] && prefix[1] == (uint32_t)(unsigned char)k[1] &&
          prefix[2] == (uint32_t)(unsigned char)k[2] &&
          (length <= 3 || scr_date_keywords[i].type == SCR_DK_MONTH)) {
        t.tag = scr_date_keywords[i].type;
        t.value = scr_date_keywords[i].value;
        break;
      }
    }
    return t;
  }
  if (scr_date_is_space_or_newline(c)) {
    scr_date_scan_advance(in);
    t.tag = SCR_DT_SPACE;
    return t;
  }
  if (c == '(') {
    int balance = 0;
    do {
      if (in->ch == ')') balance--;
      else if (in->ch == '(') balance++;
      scr_date_scan_advance(in);
    } while (balance > 0 && in->ch);
    return t;
  }
  scr_date_scan_advance(in);
  return t;
}

static ScrDateTok scr_date_next(ScrDateScan *in) {
  ScrDateTok t = in->next;
  in->next = scr_date_scan_token(in);
  return t;
}

static bool scr_date_tok_symbol(ScrDateTok t, int c) {
  return t.tag == SCR_DT_SYMBOL && t.value == c;
}

static bool scr_date_skip(ScrDateScan *in, int c) {
  if (!scr_date_tok_symbol(in->next, c)) return false;
  in->next = scr_date_scan_token(in);
  return true;
}

static bool scr_date_tok_sign(ScrDateTok t) {
  return t.tag == SCR_DT_SYMBOL && (t.value == '-' || t.value == '+');
}

static bool scr_date_tok_fixed(ScrDateTok t, int length) {
  return t.tag == SCR_DT_NUMBER && t.length == length;
}

static bool scr_date_tok_z(ScrDateTok t) {
  return t.tag == SCR_DK_ZONE && t.length == 1 && t.value == 0;
}

static bool scr_date_between(int x, int lo, int hi) { return x >= lo && x <= hi; }

typedef struct {
  int comp[3], index, named_month;
  bool iso;
} ScrDateDay;

typedef struct {
  int comp[4], index, hour_offset;
} ScrDateTime;

typedef struct {
  int sign, hour, minute;
} ScrDateZone;

static bool scr_date_day_add(ScrDateDay *d, int n) {
  if (d->index >= 3) return false;
  d->comp[d->index++] = n;
  return true;
}

static bool scr_date_time_add(ScrDateTime *t, int n) {
  if (t->index >= 4) return false;
  t->comp[t->index++] = n;
  return true;
}

static bool scr_date_time_add_final(ScrDateTime *t, int n) {
  if (!scr_date_time_add(t, n)) return false;
  while (t->index < 4) t->comp[t->index++] = 0;
  return true;
}

static bool scr_date_time_expecting(const ScrDateTime *t, int n) {
  return (t->index == 1 && scr_date_between(n, 0, 59)) ||
         (t->index == 2 && scr_date_between(n, 0, 59)) ||
         (t->index == 3 && scr_date_between(n, 0, 999));
}

static void scr_date_zone_set(ScrDateZone *z, int hours) {
  z->sign = hours < 0 ? -1 : 1;
  z->hour = hours * z->sign;
  z->minute = 0;
}

static bool scr_date_zone_expecting(const ScrDateZone *z, int n) {
  return z->hour != SCR_DT_NONE && z->minute == SCR_DT_NONE && scr_date_between(n, 0, 59);
}

/* ReadMilliseconds: the first three significant digits of the numeral. */
static int scr_date_millis(ScrDateTok t) {
  int number = t.value, length = t.length;
  if (length == 1) number *= 100;
  else if (length == 2) number *= 10;
  else if (length > 3) {
    static const int factors[] = {10, 100, 1000, 10000, 100000, 1000000};
    if (length > 9) length = 9;
    number /= factors[length - 4];
  }
  return number;
}

/* ParseES5DateTime: answers the first token it could not place (the
 * legacy grammar resumes there), END after a complete ES5 string, or
 * INVALID for a malformed ES5 time part. */
static ScrDateTok scr_date_parse_es5(ScrDateScan *in, ScrDateDay *day, ScrDateTime *time,
                                     ScrDateZone *tz) {
  ScrDateTok invalid;
  invalid.tag = SCR_DT_INVALID;
  invalid.length = 0;
  invalid.value = -1;
  if (scr_date_tok_sign(in->next)) {
    ScrDateTok sign = scr_date_next(in);
    if (!scr_date_tok_fixed(in->next, 6)) return sign;
    int s = 44 - sign.value;
    int year = scr_date_next(in).value;
    if (s < 0 && year == 0) return sign;
    scr_date_day_add(day, s * year);
  } else if (scr_date_tok_fixed(in->next, 4)) {
    scr_date_day_add(day, scr_date_next(in).value);
  } else {
    return scr_date_next(in);
  }
  if (scr_date_skip(in, '-')) {
    if (!scr_date_tok_fixed(in->next, 2) || !scr_date_between(in->next.value, 1, 12)) {
      return scr_date_next(in);
    }
    scr_date_day_add(day, scr_date_next(in).value);
    if (scr_date_skip(in, '-')) {
      if (!scr_date_tok_fixed(in->next, 2) || !scr_date_between(in->next.value, 1, 31)) {
        return scr_date_next(in);
      }
      scr_date_day_add(day, scr_date_next(in).value);
    }
  }
  if (in->next.tag != SCR_DK_T) {
    if (in->next.tag != SCR_DT_END) return scr_date_next(in);
  } else {
    scr_date_next(in);
    if (!scr_date_tok_fixed(in->next, 2) || !scr_date_between(in->next.value, 0, 24)) return invalid;
    bool hour_is_24 = in->next.value == 24;
    scr_date_time_add(time, scr_date_next(in).value);
    if (!scr_date_skip(in, ':')) return invalid;
    if (!scr_date_tok_fixed(in->next, 2) || !scr_date_between(in->next.value, 0, 59) ||
        (hour_is_24 && in->next.value > 0)) {
      return invalid;
    }
    scr_date_time_add(time, scr_date_next(in).value);
    if (scr_date_skip(in, ':')) {
      if (!scr_date_tok_fixed(in->next, 2) || !scr_date_between(in->next.value, 0, 59) ||
          (hour_is_24 && in->next.value > 0)) {
        return invalid;
      }
      scr_date_time_add(time, scr_date_next(in).value);
      if (scr_date_skip(in, '.')) {
        if (in->next.tag != SCR_DT_NUMBER || (hour_is_24 && in->next.value > 0)) return invalid;
        scr_date_time_add(time, scr_date_millis(scr_date_next(in)));
      }
    }
    if (scr_date_tok_z(in->next)) {
      scr_date_next(in);
      scr_date_zone_set(tz, 0);
    } else if (scr_date_tok_sign(in->next)) {
      tz->sign = scr_date_next(in).value == '+' ? 1 : -1;
      if (scr_date_tok_fixed(in->next, 4)) {
        int hourmin = scr_date_next(in).value;
        int hour = hourmin / 100, minute = hourmin % 100;
        if (!scr_date_between(hour, 0, 23) || !scr_date_between(minute, 0, 59)) return invalid;
        tz->hour = hour;
        tz->minute = minute;
      } else {
        if (!scr_date_tok_fixed(in->next, 2) || !scr_date_between(in->next.value, 0, 23)) {
          return invalid;
        }
        tz->hour = scr_date_next(in).value;
        if (!scr_date_skip(in, ':')) return invalid;
        if (!scr_date_tok_fixed(in->next, 2) || !scr_date_between(in->next.value, 0, 59)) {
          return invalid;
        }
        tz->minute = scr_date_next(in).value;
      }
    }
    if (in->next.tag != SCR_DT_END) return invalid;
  }
  /* Date-only forms without a zone are UTC; date-times are local. */
  if (tz->hour == SCR_DT_NONE && time->index == 0) scr_date_zone_set(tz, 0);
  day->iso = true;
  ScrDateTok end;
  end.tag = SCR_DT_END;
  end.length = 0;
  end.value = -1;
  return end;
}

static bool scr_date_day_write(ScrDateDay *d, double *year_out, double *month_out, double *day_out) {
  if (d->index < 1) return false;
  while (d->index < 3) d->comp[d->index++] = 1;
  int year = 0, month, day;
  if (d->named_month == SCR_DT_NONE) {
    if (d->iso || !scr_date_between(d->comp[0], 1, 31)) {
      year = d->comp[0];
      month = d->comp[1];
      day = d->comp[2];
    } else {
      month = d->comp[0];
      day = d->comp[1];
      year = d->comp[2];
    }
  } else {
    month = d->named_month;
    /* V8 pads to three components before choosing an order, so a lone
     * day after a month name reads the padding 1 as the year (2001). */
    if (!scr_date_between(d->comp[0], 1, 31)) {
      year = d->comp[0];
      day = d->comp[1];
    } else {
      day = d->comp[0];
      year = d->comp[1];
    }
  }
  if (!d->iso) {
    if (scr_date_between(year, 0, 49)) year += 2000;
    else if (scr_date_between(year, 50, 99)) year += 1900;
  }
  if (!scr_date_between(month, 1, 12) || !scr_date_between(day, 1, 31)) return false;
  *year_out = year;
  *month_out = month - 1;
  *day_out = day;
  return true;
}

static bool scr_date_time_write(ScrDateTime *t, double out[4]) {
  while (t->index < 4) t->comp[t->index++] = 0;
  int hour = t->comp[0], minute = t->comp[1], second = t->comp[2], millisecond = t->comp[3];
  if (t->hour_offset != SCR_DT_NONE) {
    if (!scr_date_between(hour, 0, 12)) return false;
    hour %= 12;
    hour += t->hour_offset;
  }
  if (!scr_date_between(hour, 0, 23) || !scr_date_between(minute, 0, 59) ||
      !scr_date_between(second, 0, 59) || !scr_date_between(millisecond, 0, 999)) {
    if (hour != 24 || minute != 0 || second != 0 || millisecond != 0) return false;
  }
  out[0] = hour;
  out[1] = minute;
  out[2] = second;
  out[3] = millisecond;
  return true;
}

static bool scr_date_zone_write(ScrDateZone *z, double *offset_ms) {
  if (z->sign == SCR_DT_NONE) {
    *offset_ms = NAN;
    return true;
  }
  if (z->hour == SCR_DT_NONE) z->hour = 0;
  if (z->minute == SCR_DT_NONE) z->minute = 0;
  unsigned total = (unsigned)z->hour * 3600u + (unsigned)z->minute * 60u;
  if (total > (unsigned)INT_MAX) return false;
  long long ms = (long long)total * 1000;
  *offset_ms = (double)(z->sign < 0 ? -ms : ms);
  return true;
}

static double scr_date_parse_v8(ScrStr *s) {
  /* Field-by-field initialization keeps vector constants out of the
   * unit's shared constant pool (see scr_date_local_limit). */
  ScrDateScan in;
  in.p = (const unsigned char *)s->data;
  in.end = in.p + s->len;
  in.ch = 0;
  in.low = 0;
  scr_date_scan_advance(&in);
  in.next = scr_date_scan_token(&in);
  ScrDateDay day;
  day.index = 0;
  day.named_month = SCR_DT_NONE;
  day.iso = false;
  ScrDateTime time;
  time.index = 0;
  time.hour_offset = SCR_DT_NONE;
  ScrDateZone tz;
  tz.sign = SCR_DT_NONE;
  tz.hour = SCR_DT_NONE;
  tz.minute = SCR_DT_NONE;
  ScrDateTok token = scr_date_parse_es5(&in, &day, &time, &tz);
  if (token.tag == SCR_DT_INVALID) return NAN;
  bool has_read_number = day.index != 0;
  for (; token.tag != SCR_DT_END; token = scr_date_next(&in)) {
    if (token.tag == SCR_DT_NUMBER) {
      has_read_number = true;
      int n = token.value;
      if (scr_date_skip(&in, ':')) {
        if (scr_date_skip(&in, ':')) {
          /* n:: */
          if (time.index != 0) return NAN;
          scr_date_time_add(&time, n);
          scr_date_time_add(&time, 0);
        } else {
          if (!scr_date_time_add(&time, n)) return NAN;
          if (scr_date_tok_symbol(in.next, '.')) scr_date_next(&in);
        }
      } else if (scr_date_skip(&in, '.') && scr_date_time_expecting(&time, n)) {
        scr_date_time_add(&time, n);
        if (in.next.tag != SCR_DT_NUMBER) return NAN;
        int ms = scr_date_millis(scr_date_next(&in));
        if (ms < 0) return NAN;
        scr_date_time_add_final(&time, ms);
      } else if (scr_date_zone_expecting(&tz, n)) {
        tz.minute = n;
      } else if (scr_date_time_expecting(&time, n)) {
        scr_date_time_add_final(&time, n);
        ScrDateTok peek = in.next;
        if (peek.tag != SCR_DT_END && peek.tag != SCR_DT_SPACE && !scr_date_tok_z(peek) &&
            !scr_date_tok_sign(peek)) {
          return NAN;
        }
      } else {
        if (!scr_date_day_add(&day, n)) return NAN;
        scr_date_skip(&in, '-');
      }
    } else if (token.tag >= 0) {
      if (token.tag == SCR_DK_AMPM && time.index != 0) {
        time.hour_offset = token.value;
      } else if (token.tag == SCR_DK_MONTH) {
        day.named_month = token.value;
        scr_date_skip(&in, '-');
      } else if (token.tag == SCR_DK_ZONE && has_read_number) {
        scr_date_zone_set(&tz, token.value);
      } else {
        /* Garbage words are illegal once a number has been read, and the
         * first number must be separated from them. */
        if (has_read_number) return NAN;
        if (in.next.tag == SCR_DT_NUMBER) return NAN;
      }
    } else if (scr_date_tok_sign(token) &&
               ((tz.hour == 0 && tz.minute == 0) || time.index != 0)) {
      /* A UTC offset, only after UTC or a time. */
      tz.sign = token.value == '-' ? -1 : 1;
      int n = 0, length = 0;
      if (in.next.tag == SCR_DT_NUMBER) {
        ScrDateTok number = scr_date_next(&in);
        length = number.length;
        n = number.value;
      }
      has_read_number = true;
      if (scr_date_tok_symbol(in.next, ':')) {
        tz.hour = n;
        tz.minute = SCR_DT_NONE;
      } else if (length == 2 || length == 1) {
        tz.hour = n;
        tz.minute = 0;
      } else if (length == 4 || length == 3) {
        tz.hour = n / 100;
        tz.minute = n % 100;
      } else {
        return NAN;
      }
    } else if ((scr_date_tok_sign(token) || scr_date_tok_symbol(token, ')')) && has_read_number) {
      return NAN;
    }
    /* Anything else (whitespace, unknown characters) is ignored. */
  }
  double year, month, date, hms[4], offset;
  if (!scr_date_day_write(&day, &year, &month, &date) || !scr_date_time_write(&time, hms) ||
      !scr_date_zone_write(&tz, &offset)) {
    return NAN;
  }
  double dayv = scr_date_v8_make_day(year, month, date);
  double timev = scr_date_v8_make_time(hms[0], hms[1], hms[2], hms[3]);
  if (isnan(offset)) return scr_date_from_local(dayv, timev);
  if (!isfinite(dayv) || !isfinite(timev)) return NAN;
  double t = timev + dayv * 86400000.0 - offset;
  if (!(fabs(t) <= 8640000000000000.0)) return NAN;
  return scr_date_new_ms(t);
}

/* ── Date time zone names ───────────────────────────────────────────────
 * Long time zone names for Date.prototype.toString and toTimeString.
 *
 * Node prints "GMT-0500 (Central Daylight Time)": the name comes from ICU
 * for the host zone, in standard or daylight form. ICU identifies the host
 * zone from TZ when it looks like a zone ID, else from /etc/localtime (the
 * symlink's target, or the zoneinfo file with the same contents), else
 * from the libc zone abbreviation. The runtime follows the same steps and
 * looks the ID up in the names Node prints for each tzdata zone
 * (scr_timezone_data.h, generated). An ID without a row prints Node's
 * fallback for a zone without a name, "GMT+hh:mm" with the zone's standard
 * offset.
 *
 * Whether an instant is in daylight time follows V8: instants before 1970
 * or after 2038-01-19 use the instant with the same month, day and time in
 * an equivalent year between 2008 and 2037 (same leap-year status and
 * weekday of January 1), and tm_isdst decides. A few zones carry Node's
 * own daylight-time changes instead: those whose tzdata rules use a
 * negative daylight saving (Europe/Dublin's winter time, Morocco's Ramadan
 * time), where ICU's data calls the larger offset daylight time, and those
 * Node shows in daylight time through 2038 (British Columbia's permanent
 * UTC-7, which tzdata names standard time). */
#include "scr_timezone_data.h"

#define SCR_TZ_ROWS (sizeof scr_tz_names / sizeof scr_tz_names[0])

/* Text that no other code in this file uses lives in named arrays: string
 * literals would join the merged read-only strings of every program that
 * links this file. */
static const char scr_tz_posix_ids[4][8] = { "PST8PDT", "MST7MDT", "CST6CDT", "EST5EDT" };
static const char scr_tz_prefixes[2][7] = { "posix/", "right/" };
static const char scr_tz_env_name[] = "TZ";
static const char scr_tz_utc[] = "UTC";
static const char scr_tz_localtime_path[] = "/etc/localtime";
static const char scr_tz_zoneinfo_tail[] = "/zoneinfo/";
static const char scr_tz_zoneinfo_dir[] = "/usr/share/zoneinfo/";
static const char scr_tz_skipped[4][11] = { ".", "..", "posixrules", "localtime" };
static const char scr_tz_fallback_format[] = "GMT%c%02lld:%02lld";
static const char scr_date_invalid_text[] = "Invalid Date";

/* The thread's host zone, detected again after a write to process.env.TZ
 * (scr_date_tz_generation). */
typedef struct {
  unsigned generation;
  const ScrTzNames *row; /* NULL: no row, use the fallback */
  bool resolved;
  bool fallback_ready;
  char fallback[16]; /* "GMT+hh:mm" */
} ScrTzState;

static SCR_TL ScrTzState scr_tz_state;

/* The local UTC offset (seconds) and tm_isdst at an epoch second. */
static bool scr_tz_offset_at(double sec, double *offset, bool *isdst) {
  struct tm tmv;
  if (!scr_date_localtime(sec, &tmv)) return false;
  double local =
    scr_days_from_civil((long long)tmv.tm_year + 1900, tmv.tm_mon + 1, tmv.tm_mday) * 86400.0 +
    tmv.tm_hour * 3600.0 + tmv.tm_min * 60.0 + tmv.tm_sec;
  *offset = local - sec;
  *isdst = tmv.tm_isdst > 0;
  return true;
}

/* ICU's isValidOlsonID: letters and punctuation up to an optional run of at
 * most two digits ending the string ("GMT+11"), or one of the four POSIX
 * zone IDs tzdata also names. */
static bool scr_tz_valid_id(const char *id) {
  size_t i = 0;
  while (id[i] && !(id[i] >= '0' && id[i] <= '9') && id[i] != ',') i++;
  size_t max = i + 2;
  while (id[i] && id[i] >= '0' && id[i] <= '9' && i < max) i++;
  if (id[i] == 0) return true;
  for (size_t k = 0; k < 4; k++) {
    if (!strcmp(id, scr_tz_posix_ids[k])) return true;
  }
  return false;
}

static const char *scr_tz_skip_prefix(const char *id) {
  return !strncmp(id, scr_tz_prefixes[0], 6) || !strncmp(id, scr_tz_prefixes[1], 6) ? id + 6 : id;
}

static const ScrTzNames *scr_tz_find(const char *id) {
  size_t lo = 0, hi = SCR_TZ_ROWS;
  while (lo < hi) {
    size_t mid = lo + (hi - lo) / 2;
    int c = strcmp(id, scr_tz_ids + scr_tz_names[mid].id);
    if (c == 0) return &scr_tz_names[mid];
    if (c < 0) hi = mid;
    else lo = mid + 1;
  }
  return NULL;
}

#if !defined(_WIN32) && !defined(__wasi__)

/* The bytes of a file, or NULL. */
static char *scr_tz_read_file(const char *path, size_t *len) {
  FILE *f = fopen(path, "rb");
  if (!f) return NULL;
  size_t cap = 4096, n = 0;
  char *data = malloc(cap);
  while (data) {
    n += fread(data + n, 1, cap - n, f);
    if (n < cap) break;
    char *grown = realloc(data, cap * 2);
    if (!grown) {
      free(data);
      data = NULL;
      break;
    }
    data = grown;
    cap *= 2;
  }
  fclose(f);
  *len = n;
  return data;
}

static bool scr_tz_same_file(const char *path, const char *data, size_t len) {
  struct stat st;
  if (stat(path, &st) != 0 || !S_ISREG(st.st_mode) || (size_t)st.st_size != len) return false;
  size_t other_len;
  char *other = scr_tz_read_file(path, &other_len);
  bool same = other && other_len == len && memcmp(other, data, len) == 0;
  free(other);
  return same;
}

/* ICU's search for a zoneinfo file with /etc/localtime's contents, in
 * directory order, skipping "posixrules" and "localtime". Writes the
 * path below the zoneinfo directory into `out`. */
static bool scr_tz_search(char *dir, size_t dir_len, const char *data, size_t len, char *out, size_t cap) {
  DIR *d = opendir(dir);
  if (!d) return false;
  bool found = false;
  struct dirent *entry;
  while (!found && (entry = readdir(d)) != NULL) {
    const char *name = entry->d_name;
    bool skipped = false;
    for (size_t k = 0; k < 4; k++) skipped = skipped || !strcmp(name, scr_tz_skipped[k]);
    if (skipped) continue;
    size_t name_len = strlen(name);
    if (dir_len + name_len + 2 > PATH_MAX) continue;
    memcpy(dir + dir_len, name, name_len + 1);
    DIR *sub = opendir(dir);
    if (sub) {
      closedir(sub);
      dir[dir_len + name_len] = '/';
      dir[dir_len + name_len + 1] = 0;
      found = scr_tz_search(dir, dir_len + name_len + 1, data, len, out, cap);
    } else if (scr_tz_same_file(dir, data, len)) {
      const char *id = scr_tz_skip_prefix(dir + strlen(scr_tz_zoneinfo_dir));
      size_t id_len = strlen(id);
      if (id_len < cap) {
        memcpy(out, id, id_len + 1);
        found = true;
      }
    }
    dir[dir_len] = 0;
  }
  closedir(d);
  return found;
}
#endif

/* The host zone's row, or NULL when ICU would not find a zone name. */
static const ScrTzNames *scr_tz_detect(void) {
#if defined(__wasi__)
  /* WASI's libc keeps every local time in UTC. */
  return scr_tz_find(scr_tz_utc);
#else
  const char *tz = getenv(scr_tz_env_name);
  if (tz && scr_tz_valid_id(tz)) {
    if (tz[0] == ':') tz++;
    return scr_tz_find(scr_tz_skip_prefix(tz));
  }
#ifdef _WIN32
  return NULL;
#else
  /* The zone ID is the path below a zoneinfo directory of the
   * /etc/localtime symlink's target, or of a zoneinfo file with the same
   * contents when /etc/localtime is a regular file. */
  char path[PATH_MAX];
  if (realpath(scr_tz_localtime_path, path) && strcmp(path, scr_tz_localtime_path) != 0) {
    const char *tail = strstr(path, scr_tz_zoneinfo_tail);
    if (tail) {
      tail = scr_tz_skip_prefix(tail + strlen(scr_tz_zoneinfo_tail));
      if (scr_tz_valid_id(tail)) return scr_tz_find(tail);
    }
  } else {
    size_t len;
    DIR *zoneinfo = opendir(scr_tz_zoneinfo_dir);
    char *data = zoneinfo ? scr_tz_read_file(scr_tz_localtime_path, &len) : NULL;
    if (zoneinfo) closedir(zoneinfo);
    if (data) {
      char dir[PATH_MAX];
      memcpy(dir, scr_tz_zoneinfo_dir, sizeof scr_tz_zoneinfo_dir);
      char id[PATH_MAX];
      bool found = scr_tz_search(dir, strlen(dir), data, len, id, sizeof id);
      free(data);
      if (found && scr_tz_valid_id(id)) return scr_tz_find(id);
    }
  }
  /* Otherwise the standard-time abbreviation names the zone ("UTC" when
   * there is no /etc/localtime). */
  tzset();
  return scr_tz_find(tzname[0]);
#endif
#endif
}

static ScrTzState *scr_tz_current(void) {
  ScrTzState *s = &scr_tz_state;
  unsigned generation = scr_date_tz_generation;
  if (s->generation != generation || !s->resolved) {
    s->generation = generation;
    s->row = scr_tz_detect();
    s->resolved = true;
    s->fallback_ready = false;
  }
  return s;
}

/* "GMT+hh:mm" for the zone's current standard offset: the name Node prints
 * for a zone ID it does not know. */
static const char *scr_tz_fallback(ScrTzState *s) {
  if (!s->fallback_ready) {
    double offset = 0;
    bool isdst = false;
    long long seconds = 0;
    if (scr_tz_offset_at((double)time(NULL), &offset, &isdst)) seconds = (long long)offset - (isdst ? 3600 : 0);
    long long minutes = (seconds < 0 ? -seconds : seconds) / 60;
    snprintf(s->fallback, sizeof s->fallback, scr_tz_fallback_format, seconds < 0 ? '-' : '+',
             minutes / 60, minutes % 60);
    s->fallback_ready = true;
  }
  return s->fallback;
}

/* V8's EquivalentTime: the same month, day and time of day in a year
 * between 2008 and 2037 with the same leap-year status and weekday of
 * January 1. */
static double scr_tz_equivalent_time(double ms) {
  ScrDateParts p;
  scr_date_utc_parts_unchecked(ms, &p);
  double within = ms - floor(ms / 86400000.0) * 86400000.0;
  long long year = p.year;
  bool leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
  long long week_day = ((long long)scr_days_from_civil(year, 1, 1) + 4) % 7;
  if (week_day < 0) week_day += 7;
  long long recent = (leap ? 1956 : 1967) + (week_day * 12) % 28;
  long long equivalent = 2008 + (recent + 3 * 28 - 2008) % 28;
  return (scr_days_from_civil(equivalent, p.month + 1, 1) + p.date - 1) * 86400000.0 + within;
}

static bool scr_tz_is_daylight(double ms, int isdst_hint, const ScrTzNames *row) {
  /* V8 names instants in [0, 2^31 - 1] seconds directly. */
  if (ms < 0 || (long long)ms > 2147483647000LL) {
    ms = scr_tz_equivalent_time(ms);
    isdst_hint = -1;
  }
  double sec = floor(ms / 1000.0);
  if (row->change_count > 0) {
    /* Daylight time after an odd number of changes. */
    const int32_t *changes = scr_tz_daylight_changes + row->first_change;
    size_t lo = 0, hi = row->change_count;
    while (lo < hi) {
      size_t mid = lo + (hi - lo) / 2;
      if (changes[mid] <= sec) lo = mid + 1;
      else hi = mid;
    }
    return (lo & 1) != 0;
  }
  if (isdst_hint >= 0) return isdst_hint != 0;
  double offset;
  bool isdst;
  return scr_tz_offset_at(sec, &offset, &isdst) && isdst;
}

const char *scr_date_zone_name(double ms, int isdst) {
  ScrTzState *s = scr_tz_current();
  if (!s->row) return scr_tz_fallback(s);
  bool daylight = scr_tz_is_daylight(ms, isdst, s->row);
  return scr_tz_name_text + (daylight ? s->row->daylight : s->row->standard);
}

/* Date.prototype.toString, toDateString and toTimeString: V8's formats over
 * the local calendar fields ("Sat Oct 18 2026 09:12:00 GMT-0500 (Central
 * Daylight Time)"), with years before 1 as "-0001", and "Invalid Date" for
 * an invalid date. */
enum { SCR_DATE_TEXT_FULL, SCR_DATE_TEXT_DATE, SCR_DATE_TEXT_TIME };

/* `value` (>= 0) in decimal, zero-padded to `width` digits. */
static char *scr_date_put_digits(char *p, long long value, int width) {
  char digits[24];
  int n = 0;
  do {
    digits[n++] = (char)('0' + value % 10);
    value /= 10;
  } while (value > 0);
  while (n < width) digits[n++] = '0';
  while (n > 0) *p++ = digits[--n];
  return p;
}

static ScrStr *scr_date_text(double ms, int mode) {
  static const char week_days[7][3] = { "Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat" };
  static const char months[12][3] = { "Jan", "Feb", "Mar", "Apr", "May", "Jun",
                                      "Jul", "Aug", "Sep", "Oct", "Nov", "Dec" };
  ScrDateParts p;
  if (!scr_date_local_parts(ms, &p)) return scr_str_new(scr_date_invalid_text, sizeof scr_date_invalid_text - 1);
  char buf[160];
  char *o = buf;
  if (mode != SCR_DATE_TEXT_TIME) {
    memcpy(o, week_days[p.day], 3);
    o[3] = ' ';
    memcpy(o + 4, months[p.month], 3);
    o[7] = ' ';
    o = scr_date_put_digits(o + 8, p.date, 2);
    *o++ = ' ';
    /* "%04d", or "%05d" (a sign and four digits) before year 0. */
    if (p.year < 0) *o++ = '-';
    o = scr_date_put_digits(o, p.year < 0 ? -p.year : p.year, 4);
  }
  if (mode == SCR_DATE_TEXT_FULL) *o++ = ' ';
  if (mode != SCR_DATE_TEXT_DATE) {
    int offset = -(int)p.timezone_offset;
    int magnitude = offset < 0 ? -offset : offset;
    o = scr_date_put_digits(o, p.hours, 2);
    *o++ = ':';
    o = scr_date_put_digits(o, p.minutes, 2);
    *o++ = ':';
    o = scr_date_put_digits(o, p.seconds, 2);
    *o++ = ' ';
    *o++ = 'G';
    *o++ = 'M';
    *o++ = 'T';
    *o++ = offset < 0 ? '-' : '+';
    o = scr_date_put_digits(o, magnitude / 60, 2);
    o = scr_date_put_digits(o, magnitude % 60, 2);
    *o++ = ' ';
    *o++ = '(';
    /* Zone names are at most 64 bytes (scr_timezone_data.h). */
    /* The name's daylight flag is decided at the instant itself, as V8's
     * LocalTimezone does, not from the offset cache. */
    const char *zone = scr_date_zone_name(ms, -1);
    size_t zone_len = strlen(zone);
    memcpy(o, zone, zone_len);
    o += zone_len;
    *o++ = ')';
  }
  return scr_str_new(buf, (size_t)(o - buf));
}

ScrStr *scr_date_to_string(double ms) { return scr_date_text(ms, SCR_DATE_TEXT_FULL); }

/* JSON.stringify of a Date object: its toJSON(), the quoted
 * toISOString() text, or null for an invalid date. */
void scr_jb_put_date(ScrJsonBuf *b, const ScrDate *date) {
  if (isnan(date->ms)) {
    scr_jb_puts(b, "null");
    return;
  }
  ScrStr *iso = scr_date_to_iso(date->ms);
  scr_jb_put_json_str(b, iso);
  scr_str_release(iso);
}

/* String(date) of a Date object: Date arrays' default ordering key. +1. */
ScrStr *scr_date_object_to_string(void *date) {
  return scr_date_text(((ScrDate *)date)->ms, SCR_DATE_TEXT_FULL);
}

/* Array.prototype.join over Date objects: each element's String() text,
 * holes empty. Both borrowed; +1. */
ScrStr *scr_date_arr_join(ScrArr *dates, const ScrStr *sep) {
  ScrJsonBuf b;
  scr_jb_init(&b);
  double len = scr_arr_len(dates);
  for (double i = 0; i < len; i++) {
    if (i > 0) scr_jb_put_str(&b, sep);
    if (scr_arr_state(dates, i) != 1) continue;
    ScrStr *text = scr_date_object_to_string(scr_arr_peek_ref(dates, i));
    scr_jb_put_str(&b, text);
    scr_str_release(text);
  }
  return scr_jb_finish(&b);
}
ScrStr *scr_date_to_date_string(double ms) { return scr_date_text(ms, SCR_DATE_TEXT_DATE); }
ScrStr *scr_date_to_time_string(double ms) { return scr_date_text(ms, SCR_DATE_TEXT_TIME); }

/* ── Number statics ────────────────────────────────────────────────────
 * JS-exact: the ES2015 Number statics never coerce (unlike the global
 * isNaN/isFinite), and the compiler routes only number-typed arguments
 * here, so plain C predicates are the whole story. */

bool scr_num_is_finite(double x) { return isfinite(x) != 0; }

/* Number.prototype.toExponential() with fractionDigits UNDEFINED — the
 * spec's "as many digits as necessary": the shortest correctly-rounded
 * mantissa that round-trips, formatted d[.ddd]e±X with no zero-padding of
 * the exponent ("7e+0", "1.5e-7"). NaN → "NaN", ±Infinity → its text,
 * ±0 → "0e+0" (the spec's x = +0 arm — the sign of -0 is dropped because
 * -0 < 0 is false). Verified differentially against Node. */
ScrStr *scr_num_to_exponential(double x) {
  if (isnan(x)) return scr_str_new("NaN", 3);
  if (isinf(x)) return x < 0 ? scr_str_new("-Infinity", 9) : scr_str_new("Infinity", 8);
  if (x == 0) return scr_str_new("0e+0", 4);
  char buf[64];
  int len = 0;
  for (int prec = 0; prec <= 17; prec++) {
    len = snprintf(buf, sizeof buf, "%.*e", prec, x);
    if (strtod(buf, NULL) == x) break;
  }
  /* Normalize C's exponent ("e+05" / "e-123") to JS's ("e+5"/"e-123"):
   * drop leading zeros after the sign, keeping at least one digit. */
  char out[64];
  int o = 0;
  const char *e = memchr(buf, 'e', (size_t)len);
  const char *p = buf;
  while (p < e) out[o++] = *p++;
  out[o++] = 'e';
  p++; /* past 'e' */
  out[o++] = *p++; /* the sign — %e always emits one */
  while (*p == '0' && p[1] >= '0' && p[1] <= '9') p++;
  while (p < buf + len) out[o++] = *p++;
  return scr_str_new(out, (size_t)o);
}

/* Number.prototype.toFixed() with fractionDigits UNDEFINED (= 0 digits) —
 * the spec's pick of the integer n closest to x with ties toward the
 * LARGER n on the magnitude ((2.5).toFixed() = "3", (-2.5).toFixed() =
 * "-3" — printf's half-even would answer "2"), the "-0" result for
 * negative fractions rounding to zero, and ToString fallback at
 * |x| ≥ 1e21 (NaN and ±Infinity ride that arm's texts via ToString too,
 * matching the spec's early answers). */
ScrStr *scr_num_to_fixed0(double x) {
  if (isnan(x)) return scr_str_new("NaN", 3);
  if (fabs(x) >= 1e21) return scr_f64_to_scrstr(x);
  double a = fabs(x);
  double fl = floor(a);
  double n = (a - fl >= 0.5) ? fl + 1 : fl; /* exact: a < 2^70, and below
                                             * 2^52 the fraction is exact;
                                             * at/above it a - fl == 0 */
  ScrStr *digits = scr_f64_to_scrstr(n); /* n < 1e21 → never exponent form */
  if (!(x < 0)) return digits;
  size_t len = digits->len;
  char buf[64];
  buf[0] = '-';
  memcpy(buf + 1, digits->data, len);
  ScrStr *r = scr_str_new(buf, len + 1);
  scr_str_release(digits);
  return r;
}

/* Number.prototype.toFixed(fractionDigits), with the argument already
 * number-typed by the frontend. ToIntegerOrInfinity validation precedes
 * the receiver's non-finite arm, as ECMA-262 requires. Invalid precision
 * raises V8's catchable RangeError text; otherwise the result is +1. The
 * exact-binary-value digits come from scr_f64_to_fixed (scr_number.c). */
/* Number.prototype.toString(radix) with a number radix, which
 * ToIntegerOrInfinity truncates (NaN to 0). Radix digit generation follows
 * V8's DoubleToRadixStringView algorithm. Copyright 2012 the V8 project
 * authors. BSD license in ../vendor/v8-number-radix/LICENSE. The decimal
 * path retains Ryū. */
ScrStr *scr_num_to_string_radix_f64(double value, double requested) {
  requested = isnan(requested) ? 0 : trunc(requested);
  if (requested < 2 || requested > 36 || !isfinite(requested)) {
    static const char message[] = "toString() radix argument must be between 2 and 36";
    scr_throw_error_msg(SCR_ERR_RANGE, message, sizeof message - 1);
    return NULL;
  }
  int radix = (int)requested;
  if (radix == 10 || !isfinite(value) || value == 0) return scr_f64_to_scrstr(value);
  static const char digits[] = "0123456789abcdefghijklmnopqrstuvwxyz";
  char buffer[2200];
  const size_t middle = sizeof buffer / 2;
  size_t begin = middle, end = middle;
  bool negative = value < 0;
  value = fabs(value);
  double integer = floor(value), fraction = value - integer;
  double tolerance = 0.5 * (nextafter(value, INFINITY) - value);
  if (tolerance <= 0) tolerance = nextafter(0, INFINITY);
  if (fraction >= tolerance) {
    buffer[end++] = '.';
    do {
      fraction *= radix;
      tolerance *= radix;
      int digit = (int)fraction;
      buffer[end++] = digits[digit];
      fraction -= digit;
      if ((fraction > 0.5 || (fraction == 0.5 && (digit & 1))) && fraction + tolerance > 1) {
        for (;;) {
          end--;
          if (end == middle) { integer += 1; break; }
          char last = buffer[end];
          digit = last > '9' ? last - 'a' + 10 : last - '0';
          if (digit + 1 < radix) { buffer[end++] = digits[digit + 1]; break; }
        }
        break;
      }
    } while (fraction >= tolerance);
  }
  /* V8's Double::Exponent is the unbiased exponent minus 52. Beyond
   * that precision boundary, trailing digits are unrepresented zeros. */
  while (integer / radix >= 0x1p53) {
    integer /= radix;
    buffer[--begin] = '0';
  }
  do {
    double remainder = fmod(integer, radix);
    buffer[--begin] = digits[(int)remainder];
    integer = (integer - remainder) / radix;
  } while (integer > 0);
  if (negative) buffer[--begin] = '-';
  return scr_str_new(buffer + begin, end - begin);
}

ScrStr *scr_num_to_fixed(double x, double fraction_digits) {
  double fd = isnan(fraction_digits) ? 0 : trunc(fraction_digits);
  if (!(fd >= 0 && fd <= 100)) {
    static const char msg[] =
        "toFixed() digits argument must be between 0 and 100";
    scr_throw_error_msg(SCR_ERR_RANGE, msg, sizeof msg - 1);
    return NULL;
  }
  if (!isfinite(x) || fabs(x) >= 1e21) return scr_f64_to_scrstr(x);
  char out[128];
  size_t len = scr_f64_to_fixed(x, (int)fd, out);
  return scr_str_new(out, len);
}

/* String.prototype.substr (Annex B.2.2.1) over substring's UTF-16
 * clamp: -Infinity and other starts below -size clamp to 0, an Infinity
 * length to the end. Comparisons only (no floating-point literal other
 * than zero, which would join the constant pool every binary links).
 * Nothing on an existing path calls this. */
ScrStr *scr_str_substr(ScrStr *s, double start, double length, bool has_length) {
  double size = scr_str_utf16_len(s);
  double first = isnan(start) ? 0 : trunc(start);
  if (first < 0) {
    first = size + first;
    if (first < 0) first = 0;
  } else if (first > size) {
    first = size;
  }
  double count = has_length ? (isnan(length) ? 0 : trunc(length)) : size;
  if (count < 0) count = 0;
  double end = first + count;
  if (end > size) end = size;
  return scr_str_substring(s, first, end);
}

/* The exponent suffix of toPrecision/toExponential: "e+5", "e-7". */
static size_t scr_num_exp_suffix(char *o, int e) {
  size_t n = 0;
  o[n++] = 'e';
  o[n++] = e < 0 ? '-' : '+';
  int a = e < 0 ? -e : e;
  char rev[8];
  int k = 0;
  do {
    rev[k++] = (char)('0' + a % 10);
    a /= 10;
  } while (a != 0);
  while (k > 0) o[n++] = rev[--k];
  return n;
}

/* Number.prototype.toPrecision(precision) (ECMA-262 §21.1.3.5): undefined
 * precision is ToString(x); ToIntegerOrInfinity runs (in the caller's
 * coercion) before the non-finite arm, which precedes the 1..100 range
 * check. Digits are the exact-value, ties-up n of
 * scr_f64_precision_digits; exponential form when e < -6 or e >= p.
 * Nothing on an existing path calls this. */
ScrStr *scr_num_to_precision(double x, double precision, bool has_precision) {
  if (!has_precision || !isfinite(x)) return scr_f64_to_scrstr(x);
  double p = isnan(precision) ? 0 : trunc(precision);
  if (!(p >= 1 && p <= 100)) {
    static const char msg[] = "toPrecision() argument must be between 1 and 100";
    scr_throw_error_msg(SCR_ERR_RANGE, msg, sizeof msg - 1);
    return NULL;
  }
  int digits_count = (int)p;
  char out[160];
  size_t o = 0;
  double a = x;
  if (x < 0) {
    out[o++] = '-';
    a = -x;
  }
  char d[104];
  int e = 0;
  if (a == 0) {
    memset(d, '0', (size_t)digits_count);
    d[digits_count] = '\0';
  } else {
    scr_f64_precision_digits(a, digits_count, d, &e);
  }
  if (e < -6 || e >= digits_count) {
    out[o++] = d[0];
    if (digits_count != 1) {
      out[o++] = '.';
      memcpy(out + o, d + 1, (size_t)(digits_count - 1));
      o += (size_t)(digits_count - 1);
    }
    o += scr_num_exp_suffix(out + o, e);
  } else if (e >= 0) {
    memcpy(out + o, d, (size_t)(e + 1));
    o += (size_t)(e + 1);
    if (e + 1 < digits_count) {
      out[o++] = '.';
      memcpy(out + o, d + e + 1, (size_t)(digits_count - e - 1));
      o += (size_t)(digits_count - e - 1);
    }
  } else {
    out[o++] = '0';
    out[o++] = '.';
    for (int i = 0; i < -(e + 1); i++) out[o++] = '0';
    memcpy(out + o, d, (size_t)digits_count);
    o += (size_t)digits_count;
  }
  return scr_str_new(out, o);
}

/* Number.prototype.toExponential(fractionDigits) with a DEFINED argument
 * (the undefined form is scr_num_to_exponential's shortest mantissa):
 * f + 1 exact-value, ties-up digits, "d.ddde±X". Nothing on an existing
 * path calls this. */
ScrStr *scr_num_to_exponential_digits(double x, double fraction_digits) {
  if (!isfinite(x)) return scr_f64_to_scrstr(x);
  double f = isnan(fraction_digits) ? 0 : trunc(fraction_digits);
  if (!(f >= 0 && f <= 100)) {
    static const char msg[] = "toExponential() argument must be between 0 and 100";
    scr_throw_error_msg(SCR_ERR_RANGE, msg, sizeof msg - 1);
    return NULL;
  }
  int count = (int)f + 1;
  char out[160];
  size_t o = 0;
  double a = x;
  if (x < 0) {
    out[o++] = '-';
    a = -x;
  }
  char d[104];
  int e = 0;
  if (a == 0) {
    memset(d, '0', (size_t)count);
    d[count] = '\0';
  } else {
    scr_f64_precision_digits(a, count, d, &e);
  }
  out[o++] = d[0];
  if (count != 1) {
    out[o++] = '.';
    memcpy(out + o, d + 1, (size_t)(count - 1));
    o += (size_t)(count - 1);
  }
  o += scr_num_exp_suffix(out + o, e);
  return scr_str_new(out, o);
}

/* Increment a decimal digit string in place. Returns true on overflow —
 * the value becomes 1 followed by len zeros (the caller folds the zeros
 * into its scale); an EMPTY string increments to "1" the same way (the
 * round-up-from-nothing case: 0.0005 at 3 fraction digits). */
static bool scr_dec_inc(char *d, int len) {
  for (int i = len - 1; i >= 0; i--) {
    if (d[i] != '9') {
      d[i]++;
      return false;
    }
    d[i] = '0';
  }
  d[0] = '1';
  return true;
}

/* Intl.NumberFormat("en-US").format(x) / x.toLocaleString("en-US") with
 * DEFAULT options: decimal notation, minimum 0 / maximum 3 fraction
 * digits, "," grouping every three integer digits, "∞"/"NaN" texts, and
 * "-0" whenever the input is negative or negative zero even after
 * rounding to zero. Rounding is half-up ON THE SHORTEST ROUND-TRIPPING
 * DECIMAL — ICU's rounding input, probed against Node: format(1.0005) is
 * "1.001" although the double is 1.000499... and toFixed(3) answers
 * "1.000"; format(1e23) prints the shortest form's trailing zeros, not
 * the double's exact expansion. The en-US/latn symbols (",", ".", "∞",
 * "NaN", group size 3) are the whole embedded locale surface. Verified
 * differentially against Node. Result +1; never throws. */
ScrStr *scr_intl_num_format_en_us(double x) {
  if (isnan(x)) return scr_str_new("NaN", 3);
  if (isinf(x)) {
    return x < 0 ? scr_str_new("-\xE2\x88\x9E", 4) : scr_str_new("\xE2\x88\x9E", 3);
  }
  bool neg = signbit(x) != 0;
  if (x == 0) return neg ? scr_str_new("-0", 2) : scr_str_new("0", 1);
  double a = neg ? -x : x;

  /* Shortest digits: value = 0.d × 10^n (no trailing zeros, k ≤ 17). */
  char d[18];
  int n;
  int k = scr_f64_digits(a, d, &n);

  /* Round at 3 fraction digits: fraction position p is digit index
   * n+p-1, so index n+3 is the first DROPPED digit. Half-up on the
   * decimal digits — the shortest string ends right after them, so
   * "first dropped digit ≥ 5" IS the whole decision. */
  int keep = n + 3;
  if (keep < k) {
    bool up = keep >= 0 && d[keep] >= '5';
    k = keep < 0 ? 0 : keep;
    if (up && scr_dec_inc(d, k)) {
      /* Carried out (all nines, or the round-up-from-nothing 0.0005
       * case): one leading 1, the dropped nines fold into the scale. */
      k = 1;
      n += 1;
    } else if (k == 0) {
      /* Everything rounded away: ±0 with the sign preserved. */
      return neg ? scr_str_new("-0", 2) : scr_str_new("0", 1);
    }
  }

  /* Assemble: integer digits (indices [0, n)), zero-padded past k, then
   * the ≤ 3 fraction digits (indices n..n+2, '0' outside [0, k)) with
   * trailing zeros trimmed, then commas every three integer digits. */
  char frac[3];
  int flen = 0;
  for (int p = 1; p <= 3; p++) {
    int idx = n + p - 1;
    frac[flen++] = (idx >= 0 && idx < k) ? d[idx] : '0';
  }
  while (flen > 0 && frac[flen - 1] == '0') flen--;

  char out[512];
  int o = 0;
  if (neg) out[o++] = '-';
  if (n <= 0) {
    out[o++] = '0';
  } else {
    for (int i = 0; i < n; i++) {
      if (i > 0 && (n - i) % 3 == 0) out[o++] = ',';
      out[o++] = (i < k) ? d[i] : '0';
    }
  }
  if (flen > 0) {
    out[o++] = '.';
    memcpy(out + o, frac, (size_t)flen);
    o += flen;
  }
  return scr_str_new(out, (size_t)o);
}

bool scr_num_is_nan(double x) { return isnan(x) != 0; }

bool scr_num_is_integer(double x) { return isfinite(x) && trunc(x) == x; }

bool scr_num_is_safe_integer(double x) {
  return isfinite(x) && trunc(x) == x && fabs(x) <= 9007199254740991.0;
}

/* ── checked catch-binding cast (`e as C`) ────────────────────────────
 * The caught analog of the dyn boundary's checked casts: an OBJ payload
 * inside the class's preorder interval extracts (retained, +1); every
 * other payload throws a catchable TypeError naming the class. Node's
 * `as` is erasure — the runtime check is the documented trust-but-verify
 * stance for dynamic values, extended to exception payloads. */
void *scr_caught_check_obj(const ScrCaught *c, size_t pre, size_t post,
                            const char *cls) {
  if (scr_caught_instanceof(c, pre, post)) return c->retain_fn(c->payload);
  char msg[160];
  int len = snprintf(msg, sizeof msg,
                     "caught value is not an instance of %s (checked cast)",
                     cls);
  scr_throw_error_msg(SCR_ERR_TYPE, msg, (size_t)len);
  return NULL; /* callers are compiler-emitted pending checks */
}

/* ── Set → array drain ([...set]) ─────────────────────────────────────
 * The live entries in insertion order (tombstones skipped — the forEach
 * walk folded into one call; no user code runs mid-drain, so the
 * live-iteration rules are moot). Borrows the set; the array is +1,
 * string elements retained into it by the iter_key read. */
static bool scr_set_to_arr_sparse(const ScrMap *s, ScrArr *out) {
  if (out->cap >= s->nlive) return false;
  /* scr_arr_new reserves dense storage for the live count; keep the
   * ordinary append path in case an allocation ever declines it. */
  for (size_t i = 0; i < s->nentries; i++) {
    if (!scr_map_entry_live(s, i)) continue;
    if (out->elem == SCR_ELEM_F64) scr_arr_push_f64(out, scr_map_iter_key_f64(s, (double)i));
    else if (out->elem == SCR_ELEM_BOOL) scr_arr_push_bool(out, scr_map_iter_key_bool(s, (double)i));
    else if (out->elem == SCR_ELEM_STR) scr_arr_push_ref(out, scr_map_iter_key_str(s, (double)i));
    else scr_arr_push_ref(out, scr_map_iter_key_ref(s, (double)i));
  }
  return true;
}

ScrArr *scr_set_to_arr_f64(const ScrMap *s) {
  ScrArr *out = scr_arr_new(SCR_ELEM_F64, s->nlive);
  if (scr_set_to_arr_sparse(s, out)) return out;
  /* A fresh array without states: the values in order. */
  for (size_t i = 0; i < s->nentries; i++) {
    if (!scr_map_entry_live(s, i)) continue;
    out->data[out->len++] = scr_map_entry_at(s, i)->key;
  }
  scr_arr_refill(out);
  return out;
}

ScrArr *scr_set_to_arr_bool(const ScrMap *s) {
  ScrArr *out = scr_arr_new(SCR_ELEM_BOOL, s->nlive);
  if (scr_set_to_arr_sparse(s, out)) return out;
  /* A fresh array without states: the values in order. */
  for (size_t i = 0; i < s->nentries; i++) {
    if (!scr_map_entry_live(s, i)) continue;
    scr_arr_dense_put(out, out->len++, scr_map_entry_at(s, i)->key != 0);
  }
  scr_arr_refill(out);
  return out;
}

ScrArr *scr_set_to_arr_str(const ScrMap *s) {
  ScrArr *out = scr_arr_new(SCR_ELEM_STR, s->nlive);
  if (scr_set_to_arr_sparse(s, out)) return out;
  /* A fresh array without states: the values in order. */
  for (size_t i = 0; i < s->nentries; i++) {
    if (!scr_map_entry_live(s, i)) continue;
    scr_str_retain((ScrStr *)(uintptr_t)scr_map_entry_at(s, i)->key);
    out->data[out->len++] = scr_map_entry_at(s, i)->key;
  }
  scr_arr_refill(out);
  return out;
}

ScrArr *scr_set_to_arr_ref(const ScrMap *s, const ScrArrOps *ops) {
  ScrArr *out = scr_arr_new_ops(ops, s->nlive);
  if (scr_set_to_arr_sparse(s, out)) return out;
  /* A fresh array without states: the values in order. */
  for (size_t i = 0; i < s->nentries; i++) {
    if (!scr_map_entry_live(s, i)) continue;
    ops->retain((void *)(uintptr_t)scr_map_entry_at(s, i)->key);
    scr_arr_dense_put(out, out->len, scr_map_entry_at(s, i)->key);
    out->len++;
  }
  scr_arr_refill(out);
  return out;
}

/* A Date object: one time value, and its identity. Compiled code and
 * checked-dynamic Date handles share these objects, so a Date keeps its
 * identity across `unknown` conversions. */
ScrDate *scr_date_new(double ms) {
  ScrDate *date = malloc(sizeof *date);
  if (!date) scr_trap("scriptc: out of memory\n");
  date->rc = 1;
  date->ms = ms;
  return date;
}

ScrDate *scr_date_retain(ScrDate *date) {
  if (date->rc != SIZE_MAX) date->rc++;
  return date;
}

void scr_date_release(ScrDate *date) {
  if (!date || date->rc == SIZE_MAX) return;
  if (--date->rc == 0) free(date);
}

void *scr_date_retain_v(void *p) { return scr_date_retain(p); }
void scr_date_release_v(void *p) { scr_date_release(p); }

bool scr_dyn_native_date_is(const ScrDyn *value) {
  return value && value->kind == SCR_DYN_HANDLE && value->v.handle.tag == SCR_DYNH_DATE;
}

/* Instances of program classes declared `extends Date` keep their time
 * value in a compiled field. In checked-dynamic code such an instance is a
 * typed reference, and the runtime reaches its time value and methods
 * through the functions %main installs (builtins/date-classes.ts), called
 * as (op, value, argument): for op 0 the time function answers the time
 * value, or undefined for any other value, and for op 1 sets it; for ops 2
 * to 5 the method function calls the instance's toISOString,
 * toJSON(argument), toString and valueOf. */
enum {
  SCR_DATE_CLASS_TIME,
  SCR_DATE_CLASS_SET_TIME,
  SCR_DATE_CLASS_TO_ISO_STRING,
  SCR_DATE_CLASS_TO_JSON,
  SCR_DATE_CLASS_TO_STRING,
  SCR_DATE_CLASS_VALUE_OF,
  SCR_DATE_CLASS_NAME,
};
static SCR_TL ScrDyn *scr_date_class_operation;
static SCR_TL ScrDyn *scr_date_class_methods;

static void scr_date_class_operation_cleanup(void) {
  ScrDyn *operation = scr_date_class_operation;
  ScrDyn *methods = scr_date_class_methods;
  scr_date_class_operation = scr_date_class_methods = NULL;
  scr_dyn_release(operation);
  scr_dyn_release(methods);
}

static bool scr_date_class_time_of(const ScrDyn *value, double *time);
static ScrDyn *scr_date_class_to_json(const ScrDyn *value, const ScrDyn *key);
static ScrDyn *scr_date_class_to_string(const ScrDyn *value);
static ScrDyn *scr_date_class_value_of(const ScrDyn *value);
static ScrStr *scr_date_class_name(const ScrDyn *value);
static ScrDyn *scr_date_class_method(const ScrDyn *value, const char *key, size_t key_len);

/* The installation also publishes these functions to the rest of the
 * runtime (scr_date_class_hooks), so only a program that declares a class
 * extending Date links them. */
static const ScrDateClassHooks scr_date_class_hook_table = {
  scr_date_class_time_of, scr_date_class_to_json, scr_date_class_to_string,
  scr_date_class_value_of, scr_date_class_name, scr_date_class_method,
};

void scr_date_class_operation_install(ScrDyn *time, ScrDyn *methods) {
  scr_date_class_hooks = &scr_date_class_hook_table;
  if (!scr_date_class_operation) scr_atexit(scr_date_class_operation_cleanup);
  scr_dyn_release(scr_date_class_operation);
  scr_dyn_release(scr_date_class_methods);
  scr_date_class_operation = scr_dyn_retain(time);
  scr_date_class_methods = scr_dyn_retain(methods);
}

/* The installed operation `op` on `value`: +1, or NULL with an exception
 * pending. */
static ScrDyn *scr_date_class_call(int op, const ScrDyn *value, const ScrDyn *argument) {
  ScrDyn *code = scr_dyn_new_num(op);
  ScrDyn *args[] = { code, (ScrDyn *)value, (ScrDyn *)(argument ? argument : scr_dyn_undefined()) };
  bool time = op < SCR_DATE_CLASS_TO_ISO_STRING || op == SCR_DATE_CLASS_NAME;
  ScrDyn *result = scr_dyn_call(time ? scr_date_class_operation : scr_date_class_methods, args, 3, "Date");
  scr_dyn_release(code);
  return result;
}

/* True, with the time value in *time, when `value` holds an instance of a
 * class declared `extends Date`. */
static bool scr_date_class_time_of(const ScrDyn *value, double *time) {
  if (!scr_date_class_operation || !value || value->kind != SCR_DYN_TYPED_REF) return false;
  ScrDyn *result = scr_date_class_call(SCR_DATE_CLASS_TIME, value, NULL);
  bool found = result && result->kind == SCR_DYN_NUM;
  if (found) *time = result->v.num;
  scr_dyn_release(result);
  return found;
}

/* `value instanceof Date`: a Date, or an instance of a class declared
 * `extends Date`. */
bool scr_dyn_date_instance_is(const ScrDyn *value) {
  double time;
  return scr_dyn_native_date_is(value) || scr_dyn_date_class_time(value, &time);
}

/* toJSON(key), toString() or valueOf() of an instance of a class declared
 * `extends Date` (scr_dyn_date_class_time answered true): the class's
 * declaration or the Date method. +1, or NULL with an exception pending. */
static ScrDyn *scr_date_class_to_json(const ScrDyn *value, const ScrDyn *key) {
  return scr_date_class_call(SCR_DATE_CLASS_TO_JSON, value, key);
}
static ScrDyn *scr_date_class_to_string(const ScrDyn *value) {
  return scr_date_class_call(SCR_DATE_CLASS_TO_STRING, value, NULL);
}
static ScrDyn *scr_date_class_value_of(const ScrDyn *value) {
  return scr_date_class_call(SCR_DATE_CLASS_VALUE_OF, value, NULL);
}

/* The name of the class of an instance of a class declared `extends
 * Date`: +1, or NULL for any other value. */
static ScrStr *scr_date_class_name(const ScrDyn *value) {
  if (!scr_date_class_operation || !value || value->kind != SCR_DYN_TYPED_REF) return NULL;
  ScrDyn *result = scr_date_class_call(SCR_DATE_CLASS_NAME, value, NULL);
  ScrStr *name = result && result->kind == SCR_DYN_STR ? scr_str_retain(result->v.str) : NULL;
  scr_dyn_release(result);
  return name;
}

double scr_dyn_native_date_value(const ScrDyn *value) {
  if (scr_dyn_native_date_is(value)) return ((ScrDate *)value->v.handle.ptr)->ms;
  double time;
  if (scr_dyn_date_class_time(value, &time)) return time;
  scr_dyn_check_fail(NULL, "Date", value);
  return NAN;
}

/* The Date object a checked-dynamic Date value holds, +1: the Date itself,
 * or a new Date with the time value of an instance of a class declared
 * `extends Date`. NULL with the check failure pending for any other
 * value. */
ScrDate *scr_dyn_native_date_check(const ScrDyn *value, const ScrDynPath *path) {
  if (scr_dyn_native_date_is(value)) return scr_date_retain(value->v.handle.ptr);
  double time;
  if (scr_dyn_date_class_time(value, &time)) return scr_date_new(time);
  scr_dyn_check_fail(path, "Date", value);
  return NULL;
}

/* Method names without another use in this file, in named arrays (see
 * scr_tz_posix_ids). */
static const char scr_date_to_date_string_name[] = "toDateString";
static const char scr_date_to_time_string_name[] = "toTimeString";

static ScrDyn *scr_native_date_invoke(void *ptr, ScrDyn *self, const char *method,
    ScrDyn *const *args, size_t argc, const char *what) {
  (void)self; (void)what;
  double ms = ((ScrDate *)ptr)->ms;
  if (!strcmp(method, "getTime") || !strcmp(method, "valueOf")) return scr_dyn_new_num(ms);
  if (!strcmp(method, "toString") || !strcmp(method, scr_date_to_date_string_name) ||
      !strcmp(method, scr_date_to_time_string_name) || !strcmp(method, "toUTCString")) {
    ScrStr *text = !strcmp(method, "toString")                     ? scr_date_to_string(ms)
                   : !strcmp(method, scr_date_to_date_string_name) ? scr_date_to_date_string(ms)
                   : !strcmp(method, "toUTCString")                ? scr_date_to_utc_string(ms)
                                                                   : scr_date_to_time_string(ms);
    ScrDyn *result = scr_dyn_new_str(text);
    scr_str_release(text);
    return result;
  }
  if (!strcmp(method, "toISOString") || !strcmp(method, "toJSON")) {
    if (!strcmp(method, "toJSON") && !isfinite(ms)) return scr_dyn_new_null();
    ScrStr *text = scr_date_to_iso(ms);
    if (!text) return NULL;
    ScrDyn *result = scr_dyn_new_str(text);
    scr_str_release(text);
    return result;
  }
  if (!strcmp(method, "setTime")) {
    double time = NAN;
    if (argc > 0 && !scr_dyn_number_coerce_js(args[0], &time)) return NULL;
    ((ScrDate *)ptr)->ms = scr_date_new_ms(time);
    return scr_dyn_new_num(((ScrDate *)ptr)->ms);
  }
#define DATE_GET(name, fn) if (!strcmp(method, name)) return scr_dyn_new_num(fn(ms))
  DATE_GET("getFullYear", scr_date_get_full_year_local);
  DATE_GET("getUTCFullYear", scr_date_get_full_year_utc);
  DATE_GET("getMonth", scr_date_get_month_local);
  DATE_GET("getUTCMonth", scr_date_get_month_utc);
  DATE_GET("getDate", scr_date_get_date_local);
  DATE_GET("getUTCDate", scr_date_get_date_utc);
  DATE_GET("getDay", scr_date_get_day_local);
  DATE_GET("getUTCDay", scr_date_get_day_utc);
  DATE_GET("getHours", scr_date_get_hours_local);
  DATE_GET("getUTCHours", scr_date_get_hours_utc);
  DATE_GET("getMinutes", scr_date_get_minutes_local);
  DATE_GET("getUTCMinutes", scr_date_get_minutes_utc);
  DATE_GET("getSeconds", scr_date_get_seconds_local);
  DATE_GET("getUTCSeconds", scr_date_get_seconds_utc);
  DATE_GET("getMilliseconds", scr_date_get_milliseconds);
  DATE_GET("getUTCMilliseconds", scr_date_get_milliseconds);
  DATE_GET("getTimezoneOffset", scr_date_get_timezone_offset);
#undef DATE_GET
  static const char message[] = "Native Date method has no lowering";
  scr_throw_error_msg_code(SCR_ERR_ERROR, message, sizeof message - 1, "SC2020");
  return NULL;
}

ScrDyn *scr_dyn_native_date_new(const ScrDyn *arguments) {
  double ms;
  if (arguments->v.arr.len == 0) ms = scr_date_mock_now ? *scr_date_mock_now : scr_date_now();
  else {
    ScrDyn *value = arguments->v.arr.items[0];
    if (scr_dyn_native_date_is(value)) ms = scr_dyn_native_date_value(value);
    else if (scr_dyn_date_class_time(value, &ms)) {
    } else if (value->kind == SCR_DYN_STR) ms = scr_date_parse_get_time(value->v.str);
    else if (!scr_dyn_number_coerce_js(value, &ms)) return NULL;
    ms = scr_date_new_ms(ms);
  }
  return scr_dyn_native_date_from_ms(ms);
}

/* The time value `new Date(...arguments)` constructs (super(...) in a
 * class declared `extends Date`), or NaN with an exception pending. */
double scr_dyn_date_arguments_time(const ScrDyn *arguments) {
  ScrDyn *date = arguments->v.arr.len > 1 ? scr_dyn_native_date_new_fields(arguments)
                                          : scr_dyn_native_date_new_value(arguments);
  if (!date) return NAN;
  double time = ((ScrDate *)date->v.handle.ptr)->ms;
  scr_dyn_release(date);
  return time;
}

/* new Date(value) in JavaScript: a string parses with the full parser;
 * every other value takes scr_dyn_native_date_new. */
ScrDyn *scr_dyn_native_date_new_value(const ScrDyn *arguments) {
  if (arguments->v.arr.len == 1 && arguments->v.arr.items[0]->kind == SCR_DYN_STR)
    return scr_dyn_native_date_from_ms(scr_date_new_ms(scr_date_parse(arguments->v.arr.items[0]->v.str)));
  return scr_dyn_native_date_new(arguments);
}

/* new Date(year, monthIndex, ...) in JavaScript: ToNumber over the first
 * seven arguments in order (a throwing conversion stops there), the
 * spec's defaults for the rest, then the local-time field constructor. */
ScrDyn *scr_dyn_native_date_new_fields(const ScrDyn *arguments) {
  double fields[7];
  fields[0] = fields[1] = fields[3] = fields[4] = fields[5] = fields[6] = 0;
  fields[2] = 1;
  size_t n = arguments->v.arr.len < 7 ? arguments->v.arr.len : 7;
  for (size_t i = 0; i < n; i++) {
    if (!scr_dyn_number_coerce_js(arguments->v.arr.items[i], &fields[i])) return NULL;
  }
  return scr_dyn_native_date_from_ms(
    scr_date_new_local(fields[0], fields[1], fields[2], fields[3], fields[4], fields[5], fields[6]));
}

/* The Date.prototype methods scr_native_date_invoke answers. */
static const char *const scr_native_date_methods[] = {
  "getTime", "valueOf", "toISOString", "toJSON", "toString", scr_date_to_date_string_name,
  scr_date_to_time_string_name, "toUTCString",
  "getFullYear", "getUTCFullYear", "getMonth",
  "getUTCMonth", "getDate", "getUTCDate", "getDay", "getUTCDay", "getHours", "getUTCHours",
  "getMinutes", "getUTCMinutes", "getSeconds", "getUTCSeconds", "getMilliseconds",
  "getUTCMilliseconds", "getTimezoneOffset", "setTime",
};
#define SCR_NATIVE_DATE_METHODS (sizeof scr_native_date_methods / sizeof scr_native_date_methods[0])
static SCR_TL ScrDyn *scr_native_date_method_values[SCR_NATIVE_DATE_METHODS];
static SCR_TL bool scr_native_date_methods_registered;

static void scr_native_date_methods_cleanup(void) {
  for (size_t i = 0; i < SCR_NATIVE_DATE_METHODS; i++) {
    ScrDyn *function = scr_native_date_method_values[i];
    scr_native_date_method_values[i] = NULL;
    scr_dyn_release(function);
  }
}

/* A Date method read as a value and called later: the closure's function
 * slot holds the method's name, and the receiver must be a Date. On an
 * instance of a class declared `extends Date` the method runs over its
 * time value; toJSON calls the instance's toISOString. */
static ScrDyn *scr_native_date_method_call(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  const char *method = closure->fn;
  ScrDyn *self = scr_dyn_this_get();
  ScrDyn *result = NULL;
  double time;
  if (scr_dyn_native_date_is(self)) {
    result = scr_native_date_invoke(self->v.handle.ptr, self, method, args, argc, method);
  } else if (scr_dyn_date_class_time(self, &time)) {
    if (!strcmp(method, "toJSON")) {
      result = isfinite(time) ? scr_date_class_call(SCR_DATE_CLASS_TO_ISO_STRING, self, NULL)
                              : scr_dyn_new_null();
    } else {
      ScrDate date = { 1, time };
      result = scr_native_date_invoke(&date, self, method, args, argc, method);
      if (result && date.ms != time && !(isnan(date.ms) && isnan(time))) {
        ScrDyn *stored = scr_dyn_new_num(date.ms);
        ScrDyn *set = scr_date_class_call(SCR_DATE_CLASS_SET_TIME, self, stored);
        scr_dyn_release(stored);
        if (!set) {
          scr_dyn_release(result);
          result = NULL;
        }
        scr_dyn_release(set);
      }
    }
  } else {
    static const char message[] = "this is not a Date object.";
    scr_throw_error_msg(SCR_ERR_TYPE, message, sizeof message - 1);
  }
  scr_dyn_release(self);
  return result;
}

static ScrDyn *scr_native_date_get(void *ptr, const char *key, size_t key_len);

/* The Date method `key` as a function value when `value` holds an instance
 * of a class declared `extends Date`, or NULL. The class's own members are
 * read first, by the caller. */
static ScrDyn *scr_date_class_method(const ScrDyn *value, const char *key, size_t key_len) {
  if (!scr_date_class_operation) return NULL;
  bool named = false;
  for (size_t i = 0; i < SCR_NATIVE_DATE_METHODS && !named; i++)
    named = strlen(scr_native_date_methods[i]) == key_len && !memcmp(scr_native_date_methods[i], key, key_len);
  double time;
  if (!named || !scr_dyn_date_class_time(value, &time)) return NULL;
  return scr_native_date_get(NULL, key, key_len);
}

/* Property reads of a Date: its methods as function values, one per name
 * and thread, and NULL (undefined) for other names. */
static ScrDyn *scr_native_date_get(void *ptr, const char *key, size_t key_len) {
  (void)ptr;
  for (size_t i = 0; i < SCR_NATIVE_DATE_METHODS; i++) {
    const char *name = scr_native_date_methods[i];
    if (strlen(name) != key_len || memcmp(name, key, key_len) != 0) continue;
    if (!scr_native_date_methods_registered) {
      scr_native_date_methods_registered = true;
      scr_atexit(scr_native_date_methods_cleanup);
    }
    if (!scr_native_date_method_values[i]) {
      scr_native_date_method_values[i] = scr_dyn_new_func(
          scr_closure_new((void *)name, 0), scr_native_date_method_call, 0, "native:Date", name);
    }
    return scr_dyn_retain(scr_native_date_method_values[i]);
  }
  return NULL;
}

/* A checked-dynamic handle for the Date object `date` (borrowed; the
 * handle retains it), so the value stays the same object. */
ScrDyn *scr_dyn_native_date(ScrDate *date) {
  static const ScrDynHandleOps ops = {
    "Date", &scr_date_retain_v, &scr_date_release_v, &scr_native_date_invoke,
    &scr_native_date_get, NULL, NULL, NULL,
  };
  scr_dyn_handle_install(SCR_DYNH_DATE, &ops);
  return scr_dyn_new_handle(date, SCR_DYNH_DATE);
}

/* A Date handle holding the time value `ms` (already TimeClip'd). */
ScrDyn *scr_dyn_native_date_from_ms(double ms) {
  ScrDate *date = scr_date_new(ms);
  ScrDyn *result = scr_dyn_native_date(date);
  scr_date_release(date);
  return result;
}

/* crypto.getRandomValues(typedArray) (WebCrypto, also node:crypto's
 * export): integer typed arrays only (Node's TypeMismatchError DOMException
 * for float arrays, DataViews and every other value), at most 65536 bytes
 * (QuotaExceededError), filled in place and returned. Nothing on an
 * existing path calls these. They stay at the end of the unit: clang emits
 * a static helper (scr_random_write) where its first emitted caller
 * appears, and an earlier caller would move it in every binary that links
 * the random fills. */
ScrBytes *scr_crypto_get_random_values(ScrBytes *view) {
  static const char mismatch[] = "TypeMismatchError";
  static const char mismatch_msg[] = "The data argument must be an integer-type TypedArray";
  static const char quota[] = "QuotaExceededError";
  static const char quota_msg[] = "The requested length exceeds 65,536 bytes";
  if (view->is_data_view || view->elem == SCR_BYTES_F32 || view->elem == SCR_BYTES_F64 ||
      view->elem == SCR_BYTES_F16) {
    scr_throw_domex(mismatch, mismatch_msg);
    return NULL;
  }
  /* Integer arithmetic: a new floating-point literal would land in the
   * merged constant pool every binary links. */
  size_t length = view->len * (size_t)scr_bytes_elem_size(view->elem);
  if (length > 65536u) {
    scr_throw_domex(quota, quota_msg);
    return NULL;
  }
  scr_random_write(view, 0, length);
  return scr_bytes_retain(view);
}

ScrDyn *scr_crypto_get_random_values_dyn(ScrDyn *value) {
  if (value->kind == SCR_DYN_TYPED_REF) {
    ScrDyn *materialized = scr_dyn_typed_ref_materialize(value);
    if (!materialized) return NULL;
    ScrDyn *result = scr_crypto_get_random_values_dyn(materialized);
    scr_dyn_release(materialized);
    return result ? scr_dyn_retain(value) : NULL;
  }
  if (value->kind != SCR_DYN_BYTES) {
    static const char mismatch[] = "TypeMismatchError";
    static const char mismatch_msg[] = "The data argument must be an integer-type TypedArray";
    scr_throw_domex(mismatch, mismatch_msg);
    return NULL;
  }
  ScrBytes *filled = scr_crypto_get_random_values(value->v.bytes);
  if (!filled) return NULL;
  scr_bytes_release(filled);
  return scr_dyn_retain(value);
}
