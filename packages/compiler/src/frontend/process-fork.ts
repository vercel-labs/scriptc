/** Process primitives for forked lowering workers (unit-journal.ts). The
 * native compiler fills these in; under Node they stay unset and reachable
 * emit lowers every wave in-process. */
export interface ProcessFork {
  /** fork(): 0 in the worker, the worker's pid in the parent, -1 on failure. */
  fork(): number;
  /** Ends the worker without running exit handlers. */
  exit(code: number): void;
  /** The worker's exit status, 128 plus a signal number, or -1. */
  wait(pid: number): number;
  /** Opens the lock file checker requests from workers take. */
  openLock(path: string): boolean;
  lock(): void;
  unlock(): void;
}

export const processFork: {
  primitives: ProcessFork | null;
  /** True in a worker: checker requests take the lock (rpc-client.ts). */
  worker: boolean;
  /** A worker's checker requests and the time it waited for the lock and
   * for responses (SCRIPTC_TIMING). */
  requests: number;
  lockWaitMs: number;
  requestMs: number;
} = { primitives: null, worker: false, requests: 0, lockWaitMs: 0, requestMs: 0 };
