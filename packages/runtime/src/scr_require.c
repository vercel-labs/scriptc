/* createRequire's require(id) and require.resolve(request) with a specifier
 * computed at run time (module-resolution.ts lowers both calls here).
 *
 * The compiled module graph is fixed at build time, so neither call loads a
 * module. Both resolve the specifier with Node 24's CommonJS algorithm
 * (lib/internal/modules/cjs/loader.js: Module._resolveFilename and
 * Module._findPath, with package.json "main", "exports" and self-reference)
 * against the file system at run time:
 *
 * - require.resolve returns what Node returns: the builtin's id, or the real
 *   path of the resolved file. It throws Node's MODULE_NOT_FOUND error when
 *   nothing resolves.
 * - require throws the same MODULE_NOT_FOUND error when nothing resolves, so
 *   packages that probe for optional files take their absent branch as in
 *   Node. When the specifier resolves (a builtin, or a file such as a native
 *   addon), Node would load the module, which a compiled program cannot do:
 *   the program ends with an SC2020 refusal naming the module. The refusal is
 *   not an exception, so a `catch` clause cannot take a fallback that Node
 *   would not take.
 *
 * Resolution steps whose Node result this file does not reproduce (package
 * "imports", invalid package configs or export targets, unexported subpaths,
 * percent-encoded export targets, an export target that names no file, a
 * "main" that names no file) end the program with the same SC2020 refusal,
 * naming the step. */
#include "scr_runtime.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef struct {
  ScrStr *request;  /* borrowed */
  ScrStr *importer; /* borrowed: the requiring file */
  ScrArr *builtins; /* borrowed: Node 24's require-able builtin ids */
  /* Set when resolution reaches a step it does not reproduce; the caller
   * refuses with this reason. Static text. */
  const char *refusal;
} ScrRequire;

static ScrStr *req_cstr(const char *s) { return scr_str_new(s, strlen(s)); }

static bool req_has_prefix(const ScrStr *s, const char *prefix) {
  size_t n = strlen(prefix);
  return s->len >= n && memcmp(s->data, prefix, n) == 0;
}

static bool req_has_suffix(const ScrStr *s, const char *suffix) {
  size_t n = strlen(suffix);
  return s->len >= n && memcmp(s->data + s->len - n, suffix, n) == 0;
}

static bool req_eq(const ScrStr *s, const char *text) {
  size_t n = strlen(text);
  return s->len == n && memcmp(s->data, text, n) == 0;
}

static ScrStr *req_concat(const ScrStr *a, const char *b, size_t b_len) {
  ScrJsonBuf out;
  scr_jb_init(&out);
  scr_jb_write(&out, a->data, a->len);
  scr_jb_write(&out, b, b_len);
  return scr_jb_finish(&out);
}

static ScrStr *req_resolve2(ScrStr *a, ScrStr *b) {
  ScrArr *parts = scr_arr_new(SCR_ELEM_STR, 2);
  scr_arr_push_ref(parts, scr_str_retain(a));
  scr_arr_push_ref(parts, scr_str_retain(b));
#ifdef _WIN32
  ScrStr *out = scr_path_win32_resolve(parts);
#else
  ScrStr *out = scr_path_resolve(parts);
#endif
  scr_arr_release(parts);
  return out;
}

static ScrStr *req_dirname(ScrStr *path) {
#ifdef _WIN32
  return scr_path_win32_dirname(path);
#else
  return scr_path_dirname(path);
#endif
}

static bool req_is_absolute(ScrStr *path) {
#ifdef _WIN32
  return scr_path_win32_is_absolute(path);
#else
  return scr_path_is_absolute(path);
#endif
}

/* Node's internalModuleStat: 0 for a file, 1 for a directory, -1 when the
 * path does not exist or cannot be read. Never throws. */
static int req_stat(ScrStr *path) {
  ScrStats *stats = scr_fs_stat_probe(path, false, false);
  if (stats == NULL) {
    if (scr_exc_pending()) scr_exc_clear();
    return -1;
  }
  int kind = scr_stats_is_dir(stats) ? 1 : 0;
  scr_stats_release(stats);
  return kind;
}

/* tryFile: the real path of `path` when it is a file (+1), else NULL. */
static ScrStr *req_try_file(ScrStr *path) {
  if (req_stat(path) != 0) return NULL;
  ScrStr *real = scr_fs_realpath(path);
  if (real != NULL) return real;
  if (scr_exc_pending()) scr_exc_clear();
  return scr_str_retain(path);
}

/* tryExtensions with Module._extensions' keys, in registration order. */
static ScrStr *req_try_extensions(ScrStr *base) {
  static const char *const extensions[] = { ".js", ".json", ".node" };
  for (size_t i = 0; i < sizeof extensions / sizeof extensions[0]; i++) {
    ScrStr *candidate = req_concat(base, extensions[i], strlen(extensions[i]));
    ScrStr *found = req_try_file(candidate);
    scr_str_release(candidate);
    if (found != NULL) return found;
  }
  return NULL;
}

/* ── package.json ────────────────────────────────────────────────────── */

/* The package.json at `pjson` parsed (+1), or NULL when there is none.
 * A file Node rejects as an invalid package config (unparsable JSON, a
 * non-object document, a non-string "name" or "type") sets the refusal. */
static ScrDyn *req_read_package(ScrRequire *r, ScrStr *pjson) {
  if (req_stat(pjson) != 0) return NULL;
  ScrStr *text = scr_fs_read_file(pjson);
  if (text == NULL) {
    if (scr_exc_pending()) scr_exc_clear();
    return NULL;
  }
  /* Node's reader skips a leading UTF-8 byte order mark. */
  if (text->len >= 3 && (unsigned char)text->data[0] == 0xEF &&
      (unsigned char)text->data[1] == 0xBB && (unsigned char)text->data[2] == 0xBF) {
    ScrStr *body = scr_str_new(text->data + 3, text->len - 3);
    scr_str_release(text);
    text = body;
  }
  ScrDyn *pkg = scr_json_parse(text);
  scr_str_release(text);
  if (pkg == NULL) {
    if (scr_exc_pending()) scr_exc_clear();
    r->refusal = "a package.json that is not valid JSON";
    return NULL;
  }
  const ScrDyn *name = pkg->kind == SCR_DYN_OBJ ? scr_dyn_obj_get(pkg, "name", 4) : NULL;
  const ScrDyn *type = pkg->kind == SCR_DYN_OBJ ? scr_dyn_obj_get(pkg, "type", 4) : NULL;
  if (pkg->kind != SCR_DYN_OBJ || (name != NULL && name->kind != SCR_DYN_STR) ||
      (type != NULL && type->kind != SCR_DYN_STR)) {
    scr_dyn_release(pkg);
    r->refusal = "an invalid package.json";
    return NULL;
  }
  return pkg;
}

/* A string field of a parsed package.json (borrowed), or NULL. */
static ScrStr *req_package_string(const ScrDyn *pkg, const char *key) {
  const ScrDyn *value = scr_dyn_obj_get(pkg, key, strlen(key));
  return value != NULL && value->kind == SCR_DYN_STR ? value->v.str : NULL;
}

/* "exports" or "imports" as Node keeps them: a string, an object or an
 * array (borrowed); NULL for every other value. */
static const ScrDyn *req_package_map(const ScrDyn *pkg, const char *key) {
  const ScrDyn *value = scr_dyn_obj_get(pkg, key, strlen(key));
  if (value == NULL) return NULL;
  return value->kind == SCR_DYN_STR || value->kind == SCR_DYN_OBJ || value->kind == SCR_DYN_ARR ? value : NULL;
}

/* tryPackage: a directory's "main" entry, then its index files. */
static ScrStr *req_try_package(ScrRequire *r, ScrStr *dir) {
  ScrStr *pjson_name = req_cstr("package.json");
  ScrStr *pjson = req_resolve2(dir, pjson_name);
  scr_str_release(pjson_name);
  ScrDyn *pkg = req_read_package(r, pjson);
  scr_str_release(pjson);
  if (r->refusal != NULL) return NULL;
  ScrStr *main = pkg != NULL ? req_package_string(pkg, "main") : NULL;
  ScrStr *index_name = req_cstr("index");
  ScrStr *index = req_resolve2(dir, index_name);
  ScrStr *found = NULL;
  if (main == NULL) {
    found = req_try_extensions(index);
  } else {
    ScrStr *filename = req_resolve2(dir, main);
    found = req_try_file(filename);
    if (found == NULL) found = req_try_extensions(filename);
    if (found == NULL) {
      ScrStr *main_index = req_resolve2(filename, index_name);
      found = req_try_extensions(main_index);
      scr_str_release(main_index);
    }
    scr_str_release(filename);
    if (found == NULL) {
      /* Node falls back to the index with a DEP0128 warning, or throws an
       * error that names the "main" entry. */
      r->refusal = "a package.json \"main\" entry that names no file";
    }
  }
  scr_str_release(index);
  scr_str_release(index_name);
  if (pkg != NULL) scr_dyn_release(pkg);
  return found;
}

/* ── package exports (lib/internal/modules/esm/resolve.js) ───────────── */

/* A target or subpath segment Node rejects or warns about: "", ".", "..",
 * "node_modules" in any case, and their percent-encoded spellings. The
 * caller refuses '%' separately, so the plain spellings suffice. */
static bool req_invalid_segment(const char *s, size_t len) {
  size_t start = 0;
  for (size_t i = 0; i <= len; i++) {
    if (i < len && s[i] != '/' && s[i] != '\\') continue;
    size_t n = i - start;
    const char *seg = s + start;
    if (n == 0 && i < len) return true;
    if ((n == 1 && seg[0] == '.') || (n == 2 && seg[0] == '.' && seg[1] == '.')) return true;
    if (n == 12) {
      static const char nm[] = "node_modules";
      bool same = true;
      for (size_t k = 0; k < 12 && same; k++) {
        char c = seg[k];
        if (c >= 'A' && c <= 'Z') c = (char)(c - 'A' + 'a');
        same = c == nm[k];
      }
      if (same) return true;
    }
    start = i + 1;
  }
  return false;
}

/* Characters whose URL parsing changes the path Node resolves: percent
 * escapes, backslashes, query and fragment delimiters, and the control
 * characters the URL parser strips. */
static bool req_url_sensitive(const char *s, size_t len) {
  for (size_t i = 0; i < len; i++) {
    unsigned char c = (unsigned char)s[i];
    if (c == '%' || c == '\\' || c == '?' || c == '#' || c < 0x20 || c == 0x7f) return true;
  }
  return false;
}

typedef enum { REQ_TARGET_PATH, REQ_TARGET_NULL, REQ_TARGET_UNDEFINED, REQ_TARGET_INVALID } ScrRequireTarget;

static bool req_condition(const ScrStr *key) {
  return req_eq(key, "default") || req_eq(key, "require") || req_eq(key, "node") ||
         req_eq(key, "node-addons") || req_eq(key, "module-sync");
}

static bool req_array_index(const ScrStr *key) {
  if (key->len == 0 || key->len > 10) return false;
  if (key->len > 1 && key->data[0] == '0') return false;
  double n = 0;
  for (size_t i = 0; i < key->len; i++) {
    if (key->data[i] < '0' || key->data[i] > '9') return false;
    n = n * 10 + (key->data[i] - '0');
  }
  return n < 4294967295.0;
}

/* resolvePackageTarget for an "exports" target. `pkg_dir` is the package
 * directory, `subpath` the part the target receives. A path result is in
 * `*out` (+1, not yet checked against the file system). */
static ScrRequireTarget req_resolve_target(ScrRequire *r, ScrStr *pkg_dir, const ScrDyn *target,
                                           const char *subpath, size_t subpath_len, bool pattern,
                                           ScrStr **out) {
  if (target->kind == SCR_DYN_STR) {
    ScrStr *t = target->v.str;
    if (subpath_len != 0 && !pattern && !req_has_suffix(t, "/")) return REQ_TARGET_INVALID;
    if (!req_has_prefix(t, "./")) return REQ_TARGET_INVALID;
    if (req_url_sensitive(t->data, t->len) || req_url_sensitive(subpath, subpath_len) ||
        req_invalid_segment(t->data + 2, t->len - 2) ||
        (subpath_len != 0 && req_invalid_segment(subpath, subpath_len))) {
      r->refusal = "a package \"exports\" target that Node rejects, warns about or decodes";
      return REQ_TARGET_INVALID;
    }
    if (pattern && memchr(pkg_dir->data, '*', pkg_dir->len) != NULL) {
      /* Node substitutes the pattern in the whole URL, directory included. */
      r->refusal = "a package \"exports\" pattern in a directory whose path contains '*'";
      return REQ_TARGET_INVALID;
    }
    ScrJsonBuf path;
    scr_jb_init(&path);
    scr_jb_write(&path, pkg_dir->data, pkg_dir->len);
    const char *rest = t->data + 1; /* keeps the '/' after "." */
    size_t rest_len = t->len - 1;
    if (pattern) {
      for (size_t i = 0; i < rest_len; i++) {
        if (rest[i] == '*')
          scr_jb_write(&path, subpath, subpath_len);
        else
          scr_jb_putc(&path, rest[i]);
      }
    } else {
      scr_jb_write(&path, rest, rest_len);
      scr_jb_write(&path, subpath, subpath_len);
    }
    ScrStr *joined = scr_jb_finish(&path);
#ifdef _WIN32
    *out = scr_path_win32_normalize(joined);
#else
    *out = scr_path_normalize(joined);
#endif
    scr_str_release(joined);
    return REQ_TARGET_PATH;
  }
  if (target->kind == SCR_DYN_ARR) {
    double n = scr_dyn_arr_len(target);
    if (n == 0) return REQ_TARGET_NULL;
    ScrRequireTarget last = REQ_TARGET_UNDEFINED;
    for (double i = 0; i < n; i++) {
      ScrDyn *item = scr_dyn_arr_at(target, i);
      ScrRequireTarget result = req_resolve_target(r, pkg_dir, item, subpath, subpath_len, pattern, out);
      scr_dyn_release(item);
      if (r->refusal != NULL) return REQ_TARGET_INVALID;
      if (result == REQ_TARGET_PATH) return result;
      if (result == REQ_TARGET_INVALID) last = REQ_TARGET_INVALID;
      else if (result == REQ_TARGET_NULL) last = REQ_TARGET_NULL;
    }
    return last == REQ_TARGET_UNDEFINED ? REQ_TARGET_UNDEFINED : last;
  }
  if (target->kind == SCR_DYN_OBJ) {
    ScrDyn *keys = scr_dyn_obj_own_keys(target);
    double n = scr_dyn_arr_len(keys);
    ScrRequireTarget result = REQ_TARGET_UNDEFINED;
    for (double i = 0; i < n; i++) {
      ScrDyn *key = scr_dyn_arr_at(keys, i);
      bool index = req_array_index(key->v.str);
      scr_dyn_release(key);
      if (index) {
        r->refusal = "numeric keys in a package's \"exports\"";
        scr_dyn_release(keys);
        return REQ_TARGET_INVALID;
      }
    }
    for (double i = 0; i < n && result == REQ_TARGET_UNDEFINED; i++) {
      ScrDyn *key = scr_dyn_arr_at(keys, i);
      if (req_condition(key->v.str)) {
        const ScrDyn *value = scr_dyn_obj_get(target, key->v.str->data, key->v.str->len);
        result = req_resolve_target(r, pkg_dir, value, subpath, subpath_len, pattern, out);
        if (r->refusal != NULL) result = REQ_TARGET_INVALID;
      }
      scr_dyn_release(key);
    }
    scr_dyn_release(keys);
    return result;
  }
  if (target->kind == SCR_DYN_NULL) return REQ_TARGET_NULL;
  return REQ_TARGET_INVALID;
}

/* patternKeyCompare(a, b) === 1: `b` is the better pattern match. */
static bool req_pattern_better(const ScrStr *a, const ScrStr *b) {
  const char *as = a ? memchr(a->data, '*', a->len) : NULL;
  const char *bs = memchr(b->data, '*', b->len);
  size_t a_len = a ? a->len : 0;
  size_t base_a = as ? (size_t)(as - a->data) + 1 : a_len;
  size_t base_b = bs ? (size_t)(bs - b->data) + 1 : b->len;
  if (base_a > base_b) return false;
  if (base_b > base_a) return true;
  if (as == NULL) return true;
  if (bs == NULL) return false;
  return b->len > a_len;
}

/* packageExportsResolve for `subpath` ("." or "./..."), then
 * finalizeEsmResolution's file check. +1 real path, or NULL with the
 * refusal set. */
static ScrStr *req_exports_resolve(ScrRequire *r, ScrStr *pkg_dir, const ScrDyn *exports, ScrStr *subpath) {
  bool sugar;
  if (exports->kind != SCR_DYN_OBJ) {
    sugar = true;
  } else {
    sugar = false;
    ScrDyn *keys = scr_dyn_obj_own_keys(exports);
    double n = scr_dyn_arr_len(keys);
    for (double i = 0; i < n; i++) {
      ScrDyn *key = scr_dyn_arr_at(keys, i);
      bool conditional = key->v.str->len == 0 || key->v.str->data[0] != '.';
      scr_dyn_release(key);
      if (i == 0) {
        sugar = conditional;
      } else if (sugar != conditional) {
        scr_dyn_release(keys);
        r->refusal = "a package \"exports\" object that mixes subpaths and conditions";
        return NULL;
      }
    }
    scr_dyn_release(keys);
  }
  if (exports->kind == SCR_DYN_STR && exports->v.str->len > 0 &&
      (exports->v.str->data[0] == '[' || exports->v.str->data[0] == '{')) {
    r->refusal = "a package \"exports\" string that Node parses as JSON";
    return NULL;
  }
  ScrStr *path = NULL;
  ScrRequireTarget result = REQ_TARGET_UNDEFINED;
  bool has_star = memchr(subpath->data, '*', subpath->len) != NULL;
  if (sugar) {
    if (req_eq(subpath, "."))
      result = req_resolve_target(r, pkg_dir, exports, "", 0, false, &path);
  } else {
    const ScrDyn *exact = has_star || req_has_suffix(subpath, "/")
                              ? NULL
                              : scr_dyn_obj_get(exports, subpath->data, subpath->len);
    if (exact != NULL) {
      result = req_resolve_target(r, pkg_dir, exact, "", 0, false, &path);
    } else {
      ScrStr *best = NULL;
      size_t best_start = 0, best_end = 0;
      ScrDyn *keys = scr_dyn_obj_own_keys(exports);
      double n = scr_dyn_arr_len(keys);
      for (double i = 0; i < n; i++) {
        ScrDyn *key_value = scr_dyn_arr_at(keys, i);
        ScrStr *key = key_value->v.str;
        const char *star = memchr(key->data, '*', key->len);
        size_t at = star ? (size_t)(star - key->data) : 0;
        if (star != NULL && subpath->len >= at && memcmp(subpath->data, key->data, at) == 0) {
          size_t trailer = key->len - at - 1;
          bool single = memchr(star + 1, '*', trailer) == NULL;
          if (subpath->len >= key->len &&
              memcmp(subpath->data + subpath->len - trailer, star + 1, trailer) == 0 &&
              req_pattern_better(best, key) && single) {
            if (best) scr_str_release(best);
            best = scr_str_retain(key);
            best_start = at;
            best_end = subpath->len - trailer;
          }
        }
        scr_dyn_release(key_value);
      }
      scr_dyn_release(keys);
      if (best != NULL) {
        if (req_has_suffix(subpath, "/")) {
          r->refusal = "a package \"exports\" pattern matched by a subpath ending in '/'";
        } else {
          const ScrDyn *target = scr_dyn_obj_get(exports, best->data, best->len);
          result = req_resolve_target(r, pkg_dir, target, subpath->data + best_start,
                                      best_end - best_start, true, &path);
        }
        scr_str_release(best);
      }
    }
  }
  if (r->refusal != NULL) {
    if (path) scr_str_release(path);
    return NULL;
  }
  if (result != REQ_TARGET_PATH) {
    r->refusal = result == REQ_TARGET_INVALID ? "an invalid package \"exports\" target"
                                              : "a subpath that the package's \"exports\" do not export";
    return NULL;
  }
  ScrStr *found = req_try_file(path);
  scr_str_release(path);
  if (found == NULL) r->refusal = "a package \"exports\" target that names no file";
  return found;
}

/* ── Module._findPath ────────────────────────────────────────────────── */

/* EXPORTS_PATTERN: /^((?:@[^/\\%]+\/)?[^./\\%][^/\\%]*)(\/.*)?$/ — the
 * package name's length in `request`, or 0 when it does not match. */
static size_t req_package_name_len(const ScrStr *request) {
  const char *s = request->data;
  size_t len = request->len, i = 0;
  if (len > 0 && s[0] == '@') {
    i = 1;
    size_t start = i;
    while (i < len && s[i] != '/' && s[i] != '\\' && s[i] != '%') i++;
    if (i == start || i >= len || s[i] != '/') i = 0;
    else i++;
  }
  if (i >= len || s[i] == '.' || s[i] == '/' || s[i] == '\\' || s[i] == '%') return 0;
  while (i < len && s[i] != '/' && s[i] != '\\' && s[i] != '%') i++;
  if (i < len && s[i] != '/') return 0;
  return i;
}

/* resolveExports: a package under `nm_dir` whose package.json has
 * "exports". +1 real path; NULL when the package has no "exports" (or the
 * refusal is set). */
static ScrStr *req_resolve_exports(ScrRequire *r, ScrStr *nm_dir) {
  size_t name_len = req_package_name_len(r->request);
  if (name_len == 0) return NULL;
  ScrStr *name = scr_str_new(r->request->data, name_len);
  ScrStr *pkg_dir = req_resolve2(nm_dir, name);
  scr_str_release(name);
  ScrStr *pjson = req_concat(pkg_dir, "/package.json", 13);
  ScrDyn *pkg = req_read_package(r, pjson);
  scr_str_release(pjson);
  ScrStr *found = NULL;
  const ScrDyn *exports = pkg != NULL ? req_package_map(pkg, "exports") : NULL;
  if (exports != NULL) {
    ScrJsonBuf sub;
    scr_jb_init(&sub);
    scr_jb_putc(&sub, '.');
    scr_jb_write(&sub, r->request->data + name_len, r->request->len - name_len);
    ScrStr *subpath = scr_jb_finish(&sub);
    found = req_exports_resolve(r, pkg_dir, exports, subpath);
    scr_str_release(subpath);
  }
  if (pkg != NULL) scr_dyn_release(pkg);
  scr_str_release(pkg_dir);
  return found;
}

/* isRelative in Module._findPath: ".", "..", and "./" or "../" prefixes. */
static bool req_is_relative(const ScrStr *request) {
  if (req_eq(request, ".") || req_eq(request, "..")) return true;
  if (req_has_prefix(request, "./") || req_has_prefix(request, "../")) return true;
#ifdef _WIN32
  if (req_has_prefix(request, ".\\") || req_has_prefix(request, "..\\")) return true;
#endif
  return false;
}

static bool req_trailing_slash(const ScrStr *request) {
  const char *s = request->data;
  size_t n = request->len;
  if (n == 0) return false;
  if (s[n - 1] == '/') return true;
  if (s[n - 1] != '.') return false;
  if (n == 1 || s[n - 2] == '/') return true;
  return s[n - 2] == '.' && (n == 2 || s[n - 3] == '/');
}

/* Module._findPath over `paths` (borrowed strings). +1 real path or NULL. */
static ScrStr *req_find_path(ScrRequire *r, ScrStr *const *paths, size_t count) {
  ScrStr *request = r->request;
  bool absolute = req_is_absolute(request);
  ScrStr *empty = NULL;
  if (absolute) {
    empty = scr_str_new("", 0);
    paths = &empty;
    count = 1;
  }
  bool trailing = req_trailing_slash(request);
  bool inside = true;
  if (req_is_relative(request)) {
#ifdef _WIN32
    ScrStr *normalized = scr_path_win32_normalize(request);
#else
    ScrStr *normalized = scr_path_normalize(request);
#endif
    inside = !req_has_prefix(normalized, "..");
    scr_str_release(normalized);
  }
  ScrStr *found = NULL;
  for (size_t i = 0; i < count && found == NULL && r->refusal == NULL; i++) {
    ScrStr *dir = paths[i];
    if (inside && dir->len > 0 && req_stat(dir) < 1) continue;
    if (!absolute) {
      found = req_resolve_exports(r, dir);
      if (found != NULL || r->refusal != NULL) break;
    }
    ScrStr *base = req_resolve2(dir, request);
    int kind = req_stat(base);
    if (!trailing) {
      if (kind == 0) found = req_try_file(base);
      if (found == NULL) found = req_try_extensions(base);
    }
    if (found == NULL && kind == 1) found = req_try_package(r, base);
    scr_str_release(base);
  }
  if (empty) scr_str_release(empty);
  return found;
}

/* Module._nodeModulePaths(from) followed by Module.globalPaths' entries
 * that come from the environment (NODE_PATH, then the home directory's
 * .node_modules and .node_libraries). Node also searches the lib/node
 * directory of its own installation prefix, which a compiled program does
 * not have. Fills `out` (+1 each) and answers the count. */
static size_t req_lookup_paths(ScrStr *from, ScrStr ***out) {
  size_t cap = 16, n = 0;
  ScrStr **paths = malloc(cap * sizeof *paths);
  if (!paths) scr_trap("scriptc: out of memory\n");
#define REQ_PUSH(value)                                                   \
  do {                                                                    \
    if (n == cap) {                                                       \
      cap *= 2;                                                           \
      ScrStr **grown = realloc(paths, cap * sizeof *paths);               \
      if (!grown) scr_trap("scriptc: out of memory\n");                   \
      paths = grown;                                                      \
    }                                                                     \
    paths[n++] = (value);                                                 \
  } while (0)
  ScrStr *dot = scr_str_new(".", 1);
  ScrStr *abs = req_resolve2(from, dot);
  scr_str_release(dot);
  static const char nm[] = "node_modules";
  const char *s = abs->data;
#ifdef _WIN32
  if (abs->len >= 2 && s[abs->len - 1] == '\\' && s[abs->len - 2] == ':') {
    REQ_PUSH(req_concat(abs, "node_modules", 12));
  } else {
    for (long i = (long)abs->len - 1, p = 0, last = (long)abs->len; i >= 0; --i) {
      char c = s[i];
      if (c == '\\' || c == '/' || c == ':') {
        if (p != 12) {
          ScrStr *prefix = scr_str_new(s, (size_t)last);
          REQ_PUSH(req_concat(prefix, "\\node_modules", 13));
          scr_str_release(prefix);
        }
        last = i;
        p = 0;
      } else if (p != -1) {
        p = (p < 12 && nm[11 - p] == c) ? p + 1 : -1;
      }
    }
  }
#else
  if (abs->len == 1 && s[0] == '/') {
    REQ_PUSH(scr_str_new("/node_modules", 13));
  } else {
    for (long i = (long)abs->len - 1, p = 0, last = (long)abs->len; i >= 0; --i) {
      char c = s[i];
      if (c == '/') {
        if (p != 12) {
          ScrStr *prefix = scr_str_new(s, (size_t)last);
          REQ_PUSH(req_concat(prefix, "/node_modules", 13));
          scr_str_release(prefix);
        }
        last = i;
        p = 0;
      } else if (p != -1) {
        p = (p < 12 && nm[11 - p] == c) ? p + 1 : -1;
      }
    }
    REQ_PUSH(scr_str_new("/node_modules", 13));
  }
#endif
  scr_str_release(abs);
#ifdef _WIN32
  const char *node_path = scr_getenv("NODE_PATH");
  const char *home = scr_getenv("USERPROFILE");
  const char delimiter = ';';
#else
  const char *node_path = scr_getenv("NODE_PATH");
  const char *home = scr_getenv("HOME");
  const char delimiter = ':';
#endif
  if (node_path != NULL) {
    for (const char *p = node_path; *p;) {
      const char *end = strchr(p, delimiter);
      size_t len = end ? (size_t)(end - p) : strlen(p);
      if (len > 0) REQ_PUSH(scr_str_new(p, len));
      p += len;
      if (*p) p++;
    }
  }
  if (home != NULL && *home) {
    ScrStr *home_dir = req_cstr(home);
    static const char *const globals[] = { ".node_modules", ".node_libraries" };
    for (size_t i = 0; i < 2; i++) {
      ScrStr *name = req_cstr(globals[i]);
      REQ_PUSH(req_resolve2(home_dir, name));
      scr_str_release(name);
    }
    scr_str_release(home_dir);
  }
#undef REQ_PUSH
  *out = paths;
  return n;
}

/* trySelf: the nearest package.json above the importer (Node stops below
 * the root and at a node_modules directory) resolves the request through
 * its own "exports" when its "name" prefixes it. */
static ScrStr *req_try_self(ScrRequire *r) {
  ScrStr *dir = req_dirname(r->importer);
  ScrStr *found = NULL;
  for (;;) {
    ScrStr *parent = req_dirname(dir);
    bool root = scr_str_eq(parent, dir);
    scr_str_release(parent);
    if (root) break;
    ScrStr *dot = scr_str_new(".", 1);
    ScrStr *abs = req_resolve2(dir, dot);
    scr_str_release(dot);
    bool boundary = req_has_suffix(abs, "/node_modules")
#ifdef _WIN32
                    || req_has_suffix(abs, "\\node_modules")
#endif
        ;
    scr_str_release(abs);
    if (boundary) break;
    ScrStr *pjson_name = req_cstr("package.json");
    ScrStr *pjson = req_resolve2(dir, pjson_name);
    scr_str_release(pjson_name);
    ScrDyn *pkg = req_read_package(r, pjson);
    scr_str_release(pjson);
    if (r->refusal != NULL) break;
    if (pkg != NULL) {
      ScrStr *name = req_package_string(pkg, "name");
      const ScrDyn *exports = req_package_map(pkg, "exports");
      if (req_has_prefix(r->request, "#") && req_package_map(pkg, "imports") != NULL) {
        r->refusal = "a package \"imports\" specifier";
      } else if (name != NULL && exports != NULL) {
        bool whole = scr_str_eq(name, r->request);
        bool prefixed = r->request->len > name->len &&
                        memcmp(r->request->data, name->data, name->len) == 0 &&
                        r->request->data[name->len] == '/';
        if (whole || prefixed) {
          ScrJsonBuf sub;
          scr_jb_init(&sub);
          scr_jb_putc(&sub, '.');
          scr_jb_write(&sub, r->request->data + name->len, r->request->len - name->len);
          ScrStr *subpath = scr_jb_finish(&sub);
          found = req_exports_resolve(r, dir, exports, subpath);
          scr_str_release(subpath);
        }
      }
      scr_dyn_release(pkg);
      break;
    }
    ScrStr *next = req_dirname(dir);
    scr_str_release(dir);
    dir = next;
  }
  scr_str_release(dir);
  return found;
}

/* The builtin id `request` names (+1), or NULL. */
static ScrStr *req_builtin(ScrRequire *r) {
  ScrDyn *id = scr_dyn_new_str(r->request);
  ScrStr *bare = scr_process_builtin_id(id, r->builtins);
  scr_dyn_release(id);
  if (bare == NULL || bare->len == 0) {
    if (bare) scr_str_release(bare);
    return NULL;
  }
  scr_str_release(bare);
  return scr_str_retain(r->request);
}

/* Module._resolveFilename: +1 resolved id or path; NULL when nothing
 * resolves (or the refusal is set). */
static ScrStr *req_resolve_filename(ScrRequire *r) {
  ScrStr *builtin = req_builtin(r);
  if (builtin != NULL) return builtin;
  ScrStr *found = req_try_self(r);
  if (found != NULL || r->refusal != NULL) return found;
  bool lookup = r->request->len == 0 || r->request->data[0] != '.' ||
                (r->request->len > 1 && r->request->data[1] != '.' && r->request->data[1] != '/'
#ifdef _WIN32
                 && r->request->data[1] != '\\'
#endif
                );
  if (lookup) {
    ScrStr *dir = req_dirname(r->importer);
    ScrStr **paths = NULL;
    size_t count = req_lookup_paths(dir, &paths);
    scr_str_release(dir);
    found = req_find_path(r, paths, count);
    for (size_t i = 0; i < count; i++) scr_str_release(paths[i]);
    free(paths);
  } else {
    ScrStr *dir = req_dirname(r->importer);
    found = req_find_path(r, &dir, 1);
    scr_str_release(dir);
  }
  return found;
}

/* ── entry points ────────────────────────────────────────────────────── */

/* Ends the program with the SC2020 refusal: it names the native addon, the
 * builtin or file the specifier resolves to, or the resolution step, then
 * the program exits with status 1 as after an uncaught error, running the
 * 'exit' listeners. */
static void req_refuse(ScrRequire *r, const char *call, const ScrStr *found, bool builtin, ScrStr *site) {
  ScrJsonBuf text;
  scr_jb_init(&text);
  if (r->refusal != NULL) {
    scr_jb_puts(&text, call);
    scr_jb_puts(&text, " of '");
    scr_jb_write(&text, r->request->data, r->request->len);
    scr_jb_puts(&text, "' reaches ");
    scr_jb_puts(&text, r->refusal);
    scr_jb_puts(&text, ", which scriptc does not resolve at run time");
  } else if (builtin) {
    scr_jb_puts(&text, call);
    scr_jb_puts(&text, " of the builtin '");
    scr_jb_write(&text, found->data, found->len);
    scr_jb_puts(&text, "' with a computed specifier is not supported; require it with a string literal");
  } else if (req_has_suffix(found, ".node")) {
    scr_jb_puts(&text, "native addon '");
    scr_jb_write(&text, found->data, found->len);
    scr_jb_puts(&text, "' requires Node's addon runtime, which is unavailable in scriptc");
  } else {
    scr_jb_puts(&text, call);
    scr_jb_puts(&text, " of '");
    scr_jb_write(&text, r->request->data, r->request->len);
    scr_jb_puts(&text, "' resolves to '");
    scr_jb_write(&text, found->data, found->len);
    scr_jb_puts(&text, "', which is not part of the compiled program: the module graph is fixed at build time");
  }
  scr_jb_puts(&text, " [SC2020 at ");
  scr_jb_write(&text, site->data, site->len);
  scr_jb_puts(&text, "]\n");
  ScrStr *message = scr_jb_finish(&text);
  fflush(stdout);
  fputs("scriptc: ", stderr);
  fwrite(message->data, 1, message->len, stderr);
  fflush(stderr);
  scr_str_release(message);
  scr_process_exit(1);
}

static void req_throw(const char *code, const char *prefix, ScrRequire *r, bool stack) {
  ScrJsonBuf text;
  scr_jb_init(&text);
  scr_jb_puts(&text, prefix);
  scr_jb_write(&text, r->request->data, r->request->len);
  if (stack) {
    scr_jb_puts(&text, "'\nRequire stack:\n- ");
    scr_jb_write(&text, r->importer->data, r->importer->len);
  }
  ScrStr *message = scr_jb_finish(&text);
  scr_throw_error_msg_code(SCR_ERR_ERROR, message->data, message->len, code);
  scr_str_release(message);
}

ScrDyn *scr_require_computed(ScrDyn *id, ScrStr *importer, ScrStr *site, ScrArr *builtins) {
  if (id->kind != SCR_DYN_STR) {
    scr_dyn_arg_type_fail("id", "of type string", id);
    return NULL;
  }
  if (id->v.str->len == 0) {
    static const char message[] = "The argument 'id' must be a non-empty string. Received ''";
    scr_throw_error_msg_code(SCR_ERR_TYPE, message, sizeof message - 1, "ERR_INVALID_ARG_VALUE");
    return NULL;
  }
  ScrRequire r = { id->v.str, importer, builtins, NULL };
  ScrStr *builtin = req_builtin(&r);
  if (builtin == NULL && req_has_prefix(r.request, "node:")) {
    req_throw("ERR_UNKNOWN_BUILTIN_MODULE", "No such built-in module: ", &r, false);
    return NULL;
  }
  ScrStr *found = builtin != NULL ? builtin : req_resolve_filename(&r);
  if (found == NULL && r.refusal == NULL) {
    req_throw("MODULE_NOT_FOUND", "Cannot find module '", &r, true);
    return NULL;
  }
  req_refuse(&r, "createRequire's require", found, builtin != NULL, site);
  if (found) scr_str_release(found);
  return NULL;
}

/* require.resolve's options: Node reads `paths` and `conditions` from an
 * object; other values select the default lookup. */
static const char *req_options_refusal(const ScrDyn *options) {
  switch (options->kind) {
  case SCR_DYN_UNDEF:
  case SCR_DYN_NULL:
  case SCR_DYN_NUM:
  case SCR_DYN_BOOL:
  case SCR_DYN_STR:
    return NULL;
  case SCR_DYN_OBJ: {
    const ScrDyn *paths = scr_dyn_obj_get(options, "paths", 5);
    const ScrDyn *conditions = scr_dyn_obj_get(options, "conditions", 10);
    if (paths != NULL && paths->kind != SCR_DYN_UNDEF) return "require.resolve's paths option";
    if (conditions != NULL && conditions->kind != SCR_DYN_UNDEF) return "require.resolve's conditions option";
    return NULL;
  }
  default:
    return "require.resolve options that are not a plain object";
  }
}

ScrStr *scr_require_resolve(ScrDyn *request, ScrDyn *options, ScrStr *importer, ScrStr *site,
                            ScrArr *builtins) {
  if (request->kind != SCR_DYN_STR) {
    scr_dyn_arg_type_fail("request", "of type string", request);
    return NULL;
  }
  ScrRequire r = { request->v.str, importer, builtins, req_options_refusal(options) };
  ScrStr *found = r.refusal == NULL ? req_resolve_filename(&r) : NULL;
  if (r.refusal != NULL) {
    if (found) scr_str_release(found);
    req_refuse(&r, "createRequire's require.resolve", NULL, false, site);
    return NULL;
  }
  if (found == NULL) req_throw("MODULE_NOT_FOUND", "Cannot find module '", &r, true);
  return found;
}
