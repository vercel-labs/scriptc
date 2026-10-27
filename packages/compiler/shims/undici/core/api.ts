// undici's top-level request() (index.js makeDispatcher over
// lib/api/api-request.js) and the global dispatcher
// (lib/global.js: one process-wide slot shared by every undici copy).
import { requestThrough } from "./dispatcher.ts";
import type { Dispatcher, RequestOptions, ResponseData } from "./dispatcher.ts";
import { parseOrigin, parseURL } from "./util.ts";
import type { IncomingHttpHeaders, Profile, RequestBody, UndiciHeaders } from "./types.ts";

/** request(url, options)'s options: Dispatcher.RequestOptions without
 * origin/path, an optional method, and the dispatcher to use. */
export interface TopLevelRequestOptions {
  dispatcher?: Dispatcher;
  method?: string;
  path?: string;
  body?: RequestBody;
  headers?: UndiciHeaders;
  idempotent?: boolean;
  blocking?: boolean;
  headersTimeout?: number | null;
  bodyTimeout?: number | null;
  reset?: boolean;
  throwOnError?: boolean;
  opaque?: unknown;
  signal?: AbortSignal | null;
  onInfo?: (info: { statusCode: number; headers: IncomingHttpHeaders }) => void;
  highWaterMark?: number;
}

let globalDispatcher: Dispatcher | null = null;
let globalDispatcherSet = false;

export function setGlobalDispatcher(dispatcher: Dispatcher): void {
  globalDispatcher = dispatcher;
  globalDispatcherSet = true;
}

/** The global dispatcher, created on first use by the asking version's
 * Agent (undici stores whichever copy asked first). */
export function getGlobalDispatcher(create: () => Dispatcher): Dispatcher {
  let dispatcher = globalDispatcher;
  if (dispatcher === null) {
    dispatcher = create();
    globalDispatcher = dispatcher;
  }
  return dispatcher;
}

/** True once a program installed its own global dispatcher. */
export function hasCustomGlobalDispatcher(): boolean {
  return globalDispatcherSet;
}

export function request(
  url: string | URL,
  options: TopLevelRequestOptions | undefined,
  createGlobal: () => Dispatcher,
  profile: Profile,
): Promise<ResponseData> {
  // makeDispatcher validates synchronously: an invalid URL throws at the
  // call rather than rejecting.
  {
    const opts: TopLevelRequestOptions = options ?? {};
    let target: URL;
    const path = opts.path;
    if (path !== undefined) {
      const prefixed = path.startsWith("/") ? path : `/${path}`;
      target = new URL(parseOrigin(url, profile).origin + prefixed);
    } else {
      target = parseURL(url, profile);
    }
    const dispatcher = opts.dispatcher ?? getGlobalDispatcher(createGlobal);
    const method =
      opts.method !== undefined && opts.method !== "" ? opts.method : opts.body ? "PUT" : "GET";
    const dispatchOptions: RequestOptions = {
      origin: target.origin,
      path: target.search ? `${target.pathname}${target.search}` : target.pathname,
      method,
      body: opts.body,
      headers: opts.headers,
      idempotent: opts.idempotent,
      blocking: opts.blocking,
      headersTimeout: opts.headersTimeout,
      bodyTimeout: opts.bodyTimeout,
      reset: opts.reset,
      throwOnError: opts.throwOnError,
      opaque: opts.opaque,
      signal: opts.signal,
      onInfo: opts.onInfo,
      highWaterMark: opts.highWaterMark,
    };
    return requestThrough(dispatcher, dispatchOptions, profile);
  }
}
