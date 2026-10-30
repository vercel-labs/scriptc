// scriptc's built-in implementation of `@hono/node-server` 2.x: the Node.js
// adapter that serves a fetch-style handler (Hono's `app.fetch`) over
// node:http. The published package swaps the global Request and Response
// for lightweight objects and reparents prototypes, which only pays off
// under V8; this port builds native Request objects from the incoming
// message, with a body streamed from it as the app reads it, and writes
// the handler's Response the way the package's listener does (header
// record, content length for bodies that complete within the first reads,
// streamed bodies, error responses), so a client sees the same status
// lines, headers and bodies. A body the app leaves unread is drained after
// the response, within the package's limits.
//
// HTTP/1.1 only: the http2/https server options and WebSocket upgrades are
// not declared. A Response that is still exactly its constructor arguments
// takes the package's cached-response path (its lightweight Response), read
// from the runtime through scriptcResponseLight; every other Response takes
// the general path.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export type HttpBindings = {
  incoming: IncomingMessage;
  outgoing: ServerResponse;
};

export type ServerType = Server;

export type FetchCallback = (request: Request, env: HttpBindings) => Response | Promise<Response>;

export type CustomErrorHandler = (err: unknown) => void | Response | Promise<void | Response>;

export type Options = {
  fetch: FetchCallback;
  overrideGlobalObjects?: boolean;
  autoCleanupIncoming?: boolean;
  port?: number;
  hostname?: string;
};

export interface RequestListenerOptions {
  hostname?: string;
  errorHandler?: CustomErrorHandler;
  overrideGlobalObjects?: boolean;
  autoCleanupIncoming?: boolean;
}

export class RequestError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "RequestError";
  }
}

const DEFAULT_CONTENT_TYPE = "text/plain; charset=UTF-8";
const X_ALREADY_SENT = "x-hono-already-sent";

const reValidRequestUrl = /^\/[!#$&-;=?-[\]_a-z~]*$/;
const reDotSegment = /\/\.\.?(?:[/?#]|$)/;
const reValidHost = /^[a-z0-9._-]+(?::(?:[1-5]\d{3,4}|[6-9]\d{3}))?$/;

function buildUrl(scheme: string, host: string, incomingUrl: string): string {
  const url = `${scheme}://${host}${incomingUrl}`;
  if (!reValidHost.test(host)) {
    const urlObj = new URL(url);
    if (
      urlObj.hostname.length !== host.length &&
      urlObj.hostname !== (host.includes(":") ? host.replace(/:\d+$/, "") : host).toLowerCase()
    )
      throw new RequestError("Invalid host header");
    return urlObj.href;
  }
  if (incomingUrl.length === 0) return url + "/";
  if (incomingUrl.charCodeAt(0) !== 47) throw new RequestError("Invalid URL");
  if (!reValidRequestUrl.test(incomingUrl) || reDotSegment.test(incomingUrl))
    return new URL(url).href;
  return url;
}

function normalizeIncomingMethod(method: string | undefined): string {
  if (method === undefined || method.length === 0) return "GET";
  switch (method) {
    case "DELETE":
    case "GET":
    case "HEAD":
    case "OPTIONS":
    case "PATCH":
    case "POST":
    case "PUT":
    case "QUERY":
      return method;
  }
  const upper = method.toUpperCase();
  switch (upper) {
    case "DELETE":
    case "GET":
    case "HEAD":
    case "OPTIONS":
    case "POST":
    case "PUT":
      return upper;
    default:
      return method;
  }
}

/** The request URL the package builds: an absolute request target as is,
 * otherwise the Host header (or the configured hostname) over http. */
function requestUrl(incoming: IncomingMessage, defaultHostname: string | undefined): string {
  const incomingUrl = incoming.url ?? "";
  if (
    incomingUrl[0] !== "/" &&
    (incomingUrl.startsWith("http://") || incomingUrl.startsWith("https://"))
  ) {
    try {
      return new URL(incomingUrl).href;
    } catch (e) {
      throw new RequestError("Invalid absolute URL", { cause: e });
    }
  }
  const hostHeader = incoming.headers.host;
  const host = hostHeader !== undefined && hostHeader !== "" ? hostHeader : (defaultHostname ?? "");
  if (host === "") throw new RequestError("Missing host header");
  try {
    return buildUrl("http", host, incomingUrl);
  } catch (e) {
    if (e instanceof RequestError) throw e;
    throw new RequestError("Invalid URL", { cause: e });
  }
}

function requestHeaders(incoming: IncomingMessage): Headers {
  const headers = new Headers();
  const raw = incoming.rawHeaders;
  for (let i = 0; i < raw.length; i += 2) {
    const name = raw[i]!;
    if (!name.startsWith(":")) headers.append(name, raw[i + 1]!);
  }
  return headers;
}

/** What the listener knows about the incoming body: whether it ended
 * (the package's `readableEnded`) and whether a drain started. */
type IncomingState = { ended: boolean; draining: boolean };

/** The incoming message's readableHighWaterMark: Readable.toWeb queues
 * this many bytes before it pauses the message. */
const BODY_HIGH_WATER_MARK = 64 * 1024;

/** The request body as the package streams it: Readable.toWeb over the
 * incoming message, read one chunk per pull. Chunks queue until
 * BODY_HIGH_WATER_MARK bytes wait unread, then the message pauses until a
 * pull takes them, so the socket holds the rest. The stream pulls once on
 * its own when it is constructed; the package builds its stream only when
 * the app reads the body, so until the app's first read a drain discards
 * the chunks instead of queueing them. */
function incomingBody(incoming: IncomingMessage, state: IncomingState): ReadableStream<Uint8Array> {
  let pulls = 0;
  let listening = false;
  let ended = false;
  let failure: Error | undefined = undefined;
  const queue: Buffer[] = [];
  let queued = 0;
  let wake: (() => void) | undefined = undefined;
  const woken = (): void => {
    const resolve = wake;
    wake = undefined;
    if (resolve !== undefined) resolve();
  };
  const listen = (): void => {
    listening = true;
    incoming.on("data", (chunk: Buffer) => {
      if (state.draining && pulls === 1) return;
      queue.push(chunk);
      queued += chunk.length;
      if (queued >= BODY_HIGH_WATER_MARK) incoming.pause();
      woken();
    });
    incoming.on("end", () => {
      ended = true;
      woken();
    });
    incoming.on("error", (err: Error) => {
      failure = err;
      woken();
    });
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      pulls++;
      if (!listening) listen();
      for (;;) {
        const chunk = queue.shift();
        if (chunk !== undefined) {
          queued -= chunk.length;
          if (queued < BODY_HIGH_WATER_MARK) incoming.resume();
          controller.enqueue(chunk);
          return;
        }
        if (failure !== undefined) {
          controller.error(failure);
          return;
        }
        if (ended) {
          controller.close();
          return;
        }
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    },
  });
}

function newRequest(
  incoming: IncomingMessage,
  defaultHostname: string | undefined,
  state: IncomingState,
): Request {
  const method = normalizeIncomingMethod(incoming.method);
  const url = requestUrl(incoming, defaultHostname);
  const headers = requestHeaders(incoming);
  if (method === "GET" || method === "HEAD") return new Request(url, { method, headers });
  return new Request(url, {
    method,
    headers,
    body: incomingBody(incoming, state),
    duplex: "half",
  });
}

const DRAIN_TIMEOUT_MS = 500;
const MAX_DRAIN_BYTES = 64 * 1024 * 1024;

/** The package's drain of a body the app left unread: read and discard
 * up to MAX_DRAIN_BYTES or DRAIN_TIMEOUT_MS, then close the connection
 * once its writes are out. */
function drainIncoming(incoming: IncomingMessage, state: IncomingState): void {
  const socket = incoming.socket;
  if (socket.destroyed || state.draining) return;
  state.draining = true;
  let bytesRead = 0;
  let done = false;
  const cleanup = (): void => {
    if (done) return;
    done = true;
    clearTimeout(timer);
  };
  const forceClose = (): void => {
    if (done) return;
    cleanup();
    if (!socket.destroyed) socket.destroySoon();
  };
  const timer = setTimeout(forceClose, DRAIN_TIMEOUT_MS);
  timer.unref();
  incoming.on("data", (chunk: Buffer) => {
    if (done) return;
    bytesRead += chunk.length;
    if (bytesRead > MAX_DRAIN_BYTES) forceClose();
  });
  incoming.on("end", cleanup);
  incoming.on("error", cleanup);
  incoming.resume();
}

/** The package's close handler cleanup: an unread body drains two timer
 * turns after the response closes. */
function drainAfterClose(incoming: IncomingMessage, state: IncomingState): void {
  if (state.ended) return;
  setTimeout(() => {
    if (!state.ended)
      setTimeout(() => {
        drainIncoming(incoming, state);
      });
  });
}

/** The package's outgoing header record: Headers order (lowercase,
 * sorted), Set-Cookie values gathered into one array entry at the end,
 * and the default content type for a response with a body. */
function buildOutgoingHttpHeaders(
  headers: Headers,
  hasBody: boolean,
): Record<string, string | string[]> {
  const res: Record<string, string | string[]> = {};
  if (headers.has("set-cookie")) {
    const cookies: string[] = [];
    headers.forEach((v, k) => {
      if (k === "set-cookie") cookies.push(v);
      else res[k] = v;
    });
    // Headers.forEach joins nothing but set-cookie, which getSetCookie
    // lists value by value, as the package's iteration does.
    if (cookies.length > 0) res["set-cookie"] = headers.getSetCookie();
  } else {
    headers.forEach((v, k) => {
      res[k] = v;
    });
  }
  if (hasBody && res["content-type"] === undefined) res["content-type"] = DEFAULT_CONTENT_TYPE;
  return res;
}

/* Spelled out rather than ReadableStreamReadResult<Uint8Array>, whose
 * declaration depends on the program's lib and @types/node settings: the
 * shim compiles inside every program that imports the package. */
type ReadResult = { done: boolean; value?: Uint8Array };

function readWithoutBlocking(read: Promise<ReadResult>): Promise<ReadResult | undefined> {
  return Promise.race([read, Promise.resolve().then(() => Promise.resolve(undefined))]);
}

function nextTick(): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve);
  });
}

/** Writes the rest of a body stream. As in the package, a response that
 * closes before the stream ends (the client disconnected) cancels the
 * stream, so its producer stops; the pending read then answers done. A
 * response that fails closes too, and its stream is cancelled the same way
 * (the package passes the error as the reason). The listener stays attached
 * and does nothing once the stream has ended. */
async function pump(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  outgoing: ServerResponse,
  pending: Promise<ReadResult> | undefined,
): Promise<void> {
  let finished = false;
  outgoing.on("close", () => {
    if (!finished) reader.cancel().catch(() => {});
  });
  try {
    let read = pending ?? reader.read();
    for (;;) {
      const { done, value } = await read;
      if (done) {
        outgoing.end();
        return;
      }
      outgoing.write(value!);
      read = reader.read();
    }
  } finally {
    finished = true;
  }
}

function handleResponseError(e: unknown, outgoing: ServerResponse): void {
  const err = e instanceof Error ? e : new Error("unknown error", { cause: e });
  console.error(e);
  if (!outgoing.headersSent) outgoing.writeHead(500, { "Content-Type": "text/plain" });
  outgoing.end(`Error: ${err.message}`);
  outgoing.destroy();
}

function emptyResponse(status: number): Response {
  return new Response(null, { status });
}

/** The lightweight state of a constructed Response (the runtime's
 * scr_fetch_response_light): [form, flags, byte length, ...record pairs]. */
declare function scriptcResponseLight(res: Response): string[];

const UNDICI_TEXT_TYPE = "text/plain;charset=UTF-8";

/** Content-Length as Node's implicit header: set the headers one by one and
 * let end(body) compute the length, which Node then writes after its own
 * Date/Connection headers, as the package's preset length does. */
function endWithImplicitLength(
  outgoing: ServerResponse,
  status: number,
  header: Record<string, string | string[]>,
  body: Uint8Array,
): void {
  outgoing.statusCode = status;
  for (const name of Object.keys(header)) outgoing.setHeader(name, header[name]!);
  outgoing.end(body);
}

/** The package's cached-response path: a Response that is still exactly
 * its constructor arguments (no body or metadata read since) is written
 * from them. Form 1 has no init headers, form 2 Headers, form 3 a plain
 * record kept verbatim. */
async function writeLightResponse(
  res: Response,
  outgoing: ServerResponse,
  light: string[],
  head: boolean,
): Promise<void> {
  const form = light[0]!;
  const flags = light[1]!;
  const length = Number(light[2]!);
  const status = res.status;
  const sized = length >= 0;
  if (form === "1") {
    if (length === -1) {
      outgoing.writeHead(status);
      outgoing.end();
    } else if (sized) {
      const body = await res.bytes();
      if (head) {
        outgoing.writeHead(status, {
          "Content-Type": DEFAULT_CONTENT_TYPE,
          "Content-Length": String(length),
        });
        outgoing.end(body);
      } else
        endWithImplicitLength(outgoing, status, { "Content-Type": DEFAULT_CONTENT_TYPE }, body);
    } else {
      outgoing.writeHead(status, { "Content-Type": DEFAULT_CONTENT_TYPE });
      outgoing.flushHeaders();
      await pump(res.body!.getReader(), outgoing, undefined);
    }
    return;
  }
  let header: Record<string, string | string[]>;
  let hasContentLength = false;
  let plain = false;
  let canAutoLength = true;
  if (form === "2") {
    const headers = new Headers(res.headers);
    if (flags.includes("a") && headers.get("content-type") === UNDICI_TEXT_TYPE) {
      if (flags.includes("d")) headers.set("content-type", DEFAULT_CONTENT_TYPE);
      else headers.delete("content-type");
    } else if (flags.includes("d") && !headers.has("content-type")) {
      headers.set("content-type", DEFAULT_CONTENT_TYPE);
    }
    hasContentLength = headers.has("content-length");
    header = buildOutgoingHttpHeaders(headers, length !== -1);
  } else {
    plain = true;
    header = {};
    for (let i = 3; i + 1 < light.length; i += 2) {
      const name = light[i]!;
      const value = light[i + 1]!;
      const previous = header[name];
      if (previous === undefined) header[name] = value;
      else if (typeof previous === "string") header[name] = [previous, value];
      else previous.push(value);
      const lower = name.toLowerCase();
      if (lower === "content-length") hasContentLength = true;
      else if (lower === "transfer-encoding" || lower === "trailer") canAutoLength = false;
    }
  }
  const body = sized ? await res.bytes() : undefined;
  if (!hasContentLength && body !== undefined) {
    if (plain && canAutoLength && !head && status !== 204 && status !== 304) {
      endWithImplicitLength(outgoing, status, header, body);
      return;
    }
    header["Content-Length"] = String(length);
  }
  outgoing.writeHead(status, header);
  if (length === -1) outgoing.end();
  else if (body !== undefined) outgoing.end(body);
  else {
    outgoing.flushHeaders();
    await pump(res.body!.getReader(), outgoing, undefined);
  }
}

async function writeResponse(
  res: Response,
  outgoing: ServerResponse,
  head: boolean,
): Promise<void> {
  const light = scriptcResponseLight(res);
  if (light[0] !== "0") return writeLightResponse(res, outgoing, light, head);
  const body = res.body;
  const record = buildOutgoingHttpHeaders(res.headers, body !== null);
  if (body !== null) {
    const reader: ReadableStreamDefaultReader<Uint8Array> = body.getReader();
    const values: Uint8Array[] = [];
    let done = false;
    let pending: Promise<ReadResult> | undefined = undefined;
    if (record["transfer-encoding"] !== "chunked") {
      let maxReadCount = 2;
      for (let i = 0; i < maxReadCount; i++) {
        pending ??= reader.read();
        let chunk: ReadResult | undefined = undefined;
        try {
          chunk = await readWithoutBlocking(pending);
        } catch (e) {
          console.error(e);
          done = true;
        }
        if (chunk === undefined) {
          if (i === 1 && !done) {
            await nextTick();
            maxReadCount = 3;
            continue;
          }
          break;
        }
        pending = undefined;
        if (chunk.value !== undefined) values.push(chunk.value);
        if (chunk.done) {
          done = true;
          break;
        }
      }
      if (done && record["content-length"] === undefined) {
        let length = 0;
        for (const value of values) length += value.length;
        record["content-length"] = String(length);
      }
    }
    outgoing.writeHead(res.status, record);
    for (const value of values) outgoing.write(value);
    if (done) outgoing.end();
    else {
      if (values.length === 0) outgoing.flushHeaders();
      await pump(reader, outgoing, pending);
    }
  } else if (record[X_ALREADY_SENT] === undefined) {
    outgoing.writeHead(res.status, record);
    outgoing.end();
  }
}

async function respond(
  pending: Response | Promise<Response>,
  outgoing: ServerResponse,
  errorHandler: CustomErrorHandler | undefined,
  head: boolean,
): Promise<void> {
  let res: Response;
  if (pending instanceof Promise) {
    try {
      res = await pending;
    } catch (err) {
      if (errorHandler === undefined) {
        res = handleFetchError(err);
      } else {
        const errRes = await errorHandler(err);
        if (errRes === undefined) return;
        res = errRes;
      }
    }
  } else res = pending;
  await writeResponse(res, outgoing, head);
}

/** A Response the package writes from its cache without waiting: still
 * exactly its constructor arguments, with no body or a string or bytes
 * body. */
function immediateCacheable(res: Response): boolean {
  const light = scriptcResponseLight(res);
  return light[0] !== "0" && Number(light[2]!) >= -1;
}

function handleFetchError(e: unknown): Response {
  return emptyResponse(e instanceof Error && e.name === "TimeoutError" ? 504 : 500);
}

async function handleRequest(
  fetchCallback: FetchCallback,
  options: RequestListenerOptions,
  incoming: IncomingMessage,
  outgoing: ServerResponse,
): Promise<void> {
  let req: Request | undefined = undefined;
  let res: Response | Promise<Response> | undefined = undefined;
  const state: IncomingState = { ended: false, draining: false };
  let needsBodyCleanup = false;
  let closeHandlerAttached = false;
  const ensureCloseHandler = (): void => {
    if (req === undefined || closeHandlerAttached) return;
    closeHandlerAttached = true;
    if (needsBodyCleanup)
      outgoing.on("close", () => {
        drainAfterClose(incoming, state);
      });
  };
  try {
    req = newRequest(incoming, options.hostname, state);
    needsBodyCleanup =
      options.autoCleanupIncoming !== false &&
      !(incoming.method === "GET" || incoming.method === "HEAD");
    if (needsBodyCleanup)
      incoming.on("end", () => {
        state.ended = true;
      });
    res = fetchCallback(req, { incoming, outgoing });
    if (!(res instanceof Promise) && immediateCacheable(res)) {
      if (needsBodyCleanup)
        outgoing.once("finish", () => {
          if (!state.ended) drainIncoming(incoming, state);
        });
    } else ensureCloseHandler();
  } catch (e) {
    if (res !== undefined) return handleResponseError(e, outgoing);
    const errorHandler = options.errorHandler;
    if (errorHandler !== undefined) {
      ensureCloseHandler();
      const handled = await errorHandler(
        req !== undefined ? e : e instanceof RequestError ? e : toRequestError(e),
      );
      if (handled === undefined) return;
      res = handled;
    } else if (req === undefined) res = emptyResponse(400);
    else res = handleFetchError(e);
  }
  try {
    await respond(res, outgoing, options.errorHandler, incoming.method === "HEAD");
  } catch (e) {
    handleResponseError(e, outgoing);
  }
}

function toRequestError(e: unknown): RequestError {
  return new RequestError(e instanceof Error ? e.message : String(e), { cause: e });
}

export function getRequestListener(
  fetchCallback: FetchCallback,
  options: RequestListenerOptions = {},
): (incoming: IncomingMessage, outgoing: ServerResponse) => Promise<void> {
  return (incoming, outgoing) => handleRequest(fetchCallback, options, incoming, outgoing);
}

export function createAdaptorServer(options: Options): ServerType {
  const listener = getRequestListener(options.fetch, {
    hostname: options.hostname,
    overrideGlobalObjects: options.overrideGlobalObjects,
    autoCleanupIncoming: options.autoCleanupIncoming,
  });
  return createServer((incoming, outgoing) => {
    void listener(incoming, outgoing);
  });
}

export function serve(
  options: Options,
  listeningListener?: (info: AddressInfo) => void,
): ServerType {
  const server = createAdaptorServer(options);
  server.listen(options.port ?? 3000, options.hostname, () => {
    const info = server.address() as AddressInfo;
    if (listeningListener !== undefined) listeningListener(info);
  });
  return server;
}
