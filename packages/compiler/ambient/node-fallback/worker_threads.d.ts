/// <reference path="./stream.d.ts" />

/* node:worker_threads — native workers use statically compiled entry points.
 * Lowering and runtime diagnostics define the supported options and methods. */
declare module "worker_threads" {
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
  export interface WorkerOptions {
    workerData?: unknown;
    transferList?: readonly unknown[];
    argv?: readonly unknown[];
    name?: string;
    resourceLimits?: ResourceLimits;
    stdout?: boolean;
    stderr?: boolean;
    stdin?: boolean;
    [option: string]: unknown;
  }
  export class Worker {
    constructor(filename: string | URL, options?: WorkerOptions);
    readonly threadId: number;
    readonly resourceLimits?: ResourceLimits;
    readonly threadName: string | null;
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
    ref(): void;
    unref(): void;
    terminate(): Promise<number>;
    removeAllListeners(event?: string): this;
    listenerCount(event: string, listener?: (...args: any[]) => void): number;
  }
  export class MessagePort {
    on(event: "message", listener: (value: any) => void): this;
    on(event: "close", listener: () => void): this;
    on(event: string, listener: (...args: any[]) => void): this;
    once(event: string, listener: (...args: any[]) => void): this;
    off(event: string, listener: (...args: any[]) => void): this;
    addListener(event: string, listener: (...args: any[]) => void): this;
    removeListener(event: string, listener: (...args: any[]) => void): this;
    prependListener(event: string, listener: (...args: any[]) => void): this;
    prependOnceListener(event: string, listener: (...args: any[]) => void): this;
    postMessage(value: unknown, transferList?: readonly unknown[]): void;
    start(): void;
    close(callback?: () => void): void;
    ref(): void;
    unref(): void;
    hasRef(): boolean;
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
}

declare module "node:worker_threads" {
  export * from "worker_threads";
}
