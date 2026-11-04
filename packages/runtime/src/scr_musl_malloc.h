/* The malloc family of musl executables (scr_musl.c).
 *
 * The musl lane links zig's libc, whose malloc wraps a slab allocator: each
 * size class takes 64 KiB slabs, each mapped on its own (an mmap and an
 * munmap to align it), every block carries a 16-byte header, and blocks
 * above 64 KiB are mapped and unmapped one by one.
 *
 * These definitions take one address-space reservation on the first call
 * and carve it in order into runs of SCR_MM_CHUNK-byte chunks. A run belongs
 * to one size class of one shard; the chunk map records the owner of every
 * chunk, so free and malloc_usable_size find a block's class and shard from
 * its address. A run hands out blocks from a bump pointer. Pages are zero
 * until first written, so calloc clears only recycled blocks.
 *
 * Each thread allocates from one of SCR_MM_SHARDS shards, chosen in turn on
 * its first call, under the shard's lock. A block freed by a thread of its
 * own shard goes back on the shard's free list; one freed by another thread
 * goes on the shard's remote list without a lock, and the shard takes that
 * list over when its free list is empty. A thread gathers the blocks it
 * frees for other shards in chains of one owner and class, at most
 * SCR_MM_CHAINS chains of SCR_MM_BATCH blocks, and pushes each chain to the
 * owner's remote list in one step: when the chain is full, when the
 * thread's event loop waits twice with no such free in between
 * (scr_mm_idle), and when the thread exits. Two threads that pass
 * blocks back and forth then do not exchange a cache line on every free.
 *
 * Requests above SCR_MM_SMALL_MAX, alignments above the page size, a block
 * that realloc grows past SCR_MM_CHUNK, and the case where the reservation
 * is exhausted or refused take a mapping of their own, with its base and
 * length in the 16 bytes before the block; realloc resizes those with
 * mremap. Blocks in runs are reused within their class. Freed blocks above
 * SCR_MM_CHUNK keep their pages up to SCR_MM_KEEP bytes in the process and
 * return the rest of their pages to the system.
 *
 * Blocks are 16-byte aligned. Runs start chunk-aligned, so a class whose
 * block size is a power of two keeps its blocks aligned to that size, which
 * serves the aligned allocation functions up to the page size.
 *
 * The functions are prefixed so that the test (scr_musl_malloc.test.c) can
 * compile them on any Linux host; scr_musl.c defines the libc names over
 * them. */
#ifndef SCR_MUSL_MALLOC_H
#define SCR_MUSL_MALLOC_H

#include <errno.h>
#include <pthread.h>
#include <sched.h>
#include <stdatomic.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>
#include <sys/mman.h>

#define SCR_MM_SHARDS 8u
#define SCR_MM_SMALL_MAX_LG 20u
#define SCR_MM_SMALL_MAX ((size_t)1 << SCR_MM_SMALL_MAX_LG)
/* 16 to 128 bytes in 16-byte steps, then four classes per doubling. */
#define SCR_MM_NCLASS (8u + 4u * (SCR_MM_SMALL_MAX_LG - 7u))
#define SCR_MM_CHUNK_LG 16u
#define SCR_MM_CHUNK ((size_t)1 << SCR_MM_CHUNK_LG)
#define SCR_MM_PAGE ((size_t)4096)
#define SCR_MM_KEEP ((size_t)4 << 20)
#define SCR_MM_BATCH 32u /* blocks per chain of a thread's remote frees */
#define SCR_MM_CHAINS 4u
#define SCR_MM_FN static inline __attribute__((no_builtin))

typedef struct ScrMmBlock {
  struct ScrMmBlock *next;
  /* (blocks above SCR_MM_CHUNK) The block's pages stayed committed when
   * it was freed, and its size counts in scr_mm_kept. */
  bool kept;
} ScrMmBlock;

typedef struct ScrMmShard {
  atomic_flag lock;
  ScrMmBlock *free[SCR_MM_NCLASS];
  char *bump[SCR_MM_NCLASS];
  char *lim[SCR_MM_NCLASS];
  /* Blocks other threads freed, pushed without the lock; the shard takes
   * a class's list over when its free list is empty. */
  _Atomic(ScrMmBlock *) remote[SCR_MM_NCLASS] __attribute__((aligned(64)));
} __attribute__((aligned(64))) ScrMmShard;

/* Blocks freed by this thread for one owner shard and class, linked from
 * head to tail; key is the owner's chunk-map entry (0 when empty). */
typedef struct ScrMmChain {
  ScrMmBlock *head, *tail;
  unsigned key, count;
} ScrMmChain;

/* A thread's held remote frees, allocated on its first one. */
typedef struct ScrMmPending {
  ScrMmChain chains[SCR_MM_CHAINS];
  unsigned next_evict;
  bool freed_since_idle;
} ScrMmPending;

/* The header of a block in a mapping of its own. */
typedef struct ScrMmMapped {
  char *map;
  size_t len;
} ScrMmMapped;

/* The reservation: the chunk map (one entry per chunk: class + 1 and the
 * shard, 0 for a chunk not yet carved), the shards, then the chunks from
 * scr_mm_base. The shards live there rather than in static storage, which
 * would move the runtime's own data. scr_mm_map, scr_mm_shards and
 * scr_mm_base are written once, under scr_mm_init_lock, before
 * scr_mm_span. */
static uint16_t *scr_mm_map;
static ScrMmShard *scr_mm_shards;
static uintptr_t scr_mm_base;
static _Atomic(uintptr_t) scr_mm_span;
static _Atomic(uintptr_t) scr_mm_carved; /* bytes of chunks handed to runs */
static atomic_flag scr_mm_init_lock = ATOMIC_FLAG_INIT;
static _Atomic(unsigned) scr_mm_next_shard;
/* Bytes of freed blocks above SCR_MM_CHUNK whose pages stayed committed, at
 * most SCR_MM_KEEP across the process. */
static _Atomic(size_t) scr_mm_kept;
static _Thread_local unsigned scr_mm_my_shard; /* shard index + 1, 0 until the first call */
static _Thread_local ScrMmPending *scr_mm_pending;
/* Flushes a thread's held remote frees when it exits. */
static pthread_key_t scr_mm_pending_key;

static inline unsigned scr_mm_class(size_t n) {
  if (n <= 128) return n ? (unsigned)((n - 1) >> 4) : 0u;
  unsigned lg = 63u - (unsigned)__builtin_clzll((unsigned long long)(n - 1)); /* 2^lg < n <= 2^(lg+1) */
  return 8u + (lg - 7u) * 4u + (unsigned)(((n - 1) >> (lg - 2)) & 3u);
}
static inline size_t scr_mm_class_size(unsigned c) {
  if (c < 8) return (size_t)(c + 1) << 4;
  unsigned k = c - 8u, lg = 7u + k / 4u;
  return ((size_t)1 << lg) + ((size_t)(k % 4u + 1u) << (lg - 2));
}
/* The run a class carves at a time: one chunk, or four blocks above that. */
static inline size_t scr_mm_run_size(size_t sz) {
  size_t run = 4 * sz;
  return run <= SCR_MM_CHUNK ? SCR_MM_CHUNK : (run + SCR_MM_CHUNK - 1) & ~(SCR_MM_CHUNK - 1);
}

static inline void scr_mm_lock(atomic_flag *l) {
  unsigned spins = 0;
  while (atomic_flag_test_and_set_explicit(l, memory_order_acquire)) {
    if (++spins < 64) {
#if defined(__x86_64__)
      __builtin_ia32_pause();
#elif defined(__aarch64__)
      __asm__ volatile("yield");
#endif
    } else {
      sched_yield();
    }
  }
}
static inline void scr_mm_unlock(atomic_flag *l) { atomic_flag_clear_explicit(l, memory_order_release); }

static void scr_mm_fork_prepare(void) {
  scr_mm_lock(&scr_mm_init_lock);
  for (unsigned s = 0; s < SCR_MM_SHARDS; s++) scr_mm_lock(&scr_mm_shards[s].lock);
}
/* The child gets the locks released, whichever threads held them in the
 * parent: only the forking thread runs there. */
static void scr_mm_fork_release(void) {
  for (unsigned s = 0; s < SCR_MM_SHARDS; s++) scr_mm_unlock(&scr_mm_shards[s].lock);
  scr_mm_unlock(&scr_mm_init_lock);
}

static void scr_mm_pending_exit(void *pending);
/* No thread-exit key, so threads push their remote frees one at a time. */
static bool scr_mm_pending_off;

static bool scr_mm_reserve(void) {
  if (atomic_load_explicit(&scr_mm_span, memory_order_acquire)) return true;
  scr_mm_lock(&scr_mm_init_lock);
  bool reserved = false;
  for (unsigned lg = 36; !atomic_load_explicit(&scr_mm_span, memory_order_relaxed) && lg >= 30; lg -= 2) {
    size_t span = (size_t)1 << lg;
    size_t map = (span >> SCR_MM_CHUNK_LG) * sizeof(uint16_t);
    size_t head = (map + SCR_MM_SHARDS * sizeof(ScrMmShard) + SCR_MM_CHUNK - 1) & ~(SCR_MM_CHUNK - 1);
    char *p = mmap(NULL, head + span, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS | MAP_NORESERVE, -1, 0);
    if (p == MAP_FAILED) continue;
    scr_mm_map = (uint16_t *)p;
    scr_mm_shards = (ScrMmShard *)(p + map); /* map is a multiple of 64 */
    scr_mm_base = (uintptr_t)p + head;
    atomic_store_explicit(&scr_mm_span, span, memory_order_release);
    reserved = true;
  }
  scr_mm_unlock(&scr_mm_init_lock);
  /* pthread_atfork allocates, which the reservation now serves. */
  if (reserved) {
    (void)pthread_atfork(scr_mm_fork_prepare, scr_mm_fork_release, scr_mm_fork_release);
    if (pthread_key_create(&scr_mm_pending_key, scr_mm_pending_exit) != 0) scr_mm_pending_off = true;
  }
  return atomic_load_explicit(&scr_mm_span, memory_order_relaxed) != 0;
}

/* The chunk-map entry of p (class + 1, shard in the high byte), or 0 when p
 * is outside the carved chunks. */
static inline unsigned scr_mm_owner(const void *p) {
  uintptr_t off = (uintptr_t)p - scr_mm_base;
  if (off >= atomic_load_explicit(&scr_mm_span, memory_order_relaxed)) return 0;
  return scr_mm_map[off >> SCR_MM_CHUNK_LG];
}

static void *scr_mm_mapped(size_t n, size_t align) {
  if (align < 16) align = 16;
  size_t head = align;
  if (n > SIZE_MAX - head - align - SCR_MM_PAGE) return NULL;
  size_t len = (n + head + (align > SCR_MM_PAGE ? align : 0) + SCR_MM_PAGE - 1) & ~(SCR_MM_PAGE - 1);
  char *m = mmap(NULL, len, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
  if (m == MAP_FAILED) return NULL;
  uintptr_t p = ((uintptr_t)m + head + align - 1) & ~(uintptr_t)(align - 1);
  ((ScrMmMapped *)p)[-1] = (ScrMmMapped){m, len};
  return (void *)p;
}

/* Gives shard s's class c a new run; called with the shard locked. */
static bool scr_mm_carve(unsigned s, unsigned c, size_t sz) {
  size_t run = scr_mm_run_size(sz);
  uintptr_t span = atomic_load_explicit(&scr_mm_span, memory_order_relaxed);
  uintptr_t off = atomic_fetch_add_explicit(&scr_mm_carved, run, memory_order_relaxed);
  if (off > span || span - off < run) return false;
  uint16_t owner = (uint16_t)((s << 8) | (c + 1));
  for (size_t k = off >> SCR_MM_CHUNK_LG; k < (off + run) >> SCR_MM_CHUNK_LG; k++) scr_mm_map[k] = owner;
  ScrMmShard *sh = &scr_mm_shards[s];
  sh->bump[c] = (char *)scr_mm_base + off;
  sh->lim[c] = sh->bump[c] + run;
  return true;
}

static void *scr_mm_small(size_t n, bool zero) {
  unsigned c = scr_mm_class(n);
  size_t sz = scr_mm_class_size(c);
  unsigned s = scr_mm_my_shard;
  if (!s)
    s = scr_mm_my_shard =
        atomic_fetch_add_explicit(&scr_mm_next_shard, 1, memory_order_relaxed) % SCR_MM_SHARDS + 1;
  ScrMmShard *sh = &scr_mm_shards[--s];
  scr_mm_lock(&sh->lock);
  ScrMmBlock *b = sh->free[c];
  if (!b && atomic_load_explicit(&sh->remote[c], memory_order_relaxed))
    b = atomic_exchange_explicit(&sh->remote[c], NULL, memory_order_acquire);
  if (b) {
    sh->free[c] = b->next;
    scr_mm_unlock(&sh->lock);
    if (sz > SCR_MM_CHUNK && b->kept) atomic_fetch_sub_explicit(&scr_mm_kept, sz, memory_order_relaxed);
    if (zero) memset(b, 0, n);
    return b;
  }
  if ((size_t)(sh->lim[c] - sh->bump[c]) < sz && !scr_mm_carve(s, c, sz)) {
    scr_mm_unlock(&sh->lock);
    return scr_mm_mapped(n, 16);
  }
  char *p = sh->bump[c];
  sh->bump[c] = p + sz;
  scr_mm_unlock(&sh->lock);
  return p;
}

static void *scr_mm_alloc(size_t n, bool zero) {
  void *p = n <= SCR_MM_SMALL_MAX && scr_mm_reserve() ? scr_mm_small(n, zero) : scr_mm_mapped(n, 16);
  if (!p) errno = ENOMEM;
  return p;
}

SCR_MM_FN void *scr_musl_malloc(size_t n) { return scr_mm_alloc(n, false); }

SCR_MM_FN void *scr_musl_calloc(size_t m, size_t n) {
  size_t t;
  if (__builtin_mul_overflow(m, n, &t)) {
    errno = ENOMEM;
    return NULL;
  }
  return scr_mm_alloc(t, true);
}

/* Pushes the chain head..tail onto the remote list of the class of `key`
 * (a chunk-map entry). Only pushes race (the owner takes the whole list),
 * so the list cannot suffer ABA. */
static void scr_mm_push_remote(unsigned key, ScrMmBlock *head, ScrMmBlock *tail) {
  _Atomic(ScrMmBlock *) *list = &scr_mm_shards[key >> 8].remote[(key & 0xffu) - 1];
  ScrMmBlock *old = atomic_load_explicit(list, memory_order_relaxed);
  do tail->next = old;
  while (!atomic_compare_exchange_weak_explicit(list, &old, head, memory_order_release,
                                                memory_order_relaxed));
}

static void scr_mm_chain_flush(ScrMmChain *ch) {
  if (ch->count) scr_mm_push_remote(ch->key, ch->head, ch->tail);
  ch->head = ch->tail = NULL;
  ch->key = ch->count = 0;
}

static void scr_mm_pending_flush(ScrMmPending *pd) {
  for (unsigned i = 0; i < SCR_MM_CHAINS; i++) scr_mm_chain_flush(&pd->chains[i]);
}

/* pthread key destructor: the exiting thread's held frees go to their
 * owners, and so does the record itself. */
static void scr_mm_pending_exit(void *pending) {
  ScrMmPending *pd = pending;
  scr_mm_pending = NULL;
  scr_mm_pending_flush(pd);
  unsigned key = scr_mm_owner(pd);
  ScrMmBlock *b = (ScrMmBlock *)pd;
  if (key) scr_mm_push_remote(key, b, b);
}

static inline void scr_musl_free(void *p);

/* Holds a block freed for another shard (`key`, its chunk-map entry). */
static void scr_mm_free_remote(unsigned key, ScrMmBlock *b) {
  ScrMmPending *pd = scr_mm_pending;
  if (!pd && !scr_mm_pending_off) {
    pd = scr_mm_small(sizeof(ScrMmPending), true);
    if (pd && scr_mm_owner(pd) && pthread_setspecific(scr_mm_pending_key, pd) == 0) {
      scr_mm_pending = pd;
    } else {
      if (pd) scr_musl_free(pd);
      pd = NULL;
    }
  }
  if (!pd) {
    scr_mm_push_remote(key, b, b);
    return;
  }
  pd->freed_since_idle = true;
  ScrMmChain *ch = NULL, *empty = NULL;
  for (unsigned i = 0; i < SCR_MM_CHAINS; i++) {
    ScrMmChain *c = &pd->chains[i];
    if (c->key == key) {
      ch = c;
      break;
    }
    if (!c->key && !empty) empty = c;
  }
  if (!ch) {
    if (!empty) {
      empty = &pd->chains[pd->next_evict++ % SCR_MM_CHAINS];
      scr_mm_chain_flush(empty);
    }
    ch = empty;
    ch->key = key;
  }
  b->next = ch->head;
  ch->head = b;
  if (!ch->tail) ch->tail = b;
  if (++ch->count >= SCR_MM_BATCH) scr_mm_chain_flush(ch);
}

/* The calling thread's event loop is about to wait with nothing ready. Held
 * remote frees go to their owners when the thread freed none since its
 * previous wait, so a thread passing blocks back and forth keeps batching
 * and an idle one keeps none back. */
SCR_MM_FN void scr_mm_idle(void) {
  ScrMmPending *pd = scr_mm_pending;
  if (!pd) return;
  if (pd->freed_since_idle) {
    pd->freed_since_idle = false;
    return;
  }
  scr_mm_pending_flush(pd);
}

SCR_MM_FN void scr_musl_free(void *p) {
  if (!p) return;
  unsigned owner = scr_mm_owner(p);
  if (owner) {
    ScrMmShard *sh = &scr_mm_shards[owner >> 8];
    unsigned c = (owner & 0xffu) - 1;
    ScrMmBlock *b = p;
    size_t sz = scr_mm_class_size(c);
    /* Above the chunk size, a freed block keeps its pages while the kept
     * blocks of the process stay within SCR_MM_KEEP, for the next request
     * of the class. Past that, its pages after the first (which holds the
     * free-list link) go back to the system, as a mapping of its own
     * would: otherwise a table that grew through several classes would
     * leave its old blocks committed. */
    if (sz > SCR_MM_CHUNK) {
      size_t kept = atomic_fetch_add_explicit(&scr_mm_kept, sz, memory_order_relaxed);
      b->kept = kept + sz <= SCR_MM_KEEP;
      if (!b->kept) {
        atomic_fetch_sub_explicit(&scr_mm_kept, sz, memory_order_relaxed);
        (void)madvise((char *)p + SCR_MM_PAGE, sz - SCR_MM_PAGE, MADV_DONTNEED);
      }
    }
    if ((owner >> 8) + 1 != scr_mm_my_shard) {
      scr_mm_free_remote(owner, b); /* another shard's block */
      return;
    }
    scr_mm_lock(&sh->lock);
    b->next = sh->free[c];
    sh->free[c] = b;
    scr_mm_unlock(&sh->lock);
    return;
  }
  ScrMmMapped h = ((ScrMmMapped *)p)[-1];
  (void)munmap(h.map, h.len);
}

SCR_MM_FN size_t scr_musl_malloc_usable_size(void *p) {
  if (!p) return 0;
  unsigned owner = scr_mm_owner(p);
  if (owner) return scr_mm_class_size((owner & 0xffu) - 1);
  ScrMmMapped h = ((ScrMmMapped *)p)[-1];
  return (size_t)(h.map + h.len - (char *)p);
}

SCR_MM_FN void *scr_musl_realloc(void *p, size_t n) {
  if (!p) return scr_musl_malloc(n);
  if (!n) {
    scr_musl_free(p);
    return NULL;
  }
  size_t have = scr_musl_malloc_usable_size(p);
  if (scr_mm_owner(p)) {
    /* Keep the block unless it would be less than half used. */
    if (n <= have && (have <= 128 || n > have / 2)) return p;
    /* A block growing past the chunk size moves to a mapping of its own,
     * which later growth resizes with mremap instead of copying. */
    if (n > have && n > SCR_MM_CHUNK) {
      void *q = scr_mm_mapped(n, 16);
      if (!q) {
        errno = ENOMEM;
        return NULL;
      }
      memcpy(q, p, have);
      scr_musl_free(p);
      return q;
    }
  } else if (n > SCR_MM_CHUNK) {
    ScrMmMapped h = ((ScrMmMapped *)p)[-1];
    size_t head = (size_t)((char *)p - h.map);
    if (head <= SCR_MM_PAGE) { /* not over-aligned: the block keeps its offset */
      size_t len = (n + head + SCR_MM_PAGE - 1) & ~(SCR_MM_PAGE - 1);
      if (len == h.len) return p;
      char *m = mremap(h.map, h.len, len, MREMAP_MAYMOVE);
      if (m == MAP_FAILED) {
        errno = ENOMEM;
        return NULL;
      }
      ((ScrMmMapped *)(m + head))[-1] = (ScrMmMapped){m, len};
      return m + head;
    }
    if (n <= have) return p;
  }
  void *q = scr_musl_malloc(n);
  if (!q) return NULL;
  memcpy(q, p, have < n ? have : n);
  scr_musl_free(p);
  return q;
}

SCR_MM_FN void *scr_musl_reallocarray(void *p, size_t m, size_t n) {
  size_t t;
  if (__builtin_mul_overflow(m, n, &t)) {
    errno = ENOMEM;
    return NULL;
  }
  return scr_musl_realloc(p, t);
}

/* align is a power of two. */
static void *scr_mm_aligned(size_t align, size_t n) {
  if (align <= 16) return scr_mm_alloc(n, false);
  if (n <= SCR_MM_SMALL_MAX && align <= SCR_MM_PAGE && scr_mm_reserve()) {
    size_t sz = n < align ? align : n;
    size_t pow = (size_t)1 << (64 - __builtin_clzll((unsigned long long)(sz - 1)));
    if (pow <= SCR_MM_SMALL_MAX) {
      void *p = scr_mm_small(pow, false);
      if (p && ((uintptr_t)p & (align - 1)) == 0) return p;
      scr_musl_free(p); /* a mapping of its own: the reservation is exhausted */
    }
  }
  void *p = scr_mm_mapped(n, align);
  if (!p) errno = ENOMEM;
  return p;
}

SCR_MM_FN void *scr_musl_aligned_alloc(size_t align, size_t n) {
  if (!align || (align & (align - 1))) {
    errno = EINVAL;
    return NULL;
  }
  return scr_mm_aligned(align, n);
}

SCR_MM_FN int scr_musl_posix_memalign(void **out, size_t align, size_t n) {
  if (align < sizeof(void *) || (align & (align - 1))) return EINVAL;
  int saved = errno;
  void *p = scr_mm_aligned(align, n);
  errno = saved;
  if (!p) return ENOMEM;
  *out = p;
  return 0;
}

#endif
