/* scriptc runtime — small-object allocator state and slow paths.
 *
 * The fast paths (free-list pop, bump carve, free-list push) are inline in
 * scr_runtime.h; see the contract there. This unit owns the process-wide
 * state, the address-space reservation, the refill/fallback path, realloc,
 * and the out-of-line entry points the LLVM backend calls for acyclic
 * records and class instances.
 *
 * Freed blocks are recycled within their class; the reservation itself
 * costs address space only, and pages are committed as the bump pointers
 * first touch them. Only an exiting worker thread returns pages, those
 * holding nothing but free blocks (scr_sa_trim, Linux). */
#include "scr_runtime.h"
#if defined(__GLIBC__)
#include <malloc.h>
#endif

/* Defined in every build: the emitted fast paths read it (see the layout
 * contract in scr_runtime.h); without the allocator it stays all-zero.
 * Explicitly initialized so it is an ordinary (localizable) definition: a
 * tentative definition becomes a COMMON symbol, which library localization
 * deliberately keeps global (abi.localize_runtime), leaking it from every
 * localized library archive. */
#ifdef SCR_WORKERS
_Thread_local ScrThreadHot scr_thread_hot = {{.tag = SCR_SA_TAG_NONE}};
#else
ScrSaState scr_sa = {.tag = SCR_SA_TAG_NONE};
#endif
/* The chunk table and the chunk map (scr_rc.h), defined in every build for
 * the same reason. */
uint16_t scr_sa_chunks[SCR_SA_WINDOW_CHUNKS] = {0};
uint16_t scr_sa_chunk_map[SCR_SA_MAP_CHUNKS] = {0};
uintptr_t scr_sa_slice_span = 0; /* the classes' slices (scr_rc.h) */
/* The map index of the window's first chunk, or SIZE_MAX while the window
 * does not lie below SCR_SA_MAP_CHUNKS chunks (not reserved, or placed
 * higher): the map then stays empty. */
static size_t scr_sa_map_first = SIZE_MAX;

/* Sets the entry of window chunk i in the chunk table and in the map. */
static inline void scr_sa_chunk_set(size_t i, uint16_t v) {
  __atomic_store_n(&scr_sa_chunks[i], v, __ATOMIC_RELAXED);
  if (scr_sa_map_first != SIZE_MAX) __atomic_store_n(&scr_sa_chunk_map[scr_sa_map_first + i], v, __ATOMIC_RELAXED);
}

/* The calling thread holds no arena: an empty state, whose tag matches no
 * chunk entry. */
static inline void scr_sa_clear(void) {
  memset(&scr_sa, 0, sizeof scr_sa);
  scr_sa.tag = SCR_SA_TAG_NONE;
}

/* Counts a worker's large blocks (scr_sa_thread_large_note, below). */
#if defined(SCR_WORKERS) && defined(__GLIBC__) && !defined(SCR_LIB)
static void scr_sa_thread_large_note(void);
#define SCR_SA_THREAD_LARGE_NOTE() scr_sa_thread_large_note()
#else
#define SCR_SA_THREAD_LARGE_NOTE() ((void)0)
#endif

#if SCR_SMALL_ALLOC
#include <sched.h>
#include <sys/mman.h>
#include <unistd.h>

/* Page policy. Chunk pages are committed by first touch, which on 4 KiB
 * pages is one fault (and page clear) per 4 KiB the bump pointers cross.
 * Transparent huge pages fault 2 MiB at a time and shrink the TLB working
 * set, but make the whole 2 MiB page around a bump pointer resident at once,
 * so every size class in use (per arena, in worker executables) would cost
 * up to 2 MiB more than it holds. A class therefore starts on small pages,
 * and the chunks it takes once it has carved SCR_SA_HUGE_AFTER bytes use
 * huge pages: only classes that already hold that much pay the partial last
 * huge page. The window is huge-page aligned, so every chunk starts on a
 * huge-page boundary. */
#if defined(__linux__) && defined(MADV_HUGEPAGE) && defined(MADV_NOHUGEPAGE)
#define SCR_SA_THP 1
#define SCR_SA_HUGE_PAGE ((size_t)2 << 20)
#define SCR_SA_HUGE_AFTER ((size_t)8 << 20)
#endif

#if defined(SCR_SA_THP) && defined(__GLIBC__)
#include <stdio.h>
#include <string.h>
/* The system's THP mode: 'a' (always), 'm' (madvise), 'n' (never), or 0
 * when the kernel has no THP setting to read. */
static char scr_sa_thp_mode(void) {
  FILE *f = fopen("/sys/kernel/mm/transparent_hugepage/enabled", "r");
  if (!f) return 0;
  char buf[96] = {0};
  size_t n = fread(buf, 1, sizeof buf - 1, f);
  fclose(f);
  buf[n] = 0;
  if (strstr(buf, "[always]")) return 'a';
  if (strstr(buf, "[madvise]")) return 'm';
  return strstr(buf, "[never]") ? 'n' : 0;
}
#endif

/* Core dumps. The window is tens of GiB of address space, almost none
 * of it ever touched. A core written to a file skips untouched pages, but a
 * core piped to a handler (a kernel.core_pattern of "|...", such as apport
 * or systemd-coredump) carries every page of a dumped mapping, untouched
 * ones as zeros, and RLIMIT_CORE does not bound it: an aborting program
 * would take seconds to minutes to die. The window is therefore mapped
 * MADV_DONTDUMP, and whenever the slow path raises a chunk's bump limit,
 * the chunk up to that limit becomes dumpable again (scr_sa_dumpable), so a
 * core still holds every carved block. Without pre-faulting, limits advance
 * in bounded steps for this (SCR_SA_DUMP_STEP on small pages, one huge page
 * on huge ones). The dumpable part ends on a grid that coarsens as the
 * chunk fills (scr_sa_dump_edge): its untouched tail is at most
 * SCR_SA_DUMP_GRAIN or a quarter of what the chunk has carved, and a chunk
 * takes a few madvise calls per doubling, not one per step (each takes the
 * mmap lock for writing, which would wait for the pre-fault helper). Grid
 * points are huge-page aligned: a mapping boundary inside a huge page would
 * split it.
 *
 * Every chunk a thread opens costs one of those calls, and the threads of a
 * worker executable open hundreds of chunks as they start. So they are only
 * made when the kernel would write a core of the process: when
 * kernel.core_pattern starts with '|' or '@' (a handler or a socket, which
 * ignore RLIMIT_CORE), or when RLIMIT_CORE is above 0. Both are read when
 * the window is mapped. Otherwise the whole window stays
 * MADV_DONTDUMP: a core written after RLIMIT_CORE is raised for the running
 * process (prlimit), or one taken with gdb's gcore, leaves out the chunks. */
#if defined(__linux__) && defined(MADV_DONTDUMP)
#define SCR_SA_DUMP 1
#define SCR_SA_DUMP_STEP ((size_t)1 << 20)
#define SCR_SA_DUMP_GRAIN ((size_t)2 << 20) /* a multiple of the page size */
#include <stdio.h>
#include <sys/resource.h>
/* Whether carved chunks are made dumpable; set before the window is
 * published. */
static bool scr_sa_dump_chunks;

/* Whether the kernel would write a core of this process (see above); true
 * when a setting cannot be read. */
static bool scr_sa_cores_written(void) {
  struct rlimit core;
  if (getrlimit(RLIMIT_CORE, &core) != 0 || core.rlim_cur != 0) return true;
  FILE *f = fopen("/proc/sys/kernel/core_pattern", "r");
  if (!f) return true;
  int c = fgetc(f);
  fclose(f);
  return c == '|' || c == '@';
}
#endif

/* Maps span bytes of address space for the window (huge-page aligned where the
 * policy above applies), or NULL. */
static void *scr_sa_map(size_t span) {
  int flags = MAP_PRIVATE | MAP_ANON;
#ifdef MAP_NORESERVE
  flags |= MAP_NORESERVE;
#endif
#ifdef SCR_SA_THP
  size_t pad = SCR_SA_HUGE_PAGE;
#else
  size_t pad = 0;
#endif
  char *p = mmap(NULL, span + pad, PROT_READ | PROT_WRITE, flags, -1, 0);
  if (p == MAP_FAILED) return NULL;
#ifdef SCR_SA_THP
  char *a = (char *)(((uintptr_t)p + pad - 1) & ~(uintptr_t)(pad - 1));
  if (a > p) (void)munmap(p, (size_t)(a - p));
  (void)munmap(a + span, (size_t)(p + pad - a)); /* a < p + pad */
  p = a;
  (void)madvise(p, span, MADV_NOHUGEPAGE);
#endif
#ifdef SCR_SA_DUMP
  (void)madvise(p, span, MADV_DONTDUMP);
  scr_sa_dump_chunks = scr_sa_cores_written();
#endif
  return p;
}

#ifdef SCR_SA_DUMP
/* The end of the dumpable part of the chunk [start, end) whose
 * limit is p: p rounded up to a multiple of SCR_SA_DUMP_GRAIN or of a
 * quarter of the largest power of two at or below p - start, whichever is
 * larger (see above). Monotonic in p. */
static char *scr_sa_dump_edge(char *start, char *end, char *p) {
  size_t off = (size_t)(p - start), grain = SCR_SA_DUMP_GRAIN;
  if (off) {
    size_t quarter = ((size_t)1 << (63 - __builtin_clzll((unsigned long long)off))) >> 2;
    if (quarter > grain) grain = quarter;
  }
  off = (off + grain - 1) & ~(grain - 1);
  return off < (size_t)(end - start) ? start + off : end;
}

/* The chunk [start, end) raised its bump limit from lim to next: makes
 * the memory up to next dumpable (see above). */
static void scr_sa_dumpable(char *start, char *end, char *lim, char *next) {
  char *lo = scr_sa_dump_edge(start, end, lim), *hi = scr_sa_dump_edge(start, end, next);
  if (hi > lo) (void)madvise(lo, (size_t)(hi - lo), MADV_DODUMP);
}
#endif

/* Pre-faulting (Linux executables). First touch of a fresh chunk page costs
 * a fault and a page clear on the allocating thread. With pre-faulting the
 * bump limits advance in steps, and each step asks a helper thread to fault
 * in the memory just ahead of it (MADV_POPULATE_WRITE: the kernel commits
 * zeroed pages as for a write, without storing anything, so it cannot race
 * with the owner's carving). The owner still faults any page the helper has
 * not reached; the fast paths are unchanged. Small-page prefixes advance in
 * SCR_SA_PF_STEP chunks and fault one chunk ahead; huge-page ranges advance
 * in half huge pages and fault the next huge page once the bump is in the
 * second half of the current one, so a class keeps at most about one step
 * of untouched committed memory. Nothing is faulted ahead before a class
 * reaches SCR_SA_PF_START: a lightly used class commits nothing extra.
 *
 * Worker threads fault ahead only once they have shown sustained
 * allocation, and within one budget that all workers share. A worker's
 * limits must have advanced SCR_SA_PF_WORKER_MIN bytes, and the ranges
 * faulted ahead of all workers together stay within SCR_SA_PF_WORKERS_MAX.
 * A range counts against the budget until its class's limit reaches it or
 * its thread parks its arena, and a class has one range in flight at a
 * time. A step outside the budget is not faulted ahead: the owner faults
 * those pages itself. Many worker threads (parse and check pools) would
 * otherwise each hold faulted-in ranges, up to a huge page per hot class,
 * that they never carve, and all of them would queue on the one helper,
 * whose populates also hold the address-space lock their own mmap and brk
 * calls need. A program whose allocation runs on one or two workers keeps
 * most of the pre-faulting. The main thread keeps the policy above, and
 * executables without worker threads compile only that policy.
 * SCR_SA_PREFAULT=0 turns pre-faulting off. Library archives run on
 * embedder threads and keep the plain policy. */
#if defined(SCR_SA_THP) && !defined(SCR_LIB)
#ifndef MADV_POPULATE_WRITE
#define MADV_POPULATE_WRITE 23 /* Linux 5.14 */
#endif
#define SCR_SA_PREFAULT 1
#define SCR_SA_PF_STEP ((size_t)256 << 10)
#define SCR_SA_PF_START ((size_t)1 << 20)
#define SCR_SA_PF_HUGE_STEP (SCR_SA_HUGE_PAGE / 2)
#define SCR_SA_PF_WORKER_MIN ((size_t)4 << 20)
#define SCR_SA_PF_WORKERS_MAX ((size_t)8 << 20)
#include <errno.h>
#include <pthread.h>
#ifdef SCR_WORKERS
#include <sys/syscall.h>
#include <unistd.h>
#endif
#include <signal.h>
#include <stdatomic.h>

typedef struct {
  char *lo, *hi;
} ScrSaPfRange;
#define SCR_SA_PF_RING 64u
static pthread_mutex_t scr_sa_pf_lock = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t scr_sa_pf_cond = PTHREAD_COND_INITIALIZER;
static ScrSaPfRange scr_sa_pf_ring[SCR_SA_PF_RING];
static unsigned scr_sa_pf_head, scr_sa_pf_tail; /* under the lock */
static bool scr_sa_pf_started, scr_sa_pf_waiting;
/* The range the helper is faulting in, and the threads that wait for it to
 * finish (scr_sa_pf_forget); under the lock. */
static ScrSaPfRange scr_sa_pf_busy;
static unsigned scr_sa_pf_forgetting;
static pthread_cond_t scr_sa_pf_done = PTHREAD_COND_INITIALIZER;
/* 0 = not decided yet, 1 = on, -1 = off (environment, no thread, or a
 * kernel without MADV_POPULATE_WRITE). */
static _Atomic(int) scr_sa_pf_state;

static void scr_sa_pf_populate(char *lo, char *hi) {
  if (madvise(lo, (size_t)(hi - lo), MADV_POPULATE_WRITE) != 0 && errno == EINVAL)
    atomic_store_explicit(&scr_sa_pf_state, -1, memory_order_relaxed);
}

/* The system allocator's heap (glibc): blocks above SCR_SA_MAX come from
 * malloc, whose main arena grows by brk. Once the heap has grown by
 * SCR_SA_PF_HEAP_MIN since the helper first looked, the helper gives malloc
 * a larger top pad (SCR_SA_PF_TOP_PAD), so every extension runs that far
 * ahead of use, and faults in each new extension as soon as it sees the
 * break move. Smaller heaps keep glibc's defaults (a top pad also fixes
 * glibc's otherwise dynamic mmap threshold), so a small program commits
 * nothing extra. The helper checks after every request and then polls while
 * the program keeps allocating (SCR_SA_PF_POLL_NS, up to SCR_SA_PF_POLLS
 * times without growth before it sleeps until the next request), so an idle
 * program does not wake it. Only the helper reads the break; a stale read
 * only delays a fault-in, and a shrunk break (malloc trimming its top)
 * restarts the watermarks there. Past the threshold the pad costs at most
 * SCR_SA_PF_TOP_PAD of committed memory beyond what malloc would have;
 * SCR_SA_PREFAULT_HEAP=0 keeps glibc's defaults and no polling.
 *
 * Where THP is in madvise mode none of this runs. The heap policy below
 * moves the heap to huge pages at the same 32 MiB, so the owner takes one
 * fault per 2 MiB and faulting ahead saves it little, while the helper's
 * populates cost more: ranges it reaches before the owner advises them (and
 * the partial huge pages at the ends of each extension) stay on small pages,
 * 230-620 MB on large type checks; the owner's brk and madvise
 * wait for the mmap lock a multi-megabyte populate holds; and the helper's
 * top pad would replace the heap policy's larger one. */
#if defined(__GLIBC__)
#include <malloc.h>
#include <time.h>
#include <unistd.h>
#define SCR_SA_PF_HEAP 1
#define SCR_SA_PF_HEAP_MIN ((size_t)32 << 20)
#define SCR_SA_PF_TOP_PAD ((size_t)16 << 20)
#define SCR_SA_PF_POLL_NS 1000000L
#define SCR_SA_PF_POLLS 64u
static int scr_sa_pf_heap_mode;  /* 0 off, 1 on; decided before the helper starts */
static uintptr_t scr_sa_pf_page; /* likewise */
static char *scr_sa_pf_brk0, *scr_sa_pf_brk; /* helper only: first and last break seen */
static bool scr_sa_pf_heap_big;              /* helper only: past SCR_SA_PF_HEAP_MIN */

/* Faults in the heap's growth since the last check; true if it grew. */
static bool scr_sa_pf_heap(void) {
  char *cur = sbrk(0);
  if (cur == (char *)-1) return false;
  char *seen = scr_sa_pf_brk;
  scr_sa_pf_brk = cur;
  if (!seen || cur < scr_sa_pf_brk0) scr_sa_pf_brk0 = cur;
  if (!seen || cur <= seen) return false;
  if (!scr_sa_pf_heap_big) {
    if ((size_t)(cur - scr_sa_pf_brk0) < SCR_SA_PF_HEAP_MIN) return true;
    scr_sa_pf_heap_big = true;
    (void)mallopt(M_TOP_PAD, (int)SCR_SA_PF_TOP_PAD);
  }
  scr_sa_pf_populate((char *)((uintptr_t)seen & ~(scr_sa_pf_page - 1)), cur);
  return true;
}
#endif

static void *scr_sa_pf_main(void *arg) {
  (void)arg;
#ifdef SCR_SA_PF_HEAP
  unsigned idle = SCR_SA_PF_POLLS;
#endif
  pthread_mutex_lock(&scr_sa_pf_lock);
  for (;;) {
    while (scr_sa_pf_head == scr_sa_pf_tail) {
      scr_sa_pf_waiting = true;
#ifdef SCR_SA_PF_HEAP
      if (scr_sa_pf_heap_mode && idle < SCR_SA_PF_POLLS) {
        struct timespec t;
        clock_gettime(CLOCK_MONOTONIC, &t);
        t.tv_nsec += SCR_SA_PF_POLL_NS;
        if (t.tv_nsec >= 1000000000L) {
          t.tv_sec++;
          t.tv_nsec -= 1000000000L;
        }
        int rc = pthread_cond_timedwait(&scr_sa_pf_cond, &scr_sa_pf_lock, &t);
        scr_sa_pf_waiting = false;
        if (rc != 0 && scr_sa_pf_head == scr_sa_pf_tail) {
          pthread_mutex_unlock(&scr_sa_pf_lock);
          idle = scr_sa_pf_heap() ? 0 : idle + 1;
          pthread_mutex_lock(&scr_sa_pf_lock);
        }
        continue;
      }
#endif
      pthread_cond_wait(&scr_sa_pf_cond, &scr_sa_pf_lock);
      scr_sa_pf_waiting = false;
    }
    ScrSaPfRange r = scr_sa_pf_ring[scr_sa_pf_tail++ % SCR_SA_PF_RING];
    scr_sa_pf_busy = r;
    pthread_mutex_unlock(&scr_sa_pf_lock);
    if (r.hi > r.lo) scr_sa_pf_populate(r.lo, r.hi);
#ifdef SCR_SA_PF_HEAP
    if (scr_sa_pf_heap_mode) {
      (void)scr_sa_pf_heap();
      idle = 0;
    }
#endif
    pthread_mutex_lock(&scr_sa_pf_lock);
    scr_sa_pf_busy = (ScrSaPfRange){NULL, NULL};
    if (scr_sa_pf_forgetting) pthread_cond_broadcast(&scr_sa_pf_done);
  }
  return NULL;
}

/* Drops the requests that overlap [lo, hi) and waits for the one the helper
 * is faulting in if it overlaps, so pages returned there stay returned. */
static void scr_sa_pf_forget(char *lo, char *hi) {
  pthread_mutex_lock(&scr_sa_pf_lock);
  for (unsigned k = scr_sa_pf_tail; k != scr_sa_pf_head; k++) {
    ScrSaPfRange *r = &scr_sa_pf_ring[k % SCR_SA_PF_RING];
    if (r->lo < hi && r->hi > lo) r->hi = r->lo;
  }
  scr_sa_pf_forgetting++;
  while (scr_sa_pf_busy.lo < hi && scr_sa_pf_busy.hi > lo) pthread_cond_wait(&scr_sa_pf_done, &scr_sa_pf_lock);
  scr_sa_pf_forgetting--;
  pthread_mutex_unlock(&scr_sa_pf_lock);
}

static bool scr_sa_pf_on(void) {
  int s = atomic_load_explicit(&scr_sa_pf_state, memory_order_relaxed);
  if (s == 0) {
    const char *v = getenv("SCR_SA_PREFAULT");
    s = v && v[0] == '0' ? -1 : 1;
    atomic_store_explicit(&scr_sa_pf_state, s, memory_order_relaxed);
  }
  return s > 0;
}

/* fork() copies only the calling thread, so a child has no helper. The
 * prepare handler takes the lock, so no other thread holds it across the
 * fork. The child handler gives the child fresh helper state: an empty ring,
 * no busy range or waiters, new conditions (the parent's can still record
 * the helper as a waiter), and the heap watermarks cleared. Its first
 * request then starts a helper of its own. */
static bool scr_sa_pf_atfork;

static void scr_sa_pf_fork_prepare(void) { pthread_mutex_lock(&scr_sa_pf_lock); }

static void scr_sa_pf_fork_parent(void) { pthread_mutex_unlock(&scr_sa_pf_lock); }

static void scr_sa_pf_fork_child(void) {
  (void)pthread_mutex_init(&scr_sa_pf_lock, NULL);
  (void)pthread_cond_init(&scr_sa_pf_cond, NULL);
  (void)pthread_cond_init(&scr_sa_pf_done, NULL);
  scr_sa_pf_head = scr_sa_pf_tail = 0;
  scr_sa_pf_busy = (ScrSaPfRange){NULL, NULL};
  scr_sa_pf_forgetting = 0;
  scr_sa_pf_waiting = false;
  scr_sa_pf_started = false;
#ifdef SCR_SA_PF_HEAP
  scr_sa_pf_heap_mode = 0;
  scr_sa_pf_brk0 = scr_sa_pf_brk = NULL;
  scr_sa_pf_heap_big = false;
#endif
}

/* Asks the helper to fault in [lo, hi) (page aligned). Dropped when the
 * ring is full: the owner then faults those pages itself. */
static void scr_sa_prefault(char *lo, char *hi) {
  if (hi <= lo || !scr_sa_pf_on()) return;
  pthread_mutex_lock(&scr_sa_pf_lock);
  if (!scr_sa_pf_started) {
    scr_sa_pf_started = true;
    /* Once per process: a child inherits the parent's handlers. */
    if (!scr_sa_pf_atfork &&
        pthread_atfork(scr_sa_pf_fork_prepare, scr_sa_pf_fork_parent, scr_sa_pf_fork_child) != 0) {
      pthread_mutex_unlock(&scr_sa_pf_lock);
      atomic_store_explicit(&scr_sa_pf_state, -1, memory_order_relaxed);
      return;
    }
    scr_sa_pf_atfork = true;
#ifdef SCR_SA_PF_HEAP
    /* Nobody waits on the condition yet: give it the monotonic clock for
     * the helper's polls (no polls without it). */
    const char *v = getenv("SCR_SA_PREFAULT_HEAP");
    long page = sysconf(_SC_PAGESIZE);
    char thp = scr_sa_thp_mode();
    pthread_condattr_t ca;
    if (!(v && v[0] == '0') && thp != 'm' && page > 0 && pthread_condattr_init(&ca) == 0) {
      if (pthread_condattr_setclock(&ca, CLOCK_MONOTONIC) == 0) {
        pthread_cond_destroy(&scr_sa_pf_cond);
        pthread_cond_init(&scr_sa_pf_cond, &ca);
        scr_sa_pf_page = (uintptr_t)page;
        scr_sa_pf_heap_mode = 1;
      }
      pthread_condattr_destroy(&ca);
    }
#endif
    /* The helper takes no signals: they stay with the program's threads. */
    pthread_attr_t attr;
    pthread_t helper;
    sigset_t all, old;
    sigfillset(&all);
    bool ok = pthread_attr_init(&attr) == 0;
    if (ok) {
      bool masked = pthread_sigmask(SIG_SETMASK, &all, &old) == 0;
      ok = pthread_attr_setdetachstate(&attr, PTHREAD_CREATE_DETACHED) == 0 &&
           pthread_attr_setstacksize(&attr, (size_t)64 << 10) == 0 &&
           pthread_create(&helper, &attr, scr_sa_pf_main, NULL) == 0;
      if (masked) (void)pthread_sigmask(SIG_SETMASK, &old, NULL);
      pthread_attr_destroy(&attr);
    }
    if (!ok) atomic_store_explicit(&scr_sa_pf_state, -1, memory_order_relaxed);
  }
  if (atomic_load_explicit(&scr_sa_pf_state, memory_order_relaxed) > 0 &&
      scr_sa_pf_head - scr_sa_pf_tail < SCR_SA_PF_RING) {
    scr_sa_pf_ring[scr_sa_pf_head++ % SCR_SA_PF_RING] = (ScrSaPfRange){lo, hi};
    if (scr_sa_pf_waiting) pthread_cond_signal(&scr_sa_pf_cond);
  }
  pthread_mutex_unlock(&scr_sa_pf_lock);
}

#ifdef SCR_WORKERS
/* The workers' budget (see above): bytes faulted ahead of all workers
 * that their limits have not reached. Per thread: whether it is the main
 * thread (0 not known yet, 1 main, 2 worker), bytes its class limits have
 * advanced, its share of the budget, and each class's range in flight. */
static _Atomic(size_t) scr_sa_pf_workers_ahead;
static _Thread_local int scr_sa_pf_role;
static _Thread_local size_t scr_sa_pf_advanced, scr_sa_pf_ahead;
static _Thread_local char *scr_sa_pf_lo[SCR_SA_NCLASS];
static _Thread_local size_t scr_sa_pf_len[SCR_SA_NCLASS];

/* Records class c's limit moving from lim to next: the advance counts
 * toward SCR_SA_PF_WORKER_MIN, and a range in flight that the limit has
 * reached goes back to the workers' budget. */
static void scr_sa_pf_advance(unsigned c, char *lim, char *next) {
  scr_sa_pf_advanced += (size_t)(next - lim);
  if (scr_sa_pf_len[c] && next > scr_sa_pf_lo[c]) {
    scr_sa_pf_ahead -= scr_sa_pf_len[c];
    atomic_fetch_sub_explicit(&scr_sa_pf_workers_ahead, scr_sa_pf_len[c], memory_order_relaxed);
    scr_sa_pf_len[c] = 0;
  }
}

/* Returns the calling thread's ranges in flight to the workers' budget
 * when it parks its arena. */
static void scr_sa_pf_park(void) {
  if (scr_sa_pf_ahead)
    atomic_fetch_sub_explicit(&scr_sa_pf_workers_ahead, scr_sa_pf_ahead, memory_order_relaxed);
  scr_sa_pf_ahead = 0;
  scr_sa_pf_advanced = 0;
  memset(scr_sa_pf_len, 0, sizeof scr_sa_pf_len);
}

/* scr_sa_prefault for class c: unconditionally on the main thread, within
 * the budget on a worker. */
static void scr_sa_prefault_ahead(unsigned c, char *lo, char *hi) {
  if (!scr_sa_pf_role) scr_sa_pf_role = (pid_t)syscall(SYS_gettid) == getpid() ? 1 : 2;
  if (scr_sa_pf_role == 1) {
    scr_sa_prefault(lo, hi);
    return;
  }
  if (hi <= lo || scr_sa_pf_len[c] || scr_sa_pf_advanced < SCR_SA_PF_WORKER_MIN) return;
  size_t n = (size_t)(hi - lo);
  size_t ahead = atomic_load_explicit(&scr_sa_pf_workers_ahead, memory_order_relaxed);
  do {
    if (ahead + n > SCR_SA_PF_WORKERS_MAX) return;
  } while (!atomic_compare_exchange_weak_explicit(&scr_sa_pf_workers_ahead, &ahead, ahead + n,
                                                  memory_order_relaxed, memory_order_relaxed));
  scr_sa_pf_ahead += n;
  scr_sa_pf_lo[c] = lo;
  scr_sa_pf_len[c] = n;
  scr_sa_prefault(lo, hi);
}
#else
/* Without worker threads every allocating thread is the main thread. */
#define scr_sa_pf_advance(c, lim, next) ((void)0)
#define scr_sa_prefault_ahead(c, lo, hi) scr_sa_prefault(lo, hi)
#endif
#endif

/* Blocks above SCR_SA_MAX (array storage, hash tables, link pages, large
 * strings) come from glibc, whose heap and per-block mappings use small
 * pages where THP is in madvise mode (the common distribution default);
 * in large compiler-like programs that is most of the page faults and a
 * share of the TLB misses. glibc only advises huge pages for its own
 * memory when the glibc.malloc.hugetlb tunable is set in the environment,
 * which a program cannot do for itself. So once the brk heap has grown
 * past SCR_SA_HEAP_HUGE_AFTER (small programs keep small pages and their
 * RSS), every large allocation advises the heap grown since the previous
 * one, and the aligned interior of a block mapped outside the heap.
 * glibc grows the heap by its top pad beyond each request; the default
 * (128 KiB) is smaller than a huge page, so every 2 MiB range would be
 * first touched while it still straddles the heap end, where it can only
 * get small pages. The policy therefore raises the top pad. Setting it
 * fixes glibc's otherwise adaptive mmap and trim thresholds, so they are
 * set to the adaptive maxima the heap of such a program reaches anyway. */
#if defined(SCR_SA_THP) && defined(__GLIBC__)
#include <malloc.h>
#include <stdatomic.h>
#include <unistd.h>
#define SCR_SA_HEAP_HUGE_AFTER ((uintptr_t)32 << 20)
#define SCR_SA_HEAP_TOP_PAD (32 << 20)
#define SCR_SA_HEAP_MMAP_THRESHOLD (32 << 20) /* glibc's adaptive maximum */
#define SCR_SA_HEAP_TRIM_THRESHOLD (64 << 20) /* twice that, as glibc keeps it */
/* 0 = undecided, 1 = following, 2 = off (THP not in madvise mode). */
static _Atomic(int) scr_sa_heap_state;
static _Atomic(uintptr_t) scr_sa_heap_lo; /* heap start seen at the first large block */
static _Atomic(uintptr_t) scr_sa_heap_hi; /* end of the advised heap prefix */
static _Atomic(uintptr_t) scr_sa_heap_page; /* the page size, read with the mode */
/* The page size is stored before scr_sa_heap_lo is published (the CAS is a
 * release), and every thread loads scr_sa_heap_lo, then scr_sa_heap_hi, with
 * acquire before reading it; each scr_sa_heap_hi update is an RMW by a thread
 * that already sees it, so any thread that wins the advice CAS sees a nonzero
 * page size. A zero read still skips the advice rather than align to 0.
 * These loads run only on blocks too large for the small allocator, next to
 * a glibc malloc call: plain loads on x86-64, LDAR (or LDAPR) on arm64. */

#if defined(SCR_WORKERS) && !defined(SCR_LIB)
#if defined(__aarch64__)
#include <sys/prctl.h>
#endif
/* glibc's per-thread heaps (worker executables; library archives run on
 * their embedder's threads and leave its heaps alone). glibc serves a thread's
 * blocks from a heap of its own: a 64 MiB mapping, aligned to its size,
 * that it makes accessible with mprotect as it grows, a page-rounded step
 * at a time, so every 2 MiB range is first touched while part of it is
 * still inaccessible and gets small pages. Once a thread has allocated
 * SCR_SA_THREAD_HUGE_AFTER bytes of large blocks (threads with few keep
 * small pages), the heap of each large block it gets is made accessible
 * whole and advised huge pages, once per heap; glibc's calloc still clears
 * only what lies below its own high-water mark, so this touches nothing.
 * glibc's mmap and trim thresholds are fixed at SCR_SA_THREAD_MMAP_THRESHOLD
 * and SCR_SA_THREAD_TRIM_THRESHOLD: lower than the maxima glibc's adaptive
 * thresholds reach, so that blocks of 4 MiB and more get mappings of their
 * own and a heap's free top goes back once it passes 8 MiB, while huge
 * pages keep resident memory that a heap would otherwise leave untouched.
 * The brk heap policy below sets its own (higher) values when the main heap
 * grows past SCR_SA_HEAP_HUGE_AFTER, and those take precedence. The
 * policy is off unless THP is in madvise mode, when the glibc.malloc.hugetlb
 * tunable is set (glibc then advises its heaps itself, or sizes them by
 * hugetlbfs pages), when the system forbids overcommit (making a heap
 * accessible would commit all of it), when malloc is not glibc's (a
 * sanitizer or a preloaded allocator: blocks have no glibc chunk header),
 * and when memory tagging is on (arm64 MTE, the glibc.mem.tagging tunable):
 * a chunk header then carries another tag than the block's pointer, and
 * reading it through that pointer faults.
 * A heap is only advised when /proc/self/maps shows the anonymous mappings
 * of exactly its range. */
#define SCR_SA_GLIBC_HEAP ((uintptr_t)64 << 20) /* glibc's heap size and alignment */
#define SCR_SA_THREAD_HUGE_AFTER ((size_t)16 << 20)
#define SCR_SA_THREAD_MMAP_THRESHOLD (4 << 20)
#define SCR_SA_THREAD_TRIM_THRESHOLD (8 << 20)
static _Thread_local size_t scr_sa_thread_large_bytes;
static _Thread_local uintptr_t scr_sa_thread_heap; /* the heap this thread advised last */
/* The heaps decided already, process-wide: advised, or found not to be a
 * whole glibc heap. Each heap is checked against /proc/self/maps once: the
 * threads of a type check switch between heaps often, and reading the maps
 * at each switch cost thousands of reads of a file that grows with the
 * process's mappings. A full table decides again; a heap that glibc maps
 * again at an address decided before keeps the pages it gets. */
#define SCR_SA_HEAPS_SEEN 1024u
static _Atomic(uintptr_t) scr_sa_heaps_seen[SCR_SA_HEAPS_SEEN];

/* Whether `heap` was decided already; records it when it was not. */
static bool scr_sa_heap_seen(uintptr_t heap) {
  size_t h = (size_t)(((uint64_t)(heap / SCR_SA_GLIBC_HEAP) * 0x9E3779B97F4A7C15ull) >> 54) & (SCR_SA_HEAPS_SEEN - 1);
  for (size_t k = 0; k < SCR_SA_HEAPS_SEEN; k++, h = (h + 1) & (SCR_SA_HEAPS_SEEN - 1)) {
    uintptr_t cur = atomic_load_explicit(&scr_sa_heaps_seen[h], memory_order_relaxed);
    if (cur == heap) return true;
    if (cur == 0) {
      if (atomic_compare_exchange_strong_explicit(&scr_sa_heaps_seen[h], &cur, heap, memory_order_relaxed,
                                                  memory_order_relaxed))
        return false;
      if (cur == heap) return true;
    }
  }
  return false;
}
static _Atomic(int) scr_sa_thread_heaps; /* 0 undecided, 1 advised, 2 off */
extern void *__libc_malloc(size_t);

/* Whether glibc tags heap memory: the glibc.mem.tagging tunable is set to a
 * nonzero value, or (arm64) the kernel checks tags for this process. */
static bool scr_sa_mem_tagging(const char *tunables) {
  const char *t = tunables ? strstr(tunables, "glibc.mem.tagging=") : NULL;
  if (t && t[sizeof "glibc.mem.tagging=" - 1] != '0') return true;
#if defined(__aarch64__)
  /* PR_GET_TAGGED_ADDR_CTRL (56); PR_MTE_TCF_MASK is bits 1-2. A kernel
   * without the call returns -1: no tag checks. */
  long ctrl = prctl(56, 0, 0, 0, 0);
  if (ctrl > 0 && (ctrl & (3L << 1))) return true;
#endif
  return false;
}

/* Whether [heap, heap + SCR_SA_GLIBC_HEAP) is covered exactly by anonymous
 * mappings, as a glibc heap is (its accessible part and the rest). */
static bool scr_sa_glibc_heap_mapped(uintptr_t heap) {
  FILE *f = fopen("/proc/self/maps", "r");
  if (!f) return false;
  char line[512];
  uintptr_t next = heap, end = heap + SCR_SA_GLIBC_HEAP;
  while (next < end && fgets(line, sizeof line, f)) {
    unsigned long lo, hi, inode;
    char path[2] = {0};
    if (sscanf(line, "%lx-%lx %*s %*s %*s %lu %1s", &lo, &hi, &inode, path) < 3) continue;
    if (hi <= next) continue;
    if (lo != next || inode != 0 || path[0]) break;
    next = hi;
  }
  fclose(f);
  return next == end;
}

static void scr_sa_thread_heap_note(void *p, size_t n) {
  if (scr_sa_thread_large_bytes < SCR_SA_THREAD_HUGE_AFTER) {
    scr_sa_thread_large_bytes += n;
    return;
  }
  int mode = atomic_load_explicit(&scr_sa_thread_heaps, memory_order_relaxed);
  if (mode == 2) return;
  if (mode == 0) {
    int undecided = 0;
    const char *tunables = getenv("GLIBC_TUNABLES");
    FILE *f = fopen("/proc/sys/vm/overcommit_memory", "r");
    int overcommit = f ? fgetc(f) : '0';
    if (f) fclose(f);
    /* Loaded through volatile: the compiler takes two declared functions
     * to have different addresses. */
    void *(*volatile used)(size_t) = malloc, *(*volatile own)(size_t) = __libc_malloc;
    bool glibc_malloc = used == own;
    mode = glibc_malloc && scr_sa_thp_mode() == 'm' && !(tunables && strstr(tunables, "glibc.malloc.hugetlb")) &&
                   overcommit != '2' && !scr_sa_mem_tagging(tunables)
               ? 1
               : 2;
    if (atomic_compare_exchange_strong(&scr_sa_thread_heaps, &undecided, mode) && mode == 1 &&
        atomic_load_explicit(&scr_sa_heap_state, memory_order_relaxed) != 1) {
      (void)mallopt(M_MMAP_THRESHOLD, SCR_SA_THREAD_MMAP_THRESHOLD);
      (void)mallopt(M_TRIM_THRESHOLD, SCR_SA_THREAD_TRIM_THRESHOLD);
      /* The brk heap policy marks itself on before it sets its values: if it
       * did so meanwhile, its values are set again. */
      if (atomic_load(&scr_sa_heap_state) == 1) {
        (void)mallopt(M_MMAP_THRESHOLD, SCR_SA_HEAP_MMAP_THRESHOLD);
        (void)mallopt(M_TRIM_THRESHOLD, SCR_SA_HEAP_TRIM_THRESHOLD);
      }
    }
    mode = atomic_load_explicit(&scr_sa_thread_heaps, memory_order_relaxed);
    if (mode != 1) return;
  }
  /* glibc's chunk header: NON_MAIN_ARENA (4) set, IS_MMAPPED (2) clear. */
  if ((((const size_t *)p)[-1] & 6) != 4) return;
  uintptr_t heap = (uintptr_t)p & ~(SCR_SA_GLIBC_HEAP - 1);
  if (heap == scr_sa_thread_heap) return;
  scr_sa_thread_heap = heap;
  if (scr_sa_heap_seen(heap)) return;
  if (scr_sa_glibc_heap_mapped(heap) && mprotect((void *)heap, SCR_SA_GLIBC_HEAP, PROT_READ | PROT_WRITE) == 0)
    (void)madvise((void *)heap, SCR_SA_GLIBC_HEAP, MADV_HUGEPAGE);
}
#endif

static void scr_sa_large_note(void *p, size_t n) {
#if defined(SCR_WORKERS) && !defined(SCR_LIB)
  if (p) scr_sa_thread_heap_note(p, n);
#endif
  int state = atomic_load_explicit(&scr_sa_heap_state, memory_order_relaxed);
  if (state == 2 || !p) return;
  uintptr_t top = (uintptr_t)sbrk(0);
  if (state == 0) {
    uintptr_t lo = atomic_load_explicit(&scr_sa_heap_lo, memory_order_acquire);
    if (!lo) {
      long page = sysconf(_SC_PAGESIZE);
      if (page <= 0 || scr_sa_thp_mode() != 'm') {
        atomic_store_explicit(&scr_sa_heap_state, 2, memory_order_relaxed);
        return;
      }
      atomic_store_explicit(&scr_sa_heap_page, (uintptr_t)page, memory_order_relaxed);
      lo = (top + (uintptr_t)page - 1) & ~((uintptr_t)page - 1);
      uintptr_t none = 0;
      if (!atomic_compare_exchange_strong(&scr_sa_heap_lo, &none, lo)) lo = none;
    }
    if (top < lo + SCR_SA_HEAP_HUGE_AFTER) return;
    uintptr_t unset = 0; /* the whole heap seen so far gets the advice */
    (void)atomic_compare_exchange_strong(&scr_sa_heap_hi, &unset, lo);
    int undecided = 0;
    if (atomic_compare_exchange_strong(&scr_sa_heap_state, &undecided, 1)) {
      (void)mallopt(M_MMAP_THRESHOLD, SCR_SA_HEAP_MMAP_THRESHOLD);
      (void)mallopt(M_TRIM_THRESHOLD, SCR_SA_HEAP_TRIM_THRESHOLD);
      (void)mallopt(M_TOP_PAD, SCR_SA_HEAP_TOP_PAD);
    }
  }
  /* The heap end moved since the last look: advise what it gained (pages
   * already touched keep their small pages), or follow a trim down. */
  uintptr_t hi = atomic_load_explicit(&scr_sa_heap_hi, memory_order_acquire);
  if (!hi) return; /* another thread is switching the policy on */
  if (top > hi) {
    if (atomic_compare_exchange_strong(&scr_sa_heap_hi, &hi, top)) {
      /* madvise wants a page-aligned start */
      uintptr_t page = atomic_load_explicit(&scr_sa_heap_page, memory_order_relaxed);
      if (page) {
        uintptr_t from = hi & ~(page - 1);
        (void)madvise((void *)from, top - from, MADV_HUGEPAGE);
      }
    }
  } else if (top < hi) {
    (void)atomic_compare_exchange_strong(&scr_sa_heap_hi, &hi, top);
  }
  /* A block glibc mapped by itself (or carved from a thread's heap). */
  uintptr_t a = (uintptr_t)p, lo = atomic_load_explicit(&scr_sa_heap_lo, memory_order_relaxed);
  if ((a < lo || a >= top) && n >= 2 * SCR_SA_HUGE_PAGE) {
    uintptr_t s = (a + SCR_SA_HUGE_PAGE - 1) & ~(uintptr_t)(SCR_SA_HUGE_PAGE - 1);
    uintptr_t e = (a + n) & ~(uintptr_t)(SCR_SA_HUGE_PAGE - 1);
    if (e > s) (void)madvise((void *)s, e - s, MADV_HUGEPAGE);
  }
}
#define SCR_SA_LARGE_NOTE(p, n) scr_sa_large_note((p), (n))
#else
#define SCR_SA_LARGE_NOTE(p, n) ((void)0)
#endif

/* ── the window ─────────────────────────────────────────────────────────
 * Every small block comes from one reservation, the window (scr_rc.h),
 * handed out in chunks of SCR_SA_CHUNK bytes: each arena carves a size
 * class from a chunk of its own until the chunk is full, then takes another.
 * On Linux the window lies in [4 GiB, 32 GiB), clear of executables loaded
 * low and their heaps, and also holds the program-lifetime region (below);
 * elsewhere it lies anywhere. Chunks come from the window's top with one
 * atomic add, or from the chunks that discarded workers returned whole
 * (scr_sa_spare). A host that refuses the whole window (valgrind limits the
 * address space) gets a smaller one, down to SCR_SA_WINDOW_MIN; an exhausted
 * or refused window leaves small blocks to the system allocator. */
#ifdef SCR_WORKERS
#define SCR_SA_ARENAS 32u
#else
#define SCR_SA_ARENAS 1u
#endif
/* Exited workers return memory (Linux; see scr_sa_trim below). */
#if defined(SCR_WORKERS) && defined(__linux__) && defined(MADV_DONTNEED)
#define SCR_SA_TRIM 1
#endif
#ifdef SCR_SA_WINDOW_TEST_CHUNKS
/* The allocator's own test (scr_alloc.test.c) exhausts a small window. */
#define SCR_SA_WINDOW_WANT ((size_t)SCR_SA_WINDOW_TEST_CHUNKS << SCR_SA_CHUNK_SHIFT)
#define SCR_SA_WINDOW_MIN SCR_SA_WINDOW_WANT
#else
#define SCR_SA_WINDOW_WANT ((size_t)SCR_SA_WINDOW_CHUNKS << SCR_SA_CHUNK_SHIFT)
#define SCR_SA_WINDOW_MIN ((size_t)1 << 30)
#endif
/* The chunks the window keeps past the classes' slices (8 GiB): large
 * blocks, runs, the program-lifetime region and the classes that outgrow
 * their slices. */
#define SCR_SA_SLICE_ROOM 2048u
static char *scr_sa_window;        /* the window's start once reserved (atomic) */
static size_t scr_sa_window_chunks; /* the chunks it holds, set before the start */
static size_t scr_sa_window_top;    /* chunks handed out from the top (atomic) */
static bool scr_sa_window_refused;
static char scr_sa_window_lock; /* the reservation and the spare chunks */
#ifdef SCR_SA_TRIM
static uint16_t scr_sa_spare[SCR_SA_WINDOW_CHUNKS]; /* chunk indices returned whole */
static size_t scr_sa_nspare;
#endif

/* Takes a lock that guards a few stores. A waiter yields its processor:
 * the holder may be descheduled, and under valgrind, which runs one thread
 * at a time, a waiter that only spins can keep the holder from running. */
static void scr_sa_spin_take(char *lock) {
  while (__atomic_test_and_set(lock, __ATOMIC_ACQUIRE)) sched_yield();
}

static void scr_sa_window_lock_take(void) { scr_sa_spin_take(&scr_sa_window_lock); }

static void scr_sa_window_lock_drop(void) { __atomic_clear(&scr_sa_window_lock, __ATOMIC_RELEASE); }

#ifdef __linux__
/* Maps `size` bytes at `at` exactly, as scr_sa_map does anywhere; NULL if
 * refused. */
static char *scr_sa_map_at(void *at, size_t size) {
  int flags = MAP_PRIVATE | MAP_ANON | MAP_NORESERVE;
#ifdef MAP_FIXED_NOREPLACE
  flags |= MAP_FIXED_NOREPLACE;
#endif
  char *p = mmap(at, size, PROT_READ | PROT_WRITE, flags, -1, 0);
  if (p == MAP_FAILED) return NULL;
  if (p != (char *)at) {
    /* The system took `at` as a hint only (no MAP_FIXED_NOREPLACE). */
    (void)munmap(p, size);
    return NULL;
  }
#ifdef SCR_SA_THP
  (void)madvise(p, size, MADV_NOHUGEPAGE);
#endif
#ifdef SCR_SA_DUMP
  (void)madvise(p, size, MADV_DONTDUMP);
  scr_sa_dump_chunks = scr_sa_cores_written();
#endif
  return p;
}
#endif

/* Reserves the window once per process; whether it exists. */
static bool scr_sa_window_reserve(void) {
  if (__atomic_load_n(&scr_sa_window, __ATOMIC_ACQUIRE)) return true;
  scr_sa_window_lock_take();
  if (!scr_sa_window && !scr_sa_window_refused) {
    char *p = NULL;
    size_t size = 0;
#ifdef __linux__
    for (size_t start = (size_t)4 << 30; !p && start <= (size_t)16 << 30; start *= 2) {
      size = ((size_t)32 << 30) - start;
      if (size > SCR_SA_WINDOW_WANT) size = SCR_SA_WINDOW_WANT;
      while (size >= SCR_SA_WINDOW_MIN && !(p = scr_sa_map_at((void *)start, size))) size /= 2;
    }
#endif
    if (!p)
      for (size = SCR_SA_WINDOW_WANT; size >= SCR_SA_WINDOW_MIN && !(p = scr_sa_map(size));) size /= 2;
    if (p) {
      scr_sa_window_chunks = size >> SCR_SA_CHUNK_SHIFT;
#ifndef SCR_WORKERS
      /* The classes' slices come first, when they leave the rest of the
       * window at least SCR_SA_SLICE_ROOM chunks. */
      if (scr_sa_window_chunks >= (size_t)SCR_SA_NCLASS * SCR_SA_SLICE_CHUNKS + SCR_SA_SLICE_ROOM) {
        scr_sa_window_top = (size_t)SCR_SA_NCLASS * SCR_SA_SLICE_CHUNKS;
        scr_sa_slice_span = (uintptr_t)SCR_SA_NCLASS * SCR_SA_SLICE_CHUNKS << SCR_SA_CHUNK_SHIFT;
      }
#endif
      if ((uintptr_t)p + size <= (uintptr_t)SCR_SA_MAP_CHUNKS << SCR_SA_CHUNK_SHIFT)
        scr_sa_map_first = (uintptr_t)p >> SCR_SA_CHUNK_SHIFT;
      __atomic_store_n(&scr_sa_window, p, __ATOMIC_RELEASE);
    } else {
      scr_sa_window_refused = true;
    }
  }
  scr_sa_window_lock_drop();
  return __atomic_load_n(&scr_sa_window, __ATOMIC_ACQUIRE) != NULL;
}

/* Takes n contiguous chunks for `owner` (their chunk-table entry); NULL
 * when the window has no room left. */
static char *scr_sa_chunk_take(size_t n, uint16_t owner) {
  char *w = __atomic_load_n(&scr_sa_window, __ATOMIC_ACQUIRE);
  if (!w) return NULL;
  size_t i = SIZE_MAX;
#ifdef SCR_SA_TRIM
  if (n == 1 && __atomic_load_n(&scr_sa_nspare, __ATOMIC_RELAXED)) {
    scr_sa_window_lock_take();
    if (scr_sa_nspare) i = scr_sa_spare[--scr_sa_nspare];
    scr_sa_window_lock_drop();
  }
#endif
  if (i == SIZE_MAX) {
    i = __atomic_fetch_add(&scr_sa_window_top, n, __ATOMIC_RELAXED);
    if (i >= scr_sa_window_chunks || n > scr_sa_window_chunks - i) return NULL;
  }
  for (size_t k = 0; k < n; k++) scr_sa_chunk_set(i + k, owner);
  return w + (i << SCR_SA_CHUNK_SHIFT);
}

/* The next chunk of small class c: in a program without workers, the next
 * chunk of the class's slice (scr_rc.h) while it has one, else a chunk from
 * the window's top or the spare chunks. */
#ifndef SCR_WORKERS
static size_t scr_sa_slice_next[SCR_SA_NCLASS]; /* chunks taken from each slice */
#endif
static char *scr_sa_class_chunk_take(unsigned c) {
#ifndef SCR_WORKERS
  if (scr_sa_slice_span && scr_sa_slice_next[c] < SCR_SA_SLICE_CHUNKS) {
    size_t i = (size_t)c * SCR_SA_SLICE_CHUNKS + scr_sa_slice_next[c]++;
    scr_sa_chunk_set(i, (uint16_t)(scr_sa.tag | c));
    return scr_sa_window + (i << SCR_SA_CHUNK_SHIFT);
  }
#endif
  return scr_sa_chunk_take(1, (uint16_t)(scr_sa.tag | c));
}

#ifdef SCR_SA_TRIM
/* Returns chunk p, whose pages went back already, for any owner to take.
 * The spare list has room for every chunk of the window. */
static void scr_sa_chunk_give(char *p) {
  size_t i = (size_t)(p - scr_sa_window) >> SCR_SA_CHUNK_SHIFT;
  scr_sa_chunk_set(i, 0);
  scr_sa_window_lock_take();
  scr_sa_spare[scr_sa_nspare] = (uint16_t)i;
  __atomic_store_n(&scr_sa_nspare, scr_sa_nspare + 1, __ATOMIC_RELAXED);
  scr_sa_window_lock_drop();
}
#endif

#ifdef SCR_WORKERS
/* The chunk-table entry of the chunk holding p: 0 outside the window and
 * for chunks that hold no small blocks. */
static inline unsigned scr_sa_owner(const void *p) {
  char *w = __atomic_load_n(&scr_sa_window, __ATOMIC_ACQUIRE);
  uintptr_t off = (uintptr_t)p - (uintptr_t)w;
  if (!w || off >= (uintptr_t)scr_sa_window_chunks << SCR_SA_CHUNK_SHIFT) return 0;
  return scr_sa_chunks[off >> SCR_SA_CHUNK_SHIFT];
}
#endif

/* The start of the chunk holding p, a pointer into the window. */
static inline char *scr_sa_chunk_of(const void *p) {
  return scr_sa_window + (((uintptr_t)p - (uintptr_t)scr_sa_window) & ~(uintptr_t)(SCR_SA_CHUNK - 1));
}

/* Whether p is a block of the window: small, large or run, of the calling
 * thread's arena or another's. */
static inline bool scr_sa_in_window(const void *p) {
  char *w = __atomic_load_n(&scr_sa_window, __ATOMIC_ACQUIRE);
  uintptr_t off = (uintptr_t)p - (uintptr_t)w;
  return w && off < (uintptr_t)scr_sa_window_chunks << SCR_SA_CHUNK_SHIFT;
}

/* Per arena and class: the chunk the class carves now (NULL before its
 * first), how many chunks it has taken, that one included, and the chunk it
 * continues in, taken ahead while the current one fills so that the pre-fault
 * helper faults its first pages before the class reaches them (NULL until
 * then; see scr_sa_extend). */
typedef struct {
  char *start;
  uint32_t chunks;
  char *next;
} ScrSaCarve;
static ScrSaCarve scr_sa_carve[SCR_SA_ARENAS][SCR_SA_NCLASS];
#ifdef SCR_WORKERS
static _Thread_local int scr_sa_arena = -1; /* the calling thread's arena, or -1 */
#define SCR_SA_ARENA_NOW ((unsigned)scr_sa_arena)
#else
#define SCR_SA_ARENA_NOW 0u
#endif

/* The bytes of a full chunk of blocks of `sz` bytes. */
static inline size_t scr_sa_chunk_bytes(size_t sz) { return SCR_SA_CHUNK / sz * sz; }

/* ── large blocks in the window ─────────────────────────────────────────
 * Blocks above SCR_SA_MAX that a 32-bit reference may name (strings with
 * their characters, class instances, records and closures; scr_mem_alloc_ref
 * in scr_rc.h) come from the window too, so that every object an object
 * field can point at lies below 32 GiB. Other large blocks (array element
 * storage, hash tables) stay with the system allocator.
 * - Up to SCR_SA_LARGE_MAX: SCR_SA_NLARGE classes, four per power of two
 *   from 640 bytes, carved by each arena from chunks of its own like the
 *   small classes. Their chunk-table entry is SCR_SA_LARGE_TAG | tag | class,
 *   which no arena's tag xors to below 256, so the inline free leaves them
 *   to scr_sa_free_foreign. A block freed by another thread goes to its
 *   arena's remote list like a small block.
 * - Larger: runs of whole chunks (entry SCR_SA_RUN_HEAD, then
 *   SCR_SA_RUN_NEXT), which any thread returns to the window when it frees
 *   the block.
 * - A free large block keeps its first page; scr_sa_large_trim returns the
 *   rest of its pages (the trim points of scr_sa_trim, scr_heap_trim). */
#define SCR_SA_LARGE_MAX ((size_t)2 << 20)
/* The size past which a growing block (scr_mem_realloc_ref) takes a run. */
#define SCR_SA_GROW_RUN ((size_t)128 << 10)
#define SCR_SA_NLARGE 48u
#define SCR_SA_LARGE_TAG 0x8000u
#define SCR_SA_RUN_HEAD 0xff00u
#define SCR_SA_RUN_NEXT 0xff01u

/* The block size of large class c: 512 * 2^(c / 4) * (1 + (c % 4 + 1) / 4). */
static inline size_t scr_sa_large_size(unsigned c) {
  size_t base = (size_t)SCR_SA_MAX << (c >> 2);
  return base + (base >> 2) * ((c & 3) + 1);
}

/* The large class of a block of n bytes, SCR_SA_MAX < n <= SCR_SA_LARGE_MAX. */
static inline unsigned scr_sa_large_class(size_t n) {
  unsigned k = 0;
  size_t base = SCR_SA_MAX;
  while (base * 2 < n) {
    base *= 2;
    k++;
  }
  size_t step = base >> 2;
  return k * 4 + (unsigned)((n - base + step - 1) / step) - 1;
}

/* Per arena and large class: free blocks whose pages are all present, free
 * blocks whose pages past the first went back (scr_sa_large_trim), and the
 * carve frontier in the class's current chunk. */
typedef struct {
  ScrSaBlock *free[SCR_SA_NLARGE], *trimmed[SCR_SA_NLARGE];
  char *bump[SCR_SA_NLARGE], *lim[SCR_SA_NLARGE];
  size_t carved; /* bytes carved, every class (scr_sa_carved) */
} ScrSaLarge;
static ScrSaLarge scr_sa_large[SCR_SA_ARENAS];

/* Runs: the chunks of the run that starts at each head chunk, and the runs
 * returned to the window, which later runs reuse first fit (under the window
 * lock). Up to SCR_SA_RUN_KEEP chunks of freed runs keep their pages
 * (`dirty`), so that a program that builds and drops large strings in turn
 * reuses resident memory instead of faulting it in again, as the system
 * allocator's heap does; the runs taken first are those. The pages of the
 * others went back, so they read as zero; the trim points return the kept
 * pages too (scr_sa_large_trim). */
#define SCR_SA_RUN_KEEP 16u
static uint16_t scr_sa_run_chunks[SCR_SA_WINDOW_CHUNKS];
typedef struct {
  uint16_t start, n;
  bool dirty;
} ScrSaFreeRun;
static ScrSaFreeRun scr_sa_free_runs[SCR_SA_WINDOW_CHUNKS];
static size_t scr_sa_nfree_runs;
static size_t scr_sa_dirty_chunks; /* chunks of the dirty free runs */

/* Returns the pages of [lo, hi) to the system; they read as zero again. */
static void scr_sa_pages_return(char *lo, char *hi) {
#if defined(__linux__) && defined(MADV_DONTNEED)
  if (hi > lo) (void)madvise(lo, (size_t)(hi - lo), MADV_DONTNEED);
#else
  if (hi > lo) memset(lo, 0, (size_t)(hi - lo));
#endif
}

/* A run of n chunks for a block of `bytes` bytes, zeroed when `zero`, from a
 * returned run (a dirty one first) or the window's top; NULL when the window
 * has no room. */
static char *scr_sa_run_take(size_t n, size_t bytes, bool zero) {
  char *w = __atomic_load_n(&scr_sa_window, __ATOMIC_ACQUIRE);
  if (!w || n > 0xffff) return NULL;
  size_t i = SIZE_MAX, pick = SIZE_MAX;
  bool dirty = false;
  scr_sa_window_lock_take();
  for (size_t k = 0; k < scr_sa_nfree_runs; k++)
    if (scr_sa_free_runs[k].n >= n && (pick == SIZE_MAX || (scr_sa_free_runs[k].dirty && !dirty))) {
      pick = k;
      dirty = scr_sa_free_runs[k].dirty;
      if (dirty) break;
    }
  if (pick != SIZE_MAX) {
    ScrSaFreeRun *r = &scr_sa_free_runs[pick];
    i = r->start;
    r->start = (uint16_t)(i + n);
    r->n = (uint16_t)(r->n - n);
    if (dirty) scr_sa_dirty_chunks -= n;
    if (!r->n) *r = scr_sa_free_runs[--scr_sa_nfree_runs];
  }
  scr_sa_window_lock_drop();
  if (dirty && zero) memset(w + (i << SCR_SA_CHUNK_SHIFT), 0, bytes);
  if (i == SIZE_MAX) {
    i = __atomic_fetch_add(&scr_sa_window_top, n, __ATOMIC_RELAXED);
    if (i >= scr_sa_window_chunks || n > scr_sa_window_chunks - i) return NULL;
  }
  scr_sa_run_chunks[i] = (uint16_t)n;
  scr_sa_chunk_set(i, (uint16_t)SCR_SA_RUN_HEAD);
  for (size_t k = 1; k < n; k++) scr_sa_chunk_set(i + k, (uint16_t)SCR_SA_RUN_NEXT);
  return w + (i << SCR_SA_CHUNK_SHIFT);
}

/* Frees the block at the head of a run: its pages go back and the run
 * returns to the window, merged with a returned run that ends where it
 * starts or starts where it ends. */
static void scr_sa_run_release(char *p, bool clean) {
  size_t i = (size_t)(p - scr_sa_window) >> SCR_SA_CHUNK_SHIFT, n = scr_sa_run_chunks[i];
  for (size_t k = 0; k < n; k++) scr_sa_chunk_set(i + k, 0);
  scr_sa_window_lock_take();
  bool dirty = !clean && scr_sa_dirty_chunks + n <= SCR_SA_RUN_KEEP;
  if (dirty) scr_sa_dirty_chunks += n;
  scr_sa_window_lock_drop();
  if (!dirty && !clean) scr_sa_pages_return(p, p + (n << SCR_SA_CHUNK_SHIFT));
  scr_sa_window_lock_take();
  size_t at = SIZE_MAX;
  for (size_t k = 0; k < scr_sa_nfree_runs; k++) {
    ScrSaFreeRun *r = &scr_sa_free_runs[k];
    if (r->dirty == dirty && ((size_t)r->start + r->n == i || i + n == r->start)) {
      if (r->start > i) r->start = (uint16_t)i;
      r->n = (uint16_t)(r->n + n);
      at = k;
      break;
    }
  }
  if (at == SIZE_MAX) scr_sa_free_runs[scr_sa_nfree_runs++] = (ScrSaFreeRun){(uint16_t)i, (uint16_t)n, dirty};
  scr_sa_window_lock_drop();
}

static void scr_sa_run_free(char *p) { scr_sa_run_release(p, false); }

/* Returns the pages of the dirty free runs (under the window lock, so that
 * no run is taken while its pages go back). */
static void scr_sa_runs_trim(void) {
  if (!__atomic_load_n(&scr_sa_window, __ATOMIC_ACQUIRE)) return;
  scr_sa_window_lock_take();
  for (size_t k = 0; k < scr_sa_nfree_runs; k++) {
    ScrSaFreeRun *r = &scr_sa_free_runs[k];
    if (!r->dirty) continue;
    char *lo = scr_sa_window + ((size_t)r->start << SCR_SA_CHUNK_SHIFT);
    scr_sa_pages_return(lo, lo + ((size_t)r->n << SCR_SA_CHUNK_SHIFT));
    r->dirty = false;
  }
  scr_sa_dirty_chunks = 0;
  scr_sa_window_lock_drop();
}

/* The bytes of the window block p with chunk-table entry e (large class or
 * run head), or 0 for any other entry. */
static size_t scr_sa_large_bytes(const void *p, unsigned e) {
  if (e == SCR_SA_RUN_HEAD)
    return (size_t)scr_sa_run_chunks[((uintptr_t)p - (uintptr_t)scr_sa_window) >> SCR_SA_CHUNK_SHIFT]
           << SCR_SA_CHUNK_SHIFT;
  if ((e & SCR_SA_LARGE_TAG) && e < SCR_SA_RUN_HEAD) return scr_sa_large_size(e & 0xff);
  return 0;
}

/* Puts large block b of class c on arena i's free list. The arena's owner
 * only (or a drain of its remote list). */
static inline void scr_sa_large_push(unsigned i, ScrSaBlock *b, unsigned c) {
  b->next = scr_sa_large[i].free[c];
  scr_sa_large[i].free[c] = b;
}

/* Returns the pages of the calling thread's free large blocks, past each
 * block's first page (which keeps the free-list link). */
static void scr_sa_runs_trim(void);
static void scr_sa_large_trim(void) {
#if defined(__linux__) && defined(MADV_DONTNEED)
  scr_sa_runs_trim();
  if (!scr_sa.span) return;
  ScrSaLarge *l = &scr_sa_large[SCR_SA_ARENA_NOW];
  long page = sysconf(_SC_PAGESIZE);
  uintptr_t pg = page > 0 ? (uintptr_t)page : 4096;
  for (unsigned c = 0; c < SCR_SA_NLARGE; c++) {
    size_t sz = scr_sa_large_size(c);
    if (sz < 2 * pg) {
      continue;
    }
    while (l->free[c]) {
      ScrSaBlock *b = l->free[c];
      l->free[c] = b->next;
      char *lo = (char *)(((uintptr_t)b + pg) & ~(pg - 1)), *hi = (char *)(((uintptr_t)b + sz) & ~(pg - 1));
      scr_sa_pages_return(lo, hi);
      b->next = l->trimmed[c];
      l->trimmed[c] = b;
    }
  }
#endif
}

/* The bytes class c of the calling thread's arena has carved, up to its
 * frontier `top` in its current chunk. */
static size_t scr_sa_class_carved(unsigned c, const char *top) {
  const ScrSaCarve *k = &scr_sa_carve[SCR_SA_ARENA_NOW][c];
  if (!k->start) return 0;
  return (size_t)(k->chunks - 1) * scr_sa_chunk_bytes(scr_sa_class_size(c)) + (size_t)(top - k->start);
}

/* The chunks of class c of the calling thread's arena, in address order,
 * into `out` (room for SCR_SA_WINDOW_CHUNKS); their count. */
static size_t scr_sa_class_chunks(unsigned c, uint32_t *out) {
  unsigned owner = scr_sa.tag | c;
  size_t top = __atomic_load_n(&scr_sa_window_top, __ATOMIC_RELAXED), n = 0;
  if (top > scr_sa_window_chunks) top = scr_sa_window_chunks;
  for (size_t i = 0; i < top; i++)
    if (__atomic_load_n(&scr_sa_chunks[i], __ATOMIC_RELAXED) == owner) out[n++] = (uint32_t)i;
  return n;
}

#if defined(__linux__) && defined(MADV_DONTNEED)
/* The free blocks of class c, marked in one bitmap per chunk of the class
 * (`chunks`, in address order): a block's bit is word (slot * words + k / 64)
 * for its index k in its chunk. Shared by the exit trim and scr_heap_trim. */
typedef struct {
  uint32_t *chunks;  /* chunk indices, in address order */
  size_t n;          /* chunks */
  size_t words;      /* bitmap words per chunk */
  uint64_t *bits;
  uint16_t *slot;    /* chunk index -> its position in `chunks` + 1 */
} ScrSaMarks;

/* Sets up `m` for class c of the calling thread's arena; false when it has
 * no chunks or the bitmaps cannot be mapped. */
static bool scr_sa_marks_open(ScrSaMarks *m, unsigned c) {
  memset(m, 0, sizeof *m);
  size_t sz = scr_sa_class_size(c);
  size_t idx = SCR_SA_WINDOW_CHUNKS * sizeof *m->chunks, map = SCR_SA_WINDOW_CHUNKS * sizeof *m->slot;
  char *meta = mmap(NULL, idx + map, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANON, -1, 0);
  if (meta == MAP_FAILED) return false;
  m->chunks = (uint32_t *)meta;
  m->slot = (uint16_t *)(meta + idx);
  m->n = scr_sa_class_chunks(c, m->chunks);
  m->words = (SCR_SA_CHUNK / sz + 63) / 64;
  if (m->n) {
    m->bits = mmap(NULL, m->n * m->words * 8, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANON, -1, 0);
    if (m->bits == MAP_FAILED) m->bits = NULL;
  }
  if (!m->bits) {
    (void)munmap(meta, idx + map);
    return false;
  }
  for (size_t j = 0; j < m->n; j++) m->slot[m->chunks[j]] = (uint16_t)(j + 1);
  return true;
}

static void scr_sa_marks_close(ScrSaMarks *m) {
  if (m->bits) (void)munmap(m->bits, m->n * m->words * 8);
  (void)munmap(m->chunks, SCR_SA_WINDOW_CHUNKS * (sizeof *m->chunks + sizeof *m->slot));
}

/* The bit word and mask of block p of `sz` bytes, or NULL for a pointer
 * outside the class's chunks. */
static inline uint64_t *scr_sa_mark(const ScrSaMarks *m, const void *p, size_t sz, uint64_t *mask) {
  size_t i = (size_t)((char *)p - scr_sa_window) >> SCR_SA_CHUNK_SHIFT;
  if ((uintptr_t)((char *)p - scr_sa_window) >= (uintptr_t)scr_sa_window_chunks << SCR_SA_CHUNK_SHIFT ||
      !m->slot[i])
    return NULL;
  size_t k = (size_t)((char *)p - scr_sa_chunk_of(p)) / sz;
  *mask = (uint64_t)1 << (k % 64);
  return &m->bits[(size_t)(m->slot[i] - 1) * m->words + k / 64];
}

/* Relinks the marked blocks of class c into its free list, in address
 * order. */
static void scr_sa_marks_relink(const ScrSaMarks *m, unsigned c) {
  size_t sz = scr_sa_class_size(c);
  ScrSaBlock *head = NULL, **tail = &head;
  for (size_t j = 0; j < m->n; j++) {
    char *start = scr_sa_window + ((size_t)m->chunks[j] << SCR_SA_CHUNK_SHIFT);
    const uint64_t *bits = &m->bits[j * m->words];
    for (size_t w = 0; w < m->words; w++)
      for (uint64_t x = bits[w]; x; x &= x - 1) {
        ScrSaBlock *b = (ScrSaBlock *)(start + (w * 64 + (size_t)__builtin_ctzll(x)) * sz);
        *tail = b;
        tail = &b->next;
      }
  }
  *tail = NULL;
  scr_sa.free[c] = head;
}

/* For each chunk of the marks, returns (MADV_DONTNEED) the whole pages below
 * its frontier whose blocks are all marked, and unmarks the blocks that
 * overlap them; `top` is the class's frontier in its current chunk. Each run
 * of returned pages goes to `found` (the lowest and highest whole block in
 * it) when it is not NULL; the bytes returned are the result. */
static size_t scr_sa_marks_return(ScrSaMarks *m, unsigned c, char *top, size_t page,
                                  bool (*found)(void *, char *, char *), void *ctx) {
  size_t sz = scr_sa_class_size(c), returned = 0;
  char *current = scr_sa_carve[SCR_SA_ARENA_NOW][c].start;
  for (size_t j = 0; j < m->n; j++) {
    char *start = scr_sa_window + ((size_t)m->chunks[j] << SCR_SA_CHUNK_SHIFT);
    char *ctop = start == current ? top : start + scr_sa_chunk_bytes(sz);
    size_t nblocks = (size_t)(ctop - start) / sz;
    if (!nblocks) continue;
    uint64_t *bits = &m->bits[j * m->words];
#define SCR_SA_BIT(k) ((bits[(k) / 64] >> ((k) % 64)) & 1)
    uintptr_t first = ((uintptr_t)start + page - 1) & ~(uintptr_t)(page - 1);
    uintptr_t last = (uintptr_t)ctop & ~(uintptr_t)(page - 1);
    char *run = NULL;
    for (uintptr_t pg = first; pg <= last; pg += page) {
      bool empty = false;
      if (pg < last) {
        size_t k0 = (size_t)((char *)pg - start) / sz;
        size_t k1 = (size_t)((char *)pg + page - 1 - start) / sz;
        if (k1 >= nblocks) k1 = nblocks - 1;
        empty = true;
        for (size_t k = k0; k <= k1 && empty; k++) empty = SCR_SA_BIT(k);
      }
      if (empty && !run) run = (char *)pg;
      if (!empty && run) {
        (void)madvise(run, (size_t)((char *)pg - run), MADV_DONTNEED);
        returned += (size_t)((char *)pg - run);
        /* Blocks wholly inside the returned pages leave the free list. */
        char *lo = start + ((size_t)(run - start) + sz - 1) / sz * sz;
        char *hi = start + ((size_t)((char *)pg - start) / sz) * sz;
        if (hi > lo && found) (void)found(ctx, lo, hi);
        for (char *q = lo; q < hi; q += sz) {
          size_t k = (size_t)(q - start) / sz;
          bits[k / 64] &= ~((uint64_t)1 << (k % 64));
        }
        /* A block starting in the returned pages but ending on a kept one is
         * dropped: relinking it would fault its page back in. */
        if (hi < (char *)pg && hi >= run) {
          size_t k = (size_t)(hi - start) / sz;
          bits[k / 64] &= ~((uint64_t)1 << (k % 64));
        }
        run = NULL;
      }
    }
#undef SCR_SA_BIT
  }
  return returned;
}
#endif

/* The next bump limit of class c in its chunk [k->start, end), whose limit
 * is lim (< end). A class's first SCR_SA_HUGE_AFTER bytes of chunks stay on
 * small pages, and every later chunk is advised huge pages when the class
 * opens it (scr_sa_open). Limits advance in steps: the pre-fault steps (see
 * above), or else the core-dump steps (SCR_SA_DUMP). */
#ifdef SCR_SA_TRIM
typedef struct ScrSaKeep ScrSaKeep;
static _Thread_local ScrSaKeep *scr_sa_keep; /* while the worker's memory is kept apart */
static void scr_sa_keep_opened(ScrSaKeep *k, const char *chunk);
#endif

#if defined(SCR_SA_THP) && defined(SCR_SA_PREFAULT)
/* Takes class c's next chunk ahead, when its current one is about to fill,
 * and has the helper fault its first pages: the first huge page where the
 * chunk will use huge pages, else the first pre-fault step. A worker that
 * keeps its memory apart takes its chunks when it needs them, since it
 * returns only the chunks it opened. */
static void scr_sa_take_ahead(unsigned c, ScrSaCarve *k) {
  if (k->next) return;
#ifdef SCR_SA_TRIM
  if (scr_sa_keep) return;
#endif
  char *chunk = scr_sa_class_chunk_take(c);
  if (!chunk) return;
  k->next = chunk;
  if (k->chunks + 1 > SCR_SA_HUGE_AFTER / SCR_SA_CHUNK) {
    (void)madvise(chunk, SCR_SA_CHUNK, MADV_HUGEPAGE);
    scr_sa_prefault_ahead(c, chunk, chunk + SCR_SA_HUGE_PAGE);
  } else if ((size_t)k->chunks * SCR_SA_CHUNK >= SCR_SA_PF_START) {
    scr_sa_prefault_ahead(c, chunk, chunk + SCR_SA_PF_STEP);
  }
}
#endif

static char *scr_sa_extend(unsigned c, ScrSaCarve *k, char *lim, char *end) {
  (void)c;
#ifdef SCR_SA_THP
  bool huge = k->chunks > SCR_SA_HUGE_AFTER / SCR_SA_CHUNK;
#ifdef SCR_SA_PREFAULT
  if (scr_sa_pf_on()) {
    if (!huge) {
      char *next = lim + SCR_SA_PF_STEP < end ? lim + SCR_SA_PF_STEP : end;
      scr_sa_pf_advance(c, lim, next);
      size_t carved = (size_t)(k->chunks - 1) * SCR_SA_CHUNK + (size_t)(next - k->start);
      if (carved >= SCR_SA_PF_START && next < end)
        scr_sa_prefault_ahead(c, next, next + SCR_SA_PF_STEP < end ? next + SCR_SA_PF_STEP : end);
      /* The last step of the chunk: fault the next one's start. */
      if (next == end) scr_sa_take_ahead(c, k);
      return next;
    }
    char *next = lim + SCR_SA_PF_HUGE_STEP < end ? lim + SCR_SA_PF_HUGE_STEP : end;
    scr_sa_pf_advance(c, lim, next);
    /* Entering the second half of a huge page: fault the next one, in the
     * next chunk at the end of this one. */
    if (((uintptr_t)next & (SCR_SA_HUGE_PAGE - 1)) == 0) {
      if (next < end) scr_sa_prefault_ahead(c, next, next + SCR_SA_HUGE_PAGE < end ? next + SCR_SA_HUGE_PAGE : end);
    } else if (next + SCR_SA_PF_HUGE_STEP >= end) {
      scr_sa_take_ahead(c, k);
    }
    return next;
  }
#endif
#ifdef SCR_SA_DUMP
  size_t step = huge ? SCR_SA_HUGE_PAGE : SCR_SA_DUMP_STEP;
  if ((size_t)(end - lim) > step) return lim + step;
#endif
#else
  (void)k;
#ifdef SCR_SA_DUMP
  if ((size_t)(end - lim) > SCR_SA_DUMP_STEP) return lim + SCR_SA_DUMP_STEP;
#else
  (void)lim;
#endif
#endif
  return end;
}

/* Class c of the calling thread's arena continues in `chunk`, a new one:
 * past the class's first SCR_SA_HUGE_AFTER bytes it is advised huge pages,
 * and its first huge page is faulted ahead, unless the chunk was taken ahead
 * (`ahead`), which did both already. */
static void scr_sa_open(unsigned c, ScrSaCarve *k, char *chunk, bool ahead) {
  (void)c;
  k->start = chunk;
  k->chunks++;
#ifdef SCR_SA_THP
  if (!ahead && k->chunks > SCR_SA_HUGE_AFTER / SCR_SA_CHUNK) {
    (void)madvise(chunk, SCR_SA_CHUNK, MADV_HUGEPAGE);
#ifdef SCR_SA_PREFAULT
    if (scr_sa_pf_on()) scr_sa_prefault_ahead(c, chunk, chunk + SCR_SA_HUGE_PAGE);
#endif
  }
#endif
#ifdef SCR_SA_TRIM
  if (scr_sa_keep) scr_sa_keep_opened(scr_sa_keep, chunk);
#endif
}


#ifdef SCR_WORKERS
#include <pthread.h>
#include <stdatomic.h>
#if defined(__linux__) && defined(MADV_DONTNEED)
#include <stdio.h>
#include <time.h>
#include <unistd.h>
#if defined(__GLIBC__)
#include <malloc.h>
#endif
#endif

/* Per-thread arenas (contract in scr_runtime.h): arena i is the chunks of
 * the window whose table entry carries tag i + 1. */
static _Atomic(uint32_t) scr_sa_claimed;              /* one bit per arena */
static ScrSaState scr_sa_parked[SCR_SA_ARENAS];         /* unowned arenas */
static _Atomic(ScrSaBlock *) scr_sa_remote[SCR_SA_ARENAS]; /* foreign frees */
static _Thread_local bool scr_sa_refused; /* this thread got no arena */
_Static_assert(SCR_SA_ARENAS <= 32, "one claim bit per arena");

#ifdef SCR_SA_TRIM
/* The arena's carved bytes when the current thread claimed it (see
 * scr_sa_trim). */
static size_t scr_sa_claim_carved[SCR_SA_ARENAS];
static size_t scr_sa_carved(void);
/* A worker thread's memory, discarded when it parks (see "Discarding a
 * worker's memory" below; ScrSaKeep and scr_sa_keep are declared above). */
static _Thread_local bool scr_sa_worker;    /* set by scr_sa_thread_starting */
static void scr_sa_keep_begin(unsigned i);
static void scr_sa_keep_drained(ScrSaKeep *k, ScrSaBlock *b, unsigned c);
static void scr_sa_keep_drained_large(ScrSaKeep *k, const ScrSaBlock *b);
static bool scr_sa_keep_remove(ScrSaKeep *k, const void *p);
static bool scr_sa_drain(void);
static bool scr_sa_drain_some(bool one);
#endif

/* Moves every block other threads freed into this arena's free lists. */
static void scr_sa_drain_remote(void) {
  ScrSaBlock *b = atomic_exchange_explicit(&scr_sa_remote[scr_sa_arena], NULL, memory_order_acquire);
  while (b) {
    ScrSaBlock *next = b->next;
    unsigned e = scr_sa_chunks[((uintptr_t)b - scr_sa.base) >> SCR_SA_CHUNK_SHIFT], c = e & 0xff;
    if (e & SCR_SA_LARGE_TAG) {
#ifdef SCR_SA_TRIM
      if (scr_sa_keep) scr_sa_keep_drained_large(scr_sa_keep, b);
#endif
      scr_sa_large_push((unsigned)scr_sa_arena, b, c);
      b = next;
      continue;
    }
#ifdef SCR_SA_TRIM
    if (scr_sa_keep) {
      scr_sa_keep_drained(scr_sa_keep, b, c);
      b = next;
      continue;
    }
#endif
    b->next = scr_sa.free[c];
    scr_sa.free[c] = b;
    b = next;
  }
}

/* Claims an arena for the calling thread: a parked one continues with its
 * free lists and bump pointers, a fresh one starts empty. */
static bool scr_sa_reserve(void) {
  if (!scr_sa_window_reserve()) {
    scr_sa_refused = true;
    return false;
  }
  uint32_t claimed = atomic_load_explicit(&scr_sa_claimed, memory_order_relaxed);
  for (;;) {
    if (claimed == UINT32_MAX) {
#ifdef SCR_SA_TRIM
      /* Arenas held by discards that wait (see scr_sa_thread_park): this
       * thread discards one of them and claims it. */
      if (scr_sa_drain_some(true)) {
        scr_sa_refused = false;
        claimed = atomic_load_explicit(&scr_sa_claimed, memory_order_relaxed);
        continue;
      }
#endif
      scr_sa_refused = true;
      return false;
    }
    unsigned i = (unsigned)__builtin_ctz(~claimed);
    if (atomic_compare_exchange_weak_explicit(&scr_sa_claimed, &claimed, claimed | (1u << i),
                                              memory_order_acquire, memory_order_relaxed)) {
      scr_sa_arena = (int)i;
      scr_sa = scr_sa_parked[i];
      if (!scr_sa.span) {
        scr_sa_clear();
        scr_sa.base = (uintptr_t)scr_sa_window;
        scr_sa.span = (uintptr_t)scr_sa_window_chunks << SCR_SA_CHUNK_SHIFT;
        scr_sa.tag = (i + 1) << 8;
      }
      scr_sa_drain_remote();
#ifdef SCR_SA_TRIM
      scr_sa_claim_carved[i] = scr_sa_carved();
      if (scr_sa_worker) scr_sa_keep_begin(i);
#endif
      return true;
    }
  }
}

#ifdef SCR_SA_TRIM
/* Returning an exited thread's free memory (Linux). When a script thread
 * exits, every page of its arena that holds only free blocks goes back to
 * the system (MADV_DONTNEED, after which it reads as zero), so other
 * threads can use that memory while the arena is parked. The free blocks on
 * the kept pages are relinked in address order; the returned runs of pages
 * become zeroed carve regions (`ScrSaHoles`), which the next thread to claim
 * the arena carves before the class's own frontier: the bump fast paths
 * already rely on carved memory being zero. A thread that carved less than
 * SCR_SA_TRIM_MIN, or whose arena holds less than that in free blocks,
 * leaves the arena as it is. */
#define SCR_SA_TRIM_MIN ((size_t)16 << 20)
typedef struct {
  char *lo, *hi;
} ScrSaRun;
typedef struct {
  ScrSaRun *runs; /* zeroed regions left to carve, carved from the end */
  size_t n, cap;
  char *bump, *lim; /* the frontier while a region is carved (lim != NULL) */
} ScrSaHoles;
static ScrSaHoles scr_sa_holes[SCR_SA_ARENAS][SCR_SA_NCLASS];

/* Bytes carved from the calling thread's chunks: up to each frontier. */
static size_t scr_sa_carved(void) {
  size_t carved = 0;
  for (unsigned c = 0; c < SCR_SA_NCLASS; c++) {
    if (!scr_sa.lim[c]) continue;
    const ScrSaHoles *h = &scr_sa_holes[scr_sa_arena][c];
    carved += scr_sa_class_carved(c, h->lim ? h->bump : scr_sa.bump[c]);
  }
  return carved + scr_sa_large[scr_sa_arena].carved;
}

/* For the slow path of class c, whose bump room is below sz: moves the
 * bump pointer to the next zeroed region, or back to the frontier. */
static void scr_sa_next_hole(unsigned c, size_t sz) {
  ScrSaHoles *h = &scr_sa_holes[scr_sa_arena][c];
  if ((size_t)(scr_sa.lim[c] - scr_sa.bump[c]) >= sz || (!h->n && !h->lim)) return;
  if (h->n) {
    if (!h->lim) {
      h->bump = scr_sa.bump[c];
      h->lim = scr_sa.lim[c];
    }
    ScrSaRun r = h->runs[--h->n];
    scr_sa.bump[c] = r.lo;
    scr_sa.lim[c] = r.hi;
  } else {
    scr_sa.bump[c] = h->bump;
    scr_sa.lim[c] = h->lim;
    h->bump = h->lim = NULL;
  }
}

static bool scr_sa_push_run(ScrSaHoles *h, char *lo, char *hi) {
  if (h->n == h->cap) {
    size_t cap = h->cap ? 2 * h->cap : 64;
    ScrSaRun *runs = realloc(h->runs, cap * sizeof *runs);
    if (!runs) return false;
    h->runs = runs;
    h->cap = cap;
  }
  h->runs[h->n++] = (ScrSaRun){lo, hi};
  return true;
}

/* With SCR_SA_STATS=1: carved, free and returned bytes of the parking thread. */
static _Thread_local size_t scr_sa_trim_stats[3];

static bool scr_sa_hole_found(void *ctx, char *lo, char *hi) {
  return scr_sa_push_run((ScrSaHoles *)ctx, lo, hi);
}

/* Returns the pages of class c that hold only free blocks (see above). */
static void scr_sa_trim_class(unsigned c, size_t page) {
  ScrSaHoles *h = &scr_sa_holes[scr_sa_arena][c];
  size_t sz = scr_sa_class_size(c);
  /* Close the region being carved: its rest is still zero. */
  if (h->lim) {
    char *lo = scr_sa.bump[c], *hi = scr_sa.lim[c];
    scr_sa.bump[c] = h->bump;
    scr_sa.lim[c] = h->lim;
    h->bump = h->lim = NULL;
    if ((size_t)(hi - lo) >= sz && !scr_sa_push_run(h, lo, hi)) return;
  }
  char *top = scr_sa.bump[c];
  if (!scr_sa_class_carved(c, top)) return;
  ScrSaMarks m;
  if (!scr_sa_marks_open(&m, c)) return;
  size_t nfree = 0;
  uint64_t mask;
  for (ScrSaBlock *b = scr_sa.free[c]; b; b = b->next) {
    uint64_t *word = scr_sa_mark(&m, b, sz, &mask);
    if (word) *word |= mask;
    nfree++;
  }
  /* Uncarved zeroed regions count as free; they are rebuilt below. */
  for (size_t r = 0; r < h->n; r++) {
    for (char *q = h->runs[r].lo; q + sz <= h->runs[r].hi; q += sz) {
      uint64_t *word = scr_sa_mark(&m, q, sz, &mask);
      if (word) *word |= mask;
    }
  }
  scr_sa_trim_stats[0] += scr_sa_class_carved(c, top);
  scr_sa_trim_stats[1] += nfree * sz;
  h->n = 0;
  scr_sa_trim_stats[2] += scr_sa_marks_return(&m, c, top, page, scr_sa_hole_found, h);
  /* The remaining free blocks, in address order. */
  scr_sa_marks_relink(&m, c);
  scr_sa_marks_close(&m);
  /* The next owner carves the returned regions before the frontier. */
  if (h->n) {
    h->bump = scr_sa.bump[c];
    h->lim = scr_sa.lim[c];
    ScrSaRun r = h->runs[--h->n];
    scr_sa.bump[c] = r.lo;
    scr_sa.lim[c] = r.hi;
  }
}

/* Whether the calling thread carved at least SCR_SA_TRIM_MIN since it
 * claimed its arena: a short-lived thread reusing the arena's free blocks
 * leaves them for the next one. */
static bool scr_sa_trim_worth(void) {
  return scr_sa_carved() - scr_sa_claim_carved[scr_sa_arena] >= SCR_SA_TRIM_MIN;
}

/* Returns the free pages of the calling thread's arena (see above). */
static void scr_sa_trim(void) {
  scr_sa_drain_remote();
  size_t free_bytes = 0;
  for (unsigned c = 0; c < SCR_SA_NCLASS; c++) {
    size_t n = 0, sz = scr_sa_class_size(c);
    for (ScrSaBlock *b = scr_sa.free[c]; b && n * sz < SCR_SA_TRIM_MIN; b = b->next) n++;
    free_bytes += n * sz;
    if (free_bytes >= SCR_SA_TRIM_MIN) break;
  }
  for (unsigned c = 0; c < SCR_SA_NLARGE && free_bytes < SCR_SA_TRIM_MIN; c++)
    for (ScrSaBlock *b = scr_sa_large[scr_sa_arena].free[c]; b && free_bytes < SCR_SA_TRIM_MIN; b = b->next)
      free_bytes += scr_sa_large_size(c);
  const char *stats = getenv("SCR_SA_STATS");
  const char *off = getenv("SCR_SA_TRIM");
  bool trim = free_bytes >= SCR_SA_TRIM_MIN && !(off && off[0] == '0');
  memset(scr_sa_trim_stats, 0, sizeof scr_sa_trim_stats);
  if (!trim && stats && stats[0] == '1')
    for (unsigned c = 0; c < SCR_SA_NCLASS; c++) {
      if (!scr_sa.lim[c]) continue;
      size_t sz = scr_sa_class_size(c);
      scr_sa_trim_stats[0] += scr_sa_class_carved(c, scr_sa.bump[c]);
      for (ScrSaBlock *b = scr_sa.free[c]; b; b = b->next) scr_sa_trim_stats[1] += sz;
    }
  if (trim) {
    long page = sysconf(_SC_PAGESIZE);
    for (unsigned c = 0; c < SCR_SA_NCLASS; c++)
      if (scr_sa.lim[c]) scr_sa_trim_class(c, page > 0 ? (size_t)page : 4096);
  }
  /* Large blocks: the window's and the system allocator's free pages too. */
  if (trim) scr_sa_large_trim();
#if defined(__GLIBC__)
  if (trim) (void)malloc_trim(0);
#endif
  if (stats && stats[0] == '1')
    fprintf(stderr, "scr_sa: park arena %d trim %d carved %zu MB free %zu MB returned %zu MB\n",
            scr_sa_arena, (int)trim, scr_sa_trim_stats[0] >> 20, scr_sa_trim_stats[1] >> 20,
            scr_sa_trim_stats[2] >> 20);
}

/* Discarding a worker's memory (Linux). Script objects stay on the thread
 * that allocated them: other threads reach one only through a message or an
 * intern table that shares a published (immortal) graph by pointer, or a
 * process-wide immortal cache, and each of those calls
 * scr_sa_thread_shares. Runtime state that outlives a thread (messages,
 * mailboxes, shared bytes, intern table entries) comes from the system
 * allocator directly. So when a worker thread parks without having shared,
 * nothing it allocated through scr_mem_* can be reachable from another
 * thread, and what it never freed (ProgramLifetime instances, published
 * module constants) is garbage. Such a thread's memory goes back whole:
 * - when a worker claims an arena, the arena's free lists and returned
 *   regions are set aside, and the worker carves only past each class's
 *   frontier, so its blocks of class c are [start[c], bump[c]), plus the
 *   blocks it takes from the free lists set aside once a class has no bump
 *   room left, which it records;
 * - the system blocks it allocates (large blocks, an exhausted window) are
 *   recorded until it frees them;
 * - a remote free into its blocks means another thread held one: the same
 *   as sharing;
 * - when it parks without having shared, its arena stays claimed until no
 *   other worker thread is running (scr_sa_thread_park): returning pages
 *   interrupts every running thread of the process to flush its TLB, and
 *   glibc's trim locks the arenas other threads allocate from, so discards
 *   wait for the last worker of a group, which hands them to one helper;
 * - the helper waits a delay (scr_sa_discard_delay_ms: 1 s to start,
 *   doubled each time workers start again soon after a discard) and stops if
 *   a worker started meanwhile: a program that starts its next workers or
 *   exits within that time does not return pages it would fault back in or
 *   never touch again, and the last worker of the next group hands the
 *   discards to a new helper; a thread that finds every arena claimed
 *   discards one waiting arena and claims it;
 * - once the event loop of the thread that is not a worker runs, the
 *   helper then discards one arena at a time, and only while that loop
 *   waits with nothing ready (scr_sa_loop_waiting): a program that does
 *   its next work on that thread alone (a compiler rebuilding one file in
 *   watch mode) would otherwise have it slowed by the discards. A loop that
 *   does not wait gets them SCR_SA_DISCARD_DELAY_MAX_MS after the delay;
 * - the helper then returns the pages
 *   it carved (MADV_DONTNEED; the start of the first page, which it may
 *   share with older blocks, is cleared), frees the recorded system blocks,
 *   and parks the arena as the worker found it, with the blocks it took
 *   free again. A worker that shared parks
 *   its arena with the blocks set aside added to its free lists, and the
 *   ordinary trim applies.
 * SCR_SA_DISCARD=0 keeps every worker's memory. SCR_SA_DISCARD=poison makes
 * the carved pages inaccessible instead, and keeps the system blocks, so
 * that a reference to discarded memory faults (a check for tests). */
#define SCR_SA_SYS_GONE ((void *)1) /* a removed entry of ScrSaKeep.sys */

struct ScrSaKeep {
  /* The arena as the worker claimed it: free lists (to which remote frees
   * of older blocks are added), carve cursors and returned regions. */
  ScrSaBlock *free[SCR_SA_NCLASS];
  char *bump[SCR_SA_NCLASS], *lim[SCR_SA_NCLASS];
  ScrSaHoles holes[SCR_SA_NCLASS];
  /* Each class's frontier then (bump and limit, NULL limits for a class not
   * opened yet), the first address the worker carves in that chunk (NULL
   * for a class not opened), and the class's chunks then. */
  char *front_bump[SCR_SA_NCLASS], *front_lim[SCR_SA_NCLASS];
  char *start[SCR_SA_NCLASS];
  ScrSaCarve carve[SCR_SA_NCLASS];
  /* The chunks the worker opened, by window index. */
  uint64_t mine[(SCR_SA_WINDOW_CHUNKS + 63) / 64];
  /* The worker's system blocks: an open-addressing set of `cap` slots (a
   * power of two, or 0), NULL for an empty slot and SCR_SA_SYS_GONE for a
   * removed entry; `used` counts both kinds of filled slots. */
  void **sys;
  size_t cap, used, live;
  /* The blocks of the free lists set aside that the worker took once a class
   * had no bump room left, so that older free blocks are used before the
   * class grows; they go back to those lists with the worker's memory. */
  ScrSaBlock **taken;
  size_t ntaken, cap_taken;
  bool shared;
  bool poison;
};

/* Records a chunk the worker opened. */
static void scr_sa_keep_opened(ScrSaKeep *k, const char *chunk) {
  size_t i = (size_t)(chunk - scr_sa_window) >> SCR_SA_CHUNK_SHIFT;
  k->mine[i / 64] |= (uint64_t)1 << (i % 64);
}

static _Thread_local bool scr_sa_discarded; /* this thread's memory went back */
static ScrSaKeep *scr_sa_parked_keep[SCR_SA_ARENAS]; /* of discards that wait */

/* SCR_SA_DISCARD: 0 off, 1 on (the default), 2 poison. */
static int scr_sa_discard_mode(void) {
  const char *mode = getenv("SCR_SA_DISCARD");
  if (!mode) return 1;
  if (strcmp(mode, "0") == 0) return 0;
  return strcmp(mode, "poison") == 0 ? 2 : 1;
}

static void scr_sa_keep_begin(unsigned i) {
  int mode = scr_sa_discard_mode();
  if (!mode) return;
  ScrSaKeep *k = calloc(1, sizeof *k);
  if (!k) return;
  k->poison = mode == 2;
  for (unsigned c = 0; c < SCR_SA_NCLASS; c++) {
    ScrSaHoles *h = &scr_sa_holes[i][c];
    k->free[c] = scr_sa.free[c];
    k->bump[c] = scr_sa.bump[c];
    k->lim[c] = scr_sa.lim[c];
    k->holes[c] = *h;
    memset(h, 0, sizeof *h);
    scr_sa.free[c] = NULL;
    /* While the class carves a returned region, its frontier is kept apart. */
    if (k->holes[c].lim) {
      scr_sa.bump[c] = k->holes[c].bump;
      scr_sa.lim[c] = k->holes[c].lim;
    }
    k->front_bump[c] = scr_sa.bump[c];
    k->front_lim[c] = scr_sa.lim[c];
    k->start[c] = scr_sa.lim[c] ? scr_sa.bump[c] : NULL;
    k->carve[c] = scr_sa_carve[i][c];
  }
  scr_sa_keep = k;
}

/* Whether block b of class c is one the worker carved: past the frontier it
 * found in that chunk, or in a chunk it opened. */
static bool scr_sa_keep_carved(const ScrSaKeep *k, const ScrSaBlock *b, unsigned c) {
  size_t i = (size_t)((const char *)b - scr_sa_window) >> SCR_SA_CHUNK_SHIFT;
  if ((k->mine[i / 64] >> (i % 64)) & 1) return true;
  const char *start = k->start[c];
  return start && scr_sa_chunk_of(start - 1) == scr_sa_chunk_of(b) && (const char *)b >= start;
}

/* A remote free of class c, drained while the worker keeps its memory
 * apart: one of its own blocks makes it share; an older block goes to the
 * free lists set aside. Once the worker has taken blocks from those lists,
 * any older block might be one of them, so it shares as well. */
static void scr_sa_keep_drained(ScrSaKeep *k, ScrSaBlock *b, unsigned c) {
  if (scr_sa_keep_carved(k, b, c)) {
    k->shared = true;
    b->next = scr_sa.free[c];
    scr_sa.free[c] = b;
  } else {
    if (k->ntaken) k->shared = true;
    b->next = k->free[c];
    k->free[c] = b;
  }
}

/* A remote free of a large block, drained while the worker keeps its memory
 * apart: one the worker recorded (scr_sa_slow_ref) makes it share. */
static void scr_sa_keep_drained_large(ScrSaKeep *k, const ScrSaBlock *b) {
  if (scr_sa_keep_remove(k, b)) k->shared = true;
}

/* A block of class c from the free lists set aside, for a worker whose
 * class has no bump room left; NULL when there is none or it cannot be
 * recorded. */
static ScrSaBlock *scr_sa_keep_take(ScrSaKeep *k, unsigned c) {
  ScrSaBlock *b = k->free[c];
  if (!b) return NULL;
  if (k->ntaken == k->cap_taken) {
    size_t cap = k->cap_taken ? 2 * k->cap_taken : 256;
    ScrSaBlock **taken = realloc(k->taken, cap * sizeof *taken);
    if (!taken) return NULL;
    k->taken = taken;
    k->cap_taken = cap;
  }
  k->free[c] = b->next;
  k->taken[k->ntaken++] = b;
  return b;
}

static size_t scr_sa_sys_slot(const void *p, size_t cap) {
  return (size_t)((((uint64_t)(uintptr_t)p >> 4) * UINT64_C(0x9E3779B97F4A7C15)) >> 32) & (cap - 1);
}

/* Records system block p. A worker whose set cannot grow keeps its memory. */
static void scr_sa_keep_add(ScrSaKeep *k, void *p) {
  if ((k->used + 1) * 2 > k->cap) {
    size_t cap = 64;
    while (cap < (k->live + 1) * 4) cap *= 2;
    void **sys = calloc(cap, sizeof *sys);
    if (!sys) {
      k->shared = true;
      return;
    }
    for (size_t s = 0; s < k->cap; s++) {
      void *q = k->sys[s];
      if (!q || q == SCR_SA_SYS_GONE) continue;
      size_t j = scr_sa_sys_slot(q, cap);
      while (sys[j]) j = (j + 1) & (cap - 1);
      sys[j] = q;
    }
    free(k->sys);
    k->sys = sys;
    k->cap = cap;
    k->used = k->live;
  }
  size_t j = scr_sa_sys_slot(p, k->cap);
  while (k->sys[j] && k->sys[j] != SCR_SA_SYS_GONE) j = (j + 1) & (k->cap - 1);
  if (!k->sys[j]) k->used++;
  k->sys[j] = p;
  k->live++;
}

/* Forgets system block p; whether it was recorded. */
static bool scr_sa_keep_remove(ScrSaKeep *k, const void *p) {
  if (!k->live) return false;
  for (size_t j = scr_sa_sys_slot(p, k->cap); k->sys[j]; j = (j + 1) & (k->cap - 1)) {
    if (k->sys[j] != p) continue;
    k->sys[j] = SCR_SA_SYS_GONE;
    k->live--;
    return true;
  }
  return false;
}

/* The calling thread's arena keeps the worker's memory (it shared): the
 * free lists set aside go back, followed by the worker's own free blocks,
 * and so do the returned regions, past which the worker carved. */
static void scr_sa_keep_merge(ScrSaKeep *k) {
  for (unsigned c = 0; c < SCR_SA_NCLASS; c++) {
    ScrSaBlock *kept = k->free[c];
    if (kept) {
      ScrSaBlock *tail = kept;
      while (tail->next) tail = tail->next;
      tail->next = scr_sa.free[c];
      scr_sa.free[c] = kept;
    }
    ScrSaHoles *h = &scr_sa_holes[scr_sa_arena][c];
    *h = k->holes[c];
    if (h->lim) {
      h->bump = scr_sa.bump[c];
      h->lim = scr_sa.lim[c];
      scr_sa.bump[c] = k->bump[c];
      scr_sa.lim[c] = k->lim[c];
    }
  }
  free(k->sys);
  free(k->taken);
  free(k);
}

/* Returns the memory of the worker whose arena the calling thread (the
 * trim helper) holds, and restores the arena to its state at the worker's
 * claim; with poison, makes the pages inaccessible and moves the frontier
 * past them instead. */
static void scr_sa_discard(ScrSaKeep *k) {
  /* Remote frees since the worker's last drain. */
  scr_sa_keep = k;
  scr_sa_drain_remote();
  scr_sa_keep = NULL;
  if (k->shared) {
    scr_sa_keep_merge(k);
    scr_sa_trim();
    return;
  }
  uintptr_t page = (uintptr_t)sysconf(_SC_PAGESIZE);
  if (page == 0 || page == (uintptr_t)-1) page = 4096;
  size_t returned = 0, sys_bytes = 0, sys_blocks = 0;
  for (unsigned c = 0; c < SCR_SA_NCLASS; c++) {
    char *lo = k->start[c], *top = scr_sa.bump[c], *lim = scr_sa.lim[c];
    char *bump = k->front_bump[c], *limit = k->front_lim[c];
    ScrSaCarve *carve = &scr_sa_carve[scr_sa_arena][c];
    /* The chunks the worker opened for the class go back whole, the highest
     * first, so that they are taken again in address order. */
    unsigned owner = scr_sa.tag | c;
    bool opened = false;
    for (size_t w = sizeof k->mine / sizeof k->mine[0]; w-- > 0;)
      for (uint64_t x = k->mine[w]; x;) {
        unsigned bit = 63 - (unsigned)__builtin_clzll(x);
        x &= ~((uint64_t)1 << bit);
        size_t i = w * 64 + bit;
        if (scr_sa_chunks[i] != owner) continue;
        char *chunk = scr_sa_window + (i << SCR_SA_CHUNK_SHIFT);
        opened = true;
        if (k->poison) {
          (void)mprotect(chunk, SCR_SA_CHUNK, PROT_NONE);
          scr_sa_chunk_set(i, 0);
        } else {
          scr_mem_release_ahead(chunk, chunk + SCR_SA_CHUNK);
          returned += SCR_SA_CHUNK;
          scr_sa_chunk_give(chunk);
        }
      }
    /* In the chunk that held the frontier the worker found, what it carved
     * past that frontier. */
    char *fend = lo ? scr_sa_chunk_of(lo - 1) + SCR_SA_CHUNK : NULL;
    char *ftop = opened ? fend : top;
    if (lo && lim && ftop > lo) {
      char *first = (char *)(((uintptr_t)lo + page - 1) & ~(page - 1));
      char *used = (char *)(((uintptr_t)ftop + page - 1) & ~(page - 1));
      /* The part of a page that may also hold older blocks. */
      if (first > lo) memset(lo, 0, (size_t)((first < ftop ? first : ftop) - lo));
      if (k->poison) {
        if (used > first) (void)mprotect(first, (size_t)(used - first), PROT_NONE);
        bump = used > first ? used : ftop;
        if (bump > fend) bump = fend;
        limit = !opened && lim > bump ? lim : bump;
      } else {
        char *end = opened ? fend : (char *)(((uintptr_t)lim + page - 1) & ~(page - 1));
        if (end > fend) end = fend;
        if (end > first) {
          (void)madvise(first, (size_t)(end - first), MADV_DONTNEED);
          returned += (size_t)(end - first);
        }
      }
    } else if (!opened) {
      bump = top;
      limit = lim;
    }
    *carve = k->carve[c];
    scr_sa.free[c] = k->free[c];
    ScrSaHoles *h = &scr_sa_holes[scr_sa_arena][c];
    *h = k->holes[c];
    if (h->lim) {
      h->bump = bump;
      h->lim = limit;
      scr_sa.bump[c] = k->bump[c];
      scr_sa.lim[c] = k->lim[c];
    } else {
      scr_sa.bump[c] = bump;
      scr_sa.lim[c] = limit;
    }
  }
  /* The older free blocks the worker took are free again. */
  if (!k->poison)
    for (size_t t = 0; t < k->ntaken; t++) {
      ScrSaBlock *b = k->taken[t];
      unsigned c = scr_sa_chunks[((uintptr_t)b - scr_sa.base) >> SCR_SA_CHUNK_SHIFT] & 0xff;
      b->next = scr_sa.free[c];
      scr_sa.free[c] = b;
    }
  if (!k->poison)
    for (size_t s = 0; s < k->cap; s++) {
      void *p = k->sys[s];
      if (!p || p == SCR_SA_SYS_GONE) continue;
      uintptr_t off = (uintptr_t)p - (uintptr_t)scr_sa_window;
      if (off < (uintptr_t)scr_sa_window_chunks << SCR_SA_CHUNK_SHIFT) {
        /* A window block: a run goes back to the window; a block of a large
         * class becomes a trimmed free block of the arena. */
        unsigned e = scr_sa_chunks[off >> SCR_SA_CHUNK_SHIFT];
        if (e == SCR_SA_RUN_HEAD) {
          returned += scr_sa_large_bytes(p, e);
          scr_sa_run_free(p);
        } else if ((e & SCR_SA_LARGE_TAG) && e < SCR_SA_RUN_HEAD) {
          unsigned c = e & 0xff;
          size_t sz = scr_sa_large_size(c);
          char *lo = (char *)(((uintptr_t)p + page) & ~(page - 1)), *hi = (char *)(((uintptr_t)p + sz) & ~(page - 1));
          ScrSaLarge *l = &scr_sa_large[scr_sa_arena];
          ScrSaBlock *b = p;
          if (hi > lo) {
            scr_sa_pages_return(lo, hi);
            returned += (size_t)(hi - lo);
            b->next = l->trimmed[c];
            l->trimmed[c] = b;
          } else {
            b->next = l->free[c];
            l->free[c] = b;
          }
        }
        continue;
      }
#if defined(__GLIBC__)
      sys_bytes += malloc_usable_size(p);
#endif
      sys_blocks++;
      free(p);
    }
#if defined(__GLIBC__)
  if (sys_blocks) (void)malloc_trim(0);
#endif
  const char *stats = getenv("SCR_SA_STATS");
  if (stats && stats[0] == '1')
    fprintf(stderr, "scr_sa: discard arena %d returned %zu MB, %zu system blocks (%zu MB)\n", scr_sa_arena,
            returned >> 20, sys_blocks, sys_bytes >> 20);
  free(k->sys);
  free(k->taken);
  free(k);
}

/* Hooks of the allocator's system paths and of sharing (scr_rc.h). */
static void scr_sa_keep_note_system(void *p) {
  if (p && scr_sa_keep) scr_sa_keep_add(scr_sa_keep, p);
}

void scr_sa_thread_shares(void) {
  if (scr_sa_keep) scr_sa_keep->shared = true;
}

/* Worker threads that started and have not parked. */
static _Atomic(unsigned) scr_sa_workers_live;

#ifdef SCR_SA_TRIM
static void scr_sa_group_starting(void);
#endif

/* Library archives run on their embedder's threads and keep their memory. */
static void scr_sa_worker_starting(void) {
#ifndef SCR_LIB
  scr_sa_worker = true;
#ifdef SCR_SA_TRIM
  if (atomic_fetch_add_explicit(&scr_sa_workers_live, 1, memory_order_relaxed) == 0) scr_sa_group_starting();
#else
  atomic_fetch_add_explicit(&scr_sa_workers_live, 1, memory_order_relaxed);
#endif
#endif
}
#define SCR_SA_WORKER_STARTING() scr_sa_worker_starting()
#endif

#ifdef SCR_SA_TRIM
/* Trims run on a detached helper thread: the parent of a worker joins it
 * when it handles the worker's exit, which must not wait for the trim (at
 * the end of a program every worker exits at once, and the process ends
 * right after). The helper takes over the exiting thread's claim on the
 * arena, so no thread claims it during the trim. */
static _Atomic(unsigned) scr_sa_trimming; /* helpers running */

static void scr_sa_release(unsigned i) {
  scr_sa_parked[i] = scr_sa;
  scr_sa_clear();
  scr_sa_arena = -1;
  scr_sa_refused = true;
  atomic_fetch_and_explicit(&scr_sa_claimed, ~(1u << i), memory_order_release);
}

static void *scr_sa_trim_main(void *arg) {
  unsigned i = (unsigned)(uintptr_t)arg;
  scr_sa_arena = (int)i;
  scr_sa = scr_sa_parked[i];
  scr_sa_trim();
  scr_sa_release(i);
  atomic_fetch_sub_explicit(&scr_sa_trimming, 1, memory_order_release);
  return NULL;
}

/* Hands the calling thread's arena to a trim helper; false if no helper
 * could start. */
static bool scr_sa_start_helper(unsigned i) {
  scr_sa_parked[i] = scr_sa;
  atomic_fetch_add_explicit(&scr_sa_trimming, 1, memory_order_relaxed);
  pthread_attr_t attr;
  pthread_t helper;
  bool started = pthread_attr_init(&attr) == 0;
  if (started) {
    started = pthread_attr_setdetachstate(&attr, PTHREAD_CREATE_DETACHED) == 0 &&
              pthread_create(&helper, &attr, scr_sa_trim_main, (void *)(uintptr_t)i) == 0;
    pthread_attr_destroy(&attr);
  }
  if (!started) atomic_fetch_sub_explicit(&scr_sa_trimming, 1, memory_order_relaxed);
  return started;
}

/* Discards that wait for the last running worker: one bit per arena, whose
 * state and ScrSaKeep are in scr_sa_parked and scr_sa_parked_keep. */
static pthread_mutex_t scr_sa_pending_lock = PTHREAD_MUTEX_INITIALIZER;
static uint32_t scr_sa_pending;

/* Queues the discard of the calling worker's arena i; the arena stays
 * claimed until it is done. */
static void scr_sa_defer_discard(unsigned i, ScrSaKeep *k) {
  atomic_fetch_add_explicit(&scr_sa_trimming, 1, memory_order_relaxed);
  pthread_mutex_lock(&scr_sa_pending_lock);
  scr_sa_parked[i] = scr_sa;
  scr_sa_parked_keep[i] = k;
  scr_sa_pending |= 1u << i;
  pthread_mutex_unlock(&scr_sa_pending_lock);
}

/* Runs the waiting discards on the calling thread, which ends with no arena:
 * all of them, or only the first one when `one` is set; returns whether
 * there were any. */
static bool scr_sa_drain_some(bool one) {
  bool any = false;
  for (;;) {
    if (one && any) return true;
    pthread_mutex_lock(&scr_sa_pending_lock);
    uint32_t pending = scr_sa_pending;
    unsigned i = pending ? (unsigned)__builtin_ctz(pending) : 0;
    scr_sa_pending &= ~(1u << i);
    pthread_mutex_unlock(&scr_sa_pending_lock);
    if (!pending) return any;
    any = true;
    scr_sa_arena = (int)i;
    scr_sa = scr_sa_parked[i];
    ScrSaKeep *k = scr_sa_parked_keep[i];
    scr_sa_parked_keep[i] = NULL;
    scr_sa_discard(k);
    scr_sa_release(i);
    atomic_fetch_sub_explicit(&scr_sa_trimming, 1, memory_order_release);
  }
}

static bool scr_sa_drain(void) { return scr_sa_drain_some(false); }

/* How long the trim helper waits after the last worker parks before it
 * returns their memory: SCR_SA_DISCARD_DELAY_MS (1000 by default) to start.
 * Each time workers start again within ten delays of a discard, the delay
 * doubles, up to SCR_SA_DISCARD_DELAY_MAX_MS (10000 by default): a program
 * that keeps starting workers (a compiler rebuilding in watch mode, a
 * server) would fault the returned pages straight back in. Memory that
 * stays idle for the grown delay still goes back. */
static _Atomic(long) scr_sa_delay_grown_ms; /* 0 until a discard proved too early */
static _Atomic(long) scr_sa_discarded_ms;   /* when the helper last discarded; 0: not since */

static long scr_sa_env_ms(const char *name, long fallback) {
  const char *value = getenv(name);
  if (!value) return fallback;
  long ms = strtol(value, NULL, 10);
  return ms < 0 ? 0 : ms;
}

static long scr_sa_discard_delay_ms(void) {
  long start = scr_sa_env_ms("SCR_SA_DISCARD_DELAY_MS", 1000);
  long max = scr_sa_env_ms("SCR_SA_DISCARD_DELAY_MAX_MS", 10000);
  long grown = atomic_load_explicit(&scr_sa_delay_grown_ms, memory_order_relaxed);
  long delay = grown > start ? grown : start;
  return max >= start && delay > max ? max : delay;
}

static long scr_sa_now_ms(void) {
  struct timespec now;
  clock_gettime(CLOCK_MONOTONIC, &now);
  return (long)now.tv_sec * 1000 + now.tv_nsec / 1000000 + 1;
}

/* The first worker of a group starts: a discard shortly before means the
 * delay was too short for this program. */
static void scr_sa_group_starting(void) {
  long at = atomic_exchange_explicit(&scr_sa_discarded_ms, 0, memory_order_relaxed);
  if (!at) return;
  long delay = scr_sa_discard_delay_ms();
  if (scr_sa_now_ms() - at >= 10 * (delay > 10 ? delay : 10)) return;
  long max = scr_sa_env_ms("SCR_SA_DISCARD_DELAY_MAX_MS", 10000);
  long grown = delay > 0 ? 2 * delay : 1;
  if (grown > max) grown = max;
  if (grown > atomic_load_explicit(&scr_sa_delay_grown_ms, memory_order_relaxed))
    atomic_store_explicit(&scr_sa_delay_grown_ms, grown, memory_order_relaxed);
}

/* The event loop of the thread that is not a worker: an odd count while it
 * waits with nothing ready, an even one while it runs, 0 until it first
 * waits. Only that thread writes it. */
static _Atomic(unsigned long) scr_sa_loop_turns;

/* The carved bytes of the main thread's arena at its last idle trim. */
static size_t scr_sa_idle_carved;

/* The main thread returns its free pages when its loop waits with nothing
 * ready, as a parking thread does (scr_sa_trim), once it has carved at least
 * SCR_SA_TRIM_MIN more since its last trim: memory it freed (a large teardown
 * before it starts workers, say) then stops counting while the workers
 * allocate their own. Measuring the carved bytes costs one pass over the
 * classes; the trim itself only runs when the frontier has grown. */
static void scr_sa_idle_trim(void) {
  if (scr_sa_arena < 0) return;
  size_t carved = scr_sa_carved();
  if (carved - scr_sa_idle_carved < SCR_SA_TRIM_MIN) return;
  scr_sa_trim();
  scr_sa_idle_carved = scr_sa_carved();
}

void scr_sa_loop_waiting(bool waiting) {
  if (scr_sa_worker) return;
  unsigned long turns = atomic_load_explicit(&scr_sa_loop_turns, memory_order_relaxed);
  if ((bool)(turns & 1) != waiting) {
    atomic_store_explicit(&scr_sa_loop_turns, turns + 1, memory_order_relaxed);
    if (waiting) scr_sa_idle_trim();
  }
}

/* Waits out the delay first, and stops if a worker starts meanwhile: the
 * discards then wait for the last worker of that group. A program that exits
 * within the delay does not spend its last milliseconds returning pages, and
 * one that starts its next workers within it does not return pages while
 * they start. Once the event loop runs, each discard then waits until the
 * loop has been in one wait for a step, or until the maximum delay has
 * passed. */
static void *scr_sa_drain_main(void *arg) {
  (void)arg;
  long delay = scr_sa_discard_delay_ms(), step = delay > 200 ? 20 : 5;
  for (long left = delay; left > 0; left -= step) {
    struct timespec pause = {0, (left < step ? left : step) * 1000000L};
    nanosleep(&pause, NULL);
    if (atomic_load_explicit(&scr_sa_workers_live, memory_order_acquire) != 0) return NULL;
  }
  long max = scr_sa_env_ms("SCR_SA_DISCARD_DELAY_MAX_MS", 10000);
  unsigned long seen = 0;
  for (long waited = 0; atomic_load_explicit(&scr_sa_workers_live, memory_order_acquire) == 0;) {
    unsigned long turns = atomic_load_explicit(&scr_sa_loop_turns, memory_order_relaxed);
    if (turns == 0 || ((turns & 1) && turns == seen) || waited >= max) {
      if (!scr_sa_drain_some(true)) break;
      atomic_store_explicit(&scr_sa_discarded_ms, scr_sa_now_ms(), memory_order_relaxed);
      continue;
    }
    seen = turns;
    struct timespec pause = {0, step * 1000000L};
    nanosleep(&pause, NULL);
    waited += step;
  }
  return NULL;
}

/* A worker parked: the last one running starts the waiting discards. */
static void scr_sa_worker_parked(void) {
  if (atomic_fetch_sub_explicit(&scr_sa_workers_live, 1, memory_order_acq_rel) != 1) return;
  pthread_mutex_lock(&scr_sa_pending_lock);
  bool pending = scr_sa_pending != 0;
  pthread_mutex_unlock(&scr_sa_pending_lock);
  if (!pending) return;
  pthread_attr_t attr;
  pthread_t helper;
  bool started = pthread_attr_init(&attr) == 0;
  if (started) {
    started = pthread_attr_setdetachstate(&attr, PTHREAD_CREATE_DETACHED) == 0 &&
              pthread_create(&helper, &attr, scr_sa_drain_main, NULL) == 0;
    pthread_attr_destroy(&attr);
  }
  if (!started) scr_sa_drain();
}

void scr_sa_wait_trims(void) {
  while (atomic_load_explicit(&scr_sa_trimming, memory_order_acquire)) {
    struct timespec pause = {0, 1000000};
    nanosleep(&pause, NULL);
  }
}
#else
void scr_sa_wait_trims(void) {}
void scr_sa_thread_shares(void) {}
void scr_sa_loop_waiting(bool waiting) { (void)waiting; }
#endif

static void scr_sa_park_arena(void);

void scr_sa_thread_park(void) {
#ifdef SCR_SA_TRIM
  bool worker = scr_sa_worker;
  scr_sa_worker = false;
  scr_sa_park_arena();
  if (worker) scr_sa_worker_parked();
#else
  scr_sa_park_arena();
#endif
}

#if defined(SCR_SA_TRIM) && defined(MADV_DONTNEED)
/* Returns the pages past each class's frontier that a parking thread leaves
 * faulted in but never carved: the rest of the huge page the frontier is in
 * (huge pages fault in whole) and the steps faulted ahead of it. The
 * thread's objects stay where they are; the next thread to claim the arena
 * faults the pages in again as it carves, and they read as zero, as fresh
 * pages do. Until then, a program that does its remaining work on threads
 * that never claim the arena (parse threads ahead of a check on the main
 * thread) does not keep them. */
static void scr_sa_release_frontiers(void) {
  uintptr_t page = (uintptr_t)sysconf(_SC_PAGESIZE);
  if (page == 0 || page == (uintptr_t)-1) page = 4096;
#ifdef SCR_SA_THP
  const uintptr_t ahead = SCR_SA_HUGE_PAGE;
#else
  const uintptr_t ahead = page;
#endif
  for (unsigned c = 0; c < SCR_SA_NCLASS; c++) {
    if (!scr_sa.lim[c]) continue;
    const ScrSaHoles *h = &scr_sa_holes[scr_sa_arena][c];
    char *bump = h->lim ? h->bump : scr_sa.bump[c];
    char *lim = h->lim ? h->lim : scr_sa.lim[c];
    const ScrSaCarve *k = &scr_sa_carve[scr_sa_arena][c];
    if (!k->start) continue;
    char *end = k->start + SCR_SA_CHUNK;
    char *from = (char *)(((uintptr_t)bump + page - 1) & ~(page - 1));
    /* At most one step of `ahead` is faulted in past the limit. */
    char *to = (char *)((((uintptr_t)lim + ahead - 1) & ~(ahead - 1)) + ahead);
    if (to > end) to = end;
    if (to > from) scr_mem_release_ahead(from, to);
  }
}
#endif

static void scr_sa_park_arena(void) {
  if (scr_sa_arena < 0) return;
  unsigned i = (unsigned)scr_sa_arena;
#if defined(SCR_SA_PREFAULT) && defined(SCR_WORKERS)
  scr_sa_pf_park();
#endif
#ifdef SCR_SA_TRIM
  ScrSaKeep *k = scr_sa_keep;
  scr_sa_keep = NULL;
  if (k && !k->shared) {
    /* Nothing this thread allocated is reachable from another one: its
     * memory goes back once no other worker runs (scr_sa_worker_parked),
     * and later frees on this thread are dropped. */
    scr_sa_discarded = true;
    scr_sa_defer_discard(i, k);
    scr_sa_clear();
    scr_sa_arena = -1;
    scr_sa_refused = true;
    return;
  }
  if (k) scr_sa_keep_merge(k);
#ifdef MADV_DONTNEED
  scr_sa_release_frontiers();
#endif
  if (scr_sa_trim_worth()) {
    if (scr_sa_start_helper(i)) {
      /* Later frees on this thread take the foreign path into the arena's
       * remote list; the helper releases the claim. */
      scr_sa_clear();
      scr_sa_arena = -1;
      scr_sa_refused = true;
      return;
    }
    scr_sa_trim();
  }
#endif
  scr_sa_parked[i] = scr_sa;
  /* Later frees on this thread (thread-exit destructors) take the foreign
   * path into the parked arena's remote list. */
  scr_sa_clear();
  scr_sa_arena = -1;
  scr_sa_refused = true;
  atomic_fetch_and_explicit(&scr_sa_claimed, ~(1u << i), memory_order_release);
}

/* The class size of a block in another thread's arena, or 0 for one outside
 * the allocator's chunks (a system block). */
static size_t scr_sa_foreign_size(const void *p) {
  unsigned e = scr_sa_owner(p);
  if (e & SCR_SA_LARGE_TAG) return scr_sa_large_bytes(p, e);
  return e ? scr_sa_class_size(e & 0xff) : 0;
}

void scr_sa_free_foreign(void *p) {
#ifdef SCR_SA_TRIM
  if (scr_sa_discarded) return; /* the block went back with the thread's memory */
#endif
  char *w = __atomic_load_n(&scr_sa_window, __ATOMIC_ACQUIRE);
  uintptr_t off = (uintptr_t)p - (uintptr_t)w;
  if (w && off < (uintptr_t)scr_sa_window_chunks << SCR_SA_CHUNK_SHIFT) {
    unsigned e = scr_sa_chunks[off >> SCR_SA_CHUNK_SHIFT];
    /* A chunk without small blocks: the block went back with a discarded
     * worker's memory. */
    if (!e) return;
    if (e == SCR_SA_RUN_HEAD) {
#ifdef SCR_SA_TRIM
      if (scr_sa_keep) (void)scr_sa_keep_remove(scr_sa_keep, p);
#endif
      scr_sa_run_free(p);
      return;
    }
    unsigned i = ((e & ~SCR_SA_LARGE_TAG) >> 8) - 1;
    if ((e & SCR_SA_LARGE_TAG) && scr_sa.span && i == (unsigned)scr_sa_arena) {
#ifdef SCR_SA_TRIM
      if (scr_sa_keep) (void)scr_sa_keep_remove(scr_sa_keep, p);
#endif
      scr_sa_large_push(i, p, e & 0xff);
      return;
    }
    ScrSaBlock *b = p;
    ScrSaBlock *head = atomic_load_explicit(&scr_sa_remote[i], memory_order_relaxed);
    do b->next = head;
    while (!atomic_compare_exchange_weak_explicit(&scr_sa_remote[i], &head, b, memory_order_release,
                                                  memory_order_relaxed));
    return;
  }
#ifdef SCR_SA_TRIM
  if (scr_sa_keep) (void)scr_sa_keep_remove(scr_sa_keep, p);
#endif
  free(p);
}
#else
static bool scr_sa_refused;

/* The one arena: the window's chunks with tag 1. */
static bool scr_sa_reserve(void) {
  if (!scr_sa_window_reserve()) {
    scr_sa_refused = true;
    return false;
  }
  scr_sa.base = (uintptr_t)scr_sa_window;
  scr_sa.span = (uintptr_t)scr_sa_window_chunks << SCR_SA_CHUNK_SHIFT;
  scr_sa.tag = 1u << 8;
  return true;
}

void scr_sa_free_foreign(void *p) {
  /* Every chunk with small blocks is the arena's, so a block of the window
   * is not the system's: a large block or run, a small block the inline
   * free left here because the window lies above the chunk map's reach, or
   * a program-lifetime block (entry 0), which is never freed. */
  uintptr_t off = (uintptr_t)p - (uintptr_t)scr_sa_window;
  if (scr_sa_window && off < (uintptr_t)scr_sa_window_chunks << SCR_SA_CHUNK_SHIFT) {
    unsigned e = scr_sa_chunks[off >> SCR_SA_CHUNK_SHIFT];
    if (e == SCR_SA_RUN_HEAD) scr_sa_run_free(p);
    else if ((e & SCR_SA_LARGE_TAG) && e < SCR_SA_RUN_HEAD) scr_sa_large_push(0, p, e & 0xff);
    else if (e && (e & 0xff00) == scr_sa.tag) {
      ScrSaBlock *b = p;
      b->next = scr_sa.free[e & 0xff];
      scr_sa.free[e & 0xff] = b;
    }
    return;
  }
  free(p);
}
#endif /* SCR_WORKERS */

/* A program that stores references in 32-bit fields: every block a reference
 * names must lie in the window, since the field keeps address >> 3 in 32
 * bits. The compiler emits scr_sa_require_window at startup for a program
 * whose compact classes have a field holding an array, a map, a set or a
 * heap instance, before any thread allocates; worker contexts set it again
 * (atomically: one may start while another allocates). Plain programs keep
 * the system allocator's blocks past the window. */
static bool scr_sa_win_required;

void scr_sa_require_window(void) { __atomic_store_n(&scr_sa_win_required, true, __ATOMIC_RELAXED); }

static inline bool scr_sa_window_required(void) {
  return __atomic_load_n(&scr_sa_win_required, __ATOMIC_RELAXED);
}

/* The window has no room left (for a reference block, or for the region of
 * program-lifetime objects): ended as Node ends at its heap limit, with this
 * message and an abort. */
static _Noreturn void scr_sa_window_limit(void) {
  static const char message[] =
      "FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory\n";
  scr_trap(message);
}

/* Runs once per class (to reserve the window and open a chunk) and then only for
 * blocks the fast path does not serve. */
__attribute__((cold, noinline)) void *scr_sa_slow(size_t n, bool zero) {
  if (n - 1 < SCR_SA_MAX && (scr_sa.span || (!scr_sa_refused && scr_sa_reserve()))) {
    unsigned c = scr_sa_class(n);
#ifdef SCR_WORKERS
    /* A claimed arena may be a parked one with free blocks and bump room,
     * and other threads may have returned blocks since the last miss. */
    if (atomic_load_explicit(&scr_sa_remote[scr_sa_arena], memory_order_relaxed))
      scr_sa_drain_remote();
    ScrSaBlock *b = scr_sa.free[c];
    if (b) {
      scr_sa.free[c] = b->next;
      if (zero) memset(b, 0, n);
      return b;
    }
#ifdef SCR_SA_TRIM
    /* A worker that keeps its memory apart uses the arena's older free
     * blocks before its class grows. */
    if (scr_sa_keep && (size_t)(scr_sa.lim[c] - scr_sa.bump[c]) < scr_sa_class_size(c) &&
        (b = scr_sa_keep_take(scr_sa_keep, c)) != NULL) {
      if (zero) memset(b, 0, n);
      return b;
    }
#endif
#endif
    /* Carve from the class's chunk, raising its limit as needed, or from a
     * new chunk once it is full; fresh pages are zero. */
    size_t sz = scr_sa_class_size(c);
#ifdef SCR_SA_TRIM
    if (scr_sa.lim[c]) scr_sa_next_hole(c, sz);
#endif
    ScrSaCarve *k = &scr_sa_carve[SCR_SA_ARENA_NOW][c];
    char *p = scr_sa.bump[c], *lim = scr_sa.lim[c];
    if (k->start) {
      char *end = k->start + SCR_SA_CHUNK;
#ifdef SCR_SA_DUMP
      char *from = lim;
#endif
      while ((size_t)(lim - p) < sz && lim < end) lim = scr_sa_extend(c, k, lim, end);
#ifdef SCR_SA_DUMP
      if (lim > from && scr_sa_dump_chunks) scr_sa_dumpable(k->start, end, from, lim);
#endif
    }
    if (!k->start || (size_t)(lim - p) < sz) {
      char *chunk = k->next;
      bool ahead = chunk != NULL;
      k->next = NULL;
      if (!chunk) chunk = scr_sa_class_chunk_take(c);
      if (chunk) {
        scr_sa_open(c, k, chunk, ahead);
        p = lim = chunk;
        while ((size_t)(lim - p) < sz) lim = scr_sa_extend(c, k, lim, chunk + SCR_SA_CHUNK);
#ifdef SCR_SA_DUMP
        if (scr_sa_dump_chunks) scr_sa_dumpable(chunk, chunk + SCR_SA_CHUNK, chunk, lim);
#endif
      }
    }
    scr_sa.lim[c] = lim;
    if ((size_t)(lim - p) >= sz) {
      scr_sa.bump[c] = p + sz;
      return p;
    }
    scr_sa.bump[c] = p;
  }
  /* Large or zero-sized, an exhausted window, or no reservation. */
  void *q = zero ? calloc(1, n) : malloc(n);
  if (n > SCR_SA_MAX) {
    SCR_SA_LARGE_NOTE(q, n);
    SCR_SA_THREAD_LARGE_NOTE();
  }
#ifdef SCR_SA_TRIM
  scr_sa_keep_note_system(q);
#endif
  return q;
}

/* A window block above SCR_SA_MAX for scr_sa_slow_ref: from the calling
 * thread's large classes, or a run of chunks; NULL when the window has no
 * room. */
static void *scr_sa_large_take(size_t n, bool zero) {
  if (n > SCR_SA_LARGE_MAX) return scr_sa_run_take((n + SCR_SA_CHUNK - 1) >> SCR_SA_CHUNK_SHIFT, n, zero);
#ifdef SCR_WORKERS
  if (atomic_load_explicit(&scr_sa_remote[scr_sa_arena], memory_order_relaxed)) scr_sa_drain_remote();
#endif
  unsigned c = scr_sa_large_class(n);
  ScrSaLarge *l = &scr_sa_large[SCR_SA_ARENA_NOW];
  ScrSaBlock *b = l->free[c];
  if (b) {
    l->free[c] = b->next;
    if (zero) memset(b, 0, n);
    return b;
  }
#if defined(__linux__) && defined(MADV_DONTNEED)
  if ((b = l->trimmed[c]) != NULL) {
    /* The whole pages after the block's first page went back and read as
     * zero (scr_sa_large_trim); the parts of its first and last pages kept
     * their bytes. */
    l->trimmed[c] = b->next;
    if (zero) {
      long page = sysconf(_SC_PAGESIZE);
      uintptr_t pg = page > 0 ? (uintptr_t)page : 4096;
      uintptr_t lo = ((uintptr_t)b + pg) & ~(pg - 1), end = (uintptr_t)b + n;
      uintptr_t hi = ((uintptr_t)b + scr_sa_large_size(c)) & ~(pg - 1);
      if (hi < lo) hi = lo;
      memset(b, 0, (size_t)((lo < end ? lo : end) - (uintptr_t)b));
      if (end > hi) memset((void *)hi, 0, (size_t)(end - hi));
    }
    return b;
  }
#endif
  size_t sz = scr_sa_large_size(c);
  char *q = l->bump[c];
  if (!q || (size_t)(l->lim[c] - q) < sz) {
    q = scr_sa_chunk_take(1, (uint16_t)(SCR_SA_LARGE_TAG | scr_sa.tag | c));
    if (!q) return NULL;
    l->lim[c] = q + scr_sa_chunk_bytes(sz);
  }
  /* Carved memory is fresh, and reads as zero. */
  l->bump[c] = q + sz;
  l->carved += sz;
  return q;
}

/* A block a 32-bit reference may name (scr_mem_alloc_ref): above SCR_SA_MAX,
 * a window block (scr_sa_large_take); the system allocator's when the window
 * is exhausted or refused. A worker that keeps its memory apart records its
 * window blocks, as it records its system blocks, so that they go back when
 * it parks without having shared. */
__attribute__((noinline)) void *scr_sa_slow_ref(size_t n, bool zero) {
  if (n - 1 < SCR_SA_MAX) {
    void *p = scr_sa_slow(n, zero);
    /* The window could not serve it (full, refused, or the thread has no
     * arena): a program that stores references in 32-bit fields cannot keep
     * the system address the field would truncate. */
    if (scr_sa_window_required() && !scr_sa_in_window(p)) scr_sa_window_limit();
    return p;
  }
  if (n > SIZE_MAX - SCR_SA_CHUNK || !(scr_sa.span || (!scr_sa_refused && scr_sa_reserve()))) {
    if (scr_sa_window_required()) scr_sa_window_limit();
    return scr_sa_slow(n, zero);
  }
  void *p = scr_sa_large_take(n, zero);
  if (!p) {
    if (scr_sa_window_required()) scr_sa_window_limit();
    return scr_sa_slow(n, zero);
  }
#ifdef SCR_SA_TRIM
  if (scr_sa_keep) scr_sa_keep_add(scr_sa_keep, p);
#endif
  return p;
}

#if defined(__linux__) && defined(MREMAP_FIXED)
/* Grows the run p of `have` bytes to a run of n bytes (n > SCR_SA_LARGE_MAX)
 * by moving its pages to a new run, as the system allocator grows a mapped
 * block, instead of copying them; NULL when p is no run or the window has no
 * room. The old range is mapped again, reads as zero, and returns to the
 * window as a run whose pages are not resident. */
static void *scr_sa_run_move(void *p, size_t have, size_t n) {
  char *w = __atomic_load_n(&scr_sa_window, __ATOMIC_ACQUIRE);
  uintptr_t off = (uintptr_t)p - (uintptr_t)w;
  if (!w || off >= (uintptr_t)scr_sa_window_chunks << SCR_SA_CHUNK_SHIFT ||
      scr_sa_chunks[off >> SCR_SA_CHUNK_SHIFT] != SCR_SA_RUN_HEAD)
    return NULL;
  char *q = scr_sa_run_take((n + SCR_SA_CHUNK - 1) >> SCR_SA_CHUNK_SHIFT, n, false);
  if (!q) return NULL;
  if (mremap(p, have, have, MREMAP_MAYMOVE | MREMAP_FIXED, q) != q) {
    memcpy(q, p, have);
    scr_sa_run_free(p);
    return q;
  }
  if (mmap(p, have, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANON | MAP_FIXED | MAP_NORESERVE, -1, 0) != p)
    scr_trap("scriptc: out of memory\n");
#ifdef SCR_SA_THP
  (void)madvise(p, have, MADV_NOHUGEPAGE);
#endif
#ifdef SCR_SA_DUMP
  (void)madvise(p, have, MADV_DONTDUMP);
#endif
  scr_sa_run_release(p, true);
#ifdef SCR_SA_TRIM
  if (scr_sa_keep && scr_sa_keep_remove(scr_sa_keep, p)) scr_sa_keep_add(scr_sa_keep, q);
#endif
  return q;
}
#endif

void *scr_mem_realloc_ref(void *p, size_t n) {
  if (!p) return scr_mem_alloc_ref(n);
  size_t have = scr_mem_block_size(p);
  if (n && n <= have && (n % 16 || have % 16 == 0)) return p;
#if defined(__linux__) && defined(MREMAP_FIXED)
  if (n > SCR_SA_LARGE_MAX) {
    void *moved = scr_sa_run_move(p, have, n);
    if (moved) return moved;
  }
  /* A block that grows past SCR_SA_GROW_RUN becomes a run: it grows in place
   * up to its last chunk and by moving its pages beyond, as the system
   * allocator's mapped blocks grow, instead of being copied at every class.
   * Only the pages it uses become resident. */
  if (n > SCR_SA_GROW_RUN && n <= SCR_SA_LARGE_MAX && have >= SCR_SA_MAX) {
    char *w = __atomic_load_n(&scr_sa_window, __ATOMIC_ACQUIRE);
    char *q = w ? scr_sa_run_take(1, n, false) : NULL;
    if (q) {
#ifdef SCR_SA_TRIM
      if (scr_sa_keep) scr_sa_keep_add(scr_sa_keep, q);
#endif
      memcpy(q, p, have);
      scr_mem_free(p);
      return q;
    }
  }
#endif
  /* A block of the system allocator on a platform whose usable size this
   * runtime cannot ask for (scr_mem_block_size: no malloc_usable_size): the
   * system allocator holds the size, so it grows the block and keeps its
   * contents, where a copy would take the zero bytes read. */
  if (have == 0 && n) {
#ifdef SCR_SA_TRIM
    bool kept = scr_sa_keep && scr_sa_keep_remove(scr_sa_keep, p);
#endif
    void *q = realloc(p, n);
    if (n > SCR_SA_MAX) SCR_SA_LARGE_NOTE(q, n);
#ifdef SCR_SA_TRIM
    if (kept) scr_sa_keep_note_system(q ? q : p); /* a failed realloc leaves p */
#endif
    return q;
  }
  void *q = scr_mem_alloc_ref(n ? n : 1);
  if (!q) return NULL;
  memcpy(q, p, have < n ? have : n);
  scr_mem_free(p);
  return q;
}

/* The usable bytes of the block p (non-NULL) of any of the allocators. */
size_t scr_mem_block_size(const void *p) {
  uintptr_t w = (uintptr_t)__atomic_load_n(&scr_sa_window, __ATOMIC_ACQUIRE), off = (uintptr_t)p - w;
  if (w && off < (uintptr_t)scr_sa_window_chunks << SCR_SA_CHUNK_SHIFT) {
    unsigned e = scr_sa_chunks[off >> SCR_SA_CHUNK_SHIFT];
    if (e & SCR_SA_LARGE_TAG) return scr_sa_large_bytes(p, e);
    if (e) return scr_sa_class_size(e & 0xff);
  }
#if defined(__GLIBC__)
  return malloc_usable_size((void *)p);
#else
  return 0;
#endif
}

void *scr_mem_realloc(void *p, size_t n) {
  if (!p) return scr_mem_alloc(n);
  /* A large window block stays in the window. */
  uintptr_t w = (uintptr_t)scr_sa_window, woff = (uintptr_t)p - w;
  if (w && woff < (uintptr_t)scr_sa_window_chunks << SCR_SA_CHUNK_SHIFT &&
      (scr_sa_chunks[woff >> SCR_SA_CHUNK_SHIFT] & SCR_SA_LARGE_TAG))
    return scr_mem_realloc_ref(p, n);
  uintptr_t off = (uintptr_t)p - scr_sa.base;
  size_t have;
  unsigned c = off < scr_sa.span ? scr_sa_chunks[off >> SCR_SA_CHUNK_SHIFT] ^ scr_sa.tag : 256;
  if (c < 256)
    have = scr_sa_class_size(c);
#ifdef SCR_WORKERS
  else if ((have = scr_sa_foreign_size(p)) != 0) {
    /* Another arena's block: move it into this thread's allocator. */
  } else if (scr_sa_window && (uintptr_t)p - (uintptr_t)scr_sa_window <
                                  (uintptr_t)scr_sa_window_chunks << SCR_SA_CHUNK_SHIFT) {
    /* A block that went back with a discarded worker's memory. */
    have = 0;
  }
#endif
  else {
#ifdef SCR_SA_TRIM
    bool kept = scr_sa_keep && scr_sa_keep_remove(scr_sa_keep, p);
#endif
    void *q = realloc(p, n);
    if (n > SCR_SA_MAX) SCR_SA_LARGE_NOTE(q, n);
#ifdef SCR_SA_TRIM
    if (kept) scr_sa_keep_note_system(q ? q : p); /* a failed realloc leaves p */
#endif
    return q;
  }
  /* Still fits its block, which is aligned for n (see the contract). */
  if (n && n <= have && (n % 16 || have % 16 == 0)) return p;
  void *q = scr_mem_alloc(n ? n : 1);
  if (!q) return NULL;
  memcpy(q, p, have < n ? have : n);
  scr_mem_free(p);
  return q;
}
#else
void *scr_mem_realloc(void *p, size_t n) { return realloc(p, n); }
void *scr_mem_realloc_ref(void *p, size_t n) { return realloc(p, n); }
size_t scr_mem_block_size(const void *p) {
#if defined(__GLIBC__)
  return malloc_usable_size((void *)p);
#else
  (void)p;
  return 0;
#endif
}
#ifdef SCR_WORKERS
void scr_sa_thread_park(void) {}
void scr_sa_wait_trims(void) {}
void scr_sa_thread_shares(void) {}
void scr_sa_loop_waiting(bool waiting) { (void)waiting; }
void scr_sa_free_foreign(void *p) { free(p); }
#endif
#endif

#ifndef SCR_SA_WORKER_STARTING
#define SCR_SA_WORKER_STARTING() ((void)0)
#endif

#ifdef SCR_WORKERS
/* Blocks above SCR_SA_MAX come from glibc, which gives each thread that
 * allocates its own arena: a heap reserved up front and made usable with
 * mprotect as it grows. Each extension takes the process's mmap lock for
 * writing, which stalls every other thread's page faults and mapping calls
 * until it is done, and a heap grows in steps barely larger than the
 * request: worker threads that parse or build large data extend their
 * heaps around a hundred times each, while the other threads fault pages.
 * A heap keeps that range accessible, though: trimming returns the pages
 * of its free top but leaves them mapped read-write (unless the system
 * forbids overcommit), and growing into them later needs no mprotect. So a
 * worker that allocates many large blocks (SCR_SA_THREAD_RESERVE_AFTER)
 * raises its heap's high-water mark once, by allocating
 * SCR_SA_THREAD_HEAP_RESERVE in blocks below glibc's smallest mmap
 * threshold and freeing them. The heap top stays as small as glibc leaves
 * it, so large blocks are still mapped on their own, and only the blocks'
 * headers are written. A worker with few large blocks never pays for the
 * extensions. The reservation stays small because glibc's calloc clears
 * all of a block that lies below the high-water mark, so a larger one
 * makes zeroed blocks touch pages they would otherwise leave untouched.
 * Library archives run on their embedder's threads and leave its heaps
 * alone. */
#if defined(__GLIBC__) && !defined(SCR_LIB)
#define SCR_SA_THREAD_HEAP_RESERVE ((size_t)4 << 20)
#define SCR_SA_THREAD_HEAP_STEP ((size_t)120 << 10) /* below 128 KiB, glibc's lowest threshold */
#define SCR_SA_THREAD_RESERVE_AFTER 256u
/* Large blocks this worker allocated before its reservation; 0 on threads
 * that are not workers (they never reserve). */
static _Thread_local unsigned scr_sa_thread_large;

void scr_sa_thread_starting(void) {
  scr_sa_thread_large = 1;
  SCR_SA_WORKER_STARTING();
}

static void scr_sa_thread_reserve(void) {
  void *blocks[SCR_SA_THREAD_HEAP_RESERVE / SCR_SA_THREAD_HEAP_STEP + 1];
  size_t n = 0;
  for (size_t total = 0; total < SCR_SA_THREAD_HEAP_RESERVE; total += SCR_SA_THREAD_HEAP_STEP) {
    void *p = malloc(SCR_SA_THREAD_HEAP_STEP);
    if (!p) break;
    blocks[n++] = p;
  }
  while (n) free(blocks[--n]);
}

static void scr_sa_thread_large_note(void) {
  unsigned count = scr_sa_thread_large;
  if (count == 0 || count > SCR_SA_THREAD_RESERVE_AFTER) return;
  scr_sa_thread_large = count + 1;
  if (count == SCR_SA_THREAD_RESERVE_AFTER) scr_sa_thread_reserve();
}
#else
void scr_sa_thread_starting(void) { SCR_SA_WORKER_STARTING(); }
#endif
#endif

void *scr_rt_calloc(size_t n) { return scr_mem_calloc_ref(n); }
void scr_rt_free(void *p) { scr_mem_free(p); }

void scr_mem_prefault(void *lo, void *hi) {
#if SCR_SMALL_ALLOC && defined(SCR_SA_PREFAULT)
  scr_sa_prefault(lo, hi);
#else
  (void)lo;
  (void)hi;
#endif
}

void scr_mem_release_ahead(void *lo, void *hi) {
#if SCR_SMALL_ALLOC && defined(SCR_SA_PREFAULT)
  if (atomic_load_explicit(&scr_sa_pf_state, memory_order_relaxed) > 0) scr_sa_pf_forget(lo, hi);
#endif
#if defined(__linux__) && defined(MADV_DONTNEED)
  if ((char *)hi > (char *)lo) (void)madvise(lo, (size_t)((char *)hi - (char *)lo), MADV_DONTNEED);
#else
  (void)lo;
  (void)hi;
#endif
}

/* Free order. Free lists are LIFO, so blocks freed in descending address
 * order come back in ascending order, the order the bump pointers carve
 * fresh memory in, and the order the program then touches them in. The
 * order within a page matters as much as across pages: blocks of a page
 * handed out in no particular order defeat the hardware prefetcher.
 *
 * The pointers are marked in a bitmap of block indices per chunk, over the
 * range of blocks they span, and read back from the highest block of the
 * highest chunk down. That takes one bit per block in that range, at most
 * one per block in use, and reading the bitmaps back costs a step per word;
 * a set spread so thinly that they would take more than SCR_SA_ORDER_SPARSE
 * words per pointer, or over more than SCR_SA_ORDER_CHUNKS chunks, is left
 * as it is. Pointers that are not the calling thread's blocks, not at
 * `offset` in a block, or repeated, come first, in the order they had. */
#define SCR_SA_ORDER_SPARSE 8

#if SCR_SMALL_ALLOC
/* The chunks a set of pointers is ordered over at most: a set spread wider
 * is left as it is. */
#define SCR_SA_ORDER_CHUNKS 16
#endif

void scr_mem_order_for_free(void **ptrs, size_t n, size_t offset) {
#if SCR_SMALL_ALLOC
  if (n < 2 || !scr_sa.span) return;
  /* The calling thread's chunks the pointers' blocks are in, with each one's
   * class and the lowest and highest block index; a block's index in its
   * chunk is below 2^19, the most 8-byte blocks a chunk holds. */
  uint32_t chunk[SCR_SA_ORDER_CHUNKS], size[SCR_SA_ORDER_CHUNKS], lo[SCR_SA_ORDER_CHUNKS],
      hi[SCR_SA_ORDER_CHUNKS];
  size_t at[SCR_SA_ORDER_CHUNKS], nchunks = 0, words = 0;
  uintptr_t base = scr_sa.base, span = scr_sa.span;
  for (size_t i = 0; i < n; i++) {
    uintptr_t off = (uintptr_t)ptrs[i] - offset - base;
    if (off >= span) continue;
    unsigned e = scr_sa_chunks[off >> SCR_SA_CHUNK_SHIFT];
    if ((e & 0xff00) != scr_sa.tag) continue;
    uint32_t ci = (uint32_t)(off >> SCR_SA_CHUNK_SHIFT), sz = (uint32_t)scr_sa_class_size(e & 0xff);
    uint32_t in = (uint32_t)(off & (SCR_SA_CHUNK - 1)), idx = in / sz;
    if (in != idx * sz) continue;
    size_t j = 0;
    while (j < nchunks && chunk[j] != ci) j++;
    if (j == nchunks) {
      if (nchunks == SCR_SA_ORDER_CHUNKS) return;
      chunk[j] = ci;
      size[j] = sz;
      lo[j] = idx;
      hi[j] = idx;
      nchunks++;
    }
    if (idx < lo[j]) lo[j] = idx;
    if (idx > hi[j]) hi[j] = idx;
  }
  for (size_t j = 0; j < nchunks; j++) {
    at[j] = words;
    words += hi[j] / 64 - lo[j] / 64 + 1;
  }
  if (words == 0 || words / SCR_SA_ORDER_SPARSE > n) return;
  uint64_t *bits = calloc(words, sizeof *bits);
  if (!bits) return; /* the order only affects performance */
  size_t k = 0;
  for (size_t i = 0; i < n; i++) {
    void *p = ptrs[i];
    uintptr_t off = (uintptr_t)p - offset - base;
    if (off < span && (scr_sa_chunks[off >> SCR_SA_CHUNK_SHIFT] & 0xff00) == scr_sa.tag) {
      uint32_t ci = (uint32_t)(off >> SCR_SA_CHUNK_SHIFT);
      size_t j = 0;
      while (j < nchunks && chunk[j] != ci) j++;
      uint32_t in = (uint32_t)(off & (SCR_SA_CHUNK - 1)), idx = in / size[j];
      if (in == idx * size[j]) {
        uint64_t *word = &bits[at[j] + idx / 64 - lo[j] / 64], bit = (uint64_t)1 << (idx % 64);
        if (!(*word & bit)) {
          *word |= bit;
          continue;
        }
      }
    }
    ptrs[k++] = p;
  }
  /* Highest address first: chunks in descending order, then blocks. */
  for (size_t done = 0; done < nchunks; done++) {
    size_t j = 0;
    for (size_t m = 1; m < nchunks; m++)
      if (chunk[m] != UINT32_MAX && (chunk[j] == UINT32_MAX || chunk[m] > chunk[j])) j = m;
    char *first = (char *)base + ((uintptr_t)chunk[j] << SCR_SA_CHUNK_SHIFT) + offset +
                  (size_t)(lo[j] / 64) * 64 * size[j];
    for (size_t w = hi[j] / 64 - lo[j] / 64 + 1; w-- > 0;) {
      uint64_t word = bits[at[j] + w];
      while (word) {
        unsigned b = 63 - (unsigned)__builtin_clzll(word);
        word &= ~((uint64_t)1 << b);
        ptrs[k++] = first + (w * 64 + b) * size[j];
      }
    }
    chunk[j] = UINT32_MAX;
  }
  free(bits);
#else
  (void)ptrs;
  (void)n;
  (void)offset;
#endif
}

#if defined(__SANITIZE_ADDRESS__)
#define SCR_HEAP_SANITIZER 1
#elif defined(__has_feature)
#if __has_feature(address_sanitizer)
#define SCR_HEAP_SANITIZER 1
#endif
#endif

#if defined(SCR_HEAP_SANITIZER)
#include <sanitizer/allocator_interface.h>
#elif defined(__GLIBC__) && (__GLIBC__ > 2 || (__GLIBC__ == 2 && __GLIBC_MINOR__ >= 33))
#include <malloc.h>
#define SCR_HEAP_MALLINFO2 1
#elif defined(__APPLE__)
#include <malloc/malloc.h>
#elif defined(_WIN32)
#include <malloc.h>
#include <windows.h>
#endif

/* process.memoryUsage's heap figures: the calling thread's small-object
 * chunks (the bytes carved from them; in use is that less the blocks on
 * their free lists and the zeroed holes left to carve) plus the system
 * allocator's own totals where the platform reports them (glibc's
 * mallinfo2, the Darwin malloc zones, the Windows CRT heap, or the
 * sanitizer's allocator in sanitized builds). Walks the free lists, so
 * the cost grows with the number of free blocks. */
#if defined(__linux__) && SCR_SMALL_ALLOC
static void scr_plr_heap_stats(size_t *held, size_t *used);
#endif

void scr_heap_stats(double *total, double *used) {
  size_t held = 0, idle = 0;
#if SCR_SMALL_ALLOC
  for (unsigned c = 0; c < SCR_SA_NCLASS; c++) {
    if (!scr_sa.lim[c]) continue;
    size_t sz = scr_sa_class_size(c);
    char *top = scr_sa.bump[c];
#ifdef SCR_SA_TRIM
    const ScrSaHoles *h = &scr_sa_holes[scr_sa_arena][c];
    if (h->lim) {
      top = h->bump;
      idle += (size_t)(scr_sa.lim[c] - scr_sa.bump[c]);
    }
    for (size_t i = 0; i < h->n; i++) idle += (size_t)(h->runs[i].hi - h->runs[i].lo);
#endif
    held += scr_sa_class_carved(c, top);
    for (const ScrSaBlock *b = scr_sa.free[c]; b; b = b->next) idle += sz;
  }
#endif
  size_t sys_held = 0, sys_used = 0;
#if defined(SCR_HEAP_SANITIZER)
  sys_held = __sanitizer_get_heap_size();
  sys_used = __sanitizer_get_current_allocated_bytes();
#elif defined(SCR_HEAP_MALLINFO2)
  struct mallinfo2 info = mallinfo2();
  sys_held = info.arena + info.hblkhd;
  sys_used = info.uordblks + info.hblkhd;
#elif defined(__APPLE__)
  malloc_statistics_t stats;
  malloc_zone_statistics(NULL, &stats);
  sys_held = stats.size_allocated;
  sys_used = stats.size_in_use;
#elif defined(_WIN32)
  typedef struct {
    DWORD cb;
    SIZE_T allocated;
    SIZE_T committed;
    SIZE_T reserved;
    SIZE_T max_reserve;
  } ScrHeapSummary;
  typedef BOOL(WINAPI * SummaryFn)(HANDLE, DWORD, ScrHeapSummary *);
  HMODULE kernel = GetModuleHandleA("kernel32.dll");
  SummaryFn summary = kernel ? (SummaryFn)(void *)GetProcAddress(kernel, "HeapSummary") : NULL;
  ScrHeapSummary s = {sizeof s, 0, 0, 0, 0};
  if (summary && summary((HANDLE)_get_heap_handle(), 0, &s)) {
    sys_held = s.committed;
    sys_used = s.allocated;
  }
#endif
#if defined(__linux__) && SCR_SMALL_ALLOC
  /* Compact class instances (the program-lifetime region below). */
  size_t region_held, region_used;
  scr_plr_heap_stats(&region_held, &region_used);
  sys_held += region_held;
  sys_used += region_used;
#endif
  *total = (double)(held + sys_held);
  *used = (double)(held - (idle < held ? idle : held) + sys_used);
}

/* scr_heap_trim: returns the heap pages that hold only freed memory to the
 * system after a phase's data died (scr_collect_cycles_phase). The
 * size classes keep freed blocks on their class's free list, which only
 * later blocks of the same class reuse, so a program whose next phase
 * allocates other sizes would otherwise grow its resident memory on top of
 * the freed heap. */
#if defined(__GLIBC__) && !defined(SCR_HEAP_SANITIZER)
#include <malloc.h>
#endif
#if SCR_SMALL_ALLOC && !defined(SCR_WORKERS) && defined(__linux__) && defined(MADV_DONTNEED)
#include <sys/mman.h>
#include <unistd.h>

/* Returns the pages of class c below its frontier that hold only free
 * blocks (MADV_DONTNEED), and relinks the class's other free blocks in
 * address order. A block wholly inside a returned page leaves the free list:
 * the class carves new blocks past its frontier instead. */
static void scr_sa_return_free_pages(unsigned c, size_t page) {
  size_t sz = scr_sa_class_size(c);
  char *top = scr_sa.bump[c];
  if (!scr_sa_class_carved(c, top) || !scr_sa.free[c]) return;
  ScrSaMarks m;
  if (!scr_sa_marks_open(&m, c)) return;
  uint64_t mask;
  for (ScrSaBlock *b = scr_sa.free[c]; b; b = b->next) {
    uint64_t *word = scr_sa_mark(&m, b, sz, &mask);
    if (word) *word |= mask;
  }
  (void)scr_sa_marks_return(&m, c, top, page, NULL, NULL);
  scr_sa_marks_relink(&m, c);
  scr_sa_marks_close(&m);
}
#endif

void scr_heap_trim(void) {
#ifdef SCR_SA_TRIM
  /* A worker runtime returns the calling thread's arena pages as a parking
   * thread does; the arena stays the thread's own. */
  if (scr_sa_arena >= 0 && scr_sa_trim_worth()) {
    scr_sa_trim();
    return;
  }
#elif SCR_SMALL_ALLOC && !defined(SCR_WORKERS) && defined(__linux__) && defined(MADV_DONTNEED)
  if (scr_sa.span) {
    long page = sysconf(_SC_PAGESIZE);
    for (unsigned c = 0; c < SCR_SA_NCLASS; c++)
      if (scr_sa.lim[c]) scr_sa_return_free_pages(c, page > 0 ? (size_t)page : 4096);
    scr_sa_large_trim();
  }
#endif
#if defined(__GLIBC__) && !defined(SCR_HEAP_SANITIZER)
  /* Large blocks: the system allocator's free pages too. */
  (void)malloc_trim(0);
#endif
}

/* ── program-lifetime region ────────────────────────────────────────────
 * Instances of compact classes (llvm/classes.ts LlClassMeta.compact) in
 * programs built for Linux without sanitizers (runtimes with the size-class
 * allocator, SCR_SMALL_ALLOC) live in one address range
 * reserved for the whole process below 32 GiB, so a field that holds one
 * can store its address over 8 in 32 bits (0 stays NULL). The instances
 * are never freed. Each thread carves them from its own chunks of
 * SCR_PLR_CHUNK bytes; a chunk is taken from the range with one atomic add.
 * Pages are committed by first touch and start zeroed. Its strings are
 * arrays rather than literals: programs without compact classes then link
 * none of this, where literals would stay in the unit's merged strings. */
#if defined(__linux__) && SCR_SMALL_ALLOC
#include <sys/mman.h>

#define SCR_PLR_CHUNK ((size_t)1 << 20)
/* References are 32-bit addresses of 8-byte units, so the region's chunks
 * must end by SCR_PLR_END: they come from the window (scr_sa_window_reserve,
 * which on Linux places it in [4 GiB, 32 GiB)), together with the small
 * blocks. Past the region's first SCR_SA_HUGE_AFTER bytes its window chunks
 * use transparent huge pages, as size classes do: a large heap of instances
 * takes 512 times fewer page faults and TLB entries, and a small program
 * stays on small pages. */
#define SCR_PLR_END ((uintptr_t)32 << 30)

static size_t scr_plr_window_chunks; /* window chunks taken; under scr_plr_lock */
static char *scr_plr_cur, *scr_plr_end; /* the rest of the last of them */
static char scr_plr_lock;
/* Bytes of the chunks threads hold, and of the tails they left unused when
 * they moved to a new chunk (scr_heap_stats); atomic. */
static size_t scr_plr_held, scr_plr_waste;
#if defined(SCR_WORKERS) || (defined(SCR_LIB) && defined(SCR_THREAD_INSTANCES))
_Thread_local ScrPlrChunk scr_plr_chunk = {NULL, NULL};
#else
ScrPlrChunk scr_plr_chunk = {NULL, NULL};
#endif

/* The heap limit: the window has no room left for the region. */
static _Noreturn void scr_plr_out_of_memory(void) { scr_sa_window_limit(); }

static __attribute__((noinline)) void scr_plr_reserve(void) {
  /* scr_trap is the runtime's failure path (scr_exception.c); the
   * allocator's standalone test defines its own (scr_alloc.test.c). */
  if (!scr_sa_window_reserve() ||
      (uintptr_t)scr_sa_window + ((uintptr_t)scr_sa_window_chunks << SCR_SA_CHUNK_SHIFT) > SCR_PLR_END) {
    static const char message[] =
        "scriptc: cannot reserve address space below 32 GiB for program-lifetime objects\n";
    scr_trap(message);
  }
}

/* `size` bytes (a multiple of SCR_PLR_CHUNK) from the window, or NULL when
 * the window has no room left. */
static char *scr_plr_take(size_t size) {
  char *fresh = NULL; /* window chunks taken here, advised after the lock */
  size_t n = 0;
  bool huge = false;
  scr_sa_spin_take(&scr_plr_lock);
  if ((size_t)(scr_plr_end - scr_plr_cur) < size) {
    n = (size + SCR_SA_CHUNK - 1) >> SCR_SA_CHUNK_SHIFT;
    fresh = scr_sa_chunk_take(n, 0);
    if (!fresh) {
      __atomic_clear(&scr_plr_lock, __ATOMIC_RELEASE);
      return NULL;
    }
    huge = scr_plr_window_chunks >= SCR_SA_HUGE_AFTER / SCR_SA_CHUNK;
    scr_plr_window_chunks += n;
    scr_plr_cur = fresh;
    scr_plr_end = fresh + (n << SCR_SA_CHUNK_SHIFT);
  }
  char *p = scr_plr_cur;
  scr_plr_cur += size;
  __atomic_clear(&scr_plr_lock, __ATOMIC_RELEASE);
  if (fresh) {
#ifdef SCR_SA_DUMP
    /* The window is left out of core dumps until carved; instances are in. */
    if (scr_sa_dump_chunks) (void)madvise(fresh, n << SCR_SA_CHUNK_SHIFT, MADV_DODUMP);
#endif
#ifdef SCR_SA_THP
    if (huge) (void)madvise(fresh, n << SCR_SA_CHUNK_SHIFT, MADV_HUGEPAGE);
#else
    (void)huge;
#endif
  }
  return p;
}

#ifdef SCR_SA_TRIM
/* A worker whose memory goes back when it exits (scr_sa_park_arena: it
 * shared nothing) returns its chunks too, when the thread ends, and later
 * chunks reuse them. A thread's chunks are linked through their first two
 * words (the next chunk and the chunk's size) from scr_plr_mine; the first
 * chunk a thread takes registers scr_plr_thread_end. */
#define SCR_PLR_LINK 16
static _Thread_local char *scr_plr_mine;
static _Thread_local size_t scr_plr_mine_waste; /* this thread's part of scr_plr_waste */
static pthread_key_t scr_plr_end_key;
static pthread_once_t scr_plr_end_once = PTHREAD_ONCE_INIT;
static pthread_mutex_t scr_plr_free_lock = PTHREAD_MUTEX_INITIALIZER;
static char **scr_plr_free; /* returned chunks of SCR_PLR_CHUNK bytes */
static size_t scr_plr_nfree, scr_plr_free_cap;

/* Thread exit, after scr_sa_thread_park decided whether the thread's memory
 * goes back. SCR_SA_DISCARD=poison makes the chunks inaccessible instead. */
static void scr_plr_thread_end(void *unused) {
  (void)unused;
  char *c = scr_plr_mine;
  scr_plr_mine = NULL;
  if (!scr_sa_discarded) return;
  bool poison = scr_sa_discard_mode() == 2;
  size_t returned = 0;
  while (c) {
    char *next = ((char **)c)[0];
    size_t size = ((size_t *)c)[1];
    returned += size;
    if (poison) {
      (void)mprotect(c, size, PROT_NONE);
    } else {
      (void)madvise(c, size, MADV_DONTNEED); /* reads as zero again */
      if (size == SCR_PLR_CHUNK) {
        pthread_mutex_lock(&scr_plr_free_lock);
        if (scr_plr_nfree == scr_plr_free_cap) {
          size_t cap = scr_plr_free_cap ? 2 * scr_plr_free_cap : 64;
          char **grown = realloc(scr_plr_free, cap * sizeof *grown);
          if (grown) {
            scr_plr_free = grown;
            scr_plr_free_cap = cap;
          }
        }
        if (scr_plr_nfree < scr_plr_free_cap) scr_plr_free[scr_plr_nfree++] = c;
        pthread_mutex_unlock(&scr_plr_free_lock);
      }
    }
    c = next;
  }
  static const char stats_line[] = "scr_sa: thread returned %zu MB of program-lifetime objects\n";
  __atomic_fetch_sub(&scr_plr_held, returned, __ATOMIC_RELAXED);
  __atomic_fetch_sub(&scr_plr_waste, scr_plr_mine_waste, __ATOMIC_RELAXED);
  scr_plr_mine_waste = 0;
  const char *stats = getenv("SCR_SA_STATS");
  if (stats && stats[0] == '1') fprintf(stderr, stats_line, returned >> 20);
}

static void scr_plr_end_key_init(void) {
  (void)pthread_key_create(&scr_plr_end_key, scr_plr_thread_end);
}

/* Records the calling thread's new chunk `p` of `size` bytes. */
static void scr_plr_own(char *p, size_t size) {
  if (!scr_plr_mine) {
    (void)pthread_once(&scr_plr_end_once, scr_plr_end_key_init);
    (void)pthread_setspecific(scr_plr_end_key, p);
  }
  ((char **)p)[0] = scr_plr_mine;
  ((size_t *)p)[1] = size;
  scr_plr_mine = p;
}

static char *scr_plr_reuse(void) {
  char *c = NULL;
  pthread_mutex_lock(&scr_plr_free_lock);
  if (scr_plr_nfree) c = scr_plr_free[--scr_plr_nfree];
  pthread_mutex_unlock(&scr_plr_free_lock);
  return c;
}
#else
#define SCR_PLR_LINK 0
#endif

static __attribute__((noinline)) void *scr_plr_refill(size_t n) {
  if (!__atomic_load_n(&scr_sa_window, __ATOMIC_ACQUIRE)) scr_plr_reserve();
  size_t need = n + SCR_PLR_LINK;
  size_t chunk =
      need > SCR_PLR_CHUNK ? (need + SCR_PLR_CHUNK - 1) & ~(SCR_PLR_CHUNK - 1) : SCR_PLR_CHUNK;
  char *p = NULL;
#ifdef SCR_SA_TRIM
  if (chunk == SCR_PLR_CHUNK) p = scr_plr_reuse();
#endif
  if (!p && !(p = scr_plr_take(chunk))) scr_plr_out_of_memory();
#ifdef SCR_SA_TRIM
  scr_plr_own(p, chunk);
#endif
  if (scr_plr_chunk.next) {
    size_t left = (size_t)(scr_plr_chunk.limit - scr_plr_chunk.next);
    __atomic_fetch_add(&scr_plr_waste, left, __ATOMIC_RELAXED);
#ifdef SCR_SA_TRIM
    scr_plr_mine_waste += left;
#endif
  }
  /* process.memoryUsage() counts the chunk in heapTotal and heapUsed
   * (scr_heap_stats, scr_plr_heap_stats). */
  __atomic_fetch_add(&scr_plr_held, chunk, __ATOMIC_RELAXED);
  scr_plr_chunk.next = p + SCR_PLR_LINK + n;
  scr_plr_chunk.limit = p + chunk;
  return p + SCR_PLR_LINK;
}

/* Called before compiled code runs (emitted main), so the region exists
 * before any reference into it does. */
void scr_plr_init(void) {
  if (!__atomic_load_n(&scr_sa_window, __ATOMIC_ACQUIRE)) scr_plr_reserve();
}

static void scr_plr_heap_stats(size_t *held, size_t *used) {
  size_t h = __atomic_load_n(&scr_plr_held, __ATOMIC_RELAXED);
  size_t w = __atomic_load_n(&scr_plr_waste, __ATOMIC_RELAXED);
  *held = h;
  *used = w < h ? h - w : 0;
}

void *scr_plr_alloc(size_t n) {
  n = (n + 7) & ~(size_t)7;
  char *p = scr_plr_chunk.next;
  if (p && n <= (size_t)(scr_plr_chunk.limit - p)) {
    scr_plr_chunk.next = p + n;
    return p;
  }
  return scr_plr_refill(n);
}
#endif
