/* node:path — BOTH of Node's lib/path.js implementations, ported
 * function-by-function (normalizeString and friends), so every edge case
 * (trailing slashes, "..", empty segments, dot-files, drive letters, UNC
 * and device roots, reserved device names) matches Node byte-for-byte;
 * the differential corpus and the committed oracle cases
 * (test/path-cases.txt) are the oracle. The scr_path_* family below is
 * posix; the scr_path_win32_* family (second half of the file) is Node
 * v24's path.win32. The compiler binds bare `path` to the TARGET
 * platform's family — Node's own rule — and the path.posix/path.win32
 * namespaces to their family on every platform.
 *
 * All inputs are BORROWED; all string results are fresh (+1). Nothing here
 * throws: these are pure string algorithms (resolve consults getcwd like
 * Node's — a getcwd failure aborts, same as process.cwd()).
 *
 * join and resolve receive their variadic arguments packed into ONE
 * borrowed string[] (the compiler builds the array literal at the call
 * site), so the C ABI stays fixed-arity.
 */
#include "scr_runtime.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#ifndef _MSC_VER
#include <unistd.h>
#else
#include <direct.h>  /* _getcwd */
#define getcwd _getcwd
#endif

/* ── a tiny growable byte buffer ─────────────────────────────────────── */

typedef struct {
  char *data;
  size_t len;
  size_t cap;
} PathBuf;

static void pb_init(PathBuf *b) {
  b->cap = 64;
  b->len = 0;
  b->data = malloc(b->cap);
  if (!b->data) {
    scr_trap("scriptc: out of memory\n");
  }
}

static void pb_reserve(PathBuf *b, size_t extra) {
  if (b->len + extra <= b->cap) return;
  while (b->len + extra > b->cap) b->cap *= 2;
  char *grown = realloc(b->data, b->cap);
  if (!grown) {
    scr_trap("scriptc: out of memory\n");
  }
  b->data = grown;
}

static void pb_append(PathBuf *b, const char *bytes, size_t n) {
  pb_reserve(b, n);
  memcpy(b->data + b->len, bytes, n);
  b->len += n;
}

static void pb_push(PathBuf *b, char c) { pb_append(b, &c, 1); }

/* Consumes the buffer into a fresh ScrStr. */
static ScrStr *pb_take(PathBuf *b) {
  ScrStr *s = scr_str_new(b->data, b->len);
  free(b->data);
  return s;
}

/* win32's input-separator test (Node's isPathSeparator): both slashes.
 * POSIX recognizes '/' only. */
static bool scr_path_w32_is_sep(char c) { return c == '/' || c == '\\'; }

static bool scr_path_is_sep(char c, bool win32) {
  return win32 ? scr_path_w32_is_sep(c) : c == '/';
}

/* ── Node's normalizeString (lib/path.js), parameterized like Node's own
 * (separator + isPathSeparator follow the `win32` flag: POSIX emits and
 * recognizes '/', win32 emits '\\' and recognizes both slashes).
 * Resolves "." and ".." segments and collapses repeated slashes. `res` is
 * the output buffer (starts empty). allowAboveRoot keeps leading ".."
 * segments (relative paths); an absolute path drops them.
 */
static void scr_path_normalize_string(const char *path, size_t len, bool allow_above_root,
                                       PathBuf *res, bool win32) {
  const char sep = win32 ? '\\' : '/';
  size_t last_segment_length = 0;
  /* lastSlash starts at -1 in Node; use a signed offset. */
  long last_slash = -1;
  int dots = 0;
  char code = 0;
  for (size_t i = 0; i <= len; ++i) {
    if (i < len) code = path[i];
    else if (scr_path_is_sep(code, win32)) break;
    else code = '/';
    if (scr_path_is_sep(code, win32)) {
      if (last_slash == (long)i - 1 || dots == 1) {
        /* NOOP: empty segment or "." */
      } else if (dots == 2) {
        if (res->len < 2 || last_segment_length != 2 || res->data[res->len - 1] != '.' ||
            res->data[res->len - 2] != '.') {
          if (res->len > 2) {
            /* Pop the last segment. */
            long last_slash_index = -1;
            for (long j = (long)res->len - 1; j >= 0; j--) {
              if (res->data[j] == sep) {
                last_slash_index = j;
                break;
              }
            }
            if (last_slash_index == -1) {
              res->len = 0;
              last_segment_length = 0;
            } else {
              res->len = (size_t)last_slash_index;
              long prev_slash = -1;
              for (long j = (long)res->len - 1; j >= 0; j--) {
                if (res->data[j] == sep) {
                  prev_slash = j;
                  break;
                }
              }
              last_segment_length = (size_t)((long)res->len - 1 - prev_slash);
            }
            last_slash = (long)i;
            dots = 0;
            continue;
          } else if (res->len != 0) {
            res->len = 0;
            last_segment_length = 0;
            last_slash = (long)i;
            dots = 0;
            continue;
          }
        }
        if (allow_above_root) {
          if (res->len > 0) {
            pb_push(res, sep);
            pb_append(res, "..", 2);
          } else {
            pb_append(res, "..", 2);
          }
          last_segment_length = 2;
        }
      } else {
        size_t seg_start = (size_t)(last_slash + 1);
        size_t seg_len = i - seg_start;
        if (res->len > 0) {
          pb_push(res, sep);
          pb_append(res, path + seg_start, seg_len);
        } else {
          pb_append(res, path + seg_start, seg_len);
        }
        last_segment_length = seg_len;
      }
      last_slash = (long)i;
      dots = 0;
    } else if (code == '.' && dots != -1) {
      ++dots;
    } else {
      dots = -1;
    }
  }
}

/* posix.normalize on raw bytes, result appended into `out`. */
static void scr_path_normalize_raw(const char *path, size_t len, PathBuf *out) {
  if (len == 0) {
    pb_push(out, '.');
    return;
  }
  bool is_absolute = path[0] == '/';
  bool trailing_separator = path[len - 1] == '/';
  PathBuf norm;
  pb_init(&norm);
  scr_path_normalize_string(path, len, !is_absolute, &norm, false);
  if (norm.len == 0) {
    free(norm.data);
    if (is_absolute) {
      pb_push(out, '/');
      return;
    }
    pb_push(out, '.');
    if (trailing_separator) pb_push(out, '/');
    return;
  }
  if (is_absolute) pb_push(out, '/');
  pb_append(out, norm.data, norm.len);
  if (trailing_separator) pb_push(out, '/');
  free(norm.data);
}

/* ── the exported surface ────────────────────────────────────────────── */

ScrStr *scr_path_normalize(ScrStr *path) {
  PathBuf out;
  pb_init(&out);
  scr_path_normalize_raw(path->data, path->len, &out);
  return pb_take(&out);
}

ScrStr *scr_path_join(ScrArr *parts) {
  size_t n = (size_t)scr_arr_len(parts);
  PathBuf joined;
  pb_init(&joined);
  bool any = false;
  for (size_t i = 0; i < n; i++) {
    ScrStr *arg = scr_arr_get_ref(parts, (double)i); /* +1 */
    if (arg->len > 0) {
      if (any) pb_push(&joined, '/');
      pb_append(&joined, arg->data, arg->len);
      any = true;
    }
    scr_str_release(arg);
  }
  PathBuf out;
  pb_init(&out);
  if (!any) pb_push(&out, '.');
  else scr_path_normalize_raw(joined.data, joined.len, &out);
  free(joined.data);
  return pb_take(&out);
}

static void scr_path_cwd(PathBuf *out) {
  char buf[4096];
  if (!getcwd(buf, sizeof buf)) {
    scr_trap("scriptc: path.resolve: getcwd failed\n");
  }
  pb_append(out, buf, strlen(buf));
}

ScrStr *scr_path_resolve(ScrArr *parts) {
  /* Node walks the args LAST-first, prepending, until one is absolute;
   * the cwd is a final virtual argument. Build the concatenation by
   * prepending into a scratch buffer (memmove — paths are short). */
  PathBuf resolved;
  pb_init(&resolved);
  bool resolved_absolute = false;
  long n = (long)scr_arr_len(parts);
  for (long i = n - 1; i >= -1 && !resolved_absolute; i--) {
    PathBuf seg;
    pb_init(&seg);
    if (i >= 0) {
      ScrStr *arg = scr_arr_get_ref(parts, (double)i); /* +1 */
      pb_append(&seg, arg->data, arg->len);
      scr_str_release(arg);
    } else {
      scr_path_cwd(&seg);
    }
    if (seg.len == 0) {
      free(seg.data);
      continue;
    }
    /* resolvedPath = `${path}/${resolvedPath}` */
    pb_push(&seg, '/');
    pb_append(&seg, resolved.data, resolved.len);
    free(resolved.data);
    resolved = seg;
    resolved_absolute = resolved.data[0] == '/';
  }
  PathBuf norm;
  pb_init(&norm);
  scr_path_normalize_string(resolved.data, resolved.len, !resolved_absolute, &norm, false);
  free(resolved.data);
  PathBuf out;
  pb_init(&out);
  if (resolved_absolute) {
    pb_push(&out, '/');
    pb_append(&out, norm.data, norm.len);
  } else if (norm.len > 0) {
    pb_append(&out, norm.data, norm.len);
  } else {
    pb_push(&out, '.');
  }
  free(norm.data);
  return pb_take(&out);
}

bool scr_path_is_absolute(ScrStr *path) { return path->len > 0 && path->data[0] == '/'; }

ScrStr *scr_path_dirname(ScrStr *path) {
  size_t len = path->len;
  const char *p = path->data;
  if (len == 0) return scr_str_new(".", 1);
  bool has_root = p[0] == '/';
  long end = -1;
  bool matched_slash = true;
  for (long i = (long)len - 1; i >= 1; --i) {
    if (p[i] == '/') {
      if (!matched_slash) {
        end = i;
        break;
      }
    } else {
      matched_slash = false;
    }
  }
  if (end == -1) return has_root ? scr_str_new("/", 1) : scr_str_new(".", 1);
  if (has_root && end == 1) return scr_str_new("//", 2);
  return scr_str_new(p, (size_t)end);
}

ScrStr *scr_path_basename(ScrStr *path, ScrStr *suffix) {
  const char *p = path->data;
  long len = (long)path->len;
  long start = 0;
  long end = -1;
  bool matched_slash = true;
  if (suffix->len > 0 && suffix->len <= path->len) {
    if (suffix->len == path->len && memcmp(suffix->data, p, path->len) == 0) {
      return scr_str_new("", 0);
    }
    long ext_idx = (long)suffix->len - 1;
    long first_non_slash_end = -1;
    for (long i = len - 1; i >= 0; --i) {
      char code = p[i];
      if (code == '/') {
        if (!matched_slash) {
          start = i + 1;
          break;
        }
      } else {
        if (first_non_slash_end == -1) {
          matched_slash = false;
          first_non_slash_end = i + 1;
        }
        if (ext_idx >= 0) {
          if (code == suffix->data[ext_idx]) {
            if (--ext_idx == -1) end = i;
          } else {
            ext_idx = -1;
            end = first_non_slash_end;
          }
        }
      }
    }
    if (start == end) end = first_non_slash_end;
    else if (end == -1) end = len;
    return scr_str_new(p + start, (size_t)(end - start));
  }
  for (long i = len - 1; i >= 0; --i) {
    if (p[i] == '/') {
      if (!matched_slash) {
        start = i + 1;
        break;
      }
    } else if (end == -1) {
      matched_slash = false;
      end = i + 1;
    }
  }
  if (end == -1) return scr_str_new("", 0);
  return scr_str_new(p + start, (size_t)(end - start));
}

ScrStr *scr_path_extname(ScrStr *path) {
  const char *p = path->data;
  long len = (long)path->len;
  long start_dot = -1;
  long start_part = 0;
  long end = -1;
  bool matched_slash = true;
  /* preDotState: 0 = start, 1 = saw non-dot chars, -1 = ext-disqualified. */
  int pre_dot_state = 0;
  for (long i = len - 1; i >= 0; --i) {
    char code = p[i];
    if (code == '/') {
      if (!matched_slash) {
        start_part = i + 1;
        break;
      }
      continue;
    }
    if (end == -1) {
      matched_slash = false;
      end = i + 1;
    }
    if (code == '.') {
      if (start_dot == -1) start_dot = i;
      else if (pre_dot_state != 1) pre_dot_state = 1;
    } else if (start_dot != -1) {
      pre_dot_state = -1;
    }
  }
  if (start_dot == -1 || end == -1 || pre_dot_state == 0 ||
      (pre_dot_state == 1 && start_dot == end - 1 && start_dot == start_part + 1)) {
    return scr_str_new("", 0);
  }
  return scr_str_new(p + start_dot, (size_t)(end - start_dot));
}

ScrStr *scr_path_relative(ScrStr *from, ScrStr *to) {
  if (from->len == to->len && memcmp(from->data, to->data, from->len) == 0) {
    return scr_str_new("", 0);
  }
  /* from = resolve(from), to = resolve(to) — via one-element packs. */
  ScrArr *pack = scr_arr_new(SCR_ELEM_STR, 1);
  scr_arr_push_ref(pack, scr_str_retain(from));
  ScrStr *rfrom = scr_path_resolve(pack);
  scr_arr_release(pack);
  pack = scr_arr_new(SCR_ELEM_STR, 1);
  scr_arr_push_ref(pack, scr_str_retain(to));
  ScrStr *rto = scr_path_resolve(pack);
  scr_arr_release(pack);

  if (rfrom->len == rto->len && memcmp(rfrom->data, rto->data, rfrom->len) == 0) {
    scr_str_release(rfrom);
    scr_str_release(rto);
    return scr_str_new("", 0);
  }

  const long from_start = 1;
  const long from_end = (long)rfrom->len;
  const long from_len = from_end - from_start;
  const long to_start = 1;
  const long to_len = (long)rto->len - to_start;

  const long length = from_len < to_len ? from_len : to_len;
  long last_common_sep = -1;
  long i = 0;
  for (; i < length; i++) {
    char from_code = rfrom->data[from_start + i];
    if (from_code != rto->data[to_start + i]) break;
    if (from_code == '/') last_common_sep = i;
  }
  if (i == length) {
    if (to_len > length) {
      if (rto->data[to_start + i] == '/') {
        ScrStr *r = scr_str_new(rto->data + to_start + i + 1, (size_t)(to_len - i - 1));
        scr_str_release(rfrom);
        scr_str_release(rto);
        return r;
      }
      if (i == 0) {
        ScrStr *r = scr_str_new(rto->data + to_start, (size_t)to_len);
        scr_str_release(rfrom);
        scr_str_release(rto);
        return r;
      }
    } else if (from_len > length) {
      if (rfrom->data[from_start + i] == '/') last_common_sep = i;
      else if (i == 0) last_common_sep = 0;
    }
  }

  PathBuf out;
  pb_init(&out);
  for (long j = from_start + last_common_sep + 1; j <= from_end; ++j) {
    if (j == from_end || rfrom->data[j] == '/') {
      if (out.len == 0) pb_append(&out, "..", 2);
      else pb_append(&out, "/..", 3);
    }
  }
  pb_append(&out, rto->data + to_start + last_common_sep,
            (size_t)((long)rto->len - (to_start + last_common_sep)));
  scr_str_release(rfrom);
  scr_str_release(rto);
  return pb_take(&out);
}

/* ── path.win32 — Node's win32 implementation, byte-for-byte ───────────
 * Ported function-by-function from Node v24's lib/path.js win32 object
 * (the same fidelity standard as the posix section above): drive-letter
 * and UNC roots (\\server\share), device paths (\\.\ and \\?\), the
 * Windows reserved device names (CON, NUL, COM1..9, LPT1..9 and the
 * superscript variants — the CVE-2024-36139 era hardening), both
 * separators recognized on input, backslash emitted on output. On a win32
 * TARGET these back the bare `path` module (Node on Windows IS
 * path.win32 — the frontend rebinds the tables per target); everywhere
 * they are the `path.win32.*` namespace, answering its own platform's
 * rules from any host, exactly like Node's.
 *
 * Two knowingly-ASCII spots (documented divergences): the
 * case-insensitive comparisons Node does with String.prototype.
 * toLowerCase/toUpperCase (win32.relative, resolve's device compare, the
 * reserved-name check) fold ASCII only here — non-ASCII device/server
 * names whose Unicode case-folding differs compare case-SENSITIVELY. */

static bool scr_path_w32_is_device_root(char c) {
  return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z');
}

static char scr_path_w32_lower(char c) { return c >= 'A' && c <= 'Z' ? (char)(c + 32) : c; }

/* ASCII-case-insensitive equality over n bytes. */
static bool scr_path_w32_ieq(const char *a, const char *b, size_t n) {
  for (size_t i = 0; i < n; i++) {
    if (scr_path_w32_lower(a[i]) != scr_path_w32_lower(b[i])) return false;
  }
  return true;
}

/* The Windows reserved device names, exactly Node's WINDOWS_RESERVED_NAMES
 * list (upper-cased; the last six carry SUPERSCRIPT digits — U+00B9/B2/B3,
 * two UTF-8 bytes each). */
static const struct {
  const char *name;
  size_t len;
} SCR_W32_RESERVED[] = {
    {"CON", 3},          {"PRN", 3},          {"AUX", 3},          {"NUL", 3},
    {"COM1", 4},         {"COM2", 4},         {"COM3", 4},         {"COM4", 4},
    {"COM5", 4},         {"COM6", 4},         {"COM7", 4},         {"COM8", 4},
    {"COM9", 4},         {"LPT1", 4},         {"LPT2", 4},         {"LPT3", 4},
    {"LPT4", 4},         {"LPT5", 4},         {"LPT6", 4},         {"LPT7", 4},
    {"LPT8", 4},         {"LPT9", 4},         {"COM\xc2\xb9", 5},  {"COM\xc2\xb2", 5},
    {"COM\xc2\xb3", 5},  {"LPT\xc2\xb9", 5},  {"LPT\xc2\xb2", 5},  {"LPT\xc2\xb3", 5},
};

/* Node's isWindowsReservedName(path, colonIndex): the device part is
 * path.slice(0, colonIndex) upper-cased. colonIndex -1 (no colon found by
 * the caller) means slice(0, -1) — drop the final UTF-16 unit: one full
 * UTF-8 sequence for BMP characters; a 4-byte (astral) final character
 * leaves a lone surrogate in JS, which can never equal a reserved name. */
static bool scr_path_w32_is_reserved(const char *path, size_t len, long colon_index) {
  size_t end;
  if (colon_index >= 0) {
    end = (size_t)colon_index;
    if (end > len) end = len;
  } else {
    if (len == 0) return false;
    size_t last = len - 1;
    while (last > 0 && ((unsigned char)path[last] & 0xC0) == 0x80) last--;
    if (len - last == 4) return false; /* astral: JS keeps a lone surrogate */
    end = last;
  }
  for (size_t i = 0; i < sizeof(SCR_W32_RESERVED) / sizeof(SCR_W32_RESERVED[0]); i++) {
    if (SCR_W32_RESERVED[i].len != end) continue;
    bool match = true;
    for (size_t j = 0; j < end; j++) {
      char c = path[j];
      if (c >= 'a' && c <= 'z') c = (char)(c - 32); /* toUpperCase, ASCII */
      if (c != SCR_W32_RESERVED[i].name[j]) {
        match = false;
        break;
      }
    }
    if (match) return true;
  }
  return false;
}

/* Byte index of the first ':' at or after `from`, -1 when absent. */
static long scr_path_w32_colon_index(const char *path, size_t len, size_t from) {
  for (size_t i = from; i < len; i++) {
    if (path[i] == ':') return (long)i;
  }
  return -1;
}

/* win32.normalize appended into `out` — Node v24's win32.normalize. */
static void scr_path_w32_normalize_raw(const char *path, size_t len, PathBuf *out) {
  if (len == 0) {
    pb_push(out, '.');
    return;
  }
  if (len == 1) {
    /* A single char: only a FORWARD slash normalizes (to backslash). */
    if (path[0] == '/') pb_push(out, '\\');
    else pb_append(out, path, 1);
    return;
  }
  size_t root_end = 0;
  PathBuf dev;
  pb_init(&dev);
  bool has_dev = false; /* Node's `device === undefined` distinction */
  bool is_absolute = false;
  char code = path[0];
  if (scr_path_w32_is_sep(code)) {
    /* Possible UNC root. */
    is_absolute = true;
    if (scr_path_w32_is_sep(path[1])) {
      size_t j = 2, last = 2;
      while (j < len && !scr_path_w32_is_sep(path[j])) j++;
      if (j < len && j != last) {
        size_t fp_start = last, fp_len = j - last;
        last = j;
        while (j < len && scr_path_w32_is_sep(path[j])) j++;
        if (j < len && j != last) {
          last = j;
          while (j < len && !scr_path_w32_is_sep(path[j])) j++;
          if (j == len || j != last) {
            if (fp_len == 1 && (path[fp_start] == '.' || path[fp_start] == '?')) {
              /* A device root (\\.\ or \\?\). */
              pb_append(&dev, "\\\\", 2);
              pb_append(&dev, path + fp_start, fp_len);
              has_dev = true;
              root_end = 4;
              long ci = scr_path_w32_colon_index(path, len, 0);
              /* possibleDevice = path.slice(4, colonIndex + 1) */
              if (ci >= 4) {
                size_t pd_len = (size_t)ci + 1 - 4;
                if (scr_path_w32_is_reserved(path + 4, pd_len, (long)pd_len - 1)) {
                  dev.len = 0;
                  pb_append(&dev, "\\\\?\\", 4);
                  pb_append(&dev, path + 4, pd_len);
                  root_end = 4 + pd_len;
                }
              }
            } else if (j == len) {
              /* A UNC root only — normalized, nothing left to process. */
              pb_append(out, "\\\\", 2);
              pb_append(out, path + fp_start, fp_len);
              pb_push(out, '\\');
              pb_append(out, path + last, len - last);
              pb_push(out, '\\');
              free(dev.data);
              return;
            } else {
              /* A UNC root with leftovers. */
              pb_append(&dev, "\\\\", 2);
              pb_append(&dev, path + fp_start, fp_len);
              pb_push(&dev, '\\');
              pb_append(&dev, path + last, j - last);
              has_dev = true;
              root_end = j;
            }
          }
        }
      }
    } else {
      root_end = 1;
    }
  } else {
    long ci = scr_path_w32_colon_index(path, len, 0);
    if (ci > 0) {
      if (scr_path_w32_is_device_root(code) && ci == 1) {
        /* A drive-letter root, absolute when a separator follows it. */
        pb_append(&dev, path, 2);
        has_dev = true;
        root_end = 2;
        if (len > 2 && scr_path_w32_is_sep(path[2])) {
          is_absolute = true;
          root_end = 3;
        }
      } else if (scr_path_w32_is_reserved(path, len, ci)) {
        pb_append(&dev, path, (size_t)ci + 1);
        has_dev = true;
        root_end = (size_t)ci + 1;
      }
    }
  }
  PathBuf tail;
  pb_init(&tail);
  if (root_end < len) {
    scr_path_normalize_string(path + root_end, len - root_end, !is_absolute, &tail, true);
  }
  if (tail.len == 0 && !is_absolute) pb_push(&tail, '.');
  if (tail.len > 0 && scr_path_w32_is_sep(path[len - 1])) pb_push(&tail, '\\');
  if (!is_absolute && !has_dev && memchr(path, ':', len) != NULL) {
    /* A relative path that resolved to no device must not normalize into
     * something Windows would read as absolute or drive-relative
     * (CVE-2024-36139): prefix ".\" when the tail grew a drive-letter
     * root, or when any ':' ends the string / precedes a separator. */
    if (tail.len >= 2 && scr_path_w32_is_device_root(tail.data[0]) && tail.data[1] == ':') {
      pb_append(out, ".\\", 2);
      pb_append(out, tail.data, tail.len);
      free(dev.data);
      free(tail.data);
      return;
    }
    long index = scr_path_w32_colon_index(path, len, 0);
    do {
      if ((size_t)index == len - 1 || scr_path_w32_is_sep(path[index + 1])) {
        pb_append(out, ".\\", 2);
        pb_append(out, tail.data, tail.len);
        free(dev.data);
        free(tail.data);
        return;
      }
    } while ((index = scr_path_w32_colon_index(path, len, (size_t)index + 1)) != -1);
  }
  {
    long ci = scr_path_w32_colon_index(path, len, 0);
    if (scr_path_w32_is_reserved(path, len, ci)) {
      pb_append(out, ".\\", 2);
      pb_append(out, dev.data, dev.len); /* device ?? '' */
      pb_append(out, tail.data, tail.len);
      free(dev.data);
      free(tail.data);
      return;
    }
  }
  if (!has_dev) {
    if (is_absolute) pb_push(out, '\\');
    pb_append(out, tail.data, tail.len);
  } else {
    pb_append(out, dev.data, dev.len);
    if (is_absolute) pb_push(out, '\\');
    pb_append(out, tail.data, tail.len);
  }
  free(dev.data);
  free(tail.data);
}

ScrStr *scr_path_win32_normalize(ScrStr *path) {
  PathBuf out;
  pb_init(&out);
  scr_path_w32_normalize_raw(path->data, path->len, &out);
  return pb_take(&out);
}

ScrStr *scr_path_win32_join(ScrArr *parts) {
  size_t n = (size_t)scr_arr_len(parts);
  PathBuf joined;
  pb_init(&joined);
  bool any = false;
  size_t first_len = 0; /* the first NON-EMPTY argument's length */
  for (size_t i = 0; i < n; i++) {
    ScrStr *arg = scr_arr_get_ref(parts, (double)i); /* +1 */
    if (arg->len > 0) {
      if (any) pb_push(&joined, '\\');
      else first_len = arg->len;
      pb_append(&joined, arg->data, arg->len);
      any = true;
    }
    scr_str_release(arg);
  }
  if (!any) {
    free(joined.data);
    return scr_str_new(".", 1);
  }
  /* Node's UNC guard: collapse a leading run of slashes to ONE backslash
   * unless the first part looks like a real UNC prefix (exactly two
   * separators then a non-separator), which is preserved. */
  bool needs_replace = true;
  size_t slash_count = 0;
  if (scr_path_w32_is_sep(joined.data[0])) {
    ++slash_count;
    if (first_len > 1 && scr_path_w32_is_sep(joined.data[1])) {
      ++slash_count;
      if (first_len > 2) {
        if (scr_path_w32_is_sep(joined.data[2])) ++slash_count;
        else needs_replace = false;
      }
    }
  }
  if (needs_replace) {
    while (slash_count < joined.len && scr_path_w32_is_sep(joined.data[slash_count])) {
      slash_count++;
    }
    if (slash_count >= 2) {
      memmove(joined.data + 1, joined.data + slash_count, joined.len - slash_count);
      joined.data[0] = '\\';
      joined.len -= slash_count - 1;
    }
  }
  /* Reserved device names skip normalization entirely (Node v24): split
   * the joined path on BACKSLASHES only, and if any part is a reserved
   * name up to its ':', return the joined path with forward slashes
   * flipped to backslashes, un-normalized. */
  {
    bool reserved = false;
    size_t start = 0;
    for (size_t i = 0; i <= joined.len && !reserved; i++) {
      if (i == joined.len || joined.data[i] == '\\') {
        if (i > start) {
          long ci = scr_path_w32_colon_index(joined.data + start, i - start, 0);
          if (ci != -1 && scr_path_w32_is_reserved(joined.data + start, i - start, ci)) {
            reserved = true;
          }
        }
        start = i + 1;
      }
    }
    if (reserved) {
      for (size_t i = 0; i < joined.len; i++) {
        if (joined.data[i] == '/') joined.data[i] = '\\';
      }
      return pb_take(&joined);
    }
  }
  PathBuf out;
  pb_init(&out);
  scr_path_w32_normalize_raw(joined.data, joined.len, &out);
  free(joined.data);
  return pb_take(&out);
}

ScrStr *scr_path_win32_resolve(ScrArr *parts) {
  PathBuf dev; /* resolvedDevice */
  pb_init(&dev);
  PathBuf tail; /* resolvedTail */
  pb_init(&tail);
  bool resolved_absolute = false;
  long n = (long)scr_arr_len(parts);
  for (long i = n - 1; i >= -1; i--) {
    PathBuf pathb;
    pb_init(&pathb);
    if (i >= 0) {
      ScrStr *arg = scr_arr_get_ref(parts, (double)i); /* +1 */
      if (arg->len == 0) {
        scr_str_release(arg);
        free(pathb.data);
        continue;
      }
      pb_append(&pathb, arg->data, arg->len);
      scr_str_release(arg);
    } else if (dev.len == 0) {
      scr_path_cwd(&pathb);
      /* Node's fast path for the current directory. On a WINDOWS host Node
       * returns the cwd verbatim; on a POSIX host it flips '/' to '\\' —
       * the compiled binary IS its target platform, so the branch is a
       * compile-time #ifdef. */
      bool fast = n == 0;
      if (!fast && n == 1) {
        ScrStr *a0 = scr_arr_get_ref(parts, 0); /* +1 */
        bool empty_or_dot = a0->len == 0 || (a0->len == 1 && a0->data[0] == '.');
        scr_str_release(a0);
        fast = empty_or_dot && pathb.len > 0 && scr_path_w32_is_sep(pathb.data[0]);
      }
      if (fast) {
#ifndef _WIN32
        for (size_t k = 0; k < pathb.len; k++) {
          if (pathb.data[k] == '/') pathb.data[k] = '\\';
        }
#endif
        free(dev.data);
        free(tail.data);
        return pb_take(&pathb);
      }
    } else {
      /* A drive was resolved but no absolute path yet: Windows keeps a cwd
       * PER DRIVE in the hidden "=C:" environment variables (cmd.exe
       * maintains them; getenv sees them through the CRT). Fall back to
       * the process cwd, and to the drive's root when neither points at
       * the resolved drive. resolvedDevice is always a 2-byte drive here
       * (UNC devices are absolute and broke out of the loop). */
      char name[4] = {'=', dev.data[0], dev.data[1], 0};
      const char *dcwd = getenv(name);
      if (dcwd && *dcwd) pb_append(&pathb, dcwd, strlen(dcwd));
      else scr_path_cwd(&pathb);
      if (!(pathb.len >= 2 && scr_path_w32_ieq(pathb.data, dev.data, 2)) &&
          (pathb.len > 2 && pathb.data[2] == '\\')) {
        pathb.len = 0;
        pb_append(&pathb, dev.data, dev.len);
        pb_push(&pathb, '\\');
      }
    }
    const char *path = pathb.data;
    size_t len = pathb.len;
    size_t root_end = 0;
    PathBuf device;
    pb_init(&device);
    bool is_absolute = false;
    char code = path[0];
    /* Try to match a root. */
    if (len == 1) {
      if (scr_path_w32_is_sep(code)) {
        root_end = 1;
        is_absolute = true;
      }
    } else if (scr_path_w32_is_sep(code)) {
      /* Possible UNC root. */
      is_absolute = true;
      if (scr_path_w32_is_sep(path[1])) {
        size_t j = 2, last = 2;
        while (j < len && !scr_path_w32_is_sep(path[j])) j++;
        if (j < len && j != last) {
          size_t fp_start = last, fp_len = j - last;
          last = j;
          while (j < len && scr_path_w32_is_sep(path[j])) j++;
          if (j < len && j != last) {
            last = j;
            while (j < len && !scr_path_w32_is_sep(path[j])) j++;
            if (j == len || j != last) {
              if (!(fp_len == 1 && (path[fp_start] == '.' || path[fp_start] == '?'))) {
                /* A UNC root. */
                pb_append(&device, "\\\\", 2);
                pb_append(&device, path + fp_start, fp_len);
                pb_push(&device, '\\');
                pb_append(&device, path + last, j - last);
                root_end = j;
              } else {
                /* A device root (\\.\PHYSICALDRIVE0 style). */
                pb_append(&device, "\\\\", 2);
                pb_append(&device, path + fp_start, fp_len);
                root_end = 4;
              }
            }
          }
        }
      } else {
        root_end = 1;
      }
    } else if (scr_path_w32_is_device_root(code) && path[1] == ':') {
      /* A drive-letter root, absolute when a separator follows it. */
      pb_append(&device, path, 2);
      root_end = 2;
      if (len > 2 && scr_path_w32_is_sep(path[2])) {
        is_absolute = true;
        root_end = 3;
      }
    }
    if (device.len > 0) {
      if (dev.len > 0) {
        if (!(device.len == dev.len && scr_path_w32_ieq(device.data, dev.data, dev.len))) {
          /* This path points to another device — not applicable. */
          free(device.data);
          free(pathb.data);
          continue;
        }
      } else {
        free(dev.data);
        dev = device;
        device.data = NULL;
      }
    }
    if (device.data) free(device.data);
    if (resolved_absolute) {
      if (dev.len > 0) {
        free(pathb.data);
        break;
      }
    } else {
      /* resolvedTail = `${path.slice(rootEnd)}\\${resolvedTail}` */
      PathBuf nt;
      pb_init(&nt);
      pb_append(&nt, path + root_end, len - root_end);
      pb_push(&nt, '\\');
      pb_append(&nt, tail.data, tail.len);
      free(tail.data);
      tail = nt;
      resolved_absolute = is_absolute;
      if (is_absolute && dev.len > 0) {
        free(pathb.data);
        break;
      }
    }
    free(pathb.data);
  }
  PathBuf norm;
  pb_init(&norm);
  scr_path_normalize_string(tail.data, tail.len, !resolved_absolute, &norm, true);
  free(tail.data);
  PathBuf out;
  pb_init(&out);
  pb_append(&out, dev.data, dev.len);
  if (resolved_absolute) {
    pb_push(&out, '\\');
    pb_append(&out, norm.data, norm.len);
  } else {
    pb_append(&out, norm.data, norm.len);
    if (out.len == 0) pb_push(&out, '.'); /* `${device}${tail}` || "." */
  }
  free(dev.data);
  free(norm.data);
  return pb_take(&out);
}

bool scr_path_win32_is_absolute(ScrStr *path) {
  size_t len = path->len;
  if (len == 0) return false;
  const char *p = path->data;
  return scr_path_w32_is_sep(p[0]) ||
         (len > 2 && scr_path_w32_is_device_root(p[0]) && p[1] == ':' &&
          scr_path_w32_is_sep(p[2]));
}

ScrStr *scr_path_win32_relative(ScrStr *from, ScrStr *to) {
  if (from->len == to->len && memcmp(from->data, to->data, from->len) == 0) {
    return scr_str_new("", 0);
  }
  /* fromOrig = win32.resolve(from), toOrig = win32.resolve(to). */
  ScrArr *pack = scr_arr_new(SCR_ELEM_STR, 1);
  scr_arr_push_ref(pack, scr_str_retain(from));
  ScrStr *rfrom = scr_path_win32_resolve(pack);
  scr_arr_release(pack);
  pack = scr_arr_new(SCR_ELEM_STR, 1);
  scr_arr_push_ref(pack, scr_str_retain(to));
  ScrStr *rto = scr_path_win32_resolve(pack);
  scr_arr_release(pack);

  if (rfrom->len == rto->len && memcmp(rfrom->data, rto->data, rfrom->len) == 0) {
    scr_str_release(rfrom);
    scr_str_release(rto);
    return scr_str_new("", 0);
  }
  /* Node lowercases both sides (case-insensitive comparison, ASCII fold
   * here — see the header comment). Byte-lowercasing never changes
   * lengths, so Node's changed-length Unicode branch cannot trigger. */
  char *flow = malloc(rfrom->len ? rfrom->len : 1);
  char *tlow = malloc(rto->len ? rto->len : 1);
  if (!flow || !tlow) {
    scr_trap("scriptc: out of memory\n");
  }
  for (size_t k = 0; k < rfrom->len; k++) flow[k] = scr_path_w32_lower(rfrom->data[k]);
  for (size_t k = 0; k < rto->len; k++) tlow[k] = scr_path_w32_lower(rto->data[k]);
  if (rfrom->len == rto->len && memcmp(flow, tlow, rfrom->len) == 0) {
    free(flow);
    free(tlow);
    scr_str_release(rfrom);
    scr_str_release(rto);
    return scr_str_new("", 0);
  }

  /* Trim leading backslashes, and trailing ones (UNC paths only). */
  long from_start = 0;
  while (from_start < (long)rfrom->len && flow[from_start] == '\\') from_start++;
  long from_end = (long)rfrom->len;
  while (from_end - 1 > from_start && flow[from_end - 1] == '\\') from_end--;
  const long from_len = from_end - from_start;

  long to_start = 0;
  while (to_start < (long)rto->len && tlow[to_start] == '\\') to_start++;
  long to_end = (long)rto->len;
  while (to_end - 1 > to_start && tlow[to_end - 1] == '\\') to_end--;
  const long to_len = to_end - to_start;

  const long length = from_len < to_len ? from_len : to_len;
  long last_common_sep = -1;
  long i = 0;
  for (; i < length; i++) {
    char from_code = flow[from_start + i];
    if (from_code != tlow[to_start + i]) break;
    if (from_code == '\\') last_common_sep = i;
  }
  ScrStr *result = NULL;
  if (i != length) {
    /* Mismatch before any common separator: return toOrig. */
    if (last_common_sep == -1) result = scr_str_new(rto->data, rto->len);
  } else {
    if (to_len > length) {
      if (tlow[to_start + i] == '\\') {
        /* `from` is the exact base path of `to`. */
        result = scr_str_new(rto->data + to_start + i + 1, (size_t)(to_end - (to_start + i + 1)));
      } else if (i == 2) {
        /* `from` is the device root. */
        result = scr_str_new(rto->data + to_start + i, (size_t)(to_end - (to_start + i)));
      }
    }
    if (result == NULL && from_len > length) {
      if (flow[from_start + i] == '\\') last_common_sep = i;
      else if (i == 2) last_common_sep = 3;
    }
    if (result == NULL && last_common_sep == -1) last_common_sep = 0;
  }
  if (result != NULL) {
    free(flow);
    free(tlow);
    scr_str_release(rfrom);
    scr_str_release(rto);
    return result;
  }

  PathBuf out;
  pb_init(&out);
  for (i = from_start + last_common_sep + 1; i <= from_end; ++i) {
    if (i == from_end || flow[i] == '\\') {
      if (out.len == 0) pb_append(&out, "..", 2);
      else pb_append(&out, "\\..", 3);
    }
  }
  to_start += last_common_sep;
  if (out.len == 0) {
    /* Node reads toOrig.charCodeAt(toStart) — NaN out of range. */
    if (to_start < (long)rto->len && rto->data[to_start] == '\\') ++to_start;
  }
  /* toOrig.slice(toStart, toEnd) — "" when the range is empty/inverted. */
  if (to_end > to_start) pb_append(&out, rto->data + to_start, (size_t)(to_end - to_start));
  free(flow);
  free(tlow);
  scr_str_release(rfrom);
  scr_str_release(rto);
  return pb_take(&out);
}

ScrStr *scr_path_win32_to_namespaced_path(ScrStr *path) {
  if (path->len == 0) return scr_str_retain(path);
  ScrArr *pack = scr_arr_new(SCR_ELEM_STR, 1);
  scr_arr_push_ref(pack, scr_str_retain(path));
  ScrStr *resolved = scr_path_win32_resolve(pack);
  scr_arr_release(pack);
  /* Node's `resolvedPath.length <= 2` counts UTF-16 units. */
  if (scr_str_utf16_len(resolved) <= 2) {
    scr_str_release(resolved);
    return scr_str_retain(path);
  }
  const char *r = resolved->data;
  if (r[0] == '\\') {
    /* Possible UNC root. */
    if (r[1] == '\\') {
      char code = r[2];
      if (code != '?' && code != '.') {
        /* A non-long UNC root: convert to a long UNC path. */
        PathBuf out;
        pb_init(&out);
        pb_append(&out, "\\\\?\\UNC\\", 8);
        pb_append(&out, r + 2, resolved->len - 2);
        scr_str_release(resolved);
        return pb_take(&out);
      }
    }
  } else if (scr_path_w32_is_device_root(r[0]) && r[1] == ':' && r[2] == '\\') {
    /* A device root: convert to a long UNC path. */
    PathBuf out;
    pb_init(&out);
    pb_append(&out, "\\\\?\\", 4);
    pb_append(&out, r, resolved->len);
    scr_str_release(resolved);
    return pb_take(&out);
  }
  return resolved;
}

/* posix.toNamespacedPath is the identity (a non-op on posix systems). */
ScrStr *scr_path_to_namespaced_path(ScrStr *path) { return scr_str_retain(path); }

ScrStr *scr_path_win32_dirname(ScrStr *path) {
  size_t len = path->len;
  const char *p = path->data;
  if (len == 0) return scr_str_new(".", 1);
  long root_end = -1;
  size_t offset = 0;
  char code = p[0];
  if (len == 1) {
    /* Just a path separator (or a single char): exit early. */
    return scr_path_w32_is_sep(code) ? scr_str_new(p, 1) : scr_str_new(".", 1);
  }
  if (scr_path_w32_is_sep(code)) {
    /* Possible UNC root. */
    root_end = 1;
    offset = 1;
    if (scr_path_w32_is_sep(p[1])) {
      size_t j = 2, last = 2;
      while (j < len && !scr_path_w32_is_sep(p[j])) j++;
      if (j < len && j != last) {
        last = j;
        while (j < len && scr_path_w32_is_sep(p[j])) j++;
        if (j < len && j != last) {
          last = j;
          while (j < len && !scr_path_w32_is_sep(p[j])) j++;
          if (j == len) {
            /* A UNC root only. */
            return scr_str_new(p, len);
          }
          if (j != last) {
            /* A UNC root with leftovers: include the separator after it
             * ("normal root" on top of the UNC root). */
            root_end = (long)j + 1;
            offset = j + 1;
          }
        }
      }
    }
  } else if (scr_path_w32_is_device_root(code) && p[1] == ':') {
    root_end = len > 2 && scr_path_w32_is_sep(p[2]) ? 3 : 2;
    offset = (size_t)root_end;
  }
  long end = -1;
  bool matched_slash = true;
  for (long i = (long)len - 1; i >= (long)offset; --i) {
    if (scr_path_w32_is_sep(p[i])) {
      if (!matched_slash) {
        end = i;
        break;
      }
    } else {
      matched_slash = false;
    }
  }
  if (end == -1) {
    if (root_end == -1) return scr_str_new(".", 1);
    end = root_end;
  }
  return scr_str_new(p, (size_t)end);
}

ScrStr *scr_path_win32_basename(ScrStr *path, ScrStr *suffix) {
  const char *p = path->data;
  long len = (long)path->len;
  long start = 0;
  long end = -1;
  bool matched_slash = true;
  /* A drive-letter prefix's separator is not a trailing separator. */
  if (len >= 2 && scr_path_w32_is_device_root(p[0]) && p[1] == ':') start = 2;
  if (suffix->len > 0 && suffix->len <= path->len) {
    if (suffix->len == path->len && memcmp(suffix->data, p, path->len) == 0) {
      return scr_str_new("", 0);
    }
    long ext_idx = (long)suffix->len - 1;
    long first_non_slash_end = -1;
    for (long i = len - 1; i >= start; --i) {
      char code = p[i];
      if (scr_path_w32_is_sep(code)) {
        if (!matched_slash) {
          start = i + 1;
          break;
        }
      } else {
        if (first_non_slash_end == -1) {
          matched_slash = false;
          first_non_slash_end = i + 1;
        }
        if (ext_idx >= 0) {
          if (code == suffix->data[ext_idx]) {
            if (--ext_idx == -1) end = i;
          } else {
            ext_idx = -1;
            end = first_non_slash_end;
          }
        }
      }
    }
    if (start == end) end = first_non_slash_end;
    else if (end == -1) end = len;
    return scr_str_new(p + start, (size_t)(end - start));
  }
  for (long i = len - 1; i >= start; --i) {
    if (scr_path_w32_is_sep(p[i])) {
      if (!matched_slash) {
        start = i + 1;
        break;
      }
    } else if (end == -1) {
      matched_slash = false;
      end = i + 1;
    }
  }
  if (end == -1) return scr_str_new("", 0);
  return scr_str_new(p + start, (size_t)(end - start));
}

ScrStr *scr_path_win32_extname(ScrStr *path) {
  const char *p = path->data;
  long len = (long)path->len;
  long start = 0;
  long start_dot = -1;
  long start_part = 0;
  long end = -1;
  bool matched_slash = true;
  /* preDotState: 0 = start, 1 = saw non-dot chars, -1 = ext-disqualified. */
  int pre_dot_state = 0;
  /* A drive-letter prefix's separator is not a trailing separator. */
  if (len >= 2 && p[1] == ':' && scr_path_w32_is_device_root(p[0])) {
    start = start_part = 2;
  }
  for (long i = len - 1; i >= start; --i) {
    char code = p[i];
    if (scr_path_w32_is_sep(code)) {
      if (!matched_slash) {
        start_part = i + 1;
        break;
      }
      continue;
    }
    if (end == -1) {
      matched_slash = false;
      end = i + 1;
    }
    if (code == '.') {
      if (start_dot == -1) start_dot = i;
      else if (pre_dot_state != 1) pre_dot_state = 1;
    } else if (start_dot != -1) {
      pre_dot_state = -1;
    }
  }
  if (start_dot == -1 || end == -1 || pre_dot_state == 0 ||
      (pre_dot_state == 1 && start_dot == end - 1 && start_dot == start_part + 1)) {
    return scr_str_new("", 0);
  }
  return scr_str_new(p + start_dot, (size_t)(end - start_dot));
}
