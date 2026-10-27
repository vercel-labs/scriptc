// undici's Dispatcher (lib/dispatcher/dispatcher.js), DispatcherBase
// (dispatcher-base.js) and the request() API's handler (lib/api/api-request.js).
import { EventEmitter } from "node:events";
import { BodyReadable } from "./readable.ts";
import {
  ClientClosedError,
  ClientDestroyedError,
  InvalidArgumentError,
  RequestAbortedError,
  ResponseStatusCodeError,
} from "./errors.ts";
import { parseHeaders, rawHeaderStrings } from "./util.ts";
import type {
  DispatchController,
  DispatchFn,
  DispatchHandlers,
  DispatchInterceptor,
  DispatchOptions,
  IncomingHttpHeaders,
  Profile,
} from "./types.ts";

/** Dispatcher.RequestOptions: the dispatch options (which carry the
 * request members, see DispatchOptions). */
export type RequestOptions = DispatchOptions;

export interface ResponseData {
  statusCode: number;
  /** 7.x only. */
  statusText?: string;
  headers: IncomingHttpHeaders;
  body: BodyReadable;
  trailers: Record<string, string>;
  opaque: unknown;
  context: object | undefined;
}

const defaultProfile: Profile = { major: 7 };

export class Dispatcher extends EventEmitter {
  // An explicit constructor: the implicit one forwards its arguments to
  // EventEmitter's options-taking constructor, which stays a runtime fence.
  constructor() {
    super();
  }

  dispatch(_options: DispatchOptions, _handler: DispatchHandlers): boolean {
    throw new Error("not implemented");
  }

  close(): Promise<void> {
    return Promise.reject(new Error("not implemented"));
  }

  destroy(_err?: Error | null): Promise<void> {
    return Promise.reject(new Error("not implemented"));
  }

  /** Dispatcher.prototype.request: dispatches through this dispatcher and
   * resolves with the response once its headers arrive. */
  request(options: RequestOptions): Promise<ResponseData> {
    return requestThrough(this, options, this.__undiciProfile());
  }

  __undiciProfile(): Profile {
    return defaultProfile;
  }

  // Pool statistics hooks (undici's kConnected/kPending/kRunning/kSize/
  // kBusy); dispatchers that are not clients or pools count nothing.
  __connectedFlag(): boolean {
    return false;
  }

  __isDestroyed(): boolean {
    return false;
  }

  __connectedCount(): number {
    return 0;
  }

  __freeCount(): number {
    return 0;
  }

  __pendingCount(): number {
    return 0;
  }

  __queuedCount(): number {
    return 0;
  }

  __runningCount(): number {
    return 0;
  }

  __sizeCount(): number {
    return 0;
  }
}

export class DispatcherBase extends Dispatcher {
  __profile: Profile;
  __destroyed: boolean;
  __closed: boolean;
  __onDestroyed: (() => void)[] | null;
  __onClosed: (() => void)[] | null;
  __interceptors: readonly DispatchInterceptor[];
  __interceptedDispatch: DispatchFn | null;

  constructor(profile: Profile) {
    super();
    this.__profile = profile;
    this.__destroyed = false;
    this.__closed = false;
    this.__onDestroyed = [];
    this.__onClosed = [];
    this.__interceptors = [];
    this.__interceptedDispatch = null;
  }

  __undiciProfile(): Profile {
    return this.__profile;
  }

  get destroyed(): boolean {
    return this.__destroyed;
  }

  __isDestroyed(): boolean {
    return this.__destroyed;
  }

  get closed(): boolean {
    return this.__closed;
  }

  close(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (this.__destroyed) {
        queueMicrotask(() => reject(new ClientDestroyedError()));
        return;
      }
      if (this.__closed) {
        const waiting = this.__onClosed;
        if (waiting !== null) waiting.push(() => resolve());
        else queueMicrotask(() => resolve());
        return;
      }
      this.__closed = true;
      this.__onClosed!.push(() => resolve());
      this.__close()
        .then(() => this.destroy())
        .then(() => {
          queueMicrotask(() => {
            const callbacks = this.__onClosed;
            this.__onClosed = null;
            if (callbacks !== null) for (const cb of callbacks) cb();
          });
        });
    });
  }

  destroy(err?: Error | null): Promise<void> {
    return new Promise<void>((resolve) => {
      if (this.__destroyed) {
        const waiting = this.__onDestroyed;
        if (waiting !== null) waiting.push(() => resolve());
        else queueMicrotask(() => resolve());
        return;
      }
      const error = err ?? new ClientDestroyedError();
      this.__destroyed = true;
      this.__onDestroyed!.push(() => resolve());
      this.__destroy(error).then(() => {
        queueMicrotask(() => {
          const callbacks = this.__onDestroyed;
          this.__onDestroyed = null;
          if (callbacks !== null) for (const cb of callbacks) cb();
        });
      });
    });
  }

  dispatch(options: DispatchOptions, handler: DispatchHandlers): boolean {
    const target = this.__profile.major >= 7 ? unwrapHandler(handler, this.__profile) : handler;
    try {
      if (this.__destroyed) throw new ClientDestroyedError();
      if (this.__closed) throw new ClientClosedError();
      return this.__dispatchIntercepted(options, target);
    } catch (err) {
      if (target.onError === undefined) {
        if (this.__profile.major >= 7) throw err;
        throw new InvalidArgumentError("invalid onError method");
      }
      target.onError!(err as Error);
      return false;
    }
  }

  __dispatchIntercepted(options: DispatchOptions, handler: DispatchHandlers): boolean {
    let dispatch = this.__interceptedDispatch;
    if (dispatch === null) {
      dispatch = (o: DispatchOptions, h: DispatchHandlers): boolean => this.__dispatch(o, h);
      for (let i = this.__interceptors.length - 1; i >= 0; i--) {
        dispatch = this.__interceptors[i]!(dispatch);
      }
      this.__interceptedDispatch = dispatch;
    }
    return dispatch(options, handler);
  }

  __dispatch(_options: DispatchOptions, _handler: DispatchHandlers): boolean {
    throw new Error("not implemented");
  }

  __close(): Promise<void> {
    return Promise.resolve();
  }

  __destroy(_err: Error): Promise<void> {
    return Promise.resolve();
  }
}

/** The request() API over a dispatcher (api-request.js's request with the
 * promise callback). */
export function requestThrough(
  dispatcher: Dispatcher,
  options: RequestOptions,
  profile: Profile,
): Promise<ResponseData> {
  return new Promise<ResponseData>((resolve, reject) => {
    const callback = (err: Error | null, data: ResponseData | null): void => {
      if (err !== null) reject(err);
      else resolve(data!);
    };
    try {
      const handler = createRequestHandler(options, profile, callback);
      dispatcher.dispatch(options, handler);
    } catch (err) {
      queueMicrotask(() => callback(err as Error, null));
    }
  });
}

/** api-request.js's RequestHandler, as a handler record over closure state. */
function createRequestHandler(
  opts: RequestOptions,
  profile: Profile,
  done: (err: Error | null, data: ResponseData | null) => void,
): DispatchHandlers {
  if (opts.method === "CONNECT") throw new InvalidArgumentError("invalid method");
  if (
    opts.highWaterMark !== undefined &&
    (!Number.isFinite(opts.highWaterMark) || opts.highWaterMark < 0)
  ) {
    throw new InvalidArgumentError("invalid highWaterMark");
  }
  const v7 = profile.major >= 7;
  const opaque: unknown = opts.opaque ?? null;
  const onInfo = opts.onInfo ?? null;
  const throwOnError = opts.throwOnError === true;
  const trailers: Record<string, string> = {};
  let callback: ((err: Error | null, data: ResponseData | null) => void) | null = done;
  let res: BodyReadable | null = null;
  let abortFn: ((err?: Error) => void) | null = null;
  let reason: Error | null = null;
  let removeAbortListener: (() => void) | null = null;

  const removeSignal = (): void => {
    const remove = removeAbortListener;
    removeAbortListener = null;
    if (remove !== null) remove();
  };

  const onError = (err: Error): void => {
    removeSignal();
    const cb = callback;
    if (cb !== null) {
      callback = null;
      queueMicrotask(() => cb(err, null));
    }
    const body = res;
    if (body !== null) {
      res = null;
      queueMicrotask(() => {
        body.on("error", () => {});
        body.destroy(err);
      });
    }
  };

  // 5.x: abort() before the request reached a socket fails it at once.
  const abortV5 = (): void => {
    const abort = abortFn;
    if (abort !== null) abort();
    else onError(new RequestAbortedError());
  };

  const signal = opts.signal ?? null;
  if (signal !== null) {
    if (v7) {
      if (signal.aborted) {
        reason = abortReason(signal);
      } else {
        const listener = (): void => {
          const why = abortReason(signal);
          reason = why;
          const body = res;
          const abort = abortFn;
          if (body !== null) {
            body.on("error", () => {});
            body.destroy(why);
          } else if (abort !== null) {
            abort(why);
          }
        };
        signal.addEventListener("abort", listener);
        removeAbortListener = () => signal.removeEventListener("abort", listener);
      }
    } else if (signal.aborted) {
      abortV5();
    } else {
      const listener = (): void => abortV5();
      signal.addEventListener("abort", listener);
      removeAbortListener = () => signal.removeEventListener("abort", listener);
    }
  }

  return {
    onConnect: (abort: (err?: Error) => void): void => {
      if (v7) {
        if (reason !== null) {
          abort(reason);
          return;
        }
      } else if (callback === null) {
        throw new RequestAbortedError();
      }
      abortFn = abort;
    },
    onHeaders: (
      statusCode: number,
      rawHeaders: Buffer[],
      resume: () => void,
      statusText: string,
    ): boolean => {
      const headers = parseHeaders(rawHeaderStrings(rawHeaders, profile), profile);
      if (statusCode < 200) {
        if (onInfo !== null) onInfo({ statusCode, headers });
        return true;
      }
      const contentTypeValue = headers["content-type"];
      const contentType = typeof contentTypeValue === "string" ? contentTypeValue : "";
      const abort = abortFn;
      const body = new BodyReadable(
        resume,
        (err: Error) => {
          if (abort !== null) {
            if (v7) abort(err);
            else abort();
          }
        },
        contentType,
        profile,
      );
      if (v7 && removeAbortListener !== null) body.on("close", () => removeSignal());
      const cb = callback;
      callback = null;
      res = body;
      if (cb !== null) {
        if (!v7 && throwOnError && statusCode >= 400) {
          resolveErrorBody(cb, body, contentType, statusCode, statusText, headers);
          return true;
        }
        const data: ResponseData = v7
          ? { statusCode, statusText, headers, trailers, opaque, body, context: undefined }
          : { statusCode, headers, trailers, opaque, body, context: undefined };
        cb(null, data);
      }
      return true;
    },
    onData: (chunk: Buffer): boolean => {
      const body = res;
      return body !== null ? body.push(chunk) : true;
    },
    onComplete: (rawTrailers: string[] | null): void => {
      if (!v7) removeSignal();
      if (rawTrailers !== null) {
        const parsed = parseHeaders(rawTrailers, profile);
        for (const key of Object.keys(parsed)) {
          const value = parsed[key];
          if (typeof value === "string") trailers[key] = value;
          else if (value !== undefined) trailers[key] = value.join(", ");
        }
      }
      const body = res;
      if (body !== null) body.push(null);
    },
    onError,
  };
}

function abortReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  return reason instanceof Error ? reason : new RequestAbortedError();
}

/** 5.x throwOnError: reject with ResponseStatusCodeError carrying the parsed
 * JSON or text body. */
function resolveErrorBody(
  callback: (err: Error | null, data: ResponseData | null) => void,
  body: BodyReadable,
  contentType: string,
  statusCode: number,
  statusMessage: string,
  headers: IncomingHttpHeaders,
): void {
  const message = `Response status code ${statusCode}${statusMessage ? `: ${statusMessage}` : ""}`;
  const record: Record<string, string | string[]> = {};
  for (const key of Object.keys(headers)) {
    const value = headers[key];
    if (value !== undefined) record[key] = value;
  }
  if (statusCode === 204 || contentType === "") {
    body.dump();
    process.nextTick(() =>
      callback(new ResponseStatusCodeError(message, statusCode, record), null),
    );
    return;
  }
  const finish = (payload: unknown): void => {
    process.nextTick(() =>
      callback(new ResponseStatusCodeError(message, statusCode, record, payload), null),
    );
  };
  const fallback = (): void => {
    body.dump();
    process.nextTick(() =>
      callback(new ResponseStatusCodeError(message, statusCode, record), null),
    );
  };
  if (contentType.startsWith("application/json")) {
    body.json().then((payload: unknown) => finish(payload), fallback);
  } else if (contentType.startsWith("text/")) {
    body.text().then((payload: string) => finish(payload), fallback);
  } else {
    fallback();
  }
}

/** 7.x's UnwrapHandler: a controller-API handler (onRequestStart, ...)
 * driven through the legacy callbacks the clients invoke. */
function unwrapHandler(handler: DispatchHandlers, profile: Profile): DispatchHandlers {
  if (handler.onRequestStart === undefined) return handler;
  let controller: UnwrapController | null = null;
  const controllerOf = (): UnwrapController => {
    let c = controller;
    if (c === null) {
      c = new UnwrapController(() => {});
      controller = c;
    }
    return c;
  };
  return {
    onConnect: (abort: (err?: Error) => void): void => {
      const c = new UnwrapController(abort);
      controller = c;
      if (handler.onRequestStart !== undefined) handler.onRequestStart!(c, undefined);
    },
    onHeaders: (
      statusCode: number,
      rawHeaders: Buffer[],
      resume: () => void,
      statusText: string,
    ): boolean => {
      const c = controllerOf();
      c.__resume = resume;
      if (handler.onResponseStart !== undefined) {
        handler.onResponseStart!(
          c,
          statusCode,
          parseHeaders(rawHeaderStrings(rawHeaders, profile), profile),
          statusText,
        );
      }
      return !c.paused;
    },
    onData: (chunk: Buffer): boolean => {
      const c = controllerOf();
      if (handler.onResponseData !== undefined) handler.onResponseData!(c, chunk);
      return !c.paused;
    },
    onComplete: (trailers: string[] | null): void => {
      if (handler.onResponseEnd !== undefined) {
        handler.onResponseEnd!(controllerOf(), parseHeaders(trailers ?? [], profile));
      }
    },
    onError: (err: Error): void => {
      if (handler.onResponseError === undefined)
        throw new InvalidArgumentError("invalid onError method");
      handler.onResponseError!(controllerOf(), err);
    },
  };
}

/** 7.x's UnwrapController. */
class UnwrapController implements DispatchController {
  __paused: boolean;
  __reason: Error | null;
  __aborted: boolean;
  __abort: (err?: Error) => void;
  __resume: (() => void) | null;

  constructor(abort: (err?: Error) => void) {
    this.__paused = false;
    this.__reason = null;
    this.__aborted = false;
    this.__abort = abort;
    this.__resume = null;
  }

  pause(): void {
    this.__paused = true;
  }

  resume(): void {
    if (this.__paused) {
      this.__paused = false;
      const resume = this.__resume;
      if (resume !== null) resume();
    }
  }

  abort(reason: Error): void {
    if (!this.__aborted) {
      this.__aborted = true;
      this.__reason = reason;
      this.__abort(reason);
    }
  }

  get aborted(): boolean {
    return this.__aborted;
  }

  get reason(): Error | null {
    return this.__reason;
  }

  get paused(): boolean {
    return this.__paused;
  }
}

/** The `Dispatcher.*` type namespace of undici's types/dispatcher.d.ts
 * (5.x and 7.x spellings). */
export declare namespace Dispatcher {
  type DispatchOptions = import("./types.ts").DispatchOptions;
  type DispatchHandlers = import("./types.ts").DispatchHandlers;
  type DispatchHandler = import("./types.ts").DispatchHandlers;
  type DispatchController = import("./types.ts").DispatchController;
  type DispatchInterceptor = import("./types.ts").DispatchInterceptor;
  type Dispatch = import("./types.ts").DispatchFn;
  type HttpMethod = string;
  type UndiciHeaders = import("./types.ts").UndiciHeaders;
  // The 7.x spellings take an opaque type parameter; the opaque value is
  // `unknown` here.
  type RequestOptions<_TOpaque = null> = import("./dispatcher.ts").RequestOptions;
  type ResponseData<_TOpaque = null> = import("./dispatcher.ts").ResponseData;
}
