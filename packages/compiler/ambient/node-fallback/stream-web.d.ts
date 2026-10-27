/* node:stream/web — the module exports the web stream globals themselves
 * (require("stream/web").ReadableStream === globalThis.ReadableStream).
 * ReadableStream is the implemented class; its reader and controller are
 * exported as types. */
declare module "stream/web" {
  export const ReadableStream: typeof globalThis.ReadableStream;
  export type ReadableStream<T = unknown> = globalThis.ReadableStream<T>;
  export type ReadableStreamDefaultReader<T = unknown> = globalThis.ReadableStreamDefaultReader<T>;
  export type ReadableStreamDefaultController<T = unknown> =
    globalThis.ReadableStreamDefaultController<T>;
  export type UnderlyingSource<T = unknown> = globalThis.UnderlyingSource<T>;
  export type QueuingStrategy<T = unknown> = globalThis.QueuingStrategy<T>;
}

declare module "node:stream/web" {
  export * from "stream/web";
}
