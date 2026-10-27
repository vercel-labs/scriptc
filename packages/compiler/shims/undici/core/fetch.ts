// undici's fetch(). Without a dispatcher (no init.dispatcher and no
// program-installed global dispatcher) it is the runtime's own fetch, which
// implements the same WHATWG algorithm. With one, the request goes through
// that dispatcher (its connector, lookup and pool), following undici's
// fetch for request headers, redirects and errors. The promise resolves
// when the response headers arrive, and the Response body streams from the
// connection with undici's back-pressure (see dispatchOnce).
//
// Known gaps: a Response built here reports `url` as "" and `redirected` as
// false (the runtime's Response has no settable URL yet), and https requests
// offer `gzip, deflate` rather than undici's `br, gzip, deflate` (the runtime
// has no Brotli decoder).
import type { Transform } from "node:stream";
import * as zlib from "node:zlib";
import type { Dispatcher } from "./dispatcher.ts";
import { getGlobalDispatcher, hasCustomGlobalDispatcher } from "./api.ts";
import type { DispatchHandlers, Profile } from "./types.ts";

/** undici's RequestInit, restricted to the implemented members: string and
 * byte bodies, and the init members the dispatcher path honors. */
export interface UndiciRequestInit {
  method?: string;
  headers?: Headers | [string, string][] | Record<string, string>;
  body?: string | Uint8Array | null;
  signal?: AbortSignal | null;
  redirect?: "follow" | "manual" | "error";
  dispatcher?: Dispatcher;
}

/** The fetch standard's blocked ports (undici lib/web/fetch/constants.js). */
const badPorts = new Set([
  "1",
  "7",
  "9",
  "11",
  "13",
  "15",
  "17",
  "19",
  "20",
  "21",
  "22",
  "23",
  "25",
  "37",
  "42",
  "43",
  "53",
  "69",
  "77",
  "79",
  "87",
  "95",
  "101",
  "102",
  "103",
  "104",
  "109",
  "110",
  "111",
  "113",
  "115",
  "117",
  "119",
  "123",
  "135",
  "137",
  "139",
  "143",
  "161",
  "179",
  "389",
  "427",
  "465",
  "512",
  "513",
  "514",
  "515",
  "526",
  "530",
  "531",
  "532",
  "540",
  "548",
  "554",
  "556",
  "563",
  "587",
  "601",
  "636",
  "989",
  "990",
  "993",
  "995",
  "1719",
  "1720",
  "1723",
  "2049",
  "3659",
  "4045",
  "4190",
  "5060",
  "5061",
  "6000",
  "6566",
  "6665",
  "6666",
  "6667",
  "6668",
  "6669",
  "6679",
  "6697",
  "10080",
]);

interface RawResponse {
  status: number;
  statusText: string;
  headers: string[];
  /** null when the response has no body to expose: a null-body status or
   * HEAD (its bytes, if any, are read and dropped), or a redirect fetch
   * follows or rejects (the request is aborted, closing its connection). */
  body: ReadableStream<Uint8Array> | null;
}

const redirectStatuses = [301, 302, 303, 307, 308];
const nullBodyStatuses = [101, 204, 205, 304];

export function undiciFetch(
  input: string | URL,
  init: UndiciRequestInit | undefined,
  createGlobal: () => Dispatcher,
  profile: Profile,
): Promise<Response> {
  const explicit = init !== undefined ? init.dispatcher : undefined;
  if (explicit === undefined && !hasCustomGlobalDispatcher()) {
    if (init === undefined) return fetch(input);
    return fetch(input, {
      method: init.method,
      headers: init.headers,
      body: init.body,
      signal: init.signal ?? undefined,
      redirect: init.redirect,
    });
  }
  const dispatcher = explicit ?? getGlobalDispatcher(createGlobal);
  return fetchThrough(dispatcher, input, init ?? {}, profile);
}

function normalizeMethod(method: string): string {
  const upper = method.toUpperCase();
  return ["DELETE", "GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH"].includes(upper)
    ? upper
    : method;
}

async function fetchThrough(
  dispatcher: Dispatcher,
  input: string | URL,
  init: UndiciRequestInit,
  profile: Profile,
): Promise<Response> {
  let url = typeof input === "string" ? new URL(input) : new URL(input.href);
  let method = normalizeMethod(init.method ?? "GET");
  const signal = init.signal ?? null;
  const redirectMode = init.redirect ?? "follow";

  // Request headers: the caller's (as a Headers list: lower-cased, sorted,
  // combined), then undici fetch's defaults.
  const headers = headerListOf(init.headers);
  let body: Buffer | null = null;
  const rawBody = init.body ?? null;
  if (rawBody !== null) {
    if (typeof rawBody === "string") {
      body = Buffer.from(rawBody);
      if (!headers.has("content-type")) headers.set("content-type", "text/plain;charset=UTF-8");
    } else {
      body = Buffer.from(rawBody.buffer, rawBody.byteOffset, rawBody.byteLength);
    }
  }
  if (!headers.has("accept")) headers.set("accept", "*/*");
  if (!headers.has("accept-language")) headers.set("accept-language", "*");

  for (let redirects = 0; ; redirects++) {
    if (signal !== null && signal.aborted) throw abortReason(signal);
    if (badPorts.has(url.port)) {
      throw new TypeError("fetch failed", { cause: new Error("bad port") });
    }
    const requestHeaders = new HeaderList(headers);
    if (body !== null) {
      if (!requestHeaders.has("content-length"))
        requestHeaders.set("content-length", String(body.length));
    } else if ((method === "POST" || method === "PUT") && !requestHeaders.has("content-length")) {
      requestHeaders.set("content-length", "0");
    }
    requestHeaders.set("sec-fetch-mode", "cors");
    if (!requestHeaders.has("user-agent")) requestHeaders.set("user-agent", "undici");
    // undici also offers br over https; the native runtime has no Brotli
    // decoder, so only the codings it can decode are offered.
    if (!requestHeaders.has("accept-encoding"))
      requestHeaders.set("accept-encoding", "gzip, deflate");
    const pairs = requestHeaders.pairs();

    let raw: RawResponse;
    try {
      raw = await dispatchOnce(dispatcher, url, method, pairs, body, signal, redirectMode, profile);
    } catch (err) {
      if (signal !== null && signal.aborted) throw abortReason(signal);
      throw new TypeError("fetch failed", { cause: err });
    }

    const responseHeaders = new Headers();
    for (let i = 0; i + 1 < raw.headers.length; i += 2) {
      responseHeaders.append(raw.headers[i]!, raw.headers[i + 1]!);
    }
    const location = responseHeaders.get("location");
    if (redirectStatuses.includes(raw.status) && location !== null && redirectMode !== "manual") {
      if (redirectMode === "error") {
        throw new TypeError("fetch failed", { cause: new Error("unexpected redirect") });
      }
      if (redirects >= 20) {
        throw new TypeError("fetch failed", { cause: new Error("redirect count exceeded") });
      }
      const next = new URL(location, url);
      if (
        raw.status === 303 && method !== "GET" && method !== "HEAD"
          ? true
          : (raw.status === 301 || raw.status === 302) && method === "POST"
      ) {
        method = "GET";
        body = null;
        for (const name of [
          "content-encoding",
          "content-language",
          "content-location",
          "content-type",
          "content-length",
        ]) {
          headers.delete(name);
        }
      }
      if (next.origin !== url.origin) {
        headers.delete("authorization");
        headers.delete("proxy-authorization");
        headers.delete("cookie");
        headers.delete("host");
      }
      url = next;
      continue;
    }

    return new Response(raw.body, {
      status: raw.status,
      statusText: raw.statusText,
      headers: responseHeaders,
    });
  }
}

/** A Fetch header list: lower-cased names, values combined with ", " in
 * insertion order, serialized sorted by name (set-cookie values stay
 * separate) — what a Headers object yields when iterated. */
class HeaderList {
  names: string[];
  values: Map<string, string[]>;

  constructor(from: HeaderList | null) {
    this.names = from !== null ? from.names.slice() : [];
    this.values = new Map<string, string[]>();
    if (from !== null)
      for (const name of from.names) this.values.set(name, from.values.get(name)!.slice());
  }

  has(name: string): boolean {
    return this.values.has(name.toLowerCase());
  }

  append(name: string, value: string): void {
    const key = name.toLowerCase();
    const normalized = value.replace(/^[\t\n\r ]+|[\t\n\r ]+$/g, "");
    const existing = this.values.get(key);
    if (existing !== undefined) existing.push(normalized);
    else {
      this.names.push(key);
      this.values.set(key, [normalized]);
    }
  }

  set(name: string, value: string): void {
    this.delete(name);
    this.append(name, value);
  }

  delete(name: string): void {
    const key = name.toLowerCase();
    if (!this.values.has(key)) return;
    this.values.delete(key);
    this.names = this.names.filter((n) => n !== key);
  }

  pairs(): string[] {
    const out: string[] = [];
    for (const name of this.names.slice().sort()) {
      const list = this.values.get(name)!;
      if (name === "set-cookie") for (const value of list) out.push(name, value);
      else out.push(name, list.join(", "));
    }
    return out;
  }
}

/** The caller's headers init as a header list. Records and pair arrays read
 * directly; a Headers object is read through forEach. */
function headerListOf(
  init: Headers | [string, string][] | Record<string, string> | undefined,
): HeaderList {
  const list = new HeaderList(null);
  if (init === undefined) return list;
  if (init instanceof Headers) {
    init.forEach((value: string, name: string) => list.append(name, value));
  } else if (Array.isArray(init)) {
    for (const pair of init) list.append(pair[0], pair[1]);
  } else {
    for (const name of Object.keys(init)) list.append(name, init[name]!);
  }
  return list;
}

/** undici 7's limit on a response's content codings, applied in both
 * profiles: undici 5 has none, and builds one decoder per listed coding. */
const maxContentEncodings = 5;

/** Whether every coding has a decoder; otherwise the body passes through
 * as sent. */
function decodable(codings: string[]): boolean {
  if (codings.length === 0) return false;
  for (const coding of codings) {
    if (coding !== "gzip" && coding !== "x-gzip" && coding !== "deflate") return false;
  }
  return true;
}

/** A decoder for one coding. undici 7 decodes with Z_SYNC_FLUSH, which
 * accepts a truncated stream; undici 5 uses zlib's defaults. */
function decoderFor(coding: string, profile: Profile): Transform {
  const options =
    profile.major >= 7
      ? { flush: zlib.constants.Z_SYNC_FLUSH, finishFlush: zlib.constants.Z_SYNC_FLUSH }
      : {};
  return coding === "deflate" ? zlib.createInflate(options) : zlib.createGunzip(options);
}

function abortReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  return reason instanceof Error
    ? reason
    : new DOMException("This operation was aborted", "AbortError");
}

/** Unread bytes held beside the response stream before the connection
 * pauses: Node's Readable highWaterMark, which undici's fetch body uses. */
const bodyHighWaterMark = 64 * 1024;

/** Dispatches one request and resolves when its response headers arrive.
 * The body streams as undici's fetch reads one: up to bodyHighWaterMark
 * unread bytes wait beside the stream, past that the connection (or the
 * last decoder) pauses until the reader pulls again; cancelling the stream
 * aborts the request, and an error after the headers errors the stream
 * with TypeError('terminated'). */
function dispatchOnce(
  dispatcher: Dispatcher,
  url: URL,
  method: string,
  headers: string[],
  body: Buffer | null,
  signal: AbortSignal | null,
  redirectMode: "follow" | "manual" | "error",
  profile: Profile,
): Promise<RawResponse> {
  return new Promise<RawResponse>((resolve, reject) => {
    let resolved = false;
    let done = false;
    let dump = false;
    let abortFn: ((err?: Error) => void) | null = null;

    // The response body: its stream controller, the unread bytes beside it,
    // and how to restart the paused producer.
    let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
    let hasBody = false;
    const queue: Buffer[] = [];
    let queued = 0;
    let ended = false;
    let closed = false;
    let onDrain: (() => void) | null = null;
    // The decoders, first-applied last; their listeners hold this scope, so
    // releaseDecoders drops them once the body ends, fails or is cancelled.
    let decoding = false;
    let decoders: Transform[] = [];
    let first: Transform | null = null;
    let encodedBytes = 0;
    let resumeConnection: (() => void) | null = null;

    const abortRequest = (err: Error): void => {
      const abort = abortFn;
      if (abort !== null && !done) abort(err);
    };
    const onAbort = (): void => {
      if (signal === null) return;
      const reason = abortReason(signal);
      // After the headers undici 7 errors the body with the signal's
      // reason; undici 5 aborts its fetch controller without one, so the
      // body gets the controller's default AbortError.
      errorBody(
        profile.major >= 7 ? reason : new DOMException("The operation was aborted.", "AbortError"),
      );
      abortRequest(reason);
    };
    const stopListening = (): void => {
      if (signal !== null) signal.removeEventListener("abort", onAbort);
    };
    if (signal !== null) signal.addEventListener("abort", onAbort);

    const releaseDecoders = (): void => {
      const chain = decoders;
      decoders = [];
      first = null;
      for (const decoder of chain) {
        decoder.removeAllListeners();
        decoder.destroy();
      }
    };
    const closeBody = (): void => {
      closed = true;
      controller!.close();
      stopListening();
    };
    const errorBody = (err: unknown): void => {
      if (!hasBody || closed) return;
      closed = true;
      queue.length = 0;
      queued = 0;
      controller!.error(err);
      stopListening();
      releaseDecoders();
    };
    const endBody = (): void => {
      if (closed) return;
      ended = true;
      if (queue.length === 0) closeBody();
    };
    /** Takes a chunk; false when the producer should pause until onDrain. */
    const pushBody = (chunk: Buffer): boolean => {
      if (closed) return true;
      if (queue.length === 0 && (controller!.desiredSize ?? 0) > 0) {
        controller!.enqueue(new Uint8Array(chunk));
        return true;
      }
      queue.push(chunk);
      queued += chunk.length;
      return queued < bodyHighWaterMark;
    };
    const pullBody = (): void => {
      if (closed) return;
      const next = queue.shift();
      if (next !== undefined) {
        queued -= next.length;
        controller!.enqueue(new Uint8Array(next));
      }
      if (queue.length === 0 && ended) {
        closeBody();
        return;
      }
      const drain = onDrain;
      if (drain !== null && queued < bodyHighWaterMark) {
        onDrain = null;
        drain();
      }
    };
    const cancelBody = (reason: unknown): void => {
      if (closed) return;
      closed = true;
      queue.length = 0;
      queued = 0;
      stopListening();
      releaseDecoders();
      abortRequest(
        reason instanceof Error
          ? reason
          : new DOMException("The operation was aborted.", "AbortError"),
      );
    };
    const failBody = (err: Error): void => {
      errorBody(new TypeError("terminated", { cause: err }));
      abortRequest(err);
    };

    const handler: DispatchHandlers = {
      onConnect: (abort: (err?: Error) => void): void => {
        abortFn = abort;
        if (signal !== null && signal.aborted) abort(abortReason(signal));
      },
      onHeaders: (statusCode: number, raw: Buffer[], resume: () => void, text: string): boolean => {
        if (statusCode < 200) return true;
        resolved = true;
        resumeConnection = resume;
        const rawHeaders: string[] = [];
        let location = false;
        let encoding: string | null = null;
        for (let i = 0; i + 1 < raw.length; i += 2) {
          const name = raw[i]!.toString("latin1");
          const value = raw[i + 1]!.toString("latin1");
          rawHeaders.push(name, value);
          const lower = name.toLowerCase();
          if (lower === "location") location = true;
          else if (lower === "content-encoding")
            encoding = encoding === null ? value : `${encoding}, ${value}`;
        }
        const follows =
          redirectStatuses.includes(statusCode) && location && redirectMode !== "manual";
        if (follows || nullBodyStatuses.includes(statusCode) || method === "HEAD") {
          dump = true;
          stopListening();
          resolve({ status: statusCode, statusText: text, headers: rawHeaders, body: null });
          // A redirect that is followed or rejected never reads its body:
          // abort the request so the connection is released instead of
          // draining a body that may never end.
          if (follows) abortRequest(new DOMException("The operation was aborted.", "AbortError"));
          return true;
        }
        const codings =
          encoding === null
            ? []
            : encoding
                .toLowerCase()
                .split(",")
                .map((c) => c.trim());
        if (codings.length > maxContentEncodings) {
          dump = true;
          stopListening();
          reject(
            new Error(
              `too many content-encodings in response: ${codings.length}, maximum allowed is ${maxContentEncodings}`,
            ),
          );
          abortRequest(new DOMException("The operation was aborted.", "AbortError"));
          return true;
        }
        hasBody = true;
        const stream = new ReadableStream<Uint8Array>({
          start: (c: ReadableStreamDefaultController<Uint8Array>): void => {
            controller = c;
          },
          pull: (): void => pullBody(),
          cancel: (reason: unknown): void => cancelBody(reason),
        });
        if (decodable(codings)) {
          // Decoders run last-applied coding first, piped into each other;
          // the last one feeds the body.
          decoding = true;
          let last: Transform | null = null;
          for (let i = codings.length - 1; i >= 0; i--) {
            const decoder = decoderFor(codings[i]!, profile);
            decoder.on("error", (err: Error) => failBody(err));
            if (last === null) first = decoder;
            else last.pipe(decoder);
            decoders.push(decoder);
            last = decoder;
          }
          const output = last!;
          output.on("data", (chunk: Buffer) => {
            if (!pushBody(chunk)) {
              output.pause();
              onDrain = (): void => {
                output.resume();
              };
            }
          });
          output.on("end", () => {
            releaseDecoders();
            endBody();
          });
          first!.on("drain", () => resume());
        }
        resolve({ status: statusCode, statusText: text, headers: rawHeaders, body: stream });
        return true;
      },
      onData: (chunk: Buffer): boolean => {
        if (dump || !hasBody || closed) return true;
        if (decoding) {
          const decoder = first;
          if (decoder === null) return true;
          encodedBytes += chunk.length;
          return decoder.write(chunk);
        }
        if (pushBody(chunk)) return true;
        onDrain = resumeConnection;
        return false;
      },
      onComplete: (_trailers: string[] | null): void => {
        done = true;
        if (!hasBody) {
          stopListening();
          return;
        }
        // zlib rejects an empty stream; undici ends such a body unread.
        const decoder = first;
        if (decoder !== null && encodedBytes > 0) {
          decoder.end();
        } else {
          releaseDecoders();
          endBody();
        }
      },
      onError: (err: Error): void => {
        done = true;
        if (!resolved) {
          stopListening();
          reject(err);
          return;
        }
        errorBody(new TypeError("terminated", { cause: err }));
      },
    };
    dispatcher.dispatch(
      {
        origin: url.origin,
        path: url.pathname + url.search,
        method,
        headers,
        body,
      },
      handler,
    );
  });
}
