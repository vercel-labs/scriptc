/* child_process — the synchronous slice: spawnSync as posix_spawnp +
 * piped utf8 capture + waitpid.
 *
 * Node parity notes (SEMANTICS.md has the user-facing story):
 * - The command PATH-searches like Node's (posix_spawnp; a command
 *   containing '/' spawns directly). No shell, ever.
 * - stdin is /dev/null (Node's spawnSync default reads nothing without
 *   `input`); stdout/stderr are captured to strings, utf8 assumed — the
 *   compiler fences every other encoding.
 * - `status` is the exit code; a child killed by a signal has NO status
 *   (has_status = false → the compiler's `number | null` union takes the
 *   null arm), exactly Node's status: null there.
 * - Spawn FAILURE (nonexistent binary, EACCES) never throws: Node reports
 *   it through the result's `error` property, which this surface does not
 *   carry — status is null and both outputs are "" (Node types them null;
 *   divergence documented).
 * - No zombies: every successfully spawned child is waitpid()ed before
 *   this function returns, unconditionally.
 */
#include "scr_runtime.h"

#ifdef _WIN32
/* ── Windows arm: real children via CreateProcessW ────────────────────
 * The POSIX arm below is untouched; this arm reimplements the exported
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
 * - stdio is HANDLE inheritance: anonymous pipes for capture and the
 *   child.stdout/stderr streams (PeekNamedPipe polls readiness —
 *   anonymous pipes cannot overlap), NUL for ignore, duplicated std
 *   handles for inherit, _get_osfhandle for the fd form, PIPE_NOWAIT on
 *   the input pipe's write end so the sync feed never blocks.
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
 * - execSync's shell is lowered as /bin/sh at compile time, which
 *   resolves ENOENT here where Windows Node would run cmd.exe — the
 *   documented shell fence until a cmd.exe story exists (SEMANTICS).
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
 * reverse-scan escape are libuv's, byte-for-byte — Windows Node builds
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
  size_t n = (size_t)scr_arr_len(args);
  size_t argc = n + 1;
  WCHAR **wargs = malloc(argc * sizeof(WCHAR *));
  if (!wargs) scr_child_oom();
  wargs[0] = scr_child_wide(cmd->data, cmd->len);
  for (size_t i = 0; i < n; i++) {
    ScrStr *s = (ScrStr *)scr_arr_get_ref(args, (double)i);
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

static void scr_win_create_process(ScrStr *cmd, ScrArr *args, ScrWinSpawn *sp) {
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
  WCHAR *file_w = scr_child_wide(cmd->data, cmd->len);
  WCHAR *app = scr_search_path(file_w, cwd_w, path_w);
  if (app == NULL) {
    sp->errname = "ENOENT";
    free(file_w);
    free(path_w);
    free(env_block);
    free(cwd_w);
    return;
  }
  WCHAR *cmdline = scr_child_cmdline(cmd, args);

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

/* One drain pass over a capture pipe: everything PeekNamedPipe reports,
 * chunk by chunk. EOF (every writer closed — ERROR_BROKEN_PIPE) closes
 * the handle and flips *open_. Returns true when anything changed. */
static bool scr_win_cap_pump(HANDLE h, ScrCapBuf *b, bool *open_) {
  bool progress = false;
  for (;;) {
    DWORD avail = 0;
    if (!PeekNamedPipe(h, NULL, 0, NULL, &avail, NULL)) {
      CloseHandle(h);
      *open_ = false;
      return true;
    }
    if (avail == 0) return progress;
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
    progress = true;
  }
}

/* ── the synchronous run core ────────────────────────────────────────── */

typedef struct {
  const char *spawn_errname; /* NULL = the child ran (and was reaped) */
  bool timed_out;            /* the deadline TerminateProcess fired */
  DWORD exit_code;
  ScrCapBuf out, err; /* always initialized; caller frees */
} ScrWinSyncRes;

/* in_mode: 0 = NUL (Node's no-input default; an `input` string swaps in
 * a fed pipe), 2 = inherit. out/err_mode: 0 = capture, 1 = NUL, 2 =
 * inherit. timeout_ms > 0 arms the deadline: TerminateProcess(h, 1) —
 * libuv's kill emulation; the caller reports the killSignal's name. */
static void scr_win_run_sync(ScrStr *cmd, ScrArr *args, const ScrStr *input,
                             int in_mode, int out_mode, int err_mode,
                             const ScrStr *cwd, ScrArr *env_pairs,
                             double timeout_ms, ScrWinSyncRes *res) {
  res->spawn_errname = NULL;
  res->timed_out = false;
  res->exit_code = 0;
  scr_cap_init(&res->out);
  scr_cap_init(&res->err);

  if (in_mode == 2 || out_mode == 2 || err_mode == 2) {
    /* Inherited stdio: flush the parent's buffers first so earlier logs
     * precede the child's writes (Node's practical ordering). */
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
  scr_win_create_process(cmd, args, &sp);
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

  /* Pump: drain both captures, feed stdin (PIPE_NOWAIT — a full pipe
   * writes short, never blocks), watch the deadline. The 1ms wait rides
   * the process handle so an exit ends the sleep immediately; pipes keep
   * draining after exit until every writer's copy closes (a grandchild
   * may hold one — the POSIX arm's discipline). */
  bool out_open = out_parent != NULL, err_open = err_parent != NULL;
  bool in_open = in_parent != NULL;
  size_t in_at = 0;
  bool exited = false;
  double deadline = timeout_ms > 0 ? scr_now_ms() + timeout_ms : 0;
  for (;;) {
    bool progress = false;
    if (out_open) progress |= scr_win_cap_pump(out_parent, &res->out, &out_open);
    if (err_open) progress |= scr_win_cap_pump(err_parent, &res->err, &err_open);
    if (in_open) {
      /* Small chunks: PIPE_NOWAIT's partial-write behavior is only
       * dependable for writes no larger than the pipe buffer. */
      DWORD want = input->len - in_at > 2048 ? 2048 : (DWORD)(input->len - in_at);
      DWORD wrote = 0;
      if (want == 0) {
        CloseHandle(in_parent);
        in_open = false;
      } else if (WriteFile(in_parent, input->data + in_at, want, &wrote, NULL)) {
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
    if (deadline > 0 && !res->timed_out && scr_now_ms() >= deadline) {
      res->timed_out = true;
      (void)TerminateProcess(sp.proc, 1); /* killed children exit 1 (uv) */
    }
    if (!exited) {
      exited = WaitForSingleObject(sp.proc, progress ? 0 : 1) == WAIT_OBJECT_0;
    } else if (!progress) {
      Sleep(1);
    }
    if (exited && !out_open && !err_open) break;
  }
  if (in_open) CloseHandle(in_parent);
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
  r->cmd = NULL;
  r->signal_name = NULL;
  return r;
}

/* Kept for the header's contract (the POSIX arms share it); no Windows
 * caller — CreateProcessW takes the quoted command LINE instead. */
char **scr_child_argv(ScrStr *cmd, ScrArr *args) {
  size_t n = (size_t)scr_arr_len(args);
  char **argv = malloc((n + 2) * sizeof(char *));
  if (!argv) scr_child_oom();
  argv[0] = cmd->data;
  for (size_t i = 0; i < n; i++) {
    ScrStr *s = (ScrStr *)scr_arr_get_ref(args, (double)i);
    argv[i + 1] = s->data;
    scr_str_release(s); /* borrow: the array's reference keeps it alive */
  }
  argv[n + 1] = NULL;
  return argv;
}

/* ── spawnSync ───────────────────────────────────────────────────────── */

static ScrSpawnRes *scr_spawn_sync_core(ScrStr *cmd, ScrArr *args, double timeout_ms,
                                        int killsig, int in_mode, int out_mode,
                                        int err_mode) {
  ScrWinSyncRes w;
  scr_win_run_sync(cmd, args, NULL, in_mode, out_mode, err_mode, NULL, NULL,
                   timeout_ms, &w);
  if (w.spawn_errname != NULL) {
    free(w.out.data);
    free(w.err.data);
    ScrSpawnRes *r = scr_spawn_res_new(false, 0, scr_str_new("", 0), scr_str_new("", 0));
    r->spawn_errname = w.spawn_errname;
    r->cmd = scr_str_retain(cmd);
    return r;
  }
  ScrStr *out_s = scr_str_new(w.out.data, w.out.len);
  ScrStr *err_s = scr_str_new(w.err.data, w.err.len);
  free(w.out.data);
  free(w.err.data);
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
  return r;
}

ScrSpawnRes *scr_spawn_sync(ScrStr *cmd, ScrArr *args) {
  return scr_spawn_sync_core(cmd, args, 0, SIGTERM, 0, 0, 0);
}

ScrSpawnRes *scr_spawn_sync_opts(ScrStr *cmd, ScrArr *args, double timeout_ms,
                                 ScrStr *killsignal, double in_mode,
                                 double out_mode, double err_mode) {
  int killsig = SIGTERM;
  if (killsignal->len > 0) {
    int resolved = scr_signal_from_name(killsignal);
    if (resolved > 0) killsig = resolved;
  }
  return scr_spawn_sync_core(cmd, args, timeout_ms, killsig, (int)in_mode,
                             (int)out_mode, (int)err_mode);
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

static void scr_exec_throw_failed(const char *display, const ScrCapBuf *err_cap,
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
  scr_throw_error_msg(SCR_ERR_ERROR, msg, at);
  free(msg);
}

static void scr_exec_throw_spawn(ScrStr *cmd, const char *errname, bool async_shape) {
  size_t cap = 10 + cmd->len + 1 + strlen(errname) + 1;
  char *msg = malloc(cap);
  if (!msg) scr_child_oom();
  int len = snprintf(msg, cap, "%s %s %s", async_shape ? "spawn" : "spawnSync",
                     cmd->data, errname);
  scr_throw_error_msg_code(SCR_ERR_ERROR, msg, (size_t)len, errname);
  free(msg);
}

/* The shared exec body (sync + promisified shapes — the POSIX arm's
 * scr_exec_sync_core semantics over the win run core). */
static ScrStr *scr_exec_run(ScrStr *cmd, ScrArr *args, bool shell,
                            const ScrStr *input, const ScrStr *cwd,
                            ScrArr *env_pairs, double timeout_ms,
                            int stdout_mode, int stderr_mode, bool async_shape,
                            ScrStr **stderr_out) {
  /* stdio "inherit"'s stdin rides bit 4 of stdout_mode (scr_runtime.h). */
  bool stdin_inherit = (stdout_mode & 4) != 0;
  stdout_mode &= 3;
  bool cap_out = stdout_mode == 1;
  bool cap_err = stderr_mode == 0 || stderr_mode == 1;
  ScrWinSyncRes w;
  scr_win_run_sync(cmd, args, input, stdin_inherit ? 2 : 0,
                   cap_out ? 0 : (stdout_mode == 2 ? 2 : 1),
                   cap_err ? 0 : (stderr_mode == 3 ? 2 : 1), cwd,
                   env_pairs, timeout_ms, &w);
  if (w.spawn_errname != NULL) {
    free(w.out.data);
    free(w.err.data);
    scr_exec_throw_spawn(cmd, w.spawn_errname, async_shape);
    return NULL;
  }
  if (w.timed_out && !async_shape) {
    /* The SYNC forms throw Node's spawnSync ETIMEDOUT; the async shape
     * reports the kill's exit-1 death as an ordinary command failure
     * below, exactly Node's promisified execFile. */
    free(w.out.data);
    free(w.err.data);
    scr_exec_throw_spawn(cmd, "ETIMEDOUT", false);
    return NULL;
  }
  bool failed = w.exit_code != 0;
  /* Node's inheritStderr: no stdio option given → the captured stderr
   * echoes to the parent's stderr AFTER completion, success or failure. */
  if (stderr_mode == 0 && w.err.len > 0) {
    fflush(stdout);
    fwrite(w.err.data, 1, w.err.len, stderr);
  }
  if (failed) {
    char *display = scr_exec_display(cmd, args, shell);
    scr_exec_throw_failed(display, &w.err, cap_err, async_shape);
    free(display);
    free(w.out.data);
    free(w.err.data);
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
                      double timeout_ms, double stdout_mode, double stderr_mode) {
  return scr_exec_run(cmd, args, shell, has_input ? input : NULL,
                      cwd->len > 0 ? cwd : NULL, has_env ? env_pairs : NULL,
                      timeout_ms, (int)stdout_mode, (int)stderr_mode, false, NULL);
}

ScrSpawnRes *scr_exec_capture(ScrStr *cmd, ScrArr *args, ScrStr *cwd,
                              bool has_env, ScrArr *env_pairs, double timeout_ms) {
  ScrStr *err_s = NULL;
  ScrStr *out_s = scr_exec_run(cmd, args, false, NULL, cwd->len > 0 ? cwd : NULL,
                               has_env ? env_pairs : NULL, timeout_ms, 1, 1,
                               true, &err_s);
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
  ScrChildStreamDataL *data_ls;
  size_t n_data, cap_data;
  ScrChildStreamEndL *end_ls;
  size_t n_end, cap_end;
  struct ScrChildStream *next; /* the service registry (+1) */
};

static ScrChildStream *scr_child_streams = NULL;
static size_t scr_child_streams_watching = 0;

struct ScrChild {
  size_t rc;
  HANDLE proc; /* NULL after the reap (or spawn failure) */
  DWORD pid;
  ScrChildState state;
  bool settled;
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
  ScrChildErrEntry *err_cbs;
  size_t n_err, cap_err;
  ScrChildStream *out_stream;
  ScrChildStream *err_stream;
  struct ScrChild *next; /* the pending registry */
};

static ScrChild *scr_children = NULL;
static size_t scr_children_reffed_n = 0;
/* Pending children the handle wait can NOT represent — spawn failures
 * awaiting their first-pass settle. While any exist, scr_children_wait
 * declines and the loop keeps the ~1ms polling cap (the POSIX arm's
 * unwatched fallback, exactly). */
static size_t scr_children_unwatched = 0;

static void scr_child_drop_listeners(ScrChild *c) {
  for (size_t i = 0; i < c->n_exit; i++) scr_closure_release(c->exit_cbs[i].cb);
  for (size_t i = 0; i < c->n_err; i++) scr_closure_release(c->err_cbs[i].cb);
  free(c->exit_cbs);
  free(c->err_cbs);
  c->exit_cbs = NULL;
  c->err_cbs = NULL;
  c->n_exit = c->n_err = c->cap_exit = c->cap_err = 0;
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
    scr_child_stream_release(c->out_stream);
    scr_child_stream_release(c->err_stream);
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
    if (s->h != NULL) CloseHandle(s->h);
    free(s);
  }
}

void *scr_child_stream_retain_v(void *p) { return scr_child_stream_retain((ScrChildStream *)p); }
void scr_child_stream_release_v(void *p) { scr_child_stream_release((ScrChildStream *)p); }

/* True while the stream has a consumer and can still deliver. */
static bool scr_child_stream_watching(const ScrChildStream *s) {
  return !s->eof && s->h != NULL && s->n_data > 0;
}

/* A fresh piped stream over the pipe's read end, registered with the
 * service registry (+1). NULL = the never-opened husk a degraded pipe
 * slot hands out (eof from birth, never registered). */
static ScrChildStream *scr_child_stream_new(HANDLE h) {
  ScrChildStream *s = calloc(1, sizeof *s);
  if (!s) scr_child_oom();
  s->rc = 1;
  s->h = h;
  if (h == NULL) {
    s->eof = true;
    return s;
  }
  s->next = scr_child_streams;
  scr_child_streams = scr_child_stream_retain(s);
  return s;
}

static void scr_child_stream_finish(ScrChildStream *s, bool fire_end) {
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
static bool scr_child_stream_pump(ScrChildStream *s) {
  while (scr_child_stream_watching(s)) {
    DWORD avail = 0;
    if (!PeekNamedPipe(s->h, NULL, 0, NULL, &avail, NULL)) return true;
    if (avail == 0) return false;
    if (avail > 65536) avail = 65536;
    char buf[65536];
    DWORD got = 0;
    if (!ReadFile(s->h, buf, avail, &got, NULL) || got == 0) return true;
    ScrBytes *chunk = scr_bytes_new(SCR_BYTES_U8, (double)got);
    memcpy(chunk->data, buf, (size_t)got);
    size_t nd = s->n_data;
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
            if (s->n_data == 0) scr_child_streams_watching--;
            break;
          }
        }
      }
      if (!scr_exc_pending()) snap[i].fn(snap[i].cb, chunk);
      scr_closure_release(snap[i].cb);
    }
    free(snap);
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
  if (s->eof || s->h == NULL) {
    scr_closure_release(cb);
    return;
  }
  if (s->n_data == s->cap_data) {
    s->cap_data = s->cap_data ? s->cap_data * 2 : 2;
    s->data_ls = realloc(s->data_ls, s->cap_data * sizeof *s->data_ls);
    if (!s->data_ls) scr_child_oom();
  }
  s->data_ls[s->n_data].cb = cb;
  s->data_ls[s->n_data].fn = fn;
  s->data_ls[s->n_data].once = once;
  s->n_data++;
  if (s->n_data == 1) scr_child_streams_watching++;
}

void scr_child_stream_on_end(ScrChildStream *s, ScrClosure *cb /*moves*/, bool once) {
  (void)once; /* 'end' fires at most once; the flag changes nothing */
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

/* ── spawn ───────────────────────────────────────────────────────────── */

ScrChild *scr_spawn(ScrStr *cmd, ScrArr *args) {
  return scr_spawn_opts(cmd, args, 0, 0, 0, 0, 0, false, false, NULL, NULL);
}

/* PER-SLOT stdio modes (the POSIX arm's numbering): in 0 = ignore (NUL),
 * 1 = inherit; out/err 0 = ignore, 1 = inherit, 2 = fd, 3 = pipe. */
ScrChild *scr_spawn_opts(ScrStr *cmd, ScrArr *args, double in_mode,
                         double out_mode, double err_mode, double out_fd,
                         double err_fd, bool detached, bool has_env,
                         ScrArr *env_pairs, ScrStr *cwd) {
  if ((int)out_mode == 1 || (int)err_mode == 1 || (int)out_mode == 2 || (int)err_mode == 2) {
    fflush(stdout);
    fflush(stderr);
  }
  ScrChild *c = calloc(1, sizeof(ScrChild));
  if (!c) scr_child_oom();
  c->rc = 1;

  /* Piped slots: the pipe NOW; a pipe failure degrades the slot to NUL
   * and the stream husk answers eof (fd exhaustion — nothing real). */
  HANDLE out_parent = NULL, out_child = NULL;
  HANDLE err_parent = NULL, err_child = NULL;
  int out_m = (int)out_mode, err_m = (int)err_mode;
  if (out_m == 3 && !scr_win_pipe(&out_parent, &out_child, true)) out_m = 0;
  if (err_m == 3 && !scr_win_pipe(&err_parent, &err_child, true)) err_m = 0;

  HANDLE in_child = (int)in_mode == 1
                        ? scr_win_dup_inherit(GetStdHandle(STD_INPUT_HANDLE))
                        : NULL;
  if (in_child == NULL) in_child = scr_win_nul(false);
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
  scr_win_create_process(cmd, args, &sp);
  if (in_child != NULL) CloseHandle(in_child);
  if (out_child != NULL) CloseHandle(out_child);
  if (err_child != NULL) CloseHandle(err_child);

  /* The parent's pipe read ends become the streams regardless of the
   * spawn's outcome — a FAILED spawn keeps them with no writer at all,
   * so a consumer sees immediate EOF and 'end' fires on the turn after
   * the 'error' event, Node's exact order (the POSIX arm's stance). */
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
    scr_throw_error_msg(SCR_ERR_TYPE, msg, (size_t)len);
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
  return scr_children_reffed_n > 0 || scr_child_streams_watching > 0;
}

void scr_children_teardown(void) {
  while (scr_child_streams != NULL) {
    ScrChildStream *s = scr_child_streams;
    scr_child_streams = s->next;
    s->next = NULL;
    scr_child_stream_finish(s, false);
    scr_child_stream_release(s);
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

static const char *scr_child_err_code = NULL;

/* The errno name embedded in an errnoException-style message — the
 * POSIX arm's parser, shared story (see its comment). */
static const char *scr_err_msg_code(const ScrStr *msg) {
  static char buf[32];
  const char *sp = strchr((const char *)msg->data, ' ');
  if (sp == NULL || sp[1] != 'E') return NULL;
  const char *tok = sp + 1;
  size_t n = 1;
  while (tok[n] != '\0' && tok[n] != ' ' && tok[n] != ':') {
    char ch = tok[n];
    if (!((ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9'))) return NULL;
    if (n + 1 >= sizeof buf) return NULL;
    n++;
  }
  if (n < 3) return NULL; /* "EIO" is the shortest real name */
  memcpy(buf, tok, n);
  buf[n] = '\0';
  return buf;
}

void scr_child_err_thunk_error(ScrClosure *cb, ScrStr *msg) {
  ScrError *e = scr_error_new(0 /* Error */, msg);
  if (scr_child_err_code != NULL) {
    scr_error_set_code(e, scr_child_err_code);
  } else {
    const char *code = scr_err_msg_code(msg);
    if (code != NULL) scr_error_set_code(e, code);
  }
  ((void (*)(ScrClosure *, ScrError *))cb->fn)(cb, e);
}

/* ── the loop's half (called from scr_async.c) ───────────────────────── */

bool scr_children_pending(void) {
  return scr_children != NULL || scr_child_streams_watching > 0;
}

bool scr_children_failed_pending(void) {
  for (ScrChild *c = scr_children; c; c = c->next) {
    if (c->state == SCR_CHILD_SPAWN_FAILED && !c->settled) return true;
  }
  return false;
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
  if (scr_children_unwatched > 0 || scr_child_streams_watching > 0) return false;
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
static void scr_child_settle(ScrChild *c) {
  if (c->reffed) {
    c->reffed = false;
    scr_children_reffed_n--;
  }
  if (c->state == SCR_CHILD_EXITED) {
    scr_child_stream_drain_now(c->out_stream);
    if (!scr_exc_pending()) scr_child_stream_drain_now(c->err_stream);
  }
  c->settled = true;
  if (scr_exc_pending()) {
    scr_child_drop_listeners(c);
    scr_child_release(c);
    return;
  }
  if (c->state == SCR_CHILD_SPAWN_FAILED) {
    if (c->n_err == 0) {
      fflush(stdout);
      fprintf(stderr, "Unhandled 'error' event: Error: %s\n", c->err_msg->data);
      _Exit(1);
    }
    scr_child_err_code = c->spawn_errname;
    for (size_t i = 0; i < c->n_err; i++) {
      c->err_cbs[i].fn(c->err_cbs[i].cb, c->err_msg);
      if (scr_exc_pending()) break; /* the loop surfaces it */
    }
    scr_child_err_code = NULL;
  } else {
    for (size_t i = 0; i < c->n_exit; i++) {
      c->exit_cbs[i].fn(c->exit_cbs[i].cb, c->has_code, c->code, c->exit_signal);
      if (scr_exc_pending()) break;
    }
  }
  scr_child_drop_listeners(c);
  scr_child_release(c); /* the registry's reference */
}

/* One reap pass: streams service first (the pinned 'end'-before-'exit'
 * ordering), then every running child answers WaitForSingleObject(h, 0)
 * — the WNOHANG analogue; spawn failures settle on their first pass. */
void scr_children_poll(void) {
  scr_child_streams_service();
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

#else /* !_WIN32 — the POSIX implementation, untouched below */

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
  return e;
}

/* ── argv construction (shared with spawn in scr_async.c's slice) ─────── */

/* Builds a NULL-terminated argv from the command + one string[] — the
 * strings are BORROWED from their containers (alive for the whole spawn;
 * the +1 from scr_arr_get_ref is dropped immediately because the array
 * keeps its own reference). Free with free() (the vector only). */
char **scr_child_argv(ScrStr *cmd, ScrArr *args) {
  size_t n = (size_t)scr_arr_len(args);
  char **argv = malloc((n + 2) * sizeof(char *));
  if (!argv) scr_child_oom();
  argv[0] = cmd->data;
  for (size_t i = 0; i < n; i++) {
    ScrStr *s = (ScrStr *)scr_arr_get_ref(args, (double)i);
    argv[i + 1] = s->data;
    scr_str_release(s); /* borrow: the array's reference keeps it alive */
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
static ScrSpawnRes *scr_spawn_sync_core(ScrStr *cmd, ScrArr *args, double timeout_ms,
                                         int killsig, int in_mode, int out_mode,
                                         int err_mode) {
  if (out_mode == 2 || err_mode == 2) {
    /* Inherited output fds: flush the parent's buffers first so earlier
     * logs precede the child's writes (Node's practical ordering). */
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
  pid_t pid = -1;
  int spawn_err = posix_spawnp(&pid, cmd->data, &fa, NULL, argv, environ);
  posix_spawn_file_actions_destroy(&fa);
  free(argv);
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
    if (deadline > 0 && !timed_out && scr_now_ms() >= deadline) {
      timed_out = true;
      kill(pid, killsig);
    }
    if (rc == 0) continue;
    for (nfds_t i = 0; i < n; i++) {
      if (!(fds[i].revents & (POLLIN | POLLHUP | POLLERR))) continue;
      if (out_open && fds[i].fd == outfd[0]) out_open = scr_cap_read(&out, outfd[0]);
      else if (err_open && fds[i].fd == errfd[0]) err_open = scr_cap_read(&err, errfd[0]);
    }
  }
  if (cap_out) close(outfd[0]);
  if (cap_err) close(errfd[0]);

  /* Reap. With nothing captured the deadline lives here: WNOHANG-poll
   * until the child exits or the timeout kill fires (the exec core's
   * pipes-drained-daemon discipline). */
  int st = 0;
  pid_t reaped = -1;
  if (deadline > 0 && !timed_out) {
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
    }
  }
  return r;
}

ScrSpawnRes *scr_spawn_sync(ScrStr *cmd, ScrArr *args) {
  return scr_spawn_sync_core(cmd, args, 0, SIGTERM, 0, 0, 0);
}

/* The options entry (cp.spawnSyncOpts): killSignal as a NAME ("" = the
 * SIGTERM default — the compiler already validated the literal against
 * Node's table by fencing non-literals; an unknown name here falls back
 * to SIGTERM defensively), modes as doubles (the IR's scalar). */
ScrSpawnRes *scr_spawn_sync_opts(ScrStr *cmd, ScrArr *args, double timeout_ms,
                                  ScrStr *killsignal, double in_mode,
                                  double out_mode, double err_mode) {
  int killsig = SIGTERM;
  if (killsignal->len > 0) {
    int resolved = scr_signal_from_name(killsignal);
    if (resolved > 0) killsig = resolved;
  }
  return scr_spawn_sync_core(cmd, args, timeout_ms, killsig, (int)in_mode,
                              (int)out_mode, (int)err_mode);
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
 * - The thrown error carries the MESSAGE only: Node's status/stdout/
 *   stderr properties don't exist here (SEMANTICS.md — nothing the
 *   supported catch forms can read anyway).
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

/* The Command-failed thrower (message only — see the block comment).
 * always_nl is the async shape: Node's promisified execFile appends
 * "\n<stderr>" unconditionally (a trailing newline on empty stderr),
 * where the sync form appends only when stderr is non-empty. */
static void scr_exec_throw_failed(const char *display, const ScrCapBuf *err_cap,
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
  scr_throw_error_msg(SCR_ERR_ERROR, msg, at);
  free(msg);
}

/* "spawnSync <file> <ERRNAME>" — Node's uv-error message for spawn
 * failures and timeouts, with `code` = the errno name (Node's
 * errnoException shape; the Command-failed error stays code-less — Node
 * puts the exit STATUS there, in properties this surface doesn't carry). */
static void scr_exec_throw_spawn(ScrStr *cmd, const char *errname, bool async_shape) {
  size_t cap = 10 + cmd->len + 1 + strlen(errname) + 1;
  char *msg = malloc(cap);
  if (!msg) scr_child_oom();
  int len = snprintf(msg, cap, "%s %s %s", async_shape ? "spawn" : "spawnSync",
                     cmd->data, errname);
  scr_throw_error_msg_code(SCR_ERR_ERROR, msg, (size_t)len, errname);
  free(msg);
}

ScrStr *scr_exec_sync_core(ScrStr *cmd, ScrArr *args, const ScrExecOpts *o) {
  int outfd[2] = {-1, -1}, errfd[2] = {-1, -1}, infd[2] = {-1, -1};
  bool cap_out = o->stdout_mode == 1;
  bool cap_err = o->stderr_mode == 0 || o->stderr_mode == 1;
  if (o->stdout_mode == 2 || o->stderr_mode == 3) {
    /* Inherited output fds: flush the parent's buffers first so earlier
     * logs precede the child's writes (Node's practical ordering). */
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
  int spawn_err = posix_spawnp(&pid, cmd->data, &fa, NULL, argv,
                               envp != NULL ? envp : environ);
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
    scr_exec_throw_spawn(cmd, scr_errname(spawn_err), o->async_shape);
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
  bool timed_out = false;
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
    if (deadline > 0 && !timed_out && scr_now_ms() >= deadline) {
      /* Node's timeout: killSignal (SIGTERM default) to the child; the
       * capture loop keeps draining until the pipes close. */
      timed_out = true;
      kill(pid, SIGTERM);
    }
    if (rc == 0) continue;
    for (nfds_t i = 0; i < n; i++) {
      if (fds[i].revents == 0) continue;
      if (out_open && fds[i].fd == outfd[0]) {
        if (fds[i].revents & (POLLIN | POLLHUP | POLLERR)) out_open = scr_cap_read(&out, outfd[0]);
      } else if (err_open && fds[i].fd == errfd[0]) {
        if (fds[i].revents & (POLLIN | POLLHUP | POLLERR)) err_open = scr_cap_read(&err, errfd[0]);
      } else if (in_open && fds[i].fd == infd[1]) {
        if (fds[i].revents & (POLLERR | POLLHUP)) {
          close(infd[1]);
          in_open = false; /* child closed stdin early: fine, like Node */
        } else if (fds[i].revents & POLLOUT) {
          ssize_t wrote = write(infd[1], o->input->data + in_at, o->input->len - in_at);
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
  }
  if (cap_out) close(outfd[0]);
  if (cap_err) close(errfd[0]);
  if (in_open) close(infd[1]);

  /* Reap. A live deadline still applies here: a child that closed its
   * stdio but keeps running (the pipes-drained daemon shape) must still be
   * killed at the timeout, so the wait polls WNOHANG until then. */
  int st = 0;
  pid_t reaped = -1;
  if (deadline > 0 && !timed_out) {
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

  char *display = NULL;
  if (timed_out && !o->async_shape) {
    /* The SYNC forms throw Node's spawnSync ETIMEDOUT; the async shape
     * reports the SIGTERM death as an ordinary command failure below,
     * exactly Node's promisified execFile. */
    free(out.data);
    free(err.data);
    scr_exec_throw_spawn(cmd, "ETIMEDOUT", false);
    return NULL;
  }
  bool failed = !WIFEXITED(st) || WEXITSTATUS(st) != 0;
  /* Node's inheritStderr: no stdio option given → the captured stderr
   * echoes to the parent's stderr AFTER completion, success or failure. */
  if (o->stderr_mode == 0 && err.len > 0) {
    fflush(stdout);
    fwrite(err.data, 1, err.len, stderr);
  }
  if (failed) {
    display = scr_exec_display(cmd, args, o->shell);
    scr_exec_throw_failed(display, &err, cap_err, o->async_shape);
    free(display);
    free(out.data);
    free(err.data);
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
                       double timeout_ms, double stdout_mode, double stderr_mode) {
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
  };
  return scr_exec_sync_core(cmd, args, &o);
}

/* The promisified-execFile capture (cp.execCapture): the SAME exec core
 * in the async shape — both streams captured (no echo), Node's async
 * messages on the throw paths (the compiler's interned async helper turns
 * the throw into the rejection). Success answers a +1 ScrSpawnRes reusing
 * the spawnSync result container (status unused — a failure threw). */
ScrSpawnRes *scr_exec_capture(ScrStr *cmd, ScrArr *args, ScrStr *cwd,
                               bool has_env, ScrArr *env_pairs, double timeout_ms) {
  ScrStr *err_s = NULL;
  ScrExecOpts o = {
      .shell = false,
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
 * (posix_spawnp, all three stdio fds on /dev/null) and registers it with
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
  bool armed;     /* EVFILT_READ registered on the child kqueue */
  bool uncounted; /* counted into scr_children_unwatched (arm failure) */
  ScrChildStreamDataL *data_ls;
  size_t n_data, cap_data;
  ScrChildStreamEndL *end_ls;
  size_t n_end, cap_end;
  struct ScrChildStream *next; /* the service registry (+1) */
};

static ScrChildStream *scr_child_streams = NULL;
/* Streams with a live consumer (data listener, not yet EOF): the loop's
 * keep-alive and service predicate. */
static size_t scr_child_streams_watching = 0;

struct ScrChild {
  size_t rc;
  pid_t pid;
  ScrChildState state;
  bool settled;   /* terminal event delivered; listeners released */
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
  ScrChildErrEntry *err_cbs;
  size_t n_err, cap_err;
  /* Piped stdio (stdio mode 3): the stream handles child.stdout /
   * child.stderr answer — owned (+1 each), NULL when not piped. */
  ScrChildStream *out_stream;
  ScrChildStream *err_stream;
  struct ScrChild *next; /* the pending registry */
};

static ScrChild *scr_children = NULL; /* unsettled children (registry +1) */
static size_t scr_children_reffed_n = 0; /* unsettled AND reffed (liveness) */

/* Children the kqueue can NOT wake the loop for (spawn failures awaiting
 * their first-pass settle, exit-filter registration failures, every child
 * on a non-kqueue platform): while any exist, scr_children_wait refuses
 * and the loop keeps the polling cap for them. */
static size_t scr_children_unwatched = 0;

#ifdef SCR_HAVE_KQUEUE
static int scr_child_kq = -1; /* created with the first spawn; lives forever */

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
static int scr_child_ep = -1; /* created with the first spawn; lives forever */

/* pid -> pidfd, so the reap can CLOSE the pidfd (it polls readable from
 * exit until closed — kqueue's ONESHOT drop has no epoll analogue). A
 * handful of entries at the corpus's scale; linear is fine. */
typedef struct {
  pid_t pid;
  int pidfd;
} ScrChildPidfd;

static ScrChildPidfd *scr_child_pidfds = NULL;
static size_t scr_child_pidfds_n = 0, scr_child_pidfds_cap = 0;

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
 * cap instead. Events are drained and DISCARDED — they are wakeups only;
 * the WNOHANG sweep stays the single reaping mechanism. */
/* The pollable child-exit wake fd for the loop's poll(2) sleep (a kqueue
 * fd reads as ready while events are pending): valid only when the kqueue
 * can wake for EVERY pending child — same condition as scr_children_wait.
 * -1 tells the caller to keep the ~1ms reap cap instead. */
int scr_children_wake_fd(void) {
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
#ifdef SCR_HAVE_KQUEUE
  if (scr_child_kq < 0 || scr_children_unwatched > 0) return false;
  if (!(max_wait_ms > 0)) max_wait_ms = 0;
  struct timespec ts = {(time_t)(max_wait_ms / 1000.0),
                        (long)((max_wait_ms - (double)((time_t)(max_wait_ms / 1000.0)) * 1000.0) * 1e6)};
  struct kevent evs[8];
  (void)kevent(scr_child_kq, NULL, 0, evs, 8, &ts); /* EINTR: spurious pass */
  return true;
#elif defined(SCR_CHILD_HAVE_PIDFD)
  if (scr_child_ep < 0 || scr_children_unwatched > 0) return false;
  if (!(max_wait_ms > 0)) max_wait_ms = 0;
  double capped = max_wait_ms > 2147483000.0 ? 2147483000.0 : max_wait_ms;
  struct epoll_event evs[8];
  /* Events are wakeups only, discarded here exactly like the kqueue
   * drain; level-triggered pidfds stay readable until the reap closes
   * them, so nothing is lost. EINTR: a spurious pass. */
  (void)epoll_wait(scr_child_ep, evs, 8, (int)(capped + 0.999));
  return true;
#else
  (void)max_wait_ms;
  return false;
#endif
}

static void scr_child_drop_listeners(ScrChild *c) {
  for (size_t i = 0; i < c->n_exit; i++) scr_closure_release(c->exit_cbs[i].cb);
  for (size_t i = 0; i < c->n_err; i++) scr_closure_release(c->err_cbs[i].cb);
  free(c->exit_cbs);
  free(c->err_cbs);
  c->exit_cbs = NULL;
  c->err_cbs = NULL;
  c->n_exit = c->n_err = c->cap_exit = c->cap_err = 0;
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
    scr_child_stream_release(c->out_stream);
    scr_child_stream_release(c->err_stream);
    free(c);
  }
}

void *scr_child_retain_v(void *p) { return scr_child_retain((ScrChild *)p); }
void scr_child_release_v(void *p) { scr_child_release((ScrChild *)p); }

/* Node's error-code names for the spawn failures a posix_spawnp can
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
    scr_child_stream_drop_listeners(s); /* only reachable pre-'end' via leaks */
    if (s->fd >= 0) close(s->fd);
    free(s);
  }
}

void *scr_child_stream_retain_v(void *p) { return scr_child_stream_retain((ScrChildStream *)p); }
void scr_child_stream_release_v(void *p) { scr_child_stream_release((ScrChildStream *)p); }

static void scr_child_stream_dearm(ScrChildStream *s);

/* True while the stream has a consumer and can still deliver. */
static bool scr_child_stream_watching(const ScrChildStream *s) {
  return !s->eof && s->fd >= 0 && s->n_data > 0;
}

/* A fresh piped stream over the pipe's read end (nonblocking, cloexec);
 * registered with the service registry (+1). fd < 0 = the never-opened
 * husk a failed spawn hands out (eof from birth, never registered). */
static ScrChildStream *scr_child_stream_new(int fd) {
  ScrChildStream *s = calloc(1, sizeof *s);
  if (!s) scr_child_oom();
  s->rc = 1;
  s->fd = fd;
  if (fd < 0) {
    s->eof = true;
    return s;
  }
  fcntl(fd, F_SETFL, O_NONBLOCK);
  fcntl(fd, F_SETFD, FD_CLOEXEC);
  s->next = scr_child_streams;
  scr_child_streams = scr_child_stream_retain(s);
  return s;
}

/* EOF/error tail: 'end' fires over a snapshot, everything drops, the fd
 * closes (deleting its kqueue filter), and the liveness/fallback counters
 * settle. The caller unlinks from the registry and releases its ref. */
static void scr_child_stream_finish(ScrChildStream *s, bool fire_end) {
  if (scr_child_stream_watching(s)) scr_child_streams_watching--;
  if (s->uncounted) {
    s->uncounted = false;
    scr_children_unwatched--;
  }
  s->eof = true;
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
static bool scr_child_stream_pump(ScrChildStream *s) {
  while (scr_child_stream_watching(s)) {
    char buf[65536];
    ssize_t n = read(s->fd, buf, sizeof buf);
    if (n < 0) {
      if (errno == EINTR) continue;
      return errno != EAGAIN;
    }
    if (n == 0) return true;
    ScrBytes *chunk = scr_bytes_new(SCR_BYTES_U8, (double)n);
    memcpy(chunk->data, buf, (size_t)n);
    size_t nd = s->n_data;
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
            if (s->n_data == 0) {
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
      if (!scr_exc_pending()) snap[i].fn(snap[i].cb, chunk);
      scr_closure_release(snap[i].cb);
    }
    free(snap);
    scr_bytes_release(chunk);
    if (scr_exc_pending()) return false;
  }
  return false;
}

/* The registry's service walk: every watched stream pumps; EOF finishes
 * and unlinks (the children_poll unlink-before-fire pattern). */
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

/* Drops the read filter when the LAST consumer leaves (a once-listener
 * removal): a level-triggered filter over an unread pipe would otherwise
 * wake every idle sleep for data nobody consumes. */
static void scr_child_stream_dearm(ScrChildStream *s) {
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

/* Arms the level-triggered read filter for a consumer-owning stream (see
 * the design note: no EV_CLEAR — the wait's drain discards events). An
 * arm failure joins the unwatched fallback so the loop keeps the ~1ms
 * polling cap for it. */
static void scr_child_stream_arm(ScrChildStream *s) {
  if (s->armed || s->fd < 0) return;
#ifdef SCR_HAVE_KQUEUE
  if (scr_child_kq < 0) scr_child_kq = kqueue();
  if (scr_child_kq >= 0) {
    struct kevent ev;
    EV_SET(&ev, (uintptr_t)s->fd, EVFILT_READ, EV_ADD, 0, 0, NULL);
    struct timespec zero = {0, 0};
    if (kevent(scr_child_kq, &ev, 1, NULL, 0, &zero) == 0) {
      s->armed = true;
      return;
    }
  }
#elif defined(SCR_CHILD_HAVE_PIDFD)
  /* Level-triggered EPOLLIN, exactly the kqueue arm's level filter: the
   * wait's drain discards events, and level readiness keeps the epoll fd
   * readable while unread data sits in the pipe — no wakeup is lost. */
  if (scr_child_ep < 0) scr_child_ep = epoll_create1(EPOLL_CLOEXEC);
  if (scr_child_ep >= 0) {
    struct epoll_event ev = {.events = EPOLLIN, .data = {.fd = s->fd}};
    if (epoll_ctl(scr_child_ep, EPOLL_CTL_ADD, s->fd, &ev) == 0) {
      s->armed = true;
      return;
    }
  }
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
  if (s->eof || s->fd < 0) {
    scr_closure_release(cb);
    return;
  }
  if (s->n_data == s->cap_data) {
    s->cap_data = s->cap_data ? s->cap_data * 2 : 2;
    s->data_ls = realloc(s->data_ls, s->cap_data * sizeof *s->data_ls);
    if (!s->data_ls) scr_child_oom();
  }
  s->data_ls[s->n_data].cb = cb;
  s->data_ls[s->n_data].fn = fn;
  s->data_ls[s->n_data].once = once;
  s->n_data++;
  if (s->n_data == 1) {
    scr_child_streams_watching++;
    scr_child_stream_arm(s);
  }
}

/* stream.on/once("end", cb): fires once at EOF; alone it neither reads
 * nor keeps the loop alive (the stdin rule). */
void scr_child_stream_on_end(ScrChildStream *s, ScrClosure *cb /*moves*/, bool once) {
  (void)once; /* 'end' fires at most once; the flag changes nothing */
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
  return c->out_stream ? scr_child_stream_retain(c->out_stream) : NULL;
}
ScrChildStream *scr_child_stderr(ScrChild *c) {
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

ScrChild *scr_spawn(ScrStr *cmd, ScrArr *args) {
  return scr_spawn_opts(cmd, args, 0, 0, 0, 0, 0, false, false, NULL, NULL);
}

/* The options core behind cp.spawn/cp.spawnOpts. PER-SLOT stdio modes:
 * 0 = ignore (/dev/null), 1 = inherit (the parent's fd), 2 = fd (out/err
 * only — out_fd/err_fd dup2 into the child's slot, Node's stdio fd form:
 * the daemon-log idiom ["ignore", logFd, logFd]), 3 = pipe (out/err only
 * — a fresh pipe whose read end becomes the child.stdout/child.stderr
 * stream; see the stream slice's design note). detached gives the
 * child its own session (POSIX_SPAWN_SETSID → setsid(2), the libuv
 * implementation of Node's flag). env_pairs, when has_env, REPLACES the
 * child environment ([k,v,...] like the exec core's); cwd (NULL/"" =
 * inherit) chdirs the child. Spawn failure stays an event, never a
 * throw. */
ScrChild *scr_spawn_opts(ScrStr *cmd, ScrArr *args, double in_mode,
                          double out_mode, double err_mode, double out_fd,
                          double err_fd, bool detached, bool has_env,
                          ScrArr *env_pairs, ScrStr *cwd) {
  if ((int)out_mode == 1 || (int)err_mode == 1 || (int)out_mode == 2 || (int)err_mode == 2) {
    /* Inherited or fd-redirected stdio: flush the parent's buffered
     * output first so everything logged BEFORE the spawn lands before
     * anything the child writes to the same destinations (Node's
     * practical ordering). */
    fflush(stdout);
    fflush(stderr);
  }
  ScrChild *c = calloc(1, sizeof(ScrChild));
  if (!c) scr_child_oom();
  c->rc = 1;

  /* Piped slots: pipe(2) NOW, both ends cloexec (the file action's dup2
   * clears the flag on the child's copy — every other descriptor closes
   * at exec). A pipe failure degrades the slot to /dev/null — nothing
   * real hits it (fd exhaustion), and the stream husk answers eof. */
  int out_pipe[2] = {-1, -1};
  int err_pipe[2] = {-1, -1};
  if ((int)out_mode == 3 && pipe(out_pipe) != 0) {
    out_pipe[0] = out_pipe[1] = -1;
    out_mode = 0;
  }
  if ((int)err_mode == 3 && pipe(err_pipe) != 0) {
    err_pipe[0] = err_pipe[1] = -1;
    err_mode = 0;
  }
  for (int i = 0; i < 2; i++) {
    if (out_pipe[i] >= 0) fcntl(out_pipe[i], F_SETFD, FD_CLOEXEC);
    if (err_pipe[i] >= 0) fcntl(err_pipe[i], F_SETFD, FD_CLOEXEC);
  }

  posix_spawn_file_actions_t fa;
  posix_spawn_file_actions_init(&fa);
  if ((int)in_mode == 0) {
    posix_spawn_file_actions_addopen(&fa, 0, "/dev/null", O_RDONLY, 0);
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
  char **argv = scr_child_argv(cmd, args);
  char **envp = has_env && env_pairs != NULL ? scr_exec_envp(env_pairs) : NULL;
  pid_t pid = -1;
  int spawn_err = posix_spawnp(&pid, cmd->data, &fa, &at, argv,
                               envp != NULL ? envp : environ);
  posix_spawnattr_destroy(&at);
  posix_spawn_file_actions_destroy(&fa);
  free(argv);
  scr_exec_envp_free(envp);

  /* The parent's copies of the write ends close regardless of outcome —
   * the child (when it spawned) holds the only writer, so EOF arrives
   * exactly when it exits (or its last inheritor does). A FAILED spawn
   * keeps its streams too, with no writer at all: a consumer sees
   * immediate EOF, so 'end' fires on the turn after the 'error' event —
   * Node's exact order, pinned by corpus. */
  if (out_pipe[1] >= 0) close(out_pipe[1]);
  if (err_pipe[1] >= 0) close(err_pipe[1]);
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
  /* The registry's reference: dropped when the child settles. */
  c->reffed = true;
  scr_children_reffed_n++;
  c->next = scr_children;
  scr_children = scr_child_retain(c);
  return c;
}

/* ── the lifecycle members (child.pid/exitCode/killed/kill/unref) ──────── */

/* child.pid — undefined exactly when the spawn failed (Node's shape). */
bool scr_child_has_pid(ScrChild *c) { return c->state != SCR_CHILD_SPAWN_FAILED; }
double scr_child_pid(ScrChild *c) { return (double)c->pid; }

/* child.exitCode — null while running and for a signal death; the exit
 * code after a normal exit; -errno once a spawn failure SETTLED (Node
 * flips it when the "error" event fires — before that it reads null). */
bool scr_child_has_exit_code(ScrChild *c) {
  if (c->state == SCR_CHILD_EXITED) return c->has_code;
  return c->state == SCR_CHILD_SPAWN_FAILED && c->settled;
}
double scr_child_exit_code(ScrChild *c) {
  if (c->state == SCR_CHILD_SPAWN_FAILED) return -(double)c->spawn_errno;
  return c->code;
}

bool scr_child_killed(ScrChild *c) { return c->killed; }

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
  int signo = scr_signal_from_name(signal);
  if (signo < 0) {
    size_t cap = 16 + signal->len + 1;
    char *msg = malloc(cap);
    if (!msg) scr_child_oom();
    int len = snprintf(msg, cap, "Unknown signal: %s", signal->data);
    scr_throw_error_msg(SCR_ERR_TYPE, msg, (size_t)len);
    free(msg);
    return false;
  }
  return scr_child_kill_signo(c, signo);
}

/* child.kill(number) — the numeric form passes through (0 probes). */
bool scr_child_kill_num(ScrChild *c, double signum) {
  return scr_child_kill_signo(c, (int)signum);
}

/* child.unref() — drops the child from the loop's keep-alive set (Node's
 * semantics: the process may exit while the child runs). The child is
 * still REAPED whenever the loop runs for other reasons; one the loop
 * never reaps is left to the OS at process exit (init reparents it — no
 * zombie outlives the parent). */
void scr_child_unref(ScrChild *c) {
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
  return scr_children_reffed_n > 0 || scr_child_streams_watching > 0;
}

/* Loop-exhaustion teardown (the scr_timers_teardown twin): the loop may
 * exit with unref'd children still running — release the registry's
 * references (listeners never fire; Node's process-exit behavior) so the
 * RC audit stays clean. */
void scr_children_teardown(void) {
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
static const char *scr_child_err_code = NULL;

/* [.code on event errors — net/http/dgram parity with spawn failures]
 * The errno name embedded in an errnoException-style message ("connect
 * ECONNREFUSED 127.0.0.1:80", "listen EADDRINUSE: address already in use
 * :::4000", "bind EADDRINUSE 0.0.0.0:4000"): the SECOND space-separated
 * token when it spells an errno name (E + capitals/digits, a colon or
 * space terminating). Every message fired through this thunk is this
 * runtime's own construction, and exactly the ones carrying a code embed
 * it in this shape — Node builds the same messages FROM the code
 * (errnoException), so parsing it back is exact over the closed message
 * set. Fallback only (an explicit context wins); returns a static buffer
 * valid until the next call, or NULL for code-less messages ("socket
 * hang up" stays undefined — divergence 54's documented bound). */
static const char *scr_err_msg_code(const ScrStr *msg) {
  static char buf[32];
  const char *sp = strchr((const char *)msg->data, ' ');
  if (sp == NULL || sp[1] != 'E') return NULL;
  const char *tok = sp + 1;
  size_t n = 1;
  while (tok[n] != '\0' && tok[n] != ' ' && tok[n] != ':') {
    char c = tok[n];
    if (!((c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9'))) return NULL;
    if (n + 1 >= sizeof buf) return NULL;
    n++;
  }
  if (n < 3) return NULL; /* "EIO" is the shortest real name */
  memcpy(buf, tok, n);
  buf[n] = '\0';
  return buf;
}

/* An (err: Error) listener: constructs the %Error instance from the
 * message (borrowed; scr_error_new retains its copy) — the listener owns
 * the +1 error param per the universal convention. `code` stamps from the
 * settle context (spawn failures) or the message's own embedded errno name
 * (net/http/dgram 'error' events — see scr_err_msg_code). */
void scr_child_err_thunk_error(ScrClosure *cb, ScrStr *msg) {
  ScrError *e = scr_error_new(0 /* Error */, msg);
  if (scr_child_err_code != NULL) {
    scr_error_set_code(e, scr_child_err_code);
  } else {
    const char *code = scr_err_msg_code(msg);
    if (code != NULL) scr_error_set_code(e, code);
  }
  ((void (*)(ScrClosure *, ScrError *))cb->fn)(cb, e);
}

/* ── the loop's half (called from scr_async.c) ───────────────────────── */

bool scr_children_pending(void) {
  return scr_children != NULL || scr_child_streams_watching > 0;
}

/* True while an UNSETTLED spawn failure sits in the registry: its 'error'
 * is a next-tick-shaped event Node delivers regardless of ref state (an
 * unref'd failed spawn still crashes an error-listener-less program), so
 * the loop's only-unref'd-children exit gate must not skip it. */
bool scr_children_failed_pending(void) {
  for (ScrChild *c = scr_children; c; c = c->next) {
    if (c->state == SCR_CHILD_SPAWN_FAILED && !c->settled) return true;
  }
  return false;
}

/* Fires one settled child's terminal event. The child is already off the
 * registry; drops the listeners and the registry's reference. The pinned
 * ordering runs first: consumer-owning piped streams drain to EOF/EAGAIN
 * so their 'end' events fire BEFORE 'exit' (Node-exact — verified: data*,
 * end, then exit for every output shape). */
static void scr_child_settle(ScrChild *c) {
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
   * the streams' immediate EOF delivers 'end' on the next turn. */
  if (c->state == SCR_CHILD_EXITED) {
    scr_child_stream_drain_now(c->out_stream);
    if (!scr_exc_pending()) scr_child_stream_drain_now(c->err_stream);
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
    if (c->n_err == 0) {
      /* Node: an 'error' event with no listener is an uncaught throw.
       * _Exit skips atexit handlers (the RC audit above all) on purpose —
       * the loop dies mid-turn with frames and registries still live,
       * exactly like process.exit(). */
      fflush(stdout);
      fprintf(stderr, "Unhandled 'error' event: Error: %s\n", c->err_msg->data);
      _Exit(1);
    }
    /* Node's spawn-failure error is an errnoException: `code` carries the
     * errno name. The thunk reads this while the pass runs. */
    scr_child_err_code = scr_errname(c->spawn_errno);
    for (size_t i = 0; i < c->n_err; i++) {
      c->err_cbs[i].fn(c->err_cbs[i].cb, c->err_msg);
      if (scr_exc_pending()) break; /* the loop surfaces it */
    }
    scr_child_err_code = NULL;
  } else {
    for (size_t i = 0; i < c->n_exit; i++) {
      c->exit_cbs[i].fn(c->exit_cbs[i].cb, c->has_code, c->code, c->exit_signal);
      if (scr_exc_pending()) break;
    }
  }
  scr_child_drop_listeners(c);
  scr_child_release(c); /* the registry's reference */
}

/* One reap pass: piped streams service FIRST (arrived chunks fire their
 * 'data' listeners; a pipe that hit EOF fires 'end' — before any 'exit'
 * this pass delivers, the pinned ordering), then waitpid(WNOHANG) every
 * running child; spawn failures settle on their first pass (their "next
 * tick"). Listeners run synchronously on the main stack, like timer
 * callbacks — a throw stops the pass and leaves the exception pending
 * for the loop. */
void scr_children_poll(void) {
  scr_child_streams_service();
  if (scr_exc_pending()) return;
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
}

#endif /* !_WIN32 */
