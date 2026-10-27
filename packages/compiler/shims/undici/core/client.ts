// undici's Client (lib/dispatcher/client.js + client-h1.js): HTTP/1.1 over
// one TCP/TLS connection at a time, with keep-alive reuse, a request queue,
// headers/body/idle timeouts and the same request lifecycle callbacks.
import type { Socket } from "node:net";
import { buildConnector } from "./connector.ts";
import { channels } from "./diagnostics.ts";
import { DispatcherBase } from "./dispatcher.ts";
import type { Dispatcher } from "./dispatcher.ts";
import {
  BodyTimeoutError,
  HeadersOverflowError,
  HeadersTimeoutError,
  HTTPParserError,
  InformationalError,
  InvalidArgumentError,
  NotSupportedError,
  RequestAbortedError,
  RequestContentLengthMismatchError,
  ResponseContentLengthMismatchError,
  ResponseExceededMaxSizeError,
  SocketError,
  UndiciError,
} from "./errors.ts";
import type { SocketInfo } from "./errors.ts";
import { Request } from "./request.ts";
import { FastTimer } from "./timers.ts";
import { parseKeepAliveTimeout, parseOrigin } from "./util.ts";
import type {
  ClientOptions,
  Connector,
  ConnectorOptions,
  DispatchHandlers,
  DispatchOptions,
  Profile,
} from "./types.ts";

const TIMEOUT_NONE = 0;
const TIMEOUT_HEADERS = 1;
const TIMEOUT_BODY = 2;
const TIMEOUT_IDLE = 3;

export class Client extends DispatcherBase {
  __url: URL;
  __connector: Connector;
  __socket: Socket | null;
  __connecting: boolean;
  __queue: (Request | null)[];
  __runningIdx: number;
  __pendingIdx: number;
  __pipelining: number;
  __hostHeader: string;
  __maxHeaderSize: number;
  __keepAliveDefaultTimeout: number;
  __keepAliveMaxTimeout: number;
  __keepAliveTimeoutThreshold: number;
  __keepAliveTimeoutValue: number;
  __headersTimeout: number;
  __bodyTimeout: number;
  __strictContentLength: boolean;
  __maxRequests: number;
  __maxResponseSize: number;
  __resuming: number;
  __needDrain: number;
  __closedResolve: (() => void) | null;
  __serverName: string | null;
  __localAddress: string | null;
  // Per-connection state (one socket at a time).
  __sockNoRef: boolean;
  __sockReset: boolean;
  __sockBlocking: boolean;
  __sockCounter: number;
  __parser: ResponseParser | null;
  __sockError: Error | null;
  // The parser timer, held as closures over its handle (a nullable timer
  // field does not compile under @types/node).
  __timerCancel: (() => void) | null;
  __timerRefresh: (() => void) | null;
  __timerType: number;

  constructor(url: string | URL, options: ClientOptions | undefined, profile: Profile) {
    super(profile);
    const opts: ClientOptions = options ?? {};
    const pipelining = opts.pipelining ?? 1;
    if (!Number.isInteger(pipelining) || pipelining < 0) {
      throw new InvalidArgumentError("invalid pipelining");
    }
    if (pipelining > 1) {
      throw new NotSupportedError(
        "scriptc's undici client does not pipeline more than one request yet",
      );
    }
    const maxHeaderSize = opts.maxHeaderSize ?? null;
    if (maxHeaderSize !== null && !Number.isFinite(maxHeaderSize)) {
      throw new InvalidArgumentError("invalid maxHeaderSize");
    }
    const connectTimeout = opts.connectTimeout ?? null;
    if (connectTimeout !== null && (!Number.isFinite(connectTimeout) || connectTimeout < 0)) {
      throw new InvalidArgumentError("invalid connectTimeout");
    }
    const keepAliveTimeout = opts.keepAliveTimeout ?? null;
    if (
      keepAliveTimeout !== null &&
      (!Number.isFinite(keepAliveTimeout) || keepAliveTimeout <= 0)
    ) {
      throw new InvalidArgumentError("invalid keepAliveTimeout");
    }
    const keepAliveMaxTimeout = opts.keepAliveMaxTimeout ?? null;
    if (
      keepAliveMaxTimeout !== null &&
      (!Number.isFinite(keepAliveMaxTimeout) || keepAliveMaxTimeout <= 0)
    ) {
      throw new InvalidArgumentError("invalid keepAliveMaxTimeout");
    }
    const keepAliveTimeoutThreshold = opts.keepAliveTimeoutThreshold ?? null;
    if (keepAliveTimeoutThreshold !== null && !Number.isFinite(keepAliveTimeoutThreshold)) {
      throw new InvalidArgumentError("invalid keepAliveTimeoutThreshold");
    }
    const headersTimeout = opts.headersTimeout ?? null;
    if (headersTimeout !== null && (!Number.isInteger(headersTimeout) || headersTimeout < 0)) {
      throw new InvalidArgumentError("headersTimeout must be a positive integer or zero");
    }
    const bodyTimeout = opts.bodyTimeout ?? null;
    if (bodyTimeout !== null && (!Number.isInteger(bodyTimeout) || bodyTimeout < 0)) {
      throw new InvalidArgumentError("bodyTimeout must be a positive integer or zero");
    }
    const maxRequests = opts.maxRequestsPerClient ?? 0;
    if (!Number.isInteger(maxRequests) || maxRequests < 0) {
      throw new InvalidArgumentError("maxRequestsPerClient must be a positive number");
    }
    const maxResponseSize = opts.maxResponseSize ?? -1;
    if (!Number.isInteger(maxResponseSize) || maxResponseSize < -1) {
      throw new InvalidArgumentError("maxResponseSize must be a positive number");
    }

    const connect = opts.connect ?? null;
    if (typeof connect === "function") {
      this.__connector = connect;
    } else {
      this.__connector = buildConnector(
        connect !== null
          ? {
              ...connect,
              timeout: connect.timeout !== undefined ? connect.timeout : connectTimeout,
            }
          : { timeout: connectTimeout },
      );
    }
    // 5.x composes `interceptors.Client` around dispatch; 7.x dropped the
    // option and ignores it.
    const interceptors = opts.interceptors;
    if (profile.major < 7 && interceptors !== undefined && interceptors.Client !== undefined) {
      this.__interceptors = interceptors.Client;
    }

    this.__url = parseOrigin(url, profile);
    this.__socket = null;
    this.__connecting = false;
    this.__queue = [];
    this.__runningIdx = 0;
    this.__pendingIdx = 0;
    this.__pipelining = pipelining;
    this.__hostHeader = `host: ${this.__url.hostname}${this.__url.port ? `:${this.__url.port}` : ""}\r\n`;
    this.__maxHeaderSize = maxHeaderSize !== null && maxHeaderSize !== 0 ? maxHeaderSize : 16384;
    this.__keepAliveDefaultTimeout = keepAliveTimeout ?? 4e3;
    this.__keepAliveMaxTimeout = keepAliveMaxTimeout ?? 600e3;
    this.__keepAliveTimeoutThreshold =
      keepAliveTimeoutThreshold ?? (profile.major >= 7 ? 2e3 : 1e3);
    this.__keepAliveTimeoutValue = this.__keepAliveDefaultTimeout;
    const defaultTimeout = profile.major >= 7 ? 300e3 : 30e3;
    this.__headersTimeout = headersTimeout ?? defaultTimeout;
    this.__bodyTimeout = bodyTimeout ?? defaultTimeout;
    this.__strictContentLength = opts.strictContentLength ?? true;
    this.__maxRequests = maxRequests;
    this.__maxResponseSize = maxResponseSize;
    this.__resuming = 0;
    this.__needDrain = 0;
    this.__closedResolve = null;
    this.__serverName = null;
    this.__localAddress = opts.localAddress ?? null;
    this.__sockNoRef = false;
    this.__sockReset = false;
    this.__sockBlocking = false;
    this.__sockCounter = 0;
    this.__parser = null;
    this.__sockError = null;
    this.__timerCancel = null;
    this.__timerRefresh = null;
    this.__timerType = TIMEOUT_NONE;
  }

  get pipelining(): number {
    return this.__pipelining;
  }

  __pendingCount(): number {
    return this.__queue.length - this.__pendingIdx;
  }

  __runningCount(): number {
    return this.__pendingIdx - this.__runningIdx;
  }

  __sizeCount(): number {
    return this.__queue.length - this.__runningIdx;
  }

  __connectedFlag(): boolean {
    const socket = this.__socket;
    return socket !== null && !this.__connecting && !socket.destroyed;
  }

  __busy(): boolean {
    return (
      (this.__socket !== null && (this.__sockReset || this.__sockBlocking)) ||
      this.__sizeCount() >= (this.__pipelining || 1) ||
      this.__pendingCount() > 0
    );
  }

  __dispatch(opts: DispatchOptions, handler: DispatchHandlers): boolean {
    const originValue = opts.origin;
    const origin =
      originValue === undefined || originValue === ""
        ? this.__url.origin
        : typeof originValue === "string"
          ? originValue
          : originValue.origin;
    const request = new Request(origin, opts, handler, this.__profile);
    this.__queue.push(request);
    if (this.__resuming === 0) this.__resume(true);
    if (this.__resuming !== 0 && this.__needDrain !== 2 && this.__busy()) this.__needDrain = 2;
    return this.__needDrain < 2;
  }

  __close(): Promise<void> {
    return new Promise<void>((resolve) => {
      if (this.__sizeCount() === 0) {
        this.destroy().then(() => resolve());
      } else {
        this.__closedResolve = resolve;
      }
    });
  }

  __destroy(err: Error): Promise<void> {
    return new Promise<void>((resolve) => {
      const requests = this.__queue.splice(this.__pendingIdx);
      for (const request of requests) if (request !== null) this.__errorRequest(request, err);
      const done = (): void => {
        const closed = this.__closedResolve;
        if (closed !== null) {
          this.__closedResolve = null;
          closed();
        }
        resolve();
      };
      const socket = this.__socket;
      if (socket === null) {
        queueMicrotask(done);
      } else {
        socket.on("close", () => done());
        this.__destroySocket(socket, err);
      }
      this.__resume(false);
    });
  }

  /** util.destroy(socket, err): remember the first error for 'close'. */
  __destroySocket(socket: Socket, err: Error): void {
    if (socket === this.__socket && this.__sockError === null) this.__sockError = err;
    socket.destroy();
  }

  __errorRequest(request: Request, err: Error): void {
    try {
      request.onError(err);
    } catch (e) {
      this.emit("error", e as Error);
    }
  }

  __socketInfo(): SocketInfo {
    const socket = this.__socket;
    if (socket === null) return {};
    return {
      localAddress: socket.localAddress,
      localPort: socket.localPort,
      remoteAddress: socket.remoteAddress,
      remotePort: socket.remotePort,
      remoteFamily: socket.remoteFamily,
      timeout: undefined,
      bytesWritten: socket.bytesWritten,
      bytesRead: socket.bytesRead,
    };
  }

  /** The parser timer: 5.x uses native timers throughout; 7.x drives the
   * headers and body timeouts from its fast timers. */
  __setTimeout(delay: number, type: number): void {
    this.__clearTimer();
    this.__timerType = type;
    if (delay > 0) {
      if (this.__profile.major >= 7 && (type === TIMEOUT_HEADERS || type === TIMEOUT_BODY)) {
        const fast = new FastTimer(() => this.__onTimeout(), delay);
        this.__timerCancel = () => fast.clear();
        this.__timerRefresh = () => fast.refresh();
      } else {
        const timer = setTimeout(() => this.__onTimeout(), delay);
        timer.unref();
        this.__timerCancel = () => clearTimeout(timer);
        this.__timerRefresh = () => {
          timer.refresh();
        };
      }
    }
  }

  __clearTimer(): void {
    const cancel = this.__timerCancel;
    this.__timerCancel = null;
    this.__timerRefresh = null;
    if (cancel !== null) cancel();
  }

  __refreshTimer(): void {
    const refresh = this.__timerRefresh;
    if (refresh !== null) refresh();
  }

  __onTimeout(): void {
    const socket = this.__socket;
    const parser = this.__parser;
    // A body timeout that fires while the response is paused keeps its
    // timer: resuming refreshes it, as undici's parser does.
    if (this.__timerType === TIMEOUT_BODY && parser !== null && parser.paused) return;
    this.__timerCancel = null;
    this.__timerRefresh = null;
    if (socket === null || parser === null) return;
    if (this.__timerType === TIMEOUT_HEADERS) {
      this.__destroySocket(socket, new HeadersTimeoutError());
    } else if (this.__timerType === TIMEOUT_BODY) {
      this.__destroySocket(socket, new BodyTimeoutError());
    } else if (this.__timerType === TIMEOUT_IDLE) {
      this.__destroySocket(socket, new InformationalError("socket idle timeout"));
    }
  }

  __connect(): void {
    const url = this.__url;
    let hostname = url.hostname;
    if (hostname.startsWith("[")) {
      const idx = hostname.indexOf("]");
      hostname = hostname.slice(1, idx);
    }
    this.__connecting = true;
    const params: ConnectorOptions = {
      host: url.host,
      hostname,
      protocol: url.protocol,
      port: url.port,
      servername: this.__serverName ?? undefined,
      localAddress: this.__localAddress,
    };
    const connectParams = {
      host: url.host,
      hostname,
      protocol: url.protocol,
      port: url.port,
      servername: this.__serverName,
      localAddress: this.__localAddress,
    };
    if (channels.beforeConnect.hasSubscribers) {
      channels.beforeConnect.publish({ connectParams, connector: this.__connector });
    }
    let settled = false;
    const onConnected = (err: Error | null, socket: Socket | null): void => {
      if (settled) return;
      settled = true;
      // undici awaits the connector's promise: continue on a later tick.
      queueMicrotask(() => {
        if (err !== null || socket === null)
          this.__onConnectError(err ?? new SocketError("connect failed"), connectParams);
        else this.__onConnected(socket, connectParams);
      });
    };
    try {
      this.__connector(params, onConnected);
    } catch (err) {
      onConnected(err as Error, null);
    }
  }

  __onConnected(
    socket: Socket,
    connectParams: {
      host: string;
      hostname: string;
      protocol: string;
      port: string;
      servername: string | null;
      localAddress: string | null;
    },
  ): void {
    this.__connecting = false;
    if (this.destroyed) {
      socket.destroy();
      this.__resume(false);
      return;
    }
    this.__socket = socket;
    this.__sockNoRef = false;
    this.__sockReset = false;
    this.__sockBlocking = false;
    this.__sockCounter = 0;
    this.__sockError = null;
    const parser = new ResponseParser(this, socket);
    this.__parser = parser;
    socket.on("data", (chunk: Buffer) => {
      if (this.__socket === socket) parser.execute(chunk);
    });
    socket.on("error", (err: Error) => {
      if (this.__socket === socket) this.__onSocketError(socket, err);
    });
    socket.on("end", () => {
      if (this.__socket === socket) this.__onSocketEnd(socket);
    });
    socket.on("close", () => {
      if (this.__socket === socket) this.__onSocketClose(socket);
    });
    if (channels.connected.hasSubscribers) {
      channels.connected.publish({ connectParams, connector: this.__connector, socket });
    }
    this.emit("connect", this.__url, [this as Dispatcher]);
    this.__resume(false);
  }

  __onConnectError(
    err: Error,
    connectParams: {
      host: string;
      hostname: string;
      protocol: string;
      port: string;
      servername: string | null;
      localAddress: string | null;
    },
  ): void {
    this.__connecting = false;
    if (channels.connectError.hasSubscribers) {
      channels.connectError.publish({ connectParams, connector: this.__connector, error: err });
    }
    this.__onError(err);
    this.emit("connectionError", this.__url, [this as Dispatcher], err);
    this.__resume(false);
  }

  /** client.js onError: with nothing running, a connection-level failure
   * fails every queued request. */
  __onError(err: Error): void {
    const code = errorCode(err);
    if (this.__runningCount() === 0 && code !== "UND_ERR_INFO" && code !== "UND_ERR_SOCKET") {
      const requests = this.__queue.splice(this.__runningIdx);
      for (const request of requests) if (request !== null) this.__errorRequest(request, err);
    }
  }

  __onSocketError(socket: Socket, err: Error): void {
    const parser = this.__parser;
    if (
      errorCode(err) === "ECONNRESET" &&
      parser !== null &&
      parser.statusCode !== 0 &&
      !parser.shouldKeepAlive
    ) {
      parser.finishOnEof();
      return;
    }
    this.__destroySocket(socket, err);
    this.__onError(err);
  }

  __onSocketEnd(socket: Socket): void {
    const parser = this.__parser;
    if (parser !== null && parser.statusCode !== 0 && !parser.shouldKeepAlive) {
      parser.finishOnEof();
      return;
    }
    this.__destroySocket(socket, new SocketError("other side closed", this.__socketInfo()));
  }

  __onSocketClose(_socket: Socket): void {
    const parser = this.__parser;
    const recorded = this.__sockError;
    this.__sockError = null;
    if (
      recorded === null &&
      parser !== null &&
      parser.statusCode !== 0 &&
      !parser.shouldKeepAlive
    ) {
      parser.finishOnEof();
    }
    const err = recorded ?? new SocketError("closed", this.__socketInfo());
    this.__parser = null;
    this.__socket = null;
    this.__clearTimer();
    this.__timerType = TIMEOUT_NONE;
    if (this.destroyed) {
      const requests = this.__queue.splice(this.__runningIdx);
      for (const request of requests) if (request !== null) this.__errorRequest(request, err);
    } else if (this.__runningCount() > 0 && errorCode(err) !== "UND_ERR_INFO") {
      const request = this.__queue[this.__runningIdx];
      this.__queue[this.__runningIdx++] = null;
      if (request !== null && request !== undefined) this.__errorRequest(request, err);
    }
    this.__pendingIdx = this.__runningIdx;
    this.emit("disconnect", this.__url, [this as Dispatcher], err);
    this.__resume(false);
  }

  __emitDrain(): void {
    this.__needDrain = 0;
    this.emit("drain", this.__url, [this as Dispatcher]);
  }

  __resume(sync: boolean): void {
    if (this.__resuming === 2) return;
    this.__resuming = 2;
    this.__resumeLoop(sync);
    this.__resuming = 0;
    if (this.__runningIdx > 256) {
      this.__queue.splice(0, this.__runningIdx);
      this.__pendingIdx -= this.__runningIdx;
      this.__runningIdx = 0;
    }
  }

  __resumeLoop(sync: boolean): void {
    for (;;) {
      if (this.destroyed) return;
      if (this.closed && this.__sizeCount() === 0) {
        this.destroy();
        return;
      }
      const socket = this.__socket;
      const parser = this.__parser;
      if (socket !== null && parser !== null) {
        if (this.__sizeCount() === 0) {
          if (!this.__sockNoRef) {
            socket.unref();
            this.__sockNoRef = true;
          }
        } else if (this.__sockNoRef) {
          socket.ref();
          this.__sockNoRef = false;
        }
        if (this.__sizeCount() === 0) {
          if (this.__timerType !== TIMEOUT_IDLE)
            this.__setTimeout(this.__keepAliveTimeoutValue, TIMEOUT_IDLE);
        } else if (this.__runningCount() > 0 && parser.statusCode < 200) {
          if (this.__timerType !== TIMEOUT_HEADERS) {
            const request = this.__queue[this.__runningIdx];
            const headersTimeout =
              request !== null && request !== undefined && request.headersTimeout !== null
                ? request.headersTimeout
                : this.__headersTimeout;
            this.__setTimeout(headersTimeout, TIMEOUT_HEADERS);
          }
        }
      }

      if (this.__busy()) {
        this.__needDrain = 2;
      } else if (this.__needDrain === 2) {
        if (sync) {
          this.__needDrain = 1;
          process.nextTick(() => this.__emitDrain());
        } else {
          this.__emitDrain();
        }
        continue;
      }

      if (this.__pendingCount() === 0) return;
      if (this.__runningCount() >= (this.__pipelining || 1)) return;

      const request = this.__queue[this.__pendingIdx]!;
      if (this.__url.protocol === "https:" && this.__serverName !== request.servername) {
        if (this.__runningCount() > 0) return;
        this.__serverName = request.servername;
        if (socket !== null) {
          this.__destroySocket(socket, new InformationalError("servername changed"));
          return;
        }
      }
      if (this.__connecting) return;
      if (socket === null) {
        this.__connect();
        continue;
      }
      if (socket.destroyed || this.__sockReset || this.__sockBlocking) return;
      if (this.__runningCount() > 0 && !request.idempotent) return;

      if (!request.aborted && this.__write(request, socket)) {
        this.__pendingIdx++;
      } else {
        this.__queue.splice(this.__pendingIdx, 1);
      }
    }
  }

  __write(request: Request, socket: Socket): boolean {
    const method = request.method;
    const body = request.body;
    const expectsPayload = method === "PUT" || method === "POST" || method === "PATCH";
    // util.bodyLength: a missing body has length 0.
    let contentLength: number | null = body !== null ? body.length : 0;
    if (contentLength === 0 && !expectsPayload) contentLength = null;
    const declared = request.contentLength;
    const sendsLength =
      method !== "GET" && method !== "HEAD" && method !== "OPTIONS" && method !== "TRACE";
    const mismatch =
      declared !== null &&
      declared !== contentLength &&
      (this.__profile.major < 7 || (sendsLength && contentLength !== null && contentLength > 0));
    if (mismatch) {
      if (this.__strictContentLength) {
        this.__errorRequest(request, new RequestContentLengthMismatchError());
        return false;
      }
      process.emitWarning(new RequestContentLengthMismatchError());
    }

    const abort = (err?: Error): void => {
      if (request.aborted || request.completed) return;
      this.__errorRequest(request, err ?? new RequestAbortedError());
      this.__destroySocket(socket, new InformationalError("aborted"));
    };
    try {
      request.onConnect(abort);
    } catch (err) {
      this.__errorRequest(request, err as Error);
    }
    if (request.aborted) return false;

    if (method === "HEAD") this.__sockReset = true;
    if (request.reset !== null) this.__sockReset = request.reset;
    if (this.__maxRequests > 0 && this.__sockCounter++ >= this.__maxRequests)
      this.__sockReset = true;
    if (request.blocking) this.__sockBlocking = true;

    let header = `${method} ${request.path} HTTP/1.1\r\n`;
    header += request.host !== null ? `host: ${request.host}\r\n` : this.__hostHeader;
    if (this.__pipelining !== 0 && !(this.__profile.major >= 7 && this.__sockReset)) {
      header += "connection: keep-alive\r\n";
    } else {
      header += "connection: close\r\n";
    }
    header += request.headers;
    if (channels.sendHeaders.hasSubscribers) {
      channels.sendHeaders.publish({ request: request.diagnosticView(), headers: header, socket });
    }
    if (body === null) {
      if (contentLength === 0) socket.write(`${header}content-length: 0\r\n\r\n`);
      else socket.write(`${header}\r\n`);
    } else {
      socket.write(`${header}content-length: ${contentLength}\r\n\r\n`);
      socket.write(body);
      request.onBodySent(body);
      if (!expectsPayload && (this.__profile.major < 7 || request.reset !== false))
        this.__sockReset = true;
    }
    request.onRequestSent();
    return true;
  }

  // ResponseParser callbacks.

  __onHeadersComplete(parser: ResponseParser, socket: Socket): number {
    const request = this.__queue[this.__runningIdx];
    if (request === null || request === undefined || socket.destroyed) return -1;
    const statusCode = parser.statusCode;
    if (statusCode === 100) {
      this.__destroySocket(socket, new SocketError("bad response", this.__socketInfo()));
      return -1;
    }
    if (statusCode >= 200) {
      const bodyTimeout = request.bodyTimeout !== null ? request.bodyTimeout : this.__bodyTimeout;
      this.__setTimeout(bodyTimeout, TIMEOUT_BODY);
    }
    if (parser.shouldKeepAlive && this.__pipelining !== 0) {
      const hint =
        parser.keepAliveHeader !== "" ? parseKeepAliveTimeout(parser.keepAliveHeader) : null;
      if (hint !== null) {
        const timeout = Math.min(
          hint - this.__keepAliveTimeoutThreshold,
          this.__keepAliveMaxTimeout,
        );
        if (timeout <= 0) this.__sockReset = true;
        else this.__keepAliveTimeoutValue = timeout;
      } else {
        this.__keepAliveTimeoutValue = this.__keepAliveDefaultTimeout;
      }
    } else {
      this.__sockReset = true;
    }
    let pause = false;
    try {
      pause =
        request.onHeaders(statusCode, parser.headers, () => parser.resume(), parser.statusText) ===
        false;
    } catch (err) {
      this.__destroySocket(socket, err as Error);
      return -1;
    }
    if (request.method === "HEAD") return 1;
    if (statusCode < 200) return 1;
    if (this.__sockBlocking) {
      this.__sockBlocking = false;
      this.__resume(false);
    }
    return pause ? 2 : 0;
  }

  __onBody(parser: ResponseParser, socket: Socket, chunk: Buffer): boolean {
    const request = this.__queue[this.__runningIdx];
    if (request === null || request === undefined || socket.destroyed) return false;
    if (this.__timerType === TIMEOUT_BODY) this.__refreshTimer();
    if (this.__maxResponseSize > -1 && parser.bytesRead + chunk.length > this.__maxResponseSize) {
      this.__destroySocket(socket, new ResponseExceededMaxSizeError());
      return false;
    }
    parser.bytesRead += chunk.length;
    try {
      return request.onData(chunk) !== false;
    } catch (err) {
      this.__destroySocket(socket, err as Error);
      return false;
    }
  }

  /** Returns false when the socket was torn down (stop parsing). */
  __onMessageComplete(parser: ResponseParser, socket: Socket, trailers: Buffer[]): boolean {
    if (socket.destroyed && (parser.statusCode === 0 || parser.shouldKeepAlive)) return false;
    const request = this.__queue[this.__runningIdx];
    if (request === null || request === undefined) return false;
    const statusCode = parser.statusCode;
    const shouldKeepAlive = parser.shouldKeepAlive;
    const contentLength = parser.contentLength;
    const bytesRead = parser.bytesRead;
    parser.reset();
    if (statusCode < 200) return true;
    if (request.method !== "HEAD" && contentLength >= 0 && bytesRead !== contentLength) {
      this.__destroySocket(socket, new ResponseContentLengthMismatchError());
      return false;
    }
    try {
      request.onComplete(trailers);
    } catch (err) {
      this.__errorRequest(request, err as Error);
    }
    this.__queue[this.__runningIdx++] = null;
    if (!shouldKeepAlive) {
      this.__destroySocket(socket, new InformationalError("reset"));
      return false;
    }
    if (this.__sockReset && this.__runningCount() === 0) {
      this.__destroySocket(socket, new InformationalError("reset"));
      return false;
    }
    if (this.__pipelining === 1) setImmediate(() => this.__resume(false));
    else this.__resume(false);
    return true;
  }

  __onParseError(socket: Socket, err: Error): void {
    this.__destroySocket(socket, err);
  }
}

function errorCode(err: Error): string {
  if (err instanceof UndiciError) return err.code;
  return (err as NodeJS.ErrnoException).code ?? "";
}

const CRLF = Buffer.from("\r\n");

// Chunk-size line states (llhttp's chunk_size* and chunk_extension* nodes).
const SIZE_FIRST = 0;
const SIZE_DIGITS = 1;
const SIZE_AFTER = 2;
const SIZE_EXT = 3;
const SIZE_EXT_NAME = 4;
const SIZE_EXT_VALUE = 5;
const SIZE_EXT_QUOTED = 6;
const SIZE_EXT_PAIR = 7;
const SIZE_EXT_QUOTED_DONE = 8;
const SIZE_CR = 9;

function hexDigit(c: number): number {
  if (c >= 0x30 && c <= 0x39) return c - 0x30;
  if (c >= 0x41 && c <= 0x46) return c - 0x37;
  if (c >= 0x61 && c <= 0x66) return c - 0x57;
  return -1;
}

/** tchar: ALPHA, DIGIT and !#$%&'*+-.^_`|~. */
const TOKEN_BYTES = tokenBytes();

function tokenBytes(): Uint8Array {
  const table = new Uint8Array(256);
  const marks = "!#$%&'*+-.^_`|~";
  for (let i = 0; i < marks.length; i++) table[marks.charCodeAt(i)] = 1;
  for (let c = 0x30; c <= 0x39; c++) table[c] = 1;
  for (let c = 0x41; c <= 0x5a; c++) {
    table[c] = 1;
    table[c + 0x20] = 1;
  }
  return table;
}

/** qdtext: HTAB, SP and 0x21-0xff but '"' and '\\'. */
function isQuotedByte(c: number): boolean {
  return c === 0x09 || c === 0x20 || (c >= 0x21 && c !== 0x22 && c !== 0x5c);
}

/** The byte after '\\' in a quoted-pair: HTAB, SP, VCHAR or obs-text. */
function isQuotedPairByte(c: number): boolean {
  return c === 0x09 || c === 0x20 || (c >= 0x21 && c !== 0x7f);
}

/** An incremental HTTP/1.1 response parser (the subset of llhttp undici
 * relies on): status line, raw header pairs, Content-Length, chunked and
 * read-until-close bodies, trailers, and pause/resume back-pressure. */
class ResponseParser {
  client: Client;
  socket: Socket;
  /** Unconsumed bytes of the current arrival, then the later arrivals in
   * order. */
  buf: Buffer;
  queue: Buffer[];
  state: number;
  paused: boolean;
  statusCode: number;
  statusText: string;
  headers: Buffer[];
  headersSize: number;
  versionMinor: number;
  contentLength: number;
  chunked: boolean;
  connectionHeader: string;
  keepAliveHeader: string;
  shouldKeepAlive: boolean;
  remaining: number;
  bytesRead: number;
  trailers: Buffer[];
  skipBody: boolean;
  sizeState: number;
  sizeDigits: number;
  chunkSize: number;

  constructor(client: Client, socket: Socket) {
    this.client = client;
    this.socket = socket;
    this.buf = Buffer.alloc(0);
    this.queue = [];
    this.state = 0;
    this.paused = false;
    this.statusCode = 0;
    this.statusText = "";
    this.headers = [];
    this.headersSize = 0;
    this.versionMinor = 1;
    this.contentLength = -1;
    this.chunked = false;
    this.connectionHeader = "";
    this.keepAliveHeader = "";
    this.shouldKeepAlive = true;
    this.remaining = 0;
    this.bytesRead = 0;
    this.trailers = [];
    this.skipBody = false;
    this.sizeState = SIZE_FIRST;
    this.sizeDigits = 0;
    this.chunkSize = 0;
  }

  reset(): void {
    this.state = 0;
    this.statusCode = 0;
    this.statusText = "";
    this.headers = [];
    this.headersSize = 0;
    this.contentLength = -1;
    this.chunked = false;
    this.connectionHeader = "";
    this.keepAliveHeader = "";
    this.remaining = 0;
    this.bytesRead = 0;
    this.trailers = [];
    this.skipBody = false;
  }

  execute(data: Buffer): void {
    if (this.buf.length === 0 && this.queue.length === 0) this.buf = data;
    else this.queue.push(data);
    if (!this.paused) this.run();
  }

  /** Moves the next queued arrival into `buf`, after the bytes left in it;
   * false when nothing is queued. Only a partial status, header or trailer
   * line (bounded by maxHeaderSize) or a partial chunk-data CRLF is copied. */
  more(): boolean {
    const next = this.queue.shift();
    if (next === undefined) return false;
    this.buf = this.buf.length === 0 ? next : Buffer.concat([this.buf, next]);
    return true;
  }

  resume(): void {
    if (!this.paused) return;
    if (this.client.__timerType === TIMEOUT_BODY) this.client.__refreshTimer();
    this.paused = false;
    this.socket.resume();
    this.run();
  }

  pause(): void {
    this.paused = true;
    this.socket.pause();
  }

  /** EOF while reading a close-delimited body completes the message. */
  finishOnEof(): void {
    if (this.state === 6) {
      this.client.__onMessageComplete(this, this.socket, []);
    }
  }

  /** A parse error with llhttp's reason: undici 7 puts it inside its
   * protocol message and, as its error table maps names to numbers only,
   * sets no code; undici 5 uses the reason as the message and the code. */
  fail(reason: string, code: string): void {
    const err =
      this.client.__profile.major >= 7
        ? new HTTPParserError(`Response does not match the HTTP/1.1 protocol (${reason})`)
        : new HTTPParserError(reason, code, "");
    this.client.__onParseError(this.socket, err);
    this.state = 99;
  }

  /** Reads the chunk-size line one byte at a time as llhttp does, so a line
   * that never ends holds no memory: hex digits (past 16 significant ones
   * the size overflows), then extensions, checked and dropped, then CRLF.
   * The 7.x profile follows llhttp 9 (undici 7), the 5.x profile llhttp 8
   * in its lenient mode (undici 5). Returns true when the line is complete
   * and chunkSize holds its size; false when it needs more bytes or failed. */
  chunkSizeLine(): boolean {
    const buf = this.buf;
    if (this.sizeState === SIZE_FIRST) {
      // The common line, hex digits then CRLF in this buffer, in one pass;
      // any other line takes the byte loop below from its start.
      let size = 0;
      let digits = 0;
      let j = 0;
      for (; j < buf.length && j < 32; j++) {
        const d = hexDigit(buf[j]!);
        if (d === -1) break;
        if (digits > 0 || d !== 0) {
          digits++;
          size = size * 16 + d;
        }
      }
      if (j > 0 && digits <= 16 && j + 1 < buf.length && buf[j] === 0x0d && buf[j + 1] === 0x0a) {
        this.chunkSize = size;
        this.buf = buf.subarray(j + 2);
        return true;
      }
    }
    const v7 = this.client.__profile.major >= 7;
    let i = 0;
    while (i < buf.length) {
      const c = buf[i]!;
      const state = this.sizeState;
      if (state === SIZE_FIRST || state === SIZE_DIGITS) {
        const d = hexDigit(c);
        if (d === -1) {
          if (state === SIZE_FIRST) {
            this.fail("Invalid character in chunk size", "INVALID_CHUNK_SIZE");
            return false;
          }
          this.sizeState = SIZE_AFTER;
          continue;
        }
        if (state === SIZE_FIRST) {
          this.chunkSize = 0;
          this.sizeDigits = 0;
          this.sizeState = SIZE_DIGITS;
        }
        if (this.sizeDigits > 0 || d !== 0) {
          if (this.sizeDigits === 16) {
            this.fail("Chunk size overflow", "INVALID_CHUNK_SIZE");
            return false;
          }
          this.sizeDigits++;
          this.chunkSize = this.chunkSize * 16 + d;
        }
      } else if (state === SIZE_AFTER) {
        if (c === 0x0d) this.sizeState = SIZE_CR;
        else if (c === 0x3b) this.sizeState = SIZE_EXT;
        else if (c === 0x0a && v7) {
          this.fail("Missing expected CR after chunk size", "CR_EXPECTED");
          return false;
        } else {
          this.fail("Invalid character in chunk size", "INVALID_CHUNK_SIZE");
          return false;
        }
      } else if (state === SIZE_EXT) {
        if (c === 0x20 || c === 0x0d) {
          this.fail("Invalid character in chunk extensions", "STRICT");
          return false;
        }
        this.sizeState = SIZE_EXT_NAME;
        continue;
      } else if (state === SIZE_EXT_NAME) {
        if (c === 0x3d) this.sizeState = SIZE_EXT_VALUE;
        else if (c === 0x3b) this.sizeState = SIZE_EXT;
        else if (c === 0x0d) this.sizeState = SIZE_CR;
        else if (c === 0x0a && v7) {
          this.fail("Missing expected CR after chunk extension name", "CR_EXPECTED");
          return false;
        } else if (TOKEN_BYTES[c] !== 1) {
          this.fail("Invalid character in chunk extensions name", "STRICT");
          return false;
        }
      } else if (state === SIZE_EXT_VALUE) {
        if (c === 0x22) this.sizeState = SIZE_EXT_QUOTED;
        // llhttp 8 goes on with the chunk-size node after a value's ';'.
        else if (c === 0x3b) this.sizeState = v7 ? SIZE_EXT : SIZE_AFTER;
        else if (c === 0x0d) this.sizeState = SIZE_CR;
        else if (c === 0x0a && v7) {
          this.fail("Missing expected CR after chunk extension value", "CR_EXPECTED");
          return false;
        } else if (TOKEN_BYTES[c] !== 1) {
          this.fail("Invalid character in chunk extensions value", "STRICT");
          return false;
        }
      } else if (state === SIZE_EXT_QUOTED) {
        if (c === 0x22) this.sizeState = SIZE_EXT_QUOTED_DONE;
        else if (c === 0x5c && v7) this.sizeState = SIZE_EXT_PAIR;
        else if (!isQuotedByte(c)) {
          this.fail("Invalid character in chunk extensions quoted value", "STRICT");
          return false;
        }
      } else if (state === SIZE_EXT_PAIR) {
        if (!isQuotedPairByte(c)) {
          this.fail("Invalid quoted-pair in chunk extensions quoted value", "STRICT");
          return false;
        }
        this.sizeState = SIZE_EXT_QUOTED;
      } else if (state === SIZE_EXT_QUOTED_DONE) {
        if (c === 0x3b) this.sizeState = SIZE_EXT;
        else if (c === 0x0d) this.sizeState = SIZE_CR;
        else if (c === 0x0a && v7) {
          this.fail("Missing expected CR after chunk extension value", "CR_EXPECTED");
          return false;
        } else {
          this.fail("Invalid character in chunk extensions quote value", "STRICT");
          return false;
        }
      } else {
        // SIZE_CR: llhttp 9 needs the LF; llhttp 8's lenient mode skips
        // whatever byte follows the CR.
        if (c !== 0x0a && v7) {
          this.fail("Expected LF after chunk size", "STRICT");
          return false;
        }
        this.buf = buf.subarray(i + 1);
        this.sizeState = SIZE_FIRST;
        return true;
      }
      i++;
    }
    this.buf = Buffer.alloc(0);
    return false;
  }

  line(): Buffer | null {
    const idx = this.buf.indexOf(CRLF);
    if (idx === -1) return null;
    const out = this.buf.subarray(0, idx);
    this.buf = this.buf.subarray(idx + 2);
    return out;
  }

  run(): void {
    while (!this.paused && this.state !== 99) {
      if (this.state === 0) {
        // Status line.
        const line = this.line();
        if (line === null) {
          if (this.buf.length > this.client.__maxHeaderSize) {
            this.client.__onParseError(this.socket, new HeadersOverflowError());
            this.state = 99;
            return;
          }
          if (this.more()) continue;
          return;
        }
        if (line.length === 0) continue;
        const text = line.toString("latin1");
        const m = /^HTTP\/1\.([01]) (\d{3})(?: (.*))?$/.exec(text);
        if (m === null) {
          const v7 = this.client.__profile.major >= 7;
          if (!text.startsWith("HTTP/")) {
            this.fail(v7 ? "Expected HTTP/, RTSP/ or ICE/" : "Expected HTTP/", "INVALID_CONSTANT");
          } else {
            this.fail(v7 ? "Invalid status code" : "Invalid response status", "INVALID_STATUS");
          }
          return;
        }
        this.versionMinor = Number(m[1]);
        this.statusCode = Number(m[2]);
        this.statusText = m[3] ?? "";
        this.headersSize = line.length;
        this.state = 1;
      } else if (this.state === 1 || this.state === 5) {
        // Header (1) or trailer (5) lines.
        const line = this.line();
        if (line === null) {
          if (this.headersSize + this.buf.length > this.client.__maxHeaderSize) {
            this.client.__onParseError(this.socket, new HeadersOverflowError());
            this.state = 99;
            return;
          }
          if (this.more()) continue;
          return;
        }
        this.headersSize += line.length;
        if (this.headersSize > this.client.__maxHeaderSize) {
          this.client.__onParseError(this.socket, new HeadersOverflowError());
          this.state = 99;
          return;
        }
        if (line.length > 0) {
          const colon = line.indexOf(0x3a);
          if (colon <= 0) {
            this.fail("Invalid header token", "INVALID_HEADER_TOKEN");
            return;
          }
          const name = line.subarray(0, colon);
          let start = colon + 1;
          let end = line.length;
          while (start < end && (line[start] === 0x20 || line[start] === 0x09)) start++;
          while (end > start && (line[end - 1] === 0x20 || line[end - 1] === 0x09)) end--;
          const value = line.subarray(start, end);
          if (this.state === 5) {
            this.trailers.push(Buffer.from(name), Buffer.from(value));
            continue;
          }
          this.headers.push(Buffer.from(name), Buffer.from(value));
          const lower = name.toString("latin1").toLowerCase();
          if (lower === "content-length") {
            const n = Number(value.toString("latin1"));
            if (!Number.isInteger(n) || n < 0) {
              this.fail("Invalid character in Content-Length", "INVALID_CONTENT_LENGTH");
              return;
            }
            this.contentLength = n;
          } else if (lower === "transfer-encoding") {
            this.chunked = /(?:^|,)\s*chunked\s*$/i.test(value.toString("latin1"));
          } else if (lower === "connection") {
            this.connectionHeader = value.toString("latin1").toLowerCase();
          } else if (lower === "keep-alive") {
            this.keepAliveHeader = value.toString("latin1");
          }
          continue;
        }
        if (this.state === 5) {
          if (!this.complete()) return;
          continue;
        }
        // End of headers.
        const noBody = this.statusCode < 200 || this.statusCode === 204 || this.statusCode === 304;
        const closeRequested = /(?:^|,)\s*close\s*(?:,|$)/.test(this.connectionHeader);
        const keepAliveRequested = /(?:^|,)\s*keep-alive\s*(?:,|$)/.test(this.connectionHeader);
        this.shouldKeepAlive = this.versionMinor === 1 ? !closeRequested : keepAliveRequested;
        if (!noBody && !this.chunked && this.contentLength < 0) this.shouldKeepAlive = false;
        const ret = this.client.__onHeadersComplete(this, this.socket);
        if (ret === -1) {
          this.state = 99;
          return;
        }
        this.skipBody = ret === 1 || noBody;
        if (this.skipBody) {
          if (!this.complete()) return;
          continue;
        }
        if (this.chunked) {
          this.state = 3;
        } else if (this.contentLength >= 0) {
          this.remaining = this.contentLength;
          this.state = 2;
          if (this.remaining === 0) {
            if (ret === 2) this.pause();
            if (!this.complete()) return;
            continue;
          }
        } else {
          this.state = 6;
        }
        if (ret === 2) this.pause();
      } else if (this.state === 2) {
        // Content-Length body.
        if (this.buf.length === 0) {
          if (this.more()) continue;
          return;
        }
        const n = Math.min(this.remaining, this.buf.length);
        const chunk = this.buf.subarray(0, n);
        this.buf = this.buf.subarray(n);
        this.remaining -= n;
        const more = this.client.__onBody(this, this.socket, Buffer.from(chunk));
        if (this.socket.destroyed) {
          this.state = 99;
          return;
        }
        if (!more) this.pause();
        if (this.remaining === 0) {
          if (!this.complete()) return;
        }
      } else if (this.state === 3) {
        // Chunk size line; a partial one continues with the next arrival.
        if (!this.chunkSizeLine()) {
          if (this.state === 3 && this.more()) continue;
          return;
        }
        if (this.chunkSize === 0) {
          this.state = 5;
        } else {
          this.remaining = this.chunkSize;
          this.state = 4;
        }
      } else if (this.state === 4) {
        // Chunk data, then its CRLF.
        if (this.remaining > 0) {
          if (this.buf.length === 0) {
            if (this.more()) continue;
            return;
          }
          const n = Math.min(this.remaining, this.buf.length);
          const chunk = this.buf.subarray(0, n);
          this.buf = this.buf.subarray(n);
          this.remaining -= n;
          const more = this.client.__onBody(this, this.socket, Buffer.from(chunk));
          if (this.socket.destroyed) {
            this.state = 99;
            return;
          }
          if (!more) this.pause();
          continue;
        }
        if (this.buf.length < 2) {
          if (this.more()) continue;
          return;
        }
        if (this.buf[0] !== 0x0d || this.buf[1] !== 0x0a) {
          this.fail("Expected LF after chunk data", "STRICT");
          return;
        }
        this.buf = this.buf.subarray(2);
        this.state = 3;
      } else if (this.state === 6) {
        // Read until the connection closes.
        if (this.buf.length === 0) {
          if (this.more()) continue;
          return;
        }
        const chunk = this.buf;
        this.buf = Buffer.alloc(0);
        const more = this.client.__onBody(this, this.socket, Buffer.from(chunk));
        if (this.socket.destroyed) {
          this.state = 99;
          return;
        }
        if (!more) this.pause();
      } else {
        return;
      }
    }
  }

  /** Message complete: hand the trailers over and get ready for the next
   * response on this connection. Returns false when parsing must stop. */
  complete(): boolean {
    const trailers = this.trailers;
    const ok = this.client.__onMessageComplete(this, this.socket, trailers);
    if (!ok) {
      this.state = 99;
      return false;
    }
    return true;
  }
}
