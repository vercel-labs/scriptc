/* The web stream globals Node's runtime provides (globalThis.ReadableStream,
 * WritableStream, TransformStream and their readers, writers, controllers and
 * strategies), plus the ScriptcBufferView shape their strategies use.
 *
 * scriptc-node-fallback.d.ts carries these for a project with no @types/node,
 * and references this file so both worlds share one text. A project WITH
 * @types/node whose types predate the globals (@types/node 20.11 and earlier
 * declare none of them) gets this file as a supplement when its program names
 * one (program.ts, nodeTypesSupplementRoots7): Node's runtime has them, so the
 * program typechecks as it does in an editor whose type world includes them.
 * Nothing here is scriptc-specific; the lowerer decides what a use compiles to
 * as it does for any other global. */

/* A typed array or a DataView as a builtin's parameter: the three members
 * every view has, so each of them, a Buffer and a value typed with the ES
 * library's `ArrayBufferView` are arguments. The builtin declarations use
 * this interface instead of the library's: that one is the type of a
 * program's own values and maps to the checked-dynamic value wherever one
 * flows, and a builtin's signature keeps its shape whatever a program's
 * values are. It has no value representation of its own: a builtin lowers
 * its view argument at the call. */
interface ScriptcBufferView<TArrayBuffer extends ArrayBufferLike = ArrayBufferLike> {
  readonly buffer: TArrayBuffer;
  readonly byteLength: number;
  readonly byteOffset: number;
}

interface QueuingStrategySize<T = unknown> {
  (chunk: T): number;
}
interface QueuingStrategy<T = unknown> {
  highWaterMark?: number;
  size?: QueuingStrategySize<T>;
}
interface ReadableStreamReadValueResult<T> {
  done: false;
  value: T;
}
interface ReadableStreamReadDoneResult<T> {
  done: true;
  value: T | undefined;
}
type ReadableStreamReadResult<T> =
  | ReadableStreamReadValueResult<T>
  | ReadableStreamReadDoneResult<T>;
interface ReadableStreamDefaultReader<T = unknown> {
  readonly closed: Promise<void>;
  read(): Promise<ReadableStreamReadResult<T>>;
  cancel(reason?: unknown): Promise<void>;
  releaseLock(): void;
}
interface ReadableStreamDefaultController<T = unknown> {
  readonly desiredSize: number | null;
  enqueue(chunk?: T): void;
  close(): void;
  error(reason?: unknown): void;
}
interface StreamPipeOptions {
  preventAbort?: boolean;
  preventCancel?: boolean;
  preventClose?: boolean;
  signal?: AbortSignal;
}
interface UnderlyingSource<T = unknown> {
  start?(controller: ReadableStreamDefaultController<T>): unknown;
  pull?(controller: ReadableStreamDefaultController<T>): unknown;
  cancel?(reason?: unknown): unknown;
}
/* A byte stream's source and its controller, request and reader
 * (@types/node's stream/web shapes). */
interface UnderlyingByteSource {
  type: "bytes";
  autoAllocateChunkSize?: number;
  start?(controller: ReadableByteStreamController): unknown;
  pull?(controller: ReadableByteStreamController): unknown;
  cancel?(reason?: unknown): unknown;
}
interface ReadableStreamBYOBRequest {
  readonly view: Uint8Array | null;
  respond(bytesWritten: number): void;
  respondWithNewView(view: Uint8Array): void;
}
interface ReadableByteStreamController {
  readonly byobRequest: ReadableStreamBYOBRequest | null;
  readonly desiredSize: number | null;
  enqueue(chunk?: ArrayBufferView): void;
  close(): void;
  error(reason?: unknown): void;
}
interface ReadableStreamBYOBReadValueResult<T extends ArrayBufferView> {
  done: false;
  value: T;
}
interface ReadableStreamBYOBReadDoneResult<T extends ArrayBufferView> {
  done: true;
  value: T | undefined;
}
type ReadableStreamBYOBReadResult<T extends ArrayBufferView> =
  | ReadableStreamBYOBReadValueResult<T>
  | ReadableStreamBYOBReadDoneResult<T>;
interface ReadableStreamBYOBReader {
  readonly closed: Promise<void>;
  read<T extends ArrayBufferView>(
    view: T,
    options?: { min?: number },
  ): Promise<ReadableStreamBYOBReadResult<T>>;
  cancel(reason?: unknown): Promise<void>;
  releaseLock(): void;
}
interface ReadableStream<T = unknown> {
  readonly locked: boolean;
  cancel(reason?: unknown): Promise<void>;
  getReader(): ReadableStreamDefaultReader<T>;
  getReader(options: { mode: "byob" }): ReadableStreamBYOBReader;
  tee(): [ReadableStream<T>, ReadableStream<T>];
  pipeTo(destination: WritableStream<T>, options?: StreamPipeOptions): Promise<void>;
  pipeThrough<O>(
    transform: { readable: ReadableStream<O>; writable: WritableStream<T> },
    options?: StreamPipeOptions,
  ): ReadableStream<O>;
  [Symbol.asyncIterator](options?: { preventCancel?: boolean }): AsyncIterableIterator<T>;
  values(options?: { preventCancel?: boolean }): AsyncIterableIterator<T>;
}
declare var ReadableStream: {
  /* Two constructor signatures, like @types/node's: a union of the two
   * source shapes in one signature would drop the contextual type of a
   * `pull(controller)` callback, since TypeScript gives no contextual
   * signature for a property whose type differs across the union. */
  new (
    source: UnderlyingByteSource,
    strategy?: QueuingStrategy<Uint8Array>,
  ): ReadableStream<Uint8Array>;
  new <T = unknown>(source?: UnderlyingSource<T>, strategy?: QueuingStrategy<T>): ReadableStream<T>;
  from<T>(iterable: readonly T[]): ReadableStream<T>;
  from(iterable: Uint8Array): ReadableStream<number>;
  from(iterable: string): ReadableStream<string>;
  from<T>(iterable: Iterable<T> | AsyncIterable<T>): ReadableStream<T>;
  readonly prototype: ReadableStream<unknown>;
};
declare var ReadableStreamBYOBReader: {
  new (stream: ReadableStream<Uint8Array>): ReadableStreamBYOBReader;
  readonly prototype: ReadableStreamBYOBReader;
};
declare var ReadableByteStreamController: {
  new (): ReadableByteStreamController;
  readonly prototype: ReadableByteStreamController;
};
declare var ReadableStreamBYOBRequest: {
  new (): ReadableStreamBYOBRequest;
  readonly prototype: ReadableStreamBYOBRequest;
};
/* The writable side of a TransformStream and its writer. A program that
 * constructs a WritableStream, or a TransformStream with a transformer,
 * builds its streams with the web stream classes (scr_webstreams.c). */
interface WritableStreamDefaultWriter<W = unknown> {
  readonly closed: Promise<void>;
  readonly desiredSize: number | null;
  readonly ready: Promise<void>;
  abort(reason?: unknown): Promise<void>;
  close(): Promise<void>;
  releaseLock(): void;
  write(chunk?: W): Promise<void>;
}
interface WritableStream<W = unknown> {
  readonly locked: boolean;
  abort(reason?: unknown): Promise<void>;
  close(): Promise<void>;
  getWriter(): WritableStreamDefaultWriter<W>;
}
/* Without a transformer, the identity transform: chunks written to
 * `writable` are read from `readable`, and a write completes when its chunk
 * is read. */
interface TransformStream<I = unknown, O = unknown> {
  readonly readable: ReadableStream<O>;
  readonly writable: WritableStream<I>;
}
interface Transformer<I = unknown, O = unknown> {
  start?(controller: TransformStreamDefaultController<O>): unknown;
  transform?(chunk: I, controller: TransformStreamDefaultController<O>): unknown;
  flush?(controller: TransformStreamDefaultController<O>): unknown;
  cancel?(reason?: unknown): unknown;
}
declare var TransformStream: {
  new <I = unknown, O = I>(
    transformer?: Transformer<I, O>,
    writableStrategy?: QueuingStrategy<I>,
    readableStrategy?: QueuingStrategy<O>,
  ): TransformStream<I, O>;
  readonly prototype: TransformStream<unknown, unknown>;
};
/* The web compression streams: a TransformStream's readable and writable
 * over one of Node's zlib formats (scr_webstream_compress.c). */
type CompressionFormat = "deflate" | "deflate-raw" | "gzip" | "brotli";
interface CompressionStream {
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;
}
declare var CompressionStream: {
  new (format: CompressionFormat): CompressionStream;
  readonly prototype: CompressionStream;
};
interface DecompressionStream {
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;
}
declare var DecompressionStream: {
  new (format: CompressionFormat): DecompressionStream;
  readonly prototype: DecompressionStream;
};
/* The other web stream interfaces. JavaScript sources construct and read
 * them as checked-dynamic values (scr_webstreams.c); TypeScript sources
 * have no static lowering for them. */
declare var ReadableStreamDefaultReader: {
  new <T = unknown>(stream: ReadableStream<T>): ReadableStreamDefaultReader<T>;
  readonly prototype: ReadableStreamDefaultReader<unknown>;
};
declare var ReadableStreamDefaultController: {
  new (): ReadableStreamDefaultController<unknown>;
  readonly prototype: ReadableStreamDefaultController<unknown>;
};
interface WritableStreamDefaultController {
  readonly signal: AbortSignal;
  error(reason?: unknown): void;
}
interface UnderlyingSink<W = unknown> {
  start?(controller: WritableStreamDefaultController): unknown;
  write?(chunk: W, controller: WritableStreamDefaultController): unknown;
  close?(): unknown;
  abort?(reason?: unknown): unknown;
}
declare var WritableStream: {
  new <W = unknown>(sink?: UnderlyingSink<W>, strategy?: QueuingStrategy<W>): WritableStream<W>;
  readonly prototype: WritableStream<unknown>;
};
declare var WritableStreamDefaultWriter: {
  new <W = unknown>(stream: WritableStream<W>): WritableStreamDefaultWriter<W>;
  readonly prototype: WritableStreamDefaultWriter<unknown>;
};
declare var WritableStreamDefaultController: {
  new (): WritableStreamDefaultController;
  readonly prototype: WritableStreamDefaultController;
};
interface TransformStreamDefaultController<O = unknown> {
  readonly desiredSize: number | null;
  enqueue(chunk?: O): void;
  error(reason?: unknown): void;
  terminate(): void;
}
declare var TransformStreamDefaultController: {
  new (): TransformStreamDefaultController<unknown>;
  readonly prototype: TransformStreamDefaultController<unknown>;
};
interface CountQueuingStrategy extends QueuingStrategy<unknown> {
  readonly highWaterMark: number;
  readonly size: QueuingStrategySize<unknown>;
}
declare var CountQueuingStrategy: {
  new (init: { highWaterMark: number }): CountQueuingStrategy;
  readonly prototype: CountQueuingStrategy;
};
interface ByteLengthQueuingStrategy extends QueuingStrategy<ScriptcBufferView> {
  readonly highWaterMark: number;
  readonly size: QueuingStrategySize<ScriptcBufferView>;
}
declare var ByteLengthQueuingStrategy: {
  new (init: { highWaterMark: number }): ByteLengthQueuingStrategy;
  readonly prototype: ByteLengthQueuingStrategy;
};
interface TextEncoderStream {
  readonly encoding: "utf-8";
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<string>;
}
declare var TextEncoderStream: {
  new (): TextEncoderStream;
  readonly prototype: TextEncoderStream;
};
interface TextDecoderStream {
  readonly encoding: string;
  readonly fatal: boolean;
  readonly ignoreBOM: boolean;
  readonly readable: ReadableStream<string>;
  readonly writable: WritableStream<Uint8Array>;
}
declare var TextDecoderStream: {
  new (label?: string, options?: { fatal?: boolean; ignoreBOM?: boolean }): TextDecoderStream;
  readonly prototype: TextDecoderStream;
};
