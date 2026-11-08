#include "scr_runtime.h"

#ifdef SCR_WORKERS
#include <pthread.h>
#include <stdlib.h>
#include <stdatomic.h>

void scr_runtime_workers_v8(void) {}

typedef struct ScrContextExit {
  void (*fn)(void);
  struct ScrContextExit *next;
} ScrContextExit;

static SCR_TL ScrContextExit *scr_context_exits;
static SCR_TL uint64_t scr_context_id;
/* The context's stop signal, which the out-of-line exception poll tests: a
 * worker points it at the flag its owner sets to terminate it (the owner
 * also raises the exception alert, so emitted polls take that slow path),
 * and a stopping context points it at a constant raised flag so every later
 * poll reinstalls the termination sentinel. It is never NULL. */
static const atomic_bool scr_context_unsignaled = false;
static const atomic_bool scr_context_raised = true;
static SCR_TL const atomic_bool *scr_context_signal = &scr_context_unsignaled;
static SCR_TL bool scr_context_stopped;
SCR_TL void (*scr_context_report_error)(void);
SCR_TL bool scr_context_report_rejection;

typedef struct { char *name; char *value; } ScrContextEnvEntry;
/* An environment's entries never change once published: a write builds a new
 * view and swaps it in. A reader that loaded a view therefore sees one
 * consistent snapshot even while another thread writes, and a borrowed value
 * pointer stays valid for as long as the environment lives. A SHARE_ENV
 * worker and the thread that created it hold one environment and can read and
 * write it at the same time. */
typedef struct ScrContextEnvView {
  size_t count;
  ScrContextEnvEntry entries[];
} ScrContextEnvView;

/* A replaced view, and every string a write dropped. No reader can tell when
 * it is the last one looking at a view (a borrowed value pointer outlives the
 * call that answered it), so both are freed with the environment, which
 * outlives every thread that holds it. */
typedef struct ScrContextEnvRetired {
  struct ScrContextEnvRetired *next;
  void *block;
} ScrContextEnvRetired;

/* A SHARE_ENV worker shares the creating thread's environment rather than
 * copying it, so two threads can hold one environment and either can outlive
 * the other; the reference count spans both. The lock orders writers only:
 * readers load the published view atomically. */
struct ScrContextEnv {
  atomic_size_t references;
  pthread_mutex_t lock;
  _Atomic(ScrContextEnvView *) view;
  ScrContextEnvRetired *retired;
};
static SCR_TL ScrContextEnv *scr_context_environment;

static char *scr_context_text_copy(const char *value) {
  size_t length = strlen(value);
  char *copy = malloc(length + 1);
  if (!copy) scr_trap("scriptc: out of memory\n");
  memcpy(copy, value, length + 1);
  return copy;
}

static ScrContextEnvView *scr_context_env_view_new(size_t count) {
  ScrContextEnvView *view = calloc(1, sizeof(*view) + count * sizeof(view->entries[0]));
  if (!view) scr_trap("scriptc: out of memory\n");
  view->count = count;
  return view;
}

static ScrContextEnvView *scr_context_env_view_load(ScrContextEnv *environment) {
  return atomic_load_explicit(&environment->view, memory_order_acquire);
}

static void scr_context_env_view_publish(ScrContextEnv *environment, ScrContextEnvView *view) {
  atomic_store_explicit(&environment->view, view, memory_order_release);
}

/* Takes a block out of service without freeing it: readers may still hold
 * the view it belongs to. Caller holds the write lock, or owns the
 * environment before it is shared. */
static void scr_context_env_retire(ScrContextEnv *environment, void *block) {
  ScrContextEnvRetired *retired = malloc(sizeof(*retired));
  if (!retired) scr_trap("scriptc: out of memory\n");
  retired->next = environment->retired;
  retired->block = block;
  environment->retired = retired;
}

ScrContextEnv *scr_context_env_capture(void) {
  ScrArr *pairs = scr_env_pairs();
  ScrContextEnv *environment = calloc(1, sizeof(*environment));
  if (!environment) scr_trap("scriptc: out of memory\n");
  atomic_init(&environment->references, 1);
  atomic_init(&environment->view, NULL);
  if (pthread_mutex_init(&environment->lock, NULL) != 0) scr_trap("scriptc: out of memory\n");
  size_t count = pairs->len / 2;
  ScrContextEnvView *view = scr_context_env_view_new(count);
  for (size_t i = 0; i < count; i++) {
    ScrStr *key = scr_arr_get_ref(pairs, (double)(2 * i));
    ScrStr *value = scr_arr_get_ref(pairs, (double)(2 * i + 1));
    view->entries[i] = (ScrContextEnvEntry){scr_context_text_copy(key->data), scr_context_text_copy(value->data)};
    scr_str_release(key); scr_str_release(value);
  }
  scr_arr_release(pairs);
  scr_context_env_view_publish(environment, view);
  return environment;
}

ScrContextEnv *scr_context_env_current(void) { return scr_context_environment; }

ScrContextEnv *scr_context_env_retain(ScrContextEnv *environment) {
  if (environment) atomic_fetch_add_explicit(&environment->references, 1, memory_order_relaxed);
  return environment;
}

void scr_context_env_release(ScrContextEnv *environment) {
  if (!environment) return;
  if (atomic_fetch_sub_explicit(&environment->references, 1, memory_order_acq_rel) != 1) return;
  ScrContextEnvView *view = scr_context_env_view_load(environment);
  if (view) {
    for (size_t i = 0; i < view->count; i++) {
      free(view->entries[i].name); free(view->entries[i].value);
    }
    free(view);
  }
  ScrContextEnvRetired *retired = environment->retired;
  while (retired) {
    ScrContextEnvRetired *next = retired->next;
    free(retired->block);
    free(retired);
    retired = next;
  }
  pthread_mutex_destroy(&environment->lock);
  free(environment);
}

static void scr_context_env_cleanup(void) {
  scr_context_env_release(scr_context_environment);
  scr_context_environment = NULL;
}

/* Takes ownership of the caller's reference for the thread's lifetime; a
 * SHARE_ENV worker passes a reference it retained from the creating thread's
 * environment, so both threads release the same environment independently. */
void scr_context_env_enter(ScrContextEnv *environment) {
  scr_context_environment = environment;
  if (scr_context_atexit(scr_context_env_cleanup)) scr_trap("scriptc: out of memory\n");
}

/* The process environment is shared by every thread: a SHARE_ENV worker
 * created by a thread that has no environment of its own reads and writes it
 * directly. glibc's setenv reallocates the environ array, so a read that
 * walks it while another thread writes is a use-after-free. Every access
 * takes this lock. A read answers a copy, kept in a per-thread ring so that
 * a caller may hold a few values at once (scr_util_terminal_colors holds
 * TERM across a dozen reads) and the copies die with the thread. */
static pthread_mutex_t scr_context_process_env_lock = PTHREAD_MUTEX_INITIALIZER;

#define SCR_CONTEXT_ENV_COPIES 16
static SCR_TL char *scr_context_env_copies[SCR_CONTEXT_ENV_COPIES];
static SCR_TL size_t scr_context_env_copy_next;

static void scr_context_env_copies_cleanup(void) {
  for (size_t i = 0; i < SCR_CONTEXT_ENV_COPIES; i++) {
    free(scr_context_env_copies[i]);
    scr_context_env_copies[i] = NULL;
  }
}

static const char *scr_context_env_copy_track(char *copy) {
  static SCR_TL bool registered = false;
  if (!copy) return NULL;
  if (!registered) {
    if (scr_context_atexit(scr_context_env_copies_cleanup)) scr_trap("scriptc: out of memory\n");
    registered = true;
  }
  free(scr_context_env_copies[scr_context_env_copy_next]);
  scr_context_env_copies[scr_context_env_copy_next] = copy;
  scr_context_env_copy_next = (scr_context_env_copy_next + 1) % SCR_CONTEXT_ENV_COPIES;
  return copy;
}

void scr_context_env_process_lock(void) { pthread_mutex_lock(&scr_context_process_env_lock); }
void scr_context_env_process_unlock(void) { pthread_mutex_unlock(&scr_context_process_env_lock); }

const char *scr_context_getenv(const char *name) {
  ScrContextEnv *environment = scr_context_environment;
  if (!environment) {
    /* The process environment goes through the same read scr_env_get uses:
     * on Windows that is the Win32 environment, which scr_env_set writes,
     * not the CRT's startup snapshot. A SHARE_ENV worker has no environment
     * of its own, so it reads here and must see the writes either thread
     * made. */
    pthread_mutex_lock(&scr_context_process_env_lock);
    char *copy = scr_env_process_copy(name);
    pthread_mutex_unlock(&scr_context_process_env_lock);
    return scr_context_env_copy_track(copy);
  }
  ScrContextEnvView *view = scr_context_env_view_load(environment);
  for (size_t i = 0; view && i < view->count; i++)
    if (!strcmp(view->entries[i].name, name)) return view->entries[i].value;
  return NULL;
}

ScrContextEnv *scr_context_env_new(void) {
  ScrContextEnv *environment = calloc(1, sizeof(*environment));
  if (!environment) scr_trap("scriptc: out of memory\n");
  atomic_init(&environment->references, 1);
  atomic_init(&environment->view, NULL);
  if (pthread_mutex_init(&environment->lock, NULL) != 0) scr_trap("scriptc: out of memory\n");
  scr_context_env_view_publish(environment, scr_context_env_view_new(0));
  return environment;
}

/* Swaps in a view that carries the change. Entries of the old view are
 * never edited, so a concurrent reader never sees a half-written one. */
static void scr_context_env_put(ScrContextEnv *environment, const char *name, const char *value) {
  pthread_mutex_lock(&environment->lock);
  ScrContextEnvView *current = scr_context_env_view_load(environment);
  size_t count = current ? current->count : 0;
  size_t at = count;
  for (size_t i = 0; i < count; i++)
    if (!strcmp(current->entries[i].name, name)) { at = i; break; }
  ScrContextEnvView *next;
  if (at < count) {
    if (value) {
      next = scr_context_env_view_new(count);
      for (size_t i = 0; i < count; i++) next->entries[i] = current->entries[i];
      next->entries[at].value = scr_context_text_copy(value);
      scr_context_env_retire(environment, current->entries[at].value);
    } else {
      next = scr_context_env_view_new(count - 1);
      for (size_t i = 0; i < at; i++) next->entries[i] = current->entries[i];
      for (size_t i = at + 1; i < count; i++) next->entries[i - 1] = current->entries[i];
      scr_context_env_retire(environment, current->entries[at].name);
      scr_context_env_retire(environment, current->entries[at].value);
    }
  } else if (value) {
    next = scr_context_env_view_new(count + 1);
    for (size_t i = 0; i < count; i++) next->entries[i] = current->entries[i];
    next->entries[count] = (ScrContextEnvEntry){scr_context_text_copy(name), scr_context_text_copy(value)};
  } else {
    pthread_mutex_unlock(&environment->lock);
    return;
  }
  scr_context_env_view_publish(environment, next);
  if (current) scr_context_env_retire(environment, current);
  pthread_mutex_unlock(&environment->lock);
}

/* Sets one entry of an environment the caller owns: the Worker env option
 * fills a fresh environment before the thread starts. */
void scr_context_env_assign(ScrContextEnv *environment, const char *name, const char *value) {
  scr_context_env_put(environment, name, value);
}

bool scr_context_env_set(const char *name, const char *value) {
  if (!scr_context_environment) return false;
  scr_context_env_put(scr_context_environment, name, value);
  return true;
}

ScrArr *scr_context_env_pairs(void) {
  ScrContextEnv *environment = scr_context_environment;
  if (!environment) return NULL;
  ScrContextEnvView *view = scr_context_env_view_load(environment);
  ScrArr *out = scr_arr_new(SCR_ELEM_STR, 0);
  for (size_t i = 0; view && i < view->count; i++) {
    const ScrContextEnvEntry *entry = &view->entries[i];
    scr_arr_push_ref(out, scr_str_new(entry->name, strlen(entry->name)));
    scr_arr_push_ref(out, scr_str_new(entry->value, strlen(entry->value)));
  }
  return out;
}

void scr_context_enter(uint64_t thread_id) { scr_context_id = thread_id; }
bool scr_context_is_main(void) { return scr_context_id == 0; }

/* When the thread's script ended: its first scr_exit_frees call. */
static SCR_TL uint64_t scr_context_script_end;
void scr_context_note_script_end(void) {
  if (scr_context_script_end == 0) scr_context_script_end = scr_hrtime_ns();
}
uint64_t scr_context_script_end_ns(void) { return scr_context_script_end; }
uint64_t scr_context_thread_id(void) { return scr_context_id; }
double scr_context_thread_number(void) { return (double)scr_context_id; }

void scr_context_stop_flag(const void *flag) {
  if (!scr_context_stopped) scr_context_signal = flag ? flag : &scr_context_unsignaled;
}
bool scr_context_stopping(void) { return scr_context_stopped; }
/* Asked to stop: the owner's signal, or (ELF worker executables) the stop
 * bit of the thread's exact pending word, which worker.terminate() sets
 * directly so that emitted checks observe it. */
static bool scr_context_signaled(void) {
#ifdef SCR_EXC_FLAG
  if (atomic_load_explicit(&scr_exc_flag, memory_order_acquire) & SCR_EXC_FLAG_STOP) return true;
#endif
  return atomic_load_explicit(scr_context_signal, memory_order_relaxed);
}

/* Neither stopping nor asked to stop. */
bool scr_context_quiet(void) {
  return !scr_context_stopped && !scr_context_signaled();
}

void scr_context_stop(int code) {
  scr_context_stopped = true;
  scr_context_signal = &scr_context_raised;
  scr_exit_code_note(code);
  scr_exc_clear();
  scr_exc_current_cell()->kind = SCR_EXC_TERMINATE;
  scr_exc_cell_changed();
}

bool scr_context_checkpoint(void) {
  if (!scr_context_stopped && scr_context_signaled()) scr_context_stop(1);
  if (!scr_context_stopped) return false;
  /* Each fiber has its own exception cell. Reinstall the sentinel after a
   * context switch or a runtime continuation consumes its pending payload. */
  if (scr_exc_current_cell()->kind != SCR_EXC_TERMINATE) {
    scr_exc_clear();
    scr_exc_current_cell()->kind = SCR_EXC_TERMINATE;
    scr_exc_cell_changed();
  }
  return true;
}

int scr_context_atexit(void (*fn)(void)) {
  ScrContextExit *entry = malloc(sizeof(*entry));
  if (!entry) return -1;
  entry->fn = fn;
  entry->next = scr_context_exits;
  scr_context_exits = entry;
  return 0;
}

void scr_context_cleanup(void) {
  scr_loop_context_shutdown();
  /* Pop before calling: a callback may register further cleanup. Those
   * registrations run first, just as newly registered libc exit handlers do.
   * Repeated cleanup is harmless after the list has been drained. */
  while (scr_context_exits) {
    ScrContextExit *entry = scr_context_exits;
    scr_context_exits = entry->next;
    void (*fn)(void) = entry->fn;
    free(entry);
    fn();
  }
  scr_exc_clear();
  if (scr_exit_frees()) scr_cyc_context_cleanup();
}
#else
bool scr_context_is_main(void) { return true; }
double scr_context_thread_number(void) { return 0; }
double scr_worker_root(void) { return -1; }
ScrDyn *scr_worker_data(void) { return scr_dyn_new_null(); }
ScrDyn *scr_worker_parent_port(void) { return scr_dyn_new_null(); }
ScrDyn *scr_worker_resource_limits(void) { return scr_dyn_new_obj(); }
ScrDyn *scr_worker_thread_name_current(void) {
  ScrStr *empty = scr_str_new("", 0);
  ScrDyn *name = scr_dyn_new_str(empty);
  scr_str_release(empty);
  return name;
}
#endif

/* ── native stack guard ─────────────────────────────────────────────────
 * Executables call scr_stack_guard_init on every context's thread before
 * compiled code runs; async fibers install their own guard on each switch
 * (scr_async.c). The guard itself is defined in scr_exception.c. Platforms
 * without a known stack extent keep the guard at zero, which leaves the
 * generated entry checks inert. */
#if defined(__linux__) && !defined(SCR_LIB)
#include <sys/auxv.h>
#include <sys/resource.h>
#elif defined(__APPLE__) && !defined(SCR_LIB)
#include <pthread.h>
#endif
#if defined(__linux__) && defined(SCR_WORKERS) && !defined(SCR_LIB)
#include <pthread.h>
#endif

#ifdef SCR_STACK_GUARD_TSD
/* The guard's thread-specific-data slot (scr_runtime.h). libpthread keeps a
 * thread's values in an array at its thread pointer, indexed by key, which
 * is also how its own inline accessors read them; the probe below checks
 * that layout once before compiled code relies on it. */
uintptr_t scr_stack_guard_tsd = 0;
static pthread_key_t scr_stack_guard_key;
static bool scr_stack_guard_keyed;
static pthread_once_t scr_stack_guard_once = PTHREAD_ONCE_INIT;

static void *scr_stack_guard_tsd_read(uintptr_t offset) {
  void *value;
#if defined(__aarch64__)
  uintptr_t base;
  __asm__ volatile("mrs %0, TPIDRRO_EL0" : "=r"(base));
  value = *(void *volatile *)((base & ~(uintptr_t)7) + offset);
#else
  __asm__ volatile("movq %%gs:(%1), %0" : "=r"(value) : "r"(offset));
#endif
  return value;
}

static void scr_stack_guard_key_init(void) {
  if (pthread_key_create(&scr_stack_guard_key, NULL) != 0) return;
  scr_stack_guard_keyed = true;
  static const char probe;
  uintptr_t offset = (uintptr_t)scr_stack_guard_key * sizeof(void *);
  if (offset != 0 && pthread_setspecific(scr_stack_guard_key, &probe) == 0 &&
      scr_stack_guard_tsd_read(offset) == &probe)
    scr_stack_guard_tsd = offset;
  (void)pthread_setspecific(scr_stack_guard_key, NULL);
}

void scr_stack_guard_set(uintptr_t guard) {
  scr_stack_guard = guard;
  if (scr_stack_guard_keyed) (void)pthread_setspecific(scr_stack_guard_key, (void *)guard);
}

uintptr_t scr_stack_guard_get(void) { return scr_stack_guard; }
#endif

void scr_stack_guard_init(void) {
#if defined(__APPLE__) && !defined(SCR_LIB)
#ifdef SCR_STACK_GUARD_TSD
  (void)pthread_once(&scr_stack_guard_once, scr_stack_guard_key_init);
#endif
  pthread_t self = pthread_self();
  uintptr_t high = (uintptr_t)pthread_get_stackaddr_np(self);
  size_t size = pthread_get_stacksize_np(self);
  if (high > size) SCR_STACK_GUARD_SET(scr_stack_guard_for(high - size, size));
#elif defined(__linux__) && !defined(SCR_LIB)
#ifdef SCR_WORKERS
  if (!scr_context_is_main()) {
    /* Worker threads: the thread library knows the exact extent. */
    pthread_attr_t attr;
    void *low = NULL;
    size_t size = 0;
    if (pthread_getattr_np(pthread_self(), &attr) != 0) return;
    if (pthread_attr_getstack(&attr, &low, &size) == 0 && low && size)
      scr_stack_guard = scr_stack_guard_for((uintptr_t)low, size);
    pthread_attr_destroy(&attr);
    return;
  }
#endif
  /* The main thread's stack grows on demand up to RLIMIT_STACK, measured
   * from the top of its mapping. The kernel places the executable's path
   * (AT_EXECFN) at the very top, followed only by a terminating pointer, so
   * it bounds the mapping's end without parsing /proc. Without it, assume
   * the arguments and environment above this frame fit in 256 KiB. */
  struct rlimit limit;
  size_t size = (size_t)8 << 20;
  if (getrlimit(RLIMIT_STACK, &limit) == 0) {
    if (limit.rlim_cur == RLIM_INFINITY) size = (size_t)64 << 20;
    else if (limit.rlim_cur < ((rlim_t)1 << 30)) size = (size_t)limit.rlim_cur;
    else size = (size_t)1 << 30;
  }
  uintptr_t here = (uintptr_t)__builtin_frame_address(0);
  const char *execfn = (const char *)getauxval(AT_EXECFN);
  uintptr_t high = execfn ? (uintptr_t)execfn + strlen(execfn) + 1 + sizeof(void *)
                          : here + ((uintptr_t)256 << 10);
  if (high < here) high = here;
  uintptr_t page = (uintptr_t)getauxval(AT_PAGESZ);
  if (page == 0 || (page & (page - 1)) != 0) page = 4096;
  high = (high + page - 1) & ~(page - 1);
  if (high > size) scr_stack_guard = scr_stack_guard_for(high - size, size);
#endif
}

/* Out of line and cold: the generated entry checks branch here and then
 * unwind like any other pending exception. */
__attribute__((cold, noinline)) void scr_stack_overflow(void) {
  static const char text[] = "Maximum call stack size exceeded";
  scr_throw_error_msg(SCR_ERR_RANGE, text, sizeof text - 1);
}
