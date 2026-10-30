/// <reference path="./http2.d.ts" />
/// <reference path="./net.d.ts" />

/* node:http — the SERVER and CLIENT slices (scr_http.c layers a
 * hand-written HTTP/1.1 parser + serializer on scr_net.c; both link only
 * into using binaries). createServer(handler) returns a net.Server —
 * listen/close/address().port/'error' are the same lowered surface. The
 * request carries url/method (always present on server requests),
 * statusCode (a number on client responses, undefined on server
 * requests), the underlying socket, and lowercased headers read as
 * `string | undefined`; the body streams through on("data"/"end"). The
 * response is setHeader/writeHead/write/end/destroy with Node's framing
 * (Content-Length for a single end(body), chunked after writeHead/write)
 * and the auto Date/Connection headers; writeHead's headers argument is
 * an object literal or a Record<string, string>. request/get dial one
 * connection per call (no agent pooling) with Node's exact wire head. */
declare module "http" {
  import { Server as NetServer, Socket } from "net";
  export const METHODS: string[];
  export const STATUS_CODES: { [status: number]: string | undefined };
  export const maxHeaderSize: number;
  export interface Server extends NetServer {
    timeout: number;
    setTimeout(msecs: number, callback?: (socket: Socket) => void): this;
    closeAllConnections(): void;
    closeIdleConnections(): void;
    keepAliveTimeout: number;
    keepAliveTimeoutBuffer: number;
    headersTimeout: number;
    requestTimeout: number;
  }
  export type RequestListener = (req: IncomingMessage, res: ServerResponse) => void;
  /* The Server VALUE — Node's constructor works with and without `new`
   * (test/parallel's http.Server(fn) spelling); both route to the
   * createServer lowering. */
  export const Server: {
    new (requestListener?: (req: IncomingMessage, res: ServerResponse) => void): Server;
    new (
      options: ServerOptions,
      requestListener?: (req: IncomingMessage, res: ServerResponse) => void,
    ): Server;
    (requestListener?: (req: IncomingMessage, res: ServerResponse) => void): Server;
    (
      options: ServerOptions,
      requestListener?: (req: IncomingMessage, res: ServerResponse) => void,
    ): Server;
  };
  /* The options-record stance (the RequestOptions precedent): every
   * documented key typechecks; the lowering's option walk decides per
   * key — requireHostHeader: false, joinDuplicateHeaders, and
   * keepAliveTimeoutBuffer lower,
   * documented-but-unlowered keys fence by name, unknown keys drop. */
  export interface ServerOptions {
    requireHostHeader?: boolean;
    joinDuplicateHeaders?: boolean;
    keepAliveTimeoutBuffer?: number;
    maxHeaderSize?: number;
    [option: string]: unknown;
  }
  /* The outgoing-header shape, @types/node's matrix: numbers format via
   * String(n), arrays write one line per element (set-cookie's shape).
   * Incoming headers stay `string | undefined` — what the parser answers
   * (under @types/node the two SLOTS unify so `{ ...req.headers }`
   * merges into outgoing literals as a copy; the fallback keeps reads
   * simple and spreads target the same string | undefined slot). */
  export type OutgoingHttpHeaders = { [name: string]: number | string | string[] | undefined };
  export interface IncomingMessage {
    readonly url: string;
    readonly method: string;
    readonly httpVersion: string;
    readonly complete: boolean;
    readonly aborted: boolean;
    readonly statusCode: number | undefined;
    readonly statusMessage: string | undefined;
    readonly socket: Socket;
    readonly connection: Socket;
    readonly headers: { [name: string]: string | undefined };
    readonly headersDistinct: { [name: string]: string[] | undefined };
    readonly rawHeaders: string[];
    readonly trailers: { [name: string]: string | undefined };
    readonly trailersDistinct: { [name: string]: string[] | undefined };
    readonly rawTrailers: string[];
    resume(): void;
    pause(): void;
    destroy(): void;
    setTimeout(msecs: number, callback?: () => void): this;
    /* setEncoding('utf8'): 'data' delivers strings (other real encodings
     * throw a "not supported yet" Error at runtime; unknown names throw
     * ERR_UNKNOWN_ENCODING). */
    setEncoding(encoding: string): void;
    /* The proxy legs: the body streams into a ServerResponse, a
     * ClientRequest, or a raw Socket; natural end ends the destination. */
    pipe(
      destination: ServerResponse | import("http2").Http2ServerResponse | ClientRequest | Socket,
    ): void;
    on(event: "data", listener: (chunk: any) => void): void;
    on(event: "end" | "close" | "aborted", listener: () => void): void;
    on(event: "error", listener: (err: Error) => void): void;
    /* addListener IS on (Node aliases them) — the suite spells both. */
    addListener(event: "data", listener: (chunk: any) => void): void;
    addListener(event: "end" | "close" | "aborted", listener: () => void): void;
    addListener(event: "error", listener: (err: Error) => void): void;
    once(event: "data", listener: (chunk: any) => void): void;
    once(event: "end" | "close" | "aborted", listener: () => void): void;
    once(event: "error", listener: (err: Error) => void): void;
  }
  export interface ServerResponse {
    readonly headersSent: boolean;
    readonly writableEnded: boolean;
    readonly finished: boolean;
    readonly writableFinished: boolean;
    readonly writableCorked: number;
    readonly req: IncomingMessage;
    readonly socket: Socket | null;
    readonly connection: Socket | null;
    sendDate: boolean;
    strictContentLength: boolean;
    /* Node's writable head properties: the implicit head reads them. */
    statusCode: number;
    statusMessage: string | undefined;
    /* The value keeps its type: getHeader answers the number, string or
     * array that was set. */
    setHeader(name: string, value: number | string | readonly string[]): void;
    appendHeader(name: string, value: string | readonly string[]): void;
    getHeader(name: string): number | string | string[] | undefined;
    getHeaderNames(): string[];
    getRawHeaderNames(): string[];
    getHeaders(): OutgoingHttpHeaders;
    hasHeader(name: string): boolean;
    removeHeader(name: string): void;
    /* Both overloads answer the response (`return this` chaining); the
     * headers argument also takes Node's flat [name, value, ...] array. */
    writeHead(statusCode: number, headers?: OutgoingHttpHeaders | string[]): ServerResponse;
    writeHead(
      statusCode: number,
      statusMessage: string,
      headers?: OutgoingHttpHeaders | string[],
    ): ServerResponse;
    writeContinue(callback?: () => void): void;
    writeProcessing(callback?: () => void): void;
    writeEarlyHints(hints: Record<string, string | string[]>, callback?: () => void): void;
    write(data: string | Uint8Array): void;
    flushHeaders(): void;
    cork(): void;
    uncork(): void;
    addTrailers(headers: OutgoingHttpHeaders | ReadonlyArray<[string, string]>): void;
    setTimeout(msecs: number, callback?: () => void): this;
    /* end's callback forms fire once the body went out (the 'finish'
     * emit, deferred past the handler's synchronous tail). */
    end(data?: string | Uint8Array, callback?: () => void): void;
    end(callback: () => void): void;
    destroy(): void;
    on(event: "close" | "finish", listener: () => void): void;
    /* addListener IS on (Node aliases them) — the suite spells both. */
    addListener(event: "close" | "finish", listener: () => void): void;
    once(event: "close" | "finish", listener: () => void): void;
  }
  /* The CLIENT slice (http.request/http.get): the options-object form
   * with hostname/host, port, path, method, timeout, and headers; the
   * callback receives the response as an IncomingMessage (statusCode,
   * headers, body via on("data"/"end")). */
  export interface RequestOptions {
    hostname?: string | null;
    host?: string | null;
    /* A string port (a URL's .port) is accepted, as by Node. */
    port?: number | string | null;
    path?: string | null;
    method?: string;
    timeout?: number;
    headers?: OutgoingHttpHeaders;
    /* The caller's own dialer (the proxy's loopback dial): invoked once,
     * synchronously; its socket carries the exchange. */
    createConnection?: () => Socket;
    /* agent: false is a one-shot dial with Connection: close — exactly
     * the compiled client's model; null/undefined are the default; an
     * Agent VALUE threads through (getName-keyed maxSockets accounting
     * over one-dial-per-request connections). */
    agent?: Agent | boolean | null;
    /* Aborting destroys the request with an AbortError. */
    signal?: AbortSignal;
    /* HTTP over the Unix socket at this path instead of host:port. */
    socketPath?: string;
    /* The options-record stance: Node ignores an options record's
     * unknown keys, so every key typechecks here — the option WALK in
     * the lowering decides per key (lower, fence by name, or drop
     * undocumented keys exactly like Node). */
    [option: string]: unknown;
  }
  /* The Agent lowers to a checked-dynamic HANDLE: option parsing at the
   * literal construction site, getName, destroy, the sockets/requests/
   * freeSockets snapshots, and REAL maxSockets accounting (over-limit
   * requests defer their dial and queue). keepAlive: true keeps finished
   * connections in freeSockets for the next request to the same name,
   * taken in `scheduling` order. */
  export interface AgentOptions {
    keepAlive?: boolean;
    keepAliveMsecs?: number;
    maxSockets?: number;
    maxFreeSockets?: number;
    maxTotalSockets?: number;
    scheduling?: "fifo" | "lifo";
    timeout?: number;
    port?: number;
    [option: string]: unknown;
  }
  export class Agent {
    constructor(options?: AgentOptions);
    destroy(): void;
    /* Node's exact key shape: host:port:localAddress[:family][:socketPath]. */
    getName(options?: {
      host?: string;
      port?: number;
      localAddress?: string;
      family?: number;
      socketPath?: string;
      [option: string]: unknown;
    }): string;
    maxSockets: number;
    maxFreeSockets: number;
    keepAliveMsecs: number;
    readonly keepAlive: boolean;
    readonly protocol: string;
    /* Settable — a portless request through this agent dials it (Node's
     * option merge). */
    defaultPort: number;
    readonly totalSocketCount: number;
    readonly sockets: { [key: string]: unknown[] };
    readonly freeSockets: { [key: string]: unknown[] };
    readonly requests: { [key: string]: unknown[] };
  }
  /* Node's keepAlive global agent for requests without an agent option. */
  export const globalAgent: Agent;
  export interface ClientRequest {
    readonly destroyed: boolean;
    readonly aborted: boolean;
    readonly socket: Socket;
    readonly connection: Socket;
    readonly writableCorked: number;
    readonly method: string;
    readonly path: string;
    readonly host: string;
    readonly protocol: string;
    readonly headersSent: boolean;
    readonly writableEnded: boolean;
    readonly writableFinished: boolean;
    readonly finished: boolean;
    readonly reusedSocket: boolean;
    setHeader(name: string, value: string): void;
    getHeader(name: string): string | undefined;
    hasHeader(name: string): boolean;
    removeHeader(name: string): void;
    getHeaderNames(): string[];
    getRawHeaderNames(): string[];
    getHeaders(): OutgoingHttpHeaders;
    flushHeaders(): void;
    addTrailers(headers: OutgoingHttpHeaders | ReadonlyArray<[string, string]>): void;
    cork(): void;
    uncork(): void;
    setNoDelay(noDelay?: boolean): void;
    setSocketKeepAlive(enable?: boolean, initialDelay?: number): void;
    setTimeout(timeout: number, callback?: () => void): this;
    write(data: string | Uint8Array): void;
    end(data?: string | Uint8Array): void;
    destroy(error?: Error): void;
    abort(): void;
    on(event: "response", listener: (res: IncomingMessage) => void): void;
    on(event: "socket", listener: (socket: Socket) => void): void;
    on(
      event: "upgrade",
      listener: (res: IncomingMessage, socket: Socket, head: Buffer) => void,
    ): void;
    on(event: "timeout" | "close" | "finish" | "abort" | "continue", listener: () => void): void;
    on(event: "error", listener: (err: Error) => void): void;
    /* addListener IS on (Node aliases them) — the suite spells both. */
    addListener(event: "response", listener: (res: IncomingMessage) => void): void;
    addListener(event: "socket", listener: (socket: Socket) => void): void;
    addListener(
      event: "upgrade",
      listener: (res: IncomingMessage, socket: Socket, head: Buffer) => void,
    ): void;
    addListener(event: "timeout" | "close" | "finish" | "abort", listener: () => void): void;
    addListener(event: "error", listener: (err: Error) => void): void;
    once(event: "response", listener: (res: IncomingMessage) => void): void;
    once(event: "socket", listener: (socket: Socket) => void): void;
    once(
      event: "upgrade",
      listener: (res: IncomingMessage, socket: Socket, head: Buffer) => void,
    ): void;
    once(event: "timeout" | "close" | "finish" | "abort" | "continue", listener: () => void): void;
    once(event: "error", listener: (err: Error) => void): void;
  }
  export function createServer(
    requestListener?: (req: IncomingMessage, res: ServerResponse) => void,
  ): Server;
  export function createServer(
    options: ServerOptions,
    requestListener?: (req: IncomingMessage, res: ServerResponse) => void,
  ): Server;
  /* One signature with a UNION first parameter rather than Node's two
   * overloads: `const requestFn = tls ? https.request : http.request`
   * (the portless isProxyRunning shape) unions two function types, and
   * resolving a call on that union collapses each constituent to a
   * single signature — with an overload SET on both sides the options
   * literal ends up checked against URL, in either declaration order.
   * A union parameter has nothing to collapse. The lowering dispatches
   * on the argument's own type, so it reads the same either way.
   *
   * `target` is a URL string or URL object (the spelling a from-scratch
   * client reaches for first — dialed directly, with a non-http scheme
   * an ERR_INVALID_PROTOCOL at runtime rather than a type error), or
   * the options record. */
  export function request(
    target: RequestOptions | string | URL,
    callback?: (res: IncomingMessage) => void,
  ): ClientRequest;
  export function get(
    target: RequestOptions | string | URL,
    callback?: (res: IncomingMessage) => void,
  ): ClientRequest;
  export function validateHeaderName(name: string, label?: string): void;
  export function validateHeaderValue(name: string, value: unknown): void;
}

declare module "node:http" {
  export * from "http";
}
