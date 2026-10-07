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
};

/* Consumes data, including on failure. Borrows the parent's mailbox. */
ScrWorkerThread *scr_worker_thread_start(ScrWorkerEntry entry, uint32_t root,
                                        ScrMessage *data, ScrMailbox *parent,
                                        ScrArr *arguments);
ScrWorkerThread *scr_worker_thread_retain(ScrWorkerThread *worker);
void scr_worker_thread_release(ScrWorkerThread *worker);
/* Join is owner-only and idempotent. The caller holds a reference. */
void scr_worker_thread_join(ScrWorkerThread *worker);
void scr_worker_thread_terminate(ScrWorkerThread *worker);
uint64_t scr_worker_thread_id(const ScrWorkerThread *worker);
/* Posting consumes the message even after the destination has closed. */
bool scr_worker_thread_post(ScrWorkerThread *worker, ScrMessage *message);
bool scr_worker_post_parent(ScrMessage *message);
void scr_worker_port_close(void);
/* Current-thread access: inbox is borrowed, data is a retained local value. */
ScrMailbox *scr_worker_inbox(void);
ScrDyn *scr_worker_data(void);
ScrDyn *scr_worker_parent_port(void);
ScrDyn *scr_worker_new(double root, ScrStr *filename, ScrDyn *options);
int scr_worker_argc(void);
char **scr_worker_argv(void);
void scr_loop_set_workers(bool (*pending)(void), bool (*ready)(void), void (*dispatch)(void),
                          int (*pollfd)(void), void (*wait)(double));

#endif
