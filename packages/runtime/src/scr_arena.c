/* Group arenas: see scr_arena.h. */
#include "scr_runtime.h"

#include <stdbool.h>
#include <stdlib.h>
#include <string.h>

/* The first chunk lives inside the arena, so a small group (one result
 * record, a short builder) touches no other memory. */
#define SCR_ARENA_INLINE 512
#define SCR_ARENA_CHUNK_MIN ((size_t)4096)
#define SCR_ARENA_CHUNK_MAX ((size_t)1 << 20)
/* Bytes an arena that is not closed takes before its call allocates on the
 * heap again: a group whose objects die before it is dropped holds at most
 * this much dead memory. A closed arena has no cap: once on the heap, its
 * later objects could come to be held by earlier ones, which are not on
 * its dispose list. Neither do objects with a collector header: on the
 * heap, they could form cycles that outlive the drop (llvm/arenas.ts). */
#define SCR_ARENA_CAP ((size_t)32 << 20)
/* What a thread keeps for reuse: arenas, chunk bytes, and dispose list
 * entries per pooled arena. */
#define SCR_ARENA_POOL 64
#define SCR_ARENA_POOL_BYTES ((size_t)8 << 20)
#define SCR_ARENA_POOL_DISPOSALS ((size_t)4096)

/* A chunk's objects run from scr_arena_chunk_start to its end. */
typedef struct ScrArenaChunk {
  struct ScrArenaChunk *next;
  size_t size; /* bytes, this header included */
} ScrArenaChunk;

/* The leading fields are an ABI: emitted arena-aware constructors bump
 * `bump` up to `limit`, test `closed`, and append to the dispose list at
 * `disposals` up to `disposals_end` inline (llvm/arenas.ts). Without the
 * small-object allocator `bump` and `limit` stay NULL, so every object
 * takes scr_arena_obj and is a block of its own. */
struct ScrArena {
  char *bump, *limit;
  ScrArenaDisposal *disposals, *disposals_end;
  uint32_t closed;
  uint32_t open;   /* still the allocation target, or under one that is */
  ScrArena *outer; /* the allocation target before it opened */
  ScrArena *next;  /* its scope's list, or the pool */
  ScrArenaDisposal *disposal_base;
  ScrArenaChunk *chunks; /* newest first */
  size_t bytes;
#if !SCR_SMALL_ALLOC
  char **blocks;
  size_t nblocks, cap;
#endif
  _Alignas(16) char inline_chunk[SCR_ARENA_INLINE];
};
/* llvm/arenas.ts addresses these fields in pointer-sized units. */
#define SCR_ARENA_PTR sizeof(void *)
_Static_assert(offsetof(ScrArena, bump) == 0 && offsetof(ScrArena, limit) == SCR_ARENA_PTR,
               "llvm/arenas.ts bumps the arena inline");
_Static_assert(offsetof(ScrArena, disposals) == 2 * SCR_ARENA_PTR &&
                   offsetof(ScrArena, disposals_end) == 3 * SCR_ARENA_PTR &&
                   offsetof(ScrArena, closed) == 4 * SCR_ARENA_PTR,
               "llvm/arenas.ts appends to the dispose list inline");
_Static_assert(sizeof(ScrArenaDisposal) == 2 * SCR_ARENA_PTR,
               "llvm/arenas.ts stores dispose entries of two pointers");
_Static_assert(offsetof(ScrArenaHead, disposals) == offsetof(ScrArena, disposals) &&
                   offsetof(ScrArenaHead, closed) == offsetof(ScrArena, closed),
               "ScrArenaHead is ScrArena's prefix");

SCR_TL ScrArena *scr_arena_cur = NULL;
static SCR_TL ScrArena *scr_arena_pool;
static SCR_TL unsigned scr_arena_pooled;
static SCR_TL ScrArenaChunk *scr_arena_chunk_pool;
static SCR_TL size_t scr_arena_chunk_bytes;

void *scr_arena_current(void) { return scr_arena_cur; }

void *scr_arena_suspend(void) {
  ScrArena *a = scr_arena_cur;
  scr_arena_cur = NULL;
  return a;
}

void scr_arena_resume(void *arena) { scr_arena_cur = (ScrArena *)arena; }

void *scr_arena_open(void **list, int32_t closed) {
  ScrArena *a = scr_arena_pool;
  if (a) {
    scr_arena_pool = a->next;
    scr_arena_pooled--;
  } else {
    a = malloc(sizeof *a);
    if (!a) scr_trap("scriptc: out of memory\n");
    a->disposal_base = NULL;
    a->disposals_end = NULL;
#if !SCR_SMALL_ALLOC
    a->blocks = NULL;
    a->cap = 0;
#endif
  }
  a->closed = closed != 0;
  a->chunks = NULL;
  a->bytes = 0;
  a->disposals = a->disposal_base;
#if SCR_SMALL_ALLOC
  a->bump = a->inline_chunk;
  a->limit = a->inline_chunk + SCR_ARENA_INLINE;
#else
  a->bump = a->limit = NULL;
  a->nblocks = 0;
#endif
  a->open = 1;
  a->outer = scr_arena_cur;
  scr_arena_cur = a;
  a->next = (ScrArena *)*list;
  *list = a;
  return a;
}

/* Makes `a`'s outer target current again, if `a` is still the target or
 * under it: an exception can leave the arenas a call opened unclosed until
 * their scopes drop them. */
static void scr_arena_unlink(ScrArena *a) {
  if (!a->open) return;
  a->open = 0;
  for (ScrArena *t = scr_arena_cur; t; t = t->outer)
    if (t == a) {
      scr_arena_cur = a->outer;
      return;
    }
}

void scr_arena_close(void *arena) {
  if (arena) scr_arena_unlink((ScrArena *)arena);
}

void scr_arena_disposal(void *arena, void *obj, ScrArenaDispose dispose) {
  ScrArena *a = (ScrArena *)arena;
  if (a->disposals == a->disposals_end) {
    size_t n = (size_t)(a->disposals - a->disposal_base);
    size_t cap = n ? n * 2 : 64;
    ScrArenaDisposal *grown = realloc(a->disposal_base, cap * sizeof *grown);
    if (!grown) scr_trap("scriptc: out of memory\n");
    a->disposal_base = grown;
    a->disposals = grown + n;
    a->disposals_end = grown + cap;
  }
  a->disposals->obj = obj;
  a->disposals->dispose = dispose;
  a->disposals++;
}

#if SCR_SMALL_ALLOC
static ScrArenaChunk *scr_arena_chunk(size_t want) {
  for (ScrArenaChunk **p = &scr_arena_chunk_pool; *p; p = &(*p)->next)
    if ((*p)->size >= want) {
      ScrArenaChunk *c = *p;
      *p = c->next;
      scr_arena_chunk_bytes -= c->size;
      return c;
    }
  ScrArenaChunk *c = malloc(want);
  if (!c) scr_trap("scriptc: out of memory\n");
  c->size = want;
  return c;
}

static char *scr_arena_chunk_start(ScrArenaChunk *c) {
  return (char *)(((uintptr_t)(c + 1) + 15) & ~(uintptr_t)15);
}

/* A new current chunk with room for `n` bytes, or false past the cap
 * when `capped`. */
static bool scr_arena_refill(ScrArena *a, size_t n, bool capped) {
  size_t want = a->chunks ? a->chunks->size * 2 : SCR_ARENA_CHUNK_MIN;
  if (want > SCR_ARENA_CHUNK_MAX) want = SCR_ARENA_CHUNK_MAX;
  size_t need = n + sizeof(ScrArenaChunk) + 15;
  if (want < need) want = need;
  if (capped && a->bytes + want > SCR_ARENA_CAP) return false;
  ScrArenaChunk *c = scr_arena_chunk(want);
  a->bytes += c->size;
  c->next = a->chunks;
  a->chunks = c;
  a->bump = scr_arena_chunk_start(c);
  a->limit = (char *)c + c->size;
  return true;
}
#endif

void *scr_arena_obj(void *arena, size_t size, void *cyc) {
  ScrArena *a = (ScrArena *)arena;
  size_t hdr = cyc ? sizeof(ScrCycHdr) : 0;
  bool capped = !a->closed && !cyc;
  if (capped && size > SCR_ARENA_CAP) return NULL;
  size_t n = (hdr + size + 7) & ~(size_t)7;
#if SCR_SMALL_ALLOC
  if ((size_t)(a->limit - a->bump) < n && !scr_arena_refill(a, n, capped)) return NULL;
  char *block = a->bump;
  a->bump += n;
  memset(block, 0, n);
#else
  if (capped && a->bytes + n > SCR_ARENA_CAP) return NULL;
  a->bytes += n;
  if (a->nblocks == a->cap) {
    size_t cap = a->cap ? a->cap * 2 : 16;
    char **grown = realloc(a->blocks, cap * sizeof *grown);
    if (!grown) scr_trap("scriptc: out of memory\n");
    a->blocks = grown;
    a->cap = cap;
  }
  char *block = calloc(1, n);
  if (!block) scr_trap("scriptc: out of memory\n");
  a->blocks[a->nblocks++] = block;
#endif
  if (!cyc) return block;
  ScrCycHdr *ch = (ScrCycHdr *)block;
  ch->id = (uint16_t)scr_cyc_type_id((ScrCycType *)cyc);
  ch->buf = SCR_CYC_ACYCLIC;
  return block + hdr;
}

static void scr_arena_free(ScrArena *a) {
  /* Every entry before any memory: a release can reach another object of
   * the arena. Newest first, the reverse of construction. */
  for (ScrArenaDisposal *d = a->disposals; d != a->disposal_base;) {
    d--;
    d->dispose(d->obj);
  }
  if ((size_t)(a->disposals_end - a->disposal_base) > SCR_ARENA_POOL_DISPOSALS) {
    free(a->disposal_base);
    a->disposal_base = a->disposals_end = NULL;
  }
#if SCR_SMALL_ALLOC
  for (ScrArenaChunk *c = a->chunks, *next; c; c = next) {
    next = c->next;
    if (scr_arena_chunk_bytes + c->size <= SCR_ARENA_POOL_BYTES) {
      c->next = scr_arena_chunk_pool;
      scr_arena_chunk_pool = c;
      scr_arena_chunk_bytes += c->size;
    } else
      free(c);
  }
  if (scr_arena_pooled < SCR_ARENA_POOL) {
    a->next = scr_arena_pool;
    scr_arena_pool = a;
    scr_arena_pooled++;
    return;
  }
#else
  for (size_t i = 0; i < a->nblocks; i++) free(a->blocks[i]);
  free(a->blocks);
#endif
  free(a->disposal_base);
  free(a);
}

void scr_arena_thread_exit(void) {
  while (scr_arena_pool) {
    ScrArena *a = scr_arena_pool;
    scr_arena_pool = a->next;
    free(a->disposal_base);
    free(a);
  }
  scr_arena_pooled = 0;
#if SCR_SMALL_ALLOC
  for (ScrArenaChunk *c = scr_arena_chunk_pool, *next; c; c = next) {
    next = c->next;
    free(c);
  }
  scr_arena_chunk_pool = NULL;
  scr_arena_chunk_bytes = 0;
#endif
}

void scr_arena_drop(void **list) {
  ScrArena *a = (ScrArena *)*list;
  *list = NULL;
  while (a) {
    ScrArena *next = a->next;
    scr_arena_unlink(a);
    scr_arena_free(a);
    a = next;
  }
}
