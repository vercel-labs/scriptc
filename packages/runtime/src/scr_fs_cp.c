/* fs.cpSync, fs.cp and fs/promises cp.
 *
 * Node runs two implementations, and this unit ports both:
 *   - cpSync: lib/internal/fs/cp/cp-sync.js over the fs binding's
 *     cpSyncCheckPaths, cpSyncOverrideFile and cpSyncCopyDir. Those
 *     helpers use std::filesystem, so their checks, error shapes ("Error:
 *     message" with a code, and ErrnoException's "EEXIST, File exists
 *     'path'") and libstdc++'s copy_file, create_directory and
 *     weakly_canonical rules are reproduced here.
 *   - fs.cp and fs/promises cp: lib/internal/fs/cp/cp.js, whose copy
 *     errors are SystemErrors.
 * Both walk directories in readdir order, as Node does. The promise and
 * callback forms complete the copy before their promise settles or their
 * callback runs. An async filter must return a promise that is already
 * settled when it returns; a pending one throws SC2020.
 *
 * scr_fs_cp_begin runs validateCpOptions and getValidatedPath(src, dest)
 * and answers the job (NULL with the exception pending); scr_fs_cp_run
 * copies, leaving any copy error pending. */
#include "scr_runtime.h"

#include <errno.h>
#include <limits.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifndef _WIN32
#include <dirent.h>
#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>
#if defined(__linux__)
#include <linux/fs.h>
#include <sys/ioctl.h>
#include <sys/sendfile.h>
#include <sys/syscall.h>
#endif
#endif

struct ScrFsCp {
  ScrStr *src, *dest;
  bool dereference, error_on_exist, force, preserve, recursive, verbatim;
  int mode;
  ScrDyn *filter; /* owned; NULL when absent */
};

/* ── validateCpOptions and getValidatedPath ───────────────────────────── */

static bool cp_bool_option(const ScrDyn *options, const char *key, bool fallback, bool *out) {
  ScrDyn *value = scr_fs_option_get(options, key);
  if (!value) return false;
  bool ok = true;
  if (value->kind == SCR_DYN_UNDEF) {
    *out = fallback;
  } else if (value->kind == SCR_DYN_BOOL) {
    *out = value->v.b;
  } else {
    char name[48];
    snprintf(name, sizeof name, "options.%s", key);
    scr_dyn_prop_type_fail(name, "of type boolean", value);
    ok = false;
  }
  scr_dyn_release(value);
  return ok;
}

/* getValidMode(options.mode, 'copyFile'): nullish selects 0, otherwise an
 * integer in [0, 7]. */
static bool cp_mode_option(const ScrDyn *options, int *out) {
  ScrDyn *value = scr_fs_option_get(options, "mode");
  if (!value) return false;
  bool ok = true;
  *out = 0;
  if (value->kind == SCR_DYN_UNDEF || value->kind == SCR_DYN_NULL) {
    /* the default */
  } else if (value->kind != SCR_DYN_NUM) {
    scr_dyn_arg_type_fail("mode", "of type number", value);
    ok = false;
  } else {
    double mode = value->v.num;
    char received[48];
    char text[160];
    if (mode != mode || mode - (double)(long long)mode != 0 || mode > 1e18 || mode < -1e18) {
      scr_num_received(mode, received);
      int n = snprintf(text, sizeof text, "The value of \"mode\" is out of range. It must be an integer. Received %s", received);
      scr_throw_error_msg_code(SCR_ERR_RANGE, text, (size_t)n, "ERR_OUT_OF_RANGE");
      ok = false;
    } else if (mode < 0 || mode > 7) {
      scr_num_received(mode, received);
      int n = snprintf(text, sizeof text, "The value of \"mode\" is out of range. It must be >= 0 && <= 7. Received %s", received);
      scr_throw_error_msg_code(SCR_ERR_RANGE, text, (size_t)n, "ERR_OUT_OF_RANGE");
      ok = false;
    } else {
      *out = (int)mode;
    }
  }
  scr_dyn_release(value);
  return ok;
}

void scr_fs_cp_free(ScrFsCp *job) {
  if (!job) return;
  scr_str_release(job->src);
  scr_str_release(job->dest);
  scr_dyn_release(job->filter);
  free(job);
}

ScrFsCp *scr_fs_cp_begin(const ScrDyn *src, const ScrDyn *dest, const ScrDyn *options) {
  ScrFsCp *job = calloc(1, sizeof *job);
  if (!job) scr_trap("scriptc: out of memory\n");
  job->force = true;
  bool ok = true;
  if (options->kind != SCR_DYN_UNDEF) {
    /* validateObject(options, 'options') */
    bool object = (options->kind == SCR_DYN_OBJ || options->kind == SCR_DYN_TYPED_REF || options->kind == SCR_DYN_HANDLE);
    if (!object) {
      scr_dyn_arg_type_fail("options", "of type object", options);
      ok = false;
    }
    ok = ok && cp_bool_option(options, "dereference", false, &job->dereference);
    ok = ok && cp_bool_option(options, "errorOnExist", false, &job->error_on_exist);
    ok = ok && cp_bool_option(options, "force", true, &job->force);
    ok = ok && cp_bool_option(options, "preserveTimestamps", false, &job->preserve);
    ok = ok && cp_bool_option(options, "recursive", false, &job->recursive);
    ok = ok && cp_bool_option(options, "verbatimSymlinks", false, &job->verbatim);
    ok = ok && cp_mode_option(options, &job->mode);
    if (ok && job->dereference && job->verbatim) {
      static const char message[] = "Option \"dereference\" cannot be used in combination with option \"verbatimSymlinks\"";
      scr_throw_error_msg_code(SCR_ERR_TYPE, message, sizeof message - 1, "ERR_INCOMPATIBLE_OPTION_PAIR");
      ok = false;
    }
    if (ok) {
      ScrDyn *filter = scr_fs_option_get(options, "filter");
      ok = filter != NULL;
      if (ok && filter->kind != SCR_DYN_UNDEF) {
        if (filter->kind != SCR_DYN_FUNC) {
          scr_dyn_prop_type_fail("options.filter", "of type function", filter);
          ok = false;
        } else {
          job->filter = scr_dyn_retain(filter);
        }
      }
      scr_dyn_release(filter);
    }
  }
  if (ok) job->src = scr_fs_validated_path(src, "src");
  if (ok && job->src) job->dest = scr_fs_validated_path(dest, "dest");
  if (!ok || !job->src || !job->dest || scr_exc_pending()) {
    scr_fs_cp_free(job);
    return NULL;
  }
  return job;
}

#ifdef _WIN32

void scr_fs_cp_run(ScrFsCp *job, bool promise_form) {
  (void)job;
  (void)promise_form;
  static const char message[] = "fs.cp has no native lowering on Windows";
  scr_throw_error_msg_code(SCR_ERR_ERROR, message, sizeof message - 1, "SC2020");
}

#else

/* ── paths ──────────────────────────────────────────────────────────── */

static ScrStr *cp_str(const char *s) { return scr_str_new(s, strlen(s)); }

static ScrStr *cp_path2(const ScrStr *a, const ScrStr *b, bool resolve) {
  ScrArr *parts = scr_arr_new(SCR_ELEM_STR, 2);
  scr_arr_push_ref(parts, scr_str_retain((ScrStr *)a));
  scr_arr_push_ref(parts, scr_str_retain((ScrStr *)b));
  ScrStr *out = resolve ? scr_path_resolve(parts) : scr_path_join(parts);
  scr_arr_release(parts);
  return out;
}

/* path.join and path.resolve (+1). */
static ScrStr *cp_join(const ScrStr *a, const ScrStr *b) { return cp_path2(a, b, false); }

static ScrStr *cp_resolve(const ScrStr *a, const ScrStr *b) { return cp_path2(a, b, true); }

static ScrStr *cp_resolve1(const ScrStr *a) {
  ScrArr *parts = scr_arr_new(SCR_ELEM_STR, 1);
  scr_arr_push_ref(parts, scr_str_retain((ScrStr *)a));
  ScrStr *out = scr_path_resolve(parts);
  scr_arr_release(parts);
  return out;
}

static bool cp_is_absolute(const ScrStr *p) { return p->len > 0 && p->data[0] == '/'; }

/* std::filesystem::path::operator/ (POSIX). */
static ScrStr *fs_append(const ScrStr *a, const char *b) {
  size_t bn = strlen(b);
  if (bn && b[0] == '/') return scr_str_new(b, bn);
  if (a->len == 0) return scr_str_new(b, bn);
  bool slash = a->data[a->len - 1] == '/';
  size_t n = a->len + (slash ? 0 : 1) + bn;
  char *buf = malloc(n + 1);
  if (!buf) scr_trap("scriptc: out of memory\n");
  memcpy(buf, a->data, a->len);
  size_t at = a->len;
  if (!slash) buf[at++] = '/';
  memcpy(buf + at, b, bn);
  ScrStr *out = scr_str_new(buf, n);
  free(buf);
  return out;
}

/* std::filesystem::path::parent_path (POSIX): the path without its last
 * element and the separators before it; a root-only path is its own
 * parent; "a/b/" answers "a/b". */
static ScrStr *fs_parent(const ScrStr *p) {
  size_t n = p->len;
  const char *d = p->data;
  size_t root = n > 0 && d[0] == '/' ? 1 : 0;
  while (root < n && d[root] == '/') root++;
  if (root == n) return scr_str_new(d, root ? 1 : 0);
  size_t last;
  if (d[n - 1] == '/') {
    last = n;
  } else {
    last = n;
    while (last > 0 && d[last - 1] != '/') last--;
  }
  size_t end = last;
  while (end > 0 && d[end - 1] == '/') end--;
  if (end == 0 && root) end = 1;
  return scr_str_new(d, end);
}

static bool fs_has_parent(const ScrStr *p) {
  ScrStr *parent = fs_parent(p);
  bool has = parent->len > 0;
  scr_str_release(parent);
  return has;
}

static bool cp_str_eq(const ScrStr *a, const ScrStr *b) {
  return a->len == b->len && memcmp(a->data, b->data, a->len) == 0;
}

static ScrStr *cp_cwd(void) {
  char *buf = malloc(PATH_MAX);
  if (!buf) scr_trap("scriptc: out of memory\n");
  ScrStr *cwd = cp_str(getcwd(buf, PATH_MAX) ? buf : "");
  free(buf);
  return cwd;
}

/* std::filesystem::absolute: the working directory joined in front of a
 * relative path, without normalization. */
static ScrStr *fs_absolute(const ScrStr *p) {
  if (cp_is_absolute(p)) return scr_str_retain((ScrStr *)p);
  ScrStr *cwd = cp_cwd();
  ScrStr *out = p->len ? fs_append(cwd, p->data) : scr_str_retain(cwd);
  scr_str_release(cwd);
  return out;
}

/* The elements of a POSIX path as std::filesystem iterates them: the root
 * "/", then each name; a trailing separator adds an empty element. */
typedef struct {
  char **v;
  size_t n;
} FsParts;

static void fs_parts_free(FsParts *parts) {
  for (size_t i = 0; i < parts->n; i++) free(parts->v[i]);
  free(parts->v);
}

static void fs_parts_push(FsParts *parts, const char *s, size_t n) {
  parts->v = realloc(parts->v, (parts->n + 1) * sizeof *parts->v);
  if (!parts->v) scr_trap("scriptc: out of memory\n");
  char *copy = malloc(n + 1);
  if (!copy) scr_trap("scriptc: out of memory\n");
  memcpy(copy, s, n);
  copy[n] = 0;
  parts->v[parts->n++] = copy;
}

static FsParts fs_split(const ScrStr *p) {
  FsParts parts = { NULL, 0 };
  size_t i = 0, n = p->len;
  const char *d = p->data;
  if (n && d[0] == '/') {
    fs_parts_push(&parts, "/", 1);
    while (i < n && d[i] == '/') i++;
  }
  while (i < n) {
    size_t start = i;
    while (i < n && d[i] != '/') i++;
    fs_parts_push(&parts, d + start, i - start);
    if (i < n) {
      while (i < n && d[i] == '/') i++;
      if (i == n) fs_parts_push(&parts, "", 0);
    }
  }
  return parts;
}

/* The C++ binding's isInsideDir: absolute(src)'s non-empty elements are a
 * prefix of absolute(dest)'s. */
static bool fs_inside_dir(const ScrStr *src, const ScrStr *dest) {
  ScrStr *a = fs_absolute(src), *b = fs_absolute(dest);
  FsParts pa = fs_split(a), pb = fs_split(b);
  size_t na = 0, nb = 0;
  for (size_t i = 0; i < pa.n; i++) na += pa.v[i][0] != 0;
  for (size_t i = 0; i < pb.n; i++) nb += pb.v[i][0] != 0;
  bool inside = na <= nb;
  for (size_t i = 0, j = 0; inside && i < pa.n; i++) {
    if (!pa.v[i][0]) continue;
    while (j < pb.n && !pb.v[j][0]) j++;
    inside = j < pb.n && strcmp(pa.v[i], pb.v[j]) == 0;
    j++;
  }
  fs_parts_free(&pa);
  fs_parts_free(&pb);
  scr_str_release(a);
  scr_str_release(b);
  return inside;
}

/* path::lexically_normal (POSIX). */
static ScrStr *fs_lexically_normal(const ScrStr *p) {
  FsParts parts = fs_split(p);
  FsParts out = { NULL, 0 };
  bool rooted = parts.n && strcmp(parts.v[0], "/") == 0;
  for (size_t i = rooted ? 1 : 0; i < parts.n; i++) {
    const char *e = parts.v[i];
    if (strcmp(e, ".") == 0 || (e[0] == 0 && i + 1 < parts.n)) continue;
    if (strcmp(e, "..") == 0) {
      if (out.n && strcmp(out.v[out.n - 1], "..") != 0) {
        free(out.v[--out.n]);
        continue;
      }
      if (rooted) continue;
    }
    fs_parts_push(&out, e, strlen(e));
  }
  size_t cap = 2;
  for (size_t i = 0; i < out.n; i++) cap += strlen(out.v[i]) + 1;
  char *buf = malloc(cap);
  if (!buf) scr_trap("scriptc: out of memory\n");
  size_t at = 0;
  if (rooted) buf[at++] = '/';
  for (size_t i = 0; i < out.n; i++) {
    if (i) buf[at++] = '/';
    size_t len = strlen(out.v[i]);
    memcpy(buf + at, out.v[i], len);
    at += len;
  }
  if (at == 0) buf[at++] = '.';
  ScrStr *result = scr_str_new(buf, at);
  free(buf);
  fs_parts_free(&parts);
  fs_parts_free(&out);
  return result;
}

static ScrStr *fs_realpath(const ScrStr *p) {
  char *real = realpath(p->data, NULL);
  if (!real) return NULL;
  ScrStr *out = cp_str(real);
  free(real);
  return out;
}

/* std::filesystem::weakly_canonical: the longest existing prefix resolved
 * with realpath, the rest appended and lexically normalized. */
static ScrStr *fs_weakly_canonical(const ScrStr *p) {
  struct stat st;
  if (stat(p->data, &st) == 0) {
    ScrStr *real = fs_realpath(p);
    if (real) return real;
  }
  FsParts parts = fs_split(p);
  ScrStr *result = cp_str("");
  size_t i = 0;
  for (; i < parts.n; i++) {
    ScrStr *next = fs_append(result, parts.v[i]);
    if (stat(next->data, &st) != 0) {
      scr_str_release(next);
      break;
    }
    scr_str_release(result);
    result = next;
  }
  if (result->len) {
    ScrStr *real = fs_realpath(result);
    if (real) {
      scr_str_release(result);
      result = real;
    }
  }
  for (; i < parts.n; i++) {
    ScrStr *next = fs_append(result, parts.v[i]);
    scr_str_release(result);
    result = next;
  }
  ScrStr *normal = fs_lexically_normal(result);
  scr_str_release(result);
  fs_parts_free(&parts);
  return normal;
}

/* cp.js's isSrcSubdir: resolve(src)'s segments are a prefix of
 * resolve(dest)'s. */
static bool cp_is_src_subdir(const ScrStr *src, const ScrStr *dest) {
  ScrStr *a = cp_resolve1(src), *b = cp_resolve1(dest);
  FsParts pa = fs_split(a), pb = fs_split(b);
  bool every = true;
  size_t j = 0;
  for (size_t i = 0; every && i < pa.n; i++) {
    if (!pa.v[i][0] || strcmp(pa.v[i], "/") == 0) continue;
    while (j < pb.n && (!pb.v[j][0] || strcmp(pb.v[j], "/") == 0)) j++;
    every = j < pb.n && strcmp(pa.v[i], pb.v[j]) == 0;
    j++;
  }
  fs_parts_free(&pa);
  fs_parts_free(&pb);
  scr_str_release(a);
  scr_str_release(b);
  return every;
}

/* ── errors ─────────────────────────────────────────────────────────── */

static void cp_native(const char *code, const char *format, const char *a, const char *b) {
  size_t cap = strlen(format) + strlen(a) + (b ? strlen(b) : 0) + 1;
  char *text = malloc(cap);
  if (!text) scr_trap("scriptc: out of memory\n");
  int n = b ? snprintf(text, cap, format, a, b) : snprintf(text, cap, format, a);
  scr_fs_throw_native_coded(code, text, (size_t)n);
  free(text);
}

static void cp_system(const char *code, const char *prefix, int e, const char *format, const char *a,
                      const char *b, const ScrStr *path) {
  size_t cap = strlen(format) + strlen(a) + (b ? strlen(b) : 0) + 1;
  char *text = malloc(cap);
  if (!text) scr_trap("scriptc: out of memory\n");
  int n = b ? snprintf(text, cap, format, a, b) : snprintf(text, cap, format, a);
  ScrStr *message = scr_str_new(text, (size_t)n);
  free(text);
  scr_fs_throw_system_error(code, prefix, e, "cp", message, path);
  scr_str_release(message);
}

static void cp_eexist(const ScrStr *dest) {
  cp_system("ERR_FS_CP_EEXIST", "Target already exists", EEXIST, "%s already exists", dest->data, NULL, dest);
}

/* ── the user filter ────────────────────────────────────────────────── */

/* Calls options.filter(src, dest); false with the exception pending when
 * it threw (or returned a promise in the synchronous form). */
static bool cp_filter(const ScrFsCp *job, const ScrStr *src, const ScrStr *dest, bool promise_form, bool *copy) {
  ScrDyn *args[2] = { scr_dyn_new_str((ScrStr *)src), scr_dyn_new_str((ScrStr *)dest) };
  ScrDyn *result = scr_dyn_call(job->filter, args, 2, "options.filter");
  scr_dyn_release(args[0]);
  scr_dyn_release(args[1]);
  if (!result) return false;
  bool ok = true;
  if (result->kind == SCR_DYN_PROMISE) {
    if (!promise_form) {
      static const char message[] = "Expected boolean to be returned from the \"filter\" function but got an instance of Promise.";
      scr_throw_error_msg_code(SCR_ERR_TYPE, message, sizeof message - 1, "ERR_INVALID_RETURN_VALUE");
      ok = false;
    } else if (!scr_promise_settled_now(result->v.promise)) {
      static const char message[] = "fs.cp filter promises that are still pending have no native lowering";
      scr_throw_error_msg_code(SCR_ERR_ERROR, message, sizeof message - 1, "SC2020");
      ok = false;
    } else if (scr_exc_pending()) {
      ok = false;
    } else {
      *copy = scr_promise_payload_truthy(result->v.promise);
    }
  } else {
    *copy = scr_dyn_truthy(result);
  }
  scr_dyn_release(result);
  return ok;
}

/* ── file operations ────────────────────────────────────────────────── */

static int cp_stat(const ScrStr *path, bool follow, struct stat *st) {
  return follow ? stat(path->data, st) : lstat(path->data, st);
}

/* Copies in's remaining bytes to out; 0 or the errno. Linux copies in the
 * kernel with sendfile (copy_file_range, which can share extents, took
 * about twice as long per small file on xfs); otherwise, or when the
 * kernel refuses, a read/write loop over a heap buffer (directory copies
 * run deep, sometimes on a fiber's stack). */
static int cp_copy_bytes(int in, int out) {
#if defined(__linux__)
  for (bool first = true;; first = false) {
    ssize_t n = sendfile(out, in, NULL, (size_t)1 << 30);
    if (n > 0) continue;
    if (n == 0) return 0;
    if (errno == EINTR) continue;
    if (!first || (errno != EINVAL && errno != ENOSYS)) return errno;
    break;
  }
#endif
  enum { CP_CHUNK = 65536 };
  char *buf = malloc(CP_CHUNK);
  if (!buf) scr_trap("scriptc: out of memory\n");
  int e = 0;
  while (!e) {
    ssize_t got = read(in, buf, CP_CHUNK);
    if (got < 0) {
      if (errno == EINTR) continue;
      e = errno;
      break;
    }
    if (got == 0) break;
    for (ssize_t at = 0; at < got;) {
      ssize_t wrote = write(out, buf + at, (size_t)(got - at));
      if (wrote < 0) {
        if (errno == EINTR) continue;
        e = errno;
        break;
      }
      at += wrote;
    }
  }
  free(buf);
  return e;
}

/* uv_fs_copyfile: the destination is created (or truncated) and takes the
 * source's mode; COPYFILE_EXCL fails on an existing destination and
 * COPYFILE_FICLONE_FORCE requires a reflink. Copying a file onto itself
 * succeeds without touching it. Errors use `syscall` with both paths. */
static void cp_copyfile(const ScrStr *src, const ScrStr *dest, int mode, const char *syscall) {
  int in = open(src->data, O_RDONLY);
  if (in < 0) {
    scr_fs_throw2(errno, syscall, src, dest);
    return;
  }
  struct stat sst;
  if (fstat(in, &sst) != 0) {
    int e = errno;
    close(in);
    scr_fs_throw2(e, syscall, src, dest);
    return;
  }
  int flags = O_WRONLY | O_CREAT | ((mode & 1) ? O_EXCL : 0);
  int out = open(dest->data, flags, sst.st_mode & 07777);
  if (out < 0) {
    int e = errno;
    close(in);
    scr_fs_throw2(e, syscall, src, dest);
    return;
  }
  struct stat dst;
  int e = 0;
  if (fstat(out, &dst) != 0) e = errno;
  else if (dst.st_dev == sst.st_dev && dst.st_ino == sst.st_ino) {
    close(in);
    close(out);
    return;
  }
  if (!e && ftruncate(out, 0) != 0) e = errno;
#ifndef __wasi__
  if (!e && fchmod(out, sst.st_mode & 07777) != 0) e = errno;
#endif
  bool cloned = false;
  if (!e && (mode & 6)) {
#if defined(__linux__) && defined(FICLONE)
    if (ioctl(out, FICLONE, in) == 0) cloned = true;
    else if (mode & 4) e = errno;
#else
    if (mode & 4) e = ENOSYS;
#endif
  }
  if (!e && !cloned) e = cp_copy_bytes(in, out);
  close(in);
  if (close(out) != 0 && !e) e = errno;
  if (e) scr_fs_throw2(e, syscall, src, dest);
}

#if defined(SCR_FS_FLAGS) && !defined(_WIN32)
/* copyFileSync(src, dest, mode) and copyFile(src, dest, mode): libuv's
 * uv_fs_copyfile with Node's flag bits (the C++ binding's range check and
 * message: any value in [0, 7], truncated to an integer — 1.5 is EXCL).
 * COPYFILE_EXCL (1) fails EEXIST on an existing destination,
 * COPYFILE_FICLONE (2) requests a reflink and falls back to a copy, and
 * COPYFILE_FICLONE_FORCE (4) fails where no reflink is possible.
 *
 * This is the SCR_FS_FLAGS build of the unit: cp_copyfile is the reflink
 * walk, and keeping the entry behind a define leaves every program that
 * never passes a mode with the default object, byte for byte. The Windows
 * arm (CopyFileW and its ENOSYS for FICLONE_FORCE) sits beside the Win32 fs
 * helpers in scr_lib.c. */
void scr_fs_copyfile_flags(ScrStr *src, ScrStr *dest, double mode) {
  if (!(mode >= 0 && mode <= 7)) {
    static const char text[] = "mode is out of range: >= 0 && <= 7";
    scr_throw_error_msg_code(SCR_ERR_RANGE, text, sizeof text - 1, "ERR_OUT_OF_RANGE");
    return;
  }
  if (!scr_fs_path_ok(src, "src")) return;
  if (!scr_fs_path_ok(dest, "dest")) return;
  cp_copyfile(src, dest, (int)mode, "copyfile");
}
#endif

/* utimes(dest, atime, mtime) in seconds, through the utimesSync path. */
static bool cp_utime(const ScrStr *dest, double atime, double mtime) {
  scr_fs_utimes((ScrStr *)dest, atime, mtime, false);
  return !scr_exc_pending();
}

static double cp_stamp_ns(time_t sec, long nsec) { return (double)sec + (double)nsec / 1e9; }

static double cp_stamp_ms(time_t sec, long nsec) {
  /* A Stats Date: msFromTimeSpec rounded to whole milliseconds
   * (dateFromMs), then toUnixTimestamp's seconds. */
  double ms = (double)sec * 1000 + (double)nsec / 1e6;
  return round(ms) / 1000;
}

#if defined(__APPLE__)
#define CP_ATIM(st) (st).st_atimespec
#define CP_MTIM(st) (st).st_mtimespec
#else
#define CP_ATIM(st) (st).st_atim
#define CP_MTIM(st) (st).st_mtim
#endif

/* setDestTimestamps: statSync(src), then utimesSync(dest) with its Date
 * values (millisecond precision). */
static bool cp_set_dest_timestamps(const ScrStr *src, const ScrStr *dest) {
  struct stat st;
  if (stat(src->data, &st) != 0) {
    scr_fs_throw(errno, "stat", src);
    return false;
  }
  return cp_utime(dest, cp_stamp_ms(CP_ATIM(st).tv_sec, CP_ATIM(st).tv_nsec),
                  cp_stamp_ms(CP_MTIM(st).tv_sec, CP_MTIM(st).tv_nsec));
}

/* The binding's CopyUtimes: uv_fs_stat(src), then uv_fs_utime(dest) with
 * nanosecond times. */
static bool cp_copy_utimes(const ScrStr *src, const ScrStr *dest) {
  struct stat st;
  if (stat(src->data, &st) != 0) {
    scr_fs_throw(errno, "stat", src);
    return false;
  }
  return cp_utime(dest, cp_stamp_ns(CP_ATIM(st).tv_sec, CP_ATIM(st).tv_nsec),
                  cp_stamp_ns(CP_MTIM(st).tv_sec, CP_MTIM(st).tv_nsec));
}

static bool cp_chmod(const ScrStr *path, mode_t mode) {
#ifdef __wasi__
  (void)path;
  (void)mode;
  return true;
#else
  if (chmod(path->data, mode & 07777) != 0) {
    scr_fs_throw(errno, "chmod", path);
    return false;
  }
  return true;
#endif
}

static ScrStr *cp_readlink(const ScrStr *path, int *err) {
  char *buf = malloc(PATH_MAX + 1);
  if (!buf) scr_trap("scriptc: out of memory\n");
  ssize_t n = readlink(path->data, buf, PATH_MAX);
  ScrStr *target = NULL;
  if (n < 0) *err = errno;
  else target = scr_str_new(buf, (size_t)n);
  free(buf);
  return target;
}

/* mkdir -p with every error ignored (std::filesystem::create_directories
 * with an error_code the caller drops). */
static void cp_mkdir_parents(const ScrStr *dir) {
  if (dir->len == 0) return;
  char *buf = malloc(dir->len + 1);
  if (!buf) scr_trap("scriptc: out of memory\n");
  memcpy(buf, dir->data, dir->len + 1);
  for (size_t i = 1; i <= dir->len; i++) {
    if (buf[i] != '/' && buf[i] != 0) continue;
    char saved = buf[i];
    buf[i] = 0;
    (void)mkdir(buf, 0777);
    buf[i] = saved;
  }
  free(buf);
}

/* A pending exception set aside while a `finally` block runs: the block's
 * own error replaces it, as in JavaScript. */
static void cp_finally_restore(ScrCaught *saved) {
  if (!saved) return;
  if (scr_exc_pending()) scr_caught_release(saved);
  else {
    scr_rethrow(saved);
    scr_caught_release(saved);
  }
}

/* ── cpSync (cp-sync.js and the fs binding) ─────────────────────────── */

static void sync_get_stats(const ScrFsCp *job, const ScrStr *src, const ScrStr *dest);

/* std::filesystem::equivalent with an error_code: false when either path
 * cannot be stat'ed. */
static bool fs_equivalent(const ScrStr *a, const ScrStr *b) {
  struct stat sa, sb;
  if (stat(a->data, &sa) != 0 || stat(b->data, &sb) != 0) return false;
  return sa.st_dev == sb.st_dev && sa.st_ino == sb.st_ino;
}

/* fsBinding.cpSyncCheckPaths. Its stat calls are swapped relative to
 * `dereference` (status for src when false), as in Node. */
static bool sync_check_paths(const ScrFsCp *job, const ScrStr *src, const ScrStr *dest) {
  struct stat sst, dst;
  if (cp_stat(src, !job->dereference, &sst) != 0) {
    scr_fs_throw(errno, job->dereference ? "stat" : "lstat", src);
    return false;
  }
  bool dest_ok = cp_stat(dest, job->dereference, &dst) == 0;
  bool src_is_dir = S_ISDIR(sst.st_mode) || (job->dereference && S_ISLNK(sst.st_mode));
  if (dest_ok) {
    if (fs_equivalent(src, dest)) {
      cp_native("ERR_FS_CP_EINVAL", "src and dest cannot be the same %s", dest->data, NULL);
      return false;
    }
    bool dest_is_dir = S_ISDIR(dst.st_mode);
    if (src_is_dir && !dest_is_dir) {
      cp_native("ERR_FS_CP_DIR_TO_NON_DIR", "Cannot overwrite non-directory %s with directory %s", dest->data, src->data);
      return false;
    }
    if (!src_is_dir && dest_is_dir) {
      cp_native("ERR_FS_CP_NON_DIR_TO_DIR", "Cannot overwrite directory %s with non-directory %s", dest->data, src->data);
      return false;
    }
  }
  /* The binding appends a separator to src before its prefix test. */
  ScrStr *src_slash;
  if (src->len && src->data[src->len - 1] == '/') {
    src_slash = scr_str_retain((ScrStr *)src);
  } else {
    ScrStr *separator = scr_str_new("/", 1);
    src_slash = scr_str_concat((ScrStr *)src, separator);
    scr_str_release(separator);
  }
  bool fail = false;
  if (src_is_dir && dest->len >= src_slash->len && memcmp(dest->data, src_slash->data, src_slash->len) == 0) {
    cp_native("ERR_FS_CP_EINVAL", "Cannot copy %s to a subdirectory of self %s", src_slash->data, dest->data);
    fail = true;
  }
  if (!fail) {
    ScrStr *dest_parent = fs_parent(dest);
    ScrStr *src_parent = fs_parent(src);
    ScrStr *grand = fs_parent(dest_parent);
    if (!cp_str_eq(src_parent, dest_parent) && fs_has_parent(dest_parent) && !cp_str_eq(grand, dest_parent) &&
        fs_equivalent(src, dest_parent)) {
      cp_native("ERR_FS_CP_EINVAL", "Cannot copy %s to a subdirectory of self %s", src_slash->data, dest->data);
      fail = true;
    }
    scr_str_release(dest_parent);
    scr_str_release(src_parent);
    scr_str_release(grand);
  }
  if (!fail && src_is_dir && !job->recursive) {
    cp_native("ERR_FS_EISDIR", "Recursive option not enabled, cannot copy a directory: %s", src_slash->data, NULL);
    fail = true;
  }
  scr_str_release(src_slash);
  if (fail) return false;
  if (S_ISSOCK(sst.st_mode)) {
    cp_native("ERR_FS_CP_SOCKET", "Cannot copy a socket file: %s", dest->data, NULL);
    return false;
  }
  if (S_ISFIFO(sst.st_mode)) {
    cp_native("ERR_FS_CP_FIFO_PIPE", "Cannot copy a FIFO pipe: %s", dest->data, NULL);
    return false;
  }
  ScrStr *parent = fs_parent(dest);
  struct stat pst;
  if (!dest_ok || stat(parent->data, &pst) != 0) cp_mkdir_parents(parent);
  scr_str_release(parent);
  return true;
}

enum { FS_COPY_SKIP, FS_COPY_OVERWRITE, FS_COPY_NONE };

static bool fs_copy_file(const ScrStr *from, const ScrStr *to, int existing, const ScrStr *error_path);

/* fsBinding.cpSyncOverrideFile: std::filesystem::remove, then
 * std::filesystem::copy_file (mode 0) or uv_fs_copyfile. */
static void sync_override_file(const ScrFsCp *job, const ScrStr *src, const ScrStr *dest) {
  if (unlink(dest->data) != 0 && (errno != EISDIR || rmdir(dest->data) != 0)) {
    scr_fs_throw_errno_exception(errno, "unlink", dest);
    return;
  }
  if (job->mode == 0) {
    if (!fs_copy_file(src, dest, FS_COPY_NONE, dest)) return;
  } else {
    cp_copyfile(src, dest, job->mode, "cp");
    if (scr_exc_pending()) return;
  }
  if (job->preserve) (void)cp_copy_utimes(src, dest);
}

static void sync_copy_file(const ScrFsCp *job, const struct stat *sst, const ScrStr *src, const ScrStr *dest) {
  cp_copyfile(src, dest, job->mode, "copyfile");
  if (scr_exc_pending()) return;
  if (job->preserve) {
    if ((sst->st_mode & 0200) == 0 && !cp_chmod(dest, sst->st_mode | 0200)) return;
    if (!cp_set_dest_timestamps(src, dest)) return;
  }
  (void)cp_chmod(dest, sst->st_mode);
}

static bool sync_copy_dir_contents(const ScrFsCp *job, const ScrStr *src, const ScrStr *dest);

/* std::filesystem::copy_file(from, to, options, ec): the source's contents
 * and mode into `to`; an existing `to` is skipped, overwritten or refused
 * (file_exists) per `existing`. A non-regular `to` is invalid_argument in
 * libstdc++ and not_supported in libc++, which Node's macOS builds use.
 * The binding reports file_exists as ERR_FS_CP_EEXIST and any other error
 * as an ErrnoException naming error_path. */
#if defined(__APPLE__)
#define FS_COPY_NOT_REGULAR ENOTSUP
#else
#define FS_COPY_NOT_REGULAR EINVAL
#endif
static bool fs_copy_file(const ScrStr *from, const ScrStr *to, int existing, const ScrStr *error_path) {
  struct stat tst, fst;
  bool exists = stat(to->data, &tst) == 0;
  if (stat(from->data, &fst) != 0) {
    scr_fs_throw_errno_exception(errno, "cp", error_path);
    return false;
  }
  if (exists) {
    if (!S_ISREG(tst.st_mode)) {
      scr_fs_throw_errno_exception(FS_COPY_NOT_REGULAR, "cp", error_path);
      return false;
    }
    bool same = tst.st_dev == fst.st_dev && tst.st_ino == fst.st_ino;
    if (same || existing == FS_COPY_NONE) {
      cp_native("ERR_FS_CP_EEXIST", "[ERR_FS_CP_EEXIST]: Target already exists: cp returned EEXIST (%s already exists)", to->data, NULL);
      return false;
    }
    if (existing == FS_COPY_SKIP) return true;
  }
  int in = open(from->data, O_RDONLY);
  int e = in < 0 ? errno : 0;
  int out = -1;
  if (!e) {
    out = open(to->data, O_WRONLY | O_CREAT | (existing == FS_COPY_OVERWRITE ? O_TRUNC : O_EXCL), S_IWUSR);
    if (out < 0) e = errno;
  }
#ifndef __wasi__
  if (!e && fchmod(out, fst.st_mode & 07777) != 0) e = errno;
#endif
  if (!e) e = cp_copy_bytes(in, out);
  if (in >= 0) close(in);
  if (out >= 0 && close(out) != 0 && !e) e = errno;
  if (e) {
    scr_fs_throw_errno_exception(e, "cp", error_path);
    return false;
  }
  return true;
}

/* A regular file inside cpSyncCopyDir. */
static bool sync_copy_entry_file(const ScrFsCp *job, const ScrStr *from, const ScrStr *to, const ScrStr *dest_dir) {
  int existing = job->force ? FS_COPY_OVERWRITE : job->error_on_exist ? FS_COPY_NONE : FS_COPY_SKIP;
  if (!fs_copy_file(from, to, existing, dest_dir)) return false;
  return !job->preserve || cp_copy_utimes(from, to);
}

/* A symbolic link inside cpSyncCopyDir. */
static bool sync_copy_entry_link(const ScrFsCp *job, const ScrStr *entry, const ScrStr *to, const ScrStr *src_dir,
                                 const ScrStr *dest_dir) {
  int err = 0;
  ScrStr *target = cp_readlink(entry, &err);
  if (!target) {
    scr_fs_throw_errno_exception(err, "cp", dest_dir);
    return false;
  }
  if (job->verbatim) {
    bool ok = symlink(target->data, to->data) == 0;
    if (!ok) scr_fs_throw_errno_exception(errno, "cp", dest_dir);
    scr_str_release(target);
    return ok;
  }
  struct stat tst, lst;
  if (stat(to->data, &tst) == 0) {
    if (lstat(to->data, &lst) == 0 && S_ISLNK(lst.st_mode)) {
      ScrStr *current = cp_readlink(to, &err);
      if (!current) {
        scr_fs_throw_errno_exception(err, "cp", dest_dir);
        scr_str_release(target);
        return false;
      }
      struct stat ast;
      bool fail = false;
      if (!job->dereference && stat(target->data, &ast) == 0 && S_ISDIR(ast.st_mode) && fs_inside_dir(target, current)) {
        cp_native("ERR_FS_CP_EINVAL", "Cannot copy \"%s\" to a subdirectory of self \"%s\"", target->data, current->data);
        fail = true;
      } else if (S_ISDIR(tst.st_mode) && fs_inside_dir(current, target)) {
        cp_native("ERR_FS_CP_SYMLINK_TO_SUBDIRECTORY", "cannot overwrite \"%s\" with \"%s\"", current->data, target->data);
        fail = true;
      } else if (unlink(to->data) != 0) {
        scr_fs_throw_errno_exception(errno, "cp", dest_dir);
        fail = true;
      }
      scr_str_release(current);
      if (fail) {
        scr_str_release(target);
        return false;
      }
    } else if (S_ISREG(tst.st_mode) && (!job->dereference || (!job->force && job->error_on_exist))) {
      scr_fs_throw_errno_exception(EEXIST, "cp", to);
      scr_str_release(target);
      return false;
    }
  }
  ScrStr *joined = fs_append(src_dir, target->data);
  ScrStr *absolute = fs_absolute(joined);
  ScrStr *canonical = fs_weakly_canonical(absolute);
  bool ok = symlink(canonical->data, to->data) == 0;
  if (!ok) scr_fs_throw_errno_exception(errno, "cp", dest_dir);
  scr_str_release(joined);
  scr_str_release(absolute);
  scr_str_release(canonical);
  scr_str_release(target);
  return ok;
}

/* An open directory in one of the walks below. The walks keep their
 * frames on the heap, not the C stack: a directory tree is as deep as
 * PATH_MAX allows, and the copy may run on a fiber's smaller stack. */
typedef struct {
  DIR *dir;
  ScrStr *src, *dest;
  bool flag;   /* created (native walk), make (filtered), created (promise form) */
  mode_t mode; /* the source directory's mode */
} CpFrame;

typedef struct {
  CpFrame *v;
  size_t n, cap;
} CpFrames;

static void cp_frames_push(CpFrames *frames, DIR *dir, const ScrStr *src, const ScrStr *dest, bool flag, mode_t mode) {
  if (frames->n == frames->cap) {
    frames->cap = frames->cap ? frames->cap * 2 : 16;
    frames->v = realloc(frames->v, frames->cap * sizeof *frames->v);
    if (!frames->v) scr_trap("scriptc: out of memory\n");
  }
  frames->v[frames->n++] = (CpFrame){ dir, scr_str_retain((ScrStr *)src), scr_str_retain((ScrStr *)dest), flag, mode };
}

static void cp_frame_release(CpFrame *frame) {
  if (frame->dir) closedir(frame->dir);
  scr_str_release(frame->src);
  scr_str_release(frame->dest);
}

static void cp_frames_free(CpFrames *frames) {
  while (frames->n) cp_frame_release(&frames->v[--frames->n]);
  free(frames->v);
}

/* cpSyncCopyDir's copy_dir_contents: each entry in readdir order, a
 * subdirectory walked when it is reached, and a directory the walk
 * created given its source's mode once its contents are in. */
static bool sync_copy_dir_contents(const ScrFsCp *job, const ScrStr *src, const ScrStr *dest) {
  DIR *root = opendir(src->data);
  if (!root) {
    scr_fs_throw_errno_exception(errno, "cp", src);
    return false;
  }
  CpFrames frames = { NULL, 0, 0 };
  cp_frames_push(&frames, root, src, dest, false, 0);
  bool ok = true;
  while (ok && frames.n) {
    CpFrame *top = &frames.v[frames.n - 1];
    struct dirent *entry = readdir(top->dir);
    if (!entry) {
      CpFrame done = frames.v[--frames.n];
#ifndef __wasi__
      if (done.flag && chmod(done.dest->data, done.mode & 07777) != 0) {
        scr_fs_throw_errno_exception(errno, "cp", done.dest);
        ok = false;
      }
#endif
      cp_frame_release(&done);
      continue;
    }
    if (!strcmp(entry->d_name, ".") || !strcmp(entry->d_name, "..")) continue;
    ScrStr *from = fs_append(top->src, entry->d_name);
    ScrStr *to = fs_append(top->dest, entry->d_name);
    /* directory_entry's cached type: d_type when the file system reports
     * one, lstat otherwise (and for directories, whose mode is needed). */
    struct stat lst;
    bool known = false;
#ifdef DT_REG
    if (entry->d_type == DT_REG) {
      lst.st_mode = S_IFREG;
      known = true;
    } else if (entry->d_type == DT_LNK) {
      lst.st_mode = S_IFLNK;
      known = true;
    }
#endif
    if (!known && lstat(from->data, &lst) != 0) {
      scr_fs_throw_errno_exception(errno, "cp", top->dest);
      ok = false;
    } else if (S_ISLNK(lst.st_mode)) {
      ok = sync_copy_entry_link(job, from, to, top->src, top->dest);
    } else if (S_ISDIR(lst.st_mode)) {
      bool created = mkdir(to->data, 0777) == 0;
      struct stat tst;
      if (!created && (errno != EEXIST || stat(to->data, &tst) != 0 || !S_ISDIR(tst.st_mode))) {
        scr_fs_throw_errno_exception(errno == EEXIST ? EEXIST : errno, "cp", to);
        ok = false;
      } else {
        DIR *child = opendir(from->data);
        if (!child) {
          scr_fs_throw_errno_exception(errno, "cp", from);
          ok = false;
        } else {
          cp_frames_push(&frames, child, from, to, created, lst.st_mode);
        }
      }
    } else if (S_ISREG(lst.st_mode)) {
      ok = sync_copy_entry_file(job, from, to, top->dest);
    }
    scr_str_release(from);
    scr_str_release(to);
  }
  cp_frames_free(&frames);
  return ok;
}

/* fsBinding.cpSyncCopyDir. */
static void sync_copy_dir_native(const ScrFsCp *job, const ScrStr *src, const ScrStr *dest) {
  struct stat st;
  bool existed = stat(dest->data, &st) == 0;
  if (existed && !S_ISDIR(st.st_mode)) {
    scr_fs_throw_errno_exception(ENOTDIR, "cp", dest);
    return;
  }
  if (!existed) {
    cp_mkdir_parents(dest);
    if (stat(dest->data, &st) != 0) {
      scr_fs_throw_errno_exception(errno, "cp", dest);
      return;
    }
  }
  if (!sync_copy_dir_contents(job, src, dest) || existed) return;
#ifndef __wasi__
  struct stat sst;
  if (stat(src->data, &sst) == 0 && chmod(dest->data, sst.st_mode & 07777) != 0)
    scr_fs_throw_errno_exception(errno, "cp", dest);
#endif
}

static void sync_on_link(const ScrFsCp *job, bool has_dest, const ScrStr *src, const ScrStr *dest, bool promise_form);

/* getStats for one path. A directory copied through the filter loop is
 * opened as a frame for the caller to walk (mkdirSync and opendirSync
 * done, true); everything else is handled here (false). */
static bool sync_stats_one(const ScrFsCp *job, const ScrStr *src, const ScrStr *dest, CpFrame *frame) {
  struct stat sst, dst;
  const char *op = job->dereference ? "stat" : "lstat";
  if (cp_stat(src, job->dereference, &sst) != 0) {
    scr_fs_throw(errno, op, src);
    return false;
  }
  bool has_dest = cp_stat(dest, job->dereference, &dst) == 0;
  if (!has_dest && errno != ENOENT && errno != ENOTDIR) {
    scr_fs_throw(errno, op, dest);
    return false;
  }
  if (S_ISDIR(sst.st_mode) && job->recursive) {
    if (has_dest && job->error_on_exist && !job->force) {
      cp_eexist(dest);
      return false;
    }
    if (!job->filter) {
      sync_copy_dir_native(job, src, dest);
      return false;
    }
    /* copyDir with a filter: mkdirSync, opendirSync, then the loop. */
    if (!has_dest && mkdir(dest->data, 0777) != 0) {
      scr_fs_throw(errno, "mkdir", dest);
      return false;
    }
    DIR *dir = opendir(src->data);
    if (!dir) {
      scr_fs_throw(errno, "opendir", src);
      return false;
    }
    *frame = (CpFrame){ dir, scr_str_retain((ScrStr *)src), scr_str_retain((ScrStr *)dest), !has_dest, sst.st_mode };
    return true;
  }
  if (S_ISREG(sst.st_mode) || S_ISCHR(sst.st_mode) || S_ISBLK(sst.st_mode)) {
    if (!has_dest) sync_copy_file(job, &sst, src, dest);
    else if (job->force) sync_override_file(job, src, dest);
    else if (job->error_on_exist) cp_eexist(dest);
  } else if (S_ISLNK(sst.st_mode)) {
    sync_on_link(job, has_dest, src, dest, false);
  } else {
    static const char message[] =
        "Unreachable code\nThis is caused by either a bug in Node.js or incorrect usage of Node.js internals.\n"
        "Please open an issue with this stack trace at https://github.com/nodejs/node/issues\n";
    scr_throw_error_msg_code(SCR_ERR_ERROR, message, sizeof message - 1, "ERR_INTERNAL_ASSERTION");
  }
  return false;
}

/* getStats, with cp-sync.js's filtered copyDir loop walked iteratively:
 * each directory's `finally` (closeSync, the timestamps when
 * preserveTimestamps, the source mode for a directory the loop created)
 * runs when the directory ends, normally or with an error. */
static void sync_get_stats(const ScrFsCp *job, const ScrStr *src, const ScrStr *dest) {
  CpFrame first;
  if (!sync_stats_one(job, src, dest, &first)) return;
  CpFrames frames = { NULL, 0, 0 };
  cp_frames_push(&frames, first.dir, first.src, first.dest, first.flag, first.mode);
  scr_str_release(first.src);
  scr_str_release(first.dest);
  while (frames.n) {
    CpFrame *top = &frames.v[frames.n - 1];
    struct dirent *entry = scr_exc_pending() ? NULL : readdir(top->dir);
    if (!entry) {
      CpFrame done = frames.v[--frames.n];
      closedir(done.dir);
      done.dir = NULL;
      ScrCaught *saved = scr_exc_pending() ? scr_exc_take() : NULL;
      if (job->preserve) (void)cp_set_dest_timestamps(done.src, done.dest);
      if (!scr_exc_pending() && done.flag) (void)cp_chmod(done.dest, done.mode);
      cp_finally_restore(saved);
      cp_frame_release(&done);
      continue;
    }
    if (!strcmp(entry->d_name, ".") || !strcmp(entry->d_name, "..")) continue;
    ScrStr *name = cp_str(entry->d_name);
    ScrStr *from = cp_join(top->src, name);
    ScrStr *to = cp_join(top->dest, name);
    bool copy = true;
    CpFrame child;
    if (cp_filter(job, from, to, false, &copy) && copy && sync_stats_one(job, from, to, &child)) {
      cp_frames_push(&frames, child.dir, child.src, child.dest, child.flag, child.mode);
      scr_str_release(child.src);
      scr_str_release(child.dest);
    }
    scr_str_release(name);
    scr_str_release(from);
    scr_str_release(to);
  }
  cp_frames_free(&frames);
}

/* onLink, shared by both implementations; they differ only in the stat
 * that guards the symlink-to-subdirectory check. */
static void sync_on_link(const ScrFsCp *job, bool has_dest, const ScrStr *src, const ScrStr *dest, bool promise_form) {
  int err = 0;
  ScrStr *resolved_src = cp_readlink(src, &err);
  if (!resolved_src) {
    scr_fs_throw(err, "readlink", src);
    return;
  }
  if (!job->verbatim && !cp_is_absolute(resolved_src)) {
    ScrStr *dir = scr_path_dirname((ScrStr *)src);
    ScrStr *resolved = cp_resolve(dir, resolved_src);
    scr_str_release(dir);
    scr_str_release(resolved_src);
    resolved_src = resolved;
  }
  struct stat ist;
  bool src_is_dir = stat(src->data, &ist) == 0 && S_ISDIR(ist.st_mode);
  if (has_dest) {
    ScrStr *resolved_dest = cp_readlink(dest, &err);
    if (!resolved_dest && err != EINVAL) {
      scr_fs_throw(err, "readlink", dest);
      scr_str_release(resolved_src);
      return;
    }
    if (resolved_dest) {
      if (!cp_is_absolute(resolved_dest)) {
        ScrStr *dir = scr_path_dirname((ScrStr *)dest);
        ScrStr *resolved = cp_resolve(dir, resolved_dest);
        scr_str_release(dir);
        scr_str_release(resolved_dest);
        resolved_dest = resolved;
      }
      bool fail = false;
      if (src_is_dir && cp_is_src_subdir(resolved_src, resolved_dest)) {
        cp_system("ERR_FS_CP_EINVAL", "Invalid src or dest", EINVAL, "cannot copy %s to a subdirectory of self %s",
                  resolved_src->data, resolved_dest->data, dest);
        fail = true;
      }
      struct stat gst;
      const ScrStr *guard = promise_form ? src : dest;
      if (!fail && stat(guard->data, &gst) != 0) {
        scr_fs_throw(errno, "stat", guard);
        fail = true;
      }
      if (!fail && S_ISDIR(gst.st_mode) && cp_is_src_subdir(resolved_dest, resolved_src)) {
        cp_system("ERR_FS_CP_SYMLINK_TO_SUBDIRECTORY", "Cannot overwrite symlink in subdirectory of self", EINVAL,
                  "cannot overwrite %s with %s", resolved_dest->data, resolved_src->data, dest);
        fail = true;
      }
      scr_str_release(resolved_dest);
      if (!fail && unlink(dest->data) != 0) {
        scr_fs_throw(errno, "unlink", dest);
        fail = true;
      }
      if (fail) {
        scr_str_release(resolved_src);
        return;
      }
    }
  }
  if (symlink(resolved_src->data, dest->data) != 0) scr_fs_throw2(errno, "symlink", resolved_src, dest);
  scr_str_release(resolved_src);
}

static void cp_sync(const ScrFsCp *job) {
  if (job->filter) {
    bool copy = true;
    if (!cp_filter(job, job->src, job->dest, false, &copy) || !copy) return;
  }
  if (!sync_check_paths(job, job->src, job->dest)) return;
  sync_get_stats(job, job->src, job->dest);
}

/* ── fs.cp and fs/promises cp (cp.js) ───────────────────────────────── */

typedef struct {
  bool skipped;
  bool has_dest;
  struct stat src, dest;
} CpChecked;

static bool async_get_stats_for_copy(const ScrFsCp *job, bool has_dest, const ScrStr *src, const ScrStr *dest);

/* checkPaths: the filter, then getStats and the identity, kind and
 * subdirectory checks. */
static bool async_check_paths(const ScrFsCp *job, const ScrStr *src, const ScrStr *dest, CpChecked *out) {
  out->skipped = false;
  if (job->filter) {
    bool copy = true;
    if (!cp_filter(job, src, dest, true, &copy)) return false;
    if (!copy) {
      out->skipped = true;
      return true;
    }
  }
  const char *op = job->dereference ? "stat" : "lstat";
  if (cp_stat(src, job->dereference, &out->src) != 0) {
    scr_fs_throw(errno, op, src);
    return false;
  }
  out->has_dest = cp_stat(dest, job->dereference, &out->dest) == 0;
  if (!out->has_dest && errno != ENOENT) {
    scr_fs_throw(errno, op, dest);
    return false;
  }
  bool src_dir = S_ISDIR(out->src.st_mode);
  if (out->has_dest) {
    if (out->dest.st_ino && out->dest.st_dev && out->dest.st_ino == out->src.st_ino &&
        out->dest.st_dev == out->src.st_dev) {
      cp_system("ERR_FS_CP_EINVAL", "Invalid src or dest", EINVAL, "%s", "src and dest cannot be the same", NULL, dest);
      return false;
    }
    bool dest_dir = S_ISDIR(out->dest.st_mode);
    if (src_dir && !dest_dir) {
      cp_system("ERR_FS_CP_DIR_TO_NON_DIR", "Cannot overwrite non-directory with directory", EISDIR,
                "cannot overwrite non-directory %s with directory %s", dest->data, src->data, dest);
      return false;
    }
    if (!src_dir && dest_dir) {
      cp_system("ERR_FS_CP_NON_DIR_TO_DIR", "Cannot overwrite directory with non-directory", ENOTDIR,
                "cannot overwrite directory %s with non-directory %s", dest->data, src->data, dest);
      return false;
    }
  }
  if (src_dir && cp_is_src_subdir(src, dest)) {
    cp_system("ERR_FS_CP_EINVAL", "Invalid src or dest", EINVAL, "cannot copy %s to a subdirectory of self %s", src->data,
              dest->data, dest);
    return false;
  }
  return true;
}

/* checkParentPaths: no parent of dest is src itself. */
static bool async_check_parent_paths(const ScrStr *src, const struct stat *sst, const ScrStr *dest) {
  ScrStr *src_dir = scr_path_dirname((ScrStr *)src);
  ScrStr *dest_dir = scr_path_dirname((ScrStr *)dest);
  ScrStr *src_parent = cp_resolve1(src_dir);
  ScrStr *dest_parent = cp_resolve1(dest_dir);
  scr_str_release(src_dir);
  scr_str_release(dest_dir);
  bool ok = true;
  bool done = cp_str_eq(src_parent, dest_parent) || (dest_parent->len == 1 && dest_parent->data[0] == '/');
  struct stat st;
  if (!done) {
    if (stat(dest_parent->data, &st) != 0) {
      if (errno != ENOENT) {
        scr_fs_throw(errno, "stat", dest_parent);
        ok = false;
      }
    } else if (st.st_ino && st.st_dev && st.st_ino == sst->st_ino && st.st_dev == sst->st_dev) {
      cp_system("ERR_FS_CP_EINVAL", "Invalid src or dest", EINVAL, "cannot copy %s to a subdirectory of self %s", src->data,
                dest->data, dest);
      ok = false;
    } else {
      ok = async_check_parent_paths(src, sst, dest_parent);
    }
  }
  scr_str_release(src_parent);
  scr_str_release(dest_parent);
  return ok;
}

static bool async_set_dest_mode(const ScrStr *dest, mode_t mode) { return cp_chmod(dest, mode); }

static bool async_copy_file(const ScrFsCp *job, mode_t src_mode, const ScrStr *src, const ScrStr *dest) {
  cp_copyfile(src, dest, job->mode, "copyfile");
  if (scr_exc_pending()) return false;
  if (job->preserve) {
    if ((src_mode & 0200) == 0 && !async_set_dest_mode(dest, src_mode | 0200)) return false;
    if (!cp_set_dest_timestamps(src, dest)) return false;
  }
  return async_set_dest_mode(dest, src_mode);
}

/* getStatsForCopy for one path. A directory to copy is opened as a frame
 * for the caller to walk (true; mkdir done when dest was absent);
 * everything else is handled here (false, with any error pending). */
static bool async_stats_one(const ScrFsCp *job, bool has_dest, const ScrStr *src, const ScrStr *dest, CpFrame *frame) {
  struct stat sst;
  if (cp_stat(src, job->dereference, &sst) != 0) {
    scr_fs_throw(errno, job->dereference ? "stat" : "lstat", src);
    return false;
  }
  if (S_ISDIR(sst.st_mode) && job->recursive) {
    if (!has_dest) {
      if (mkdir(dest->data, 0777) != 0) {
        scr_fs_throw(errno, "mkdir", dest);
        return false;
      }
    } else if (job->error_on_exist && !job->force) {
      cp_eexist(dest);
      return false;
    }
    DIR *dir = opendir(src->data);
    if (!dir) {
      scr_fs_throw(errno, "opendir", src);
      return false;
    }
    *frame = (CpFrame){ dir, scr_str_retain((ScrStr *)src), scr_str_retain((ScrStr *)dest), !has_dest, sst.st_mode };
    return true;
  }
  if (S_ISDIR(sst.st_mode)) {
    cp_system("ERR_FS_EISDIR", "Path is a directory", EISDIR, "%s is a directory (not copied)", src->data, NULL, src);
  } else if (S_ISREG(sst.st_mode) || S_ISCHR(sst.st_mode) || S_ISBLK(sst.st_mode)) {
    if (!has_dest) {
      (void)async_copy_file(job, sst.st_mode, src, dest);
    } else if (job->force) {
      if (unlink(dest->data) != 0) scr_fs_throw(errno, "unlink", dest);
      else (void)async_copy_file(job, sst.st_mode, src, dest);
    } else if (job->error_on_exist) {
      cp_eexist(dest);
    }
  } else if (S_ISLNK(sst.st_mode)) {
    sync_on_link(job, has_dest, src, dest, true);
  } else if (S_ISSOCK(sst.st_mode)) {
    cp_system("ERR_FS_CP_SOCKET", "Cannot copy a socket file", EINVAL, "cannot copy a socket file: %s", dest->data, NULL,
              dest);
  } else if (S_ISFIFO(sst.st_mode)) {
    cp_system("ERR_FS_CP_FIFO_PIPE", "Cannot copy a FIFO pipe", EINVAL, "cannot copy a FIFO pipe: %s", dest->data, NULL,
              dest);
  } else {
    cp_system("ERR_FS_CP_UNKNOWN", "Cannot copy an unknown file type", EINVAL, "cannot copy an unknown file type: %s",
              dest->data, NULL, dest);
  }
  return false;
}

/* getStatsForCopy, with cp.js's copyDir walked iteratively: each entry
 * goes through checkPaths, and a finished directory gets the source
 * timestamps (preserveTimestamps) and, when the walk created it, the
 * source mode. An error ends the walk without those steps. */
static bool async_get_stats_for_copy(const ScrFsCp *job, bool has_dest, const ScrStr *src, const ScrStr *dest) {
  CpFrame first;
  if (!async_stats_one(job, has_dest, src, dest, &first)) return !scr_exc_pending();
  CpFrames frames = { NULL, 0, 0 };
  cp_frames_push(&frames, first.dir, first.src, first.dest, first.flag, first.mode);
  scr_str_release(first.src);
  scr_str_release(first.dest);
  bool ok = true;
  while (ok && frames.n) {
    CpFrame *top = &frames.v[frames.n - 1];
    struct dirent *entry = readdir(top->dir);
    if (!entry) {
      CpFrame done = frames.v[--frames.n];
      if (job->preserve && !cp_set_dest_timestamps(done.src, done.dest)) ok = false;
      if (ok && done.flag && !async_set_dest_mode(done.dest, done.mode)) ok = false;
      cp_frame_release(&done);
      continue;
    }
    if (!strcmp(entry->d_name, ".") || !strcmp(entry->d_name, "..")) continue;
    ScrStr *name = cp_str(entry->d_name);
    ScrStr *from = cp_join(top->src, name);
    ScrStr *to = cp_join(top->dest, name);
    CpChecked checked;
    CpFrame child;
    if (!async_check_paths(job, from, to, &checked)) {
      ok = false;
    } else if (!checked.skipped) {
      if (async_stats_one(job, checked.has_dest, from, to, &child)) {
        cp_frames_push(&frames, child.dir, child.src, child.dest, child.flag, child.mode);
        scr_str_release(child.src);
        scr_str_release(child.dest);
      } else if (scr_exc_pending()) {
        ok = false;
      }
    }
    scr_str_release(name);
    scr_str_release(from);
    scr_str_release(to);
  }
  cp_frames_free(&frames);
  return ok;
}

static void cp_async(const ScrFsCp *job) {
  CpChecked checked;
  if (!async_check_paths(job, job->src, job->dest, &checked) || checked.skipped) return;
  if (!async_check_parent_paths(job->src, &checked.src, job->dest)) return;
  /* checkParentDir */
  ScrStr *parent = scr_path_dirname(job->dest);
  struct stat st;
  if (stat(parent->data, &st) != 0) {
    if (errno != ENOENT) {
      scr_fs_throw(errno, "stat", parent);
      scr_str_release(parent);
      return;
    }
    scr_fs_mkdir_recursive_mode(parent, 0777);
    if (scr_exc_pending()) {
      scr_str_release(parent);
      return;
    }
  }
  scr_str_release(parent);
  (void)async_get_stats_for_copy(job, checked.has_dest, job->src, job->dest);
}

void scr_fs_cp_run(ScrFsCp *job, bool promise_form) {
  if (promise_form) cp_async(job);
  else cp_sync(job);
}

#endif

void scr_fs_cp_sync(const ScrDyn *src, const ScrDyn *dest, const ScrDyn *options) {
  ScrFsCp *job = scr_fs_cp_begin(src, dest, options);
  if (!job) return;
  scr_fs_cp_run(job, false);
  scr_fs_cp_free(job);
}

ScrPromise *scr_fsp_cp(const ScrDyn *src, const ScrDyn *dest, const ScrDyn *options) {
  ScrFsCp *job = scr_fs_cp_begin(src, dest, options);
  if (job) scr_fs_cp_run(job, true);
  scr_fs_cp_free(job);
  return scr_promise_settled_void();
}
