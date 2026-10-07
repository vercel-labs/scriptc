#include "scr_runtime.h"

#include <math.h>
#include <stdio.h>
#include <stdint.h>

/* ES2023 Array/TypedArray copying methods and the typed-array-to-number[]
 * bridge live in their own archive member. Programs that do not use this
 * surface therefore pull in none of it — the static binary size contract. */

static uint64_t copying_slot_from_ptr(void *p) {
  return (uint64_t)(uintptr_t)p;
}

static void *copying_slot_to_ptr(uint64_t slot) {
  return (void *)(uintptr_t)slot;
}

static bool copying_elem_is_ref(ScrElemKind kind) {
  return kind == SCR_ELEM_STR || kind == SCR_ELEM_ARR ||
         kind == SCR_ELEM_BYTES || kind == SCR_ELEM_REF;
}

static ScrArr *copying_arr_new_like(const ScrArr *a, size_t cap) {
  ScrArr *out = a->elem == SCR_ELEM_REF
                    ? scr_arr_new_ref(a->elem_retain, a->elem_release,
                                      a->elem_trace, cap ? cap : 1)
                    : scr_arr_new(a->elem, cap ? cap : 1);
  out->len = cap;
  return out;
}

static uint64_t copying_arr_retain_slot(const ScrArr *a, uint64_t slot) {
  if (!copying_elem_is_ref(a->elem)) return slot;
  void *p = copying_slot_to_ptr(slot);
  if (a->elem == SCR_ELEM_STR) p = scr_str_retain((ScrStr *)p);
  else if (a->elem == SCR_ELEM_ARR) p = scr_arr_retain((ScrArr *)p);
  else if (a->elem == SCR_ELEM_BYTES) p = scr_bytes_retain((ScrBytes *)p);
  else p = a->elem_retain(p);
  return copying_slot_from_ptr(p);
}

ScrArr *scr_arr_to_reversed(const ScrArr *a) {
  ScrArr *out = copying_arr_new_like(a, a->len);
  scr_arr_copy_range_ex(out, 0, a, 0, a->len, true, true);
  return out;
}

ScrArr *scr_arr_to_spliced(const ScrArr *a, double start,
                           double delete_count, const ScrArr *items) {
  double len = (double)a->len;
  double s0 = isnan(start) ? 0 : trunc(start);
  if (s0 < 0) s0 += len;
  size_t from = s0 <= 0 ? 0 : s0 >= len ? a->len : (size_t)s0;
  double avail = len - (double)from;
  double d0 = isnan(delete_count) ? 0 : trunc(delete_count);
  size_t ndelete =
      d0 <= 0 ? 0 : d0 >= avail ? (size_t)avail : (size_t)d0;
  if (items->len > SIZE_MAX - (a->len - ndelete)) {
    scr_trap("scriptc: out of memory\n");
  }
  size_t out_len = a->len - ndelete + items->len;
  ScrArr *out = copying_arr_new_like(a, out_len);
  scr_arr_copy_range_ex(out, 0, a, 0, from, false, true);
  scr_arr_copy_range_ex(out, from, items, 0, items->len, false, true);
  scr_arr_copy_range_ex(out, from + items->len, a, from + ndelete,
                        a->len - from - ndelete, false, true);
  return out;
}

static bool copying_arr_with_index(const ScrArr *a, double index,
                                   size_t *out) {
  double rel = isnan(index) ? 0 : trunc(index);
  double actual = rel >= 0 ? rel : (double)a->len + rel;
  if (!(actual >= 0) || actual >= (double)a->len) {
    char num[32];
    size_t numlen = scr_f64_to_str(index, num);
    char msg[80];
    int mlen = snprintf(msg, sizeof msg, "Invalid index : %.*s",
                        (int)numlen, num);
    scr_throw_error_msg(SCR_ERR_RANGE, msg, (size_t)mlen);
    return false;
  }
  *out = (size_t)actual;
  return true;
}

ScrArr *scr_arr_with_f64(ScrArr *a, double index, double value) {
  size_t i;
  if (!copying_arr_with_index(a, index, &i)) return NULL;
  ScrArr *out = copying_arr_new_like(a, a->len);
  scr_arr_copy_range_ex(out, 0, a, 0, a->len, false, true);
  scr_arr_set_f64(out, (double)i, value);
  return out;
}

ScrArr *scr_arr_with_bool(ScrArr *a, double index, bool value) {
  size_t i;
  if (!copying_arr_with_index(a, index, &i)) return NULL;
  ScrArr *out = copying_arr_new_like(a, a->len);
  scr_arr_copy_range_ex(out, 0, a, 0, a->len, false, true);
  scr_arr_set_bool(out, (double)i, value);
  return out;
}

ScrArr *scr_arr_with_ref(ScrArr *a, double index, void *value) {
  size_t i;
  if (!copying_arr_with_index(a, index, &i)) return NULL;
  ScrArr *out = copying_arr_new_like(a, a->len);
  scr_arr_copy_range_ex(out, 0, a, 0, a->len, false, true);
  uint64_t retained =
      copying_arr_retain_slot(a, copying_slot_from_ptr(value));
  scr_arr_set_ref(out, (double)i, copying_slot_to_ptr(retained));
  return out;
}

ScrArr *scr_arr_with_undefined(ScrArr *a, double index) {
  size_t i;
  if (!copying_arr_with_index(a, index, &i)) return NULL;
  ScrArr *out = copying_arr_new_like(a, a->len);
  scr_arr_copy_range_ex(out, 0, a, 0, a->len, false, true);
  scr_arr_set_undefined(out, (double)i);
  return out;
}

ScrBytes *scr_bytes_to_reversed(const ScrBytes *b) {
  SCR_SHARED_GUARD(b, NULL);
  ScrBytes *out = scr_bytes_new(b->elem, (double)b->len);
  size_t width = scr_bytes_elem_size(b->elem);
  /* Copy the stored representation without numeric conversion. Views may
   * be unaligned, so fixed-width memcpy preserves both alignment safety
   * and floating-point payload bits. The width is invariant for the loop. */
  for (size_t i = 0; i < b->len; i++) {
    const uint8_t *source = b->data + (b->len - i - 1) * width;
    uint8_t *target = out->data + i * width;
    switch (width) {
    case 1: *target = *source; break;
    case 2: memcpy(target, source, 2); break;
    case 4: memcpy(target, source, 4); break;
    case 8: memcpy(target, source, 8); break;
    }
  }
  return out;
}

ScrBytes *scr_bytes_with(const ScrBytes *b, double index, double value) {
  double rel = isnan(index) ? 0 : trunc(index);
  double actual = rel >= 0 ? rel : (double)b->len + rel;
  if (!(actual >= 0) || actual >= (double)b->len) {
    static const char msg[] = "Invalid typed array index";
    scr_throw_error_msg(SCR_ERR_RANGE, msg, sizeof msg - 1);
    return NULL;
  }
  ScrBytes *out = scr_bytes_copy(b);
  scr_bytes_set(out, actual, value);
  return out;
}
