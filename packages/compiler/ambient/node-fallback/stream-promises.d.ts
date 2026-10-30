/// <reference path="./stream.d.ts" />

declare module "stream/promises" {
  /* The promise forms of finished/pipeline: a void promise the stream's
   * terminal point settles (rejected with the error, or
   * ERR_STREAM_PREMATURE_CLOSE on an early close). Stream arguments are
   * the lowered surface — iterables/generators/functions fence per site.
   * pipeline's trailing { signal, end } object and finished's options
   * (readable, writable, error, cleanup, signal) are supported. A last
   * stage that is an async function resolves the promise with its value. */
  function pipeline<T extends unknown[]>(...streams: T): import("stream").PipelinePromise<T>;
  function finished(
    stream: unknown,
    options?: {
      readable?: boolean;
      writable?: boolean;
      error?: boolean;
      cleanup?: boolean;
      signal?: AbortSignal;
    } | null,
  ): Promise<void>;
  export { pipeline, finished };
}

declare module "node:stream/promises" {
  import streamPromises = require("stream/promises");
  export = streamPromises;
}
