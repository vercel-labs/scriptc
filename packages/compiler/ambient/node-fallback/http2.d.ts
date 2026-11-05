/// <reference path="./dgram.d.ts" />
/// <reference path="./http.d.ts" />
/// <reference path="./net.d.ts" />
/// <reference path="./tls.d.ts" />

/* node:http2 — the compatibility surface: allowHTTP1 servers negotiate
 * h2 or HTTP/1.1 and expose the shared request/response API. HTTP/2
 * requests retain their backing stream; server session failures surface
 * through sessionError. */
declare module "http2" {
  import { Socket } from "net";
  export interface Http2Stream {
    on(event: "error" | "close", listener: (err: Error) => void): void;
    once(event: "error" | "close", listener: (err: Error) => void): void;
    addListener(event: "error" | "close", listener: (err: Error) => void): void;
    destroy(): void;
  }
  export interface Http2ServerRequest {
    readonly url: string;
    readonly method: string;
    readonly statusCode: number | undefined;
    readonly socket: Socket;
    readonly headers: { [name: string]: string | undefined };
    readonly stream: Http2Stream;
    /* The h2 compat request's version triple ("2.0" over real h2 streams;
     * the allowHTTP1 lowering's HTTP/1.1 connections answer 1.x). */
    readonly httpVersion: string;
    readonly httpVersionMajor: number;
    readonly httpVersionMinor: number;
    readonly aborted: boolean;
    readonly complete: boolean;
    resume(): void;
    destroy(): void;
    setEncoding(encoding: string): void;
    pipe(destination: Socket | import("http").ClientRequest): void;
    on(event: "data", listener: (chunk: Buffer) => void): void;
    on(event: "end" | "close" | "aborted", listener: () => void): void;
    on(event: "error", listener: (err: Error) => void): void;
    /* addListener IS on (Node aliases them) — and the compat req IS the
     * http.IncomingMessage surface, so the alias mirrors here too. */
    addListener(event: "data", listener: (chunk: Buffer) => void): void;
    addListener(event: "end" | "close" | "aborted", listener: () => void): void;
    addListener(event: "error", listener: (err: Error) => void): void;
    once(event: "data", listener: (chunk: Buffer) => void): void;
    once(event: "end" | "close" | "aborted", listener: () => void): void;
    once(event: "error", listener: (err: Error) => void): void;
  }
  export interface Http2ServerResponse {
    readonly headersSent: boolean;
    readonly writableEnded: boolean;
    readonly writableCorked: number;
    /* The same lowered surface as http.ServerResponse — the allowHTTP1
     * lowering serves every connection as HTTP/1.1, where the compat
     * response IS this parser's response handle. */
    statusCode: number;
    statusMessage: string;
    setHeader(name: string, value: string | number): void;
    getHeader(name: string): string | undefined;
    getHeaderNames(): string[];
    getRawHeaderNames(): string[];
    getHeaders(): import("http").OutgoingHttpHeaders;
    hasHeader(name: string): boolean;
    removeHeader(name: string): void;
    writeHead(
      statusCode: number,
      headers?: import("http").OutgoingHttpHeaders | string[],
    ): Http2ServerResponse;
    writeHead(
      statusCode: number,
      statusMessage: string,
      headers?: import("http").OutgoingHttpHeaders | string[],
    ): Http2ServerResponse;
    writeContinue(): void;
    writeEarlyHints(hints: Record<string, string | string[]>): void;
    write(data: string | Uint8Array): void;
    flushHeaders(): void;
    cork(): void;
    uncork(): void;
    addTrailers(
      headers: import("http").OutgoingHttpHeaders | ReadonlyArray<[string, string]>,
    ): void;
    end(data?: string | Uint8Array, callback?: () => void): void;
    end(callback: () => void): void;
    destroy(): void;
    on(event: "close", listener: () => void): void;
    /* addListener IS on (Node aliases them) — and the compat res IS the
     * http.ServerResponse surface (assignability into ServerResponse
     * unions — IncomingMessage.pipe's destination — needs the alias). */
    addListener(event: "close", listener: () => void): void;
    once(event: "close", listener: () => void): void;
  }
  export interface Http2SecureServer {
    listen(port: number, callback?: () => void): void;
    close(callback?: () => void): void;
    /* The bound AddressInfo (Node answers null before listen — this
     * surface answers the record with port 0 there, the serverPort
     * stance). */
    address(): import("node:dgram").AddressInfo;
    emit(event: "connection", socket: Socket): void;
    on(event: "connection", listener: (socket: Socket) => void): void;
    on(
      event: "request",
      listener: (req: Http2ServerRequest, res: Http2ServerResponse) => void,
    ): void;
    on(event: "error", listener: (err: Error) => void): void;
    on(event: "close", listener: () => void): void;
    on(event: "sessionError", listener: (err: Error, session: ServerHttp2Session) => void): void;
    /* The ALPN=h2 server's surface (createSecureServer WITHOUT
     * allowHTTP1 — the real h2-over-TLS stack): per-stream and
     * per-session listeners, exactly the h2c server's. */
    on(
      event: "stream",
      listener: (stream: ServerHttp2Stream, headers: IncomingHttpHeaders, flags: number) => void,
    ): void;
    on(event: "session", listener: (session: ServerHttp2Session) => void): void;
    /* HTTP CONNECT (and, in Node, the h2 extended CONNECT — which the
     * allowHTTP1 lowering never sees): the second argument is the raw
     * socket on HTTP/1.1 connections; narrow with instanceof. */
    on(
      event: "connect",
      listener: (
        req: Http2ServerRequest | import("http").IncomingMessage,
        resOrSocket: Http2ServerResponse | Socket,
      ) => void,
    ): void;
    once(event: "connection", listener: (socket: Socket) => void): void;
    once(
      event: "request",
      listener: (req: Http2ServerRequest, res: Http2ServerResponse) => void,
    ): void;
    once(event: "error", listener: (err: Error) => void): void;
    once(event: "close", listener: () => void): void;
    once(event: "sessionError", listener: (err: Error, session: ServerHttp2Session) => void): void;
    once(
      event: "stream",
      listener: (stream: ServerHttp2Stream, headers: IncomingHttpHeaders, flags: number) => void,
    ): void;
    once(event: "session", listener: (session: ServerHttp2Session) => void): void;
    once(
      event: "connect",
      listener: (
        req: Http2ServerRequest | import("http").IncomingMessage,
        resOrSocket: Http2ServerResponse | Socket,
      ) => void,
    ): void;
    addListener(event: "connection", listener: (socket: Socket) => void): void;
    addListener(
      event: "request",
      listener: (req: Http2ServerRequest, res: Http2ServerResponse) => void,
    ): void;
    addListener(event: "error", listener: (err: Error) => void): void;
    addListener(event: "close", listener: () => void): void;
    addListener(
      event: "sessionError",
      listener: (err: Error, session: ServerHttp2Session) => void,
    ): void;
    addListener(
      event: "stream",
      listener: (stream: ServerHttp2Stream, headers: IncomingHttpHeaders, flags: number) => void,
    ): void;
    addListener(event: "session", listener: (session: ServerHttp2Session) => void): void;
    addListener(
      event: "connect",
      listener: (
        req: Http2ServerRequest | import("http").IncomingMessage,
        resOrSocket: Http2ServerResponse | Socket,
      ) => void,
    ): void;
  }
  export interface SecureServerOptions {
    allowHTTP1?: boolean;
    cert?: string | Uint8Array;
    key?: string | Uint8Array;
    SNICallback?: (
      servername: string,
      cb: (err: Error | null, ctx?: import("tls").SecureContext) => void,
    ) => void;
    /* The options-record stance (see http.RequestOptions): h2 session-
     * tuning knobs are accepted as literals and ignored (no h2 session
     * ever exists under the allowHTTP1 lowering); other documented keys
     * fence by name; undocumented keys drop like Node. */
    [option: string]: unknown;
  }
  /* The full Node v24 constants table (240 members), literal-typed so
   * computed header keys ([HTTP2_HEADER_PATH]: value) stay literal keys.
   * Every ACCESS bakes as its literal at lowering; the object itself
   * never materializes (bare http2.constants value uses fence). */
  export interface Http2Constants {
    readonly NGHTTP2_ERR_FRAME_SIZE_ERROR: -522;
    readonly NGHTTP2_SESSION_SERVER: 0;
    readonly NGHTTP2_SESSION_CLIENT: 1;
    readonly NGHTTP2_STREAM_STATE_IDLE: 1;
    readonly NGHTTP2_STREAM_STATE_OPEN: 2;
    readonly NGHTTP2_STREAM_STATE_RESERVED_LOCAL: 3;
    readonly NGHTTP2_STREAM_STATE_RESERVED_REMOTE: 4;
    readonly NGHTTP2_STREAM_STATE_HALF_CLOSED_LOCAL: 5;
    readonly NGHTTP2_STREAM_STATE_HALF_CLOSED_REMOTE: 6;
    readonly NGHTTP2_STREAM_STATE_CLOSED: 7;
    readonly NGHTTP2_FLAG_NONE: 0;
    readonly NGHTTP2_FLAG_END_STREAM: 1;
    readonly NGHTTP2_FLAG_END_HEADERS: 4;
    readonly NGHTTP2_FLAG_ACK: 1;
    readonly NGHTTP2_FLAG_PADDED: 8;
    readonly NGHTTP2_FLAG_PRIORITY: 32;
    readonly DEFAULT_SETTINGS_HEADER_TABLE_SIZE: 4096;
    readonly DEFAULT_SETTINGS_ENABLE_PUSH: 1;
    readonly DEFAULT_SETTINGS_MAX_CONCURRENT_STREAMS: 4294967295;
    readonly DEFAULT_SETTINGS_INITIAL_WINDOW_SIZE: 65535;
    readonly DEFAULT_SETTINGS_MAX_FRAME_SIZE: 16384;
    readonly DEFAULT_SETTINGS_MAX_HEADER_LIST_SIZE: 65535;
    readonly DEFAULT_SETTINGS_ENABLE_CONNECT_PROTOCOL: 0;
    readonly MAX_MAX_FRAME_SIZE: 16777215;
    readonly MIN_MAX_FRAME_SIZE: 16384;
    readonly MAX_INITIAL_WINDOW_SIZE: 2147483647;
    readonly NGHTTP2_SETTINGS_HEADER_TABLE_SIZE: 1;
    readonly NGHTTP2_SETTINGS_ENABLE_PUSH: 2;
    readonly NGHTTP2_SETTINGS_MAX_CONCURRENT_STREAMS: 3;
    readonly NGHTTP2_SETTINGS_INITIAL_WINDOW_SIZE: 4;
    readonly NGHTTP2_SETTINGS_MAX_FRAME_SIZE: 5;
    readonly NGHTTP2_SETTINGS_MAX_HEADER_LIST_SIZE: 6;
    readonly NGHTTP2_SETTINGS_ENABLE_CONNECT_PROTOCOL: 8;
    readonly PADDING_STRATEGY_NONE: 0;
    readonly PADDING_STRATEGY_ALIGNED: 1;
    readonly PADDING_STRATEGY_MAX: 2;
    readonly PADDING_STRATEGY_CALLBACK: 1;
    readonly NGHTTP2_NO_ERROR: 0;
    readonly NGHTTP2_PROTOCOL_ERROR: 1;
    readonly NGHTTP2_INTERNAL_ERROR: 2;
    readonly NGHTTP2_FLOW_CONTROL_ERROR: 3;
    readonly NGHTTP2_SETTINGS_TIMEOUT: 4;
    readonly NGHTTP2_STREAM_CLOSED: 5;
    readonly NGHTTP2_FRAME_SIZE_ERROR: 6;
    readonly NGHTTP2_REFUSED_STREAM: 7;
    readonly NGHTTP2_CANCEL: 8;
    readonly NGHTTP2_COMPRESSION_ERROR: 9;
    readonly NGHTTP2_CONNECT_ERROR: 10;
    readonly NGHTTP2_ENHANCE_YOUR_CALM: 11;
    readonly NGHTTP2_INADEQUATE_SECURITY: 12;
    readonly NGHTTP2_HTTP_1_1_REQUIRED: 13;
    readonly NGHTTP2_DEFAULT_WEIGHT: 16;
    readonly HTTP2_HEADER_STATUS: ":status";
    readonly HTTP2_HEADER_METHOD: ":method";
    readonly HTTP2_HEADER_AUTHORITY: ":authority";
    readonly HTTP2_HEADER_SCHEME: ":scheme";
    readonly HTTP2_HEADER_PATH: ":path";
    readonly HTTP2_HEADER_PROTOCOL: ":protocol";
    readonly HTTP2_HEADER_ACCEPT_ENCODING: "accept-encoding";
    readonly HTTP2_HEADER_ACCEPT_LANGUAGE: "accept-language";
    readonly HTTP2_HEADER_ACCEPT_RANGES: "accept-ranges";
    readonly HTTP2_HEADER_ACCEPT: "accept";
    readonly HTTP2_HEADER_ACCESS_CONTROL_ALLOW_CREDENTIALS: "access-control-allow-credentials";
    readonly HTTP2_HEADER_ACCESS_CONTROL_ALLOW_HEADERS: "access-control-allow-headers";
    readonly HTTP2_HEADER_ACCESS_CONTROL_ALLOW_METHODS: "access-control-allow-methods";
    readonly HTTP2_HEADER_ACCESS_CONTROL_ALLOW_ORIGIN: "access-control-allow-origin";
    readonly HTTP2_HEADER_ACCESS_CONTROL_EXPOSE_HEADERS: "access-control-expose-headers";
    readonly HTTP2_HEADER_ACCESS_CONTROL_REQUEST_HEADERS: "access-control-request-headers";
    readonly HTTP2_HEADER_ACCESS_CONTROL_REQUEST_METHOD: "access-control-request-method";
    readonly HTTP2_HEADER_AGE: "age";
    readonly HTTP2_HEADER_AUTHORIZATION: "authorization";
    readonly HTTP2_HEADER_CACHE_CONTROL: "cache-control";
    readonly HTTP2_HEADER_CONNECTION: "connection";
    readonly HTTP2_HEADER_CONTENT_DISPOSITION: "content-disposition";
    readonly HTTP2_HEADER_CONTENT_ENCODING: "content-encoding";
    readonly HTTP2_HEADER_CONTENT_LENGTH: "content-length";
    readonly HTTP2_HEADER_CONTENT_TYPE: "content-type";
    readonly HTTP2_HEADER_COOKIE: "cookie";
    readonly HTTP2_HEADER_DATE: "date";
    readonly HTTP2_HEADER_ETAG: "etag";
    readonly HTTP2_HEADER_FORWARDED: "forwarded";
    readonly HTTP2_HEADER_HOST: "host";
    readonly HTTP2_HEADER_IF_MODIFIED_SINCE: "if-modified-since";
    readonly HTTP2_HEADER_IF_NONE_MATCH: "if-none-match";
    readonly HTTP2_HEADER_IF_RANGE: "if-range";
    readonly HTTP2_HEADER_LAST_MODIFIED: "last-modified";
    readonly HTTP2_HEADER_LINK: "link";
    readonly HTTP2_HEADER_LOCATION: "location";
    readonly HTTP2_HEADER_RANGE: "range";
    readonly HTTP2_HEADER_REFERER: "referer";
    readonly HTTP2_HEADER_SERVER: "server";
    readonly HTTP2_HEADER_SET_COOKIE: "set-cookie";
    readonly HTTP2_HEADER_STRICT_TRANSPORT_SECURITY: "strict-transport-security";
    readonly HTTP2_HEADER_TRANSFER_ENCODING: "transfer-encoding";
    readonly HTTP2_HEADER_TE: "te";
    readonly HTTP2_HEADER_UPGRADE_INSECURE_REQUESTS: "upgrade-insecure-requests";
    readonly HTTP2_HEADER_UPGRADE: "upgrade";
    readonly HTTP2_HEADER_USER_AGENT: "user-agent";
    readonly HTTP2_HEADER_VARY: "vary";
    readonly HTTP2_HEADER_X_CONTENT_TYPE_OPTIONS: "x-content-type-options";
    readonly HTTP2_HEADER_X_FRAME_OPTIONS: "x-frame-options";
    readonly HTTP2_HEADER_KEEP_ALIVE: "keep-alive";
    readonly HTTP2_HEADER_PROXY_CONNECTION: "proxy-connection";
    readonly HTTP2_HEADER_X_XSS_PROTECTION: "x-xss-protection";
    readonly HTTP2_HEADER_ALT_SVC: "alt-svc";
    readonly HTTP2_HEADER_CONTENT_SECURITY_POLICY: "content-security-policy";
    readonly HTTP2_HEADER_EARLY_DATA: "early-data";
    readonly HTTP2_HEADER_EXPECT_CT: "expect-ct";
    readonly HTTP2_HEADER_ORIGIN: "origin";
    readonly HTTP2_HEADER_PURPOSE: "purpose";
    readonly HTTP2_HEADER_TIMING_ALLOW_ORIGIN: "timing-allow-origin";
    readonly HTTP2_HEADER_X_FORWARDED_FOR: "x-forwarded-for";
    readonly HTTP2_HEADER_PRIORITY: "priority";
    readonly HTTP2_HEADER_ACCEPT_CHARSET: "accept-charset";
    readonly HTTP2_HEADER_ACCESS_CONTROL_MAX_AGE: "access-control-max-age";
    readonly HTTP2_HEADER_ALLOW: "allow";
    readonly HTTP2_HEADER_CONTENT_LANGUAGE: "content-language";
    readonly HTTP2_HEADER_CONTENT_LOCATION: "content-location";
    readonly HTTP2_HEADER_CONTENT_MD5: "content-md5";
    readonly HTTP2_HEADER_CONTENT_RANGE: "content-range";
    readonly HTTP2_HEADER_DNT: "dnt";
    readonly HTTP2_HEADER_EXPECT: "expect";
    readonly HTTP2_HEADER_EXPIRES: "expires";
    readonly HTTP2_HEADER_FROM: "from";
    readonly HTTP2_HEADER_IF_MATCH: "if-match";
    readonly HTTP2_HEADER_IF_UNMODIFIED_SINCE: "if-unmodified-since";
    readonly HTTP2_HEADER_MAX_FORWARDS: "max-forwards";
    readonly HTTP2_HEADER_PREFER: "prefer";
    readonly HTTP2_HEADER_PROXY_AUTHENTICATE: "proxy-authenticate";
    readonly HTTP2_HEADER_PROXY_AUTHORIZATION: "proxy-authorization";
    readonly HTTP2_HEADER_REFRESH: "refresh";
    readonly HTTP2_HEADER_RETRY_AFTER: "retry-after";
    readonly HTTP2_HEADER_TRAILER: "trailer";
    readonly HTTP2_HEADER_TK: "tk";
    readonly HTTP2_HEADER_VIA: "via";
    readonly HTTP2_HEADER_WARNING: "warning";
    readonly HTTP2_HEADER_WWW_AUTHENTICATE: "www-authenticate";
    readonly HTTP2_HEADER_HTTP2_SETTINGS: "http2-settings";
    readonly HTTP2_METHOD_ACL: "ACL";
    readonly HTTP2_METHOD_BASELINE_CONTROL: "BASELINE-CONTROL";
    readonly HTTP2_METHOD_BIND: "BIND";
    readonly HTTP2_METHOD_CHECKIN: "CHECKIN";
    readonly HTTP2_METHOD_CHECKOUT: "CHECKOUT";
    readonly HTTP2_METHOD_CONNECT: "CONNECT";
    readonly HTTP2_METHOD_COPY: "COPY";
    readonly HTTP2_METHOD_DELETE: "DELETE";
    readonly HTTP2_METHOD_GET: "GET";
    readonly HTTP2_METHOD_HEAD: "HEAD";
    readonly HTTP2_METHOD_LABEL: "LABEL";
    readonly HTTP2_METHOD_LINK: "LINK";
    readonly HTTP2_METHOD_LOCK: "LOCK";
    readonly HTTP2_METHOD_MERGE: "MERGE";
    readonly HTTP2_METHOD_MKACTIVITY: "MKACTIVITY";
    readonly HTTP2_METHOD_MKCALENDAR: "MKCALENDAR";
    readonly HTTP2_METHOD_MKCOL: "MKCOL";
    readonly HTTP2_METHOD_MKREDIRECTREF: "MKREDIRECTREF";
    readonly HTTP2_METHOD_MKWORKSPACE: "MKWORKSPACE";
    readonly HTTP2_METHOD_MOVE: "MOVE";
    readonly HTTP2_METHOD_OPTIONS: "OPTIONS";
    readonly HTTP2_METHOD_ORDERPATCH: "ORDERPATCH";
    readonly HTTP2_METHOD_PATCH: "PATCH";
    readonly HTTP2_METHOD_POST: "POST";
    readonly HTTP2_METHOD_PRI: "PRI";
    readonly HTTP2_METHOD_PROPFIND: "PROPFIND";
    readonly HTTP2_METHOD_PROPPATCH: "PROPPATCH";
    readonly HTTP2_METHOD_PUT: "PUT";
    readonly HTTP2_METHOD_REBIND: "REBIND";
    readonly HTTP2_METHOD_REPORT: "REPORT";
    readonly HTTP2_METHOD_SEARCH: "SEARCH";
    readonly HTTP2_METHOD_TRACE: "TRACE";
    readonly HTTP2_METHOD_UNBIND: "UNBIND";
    readonly HTTP2_METHOD_UNCHECKOUT: "UNCHECKOUT";
    readonly HTTP2_METHOD_UNLINK: "UNLINK";
    readonly HTTP2_METHOD_UNLOCK: "UNLOCK";
    readonly HTTP2_METHOD_UPDATE: "UPDATE";
    readonly HTTP2_METHOD_UPDATEREDIRECTREF: "UPDATEREDIRECTREF";
    readonly HTTP2_METHOD_VERSION_CONTROL: "VERSION-CONTROL";
    readonly HTTP_STATUS_CONTINUE: 100;
    readonly HTTP_STATUS_SWITCHING_PROTOCOLS: 101;
    readonly HTTP_STATUS_PROCESSING: 102;
    readonly HTTP_STATUS_EARLY_HINTS: 103;
    readonly HTTP_STATUS_OK: 200;
    readonly HTTP_STATUS_CREATED: 201;
    readonly HTTP_STATUS_ACCEPTED: 202;
    readonly HTTP_STATUS_NON_AUTHORITATIVE_INFORMATION: 203;
    readonly HTTP_STATUS_NO_CONTENT: 204;
    readonly HTTP_STATUS_RESET_CONTENT: 205;
    readonly HTTP_STATUS_PARTIAL_CONTENT: 206;
    readonly HTTP_STATUS_MULTI_STATUS: 207;
    readonly HTTP_STATUS_ALREADY_REPORTED: 208;
    readonly HTTP_STATUS_IM_USED: 226;
    readonly HTTP_STATUS_MULTIPLE_CHOICES: 300;
    readonly HTTP_STATUS_MOVED_PERMANENTLY: 301;
    readonly HTTP_STATUS_FOUND: 302;
    readonly HTTP_STATUS_SEE_OTHER: 303;
    readonly HTTP_STATUS_NOT_MODIFIED: 304;
    readonly HTTP_STATUS_USE_PROXY: 305;
    readonly HTTP_STATUS_TEMPORARY_REDIRECT: 307;
    readonly HTTP_STATUS_PERMANENT_REDIRECT: 308;
    readonly HTTP_STATUS_BAD_REQUEST: 400;
    readonly HTTP_STATUS_UNAUTHORIZED: 401;
    readonly HTTP_STATUS_PAYMENT_REQUIRED: 402;
    readonly HTTP_STATUS_FORBIDDEN: 403;
    readonly HTTP_STATUS_NOT_FOUND: 404;
    readonly HTTP_STATUS_METHOD_NOT_ALLOWED: 405;
    readonly HTTP_STATUS_NOT_ACCEPTABLE: 406;
    readonly HTTP_STATUS_PROXY_AUTHENTICATION_REQUIRED: 407;
    readonly HTTP_STATUS_REQUEST_TIMEOUT: 408;
    readonly HTTP_STATUS_CONFLICT: 409;
    readonly HTTP_STATUS_GONE: 410;
    readonly HTTP_STATUS_LENGTH_REQUIRED: 411;
    readonly HTTP_STATUS_PRECONDITION_FAILED: 412;
    readonly HTTP_STATUS_PAYLOAD_TOO_LARGE: 413;
    readonly HTTP_STATUS_URI_TOO_LONG: 414;
    readonly HTTP_STATUS_UNSUPPORTED_MEDIA_TYPE: 415;
    readonly HTTP_STATUS_RANGE_NOT_SATISFIABLE: 416;
    readonly HTTP_STATUS_EXPECTATION_FAILED: 417;
    readonly HTTP_STATUS_TEAPOT: 418;
    readonly HTTP_STATUS_MISDIRECTED_REQUEST: 421;
    readonly HTTP_STATUS_UNPROCESSABLE_ENTITY: 422;
    readonly HTTP_STATUS_LOCKED: 423;
    readonly HTTP_STATUS_FAILED_DEPENDENCY: 424;
    readonly HTTP_STATUS_TOO_EARLY: 425;
    readonly HTTP_STATUS_UPGRADE_REQUIRED: 426;
    readonly HTTP_STATUS_PRECONDITION_REQUIRED: 428;
    readonly HTTP_STATUS_TOO_MANY_REQUESTS: 429;
    readonly HTTP_STATUS_REQUEST_HEADER_FIELDS_TOO_LARGE: 431;
    readonly HTTP_STATUS_UNAVAILABLE_FOR_LEGAL_REASONS: 451;
    readonly HTTP_STATUS_INTERNAL_SERVER_ERROR: 500;
    readonly HTTP_STATUS_NOT_IMPLEMENTED: 501;
    readonly HTTP_STATUS_BAD_GATEWAY: 502;
    readonly HTTP_STATUS_SERVICE_UNAVAILABLE: 503;
    readonly HTTP_STATUS_GATEWAY_TIMEOUT: 504;
    readonly HTTP_STATUS_HTTP_VERSION_NOT_SUPPORTED: 505;
    readonly HTTP_STATUS_VARIANT_ALSO_NEGOTIATES: 506;
    readonly HTTP_STATUS_INSUFFICIENT_STORAGE: 507;
    readonly HTTP_STATUS_LOOP_DETECTED: 508;
    readonly HTTP_STATUS_BANDWIDTH_LIMIT_EXCEEDED: 509;
    readonly HTTP_STATUS_NOT_EXTENDED: 510;
    readonly HTTP_STATUS_NETWORK_AUTHENTICATION_REQUIRED: 511;
  }
  export const constants: Http2Constants;
  /* The eager handler is the first COMPAT 'request' listener — Node's
   * route on either flavor (the allowHTTP1 server's HTTP/1.1 handles,
   * the ALPN=h2 server's compat handles over streams). */
  export function createSecureServer(
    options: SecureServerOptions,
    onRequestHandler?: (
      req: import("http").IncomingMessage,
      res: import("http").ServerResponse,
    ) => void,
  ): Http2SecureServer;

  /* ── the REAL h2c surface (scr_http2.c: frame codec + HPACK over the
   * net loop) — createServer/connect and the session/stream handles the
   * Node suite's http2 family exercises. Headers cross as the canonical
   * header record (the IncomingHttpHeaders index-signature shape); the
   * response :status reads back as a number. Members declared here
   * without a lowering fence by name at their use sites. */

  /** The http2 module's own header shapes: pure index-signature records
   * (the HEADER-FAMILY canonicalization — string[] arm included). */
  export interface IncomingHttpHeaders {
    [name: string]: number | string | string[] | undefined;
  }
  export interface OutgoingHttpHeaders {
    [name: string]: number | string | string[] | undefined;
  }

  export interface Http2Session {
    close(callback?: () => void): void;
    destroy(): void;
    readonly closed: boolean;
    readonly destroyed: boolean;
    readonly encrypted: boolean;
    readonly type: number;
    readonly alpnProtocol: string;
    readonly socket: import("net").Socket;
    readonly pendingSettingsAck: boolean;
    ref(): void;
    unref(): void;
    setTimeout(msecs: number, callback?: () => void): void;
    ping(callback: (err: Error | null, duration: number, payload: Uint8Array) => void): boolean;
    /* The settings surface rides the checked-dynamic machinery (records
     * cross as dyn values — the suite's mustCall listeners are dyn). */
    settings(settings?: any, callback?: any): void;
    readonly localSettings: any;
    readonly remoteSettings: any;
    goaway(code?: number, lastStreamID?: number, opaqueData?: Uint8Array): void;
    on(event: "close" | "timeout", listener: () => void): void;
    on(event: "error", listener: (err: Error) => void): void;
    on(
      event: "connect",
      listener: (session: Http2Session, socket: import("net").Socket) => void,
    ): void;
    on(
      event: "stream",
      listener: (stream: ServerHttp2Stream, headers: IncomingHttpHeaders, flags: number) => void,
    ): void;
    on(
      event: "goaway",
      listener: (errorCode: number, lastStreamID: number, opaqueData?: Uint8Array) => void,
    ): void;
    on(event: "localSettings" | "remoteSettings", listener: (settings: any) => void): void;
    on(event: "frameError", listener: (type: number, code: number, id: number) => void): void;
    on(event: "ping", listener: (payload: Uint8Array) => void): void;
    once(event: "close" | "timeout", listener: () => void): void;
    once(event: "error", listener: (err: Error) => void): void;
    once(
      event: "connect",
      listener: (session: Http2Session, socket: import("net").Socket) => void,
    ): void;
    once(
      event: "stream",
      listener: (stream: ServerHttp2Stream, headers: IncomingHttpHeaders, flags: number) => void,
    ): void;
    once(
      event: "goaway",
      listener: (errorCode: number, lastStreamID: number, opaqueData?: Uint8Array) => void,
    ): void;
    once(event: "localSettings" | "remoteSettings", listener: (settings: any) => void): void;
    once(event: "frameError", listener: (type: number, code: number, id: number) => void): void;
    once(event: "ping", listener: (payload: Uint8Array) => void): void;
    addListener(event: "close" | "timeout", listener: () => void): void;
    addListener(event: "error", listener: (err: Error) => void): void;
    addListener(
      event: "connect",
      listener: (session: Http2Session, socket: import("net").Socket) => void,
    ): void;
    addListener(
      event: "stream",
      listener: (stream: ServerHttp2Stream, headers: IncomingHttpHeaders, flags: number) => void,
    ): void;
    addListener(
      event: "goaway",
      listener: (errorCode: number, lastStreamID: number, opaqueData?: Uint8Array) => void,
    ): void;
    addListener(event: "localSettings" | "remoteSettings", listener: (settings: any) => void): void;
    addListener(
      event: "frameError",
      listener: (type: number, code: number, id: number) => void,
    ): void;
    addListener(event: "ping", listener: (payload: Uint8Array) => void): void;
  }

  export interface ClientHttp2Session extends Http2Session {
    request(
      headers?: OutgoingHttpHeaders,
      options?: {
        endStream?: boolean;
        exclusive?: boolean;
        parent?: number;
        weight?: number;
        waitForTrailers?: boolean;
      },
    ): ClientHttp2Stream;
  }

  export interface ServerHttp2Session extends Http2Session {
    altsvc(alt: string, originOrStream: number | string): void;
    origin(...origins: string[]): void;
  }

  /** The shared Http2Stream core (both roles). 'data' chunks are Buffers
   * (strings once setEncoding('utf8') is in force — the IncomingMessage
   * chunk:any stance keeps both working). */
  interface Http2StreamCore {
    readonly id: number | undefined;
    readonly rstCode: number;
    readonly closed: boolean;
    readonly destroyed: boolean;
    readonly pending: boolean;
    readonly aborted: boolean;
    readonly session: Http2Session;
    readonly sentHeaders: OutgoingHttpHeaders;
    readonly state: Record<string, number>;
    write(chunk: string | Uint8Array, callback?: (err?: Error | null) => void): boolean;
    end(data?: string | Uint8Array, callback?: () => void): void;
    end(callback: () => void): void;
    close(code?: number, callback?: () => void): void;
    destroy(error?: Error): void;
    setEncoding(encoding: string): this;
    resume(): void;
    pause(): void;
    setTimeout(msecs: number, callback?: () => void): void;
    priority(options: Record<string, number | boolean>): void;
    sendTrailers(headers: OutgoingHttpHeaders): void;
  }

  export interface ServerHttp2Stream extends Http2StreamCore {
    on(event: "data", listener: (chunk: any) => void): void;
    on(
      event:
        | "end"
        | "close"
        | "aborted"
        | "ready"
        | "timeout"
        | "drain"
        | "finish"
        | "wantTrailers",
      listener: () => void,
    ): void;
    on(event: "error", listener: (err: Error) => void): void;
    on(event: "frameError", listener: (type: number, code: number, id: number) => void): void;
    on(event: "trailers", listener: (trailers: IncomingHttpHeaders, flags: number) => void): void;
    once(event: "data", listener: (chunk: any) => void): void;
    once(
      event:
        | "end"
        | "close"
        | "aborted"
        | "ready"
        | "timeout"
        | "drain"
        | "finish"
        | "wantTrailers",
      listener: () => void,
    ): void;
    once(event: "error", listener: (err: Error) => void): void;
    once(event: "frameError", listener: (type: number, code: number, id: number) => void): void;
    once(event: "trailers", listener: (trailers: IncomingHttpHeaders, flags: number) => void): void;
    addListener(event: "data", listener: (chunk: any) => void): void;
    addListener(
      event:
        | "end"
        | "close"
        | "aborted"
        | "ready"
        | "timeout"
        | "drain"
        | "finish"
        | "wantTrailers",
      listener: () => void,
    ): void;
    addListener(event: "error", listener: (err: Error) => void): void;
    addListener(
      event: "frameError",
      listener: (type: number, code: number, id: number) => void,
    ): void;
    addListener(
      event: "trailers",
      listener: (trailers: IncomingHttpHeaders, flags: number) => void,
    ): void;
    respond(
      headers?: OutgoingHttpHeaders,
      options?: { endStream?: boolean; waitForTrailers?: boolean },
    ): void;
    respondWithFile(
      path: string,
      headers?: OutgoingHttpHeaders,
      options?: Record<string, unknown>,
    ): void;
    respondWithFD(
      fd: number,
      headers?: OutgoingHttpHeaders,
      options?: Record<string, unknown>,
    ): void;
    pushStream(
      headers: OutgoingHttpHeaders,
      callback: (
        err: Error | null,
        pushStream: ServerHttp2Stream,
        headers: OutgoingHttpHeaders,
      ) => void,
    ): void;
    readonly headersSent: boolean;
    readonly pushAllowed: boolean;
    additionalHeaders(headers: OutgoingHttpHeaders): void;
  }

  export interface ClientHttp2Stream extends Http2StreamCore {
    on(event: "response", listener: (headers: IncomingHttpHeaders, flags: number) => void): void;
    on(event: "push", listener: (headers: IncomingHttpHeaders, flags: number) => void): void;
    on(event: "headers", listener: (headers: IncomingHttpHeaders, flags: number) => void): void;
    on(event: "data", listener: (chunk: any) => void): void;
    on(
      event:
        | "end"
        | "close"
        | "aborted"
        | "ready"
        | "timeout"
        | "drain"
        | "finish"
        | "wantTrailers",
      listener: () => void,
    ): void;
    on(event: "error", listener: (err: Error) => void): void;
    on(event: "frameError", listener: (type: number, code: number, id: number) => void): void;
    on(event: "trailers", listener: (trailers: IncomingHttpHeaders, flags: number) => void): void;
    once(event: "response", listener: (headers: IncomingHttpHeaders, flags: number) => void): void;
    once(event: "push", listener: (headers: IncomingHttpHeaders, flags: number) => void): void;
    once(event: "headers", listener: (headers: IncomingHttpHeaders, flags: number) => void): void;
    once(event: "data", listener: (chunk: any) => void): void;
    once(
      event:
        | "end"
        | "close"
        | "aborted"
        | "ready"
        | "timeout"
        | "drain"
        | "finish"
        | "wantTrailers",
      listener: () => void,
    ): void;
    once(event: "error", listener: (err: Error) => void): void;
    once(event: "frameError", listener: (type: number, code: number, id: number) => void): void;
    once(event: "trailers", listener: (trailers: IncomingHttpHeaders, flags: number) => void): void;
    addListener(
      event: "response",
      listener: (headers: IncomingHttpHeaders, flags: number) => void,
    ): void;
    addListener(
      event: "push",
      listener: (headers: IncomingHttpHeaders, flags: number) => void,
    ): void;
    addListener(
      event: "headers",
      listener: (headers: IncomingHttpHeaders, flags: number) => void,
    ): void;
    addListener(event: "data", listener: (chunk: any) => void): void;
    addListener(
      event:
        | "end"
        | "close"
        | "aborted"
        | "ready"
        | "timeout"
        | "drain"
        | "finish"
        | "wantTrailers",
      listener: () => void,
    ): void;
    addListener(event: "error", listener: (err: Error) => void): void;
    addListener(
      event: "frameError",
      listener: (type: number, code: number, id: number) => void,
    ): void;
    addListener(
      event: "trailers",
      listener: (trailers: IncomingHttpHeaders, flags: number) => void,
    ): void;
  }

  export interface Http2Server {
    listen(port?: number, callback?: () => void): void;
    listen(port: number, host: string, callback?: () => void): void;
    close(callback?: () => void): void;
    address(): import("node:dgram").AddressInfo;
    setTimeout(msecs?: number, callback?: () => void): void;
    ref(): void;
    unref(): void;
    on(
      event: "stream",
      listener: (stream: ServerHttp2Stream, headers: IncomingHttpHeaders, flags: number) => void,
    ): void;
    on(event: "session", listener: (session: ServerHttp2Session) => void): void;
    on(
      event: "request",
      listener: (req: Http2ServerRequest, res: Http2ServerResponse) => void,
    ): void;
    on(event: "error", listener: (err: Error) => void): void;
    on(event: "close" | "listening" | "timeout", listener: () => void): void;
    on(event: "connection", listener: (socket: import("net").Socket) => void): void;
    on(event: "sessionError", listener: (err: Error, session: ServerHttp2Session) => void): void;
    once(
      event: "stream",
      listener: (stream: ServerHttp2Stream, headers: IncomingHttpHeaders, flags: number) => void,
    ): void;
    once(event: "session", listener: (session: ServerHttp2Session) => void): void;
    once(
      event: "request",
      listener: (req: Http2ServerRequest, res: Http2ServerResponse) => void,
    ): void;
    once(event: "error", listener: (err: Error) => void): void;
    once(event: "close" | "listening" | "timeout", listener: () => void): void;
    once(event: "connection", listener: (socket: import("net").Socket) => void): void;
    once(event: "sessionError", listener: (err: Error, session: ServerHttp2Session) => void): void;
    addListener(
      event: "stream",
      listener: (stream: ServerHttp2Stream, headers: IncomingHttpHeaders, flags: number) => void,
    ): void;
    addListener(event: "session", listener: (session: ServerHttp2Session) => void): void;
    addListener(
      event: "request",
      listener: (req: Http2ServerRequest, res: Http2ServerResponse) => void,
    ): void;
    addListener(event: "error", listener: (err: Error) => void): void;
    addListener(event: "close" | "listening" | "timeout", listener: () => void): void;
    addListener(event: "connection", listener: (socket: import("net").Socket) => void): void;
    addListener(
      event: "sessionError",
      listener: (err: Error, session: ServerHttp2Session) => void,
    ): void;
  }

  export interface ServerOptions {
    [option: string]: unknown;
  }

  export function createServer(
    onRequestHandler?: (req: Http2ServerRequest, res: Http2ServerResponse) => void,
  ): Http2Server;
  export function createServer(
    options: ServerOptions,
    onRequestHandler?: (req: Http2ServerRequest, res: Http2ServerResponse) => void,
  ): Http2Server;

  export function connect(
    authority: string,
    listener?: (session: ClientHttp2Session, socket: import("net").Socket) => void,
  ): ClientHttp2Session;
  export function connect(
    authority: string,
    options: Record<string, unknown>,
    listener?: (session: ClientHttp2Session, socket: import("net").Socket) => void,
  ): ClientHttp2Session;

  export function getDefaultSettings(): any;
  export function getPackedSettings(settings: Record<string, number | boolean>): Uint8Array;
  export const sensitiveHeaders: unique symbol;
}

declare module "node:http2" {
  export * from "http2";
}
