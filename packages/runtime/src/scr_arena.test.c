/* Group arenas (scr_arena.h): allocation, nesting, closing and dropping,
 * and the drop's dispose list. Prints one line per check. */
#include "scr_runtime.h"

#include <stdio.h>
#include <string.h>

typedef struct {
  int64_t rc;
  int64_t id;
} TestObj;

static int disposed;
static int64_t disposed_sum;
static void test_dispose(void *obj) {
  disposed++;
  disposed_sum += ((TestObj *)obj)->id;
}
/* What an emitted arena-aware constructor does: the object, and its
 * dispose entry unless the arena is closed. */
static TestObj *obj(void *arena, int64_t id, int closed) {
  TestObj *o = scr_arena_obj(arena, sizeof *o, NULL);
  if (!o) return NULL;
  o->rc = SCR_ARENA_RC;
  o->id = id;
  if (!closed) scr_arena_disposal(arena, o, test_dispose);
  return o;
}

int main(void) {
  /* An open arena is the allocation target until it closes. */
  void *list = NULL;
  void *a = scr_arena_open(&list, 0);
  printf("current while open: %s\n", scr_arena_current() == a ? "yes" : "no");
  TestObj *first = obj(a, 1, 0);
  int zero = 1, adjacent = 1;
  TestObj *prev = first;
  for (int i = 0; i < 16; i++) {
    TestObj *o = scr_arena_obj(a, sizeof *o, NULL);
    if (o->rc != 0 || o->id != 0) zero = 0;
    if ((char *)o != (char *)(prev + 1)) adjacent = 0;
    prev = o;
  }
  printf("objects start zeroed: %s\n", zero ? "yes" : "no");
#if !SCR_SMALL_ALLOC
  adjacent = 1; /* a block per object */
#endif
  printf("objects without headers: %s\n", adjacent ? "yes" : "no");
  /* A nested arena makes the outer one current again when it closes. */
  void *inner_list = NULL;
  void *b = scr_arena_open(&inner_list, 0);
  for (int i = 0; i < 10; i++) obj(b, 100, 0);
  scr_arena_close(b);
  scr_arena_close(b);
  printf("outer current after inner close: %s\n", scr_arena_current() == a ? "yes" : "no");
  scr_arena_drop(&inner_list);
  printf("inner drop disposed %d (sum %lld)\n", disposed, (long long)disposed_sum);
  /* Many objects span chunks; each is disposed once. */
  disposed = 0;
  disposed_sum = 0;
  for (int i = 0; i < 100000; i++) obj(a, 1, 0);
  scr_arena_close(a);
  printf("current after close: %s\n", scr_arena_current() == NULL ? "none" : "some");
  scr_arena_drop(&list);
  printf("drop disposed %d (sum %lld), list %s\n", disposed, (long long)disposed_sum,
         list == NULL ? "cleared" : "kept");

  /* A closed arena's objects take no dispose entries, and it has no cap. */
  disposed = 0;
  void *closed = scr_arena_open(&list, 1);
  int held = 0;
  for (int i = 0; i < 3000000; i++)
    if (obj(closed, 1, 1)) held++;
  scr_arena_drop(&list);
  printf("closed arena held %d, disposed %d, current %s\n", held, disposed,
         scr_arena_current() == NULL ? "none" : "some");

  /* Past the byte cap an arena that is not closed refuses, and its drop
   * disposes everything it holds. */
  disposed = 0;
  void *capped = scr_arena_open(&list, 0);
  int refused = 0;
  held = 0;
  for (int i = 0; i < 3000000 && !refused; i++) {
    if (obj(capped, 1, 0))
      held++;
    else
      refused = 1;
  }
  scr_arena_drop(&list);
  printf("cap refused: %s, all disposed: %s\n", refused ? "yes" : "no", disposed == held ? "yes" : "no");

  /* A drop of an arena that is still open (an exception skipped its close)
   * restores the target it replaced. */
  void *outer_list = NULL, *skipped_list = NULL;
  void *outer = scr_arena_open(&outer_list, 0);
  scr_arena_open(&skipped_list, 0);
  scr_arena_drop(&skipped_list);
  printf("target after dropping an open arena: %s\n", scr_arena_current() == outer ? "outer" : "other");
  /* A suspended arena is no target until it resumes. */
  void *saved = scr_arena_suspend();
  printf("target while suspended: %s\n", scr_arena_current() == NULL ? "none" : "some");
  scr_arena_resume(saved);
  printf("target after resume: %s\n", scr_arena_current() == outer ? "outer" : "other");
  scr_arena_close(outer);
  scr_arena_drop(&outer_list);
  return 0;
}
