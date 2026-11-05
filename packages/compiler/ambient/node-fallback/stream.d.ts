/// <reference path="./events.d.ts" />

/* node:stream — the static stream classes (runtime-provided, the
 * EventEmitter-hierarchy precedent). Phase 1 is the OPTIONS-OBJECT
 * constructor surface: `new Readable({ read() {} })`, `new Writable({
 * write(chunk, enc, cb) {} })`, Duplex/Transform/PassThrough, push/read,
 * flowing vs paused, write/end backpressure + 'drain', pipe/unpipe, and
 * destroy — with Node's event orderings. Chunks are BYTES (Buffer), with
 * strings converted at push/write like Node, and any value on an
 * object-mode side (objectMode, readableObjectMode, writableObjectMode —
 * the object-mode constructor overloads come first). The runtime-fired
 * events carry per-class FORCED argument tuples ('data' is one chunk,
 * 'error' one Error, 'pipe'/'unpipe' one Readable, the rest empty) — the
 * overloads below hand tsc the same contract so unannotated listener
 * parameters contextually type in .js sources. */
declare module "stream" {
  import { EventEmitter } from "events";

  interface ReadableOptions {
    highWaterMark?: number;
    encoding?: string;
    objectMode?: boolean;
    read?(this: Readable, size: number): void;
    destroy?(this: Readable, error: Error | null, callback: (error?: Error | null) => void): void;
    construct?(this: Readable, callback: (error?: Error | null) => void): void;
    autoDestroy?: boolean;
    emitClose?: boolean;
    captureRejections?: boolean;
    defaultEncoding?: string;
    signal?: AbortSignal;
  }
  interface WritableOptions {
    highWaterMark?: number;
    decodeStrings?: boolean;
    defaultEncoding?: string;
    objectMode?: boolean;
    write?(
      this: Writable,
      chunk: Buffer,
      encoding: string,
      callback: (error?: Error | null) => void,
    ): void;
    writev?(
      this: Writable,
      chunks: Array<{ chunk: any; encoding: string }>,
      callback: (error?: Error | null) => void,
    ): void;
    final?(this: Writable, callback: (error?: Error | null) => void): void;
    destroy?(this: Writable, error: Error | null, callback: (error?: Error | null) => void): void;
    construct?(this: Writable, callback: (error?: Error | null) => void): void;
    autoDestroy?: boolean;
    emitClose?: boolean;
    captureRejections?: boolean;
    signal?: AbortSignal;
  }
  interface DuplexOptions {
    highWaterMark?: number;
    readableHighWaterMark?: number;
    writableHighWaterMark?: number;
    encoding?: string;
    decodeStrings?: boolean;
    objectMode?: boolean;
    readableObjectMode?: boolean;
    writableObjectMode?: boolean;
    allowHalfOpen?: boolean;
    read?(this: Duplex, size: number): void;
    write?(
      this: Duplex,
      chunk: Buffer,
      encoding: string,
      callback: (error?: Error | null) => void,
    ): void;
    final?(this: Duplex, callback: (error?: Error | null) => void): void;
    destroy?(this: Duplex, error: Error | null, callback: (error?: Error | null) => void): void;
    construct?(this: Duplex, callback: (error?: Error | null) => void): void;
    autoDestroy?: boolean;
    emitClose?: boolean;
    captureRejections?: boolean;
    readable?: boolean;
    writable?: boolean;
    defaultEncoding?: string;
    writev?(
      this: Duplex,
      chunks: Array<{ chunk: any; encoding: string }>,
      callback: (error?: Error | null) => void,
    ): void;
    signal?: AbortSignal;
  }
  interface TransformOptions {
    highWaterMark?: number;
    readableHighWaterMark?: number;
    writableHighWaterMark?: number;
    encoding?: string;
    decodeStrings?: boolean;
    objectMode?: boolean;
    readableObjectMode?: boolean;
    writableObjectMode?: boolean;
    allowHalfOpen?: boolean;
    transform?(
      this: Transform,
      chunk: Buffer,
      encoding: string,
      callback: (error?: Error | null, data?: Buffer | string) => void,
    ): void;
    flush?(this: Transform, callback: (error?: Error | null, data?: Buffer | string) => void): void;
    destroy?(this: Transform, error: Error | null, callback: (error?: Error | null) => void): void;
    construct?(this: Transform, callback: (error?: Error | null) => void): void;
    read?(this: Transform, size: number): void;
    write?(
      this: Transform,
      chunk: Buffer,
      encoding: string,
      callback: (error?: Error | null) => void,
    ): void;
    final?(this: Transform, callback: (error?: Error | null) => void): void;
    writev?(this: Transform, chunks: unknown[], callback: (error?: Error | null) => void): void;
    autoDestroy?: boolean;
    emitClose?: boolean;
    captureRejections?: boolean;
    readable?: boolean;
    writable?: boolean;
    defaultEncoding?: string;
    signal?: AbortSignal;
  }

  /* Object-mode options (objectMode: true, or a Duplex's or Transform's
   * readableObjectMode / writableObjectMode): chunks and completion data
   * are any values, and an object-mode write's encoding argument reaches
   * write/transform as passed (undefined when absent, null when a
   * callback took its place). The constructors take these before the
   * byte-mode options, so a byte-mode stream's callbacks keep Buffer
   * chunks. */
  type ObjectModeEncoding = string | null | undefined;
  type ObjectModeFlag =
    | { objectMode: true }
    | { readableObjectMode: true }
    | { writableObjectMode: true };
  interface ObjectWritableOptions extends Omit<WritableOptions, "objectMode" | "write"> {
    objectMode: true;
    write?(
      this: Writable,
      chunk: any,
      encoding: ObjectModeEncoding,
      callback: (error?: Error | null) => void,
    ): void;
  }
  type ObjectDuplexOptions = Omit<DuplexOptions, "write"> & {
    write?(
      this: Duplex,
      chunk: any,
      encoding: ObjectModeEncoding,
      callback: (error?: Error | null) => void,
    ): void;
  } & ObjectModeFlag;
  type ObjectTransformOptions = Omit<TransformOptions, "transform" | "flush" | "write"> & {
    transform?(
      this: Transform,
      chunk: any,
      encoding: ObjectModeEncoding,
      callback: (error?: Error | null, data?: any) => void,
    ): void;
    flush?(this: Transform, callback: (error?: Error | null, data?: any) => void): void;
    write?(
      this: Transform,
      chunk: any,
      encoding: ObjectModeEncoding,
      callback: (error?: Error | null) => void,
    ): void;
  } & ObjectModeFlag;

  /* decodeStrings: false — a string write reaches write/transform as the
   * string with its encoding (Buffers keep 'buffer'). */
  interface StringWritableOptions extends Omit<WritableOptions, "decodeStrings" | "write"> {
    decodeStrings: false;
    write?(
      this: Writable,
      chunk: string | Buffer,
      encoding: string,
      callback: (error?: Error | null) => void,
    ): void;
  }
  type StringDuplexOptions = Omit<DuplexOptions, "decodeStrings" | "write"> & {
    decodeStrings: false;
    write?(
      this: Duplex,
      chunk: string | Buffer,
      encoding: string,
      callback: (error?: Error | null) => void,
    ): void;
  };
  type StringTransformOptions = Omit<TransformOptions, "decodeStrings" | "transform"> & {
    decodeStrings: false;
    transform?(
      this: Transform,
      chunk: string | Buffer,
      encoding: string,
      callback: (error?: Error | null, data?: Buffer | string) => void,
    ): void;
  };

  /* The operators' options: concurrency and highWaterMark bound map's
   * in-flight callbacks and queued results. */
  interface ArrayOptions {
    concurrency?: number;
    highWaterMark?: number;
    signal?: AbortSignal;
  }

  class Readable extends EventEmitter {
    constructor(opts?: ReadableOptions);
    /* The underscore-method surface (@types/node declares these on the
     * classes; assigning them post-construction shadows the prototype
     * method and the machinery calls through the assignment — lowered
     * onto the option-callback slots). */
    _read(size: number): void;
    _destroy(error: Error | null, callback: (error?: Error | null) => void): void;
    [Symbol.asyncIterator](): AsyncIterableIterator<any>;
    iterator(options?: { destroyOnReturn?: boolean }): AsyncIterableIterator<any>;
    /* compose(this, stage), destroyed when options.signal aborts. */
    compose(stage: ComposeStage, options?: { signal: AbortSignal }): Duplex;
    push(chunk: Buffer | string | null, encoding?: string): boolean;
    /* An object-mode stream's values. */
    push(chunk: any, encoding?: string): boolean;
    unshift(chunk: Buffer | string, encoding?: string): void;
    unshift(chunk: any, encoding?: string): void;
    /* A Buffer, a string once encoded, an object-mode value, or null (as
     * @types/node types it). */
    read(size?: number): any;
    pause(): this;
    resume(): this;
    isPaused(): boolean;
    setEncoding(encoding: string): this;
    pipe<T extends NodeJS.WritableStream>(destination: T, options?: { end?: boolean }): T;
    unpipe(destination?: NodeJS.WritableStream): this;
    destroy(error?: Error): this;
    readonly readable: boolean;
    readonly readableEnded: boolean;
    readonly readableFlowing: boolean | null;
    readonly readableLength: number;
    readonly readableHighWaterMark: number;
    readonly readableObjectMode: boolean;
    readonly closed: boolean;
    readonly destroyed: boolean;
    readonly errored: Error | null;
    static from(iterable: unknown, options?: ReadableOptions): Readable;
    /* A Readable over a web ReadableStream's reader. */
    static fromWeb(
      readableStream: globalThis.ReadableStream,
      options?: {
        encoding?: string;
        highWaterMark?: number;
        objectMode?: boolean;
        signal?: AbortSignal;
      },
    ): Readable;
    /* The Readable operators: chunks are strings or Buffers, map and
     * flatMap callbacks return strings or Buffers (flatMap: arrays of
     * them, or strings), and callbacks that declare the options argument
     * are refused. */
    map(
      fn: (data: any, options?: Pick<ArrayOptions, "signal">) => any,
      options?: ArrayOptions,
    ): Readable;
    filter(
      fn: (data: any, options?: Pick<ArrayOptions, "signal">) => boolean | Promise<boolean>,
      options?: ArrayOptions,
    ): Readable;
    forEach(
      fn: (data: any, options?: Pick<ArrayOptions, "signal">) => void | Promise<void>,
      options?: ArrayOptions,
    ): Promise<void>;
    toArray(options?: Pick<ArrayOptions, "signal">): Promise<any[]>;
    some(
      fn: (data: any, options?: Pick<ArrayOptions, "signal">) => boolean | Promise<boolean>,
      options?: ArrayOptions,
    ): Promise<boolean>;
    find(
      fn: (data: any, options?: Pick<ArrayOptions, "signal">) => boolean | Promise<boolean>,
      options?: ArrayOptions,
    ): Promise<any>;
    every(
      fn: (data: any, options?: Pick<ArrayOptions, "signal">) => boolean | Promise<boolean>,
      options?: ArrayOptions,
    ): Promise<boolean>;
    flatMap(
      fn: (data: any, options?: Pick<ArrayOptions, "signal">) => any,
      options?: ArrayOptions,
    ): Readable;
    drop(limit: number, options?: Pick<ArrayOptions, "signal">): Readable;
    take(limit: number, options?: Pick<ArrayOptions, "signal">): Readable;
    reduce<T = any>(
      fn: (previous: any, data: any, options?: Pick<ArrayOptions, "signal">) => T,
      initial?: undefined,
      options?: Pick<ArrayOptions, "signal">,
    ): Promise<T>;
    reduce<T = any>(
      fn: (previous: T, data: any, options?: Pick<ArrayOptions, "signal">) => T,
      initial: T,
      options?: Pick<ArrayOptions, "signal">,
    ): Promise<T>;
    on(event: "data", listener: (chunk: any) => void): this;
    on(event: "end" | "close" | "readable" | "pause" | "resume", listener: () => void): this;
    on(event: "error", listener: (err: Error) => void): this;
    on(event: string, listener: (...args: any[]) => void): this;
    once(event: "data", listener: (chunk: any) => void): this;
    once(event: "end" | "close" | "readable" | "pause" | "resume", listener: () => void): this;
    once(event: "error", listener: (err: Error) => void): this;
    once(event: string, listener: (...args: any[]) => void): this;
    addListener(event: "data", listener: (chunk: any) => void): this;
    addListener(
      event: "end" | "close" | "readable" | "pause" | "resume",
      listener: () => void,
    ): this;
    addListener(event: "error", listener: (err: Error) => void): this;
    addListener(event: string, listener: (...args: any[]) => void): this;
    prependListener(event: "data", listener: (chunk: any) => void): this;
    prependListener(
      event: "end" | "close" | "readable" | "pause" | "resume",
      listener: () => void,
    ): this;
    prependListener(event: "error", listener: (err: Error) => void): this;
    prependListener(event: string, listener: (...args: any[]) => void): this;
    prependOnceListener(event: "data", listener: (chunk: any) => void): this;
    prependOnceListener(
      event: "end" | "close" | "readable" | "pause" | "resume",
      listener: () => void,
    ): this;
    prependOnceListener(event: "error", listener: (err: Error) => void): this;
    prependOnceListener(event: string, listener: (...args: any[]) => void): this;
    off(event: "data", listener: (chunk: any) => void): this;
    off(event: "end" | "close" | "readable" | "pause" | "resume", listener: () => void): this;
    off(event: "error", listener: (err: Error) => void): this;
    off(event: string, listener: (...args: any[]) => void): this;
    removeListener(event: "data", listener: (chunk: any) => void): this;
    removeListener(
      event: "end" | "close" | "readable" | "pause" | "resume",
      listener: () => void,
    ): this;
    removeListener(event: "error", listener: (err: Error) => void): this;
    removeListener(event: string, listener: (...args: any[]) => void): this;
  }

  class Writable extends EventEmitter {
    constructor(opts: ObjectWritableOptions);
    constructor(opts: StringWritableOptions);
    constructor(opts?: WritableOptions);
    /* The underscore-method surface (see Readable). */
    _write(chunk: any, encoding: string, callback: (error?: Error | null) => void): void;
    _writev(
      chunks: Array<{ chunk: any; encoding: string }>,
      callback: (error?: Error | null) => void,
    ): void;
    _final(callback: (error?: Error | null) => void): void;
    _destroy(error: Error | null, callback: (error?: Error | null) => void): void;
    write(chunk: Buffer | string, callback?: (error?: Error | null) => void): boolean;
    write(
      chunk: Buffer | string,
      encoding: string,
      callback?: (error?: Error | null) => void,
    ): boolean;
    /* An object-mode stream's values (the encoding argument reaches
     * _write as passed). */
    write(chunk: any, callback?: (error?: Error | null) => void): boolean;
    write(
      chunk: any,
      encoding: ObjectModeEncoding,
      callback?: (error?: Error | null) => void,
    ): boolean;
    end(callback?: () => void): this;
    end(chunk: Buffer | string, callback?: () => void): this;
    end(chunk: Buffer | string, encoding: string, callback?: () => void): this;
    end(chunk: any, callback?: () => void): this;
    end(chunk: any, encoding: ObjectModeEncoding, callback?: () => void): this;
    cork(): void;
    uncork(): void;
    setDefaultEncoding(encoding: string): this;
    destroy(error?: Error): this;
    readonly writable: boolean;
    readonly writableEnded: boolean;
    readonly writableFinished: boolean;
    readonly writableLength: number;
    readonly writableHighWaterMark: number;
    readonly writableObjectMode: boolean;
    readonly writableNeedDrain: boolean;
    readonly writableCorked: number;
    readonly closed: boolean;
    readonly destroyed: boolean;
    readonly errored: Error | null;
    on(event: "drain" | "finish" | "close", listener: () => void): this;
    on(event: "error", listener: (err: Error) => void): this;
    on(event: "pipe" | "unpipe", listener: (src: Readable) => void): this;
    on(event: string, listener: (...args: any[]) => void): this;
    once(event: "drain" | "finish" | "close", listener: () => void): this;
    once(event: "error", listener: (err: Error) => void): this;
    once(event: "pipe" | "unpipe", listener: (src: Readable) => void): this;
    once(event: string, listener: (...args: any[]) => void): this;
    addListener(event: "drain" | "finish" | "close", listener: () => void): this;
    addListener(event: "error", listener: (err: Error) => void): this;
    addListener(event: "pipe" | "unpipe", listener: (src: Readable) => void): this;
    addListener(event: string, listener: (...args: any[]) => void): this;
    prependListener(event: "drain" | "finish" | "close", listener: () => void): this;
    prependListener(event: "error", listener: (err: Error) => void): this;
    prependListener(event: "pipe" | "unpipe", listener: (src: Readable) => void): this;
    prependListener(event: string, listener: (...args: any[]) => void): this;
    prependOnceListener(event: "drain" | "finish" | "close", listener: () => void): this;
    prependOnceListener(event: "error", listener: (err: Error) => void): this;
    prependOnceListener(event: "pipe" | "unpipe", listener: (src: Readable) => void): this;
    prependOnceListener(event: string, listener: (...args: any[]) => void): this;
    off(event: "drain" | "finish" | "close", listener: () => void): this;
    off(event: "error", listener: (err: Error) => void): this;
    off(event: "pipe" | "unpipe", listener: (src: Readable) => void): this;
    off(event: string, listener: (...args: any[]) => void): this;
    removeListener(event: "drain" | "finish" | "close", listener: () => void): this;
    removeListener(event: "error", listener: (err: Error) => void): this;
    removeListener(event: "pipe" | "unpipe", listener: (src: Readable) => void): this;
    removeListener(event: string, listener: (...args: any[]) => void): this;
  }

  /* Duplex is Readable + Writable in one object. TS single inheritance
   * mirrors @types/node: extends Readable, the writable half declared
   * again. The lowering treats both halves as first-class. */
  class Duplex extends Readable {
    /* Duplex.from: an async generator function, an iterable, a string or
     * a stream (duplexify.js). */
    static from(body: unknown): Duplex;
    constructor(opts: ObjectDuplexOptions);
    constructor(opts: StringDuplexOptions);
    constructor(opts?: DuplexOptions);
    /* The underscore-method surface (see Readable). */
    _write(chunk: any, encoding: string, callback: (error?: Error | null) => void): void;
    _writev(
      chunks: Array<{ chunk: any; encoding: string }>,
      callback: (error?: Error | null) => void,
    ): void;
    _final(callback: (error?: Error | null) => void): void;
    write(chunk: Buffer | string, callback?: (error?: Error | null) => void): boolean;
    write(
      chunk: Buffer | string,
      encoding: string,
      callback?: (error?: Error | null) => void,
    ): boolean;
    /* An object-mode stream's values (the encoding argument reaches
     * _write as passed). */
    write(chunk: any, callback?: (error?: Error | null) => void): boolean;
    write(
      chunk: any,
      encoding: ObjectModeEncoding,
      callback?: (error?: Error | null) => void,
    ): boolean;
    end(callback?: () => void): this;
    end(chunk: Buffer | string, callback?: () => void): this;
    end(chunk: Buffer | string, encoding: string, callback?: () => void): this;
    end(chunk: any, callback?: () => void): this;
    end(chunk: any, encoding: ObjectModeEncoding, callback?: () => void): this;
    cork(): void;
    uncork(): void;
    setDefaultEncoding(encoding: string): this;
    readonly writable: boolean;
    readonly writableEnded: boolean;
    readonly writableFinished: boolean;
    readonly writableLength: number;
    readonly writableHighWaterMark: number;
    readonly writableObjectMode: boolean;
    readonly writableNeedDrain: boolean;
    readonly writableCorked: number;
    readonly allowHalfOpen: boolean;
    on(event: "data", listener: (chunk: any) => void): this;
    on(
      event: "end" | "close" | "readable" | "pause" | "resume" | "drain" | "finish",
      listener: () => void,
    ): this;
    on(event: "error", listener: (err: Error) => void): this;
    on(event: "pipe" | "unpipe", listener: (src: Readable) => void): this;
    on(event: string, listener: (...args: any[]) => void): this;
    once(event: "data", listener: (chunk: any) => void): this;
    once(
      event: "end" | "close" | "readable" | "pause" | "resume" | "drain" | "finish",
      listener: () => void,
    ): this;
    once(event: "error", listener: (err: Error) => void): this;
    once(event: "pipe" | "unpipe", listener: (src: Readable) => void): this;
    once(event: string, listener: (...args: any[]) => void): this;
    addListener(event: "data", listener: (chunk: any) => void): this;
    addListener(
      event: "end" | "close" | "readable" | "pause" | "resume" | "drain" | "finish",
      listener: () => void,
    ): this;
    addListener(event: "error", listener: (err: Error) => void): this;
    addListener(event: "pipe" | "unpipe", listener: (src: Readable) => void): this;
    addListener(event: string, listener: (...args: any[]) => void): this;
    prependListener(event: "data", listener: (chunk: any) => void): this;
    prependListener(
      event: "end" | "close" | "readable" | "pause" | "resume" | "drain" | "finish",
      listener: () => void,
    ): this;
    prependListener(event: "error", listener: (err: Error) => void): this;
    prependListener(event: "pipe" | "unpipe", listener: (src: Readable) => void): this;
    prependListener(event: string, listener: (...args: any[]) => void): this;
    prependOnceListener(event: "data", listener: (chunk: any) => void): this;
    prependOnceListener(
      event: "end" | "close" | "readable" | "pause" | "resume" | "drain" | "finish",
      listener: () => void,
    ): this;
    prependOnceListener(event: "error", listener: (err: Error) => void): this;
    prependOnceListener(event: "pipe" | "unpipe", listener: (src: Readable) => void): this;
    prependOnceListener(event: string, listener: (...args: any[]) => void): this;
    off(event: "data", listener: (chunk: any) => void): this;
    off(
      event: "end" | "close" | "readable" | "pause" | "resume" | "drain" | "finish",
      listener: () => void,
    ): this;
    off(event: "error", listener: (err: Error) => void): this;
    off(event: "pipe" | "unpipe", listener: (src: Readable) => void): this;
    off(event: string, listener: (...args: any[]) => void): this;
    removeListener(event: "data", listener: (chunk: any) => void): this;
    removeListener(
      event: "end" | "close" | "readable" | "pause" | "resume" | "drain" | "finish",
      listener: () => void,
    ): this;
    removeListener(event: "error", listener: (err: Error) => void): this;
    removeListener(event: "pipe" | "unpipe", listener: (src: Readable) => void): this;
    removeListener(event: string, listener: (...args: any[]) => void): this;
  }

  class Transform extends Duplex {
    constructor(opts: ObjectTransformOptions);
    constructor(opts: StringTransformOptions);
    constructor(opts?: TransformOptions);
    /* The underscore-method surface (see Readable). */
    _transform(
      chunk: any,
      encoding: string,
      callback: (error?: Error | null, data?: any) => void,
    ): void;
    _flush(callback: (error?: Error | null, data?: any) => void): void;
  }
  class PassThrough extends Transform {
    constructor(opts: ObjectTransformOptions);
    constructor(opts: StringTransformOptions);
    constructor(opts?: TransformOptions);
  }

  /* addAbortSignal(signal, stream): the stream, destroyed with an
   * AbortError (cause: signal.reason) when the signal aborts. */
  function addAbortSignal<T extends Readable | Writable>(signal: AbortSignal, stream: T): T;
  /* pipeline(...stages, callback): the last stream, or the object-mode
   * PassThrough that a function destination feeds. */
  type PipelineResult<T extends unknown[]> = T extends [
    ...unknown[],
    infer D,
    (...args: any[]) => unknown,
  ]
    ? D extends (...args: any[]) => unknown
      ? PassThrough
      : D
    : unknown;
  function pipeline<T extends unknown[]>(...streams: T): PipelineResult<T>;
  /* util.promisify's pipeline overload matches only pipeline itself: a
   * generic signature alone admits every function. */
  namespace pipeline {
    const __promisify__: typeof promises.pipeline;
  }
  /* A compose stage: a stream, an async generator function over the
   * previous stage, or (first) an iterable, async iterable or web
   * ReadableStream. */
  type ComposeStage =
    | Readable
    | Writable
    | Iterable<unknown>
    | AsyncIterable<unknown>
    | globalThis.ReadableStream
    | ((source: any, options?: { signal: AbortSignal }) => unknown);
  /* compose(...streams): a Duplex that writes to the first stage and
   * reads from the last, with the stages running as a pipeline. */
  function compose(...streams: ComposeStage[]): Duplex;
  /* finished's options: readable/writable choose which ends count,
   * error: false ignores 'error' events, signal aborts the wait. */
  interface FinishedOptions {
    readable?: boolean;
    writable?: boolean;
    error?: boolean;
    signal?: AbortSignal;
  }
  function finished(stream: unknown, callback: (err?: Error | null) => void): () => void;
  function finished(
    stream: unknown,
    options: FinishedOptions | null,
    callback: (err?: Error | null) => void,
  ): () => void;
  /* Folds to the TARGET platform's default at compile time (win32 16384,
   * else 65536 — Node's own state.js split); literal argument only. */
  function getDefaultHighWaterMark(objectMode: boolean): number;
  /* The promise pipeline's result: a last stage that is an async
   * function resolves the promise with its value (before the options
   * argument, when one follows). */
  type PipelinePromise<T extends unknown[]> = T extends [
    ...unknown[],
    (...args: any[]) => Promise<infer P>,
  ]
    ? Promise<P>
    : T extends [
          ...unknown[],
          (...args: any[]) => Promise<infer P>,
          { signal?: AbortSignal; end?: boolean },
        ]
      ? Promise<P>
      : Promise<void>;
  namespace promises {
    function pipeline<T extends unknown[]>(...streams: T): PipelinePromise<T>;
    function finished(
      stream: unknown,
      options?: FinishedOptions & { cleanup?: boolean },
    ): Promise<void>;
  }
  class Stream extends EventEmitter {}

  export {
    Readable,
    Writable,
    Duplex,
    Transform,
    PassThrough,
    Stream,
    addAbortSignal,
    pipeline,
    compose,
    finished,
    getDefaultHighWaterMark,
    promises,
  };
  export type {
    ReadableOptions,
    WritableOptions,
    DuplexOptions,
    TransformOptions,
    FinishedOptions,
    PipelinePromise,
  };
}

declare module "node:stream" {
  import stream = require("stream");
  export = stream;
}
