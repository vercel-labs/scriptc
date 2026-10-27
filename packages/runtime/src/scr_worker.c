#include "scr_worker.h"

#ifdef SCR_WORKERS
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <limits.h>
#ifdef _WIN32
#include <process.h>
#include <windows.h>
#else
#include <pthread.h>
#include <unistd.h>
#endif

#if defined(__linux__)
#include <fcntl.h>
#include <sys/resource.h>
#include <unistd.h>

/* Every worker's mailbox holds descriptors. Once a process passes 64 of
 * them, the kernel grows its descriptor table, and while other threads share
 * the table it first waits a full RCU grace period (synchronize_rcu in
 * expand_fdtable): measured 11-25 ms on a 16-vCPU host, on the thread that
 * starts the next worker. Growing the table at load, while the process still
 * has one thread, never waits; the table never shrinks. 256 entries leave
 * room for the most workers the allocator gives arenas to. */
__attribute__((constructor)) static void scr_worker_reserve_fd_table(void) {
  const int top = 255;
  struct rlimit limit;
  if (getrlimit(RLIMIT_NOFILE, &limit) == 0 && limit.rlim_cur != RLIM_INFINITY && limit.rlim_cur <= (rlim_t)top)
    return;
  for (int fd = 0; fd <= 2; fd++) {
    int copy = fcntl(fd, F_DUPFD_CLOEXEC, top);
    if (copy >= 0) {
      (void)close(copy);
      return;
    }
  }
}
#endif

struct ScrWorkerThread {
  atomic_size_t references;
  atomic_bool cancel;
#ifdef SCR_EXC_FLAG
  /* The worker thread's exact pending word (scr_exception.c) while its
   * script runs, NULL before and after: terminate() sets the stop bit
   * through it. The lock keeps the thread's TLS alive across that write. */
  pthread_mutex_t flag_lock;
  _Atomic uint32_t *flag;
#else
  /* The exception alert reference of a terminate request: 0 none, 1 held,
   * 2 the thread finished its script (no reference is taken any more). */
  atomic_int alert;
#endif
  atomic_bool port_closed;
  uint64_t id;
  uint32_t root;
  ScrWorkerEntry entry;
  ScrMailbox *inbox;
  ScrMailbox *parent;
  ScrMessage *data;
  /* data is [workerData, entries] when the parent had environment data */
  bool environment_data;
  ScrContextEnv *environment;
  ScrStr *name; /* threadName: immortal copy shared by both threads */
  unsigned capture; /* 1 stdout, 2 stderr: writes go to the parent as events */
  int argc;
  char **argv;
  bool joined;
  uint64_t spawned_ns; /* SCRIPTC_WORKER_STATS only */
#ifdef _WIN32
  HANDLE thread;
#else
  pthread_t thread;
#endif
};

static atomic_uint_fast64_t scr_worker_next_id = 1;
static SCR_TL ScrWorkerThread *scr_worker_current;
static SCR_TL ScrDyn *scr_worker_local_data;
static SCR_TL ScrDyn *scr_worker_local_environment;

/* SCRIPTC_WORKER_STATS=1 reports, as each worker thread exits, how long it
 * took to start, to run its script (runtime and module initialization
 * included) and to exit (freeing its heap). -1 until read. */
static _Atomic int scr_worker_stats_mode = -1;

static bool scr_worker_stats(void) {
  int mode = atomic_load_explicit(&scr_worker_stats_mode, memory_order_relaxed);
  if (mode < 0) {
    const char *value = getenv("SCRIPTC_WORKER_STATS");
    mode = value != NULL && value[0] == '1';
    atomic_store_explicit(&scr_worker_stats_mode, mode, memory_order_relaxed);
  }
  return mode != 0;
}

static ScrMailEvent *scr_worker_event(unsigned kind, uint64_t source,
                                     int code, ScrMessage *message) {
  ScrMailEvent *event = message ? scr_message_mail_event(message) : calloc(1, sizeof(*event));
  if (!event) scr_trap("scriptc: out of memory\n");
  *event = (ScrMailEvent){
      .kind = kind, .source = source, .code = code, .message = message, .in_message = message != NULL};
  return event;
}

ScrWorkerThread *scr_worker_thread_retain(ScrWorkerThread *worker) {
  atomic_fetch_add_explicit(&worker->references, 1, memory_order_relaxed);
  return worker;
}

void scr_worker_thread_release(ScrWorkerThread *worker) {
  if (!worker || atomic_fetch_sub_explicit(&worker->references, 1, memory_order_acq_rel) != 1) return;
#ifdef _WIN32
  if (worker->thread) CloseHandle(worker->thread);
#else
  if (!worker->joined) (void)pthread_detach(worker->thread);
#endif
  scr_mailbox_release(worker->inbox);
  scr_mailbox_release(worker->parent);
  scr_message_free(worker->data);
  scr_context_env_free(worker->environment);
  free(worker->name);
  for (int i = 0; i < worker->argc; i++) free(worker->argv[i]);
  free(worker->argv);
#ifdef SCR_EXC_FLAG
  pthread_mutex_destroy(&worker->flag_lock);
#endif
  free(worker);
}

static void scr_worker_data_cleanup(void) {
  ScrDyn *data = scr_worker_local_data;
  ScrDyn *environment = scr_worker_local_environment;
  scr_worker_local_data = NULL;
  scr_worker_local_environment = NULL;
  scr_dyn_release(data);
  scr_dyn_release(environment);
}

/* Decodes the start message once: workerData and, when the parent had
 * environment data, its entries. */
static bool scr_worker_decode_start(void) {
  if (scr_worker_local_data) return true;
  ScrDyn *data = scr_message_decode(scr_worker_current->data);
  if (!data) return false;
  if (scr_worker_current->environment_data) {
    scr_worker_local_environment = scr_dyn_arr_at(data, 1);
    ScrDyn *value = scr_dyn_arr_at(data, 0);
    scr_dyn_release(data);
    data = value;
  }
  scr_worker_local_data = data;
  if (scr_context_atexit(scr_worker_data_cleanup) != 0) scr_trap("scriptc: out of memory\n");
  scr_message_free(scr_worker_current->data);
  scr_worker_current->data = NULL;
  return true;
}

ScrDyn *scr_worker_data(void) {
  if (!scr_worker_current) return scr_dyn_new_null();
  if (!scr_worker_decode_start()) return NULL;
  return scr_dyn_retain(scr_worker_local_data);
}

ScrDyn *scr_worker_take_environment(void) {
  if (!scr_worker_current || !scr_worker_current->environment_data) return NULL;
  if (!scr_worker_decode_start()) return NULL;
  ScrDyn *entries = scr_worker_local_environment;
  scr_worker_local_environment = NULL;
  return entries;
}

ScrMailbox *scr_worker_inbox(void) {
  return scr_worker_current ? scr_worker_current->inbox : NULL;
}

double scr_worker_root(void) { return scr_worker_current ? (double)scr_worker_current->root : -1; }
int scr_worker_argc(void) { return scr_worker_current ? scr_worker_current->argc : 0; }
char **scr_worker_argv(void) { return scr_worker_current ? scr_worker_current->argv : NULL; }

uint64_t scr_worker_thread_id(const ScrWorkerThread *worker) { return worker->id; }

const ScrStr *scr_worker_thread_name(const ScrWorkerThread *worker) { return worker->name; }

ScrDyn *scr_worker_thread_name_current(void) {
  if (!scr_worker_current) {
    ScrStr *empty = scr_str_new("", 0);
    ScrDyn *name = scr_dyn_new_str(empty);
    scr_str_release(empty);
    return name;
  }
  /* a copy: the thread record's name is freed with the record */
  ScrStr *copy = scr_str_new(scr_worker_current->name->data, scr_worker_current->name->len);
  ScrDyn *name = scr_dyn_new_str(copy);
  scr_str_release(copy);
  return name;
}

void scr_worker_thread_terminate(ScrWorkerThread *worker) {
  atomic_store_explicit(&worker->cancel, true, memory_order_relaxed);
#ifdef SCR_EXC_FLAG
  /* Emitted checks test only the worker's own pending word: raise its stop
   * bit. A worker that has not registered its word yet finds the cancel
   * flag when it does (scr_worker_thread_run); one that has finished its
   * script needs nothing. */
  pthread_mutex_lock(&worker->flag_lock);
  if (worker->flag) scr_exc_flag_request_stop(worker->flag);
  pthread_mutex_unlock(&worker->flag_lock);
#else
  /* Emitted polls only call into the runtime while the exception alert is
   * raised: hold a reference until the worker's script has ended. */
  scr_exc_alert_add(1);
  int idle = 0;
  if (!atomic_compare_exchange_strong_explicit(&worker->alert, &idle, 1, memory_order_acq_rel,
                                               memory_order_acquire))
    scr_exc_alert_add(-1);
#endif
  scr_mailbox_post(worker->inbox, scr_worker_event(SCR_WORKER_WAKE, 0, 0, NULL));
}

bool scr_worker_thread_post(ScrWorkerThread *worker, ScrMessage *message) {
  if (atomic_load_explicit(&worker->port_closed, memory_order_relaxed)) {
    scr_message_free(message);
    return false;
  }
  return scr_mailbox_post(worker->inbox, scr_worker_event(SCR_WORKER_MESSAGE, 0, 0, message));
}

void scr_worker_port_close(void) {
  if (scr_worker_current)
    atomic_store_explicit(&scr_worker_current->port_closed, true, memory_order_relaxed);
}

static _Atomic(void (*)(void)) scr_worker_stdin_attach;

void scr_worker_set_stdin_attach(void (*attach)(void)) {
  atomic_store_explicit(&scr_worker_stdin_attach, attach, memory_order_relaxed);
}

bool scr_worker_thread_post_stdin(ScrWorkerThread *worker, const void *data, size_t len, bool end) {
  ScrMailEvent *event = scr_worker_event(SCR_WORKER_STDIN, 0, 0, NULL);
  if (!end) {
    event->data = malloc(len ? len : 1);
    if (!event->data) scr_trap("scriptc: out of memory\n");
    memcpy(event->data, data, len);
    event->length = len;
  }
  return scr_mailbox_post(worker->inbox, event);
}

bool scr_worker_post_parent(ScrMessage *message) {
  if (!scr_worker_current) { scr_message_free(message); return false; }
  return scr_mailbox_post(scr_worker_current->parent,
    scr_worker_event(SCR_WORKER_MESSAGE, scr_worker_current->id, 0, message));
}

/* The stdout and stderr options: a captured write reaches the parent's
 * worker.stdout or worker.stderr in order with the worker's other events. */
static bool scr_worker_capture(int fd, const void *data, size_t len) {
  unsigned bit = fd == 2 ? 2 : 1;
  if (!scr_worker_current || !(scr_worker_current->capture & bit)) return false;
  if (!len) return true;
  ScrMailEvent *event = scr_worker_event(bit == 2 ? SCR_WORKER_STDERR : SCR_WORKER_STDOUT,
                                         scr_worker_current->id, 0, NULL);
  event->data = malloc(len);
  if (!event->data) scr_trap("scriptc: out of memory\n");
  memcpy(event->data, data, len);
  event->length = len;
  scr_mailbox_post(scr_worker_current->parent, event);
  return true;
}

static void scr_worker_report_error(void) {
  ScrCaught *caught = scr_exc_take();
  ScrDyn *value = scr_caught_to_dyn(caught);
  if (scr_context_report_rejection) {
    ScrDyn *error = scr_unhandled_rejection_error(value);
    scr_dyn_release(value);
    value = error;
  }
  ScrMessage *message = value ? scr_message_encode_uncaught(value) : NULL;
  if (!message && value) {
    /* Node falls back to the plain clone when a property does not clone. */
    scr_exc_clear();
    message = scr_message_encode(value);
  }
  scr_dyn_release(value);
  scr_caught_release(caught);
  if (!message) {
    scr_exc_clear();
    static const char text[] = "Serializing an uncaught exception failed";
    scr_throw_error_msg_code(SCR_ERR_ERROR, text, sizeof text - 1, "ERR_WORKER_UNSERIALIZABLE_ERROR");
    caught = scr_exc_take();
    value = scr_caught_to_dyn(caught);
    message = scr_message_encode(value);
    scr_dyn_release(value);
    scr_caught_release(caught);
  }
  scr_mailbox_post(scr_worker_current->parent,
    scr_worker_event(SCR_WORKER_ERROR, scr_worker_current->id, 0, message));
}

static void scr_worker_thread_run(ScrWorkerThread *worker) {
  bool stats = scr_worker_stats();
  uint64_t started_ns = stats ? scr_hrtime_ns() : 0;
  scr_context_enter(worker->id);
#ifdef SCR_EXC_FLAG
  pthread_mutex_lock(&worker->flag_lock);
  worker->flag = &scr_exc_flag;
  pthread_mutex_unlock(&worker->flag_lock);
  /* A terminate() that ran before the registration only set the flag. */
  if (atomic_load_explicit(&worker->cancel, memory_order_relaxed))
    scr_exc_flag_request_stop(&scr_exc_flag);
#endif
  scr_context_stop_flag(&worker->cancel);
  scr_context_env_enter(worker->environment);
  worker->environment = NULL;
  scr_worker_current = worker;
  scr_context_report_error = scr_worker_report_error;
  if (worker->capture & 3) scr_stdio_capture = scr_worker_capture;
  if (worker->capture & 4) {
    scr_stdin_fed = true;
    scr_stdin_fed_attach = atomic_load_explicit(&scr_worker_stdin_attach, memory_order_relaxed);
  }
  scr_mailbox_post(worker->parent, scr_worker_event(SCR_WORKER_ONLINE, worker->id, 0, NULL));
  int code = worker->entry(worker->root);
  scr_context_note_script_end(); /* when the program frees nothing at exit */
  scr_mailbox_close(worker->inbox);
  scr_stdin_fed_clear(); /* chunks the worker never read */
  scr_context_cleanup();
  if (stats) {
    uint64_t now = scr_hrtime_ns();
    fprintf(stderr, "scriptc worker %llu: started %.2f ms after spawn, script %.2f ms, exit %.2f ms\n",
            (unsigned long long)worker->id, (double)(started_ns - worker->spawned_ns) / 1e6,
            (double)(scr_context_script_end_ns() - started_ns) / 1e6, (double)(now - scr_context_script_end_ns()) / 1e6);
  }
  scr_stdio_capture = NULL;
  scr_worker_current = NULL;
  scr_exc_alert_thread_exit();
#ifdef SCR_EXC_FLAG
  pthread_mutex_lock(&worker->flag_lock);
  worker->flag = NULL;
  pthread_mutex_unlock(&worker->flag_lock);
#else
  if (atomic_exchange_explicit(&worker->alert, 2, memory_order_acq_rel) == 1) scr_exc_alert_add(-1);
#endif
  /* Cleanup may itself finish owner-bound native operations. Publish exit
   * only once none of those operations can touch the worker's script heap. */
  scr_mailbox_post(worker->parent, scr_worker_event(SCR_WORKER_EXIT, worker->id, code, NULL));
  scr_worker_thread_release(worker);
  /* Replaced InternTable indexes no longer wait for this thread. */
  scr_itable_thread_exit();
  /* The next script thread continues this thread's allocator arena. */
  scr_sa_thread_park();
}

#ifdef _WIN32
static unsigned __stdcall scr_worker_thread_main(void *data) {
  scr_sa_thread_starting();
  scr_worker_thread_run(data);
  return 0;
}
#else
static void *scr_worker_thread_main(void *data) {
  scr_sa_thread_starting();
  scr_worker_thread_run(data);
  return NULL;
}
#endif

ScrWorkerThread *scr_worker_thread_start(ScrWorkerEntry entry, uint32_t root,
                                        ScrMessage *data, bool environment_data,
                                        ScrMailbox *parent, ScrArr *arguments,
                                        size_t stack_size, const ScrStr *name,
                                        unsigned capture) {
  ScrWorkerThread *worker = calloc(1, sizeof(*worker));
  if (!worker) scr_trap("scriptc: out of memory\n");
  atomic_init(&worker->references, 2); /* owner and native thread */
  atomic_init(&worker->cancel, false);
#ifdef SCR_EXC_FLAG
  if (pthread_mutex_init(&worker->flag_lock, NULL) != 0) scr_trap("scriptc: out of memory\n");
  worker->flag = NULL;
#else
  atomic_init(&worker->alert, 0);
#endif
  atomic_init(&worker->port_closed, false);
  worker->id = atomic_fetch_add_explicit(&scr_worker_next_id, 1, memory_order_relaxed);
  worker->entry = entry;
  worker->root = root;
  worker->data = data;
  worker->environment_data = environment_data;
  worker->capture = capture;
  worker->environment = scr_context_env_capture();
  worker->name = malloc(sizeof(ScrStr) + name->len + 1);
  if (!worker->name) scr_trap("scriptc: out of memory\n");
  memcpy(worker->name, name, sizeof(ScrStr) + name->len + 1);
  worker->name->rc = SIZE_MAX;
  worker->parent = scr_mailbox_retain(parent);
  if (arguments) {
    if (arguments->len > INT_MAX) scr_trap("scriptc: too many worker arguments\n");
    worker->argc = (int)arguments->len;
    worker->argv = calloc(arguments->len + 1, sizeof(*worker->argv));
    if (!worker->argv) scr_trap("scriptc: out of memory\n");
    for (size_t i = 0; i < arguments->len; i++) {
      ScrStr *text = scr_arr_get_ref(arguments, (double)i);
      worker->argv[i] = malloc(text->len + 1);
      if (!worker->argv[i]) scr_trap("scriptc: out of memory\n");
      memcpy(worker->argv[i], text->data, text->len + 1);
      scr_str_release(text);
    }
  }
  worker->inbox = scr_mailbox_new();
  if (!worker->inbox) goto failed;
  if (scr_worker_stats()) worker->spawned_ns = scr_hrtime_ns();
#ifdef _WIN32
  worker->thread = (HANDLE)_beginthreadex(NULL, stack_size > UINT_MAX ? UINT_MAX : (unsigned)stack_size,
                                          scr_worker_thread_main, worker, 0, NULL);
  if (!worker->thread) goto failed;
#else
  /* An explicit size keeps recursion depth independent of the C library's
   * default thread stack (as small as 128 KiB with musl and 512 KiB on
   * macOS): workers get the 8 MiB a main thread usually has, or
   * resourceLimits.stackSizeMb. Pages are committed only as the stack
   * grows. */
  pthread_attr_t attr;
  if (pthread_attr_init(&attr) != 0) goto failed;
  if (!stack_size) stack_size = (size_t)8 << 20;
  long page = sysconf(_SC_PAGESIZE);
  if (page > 0 && stack_size % (size_t)page) stack_size += (size_t)page - stack_size % (size_t)page;
  if (pthread_attr_setstacksize(&attr, stack_size) != 0) {
    pthread_attr_destroy(&attr);
    goto failed;
  }
  int started = pthread_create(&worker->thread, &attr, scr_worker_thread_main, worker);
  pthread_attr_destroy(&attr);
  if (started != 0) goto failed;
#endif
  return worker;
failed:
  for (int i = 0; i < worker->argc; i++) free(worker->argv[i]);
  free(worker->argv);
  free(worker->name);
  scr_context_env_free(worker->environment);
  scr_mailbox_release(worker->inbox);
  scr_mailbox_release(worker->parent);
  scr_message_free(worker->data);
#ifdef SCR_EXC_FLAG
  pthread_mutex_destroy(&worker->flag_lock);
#endif
  free(worker);
  if (!scr_exc_pending()) {
    static const char message[] = "Could not start worker thread";
    scr_throw_error_msg_code(SCR_ERR_ERROR, message, sizeof message - 1, "ERR_WORKER_INIT_FAILED");
  }
  return NULL;
}

void scr_worker_thread_join(ScrWorkerThread *worker) {
  if (worker->joined) return;
#ifdef _WIN32
  if (WaitForSingleObject(worker->thread, INFINITE) != WAIT_OBJECT_0)
    scr_trap("scriptc: worker join failed\n");
#else
  if (pthread_join(worker->thread, NULL) != 0) scr_trap("scriptc: worker join failed\n");
#endif
  worker->joined = true;
}
#endif
