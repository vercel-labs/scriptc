// Types shared by the undici entries. They restate the subset of undici's
// own declarations (types/dispatcher.d.ts, connector.d.ts, ...) that the
// shim implements; test/package-shims/undici-types.test.ts checks them
// against the installed 5.x and 7.x declarations.
import type { Socket } from "node:net";
import type { Dispatcher } from "./dispatcher.ts";

/** Response and request header records (undici's IncomingHttpHeaders). */
export type IncomingHttpHeaders = Record<string, string | string[] | undefined>;

/** What a request's `headers` option accepts here: a record or a flat
 * [name, value, ...] array. */
export type UndiciHeaders = Record<string, string | string[] | undefined> | string[] | null;

/** The payloads the shim writes. Streams, iterables, Blob and FormData
 * bodies are outside the implemented subset. */
export type RequestBody = string | Buffer | Uint8Array | null;

export interface DispatchOptions {
  origin?: string | URL;
  path: string;
  method: string;
  body?: RequestBody;
  headers?: UndiciHeaders;
  idempotent?: boolean;
  blocking?: boolean;
  headersTimeout?: number | null;
  bodyTimeout?: number | null;
  reset?: boolean;
  throwOnError?: boolean;
  // Dispatcher.RequestOptions' members live here too: a record passed to
  // dispatch() is copied to this shape, and interceptors read them back
  // through a `params as Dispatcher.RequestOptions` cast, as with undici.
  opaque?: unknown;
  signal?: AbortSignal | null;
  onInfo?: (info: { statusCode: number; headers: IncomingHttpHeaders }) => void;
  highWaterMark?: number;
}

/** undici's dispatch-controller (7.x handler API). */
export interface DispatchController {
  readonly aborted: boolean;
  readonly paused: boolean;
  readonly reason: Error | null;
  abort(reason: Error): void;
  pause(): void;
  resume(): void;
}

/** Dispatch handlers: the 5.x callbacks, plus 7.x's controller callbacks. */
export interface DispatchHandlers {
  onConnect?(abort: (err?: Error) => void): void;
  onError?(err: Error): void;
  onHeaders?(
    statusCode: number,
    headers: Buffer[],
    resume: () => void,
    statusText: string,
  ): boolean;
  onData?(chunk: Buffer): boolean;
  onComplete?(trailers: string[] | null): void;
  onBodySent?(chunkSize: number, totalBytesSent: number): void;
  onRequestStart?(controller: DispatchController, context: unknown): void;
  onResponseStart?(
    controller: DispatchController,
    statusCode: number,
    headers: IncomingHttpHeaders,
    statusMessage?: string,
  ): void;
  onResponseData?(controller: DispatchController, chunk: Buffer): void;
  onResponseEnd?(controller: DispatchController, trailers: IncomingHttpHeaders): void;
  onResponseError?(controller: DispatchController, error: Error): void;
}

export type DispatchFn = (options: DispatchOptions, handler: DispatchHandlers) => boolean;

export type DispatchInterceptor = (dispatch: DispatchFn) => DispatchFn;

/** buildConnector's per-connection parameters. */
export interface ConnectorOptions {
  hostname: string;
  host?: string;
  protocol: string;
  port: string;
  servername?: string;
  localAddress?: string | null;
}

export type ConnectorCallback = (err: Error | null, socket: Socket | null) => void;

/** A connector: dials, reports through the callback, and returns the socket
 * (undici 5 and 7 both return it although their types declare void). */
export type Connector = (options: ConnectorOptions, callback: ConnectorCallback) => Socket;

/** net/tls connect options a connector forwards (the implemented subset). */
export interface ConnectorBuildOptions {
  timeout?: number | null;
  maxCachedSessions?: number | null;
  socketPath?: string | null;
  port?: number;
  rejectUnauthorized?: boolean;
  ca?: string | Buffer | (string | Buffer)[];
  servername?: string;
  /** net.connect's resolver hook: @types/node's LookupFunction is
   * assignable (method syntax; the callback takes one address or all). */
  lookup?(
    hostname: string,
    options: unknown,
    callback: (
      err: NodeJS.ErrnoException | null,
      address: string | LookupAddress[],
      family?: number,
    ) => void,
  ): void;
  keepAlive?: boolean;
  keepAliveInitialDelay?: number;
  noDelay?: boolean;
  autoSelectFamily?: boolean;
  autoSelectFamilyAttemptTimeout?: number;
}

export interface LookupAddress {
  address: string;
  family: number;
}

export interface ClientOptions {
  keepAliveTimeout?: number | null;
  keepAliveMaxTimeout?: number | null;
  keepAliveTimeoutThreshold?: number | null;
  pipelining?: number | null;
  connect?: ConnectorBuildOptions | Connector | null;
  maxHeaderSize?: number | null;
  bodyTimeout?: number | null;
  headersTimeout?: number | null;
  strictContentLength?: boolean;
  maxRequestsPerClient?: number;
  maxResponseSize?: number | null;
  connectTimeout?: number | null;
  localAddress?: string;
  /** 5.x applies `Client` interceptors; 7.x ignores the option. */
  interceptors?: { Client?: readonly DispatchInterceptor[] | undefined };
}

export interface PoolOptions extends ClientOptions {
  factory?(origin: URL, opts: object): Dispatcher;
  connections?: number | null;
  interceptors?: {
    Pool?: readonly DispatchInterceptor[] | undefined;
    Client?: readonly DispatchInterceptor[] | undefined;
  };
}

export interface AgentOptions extends PoolOptions {
  factory?(origin: string | URL, opts: object): Dispatcher;
  interceptors?: {
    Agent?: readonly DispatchInterceptor[] | undefined;
    Pool?: readonly DispatchInterceptor[] | undefined;
    Client?: readonly DispatchInterceptor[] | undefined;
  };
}

/** Version-dependent behavior, selected by the importing package's installed
 * undici (the 5.x or 7.x entry). */
export interface Profile {
  major: number;
}
