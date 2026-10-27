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
