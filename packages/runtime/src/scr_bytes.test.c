#include "scr_runtime.h"
#include <assert.h>
#include <math.h>
#include <string.h>

long scr_bytes_live_count(void);

/* Foreign wrappers may alias without a shared owner and may be unaligned. */
static ScrBytes *external(uint8_t *data, ScrBytesElem elem, size_t count) {
  ScrBytes *view = scr_bytes_from_external(data, count * scr_bytes_elem_size(elem));
  view->elem = elem;
  view->len = count;
  return view;
}

static void external_set(void) {
  const size_t starts[] = {1, 9, 41, 3001};
  uint8_t storage[6000], expected[6000];
  for (ScrBytesElem from = SCR_BYTES_U8; from <= SCR_BYTES_U8C; from++) {
    for (ScrBytesElem to = SCR_BYTES_U8; to <= SCR_BYTES_U8C; to++) {
      for (size_t j = 0; j < sizeof starts / sizeof starts[0]; j++) {
        memset(storage, 0x5a, sizeof storage);
        ScrBytes *src = external(storage + 9, from, 259);
        ScrBytes *dst = external(storage + starts[j], to, 263);
        for (size_t i = 0; i < src->len; i++) scr_bytes_set(src, i, (double)i * 3.5 - 257);
        memcpy(expected, storage, sizeof storage);
        ScrBytes *want = external(expected + starts[j], to, 263);
        for (size_t i = 0; i < src->len; i++) scr_bytes_set(want, i + 2, scr_bytes_get(src, i));
        scr_bytes_set_from(dst, src, 2);
        assert(!scr_exc_pending());
        assert(memcmp(storage, expected, sizeof storage) == 0);
        scr_bytes_release(want);
        scr_bytes_release(dst);
        scr_bytes_release(src);
      }
    }
  }
}

/* Same-kind sets into and out of shared storage copy raw bytes, NaN
 * payloads included, also between overlapping views of one shared buffer. */
static void shared_set(void) {
  enum { COUNT = 37 };
  for (ScrBytesElem elem = SCR_BYTES_U8; elem <= SCR_BYTES_F16; elem++) {
    size_t width = scr_bytes_elem_size(elem), bytes = COUNT * width;
    uint8_t pattern[COUNT * 8], expected[COUNT * 8];
    for (size_t i = 0; i < bytes; i++) pattern[i] = (uint8_t)(i * 37 + 0x7f);
    /* Signaling NaNs, which a conversion through double would quiet. */
    const uint16_t nan16 = 0x7d01;
    const uint32_t nan32 = 0x7fa00001;
    const uint64_t nan64 = UINT64_C(0x7ff4000000000001);
    for (size_t i = 1; i < COUNT; i += 6) {
      if (elem == SCR_BYTES_F16) memcpy(pattern + i * width, &nan16, width);
      if (elem == SCR_BYTES_F32) memcpy(pattern + i * width, &nan32, width);
      if (elem == SCR_BYTES_F64) memcpy(pattern + i * width, &nan64, width);
    }
    for (int direction = 0; direction < 2; direction++) {
      ScrBytes *shared = scr_bytes_new(elem, COUNT);
      scr_bytes_make_shared(shared);
      memcpy(shared->data, pattern, bytes);
      ScrBytes *src = direction ? scr_bytes_subarray(shared, 3, COUNT) : scr_bytes_subarray(shared, 0, COUNT - 3);
      double offset = direction ? 0 : 3;
      memcpy(expected, pattern, bytes);
      memmove(expected + (size_t)offset * width, pattern + (direction ? 3 : 0) * width, (COUNT - 3) * width);
      scr_bytes_set_from(shared, src, offset);
      assert(!scr_exc_pending());
      assert(memcmp(shared->data, expected, bytes) == 0);
      scr_bytes_release(src);

      ScrBytes *local = scr_bytes_new(elem, COUNT);
      memcpy(local->data, pattern, bytes);
      ScrBytes *head = scr_bytes_subarray(local, 0, COUNT - 1);
      scr_bytes_set_from(shared, head, 1);
      memcpy(expected + width, pattern, bytes - width);
      assert(memcmp(shared->data, expected, bytes) == 0);
      memset(local->data, 0, bytes);
      scr_bytes_set_from(local, shared, 0);
      assert(memcmp(local->data, expected, bytes) == 0);
      scr_bytes_release(head);
      scr_bytes_release(local);
      scr_bytes_release(shared);
    }
  }
}

static void copied_storage(void) {
  /* Same-kind copies preserve NaN payloads, signed zero and ownership. */
  const uint64_t bits[] = {UINT64_C(0x7ff8000000000042), UINT64_C(0x8000000000000000),
                           UINT64_C(0xfff0000000000000)};
  ScrBytes *src = scr_bytes_new(SCR_BYTES_F64, 3);
  memcpy(src->data, bits, sizeof bits);
  ScrBytes *copy = scr_bytes_convert(SCR_BYTES_F64, src);
  ScrBytes *slice = scr_bytes_slice(src, 0, 3);
  assert(copy->data != src->data && slice->data != src->data);
  assert(memcmp(copy->data, bits, sizeof bits) == 0);
  assert(memcmp(slice->data, bits, sizeof bits) == 0);
  ScrBytes *view = scr_bytes_subarray(copy, 1, 3);
  scr_bytes_release(copy);
  scr_bytes_release(src);
  assert(memcmp(view->data, bits + 1, sizeof bits - sizeof bits[0]) == 0);
  scr_bytes_release(view);
  scr_bytes_release(slice);
}

static void filled_storage(void) {
  uint8_t storage[2200], expected[2200];
  const double values[] = {-0.0, -1.5, 2.5, 255.5, 4294967297.0, NAN, INFINITY};
  for (ScrBytesElem elem = SCR_BYTES_U8; elem <= SCR_BYTES_U8C; elem++) {
    for (size_t j = 0; j < sizeof values / sizeof values[0]; j++) {
      memset(storage, 0xa5, sizeof storage);
      memcpy(expected, storage, sizeof storage);
      ScrBytes *dst = external(storage + 1, elem, 263);
      ScrBytes *want = external(expected + 1, elem, 263);
      for (size_t i = 2; i < 261; i++) scr_bytes_set(want, i, values[j]);
      ScrBytes *result = scr_bytes_fill_elem(dst, values[j], 2, 261);
      assert(result == dst && dst->rc == 2);
      assert(memcmp(storage, expected, sizeof storage) == 0);
      scr_bytes_release(result);
      scr_bytes_release(dst);
      scr_bytes_release(want);
    }
  }
}

void scr_bytes_test_bulk_storage(void) {
  long before = scr_bytes_live_count();
  external_set();
  shared_set();
  copied_storage();
  filled_storage();
  assert(scr_bytes_live_count() == before);
}

/* The Buffer pool: views into one slab at 8-byte aligned offsets, the
 * threshold, a slab whose size is not a multiple of 8, the slab's lifetime
 * through its views, and the reset that drops the pool's own reference. */
void scr_bytes_test_buffer_pool(void) {
  long before = scr_bytes_live_count();
  scr_buffer_pool_reset();
  ScrBytes *a = scr_buffer_alloc_unsafe(3);
  ScrBytes *b = scr_buffer_alloc_unsafe(9);
  ScrBytes *c = scr_buffer_alloc_unsafe(1);
  assert(a->backing && a->backing == b->backing && b->backing == c->backing);
  assert(a->backing->len == 65536 && a->backing->untransferable);
  assert(scr_bytes_byte_offset(a) == 0 && scr_bytes_byte_offset(b) == 8 &&
         scr_bytes_byte_offset(c) == 24);
  ScrBytes *slab = scr_bytes_retain(a->backing);
  ScrBytes *big = scr_buffer_alloc_unsafe(32768);
  assert(big && !big->backing && big->len == 32768);
  ScrBytes *edge = scr_buffer_alloc_unsafe(32767);
  assert(edge->backing == slab);

  /* A 60-byte slab: after offset 56 four bytes remain, then none. */
  scr_buffer_set_pool_size(60);
  ScrBytes *t = scr_buffer_alloc_unsafe(29);
  while (scr_bytes_byte_offset(t) != 0) {
    scr_bytes_release(t);
    t = scr_buffer_alloc_unsafe(29);
  }
  assert(t->backing->len == 60);
  ScrBytes *u = scr_buffer_alloc_unsafe(20);
  ScrStr *euro = scr_str_new("\xe2\x82\xac", 3), *utf16 = scr_str_new("utf16le", 7);
  ScrBytes *w = scr_buffer_from_str(euro, utf16);
  assert(w->backing == t->backing && scr_bytes_byte_offset(w) == 56 && w->len == 2);
  assert(w->data[0] == 0xac && w->data[1] == 0x20);
  ScrBytes *x = scr_buffer_alloc_unsafe(1);
  assert(x->backing != t->backing && scr_bytes_byte_offset(x) == 0);
  scr_buffer_set_pool_size(0);
  ScrBytes *y = scr_buffer_alloc_unsafe(1);
  assert(!y->backing);

  ScrBytes *views[] = {a, b, c, edge, t, u, w, x, y, big};
  for (size_t i = 0; i < sizeof views / sizeof views[0]; i++) scr_bytes_release(views[i]);
  /* The first slab lives while a reference to it does. */
  assert(slab->rc == 1);
  scr_bytes_release(slab);
  scr_str_release(euro);
  scr_str_release(utf16);
  scr_buffer_pool_reset();
  assert(scr_buffer_pool_size() == 65536);
  assert(scr_bytes_live_count() == before);
}

/* src.copy(dst, targetStart?, sourceStart?, sourceEnd?): every index
 * converts through copyImpl's toInteger — a fractional index floors, and
 * NaN, ±Infinity and a value outside the safe-integer range become the
 * default 0 — so no index is ever reported as a non-integer. Only the
 * sign and the bounds Node checks remain, and an absent index keeps its
 * default (0, or the source length for sourceEnd) without converting. */
void scr_bytes_test_copy_ladder(void) {
  long before = scr_bytes_live_count();
  ScrBytes *src = scr_bytes_new(SCR_BYTES_U8, 8);
  for (size_t i = 0; i < 8; i++) scr_bytes_set(src, (double)i, (double)('a' + i));
  ScrBytes *dst = scr_bytes_new(SCR_BYTES_U8, 8);

  /* Fractional positions floor (toward -infinity, as Node's toInteger). */
  for (size_t i = 0; i < 5; i++) scr_bytes_set(dst, (double)i, 'x');
  assert(scr_bytes_copy_into(src, dst, 3, 1.9, 2.9, 4.9) == 2);
  assert(dst->data[0] == 'x' && dst->data[1] == 'c' && dst->data[2] == 'd' && dst->data[3] == 'x');

  /* NaN and ±Infinity in every position are 0, never a range error. */
  assert(scr_bytes_copy_into(src, dst, 1, NAN, 0, 0) == 8);
  assert(scr_bytes_copy_into(src, dst, 1, INFINITY, 0, 0) == 8);
  assert(scr_bytes_copy_into(src, dst, 1, -INFINITY, 0, 0) == 8);
  assert(scr_bytes_copy_into(src, dst, 2, 0, NAN, 0) == 8);
  assert(scr_bytes_copy_into(src, dst, 2, 0, -INFINITY, 0) == 8);
  assert(scr_bytes_copy_into(src, dst, 3, 0, 0, NAN) == 0);
  assert(scr_bytes_copy_into(src, dst, 3, 0, 0, INFINITY) == 0);

  /* An integer-valued index beyond the safe-integer range is kept (it
   * starts past both buffers), while a non-integer one there becomes 0. */
  assert(scr_bytes_copy_into(src, dst, 1, 1e300, 0, 0) == 0);
  assert(scr_bytes_copy_into(src, dst, 2, 0, 1e300, 0) == 0 && scr_exc_pending());
  scr_exc_clear();
  assert(scr_bytes_copy_into(src, dst, 3, 0, 1, 1e300) == 7);

  /* The bounds Node checks after conversion still throw. */
  assert(scr_bytes_copy_into(src, dst, 1, -1, 0, 0) == 0 && scr_exc_pending());
  scr_exc_clear();
  assert(scr_bytes_copy_into(src, dst, 2, 0, -1, 0) == 0 && scr_exc_pending());
  scr_exc_clear();
  assert(scr_bytes_copy_into(src, dst, 2, 0, 9, 0) == 0 && scr_exc_pending());
  scr_exc_clear();
  assert(scr_bytes_copy_into(src, dst, 3, 0, 0, -1) == 0 && scr_exc_pending());
  scr_exc_clear();

  /* Absent positions keep their defaults: the whole source at target 0. */
  assert(scr_bytes_copy_into(src, dst, 0, -5, -5, -5) == 8);
  assert(memcmp(dst->data, src->data, 8) == 0);

  scr_bytes_release(dst);
  scr_bytes_release(src);
  assert(scr_bytes_live_count() == before);
}

/* indexOf/lastIndexOf's byteOffset ladder: a negative offset counts from
 * the end, one that starts before the first byte searches nothing going
 * back — except for an empty needle, which matches at 0 — NaN searches
 * everything (0 forward, the end backward), and fractions truncate. */
void scr_bytes_test_search_offsets(void) {
  long before = scr_bytes_live_count();
  ScrBytes *hay = scr_bytes_new(SCR_BYTES_U8, 9);
  for (size_t i = 0; i < 9; i++) scr_bytes_set(hay, (double)i, "abcabcabc"[i]);
  ScrBytes *empty = scr_bytes_new(SCR_BYTES_U8, 0);
  ScrBytes *bc = scr_bytes_new(SCR_BYTES_U8, 2);
  scr_bytes_set(bc, 0, 'b');
  scr_bytes_set(bc, 1, 'c');
  const double offsets[] = { -99, -9, -10, -1, 0, 1, NAN, 9, 99, 1.5, INFINITY, -INFINITY };
  /* Node's answers for indexOf(needle, offset) and lastIndexOf(needle, offset). */
  const double want_empty_fwd[] = { 0, 0, 0, 8, 0, 1, 0, 9, 9, 1, 9, 0 };
  const double want_empty_back[] = { 0, 0, 0, 8, 0, 1, 9, 9, 9, 1, 9, 0 };
  const double want_bc_fwd[] = { 1, 1, 1, -1, 1, 1, 1, -1, -1, 1, -1, 1 };
  const double want_bc_back[] = { -1, -1, -1, 7, -1, 1, 7, 7, 7, 1, 7, -1 };
  for (size_t i = 0; i < sizeof offsets / sizeof offsets[0]; i++) {
    assert(scr_bytes_index_of(hay, empty, offsets[i], 1, true) == want_empty_fwd[i]);
    assert(scr_bytes_index_of(hay, empty, offsets[i], 1, false) == want_empty_back[i]);
    assert(scr_bytes_index_of(hay, bc, offsets[i], 1, true) == want_bc_fwd[i]);
    assert(scr_bytes_index_of(hay, bc, offsets[i], 1, false) == want_bc_back[i]);
  }
  /* utf16le searches whole 2-byte units. */
  ScrBytes *u16 = scr_bytes_new(SCR_BYTES_U8, 6);
  const uint8_t u16bytes[] = { 0x61, 0x00, 0x62, 0x00, 0x63, 0x00 };
  for (size_t i = 0; i < 6; i++) scr_bytes_set(u16, (double)i, u16bytes[i]);
  ScrBytes *b16 = scr_bytes_new(SCR_BYTES_U8, 2);
  scr_bytes_set(b16, 0, 'b');
  scr_bytes_set(b16, 1, 0);
  assert(scr_bytes_index_of(u16, b16, -99, 2, true) == 2);
  assert(scr_bytes_index_of(u16, b16, -1, 2, true) == -1);
  assert(scr_bytes_index_of(u16, b16, NAN, 2, false) == 2);
  assert(scr_bytes_index_of(u16, b16, 99, 2, false) == 2);
  scr_bytes_release(b16);
  scr_bytes_release(u16);
  scr_bytes_release(bc);
  scr_bytes_release(empty);
  scr_bytes_release(hay);
  assert(scr_bytes_live_count() == before);
}
/* Buffer.copyBytesFrom(view[, offset[, length]]): a pooled copy of the
 * view's underlying bytes over [offset, offset + length) in element
 * indices — a wider typed array copies BYTES_PER_ELEMENT bytes per element
 * — with Node's validateInteger ladder on the supplied positions only, and
 * an empty view answering an empty Buffer before either position is read. */
void scr_bytes_test_copy_bytes_from(void) {
  scr_buffer_pool_reset();
  long before = scr_bytes_live_count();
  ScrBytes *u8 = scr_bytes_new(SCR_BYTES_U8, 3);
  for (size_t i = 0; i < 3; i++) scr_bytes_set(u8, (double)i, (double)(i + 1));
  ScrBytes *u16 = scr_bytes_new(SCR_BYTES_U16, 2);
  scr_bytes_set(u16, 0, 0x0102);
  scr_bytes_set(u16, 1, 0x0304);
  ScrBytes *empty = scr_bytes_new(SCR_BYTES_U8, 0);

  ScrBytes *all = scr_buffer_copy_bytes_from(u8, 0, 0, 0);
  assert(all->len == 3 && all->data[0] == 1 && all->data[2] == 3 && all->backing != NULL);
  scr_bytes_release(all);

  ScrBytes *tail = scr_buffer_copy_bytes_from(u8, 1, 0, 1);
  assert(tail->len == 2 && tail->data[0] == 2 && tail->data[1] == 3);
  scr_bytes_release(tail);

  ScrBytes *one = scr_buffer_copy_bytes_from(u8, 1, 1, 3);
  assert(one->len == 1 && one->data[0] == 2);
  scr_bytes_release(one);

  ScrBytes *clamped = scr_buffer_copy_bytes_from(u8, 2, 9, 3);
  assert(clamped->len == 1 && clamped->data[0] == 3);
  scr_bytes_release(clamped);

  ScrBytes *past = scr_buffer_copy_bytes_from(u8, 3, 0, 1);
  assert(past->len == 0);
  scr_bytes_release(past);

  ScrBytes *zero = scr_buffer_copy_bytes_from(u8, 0, 0, 3);
  assert(zero->len == 0);
  scr_bytes_release(zero);

  /* Element indices: the wider view copies its bytes, not its count. */
  ScrBytes *wide = scr_buffer_copy_bytes_from(u16, 0, 0, 0);
  assert(wide->len == 4 && wide->data[0] == 0x02 && wide->data[1] == 0x01 &&
         wide->data[2] == 0x04 && wide->data[3] == 0x03);
  scr_bytes_release(wide);
  ScrBytes *wide_second = scr_buffer_copy_bytes_from(u16, 1, 0, 1);
  assert(wide_second->len == 2 && wide_second->data[0] == 0x04 && wide_second->data[1] == 0x03);
  scr_bytes_release(wide_second);

  /* An empty view answers an empty Buffer before a bad position is read. */
  ScrBytes *empty_copy = scr_buffer_copy_bytes_from(empty, -1, -1, 3);
  assert(empty_copy->len == 0 && !scr_exc_pending());
  scr_bytes_release(empty_copy);

  /* Supplied positions take validateInteger, in argument order. */
  assert(scr_buffer_copy_bytes_from(u8, -1, 0, 1) == NULL && scr_exc_pending());
  scr_exc_clear();
  assert(scr_buffer_copy_bytes_from(u8, 1.5, 0, 1) == NULL && scr_exc_pending());
  scr_exc_clear();
  assert(scr_buffer_copy_bytes_from(u8, NAN, 0, 1) == NULL && scr_exc_pending());
  scr_exc_clear();
  assert(scr_buffer_copy_bytes_from(u8, 0, -1, 2) == NULL && scr_exc_pending());
  scr_exc_clear();
  assert(scr_buffer_copy_bytes_from(u8, 0, 1.5, 2) == NULL && scr_exc_pending());
  scr_exc_clear();
  /* An absent position skips its validation even when the value is junk. */
  ScrBytes *absent = scr_buffer_copy_bytes_from(u8, -1, -1, 0);
  assert(absent->len == 3);
  scr_bytes_release(absent);

  scr_bytes_release(empty);
  scr_bytes_release(u16);
  scr_bytes_release(u8);
  scr_buffer_pool_reset();
  assert(scr_bytes_live_count() == before);
}

