/// <reference path="./stream.d.ts" />

/* node:worker_threads — native workers use statically compiled entry points.
 * Lowering and runtime diagnostics define the supported options and methods. */
declare module "worker_threads" {
  import { EventEmitter } from "events";
  export const isMainThread: boolean;
  export const isInternalThread: boolean;
  export const threadId: number;
  export interface ResourceLimits {
    maxYoungGenerationSizeMb?: number;
    maxOldGenerationSizeMb?: number;
    codeRangeSizeMb?: number;
    stackSizeMb?: number;
  }
  /* {} in the main thread */
  export const resourceLimits: ResourceLimits;
  /* the Worker's name option, trimmed ("WorkerThread" by default); "" in the main thread */
  export const threadName: string | null;
  /* The env option value that makes a Worker read and write this process's
   * environment instead of a copy: env: SHARE_ENV. */
  export const SHARE_ENV: unique symbol;
  export interface WorkerOptions {
    workerData?: unknown;
    transferList?: readonly unknown[];
    argv?: readonly unknown[];
    /* A copy of these entries becomes the worker's process.env; omitted or
     * null copies this thread's environment. */
    env?: { [key: string]: string | number | boolean | undefined } | null | typeof SHARE_ENV;
    name?: string;
    resourceLimits?: ResourceLimits;
    stdout?: boolean;
    stderr?: boolean;
    stdin?: boolean;
    [option: string]: unknown;
  }
  /* worker.performance.eventLoopUtilization: the worker thread's own event
   * loop utilization, read from the thread's last loop turn. */
  export interface WorkerEventLoopUtilization {
    idle: number;
    active: number;
    utilization: number;
  }
  export interface WorkerPerformance {
    eventLoopUtilization(
      utilization1?: WorkerEventLoopUtilization,
      utilization2?: WorkerEventLoopUtilization,
    ): WorkerEventLoopUtilization;
  }
  /* A Worker extends EventEmitter, not the EventTarget shape a port has: the
   * full EventEmitter surface (emit, eventNames, the meta events, duplicate
   * registrations, multi-argument emit) is present, and the seeded
   * 'newListener'/'removeListener' listeners fire. */
  export class Worker extends EventEmitter {
    constructor(filename: string | URL, options?: WorkerOptions);
    readonly threadId: number;
    readonly resourceLimits?: ResourceLimits;
    readonly threadName: string | null;
    /* an object holding the worker thread's eventLoopUtilization */
    readonly performance: WorkerPerformance;
    /* with the stdout/stderr options: the worker's writes to those streams */
    readonly stdout: import("stream").Readable;
    readonly stderr: import("stream").Readable;
    /* with the stdin option: what the worker reads from process.stdin */
    readonly stdin: import("stream").Writable | null;
    /* terminate(), resolving with undefined once the worker exited */
    [Symbol.asyncDispose](): Promise<void>;
    on(event: "online", listener: () => void): this;
    on(event: "message", listener: (value: any) => void): this;
    on(event: "error", listener: (error: any) => void): this;
    on(event: "exit", listener: (code: number) => void): this;
    on(event: string, listener: (...args: any[]) => void): this;
    once(event: string, listener: (...args: any[]) => void): this;
    off(event: string, listener: (...args: any[]) => void): this;
    addListener(event: string, listener: (...args: any[]) => void): this;
    removeListener(event: string, listener: (...args: any[]) => void): this;
    prependListener(event: string, listener: (...args: any[]) => void): this;
    prependOnceListener(event: string, listener: (...args: any[]) => void): this;
    postMessage(value: unknown, transferList?: readonly unknown[]): void;
    /* the worker thread's own CPU usage (process.threadCpuUsage's values),
     * a rejection with ERR_WORKER_NOT_RUNNING before 'online' or after exit */
    cpuUsage(prev?: { user: number; system: number }): Promise<{ user: number; system: number }>;
    ref(): void;
    unref(): void;
    terminate(): Promise<number>;
    removeAllListeners(event?: string): this;
    listenerCount(event: string, listener?: (...args: any[]) => void): number;
  }
  /* A port is a NodeEventTarget: its listeners live in an emitter registry
   * shared by the EventEmitter and EventTarget spellings. */
  export class MessagePort extends EventTarget {
    on(event: "message", listener: (value: any) => void): this;
    on(event: "close", listener: () => void): this;
    on(event: string, listener: (...args: any[]) => void): this;
    once(event: string, listener: (...args: any[]) => void): this;
    off(event: string, listener: (...args: any[]) => void): this;
    addListener(event: string, listener: (...args: any[]) => void): this;
    removeListener(event: string, listener: (...args: any[]) => void): this;
    prependListener(event: string, listener: (...args: any[]) => void): this;
    prependOnceListener(event: string, listener: (...args: any[]) => void): this;
    /* The target's raw dispatch: one argument, extra arguments ignored. */
    emit(event: string, ...args: any[]): boolean;
    eventNames(): string[];
    getMaxListeners(): number;
    setMaxListeners(n: number): this;
    postMessage(value: unknown, transferList?: readonly unknown[]): void;
    start(): void;
    close(callback?: () => void): void;
    ref(): void;
    unref(): void;
    hasRef(): boolean;
    /* The EventTarget form of the events: a MessageEvent for 'message'. */
    onmessage: ((event: MessageEvent) => void) | null;
    onmessageerror: ((event: MessageEvent) => void) | null;
    removeAllListeners(event?: string): this;
    listenerCount(event: string, listener?: (...args: any[]) => void): number;
  }
  /* Two entangled ports; a port moves to another thread through a
   * postMessage or workerData transferList. */
  export class MessageChannel {
    readonly port1: MessagePort;
    readonly port2: MessagePort;
  }
  export function receiveMessageOnPort(port: MessagePort): { message: any } | undefined;
  /* This thread's environment data; each new Worker starts from a clone. */
  export function setEnvironmentData(key: any, value?: any): void;
  export function getEnvironmentData(key: any): any;
  /* A marked object cannot be listed in a transfer list. */
  export function markAsUntransferable(object: any): void;
  /* structuredClone and postMessage throw DataCloneError for a marked
   * object, error or class instance */
  export function markAsUncloneable(object: any): void;
  export function isMarkedAsUntransferable(object: any): boolean;
  /* Delivers each message to every other open channel with the name, in
   * any thread, as a 'message' MessageEvent. */
  export class BroadcastChannel extends EventTarget {
    constructor(name: string);
    readonly name: string;
    onmessage: ((event: MessageEvent) => void) | null;
    onmessageerror: ((event: MessageEvent) => void) | null;
    postMessage(message: unknown): void;
    close(): void;
    ref(): this;
    unref(): this;
  }
  export const parentPort: MessagePort | null;
  export const workerData: any;
  /* The Web Locks manager: one lock store for the process, shared by every
   * thread. request() runs the callback while the lock is held and resolves
   * with { name, mode } once the callback's result settles; query() answers
   * this client's held and pending locks. A lock's name is converted with
   * ToString and may not start with "-". */
  export interface Lock {
    readonly name: string;
    readonly mode: "exclusive" | "shared";
  }
  export interface LockOptions {
    mode?: "exclusive" | "shared";
    ifAvailable?: boolean;
    steal?: boolean;
    signal?: AbortSignal;
  }
  export interface LockManagerSnapshot {
    held: Lock[];
    pending: Lock[];
  }
  export interface LockManager {
    /* The promise answers the callback's own result once the callback
     * finished holding the lock; the result is checked-dynamic. */
    request(name: string, callback: (lock: Lock) => unknown): Promise<any>;
    request(name: string, options: LockOptions, callback: (lock: Lock) => unknown): Promise<any>;
    query(): Promise<LockManagerSnapshot>;
  }
  export const locks: LockManager;
}

declare module "node:worker_threads" {
  export * from "worker_threads";
}
