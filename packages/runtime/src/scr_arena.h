#ifndef SCR_ARENA_H
#define SCR_ARENA_H
/* Group arenas (llvm/region-groups.ts, llvm/arenas.ts): the objects a call
 * allocates while the compiler has proven they die together, bump-allocated
 * and released at once.
 *
 * Two kinds of call open one:
 * - a fresh-result call (a root) whose value its caller keeps in one scope:
 *   the arena stays the allocation target while the call runs, and is
 *   dropped when that scope exits, on every path;
 * - a call region, a call of a function that keeps nothing it allocates
 *   and returns no reference: the arena is dropped when the call returns.
 *
 * Only allocation sites in functions the compiler reached from such a call
 * consult the target (scr_arena_cur), and only those whose value the group
 * keeps (llvm/region-sites.ts), so runtime-internal allocations and
 * temporaries never land in an arena.
 *
 * An arena object is an ordinary object with an ordinary count, starting
 * at SCR_ARENA_RC instead of 1, so no release reaches zero while it lives:
 * no teardown, no free, and (with `buf` SCR_CYC_ACYCLIC) never a collector
 * candidate. The count is far below SCR_RC_PUBLISHED, so the arena object
 * stays mutable and thread-local like any other. Dropping the arena runs
 * its dispose list, whose entries release their objects' fields (and
 * storage) without freeing the objects, and then recycles the memory. A
 * closed arena's objects hold only each other and immortal values, so only
 * objects with storage of their own (arrays) go on its list.
 *
 * Without the small-object allocator (sanitized and audit builds), every
 * arena object is a block of its own that the drop frees, so a use after
 * the drop is a use after free that the sanitizer reports. */
#include "scr_core.h"

#include <stddef.h>
#include <stdint.h>

/* The starting count of an arena object (a count, in the low 32 bits of
 * the rc word, so it also suits classes that keep their id in the high
 * half). */
#define SCR_ARENA_RC ((uint32_t)1 << 29)

typedef struct ScrArena ScrArena;
/* Releases what an arena object holds (its fields, an array's storage)
 * without freeing the object. */
typedef void (*ScrArenaDispose)(void *obj);

/* An entry of an arena's dispose list. The emitted arena-aware
 * constructors append one inline for an object whose type has fields to
 * release, unless the arena is closed (llvm/arenas.ts). */
typedef struct ScrArenaDisposal {
  void *obj;
  ScrArenaDispose dispose;
} ScrArenaDisposal;

/* The arena that allocation sites in arena-aware functions use, or NULL.
 * Emitted code reads scr_arena_cur directly outside worker programs. */
extern SCR_TL ScrArena *scr_arena_cur;
void *scr_arena_current(void);
/* Stops any arena being the allocation target while a call whose value
 * its group does not keep runs; returns the target, which
 * scr_arena_resume restores. */
void *scr_arena_suspend(void);
void scr_arena_resume(void *arena);
/* Opens an arena as the allocation target and links it onto `*list`, the
 * list its scope drops. Returns it. A `closed` arena's objects hold only
 * each other and immortal values (the compiler proved it), so dropping it
 * releases nothing. */
void *scr_arena_open(void **list, int32_t closed);
/* Stops `arena` (may be NULL) being the allocation target; its objects
 * live on until its list is dropped. */
void scr_arena_close(void *arena);
/* Drops every arena on `*list`, newest first, and clears the list. */
void scr_arena_drop(void **list);
/* A zeroed object of `size` bytes in `arena` (behind a collector header
 * when `cyc` is not NULL, its `buf` SCR_CYC_ACYCLIC), for when the emitted
 * bump finds no room: a new chunk. Returns NULL when an arena that is not
 * closed is past its byte cap and `cyc` is NULL, and the caller allocates
 * on the heap. The caller stores the count (SCR_ARENA_RC). */
void *scr_arena_obj(void *arena, size_t size, void *cyc);
/* Appends `obj` to `arena`'s dispose list, which the drop runs. */
void scr_arena_disposal(void *arena, void *obj, ScrArenaDispose dispose);

/* The leading fields of an arena (scr_arena.c's ScrArena), for the
 * runtime's own inline allocation. */
typedef struct ScrArenaHead {
  char *bump, *limit;
  ScrArenaDisposal *disposals, *disposals_end;
  uint32_t closed;
} ScrArenaHead;

/* `n` bytes (a multiple of 8) from `arena`'s current chunk, not cleared,
 * or NULL when the chunk has no room (scr_arena_obj takes a new one). */
static inline void *scr_arena_bump(void *arena, size_t n) {
  ScrArenaHead *h = (ScrArenaHead *)arena;
  if ((size_t)(h->limit - h->bump) < n) return NULL;
  char *p = h->bump;
  h->bump = p + n;
  return p;
}

/* scr_arena_disposal with the append inline. */
static inline void scr_arena_dispose_later(void *arena, void *obj, ScrArenaDispose dispose) {
  ScrArenaHead *h = (ScrArenaHead *)arena;
  if (h->disposals == h->disposals_end) {
    scr_arena_disposal(arena, obj, dispose);
    return;
  }
  h->disposals->obj = obj;
  h->disposals->dispose = dispose;
  h->disposals++;
}

static inline int scr_arena_is_closed(void *arena) { return ((ScrArenaHead *)arena)->closed != 0; }

#endif
