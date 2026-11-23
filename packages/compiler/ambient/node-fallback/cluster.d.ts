/* node:cluster — primary/worker process management (scr_cluster.c).
 *
 * A cluster worker is this native executable restarted with the entry
 * module selected and an IPC channel attached; cluster.fork() does that,
 * so isPrimary/isWorker are runtime values in a compiled program. Worker
 * instances are checked-dynamic handles: their members (send, disconnect,
 * kill, isConnected, isDead, on/once/off) dispatch at run time.
 *
 * Servlet sharing is not modeled: a worker that listens has its own
 * socket rather than a handle shared by the primary ('listening' events
 * do not fire). */
declare module "cluster" {
  export interface ClusterSettings {
    /** The arguments a worker starts with (process.argv.slice(2)). */
    args?: string[];
    /** Always this executable: a compiled worker re-runs the artifact. */
    exec?: string;
    /** Accepted and stored; workers start from the executable's own
     * arguments. */
    execArgv?: string[];
    /** Pipe the workers' stdio instead of inheriting it. */
    silent?: boolean;
    cwd?: string;
    env?: { [key: string]: string | number | boolean | undefined };
    [option: string]: unknown;
  }

  /* A worker process. Extends EventEmitter, whose surface is the events
   * below plus on/once/off/addListener/removeListener. */
  export interface Worker {
    /** The worker's unique id (1, 2, ... in fork order). */
    readonly id: number;
    /** The underlying child process (a ChildProcess in the primary). */
    readonly process: import("child_process").ChildProcess;
    /** True once the worker was disconnected on purpose. */
    readonly exitedAfterDisconnect: boolean | undefined;
    readonly state: "none" | "online" | "listening" | "disconnected" | "dead";
    send(message: unknown): boolean;
    send(message: unknown, callback: (error: Error | null) => void): boolean;
    /** Close the worker's IPC channel and let it exit gracefully. */
    disconnect(): this;
    /** Send SIGTERM (or `signal`) to the worker. */
    kill(signal?: string): void;
    isConnected(): boolean;
    isDead(): boolean;
    on(event: "online", listener: () => void): this;
    on(event: "listening", listener: (address: unknown) => void): this;
    on(event: "message", listener: (message: any, handle: any) => void): this;
    on(event: "disconnect", listener: () => void): this;
    on(event: "exit", listener: (code: number | null, signal: string | null) => void): this;
    on(event: "error", listener: (error: Error) => void): this;
    on(event: string, listener: (...args: any[]) => void): this;
    once(event: string, listener: (...args: any[]) => void): this;
    off(event: string, listener: (...args: any[]) => void): this;
    addListener(event: string, listener: (...args: any[]) => void): this;
    removeListener(event: string, listener: (...args: any[]) => void): this;
  }

  export const isPrimary: boolean;
  /** Deprecated alias of isPrimary. */
  export const isMaster: boolean;
  export const isWorker: boolean;

  /** SCHED_NONE: the primary keeps no dispatcher (the OS distributes). */
  export const SCHED_NONE: number;
  /** SCHED_RR: the primary distributes connections round-robin. Accepted
   * and reported; a compiled program's workers do not share a listening
   * socket, so the policy is not exercised. */
  export const SCHED_RR: number;
  export const schedulingPolicy: number;

  /** The settings setupPrimary() exposes; `{}` until the first call. */
  export const settings: any;
  /** The live workers by id (a snapshot object per read). */
  export const workers: any;
  /** This process's own worker handle in a worker, undefined in the
   * primary. */
  export const worker: any;

  /** Start a worker process (this executable, entry module). */
  export function fork(env?: { [key: string]: string | number | boolean | undefined }): Worker;
  /** Merge settings for the workers the primary starts. */
  export function setupPrimary(settings?: ClusterSettings): void;
  /** Deprecated alias of setupPrimary. */
  export function setupMaster(settings?: ClusterSettings): void;
  /** Disconnect every connected worker; the callback runs once the last
   * one is gone. */
  export function disconnect(callback?: () => void): void;

  export function on(
    event: "fork" | "online" | "disconnect",
    listener: (worker: Worker) => void,
  ): unknown;
  export function on(
    event: "listening",
    listener: (worker: Worker, address: unknown) => void,
  ): unknown;
  export function on(
    event: "message",
    listener: (worker: Worker, message: any, handle: any) => void,
  ): unknown;
  export function on(
    event: "exit",
    listener: (worker: Worker, code: number | null, signal: string | null) => void,
  ): unknown;
  export function on(event: "setup", listener: (settings: ClusterSettings) => void): unknown;
  export function on(event: string, listener: (...args: any[]) => void): unknown;
  export function once(event: string, listener: (...args: any[]) => void): unknown;
  export function off(event: string, listener: (...args: any[]) => void): unknown;
  export function addListener(event: string, listener: (...args: any[]) => void): unknown;
  export function removeListener(event: string, listener: (...args: any[]) => void): unknown;
}

declare module "node:cluster" {
  export * from "cluster";
}
