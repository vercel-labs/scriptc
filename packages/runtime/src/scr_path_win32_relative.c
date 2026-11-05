/* node:path's win32.relative (scr_path.c holds the rest of path.win32).
 * Node lowercases both resolved paths with String.prototype.toLowerCase,
 * so the comparison uses the runtime's Unicode case mapping
 * (scr_str_to_lower, scr_regex.c). That keeps scr_path.c free of the case
 * tables: this unit links with the regex unit, which the compiler selects
 * for every program that calls path.win32.relative.
 *
 * Inputs are BORROWED; results are fresh (+1). Nothing here throws. */
#include "scr_runtime.h"

#include <string.h>

/* win32.relative when lowercasing changed a length: Node compares the
 * '\\'-separated segments case-insensitively instead (a trailing empty
 * segment dropped) and joins the rest of `to`. */
static ScrStr *scr_path_w32_relative_split(ScrStr *from, ScrStr *to) {
  ScrArr *parts[2];
  ScrStr *sides[2] = {from, to};
  for (int side = 0; side < 2; side++) {
    ScrStr *s = sides[side];
    parts[side] = scr_arr_new(SCR_ELEM_STR, 4);
    size_t start = 0;
    for (size_t k = 0; k <= s->len; k++) {
      if (k == s->len || s->data[k] == '\\') {
        if (!(k == s->len && k == start)) {
          scr_arr_push_ref(parts[side], scr_str_new(s->data + start, k - start));
        }
        start = k + 1;
      }
    }
  }
  size_t from_len = scr_arr_len(parts[0]), to_len = scr_arr_len(parts[1]);
  size_t length = from_len < to_len ? from_len : to_len;
  size_t i = 0;
  for (; i < length; i++) {
    ScrStr *a = scr_arr_get_ref(parts[0], (double)i);
    ScrStr *b = scr_arr_get_ref(parts[1], (double)i);
    ScrStr *la = scr_str_to_lower(a);
    ScrStr *lb = scr_str_to_lower(b);
    bool same = la->len == lb->len && memcmp(la->data, lb->data, la->len) == 0;
    scr_str_release(la);
    scr_str_release(lb);
    scr_str_release(a);
    scr_str_release(b);
    if (!same) break;
  }
  ScrJsonBuf out;
  scr_jb_init(&out);
  if (i == 0) {
    scr_jb_write(&out, to->data, to->len);
  } else {
    size_t ups = i == length ? (to_len > length ? 0 : from_len > length ? from_len - i : 0) : from_len - i;
    for (size_t k = 0; k < ups; k++) {
      if (i == length && k + 1 == ups) scr_jb_write(&out, "..", 2);
      else scr_jb_write(&out, "..\\", 3);
    }
    if (i < length || to_len > length) {
      for (size_t k = i; k < to_len; k++) {
        ScrStr *part = scr_arr_get_ref(parts[1], (double)k);
        if (k > i) scr_jb_putc(&out, '\\');
        scr_jb_write(&out, part->data, part->len);
        scr_str_release(part);
      }
    }
  }
  scr_arr_release(parts[0]);
  scr_arr_release(parts[1]);
  return scr_jb_finish(&out);
}

/* win32.relative over the lowercased paths `from` and `to`, whose UTF-16
 * lengths are the originals': Node's longest-common-path walk by UTF-16
 * unit, slicing the original `orig_to`. */
static ScrStr *scr_path_w32_relative_units(ScrStr *from, ScrStr *to, ScrStr *orig_to) {
  const double bs = '\\';
  double from_n = scr_str_utf16_len(from), to_n = scr_str_utf16_len(to);
  /* Trim leading backslashes, and trailing ones (UNC paths only). */
  double from_start = 0;
  while (from_start < from_n && scr_str_char_code_at(from, from_start) == bs) from_start++;
  double from_end = from_n;
  while (from_end - 1 > from_start && scr_str_char_code_at(from, from_end - 1) == bs) from_end--;
  const double from_len = from_end - from_start;
  double to_start = 0;
  while (to_start < to_n && scr_str_char_code_at(to, to_start) == bs) to_start++;
  double to_end = to_n;
  while (to_end - 1 > to_start && scr_str_char_code_at(to, to_end - 1) == bs) to_end--;
  const double to_len = to_end - to_start;

  const double length = from_len < to_len ? from_len : to_len;
  double last_common_sep = -1;
  double i = 0;
  for (; i < length; i++) {
    double from_code = scr_str_char_code_at(from, from_start + i);
    if (from_code != scr_str_char_code_at(to, to_start + i)) break;
    if (from_code == bs) last_common_sep = i;
  }
  if (i != length) {
    /* Mismatch before any common separator: return toOrig. */
    if (last_common_sep == -1) return scr_str_retain(orig_to);
  } else {
    if (to_len > length) {
      /* `from` is the exact base path of `to`, or the device root. */
      if (scr_str_char_code_at(to, to_start + i) == bs)
        return scr_str_slice(orig_to, to_start + i + 1, to_n);
      if (i == 2) return scr_str_slice(orig_to, to_start + i, to_n);
    }
    if (from_len > length) {
      if (scr_str_char_code_at(from, from_start + i) == bs) last_common_sep = i;
      else if (i == 2) last_common_sep = 3;
    }
    if (last_common_sep == -1) last_common_sep = 0;
  }
  ScrJsonBuf out;
  scr_jb_init(&out);
  for (i = from_start + last_common_sep + 1; i <= from_end; ++i) {
    if (i == from_end || scr_str_char_code_at(from, i) == bs) {
      if (out.len == 0) scr_jb_write(&out, "..", 2);
      else scr_jb_write(&out, "\\..", 3);
    }
  }
  to_start += last_common_sep;
  /* Node reads toOrig.charCodeAt(toStart) — NaN out of range. */
  if (out.len == 0 && scr_str_char_code_at(orig_to, to_start) == bs) ++to_start;
  /* toOrig.slice(toStart, toEnd) — "" when the range is empty/inverted. */
  ScrStr *tail = scr_str_slice(orig_to, to_start, to_end);
  scr_jb_write(&out, tail->data, tail->len);
  scr_str_release(tail);
  return scr_jb_finish(&out);
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
  /* Node compares the lowercased paths (String.prototype.toLowerCase),
   * indexing UTF-16 units. */
  ScrStr *flow = scr_str_to_lower(rfrom);
  ScrStr *tlow = scr_str_to_lower(rto);
  ScrStr *result = NULL;
  if (flow->len == tlow->len && memcmp(flow->data, tlow->data, flow->len) == 0) {
    result = scr_str_new("", 0);
  } else if (scr_str_utf16_len(rfrom) != scr_str_utf16_len(flow) ||
             scr_str_utf16_len(rto) != scr_str_utf16_len(tlow)) {
    result = scr_path_w32_relative_split(rfrom, rto);
  } else {
    result = scr_path_w32_relative_units(flow, tlow, rto);
  }
  scr_str_release(flow);
  scr_str_release(tlow);
  scr_str_release(rfrom);
  scr_str_release(rto);
  return result;
}

