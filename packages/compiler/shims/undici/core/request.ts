// undici's per-dispatch request record (lib/core/request.js): option
// validation, header processing, and the handler callbacks with their
// diagnostics_channel publications.
import { channels } from "./diagnostics.ts";
import { InvalidArgumentError, NotSupportedError } from "./errors.ts";
import type { DispatchHandlers, DispatchOptions, Profile } from "./types.ts";

const tokenRegExp = /^[\^_`a-zA-Z\-0-9!#$%&'*+.|~]+$/;
const headerCharRegex = /[^\t\x20-\x7e\x80-\xff]/;
const invalidPathRegex = /[^!-ÿ]/;

export class Request {
  origin: string;
  method: string;
  path: string;
  body: Buffer | null;
  /** Header name/value pairs in insertion order (host and content-length
   * are consumed into their own fields, like undici). */
  headerPairs: string[];
  host: string | null;
  contentLength: number | null;
  contentType: string | null;
  completed: boolean;
  aborted: boolean;
  idempotent: boolean;
  blocking: boolean;
  reset: boolean | null;
  headersTimeout: number | null;
  bodyTimeout: number | null;
  throwOnError: boolean;
  servername: string | null;
  error: Error | null;
  abortFn: ((err?: Error) => void) | null;
  handler: DispatchHandlers;
  profile: Profile;
  /** The request as diagnostics_channel subscribers see it: one untyped
   * object per request, so its identity is stable across publications.
   * The request keeps its completed and headers fields current. */
  diagnostic: unknown;

  constructor(origin: string, opts: DispatchOptions, handler: DispatchHandlers, profile: Profile) {
    const path = opts.path;
    const method = opts.method;
    if (typeof path !== "string") {
      throw new InvalidArgumentError("path must be a string");
    } else if (
      path[0] !== "/" &&
      !(path.startsWith("http://") || path.startsWith("https://")) &&
      method !== "CONNECT"
    ) {
      throw new InvalidArgumentError("path must be an absolute URL or start with a slash");
    } else if (invalidPathRegex.test(path)) {
      throw new InvalidArgumentError("invalid request path");
    }
    if (typeof method !== "string") {
      throw new InvalidArgumentError("method must be a string");
    } else if (!tokenRegExp.test(method)) {
      throw new InvalidArgumentError("invalid request method");
    }
    if (method === "CONNECT") {
      throw new NotSupportedError(
        "scriptc's undici client does not implement CONNECT requests yet",
      );
    }
    const headersTimeout = opts.headersTimeout ?? null;
    if (headersTimeout !== null && (!Number.isFinite(headersTimeout) || headersTimeout < 0)) {
      throw new InvalidArgumentError("invalid headersTimeout");
    }
    const bodyTimeout = opts.bodyTimeout ?? null;
    if (bodyTimeout !== null && (!Number.isFinite(bodyTimeout) || bodyTimeout < 0)) {
      throw new InvalidArgumentError("invalid bodyTimeout");
    }

    this.origin = origin;
    this.method = method;
    this.path = path;
    this.headersTimeout = headersTimeout;
    this.bodyTimeout = bodyTimeout;
    // 7.x dropped throwOnError (the responseError interceptor replaced it).
    if (profile.major >= 7 && opts.throwOnError !== undefined) {
      throw new InvalidArgumentError("invalid throwOnError");
    }
    this.throwOnError = opts.throwOnError === true;

    const body = opts.body ?? null;
    if (body === null) {
      this.body = null;
    } else if (typeof body === "string") {
      this.body = body.length > 0 ? Buffer.from(body) : null;
    } else {
      this.body =
        body.byteLength > 0 ? Buffer.from(body.buffer, body.byteOffset, body.byteLength) : null;
    }

    this.completed = false;
    this.profile = profile;
    this.aborted = false;
    this.idempotent = opts.idempotent ?? (method === "HEAD" || method === "GET");
    this.blocking = opts.blocking ?? (profile.major >= 7 ? method !== "HEAD" : false);
    this.reset = opts.reset ?? null;
    this.host = null;
    this.contentLength = null;
    this.contentType = null;
    this.headerPairs = [];
    this.error = null;
    this.abortFn = null;

    const headers = opts.headers ?? null;
    if (headers !== null) {
      if (Array.isArray(headers)) {
        if (headers.length % 2 !== 0) throw new InvalidArgumentError("headers array must be even");
        for (let i = 0; i < headers.length; i += 2) {
          processHeader(this, headers[i]!, headers[i + 1]!, profile);
        }
      } else {
        for (const key of Object.keys(headers)) {
          const value = headers[key];
          if (value === undefined) continue;
          if (typeof value === "string") {
            processHeader(this, key, value, profile);
          } else if (profile.major >= 7) {
            for (const item of value) processHeader(this, key, item, profile);
          } else {
            throw new InvalidArgumentError(`invalid ${key} header`);
          }
        }
      }
    }

    this.servername = serverName(this.host);
    this.handler = handler;
    this.diagnostic = null;
    if (channels.create.hasSubscribers) channels.create.publish({ request: this.diagnosticView() });
  }

  diagnosticView(): unknown {
    if (this.diagnostic === null) {
      // addHeader adds a header as undici's Request.addHeader does (the
      // tracing instrumentations' header injection).
      const view: any = {
        origin: this.origin,
        completed: this.completed,
        method: this.method,
        path: this.path,
        headers: this.diagnosticHeaders(),
        addHeader: (key: string, value: string): unknown => {
          this.addHeader(key, value);
          return view;
        },
      };
      this.diagnostic = view;
    }
    return this.diagnostic;
  }

  /** The diagnostics view's headers: undici 7 publishes its header array,
   * undici 5 the raw block. */
  diagnosticHeaders(): string | string[] {
    return this.profile.major >= 7 ? this.headerPairs.slice() : this.headers;
  }

  /** The DiagnosticsChannel.Request view's raw header block. */
  get headers(): string {
    let out = "";
    for (let i = 0; i < this.headerPairs.length; i += 2) {
      out += `${this.headerPairs[i]}: ${this.headerPairs[i + 1]}\r\n`;
    }
    return out;
  }

  addHeader(key: string, value: string): Request {
    processHeader(this, key, value, this.profile);
    const view: any = this.diagnostic;
    if (view !== null) view.headers = this.diagnosticHeaders();
    return this;
  }

  onBodySent(chunk: Buffer): void {
    const cb = this.handler.onBodySent;
    if (cb !== undefined) {
      try {
        this.handler.onBodySent!(chunk.length, chunk.length);
      } catch (err) {
        this.onError(err as Error);
      }
    }
  }

  onRequestSent(): void {
    if (channels.bodySent.hasSubscribers)
      channels.bodySent.publish({ request: this.diagnosticView() });
  }

  onConnect(abort: (err?: Error) => void): void {
    if (this.error !== null) {
      abort(this.error);
      return;
    }
    this.abortFn = abort;
    if (this.handler.onConnect !== undefined) this.handler.onConnect!(abort);
  }

  onHeaders(
    statusCode: number,
    headers: Buffer[],
    resume: () => void,
    statusText: string,
  ): boolean {
    if (channels.headers.hasSubscribers) {
      channels.headers.publish({
        request: this.diagnosticView(),
        response: { statusCode, headers, statusText },
      });
    }
    if (this.handler.onHeaders === undefined) return true;
    return this.handler.onHeaders!(statusCode, headers, resume, statusText);
  }

  onData(chunk: Buffer): boolean {
    if (this.handler.onData === undefined) return true;
    return this.handler.onData!(chunk);
  }

  onComplete(trailers: Buffer[]): void {
    this.completed = true;
    const view: any = this.diagnostic;
    if (view !== null) view.completed = true;
    if (channels.trailers.hasSubscribers)
      channels.trailers.publish({ request: this.diagnosticView(), trailers });
    if (this.handler.onComplete !== undefined) {
      const raw: string[] = [];
      for (const t of trailers) raw.push(t.toString("latin1"));
      this.handler.onComplete!(raw);
    }
  }

  onError(error: Error): void {
    if (channels.error.hasSubscribers)
      channels.error.publish({ request: this.diagnosticView(), error });
    if (this.aborted) return;
    this.aborted = true;
    if (this.handler.onError !== undefined) this.handler.onError!(error);
  }
}

function processHeader(request: Request, key: string, val: string, profile: Profile): void {
  const lower = key.toLowerCase();
  // undici 7 checks the name and every value before the special cases;
  // undici 5 checks the first Host value before storing it. Either way a
  // CR or LF in a value never reaches the request head.
  if (profile.major >= 7) {
    if (!tokenRegExp.test(lower)) throw new InvalidArgumentError("invalid header key");
    if (headerCharRegex.test(val)) throw new InvalidArgumentError(`invalid ${key} header`);
  }
  if (lower === "host") {
    // The client writes the Host value into the request head as given.
    if (headerCharRegex.test(val)) throw new InvalidArgumentError(`invalid ${key} header`);
    if (request.host === null) {
      if (headerCharRegex.test(val)) throw new InvalidArgumentError(`invalid ${key} header`);
      request.host = val;
      return;
    }
    if (profile.major >= 7) throw new InvalidArgumentError("duplicate host header");
  } else if (lower === "content-length") {
    if (request.contentLength === null) {
      const n = parseInt(val, 10);
      if (!Number.isFinite(n) || (profile.major >= 7 && !/^\d+$/.test(val))) {
        throw new InvalidArgumentError("invalid content-length header");
      }
      request.contentLength = n;
      return;
    }
    // The client writes the one Content-Length it validated or computed
    // from the body; a second field would frame the request twice. Both
    // profiles reject it with undici 7's error (5.x sends it as given).
    throw new InvalidArgumentError("duplicate content-length header");
  }
  if (lower === "content-type" && request.contentType === null && !headerCharRegex.test(val)) {
    request.contentType = val;
    request.headerPairs.push(key, val);
    return;
  }
  if (lower === "transfer-encoding" || lower === "keep-alive" || lower === "upgrade") {
    throw new InvalidArgumentError(`invalid ${lower} header`);
  }
  if (lower === "connection") {
    if (profile.major < 7) throw new InvalidArgumentError("invalid connection header");
    for (const token of val.toLowerCase().split(",")) {
      const trimmed = token.trim();
      if (!tokenRegExp.test(trimmed)) throw new InvalidArgumentError("invalid connection header");
      if (trimmed === "close") request.reset = true;
    }
    return;
  }
  if (lower === "expect") throw new NotSupportedError("expect header not supported");
  if (!tokenRegExp.test(key)) throw new InvalidArgumentError("invalid header key");
  if (headerCharRegex.test(val)) throw new InvalidArgumentError(`invalid ${key} header`);
  request.headerPairs.push(key, val);
}

/** util.getServerName: the Host header without its port; null for IPs. */
function serverName(host: string | null): string | null {
  if (host === null || host === "") return null;
  let name = host;
  if (name.startsWith("[")) {
    const idx = name.indexOf("]");
    if (idx !== -1) name = name.slice(1, idx);
    return null;
  }
  const idx = name.indexOf(":");
  if (idx !== -1) name = name.slice(0, idx);
  return /^\d+\.\d+\.\d+\.\d+$/.test(name) ? null : name;
}
