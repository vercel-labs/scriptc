import type { IrLibFn } from "../builtin-signatures.js";

/** The builtins in the cluster module decided never to throw. */
export const clusterNeverThrow: readonly IrLibFn[] = [
  // node:cluster's process state (scr_cluster.c): the worker probe, the
  // scheduling policy read, and the settings/workers/worker value reads
  // answer the runtime's own state and allocate their result; none runs
  // program code or raises a catchable error. (fork, setup, disconnect and
  // the event registration validate their arguments and are MAY_THROW.)
  "cluster.init",
  "cluster.isPrimary",
  "cluster.isWorker",
  "cluster.schedulingPolicy",
  "cluster.settings",
  "cluster.workers",
  "cluster.worker",
];
