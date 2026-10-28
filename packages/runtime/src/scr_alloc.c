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

/* Defined in every build: the emitted fast paths read it (see the layout
 * contract in scr_runtime.h); without the allocator it stays all-zero.
 * Explicitly initialized so it is an ordinary (localizable) definition: a
 * tentative definition becomes a COMMON symbol, which library localization
 * deliberately keeps global (abi.localize_runtime), leaking it from every
 * localized library archive. */
#ifdef SCR_WORKERS
_Thread_local ScrThreadHot scr_thread_hot = {{0}};
#else
ScrSaState scr_sa = {0};
#endif

/* Counts a worker's large blocks (scr_sa_thread_large_note, below). */
#if defined(SCR_WORKERS) && defined(__GLIBC__) && !defined(SCR_LIB)
static void scr_sa_thread_large_note(void);
#define SCR_SA_THREAD_LARGE_NOTE() scr_sa_thread_large_note()
#else
#define SCR_SA_THREAD_LARGE_NOTE() ((void)0)
#endif

#if SCR_SMALL_ALLOC
#include <sys/mman.h>

/* Page policy. Slice pages are committed by first touch, which on 4 KiB
 * pages is one fault (and page clear) per 4 KiB the bump pointers cross.
 * Transparent huge pages fault 2 MiB at a time and shrink the TLB working
 * set, but make the whole 2 MiB page around a bump pointer resident at once,
 * so every class slice in use (per arena, in worker executables) would cost
 * up to 2 MiB more than it holds. A slice therefore starts on small pages
 * and moves the rest of its range to huge pages once it has carved
 * SCR_SA_HUGE_AFTER bytes: only slices that already hold that much pay the
 * partial last huge page. The reservation is huge-page aligned so the
 * switch point and every slice start on a huge-page boundary. */
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

/* Core dumps. The reservation is tens of GiB of address space, almost none
 * of it ever touched. A core written to a file skips untouched pages, but a
 * core piped to a handler (a kernel.core_pattern of "|...", such as apport
 * or systemd-coredump) carries every page of a dumped mapping, untouched
 * ones as zeros, and RLIMIT_CORE does not bound it: an aborting program
 * would take seconds to minutes to die. The reservation is therefore mapped
 * MADV_DONTDUMP, and whenever the slow path raises a slice's bump limit,
 * the slice up to that limit becomes dumpable again (scr_sa_dumpable), so a
 * core still holds every carved block. Without pre-faulting, limits advance
 * in bounded steps for this (SCR_SA_DUMP_STEP on small pages, one huge page
 * past the switch point). The dumpable part ends on a grid that coarsens as
 * the slice grows (scr_sa_dump_edge): its untouched tail is at most
 * SCR_SA_DUMP_GRAIN or a quarter of what the slice has carved, and a slice
 * makes a few madvise calls per doubling, not one per step (each takes the
 * mmap lock for writing, which would wait for the pre-fault helper). Grid
 * points are huge-page aligned: a mapping boundary inside a huge page would
 * split it.
 *
 * Every slice a thread opens costs one of those calls, and the threads of a
 * worker executable open hundreds of slices as they start. So they are only
 * made when the kernel would write a core of the process: when
 * kernel.core_pattern starts with '|' or '@' (a handler or a socket, which
 * ignore RLIMIT_CORE), or when RLIMIT_CORE is above 0. Both are read when
 * the reservation is mapped. Otherwise the whole reservation stays
 * MADV_DONTDUMP: a core written after RLIMIT_CORE is raised for the running
 * process (prlimit), or one taken with gdb's gcore, leaves out the slices. */
#if defined(__linux__) && defined(MADV_DONTDUMP)
#define SCR_SA_DUMP 1
#define SCR_SA_DUMP_STEP ((size_t)1 << 20)
#define SCR_SA_DUMP_GRAIN ((size_t)2 << 20) /* a multiple of the page size */
#include <stdio.h>
#include <sys/resource.h>
/* Whether carved slices are made dumpable; set before the reservation is
 * published. */
static bool scr_sa_dump_slices;

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

/* Maps span bytes of address space for slices (huge-page aligned where the
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
  scr_sa_dump_slices = scr_sa_cores_written();
#endif
  return p;
}

#ifdef SCR_SA_DUMP
/* The end of the dumpable part of the class slice [start, end) whose
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

/* The slice [start, end) raised its bump limit from lim to next: makes
 * the memory up to next dumpable (see above). */
static void scr_sa_dumpable(char *start, char *end, char *lim, char *next) {
  char *lo = scr_sa_dump_edge(start, end, lim), *hi = scr_sa_dump_edge(start, end, next);
  if (hi > lo) (void)madvise(lo, (size_t)(hi - lo), MADV_DODUMP);
}
#endif

/* Pre-faulting (Linux executables). First touch of a fresh slice page costs
 * a fault and a page clear on the allocating thread. With pre-faulting the
 * bump limits advance in steps, and each step asks a helper thread to fault
 * in the memory just ahead of it (MADV_POPULATE_WRITE: the kernel commits
 * zeroed pages as for a write, without storing anything, so it cannot race
 * with the owner's carving). The owner still faults any page the helper has
 * not reached; the fast paths are unchanged. Small-page prefixes advance in
 * SCR_SA_PF_STEP chunks and fault one chunk ahead; huge-page ranges advance
 * in half huge pages and fault the next huge page once the bump is in the
 * second half of the current one, so a slice keeps at most about one step
 * of untouched committed memory. Nothing is faulted ahead before a slice
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
 * thread (0 not known yet, 1 main, 2 worker), bytes its slice limits have
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

/* The next bump limit of class c's slice [start, end) whose limit is lim
 * (< end): its small-page prefix ends at SCR_SA_HUGE_AFTER, where the rest
 * of the slice switches to huge pages. Limits advance in steps: the
 * pre-fault steps (see above), or else the core-dump steps (SCR_SA_DUMP). */
static char *scr_sa_extend(unsigned c, char *start, char *lim, char *end) {
  (void)c;
#ifdef SCR_SA_THP
  char *sw = start + SCR_SA_HUGE_AFTER;
  bool tiered = (size_t)(end - start) > SCR_SA_HUGE_AFTER;
#ifdef SCR_SA_PREFAULT
  if (scr_sa_pf_on()) {
    if (!tiered) return end;
    if (lim < sw) {
      char *next = lim + SCR_SA_PF_STEP < sw ? lim + SCR_SA_PF_STEP : sw;
      scr_sa_pf_advance(c, lim, next);
      if (next == sw) {
        /* The last small-page chunk: switch the rest now, so the first huge
         * page can be faulted ahead like every later one. */
        (void)madvise(sw, (size_t)(end - sw), MADV_HUGEPAGE);
        scr_sa_prefault_ahead(c, sw, sw + SCR_SA_HUGE_PAGE < end ? sw + SCR_SA_HUGE_PAGE : end);
      } else if ((size_t)(next - start) >= SCR_SA_PF_START) {
        scr_sa_prefault_ahead(c, next, next + SCR_SA_PF_STEP < sw ? next + SCR_SA_PF_STEP : sw);
      }
      return next;
    }
    char *next = lim + SCR_SA_PF_HUGE_STEP < end ? lim + SCR_SA_PF_HUGE_STEP : end;
    scr_sa_pf_advance(c, lim, next);
    /* Entering the second half of a huge page: fault the next one. */
    if (((uintptr_t)next & (SCR_SA_HUGE_PAGE - 1)) == 0 && next < end)
      scr_sa_prefault_ahead(c, next, next + SCR_SA_HUGE_PAGE < end ? next + SCR_SA_HUGE_PAGE : end);
    return next;
  }
#endif
  if (tiered && lim < sw) {
#ifdef SCR_SA_DUMP
    if ((size_t)(sw - lim) > SCR_SA_DUMP_STEP) return lim + SCR_SA_DUMP_STEP;
#endif
    return sw;
  }
  if (tiered && lim == sw) (void)madvise(sw, (size_t)(end - sw), MADV_HUGEPAGE);
#ifdef SCR_SA_DUMP
  if (tiered && (size_t)(end - lim) > SCR_SA_HUGE_PAGE) return lim + SCR_SA_HUGE_PAGE;
#endif
#else
  (void)start;
#ifdef SCR_SA_DUMP
  if ((size_t)(end - lim) > SCR_SA_DUMP_STEP) return lim + SCR_SA_DUMP_STEP;
#else
  (void)lim;
#endif
#endif
  return end;
}

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

#ifdef SCR_WORKERS
#include <pthread.h>
#include <stdatomic.h>
#if defined(__linux__) && defined(MADV_DONTNEED)
#define SCR_SA_TRIM 1
#include <stdio.h>
#include <time.h>
#include <unistd.h>
#if defined(__GLIBC__)
#include <malloc.h>
#endif
#endif

/* Per-thread arenas (contract in scr_runtime.h). The region is reserved
 * once; arena i spans [region + i * arena_span, + arena_span) and is split
 * into class slices exactly like the single-threaded reservation. */
#define SCR_SA_ARENAS 32u
#define SCR_SA_MIN_ARENAS 4u /* the fewest arenas a limited host gets before smaller slices */
static pthread_mutex_t scr_sa_region_lock = PTHREAD_MUTEX_INITIALIZER;
static _Atomic(uintptr_t) scr_sa_region; /* 0 until reserved */
static uintptr_t scr_sa_arena_span;
static unsigned scr_sa_region_shift;
static unsigned scr_sa_region_arenas; /* arenas the region holds, a power of two */
static bool scr_sa_region_refused;
static _Atomic(uint32_t) scr_sa_claimed;              /* one bit per arena */
static ScrSaState scr_sa_parked[SCR_SA_ARENAS];         /* unowned arenas */
static _Atomic(ScrSaBlock *) scr_sa_remote[SCR_SA_ARENAS]; /* foreign frees */
static _Thread_local int scr_sa_arena = -1;
static _Thread_local bool scr_sa_refused; /* this thread got no arena */
_Static_assert(SCR_SA_ARENAS <= 32, "one claim bit per arena");

static bool scr_sa_reserve_region(void) {
  pthread_mutex_lock(&scr_sa_region_lock);
  if (!atomic_load_explicit(&scr_sa_region, memory_order_acquire) && !scr_sa_region_refused) {
    /* Same per-class slice ladder as the single-threaded reservation, for
     * every arena at once. A host that limits address space (valgrind maps
     * at most 56 GiB) gets fewer arenas before smaller slices, down to
     * SCR_SA_MIN_ARENAS, and fewer still only when no slice size fits that
     * many. A slice that fills falls back to the system, so with smaller
     * slices a program that keeps many objects of one class makes system
     * allocations that a run with full slices does not, and a profile taken
     * under the limit counts them. At least SCR_SA_MIN_ARENAS arenas are
     * kept because threads claim them in the order they first allocate:
     * the main thread keeps its arena, and a thread that starts later reuses
     * one that another thread parked. Threads beyond the arenas reserved use
     * the system allocator. */
    for (unsigned least = SCR_SA_MIN_ARENAS; least >= 1 && !scr_sa_region_arenas; least /= 2) {
      for (unsigned shift = 30; shift >= 22 && !scr_sa_region_arenas; shift -= 2) {
        for (unsigned arenas = least == SCR_SA_MIN_ARENAS ? SCR_SA_ARENAS : least; arenas >= least;
             arenas /= 2) {
          size_t arena = (size_t)SCR_SA_NCLASS << shift;
          void *p = scr_sa_map(arena * arenas);
          if (!p) continue;
          scr_sa_arena_span = arena;
          scr_sa_region_shift = shift;
          scr_sa_region_arenas = arenas;
          /* The arenas that were not reserved stay claimed. */
          if (arenas < SCR_SA_ARENAS)
            atomic_fetch_or_explicit(&scr_sa_claimed, ~((1u << arenas) - 1u), memory_order_relaxed);
          atomic_store_explicit(&scr_sa_region, (uintptr_t)p, memory_order_release);
          break;
        }
      }
    }
    if (!atomic_load_explicit(&scr_sa_region, memory_order_relaxed)) scr_sa_region_refused = true;
  }
  pthread_mutex_unlock(&scr_sa_region_lock);
  return atomic_load_explicit(&scr_sa_region, memory_order_acquire) != 0;
}

#ifdef SCR_SA_TRIM
/* The arena's carved bytes when the current thread claimed it (see
 * scr_sa_trim). */
static size_t scr_sa_claim_carved[SCR_SA_ARENAS];
static size_t scr_sa_carved(void);
/* A worker thread's memory, discarded when it parks (see "Discarding a
 * worker's memory" below). */
typedef struct ScrSaKeep ScrSaKeep;
static _Thread_local bool scr_sa_worker;    /* set by scr_sa_thread_starting */
static _Thread_local ScrSaKeep *scr_sa_keep; /* while the worker's memory is kept apart */
static void scr_sa_keep_begin(unsigned i);
static void scr_sa_keep_drained(ScrSaKeep *k, ScrSaBlock *b, unsigned c);
static bool scr_sa_drain(void);
static bool scr_sa_drain_some(bool one);
#endif

/* Moves every block other threads freed into this arena's free lists. */
static void scr_sa_drain_remote(void) {
  ScrSaBlock *b = atomic_exchange_explicit(&scr_sa_remote[scr_sa_arena], NULL, memory_order_acquire);
  while (b) {
    ScrSaBlock *next = b->next;
    unsigned c = (unsigned)(((uintptr_t)b - scr_sa.base) >> scr_sa.shift);
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
  if (!atomic_load_explicit(&scr_sa_region, memory_order_acquire) && !scr_sa_reserve_region()) {
    scr_sa_refused = true;
    return false;
  }
  uintptr_t region = atomic_load_explicit(&scr_sa_region, memory_order_acquire);
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
        memset(&scr_sa, 0, sizeof scr_sa);
        scr_sa.base = region + (uintptr_t)i * scr_sa_arena_span;
        scr_sa.span = scr_sa_arena_span;
        scr_sa.shift = scr_sa_region_shift;
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
 * the arena carves before the slice's own frontier: the bump fast paths
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

/* Bytes carved from the calling thread's slices: up to each frontier. */
static size_t scr_sa_carved(void) {
  size_t carved = 0;
  for (unsigned c = 0; c < SCR_SA_NCLASS; c++) {
    if (!scr_sa.lim[c]) continue;
    const ScrSaHoles *h = &scr_sa_holes[scr_sa_arena][c];
    char *top = h->lim ? h->bump : scr_sa.bump[c];
    carved += (size_t)(top - ((char *)scr_sa.base + ((size_t)c << scr_sa.shift)));
  }
  return carved;
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

/* Returns the pages of class c that hold only free blocks (see above). */
static void scr_sa_trim_class(unsigned c, size_t page) {
  ScrSaHoles *h = &scr_sa_holes[scr_sa_arena][c];
  size_t sz = scr_sa_class_size(c);
  char *start = (char *)scr_sa.base + ((size_t)c << scr_sa.shift);
  /* Close the region being carved: its rest is still zero. */
  if (h->lim) {
    char *lo = scr_sa.bump[c], *hi = scr_sa.lim[c];
    scr_sa.bump[c] = h->bump;
    scr_sa.lim[c] = h->lim;
    h->bump = h->lim = NULL;
    if ((size_t)(hi - lo) >= sz && !scr_sa_push_run(h, lo, hi)) return;
  }
  char *top = scr_sa.bump[c];
  size_t nblocks = (size_t)(top - start) / sz;
  if (!nblocks) return;
  size_t words = (nblocks + 63) / 64;
  uint64_t *bits = mmap(NULL, words * 8, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANON, -1, 0);
  if (bits == MAP_FAILED) return;
  size_t nfree = 0;
  for (ScrSaBlock *b = scr_sa.free[c]; b; b = b->next) {
    size_t k = (size_t)((char *)b - start) / sz;
    bits[k / 64] |= (uint64_t)1 << (k % 64);
    nfree++;
  }
  /* Uncarved zeroed regions count as free; they are rebuilt below. */
  for (size_t r = 0; r < h->n; r++) {
    for (char *q = h->runs[r].lo; q + sz <= h->runs[r].hi; q += sz) {
      size_t k = (size_t)(q - start) / sz;
      bits[k / 64] |= (uint64_t)1 << (k % 64);
    }
  }
  scr_sa_trim_stats[0] += nblocks * sz;
  scr_sa_trim_stats[1] += nfree * sz;
#define SCR_SA_BIT(k) ((bits[(k) / 64] >> ((k) % 64)) & 1)
  /* Whole pages below the frontier whose blocks are all free. */
  uintptr_t first = ((uintptr_t)start + page - 1) & ~(uintptr_t)(page - 1);
  uintptr_t last = (uintptr_t)top & ~(uintptr_t)(page - 1);
  h->n = 0;
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
      scr_sa_trim_stats[2] += (size_t)((char *)pg - run);
      /* Blocks wholly inside the returned pages carve from it later. */
      char *lo = start + ((size_t)(run - start) + sz - 1) / sz * sz;
      char *hi = start + ((size_t)((char *)pg - start) / sz) * sz;
      if (hi > lo) (void)scr_sa_push_run(h, lo, hi);
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
  /* The remaining free blocks, in address order. */
  ScrSaBlock *head = NULL, **tail = &head;
  for (size_t w = 0; w < words; w++) {
    for (uint64_t m = bits[w]; m; m &= m - 1) {
      size_t k = w * 64 + (size_t)__builtin_ctzll(m);
      ScrSaBlock *b = (ScrSaBlock *)(start + k * sz);
      *tail = b;
      tail = &b->next;
    }
  }
  *tail = NULL;
  scr_sa.free[c] = head;
  munmap(bits, words * 8);
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
  const char *stats = getenv("SCR_SA_STATS");
  const char *off = getenv("SCR_SA_TRIM");
  bool trim = free_bytes >= SCR_SA_TRIM_MIN && !(off && off[0] == '0');
  memset(scr_sa_trim_stats, 0, sizeof scr_sa_trim_stats);
  if (!trim && stats && stats[0] == '1')
    for (unsigned c = 0; c < SCR_SA_NCLASS; c++) {
      if (!scr_sa.lim[c]) continue;
      size_t sz = scr_sa_class_size(c);
      char *start = (char *)scr_sa.base + ((size_t)c << scr_sa.shift);
      scr_sa_trim_stats[0] += (size_t)(scr_sa.bump[c] - start);
      for (ScrSaBlock *b = scr_sa.free[c]; b; b = b->next) scr_sa_trim_stats[1] += sz;
    }
  if (trim) {
    long page = sysconf(_SC_PAGESIZE);
    for (unsigned c = 0; c < SCR_SA_NCLASS; c++)
      if (scr_sa.lim[c]) scr_sa_trim_class(c, page > 0 ? (size_t)page : 4096);
  }
#if defined(__GLIBC__)
  /* Large blocks: the system allocator's free pages too. */
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
 *   regions are set aside, and the worker carves only past each slice's
 *   frontier, so its blocks of class c are [start[c], bump[c]), plus the
 *   blocks it takes from the free lists set aside once a slice has no bump
 *   room left, which it records;
 * - the system blocks it allocates (large blocks, an exhausted slice) are
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
  /* Each slice's frontier then (bump and limit, NULL limits for a slice not
   * opened yet), and the first address the worker carves in it. */
  char *front_bump[SCR_SA_NCLASS], *front_lim[SCR_SA_NCLASS];
  char *start[SCR_SA_NCLASS];
  /* The worker's system blocks: an open-addressing set of `cap` slots (a
   * power of two, or 0), NULL for an empty slot and SCR_SA_SYS_GONE for a
   * removed entry; `used` counts both kinds of filled slots. */
  void **sys;
  size_t cap, used, live;
  /* The blocks of the free lists set aside that the worker took once a slice
   * had no bump room left, so that older free blocks are used before the
   * slice grows; they go back to those lists with the worker's memory. */
  ScrSaBlock **taken;
  size_t ntaken, cap_taken;
  bool shared;
  bool poison;
};

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
    /* While the slice carves a returned region, its frontier is kept apart. */
    if (k->holes[c].lim) {
      scr_sa.bump[c] = k->holes[c].bump;
      scr_sa.lim[c] = k->holes[c].lim;
    }
    k->front_bump[c] = scr_sa.bump[c];
    k->front_lim[c] = scr_sa.lim[c];
    k->start[c] = scr_sa.lim[c] ? scr_sa.bump[c] : (char *)scr_sa.base + ((size_t)c << scr_sa.shift);
  }
  scr_sa_keep = k;
}

/* A remote free of class c, drained while the worker keeps its memory
 * apart: one of its own blocks makes it share; an older block goes to the
 * free lists set aside. Once the worker has taken blocks from those lists,
 * any older block might be one of them, so it shares as well. */
static void scr_sa_keep_drained(ScrSaKeep *k, ScrSaBlock *b, unsigned c) {
  if ((char *)b >= k->start[c] && (char *)b < scr_sa.bump[c]) {
    k->shared = true;
    b->next = scr_sa.free[c];
    scr_sa.free[c] = b;
  } else {
    if (k->ntaken) k->shared = true;
    b->next = k->free[c];
    k->free[c] = b;
  }
}

/* A block of class c from the free lists set aside, for a worker whose
 * slice has no bump room left; NULL when there is none or it cannot be
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
    if (lim && top > lo) {
      char *first = (char *)(((uintptr_t)lo + page - 1) & ~(page - 1));
      char *used = (char *)(((uintptr_t)top + page - 1) & ~(page - 1));
      /* The part of a page that may also hold older blocks. */
      if (first > lo) memset(lo, 0, (size_t)((first < top ? first : top) - lo));
      if (k->poison) {
        if (used > first) (void)mprotect(first, (size_t)(used - first), PROT_NONE);
        bump = used > first ? used : top;
        limit = lim > bump ? lim : bump;
      } else {
        char *end = (char *)(((uintptr_t)lim + page - 1) & ~(page - 1));
        if (end > first) {
          (void)madvise(first, (size_t)(end - first), MADV_DONTNEED);
          returned += (size_t)(end - first);
        }
      }
    } else {
      bump = top;
      limit = lim;
    }
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
      unsigned c = (unsigned)(((uintptr_t)b - scr_sa.base) >> scr_sa.shift);
      b->next = scr_sa.free[c];
      scr_sa.free[c] = b;
    }
  if (!k->poison)
    for (size_t s = 0; s < k->cap; s++) {
      void *p = k->sys[s];
      if (!p || p == SCR_SA_SYS_GONE) continue;
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
  memset(&scr_sa, 0, sizeof scr_sa);
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

void scr_sa_loop_waiting(bool waiting) {
  if (scr_sa_worker) return;
  unsigned long turns = atomic_load_explicit(&scr_sa_loop_turns, memory_order_relaxed);
  if ((bool)(turns & 1) != waiting) atomic_store_explicit(&scr_sa_loop_turns, turns + 1, memory_order_relaxed);
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
/* Returns the pages past each slice's frontier that a parking thread leaves
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
    char *end = (char *)scr_sa.base + ((size_t)(c + 1) << scr_sa.shift);
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
    memset(&scr_sa, 0, sizeof scr_sa);
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
      memset(&scr_sa, 0, sizeof scr_sa);
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
  memset(&scr_sa, 0, sizeof scr_sa);
  scr_sa_arena = -1;
  scr_sa_refused = true;
  atomic_fetch_and_explicit(&scr_sa_claimed, ~(1u << i), memory_order_release);
}

/* The class size of a block in another thread's arena, or 0 outside the
 * region (a system block). */
static size_t scr_sa_foreign_size(const void *p) {
  uintptr_t region = atomic_load_explicit(&scr_sa_region, memory_order_acquire);
  uintptr_t off = (uintptr_t)p - region;
  if (!region || off >= scr_sa_arena_span * scr_sa_region_arenas) return 0;
  return scr_sa_class_size((unsigned)((off % scr_sa_arena_span) >> scr_sa_region_shift));
}

void scr_sa_free_foreign(void *p) {
#ifdef SCR_SA_TRIM
  if (scr_sa_discarded) return; /* the block went back with the thread's memory */
#endif
  uintptr_t region = atomic_load_explicit(&scr_sa_region, memory_order_acquire);
  uintptr_t off = (uintptr_t)p - region;
  if (region && off < scr_sa_arena_span * scr_sa_region_arenas) {
    unsigned i = (unsigned)(off / scr_sa_arena_span);
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

/* Reserve address space for every class slice at once; smaller slices are
 * tried when the host limits address space or overcommit. */
static bool scr_sa_reserve(void) {
  for (unsigned shift = 30; shift >= 24; shift -= 2) {
    size_t span = (size_t)SCR_SA_NCLASS << shift;
    void *p = scr_sa_map(span);
    if (!p) continue;
    scr_sa.base = (uintptr_t)p;
    scr_sa.shift = shift;
    scr_sa.span = span;
    return true;
  }
  scr_sa_refused = true;
  return false;
}
#endif /* SCR_WORKERS */

/* Runs once per class (to reserve and open its slice) and then only for
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
     * blocks before its slice grows. */
    if (scr_sa_keep && (size_t)(scr_sa.lim[c] - scr_sa.bump[c]) < scr_sa_class_size(c) &&
        (b = scr_sa_keep_take(scr_sa_keep, c)) != NULL) {
      if (zero) memset(b, 0, n);
      return b;
    }
#endif
#endif
    /* Carve from the slice, opening it or raising its limit as needed;
     * fresh pages are zero. */
    size_t sz = scr_sa_class_size(c);
#ifdef SCR_SA_TRIM
    if (scr_sa.lim[c]) scr_sa_next_hole(c, sz);
#endif
    char *start = (char *)scr_sa.base + ((size_t)c << scr_sa.shift);
    char *end = start + ((size_t)1 << scr_sa.shift);
    char *p = scr_sa.lim[c] ? scr_sa.bump[c] : start;
    char *lim = scr_sa.lim[c] ? scr_sa.lim[c] : start;
#ifdef SCR_SA_DUMP
    char *from = lim;
#endif
    while ((size_t)(lim - p) < sz && lim < end) lim = scr_sa_extend(c, start, lim, end);
#ifdef SCR_SA_DUMP
    if (lim > from && scr_sa_dump_slices) scr_sa_dumpable(start, end, from, lim);
#endif
    scr_sa.lim[c] = lim;
    if ((size_t)(lim - p) >= sz) {
      scr_sa.bump[c] = p + sz;
      return p;
    }
    scr_sa.bump[c] = p;
  }
  /* Large or zero-sized, an exhausted slice, or no reservation. */
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

void *scr_mem_realloc(void *p, size_t n) {
  if (!p) return scr_mem_alloc(n);
  uintptr_t off = (uintptr_t)p - scr_sa.base;
  size_t have;
  if (off < scr_sa.span) have = scr_sa_class_size((unsigned)(off >> scr_sa.shift));
#ifdef SCR_WORKERS
  else if ((have = scr_sa_foreign_size(p)) != 0) {
    /* Another arena's block: move it into this thread's allocator. */
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

void *scr_rt_calloc(size_t n) { return scr_mem_calloc(n); }
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
 * The pointers are marked in a bitmap of block indices per class, over the
 * range of blocks they span, and read back from the highest block down.
 * That takes one bit per block in that range, at most one per block in
 * use, and reading the bitmaps back costs a step per word; a set spread so
 * thinly that they would take more than SCR_SA_ORDER_SPARSE words per
 * pointer is left as it is. Pointers outside the reservation, not at
 * `offset` in a block, or repeated, come first, in the order they had. */
#define SCR_SA_ORDER_SPARSE 8

#if SCR_SMALL_ALLOC
/* The class and block index of a pointer `off` bytes past the reservation
 * base plus the block offset, if it is at that offset in a block. Slices
 * span at most 1 << 30 bytes, so an offset within one fits in 32 bits. */
static inline bool scr_sa_order_block(uintptr_t off, uintptr_t span, unsigned shift,
                                      const uint32_t *size, unsigned *c, uint32_t *idx) {
  if (off >= span) return false;
  *c = (unsigned)(off >> shift);
  uint32_t in = (uint32_t)(off & (((uintptr_t)1 << shift) - 1));
  *idx = in / size[*c];
  return in == *idx * size[*c];
}
#endif

void scr_mem_order_for_free(void **ptrs, size_t n, size_t offset) {
#if SCR_SMALL_ALLOC
  if (n < 2 || !scr_sa.span) return;
  uintptr_t base = scr_sa.base + offset, span = scr_sa.span;
  unsigned shift = scr_sa.shift, c;
  uint32_t idx;
  uint32_t size[SCR_SA_NCLASS], lo[SCR_SA_NCLASS], hi[SCR_SA_NCLASS];
  size_t at[SCR_SA_NCLASS], words = 0;
  for (c = 0; c < SCR_SA_NCLASS; c++) {
    size[c] = (uint32_t)scr_sa_class_size(c);
    lo[c] = UINT32_MAX;
    hi[c] = 0;
  }
  for (size_t i = 0; i < n; i++) {
    if (!scr_sa_order_block((uintptr_t)ptrs[i] - base, span, shift, size, &c, &idx)) continue;
    if (idx < lo[c]) lo[c] = idx;
    if (idx > hi[c]) hi[c] = idx;
  }
  for (c = 0; c < SCR_SA_NCLASS; c++) {
    at[c] = words;
    if (lo[c] <= hi[c]) words += hi[c] / 64 - lo[c] / 64 + 1;
  }
  if (words == 0 || words / SCR_SA_ORDER_SPARSE > n) return;
  uint64_t *bits = calloc(words, sizeof *bits);
  if (!bits) return; /* the order only affects performance */
  size_t k = 0;
  for (size_t i = 0; i < n; i++) {
    void *p = ptrs[i];
    if (scr_sa_order_block((uintptr_t)p - base, span, shift, size, &c, &idx)) {
      uint64_t *word = &bits[at[c] + idx / 64 - lo[c] / 64], bit = (uint64_t)1 << (idx % 64);
      if (!(*word & bit)) {
        *word |= bit;
        continue;
      }
    }
    ptrs[k++] = p;
  }
  for (c = 0; c < SCR_SA_NCLASS; c++) {
    if (lo[c] > hi[c]) continue;
    char *first = (char *)base + ((uintptr_t)c << shift) + (size_t)(lo[c] / 64) * 64 * size[c];
    for (size_t w = hi[c] / 64 - lo[c] / 64 + 1; w-- > 0;) {
      uint64_t word = bits[at[c] + w];
      while (word) {
        unsigned b = 63 - (unsigned)__builtin_clzll(word);
        word &= ~((uint64_t)1 << b);
        ptrs[k++] = first + (w * 64 + b) * size[c];
      }
    }
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
 * slices (the bytes carved from them; in use is that less the blocks on
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
    char *start = (char *)scr_sa.base + ((size_t)c << scr_sa.shift);
    char *top = scr_sa.bump[c];
#ifdef SCR_SA_TRIM
    const ScrSaHoles *h = &scr_sa_holes[scr_sa_arena][c];
    if (h->lim) {
      top = h->bump;
      idle += (size_t)(scr_sa.lim[c] - scr_sa.bump[c]);
    }
    for (size_t i = 0; i < h->n; i++) idle += (size_t)(h->runs[i].hi - h->runs[i].lo);
#endif
    held += (size_t)(top - start);
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
 * size-class slices keep freed blocks on their class's free list, which only
 * later blocks of the same class reuse, so a program whose next phase
 * allocates other sizes would otherwise grow its resident memory on top of
 * the freed heap. */
#if defined(__GLIBC__) && !defined(SCR_HEAP_SANITIZER)
#include <malloc.h>
#endif
#if SCR_SMALL_ALLOC && !defined(SCR_WORKERS) && defined(__linux__) && defined(MADV_DONTNEED)
#include <sys/mman.h>
#include <unistd.h>

/* Returns the pages of class c's slice below its frontier that hold only
 * free blocks (MADV_DONTNEED), and relinks the class's other free blocks in
 * address order. A block wholly inside a returned page leaves the free list:
 * the class carves new blocks past its frontier instead, and the slice's
 * reservation is far larger than what a program fills. */
static void scr_sa_return_free_pages(unsigned c, size_t page) {
  size_t sz = scr_sa_class_size(c);
  char *start = (char *)scr_sa.base + ((size_t)c << scr_sa.shift);
  char *top = scr_sa.bump[c];
  size_t nblocks = (size_t)(top - start) / sz;
  if (!nblocks || !scr_sa.free[c]) return;
  size_t words = (nblocks + 63) / 64;
  uint64_t *bits = mmap(NULL, words * 8, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANON, -1, 0);
  if (bits == MAP_FAILED) return;
  for (ScrSaBlock *b = scr_sa.free[c]; b; b = b->next) {
    size_t k = (size_t)((char *)b - start) / sz;
    bits[k / 64] |= (uint64_t)1 << (k % 64);
  }
#define SCR_SA_FREE_BIT(k) ((bits[(k) / 64] >> ((k) % 64)) & 1)
  /* Mark the returned pages' blocks by clearing their bits after the
   * madvise; a page is returned when every block overlapping it is free. */
  uintptr_t first = ((uintptr_t)start + page - 1) & ~(uintptr_t)(page - 1);
  uintptr_t last = (uintptr_t)top & ~(uintptr_t)(page - 1);
  char *run = NULL;
  for (uintptr_t pg = first; pg <= last; pg += page) {
    bool empty = false;
    if (pg < last) {
      size_t k0 = (size_t)((char *)pg - start) / sz;
      size_t k1 = (size_t)((char *)pg + page - 1 - start) / sz;
      if (k1 >= nblocks) k1 = nblocks - 1;
      empty = true;
      for (size_t k = k0; k <= k1 && empty; k++) empty = SCR_SA_FREE_BIT(k);
    }
    if (empty && !run) run = (char *)pg;
    if (!empty && run) {
      (void)madvise(run, (size_t)((char *)pg - run), MADV_DONTNEED);
      /* Blocks wholly inside the returned pages are dropped. */
      size_t k0 = ((size_t)(run - start) + sz - 1) / sz;
      size_t k1 = (size_t)((char *)pg - start) / sz;
      for (size_t k = k0; k < k1 && (char *)start + (k + 1) * sz <= (char *)pg; k++)
        bits[k / 64] &= ~((uint64_t)1 << (k % 64));
      run = NULL;
    }
  }
  /* The kept free blocks, in address order. */
  ScrSaBlock *head = NULL, **tail = &head;
  for (size_t w = 0; w < words; w++)
    for (uint64_t m = bits[w]; m; m &= m - 1) {
      ScrSaBlock *b = (ScrSaBlock *)(start + (w * 64 + (size_t)__builtin_ctzll(m)) * sz);
      *tail = b;
      tail = &b->next;
    }
  *tail = NULL;
  scr_sa.free[c] = head;
#undef SCR_SA_FREE_BIT
  (void)munmap(bits, words * 8);
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
/* References are 32-bit addresses of 8-byte units, so the range ends by
 * SCR_PLR_END. It starts at 4 GiB or above, clear of executables loaded low
 * and their heaps; a refused size is halved down to SCR_PLR_MIN. */
#define SCR_PLR_END ((size_t)32 << 30)
#define SCR_PLR_MIN ((size_t)1 << 30)
/* Past its first SCR_PLR_HUGE_AFTER bytes the range uses transparent huge
 * pages, as the allocator's slices do (SCR_SA_HUGE_AFTER): a large heap of
 * instances takes 512 times fewer page faults and TLB entries, and a small
 * program stays on small pages. */
#define SCR_PLR_HUGE_AFTER ((size_t)8 << 20)

static char *scr_plr_base; /* the range's start, once reserved */
static size_t scr_plr_size;
static size_t scr_plr_top; /* atomic */
/* Bytes of the chunks threads hold, and of the tails they left unused when
 * they moved to a new chunk (scr_heap_stats); atomic. */
static size_t scr_plr_held, scr_plr_waste;
#if defined(SCR_WORKERS) || (defined(SCR_LIB) && defined(SCR_THREAD_INSTANCES))
_Thread_local ScrPlrChunk scr_plr_chunk = {NULL, NULL};
#else
ScrPlrChunk scr_plr_chunk = {NULL, NULL};
#endif

/* Reserves `size` bytes at `at` exactly; NULL if refused. */
static char *scr_plr_map(void *at, size_t size) {
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
  return p;
}

static __attribute__((noinline)) void scr_plr_reserve(void) {
  static char lock;
  while (__atomic_test_and_set(&lock, __ATOMIC_ACQUIRE)) {
  }
  if (!__atomic_load_n(&scr_plr_base, __ATOMIC_ACQUIRE)) {
    char *p = NULL;
    size_t size = 0;
    for (size_t start = (size_t)4 << 30; !p && start <= (size_t)16 << 30; start *= 2) {
      size = SCR_PLR_END - start;
      while (size >= SCR_PLR_MIN && !(p = scr_plr_map((void *)start, size))) size /= 2;
    }
    if (p) {
#ifdef MADV_HUGEPAGE
      (void)madvise(p + SCR_PLR_HUGE_AFTER, size - SCR_PLR_HUGE_AFTER, MADV_HUGEPAGE);
#endif
      scr_plr_size = size;
      /* The first chunk is never handed out, so every chunk is
       * page-aligned. */
      __atomic_store_n(&scr_plr_top, SCR_PLR_CHUNK, __ATOMIC_RELAXED);
      __atomic_store_n(&scr_plr_base, p, __ATOMIC_RELEASE);
    }
  }
  __atomic_clear(&lock, __ATOMIC_RELEASE);
  /* scr_trap is the runtime's failure path (scr_exception.c); the
   * allocator's standalone test defines its own (scr_alloc.test.c). */
  if (!scr_plr_base) {
    static const char message[] =
        "scriptc: cannot reserve address space below 32 GiB for program-lifetime objects\n";
    scr_trap(message);
  }
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
  if (!__atomic_load_n(&scr_plr_base, __ATOMIC_ACQUIRE)) scr_plr_reserve();
  size_t need = n + SCR_PLR_LINK;
  size_t chunk =
      need > SCR_PLR_CHUNK ? (need + SCR_PLR_CHUNK - 1) & ~(SCR_PLR_CHUNK - 1) : SCR_PLR_CHUNK;
  char *p = NULL;
#ifdef SCR_SA_TRIM
  if (chunk == SCR_PLR_CHUNK) p = scr_plr_reuse();
#endif
  if (!p) {
    size_t at = __atomic_fetch_add(&scr_plr_top, chunk, __ATOMIC_RELAXED);
    if (at + chunk > scr_plr_size || at + chunk < at) {
      static const char message[] = "scriptc: out of address space for program-lifetime objects\n";
      scr_trap(message);
    }
    p = scr_plr_base + at;
  }
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
  if (!__atomic_load_n(&scr_plr_base, __ATOMIC_ACQUIRE)) scr_plr_reserve();
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
