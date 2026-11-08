/* Group arenas in a program that stores references in 32-bit fields: every
 * arena object must lie in the allocator window, since a compact class
 * field keeps the address's low bits (scr_arena.h, scr_sa_require_window).
 * Prints one line per check. */
#include "scr_runtime.h"

#include <stdio.h>

typedef struct {
  int64_t rc;
  int64_t id;
} TestObj;

/* Whether p lies in the allocator window (any owner). */
static bool in_window(const void *p) { return (uintptr_t)p - scr_sa.base < scr_sa.span; }

/* What the compiled code does with a reference held in a compact field:
 * address >> 3 in 32 bits, the address back by << 3 (llvm/classes.ts). */
static uint32_t field_of(const void *p) { return (uint32_t)((uintptr_t)p >> 3); }
static const void *from_field(uint32_t f) { return (const void *)((uintptr_t)f << 3); }

int main(void) {
  /* Reserve the window, so that the next check tells the window's blocks
   * from the system allocator's. */
  (void)scr_mem_alloc_ref(64);

  /* A program whose fields keep full pointers uses the arena's inline
   * chunk: its first object is part of the arena itself. */
  void *list = NULL;
  void *a = scr_arena_open(&list, 0);
  TestObj *first = scr_arena_obj(a, sizeof *first, NULL);
  printf("inline chunk: %s\n", first && !in_window(first) ? "system" : "window");
  scr_arena_drop(&list);

  /* One that stores references in 32-bit fields, opened from the pool that
   * held the arena above, takes every object from the window: the inline
   * chunk would be the system allocator's, and a field would truncate it.
   * The objects fill several chunks, and one is larger than a chunk. */
  scr_sa_require_window();
  a = scr_arena_open(&list, 0);
  int windowed = 1;
  for (int i = 0; i < 200000; i++) {
    TestObj *o = scr_arena_obj(a, sizeof *o, NULL);
    if (!o || !in_window(o) || from_field(field_of(o)) != o) windowed = 0;
  }
  printf("arena objects: %s\n", windowed ? "window" : "outside");
  TestObj *large = scr_arena_obj(a, (size_t)3 << 20, NULL);
  printf("large object: %s\n", large && in_window(large) && from_field(field_of(large)) == large
                                  ? "window"
                                  : "outside");
  scr_arena_drop(&list);

  /* A second arena reuses the chunks the drop returned; they keep their
   * source. The thread's pooled chunks go back to the window allocator at
   * its exit, and later arenas still take theirs from the window. */
  windowed = 1;
  for (int round = 0; round < 2; round++) {
    if (round) scr_arena_thread_exit();
    a = scr_arena_open(&list, 0);
    for (int i = 0; i < 20000; i++) {
      TestObj *o = scr_arena_obj(a, sizeof *o, NULL);
      if (!o || !in_window(o) || from_field(field_of(o)) != o) windowed = 0;
    }
    scr_arena_drop(&list);
  }
  printf("reused chunks: %s\n", windowed ? "window" : "outside");
  scr_arena_thread_exit();
  return 0;
}
