/* Async runtime: stackful fibers, promises, and a dependency-free event
 * loop (microtask queue + timer min-heap).
 *
 * Model (see docs/ir.md):
 * - An async function's body is ordinary compiled C, run on its own fiber
 *   (dedicated stack). Calling it runs the body EAGERLY until
 *   the first suspension (JS's synchronous-prefix rule), then control
 *   returns to the spawner with a +1 promise.
 * - `await` on a pending promise parks the fiber on the promise's waiter
 *   list and switches back to whoever resumed it. Fulfillment moves waiters
 *   to the microtask queue (microtasks run before timers, like Node).
 * - Each fiber carries its own exception cell (scr_exc_swap_cell) so a
 *   pending exception can't leak across concurrent execution contexts. A
 *   throw escaping an async body rejects its promise; awaiting a rejected
 *   promise re-throws into the awaiter.
 * - Loop exhaustion with still-suspended fibers exits normally (Node's
 *   behavior); those stacks are deliberately not unwound, and the RC audit
 *   downgrades to a note in that case.
 */
#define _XOPEN_SOURCE 700
/* Anonymous mappings alongside the XSI ucontext API on Darwin and glibc. */
#ifndef _DARWIN_C_SOURCE
#define _DARWIN_C_SOURCE 1
#endif
#ifndef _DEFAULT_SOURCE
#define _DEFAULT_SOURCE 1
#endif
#include "scr_runtime.h"

#include <errno.h>
#include <fcntl.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#ifdef _WIN32
/* Windows arm: fibers come from the Win32 Fibers API (CreateFiberEx /
 * SwitchToFiber — the direct ucontext analog: cooperatively scheduled,
 * same thread, own stack); the idle sleep is nanosleep (mingw-w64 ships
 * it, over Sleep). poll(2) has no Windows arm — see the sleep seam in
 * scr_loop_run: the poller-backed units (net/dgram/watch) are not built
 * for win32 targets (native-toolchain.ts gates them), so their fds never appear; the
 * events unit DOES cross-compile (scr_events.c's win32 arm) and is
 * served by a capped nanosleep — dispatch at the next turn's top, the
 * cap bounding signal/stdin latency instead of a pollable wake fd. */
#include <windows.h>
#elif defined(__wasi__)
#include <poll.h>
#else
#include <poll.h>
#include <pthread.h>
#include <signal.h>
#include <sys/mman.h>
#include <ucontext.h>
#include <unistd.h>
#endif

#if defined(__has_feature)
#if __has_feature(address_sanitizer)
#define SCR_ASAN_FIBERS 1
void __sanitizer_start_switch_fiber(void **fake_stack_save, const void *bottom, size_t size);
void __sanitizer_finish_switch_fiber(void *fake_stack_save, const void **bottom_old, size_t *size_old);
/* LeakSanitizer scans thread stacks, not the mapped fiber stacks, so a
 * suspended fiber's locals would look unreferenced at exit. Each stack is
 * a root region while it exists. Weak: platforms whose ASan runtime has
 * no leak checker leave them NULL. */
void __lsan_register_root_region(const void *p, size_t size) __attribute__((weak));
void __lsan_unregister_root_region(const void *p, size_t size) __attribute__((weak));
#endif
#endif


#if !defined(_WIN32) && !defined(__wasi__)
/* Keep stacks out of malloc's size classes. Reuse a bounded number of
 * finished stacks, which avoids both heap fragmentation and per-call mmap
 * overhead. A server's loop sleeps between nearly every pair of requests,
 * so unmapping the spares at each sleep would map, fault in and unmap a
 * stack for every request that awaits. Spares therefore outlive short
 * sleeps: at most once per SCR_FIBER_TRIM_MS, a sleep unmaps the spares
 * that no fiber took since the previous trim (the pool's low-water mark),
 * and a sleep longer than twice that unmaps every spare, so an idle
 * program gives the memory back as before. The sanitizer lane unmaps
 * every finished stack immediately. */
#ifndef SCR_ASAN_FIBERS
#define SCR_FIBER_SPARES 64
#define SCR_FIBER_TRIM_MS 1000.0
static SCR_TL void *scr_fiber_spares[SCR_FIBER_SPARES];
static SCR_TL size_t scr_fiber_nspares;
static SCR_TL bool scr_fiber_cleanup_registered;
/* The fewest spares the pool held since the last trim: the spares below
 * this index went unused for the whole window. */
static SCR_TL size_t scr_fiber_spares_low;
static SCR_TL double scr_fiber_trimmed_at;
#endif

static void scr_fiber_stacks_clear(void) {
#ifndef SCR_ASAN_FIBERS
  while (scr_fiber_nspares > 0) {
    (void)munmap(scr_fiber_spares[--scr_fiber_nspares], SCR_FIBER_STACK);
    scr_fiber_spares[scr_fiber_nspares] = NULL;
  }
  scr_fiber_spares_low = 0;
#endif
}

/* The loop is about to sleep for `wait` ms (see above). */
static void scr_fiber_stacks_trim(double now, double wait) {
#ifndef SCR_ASAN_FIBERS
  if (wait > 2 * SCR_FIBER_TRIM_MS) {
    scr_fiber_stacks_clear();
    scr_fiber_trimmed_at = now;
    return;
  }
  if (now - scr_fiber_trimmed_at < SCR_FIBER_TRIM_MS) return;
  size_t unused = scr_fiber_spares_low;
  for (size_t i = 0; i < unused; i++) (void)munmap(scr_fiber_spares[i], SCR_FIBER_STACK);
  scr_fiber_nspares -= unused;
  memmove(scr_fiber_spares, scr_fiber_spares + unused, scr_fiber_nspares * sizeof *scr_fiber_spares);
  memset(scr_fiber_spares + scr_fiber_nspares, 0, unused * sizeof *scr_fiber_spares);
  scr_fiber_spares_low = scr_fiber_nspares;
  scr_fiber_trimmed_at = now;
#else
  (void)now;
  (void)wait;
#endif
}

static void *scr_fiber_stack_new(void) {
#ifndef SCR_ASAN_FIBERS
  if (scr_fiber_nspares > 0) {
    void *stack = scr_fiber_spares[--scr_fiber_nspares];
    scr_fiber_spares[scr_fiber_nspares] = NULL;
    if (scr_fiber_nspares < scr_fiber_spares_low) scr_fiber_spares_low = scr_fiber_nspares;
    return stack;
  }
  if (!scr_fiber_cleanup_registered) {
    scr_fiber_cleanup_registered = true;
    scr_atexit(scr_fiber_stacks_clear);
  }
#endif
  void *stack = mmap(NULL, SCR_FIBER_STACK, PROT_READ | PROT_WRITE,
                    MAP_PRIVATE | MAP_ANON, -1, 0);
  if (stack == MAP_FAILED) scr_trap("scriptc: out of memory\n");
#ifdef SCR_ASAN_FIBERS
  if (__lsan_register_root_region) __lsan_register_root_region(stack, SCR_FIBER_STACK);
#endif
  return stack;
}

static void scr_fiber_stack_free(void *stack) {
  if (!stack) return;
#ifndef SCR_ASAN_FIBERS
  if (scr_fiber_nspares < SCR_FIBER_SPARES) {
    scr_fiber_spares[scr_fiber_nspares++] = stack;
    return;
  }
#endif
#ifdef SCR_ASAN_FIBERS
  if (__lsan_unregister_root_region) __lsan_unregister_root_region(stack, SCR_FIBER_STACK);
#endif
  (void)munmap(stack, SCR_FIBER_STACK);
}
#endif

/* ── promises ─────────────────────────────────────────────────────────── */

enum { SCR_PROM_PENDING = 0, SCR_PROM_FULFILLED = 1, SCR_PROM_REJECTED = 2 };

#define SCR_CB_SYNC SIZE_MAX
#define SCR_CB_BATCH (SIZE_MAX - 1)

typedef struct ScrFiber ScrFiber;

typedef struct { size_t rc; } ScrPromiseIdentity;

struct ScrPromise {
  size_t rc; /* The cycle collector reads the reference count at offset zero. */
  /* Shared identity cell for promises adopted across inner types (NULL
   * until scr_promise_share_identity first links this promise). */
  ScrPromiseIdentity *identity;
  int state;
  bool top_level_handled; /* uncaughtException handled entry evaluation */
  /* Unhandled-rejection tracking: set when rejected, cleared on await. */
  bool rejection_observed;
  /* Set when the checkpoint report delivered THIS promise to
   * 'unhandledRejection' listeners — a handler attached after that is
   * Node's 'rejectionHandled' moment (scr_prom_observe below). */
  bool reported_unhandled;
  bool b; /* the boolean payload */
  /* Payload (fulfillment value or rejection reason), ScrExcCell-style.
   * trace_fn is non-NULL iff the REF payload type carries a cycle header
   * (a promise settled with a cycle-capable value can be a cycle member —
   * e.g. a closure that captures a box holding this very promise). */
  ScrExcKind payload_kind; /* NONE = void fulfillment */
  double f64;
  void *payload;
  void *(*retain_fn)(void *);
  void (*release_fn)(void *);
  ScrTraceFn trace_fn;
  /* Fibers parked on this promise. */
  ScrFiber **waiters; /* waiter_inline until a second fiber parks */
  size_t nwaiters, waiters_cap;
  ScrFiber *waiter_inline;
  /* Callback waiters: fulfilled promises run adapt(dst, this) — an
   * emitted adapter converting the payload into the destination's inner
   * type — and rejections copy raw (reasons are dynamically tagged). Each
   * entry owns a reference on its dst. Promise.all entries carry the
   * shared countdown state (`all` non-NULL, `all_idx` the entry's INPUT
   * index); the others leave both zeroed and keep the adapt dispatch.
   * Combinator entries (Promise.all / Promise.race) are reaction jobs:
   * `job_at` is the number of waiters parked before the entry subscribed,
   * so settlement queues the job in subscription order among the waking
   * fibers. Conversions (SCR_CB_SYNC) run inside the settle itself. */
  struct ScrPromiseCbWaiter {
    void (*adapt)(ScrPromise *dst, ScrPromise *src);
    ScrPromise *dst;
    struct ScrAllState *all;
    size_t all_idx;
    size_t job_at;
  } *cbs;
  size_t ncbs, cbs_cap;
};
/* The flags share the word after `state`, so a promise and its cycle header
 * take a 144-byte block rather than a 160-byte one (one per pending
 * `await`). */
#if UINTPTR_MAX == UINT64_MAX
_Static_assert(sizeof(ScrPromise) == 128, "ScrPromise packs its flags after state");
#endif

#ifdef SCR_RC_AUDIT
static SCR_TL long scr_live_promises = 0;
long scr_promise_live_count(void) { return scr_live_promises; }
#endif

/* ── Promise.all shared state ─────────────────────────────────────────
 * One per Promise.all call: the values array filled per INPUT index as
 * entries fulfill, the countdown of fulfillments still missing, and the
 * per-element-kind store helper. The state holds +1 on `values` (NULL for
 * void-element all) and is itself refcounted by the entries that still
 * point at it (parked cb waiters plus the builder while it subscribes);
 * the RESULT promise is NOT held here — each parked entry's cb.dst is the
 * retained result, so promise teardown paths need no all-specific
 * destination handling. */
typedef struct ScrAllState {
  size_t rc;
  size_t remaining;
  ScrArr *values;
  ScrAllStore store;
  int mode;        /* SCR_COMBINE_* */
  ScrAnyFail fail; /* Promise.any's exhaustion (rejects the result) */
} ScrAllState;

static void scr_promise_all_state_release(ScrAllState *st) {
  if (--st->rc == 0) {
    if (st->values) scr_arr_release(st->values);
    scr_mem_free(st);
  }
}

static void scr_oom(void) {
  fputs("scriptc: out of memory\n", stderr);
  abort();
}

static void scr_promise_free_side(ScrPromise *p) {
  if (p->identity && --p->identity->rc == 0) free(p->identity);
  /* Most promises never park a fiber or a second waiter: skip the calls. */
  if (p->waiters && p->waiters != &p->waiter_inline) free(p->waiters);
}

static void scr_promise_add_waiter(ScrPromise *p, ScrFiber *f) {
  if (p->nwaiters == p->waiters_cap) {
    if (p->waiters_cap == 0) {
      p->waiters = &p->waiter_inline;
      p->waiters_cap = 1;
    } else {
      size_t cap = p->waiters_cap < 4 ? 4 : p->waiters_cap * 2;
      ScrFiber **grown = p->waiters == &p->waiter_inline
                             ? malloc(cap * sizeof *grown)
                             : realloc(p->waiters, cap * sizeof *grown);
      if (!grown) scr_oom();
      if (p->waiters == &p->waiter_inline) grown[0] = p->waiter_inline;
      p->waiters = grown;
      p->waiters_cap = cap;
    }
  }
  p->waiters[p->nwaiters++] = f;
}

static bool scr_promise_has_traced_children(const ScrPromise *p) {
  return p->ncbs != 0 ||
         ((p->payload_kind == SCR_EXC_REF || p->payload_kind == SCR_EXC_OBJ ||
           p->payload_kind == SCR_EXC_PRIMITIVE_REF) &&
          p->trace_fn && p->payload);
}

static void scr_promise_trace(void *o, ScrTraceVisit visit, void *ctx) {
  ScrPromise *p = (ScrPromise *)o;
  /* Waiters are fibers (not refcounted objects) — the settled payload and
   * the combinator destinations are the strong references this promise
   * owns (destination promises are cycle-headered). */
  if ((p->payload_kind == SCR_EXC_REF || p->payload_kind == SCR_EXC_OBJ ||
       p->payload_kind == SCR_EXC_PRIMITIVE_REF) &&
      p->trace_fn) {
    visit(p->payload, ctx);
  }
  for (size_t i = 0; i < p->ncbs; i++) visit(p->cbs[i].dst, ctx);
}

/* Teardown for the collector: release the payload only when the trace does
 * NOT visit it (the complement — see the contract in scr_runtime.h). The
 * cb destinations are always visited, so only the array frees here. */
static void scr_promise_gcfree(void *o) {
  ScrPromise *p = (ScrPromise *)o;
  if (p->payload_kind == SCR_EXC_STR) {
    scr_str_release((ScrStr *)p->payload);
  } else if ((p->payload_kind == SCR_EXC_REF || p->payload_kind == SCR_EXC_OBJ ||
              p->payload_kind == SCR_EXC_PRIMITIVE_REF) &&
             p->payload && !p->trace_fn) {
    p->release_fn(p->payload);
  }
  /* Parked Promise.all states are NOT traced children (their values array
   * is reachable only through them) — release like the untraced payload
   * above; the cb destinations stay untouched (trace visits them). */
  for (size_t i = 0; i < p->ncbs; i++) {
    if (p->cbs[i].all) scr_promise_all_state_release(p->cbs[i].all);
  }
  scr_promise_free_side(p);
  if (p->cbs) free(p->cbs);
#ifdef SCR_RC_AUDIT
  scr_live_promises--;
#endif
  scr_cyc_free_inline(p);
}

ScrPromise *scr_promise_new(void) {
  static ScrCycType cyc_type = { &scr_promise_trace, &scr_promise_gcfree, SCR_CYC_KIND_PROMISE };
  ScrPromise *p = scr_cyc_alloc_inline(sizeof *p, &cyc_type); /* constant size: zeroing inlines */
  p->rc = 1;
#ifdef SCR_RC_AUDIT
  scr_live_promises++;
#endif
  return p;
}

void scr_promise_share_identity(ScrPromise *dst, ScrPromise *src) {
  if (dst == src) return;
  if (!src->identity) {
    src->identity = malloc(sizeof *src->identity);
    if (!src->identity) scr_oom();
    src->identity->rc = 1;
  }
  if (dst->identity == src->identity) return;
  if (dst->identity && --dst->identity->rc == 0) free(dst->identity);
  dst->identity = src->identity;
  dst->identity->rc++;
}

bool scr_promise_identity_equal(ScrPromise *a, ScrPromise *b) {
  return a == b || (a->identity != NULL && a->identity == b->identity);
}

/* The 'rejectionHandled' hook (scr_async_dyn.c installs it at listener
 * registration — the scr_urj_deliver_fn pattern, so listener-free
 * binaries keep their size class): called when a promise the checkpoint
 * report already delivered as unhandled gains a handler. */
SCR_TL void (*scr_rjh_notify_fn)(ScrPromise *p) = NULL;

/* Every handler attach funnels here: mark the rejection observed, and
 * fire Node's 'rejectionHandled' when the attach arrived AFTER the
 * report delivered this promise to 'unhandledRejection' listeners (the
 * model's one late-handling window — earlier handling keeps the promise
 * out of the report entirely). The flag clears on the first attach, so
 * one report fires at most one 'rejectionHandled' — Node's pairing. */
static void scr_prom_observe(ScrPromise *p) {
  p->rejection_observed = true;
  if (p->reported_unhandled) {
    p->reported_unhandled = false;
    if (scr_rjh_notify_fn != NULL) scr_rjh_notify_fn(p);
  }
}

/* The attach-time handled mark (scr_async_dyn.c's dyn then/catch with a
 * rejection handler, plus the module loader's ownership of every module
 * evaluation promise): Node marks a promise handled at ATTACH, including
 * while it is still pending, not when a later reaction runs. The pending
 * mark is essential for a module dependency whose importer aborts while
 * evaluating a later sibling — the loader still owns that dependency's
 * eventual rejection, so it must never surface as an unrelated unhandled
 * rejection. */
void scr_promise_mark_handled(ScrPromise *p) {
  scr_prom_observe(p);
}

ScrPromise *scr_promise_retain(ScrPromise *p) {
  if (p && p->rc != SIZE_MAX) {
    p->rc++;
  }
  return p;
}

static void scr_promise_release_payload(ScrPromise *p) {
  if (p->payload_kind == SCR_EXC_STR) scr_str_release((ScrStr *)p->payload);
  else if ((p->payload_kind == SCR_EXC_REF || p->payload_kind == SCR_EXC_OBJ ||
            p->payload_kind == SCR_EXC_PRIMITIVE_REF) &&
           p->payload) p->release_fn(p->payload);
  p->payload_kind = SCR_EXC_NONE;
  p->payload = NULL;
}

void scr_promise_release(ScrPromise *p) {
  if (!p || p->rc == SIZE_MAX) return;
  if (--p->rc == 0) {
    scr_cyc_dead(p);
    scr_promise_release_payload(p);
    scr_promise_free_side(p);
    for (size_t i = 0; i < p->ncbs; i++) {
      scr_promise_release(p->cbs[i].dst);
      if (p->cbs[i].all) scr_promise_all_state_release(p->cbs[i].all);
    }
    if (p->cbs) free(p->cbs);
#ifdef SCR_RC_AUDIT
    scr_live_promises--;
#endif
    scr_cyc_free_inline(p);
  } else if (scr_promise_has_traced_children(p)) {
    scr_cyc_released(p); /* possible cycle root; may collect — p is done */
  }
  /* A promise the trace walks nothing from cannot be on a cycle at this
   * decrement, so it is not a candidate root. If it later gains traced
   * children (a cycle-capable payload or a combinator destination) while
   * still referenced, the decrement that could strand a cycle through it
   * sees them and buffers it then. */
}

void *scr_promise_retain_v(void *p) { return scr_promise_retain((ScrPromise *)p); }
void scr_promise_release_v(void *p) { scr_promise_release((ScrPromise *)p); }
void scr_promise_trace_v(void *p, ScrTraceVisit visit, void *ctx) {
  scr_promise_trace(p, visit, ctx);
}

/* ── fibers and the scheduler ─────────────────────────────────────────── */

/* One saved execution context. x86_64/AArch64 POSIX: the callee-saved
 * register file (scr_ctx_swap below). Other POSIX targets: a ucontext_t
 * (swapcontext saves the outgoing context INTO the `from` slot). Windows:
 * the fiber HANDLE — SwitchToFiber saves the outgoing state inside the
 * fiber object itself, so the slot only needs to name the destination;
 * `from` is unused. */
#if !defined(_WIN32) && !defined(__wasi__) && (defined(__x86_64__) || defined(__aarch64__))
#define SCR_FAST_CTX 1
#endif

#if defined(SCR_FAST_CTX) && defined(__x86_64__)
/* rsp, rbp, rbx, r12..r15, resume address; then MXCSR and the x87 control
 * word (callee-saved control state in the SysV ABI). */
typedef struct {
  void *gpr[8];
  uint32_t mxcsr;
  uint16_t fpcw;
} ScrCtx;
#elif defined(SCR_FAST_CTX)
/* x19..x28, x29 (fp), x30 (lr), sp, d8..d15. */
typedef struct {
  uint64_t reg[13];
  uint64_t fpr[8];
} ScrCtx;
#elif defined(_WIN32)
typedef void *ScrCtx;
#elif defined(__wasi__)
typedef unsigned char ScrCtx;
#else
typedef ucontext_t ScrCtx;
#endif

#ifdef SCR_FAST_CTX
/* User-space context switch: the fibers only need the ABI's callee-saved
 * state preserved across a cooperative switch. swapcontext additionally
 * saves and restores the process signal mask (one rt_sigprocmask syscall
 * per switch on glibc; sigprocmask + sigaltstack + getrlimit on Darwin),
 * which dominated await-heavy programs. The runtime never uses a context
 * to change the signal mask, so the mask simply stays the process's.
 *
 * scr_ctx_swap(from, to) stores the callee-saved registers, the stack
 * pointer, and the resume address into *from, then loads *to and resumes
 * there. The register file lives in the ScrCtx itself — inside the heap
 * ScrFiber for fibers, on the C stack for a resumer — exactly where
 * ucontext_t kept it, so LeakSanitizer still sees pointers a suspended
 * fiber holds in callee-saved registers. A fresh fiber's ScrCtx is seeded
 * by scr_fiber_context_init so its first switch-in enters the trampoline.
 * x18 (the Darwin platform register) is never touched. */
#if defined(__APPLE__)
#define SCR_CTX_FN(name) \
  ".globl _" name "\n.private_extern _" name "\n.p2align 4\n_" name ":\n"
#define SCR_CTX_END(name) ""
#elif defined(__x86_64__)
#define SCR_CTX_FN(name) \
  ".globl " name "\n.hidden " name "\n.type " name ", @function\n.p2align 4\n" name ":\n"
#define SCR_CTX_END(name) ".size " name ", .-" name "\n"
#else
#define SCR_CTX_FN(name) \
  ".globl " name "\n.hidden " name "\n.type " name ", %function\n.p2align 4\n" name ":\n"
#define SCR_CTX_END(name) ".size " name ", .-" name "\n"
#endif

#if defined(__x86_64__)
__asm__(".text\n"
        SCR_CTX_FN("scr_ctx_swap")
#ifdef __CET__
        "  endbr64\n"
#endif
        "  movq (%rsp), %rax\n"   /* resume address */
        "  leaq 8(%rsp), %rcx\n"  /* rsp after our return */
        "  movq %rcx, 0(%rdi)\n"
        "  movq %rbp, 8(%rdi)\n"
        "  movq %rbx, 16(%rdi)\n"
        "  movq %r12, 24(%rdi)\n"
        "  movq %r13, 32(%rdi)\n"
        "  movq %r14, 40(%rdi)\n"
        "  movq %r15, 48(%rdi)\n"
        "  movq %rax, 56(%rdi)\n"
        "  stmxcsr 64(%rdi)\n"
        "  fnstcw 68(%rdi)\n"
        "  movq 0(%rsi), %rsp\n"
        "  movq 8(%rsi), %rbp\n"
        "  movq 16(%rsi), %rbx\n"
        "  movq 24(%rsi), %r12\n"
        "  movq 32(%rsi), %r13\n"
        "  movq 40(%rsi), %r14\n"
        "  movq 48(%rsi), %r15\n"
        "  ldmxcsr 64(%rsi)\n"
        "  fldcw 68(%rsi)\n"
        "  jmpq *56(%rsi)\n"
        SCR_CTX_END("scr_ctx_swap"));
#else
__asm__(".text\n"
        SCR_CTX_FN("scr_ctx_swap")
        "  stp x19, x20, [x0, #0]\n"
        "  stp x21, x22, [x0, #16]\n"
        "  stp x23, x24, [x0, #32]\n"
        "  stp x25, x26, [x0, #48]\n"
        "  stp x27, x28, [x0, #64]\n"
        "  stp x29, x30, [x0, #80]\n"
        "  mov x9, sp\n"
        "  str x9, [x0, #96]\n"
        "  stp d8, d9, [x0, #104]\n"
        "  stp d10, d11, [x0, #120]\n"
        "  stp d12, d13, [x0, #136]\n"
        "  stp d14, d15, [x0, #152]\n"
        "  ldp x19, x20, [x1, #0]\n"
        "  ldp x21, x22, [x1, #16]\n"
        "  ldp x23, x24, [x1, #32]\n"
        "  ldp x25, x26, [x1, #48]\n"
        "  ldp x27, x28, [x1, #64]\n"
        "  ldp x29, x30, [x1, #80]\n"
        "  ldr x9, [x1, #96]\n"
        "  mov sp, x9\n"
        "  ldp d8, d9, [x1, #104]\n"
        "  ldp d10, d11, [x1, #120]\n"
        "  ldp d12, d13, [x1, #136]\n"
        "  ldp d14, d15, [x1, #152]\n"
        "  ret\n"
        SCR_CTX_END("scr_ctx_swap")
        /* First switch-in of a fresh fiber: x19 holds the trampoline. Clear
         * fp and lr so unwinders stop at the fiber's base, and branch
         * through x16 (a valid BTI `bti c` landing source). */
        SCR_CTX_FN("scr_ctx_boot")
        "  mov x16, x19\n"
        "  mov x29, xzr\n"
        "  mov x30, xzr\n"
        "  br x16\n"
        SCR_CTX_END("scr_ctx_boot"));
extern void scr_ctx_boot(void);
#endif
#if defined(__x86_64__)
_Static_assert(offsetof(ScrCtx, mxcsr) == 64 && offsetof(ScrCtx, fpcw) == 68,
               "scr_ctx_swap's x86_64 register-file offsets");
#else
_Static_assert(offsetof(ScrCtx, fpr) == 104, "scr_ctx_swap's AArch64 register-file offsets");
#endif
extern void scr_ctx_swap(ScrCtx *from, ScrCtx *to);
#endif

struct ScrFiber {
#ifdef SCR_WORKERS
  struct ScrFiber *context_next;
  struct ScrFiber **context_previous;
  ScrPromise *waiting;
#endif
  ScrCtx ctx;
  /* wasm32 uses LLVM's stackless switched-coroutine frame instead of a
   * native saved stack. The compiler emits these two generic wrappers in
   * every WASI module. */
  void *coro;
  ScrCtx *return_to; /* whoever resumed us last (spawner or the loop) */
  char *stack;       /* POSIX only; Windows fibers own their stack (NULL) */
  ScrPromise *promise; /* the promise this fiber settles (owned +1); NULL
                        * for generator fibers (gen non-NULL instead) */
  ScrGen *gen;         /* the generator this fiber runs (borrowed — the
                        * ScrGen owns the fiber, never the reverse) */
  ScrExcCell exc;
  /* AsyncLocalStorage context (owned; NULL = empty). Inherited from the
   * SPAWNER at spawn (Node's init-time capture), swapped active with the
   * fiber (the exc-cell pattern) so run()'s window rides awaits. */
  ScrAlsCtx *als;
  /* The lifetime region the body was spawned in (scr_region_fiber_hooks;
   * NULL = the default region): the loop makes it current again whenever
   * it resumes the fiber, stackful or stackless. Async bodies only;
   * generators run in their resumer's region. */
  void *region;
  bool done;
  /* A native synchronous generator compiled as an LLVM coroutine (see coro
   * above): no stack or saved context; resumes call into the frame on the
   * resumer's stack. */
  bool stackless;
  /* The fiber a stackless hop resumed this body from (scr_gen_coro_hop),
   * parked here so the hop keeps fewer values live across the body. */
  struct ScrFiber *resumer;
  /* Fiberless async bodies (scr_async_inline_enter) currently running on
   * this fiber's stack. Such a body was proven never to park, so a park
   * or hop while this is nonzero is a compiler bug — trap instead of
   * resuming the caller out of order. */
  unsigned inline_depth;
  /* Trampoline args: the spawn wrapper stores a pointer to a stack-local
   * argpack; the trampoline copies it out before the spawner resumes. */
  void *argpack;
  void (*entry)(ScrFiber *self, void *argpack);
  /* queueMicrotask entries: a stackless pseudo-fiber — the READY queue's
   * FIFO IS the microtask queue, so a closure rides it as a fiber-shaped
   * envelope and scr_resume_fiber runs it on the main stack (a throw is
   * an UNCAUGHT exception, like Node's queueMicrotask, never a
   * rejection). Owned; NULL on real fibers. */
  ScrClosure *micro_cb;
  /* Async-generator settlement jobs: stackless READY-queue envelopes.
   * The retained generator is pumped on the main stack. */
  ScrGen *gen_job;
  /* Promise.all / Promise.race reaction jobs (cb_job set): stackless
   * READY-queue envelopes carrying the settled entry (owned) and its
   * callback waiter (which owns its destination and countdown state). A
   * combinator batch job (cb.job_at == SCR_CB_BATCH) carries the batch's
   * first deciding entry, or none. */
  bool cb_job;
  ScrPromise *cb_src;
  struct ScrPromiseCbWaiter cb;
  /* Set during the eager prefix of a fiber spawned by an await-call entry
   * (scr_async_spawn_await_*): the spawner that awaits this fiber's promise
   * as soon as the spawn returns. The first suspension parks it on the
   * promise right away (scr_fiber_park_awaiters) instead of switching back
   * just so it can park itself. */
  struct ScrFiber *awaiter;
  /* This fiber was parked by such a child; set before the switch away. */
  bool await_parked;
  /* A stackless body spawned for a direct await (scr_async_spawn_direct):
   * its promise lives in the same block (ScrDirectFiber) and nothing else
   * sees it. Once the awaiting coroutine suspends it is direct_awaiter, the
   * finished body wakes it in place of the promise's settlement, and the
   * awaiter destroys the record when it takes the result. */
  bool direct;
  struct ScrFiber *direct_awaiter;
  /* While an async body runs its synchronous prefix (until its first await
   * or its end), the AsyncLocalStorage slot of the execution that spawned
   * it; NULL afterwards (scr_als_prefix_end). */
  ScrAlsCtx **prefix_slot;
#ifdef SCR_ASAN_FIBERS
  void *fake_stack;
  /* Live stackless async fibers (scr_async_spawn_stackless) form a list
   * rooted in a global, the stack root regions' counterpart: a suspended
   * coroutine frame that never resumes stays reachable for the leak check
   * as an abandoned fiber stack does. */
  struct ScrFiber *stackless_next;
  struct ScrFiber **stackless_previous;
#endif
};

/* ── AsyncLocalStorage (node:async_hooks) ─────────────────────────────
 * Stores are process-lived ids; the CONTEXT is an immutable refcounted
 * snapshot of (store id → dyn value) entries. One ACTIVE SLOT pointer
 * (the exc-cell pattern): main owns a static slot, every fiber owns its
 * own field, scr_switch repoints the active slot — so run()'s window
 * rides the fiber across awaits, and a spawned fiber INHERITS the
 * spawner's snapshot (Node's init-time capture through AsyncResource).
 * Snapshots are immutable: enter builds a fresh one (entries retained),
 * restore swaps the previous back — timer capture retains pointers. */

/* The ScrAlsCtx layout and the API over it live in scr_runtime.h /
 * scr_async_dyn.c (gated — the size-class stance); this always-linked
 * core keeps only what the fiber machinery and the test runner touch: the
 * active slot, the snapshot RC pair, enter/restore, and the
 * switch/spawn/destroy wiring. */
static SCR_TL ScrAlsCtx *scr_als_main_slot = NULL;
#ifdef SCR_WORKERS
SCR_TL ScrAlsCtx **scr_als_active;
ScrAlsCtx **scr_als_slot(void) {
  return scr_als_active ? scr_als_active : &scr_als_main_slot;
}
#else
ScrAlsCtx **scr_als_active = &scr_als_main_slot;
#endif

ScrAlsCtx *scr_als_ctx_retain(ScrAlsCtx *c) {
  if (c) c->rc++;
  return c;
}

void scr_als_ctx_release(ScrAlsCtx *c) {
  if (!c || --c->rc != 0) return;
  for (size_t i = 0; i < c->len; i++) scr_dyn_release(c->entries[i].value);
  free(c);
}

/* enterWith on the main stack lasts until that code returns to the loop,
 * so the store does not reach callbacks scheduled without it: the loop
 * clears the main slot when the main module's body returns, and an
 * enterWith inside a callback the loop runs puts a tick that clears it at
 * the front of the tick queue, so it runs as soon as that callback
 * returns. A store that an async callee's prefix or a generator step
 * enters becomes the caller's at scr_als_prefix_end and is cleared the
 * same way. */
static SCR_TL bool scr_loop_started = false;

static void scr_als_main_clear(void) {
  scr_als_ctx_release(scr_als_main_slot);
  scr_als_main_slot = NULL;
}

static void scr_next_tick_raw_first(void (*fn)(void));

/* A new store on the main slot: one a loop callback enters ends with it. */
static void scr_als_main_entered(void) {
  if (scr_loop_started) scr_next_tick_raw_first(scr_als_main_clear);
}

void scr_als_entered_with(void) {
  if (SCR_ALS_SLOT() == &scr_als_main_slot) scr_als_main_entered();
}

/* The end of an async body's synchronous prefix: its first await, or its
 * end. Node runs that prefix inside the caller's execution, so a store it
 * entered (enterWith) is still the caller's store after the call; the body
 * keeps its own copy of the context for what runs after its await. */
static void scr_als_prefix_end(ScrFiber *f) {
  ScrAlsCtx **slot = f->prefix_slot;
  if (slot == NULL) return;
  f->prefix_slot = NULL;
  if (*slot != f->als) {
    scr_als_ctx_release(*slot);
    *slot = scr_als_ctx_retain(f->als);
    if (f->als != NULL && slot == &scr_als_main_slot) scr_als_main_entered();
  }
}

/* A generator step runs in its resumer's execution, as Node runs it. A
 * fiber-backed generator switches to its own slot, so its step starts from
 * the resumer's store and a store it enters is the resumer's after the
 * step (scr_als_prefix_end on the way back); a stackless synchronous one
 * runs in the resumer's slot (scr_gen_coro_hop). An async generator's step
 * starts the same way, and after an await it continues in its own copy of
 * the context, as an async function's body does after its prefix. */
static void scr_als_step_begin(ScrFiber *f) {
  ScrAlsCtx **slot = SCR_ALS_SLOT();
  if (f->als != *slot) {
    scr_als_ctx_release(f->als);
    f->als = scr_als_ctx_retain(*slot);
  }
  f->prefix_slot = slot;
}

/* The lifetime region a new async fiber carries (ScrFiber.region). */
static inline void *scr_fiber_region_capture(void) {
  const ScrRgnFiberHooks *regions = atomic_load_explicit(&scr_region_fiber_hooks, memory_order_relaxed);
  return regions != NULL ? regions->capture() : NULL;
}

/* Fresh snapshot storage. */
ScrAlsCtx *scr_als_ctx_alloc(size_t len) {
  ScrAlsCtx *c = malloc(sizeof *c + len * sizeof(ScrAlsEntry));
  if (!c) scr_oom();
  c->rc = 1;
  c->len = len;
  return c;
}

/* Fresh snapshot with (id → value) replaced-or-appended (value borrowed,
 * retained in), installed as the active context; the PREVIOUS snapshot
 * returns (ownership moves out) for scr_als_restore. The test runner
 * enters its own entry through this too, so it lives in the core. */
ScrAlsCtx *scr_als_enter(double id, ScrDyn *value) {
  ScrAlsCtx *prev = *SCR_ALS_SLOT();
  size_t n = prev ? prev->len : 0;
  bool have = false;
  for (size_t i = 0; i < n; i++) {
    if (prev->entries[i].id == id) { have = true; break; }
  }
  ScrAlsCtx *next = scr_als_ctx_alloc(have ? n : n + 1);
  size_t w = 0;
  for (size_t i = 0; i < n; i++) {
    if (prev->entries[i].id == id) continue;
    next->entries[w].id = prev->entries[i].id;
    next->entries[w].value = scr_dyn_retain(prev->entries[i].value);
    w++;
  }
  next->entries[w].id = id;
  next->entries[w].value = scr_dyn_retain(value);
  *SCR_ALS_SLOT() = next;
  return prev; /* ownership moves to the caller */
}

void scr_als_restore(ScrAlsCtx *prev) {
  scr_als_ctx_release(*SCR_ALS_SLOT());
  *SCR_ALS_SLOT() = prev; /* ownership moves back in */
}

ScrAlsCtx *scr_als_dispatch_enter(ScrAlsCtx *ctx) {
  ScrAlsCtx **slot = SCR_ALS_SLOT();
  ScrAlsCtx *prev = *slot;
  *slot = scr_als_ctx_retain(ctx);
  return prev;
}

void scr_als_dispatch_leave(ScrAlsCtx *prev) { scr_als_restore(prev); }

ScrAlsCtx *scr_als_capture(void) { return scr_als_ctx_retain(*SCR_ALS_SLOT()); }

/* The value of `id` in the active snapshot (borrowed), or NULL. */
ScrDyn *scr_als_peek(double id) {
  const ScrAlsCtx *c = *SCR_ALS_SLOT();
  if (c) {
    for (size_t i = 0; i < c->len; i++) {
      if (c->entries[i].id == id) return c->entries[i].value;
    }
  }
  return NULL;
}

static SCR_TL ScrCtx scr_loop_ctx; /* the main stack (scheduler home) */
static SCR_TL ScrFiber *scr_current = NULL;
/* A finished fiber whose last switch went to the loop (scr_resume_fiber). */
static SCR_TL ScrFiber *scr_loop_reap = NULL;
static SCR_TL long scr_fibers_live = 0;
static SCR_TL long scr_fibers_abandoned = 0;

#ifdef SCR_WORKERS
static SCR_TL ScrFiber *scr_context_fibers;
static void scr_fiber_track(ScrFiber *fiber) {
  fiber->context_next = scr_context_fibers;
  fiber->context_previous = &scr_context_fibers;
  if (scr_context_fibers) scr_context_fibers->context_previous = &fiber->context_next;
  scr_context_fibers = fiber;
}
#else
static void scr_fiber_track(ScrFiber *fiber) { (void)fiber; }
#endif

long scr_abandoned_fiber_count(void) { return scr_fibers_abandoned; }

#ifdef SCR_ASAN_FIBERS
/* Deliberately abandoned fibers stay referenced for the process lifetime,
 * as their stacks do: the sanitizer lane's leak check then reports only
 * memory nothing can reach, matching the RC audit's abandoned-fiber note. */
static SCR_TL ScrFiber **scr_abandoned_fibers;
static SCR_TL size_t scr_abandoned_len, scr_abandoned_cap;
static void scr_fiber_keep_abandoned(ScrFiber *fiber) {
  if (scr_abandoned_len == scr_abandoned_cap) {
    size_t cap = scr_abandoned_cap ? scr_abandoned_cap * 2 : 8;
    ScrFiber **grown = realloc(scr_abandoned_fibers, cap * sizeof *grown);
    if (!grown) scr_oom();
    scr_abandoned_fibers = grown;
    scr_abandoned_cap = cap;
  }
  scr_abandoned_fibers[scr_abandoned_len++] = fiber;
}

static SCR_TL ScrFiber *scr_stackless_fibers;
#endif

void *scr_fiber_self(void) { return scr_current; }

#ifndef __wasi__
/* LLVM's switched-resume coroutine frame begins with its resume and destroy
 * functions (what llvm.coro.resume / llvm.coro.destroy call). */
typedef void (*ScrCoroFn)(void *);
static inline void scr_coro_resume(void *handle) { ((ScrCoroFn *)handle)[0](handle); }
static inline void scr_coro_destroy(void *handle) { ((ScrCoroFn *)handle)[1](handle); }

void scr_coro_started(void *handle) {
  if (scr_current == NULL || !scr_current->stackless) {
    fputs("scriptc: internal error: coroutine started outside a stackless generator\n", stderr);
    abort();
  }
  scr_current->coro = handle;
}
#endif

#ifdef __wasi__
extern void scr_wasi_coro_resume(void *handle);
extern void scr_wasi_coro_destroy(void *handle);

void scr_wasi_coro_started(void *handle) {
  if (scr_current == NULL) {
    fputs("scriptc: internal error: coroutine started outside a fiber\n", stderr);
    abort();
  }
  scr_current->coro = handle;
}
#endif

/* Microtask queue: ready fibers, FIFO. */
static SCR_TL ScrFiber **scr_ready = NULL;
static SCR_TL size_t scr_ready_head = 0, scr_ready_len = 0, scr_ready_cap = 0;

static void scr_ready_push(ScrFiber *f) {
  if (scr_ready_head + scr_ready_len == scr_ready_cap) {
    if (scr_ready_len > 0) {
      memmove(scr_ready, scr_ready + scr_ready_head, scr_ready_len * sizeof *scr_ready);
    }
    scr_ready_head = 0;
    if (scr_ready_len == scr_ready_cap) {
      scr_ready_cap = scr_ready_cap ? scr_ready_cap * 2 : 16;
      scr_ready = realloc(scr_ready, scr_ready_cap * sizeof *scr_ready);
      if (!scr_ready) scr_oom();
    }
  }
  scr_ready[scr_ready_head + scr_ready_len++] = f;
}

static void scr_async_gen_job(ScrGen *g);
static void scr_async_gen_resume_ready(ScrGen *g);

/* Timer min-heap, FIFO tiebreak via sequence numbers. `id` is nonzero only
 * for setInterval entries (the clearInterval handle; setTimeout has no
 * clear surface, so plain timeouts never need one) and `repeat_ms` is the
 * interval's period — a fired interval re-enters the heap with a fresh
 * deadline and seq, so ties against later timers stay FIFO like Node's. */
typedef struct {
  double deadline_ms;
  unsigned long seq;
  ScrClosure *cb; /* owned */
  double repeat_ms;
  unsigned long id;
  bool reffed;     /* keeps the loop alive; unref() clears it (Node semantics) */
  double delay_ms; /* the original delay — refresh() re-arms to now + this */
} ScrTimer;

static SCR_TL ScrTimer *scr_timers = NULL;
static SCR_TL size_t scr_ntimers = 0, scr_timers_cap = 0;
static SCR_TL unsigned long scr_timer_seq = 0;
/* REF'd armed timers — the loop's timer-liveness count (an unref'd timer
 * sits in the heap and still FIRES if the loop runs for other reasons, but
 * does not by itself keep the loop alive). Kept in sync by push/pop/remove
 * and by ref/unref. */
static SCR_TL size_t scr_reffed_timers = 0;

double scr_now_ms(void) {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return (double)ts.tv_sec * 1000.0 + (double)ts.tv_nsec / 1e6;
}

static bool scr_timer_before(const ScrTimer *a, const ScrTimer *b) {
  if (a->deadline_ms != b->deadline_ms) return a->deadline_ms < b->deadline_ms;
  return a->seq < b->seq;
}

/* Heap slot of every handle-carrying timer (id != 0), so clear, ref,
 * unref, refresh, and hasRef find their entry without scanning the heap.
 * The scan made a server that arms and clears a timeout per request
 * quadratic in the number of live timers. Open addressing with linear
 * probing; deletion shifts the probe run back (no tombstones). Every heap
 * write goes through scr_timer_set so the slots stay exact. */
typedef struct {
  unsigned long id; /* 0 = empty */
  size_t slot;
} ScrTimerSlot;
static SCR_TL ScrTimerSlot *scr_timer_slots = NULL;
static SCR_TL size_t scr_timer_slots_cap = 0, scr_timer_slots_len = 0;

static size_t scr_timer_slot_home(unsigned long id) {
  uint64_t h = (uint64_t)id * UINT64_C(0x9E3779B97F4A7C15);
  return (size_t)(h >> 32) & (scr_timer_slots_cap - 1);
}

static size_t scr_timer_slot_find(unsigned long id) {
  if (scr_timer_slots_cap == 0) return SIZE_MAX;
  size_t mask = scr_timer_slots_cap - 1;
  for (size_t i = scr_timer_slot_home(id); scr_timer_slots[i].id != 0; i = (i + 1) & mask) {
    if (scr_timer_slots[i].id == id) return i;
  }
  return SIZE_MAX;
}

static void scr_timer_slot_put(unsigned long id, size_t slot);

static void scr_timer_slots_grow(void) {
  ScrTimerSlot *old = scr_timer_slots;
  size_t old_cap = scr_timer_slots_cap;
  scr_timer_slots_cap = old_cap ? old_cap * 2 : 64;
  scr_timer_slots = calloc(scr_timer_slots_cap, sizeof *scr_timer_slots);
  if (!scr_timer_slots) scr_oom();
  scr_timer_slots_len = 0;
  for (size_t i = 0; i < old_cap; i++) {
    if (old[i].id != 0) scr_timer_slot_put(old[i].id, old[i].slot);
  }
  free(old);
}

static void scr_timer_slot_put(unsigned long id, size_t slot) {
  if ((scr_timer_slots_len + 1) * 2 > scr_timer_slots_cap) scr_timer_slots_grow();
  size_t mask = scr_timer_slots_cap - 1;
  size_t i = scr_timer_slot_home(id);
  while (scr_timer_slots[i].id != 0 && scr_timer_slots[i].id != id) i = (i + 1) & mask;
  if (scr_timer_slots[i].id == 0) scr_timer_slots_len++;
  scr_timer_slots[i].id = id;
  scr_timer_slots[i].slot = slot;
}

static void scr_timer_slot_delete(unsigned long id) {
  if (id == 0) return;
  size_t i = scr_timer_slot_find(id);
  if (i == SIZE_MAX) return;
  size_t mask = scr_timer_slots_cap - 1;
  for (size_t j = (i + 1) & mask; scr_timer_slots[j].id != 0; j = (j + 1) & mask) {
    size_t home = scr_timer_slot_home(scr_timer_slots[j].id);
    /* Entry j stays when its home lies cyclically in (i, j]. */
    bool stays = i <= j ? (i < home && home <= j) : (i < home || home <= j);
    if (stays) continue;
    scr_timer_slots[i] = scr_timer_slots[j];
    i = j;
  }
  scr_timer_slots[i].id = 0;
  scr_timer_slots_len--;
}

static void scr_timer_set(size_t i, ScrTimer t) {
  scr_timers[i] = t;
  if (t.id != 0) scr_timer_slot_put(t.id, i);
}

static void scr_timer_swap(size_t i, size_t j) {
  ScrTimer tmp = scr_timers[i];
  scr_timer_set(i, scr_timers[j]);
  scr_timer_set(j, tmp);
}

static void scr_timer_push(ScrTimer t) {
  if (scr_ntimers == scr_timers_cap) {
    scr_timers_cap = scr_timers_cap ? scr_timers_cap * 2 : 16;
    scr_timers = realloc(scr_timers, scr_timers_cap * sizeof *scr_timers);
    if (!scr_timers) scr_oom();
  }
  if (t.reffed) scr_reffed_timers++;
  size_t i = scr_ntimers++;
  scr_timer_set(i, t);
  while (i > 0) {
    size_t parent = (i - 1) / 2;
    if (!scr_timer_before(&scr_timers[i], &scr_timers[parent])) break;
    scr_timer_swap(i, parent);
    i = parent;
  }
}

static ScrTimer scr_timer_pop(void) {
  ScrTimer top = scr_timers[0];
  if (top.reffed && scr_reffed_timers > 0) scr_reffed_timers--;
  scr_timer_slot_delete(top.id);
  if (--scr_ntimers == 0) return top;
  scr_timer_set(0, scr_timers[scr_ntimers]);
  size_t i = 0;
  for (;;) {
    size_t l = 2 * i + 1, r = 2 * i + 2, min = i;
    if (l < scr_ntimers && scr_timer_before(&scr_timers[l], &scr_timers[min])) min = l;
    if (r < scr_ntimers && scr_timer_before(&scr_timers[r], &scr_timers[min])) min = r;
    if (min == i) break;
    scr_timer_swap(i, min);
    i = min;
  }
  return top;
}

/* Node's delay coercion (lib/internal/timers.js): NaN/negative/sub-ms
 * clamp to 1, the delay TRUNCATES to integer milliseconds (setTimeout(cb,
 * 1.8) and setTimeout(cb, 1.1) both land in the 1ms bucket, so a batch of
 * fractional delays fires in REGISTRATION order — test-timers-non-integer-
 * delay's contract), and anything past TIMEOUT_MAX (2^31-1) becomes 1. */
static double scr_timer_coerce_ms(double ms) {
  if (!(ms >= 1)) return 1;
  if (ms > 2147483647.0) return 1; /* past TIMEOUT_MAX (also +Infinity) */
  return (double)(unsigned long long)ms; /* trunc: positive, finite, in range */
}

void scr_set_timeout(ScrClosure *cb, double ms) {
  ms = scr_timer_coerce_ms(ms);
  ScrTimer t = {scr_now_ms() + ms, scr_timer_seq++, cb /* ownership moves in */, 0, 0, true, ms};
  scr_timer_push(t);
}

/* ── setInterval / clearInterval ─────────────────────────────────────
 * Intervals ride the same heap: the entry carries its period and a
 * nonzero id (the compiled handle — Node's Timeout object reduced to the
 * number the fallback declarations promise). A live interval keeps the
 * loop alive exactly because it sits in the heap; clearInterval removes
 * the entry EAGERLY (a lazily-cancelled entry would hold the loop open
 * until its deadline — an interval cleared at t=0 with a one-hour period
 * must let the program exit NOW, like Node). Clearing the interval whose
 * callback is currently running (the self-clearing spinner pattern) is
 * handled by the firing pair below: the entry is out of the heap while
 * its callback runs, so the run loop re-pushes it only if the callback
 * did not clear it. */

static SCR_TL unsigned long scr_interval_next_id = 1;
static SCR_TL unsigned long scr_firing_id = 0; /* interval currently running */
static SCR_TL bool scr_firing_cleared = false;
static SCR_TL bool scr_firing_reffed = true;  /* the running interval's ref state */
static SCR_TL bool scr_firing_refresh = false; /* refresh() called mid-callback */

/* Removes heap entry i (swap-with-last, then sift whichever way the moved
 * entry needs). */
static void scr_timer_remove_at(size_t i) {
  if (scr_timers[i].reffed && scr_reffed_timers > 0) scr_reffed_timers--;
  scr_timer_slot_delete(scr_timers[i].id);
  if (i >= --scr_ntimers) return;
  scr_timer_set(i, scr_timers[scr_ntimers]);
  /* Sift up if the moved entry beats its parent, else sift down. */
  while (i > 0) {
    size_t parent = (i - 1) / 2;
    if (!scr_timer_before(&scr_timers[i], &scr_timers[parent])) break;
    scr_timer_swap(i, parent);
    i = parent;
  }
  for (;;) {
    size_t l = 2 * i + 1, r = 2 * i + 2, min = i;
    if (l < scr_ntimers && scr_timer_before(&scr_timers[l], &scr_timers[min])) min = l;
    if (r < scr_ntimers && scr_timer_before(&scr_timers[r], &scr_timers[min])) min = r;
    if (min == i) break;
    scr_timer_swap(i, min);
    i = min;
  }
}

double scr_set_interval(ScrClosure *cb, double ms) {
  ms = scr_timer_coerce_ms(ms); /* Node's clamp-and-trunc, like setTimeout */
  unsigned long id = scr_interval_next_id++;
  ScrTimer t = {scr_now_ms() + ms, scr_timer_seq++, cb /* ownership moves in */, ms, id, true, ms};
  scr_timer_push(t);
  return (double)id;
}

SCR_TL void (*scr_mt_abort_timeout_arm)(ScrClosure *cb, double ms) = NULL;
SCR_TL int scr_mt_wait_state = 0;

double scr_set_timeout_handle(ScrClosure *cb, double ms) {
  ms = scr_timer_coerce_ms(ms);
  unsigned long id = scr_interval_next_id++;
  ScrTimer t = {scr_now_ms() + ms, scr_timer_seq++, cb /* ownership moves in */, 0, id, true, ms};
  scr_timer_push(t);
  return (double)id;
}

/* process.env-style timer ref bookkeeping: unref() drops a timer from the
 * loop's liveness count (it still fires if the loop runs on), ref() puts
 * it back. Node-exact for the static timer surface; NaN/0/absent handles
 * are tolerated (never a handle). The one-shot setTimeout with NO clear
 * handle (id 0) cannot be unref'd by id — the compiler routes .unref()
 * only over handle-returning timers, so id 0 never reaches here. */
static ScrTimer *scr_timer_find(unsigned long id) {
  size_t i = scr_timer_slot_find(id);
  return i == SIZE_MAX ? NULL : &scr_timers[scr_timer_slots[i].slot];
}

void scr_timer_unref(double handle) {
  if (!(handle >= 1)) return;
  unsigned long id = (unsigned long)handle;
  if (id == scr_firing_id) {
    /* Firing interval unref'ing itself: the re-arm carries the flag. */
    scr_firing_reffed = false;
    return;
  }
  ScrTimer *t = scr_timer_find(id);
  if (t && t->reffed) {
    t->reffed = false;
    if (scr_reffed_timers > 0) scr_reffed_timers--;
  }
}

void scr_timer_ref(double handle) {
  if (!(handle >= 1)) return;
  unsigned long id = (unsigned long)handle;
  if (id == scr_firing_id) {
    scr_firing_reffed = true;
    return;
  }
  ScrTimer *t = scr_timer_find(id);
  if (t && !t->reffed) {
    t->reffed = true;
    scr_reffed_timers++;
  }
}

/* refresh(): re-arm to now + the original delay — Node's Timeout.refresh.
 * A HEAP entry (armed timeout or interval between ticks) re-enters the
 * heap with a fresh deadline and seq (FIFO against later same-deadline
 * timers, like a brand-new timer); the timer whose callback is RUNNING
 * sets the firing flag and the loop re-arms the one-shot after the
 * callback returns (the interval re-arm already does). A one-shot that
 * fired on an earlier turn is gone — its closure released — so refresh
 * of a dead handle is a tolerated no-op (SEMANTICS: Node re-activates
 * even a fired Timeout; the compiled handle cannot). */
void scr_timer_refresh(double handle) {
  if (!(handle >= 1)) return;
  unsigned long id = (unsigned long)handle;
  if (id == scr_firing_id) {
    scr_firing_refresh = true;
    return;
  }
  ScrTimer *found = scr_timer_find(id);
  if (found) {
    ScrTimer t = *found;
    scr_timer_remove_at((size_t)(found - scr_timers));
    t.deadline_ms = scr_now_ms() + t.delay_ms;
    t.seq = scr_timer_seq++;
    scr_timer_push(t);
  }
}

/* hasRef(): true iff the handle names a live, still-reffed timer. */
bool scr_timer_has_ref(double handle) {
  if (!(handle >= 1)) return false;
  unsigned long id = (unsigned long)handle;
  if (id == scr_firing_id) return scr_firing_reffed;
  ScrTimer *t = scr_timer_find(id);
  return t != NULL && t->reffed;
}

/* ── process.getActiveResourcesInfo (the loop's own bookkeeping) ──────
 * 'Timeout' per armed heap timer — plus the firing, uncleared one (Node
 * counts a Timeout as active while its callback runs, until clearTimeout
 * drops it) — and 'Immediate' per queued, unfired immediate (a FIRED
 * immediate no longer counts, Node's current answer inside the
 * callback). Resource kinds this runtime does not model as loop handles
 * (TCP wraps, FS requests, ...) are absent — SEMANTICS.md names the
 * divergence. Result +1. */
static SCR_TL size_t scr_pending_immediates; /* defined below with the queue */
ScrArr *scr_active_resources(void) {
  ScrArr *arr = scr_arr_new(SCR_ELEM_STR, 8);
  size_t timeouts = scr_ntimers + ((scr_firing_id != 0 && !scr_firing_cleared) ? 1 : 0);
  for (size_t i = 0; i < timeouts; i++) scr_arr_push_ref(arr, scr_str_new("Timeout", 7));
  for (size_t i = 0; i < scr_pending_immediates; i++) scr_arr_push_ref(arr, scr_str_new("Immediate", 9));
  return arr;
}

/* ── process.nextTick (the user tick queue) ───────────────────────────
 * A FIFO of user callbacks drained BEFORE promise jobs at every loop
 * checkpoint, to joint exhaustion with them — Node's tick-then-microtask
 * order. Pending ticks are always-ready work: the loop neither sleeps
 * nor exits while any exist. Ticks scheduled from 'exit' listeners (or
 * left queued on the uncaught paths) never run — the teardown releases
 * them, like Node dropping the queue at exit. */
typedef struct ScrNtick {
  ScrClosure *cb;             /* owned; NULL for a raw C-hook entry */
  ScrFsRenameFn error_cb;     /* process-write success adapter, or NULL */
  void (*raw)(void);          /* hook when cb == NULL (stream markers) */
  struct ScrNtick *next;
} ScrNtick;

static SCR_TL ScrNtick *scr_nt_head = NULL;
static SCR_TL ScrNtick *scr_nt_tail = NULL;

/* Public: releases every queued tick without running it — the loop-exit
 * teardown below AND the exit-listener runner (scr_events.c) both call
 * it, because 'exit' listeners run AFTER the loop's teardown and may
 * enqueue ticks that must never run (Node) yet must not leak. */

static ScrClosure *scr_als_bind(ScrClosure *cb /*moves*/);

/* A tick runs with the AsyncLocalStorage context active when it was
 * queued, as Node's process.nextTick does. */
void scr_next_tick(ScrClosure *cb /*moves*/) {
  ScrNtick *t = scr_mem_calloc(sizeof *t);
  if (!t) scr_oom();
  t->cb = scr_als_bind(cb);
  if (scr_nt_tail) scr_nt_tail->next = t;
  else scr_nt_head = t;
  scr_nt_tail = t;
}

/* stdout/stderr write completions are Node nextTicks too, but their
 * callback receives the success `null` argument. Reuse the error-first
 * adapter ABI also used by fs.rename: emitted adapters construct the
 * program's Error | null union, and NULL selects its null arm. */
void scr_process_write_callback(ScrClosure *cb /*moves*/, ScrFsRenameFn fn) {
  ScrNtick *t = scr_mem_calloc(sizeof *t);
  if (!t) scr_oom();
  t->cb = cb;
  t->error_cb = fn;
  if (scr_nt_tail) scr_nt_tail->next = t;
  else scr_nt_head = t;
  scr_nt_tail = t;
}

/* A RAW C-hook tick: the stream unit enqueues one marker per deferred
 * stream emission so those emissions interleave with user nextTicks in
 * true FIFO order — in Node they ARE nextTicks (resume_, emitReadable_,
 * endReadableNT, ...). The hook dispatches exactly one stream tick;
 * teardown just drops markers (the stream queue owns its entries). */
void scr_next_tick_raw(void (*fn)(void)) {
  ScrNtick *t = scr_mem_calloc(sizeof *t);
  if (!t) scr_oom();
  t->raw = fn;
  if (scr_nt_tail) scr_nt_tail->next = t;
  else scr_nt_head = t;
  scr_nt_tail = t;
}

/* A raw tick at the front of the queue: it runs before the ticks already
 * queued. */
static void scr_next_tick_raw_first(void (*fn)(void)) {
  ScrNtick *t = scr_mem_calloc(sizeof *t);
  if (!t) scr_oom();
  t->raw = fn;
  t->next = scr_nt_head;
  scr_nt_head = t;
  if (scr_nt_tail == NULL) scr_nt_tail = t;
}

void scr_nticks_teardown(void) {
  while (scr_nt_head != NULL) {
    ScrNtick *t = scr_nt_head;
    scr_nt_head = t->next;
    if (t->cb) scr_closure_release(t->cb);
    scr_mem_free(t);
  }
  scr_nt_tail = NULL;
}

static void scr_immediates_teardown(void);
void scr_timers_teardown(void) {
  for (size_t i = 0; i < scr_ntimers; i++) scr_closure_release(scr_timers[i].cb);
  scr_ntimers = 0;
  scr_reffed_timers = 0;
  free(scr_timer_slots);
  scr_timer_slots = NULL;
  scr_timer_slots_cap = scr_timer_slots_len = 0;
  scr_immediates_teardown();
  scr_nticks_teardown();
}

void scr_clear_interval(double handle) {
  if (!(handle >= 1)) return; /* NaN/0/negative: never a handle; Node tolerates */
  unsigned long id = (unsigned long)handle;
  if (id == scr_firing_id) {
    scr_firing_cleared = true; /* the run loop drops the callback */
    return;
  }
  ScrTimer *found = scr_timer_find(id);
  if (found) {
    scr_closure_release(found->cb);
    scr_timer_remove_at((size_t)(found - scr_timers));
  }
}

/* ── immediates (Node's check phase) ──────────────────────────────────
 * setImmediate callbacks run once per loop turn, AFTER due timers, in
 * FIFO order — and immediates queued while the phase runs wait for the
 * NEXT turn (the phase snapshots its end index). The queue is an
 * append-only array with a head cursor; clearImmediate NULLs the slot in
 * place (order and indices stay stable mid-phase). Ids ride their own
 * space — clearTimeout of an Immediate is a no-op, like Node. */
typedef struct {
  unsigned long id;
  ScrClosure *cb; /* owned; NULL once fired or cleared */
  bool reffed;    /* keeps the loop alive; unref() clears it (Node semantics) */
} ScrImmediate;

static SCR_TL ScrImmediate *scr_immediates = NULL;
static SCR_TL size_t scr_nimmediates = 0, scr_immediates_head = 0, scr_immediates_cap = 0;
static SCR_TL unsigned long scr_immediate_seq = 0;
/* Pending (queued, uncleared) immediates and the reffed subset — the
 * loop's no-sleep signal and liveness count respectively. */
static SCR_TL size_t scr_pending_immediates = 0;
static SCR_TL size_t scr_reffed_immediates = 0;

double scr_set_immediate(ScrClosure *cb) {
  if (scr_nimmediates == scr_immediates_cap) {
    scr_immediates_cap = scr_immediates_cap ? scr_immediates_cap * 2 : 16;
    scr_immediates = realloc(scr_immediates, scr_immediates_cap * sizeof *scr_immediates);
    if (!scr_immediates) scr_oom();
  }
  unsigned long id = ++scr_immediate_seq;
  scr_immediates[scr_nimmediates].id = id;
  scr_immediates[scr_nimmediates].cb = cb; /* ownership moves in */
  scr_immediates[scr_nimmediates].reffed = true;
  scr_nimmediates++;
  scr_pending_immediates++;
  scr_reffed_immediates++;
  return (double)id;
}

static ScrImmediate *scr_immediate_find(unsigned long id) {
  for (size_t i = scr_immediates_head; i < scr_nimmediates; i++) {
    if (scr_immediates[i].id == id && scr_immediates[i].cb != NULL) return &scr_immediates[i];
  }
  return NULL;
}

void scr_clear_immediate(double handle) {
  if (!(handle >= 1)) return; /* NaN/0/negative: never a handle; Node tolerates */
  ScrImmediate *im = scr_immediate_find((unsigned long)handle);
  if (im == NULL) return; /* already fired/cleared: no-op, like Node */
  scr_closure_release(im->cb);
  im->cb = NULL;
  if (scr_pending_immediates > 0) scr_pending_immediates--;
  if (im->reffed) {
    im->reffed = false;
    if (scr_reffed_immediates > 0) scr_reffed_immediates--;
  }
}

/* Immediate.unref()/ref()/hasRef(): the Timeout trio's exact story over
 * the immediate queue. A fired or cleared handle is a tolerated no-op
 * (Node's Immediate methods on a dead handle do nothing). */
void scr_immediate_unref(double handle) {
  if (!(handle >= 1)) return;
  ScrImmediate *im = scr_immediate_find((unsigned long)handle);
  if (im && im->reffed) {
    im->reffed = false;
    if (scr_reffed_immediates > 0) scr_reffed_immediates--;
  }
}

void scr_immediate_ref(double handle) {
  if (!(handle >= 1)) return;
  ScrImmediate *im = scr_immediate_find((unsigned long)handle);
  if (im && !im->reffed) {
    im->reffed = true;
    scr_reffed_immediates++;
  }
}

bool scr_immediate_has_ref(double handle) {
  if (!(handle >= 1)) return false;
  ScrImmediate *im = scr_immediate_find((unsigned long)handle);
  return im != NULL && im->reffed;
}

/* The teardown sweep's immediate arm (called from scr_timers_teardown):
 * unref'd immediates left queued at normal loop exit never fire (Node),
 * so their closures release here or the RC audit counts them as leaks. */
static void scr_immediates_teardown(void) {
  for (size_t i = scr_immediates_head; i < scr_nimmediates; i++) {
    if (scr_immediates[i].cb != NULL) scr_closure_release(scr_immediates[i].cb);
  }
  scr_nimmediates = 0;
  scr_immediates_head = 0;
  scr_pending_immediates = 0;
  scr_reffed_immediates = 0;
}

/* Unhandled rejections: rejected promises retained here until observed. */
static SCR_TL ScrPromise **scr_maybe_unhandled = NULL;
static SCR_TL size_t scr_nunhandled = 0, scr_unhandled_cap = 0;

static void scr_track_rejection(ScrPromise *p) {
  if (scr_nunhandled == scr_unhandled_cap) {
    scr_unhandled_cap = scr_unhandled_cap ? scr_unhandled_cap * 2 : 8;
    scr_maybe_unhandled = realloc(scr_maybe_unhandled, scr_unhandled_cap * sizeof *scr_maybe_unhandled);
    if (!scr_maybe_unhandled) scr_oom();
  }
  scr_maybe_unhandled[scr_nunhandled++] = scr_promise_retain(p);
}

/* ── context switching (ASan-annotated) ───────────────────────────────── */

#ifdef SCR_ASAN_FIBERS
static SCR_TL void *scr_main_fake_stack; /* fake-stack slot for the main context */
#endif

#ifdef _WIN32
/* The current context's handle, converting the main thread to a fiber on
 * first need (SwitchToFiber requires the caller BE a fiber; the runtime is
 * single-threaded, so one lazy conversion covers the process). Also the
 * loop-home keeper: whenever main is the caller this IS scr_loop_ctx's
 * value — assigned at the conversion so parked fibers can always switch
 * back to it. */
static void *scr_win_self(void) {
  static bool converted = false;
  if (!converted) {
    scr_loop_ctx = ConvertThreadToFiber(NULL);
    if (scr_loop_ctx == NULL) {
      fputs("scriptc: ConvertThreadToFiber failed\n", stderr);
      abort();
    }
    converted = true;
  }
  return GetCurrentFiber();
}
#endif

static void scr_switch(ScrCtx *from, ScrCtx *to, ScrFiber *to_fiber) {
#ifdef SCR_ASAN_FIBERS
  ScrFiber *from_fiber = scr_current;
#endif
  scr_current = to_fiber;
  scr_exc_swap_cell(to_fiber ? &to_fiber->exc : NULL);
  scr_als_active = to_fiber ? &to_fiber->als : &scr_als_main_slot;
#if !defined(_WIN32) && !defined(__wasi__)
  /* The stack guard follows the running stack. A fresh fiber starts with
   * its own; every resumed context restores the guard it saved here. */
  uintptr_t guard = scr_stack_guard;
  if (to_fiber) SCR_STACK_GUARD_SET(scr_stack_guard_for((uintptr_t)to_fiber->stack, SCR_FIBER_STACK));
#endif
#ifdef _WIN32
  /* SwitchToFiber snapshots the outgoing fiber's state inside its own
   * fiber object — `from` has nothing to record. */
  (void)from;
  SwitchToFiber(*to);
#elif defined(__wasi__)
  (void)from;
  (void)to;
  scr_trap("scriptc: internal error: native stack switch reached on WASI\n");
#elif defined(SCR_ASAN_FIBERS)
  /* A finished fiber leaves for the last time: a NULL slot has
   * AddressSanitizer free its fake stack, which otherwise stays mapped
   * until exit. */
  void **save = from_fiber ? (from_fiber->done ? NULL : &from_fiber->fake_stack)
                           : &scr_main_fake_stack;
  const void *bottom = to_fiber ? to_fiber->stack : NULL;
  size_t size = to_fiber ? SCR_FIBER_STACK : 0;
  __sanitizer_start_switch_fiber(save, bottom, size);
#ifdef SCR_FAST_CTX
  scr_ctx_swap(from, to);
#else
  swapcontext(from, to);
#endif
  /* Back in this frame: the context that saved into `save` above runs
   * again, whichever fiber `scr_current` names (a finished fiber returns
   * to its resumer with no fiber to switch to). */
  const void *old_bottom;
  size_t old_size;
  __sanitizer_finish_switch_fiber(from_fiber ? from_fiber->fake_stack : scr_main_fake_stack,
                                  &old_bottom, &old_size);
#elif defined(SCR_FAST_CTX)
  scr_ctx_swap(from, to);
#else
  swapcontext(from, to);
#endif
#if !defined(_WIN32) && !defined(__wasi__)
  SCR_STACK_GUARD_SET(guard);
#endif
}

static void scr_promise_settle_wake(ScrPromise *p);

/* Copies src's settlement into a still-pending dst (payload RETAINED —
 * src can settle other destinations and still be awaited) and wakes dst's
 * waiters. A rejection consumed this way counts as HANDLED on src (a
 * combinator attached a handler, like Node's race). The Promise.race
 * same-inner-type adapter and the rejection path both land here. */
static void scr_promise_settle_from(ScrPromise *dst, ScrPromise *src) {
  if (dst->state == SCR_PROM_PENDING) {
    dst->state = src->state;
    dst->payload_kind = src->payload_kind;
    dst->f64 = src->f64;
    dst->b = src->b;
    dst->retain_fn = src->retain_fn;
    dst->release_fn = src->release_fn;
    dst->trace_fn = src->trace_fn;
    dst->payload = NULL;
    if (src->payload_kind == SCR_EXC_STR && src->payload) {
      dst->payload = scr_str_retain((ScrStr *)src->payload);
    } else if ((src->payload_kind == SCR_EXC_REF || src->payload_kind == SCR_EXC_OBJ ||
                src->payload_kind == SCR_EXC_PRIMITIVE_REF) &&
               src->payload) {
      dst->payload = src->retain_fn(src->payload);
    }
    scr_promise_settle_wake(dst);
  }
  if (src->state == SCR_PROM_REJECTED) scr_prom_observe(src);
}

/* The emitted same-type Promise.race adapter (see raceAdapterFor). */
void scr_promise_adapt_copy(ScrPromise *dst, ScrPromise *src) {
  scr_promise_settle_from(dst, src);
}

/* One combinator entry's reaction job. An entry DECIDES the result when
 * its settlement alone settles it — a Promise.all rejection, a
 * Promise.any fulfillment — and copies raw into the result (the first job
 * to run wins through the destination's own pending check; the entries
 * stay HANDLED from the subscription, exactly Node's subscribe-to-
 * everything behavior). Every other settlement stores through the mode's
 * helper at the entry's INPUT index (input order regardless of
 * settlement order: all's values, allSettled's records, any's reasons)
 * and counts down; the last one finishes the result — all/allSettled
 * fulfill with the array (void-element all fulfills void), any rejects
 * through its fail hook. */
static bool scr_promise_all_decides(const ScrAllState *st, const ScrPromise *src) {
  if (st->mode == SCR_COMBINE_ALL) return src->state == SCR_PROM_REJECTED;
  if (st->mode == SCR_COMBINE_ANY) return src->state == SCR_PROM_FULFILLED;
  return false;
}

static void scr_promise_all_fulfill(ScrAllState *st, ScrPromise *result) {
  if (st->mode == SCR_COMBINE_ANY) {
    st->fail(result, st->values);
  } else if (st->values) {
    scr_promise_fulfill_ref(result, scr_arr_retain(st->values), scr_arr_retain_v,
                             scr_arr_release_v, st->values->cyc ? scr_arr_trace_v : NULL);
  } else {
    scr_promise_fulfill_void(result);
  }
}

static void scr_promise_all_count(ScrAllState *st, ScrPromise *result, size_t counted) {
  st->remaining -= counted;
  if (st->remaining == 0 && result->state == SCR_PROM_PENDING) scr_promise_all_fulfill(st, result);
}

static void scr_promise_all_settle(ScrAllState *st, ScrPromise *result, size_t idx,
                                    ScrPromise *src) {
  if (scr_promise_all_decides(st, src)) {
    scr_promise_settle_from(result, src);
  } else {
    if (st->store) st->store(st->values, (double)idx, src);
    scr_promise_all_count(st, result, 1);
  }
}

static inline void scr_promise_wake_one(ScrFiber *f) {
#ifdef SCR_WORKERS
  f->waiting = NULL;
#endif
  scr_ready_push(f);
}

/* Runs one callback waiter against its settled source and drops the
 * waiter's references (its destination and countdown state). */
static void scr_promise_cb_run(struct ScrPromiseCbWaiter *cb, ScrPromise *src) {
  if (cb->all) {
    scr_promise_all_settle(cb->all, cb->dst, cb->all_idx, src);
    scr_promise_all_state_release(cb->all);
  } else if (src->state == SCR_PROM_FULFILLED) {
    cb->adapt(cb->dst, src);
  } else {
    scr_promise_settle_from(cb->dst, src);
  }
  scr_promise_release(cb->dst);
}

/* Queues a combinator's reaction job for a settled entry. The waiter's
 * references move into the envelope, which also retains the entry. */
static void scr_promise_cb_queue(const struct ScrPromiseCbWaiter *cb, ScrPromise *src) {
  ScrFiber *job = scr_mem_calloc(sizeof *job);
  if (!job) scr_oom();
  job->cb_job = true;
  job->cb_src = scr_promise_retain(src);
  job->cb = *cb;
  scr_ready_push(job);
}

/* Runs and frees a reaction job envelope. */
static void scr_promise_job_run(ScrFiber *f) {
  ScrPromise *src = f->cb_src;
  struct ScrPromiseCbWaiter cb = f->cb;
  scr_mem_free(f);
  if (cb.job_at != SCR_CB_BATCH) {
    scr_promise_cb_run(&cb, src);
  } else {
    if (src != NULL) scr_promise_settle_from(cb.dst, src);
    else scr_promise_all_count(cb.all, cb.dst, cb.all_idx);
    scr_promise_all_state_release(cb.all);
    scr_promise_release(cb.dst);
  }
  scr_promise_release(src);
}

static struct ScrPromiseCbWaiter *scr_promise_cb_push(ScrPromise *in) {
  if (in->ncbs == in->cbs_cap) {
    in->cbs_cap = in->cbs_cap ? in->cbs_cap * 2 : 4;
    in->cbs = realloc(in->cbs, in->cbs_cap * sizeof *in->cbs);
    if (!in->cbs) scr_oom();
  }
  return &in->cbs[in->ncbs++];
}

/* A combinator subscribing to an entry: Node's `then` on the entry. The
 * entry counts as handled from here on; a settled entry queues its
 * reaction job now, a pending one when it settles. */
static void scr_promise_cb_subscribe(ScrPromise *in, struct ScrPromiseCbWaiter cb) {
  scr_prom_observe(in);
  if (in->state != SCR_PROM_PENDING) {
    scr_promise_cb_queue(&cb, in);
  } else {
    cb.job_at = in->nwaiters;
    *scr_promise_cb_push(in) = cb;
  }
}

/* Settlement with callback waiters: combinator jobs enter the microtask
 * queue interleaved with the waking fibers in subscription order, then
 * the conversions run in place (they settle their destinations now, so
 * those destinations' waiters queue behind this promise's). */
static void scr_promise_settle_wake_cbs(ScrPromise *p) {
  size_t w = 0;
  for (size_t i = 0; i < p->ncbs; i++) {
    const struct ScrPromiseCbWaiter *cb = &p->cbs[i];
    if (cb->job_at == SCR_CB_SYNC) continue;
    for (; w < cb->job_at && w < p->nwaiters; w++) scr_promise_wake_one(p->waiters[w]);
    scr_promise_cb_queue(cb, p);
  }
  for (; w < p->nwaiters; w++) scr_promise_wake_one(p->waiters[w]);
  p->nwaiters = 0;
  for (size_t i = 0; i < p->ncbs; i++) {
    if (p->cbs[i].job_at == SCR_CB_SYNC) scr_promise_cb_run(&p->cbs[i], p);
  }
  p->ncbs = 0;
}

/* Settle helpers wake waiters into the microtask queue and dispatch the
 * callback waiters. */
static void scr_promise_settle_wake(ScrPromise *p) {
  if (p->ncbs != 0) {
    scr_promise_settle_wake_cbs(p);
  } else {
    for (size_t i = 0; i < p->nwaiters; i++) scr_promise_wake_one(p->waiters[i]);
    p->nwaiters = 0;
  }
  if (p->state == SCR_PROM_REJECTED) scr_track_rejection(p);
}

/* ── Promise.race ─────────────────────────────────────────────────────
 * The compiler emits: a fresh result promise, then one race_join per
 * entry. Each entry settles the result from its reaction job (first job
 * wins), one microtask turn after the entry settles or, for an entry
 * already settled, after the join. Losing entries keep their own
 * settlements (payloads are retained, not moved).
 *
 * race_add is the same callback without the job: the destination is a
 * view of the entry at another inner type (dyn boxes, typed reads of
 * dyn promises), so it settles inside the entry's own settlement. */

void scr_promise_race_join(ScrPromise *race, ScrPromise *in,
                            void (*adapt)(ScrPromise *dst, ScrPromise *src)) {
  scr_promise_cb_subscribe(
      in, (struct ScrPromiseCbWaiter){ adapt, scr_promise_retain(race), NULL, 0, 0 });
}

void scr_promise_race_add(ScrPromise *race, ScrPromise *in,
                           void (*adapt)(ScrPromise *dst, ScrPromise *src)) {
  if (in->state != SCR_PROM_PENDING) {
    if (in->state == SCR_PROM_FULFILLED) adapt(race, in);
    else scr_promise_settle_from(race, in);
    return;
  }
  *scr_promise_cb_push(in) =
      (struct ScrPromiseCbWaiter){ adapt, scr_promise_retain(race), NULL, 0, SCR_CB_SYNC };
}

/* ── Promise.all / allSettled / any ───────────────────────────────────
 * The builder takes the entries in input order. Every entry subscribes a
 * countdown reaction job (Node's `then` on each entry): it runs one
 * microtask turn after the entry settles, or after its add for an entry
 * already settled, and every entry is marked handled at the subscription.
 * The jobs of entries already settled would run back to back with nothing
 * in between, so they run as one batch job: non-deciding settlements
 * store now (the array is unobservable until the result settles) and
 * count down in the job; the batch's first deciding entry in input order
 * settles the result there. A caller that queues other jobs between
 * entries flushes the batch first, so the queue keeps Node's order.
 * `values` arrives EMPTY with cap >= n (the emitted construction passes
 * the length) and is pre-sized here: every slot's zero bits are the
 * per-kind placeholder (0.0 / false / NULL), legal to overwrite through
 * the store helpers and to release. The empty input finishes immediately
 * (awaiters take the settled-await microtask hop, like Node's one-tick
 * resolve). */
__attribute__((always_inline)) static inline void scr_combine_begin(ScrCombine *c, int mode,
                                                                    size_t n, ScrArr *values,
                                                                    ScrAllStore store,
                                                                    ScrAnyFail fail) {
  c->result = scr_promise_new();
  if (values && n > 0) {
    /* Pre-size as holes. Promise settlement writes the present slots through
     * the normal setters; this also remains safe when n is sparse-sized and
     * the array intentionally has no dense allocation. */
    scr_arr_set_len(values, (double)n);
  }
  ScrAllState *st = scr_mem_alloc(sizeof *st);
  if (!st) scr_oom();
  st->rc = 1; /* the builder's reference, dropped at the end */
  st->remaining = n;
  st->values = values ? scr_arr_retain(values) : NULL;
  st->store = store;
  st->mode = mode;
  st->fail = fail;
  c->st = st;
  c->next = 0;
  c->batched = 0;
  c->decided = NULL;
  c->open = false;
}

__attribute__((always_inline)) static inline void scr_combine_add(ScrCombine *c,
                                                                  ScrPromise *in) {
  ScrAllState *st = c->st;
  size_t i = c->next++;
  if (in->state == SCR_PROM_PENDING) {
    st->rc++;
    scr_promise_cb_subscribe(
        in, (struct ScrPromiseCbWaiter){ NULL, scr_promise_retain(c->result), st, i, 0 });
    return;
  }
  scr_prom_observe(in);
  c->open = true;
  if (scr_promise_all_decides(st, in)) {
    if (c->decided == NULL) c->decided = scr_promise_retain(in);
  } else {
    if (st->store) st->store(st->values, (double)i, in);
    c->batched++;
  }
}

__attribute__((always_inline)) static inline void scr_combine_flush(ScrCombine *c) {
  if (!c->open) return;
  ScrFiber *job = scr_mem_calloc(sizeof *job);
  if (!job) scr_oom();
  c->st->rc++;
  job->cb_job = true;
  job->cb_src = c->decided; /* the reference moves in */
  job->cb = (struct ScrPromiseCbWaiter){ NULL, scr_promise_retain(c->result), c->st, c->batched,
                                         SCR_CB_BATCH };
  scr_ready_push(job);
  c->decided = NULL;
  c->batched = 0;
  c->open = false;
}

__attribute__((always_inline)) static inline ScrPromise *scr_combine_end(ScrCombine *c) {
  scr_combine_flush(c);
  /* The empty input. */
  if (c->next == 0) scr_promise_all_fulfill(c->st, c->result);
  scr_promise_all_state_release(c->st);
  return c->result;
}

/* The builder for callers in other units (the dyn combinators). */
void scr_promise_combine_begin(ScrCombine *c, int mode, size_t n, ScrArr *values,
                               ScrAllStore store, ScrAnyFail fail) {
  scr_combine_begin(c, mode, n, values, store, fail);
}
void scr_promise_combine_add(ScrCombine *c, ScrPromise *in) { scr_combine_add(c, in); }
void scr_promise_combine_flush(ScrCombine *c) { scr_combine_flush(c); }
ScrPromise *scr_promise_combine_end(ScrCombine *c) { return scr_combine_end(c); }

/* One specialization per mode for the compiled Promise<T>[] combinators. */
__attribute__((always_inline)) static inline ScrPromise *
scr_promise_combine_array(int mode, ScrArr *ps, ScrArr *values, ScrAllStore store,
                          ScrAnyFail fail) {
  size_t n = ps->len;
  ScrCombine c;
  scr_combine_begin(&c, mode, n, values, store, fail);
  for (size_t i = 0; i < n; i++) {
    ScrPromise *in = (ScrPromise *)scr_arr_get_ref(ps, (double)i); /* +1 */
    scr_combine_add(&c, in);
    scr_promise_release(in);
  }
  return scr_combine_end(&c);
}

/* Promise.all: BORROWS the entries array `ps` and the pre-capacity values
 * array `values` (NULL for void elements), retains what it keeps, and
 * returns the result promise +1. */
ScrPromise *scr_promise_all(ScrArr *ps, ScrArr *values,
                             void (*store)(ScrArr *a, double i, ScrPromise *src)) {
  return scr_promise_combine_array(SCR_COMBINE_ALL, ps, values, store, NULL);
}

ScrPromise *scr_promise_all_settled(ScrArr *ps, ScrArr *values, ScrAllStore store) {
  return scr_promise_combine_array(SCR_COMBINE_ALL_SETTLED, ps, values, store, NULL);
}

ScrPromise *scr_promise_any(ScrArr *ps, ScrArr *errors, ScrAllStore store, ScrAnyFail fail) {
  return scr_promise_combine_array(SCR_COMBINE_ANY, ps, errors, store, fail);
}

/* Per-element-kind store helpers for the emitted Promise.all: write the
 * entry's fulfillment payload into the values array at its input index.
 * The payload accessors return retained/by-value (losing a reference is
 * impossible: set_* takes ownership and releases the zero placeholder). */
void scr_promise_all_store_f64(ScrArr *a, double i, ScrPromise *src) {
  scr_arr_set_f64(a, i, scr_promise_payload_f64(src));
}
void scr_promise_all_store_bool(ScrArr *a, double i, ScrPromise *src) {
  scr_arr_set_bool(a, i, scr_promise_payload_bool(src));
}
void scr_promise_all_store_str(ScrArr *a, double i, ScrPromise *src) {
  scr_arr_set_ref(a, i, scr_promise_payload_str(src));
}
void scr_promise_all_store_ref(ScrArr *a, double i, ScrPromise *src) {
  scr_arr_set_ref(a, i, scr_promise_payload_ref(src));
}

/* The entry promise itself: Promise.all's tuple form reads each fulfilled
 * entry at its own type once the combinator fulfills. */
void scr_promise_all_store_promise(ScrArr *a, double i, ScrPromise *src) {
  scr_arr_set_ref(a, i, scr_promise_retain(src));
}

/* Fulfillment payload accessors for the emitted race adapters — all
 * retained/by-value (the source keeps its settlement). */
double scr_promise_payload_f64(ScrPromise *p) { return p->f64; }
bool scr_promise_payload_bool(ScrPromise *p) { return p->b; }
ScrStr *scr_promise_payload_str(ScrPromise *p) {
  return scr_str_retain((ScrStr *)p->payload);
}
/* Thin views for the gated dyn-async TU (scr_async_dyn.c): the payload
 * KIND, whether a REF payload is a dyn value (the dyn adapters), and the
 * settled-await primitive (park/hop + rejection re-throw; true =
 * fulfilled). */
static bool scr_await_settled(ScrPromise *p); /* defined with the await family */
int scr_promise_payload_kind(const ScrPromise *p) { return (int)p->payload_kind; }
bool scr_promise_is_rejected(const ScrPromise *p) { return p->state == SCR_PROM_REJECTED; }
bool scr_promise_is_pending(const ScrPromise *p) { return p->state == SCR_PROM_PENDING; }
bool scr_promise_payload_is_dyn(const ScrPromise *p) { return p->retain_fn == scr_dyn_retain_v; }
double scr_promise_payload_num(const ScrPromise *p) { return p->f64; }
bool scr_promise_payload_flag(const ScrPromise *p) { return p->b; }
bool scr_promise_await_settled(ScrPromise *p) { return scr_await_settled(p); }
void scr_promise_payload_release(const ScrPromise *p, void *v) { p->release_fn(v); }

void *scr_promise_payload_ref(ScrPromise *p) {
  return p->payload ? p->retain_fn(p->payload) : NULL;
}

/* MOVES a pending exception out of `cell` into `p` as its rejection payload
 * (the cell resets to NONE). Shared by fiber completion and the new-Promise
 * executor runners; callers wake waiters themselves. */
static void scr_promise_reject_from_cell(ScrPromise *p, ScrExcCell *cell) {
  p->state = SCR_PROM_REJECTED;
  p->payload_kind = cell->kind;
  p->f64 = cell->f64;
  p->b = cell->b;
  p->payload = cell->payload;
  p->retain_fn = cell->retain_fn;
  p->release_fn = cell->release_fn;
  p->trace_fn = cell->trace_fn;
  cell->kind = SCR_EXC_NONE;
  cell->payload = NULL;
  cell->trace_fn = NULL;
  scr_exc_cell_changed();
}

static void scr_fiber_finish(ScrFiber *self) {
  if (self->gen != NULL) {
    /* Generator completion: the emitted trampoline already stored the
     * completion value (or consumed the GENRET sentinel); a real body
     * exception stays pending in this fiber's cell — the consumer-side
     * resume moves it into the resumer's cell. No promise to settle. */
    self->done = true;
    return;
  }
  ScrPromise *p = self->promise;
#ifdef SCR_WORKERS
  /* Checkpoint, not just test: the body may have unwound for a stop
   * request that its cell does not show yet. */
  if (scr_context_checkpoint()) {
    scr_promise_reject_from_cell(p, &self->exc);
    p->rejection_observed = true;
    self->done = true;
    return;
  }
#endif
  if (scr_exc_pending()) {
    /* The body's exception escaped: the promise rejects with the payload
     * (moved from the fiber's cell into the promise). */
    scr_promise_reject_from_cell(p, &self->exc);
  }
  /* A returned checked promise may still be resolving after its function
   * body finishes. Its resolver owns settlement and must not wake awaiters
   * until adoption completes (WASI continuations cannot park a C stack). */
  if (p->state != SCR_PROM_PENDING) scr_promise_settle_wake(p);
  self->done = true;
}

#ifdef _WIN32
static void CALLBACK scr_trampoline(void *param) {
  (void)param;
#else
static void scr_trampoline(void) {
#endif
#ifdef SCR_ASAN_FIBERS
  const void *ob;
  size_t os;
  __sanitizer_finish_switch_fiber(scr_current->fake_stack, &ob, &os);
#endif
  ScrFiber *self = scr_current;
  self->entry(self, self->argpack);
  scr_fiber_finish(self);
  scr_als_prefix_end(self);
  /* The loop reaps the fiber that comes back to it finished, which need
   * not be the one it resumed: a fiber that continued in place for the
   * awaiters it parked (scr_await_yield) returns to the loop too. */
  if (self->gen == NULL && self->return_to == &scr_loop_ctx) scr_loop_reap = self;
  /* Dead fiber: hop back to whoever resumed us. The loop frees us. */
  scr_switch(&self->ctx, self->return_to, NULL);
  /* unreachable */
}

#ifdef SCR_FAST_CTX
/* Seeds a fresh fiber's register file so its first switch-in enters the
 * trampoline with an ABI-conforming stack. The stack itself is only
 * written at its top word, so the mapping stays lazily committed. */
static void scr_fiber_context_start(ScrFiber *f, void (*start)(void)) {
  f->stack = scr_fiber_stack_new();
  uintptr_t top = ((uintptr_t)f->stack + SCR_FIBER_STACK) & ~(uintptr_t)15;
  memset(&f->ctx, 0, sizeof f->ctx);
#if defined(__x86_64__)
  /* The trampoline starts like a called function: rsp ≡ 8 (mod 16) with a
   * NULL return address at [rsp]; rbp = 0 ends frame-pointer unwinding. */
  void **sp = (void **)top;
  *--sp = NULL;
  f->ctx.gpr[0] = sp;
  f->ctx.gpr[7] = (void *)start;
  f->ctx.mxcsr = __builtin_ia32_stmxcsr();
  __asm__ volatile("fnstcw %0" : "=m"(f->ctx.fpcw));
#else
  f->ctx.reg[0] = (uint64_t)(uintptr_t)start;        /* x19, for scr_ctx_boot */
  f->ctx.reg[11] = (uint64_t)(uintptr_t)scr_ctx_boot; /* x30: resume address */
  f->ctx.reg[12] = (uint64_t)top;                     /* sp */
#endif
}
#elif !defined(_WIN32) && !defined(__wasi__)
/* Apple Silicon's makecontext clears all of uc_stack before installing the
 * initial registers. Passing the whole mapping eagerly commits all of it
 * (8 MiB under ASan) per call, defeating the lazy allocation above. Its
 * zero-argument startup frame only needs the top of the downward-growing
 * stack. Initialize that window, then publish the FULL stack bounds before
 * any execution or sanitizer switch. The stack top and saved SP are the
 * same as when initializing the full mapping; ordinary calls can still
 * use all of SCR_FIBER_STACK.
 * See libplatform/src/ucontext/generic/makecontext.c's arm64 implementation. */
static void scr_fiber_context_start(ScrFiber *f, void (*start)(void)) {
  f->stack = scr_fiber_stack_new();
  if (getcontext(&f->ctx) != 0) scr_trap("scriptc: getcontext failed\n");
  f->ctx.uc_stack.ss_sp = f->stack;
  f->ctx.uc_stack.ss_size = SCR_FIBER_STACK;
  f->ctx.uc_stack.ss_flags = 0;
  f->ctx.uc_link = NULL;
#if defined(__APPLE__) && defined(__aarch64__)
  const size_t bootstrap = 16 * 1024;
  f->ctx.uc_stack.ss_sp = f->stack + SCR_FIBER_STACK - bootstrap;
  f->ctx.uc_stack.ss_size = bootstrap;
#endif
  makecontext(&f->ctx, start, 0);
  f->ctx.uc_stack.ss_sp = f->stack;
  f->ctx.uc_stack.ss_size = SCR_FIBER_STACK;
}
#endif
#if !defined(_WIN32) && !defined(__wasi__)
static void scr_fiber_context_init(ScrFiber *f) { scr_fiber_context_start(f, scr_trampoline); }
#endif

/* Frees a finished fiber's execution resources (the promise release and
 * bookkeeping stay at the call sites). Windows: DeleteFiber tears down the
 * fiber object and its stack — legal here because a finished fiber has
 * switched away and can never be current again. */
static void scr_fiber_destroy(ScrFiber *f) {
#ifdef SCR_WORKERS
  if (f->context_previous) {
    *f->context_previous = f->context_next;
    if (f->context_next) f->context_next->context_previous = f->context_previous;
  }
#endif
#ifdef SCR_ASAN_FIBERS
  if (f->stackless_previous) {
    *f->stackless_previous = f->stackless_next;
    if (f->stackless_next) f->stackless_next->stackless_previous = f->stackless_previous;
  }
#endif
#ifdef __wasi__
  if (f->coro != NULL) scr_wasi_coro_destroy(f->coro);
#else
  if (f->coro != NULL) scr_coro_destroy(f->coro);
#ifdef _WIN32
  if (!f->stackless) DeleteFiber(f->ctx);
#endif
#endif
  scr_als_ctx_release(f->als);
  if (f->region != NULL) atomic_load_explicit(&scr_region_fiber_hooks, memory_order_relaxed)->drop(f->region);
#if !defined(_WIN32) && !defined(__wasi__)
  scr_fiber_stack_free(f->stack);
#else
  free(f->stack);
#endif
  scr_mem_free(f);
}

#if !defined(_WIN32) && !defined(__wasi__) && !defined(SCR_WORKERS)
#define SCR_SPAWN_AWAIT 1
#endif

/* Spawns and EAGERLY runs an async body until its first suspension (JS's
 * synchronous-prefix rule). Returns the fiber's promise, +1. A non-NULL
 * `awaiter` (the current fiber, SCR_SPAWN_AWAIT only) awaits that promise
 * immediately: the child saves into and returns to the awaiter's own
 * context, so a child suspension can park the awaiter and switch past
 * it (scr_fiber_park_awaiters). The promise is retained before the child
 * runs, as the child may then finish and be reaped by the loop before the
 * awaiter resumes. */
static ScrPromise *scr_async_spawn_impl(void (*entry)(ScrFiber *, void *), void *argpack,
                                        ScrFiber *awaiter) {
  ScrFiber *f = scr_mem_calloc(sizeof *f);
  if (!f) scr_oom();
  scr_fiber_track(f);
  f->promise = scr_promise_new();
  f->entry = entry;
  f->argpack = argpack;
  /* AsyncLocalStorage: the child runs in the SPAWNER's context (Node's
   * init-time capture); snapshots are immutable, so a retain suffices. */
  f->als = scr_als_ctx_retain(*SCR_ALS_SLOT());
  f->prefix_slot = SCR_ALS_SLOT();
  f->region = scr_fiber_region_capture();
  scr_fibers_live++;

#ifdef _WIN32
  /* Commit one page initially; Windows commits further pages as the stack
   * grows. Keep the executable's stack reserve, as with CreateFiber,
   * without committing SCR_FIBER_STACK for every idle fiber. */
  ScrCtx here = scr_win_self();
  f->ctx = CreateFiberEx(4096, 0, 0, scr_trampoline, NULL);
  if (f->ctx == NULL) scr_oom();
#elif defined(__wasi__)
  (void)awaiter;
  ScrFiber *spawner = scr_current;
  ScrAlsCtx **spawner_slot = scr_als_active;
  scr_current = f;
  scr_exc_swap_cell(&f->exc);
  scr_als_active = &f->als;
  entry(f, argpack); /* eager prefix; returns at suspend/final suspend */
  scr_als_prefix_end(f);
  scr_current = spawner;
  scr_exc_swap_cell(spawner ? &spawner->exc : NULL);
  scr_als_active = spawner_slot;
  ScrPromise *result = scr_promise_retain(f->promise);
  if (f->done) {
    scr_promise_release(f->promise);
    scr_fiber_destroy(f);
    scr_fibers_live--;
  }
  return result;
#else
  scr_fiber_context_init(f);

  ScrCtx here;
#endif
#ifndef __wasi__
  ScrCtx *home = &here;
  ScrPromise *awaited = NULL;
#ifdef SCR_SPAWN_AWAIT
  if (awaiter != NULL) {
    f->awaiter = awaiter;
    awaiter->await_parked = false;
    home = &awaiter->ctx;
    awaited = scr_promise_retain(f->promise);
  }
#else
  (void)awaiter;
#endif
  f->return_to = home;
  ScrFiber *spawner = scr_current;
  ScrAlsCtx **spawner_slot = scr_als_active;
  scr_switch(home, &f->ctx, f);
  /* back: the fiber suspended or finished. The switch back targeted NULL
   * (the child doesn't know who spawned it), which pointed both the current
   * fiber AND the exception machinery at main — restore the spawner's cell
   * too, or a fiber that eagerly spawned another keeps throwing/catching
   * against main's cell and completes with its own cell empty (a phantom
   * `undefined` rejection while the real payload leaks). */
  scr_current = spawner;
  scr_exc_swap_cell(spawner ? &spawner->exc : NULL);
  scr_als_active = spawner_slot;
  if (awaited != NULL) {
    /* Parked by the child: the loop owns (and may have reaped) it. */
    if (awaiter->await_parked) return awaited;
    f->awaiter = NULL;
  }
  ScrPromise *result = awaited != NULL ? awaited : scr_promise_retain(f->promise);
  if (f->done) {
    scr_promise_release(f->promise);
    scr_fiber_destroy(f);
    scr_fibers_live--;
  }
  return result;
#endif
}

ScrPromise *scr_async_spawn(void (*entry)(ScrFiber *, void *), void *argpack) {
  return scr_async_spawn_impl(entry, argpack, NULL);
}

#ifndef __wasi__
/* ── stackless async functions ────────────────────────────────────────
 * The compiler lowers an async body that suspends only at its own awaits
 * to an LLVM switched coroutine (scr_async.h). Its fiber is a scheduler
 * envelope without a stack or saved context: the eager prefix runs on the
 * spawner's stack (the WASI spawn's shape), and every later step runs on
 * the loop's (scr_resume_fiber). The exception cell, AsyncLocalStorage
 * context, and Error.stack chain swap exactly as a fiber switch swaps them,
 * and the promise settles and wakes its waiters through the same paths. */
#ifndef _WIN32
/* The stack a nest of eager prefixes leaves above the running stack's
 * guard before the next prefix moves to a fresh stack. Each fiber of the
 * stackful form brought its own stack, so an async recursion as deep as
 * memory allows keeps working; between moves the stack guard (with its
 * reserve below the guard) still covers synchronous recursion. */
#define SCR_STACKLESS_PREFIX_ROOM ((uintptr_t)64 << 10)

static SCR_TL struct {
  ScrFiber *body;
  void (*entry)(ScrFiber *, void *);
  void *argpack;
} scr_prefix_call;

/* Runs on the carrier's fresh stack: the body's prefix as the body's own
 * fiber, then back to the spawner, which frees the stack. */
static void scr_prefix_trampoline(void) {
#ifdef SCR_ASAN_FIBERS
  const void *ob;
  size_t os;
  __sanitizer_finish_switch_fiber(scr_current->fake_stack, &ob, &os);
#endif
  ScrFiber *carrier = scr_current;
  ScrFiber *f = scr_prefix_call.body;
  void (*entry)(ScrFiber *, void *) = scr_prefix_call.entry;
  void *argpack = scr_prefix_call.argpack;
  scr_current = f;
  scr_exc_swap_cell(&f->exc);
  scr_als_active = &f->als;
  entry(f, argpack);
  scr_current = carrier;
  carrier->done = true; /* its stack is freed once the spawner is back */
  scr_switch(&carrier->ctx, carrier->return_to, NULL);
  /* unreachable */
}

static void scr_prefix_on_fresh_stack(ScrFiber *f, void (*entry)(ScrFiber *, void *),
                                      void *argpack) {
  ScrFiber carrier;
  memset(&carrier, 0, sizeof carrier);
  scr_fiber_context_start(&carrier, scr_prefix_trampoline);
  ScrCtx here;
  carrier.return_to = &here;
  scr_prefix_call.body = f;
  scr_prefix_call.entry = entry;
  scr_prefix_call.argpack = argpack;
  scr_switch(&here, &carrier.ctx, &carrier);
  scr_fiber_stack_free(carrier.stack);
}
#endif

/* A directly awaited body's fiber record and its promise, one block. */
typedef struct {
  ScrFiber fiber;
  ScrPromise promise;
} ScrDirectFiber;

/* Creates a stackless body's fiber and runs its eager prefix, which
 * returns at the first suspension or the end. A direct fiber's promise is
 * embedded and immortal (retains and releases skip it). */
static ScrFiber *scr_spawn_stackless_fiber(void (*entry)(ScrFiber *, void *), void *argpack,
                                           bool direct) {
  ScrFiber *f;
  if (direct) {
    ScrDirectFiber *block = scr_mem_calloc(sizeof *block);
    if (!block) scr_oom();
    f = &block->fiber;
    f->promise = &block->promise;
    f->promise->rc = SIZE_MAX;
    f->direct = true;
  } else {
    f = scr_mem_calloc(sizeof *f);
    if (!f) scr_oom();
    f->promise = scr_promise_new();
  }
  scr_fiber_track(f);
  f->stackless = true;
  f->als = scr_als_ctx_retain(*SCR_ALS_SLOT());
  f->prefix_slot = SCR_ALS_SLOT();
  /* The lifetime region the eager prefix runs in, which every later step
   * resumes in (scr_resume_fiber), as a fiber's body does. */
  f->region = scr_fiber_region_capture();
  scr_fibers_live++;
#ifdef SCR_ASAN_FIBERS
  f->stackless_next = scr_stackless_fibers;
  f->stackless_previous = &scr_stackless_fibers;
  if (scr_stackless_fibers) scr_stackless_fibers->stackless_previous = &f->stackless_next;
  scr_stackless_fibers = f;
#endif
  ScrFiber *spawner = scr_current;
  ScrAlsCtx **spawner_slot = scr_als_active;
#ifndef _WIN32
  uintptr_t guard = scr_stack_guard;
  if (guard != 0 && (uintptr_t)__builtin_frame_address(0) < guard + SCR_STACKLESS_PREFIX_ROOM) {
    scr_prefix_on_fresh_stack(f, entry, argpack);
  } else
#endif
  {
    scr_current = f;
    scr_exc_swap_cell(&f->exc);
    scr_als_active = &f->als;
    entry(f, argpack); /* the eager prefix: returns at a suspension or the end */
  }
  scr_als_prefix_end(f);
  scr_current = spawner;
  scr_exc_swap_cell(spawner ? &spawner->exc : NULL);
  scr_als_active = spawner_slot;
  return f;
}

ScrPromise *scr_async_spawn_stackless(void (*entry)(ScrFiber *, void *), void *argpack) {
  ScrFiber *f = scr_spawn_stackless_fiber(entry, argpack, false);
  ScrPromise *result = scr_promise_retain(f->promise);
  if (f->done) {
    scr_promise_release(f->promise);
    scr_fiber_destroy(f);
    scr_fibers_live--;
  }
  return result;
}

/* A stackless body that a stackless coroutine awaits right away (the
 * compiler's direct await): its promise never escapes, so it is embedded
 * in the fiber record, which the awaiter takes the result from
 * (scr_coro_direct_*) and then destroys. */
ScrFiber *scr_async_spawn_direct(void (*entry)(ScrFiber *, void *), void *argpack) {
  return scr_spawn_stackless_fiber(entry, argpack, true);
}
#endif

static void scr_await_park(ScrPromise *p);
static void scr_promise_rethrow(ScrPromise *p);

/* `await f(...)` of a fiber-backed async f in one call (the compiler's
 * await-call entry): spawn, then await the promise, with the same turns
 * as the two steps. When the child suspends in its eager prefix, the
 * awaiter is already parked on the pending promise, so the settle wake
 * resumes it with the result and no further hop; a child that finished
 * eagerly leaves a settled promise, which the ordinary await hops on.
 * Returns the promise +1; `ok` false means the rejection was re-thrown. */

static ScrPromise *scr_async_spawn_await(void (*entry)(ScrFiber *, void *), void *argpack,
                                         bool *ok) {
#ifdef SCR_SPAWN_AWAIT
  ScrFiber *self = scr_current;
  if (self != NULL && self->gen == NULL && self->inline_depth == 0 && !self->stackless) {
    ScrPromise *p = scr_async_spawn_impl(entry, argpack, self);
    if (self->await_parked) {
      self->await_parked = false;
      while (p->state == SCR_PROM_PENDING) scr_await_park(p);
      scr_prom_observe(p);
      if (p->state == SCR_PROM_REJECTED) {
        scr_promise_rethrow(p);
        *ok = false;
      } else {
        *ok = true;
      }
      return p;
    }
    *ok = scr_await_settled(p);
    return p;
  }
#endif
  ScrPromise *p = scr_async_spawn(entry, argpack);
  *ok = scr_await_settled(p);
  return p;
}

void scr_async_spawn_await_void(void (*entry)(ScrFiber *, void *), void *argpack) {
  bool ok;
  scr_promise_release(scr_async_spawn_await(entry, argpack, &ok));
}
double scr_async_spawn_await_f64(void (*entry)(ScrFiber *, void *), void *argpack) {
  bool ok;
  ScrPromise *p = scr_async_spawn_await(entry, argpack, &ok);
  double v = ok ? p->f64 : 0;
  scr_promise_release(p);
  return v;
}
bool scr_async_spawn_await_bool(void (*entry)(ScrFiber *, void *), void *argpack) {
  bool ok;
  ScrPromise *p = scr_async_spawn_await(entry, argpack, &ok);
  bool v = ok ? p->b : false;
  scr_promise_release(p);
  return v;
}
ScrStr *scr_async_spawn_await_str(void (*entry)(ScrFiber *, void *), void *argpack) {
  bool ok;
  ScrPromise *p = scr_async_spawn_await(entry, argpack, &ok);
  ScrStr *v = ok && p->payload ? scr_str_retain((ScrStr *)p->payload) : NULL;
  scr_promise_release(p);
  return v;
}
void *scr_async_spawn_await_ref(void (*entry)(ScrFiber *, void *), void *argpack) {
  bool ok;
  ScrPromise *p = scr_async_spawn_await(entry, argpack, &ok);
  void *v = ok && p->payload ? p->retain_fn(p->payload) : NULL;
  scr_promise_release(p);
  return v;
}

/* ── fiberless async calls ─────────────────────────────────────────────
 * An async function whose body the compiler proved can never park its
 * execution context (no await, no other suspending runtime call, directly
 * or through the functions it calls) completes synchronously on every
 * path, exactly like a fiber that never suspends: JS runs an async body
 * eagerly to its first await, and the promise settles before the call
 * returns. Running it on the caller's stack skips the fiber, its stack,
 * and two context switches while keeping every observable effect: the
 * settled promise is created and settled in the same order, rejections
 * enter the unhandled ledger through the same settle path, and the frame
 * isolates what a fresh fiber would — the Error.stack frame chain
 * (cell->stack). The AsyncLocalStorage context is the caller's throughout:
 * the whole body is the synchronous prefix Node runs in the caller's
 * execution, so a store it enters stays entered after the call
 * (scr_als_prefix_end). The caller's exception cell is clean at any call
 * (try/finally stashes in-flight exceptions), so a pending exception
 * after the body is the body's own throw. */
static void scr_inline_park_trap(void) {
  scr_trap("scriptc: internal error: fiberless async body suspended\n");
}

/* A stackless body has no stack to park: only its own emitted awaits may
 * suspend it (scr_coro_await_prepare). */
static void scr_stackless_park_trap(void) {
  scr_trap("scriptc: internal error: stackless async body parked its stack\n");
}

void scr_async_inline_enter(ScrAsyncInline *frame) {
  ScrExcCell *cell = scr_exc_current_cell();
  frame->stack = cell->stack;
  cell->stack = NULL;
  if (scr_current != NULL) scr_current->inline_depth++;
}

void scr_async_inline_exit(ScrAsyncInline *frame) {
  if (scr_current != NULL) scr_current->inline_depth--;
  scr_exc_current_cell()->stack = (ScrStackFrame *)frame->stack;
}

ScrPromise *scr_async_inline_leave(ScrAsyncInline *frame) {
  scr_async_inline_exit(frame);
  return scr_promise_new();
}

/* A runtime-authored C continuation whose first operation awaits one known
 * dependency. Native fibers can park normally. wasm32 has no resumable C
 * stack, so queue the fiber only after the dependency settles; the entry's
 * await then extracts the result without attempting a stack switch. The
 * READY queue supplies the settled-await microtask hop in both cases. */
ScrPromise *scr_async_spawn_after(ScrPromise *dependency,
                                  void (*entry)(ScrFiber *, void *),
                                  void *argpack) {
#ifndef __wasi__
  (void)dependency;
  return scr_async_spawn(entry, argpack);
#else
  ScrFiber *f = scr_mem_calloc(sizeof *f);
  if (!f) scr_oom();
  f->promise = scr_promise_new();
  f->entry = entry;
  f->argpack = argpack;
  f->als = scr_als_ctx_retain(*SCR_ALS_SLOT());
  f->region = scr_fiber_region_capture();
  scr_fibers_live++;

  if (dependency->state == SCR_PROM_PENDING) {
    scr_promise_add_waiter(dependency, f);
  } else {
    scr_ready_push(f);
  }
  return scr_promise_retain(f->promise);
#endif
}

/* Where a suspending async fiber switches to. During the eager prefix
 * under an await-call entry (awaiter set), control would return to the
 * awaiter only for it to park on this fiber's still-pending promise and
 * switch to its own resumer: park it here, for each such awaiter up the
 * chain, and switch there directly. Nothing runs in between either way. */
static ScrCtx *scr_fiber_park_awaiters(ScrFiber *self) {
  scr_als_prefix_end(self);
  ScrCtx *to = self->return_to;
#ifdef SCR_SPAWN_AWAIT
  for (ScrFiber *cur = self; cur->awaiter != NULL;) {
    ScrFiber *aw = cur->awaiter;
    cur->awaiter = NULL;
    /* The awaiter's await is its own suspension: its prefix ends here. */
    scr_als_prefix_end(aw);
    scr_promise_add_waiter(cur->promise, aw);
    aw->await_parked = true;
    to = aw->return_to;
    cur = aw;
  }
  /* Whoever resumes this fiber next (the loop) becomes its return target;
   * also right when the caller continues in place without switching. */
  self->return_to = to;
#endif
  return to;
}

/* Parks the current fiber on `p` until it settles. Only fibers await. */
static void scr_await_park(ScrPromise *p) {
  ScrFiber *self = scr_current;
  if (!self) {
    fputs("scriptc: internal error: await outside an async function\n", stderr);
    abort();
  }
  if (self->inline_depth != 0) scr_inline_park_trap();
  if (self->stackless) scr_stackless_park_trap();
  scr_promise_add_waiter(p, self);
#ifdef SCR_WORKERS
  self->waiting = p;
#endif
  scr_switch(&self->ctx, scr_fiber_park_awaiters(self), NULL);
#ifdef SCR_WORKERS
  /* Shutdown resumes suspended stacks without settling their dependencies.
   * Remove the borrowed waiter before the stack releases its promise. */
  if (self->waiting) {
    for (size_t i = 0; i < p->nwaiters; i++) {
      if (p->waiters[i] != self) continue;
      memmove(p->waiters + i, p->waiters + i + 1, (--p->nwaiters - i) * sizeof(*p->waiters));
      break;
    }
    self->waiting = NULL;
  }
#endif
  /* Resumed by the loop: return_to must now point at the loop's context. */
}

#ifdef __wasi__
/* The emitted coroutine suspends immediately after these preparation
 * calls. Settled promises still queue one ready turn; pending promises own
 * the continuation through their waiter list. */
void scr_wasi_await_prepare(ScrFiber *self, ScrPromise *p) {
  if (p->state == SCR_PROM_PENDING) {
    scr_promise_add_waiter(p, self);
  } else {
    scr_ready_push(self);
  }
}

void scr_wasi_await_hop_prepare(ScrFiber *self) { scr_ready_push(self); }

bool scr_wasi_module_await_prepare(ScrFiber *self, ScrPromise *p) {
  if (p->state != SCR_PROM_PENDING) return false;
  scr_wasi_await_prepare(self, p);
  return true;
}

void scr_wasi_async_finish(ScrFiber *self) { scr_fiber_finish(self); }

void scr_wasi_gen_finish(ScrFiber *self) {
  if (scr_exc_genret_pending()) {
    scr_exc_clear();
    scr_gen_ret_to_out(self->gen);
  }
  scr_fiber_finish(self);
}
#else
/* A stackless generator body's final block: the native trampoline
 * epilogue (consume a GENRET unwind, promoting the parked .return value)
 * plus the fiber's completion mark. */
void scr_gen_coro_finish(ScrFiber *self) {
  if (scr_exc_genret_pending()) {
    scr_exc_clear();
    scr_gen_ret_to_out(self->gen);
  }
  scr_fiber_finish(self);
}

/* A stackless async body's await. A pending promise owns the continuation
 * through its waiter list. A settled one (or a non-promise operand) takes
 * one microtask turn on the READY queue, except where scr_await_yield
 * continues a fiber in place: resumed by the loop's drain with nothing
 * else queued, this body is the very next job either way. */
static bool scr_coro_hop_needed(ScrFiber *self) {
  if (self->return_to == &scr_loop_ctx && scr_ready_len == 0) return false;
  scr_ready_push(self);
  return true;
}

bool scr_coro_await_prepare(ScrFiber *self, ScrPromise *p) {
  if (p->state == SCR_PROM_PENDING) {
    scr_promise_add_waiter(p, self);
    return true;
  }
  return scr_coro_hop_needed(self);
}

bool scr_coro_hop_prepare(ScrFiber *self) { return scr_coro_hop_needed(self); }

/* A directly awaited body's end: its awaiter is the promise's only waiter,
 * and it observes a rejection when it takes the result, so the body wakes
 * it where the settlement would, without the unhandled-rejection ledger. */
static void scr_direct_finish(ScrFiber *self) {
  ScrPromise *p = self->promise;
  bool stopped = false;
#ifdef SCR_WORKERS
  /* A stop request rejects like the fiber epilogue does (scr_fiber_finish). */
  stopped = scr_context_checkpoint();
#endif
  if (stopped || scr_exc_pending()) scr_promise_reject_from_cell(p, &self->exc);
  if (stopped) p->rejection_observed = true;
  if (p->state == SCR_PROM_PENDING)
    scr_trap("scriptc: internal error: directly awaited body finished unsettled\n");
  self->done = true;
  if (self->direct_awaiter != NULL) scr_promise_wake_one(self->direct_awaiter);
}

void scr_coro_async_finish(ScrFiber *self) {
  if (self->direct) scr_direct_finish(self);
  else scr_fiber_finish(self);
}

/* Extraction after the await's suspension: the promise has settled. */
static bool scr_coro_await_settled(ScrPromise *p) {
  if (p->state == SCR_PROM_PENDING)
    scr_trap("scriptc: internal error: resumed before awaited promise settled\n");
  scr_prom_observe(p);
  if (p->state == SCR_PROM_REJECTED) {
    scr_promise_rethrow(p);
    return false;
  }
  return true;
}

void scr_coro_await_void(ScrPromise *p) { scr_coro_await_settled(p); }
double scr_coro_await_f64(ScrPromise *p) { return scr_coro_await_settled(p) ? p->f64 : 0; }
bool scr_coro_await_bool(ScrPromise *p) { return scr_coro_await_settled(p) ? p->b : false; }
ScrStr *scr_coro_await_str(ScrPromise *p) {
  return scr_coro_await_settled(p) && p->payload ? scr_str_retain((ScrStr *)p->payload) : NULL;
}
void *scr_coro_await_ref(ScrPromise *p) {
  return scr_coro_await_settled(p) && p->payload ? p->retain_fn(p->payload) : NULL;
}

/* A direct await of a stackless body (scr_async_spawn_direct): a body
 * still running gets the coroutine as its only awaiter, which its finish
 * wakes as a settlement wakes a promise's waiter; a finished body is a
 * settled promise, which takes one microtask turn. */
bool scr_coro_direct_prepare(ScrFiber *self, ScrFiber *callee) {
  if (!callee->done) {
    callee->direct_awaiter = self;
    return true;
  }
  return scr_coro_hop_needed(self);
}

/* The result of a finished direct body: its promise's settlement, read as
 * scr_coro_await_* reads it (a rejection re-throws), then the record goes. */
static inline void scr_direct_destroy(ScrFiber *f) {
  /* Only a rejection reason is left: values moved out, and nothing waits
   * on or shares the promise. */
  if (f->promise->payload_kind != SCR_EXC_NONE) scr_promise_release_payload(f->promise);
  scr_fiber_destroy(f);
  scr_fibers_live--;
}

void scr_coro_direct_void(ScrFiber *f) {
  scr_coro_await_settled(f->promise);
  scr_direct_destroy(f);
}
double scr_coro_direct_f64(ScrFiber *f) {
  double v = scr_coro_await_settled(f->promise) ? f->promise->f64 : 0;
  scr_direct_destroy(f);
  return v;
}
bool scr_coro_direct_bool(ScrFiber *f) {
  bool v = scr_coro_await_settled(f->promise) ? f->promise->b : false;
  scr_direct_destroy(f);
  return v;
}
/* String and reference results move out of the record (+1). */
ScrStr *scr_coro_direct_str(ScrFiber *f) {
  ScrPromise *p = f->promise;
  ScrStr *v = NULL;
  if (scr_coro_await_settled(p)) {
    v = (ScrStr *)p->payload;
    p->payload = NULL;
    p->payload_kind = SCR_EXC_NONE;
  }
  scr_direct_destroy(f);
  return v;
}
void *scr_coro_direct_ref(ScrFiber *f) {
  ScrPromise *p = f->promise;
  void *v = NULL;
  if (scr_coro_await_settled(p)) {
    v = p->payload;
    p->payload = NULL;
    p->payload_kind = SCR_EXC_NONE;
  }
  scr_direct_destroy(f);
  return v;
}
#endif

/* One microtask hop: park the current fiber on the READY queue itself and
 * yield. JS's `await` ALWAYS suspends — even on an already-settled promise
 * the continuation runs as a microtask — so without this hop an awaiter of
 * a settled promise would continue synchronously inside the spawner,
 * observably earlier than Node (corpus 1428 pins the ordering). */
static void scr_await_yield(void) {
  ScrFiber *self = scr_current;
  if (!self) {
    fputs("scriptc: internal error: await outside an async function\n", stderr);
    abort();
  }
  if (self->inline_depth != 0) scr_inline_park_trap();
  if (self->stackless) scr_stackless_park_trap();
  if (self->gen != NULL) {
    scr_ready_push(self);
    scr_switch(&self->ctx, self->return_to, NULL);
    return;
  }
  /* The hop would return control to the loop's microtask drain with
   * nothing else queued (this async fiber, or the awaiters parked for it,
   * were resumed by the drain), so this fiber would be the very next job:
   * the drain runs to exhaustion with no checkpoint in between. Continuing
   * in place is the same turn order without the two switches. A fiber
   * resumed by its spawner (the eager prefix) must still hop: the spawner
   * has code to run first. */
  ScrCtx *to = scr_fiber_park_awaiters(self);
  if (to == &scr_loop_ctx && scr_ready_len == 0) return;
  scr_ready_push(self);
  scr_switch(&self->ctx, to, NULL);
}

/* The emitted promise-or-absent await's unit arm (`await u` where u holds
 * undefined/null): JS awaits non-thenables through exactly one microtask
 * turn — the same hop a settled promise takes. */
void scr_await_hop(void) { scr_await_yield(); }

/* Copies a rejection into the active execution context's exception cell.
 * The payload is RETAINED, not moved — a promise can be awaited more than
 * once, and the executable's top-level completion probe consumes the same
 * settlement from the main stack after the loop drains. */
static void scr_promise_rethrow(ScrPromise *p) {
  switch (p->payload_kind) {
  case SCR_EXC_F64: scr_throw_f64(p->f64); break;
  case SCR_EXC_BOOL: scr_throw_bool(p->b); break;
  case SCR_EXC_STR: scr_throw_str(scr_str_retain((ScrStr *)p->payload)); break;
  case SCR_EXC_REF: scr_throw_ref(p->retain_fn(p->payload), p->retain_fn, p->release_fn, p->trace_fn); break;
  case SCR_EXC_PRIMITIVE_REF: scr_throw_primitive_ref(p->retain_fn(p->payload), p->retain_fn, p->release_fn, p->trace_fn); break;
  case SCR_EXC_OBJ: scr_throw_obj(p->retain_fn(p->payload), p->retain_fn, p->release_fn, p->trace_fn); break;
  case SCR_EXC_NONE:
  case SCR_EXC_TERMINATE:
  case SCR_EXC_GENRET: /* unreachable: the sentinel never settles a promise */
    scr_throw_str(scr_str_new("undefined", 9));
    break;
  }
}

/* Await result extraction. Rejection re-throws into the awaiter. */
static bool scr_await_settled(ScrPromise *p) {
#ifdef SCR_WORKERS
  if (scr_context_checkpoint()) return false;
#endif
#ifdef __wasi__
  if (p->state == SCR_PROM_PENDING) {
    fputs("scriptc: internal error: resumed before awaited promise settled\n", stderr);
    abort();
  }
#else
  if (p->state != SCR_PROM_PENDING) scr_await_yield();
  while (p->state == SCR_PROM_PENDING) {
#ifdef SCR_WORKERS
    if (scr_context_checkpoint()) return false;
#endif
    scr_await_park(p);
  }
#ifdef SCR_WORKERS
  if (scr_context_checkpoint()) return false;
#endif
#endif
  scr_prom_observe(p);
  if (p->state == SCR_PROM_REJECTED) {
    scr_promise_rethrow(p);
    return false;
  }
  return true;
}

bool scr_promise_settled_now(ScrPromise *p) {
  if (p->state == SCR_PROM_PENDING) return false;
  scr_prom_observe(p);
  if (p->state == SCR_PROM_REJECTED) scr_promise_rethrow(p);
  return true;
}

bool scr_promise_payload_truthy(const ScrPromise *p) {
  switch (p->payload_kind) {
    case SCR_EXC_NONE: return false;
    case SCR_EXC_F64: return p->f64 != 0 && p->f64 == p->f64;
    case SCR_EXC_BOOL: return p->b;
    case SCR_EXC_STR: return p->payload && ((const ScrStr *)p->payload)->len > 0;
    default:
      if (p->retain_fn == scr_dyn_retain_v) return p->payload && scr_dyn_truthy(p->payload);
      return p->payload != NULL;
  }
}

double scr_await_f64(ScrPromise *p) {
  return scr_await_settled(p) ? p->f64 : 0;
}
bool scr_await_bool(ScrPromise *p) {
  return scr_await_settled(p) ? p->b : false;
}
void *scr_await_ref(ScrPromise *p) {
  return scr_await_settled(p) && p->payload ? p->retain_fn(p->payload) : NULL;
}
void scr_await_void(ScrPromise *p) { scr_await_settled(p); }

/* ECMAScript's INTERNAL module-dependency wait. Unlike a user-authored
 * await, an already-completed dependency does not introduce a promise-job
 * hop: the evaluator continues synchronously into the importer. A pending
 * dependency still parks this module fiber, and rejection propagates into
 * it exactly like an ordinary await. */
void scr_module_await(ScrPromise *p) {
#ifndef __wasi__
  while (p->state == SCR_PROM_PENDING) scr_await_park(p);
#endif
  scr_prom_observe(p);
  if (p->state == SCR_PROM_REJECTED) scr_promise_rethrow(p);
}

int scr_promise_finish_top_level(ScrPromise *p) {
  if (p->state == SCR_PROM_PENDING) {
    /* ECMAScript module evaluation is still pending, but Node's ref'd
     * event-loop work is exhausted. Node exits with its dedicated
     * unsettled-top-level-await status unless the program set a nonzero
     * process.exitCode (`process.exitCode || 13`). Uncaught errors and
     * reported rejections leave through other exits, so a nonzero hint
     * here is the program's own. */
    if (scr_exit_code_hint_get() == 0) scr_exit_code_note(13);
    return 13;
  }
  scr_prom_observe(p);
  return p->state == SCR_PROM_REJECTED && !p->top_level_handled ? 1 : 0;
}

void scr_promise_rethrow_top_level(ScrPromise *p) {
  if (p->state == SCR_PROM_REJECTED) scr_promise_rethrow(p);
}

/* Fulfillment storers, called by the compiled trampolines / resolve thunks. */
void scr_promise_fulfill_f64(ScrPromise *p, double v) {
  if (p->state != SCR_PROM_PENDING) return; /* first settle wins */
  p->state = SCR_PROM_FULFILLED;
  p->payload_kind = SCR_EXC_F64;
  p->f64 = v;
  scr_promise_settle_wake(p);
}
void scr_promise_fulfill_bool(ScrPromise *p, bool v) {
  if (p->state != SCR_PROM_PENDING) return;
  p->state = SCR_PROM_FULFILLED;
  p->payload_kind = SCR_EXC_BOOL;
  p->b = v;
  scr_promise_settle_wake(p);
}
void scr_promise_fulfill_ref(ScrPromise *p, void *v, void *(*retain)(void *), void (*release)(void *), ScrTraceFn trace) {
  if (p->state != SCR_PROM_PENDING) {
    if (release) release(v); /* value was +1 for us; drop it */
    return;
  }
  p->state = SCR_PROM_FULFILLED;
  p->payload_kind = v ? SCR_EXC_REF : SCR_EXC_NONE;
  p->payload = v;
  p->retain_fn = retain;
  p->release_fn = release;
  p->trace_fn = trace;
  scr_promise_settle_wake(p);
}
void scr_promise_fulfill_like(ScrPromise *p, const ScrPromise *src) {
  if (p->state != SCR_PROM_PENDING) return;
  p->state = SCR_PROM_FULFILLED;
  p->payload_kind = src->payload_kind;
  p->f64 = src->f64;
  p->b = src->b;
  p->payload = src->payload && src->retain_fn ? src->retain_fn(src->payload) : src->payload;
  p->retain_fn = src->retain_fn;
  p->release_fn = src->release_fn;
  p->trace_fn = src->trace_fn;
  scr_promise_settle_wake(p);
}
void scr_promise_fulfill_void(ScrPromise *p) {
  if (p->state != SCR_PROM_PENDING) return;
  p->state = SCR_PROM_FULFILLED;
  p->payload_kind = SCR_EXC_NONE;
  scr_promise_settle_wake(p);
}

/* String payloads ride the STR kind so awaits type them precisely. */
void scr_promise_fulfill_str(ScrPromise *p, ScrStr *v) {
  if (p->state != SCR_PROM_PENDING) {
    scr_str_release(v);
    return;
  }
  p->state = SCR_PROM_FULFILLED;
  p->payload_kind = SCR_EXC_STR;
  p->payload = v; /* ownership moves in */
  p->retain_fn = (void *(*)(void *))scr_str_retain;
  p->release_fn = (void (*)(void *))scr_str_release;
  scr_promise_settle_wake(p);
}
ScrStr *scr_await_str(ScrPromise *p) {
  return scr_await_settled(p) && p->payload ? scr_str_retain((ScrStr *)p->payload) : NULL;
}

void scr_promise_reject_pending(ScrPromise *p) {
  if (!scr_exc_pending()) return;
  if (p->state == SCR_PROM_PENDING) {
    scr_promise_reject_from_cell(p, scr_exc_current_cell());
    scr_promise_settle_wake(p);
  } else {
    scr_exc_clear();
  }
}

/* ── settled-promise minting (the fs/promises bridge) ─────────────────
 * The promise-returning stdlib functions run their syscall SYNCHRONOUSLY
 * (the documented non-interleaving divergence, SEMANTICS.md) and wrap the
 * outcome here: a pending exception in the active cell becomes the
 * promise's REJECTION (moved out of the cell — the caller's pending check
 * then sees a clean cell, exactly like Node where fs/promises failures
 * reject instead of throwing), anything else fulfills with the payload.
 * The rejected case still enters the unhandled-rejection ledger, so a
 * never-awaited failure reports at exit like any other rejection. */

static ScrPromise *scr_promise_settled_common(void) {
  if (!scr_exc_pending()) return NULL;
  ScrPromise *p = scr_promise_new();
  scr_promise_reject_from_cell(p, scr_exc_current_cell());
  scr_promise_settle_wake(p); /* no waiters yet; enters the ledger */
  return p;
}

ScrPromise *scr_promise_settled_str(ScrStr *v) {
  ScrPromise *rejected = scr_promise_settled_common();
  if (rejected) {
    scr_str_release(v); /* NULL-tolerant; the op returned a dummy */
    return rejected;
  }
  ScrPromise *p = scr_promise_new();
  scr_promise_fulfill_str(p, v); /* moves in */
  return p;
}

ScrPromise *scr_promise_settled_void(void) {
  ScrPromise *rejected = scr_promise_settled_common();
  if (rejected) return rejected;
  ScrPromise *p = scr_promise_new();
  scr_promise_fulfill_void(p);
  return p;
}

ScrPromise *scr_promise_settled_ref(void *v, void *(*retain)(void *), void (*release)(void *),
                                     ScrTraceFn trace) {
  ScrPromise *rejected = scr_promise_settled_common();
  if (rejected) {
    if (v && release) release(v);
    return rejected;
  }
  ScrPromise *p = scr_promise_new();
  scr_promise_fulfill_ref(p, v, retain, release, trace); /* moves in */
  return p;
}

/* ── fs/promises ─────────────────────────────────────────────────────
 * The promise forms run the SAME sync operations and mint an already-
 * settled promise (scr_promise_settled_*): success fulfills, a pending
 * exception moves in as the rejection — catchable at the await, like
 * Node. DOCUMENTED DIVERGENCE (SEMANTICS.md): the syscall blocks the
 * event loop, so I/O never interleaves with timers or other fibers —
 * observable only in concurrent code, not in the sequential await
 * chains CLIs are made of. */

ScrPromise *scr_fsp_read_file(ScrStr *path) {
  return scr_promise_settled_str(scr_fs_read_file(path));
}

ScrPromise *scr_fsp_write_file(ScrStr *path, ScrStr *data) {
  scr_fs_write_file(path, data);
  return scr_promise_settled_void();
}

ScrPromise *scr_fsp_write_file_mode(ScrStr *path, ScrStr *data, double mode) {
  scr_fs_write_file_mode(path, data, mode);
  return scr_promise_settled_void();
}

ScrPromise *scr_fsp_mkdir(ScrStr *path) {
  scr_fs_mkdir(path);
  return scr_promise_settled_void();
}

ScrPromise *scr_fsp_mkdir_mode(ScrStr *path, double mode) {
  scr_fs_mkdir_mode(path, mode);
  return scr_promise_settled_void();
}

ScrPromise *scr_fsp_mkdir_recursive(ScrStr *path) {
  scr_fs_mkdir_recursive(path);
  return scr_promise_settled_void();
}

ScrPromise *scr_fsp_mkdir_recursive_mode(ScrStr *path, double mode) {
  scr_fs_mkdir_recursive_mode(path, mode);
  return scr_promise_settled_void();
}

ScrPromise *scr_fsp_unlink(ScrStr *path) {
  scr_fs_unlink(path);
  return scr_promise_settled_void();
}

ScrPromise *scr_fsp_chmod(ScrStr *path, double mode) {
  scr_fs_chmod(path, mode);
  return scr_promise_settled_void();
}

ScrPromise *scr_fsp_chown(ScrStr *path, double uid, double gid) {
  scr_fs_chown(path, uid, gid);
  return scr_promise_settled_void();
}

ScrPromise *scr_fsp_lchown(ScrStr *path, double uid, double gid) {
  scr_fs_lchown(path, uid, gid);
  return scr_promise_settled_void();
}

ScrPromise *scr_fsp_access(ScrStr *path, double mode) {
  scr_fs_access(path, mode);
  return scr_promise_settled_void();
}

ScrPromise *scr_fsp_append_file(ScrStr *path, ScrStr *data) {
  scr_fs_append_file(path, data);
  return scr_promise_settled_void();
}

ScrPromise *scr_fsp_append_file_bytes(ScrStr *path, ScrBytes *data) {
  scr_fs_append_file_bytes(path, data);
  return scr_promise_settled_void();
}

ScrPromise *scr_fsp_copyfile(ScrStr *src, ScrStr *dest) {
  scr_fs_copyfile(src, dest);
  return scr_promise_settled_void();
}

/* readFile(path, encoding | { encoding }): the encoding is checked first,
 * so an unknown name rejects before the read. */
ScrPromise *scr_fsp_read_file_encoded(ScrStr *path, ScrStr *encoding) {
  return scr_promise_settled_str(scr_fs_read_file_encoded(path, encoding));
}

ScrPromise *scr_fsp_mkdtemp(ScrStr *prefix) {
  return scr_promise_settled_str(scr_fs_mkdtemp_async(prefix));
}

ScrPromise *scr_fsp_rmdir(ScrStr *path) {
  scr_fs_rmdir(path);
  return scr_promise_settled_void();
}

ScrPromise *scr_fsp_truncate(ScrStr *path, double length) {
  scr_fs_truncate(path, length);
  return scr_promise_settled_void();
}

ScrPromise *scr_fsp_utimes(const ScrDyn *path, const ScrDyn *atime, const ScrDyn *mtime) {
  scr_fs_utimes_checked(path, atime, mtime);
  return scr_promise_settled_void();
}

ScrPromise *scr_fsp_link(const ScrDyn *existing, const ScrDyn *destination) {
  scr_fs_link_checked(existing, destination);
  return scr_promise_settled_void();
}

ScrPromise *scr_fsp_symlink(const ScrDyn *target, const ScrDyn *destination, const ScrDyn *type) {
  scr_fs_symlink_promise_checked(target, destination, type);
  return scr_promise_settled_void();
}

ScrPromise *scr_fsp_readlink_dyn(const ScrDyn *path, const ScrDyn *options) {
  ScrDyn *result = scr_fs_readlink_checked(path, options, true);
  return scr_promise_settled_ref(result, scr_dyn_retain_v, scr_dyn_release_v, scr_dyn_trace_v);
}

ScrPromise *scr_fsp_statfs(const ScrDyn *path, const ScrDyn *options) {
  ScrDyn *result = scr_fs_statfs_checked(path, options);
  return scr_promise_settled_ref(result, scr_dyn_retain_v, scr_dyn_release_v, scr_dyn_trace_v);
}

ScrPromise *scr_fsp_readlink_str(const ScrDyn *path, const ScrDyn *options) {
  ScrDyn *result = scr_fs_readlink_checked(path, options, true);
  ScrStr *text = result && result->kind == SCR_DYN_STR ? scr_str_retain(result->v.str) : NULL;
  scr_dyn_release(result);
  return scr_promise_settled_str(text);
}

ScrPromise *scr_fsp_readlink_buffer(const ScrDyn *path, const ScrDyn *options) {
  ScrDyn *result = scr_fs_readlink_checked(path, options, true);
  ScrBytes *bytes = result ? scr_dyn_bytes_unbox(result) : NULL;
  scr_dyn_release(result);
  return scr_promise_settled_ref(bytes, scr_bytes_retain_v, scr_bytes_release_v, NULL);
}

ScrPromise *scr_fsp_lutimes(const ScrDyn *path, const ScrDyn *atime, const ScrDyn *mtime) {
  scr_fs_lutimes_checked(path, atime, mtime);
  return scr_promise_settled_void();
}

ScrPromise *scr_fsp_readdir(ScrStr *path) {
  ScrArr *names = scr_fs_readdir(path);
  return scr_promise_settled_ref(names, &scr_arr_retain_v, &scr_arr_release_v, NULL);
}

ScrPromise *scr_fsp_rm(ScrStr *path) {
  scr_fs_rm(path);
  return scr_promise_settled_void();
}

ScrPromise *scr_fsp_rm_opts(ScrStr *path, bool recursive, bool force) {
  scr_fs_rm_opts(path, recursive, force);
  return scr_promise_settled_void();
}

/* fs.promises.rm validates the path before its options, unlike rmSync. */
ScrPromise *scr_fsp_rm_opts_retry(ScrStr *path, bool recursive, bool force, double max_retries,
                                  double retry_delay) {
  if (scr_fs_path_ok(path, "path") && scr_fs_rm_retry_options_ok(max_retries, retry_delay))
    scr_fs_rm_opts_retry(path, recursive, force, max_retries, retry_delay);
  return scr_promise_settled_void();
}

ScrPromise *scr_fsp_stat(ScrStr *path) {
  ScrStats *st = scr_fs_stat(path);
  return scr_promise_settled_ref(st, &scr_stats_retain_v, &scr_stats_release_v, NULL);
}

ScrPromise *scr_fsp_realpath(ScrStr *path) {
  return scr_promise_settled_str(scr_fs_realpath_promise(path));
}

ScrPromise *scr_fsp_lstat(ScrStr *path) {
  ScrStats *st = scr_fs_lstat(path);
  return scr_promise_settled_ref(st, &scr_stats_retain_v, &scr_stats_release_v, NULL);
}

ScrPromise *scr_fsp_opendir(ScrStr *path, double buffer_size) {
  ScrDir *d = scr_fs_opendir(path, buffer_size);
  return scr_promise_settled_ref(d, &scr_dir_retain_v, &scr_dir_release_v, NULL);
}

/* dir.close(): a closed Dir rejects with ERR_DIR_CLOSED. */
ScrPromise *scr_dir_close_promise(ScrDir *d) {
  scr_dir_close(d);
  return scr_promise_settled_void();
}

ScrPromise *scr_fsp_rename(ScrStr *oldpath, ScrStr *newpath) {
  scr_fs_rename(oldpath, newpath);
  return scr_promise_settled_void();
}

/* Shared native work queue, initially introduced by fs.rename and also used
 * by node:zlib's callback codecs. Work starts immediately on a native worker,
 * matching libuv's key contract while JS/main is synchronously occupied.
 * Error/Buffer construction, callback invocation, and every RC mutation stay
 * on the main runtime thread when a later loop turn observes completion.
 *
 * A compact operation queue is also the liveness handle: an outstanding
 * callback-style request keeps the loop alive. Four persistent workers mirror
 * libuv's default pool size without creating one OS thread per request. A
 * platform mutex publishes each result before the loop removes it from the
 * completion queue. */
#if !defined(SCR_LIB) && !defined(__wasi__)
/* The completion wake: a worker signals it once per published completion,
 * so the loop's sleep ends for the completion — a pipe the poll(2) sleep
 * watches on POSIX, an auto-reset event the Windows sleep waits on. */
typedef struct ScrFsRenameWake {
#ifdef _WIN32
  HANDLE event; /* NULL until created */
#else
  int fds[2]; /* -1 until created */
#endif
} ScrFsRenameWake;
#ifdef _WIN32
#define SCR_FS_RENAME_WAKE_NONE {NULL}
#else
#define SCR_FS_RENAME_WAKE_NONE {{-1, -1}}
#endif
#ifdef SCR_WORKERS
typedef struct ScrFsRenameOwner ScrFsRenameOwner;
#endif
typedef struct ScrFsRenameOp {
  bool generic;
  bool ran;
  void *payload;
  ScrWorkFn work;
  ScrWorkFn after;
  ScrWorkFn destroy;
  ScrStr *oldpath;
  ScrStr *newpath;
  ScrClosure *cb;
  ScrFsRenameFn fn;
  int error;
  struct ScrFsRenameOp *next;
#ifdef SCR_WORKERS
  ScrFsRenameOwner *owner;
#endif
} ScrFsRenameOp;

static ScrFsRenameOp *scr_fs_rename_work = NULL;
static ScrFsRenameOp **scr_fs_rename_work_tail = &scr_fs_rename_work;
#ifdef SCR_WORKERS
struct ScrFsRenameOwner {
  ScrFsRenameOp *done;
  ScrFsRenameOp **tail;
  size_t pending;
  ScrFsRenameWake wake;
};
static SCR_TL ScrFsRenameOwner *scr_fs_rename_owner;
#define scr_fs_rename_done (scr_fs_rename_owner->done)
#define scr_fs_rename_done_tail (scr_fs_rename_owner->tail)
#define scr_fs_rename_pending_count (scr_fs_rename_owner->pending)
#else
static ScrFsRenameOp *scr_fs_rename_done = NULL;
static ScrFsRenameOp **scr_fs_rename_done_tail = &scr_fs_rename_done;
static size_t scr_fs_rename_pending_count = 0;
static ScrFsRenameWake scr_fs_rename_wake_global = SCR_FS_RENAME_WAKE_NONE;
#endif
static size_t scr_fs_rename_worker_count = 0;
static bool scr_fs_rename_stopping = false;
static bool scr_fs_rename_shutdown_registered = false;

#ifdef _WIN32
static HANDLE scr_fs_rename_workers[4];
static SRWLOCK scr_fs_rename_lock = SRWLOCK_INIT;
static CONDITION_VARIABLE scr_fs_rename_cond = CONDITION_VARIABLE_INIT;
static void scr_fs_rename_lock_enter(void) { AcquireSRWLockExclusive(&scr_fs_rename_lock); }
static void scr_fs_rename_lock_leave(void) { ReleaseSRWLockExclusive(&scr_fs_rename_lock); }
static void scr_fs_rename_wait(void) {
  (void)SleepConditionVariableSRW(&scr_fs_rename_cond, &scr_fs_rename_lock, INFINITE, 0);
}
static void scr_fs_rename_signal(void) { WakeConditionVariable(&scr_fs_rename_cond); }
static void scr_fs_rename_broadcast(void) { WakeAllConditionVariable(&scr_fs_rename_cond); }
#else
static pthread_t scr_fs_rename_workers[4];
static pthread_mutex_t scr_fs_rename_lock = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t scr_fs_rename_cond = PTHREAD_COND_INITIALIZER;
static void scr_fs_rename_lock_enter(void) { (void)pthread_mutex_lock(&scr_fs_rename_lock); }
static void scr_fs_rename_lock_leave(void) { (void)pthread_mutex_unlock(&scr_fs_rename_lock); }
static void scr_fs_rename_wait(void) {
  (void)pthread_cond_wait(&scr_fs_rename_cond, &scr_fs_rename_lock);
}
static void scr_fs_rename_signal(void) { (void)pthread_cond_signal(&scr_fs_rename_cond); }
static void scr_fs_rename_broadcast(void) { (void)pthread_cond_broadcast(&scr_fs_rename_cond); }
#endif

#ifdef SCR_WORKERS
#define SCR_FS_RENAME_WAKE(owner) (&(owner)->wake)
#else
#define SCR_FS_RENAME_WAKE(owner) (&scr_fs_rename_wake_global)
#endif

/* Creation failure leaves the wake unset; the loop then bounds its sleep
 * at the child-reap cap, as it did before the wake existed. */
static void scr_fs_rename_wake_open(ScrFsRenameWake *wake) {
#ifdef _WIN32
  if (wake->event == NULL) wake->event = CreateEventW(NULL, FALSE, FALSE, NULL);
#else
  if (wake->fds[0] >= 0) return;
  int fds[2];
  if (pipe(fds) != 0) return;
  for (int i = 0; i < 2; i++) {
    (void)fcntl(fds[i], F_SETFD, FD_CLOEXEC);
    (void)fcntl(fds[i], F_SETFL, fcntl(fds[i], F_GETFL) | O_NONBLOCK);
  }
  wake->fds[0] = fds[0];
  wake->fds[1] = fds[1];
#endif
}

static void scr_fs_rename_wake_post(ScrFsRenameWake *wake) {
#ifdef _WIN32
  if (wake->event != NULL) (void)SetEvent(wake->event);
#else
  if (wake->fds[1] >= 0) {
    char byte = 1;
    ssize_t n = write(wake->fds[1], &byte, 1); /* a full pipe already wakes the loop */
    (void)n;
  }
#endif
}

/* POSIX: empty the pipe before taking the queue, so a completion published
 * afterwards leaves its byte for the next poll. The Windows event resets
 * when a wait consumes it. */
static void scr_fs_rename_wake_drain(ScrFsRenameWake *wake) {
#ifdef _WIN32
  (void)wake;
#else
  if (wake->fds[0] < 0) return;
  char buf[64];
  while (read(wake->fds[0], buf, sizeof buf) > 0) {
  }
#endif
}

#ifdef SCR_WORKERS
static void scr_fs_rename_wake_close(ScrFsRenameWake *wake) {
#ifdef _WIN32
  if (wake->event != NULL) CloseHandle(wake->event);
  wake->event = NULL;
#else
  for (int i = 0; i < 2; i++) {
    if (wake->fds[i] >= 0) close(wake->fds[i]);
    wake->fds[i] = -1;
  }
#endif
}
#endif

static void scr_fs_rename_op_release(ScrFsRenameOp *op) {
  if (op->generic) {
    op->destroy(op->payload);
    free(op);
    return;
  }
  scr_str_release(op->oldpath);
  scr_str_release(op->newpath);
  scr_closure_release(op->cb);
  free(op);
}

#ifdef SCR_WORKERS
static void scr_fs_rename_context_cleanup(void) {
  ScrFsRenameOwner *owner = scr_fs_rename_owner;
  /* Outstanding native work may still borrow payload storage. Wait for its
   * publication before reclaiming it, without invoking script callbacks
   * during context teardown. Other script contexts keep using the pool. */
  while (owner->pending) {
    scr_fs_rename_lock_enter();
    while (!owner->done) scr_fs_rename_wait();
    ScrFsRenameOp *op = owner->done;
    owner->done = op->next;
    if (!owner->done) owner->tail = &owner->done;
    scr_fs_rename_lock_leave();
    owner->pending--;
    scr_fs_rename_op_release(op);
  }
  scr_fs_rename_owner = NULL;
  scr_fs_rename_wake_close(&owner->wake);
  free(owner);
}

static ScrFsRenameOwner *scr_fs_rename_context(void) {
  if (!scr_fs_rename_owner) {
    ScrFsRenameOwner *owner = calloc(1, sizeof(*owner));
    if (!owner) scr_oom();
    owner->tail = &owner->done;
    owner->wake = (ScrFsRenameWake)SCR_FS_RENAME_WAKE_NONE;
    if (scr_atexit(scr_fs_rename_context_cleanup) != 0) {
      free(owner);
      scr_trap("scriptc: could not register work context cleanup\n");
    }
    scr_fs_rename_owner = owner;
  }
  return scr_fs_rename_owner;
}
#endif

static void scr_fs_rename_worker_loop(void) {
  for (;;) {
    scr_fs_rename_lock_enter();
    while (scr_fs_rename_work == NULL && !scr_fs_rename_stopping) scr_fs_rename_wait();
    if (scr_fs_rename_stopping) {
      scr_fs_rename_lock_leave();
      return;
    }
    ScrFsRenameOp *op = scr_fs_rename_work;
    scr_fs_rename_work = op->next;
    if (scr_fs_rename_work == NULL) scr_fs_rename_work_tail = &scr_fs_rename_work;
    scr_fs_rename_lock_leave();

    if (op->generic) op->work(op->payload);
    else op->error = scr_fs_rename_raw(op->oldpath, op->newpath);
    op->ran = true;

    scr_fs_rename_lock_enter();
    op->next = NULL;
#ifdef SCR_WORKERS
    *op->owner->tail = op;
    op->owner->tail = &op->next;
    scr_fs_rename_broadcast();
    scr_fs_rename_wake_post(&op->owner->wake);
#else
    *scr_fs_rename_done_tail = op;
    scr_fs_rename_done_tail = &op->next;
    scr_fs_rename_wake_post(&scr_fs_rename_wake_global);
#endif
    scr_fs_rename_lock_leave();
  }
}

#ifdef _WIN32
static DWORD WINAPI scr_fs_rename_worker(LPVOID payload) {
  (void)payload;
  scr_fs_rename_worker_loop();
  return 0;
}
#else
static void *scr_fs_rename_worker(void *payload) {
  (void)payload;
  scr_fs_rename_worker_loop();
  return NULL;
}
#endif

/* Runs before the ordinary runtime atexit cleanup/audit (it is registered
 * lazily by the first rename request, after scr_init/scr_lib_init). Fatal
 * top-level or callback exceptions can stop the loop with requests still in
 * flight; join the workers before releasing their retained path/callback
 * payloads so sanitized builds keep the program's real exit verdict. */
static void scr_fs_renames_shutdown(void) {
  scr_fs_rename_lock_enter();
  scr_fs_rename_stopping = true;
  scr_fs_rename_broadcast();
  scr_fs_rename_lock_leave();

  for (size_t i = 0; i < scr_fs_rename_worker_count; i++) {
#ifdef _WIN32
    (void)WaitForSingleObject(scr_fs_rename_workers[i], INFINITE);
    CloseHandle(scr_fs_rename_workers[i]);
#else
    (void)pthread_join(scr_fs_rename_workers[i], NULL);
#endif
  }

  scr_fs_rename_lock_enter();
#ifdef SCR_WORKERS
  /* Every context drains its in-flight work before it exits. This final
   * process hook owns only the pool threads and cannot touch runtime heaps. */
  if (scr_fs_rename_work) {
    scr_fs_rename_lock_leave();
    scr_trap("scriptc: work queue survived context teardown\n");
  }
  scr_fs_rename_lock_leave();
#else
  ScrFsRenameOp *work = scr_fs_rename_work;
  ScrFsRenameOp *done = scr_fs_rename_done;
  scr_fs_rename_work = NULL;
  scr_fs_rename_work_tail = &scr_fs_rename_work;
  scr_fs_rename_done = NULL;
  scr_fs_rename_done_tail = &scr_fs_rename_done;
  scr_fs_rename_pending_count = 0;
  scr_fs_rename_lock_leave();
  while (work != NULL) {
    ScrFsRenameOp *next = work->next;
    scr_fs_rename_op_release(work);
    work = next;
  }
  while (done != NULL) {
    ScrFsRenameOp *next = done->next;
    scr_fs_rename_op_release(done);
    done = next;
  }
#endif
}

static bool scr_fs_renames_pending(void) {
#ifdef SCR_WORKERS
  if (!scr_fs_rename_owner) return false;
#endif
  return scr_fs_rename_pending_count != 0;
}

/* POSIX: the loop polls this fd while completions are pending (-1: none). */
static int scr_fs_renames_pollfd(void) {
#if defined(_WIN32)
  return -1;
#else
#ifdef SCR_WORKERS
  if (!scr_fs_rename_owner) return -1;
#endif
  return SCR_FS_RENAME_WAKE(scr_fs_rename_owner)->fds[0];
#endif
}

/* Windows: the loop's sleep waits on the event (false: no event). */
static bool scr_fs_renames_can_wait(void) {
#if defined(_WIN32)
#ifdef SCR_WORKERS
  if (!scr_fs_rename_owner) return false;
#endif
  return SCR_FS_RENAME_WAKE(scr_fs_rename_owner)->event != NULL;
#else
  return false;
#endif
}

#ifdef _WIN32
static void scr_fs_renames_wait(double ms) {
  DWORD timeout = ms >= 4294967294.0 ? 4294967294u : (DWORD)(ms + 0.999);
  (void)WaitForSingleObject(SCR_FS_RENAME_WAKE(scr_fs_rename_owner)->event, timeout);
}
#endif

static bool scr_fs_renames_dispatch(void) {
#ifdef SCR_WORKERS
  if (!scr_fs_rename_owner) return false;
#endif
  scr_fs_rename_wake_drain(SCR_FS_RENAME_WAKE(scr_fs_rename_owner));
  scr_fs_rename_lock_enter();
  ScrFsRenameOp *op = scr_fs_rename_done;
  if (op != NULL) {
    scr_fs_rename_done = op->next;
    if (scr_fs_rename_done == NULL) scr_fs_rename_done_tail = &scr_fs_rename_done;
  }
  scr_fs_rename_lock_leave();
  if (op == NULL) return false;
  scr_fs_rename_pending_count--;
  if (op->generic) {
    if (!op->ran) op->work(op->payload);
    op->after(op->payload);
    scr_fs_rename_op_release(op);
    return true;
  }
  ScrCaught *caught = NULL;
  ScrError *err = NULL;
  if (op->error != 0) {
    scr_fs_rename_error(op->error, op->oldpath, op->newpath);
    caught = scr_exc_take();
    if (caught && caught->kind == SCR_EXC_OBJ && scr_error_is(caught->payload)) {
      err = (ScrError *)caught->payload;
    }
  }
  op->fn(op->cb, err);
  scr_caught_release(caught);
  scr_fs_rename_op_release(op);
  return true;
}

static void scr_work_submit_op(ScrFsRenameOp *op) {
#ifdef SCR_WORKERS
  op->owner = scr_fs_rename_context();
  scr_fs_rename_wake_open(&op->owner->wake);
  scr_fs_rename_pending_count++;
  scr_fs_rename_lock_enter();
#else
  scr_fs_rename_wake_open(&scr_fs_rename_wake_global);
#endif
  if (!scr_fs_rename_shutdown_registered) {
    if (atexit(scr_fs_renames_shutdown) != 0) {
      scr_trap("scriptc: could not register worker cleanup\n");
    }
    scr_fs_rename_shutdown_registered = true;
  }
#ifndef SCR_WORKERS
  scr_fs_rename_pending_count++;
  scr_fs_rename_lock_enter();
#endif
  *scr_fs_rename_work_tail = op;
  scr_fs_rename_work_tail = &op->next;
  int create_error = 0;
  if (scr_fs_rename_worker_count < 4) {
#ifdef _WIN32
    HANDLE worker = CreateThread(NULL, 0, scr_fs_rename_worker, NULL, 0, NULL);
    if (worker != NULL) {
      scr_fs_rename_workers[scr_fs_rename_worker_count] = worker;
      scr_fs_rename_worker_count++;
    } else {
      create_error = EAGAIN;
    }
#else
    pthread_t worker;
    create_error = pthread_create(&worker, NULL, scr_fs_rename_worker, NULL);
    if (create_error == 0) {
      scr_fs_rename_workers[scr_fs_rename_worker_count] = worker;
      scr_fs_rename_worker_count++;
    }
#endif
  }
  if (create_error != 0 && scr_fs_rename_worker_count == 0) {
    /* Submission failure remains asynchronous. Rename preserves its
     * resource error; generic work falls back to the main loop turn. */
    while (scr_fs_rename_work != NULL) {
      ScrFsRenameOp *failed = scr_fs_rename_work;
      scr_fs_rename_work = failed->next;
      failed->error = create_error;
      failed->ran = !failed->generic;
      failed->next = NULL;
#ifdef SCR_WORKERS
      *failed->owner->tail = failed;
      failed->owner->tail = &failed->next;
      scr_fs_rename_broadcast();
      scr_fs_rename_wake_post(&failed->owner->wake);
#else
      *scr_fs_rename_done_tail = failed;
      scr_fs_rename_done_tail = &failed->next;
      scr_fs_rename_wake_post(&scr_fs_rename_wake_global);
#endif
    }
    scr_fs_rename_work_tail = &scr_fs_rename_work;
  } else {
    scr_fs_rename_signal();
  }
  scr_fs_rename_lock_leave();
}
#elif defined(__wasi__)
/* WASI Preview 1 has no threads, but rename itself is available. Queue the
 * request and perform it on the next loop turn so callback timing remains
 * asynchronous and the request remains a liveness handle. */
typedef struct ScrFsRenameOp {
  bool generic;
  void *payload;
  ScrWorkFn work;
  ScrWorkFn after;
  ScrWorkFn destroy;
  ScrStr *oldpath;
  ScrStr *newpath;
  ScrClosure *cb;
  ScrFsRenameFn fn;
  struct ScrFsRenameOp *next;
} ScrFsRenameOp;

static ScrFsRenameOp *scr_fs_rename_done = NULL;
static ScrFsRenameOp **scr_fs_rename_done_tail = &scr_fs_rename_done;
static size_t scr_fs_rename_pending_count = 0;

static bool scr_fs_renames_pending(void) { return scr_fs_rename_pending_count != 0; }
static int scr_fs_renames_pollfd(void) { return -1; }
static bool scr_fs_renames_can_wait(void) { return false; }

static bool scr_fs_renames_dispatch(void) {
  ScrFsRenameOp *op = scr_fs_rename_done;
  if (op == NULL) return false;
  scr_fs_rename_done = op->next;
  if (scr_fs_rename_done == NULL) scr_fs_rename_done_tail = &scr_fs_rename_done;
  scr_fs_rename_pending_count--;

  if (op->generic) {
    op->work(op->payload);
    op->after(op->payload);
    op->destroy(op->payload);
    free(op);
    return true;
  }

  int error = scr_fs_rename_raw(op->oldpath, op->newpath);
  ScrCaught *caught = NULL;
  ScrError *err = NULL;
  if (error != 0) {
    scr_fs_rename_error(error, op->oldpath, op->newpath);
    caught = scr_exc_take();
    if (caught && caught->kind == SCR_EXC_OBJ && scr_error_is(caught->payload)) {
      err = (ScrError *)caught->payload;
    }
  }
  op->fn(op->cb, err);
  scr_caught_release(caught);
  scr_str_release(op->oldpath);
  scr_str_release(op->newpath);
  scr_closure_release(op->cb);
  free(op);
  return true;
}
#else
static bool scr_fs_renames_pending(void) { return false; }
static bool scr_fs_renames_dispatch(void) { return false; }
static int scr_fs_renames_pollfd(void) { return -1; }
static bool scr_fs_renames_can_wait(void) { return false; }
#endif

void scr_fs_rename_async(ScrStr *oldpath, ScrStr *newpath,
                         ScrClosure *cb, ScrFsRenameFn fn) {
  /* Node validates both paths before queueing the rename: a null byte
   * throws here and the callback never runs. */
  if (!scr_fs_path_ok(oldpath, "oldPath") || !scr_fs_path_ok(newpath, "newPath")) {
    scr_closure_release(cb);
    return;
  }
#if defined(SCR_LIB)
  (void)oldpath; (void)newpath; (void)fn;
  scr_closure_release(cb);
  scr_trap("scriptc: callback-style fs.rename is not supported by this target\n");
#elif defined(__wasi__)
  ScrFsRenameOp *op = calloc(1, sizeof *op);
  if (!op) scr_trap("scriptc: out of memory\n");
  op->oldpath = scr_str_retain(oldpath);
  op->newpath = scr_str_retain(newpath);
  op->cb = cb;
  op->fn = fn;
  *scr_fs_rename_done_tail = op;
  scr_fs_rename_done_tail = &op->next;
  scr_fs_rename_pending_count++;
#else
  ScrFsRenameOp *op = calloc(1, sizeof *op);
  if (!op) scr_trap("scriptc: out of memory\n");
  op->oldpath = scr_str_retain(oldpath);
  op->newpath = scr_str_retain(newpath);
  op->cb = cb;
  op->fn = fn;
  scr_work_submit_op(op);
#endif
}

void scr_work_submit(void *payload, ScrWorkFn work, ScrWorkFn after,
                     ScrWorkFn destroy) {
#if defined(SCR_LIB)
  (void)work; (void)after;
  destroy(payload);
  scr_trap("scriptc: native worker jobs are not supported by this target\n");
#elif defined(__wasi__)
  ScrFsRenameOp *op = calloc(1, sizeof *op);
  if (!op) scr_trap("scriptc: out of memory\n");
  op->generic = true;
  op->payload = payload;
  op->work = work;
  op->after = after;
  op->destroy = destroy;
  *scr_fs_rename_done_tail = op;
  scr_fs_rename_done_tail = &op->next;
  scr_fs_rename_pending_count++;
#else
  ScrFsRenameOp *op = calloc(1, sizeof *op);
  if (!op) scr_trap("scriptc: out of memory\n");
  op->generic = true;
  op->payload = payload;
  op->work = work;
  op->after = after;
  op->destroy = destroy;
  scr_work_submit_op(op);
#endif
}

void scr_fs_rename_thunk0(ScrClosure *cb, ScrError *err) {
  (void)err;
  ((void (*)(ScrClosure *))cb->fn)(cb);
}

/* Callback-style crypto completions. The operation validates and computes
 * before enqueueing; delivery is a later macrotask, never synchronous with
 * the API call. The queue owns both references and transfers the Buffer to
 * the emitted callback adapter. */
typedef struct ScrCryptoBytesOp {
  ScrBytes *value; /* a ScrDyn when value_is_dyn */
  bool value_is_dyn;
  ScrError *error;
  ScrClosure *cb;
  ScrCryptoBytesFn fn;
  struct ScrCryptoBytesOp *next;
} ScrCryptoBytesOp;

static SCR_TL ScrCryptoBytesOp *scr_crypto_bytes_head = NULL;
#ifdef SCR_WORKERS
static SCR_TL ScrCryptoBytesOp **scr_crypto_bytes_tail;
#else
static SCR_TL ScrCryptoBytesOp **scr_crypto_bytes_tail = &scr_crypto_bytes_head;
#endif
static SCR_TL size_t scr_crypto_bytes_pending_count = 0;
static SCR_TL ScrCryptoBytesOp *scr_crypto_bytes_last = NULL; /* the newest entry */
static SCR_TL bool scr_crypto_bytes_cleanup_registered = false;

static void scr_crypto_bytes_shutdown(void) {
  while (scr_crypto_bytes_head != NULL) {
    ScrCryptoBytesOp *op = scr_crypto_bytes_head;
    scr_crypto_bytes_head = op->next;
    if (op->value_is_dyn) {
      if (op->value) scr_dyn_release((ScrDyn *)op->value);
    } else {
      scr_bytes_release(op->value);
    }
    scr_error_release(op->error);
    scr_closure_release(op->cb);
    free(op);
  }
  scr_crypto_bytes_tail = &scr_crypto_bytes_head;
  scr_crypto_bytes_pending_count = 0;
}

static bool scr_crypto_bytes_pending(void) {
  return scr_crypto_bytes_pending_count != 0;
}

static bool scr_crypto_bytes_dispatch(void) {
  ScrCryptoBytesOp *op = scr_crypto_bytes_head;
  if (op == NULL) return false;
  scr_crypto_bytes_head = op->next;
  if (scr_crypto_bytes_head == NULL) scr_crypto_bytes_tail = &scr_crypto_bytes_head;
  scr_crypto_bytes_pending_count--;
  op->fn(op->cb, op->error, op->value); /* adapter consumes value */
  scr_error_release(op->error);
  scr_closure_release(op->cb);
  free(op);
  return true;
}

void scr_crypto_defer_bytes(ScrBytes *value, ScrError *error, ScrClosure *cb, ScrCryptoBytesFn fn) {
  if (!scr_crypto_bytes_cleanup_registered) {
    if (scr_atexit(scr_crypto_bytes_shutdown) != 0) {
      scr_bytes_release(value);
      scr_error_release(error);
      scr_closure_release(cb);
      scr_trap("scriptc: could not register crypto callback cleanup\n");
    }
    scr_crypto_bytes_cleanup_registered = true;
    scr_crypto_bytes_tail = &scr_crypto_bytes_head;
  }
  ScrCryptoBytesOp *op = malloc(sizeof *op);
  if (!op) {
    scr_bytes_release(value);
    scr_error_release(error);
    scr_closure_release(cb);
    scr_trap("scriptc: out of memory\n");
  }
  op->value = value;
  op->value_is_dyn = false;
  op->error = error;
  op->cb = cb;
  op->fn = fn;
  op->next = NULL;
  *scr_crypto_bytes_tail = op;
  scr_crypto_bytes_tail = &op->next;
  scr_crypto_bytes_last = op;
  scr_crypto_bytes_pending_count++;
}

/* The same queue with a dyn value, which the callback adapter receives in
 * the value slot unchanged (randomFill over an ArrayBuffer passes back the
 * ArrayBuffer itself). */
void scr_crypto_defer_dyn(ScrDyn *value, ScrError *error, ScrClosure *cb, ScrCryptoBytesFn fn) {
  scr_crypto_defer_bytes(NULL, error, cb, fn);
  scr_crypto_bytes_last->value = (ScrBytes *)value;
  scr_crypto_bytes_last->value_is_dyn = true;
}

/* Deferred native callbacks: the fs error-first callbacks (and fs.exists)
 * do their work synchronously and deliver the callback on a later loop
 * turn. The queue is FIFO and its callbacks are macrotasks, one per
 * checkpoint like the worker-pool completions, so nextTicks and microtasks
 * drain between them. Before this queue they rode zero-delay timers,
 * whose 1 ms floor made every callback wait for a timer turn. */
typedef struct ScrLoopDeferred {
  ScrClosure *cb;
  struct ScrLoopDeferred *next;
} ScrLoopDeferred;

static SCR_TL ScrLoopDeferred *scr_loop_deferred_head = NULL;
static SCR_TL ScrLoopDeferred **scr_loop_deferred_tail = NULL;
static SCR_TL size_t scr_loop_deferred_count = 0;
/* Callbacks this turn may deliver: the queue as it stood when the turn's
 * timers ran (libuv's poll phase runs the callbacks that were ready when
 * it began), so a callback that queues another cannot starve timers and
 * immediates. */
static SCR_TL size_t scr_loop_deferred_ready = 0;
static SCR_TL bool scr_loop_deferred_cleanup_registered = false;

static void scr_loop_deferred_shutdown(void) {
  while (scr_loop_deferred_head != NULL) {
    ScrLoopDeferred *d = scr_loop_deferred_head;
    scr_loop_deferred_head = d->next;
    scr_closure_release(d->cb);
    free(d);
  }
  scr_loop_deferred_tail = &scr_loop_deferred_head;
  scr_loop_deferred_count = 0;
  scr_loop_deferred_ready = 0;
}

static bool scr_loop_deferred_pending(void) { return scr_loop_deferred_count != 0; }

static bool scr_loop_deferred_dispatch(void) {
  ScrLoopDeferred *d = scr_loop_deferred_head;
  if (d == NULL || scr_loop_deferred_ready == 0) return false;
  scr_loop_deferred_ready--;
  scr_loop_deferred_head = d->next;
  if (scr_loop_deferred_head == NULL) scr_loop_deferred_tail = &scr_loop_deferred_head;
  scr_loop_deferred_count--;
  ScrClosure *cb = d->cb;
  free(d);
  ((void (*)(ScrClosure *))cb->fn)(cb);
  scr_closure_release(cb);
  return true;
}

void scr_loop_defer(ScrClosure *cb) {
  if (!scr_loop_deferred_cleanup_registered) {
    if (scr_atexit(scr_loop_deferred_shutdown) != 0) {
      scr_closure_release(cb);
      scr_trap("scriptc: could not register deferred callback cleanup\n");
    }
    scr_loop_deferred_cleanup_registered = true;
    scr_loop_deferred_tail = &scr_loop_deferred_head;
  }
  ScrLoopDeferred *d = malloc(sizeof *d);
  if (!d) {
    scr_closure_release(cb);
    scr_trap("scriptc: out of memory\n");
  }
  d->cb = cb;
  d->next = NULL;
  *scr_loop_deferred_tail = d;
  scr_loop_deferred_tail = &d->next;
  scr_loop_deferred_count++;
}

/* ── node:timers/promises ────────────────────────────────────────────
 * The promisified pair: a PENDING void promise a one-shot heap timer
 * (setTimeout) or the immediate queue (setImmediate) fulfills — the
 * resolve closure is scr_make_resolve's void thunk, so settlement wakes
 * awaiting fibers exactly like every other promise, and the armed
 * timer/immediate keeps the loop alive until it fires (Node: an awaited
 * timers/promises sleep holds the process open). Neither throws; the
 * delay rides scr_set_timeout's own Node-exact coercion (clamp to 1,
 * truncate). */

ScrPromise *scr_tp_set_timeout(double ms) {
  ScrPromise *p = scr_promise_new();
  scr_set_timeout(scr_make_resolve(p, 3 /* void */), ms);
  return p;
}

ScrPromise *scr_tp_set_immediate(void) {
  ScrPromise *p = scr_promise_new();
  scr_set_immediate(scr_make_resolve(p, 3 /* void */));
  return p;
}

/* setTimeout(delay, value[, { ref }]) and setImmediate(value[, { ref }]):
 * the value arrives as an already-settled promise of its own type (the
 * Promise.resolve lowering, borrowed), whose settlement the result copies
 * when the timer or immediate fires. `ref: false` unrefs it, so it no
 * longer keeps the loop alive, as in Node. */
static void scr_tp_settle_thunk(ScrClosure *self) {
  ScrPromise *dst = (ScrPromise *)scr_box_get_ref(self->caps[0]);
  ScrPromise *src = (ScrPromise *)scr_box_get_ref(self->caps[1]);
  scr_promise_settle_from(dst, src);
  scr_promise_release(dst);
  scr_promise_release(src);
}

static ScrClosure *scr_tp_settle_closure(ScrPromise *dst, ScrPromise *src) {
  ScrClosure *c = scr_closure_new((void *)&scr_tp_settle_thunk, 2);
  for (int i = 0; i < 2; i++) {
    ScrBox *b = scr_box_new_obj(scr_promise_retain_v, scr_promise_release_v, scr_promise_trace_v);
    scr_box_set_ref(b, scr_promise_retain(i == 0 ? dst : src));
    c->caps[i] = b;
  }
  return c;
}

ScrPromise *scr_tp_set_timeout_value(double ms, ScrPromise *value, bool ref) {
  ScrPromise *p = scr_promise_new();
  double handle = scr_set_timeout_handle(scr_tp_settle_closure(p, value), ms);
  if (!ref) scr_timer_unref(handle);
  return p;
}

ScrPromise *scr_tp_set_immediate_value(ScrPromise *value, bool ref) {
  ScrPromise *p = scr_promise_new();
  double handle = scr_set_immediate(scr_tp_settle_closure(p, value));
  if (!ref) scr_immediate_unref(handle);
  return p;
}

/* ── setImmediate as a first-class dyn value ─────────────────────────
 * The global passed AS A FUNCTION VALUE into untyped code (the Node-suite
 * traceCallback shape: `channel.traceCallback(setImmediate, 0, ctx, null,
 * cb)`). The minted dyn callable schedules its own immediate that calls
 * args[0] with the remaining arguments (Node's setImmediate(cb, ...args)
 * contract) and answers undefined (the Immediate handle object has no dyn
 * story — clearImmediate over this value is not modeled). A non-function
 * first argument throws Node's ERR_INVALID_ARG_TYPE synchronously. */

static void scr_imm_dyn_fire(ScrClosure *c) {
  ScrDyn *fn = (ScrDyn *)scr_box_get_ref(c->caps[0]);
  ScrDyn *args = (ScrDyn *)scr_box_get_ref(c->caps[1]);
  ScrDyn *r = scr_dyn_call(fn, args->v.arr.items, args->v.arr.len, "immediate callback");
  if (r != NULL) scr_dyn_release(r);
  scr_dyn_release(fn);
  scr_dyn_release(args);
}

static ScrDyn *scr_imm_dyn_thunk(ScrClosure *clo, ScrDyn *const *args, size_t argc) {
  (void)clo;
  if (argc == 0 || args[0]->kind != SCR_DYN_FUNC) {
    static const char msg[] = "The \"callback\" argument must be of type function.";
    scr_throw_error_msg_code(SCR_ERR_TYPE, msg, sizeof msg - 1, "ERR_INVALID_ARG_TYPE");
    return NULL;
  }
  ScrDyn *rest = scr_dyn_new_arr();
  for (size_t i = 1; i < argc; i++) scr_dyn_arr_push(rest, scr_dyn_retain(args[i]));
  ScrClosure *c = scr_closure_new((void *)scr_imm_dyn_fire, 2);
  c->caps[0] = scr_box_new_obj(scr_dyn_retain_v, scr_dyn_release_v, NULL);
  scr_box_set_ref(c->caps[0], scr_dyn_retain(args[0]));
  c->caps[1] = scr_box_new_obj(scr_dyn_retain_v, scr_dyn_release_v, NULL);
  scr_box_set_ref(c->caps[1], rest); /* moves */
  scr_set_immediate(c);
  return scr_dyn_retain(scr_dyn_undefined());
}

ScrDyn *scr_set_immediate_dyn_value(void) {
  return scr_dyn_new_func(scr_closure_new((void *)scr_imm_dyn_thunk, 0), scr_imm_dyn_thunk,
                          1, "(cb,...)", "setImmediate");
}

/* ── queueMicrotask ──────────────────────────────────────────────────
 * The READY queue's FIFO is the microtask queue (promise continuations
 * ride it as parked fibers), so a queueMicrotask callback enters the SAME
 * queue as a stackless envelope — one order across both producers, like
 * V8's single microtask queue. scr_resume_fiber runs the closure on the
 * main stack; a throw is an uncaught exception (Node's queueMicrotask),
 * never a rejection. */
void scr_queue_microtask(ScrClosure *cb) {
  ScrFiber *f = scr_mem_calloc(sizeof *f);
  if (!f) scr_oom();
  f->micro_cb = cb; /* ownership moves in */
  scr_ready_push(f);
}

/* ── scheduling in an AsyncLocalStorage context ───────────────────────
 * Programs that enter AsyncLocalStorage stores schedule their timer,
 * interval, setImmediate, process.nextTick and queueMicrotask callbacks
 * through these entry points (the emitter picks them when the program
 * uses the store API), so each callback runs with the stores that were
 * active when it was scheduled, as Node's async resources capture them.
 * With a snapshot active, the callback is wrapped in a closure that
 * installs it around the call; other programs keep the plain entry
 * points. */
static void *scr_als_ctx_retain_v(void *c) { return scr_als_ctx_retain(c); }
static void scr_als_ctx_release_v(void *c) { scr_als_ctx_release(c); }

static void scr_als_bound_fire(ScrClosure *self) {
  ScrClosure *cb = scr_box_get_ref(self->caps[0]);
  ScrAlsCtx **slot = SCR_ALS_SLOT();
  ScrAlsCtx *prev = *slot;
  *slot = scr_box_get_ref(self->caps[1]); /* the slot owns this reference */
  ((void (*)(ScrClosure *))cb->fn)(cb);
  /* An enterWith inside the callback replaced the slot's snapshot; either
   * way the slot's reference is released here. */
  slot = SCR_ALS_SLOT();
  scr_als_ctx_release(*slot);
  *slot = prev;
  scr_closure_release(cb);
}

static ScrClosure *scr_als_bind(ScrClosure *cb /*moves*/) {
  ScrAlsCtx *active = *SCR_ALS_SLOT();
  if (active == NULL) return cb;
  ScrClosure *bound = scr_closure_new((void *)scr_als_bound_fire, 2);
  bound->caps[0] = scr_box_new(SCR_BOX_FUNC);
  scr_box_set_ref(bound->caps[0], cb);
  bound->caps[1] = scr_box_new_obj(scr_als_ctx_retain_v, scr_als_ctx_release_v, NULL);
  scr_box_set_ref(bound->caps[1], scr_als_ctx_retain(active));
  return bound;
}

void scr_set_timeout_als(ScrClosure *cb, double ms) { scr_set_timeout(scr_als_bind(cb), ms); }
double scr_set_interval_als(ScrClosure *cb, double ms) {
  return scr_set_interval(scr_als_bind(cb), ms);
}
double scr_set_timeout_handle_als(ScrClosure *cb, double ms) {
  return scr_set_timeout_handle(scr_als_bind(cb), ms);
}
double scr_set_immediate_als(ScrClosure *cb) { return scr_set_immediate(scr_als_bind(cb)); }
void scr_next_tick_als(ScrClosure *cb) { scr_next_tick(cb); } /* scr_next_tick binds */
void scr_queue_microtask_als(ScrClosure *cb) { scr_queue_microtask(scr_als_bind(cb)); }

/* A typed callback bound to the context active when it was bound: the
 * completion callbacks of callback-style APIs in programs that use
 * AsyncLocalStorage, and AsyncLocalStorage.bind. The bound closure's entry
 * is a thunk the compiler emits per callback signature; it reads the
 * target (scr_als_bound_target), enters the captured context
 * (scr_als_bound_enter), calls the target with its own arguments and
 * restores the caller's context (scr_als_bound_leave). With `always`
 * false an empty context leaves the callback unbound, since the loop runs
 * callbacks with an empty context; AsyncLocalStorage.bind passes true, so
 * a bound function called later inside run() still sees no store. */
ScrClosure *scr_als_bind_closure(ScrClosure *cb /*moves*/, void *thunk, bool always) {
  ScrAlsCtx *active = *SCR_ALS_SLOT();
  if (cb == NULL || (active == NULL && !always)) return cb;
  ScrClosure *bound = scr_closure_new(thunk, 2);
  bound->caps[0] = scr_box_new(SCR_BOX_FUNC);
  scr_box_set_ref(bound->caps[0], cb);
  bound->caps[1] = scr_box_new_obj(scr_als_ctx_retain_v, scr_als_ctx_release_v, NULL);
  scr_box_set_ref(bound->caps[1], scr_als_ctx_retain(active));
  return bound;
}

/* The bound target (+1, released by scr_als_bound_leave). */
ScrClosure *scr_als_bound_target(ScrClosure *self) {
  return scr_box_get_ref(self->caps[0]);
}

/* Enters the captured context; returns the caller's (owned). */
ScrAlsCtx *scr_als_bound_enter(ScrClosure *self) {
  ScrAlsCtx **slot = SCR_ALS_SLOT();
  ScrAlsCtx *prev = *slot;
  *slot = scr_box_get_ref(self->caps[1]); /* the slot owns this reference */
  return prev;
}

/* Restores the caller's context, replacing whatever the target entered
 * (an enterWith inside it), and releases the target. */
void scr_als_bound_leave(ScrAlsCtx *prev, ScrClosure *target) {
  scr_als_restore(prev);
  scr_closure_release(target);
}

/* The checked-dynamic argument form (JS files — common.mustCall wrappers
 * and the suite's invalid-input probes): a non-function throws Node's
 * ERR_INVALID_ARG_TYPE synchronously; a function value is called with
 * zero arguments (Node passes none — extra queueMicrotask arguments are
 * ignored). */
static void scr_micro_dyn_fire(ScrClosure *c) {
  ScrDyn *fn = (ScrDyn *)scr_box_get_ref(c->caps[0]);
  ScrDyn *r = scr_dyn_call(fn, NULL, 0, "queueMicrotask callback");
  if (r != NULL) scr_dyn_release(r);
  scr_dyn_release(fn);
}

/* The closure that calls a dyn function value, or NULL with Node's
 * ERR_INVALID_ARG_TYPE pending for a non-function. */
static ScrClosure *scr_micro_dyn_closure(const ScrDyn *cb) {
  if (cb->kind != SCR_DYN_FUNC) {
    static const char msg[] = "The \"callback\" argument must be of type function.";
    scr_throw_error_msg_code(SCR_ERR_TYPE, msg, sizeof msg - 1, "ERR_INVALID_ARG_TYPE");
    return NULL;
  }
  ScrClosure *c = scr_closure_new((void *)scr_micro_dyn_fire, 1);
  c->caps[0] = scr_box_new_obj(scr_dyn_retain_v, scr_dyn_release_v, NULL);
  scr_box_set_ref(c->caps[0], scr_dyn_retain((ScrDyn *)cb));
  return c;
}

void scr_queue_microtask_dyn(const ScrDyn *cb) {
  ScrClosure *c = scr_micro_dyn_closure(cb);
  if (c) scr_queue_microtask(c);
}

void scr_queue_microtask_dyn_als(const ScrDyn *cb) {
  ScrClosure *c = scr_micro_dyn_closure(cb);
  if (c) scr_queue_microtask_als(c);
}

/* ── the event hooks (scr_events.c) ──────────────────────────────────
 * Process signal/exit events and the piped-stdin surface live in
 * scr_events.c, which links ONLY into binaries whose IR uses those
 * surfaces (the io-hook precedent, gated like scr_regex/scr_fetch):
 * scr_events_install() fills these slots before %main. Event-free
 * builds keep every slot NULL and the loop is byte-identical in
 * behavior. The scr_lib.c hooks live in scr_lib.c and the abnormal-exit
 * code hint in scr_exception.c, so each unit stays self-contained (the
 * runtime C tests link them separately). */

static SCR_TL bool (*scr_events_pending_fn)(void) = NULL;  /* keeps the loop alive */
static SCR_TL bool (*scr_events_watching_fn)(void) = NULL; /* wants the poll sleep */
static SCR_TL void (*scr_events_dispatch_fn)(void) = NULL; /* fire due listeners */
static SCR_TL int (*scr_events_pollfds_fn)(int out[2]) = NULL;

void scr_loop_set_events(bool (*pending)(void), bool (*watching)(void),
                          void (*dispatch)(void), int (*pollfds)(int out[2])) {
  scr_events_pending_fn = pending;
  scr_events_watching_fn = watching;
  scr_events_dispatch_fn = dispatch;
  scr_events_pollfds_fn = pollfds;
}

/* ── the event loop ───────────────────────────────────────────────────── */

static void scr_resume_fiber(ScrFiber *f) {
  if (f->gen_job != NULL) {
    ScrGen *g = f->gen_job;
    scr_mem_free(f);
    scr_async_gen_job(g);
    scr_gen_release(g);
    return;
  }
  /* A queueMicrotask envelope: run the closure on the main stack, no
   * context switch. A throw leaves the exception cell pending — every
   * drain site returns to main's uncaught report, Node's queueMicrotask
   * semantics (uncaughtException, never an unhandled rejection). */
  if (f->micro_cb != NULL) {
    ScrClosure *cb = f->micro_cb;
    scr_mem_free(f);
    ((void (*)(ScrClosure *))cb->fn)(cb);
    scr_closure_release(cb);
    return;
  }
  /* A Promise.all / Promise.race reaction job, also on the main stack. */
  if (f->cb_job) {
    scr_promise_job_run(f);
    return;
  }
  if (f->gen != NULL) {
    scr_async_gen_resume_ready(f->gen);
    return;
  }
#ifdef _WIN32
  /* The loop runs on the main stack; make sure scr_loop_ctx names its
   * fiber handle (a no-op after the first conversion). */
  (void)scr_win_self();
#endif
  f->return_to = &scr_loop_ctx;
  /* The body continues in the lifetime region it was spawned in. */
  const ScrRgnFiberHooks *regions = atomic_load_explicit(&scr_region_fiber_hooks, memory_order_relaxed);
  void *region_before = regions != NULL ? regions->resume(f->region) : NULL;
#ifdef __wasi__
  scr_current = f;
  scr_exc_swap_cell(&f->exc);
  scr_als_active = &f->als;
  if (f->coro != NULL) {
    scr_wasi_coro_resume(f->coro);
  } else {
    /* scr_async_spawn_after's runtime C continuation. Its dependency is
     * settled, so the entry can extract through scr_await_* without a
     * stack switch and then completes in this turn. */
    f->entry(f, f->argpack);
    scr_fiber_finish(f);
  }
  scr_current = NULL;
  scr_exc_swap_cell(NULL);
  scr_als_active = &scr_als_main_slot;
  if (regions != NULL) regions->suspend(region_before);
#else
  if (f->stackless) {
    /* A stackless async body continues on the loop's stack. */
    scr_current = f;
    scr_exc_swap_cell(&f->exc);
    scr_als_active = &f->als;
    scr_coro_resume(f->coro);
    scr_current = NULL;
    scr_exc_swap_cell(NULL);
    scr_als_active = &scr_als_main_slot;
    if (regions != NULL) regions->suspend(region_before);
  } else {
    scr_switch(&scr_loop_ctx, &f->ctx, f);
    if (regions != NULL) regions->suspend(region_before);
    f = scr_loop_reap;
    if (f == NULL) return;
    scr_loop_reap = NULL;
  }
#endif
  if (f->done && !f->direct) {
    scr_promise_release(f->promise);
    scr_fiber_destroy(f);
    scr_fibers_live--;
  }
}

/* Reap granularity while children are pending on the POLLING fallback:
 * the loop polls waitpid(WNOHANG) at least this often instead of sleeping
 * to the next timer deadline. The primary path has no cap — the sleep
 * waits on the child watch (scr_children_wait — kqueue NOTE_EXIT on BSD,
 * pidfd epoll on Linux, the timer deadline riding the wait timeout) and a
 * child's exit wakes it immediately. The fallback covers platforms with
 * neither backend, children whose exit watch could not be armed, and
 * turns where the io poll takes the sleep (curl's fds can't join it). */
#define SCR_CHILD_POLL_MS 1.0

/* Sleep cap while only external io is pending (no timer models its
 * wakeup): the io poll sleeps on REAL fds inside this window (a fetch
 * transfer's sockets wake it early), so a generous cap costs nothing. */
#define SCR_IO_POLL_MS 1000.0

/* Sleep cap while signal handlers or stdin consumers are pending AND the
 * io poll owns the sleep (curl's fd wait retries on EINTR and can't watch
 * the wake pipe): bounded signal/stdin latency during a fetch at 20
 * wakeups/second. The dedicated poll(2) sleep needs no cap — it waits on
 * the wake pipe and fd 0 directly. */
#define SCR_SIGNAL_POLL_MS 50.0

/* The net hook (scr_net.c, when linked — the events-hook shape):
 * `pending` keeps the loop alive while servers/sockets are live,
 * `dispatch` fires at every turn top, and `pollfd` is the unit's poller
 * fd for the idle poll(2) sleep (readable while events are pending —
 * kqueue and epoll fds both behave this way).
 * Net-free builds keep every slot NULL and the loop is byte-identical. */
static SCR_TL bool (*scr_net_pending_fn)(void) = NULL;
static SCR_TL void (*scr_net_dispatch_fn)(void) = NULL;
static SCR_TL int (*scr_net_pollfd_fn)(void) = NULL;

/* Net io without liveness: unref'd sockets and servers still deliver
 * events while the loop runs for other work, but do not keep it alive. */
static SCR_TL bool (*scr_net_io_fn)(void) = NULL;

void scr_loop_set_net_io(bool (*io)(void)) { scr_net_io_fn = io; }

void scr_loop_set_net(bool (*pending)(void), void (*dispatch)(void), int (*pollfd)(void)) {
  scr_net_pending_fn = pending;
  scr_net_dispatch_fn = dispatch;
  scr_net_pollfd_fn = pollfd;
}

/* The dgram hook (scr_dgram.c, when linked) — the net hook's exact shape:
 * one more set of nullable slots, byte-identical loop behavior when
 * unset. */
static SCR_TL bool (*scr_dgram_pending_fn)(void) = NULL;
static SCR_TL void (*scr_dgram_dispatch_fn)(void) = NULL;
static SCR_TL int (*scr_dgram_pollfd_fn)(void) = NULL;

void scr_loop_set_dgram(bool (*pending)(void), void (*dispatch)(void), int (*pollfd)(void)) {
  scr_dgram_pending_fn = pending;
  scr_dgram_dispatch_fn = dispatch;
  scr_dgram_pollfd_fn = pollfd;
}

/* The fs.watch hook (scr_watch.c, when linked) — the net hook's exact
 * shape: one more set of nullable slots, byte-identical loop behavior
 * when unset. */
static SCR_TL bool (*scr_watch_pending_fn)(void) = NULL;
static SCR_TL void (*scr_watch_dispatch_fn)(void) = NULL;
static SCR_TL int (*scr_watch_pollfd_fn)(void) = NULL;

void scr_loop_set_watch(bool (*pending)(void), void (*dispatch)(void), int (*pollfd)(void)) {
  scr_watch_pending_fn = pending;
  scr_watch_dispatch_fn = dispatch;
  scr_watch_pollfd_fn = pollfd;
}

/* The child-process hook (scr_child.c, installed with the first spawned
 * child or IPC channel). Programs that never create one keep it NULL and
 * do not link the child unit; WASI never links it. */
static SCR_TL const ScrLoopChildren *scr_loop_children = NULL;

void scr_loop_set_children(const ScrLoopChildren *hooks) { scr_loop_children = hooks; }

/* The foreign-FFI queue hook (scr_ffi.c when a format-5 descriptor exists).
 * Its pending count includes live registrations (reffed by default) and
 * queued deliveries; dispatch runs exactly one callback per loop turn. */
static SCR_TL bool (*scr_ffi_pending_fn)(void) = NULL;
static SCR_TL bool (*scr_ffi_dispatch_fn)(void) = NULL;
static SCR_TL int (*scr_ffi_pollfd_fn)(void) = NULL;
static SCR_TL void (*scr_ffi_stop_fn)(void) = NULL;

void scr_loop_set_ffi(bool (*pending)(void), bool (*dispatch)(void),
                      int (*pollfd)(void), void (*stop)(void)) {
  scr_ffi_pending_fn = pending;
  scr_ffi_dispatch_fn = dispatch;
  scr_ffi_pollfd_fn = pollfd;
  scr_ffi_stop_fn = stop;
}

/* The stream hook (scr_stream.c, when linked): `pending` keeps the loop
 * alive while deferred stream ticks exist, `dispatch` drains them at the
 * TOP of every turn — before the events/net stations, the closest
 * placement to Node's process.nextTick (whose stream emissions these
 * are). No poller fd: ticks are pure CPU work, always ready. */
static SCR_TL bool (*scr_stream_pending_fn)(void) = NULL;
static SCR_TL void (*scr_stream_dispatch_fn)(void) = NULL;

void scr_loop_set_stream(bool (*pending)(void), void (*dispatch)(void)) {
  scr_stream_pending_fn = pending;
  scr_stream_dispatch_fn = dispatch;
}

#ifdef SCR_WORKERS
static SCR_TL bool (*scr_workers_pending_fn)(void);
static SCR_TL void (*scr_workers_dispatch_fn)(void);
static SCR_TL bool (*scr_workers_more_fn)(void);
static SCR_TL int (*scr_workers_pollfd_fn)(void);
static SCR_TL bool (*scr_workers_ready_fn)(void);
static SCR_TL void (*scr_workers_wait_fn)(double);

void scr_loop_set_workers(bool (*pending)(void), bool (*ready)(void), void (*dispatch)(void),
                          int (*pollfd)(void), void (*wait)(double)) {
  scr_workers_pending_fn = pending;
  scr_workers_dispatch_fn = dispatch;
  scr_workers_pollfd_fn = pollfd;
  scr_workers_ready_fn = ready;
  scr_workers_wait_fn = wait;
}

void scr_loop_set_workers_more(bool (*more)(void)) { scr_workers_more_fn = more; }
#endif

static bool scr_workers_pending(void) {
#ifdef SCR_WORKERS
  return scr_workers_pending_fn && scr_workers_pending_fn();
#else
  return false;
#endif
}

static void scr_workers_dispatch(void) {
#ifdef SCR_WORKERS
  if (scr_workers_dispatch_fn) scr_workers_dispatch_fn();
#endif
}

static int scr_workers_pollfd(void) {
#ifdef SCR_WORKERS
  return scr_workers_pollfd_fn ? scr_workers_pollfd_fn() : -1;
#else
  return -1;
#endif
}

/* Dispatch hooks yield between event batches when process.nextTick
 * callbacks or fibers are already queued, so ticks and promise jobs
 * interleave with event delivery (Node's checkpoint after each
 * macrotask). */
bool scr_loop_has_ready(void) { return scr_ready_len > 0 || scr_nt_head != NULL; }

/* The poll phase runs once per loop iteration, like libuv's: the net unit
 * drains the poller at most once between check phases. I/O that becomes
 * ready while this iteration's callbacks run (a loopback connect started
 * by one of them) waits for the next iteration, so immediates queued in
 * the meantime fire first — Node's poll → check order. A full batch polls
 * again without waiting, at most SCR_LOOP_IO_BATCHES times per phase (the
 * count libuv's uv__io_poll uses); later events wait for the next
 * iteration, so timers and immediates still run while sockets stay busy. */
enum { SCR_LOOP_IO_BATCHES = 48 };
static SCR_TL bool scr_loop_io_open = true;
static SCR_TL int scr_loop_io_batches = 0;
bool scr_loop_io_take(void) {
  bool open = scr_loop_io_open;
  scr_loop_io_open = false;
  return open;
}
bool scr_loop_io_more(void) { return ++scr_loop_io_batches < SCR_LOOP_IO_BATCHES; }
void scr_loop_io_reopen(void) { scr_loop_io_open = true; }

/* The process.nextTick queue to exhaustion, ticks queued meanwhile
 * included. false: a tick threw (uncaught, pending). */
static bool scr_loop_run_ticks(void) {
  while (scr_nt_head != NULL) {
    ScrNtick *t = scr_nt_head;
    scr_nt_head = t->next;
    if (scr_nt_head == NULL) scr_nt_tail = NULL;
    ScrClosure *cb = t->cb;
    ScrFsRenameFn error_cb = t->error_cb;
    void (*raw)(void) = t->raw;
    scr_mem_free(t);
    if (cb) {
      if (error_cb) error_cb(cb, NULL);
      else ((void (*)(ScrClosure *))cb->fn)(cb);
      scr_closure_release(cb);
    } else {
      raw(); /* one stream tick, FIFO with the user ticks around it */
    }
    if (scr_exc_pending()) return false;
  }
  return true;
}

/* The checkpoint after a macrotask callback (processTicksAndRejections):
 * ticks to exhaustion, then promise jobs to exhaustion, and back while
 * either has work. false: a tick threw (uncaught, pending). */
static bool scr_loop_run_checkpoint(void) {
  while (scr_nt_head != NULL || scr_ready_len > 0) {
    if (!scr_loop_run_ticks()) return false;
    while (scr_ready_len > 0) {
      ScrFiber *f = scr_ready[scr_ready_head++];
      scr_ready_len--;
      scr_resume_fiber(f);
    }
  }
  return true;
}

static bool scr_loop_run_pass(ScrPromise *top_level, bool first_checkpoint) {
  /* The FIRST checkpoint after the synchronous main body runs promise
   * jobs BEFORE the first tick drain: Node's main-module evaluation is
   * itself awaited (the runMain continuation is a microtask queued after
   * the body's own), so microtasks scheduled during the body beat ticks
   * scheduled during the body exactly once, at startup — differentially
   * pinned. Every later checkpoint drains ticks first. */
  bool rejection_failed = false;
  for (;;) {
    if (top_level != NULL && top_level->state == SCR_PROM_REJECTED) break;
    /* process.nextTick callbacks BEFORE promise jobs (Node's checkpoint
     * order): the tick queue to exhaustion, then the microtask queue to
     * exhaustion, and back while either has work — a microtask's
     * nextTick runs before the turn proceeds, but never preempts the
     * microtask queue mid-drain (V8 drains it fully). A tick's uncaught
     * throw ends the loop like any listener's (main reports it). */
    if (!first_checkpoint && !scr_loop_run_ticks()) return false;
    /* Microtasks to exhaustion (Node: promise jobs before timers). */
    while (scr_ready_len > 0) {
      ScrFiber *f = scr_ready[scr_ready_head++];
      scr_ready_len--;
      scr_resume_fiber(f);
    }
    first_checkpoint = false;
    /* The ESM loader observes a rejected entry evaluation at a promise-job
     * checkpoint and terminates before later ref'd timers or I/O can run.
     * Wait until this checkpoint's ready queue is drained — the root's
     * rejection handler is itself promise-job ordered — then leave through
     * the normal teardown below. A fulfilled root deliberately does not
     * stop the loop. */
    if (top_level != NULL && top_level->state == SCR_PROM_REJECTED) break;
    if (scr_nt_head != NULL) continue;
    /* Node decides unhandled rejections at the END of each complete
     * nextTick/microtask checkpoint, before advancing to timers or I/O.
     * A rejected executable module root wins over OTHER rejections from
     * this same checkpoint (the root check above); rejections from an
     * earlier checkpoint have already delivered here. Handled listeners
     * may enqueue more jobs or ref'd work, so return to the checkpoint
     * head instead of declaring the loop exhausted underneath them. */
    if (scr_report_unhandled_rejections()) {
      rejection_failed = true;
      break;
    }
    if (scr_ready_len > 0 || scr_nt_head != NULL || scr_nunhandled > 0) continue;
    /* Quiescent between turns (microtasks drained, nothing running):
     * collect any cycles the turn left behind. One SCHEDULED pass — almost
     * always a nursery one, sized to the turn's own garbage. A full sweep
     * here would walk the whole live heap every turn, which is precisely
     * what the generations exist to avoid. No-op on an empty buffer. */
    scr_cyc_collect_scheduled();
    /* Completed callback-style worker jobs are delivered on the main
     * runtime thread. A worker may have finished while synchronous user code
     * occupied that thread. Deliver exactly one completion per checkpoint:
     * Node drains nextTicks and microtasks after each native callback before
     * invoking the next ready callback. */
    if (scr_fs_renames_pending()) {
      bool dispatched = scr_fs_renames_dispatch();
      if (scr_exc_pending()) return false;
      if (dispatched) continue;
    }
    if (scr_crypto_bytes_pending()) {
      bool dispatched = scr_crypto_bytes_dispatch();
      if (scr_exc_pending()) return false;
      if (dispatched) continue;
    }
    if (scr_loop_deferred_pending()) {
      bool dispatched = scr_loop_deferred_dispatch();
      if (scr_exc_pending()) return false;
      if (dispatched) continue;
    }
    /* Foreign native callbacks are macrotasks. Deliver one, then restart at
     * the microtask checkpoint before considering the next queued post. */
    if (scr_ffi_dispatch_fn != NULL && scr_ffi_dispatch_fn()) {
      if (scr_exc_pending()) return false;
      if (scr_ready_len > 0 || scr_nt_head != NULL || scr_nunhandled > 0) continue;
    }
    /* Stream tick dispatch (scr_stream.c, when linked): the deferred
     * next-tick emissions ('data' flow kicks, 'readable'/'end'/'finish'/
     * 'drain'/'error'/'close') fire now, FIRST — the nextTick station.
     * Listeners may enqueue microtasks or more ticks — restart the turn
     * so those drain first. */
    if (scr_stream_dispatch_fn != NULL) {
      scr_stream_dispatch_fn();
      if (scr_exc_pending()) return false; /* uncaught throw in a listener */
      if (scr_ready_len > 0 || scr_nt_head != NULL) continue;
      if (scr_stream_pending_fn != NULL && scr_stream_pending_fn()) continue;
    }
    scr_workers_dispatch();
    if (scr_exc_pending()) return false;
    if (scr_ready_len > 0 || scr_nt_head != NULL) continue;
#ifdef SCR_WORKERS
    if (scr_workers_more_fn != NULL && scr_workers_more_fn()) continue;
#endif
    /* Event dispatch (scr_events.c, when linked): watched signals
     * delivered since the last turn fire their listeners now (macrotasks,
     * like timers), then stdin — while a consumer exists, probe fd 0 and
     * deliver one arrived chunk / the EOF events. Both may enqueue
     * microtasks — restart the turn so those drain first. */
    if (scr_events_dispatch_fn != NULL) {
      scr_events_dispatch_fn();
      if (scr_exc_pending()) return false; /* uncaught throw in a listener */
      if (scr_ready_len > 0 || scr_nt_head != NULL) continue;
    }
    /* Net dispatch (scr_net.c, when linked): accepts, arrived data,
     * connect completions, and the deferred listening/error/close emits
     * fire now (macrotasks, like the events hook). Callbacks may enqueue
     * microtasks — restart the turn so those drain first. */
    if (scr_net_dispatch_fn != NULL) {
      scr_net_dispatch_fn();
      if (scr_exc_pending()) return false; /* uncaught throw in a listener */
      if (scr_ready_len > 0 || scr_nt_head != NULL) continue;
    }
    /* Dgram dispatch (scr_dgram.c, when linked): arrived datagrams and
     * the deferred listening/connect/error/close emits (plus pending
     * dns.lookup callbacks) fire now — the net hook's exact station. */
    if (scr_dgram_dispatch_fn != NULL) {
      scr_dgram_dispatch_fn();
      if (scr_exc_pending()) return false; /* uncaught throw in a listener */
      if (scr_ready_len > 0 || scr_nt_head != NULL) continue;
    }
    /* Watch dispatch (scr_watch.c, when linked): file events queued on
     * the unit's event backend fire their FSWatcher listeners now — the
     * net hook's exact station. */
    if (scr_watch_dispatch_fn != NULL) {
      scr_watch_dispatch_fn();
      if (scr_exc_pending()) return false; /* uncaught throw in a listener */
      if (scr_ready_len > 0 || scr_nt_head != NULL) continue;
    }
    /* Reap spawned children and fire their listeners (before timers,
     * like Node's nextTick-ish spawn-failure "error"). A callback may
     * enqueue microtasks or spawn again — restart the turn if so.
     * EXCEPT when ONLY unref'd children remain: Node's liveness check
     * precedes any further poll/reap, so once nothing reffed holds the
     * loop their pending exits are DROPPED at loop exit — never
     * delivered. Without this gate the kill-then-exit shape (a timer's
     * last act kills an unref'd child) would race machine timing: a
     * death landing before this sweep fired its 'exit' where Node
     * deterministically never does. The teardown below releases the
     * undelivered listeners, so the RC audit stays clean. */
    if (scr_loop_children != NULL && scr_loop_children->pending()) {
      bool held =
          scr_reffed_timers > 0 || scr_reffed_immediates > 0 ||
          scr_loop_children->reffed_pending() ||
          /* spawn failures settle regardless: their 'error' is a
           * next-tick event, delivered even on an unref'd child */
          scr_loop_children->failed_pending() ||
          (scr_events_pending_fn != NULL && scr_events_pending_fn()) ||
          (scr_net_pending_fn != NULL && scr_net_pending_fn()) ||
          (scr_dgram_pending_fn != NULL && scr_dgram_pending_fn()) ||
          (scr_watch_pending_fn != NULL && scr_watch_pending_fn()) ||
          (scr_ffi_pending_fn != NULL && scr_ffi_pending_fn()) ||
          scr_fs_renames_pending() || scr_crypto_bytes_pending() || scr_loop_deferred_pending() ||
          scr_workers_pending();
      if (held) {
        scr_loop_children->poll();
        if (scr_exc_pending()) return false; /* uncaught throw in a listener */
        if (scr_ready_len > 0 || scr_nt_head != NULL) continue;
      }
    }
    /* Deferred stream ticks are always-ready work: never sleep or exit
     * while any exist (the dispatch above drains them, so reaching here
     * with ticks pending means a dispatch station enqueued more). User
     * nextTicks enqueued by a station listener are the same story. */
    if (scr_stream_pending_fn != NULL && scr_stream_pending_fn()) continue;
    if (scr_nt_head != NULL) continue;
    bool kids = scr_loop_children != NULL && scr_loop_children->pending();
    bool kids_reffed = scr_loop_children != NULL && scr_loop_children->reffed_pending();
    bool events = scr_events_pending_fn != NULL && scr_events_pending_fn();
    bool net = scr_net_pending_fn != NULL && scr_net_pending_fn();
    /* `net` keeps the process alive; `net_io` (unref'd handles too) decides
     * whether the sleep polls the net unit's fd */
    bool net_io = net || (scr_net_io_fn != NULL && scr_net_io_fn());
    bool dgram = scr_dgram_pending_fn != NULL && scr_dgram_pending_fn();
    bool watch = scr_watch_pending_fn != NULL && scr_watch_pending_fn();
    bool ffi = scr_ffi_pending_fn != NULL && scr_ffi_pending_fn();
    bool renames = scr_fs_renames_pending();
    bool crypto = scr_crypto_bytes_pending() || scr_loop_deferred_pending();
    bool workers = scr_workers_pending();
    /* Timer liveness counts only REF'd timers: an unref'd timer stays in
     * the heap (and fires if the loop runs on for other reasons) but does
     * not by itself keep the process alive — Node's unref semantics.
     * Children follow the same rule: an unref'd child is still REAPED
     * while the loop runs (kids drives the sweeps and sleeps above) but
     * only reffed ones keep the process alive. */
    if (scr_reffed_timers == 0 && scr_reffed_immediates == 0 && !kids_reffed && !events && !net && !dgram && !watch && !ffi && !renames && !crypto && !workers) break;
    /* Sleep to the earliest deadline, then run every due timer (each may
     * enqueue microtasks, which the next iteration drains first). Who
     * sleeps depends on what is pending:
     * - external io: the io POLL takes the sleep — it waits on real fds
     *   up to the deadline (socket readiness wakes it early) and makes
     *   progress (engine jobs, arrived response data) before timers run.
     *   A child's exit can't wake curl's fds, so children re-impose the
     *   reap-granularity cap on this path.
     * - signals watched or stdin consumed: poll(2) takes the sleep — the
     *   wake pipe, fd 0, and the child watch's fd together, so any of
     *   them ends it immediately (details at the branch).
     * - children only: the sleep waits on the child watch — the exit
     *   wakeup and the timer deadline together via the wait timeout — so a
     *   child's exit ends the sleep immediately and the next turn's reap
     *   pass fires its listeners. scr_children_wait declines when it
     *   can't wake for every pending child; the ~1ms polling cap is the
     *   fallback.
     * - timers only: plain nanosleep to the deadline. */
    double now = scr_now_ms();
    double due = scr_ntimers > 0 ? scr_timers[0].deadline_ms : now + SCR_IO_POLL_MS;
    /* The worker pool's wake ends the sleep when a job completes: its pipe
     * joins the poll(2) set on POSIX, and the Windows sleeps wait on its
     * event. Without one (a failed pipe or event, or a child wait that
     * cannot include it) the idle wait is bounded like the portable child
     * fallback so completion is noticed promptly. */
    int renames_fd = renames ? scr_fs_renames_pollfd() : -1;
    bool renames_wait = renames && renames_fd < 0 && scr_fs_renames_can_wait();
    if (renames && renames_fd < 0 && (!renames_wait || kids) && due > now + SCR_CHILD_POLL_MS) {
      due = now + SCR_CHILD_POLL_MS;
    }
    /* Pending immediates are always-ready work: no sleep — run due timers
     * (Node's timers phase precedes check), then the check phase below. */
    if (scr_pending_immediates > 0) due = now;
    /* Queued native callbacks are ready work: no sleep. The next turn
     * delivers the ones queued so far. */
    if (scr_loop_deferred_pending()) {
      due = now;
      scr_loop_deferred_ready = scr_loop_deferred_count;
    }
    /* Child polling can drain a pipe into the IPC queue after its dispatch
     * station has run. Completed sends and disconnects can also become ready
     * during that turn. No fd will wake us for this userspace work: return to
     * dispatch without sleeping, still allowing due timers and immediates. */
    if (scr_loop_children != NULL && scr_loop_children->ready()) due = now;
#ifdef SCR_WORKERS
    if (scr_workers_ready_fn && scr_workers_ready_fn()) due = now;
#endif
    /* An idle moment: a full pass the death rule deferred runs now. */
    if (due > now && scr_cyc_collect_idle()) now = scr_now_ms();
#if !defined(_WIN32) && !defined(__wasi__)
    if (due > now) scr_fiber_stacks_trim(now, due - now);
#endif
#ifdef SCR_WORKERS
    if (due > now) scr_sa_loop_waiting(true);
#endif
    bool evw = scr_events_watching_fn != NULL && scr_events_watching_fn();
#ifdef SCR_WORKERS
    if (workers && scr_workers_wait_fn && !kids && !evw && !net_io && !dgram && !watch && !ffi && !renames && !crypto) {
      scr_workers_wait_fn(due > now ? due - now : 0);
      now = scr_now_ms();
    } else
#endif
    if (evw || net_io || dgram || watch || ffi || workers || renames_fd >= 0) {
#if defined(_WIN32) || defined(__wasi__)
      /* The win32 arm, and WASI hosts whose poll_oneoff adapters do not
       * reliably wake for a closed inherited stdin pipe: the sleep is a capped nanosleep and
       * the next turn's dispatch does the work — signal flags (set by the
       * CRT handler on msvcrt's console-ctrl thread) and the stdin probe
       * at SCR_SIGNAL_POLL_MS granularity (scr_events.c), socket/dgram
       * readiness at the child-reap cap (scr_loop_wsapoll.c's zero-timeout
       * WSAPoll drains at dispatch; ~1ms keeps loopback exchanges inside
       * the granularity Node's IOCP-woken loop delivers, where 50ms could
       * reorder a socket emit past a short timer). When the caps ever
       * show up in a profile, the upgrade is a real waitable arm —
       * WaitForMultipleObjects over WSAEVENTs, or IOCP. */
      if (evw && due > now + SCR_SIGNAL_POLL_MS) due = now + SCR_SIGNAL_POLL_MS;
      if ((net_io || dgram || watch) && due > now + SCR_CHILD_POLL_MS) due = now + SCR_CHILD_POLL_MS;
      if ((ffi || workers) && due > now + SCR_CHILD_POLL_MS) due = now + SCR_CHILD_POLL_MS;
      if (kids && due > now + SCR_CHILD_POLL_MS) due = now + SCR_CHILD_POLL_MS;
      if (due > now) {
        double wait = due - now;
#ifdef _WIN32
        if (renames_wait) {
          scr_fs_renames_wait(wait);
        } else
#endif
        {
          struct timespec ts = {(time_t)(wait / 1000.0), (long)((wait - (double)((time_t)(wait / 1000.0)) * 1000.0) * 1e6)};
          nanosleep(&ts, NULL);
        }
      }
      now = scr_now_ms();
#else
      /* poll(2) takes the sleep: the events unit's fds — the signal wake
       * pipe (a signal delivered BEFORE the poll entered still has its
       * byte in the pipe — no lost-wakeup race) and fd 0 while stdin has
       * a consumer — plus the child watch's fd when it can represent
       * every pending child (kqueue and epoll fds poll readable when
       * events are pending); unrepresentable children keep the ~1ms reap cap
       * instead. Dispatch happens at the next turn's top — the poll only
       * decides how long to sleep. */
      struct pollfd fds[10];
      int nfds = 0;
      int evfds[2];
      int nev = evw && scr_events_pollfds_fn != NULL ? scr_events_pollfds_fn(evfds) : 0;
      for (int i = 0; i < nev; i++) {
        fds[nfds].fd = evfds[i];
        fds[nfds].events = POLLIN;
        fds[nfds++].revents = 0;
      }
      if (net_io) {
        /* The net unit's poller fd: readable while socket events are
         * pending, so arrived data/accepts end the sleep immediately.
         * Dispatch (which also DRAINS the poller) happens at the next
         * turn's top — the poll only decides how long to sleep. */
        int nfd = scr_net_pollfd_fn != NULL ? scr_net_pollfd_fn() : -1;
        if (nfd >= 0) {
          fds[nfds].fd = nfd;
          fds[nfds].events = POLLIN;
          fds[nfds++].revents = 0;
        } else if (due > now + SCR_SIGNAL_POLL_MS) {
          due = now + SCR_SIGNAL_POLL_MS;
        }
      }
      if (dgram) {
        /* The dgram unit's poller fd — the net slot's exact story. */
        int dfd = scr_dgram_pollfd_fn != NULL ? scr_dgram_pollfd_fn() : -1;
        if (dfd >= 0) {
          fds[nfds].fd = dfd;
          fds[nfds].events = POLLIN;
          fds[nfds++].revents = 0;
        } else if (due > now + SCR_SIGNAL_POLL_MS) {
          due = now + SCR_SIGNAL_POLL_MS;
        }
      }
      if (watch) {
        /* The watch unit's event fd — the net slot's exact story. */
        int wfd = scr_watch_pollfd_fn != NULL ? scr_watch_pollfd_fn() : -1;
        if (wfd >= 0) {
          fds[nfds].fd = wfd;
          fds[nfds].events = POLLIN;
          fds[nfds++].revents = 0;
        } else if (due > now + SCR_SIGNAL_POLL_MS) {
          due = now + SCR_SIGNAL_POLL_MS;
        }
      }
      if (ffi) {
        int ffd = scr_ffi_pollfd_fn != NULL ? scr_ffi_pollfd_fn() : -1;
        if (ffd >= 0) {
          fds[nfds].fd = ffd;
          fds[nfds].events = POLLIN;
          fds[nfds++].revents = 0;
        } else if (due > now + SCR_CHILD_POLL_MS) {
          due = now + SCR_CHILD_POLL_MS;
        }
      }
      if (kids) {
        int cfd = scr_loop_children->wake_fd();
        if (cfd >= 0) {
          fds[nfds].fd = cfd;
          fds[nfds].events = POLLIN;
          fds[nfds++].revents = 0;
        } else if (due > now + SCR_CHILD_POLL_MS) {
          due = now + SCR_CHILD_POLL_MS;
        }
      }
      if (renames_fd >= 0) {
        fds[nfds].fd = renames_fd;
        fds[nfds].events = POLLIN;
        fds[nfds++].revents = 0;
      }
      if (workers) {
        int worker_fd = scr_workers_pollfd();
        if (worker_fd >= 0) {
          fds[nfds].fd = worker_fd;
          fds[nfds].events = POLLIN;
          fds[nfds++].revents = 0;
        } else if (due > now + SCR_CHILD_POLL_MS) {
          due = now + SCR_CHILD_POLL_MS;
        }
      }
      double wait = due > now ? due - now : 0;
      if (wait > 1e9) wait = 1e9; /* poll takes int ms */
      (void)poll(fds, (nfds_t)nfds, (int)(wait + 0.999));
      /* Consume queued child-exit events NOW (zero-timeout drain) — an
       * unconsumed event keeps the kqueue fd readable and would turn the
       * next poll into a busy spin while other children still run. The
       * WNOHANG sweep at the next turn's top stays the reaper. */
      if (kids) (void)scr_loop_children->wait(0);
      now = scr_now_ms();
#endif /* !_WIN32 && !__wasi__ */
    } else if (kids && scr_loop_children->wait(due > now ? due - now : 0)) {
      now = scr_now_ms(); /* woke early on an exit, or hit the deadline */
    } else {
      if (kids && due > now + SCR_CHILD_POLL_MS) due = now + SCR_CHILD_POLL_MS;
#ifdef _WIN32
      if (renames_wait && due > now) {
        scr_fs_renames_wait(due - now); /* a completion ends the sleep early */
        now = scr_now_ms();
      } else
#endif
      if (due > now) {
        double wait = due - now;
        struct timespec ts = {(time_t)(wait / 1000.0), (long)((wait - (double)((time_t)(wait / 1000.0)) * 1000.0) * 1e6)};
        nanosleep(&ts, NULL);
        now = due;
      }
    }
#ifdef SCR_WORKERS
    scr_sa_loop_waiting(false);
#endif
    while (scr_ntimers > 0 && scr_timers[0].deadline_ms <= now) {
      ScrTimer t = scr_timer_pop();
      /* Timer callbacks are plain sync closures, run on the main stack.
       * An interval entry is OUT of the heap while its callback runs;
       * clearInterval(its own id) from inside sets the firing flag and
       * the re-arm below drops it instead. A throw kills the interval
       * with the program (Node: the uncaught exception ends the process
       * before any rescheduled tick could run). */
      if (t.id != 0) {
        scr_firing_id = t.id;
        scr_firing_cleared = false;
        scr_firing_reffed = t.reffed; /* unref/ref during the callback lands here */
        scr_firing_refresh = false;
      }
      ((void (*)(ScrClosure *))t.cb->fn)(t.cb);
      if (t.id != 0 && t.repeat_ms > 0 && !scr_firing_cleared) {
        /* Re-arm relative to the post-callback clock (libuv's uv_timer
         * repeat behavior: no catch-up bursts after a slow callback). The
         * ref state carries across ticks (a self-unref'd interval stays
         * unref'd). */
        ScrTimer again = {scr_now_ms() + t.repeat_ms, scr_timer_seq++, t.cb, t.repeat_ms, t.id, scr_firing_reffed, t.delay_ms};
        scr_timer_push(again);
      } else if (t.id != 0 && scr_firing_refresh && !scr_firing_cleared) {
        /* refresh() from inside the one-shot's own callback: re-arm to
         * now + the original delay, ref state carried (Node's
         * Timeout.refresh — the timer fires again). */
        ScrTimer again = {scr_now_ms() + t.delay_ms, scr_timer_seq++, t.cb, 0, t.id, scr_firing_reffed, t.delay_ms};
        scr_timer_push(again);
      } else {
        scr_closure_release(t.cb);
      }
      scr_firing_id = 0;
      if (scr_exc_pending()) return false; /* uncaught throw in a callback: main handles it */
      /* Drain ticks and microtasks, and report the rejections the callback
       * left, before more timers (Node's runNextTicks between timers). */
      if (scr_ready_len > 0 || scr_nt_head != NULL || scr_nunhandled > 0) break;
    }
    /* The check phase: immediates queued BEFORE this phase started run
     * now, FIFO; ones a callback queues wait for the next turn (the end
     * snapshot — Node's once-per-turn rule, so a setImmediate chain can't
     * starve the loop). Cleared slots (cb NULL) skip. Ticks, then
     * microtasks, drain after each callback, like Node's checkpoint after
     * every macrotask; pending ticks or a woken fiber restart the turn
     * first (the timer loop's break above), so the phase only runs on a
     * drained checkpoint. */
    bool check_ran = false;
    if (scr_ready_len == 0 && scr_nt_head == NULL && scr_nunhandled == 0 && scr_pending_immediates > 0) {
      size_t end = scr_nimmediates;
      while (scr_immediates_head < end) {
        size_t i = scr_immediates_head++;
        ScrClosure *cb = scr_immediates[i].cb;
        if (cb == NULL) continue; /* cleared */
        scr_immediates[i].cb = NULL; /* fired: clear/ref/unref on this id no-op now */
        if (scr_pending_immediates > 0) scr_pending_immediates--;
        if (scr_immediates[i].reffed) {
          scr_immediates[i].reffed = false;
          if (scr_reffed_immediates > 0) scr_reffed_immediates--;
        }
        ((void (*)(ScrClosure *))cb->fn)(cb);
        scr_closure_release(cb);
        if (scr_exc_pending()) return false; /* uncaught throw: main handles it */
        if (!scr_loop_run_checkpoint()) return false;
        /* Node's runNextTicks between immediates also reports the
         * rejections the callback left before the next one runs; a
         * listener's jobs drain before the next report. */
        while (scr_nunhandled > 0 && (top_level == NULL || top_level->state != SCR_PROM_REJECTED)) {
          if (scr_report_unhandled_rejections()) return true;
          if (!scr_loop_run_checkpoint()) return false;
        }
        if (top_level != NULL && top_level->state == SCR_PROM_REJECTED) break;
      }
      /* Fully drained: reset the cursor so the array reuses its slots. */
      if (scr_immediates_head == scr_nimmediates) {
        scr_immediates_head = 0;
        scr_nimmediates = 0;
      }
      check_ran = true;
    }
    /* The next poll phase opens once this iteration's check phase ran (or
     * had nothing to run). A check phase deferred for pending microtasks
     * keeps it closed, so the next iteration reaches the check phase
     * before polling again. */
    if (check_ran || scr_pending_immediates == 0) {
      scr_loop_io_open = true;
      scr_loop_io_batches = 0;
    }
  }
  return rejection_failed;
}

/* A CommonJS main module runs synchronously (Module._load), so the first
 * checkpoint after it drains process.nextTick callbacks before promise
 * jobs like every later one; only an ES-module main's awaited evaluation
 * lets its body's promise jobs run first. Set by the emitted main before
 * the loop starts. */
static SCR_TL bool scr_loop_cjs_entry = false;
void scr_loop_commonjs_entry(void) { scr_loop_cjs_entry = true; }

bool scr_loop_run(ScrPromise *top_level) {
  /* The main module's body has returned: an enterWith it made ends here. */
  scr_loop_started = true;
  scr_cyc_note_event_loop();
  if (scr_als_main_slot != NULL) scr_als_main_clear();
  bool first_checkpoint = !scr_loop_cjs_entry;
  bool rejection_failed;
  for (;;) {
    rejection_failed = scr_loop_run_pass(top_level && !top_level->top_level_handled ? top_level : NULL, first_checkpoint);
    first_checkpoint = false;
    if (scr_exc_pending()) {
      if (scr_exc_handle_uncaught(false)) continue;
      break; /* main reports the original or handler-thrown exception */
    }
    if (rejection_failed) break;
    if (top_level && top_level->state == SCR_PROM_REJECTED && !top_level->top_level_handled) {
      scr_promise_rethrow(top_level);
      if (scr_exc_handle_uncaught(true)) {
        top_level->top_level_handled = true;
        scr_prom_observe(top_level);
        continue;
      }
      scr_discard_unhandled_rejections();
      break;
    }
    break;
  }
  /* Exit can now leave UNREF'd timers armed in the heap (ordinary
   * exhaustion, a fatal module root, or an unhandled rejection). They
   * never fire, so release their closures here or the RC audit counts
   * them as leaks. Uncaught callback throws still return above for main
   * to report through the existing exceptional teardown path. */
  scr_timers_teardown();
  /* No reffed foreign registration or queued invocation remains at ordinary
   * exhaustion. Disarm posting before exit listeners/global teardown so a
   * post from a straggling native thread is dropped safely. */
  if (scr_ffi_stop_fn != NULL) scr_ffi_stop_fn();
  /* Retained native FFI registrations are deliberately NOT torn down
   * here: process 'exit' listeners run after the loop returns (inline in
   * main, before any atexit handler) and may legitimately release a
   * registration or pump a native library one last time — exactly like
   * the process.exit() path, where the ledger is also still intact. On
   * returns that reach atexit, the sweep scr_ffi_retain registered (LIFO
   * before the RC audit) then drops the ledger's references. It does NOT
   * run on process.exit(): scr_process_exit ends in _Exit, skipping every
   * atexit handler — the sweep and the RC audit alike — and leaves the
   * ledger to the OS. */
  /* Unref'd children the loop never reaped: release the
   * registry's references (their listeners never fire — the process is
   * exiting, Node's behavior; the OS reparents the children). */
  if (scr_loop_children != NULL) scr_loop_children->teardown();
  scr_fibers_abandoned = scr_fibers_live;
  scr_note_abandoned_fibers(scr_fibers_abandoned);
  return rejection_failed;
}

/* ── process.on('unhandledRejection') ─────────────────────────────────
 * Dyn listeners are called per never-observed rejection at the completed
 * nextTick/microtask checkpoint. A registered listener suppresses the
 * default report and exit 1, exactly Node's handled-event contract. */

/* The unhandled-rejection LISTENER hook (scr_async_dyn.c installs it at
 * registration — the loop-hook pattern, so listener-free binaries keep
 * their size class): called per never-observed rejection; false = a
 * listener threw (the uncaught crash path). */
SCR_TL bool (*scr_urj_deliver_fn)(ScrPromise *p) = NULL;

/* Unhandled rejections at a completed nextTick/microtask checkpoint:
 * Node prints an error and exits 1 when no listener handles the event.
 * Snapshot the ledger: a listener can reject another promise, but that
 * new rejection belongs to the NEXT checkpoint rather than this report. */
bool scr_report_unhandled_rejections(void) {
  bool any = false;
  bool crashed = false;
  size_t report_count = scr_nunhandled;
  for (size_t i = 0; i < report_count; i++) {
    ScrPromise *p = scr_maybe_unhandled[i];
    if (p->state == SCR_PROM_REJECTED && !p->rejection_observed && !crashed) {
      if (scr_urj_deliver_fn != NULL) {
        /* Listener dispatch (scr_async_dyn.c installed the hook at
         * registration): the event handles it, like Node — per entry,
         * no report, exit 0. A listener throw is the uncaught crash.
         * reported_unhandled arms the 'rejectionHandled' window: a
         * handler the listener itself attaches fires the sibling event
         * (scr_prom_observe). */
        p->rejection_observed = true;
        p->reported_unhandled = true;
        if (!scr_urj_deliver_fn(p) && !scr_exc_handle_uncaught(false)) crashed = true;
      } else if (scr_uncaught_exception_hook != NULL) {
        scr_promise_rethrow(p);
        if (scr_exc_handle_uncaught(true)) {
          p->rejection_observed = true;
          p->reported_unhandled = true;
        } else {
          crashed = true;
        }
      } else if (!any) {
        any = true;
#ifdef SCR_WORKERS
        if (scr_context_report_error) {
          scr_promise_rethrow(p);
          scr_context_report_rejection = true;
          scr_exc_print_uncaught();
          scr_context_report_rejection = false;
          scr_promise_release(p);
          continue;
        }
#endif
        fflush(stdout);
        fputs("Unhandled promise rejection: ", stderr);
        switch (p->payload_kind) {
        case SCR_EXC_F64: {
          char buf[32];
          scr_f64_to_str(p->f64, buf);
          fputs(buf, stderr);
          break;
        }
        case SCR_EXC_BOOL: fputs(p->b ? "true" : "false", stderr); break;
        case SCR_EXC_STR: fputs(((ScrStr *)p->payload)->data, stderr); break;
        case SCR_EXC_OBJ:
          /* Error rejections render "name: message", like the uncaught path. */
          if (scr_error_is(p->payload)) {
            ScrStr *s = scr_error_to_string((ScrError *)p->payload);
            fwrite(s->data, 1, s->len, stderr);
            scr_str_release(s);
            break;
          }
          /* fall through */
        default: fputs("[object]", stderr); break;
        }
        fputc('\n', stderr);
      }
    }
    scr_promise_release(p);
  }
  size_t remaining = scr_nunhandled - report_count;
  if (remaining > 0) {
    memmove(scr_maybe_unhandled, scr_maybe_unhandled + report_count,
            remaining * sizeof *scr_maybe_unhandled);
  }
  scr_nunhandled = remaining;
  if (crashed) {
    scr_exc_print_uncaught();
    return true;
  }
  /* main returns 1 on a reported rejection — the 'exit' listeners (atexit)
   * must see that code, like Node's. */
  if (any) scr_exit_code_note(1);
  return any;
}

/* A fatal executable-module rejection suppresses unrelated rejections
 * created in the SAME checkpoint. Drop their retained ledger references
 * without delivering process events or a competing default report. */
void scr_discard_unhandled_rejections(void) {
  for (size_t i = 0; i < scr_nunhandled; i++) {
    scr_promise_release(scr_maybe_unhandled[i]);
  }
  scr_nunhandled = 0;
}

/* ── new Promise(executor) ────────────────────────────────────────────── */

/* resolve closures: caps[0] is a box whose slot holds the promise (+1). */
static ScrPromise *scr_resolve_target(ScrClosure *self) {
  return (ScrPromise *)scr_box_get_ref(self->caps[0]);
}
static void scr_resolve_thunk_f64(ScrClosure *self, double v) {
  ScrPromise *p = scr_resolve_target(self);
  scr_promise_fulfill_f64(p, v);
  scr_promise_release(p);
}
static void scr_resolve_thunk_bool(ScrClosure *self, bool v) {
  ScrPromise *p = scr_resolve_target(self);
  scr_promise_fulfill_bool(p, v);
  scr_promise_release(p);
}
static void scr_resolve_thunk_str(ScrClosure *self, ScrStr *v) {
  ScrPromise *p = scr_resolve_target(self);
  scr_promise_fulfill_str(p, v); /* callee owns its params: moves in */
  scr_promise_release(p);
}
static void scr_resolve_thunk_void(ScrClosure *self) {
  ScrPromise *p = scr_resolve_target(self);
  scr_promise_fulfill_void(p);
  scr_promise_release(p);
}
/* Ref payloads: emitted code passes the concrete retain/release via a
 * second box slot? Keep simple: ref resolve thunks are monomorphized by the
 * EMITTER (it knows the arm type) — it emits a tiny static thunk calling
 * scr_promise_fulfill_ref with the concrete helpers, wrapped over caps[0].
 * The runtime provides only the scalar/str/void thunks. */

ScrClosure *scr_make_resolve(ScrPromise *p, int kind /*0 f64,1 bool,2 str,3 void*/) {
  void *fns[4] = {(void *)&scr_resolve_thunk_f64, (void *)&scr_resolve_thunk_bool,
                  (void *)&scr_resolve_thunk_str, (void *)&scr_resolve_thunk_void};
  ScrClosure *c = scr_closure_new(fns[kind], 1);
  ScrBox *b = scr_box_new_obj(scr_promise_retain_v, scr_promise_release_v,
                               scr_promise_trace_v);
  scr_box_set_ref(b, scr_promise_retain(p));
  c->caps[0] = b;
  return c;
}

/* Emitted ref-kind resolve thunks call this. */
void scr_resolve_ref_impl(ScrClosure *self, void *v, void *(*retain)(void *), void (*release)(void *), ScrTraceFn trace) {
  ScrPromise *p = scr_resolve_target(self);
  scr_promise_fulfill_ref(p, v, retain, release, trace);
  scr_promise_release(p);
}

/* ── emitter support ──────────────────────────────────────────────────── */

ScrPromise *scr_fiber_promise(ScrFiber *f) { return f->promise; }

/* Generalized resolve construction: `fn` is an emitted thunk with closure
 * calling convention (self, value) that forwards to scr_resolve_ref_impl
 * with the concrete RC helpers. */
ScrClosure *scr_make_resolve_fn(ScrPromise *p, void *fn) {
  ScrClosure *c = scr_closure_new(fn, 1);
  ScrBox *b = scr_box_new_obj(scr_promise_retain_v, scr_promise_release_v,
                               scr_promise_trace_v);
  scr_box_set_ref(b, scr_promise_retain(p));
  c->caps[0] = b;
  return c;
}

/* ── reject closures (new Promise((resolve, reject) => ...)) ──────────
 * Mirror of the resolve closures: caps[0] is a box whose slot holds the
 * promise (+1). The reason is always an Error-hierarchy instance (the
 * frontend pins the reject parameter to `(reason: Error) => void`), and it
 * stores as SCR_EXC_OBJ — exactly the thrown-Error representation — so an
 * await rethrows it, catch-side instanceof answers, and the uncaught
 * printer prints "name: message". First settle wins, exactly JS: reject
 * after any settle (resolve-then-reject, double reject) releases the
 * reason and does nothing. The closure calling convention makes the thunk
 * own its param, like every compiled callee. */
static void scr_reject_thunk(ScrClosure *self, ScrError *reason) {
  ScrPromise *p = scr_resolve_target(self);
  if (p->state != SCR_PROM_PENDING) {
    scr_error_release(reason);
  } else {
    p->state = SCR_PROM_REJECTED;
    p->payload_kind = SCR_EXC_OBJ;
    p->payload = reason; /* ownership moves in */
    p->retain_fn = scr_error_retain_v;
    p->release_fn = scr_error_release_v;
    p->trace_fn = scr_error_trace_arg();
    scr_promise_settle_wake(p);
  }
  scr_promise_release(p);
}

ScrClosure *scr_make_reject(ScrPromise *p) {
  ScrClosure *c = scr_closure_new((void *)&scr_reject_thunk, 1);
  ScrBox *b = scr_box_new_obj(scr_promise_retain_v, scr_promise_release_v,
                               scr_promise_trace_v);
  scr_box_set_ref(b, scr_promise_retain(p));
  c->caps[0] = b;
  return c;
}

/* Shared executor epilogue: an escaping throw rejects a still-pending
 * promise (payload moved out of the active exception cell); a throw after
 * the promise settled is swallowed, like resolve-then-throw in JS. */
static void scr_executor_check_throw(ScrPromise *p) {
  if (!scr_exc_pending()) return;
  if (p->state == SCR_PROM_PENDING) {
    scr_promise_reject_from_cell(p, scr_exc_current_cell());
    scr_promise_settle_wake(p);
  } else {
    scr_exc_clear();
  }
}

/* Runs a `new Promise(executor)` executor synchronously; an escaping throw
 * rejects the promise (JS-exact). Borrows `p` and `exec`; `resolve`
 * ownership moves INTO the executor call (compiled callees own and finally
 * release their params). */
void scr_promise_run_executor(ScrPromise *p, ScrClosure *exec, ScrClosure *resolve) {
  ((void (*)(ScrClosure *, ScrClosure *))exec->fn)(exec, resolve);
  scr_executor_check_throw(p);
}

/* Zero-param executor (`new Promise(() => {})`): nothing can ever resolve —
 * a deliberately-forever-pending promise. Borrows both. */
void scr_promise_run_executor0(ScrPromise *p, ScrClosure *exec) {
  ((void (*)(ScrClosure *))exec->fn)(exec);
  scr_executor_check_throw(p);
}

/* Two-param executor (`new Promise((resolve, reject) => ...)`): same as
 * scr_promise_run_executor with the reject closure's +1 also moving into
 * the call. */
void scr_promise_run_executor2(ScrPromise *p, ScrClosure *exec, ScrClosure *resolve,
                                ScrClosure *reject) {
  ((void (*)(ScrClosure *, ScrClosure *, ScrClosure *))exec->fn)(exec, resolve, reject);
  scr_executor_check_throw(p);
}

/* ── sync generators (function*) ──────────────────────────────────────
 * Contract in scr_runtime.h. The fiber machinery above is the engine:
 * scr_switch is a synchronous coroutine hop, so generators need no event
 * loop — .next() from the main stack (or any fiber) blocks until the
 * yield. */

enum {
  SCR_GEN_UNSTARTED = 0,
  SCR_GEN_SUSPENDED,
  SCR_GEN_AWAITING,
  SCR_GEN_RUNNING,
  SCR_GEN_DONE
};

/* One type-erased value slot: the exception cell's payload technique,
 * with only the release entry point (takes MOVE — nothing here retains). */
typedef struct {
  ScrExcKind kind; /* NONE / F64 / BOOL / REF (strings ride REF) */
  double f64;
  bool b;
  void *payload;
  void (*release_fn)(void *);
} ScrGenSlot;

enum { SCR_AG_NEXT = 0, SCR_AG_RETURN, SCR_AG_THROW };

typedef struct ScrAsyncGenRequest {
  int mode;
  ScrGenSlot arg;
  ScrExcCell thrown;
  ScrPromise *promise; /* owned until this request settles */
  struct ScrAsyncGenRequest *next;
} ScrAsyncGenRequest;

static void scr_gen_slot_reset(ScrGenSlot *s) {
  if (s->kind == SCR_EXC_REF && s->payload != NULL) s->release_fn(s->payload);
  s->kind = SCR_EXC_NONE;
  s->payload = NULL;
  s->release_fn = NULL;
}

static void scr_gen_exc_reset(ScrExcCell *cell) {
  if (cell->kind == SCR_EXC_STR) {
    scr_str_release((ScrStr *)cell->payload);
  } else if (cell->kind == SCR_EXC_REF || cell->kind == SCR_EXC_OBJ ||
             cell->kind == SCR_EXC_PRIMITIVE_REF) {
    cell->release_fn(cell->payload);
  }
  ScrStackFrame *stack = cell->stack;
  memset(cell, 0, sizeof *cell);
  cell->stack = stack;
}

static void scr_gen_exc_move(ScrExcCell *dst, ScrExcCell *src) {
  scr_gen_exc_reset(dst);
  ScrStackFrame *dst_stack = dst->stack;
  ScrStackFrame *src_stack = src->stack;
  *dst = *src;
  dst->stack = dst_stack;
  memset(src, 0, sizeof *src);
  src->stack = src_stack;
  scr_exc_cell_changed();
}

struct ScrGen {
  size_t rc;
  ScrDyn *receiver;
  ScrFiber *fiber; /* NULL once torn down (done, or unstarted release) */
  int state;
  ScrGenSlot out; /* yielded value / completion value */
  ScrGenSlot in;  /* the .next(v) argument */
  ScrGenSlot ret; /* a parked .return(v) value */
  /* The never-started teardown: drops the packed (already-retained)
   * arguments the spawn wrapper built. Emitted per generator function. */
  void (*drop_args)(void *);
  /* scr_gen_set_unstarted_return's hook; NULL for most generators. */
  void (*unstarted_return)(void *);
  const char *tag; /* scr_gen_set_tag's; NULL is the default */
  bool is_async;
  void (*settle_async)(ScrGen *, ScrPromise *);
  ScrAsyncGenRequest *requests_head;
  ScrAsyncGenRequest *requests_tail;
  ScrPromise *active_request;
  ScrExcCell async_error;
  bool settle_queued;
  bool success_hop_done;
  /* A return() request at a yield: the queued job resumes the body after
   * the return value's await (return_queued), and the body's completion,
   * on that request or a later one, settles without another turn
   * (return_awaited). An explicit `return x` during the unwind clears it,
   * since that return takes its own turn to await x. */
  bool return_queued;
  bool return_awaited;
  /* The AsyncLocalStorage context of a return() request deferred at a
   * yield (+1): the body's unwind runs in it, as Node resumes it from the
   * return value's await. */
  ScrAlsCtx *return_ctx;
#ifdef SCR_WORKERS
  bool context_abandoned;
#endif
};

/* The LLVM emitter stores number and boolean yields into OUT and takes
 * them back out inline, through %ScrGenHead { rc, receiver, fiber, state,
 * out } and %ScrGenSlot { kind, f64, b, payload, release_fn }. */
struct ScrGenHeadMirror {
  size_t rc;
  ScrDyn *receiver;
  ScrFiber *fiber;
  int state;
  ScrGenSlot out;
};
_Static_assert(offsetof(ScrGen, fiber) == offsetof(struct ScrGenHeadMirror, fiber) &&
                   offsetof(ScrGen, state) == offsetof(struct ScrGenHeadMirror, state) &&
                   offsetof(ScrGen, out) == offsetof(struct ScrGenHeadMirror, out),
               "the LLVM emitter's %ScrGenHead");
_Static_assert(offsetof(ScrGenSlot, kind) == 0 && sizeof(ScrExcKind) == 4 &&
                   offsetof(ScrGenSlot, f64) == 8 && offsetof(ScrGenSlot, b) == 16 &&
                   sizeof(bool) == 1 && SCR_EXC_NONE == 0 && SCR_EXC_F64 == 1 &&
                   SCR_EXC_BOOL == 2,
               "the LLVM emitter's %ScrGenSlot and its number/boolean tags");

static ScrGen *scr_gen_new_common(void (*entry)(ScrFiber *, void *), void *argpack,
                                  void (*drop_args)(void *),
                                  void (*settle_async)(ScrGen *, ScrPromise *),
                                  bool stackless) {
  ScrGen *g = scr_mem_calloc(sizeof *g);
  if (!g) scr_oom();
  /* Install the tag reader with each generator rather than in a constructor:
   * a constructor is a link root, so it would keep scr_gen_tag and this
   * unit's string literals in every executable, generators or not. Threads
   * store the same value, relaxed. */
  __atomic_store_n(&scr_gen_tag_reader, scr_gen_tag, __ATOMIC_RELAXED);
  g->rc = 1;
  g->receiver = scr_dyn_this_get();
  g->state = SCR_GEN_UNSTARTED;
  g->drop_args = drop_args;
  g->is_async = settle_async != NULL;
  g->settle_async = settle_async;
  scr_obj_alloc_note();

  ScrFiber *f = scr_mem_calloc(sizeof *f);
  if (!f) scr_oom();
  f->gen = g;
  scr_fiber_track(f);
  f->entry = entry;
  f->argpack = argpack; /* owned by the fiber start; drop_args if never started */
  /* AsyncLocalStorage: generator bodies run in their CREATOR's context
   * (the spawn-inheritance stance; resumes swap it active like any
   * fiber switch). */
  f->als = scr_als_ctx_retain(*SCR_ALS_SLOT());
  scr_fibers_live++;
  f->stackless = stackless;
#ifdef _WIN32
  if (!stackless) {
    f->ctx = CreateFiberEx(4096, 0, 0, scr_trampoline, NULL);
    if (f->ctx == NULL) scr_oom();
  }
#elif defined(__wasi__)
  f->ctx = 0;
#else
  if (!stackless) scr_fiber_context_init(f);
#endif
  g->fiber = f;
  return g;
}

ScrGen *scr_gen_new(void (*entry)(ScrFiber *, void *), void *argpack,
                    void (*drop_args)(void *)) {
  return scr_gen_new_common(entry, argpack, drop_args, NULL, false);
}

ScrGen *scr_gen_new_stackless(void (*entry)(ScrFiber *, void *), void *argpack,
                              void (*drop_args)(void *)) {
  return scr_gen_new_common(entry, argpack, drop_args, NULL, true);
}

ScrGen *scr_async_gen_new(void (*entry)(ScrFiber *, void *), void *argpack,
                          void (*drop_args)(void *),
                          void (*settle)(ScrGen *, ScrPromise *)) {
  return scr_gen_new_common(entry, argpack, drop_args, settle, false);
}

#ifndef __wasi__
ScrGen *scr_async_gen_new_stackless(void (*entry)(ScrFiber *, void *), void *argpack,
                                    void (*drop_args)(void *),
                                    void (*settle)(ScrGen *, ScrPromise *)) {
  return scr_gen_new_common(entry, argpack, drop_args, settle, true);
}
#endif

ScrGen *scr_gen_retain(ScrGen *g) {
  if (g) g->rc++;
  return g;
}

void scr_gen_release(ScrGen *g) {
  if (!g || --g->rc != 0) return;
#ifdef SCR_WORKERS
  if (g->fiber && g->state != SCR_GEN_UNSTARTED && g->state != SCR_GEN_DONE) {
    /* A dropped suspended generator cannot run user finalizers. Keep its
     * native frame valid until context shutdown can unwind owned locals
     * through the noncatchable stop path. */
    g->rc = 1;
    g->context_abandoned = true;
    return;
  }
#endif
  scr_dyn_release(g->receiver);
  scr_gen_slot_reset(&g->out);
  scr_gen_slot_reset(&g->in);
  scr_gen_slot_reset(&g->ret);
  scr_gen_exc_reset(&g->async_error);
  scr_als_ctx_release(g->return_ctx);
  if (g->fiber != NULL) {
    if (g->state == SCR_GEN_UNSTARTED) {
      /* Never ran: nothing on the stack owns anything — clean teardown.
       * The packed arguments (+1 each) drop through the emitted helper. */
      if (g->drop_args != NULL) g->drop_args(g->fiber->argpack);
      else free(g->fiber->argpack);
      scr_fiber_destroy(g->fiber);
      scr_fibers_live--;
    } else {
      /* Suspended: the stack holds live locals — unwinding would run user
       * finally blocks Node's GC never runs, so the fiber is deliberately
       * ABANDONED (it stays in the live count; a program that drops a
       * suspended generator gets the abandoned-fiber audit note, the
       * loop-exhaustion story). The fiber's back-pointer clears so a
       * dangling resume can never reach the freed ScrGen. */
      g->fiber->gen = NULL;
#ifdef SCR_ASAN_FIBERS
      scr_fiber_keep_abandoned(g->fiber);
#endif
    }
  }
  scr_obj_free_note();
  scr_mem_free(g);
}

void *scr_gen_retain_v(void *g) { return scr_gen_retain((ScrGen *)g); }
void scr_gen_release_v(void *g) { scr_gen_release((ScrGen *)g); }

bool scr_gen_done(ScrGen *g) { return g->state == SCR_GEN_DONE; }
ScrGen *scr_gen_of_fiber(ScrFiber *f) { return f->gen; }
ScrDyn *scr_gen_receiver(void) {
  return scr_dyn_retain(scr_current && scr_current->gen ? scr_current->gen->receiver : scr_dyn_undefined());
}

/* Slot setters (release the previous occupant; payloads MOVE in). */
static void scr_gen_slot_f64(ScrGenSlot *s, double v) {
  scr_gen_slot_reset(s);
  s->kind = SCR_EXC_F64;
  s->f64 = v;
}
static void scr_gen_slot_bool(ScrGenSlot *s, bool v) {
  scr_gen_slot_reset(s);
  s->kind = SCR_EXC_BOOL;
  s->b = v;
}
static void scr_gen_slot_ref(ScrGenSlot *s, void *v, void (*release)(void *)) {
  scr_gen_slot_reset(s);
  s->kind = SCR_EXC_REF;
  s->payload = v;
  s->release_fn = release;
}

void scr_gen_in_f64(ScrGen *g, double v) { scr_gen_slot_f64(&g->in, v); }
void scr_gen_in_bool(ScrGen *g, bool v) { scr_gen_slot_bool(&g->in, v); }
void scr_gen_in_ref(ScrGen *g, void *v, void (*release)(void *)) {
  scr_gen_slot_ref(&g->in, v, release);
}
void scr_gen_in_none(ScrGen *g) { scr_gen_slot_reset(&g->in); }

void scr_gen_ret_f64(ScrGen *g, double v) { scr_gen_slot_f64(&g->ret, v); }
void scr_gen_ret_bool(ScrGen *g, bool v) { scr_gen_slot_bool(&g->ret, v); }
void scr_gen_ret_ref(ScrGen *g, void *v, void (*release)(void *)) {
  scr_gen_slot_ref(&g->ret, v, release);
}
void scr_gen_ret_none(ScrGen *g) { scr_gen_slot_reset(&g->ret); }

void scr_gen_out_f64(ScrGen *g, double v) { scr_gen_slot_f64(&g->out, v); }
void scr_gen_out_bool(ScrGen *g, bool v) { scr_gen_slot_bool(&g->out, v); }
void scr_gen_out_ref(ScrGen *g, void *v, void (*release)(void *)) {
  scr_gen_slot_ref(&g->out, v, release);
}

/* Takes MOVE the slot's value out (the slot resets — a done generator's
 * later resumes answer NONE, JS's undefined). */
static double scr_gen_slot_take_f64(ScrGenSlot *s) {
  double v = s->kind == SCR_EXC_F64 ? s->f64 : 0;
  s->kind = SCR_EXC_NONE;
  return v;
}
static bool scr_gen_slot_take_bool(ScrGenSlot *s) {
  bool v = s->kind == SCR_EXC_BOOL ? s->b : false;
  s->kind = SCR_EXC_NONE;
  return v;
}
static void *scr_gen_slot_take_ref(ScrGenSlot *s) {
  void *v = s->kind == SCR_EXC_REF ? s->payload : NULL;
  s->kind = SCR_EXC_NONE;
  s->payload = NULL;
  s->release_fn = NULL;
  return v;
}

bool scr_gen_out_has(ScrGen *g) { return g->out.kind != SCR_EXC_NONE; }
double scr_gen_take_out_f64(ScrGen *g) { return scr_gen_slot_take_f64(&g->out); }
bool scr_gen_take_out_bool(ScrGen *g) { return scr_gen_slot_take_bool(&g->out); }
void *scr_gen_take_out_ref(ScrGen *g) { return scr_gen_slot_take_ref(&g->out); }

/* The running fiber's generator — the body-side helpers' anchor. */
static ScrGen *scr_gen_self(void) {
  ScrGen *g = scr_current != NULL ? scr_current->gen : NULL;
  if (g == NULL) {
    fputs("scriptc: internal error: yield outside a generator\n", stderr);
    abort();
  }
  return g;
}

double scr_gen_take_in_f64(void) { return scr_gen_slot_take_f64(&scr_gen_self()->in); }
bool scr_gen_take_in_bool(void) { return scr_gen_slot_take_bool(&scr_gen_self()->in); }
void *scr_gen_take_in_ref(void) { return scr_gen_slot_take_ref(&scr_gen_self()->in); }
ScrDyn *scr_gen_take_in_dyn(void) {
  ScrGenSlot *in = &scr_gen_self()->in;
  if (in->kind == SCR_EXC_NONE) return scr_dyn_retain(scr_dyn_undefined());
  return scr_gen_slot_take_ref(in);
}

ScrDyn *scr_gen_delegate_resume(ScrDyn *(*next_ref)(void *),
                                ScrDyn *(*return_ref)(void *),
                                ScrDyn *(*caught_ref)(const ScrCaught *)) {
  ScrGen *g = scr_gen_self();
  ScrExcCell *cell = scr_exc_current_cell();
  int mode = cell->kind == SCR_EXC_GENRET ? 1 : cell->kind != SCR_EXC_NONE ? 2 : 0;
  ScrDyn *value;
  if (mode == 2) {
    ScrCaught *caught = scr_exc_take();
    value = caught_ref(caught);
    scr_caught_release(caught);
  } else {
    if (mode == 1) scr_exc_clear();
    ScrGenSlot *slot = mode == 1 ? &g->ret : &g->in;
    ScrDyn *(*convert)(void *) = mode == 1 ? return_ref : next_ref;
    switch (slot->kind) {
    case SCR_EXC_F64: value = scr_dyn_new_num(slot->f64); break;
    case SCR_EXC_BOOL: value = scr_dyn_new_bool(slot->b); break;
    case SCR_EXC_REF: value = convert(slot->payload); break;
    default: value = scr_dyn_retain(scr_dyn_undefined()); break;
    }
    scr_gen_slot_reset(slot);
  }
  if (scr_exc_pending()) {
    scr_dyn_release(value);
    return NULL;
  }
  ScrDyn *result = scr_dyn_new_obj();
  ScrDyn *kind = scr_dyn_new_num(mode);
  scr_dyn_obj_set(result, "kind", 4, kind);
  scr_dyn_obj_set(result, "value", 5, value);
  /* Object insertion takes ownership of both completion fields. */
  return result;
}

/* yield* into a sync generator delegate. A channel transfer moves one
 * slot into another: MOVE as is (same channel type), DYN boxed into a dyn
 * channel, STRICT only when empty (any value would change type: the
 * SC1071 fence), DROP onto an undefined channel. A return(v) whose value
 * the delegate's return channel cannot hold keeps v parked in the
 * delegating body (STRICT in the return position): the delegate returns
 * without a value and v becomes the body's completion unless the
 * delegate's finally returns its own. */
enum { SCR_GEN_XFER_MOVE, SCR_GEN_XFER_DYN, SCR_GEN_XFER_STRICT, SCR_GEN_XFER_DROP };

static bool scr_gen_delegate_fence(const char *message, size_t len) {
  scr_throw_error_msg_code(SCR_ERR_ERROR, message, len, "SC1071");
  return false;
}

static bool scr_gen_slot_transfer(ScrGenSlot *dst, ScrGenSlot *src, unsigned mode,
                                  ScrDyn *(*to_dyn)(void *)) {
  scr_gen_slot_reset(dst);
  if (mode == SCR_GEN_XFER_DROP || src->kind == SCR_EXC_NONE) {
    scr_gen_slot_reset(src);
    return true;
  }
  if (mode == SCR_GEN_XFER_STRICT) {
    static const char sc_m[] =
        "yield* completing with a value outside the delegating generator's return type is not "
        "supported";
    return scr_gen_delegate_fence(sc_m, sizeof sc_m - 1);
  }
  if (mode == SCR_GEN_XFER_DYN) {
    ScrDyn *v;
    switch (src->kind) {
    case SCR_EXC_F64: v = scr_dyn_new_num(src->f64); break;
    case SCR_EXC_BOOL: v = scr_dyn_new_bool(src->b); break;
    default: v = to_dyn(src->payload); break;
    }
    scr_gen_slot_reset(src);
    scr_gen_slot_ref(dst, v, scr_dyn_release_v);
    return true;
  }
  *dst = *src;
  src->kind = SCR_EXC_NONE;
  src->payload = NULL;
  src->release_fn = NULL;
  return true;
}

/* Whether the delegate is done. `typed_ret`: the delegating body reads the
 * completion as a return type that cannot hold undefined, which an empty
 * completion (a finished delegate, or a valueless return) would be. */
static bool scr_gen_delegate_done(ScrGen *d, bool typed_ret) {
  if (d->state != SCR_GEN_DONE) return false;
  if (typed_ret && d->out.kind == SCR_EXC_NONE && !scr_exc_pending()) {
    static const char sc_m[] =
        "yield* of a generator that completes with undefined through a return type that cannot "
        "hold it is not supported";
    scr_gen_delegate_fence(sc_m, sizeof sc_m - 1);
  }
  return true;
}

bool scr_gen_delegate_start(ScrGen *d, unsigned flags) {
  if ((flags & 1) && d->state == SCR_GEN_SUSPENDED) {
    static const char sc_m[] =
        "yield* into a started generator with a typed next channel is not supported (it would "
        "deliver undefined into a typed yield)";
    return scr_gen_delegate_fence(sc_m, sizeof sc_m - 1);
  }
  scr_gen_slot_reset(&d->in);
  scr_gen_resume(d);
  return scr_gen_delegate_done(d, flags & 2);
}

bool scr_gen_delegate_next(ScrGen *d, unsigned flags, ScrDyn *(*to_dyn)(void *)) {
  scr_gen_slot_transfer(&d->in, &scr_gen_self()->in, flags & 3, to_dyn);
  scr_gen_resume(d);
  return scr_gen_delegate_done(d, flags & 4);
}

bool scr_gen_delegate_forward(ScrGen *d, unsigned modes, ScrDyn *(*next_dyn)(void *),
                              ScrDyn *(*ret_dyn)(void *), ScrDyn *(*done_dyn)(void *)) {
  ScrGen *g = scr_gen_self();
  ScrExcCell *cell = scr_exc_current_cell();
  if (cell->kind == SCR_EXC_NONE) {
    scr_gen_slot_transfer(&d->in, &g->in, modes & 3, next_dyn);
    scr_gen_resume(d);
    return scr_gen_delegate_done(d, modes & 64);
  }
  if (cell->kind != SCR_EXC_GENRET) {
    /* throw(e): the pending payload moves into the delegate. */
    scr_gen_resume_throw(d);
    return scr_gen_delegate_done(d, modes & 64);
  }
  /* return(v): the delegate's return runs first; only its completion
   * returns from this body. */
  unsigned ret_mode = (modes >> 2) & 3;
  scr_exc_clear();
  if (ret_mode == SCR_GEN_XFER_STRICT) scr_gen_slot_reset(&d->ret);
  else scr_gen_slot_transfer(&d->ret, &g->ret, ret_mode, ret_dyn);
  scr_gen_resume_return(d);
  if (scr_exc_pending()) return false;
  if (d->state == SCR_GEN_DONE) {
    if (d->out.kind == SCR_EXC_NONE ||
        scr_gen_slot_transfer(&g->ret, &d->out, (modes >> 4) & 3, done_dyn)) {
      scr_exc_current_cell()->kind = SCR_EXC_GENRET;
      scr_exc_cell_changed();
    }
    return true;
  }
  if (g->ret.kind != SCR_EXC_NONE) {
    /* The delegate's finally yielded; its later completion could not
     * carry the parked value. */
    static const char sc_m[] =
        "yield* forwarding return(value) to a generator with a different return type whose "
        "finally block yields is not supported";
    scr_gen_delegate_fence(sc_m, sizeof sc_m - 1);
  }
  return false;
}

/* yield: park the value in OUT and hop back to the resumer. Control
 * returns here at the next resume — possibly with an injected .throw
 * payload or the GENRET sentinel pending (the emitted check handles it). */
static void scr_gen_yield_switch(void) {
  ScrFiber *self = scr_current;
  scr_switch(&self->ctx, self->return_to, NULL);
}
void scr_gen_yield_f64(double v) {
  scr_gen_slot_f64(&scr_gen_self()->out, v);
  scr_gen_yield_switch();
}
void scr_gen_yield_bool(bool v) {
  scr_gen_slot_bool(&scr_gen_self()->out, v);
  scr_gen_yield_switch();
}
void scr_gen_yield_ref(void *v, void (*release)(void *)) {
  scr_gen_slot_ref(&scr_gen_self()->out, v, release);
  scr_gen_yield_switch();
}

/* Coroutine-body yields: park the value in the body's own generator; the
 * emitted suspension follows. */
void scr_coro_yield_f64(ScrFiber *self, double v) { scr_gen_slot_f64(&self->gen->out, v); }
void scr_coro_yield_bool(ScrFiber *self, bool v) { scr_gen_slot_bool(&self->gen->out, v); }
void scr_coro_yield_ref(ScrFiber *self, void *v, void (*release)(void *)) {
  scr_gen_slot_ref(&self->gen->out, v, release);
}

void scr_async_gen_return_awaits(void) { scr_gen_self()->return_awaited = false; }

void scr_async_gen_hop_done(void) {
  ScrGen *g = scr_gen_self();
  if (!g->is_async) {
    fputs("scriptc: internal error: async-generator hop on sync generator\n", stderr);
    abort();
  }
  g->success_hop_done = true;
}

bool scr_exc_genret_pending(void) {
  return scr_exc_current_cell()->kind == SCR_EXC_GENRET;
}

void scr_gen_ret_to_out(ScrGen *g) {
  scr_gen_slot_reset(&g->out);
  g->out = g->ret;
  g->ret.kind = SCR_EXC_NONE;
  g->ret.payload = NULL;
  g->ret.release_fn = NULL;
}

/* Back from the body (a yield, a finish, or an async generator's await):
 * settle the generator's state, moving a finished body's exception to the
 * resumer and tearing the finished fiber down. `release` drops the hop's
 * own reference (see scr_gen_switch_in); `sync` marks a body known to be a
 * synchronous generator. */
__attribute__((always_inline)) static inline void scr_gen_switched_back(ScrGen *g, ScrFiber *f,
                                                                  bool release, bool sync) {
  if (__builtin_expect(f->done, 0)) {
    g->state = SCR_GEN_DONE;
    if (f->exc.kind != SCR_EXC_NONE) {
      if (!sync && g->is_async) {
        /* Async-generator failures reject the active request; they never
         * throw synchronously from next/return/throw. */
        scr_gen_exc_move(&g->async_error, &f->exc);
      } else {
        /* The sync body's exception escapes at the resume site. */
        ScrExcCell *mine = scr_exc_current_cell();
        scr_gen_exc_move(mine, &f->exc);
      }
    }
    scr_fiber_destroy(f);
    g->fiber = NULL;
    scr_fibers_live--;
  } else {
    /* An async generator can return to its resumer because it yielded OR
     * because await parked it. OUT distinguishes the two. */
    g->state = !sync && g->is_async && !scr_gen_out_has(g)
        ? SCR_GEN_AWAITING
        : SCR_GEN_SUSPENDED;
  }
  if (release) scr_gen_release(g);
}

/* Out of line, so the hop that synchronous generators share stays as it
 * was: an async generator's step begins from its resumer's context and
 * hands the prefix's context back at its first suspension. */
static __attribute__((noinline)) void scr_async_gen_step_begin(ScrFiber *f) { scr_als_step_begin(f); }
static __attribute__((noinline)) void scr_async_gen_step_end(ScrFiber *f) { scr_als_prefix_end(f); }

#ifndef __wasi__
/* The stackless form of the hop: the coroutine frame runs on this stack
 * until its next yield, an async generator's await, or its final
 * suspension returns here. `retain` holds the generator across the hop; a
 * resumer whose own reference provably outlives the hop passes false.
 * `sync` marks a body known to be a synchronous generator. */
__attribute__((always_inline)) static inline void scr_gen_coro_hop(ScrGen *g, bool retain,
                                                                  bool sync) {
  ScrFiber *f = g->fiber;
  if (retain) scr_gen_retain(g);
  /* A synchronous generator has no AsyncLocalStorage context of its own:
   * its step runs in the resumer's slot, as Node runs it in the execution
   * that called next(). An async generator's step runs in its own slot,
   * which a new step (not the continuation after an await) starts from the
   * resumer's context (scr_als_step_begin). */
  if (g->is_async && g->state != SCR_GEN_AWAITING) scr_async_gen_step_begin(f);
  g->state = SCR_GEN_RUNNING;
  f->resumer = scr_current;
  ScrAlsCtx **resumer_slot = scr_als_active;
  scr_current = f;
  scr_exc_swap_cell(&f->exc);
  if (g->is_async) scr_als_active = &f->als;
  if (f->coro == NULL) f->entry(f, f->argpack);
  else scr_coro_resume(f->coro);
  /* A running generator cannot be resumed again, so neither its fiber nor
   * the parked resumer changed while the body ran. */
  f = g->fiber;
  ScrFiber *me = f->resumer;
  scr_current = me;
  scr_exc_swap_cell(me != NULL ? &me->exc : NULL);
  scr_als_active = resumer_slot;
  if (g->is_async) scr_async_gen_step_end(f);
  scr_gen_switched_back(g, f, retain, sync);
}

/* An async generator's step can resume the next one down a chain of them
 * before it suspends, all on one stack, through runtime frames that check
 * no guard: a step that would start below the stack guard throws the
 * RangeError compiled code throws there, which rejects its request. */
static __attribute__((noinline)) void scr_async_gen_coro_in(ScrGen *g) {
  uintptr_t guard = scr_stack_guard;
  if (guard != 0 && (uintptr_t)__builtin_frame_address(0) < guard) {
    /* scr_stack_overflow's error, thrown here: this unit links without
     * scr_context.c in the runtime's own tests. */
    static const char text[] = "Maximum call stack size exceeded";
    scr_throw_error_msg(SCR_ERR_RANGE, text, sizeof text - 1);
    return;
  }
  scr_gen_coro_hop(g, true, false);
}

static void scr_gen_coro_in(ScrGen *g) {
  if (g->is_async) scr_async_gen_coro_in(g);
  else scr_gen_coro_hop(g, true, true);
}
#endif

/* The consumer→fiber hop shared by every resume mode: switches in, and on
 * the way back moves a pending body exception into the RESUMER's cell
 * (synchronous propagation — the await-rethrow analog) and tears down a
 * finished fiber. The gen is retained across the hop so a body that
 * releases the consumer's last reference cannot free it mid-run. */
static void scr_gen_switch_in(ScrGen *g) {
  ScrFiber *f = g->fiber;
#ifndef __wasi__
  if (f->stackless) {
    scr_gen_coro_in(g);
    return;
  }
#endif
  scr_gen_retain(g);
  /* Each step starts from the resumer's context; an async generator's
   * continuation after an await keeps its own. */
  if (!g->is_async || g->state != SCR_GEN_AWAITING) scr_als_step_begin(f);
  g->state = SCR_GEN_RUNNING;
#ifdef _WIN32
  ScrCtx here = scr_win_self();
#elif defined(__wasi__)
  ScrCtx here = 0;
#else
  ScrCtx here;
#endif
  f->return_to = &here;
  ScrFiber *me = scr_current;
  ScrAlsCtx **resumer_slot = scr_als_active;
#ifdef __wasi__
  scr_current = f;
  scr_exc_swap_cell(&f->exc);
  scr_als_active = &f->als;
  if (f->coro == NULL) f->entry(f, f->argpack);
  else scr_wasi_coro_resume(f->coro);
  scr_current = me;
  scr_exc_swap_cell(me != NULL ? &me->exc : NULL);
  scr_als_active = resumer_slot;
#else
  scr_switch(&here, &f->ctx, f);
  /* Back on the consumer: restore identity, the consumer's cell and its
   * AsyncLocalStorage slot (the yield/finish switch targeted NULL — main's
   * cell and slot). */
  scr_current = me;
  scr_exc_swap_cell(me != NULL ? &me->exc : NULL);
  scr_als_active = resumer_slot;
#endif
  scr_als_prefix_end(f);
  scr_gen_switched_back(g, f, true, false);
}

void scr_gen_resume(ScrGen *g) {
  switch (g->state) {
  case SCR_GEN_RUNNING: {
    static const char sc_m[] = "Generator is already running";
    scr_throw_error_msg(SCR_ERR_TYPE, sc_m, sizeof sc_m - 1);
    return;
  }
  case SCR_GEN_DONE:
    /* next() on a done generator: { value: undefined, done: true } —
     * OUT is NONE (the completing resume took it). */
    return;
  default:
    scr_gen_switch_in(g);
  }
}

void scr_gen_set_unstarted_return(ScrGen *g, void (*hook)(void *)) { g->unstarted_return = hook; }

void scr_gen_set_tag(ScrGen *g, const char *tag) { g->tag = tag; }

void scr_gen_copy_tag(ScrGen *g, const ScrGen *from) { g->tag = from->tag; }

const char *scr_gen_tag(const ScrGen *g) {
  return g->tag ? g->tag : g->is_async ? "AsyncGenerator" : "Generator";
}

void scr_gen_close(ScrGen *g) {
  scr_gen_slot_reset(&g->ret);
  scr_gen_resume_return(g);
  scr_gen_slot_reset(&g->out);
}

/* The compiler's own drives (for-of, spread, destructuring, valueless
 * yield* steps). Every emitted caller passes a generator it owns or lends
 * from a binding nothing can rebind during the step, so the body cannot
 * drop the last reference and a stackless hop needs no retain of its own. */
bool scr_gen_step(ScrGen *g) {
  if (g->in.kind != SCR_EXC_NONE) scr_gen_slot_reset(&g->in);
#ifndef __wasi__
  if ((g->state == SCR_GEN_SUSPENDED || g->state == SCR_GEN_UNSTARTED) && g->fiber->stackless &&
      !g->is_async) {
    scr_gen_coro_hop(g, false, true);
    return g->state == SCR_GEN_DONE;
  }
#endif
  scr_gen_resume(g);
  return g->state == SCR_GEN_DONE;
}

void scr_gen_resume_return(ScrGen *g) {
  switch (g->state) {
  case SCR_GEN_RUNNING: {
    static const char sc_m[] = "Generator is already running";
    scr_throw_error_msg(SCR_ERR_TYPE, sc_m, sizeof sc_m - 1);
    return;
  }
  case SCR_GEN_DONE:
    scr_gen_ret_to_out(g);
    return;
  case SCR_GEN_UNSTARTED:
    /* The body never runs: tear the fiber down cleanly (drop the packed
     * arguments) and complete with the parked value. The generator is
     * done before the hook runs, so a resume from inside it answers done;
     * an exception the hook raises stays pending for the caller. */
    g->state = SCR_GEN_DONE;
    if (g->unstarted_return != NULL) g->unstarted_return(g->fiber->argpack);
    if (g->drop_args != NULL) g->drop_args(g->fiber->argpack);
    else free(g->fiber->argpack);
    scr_fiber_destroy(g->fiber);
    g->fiber = NULL;
    scr_fibers_live--;
    scr_gen_ret_to_out(g);
    return;
  default:
    /* Suspended at a yield: inject the sentinel (an earlier .return whose
     * unwind a finally-yield parked leaves it already set) and resume. */
    if (g->fiber->exc.kind == SCR_EXC_NONE) g->fiber->exc.kind = SCR_EXC_GENRET;
    scr_gen_switch_in(g);
  }
}

void scr_gen_resume_throw(ScrGen *g) {
  switch (g->state) {
  case SCR_GEN_RUNNING: {
    /* Replace the parked payload with Node's reentrancy TypeError. */
    static const char sc_m[] = "Generator is already running";
    scr_throw_error_msg(SCR_ERR_TYPE, sc_m, sizeof sc_m - 1);
    return;
  }
  case SCR_GEN_DONE:
    /* .throw on a done generator: it stays done; the payload stays
     * pending in the caller — the call site's check rethrows it. */
    return;
  case SCR_GEN_UNSTARTED:
    /* The body never runs; the generator becomes done and the payload
     * stays pending in the caller (probed Node behavior). */
    if (g->drop_args != NULL) g->drop_args(g->fiber->argpack);
    else free(g->fiber->argpack);
    scr_fiber_destroy(g->fiber);
    g->fiber = NULL;
    scr_fibers_live--;
    g->state = SCR_GEN_DONE;
    return;
  default: {
    /* Move the caller's pending payload into the fiber's cell (an
     * earlier sentinel parked by a finally-yield is replaced — the
     * injected throw wins, like a throw inside that finally). */
    ScrExcCell *mine = scr_exc_current_cell();
    ScrExcCell *dst = &g->fiber->exc;
    dst->kind = mine->kind;
    dst->f64 = mine->f64;
    dst->b = mine->b;
    dst->payload = mine->payload;
    dst->retain_fn = mine->retain_fn;
    dst->release_fn = mine->release_fn;
    dst->trace_fn = mine->trace_fn;
    mine->kind = SCR_EXC_NONE;
    mine->payload = NULL;
    mine->trace_fn = NULL;
    scr_exc_cell_changed();
    scr_gen_switch_in(g);
  }
  }
}

/* ── async generators ────────────────────────────────────────────────
 * The body is the same suspended generator fiber, now allowed to await.
 * Each resume request owns a promise and a retained generator. The first
 * idle request starts synchronously; successful yield/return settlement
 * takes AsyncGeneratorYield's Await hop (the emitter marks a yielded
 * promise whose await already supplied it), while thrown completions reject
 * immediately. Requests queued behind an active one begin in that
 * settlement continuation, preserving Node's ordering. */

static void scr_async_gen_start_queued(ScrGen *g);

/* Runs fn(g) with `ctx` (borrowed) as the active AsyncLocalStorage
 * context. A settlement job runs from the loop: a request queued behind
 * another starts in the context of the step before it (Node drains the
 * queue in the generator's own execution), and a deferred return() in its
 * call's. */
static __attribute__((noinline)) void scr_async_gen_in_context(ScrGen *g, ScrAlsCtx *ctx,
                                                               void (*fn)(ScrGen *)) {
  ScrAlsCtx **slot = SCR_ALS_SLOT();
  ScrAlsCtx *prev = *slot;
  *slot = scr_als_ctx_retain(ctx);
  fn(g);
  scr_als_restore(prev);
}

/* Starts the queued requests in the context of the step before them. */
static __attribute__((noinline)) void scr_async_gen_start_queued_in_own(ScrGen *g) {
  scr_async_gen_in_context(g, g->fiber != NULL ? g->fiber->als : NULL, scr_async_gen_start_queued);
}

static void scr_async_gen_schedule_settle(ScrGen *g) {
  if (g->settle_queued) return;
  ScrFiber *job = scr_mem_calloc(sizeof *job);
  if (!job) scr_oom();
  job->gen_job = scr_gen_retain(g);
  g->settle_queued = true;
  scr_ready_push(job);
}

static void scr_async_gen_finish_active(ScrGen *g, bool rejected) {
  ScrPromise *p = g->active_request;
  if (p == NULL) {
    fputs("scriptc: internal error: async generator settled without a request\n", stderr);
    abort();
  }
  g->active_request = NULL;
  if (rejected) {
    scr_promise_reject_from_cell(p, &g->async_error);
    scr_promise_settle_wake(p);
  } else {
    g->settle_async(g, p);
  }
  scr_promise_release(p);
  /* Every queued request retains its generator until settlement. */
  scr_gen_release(g);
}

static void scr_async_gen_capture_caller_error(ScrGen *g) {
  ScrExcCell *cell = scr_exc_current_cell();
  if (cell->kind != SCR_EXC_NONE) scr_gen_exc_move(&g->async_error, cell);
}

/* Whether the body's latest stop settles its request without a further
 * turn: a yield whose await already supplied the value, or a completion
 * after a return() request's await. */
static bool scr_async_gen_settles_now(ScrGen *g) {
  if (g->success_hop_done) {
    g->success_hop_done = false;
    return true;
  }
  if (g->return_awaited && g->state == SCR_GEN_DONE) {
    g->return_awaited = false;
    return true;
  }
  return false;
}

static __attribute__((noinline)) void scr_async_gen_capture_return_ctx(ScrGen *g) {
  scr_als_ctx_release(g->return_ctx);
  g->return_ctx = scr_als_ctx_retain(*SCR_ALS_SLOT());
}

static void scr_async_gen_run_active(ScrGen *g, ScrAsyncGenRequest *req) {
  const bool was_done = g->state == SCR_GEN_DONE;
  if (req->mode == SCR_AG_NEXT) {
    scr_gen_slot_reset(&g->in);
    g->in = req->arg;
    memset(&req->arg, 0, sizeof req->arg);
    scr_gen_resume(g);
  } else if (req->mode == SCR_AG_RETURN) {
    scr_gen_slot_reset(&g->ret);
    g->ret = req->arg;
    memset(&req->arg, 0, sizeof req->arg);
    if (g->state == SCR_GEN_SUSPENDED) {
      /* At a yield, AsyncGeneratorYield awaits the return value before
       * the body resumes, so finally blocks run one turn later. */
      g->return_queued = true;
      scr_async_gen_capture_return_ctx(g);
      scr_async_gen_schedule_settle(g);
      return;
    }
    scr_gen_resume_return(g);
  } else {
    scr_gen_exc_move(scr_exc_current_cell(), &req->thrown);
    scr_gen_resume_throw(g);
  }
  scr_async_gen_capture_caller_error(g);

  if (g->async_error.kind != SCR_EXC_NONE) {
    scr_async_gen_finish_active(g, true);
    return;
  }
  if (g->state == SCR_GEN_AWAITING) return;

  /* next() on an already-completed generator produces its undefined done
   * result immediately. A yield and return(value) on an unstarted or
   * completed generator pass through an Await step; a body that falls off
   * its end, or whose `return x` already awaited x, marks its completion
   * as settled. */
  if (was_done && req->mode == SCR_AG_NEXT) {
    scr_async_gen_finish_active(g, false);
  } else if (scr_async_gen_settles_now(g)) {
    scr_async_gen_finish_active(g, false);
  } else {
    scr_async_gen_schedule_settle(g);
  }
}

static void scr_async_gen_resume_returning(ScrGen *g);

/* The deferred return() resumes in its call's context. */
static __attribute__((noinline)) void scr_async_gen_resume_returning_in_context(ScrGen *g) {
  ScrAlsCtx *ctx = g->return_ctx;
  g->return_ctx = NULL;
  scr_async_gen_in_context(g, ctx, scr_async_gen_resume_returning);
  scr_als_ctx_release(ctx);
}

/* The return() request's await has taken its turn: resume the body with
 * the return completion. */
static void scr_async_gen_resume_returning(ScrGen *g) {
  g->return_queued = false;
  g->return_awaited = true;
  scr_gen_resume_return(g);
  scr_async_gen_capture_caller_error(g);
  if (g->async_error.kind != SCR_EXC_NONE) {
    scr_async_gen_finish_active(g, true);
  } else if (g->state == SCR_GEN_AWAITING) {
    return;
  } else if (scr_async_gen_settles_now(g)) {
    scr_async_gen_finish_active(g, false);
  } else {
    scr_async_gen_schedule_settle(g);
    return;
  }
  scr_async_gen_start_queued(g);
}

static void scr_async_gen_start_queued(ScrGen *g) {
  /* Keep the object alive while an immediately-settled request releases
   * its own retain and the loop inspects the next queue node. */
  scr_gen_retain(g);
  while (g->active_request == NULL && g->requests_head != NULL) {
    ScrAsyncGenRequest *req = g->requests_head;
    g->requests_head = req->next;
    if (g->requests_head == NULL) g->requests_tail = NULL;
    g->active_request = req->promise; /* request ownership transfers */
    scr_async_gen_run_active(g, req);
    scr_gen_slot_reset(&req->arg);
    scr_gen_exc_reset(&req->thrown);
    free(req);
    /* Awaiting or deferred successful settlement keeps this request
     * active. Immediate done/error settlement cleared it and can consume
     * the next queued request in this same turn. */
    if (g->active_request != NULL) break;
  }
  scr_gen_release(g);
}

static ScrPromise *scr_async_gen_enqueue(ScrGen *g, int mode,
                                         ScrGenSlot *arg,
                                         ScrExcCell *thrown) {
  if (!g->is_async || g->settle_async == NULL) {
    fputs("scriptc: internal error: async resume of a sync generator\n", stderr);
    abort();
  }
  ScrAsyncGenRequest *req = calloc(1, sizeof *req);
  if (!req) scr_oom();
  req->mode = mode;
  if (arg != NULL) {
    req->arg = *arg;
    memset(arg, 0, sizeof *arg);
  }
  if (thrown != NULL) scr_gen_exc_move(&req->thrown, thrown);
  req->promise = scr_promise_new();
  /* The request owns the original promise reference and one generator
   * reference; the caller receives a second promise reference. */
  ScrPromise *result = scr_promise_retain(req->promise);
  scr_gen_retain(g);
  if (g->requests_tail != NULL) g->requests_tail->next = req;
  else g->requests_head = req;
  g->requests_tail = req;
  if (g->active_request == NULL && !g->settle_queued) {
    scr_async_gen_start_queued(g);
  }
  return result;
}

ScrPromise *scr_async_gen_next_none(ScrGen *g) {
  ScrGenSlot arg = {0};
  return scr_async_gen_enqueue(g, SCR_AG_NEXT, &arg, NULL);
}

ScrPromise *scr_async_gen_next_f64(ScrGen *g, double value) {
  ScrGenSlot arg = {0};
  scr_gen_slot_f64(&arg, value);
  return scr_async_gen_enqueue(g, SCR_AG_NEXT, &arg, NULL);
}

ScrPromise *scr_async_gen_next_bool(ScrGen *g, bool value) {
  ScrGenSlot arg = {0};
  scr_gen_slot_bool(&arg, value);
  return scr_async_gen_enqueue(g, SCR_AG_NEXT, &arg, NULL);
}

ScrPromise *scr_async_gen_next_ref(ScrGen *g, void *value,
                                   void (*release)(void *)) {
  ScrGenSlot arg = {0};
  scr_gen_slot_ref(&arg, value, release);
  return scr_async_gen_enqueue(g, SCR_AG_NEXT, &arg, NULL);
}

ScrPromise *scr_async_gen_return_none(ScrGen *g) {
  ScrGenSlot arg = {0};
  return scr_async_gen_enqueue(g, SCR_AG_RETURN, &arg, NULL);
}

ScrPromise *scr_async_gen_return_f64(ScrGen *g, double value) {
  ScrGenSlot arg = {0};
  scr_gen_slot_f64(&arg, value);
  return scr_async_gen_enqueue(g, SCR_AG_RETURN, &arg, NULL);
}

ScrPromise *scr_async_gen_return_bool(ScrGen *g, bool value) {
  ScrGenSlot arg = {0};
  scr_gen_slot_bool(&arg, value);
  return scr_async_gen_enqueue(g, SCR_AG_RETURN, &arg, NULL);
}

ScrPromise *scr_async_gen_return_ref(ScrGen *g, void *value,
                                     void (*release)(void *)) {
  ScrGenSlot arg = {0};
  scr_gen_slot_ref(&arg, value, release);
  return scr_async_gen_enqueue(g, SCR_AG_RETURN, &arg, NULL);
}

ScrPromise *scr_async_gen_throw(ScrGen *g) {
  ScrExcCell thrown = {0};
  scr_gen_exc_move(&thrown, scr_exc_current_cell());
  return scr_async_gen_enqueue(g, SCR_AG_THROW, NULL, &thrown);
}

static void scr_async_gen_job(ScrGen *g) {
  g->settle_queued = false;
  if (g->active_request == NULL || g->async_error.kind != SCR_EXC_NONE) {
    fputs("scriptc: internal error: invalid async generator settlement job\n", stderr);
    abort();
  }
  if (g->return_queued) {
    scr_gen_retain(g);
    scr_async_gen_resume_returning_in_context(g);
    scr_gen_release(g);
    return;
  }
  scr_async_gen_finish_active(g, false);
  scr_async_gen_start_queued_in_own(g);
}

static void scr_async_gen_resume_ready(ScrGen *g) {
  if (!g->is_async || g->active_request == NULL) {
    fputs("scriptc: internal error: async generator resumed without a request\n", stderr);
    abort();
  }
  /* The active request normally owns the generator. Keep an independent
   * reference across settlement, which releases that request ownership. */
  scr_gen_retain(g);
  scr_gen_switch_in(g);
  if (g->async_error.kind != SCR_EXC_NONE) {
    scr_async_gen_finish_active(g, true);
    scr_async_gen_start_queued_in_own(g);
  } else if (g->state != SCR_GEN_AWAITING) {
    if (scr_async_gen_settles_now(g)) {
      scr_async_gen_finish_active(g, false);
      scr_async_gen_start_queued_in_own(g);
    } else {
      scr_async_gen_schedule_settle(g);
    }
  }
  scr_gen_release(g);
}

#ifdef SCR_WORKERS
static void scr_context_ready_discard(void) {
  while (scr_ready_len) {
    ScrFiber *fiber = scr_ready[scr_ready_head++];
    scr_ready_len--;
    if (fiber->micro_cb) {
      scr_closure_release(fiber->micro_cb);
      scr_mem_free(fiber);
    } else if (fiber->gen_job) {
      ScrGen *generator = fiber->gen_job;
      generator->settle_queued = false;
      scr_gen_release(generator);
      scr_mem_free(fiber);
    } else if (fiber->cb_job) {
      scr_promise_release(fiber->cb.dst);
      if (fiber->cb.all) scr_promise_all_state_release(fiber->cb.all);
      scr_promise_release(fiber->cb_src);
      scr_mem_free(fiber);
    }
    /* Real fibers belong to the context registry, including queued ones. */
  }
  scr_ready_head = 0;
}

/* Thread exit reclaims suspended native stacks by resuming only their
 * compiler-owned unwind paths. No JavaScript catch/finally or queued user
 * callback runs after the stop flag is installed. */
void scr_loop_context_shutdown(void) {
  if (scr_current) scr_trap("scriptc: context shutdown on an active fiber\n");
  scr_context_stop(scr_exit_code_hint_get());
  scr_timers_teardown();
  scr_context_ready_discard();
  while (scr_context_fibers) {
    ScrFiber *fiber = scr_context_fibers;
    if (fiber->gen) {
      ScrGen *generator = scr_gen_retain(fiber->gen);
      if (generator->state == SCR_GEN_UNSTARTED) {
        if (generator->drop_args) generator->drop_args(fiber->argpack);
        else free(fiber->argpack);
        scr_fiber_destroy(fiber);
        generator->fiber = NULL;
        generator->state = SCR_GEN_DONE;
        scr_fibers_live--;
      } else {
        scr_gen_switch_in(generator);
        if (generator->fiber) scr_trap("scriptc: generator did not unwind during shutdown\n");
      }
      while (generator->requests_head) {
        ScrAsyncGenRequest *request = generator->requests_head;
        generator->requests_head = request->next;
        scr_gen_slot_reset(&request->arg);
        scr_gen_exc_reset(&request->thrown);
        scr_promise_release(request->promise);
        free(request);
        scr_gen_release(generator);
      }
      generator->requests_tail = NULL;
      if (generator->active_request) {
        scr_promise_release(generator->active_request);
        generator->active_request = NULL;
        scr_gen_release(generator);
      }
      if (generator->context_abandoned) {
        generator->context_abandoned = false;
        scr_gen_release(generator);
      }
      scr_gen_release(generator);
    } else {
      scr_resume_fiber(fiber);
      if (scr_context_fibers == fiber) scr_trap("scriptc: async function did not unwind during shutdown\n");
    }
    scr_context_ready_discard();
  }
  scr_discard_unhandled_rejections();
  free(scr_ready); scr_ready = NULL; scr_ready_cap = 0;
  free(scr_timers); scr_timers = NULL; scr_timers_cap = 0;
  free(scr_immediates); scr_immediates = NULL; scr_immediates_cap = 0;
  free(scr_maybe_unhandled); scr_maybe_unhandled = NULL; scr_unhandled_cap = 0;
  scr_als_ctx_release(scr_als_main_slot); scr_als_main_slot = NULL;
  scr_fibers_abandoned = 0;
  scr_note_abandoned_fibers(0);
}
#endif
