/* scriptc runtime — node:cluster (scr_cluster.c). Included by scr_runtime.h,
 * which says where new declarations go. */
#ifndef SCR_CLUSTER_H
#define SCR_CLUSTER_H

#include "scr_child.h"
#include "scr_lib.h"

/* ── node:cluster ─────────────────────────────────────────────────────
 * A compiled program has no script path to re-run, so a cluster worker is
 * the same native executable restarted with the entry module selected and
 * an IPC channel attached: fork() re-executes the artifact with the
 * runtime's private fork marker (target -1 selects the entry) and
 * NODE_UNIQUE_ID in the child's environment, the variable Node's own
 * worker bootstrap reads and then deletes. The primary keeps a registry of
 * worker handles; a worker handle is a checked-dynamic object (the
 * scr_dns_resolve.c Resolver model) whose members dispatch onto the child
 * handle it wraps.
 *
 * Message routing: cluster's own protocol messages travel on the same IPC
 * channel as user messages, marked { cmd: "NODE_CLUSTER", ... } exactly as
 * Node marks them. scr_child.c asks this unit whether a delivered message
 * is internal and, if so, hands it here instead of the user's 'message'
 * listeners. */

/* True in a process started by cluster.fork() (Node's own NODE_UNIQUE_ID
 * test at startup). Calls the lazy init, so a program that reads
 * cluster.isPrimary before anything else still sees worker mode. */
bool scr_cluster_is_worker(void);
bool scr_cluster_is_primary(void);
/* cluster.schedulingPolicy: SCHED_RR (2) everywhere but win32, SCHED_NONE
 * (1) there, unless NODE_CLUSTER_SCHED_POLICY says "none" or "rr". */
double scr_cluster_scheduling_policy(void);
/* Emitted at the top of %main by a program that names the cluster
 * surface: captures worker mode from NODE_UNIQUE_ID, installs the IPC
 * hooks, and (in a worker) sends the 'online' act and arms the channel,
 * which is what keeps a Node cluster worker alive. */
void scr_cluster_init(void);
/* cluster.fork([env]): restart this executable as worker `id`, with env
 * entries merged over this process's environment (Node's ToString
 * coercion, undefined dropped) plus NODE_UNIQUE_ID. Answers the worker
 * handle (+1). */
ScrDyn *scr_cluster_fork(const ScrDyn *env);
/* cluster.setupPrimary(options) / setupMaster: merge the options over the
 * defaults (args = process.argv.slice(2), exec = the executable,
 * execArgv = [], silent = false) and emit 'setup' on the next tick. The
 * options object is borrowed; NULL means the bare call. */
void scr_cluster_setup(const ScrDyn *options);
/* cluster.disconnect([callback]): disconnect every connected worker and
 * run the callback once the last one is gone (next tick when there are
 * none). The callback is a borrowed dynamic function. */
void scr_cluster_disconnect(const ScrDyn *callback);
/* cluster.settings (+1) and cluster.workers (+1, a snapshot object of the
 * live workers keyed by id). */
ScrDyn *scr_cluster_settings(void);
ScrDyn *scr_cluster_workers(void);
/* cluster.worker in a worker process (+1 worker handle), undefined in the
 * primary. */
ScrDyn *scr_cluster_worker_value(void);
/* cluster.on/once/off: the listener is a dynamic function. */
void scr_cluster_on(ScrStr *event, ScrDyn *listener, bool once);
void scr_cluster_off(const ScrStr *event, const ScrDyn *listener);

/* The IPC hooks scr_child.c calls for messages marked { cmd:
 * "NODE_CLUSTER" }. `scr_cluster_message_is_internal` answers whether a
 * delivered message is one of them; `scr_cluster_message_dispatch` handles
 * it (child NULL = this process's own channel). */
bool scr_cluster_message_is_internal(const ScrDyn *message);
void scr_cluster_message_dispatch(ScrChild *child, ScrDyn *message);

#endif /* SCR_CLUSTER_H */
