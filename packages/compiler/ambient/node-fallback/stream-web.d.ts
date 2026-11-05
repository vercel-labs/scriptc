/* node:stream/web — the module exports the web stream globals themselves
 * (require("stream/web").ReadableStream === globalThis.ReadableStream). */
declare module "stream/web" {
  export const ReadableStream: typeof globalThis.ReadableStream;
  export type ReadableStream<T = unknown> = globalThis.ReadableStream<T>;
  export const ReadableStreamDefaultReader: typeof globalThis.ReadableStreamDefaultReader;
  export type ReadableStreamDefaultReader<T = unknown> = globalThis.ReadableStreamDefaultReader<T>;
  export const ReadableStreamDefaultController: typeof globalThis.ReadableStreamDefaultController;
  export type ReadableStreamDefaultController<T = unknown> =
    globalThis.ReadableStreamDefaultController<T>;
  export const WritableStream: typeof globalThis.WritableStream;
  export type WritableStream<W = unknown> = globalThis.WritableStream<W>;
  export const WritableStreamDefaultWriter: typeof globalThis.WritableStreamDefaultWriter;
  export type WritableStreamDefaultWriter<W = unknown> = globalThis.WritableStreamDefaultWriter<W>;
  export const WritableStreamDefaultController: typeof globalThis.WritableStreamDefaultController;
  export type WritableStreamDefaultController = globalThis.WritableStreamDefaultController;
  export const TransformStream: typeof globalThis.TransformStream;
  export type TransformStream<I = unknown, O = unknown> = globalThis.TransformStream<I, O>;
  export const TransformStreamDefaultController: typeof globalThis.TransformStreamDefaultController;
  export type TransformStreamDefaultController<O = unknown> =
    globalThis.TransformStreamDefaultController<O>;
  export const CountQueuingStrategy: typeof globalThis.CountQueuingStrategy;
  export type CountQueuingStrategy = globalThis.CountQueuingStrategy;
  export const ByteLengthQueuingStrategy: typeof globalThis.ByteLengthQueuingStrategy;
  export type ByteLengthQueuingStrategy = globalThis.ByteLengthQueuingStrategy;
  export const TextEncoderStream: typeof globalThis.TextEncoderStream;
  export type TextEncoderStream = globalThis.TextEncoderStream;
  export const TextDecoderStream: typeof globalThis.TextDecoderStream;
  export type TextDecoderStream = globalThis.TextDecoderStream;
  export type UnderlyingSource<T = unknown> = globalThis.UnderlyingSource<T>;
  export type QueuingStrategy<T = unknown> = globalThis.QueuingStrategy<T>;
}

declare module "node:stream/web" {
  export * from "stream/web";
}
