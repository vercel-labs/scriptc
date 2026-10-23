/* Node islands: Node.js loaded into the process on first use (scope-B
 * milestone NI-1). This translation unit links only into programs whose
 * IR calls into Node (the `nodeIsland` runtime feature), with the
 * SCR_NODE_ISLANDS build of scr_async.c; every other program links
 * neither, byte for byte. libnode itself is never linked: the first call
 * dlopens the bridge library of a libnode pack (scr_node_bridge.h), which
 * links libnode, so a run that never calls into Node never maps it.
 *
 * Locating Node. The pack directory is SCRIPTC_LIBNODE when set, else the
 * path recorded at build time; a recorded path that starts with `$ORIGIN/`
 * resolves against the directory of the running executable (the `beside`
 * packaging, and the hook for shipping Node with the program). No search
 * path is used. The bridge must speak SCR_NODE_BRIDGE_ABI and link the
 * Node version recorded at build time; anything else is a fatal error at
 * first use, never a silent use of another Node.
 *
 * Calls. A call serializes its arguments as JSON, enters JavaScript through
 * the bridge (a callback scope, so ticks and microtasks drain when it
 * returns) and parses the outcome: the result's JSON copy, or the copied
 * error (see scr_node_island_host.cjs). An asynchronous call registers its
 * promise first, because the bridge may settle it before returning.
 *
 * One loop (scope-B NI-3). Right after Node starts, scr_loop_host moves the
 * runtime's pending ticks, promise jobs, timers and immediates onto Node's
 * queues and from then on schedules them there, and the bridge watches the
 * runtime's I/O on Node's libuv loop: there is one loop and one set of
 * queues, so the jobs of both sides interleave as in Node. Calls into
 * JavaScript do not drain queues themselves; the runtime's checkpoints do
 * (the bridge's `checkpoint`, and Node's own after every callback it
 * dispatches).
 *
 * Process state is shared, not mirrored: island listeners for signals and
 * 'exit' join the runtime's registries (scr_events.c) at their position,
 * so the runtime keeps owning every signal disposition; the exit code
 * island code leaves in process.exitCode becomes the program's when the
 * loop ends; Node's process.exit runs the runtime's exit sequence.
 *
 * Node's stack. V8 fixes an isolate's stack limit where it is created, and
 * calls into Node can come from any async fiber (512 KB stacks without a
 * guard page) or from the main stack. Every entry into Node from outside
 * it runs on one dedicated stack of NI_STACK bytes with a guard page,
 * reached by a context switch; the runtime's own stack guard follows it
 * there. Node's loop runs there too once it hosts the runtime's queues, so
 * a runtime job it dispatches may resume an async fiber that calls into
 * Node again from the fiber's stack: the bridge sets V8's limit for the
 * stack each entry comes from (ni_stack_limit). */
#define _XOPEN_SOURCE 700
#define _DARWIN_C_SOURCE 1
#include "scr_runtime.h"
#include "scr_events.h"
#include "scr_node_bridge.h"
#include "scr_node_island.h"

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#if !defined(_WIN32) && !defined(__wasi__)
#include "scr_node_island_host.h"

#include <dlfcn.h>
#include <sys/mman.h>
#include <ucontext.h>
#include <pthread.h>

#ifdef __APPLE__
#define NI_BRIDGE_FILE "libscr_node_bridge.dylib"
#else
#define NI_BRIDGE_FILE "libscr_node_bridge.so"
#endif

typedef struct {
  uint32_t id;
  ScrPromise *promise; /* owned */
} NiPending;

#if defined(__has_feature)
#if __has_feature(address_sanitizer)
#define NI_ASAN 1
void __sanitizer_start_switch_fiber(void **fake_stack_save, const void *bottom, size_t size);
void __sanitizer_finish_switch_fiber(void *fake_stack_save, const void **bottom_old,
                                     size_t *size_old);
void __lsan_register_root_region(const void *p, size_t size) __attribute__((weak));
#endif
#endif

#define NI_STACK ((size_t)64 * 1024 * 1024)
#define NI_GUARD ((size_t)64 * 1024)

static const char *ni_libnode = NULL;      /* recorded pack directory */
static const char *ni_node_version = NULL; /* recorded Node version */
static const ScrNodeBridge *ni_bridge = NULL;
static char ni_dir[4096];
static uint32_t ni_next_id = 1;
static NiPending *ni_pending = NULL;
static size_t ni_npending = 0, ni_pending_cap = 0;

void scr_node_island_install(const char *libnode, const char *node_version) {
  ni_libnode = libnode;
  ni_node_version = node_version;
}

SCR_COLD static void ni_oom(void) { scr_trap("scriptc: out of memory\n"); }

SCR_COLD static void ni_fatal(const char *message) {
  fflush(stdout);
  fputs(message, stderr);
  fflush(stderr);
  _Exit(1);
}

/* The pack directory: SCRIPTC_LIBNODE, else the recorded path with a
 * leading `$ORIGIN/` resolved against the executable's own directory. */
static const char *ni_pack_dir(void) {
  const char *override = getenv("SCRIPTC_LIBNODE");
  const char *dir = override != NULL && override[0] != '\0' ? override : ni_libnode;
  if (dir == NULL || dir[0] == '\0')
    ni_fatal("scriptc: this program calls into Node.js (@scriptc/node), but no libnode pack was "
             "recorded at build time; set SCRIPTC_LIBNODE to a pack directory\n");
  static const char origin[] = "$ORIGIN/";
  if (dir != override && strncmp(dir, origin, sizeof origin - 1) == 0) {
    ScrStr *self = scr_process_exec_path();
    size_t len = self->len;
    while (len > 0 && self->data[len - 1] != '/') len--;
    snprintf(ni_dir, sizeof ni_dir, "%.*s%s", (int)len, self->data, dir + sizeof origin - 1);
    scr_str_release(self);
  } else {
    snprintf(ni_dir, sizeof ni_dir, "%s", dir);
  }
  return ni_dir;
}

/* ── outcomes ─────────────────────────────────────────────────────────── */

/* The result of an "R" outcome: its JSON copy, or undefined. +1, or NULL
 * with a parse error pending. */
static ScrDyn *ni_result(const char *json, size_t len) {
  if (len == 0) return scr_dyn_undefined();
  ScrStr *text = scr_str_new(json, len);
  ScrDyn *value = scr_json_parse(text);
  scr_str_release(text);
  return value;
}

/* Leaves the copied error of a "T" outcome pending. */
static void ni_throw(const char *json, size_t len) {
  ScrStr *text = scr_str_new(json, len);
  ScrDyn *body = scr_json_parse(text);
  scr_str_release(text);
  if (body == NULL) return; /* the parse error is pending */
  ScrDyn *error = scr_dyn_obj_get(body, "error", 5);
  if (error != NULL && error->kind == SCR_DYN_OBJ) {
    ScrDyn *kind = scr_dyn_obj_get(error, "kind", 4);
    ScrDyn *message = scr_dyn_obj_get(error, "message", 7);
    ScrDyn *code = scr_dyn_obj_get(error, "code", 4);
    ScrStr *empty = scr_str_new("", 0);
    scr_throw_node_coded(kind != NULL && kind->kind == SCR_DYN_NUM ? kind->v.num : 0,
                         code != NULL && code->kind == SCR_DYN_STR ? code->v.str : empty,
                         message != NULL && message->kind == SCR_DYN_STR ? message->v.str : empty);
    scr_str_release(empty);
    scr_dyn_release(body);
    return;
  }
  ScrDyn *value = scr_dyn_obj_get(body, "value", 5);
  scr_dyn_throw(scr_dyn_retain(value != NULL ? value : scr_dyn_undefined()));
  scr_dyn_release(body);
}

/* An outcome as a value (+1), or NULL with its error pending. */
static ScrDyn *ni_outcome(const char *outcome, size_t len) {
  if (len > 0 && outcome[0] == 'R') return ni_result(outcome + 1, len - 1);
  if (len > 0 && outcome[0] == 'T') ni_throw(outcome + 1, len - 1);
  else ni_fatal("scriptc: malformed outcome from the libnode bridge\n");
  return NULL;
}

/* ── the host side of the bridge ──────────────────────────────────────── */

static void ni_settle(uint32_t id, const char *outcome, size_t len) {
  for (size_t i = 0; i < ni_npending; i++) {
    if (ni_pending[i].id != id) continue;
    ScrPromise *p = ni_pending[i].promise;
    ni_pending[i] = ni_pending[--ni_npending];
    ScrDyn *value = ni_outcome(outcome, len);
    if (value != NULL)
      scr_promise_fulfill_ref(p, value, scr_dyn_retain_v, scr_dyn_release_v, scr_dyn_trace_v);
    scr_promise_reject_pending(p); /* no-op unless an error is pending */
    scr_promise_release(p);
    return;
  }
}

static void ni_exit(int code) {
  scr_process_exit((double)code);
  /* A code process.exit refuses: exit 1 rather than continue half-way. */
  ni_fatal("");
}

/* An island listener for a process event was added or removed. */
static void ni_listen(uint32_t event, const char *name, uint32_t listener, int add, int once) {
  (void)once; /* Node's once wrapper removes itself through removeListener */
  if (event == SCR_NODE_EVENT_SIGNAL) {
    if (add) {
      ScrStr *s = scr_str_new(name, strlen(name));
      scr_signal_on_island(s, listener);
      scr_str_release(s);
    } else {
      scr_signal_off_island(listener);
    }
  } else if (event == SCR_NODE_EVENT_EXIT) {
    if (add) scr_process_on_exit_island(listener);
    else scr_process_off_exit_island(listener);
  }
}

/* The main thread's stack, for V8's stack limit (ni_stack_limit). */
static uintptr_t ni_main_lo = 0, ni_main_hi = 0;

static void ni_main_stack(void) {
#if defined(__APPLE__)
  pthread_t self = pthread_self();
  ni_main_hi = (uintptr_t)pthread_get_stackaddr_np(self);
  ni_main_lo = ni_main_hi - pthread_get_stacksize_np(self);
#elif defined(__linux__)
  pthread_attr_t attr;
  if (pthread_getattr_np(pthread_self(), &attr) == 0) {
    void *addr = NULL;
    size_t size = 0;
    if (pthread_attr_getstack(&attr, &addr, &size) == 0) {
      ni_main_lo = (uintptr_t)addr;
      ni_main_hi = ni_main_lo + size;
    }
    pthread_attr_destroy(&attr);
  }
#endif
}

static void ni_on_node_stack(void (*job)(void *), void *arg);
static const ScrNodeBridgeHost ni_host;

/* ── Node's stack ─────────────────────────────────────────────────────── */

static char *ni_stack = NULL; /* the mapping; usable above NI_GUARD */
static ucontext_t ni_node_ctx, ni_caller_ctx;
static bool ni_on_stack = false;
static void (*ni_job)(void *) = NULL;
static void *ni_job_arg = NULL;
#ifdef NI_ASAN
static void *ni_node_fake = NULL;
static const void *ni_caller_bottom = NULL;
static size_t ni_caller_size = 0;
#endif

static void ni_trampoline(void) {
  for (;;) {
#ifdef NI_ASAN
    __sanitizer_finish_switch_fiber(ni_node_fake, &ni_caller_bottom, &ni_caller_size);
#endif
    ni_job(ni_job_arg);
#ifdef NI_ASAN
    __sanitizer_start_switch_fiber(&ni_node_fake, ni_caller_bottom, ni_caller_size);
#endif
    swapcontext(&ni_node_ctx, &ni_caller_ctx);
  }
}

/* Whether `sp` lies on Node's stack. */
static bool ni_stack_has(uintptr_t sp) {
  return ni_stack != NULL && sp > (uintptr_t)ni_stack && sp <= (uintptr_t)ni_stack + NI_STACK;
}

/* The lowest address of Node's stack its frames use while runtime code
 * they called runs (a host callback below), 0 outside them. Runtime code
 * may resume an async fiber there, and the fiber may call into Node again:
 * that entry runs on Node's stack below this mark, so every frame of Node
 * stays on the one stack V8 scans (heap::base::Stack, bounded by
 * ni_stack_start), never on a fiber's stack beyond its bound. */
static uintptr_t ni_mark = 0;

/* Host callbacks run runtime code from Node's frames: each records the
 * mark for its duration. */
#define NI_MARK_BEGIN                                                    \
  uintptr_t ni_saved_mark = ni_mark;                                     \
  do {                                                                   \
    uintptr_t ni_here = (uintptr_t)__builtin_frame_address(0);           \
    if (ni_stack_has(ni_here)) ni_mark = ni_here;                        \
  } while (0)
#define NI_MARK_END (ni_mark = ni_saved_mark)

/* A nested entry: job(arg) on Node's stack below the mark, from a fiber. */
static void (*ni_nested_job)(void *) = NULL;
static void *ni_nested_arg = NULL;
static ucontext_t *ni_nested_return = NULL;

static void ni_nested_trampoline(void) {
#ifdef NI_ASAN
  const void *caller_bottom;
  size_t caller_size;
  __sanitizer_finish_switch_fiber(NULL, &caller_bottom, &caller_size);
#endif
  void (*job)(void *) = ni_nested_job;
  void *arg = ni_nested_arg;
  ucontext_t *back = ni_nested_return;
  job(arg);
#ifdef NI_ASAN
  /* This context ends: no fake stack to keep. */
  __sanitizer_start_switch_fiber(NULL, caller_bottom, caller_size);
#endif
  setcontext(back);
}

static void ni_on_node_stack_below_mark(void (*job)(void *), void *arg) {
  ucontext_t nested, caller;
  char *lo = ni_stack + NI_GUARD;
  /* Below the red zone and 16-byte aligned, as makecontext expects. */
  uintptr_t hi = (ni_mark - 512) & ~(uintptr_t)15;
  if (getcontext(&nested) != 0) scr_trap("scriptc: getcontext failed\n");
  nested.uc_stack.ss_sp = lo;
  nested.uc_stack.ss_size = hi - (uintptr_t)lo;
  nested.uc_link = NULL;
  makecontext(&nested, ni_nested_trampoline, 0);
  ni_nested_job = job;
  ni_nested_arg = arg;
  ni_nested_return = &caller;
  uintptr_t guard = scr_stack_guard;
  SCR_STACK_GUARD_SET(scr_stack_guard_for((uintptr_t)lo, hi - (uintptr_t)lo));
#ifdef NI_ASAN
  void *caller_fake = NULL;
  __sanitizer_start_switch_fiber(&caller_fake, lo, hi - (uintptr_t)lo);
#endif
  swapcontext(&caller, &nested);
#ifdef NI_ASAN
  const void *bottom;
  size_t size;
  __sanitizer_finish_switch_fiber(caller_fake, &bottom, &size);
#endif
  SCR_STACK_GUARD_SET(guard);
}

/* Runs job(arg) on Node's stack (directly when already there). */
static void ni_on_node_stack(void (*job)(void *), void *arg) {
  if (ni_on_stack) {
    if (ni_mark != 0 && !ni_stack_has((uintptr_t)__builtin_frame_address(0)))
      ni_on_node_stack_below_mark(job, arg);
    else
      job(arg);
    return;
  }
  if (ni_stack == NULL) {
    ni_stack = mmap(NULL, NI_STACK, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANON, -1, 0);
    if (ni_stack == MAP_FAILED) ni_oom();
    (void)mprotect(ni_stack, NI_GUARD, PROT_NONE);
#ifdef NI_ASAN
    if (__lsan_register_root_region) __lsan_register_root_region(ni_stack, NI_STACK);
#endif
    if (getcontext(&ni_node_ctx) != 0) scr_trap("scriptc: getcontext failed\n");
    ni_node_ctx.uc_stack.ss_sp = ni_stack + NI_GUARD;
    ni_node_ctx.uc_stack.ss_size = NI_STACK - NI_GUARD;
    ni_node_ctx.uc_link = NULL;
    makecontext(&ni_node_ctx, ni_trampoline, 0);
  }
  ni_job = job;
  ni_job_arg = arg;
  ni_on_stack = true;
  uintptr_t guard = scr_stack_guard;
  SCR_STACK_GUARD_SET(scr_stack_guard_for((uintptr_t)(ni_stack + NI_GUARD), NI_STACK - NI_GUARD));
#ifdef NI_ASAN
  void *caller_fake = NULL;
  __sanitizer_start_switch_fiber(&caller_fake, ni_stack + NI_GUARD, NI_STACK - NI_GUARD);
#endif
  swapcontext(&ni_caller_ctx, &ni_node_ctx);
#ifdef NI_ASAN
  const void *bottom;
  size_t size;
  __sanitizer_finish_switch_fiber(caller_fake, &bottom, &size);
#endif
  SCR_STACK_GUARD_SET(guard);
  ni_on_stack = false;
}

typedef struct {
  const char *bootstrap, *argv0;
  char *error;
} NiStart;

static void ni_start_job(void *p) {
  NiStart *a = p;
  /* JavaScript may use Node's stack down to a reserve above its guard page
   * (native frames below V8's limit, the runtime's stack guard). */
  uintptr_t limit = (uintptr_t)(ni_stack + NI_GUARD) + NI_STACK / 8;
  a->error = ni_bridge->start(&ni_host, a->bootstrap, a->argv0, limit);
}

typedef struct {
  uint32_t id;
  int sync;
  const char *file, *specifier, *name, *args;
  size_t args_len, len;
  char *outcome;
} NiCall;

static void ni_call_job(void *p) {
  NiCall *a = p;
  a->outcome =
      ni_bridge->call(a->id, a->sync, a->file, a->specifier, a->name, a->args, a->args_len, &a->len);
}

/* V8's stack limit for the stack an entry comes from: Node's own stack
 * (a reserve above its guard page), the main thread's (Node's default
 * --stack-size, 984 KiB, below its top), or an async fiber's (the
 * runtime's guard for it: its mapping's start plus the reserve compiled
 * code keeps). */
static uintptr_t ni_stack_limit(void) {
  /* The frame address, not a local's: under ASan's use-after-return
   * detection locals live on a fake stack elsewhere in memory. */
  uintptr_t sp = (uintptr_t)__builtin_frame_address(0);
  if (ni_stack_has(sp)) return (uintptr_t)(ni_stack + NI_GUARD) + NI_STACK / 8;
  if (sp > ni_main_lo && sp <= ni_main_hi) {
    uintptr_t limit = ni_main_hi > 984 * 1024 ? ni_main_hi - 984 * 1024 : 0;
    return limit > ni_main_lo ? limit : ni_main_lo + 64 * 1024;
  }
  if (scr_stack_guard != 0 && scr_stack_guard < sp) return scr_stack_guard;
  return 0;
}

/* The start of Node's stack for callers on it (V8's stack-scan bound). */
static uintptr_t ni_stack_start(void) {
  uintptr_t sp = (uintptr_t)__builtin_frame_address(0);
  return ni_stack_has(sp) ? (uintptr_t)ni_stack + NI_STACK : 0;
}

/* The host callbacks that run runtime code, with the mark recorded. */
static void ni_host_settle(uint32_t id, const char *outcome, size_t len) {
  NI_MARK_BEGIN;
  ni_settle(id, outcome, len);
  NI_MARK_END;
}

static void ni_host_exit(int code) {
  NI_MARK_BEGIN; /* never returns */
  (void)ni_saved_mark;
  ni_exit(code);
}

static void ni_host_run(uint32_t kind, uint32_t token) {
  NI_MARK_BEGIN;
  scr_loop_hosted_run(kind, token);
  NI_MARK_END;
}

static void ni_host_io(void) {
  NI_MARK_BEGIN;
  scr_loop_hosted_io();
  NI_MARK_END;
}

static void ni_host_microtasks_done(void) {
  NI_MARK_BEGIN;
  scr_loop_hosted_microtasks_done();
  NI_MARK_END;
}

static void ni_host_listen(uint32_t event, const char *name, uint32_t listener, int add,
                           int once) {
  NI_MARK_BEGIN;
  ni_listen(event, name, listener, add, once);
  NI_MARK_END;
}

static const ScrNodeBridgeHost ni_host = {
    &ni_host_settle,
    &ni_host_exit,
    &ni_host_run,
    &scr_loop_hosted_io_state,
    &ni_host_io,
    &ni_host_microtasks_done,
    &ni_host_listen,
    &ni_stack_limit,
    &ni_stack_start,
};

typedef struct {
  uint32_t event, listener;
  const char *name;
  int arg;
} NiEmit;

static void ni_emit_job(void *p) {
  NiEmit *e = p;
  ni_bridge->emit(e->event, e->listener, e->name, e->arg);
}

/* An island listener of a process event, on Node's stack (an exit listener
 * runs from the runtime's exit sequence, on whatever stack called it). */
void scr_node_island_emit(uint32_t event, uint32_t listener, ScrStr *name, int arg) {
  if (ni_bridge == NULL) return;
  char *n = malloc(name->len + 1);
  if (n == NULL) ni_oom();
  memcpy(n, name->data, name->len);
  n[name->len] = '\0';
  NiEmit e = {event, listener, n, arg};
  ni_on_node_stack(ni_emit_job, &e);
  free(n);
}

static void ni_stop_job(void *p) {
  (void)p;
  ni_bridge->stop();
}

/* Process end after a normal return: the 'exit' listeners of both sides
 * run while Node can still call into JavaScript (this handler runs before
 * the events unit's own, which then finds them done), then Node stops. */
static void ni_stop_atexit(void) {
  scr_run_exit_listeners((double)scr_exit_code_hint_get());
  ni_on_node_stack(ni_stop_job, NULL);
}

/* The hosted loop's run_loop on Node's stack. */
typedef struct {
  int continue_turn, code;
} NiRunLoop;

static void ni_run_loop_job(void *p) {
  NiRunLoop *a = p;
  a->code = ni_bridge->run_loop(a->continue_turn);
}

static int ni_run_loop(int continue_turn) {
  NiRunLoop a = {continue_turn, 0};
  ni_on_node_stack(ni_run_loop_job, &a);
  return a.code;
}

/* The bridge as the hosted loop sees it. Every entry that runs JavaScript
 * (scheduling a tick, timer or immediate goes through the bootstrap's
 * helpers; a checkpoint drains queues; Node's loop) runs on Node's stack,
 * below the mark when it comes from an async fiber that a host callback
 * resumed, like every other entry: V8 scans only Node's stack, so no frame
 * of Node may live on a fiber's stack or the main thread's. */
typedef struct {
  int op;
  uint32_t a, b;
  double d0, d1;
  int i0;
  uint32_t result;
} NiHosted;

enum {
  NI_H_MICROTASK,
  NI_H_TICK,
  NI_H_TIMER,
  NI_H_TIMER_CLEAR,
  NI_H_TIMER_REF,
  NI_H_TIMER_REFRESH,
  NI_H_IMMEDIATE,
  NI_H_IMMEDIATE_CLEAR,
  NI_H_IMMEDIATE_REF,
  NI_H_CHECKPOINT,
};

static void ni_hosted_job(void *p) {
  NiHosted *h = p;
  switch (h->op) {
  case NI_H_MICROTASK: ni_bridge->microtask(h->a); break;
  case NI_H_TICK: ni_bridge->tick(h->a); break;
  case NI_H_TIMER: h->result = ni_bridge->timer(h->d0, h->d1, h->i0, h->a); break;
  case NI_H_TIMER_CLEAR: ni_bridge->timer_clear(h->a); break;
  case NI_H_TIMER_REF: ni_bridge->timer_ref(h->a, h->i0); break;
  case NI_H_TIMER_REFRESH: ni_bridge->timer_refresh(h->a); break;
  case NI_H_IMMEDIATE: h->result = ni_bridge->immediate(h->i0, h->a); break;
  case NI_H_IMMEDIATE_CLEAR: ni_bridge->immediate_clear(h->a); break;
  case NI_H_IMMEDIATE_REF: ni_bridge->immediate_ref(h->a, h->i0); break;
  case NI_H_CHECKPOINT: ni_bridge->checkpoint(h->i0); break;
  default: break;
  }
}

static uint32_t ni_hosted_run(int op, uint32_t a, double d0, double d1, int i0) {
  NiHosted h = {op, a, 0, d0, d1, i0, 0};
  ni_on_node_stack(ni_hosted_job, &h);
  return h.result;
}

static void ni_h_microtask(uint32_t token) { ni_hosted_run(NI_H_MICROTASK, token, 0, 0, 0); }
static void ni_h_tick(uint32_t token) { ni_hosted_run(NI_H_TICK, token, 0, 0, 0); }
static uint32_t ni_h_timer(double delay, double repeat, int ref, uint32_t token) {
  return ni_hosted_run(NI_H_TIMER, token, delay, repeat, ref);
}
static void ni_h_timer_clear(uint32_t h) { ni_hosted_run(NI_H_TIMER_CLEAR, h, 0, 0, 0); }
static void ni_h_timer_ref(uint32_t h, int ref) { ni_hosted_run(NI_H_TIMER_REF, h, 0, 0, ref); }
static void ni_h_timer_refresh(uint32_t h) { ni_hosted_run(NI_H_TIMER_REFRESH, h, 0, 0, 0); }
static uint32_t ni_h_immediate(int ref, uint32_t token) {
  return ni_hosted_run(NI_H_IMMEDIATE, token, 0, 0, ref);
}
static void ni_h_immediate_clear(uint32_t h) { ni_hosted_run(NI_H_IMMEDIATE_CLEAR, h, 0, 0, 0); }
static void ni_h_immediate_ref(uint32_t h, int ref) {
  ni_hosted_run(NI_H_IMMEDIATE_REF, h, 0, 0, ref);
}
static void ni_h_checkpoint(int microtasks_first) {
  ni_hosted_run(NI_H_CHECKPOINT, 0, 0, 0, microtasks_first);
}

static ScrNodeBridge ni_hosted;

/* ── loading Node ─────────────────────────────────────────────────────── */

static void ni_start(void) {
  if (ni_bridge != NULL) return;
  /* Timers pending now keep their deadlines relative to this moment: the
   * time Node takes to load is invisible to their order. */
  double since = scr_now_ms();
  const char *dir = ni_pack_dir();
  char path[4352];
  snprintf(path, sizeof path, "%s/%s", dir, NI_BRIDGE_FILE);
  /* RTLD_GLOBAL: native addons resolve napi_* and node::* from the global
   * namespace. The executable exports no symbols libnode could bind to. */
  void *library = dlopen(path, RTLD_NOW | RTLD_GLOBAL);
  if (library == NULL) {
    char message[8192];
    snprintf(message, sizeof message,
             "scriptc: cannot load Node.js for this program's Node islands: %s\n", dlerror());
    ni_fatal(message);
  }
  const ScrNodeBridge *(*entry)(void) =
      (const ScrNodeBridge *(*)(void))dlsym(library, SCR_NODE_BRIDGE_ENTRY);
  const ScrNodeBridge *bridge = entry != NULL ? entry() : NULL;
  if (bridge == NULL || bridge->abi != SCR_NODE_BRIDGE_ABI) {
    char message[8192];
    snprintf(message, sizeof message,
             "scriptc: the libnode pack at %s has an incompatible bridge (ABI %u; this program "
             "needs %u)\n",
             dir, bridge != NULL ? bridge->abi : 0u, SCR_NODE_BRIDGE_ABI);
    ni_fatal(message);
  }
  if (ni_node_version != NULL && ni_node_version[0] != '\0' &&
      strcmp(bridge->node_version, ni_node_version) != 0) {
    char message[8192];
    snprintf(message, sizeof message,
             "scriptc: this program's Node islands need libnode %s; found %s (NODE_MODULE_VERSION "
             "%u) at %s\n",
             ni_node_version, bridge->node_version, bridge->module_version, dir);
    ni_fatal(message);
  }
  ScrStr *self = scr_process_exec_path();
  char argv0[4096];
  snprintf(argv0, sizeof argv0, "%.*s", (int)self->len, self->data);
  scr_str_release(self);
  /* Flush first: Node writes to the same stdout. */
  fflush(stdout);
  ni_bridge = bridge;
  ni_main_stack();
  NiStart start = {scr_node_island_host_js, argv0, NULL};
  ni_on_node_stack(ni_start_job, &start);
  char *error = start.error;
  if (error != NULL) {
    char message[8192];
    snprintf(message, sizeof message, "scriptc: cannot start Node.js from %s: %s\n", dir, error);
    bridge->release(error);
    ni_fatal(message);
  }
  /* Island listeners need the runtime's event registries and their
   * delivery; installed before the stop handler, whose 'exit' listeners
   * run first. */
  scr_events_install();
  scr_atexit(ni_stop_atexit);
  ni_hosted = *bridge;
  ni_hosted.run_loop = &ni_run_loop;
  ni_hosted.microtask = &ni_h_microtask;
  ni_hosted.tick = &ni_h_tick;
  ni_hosted.timer = &ni_h_timer;
  ni_hosted.timer_clear = &ni_h_timer_clear;
  ni_hosted.timer_ref = &ni_h_timer_ref;
  ni_hosted.timer_refresh = &ni_h_timer_refresh;
  ni_hosted.immediate = &ni_h_immediate;
  ni_hosted.immediate_clear = &ni_h_immediate_clear;
  ni_hosted.immediate_ref = &ni_h_immediate_ref;
  ni_hosted.checkpoint = &ni_h_checkpoint;
  scr_loop_host(&ni_hosted, since);
}

/* ── calls ────────────────────────────────────────────────────────────── */

/* The JSON text of the argument array (+1 dyn string), or NULL with the
 * copy's error pending. */
static ScrDyn *ni_args_json(ScrDyn *args) {
  ScrStr *gap = scr_str_new("", 0);
  ScrDyn *json = scr_json_stringify_replacer(args, scr_dyn_undefined(), gap);
  scr_str_release(gap);
  if (json != NULL && !scr_exc_pending() && json->kind == SCR_DYN_STR) return json;
  scr_dyn_release(json);
  return NULL;
}

/* A borrowed ScrStr as a NUL-terminated copy for the bridge. */
static char *ni_cstr(const ScrStr *s) {
  char *copy = malloc(s->len + 1);
  if (copy == NULL) ni_oom();
  memcpy(copy, s->data, s->len);
  copy[s->len] = '\0';
  return copy;
}

static char *ni_call(uint32_t id, bool sync, ScrStr *file, ScrStr *specifier, ScrStr *name,
                     ScrDyn *json, size_t *len) {
  char *f = ni_cstr(file), *s = ni_cstr(specifier), *n = ni_cstr(name);
  NiCall call = {id, sync ? 1 : 0, f, s, n, json->v.str->data, json->v.str->len, 0, NULL};
  ni_on_node_stack(ni_call_job, &call);
  char *outcome = call.outcome;
  *len = call.len;
  free(f);
  free(s);
  free(n);
  return outcome;
}

ScrDyn *scr_node_island_call_sync(ScrStr *file, ScrStr *specifier, ScrStr *name, ScrDyn *args) {
  ScrDyn *json = ni_args_json(args);
  if (json == NULL) return NULL;
  ni_start();
  size_t len = 0;
  char *outcome = ni_call(0, true, file, specifier, name, json, &len);
  scr_dyn_release(json);
  if (outcome == NULL) ni_fatal("scriptc: the libnode bridge answered no outcome\n");
  ScrDyn *result = ni_outcome(outcome, len);
  ni_bridge->release(outcome);
  return result;
}

ScrPromise *scr_node_island_call(ScrStr *file, ScrStr *specifier, ScrStr *name, ScrDyn *args) {
  ScrPromise *p = scr_promise_new();
  ScrDyn *json = ni_args_json(args);
  if (json == NULL) {
    scr_promise_reject_pending(p);
    return p;
  }
  ni_start();
  if (ni_npending == ni_pending_cap) {
    size_t cap = ni_pending_cap ? ni_pending_cap * 2 : 8;
    NiPending *grown = realloc(ni_pending, cap * sizeof *grown);
    if (grown == NULL) ni_oom();
    ni_pending = grown;
    ni_pending_cap = cap;
  }
  uint32_t id = ni_next_id++;
  if (ni_next_id == 0) ni_next_id = 1;
  ni_pending[ni_npending].id = id;
  ni_pending[ni_npending].promise = scr_promise_retain(p);
  ni_npending++;
  size_t len = 0;
  char *outcome = ni_call(id, false, file, specifier, name, json, &len);
  scr_dyn_release(json);
  if (outcome != NULL) ni_bridge->release(outcome);
  return p;
}

#else /* _WIN32 || __wasi__ */

void scr_node_island_emit(uint32_t event, uint32_t listener, ScrStr *name, int arg) {
  (void)event;
  (void)listener;
  (void)name;
  (void)arg;
}

/* Node islands need a libnode pack, which these targets do not have: the
 * compiler refuses them there, so these entry points only report that. */
void scr_node_island_install(const char *libnode, const char *node_version) {
  (void)libnode;
  (void)node_version;
}

SCR_COLD static void ni_unsupported(void) {
  fputs("scriptc: Node islands are not supported on this target\n", stderr);
  fflush(stderr);
  _Exit(1);
}

ScrDyn *scr_node_island_call_sync(ScrStr *file, ScrStr *specifier, ScrStr *name, ScrDyn *args) {
  (void)file;
  (void)specifier;
  (void)name;
  (void)args;
  ni_unsupported();
  return NULL;
}

ScrPromise *scr_node_island_call(ScrStr *file, ScrStr *specifier, ScrStr *name, ScrDyn *args) {
  (void)file;
  (void)specifier;
  (void)name;
  (void)args;
  ni_unsupported();
  return NULL;
}

#endif
