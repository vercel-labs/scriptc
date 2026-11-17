#ifndef SCR_WORKER_H
#define SCR_WORKER_H

#include "scr_mailbox.h"

/* A thread carries only neutral transport state and an immutable compiled
 * entry point. Script-visible handles and listeners stay in their owner's
 * runtime heap. The entry initializes that thread's runtime before user code;
 * the thread wrapper drains its context before publishing the exit event. */
typedef struct ScrWorkerThread ScrWorkerThread;
/* The thread's process.env (scr_context.c under SCR_WORKERS). Named here so
 * the start prototype compiles in every configuration. */
typedef struct ScrContextEnv ScrContextEnv;
typedef int (*ScrWorkerEntry)(uint32_t root);

enum {
  SCR_WORKER_ONLINE = 1,
  SCR_WORKER_MESSAGE,
  SCR_WORKER_ERROR,
  SCR_WORKER_EXIT,
  SCR_WORKER_WAKE,
  SCR_WORKER_STDOUT,
  SCR_WORKER_STDERR,
  SCR_WORKER_STDIN, /* parent to worker: a worker.stdin chunk, or its end (no data) */
  /* worker.cpuUsage(): the parent asks the worker thread to measure its
   * own CPU usage, and the worker answers with {user, system} microseconds
   * in the event's data. `code` carries the request's sequence number. */
  SCR_WORKER_CPUTIME,
  SCR_WORKER_CPUTIME_RESULT,
};

/* Consumes data, including on failure. Borrows the parent's mailbox. With
 * environment_data, data encodes [workerData, environment entries]. A
 * stack_size of 0 selects the default 8 MiB thread stack. limits are the
 * resourceLimits the constructor asked for, in Node's key order (young,
 * old, codeRange, stack); the thread record keeps them for the worker's own
 * resourceLimits read. capture (1 stdout, 2 stderr) posts the worker's
 * writes to those descriptors to the parent as SCR_WORKER_STDOUT/STDERR
 * events; 4 (stdin) has the worker's process.stdin read what
 * scr_worker_thread_post_stdin sends. environment,
 * when not NULL, is the thread's process.env and the thread record owns it;
 * otherwise the thread captures a copy of the parent's. share_environment
 * skips both: the thread reads and writes the process environment itself,
 * as worker_threads.SHARE_ENV asks. */
ScrWorkerThread *scr_worker_thread_start(ScrWorkerEntry entry, uint32_t root,
                                        ScrMessage *data, bool environment_data,
                                        ScrMailbox *parent, ScrArr *arguments,
                                        size_t stack_size, const double limits[4],
                                        const ScrStr *name, unsigned capture,
                                        ScrContextEnv *environment, bool share_environment);
ScrWorkerThread *scr_worker_thread_retain(ScrWorkerThread *worker);
void scr_worker_thread_release(ScrWorkerThread *worker);
/* Join is owner-only and idempotent. The caller holds a reference. */
void scr_worker_thread_join(ScrWorkerThread *worker);
void scr_worker_thread_terminate(ScrWorkerThread *worker);
uint64_t scr_worker_thread_id(const ScrWorkerThread *worker);
/* The Worker's threadName, owned by the thread record and freed with it:
 * callers copy it into the strings they return. */
const ScrStr *scr_worker_thread_name(const ScrWorkerThread *worker);
/* Posting consumes the message even after the destination has closed. */
bool scr_worker_thread_post(ScrWorkerThread *worker, ScrMessage *message);
/* A worker.stdin chunk (data copied), or with end the end of the input.
 * False once the worker's inbox has closed. */
bool scr_worker_thread_post_stdin(ScrWorkerThread *worker, const void *data, size_t len, bool end);
/* worker.performance: the worker's last published loop metrics (its loop
 * start and idle time in milliseconds on the process timeline), false
 * before its loop has turned. Any thread holding a reference may read. */
bool scr_worker_thread_metrics(ScrWorkerThread *worker, double *loop_start_ms, double *idle_ms);
/* worker.cpuUsage(): asks the worker's thread to measure its own CPU usage
 * (false once the worker's inbox closed), and answers from that thread with
 * the two microsecond values. The answer carries `seq`. */
bool scr_worker_thread_post_cputime(ScrWorkerThread *worker, int seq);
bool scr_worker_post_parent_cputime(int seq, uint64_t user_us, uint64_t system_us);
/* The calling thread's own CPU usage, user and system in microseconds. */
void scr_worker_thread_cpu_usage(uint64_t *user_us, uint64_t *system_us);
/* The worker event unit's function that starts a worker's event dispatch,
 * which queues the stdin chunks. The unit stores it before it starts a
 * worker with the stdin option; that worker installs it as
 * scr_stdin_fed_attach. */
void scr_worker_set_stdin_attach(void (*attach)(void));
bool scr_worker_post_parent(ScrMessage *message);
void scr_worker_port_close(void);
/* Current-thread access: inbox is borrowed, data is a retained local value. */
ScrMailbox *scr_worker_inbox(void);
/* The limits this thread's Worker was created with, false in the main
 * thread. */
bool scr_worker_thread_current_limits(double out[4]);
/* The worker event unit's function that installs a worker thread's own
 * machinery before its script runs (scr_worker_events.c), so the thread
 * answers its creator's worker.cpuUsage() even when the script never names
 * worker_threads. NULL when that unit is not linked. */
void scr_worker_set_events_attach(void (*attach)(void));
/* The worker event unit's function that releases a worker thread's
 * worker-event state at its exit, before the reference-count audit runs
 * (scr_worker_events.c). NULL when that unit is not linked. */
void scr_worker_set_events_detach(void (*detach)(void));
/* The parent's environment data entries ([key, value, ...], +1) on the
 * first call in a worker; NULL afterwards, in the main thread, when the
 * parent had none, and after a throw. */
ScrDyn *scr_worker_take_environment(void);
void scr_loop_set_workers(bool (*pending)(void), bool (*ready)(void), void (*dispatch)(void),
                          int (*pollfd)(void), void (*wait)(double));
/* After a dispatch: true keeps the loop pass delivering (a MessagePort poll
 * phase in progress), with microtasks drained between events. */
void scr_loop_set_workers_more(bool (*more)(void));

#endif
