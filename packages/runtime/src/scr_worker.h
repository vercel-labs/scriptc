#ifndef SCR_WORKER_H
#define SCR_WORKER_H

#include "scr_mailbox.h"

/* A thread carries only neutral transport state and an immutable compiled
 * entry point. Script-visible handles and listeners stay in their owner's
 * runtime heap. The entry initializes that thread's runtime before user code;
 * the thread wrapper drains its context before publishing the exit event. */
typedef struct ScrWorkerThread ScrWorkerThread;
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
};

/* Consumes data, including on failure. Borrows the parent's mailbox. With
 * environment_data, data encodes [workerData, environment entries]. A
 * stack_size of 0 selects the default 8 MiB thread stack. capture (1
 * stdout, 2 stderr) posts the worker's writes to those descriptors to the
 * parent as SCR_WORKER_STDOUT/STDERR events; 4 (stdin) has the worker's
 * process.stdin read what scr_worker_thread_post_stdin sends. */
ScrWorkerThread *scr_worker_thread_start(ScrWorkerEntry entry, uint32_t root,
                                        ScrMessage *data, bool environment_data,
                                        ScrMailbox *parent, ScrArr *arguments,
                                        size_t stack_size, const ScrStr *name,
                                        unsigned capture);
ScrWorkerThread *scr_worker_thread_retain(ScrWorkerThread *worker);
void scr_worker_thread_release(ScrWorkerThread *worker);
/* Join is owner-only and idempotent. The caller holds a reference. */
void scr_worker_thread_join(ScrWorkerThread *worker);
void scr_worker_thread_terminate(ScrWorkerThread *worker);
uint64_t scr_worker_thread_id(const ScrWorkerThread *worker);
/* The Worker's threadName (immortal, owned by the thread record). */
const ScrStr *scr_worker_thread_name(const ScrWorkerThread *worker);
/* Posting consumes the message even after the destination has closed. */
bool scr_worker_thread_post(ScrWorkerThread *worker, ScrMessage *message);
/* A worker.stdin chunk (data copied), or with end the end of the input.
 * False once the worker's inbox has closed. */
bool scr_worker_thread_post_stdin(ScrWorkerThread *worker, const void *data, size_t len, bool end);
/* The worker event unit's function that starts a worker's event dispatch,
 * which queues the stdin chunks. The unit stores it before it starts a
 * worker with the stdin option; that worker installs it as
 * scr_stdin_fed_attach. */
void scr_worker_set_stdin_attach(void (*attach)(void));
bool scr_worker_post_parent(ScrMessage *message);
void scr_worker_port_close(void);
/* Current-thread access: inbox is borrowed, data is a retained local value. */
ScrMailbox *scr_worker_inbox(void);
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
