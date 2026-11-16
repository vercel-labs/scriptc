/// <reference path="./dgram.d.ts" />
/// <reference path="./dns.d.ts" />
/// <reference path="./http.d.ts" />
/// <reference path="./http2.d.ts" />
/// <reference path="./tls.d.ts" />

/* node:net — the inbound-networking slice (scr_net.c links only into
 * net-using binaries). TCP only, Node's shapes narrowed to what lowers:
 * createServer with an optional connection handler; listen(port[, cb])
 * with the real port discoverable as address().port (the composed read
 * is the lowered form — bare address() has no lowering); close([cb])
 * firing once connections drain; socket write/end/destroy/pipe and the
 * data/end/close/error/connect/drain events (on and once — listeners
 * take at most the declared parameter). write returns Node's
 * backpressure boolean; end, destroy, setEncoding, setTimeout and the
 * socket-option setters answer the socket (Node's chaining); on/once return
 * void (chaining is fenced). connect's host is a numeric IP or "localhost"
 * (pinned to 127.0.0.1 — SEMANTICS.md); every failure is the async 'error'
 * event,
 * and an 'error' with no listener exits 1 like an unhandled EventEmitter
 * 'error'. */
declare module "net" {
  export interface Socket {
    /* Whether the socket keeps the event loop alive (ref'd by default).
     * Both chain, Node's shape. */
    ref(): Socket;
    unref(): Socket;
    readonly remoteAddress: string | undefined;
    /* The peer's fields are cached at first read, like remoteAddress; the
     * local ones are undefined while connecting and after close. */
    readonly remotePort: number | undefined;
    readonly remoteFamily: string | undefined;
    readonly localAddress: string | undefined;
    readonly localPort: number | undefined;
    readonly localFamily: string | undefined;
    readonly bytesRead: number;
    readonly connecting: boolean;
    readonly pending: boolean;
    readonly readyState: "opening" | "open" | "readOnly" | "writeOnly" | "closed";
    /* true once the fd is gone (destroy() or full close) — Node's flag. */
    readonly destroyed: boolean;
    /* the write half is open: no end() yet, no FIN sent, fd alive. */
    readonly writable: boolean;
    /* true until the read half is done (peer FIN / destroy). */
    readonly readable: boolean;
    /* every byte the write paths accepted (buffered included — Node
     * counts those too; plaintext on TLS sockets). */
    readonly bytesWritten: number;
    /* The unsent bytes (Node's deprecated writableLength alias); Node
     * answers undefined before the socket has a handle. */
    readonly bufferSize: number;
    /* The "$ip:$port" strings a multi-address dial tried; Node's property
     * is absent (undefined) when the dial took the single-address path. */
    readonly autoSelectFamilyAttemptedAddresses: string[];
    /* write's callback runs once the data is flushed, with null; end's
     * once the socket finishes. */
    /* false when the bytes this write left unsent reach the 65536-byte
     * high-water mark, as in Node; 'drain' fires when they are all sent. */
    write(data: string | Uint8Array, callback?: (err?: Error | null) => void): boolean;
    /* the bytes written and not yet sent */
    readonly writableLength: number;
    /* a write answered false and 'drain' has not fired yet */
    readonly writableNeedDrain: boolean;
    end(callback?: () => void): Socket;
    end(data: string | Uint8Array, callback?: () => void): Socket;
    /* An explicit destroy only; the error payload form is not lowered. */
    destroy(): Socket;
    /* Flow control: pause holds reads off (kernel/TCP backpressure is
     * the buffer); resume flows — and discards without listeners, so
     * 'end' stays reachable. Both chain, Node's shape. */
    pause(): Socket;
    resume(): Socket;
    /* TCP_NODELAY on the live fd; missing means true. Chains. */
    setNoDelay(noDelay?: boolean): Socket;
    /* SO_KEEPALIVE with the initial delay in ms; interval and count tune
     * the probes. A trailing `enable` object is Node's options form
     * ({ enable, initialDelay, interval, count }). Chains. */
    setKeepAlive(
      enable?: boolean,
      initialDelay?: number,
      interval?: number,
      count?: number,
    ): Socket;
    setKeepAlive(options: {
      enable?: boolean;
      initialDelay?: number;
      interval?: number;
      count?: number;
    }): Socket;
    /* end() now, destroy once the FIN actually flushed. */
    destroySoon(): void;
    /* An RST instead of a FIN; a connecting socket resets once it
     * connects. Throws ERR_INVALID_HANDLE_TYPE on a TLS socket. */
    resetAndDestroy(): Socket;
    /* The local address, or {} while connecting and once destroyed. */
    address(): AddressInfo | {};
    /* setEncoding([encoding]): 'data' delivers strings — the IncomingMessage
     * twin's contract. A missing encoding is 'utf8'. Chains. */
    setEncoding(encoding?: string): Socket;
    /* socket→socket, and socket→response (the extended-CONNECT bridge
     * leg: raw chunks become response body writes; EOF ends it). */
    pipe(
      destination: Socket | import("http").ServerResponse | import("http2").Http2ServerResponse,
    ): void;
    /* The callback is a once('timeout') listener (removed again by 0).
     * Chains. */
    setTimeout(ms: number, callback?: () => void): Socket;
    /* The paused-mode demux surface: once('readable') + read(1) +
     * unshift — read answers exactly n buffered bytes or null. */
    read(size?: number): Buffer | null;
    unshift(chunk: Uint8Array): void;
    /* secureConnect/secure/session are TLS-socket events declared on the
     * shared socket surface (the lowering collapses TLSSocket onto this kind):
     * the runtime gates on the transport, so a plain socket's
     * registration never fires — Node's exact split. 'session' fires
     * once with the serialized session (the received-ticket event). */
    on(event: "data", listener: (chunk: Buffer) => void): void;
    /* After setEncoding the chunk is a string. */
    on(event: "data", listener: (chunk: string) => void): void;
    on(
      event:
        | "end"
        | "connect"
        | "ready"
        | "timeout"
        | "drain"
        | "readable"
        | "finish"
        | "secureConnect"
        | "secure",
      listener: () => void,
    ): void;
    on(event: "close", listener: (hadError: boolean) => void): void;
    on(event: "error", listener: (err: Error) => void): void;
    on(event: "session", listener: (session: Buffer) => void): void;
    /* The host name's resolution, before the connect. */
    on(
      event: "lookup",
      listener: (err: Error | null, address: string, family: number, host: string) => void,
    ): void;
    /* The happy-eyeballs dial's attempt events: (ip, port, family) per
     * address tried; the failure carries the error too. */
    on(
      event: "connectionAttempt" | "connectionAttemptTimeout",
      listener: (ip: string, port: number, family: number) => void,
    ): void;
    on(
      event: "connectionAttemptFailed",
      listener: (ip: string, port: number, family: number, error: Error) => void,
    ): void;
    /* addListener IS on (Node aliases them) — the suite spells both. */
    addListener(event: "data", listener: (chunk: Buffer) => void): void;
    /* After setEncoding the chunk is a string. */
    addListener(event: "data", listener: (chunk: string) => void): void;
    addListener(
      event:
        | "end"
        | "connect"
        | "ready"
        | "timeout"
        | "drain"
        | "readable"
        | "finish"
        | "secureConnect"
        | "secure",
      listener: () => void,
    ): void;
    addListener(event: "close", listener: (hadError: boolean) => void): void;
    addListener(event: "error", listener: (err: Error) => void): void;
    addListener(event: "session", listener: (session: Buffer) => void): void;
    /* The host name's resolution, before the connect. */
    addListener(
      event: "lookup",
      listener: (err: Error | null, address: string, family: number, host: string) => void,
    ): void;
    addListener(
      event: "connectionAttempt" | "connectionAttemptTimeout",
      listener: (ip: string, port: number, family: number) => void,
    ): void;
    addListener(
      event: "connectionAttemptFailed",
      listener: (ip: string, port: number, family: number, error: Error) => void,
    ): void;
    once(event: "data", listener: (chunk: Buffer) => void): void;
    /* After setEncoding the chunk is a string. */
    once(event: "data", listener: (chunk: string) => void): void;
    once(
      event:
        | "end"
        | "connect"
        | "ready"
        | "timeout"
        | "drain"
        | "readable"
        | "finish"
        | "secureConnect"
        | "secure",
      listener: () => void,
    ): void;
    once(event: "close", listener: (hadError: boolean) => void): void;
    once(event: "error", listener: (err: Error) => void): void;
    once(event: "session", listener: (session: Buffer) => void): void;
    /* The host name's resolution, before the connect. */
    once(
      event: "lookup",
      listener: (err: Error | null, address: string, family: number, host: string) => void,
    ): void;
    once(
      event: "connectionAttempt" | "connectionAttemptTimeout",
      listener: (ip: string, port: number, family: number) => void,
    ): void;
    once(
      event: "connectionAttemptFailed",
      listener: (ip: string, port: number, family: number, error: Error) => void,
    ): void;
  }
  export interface Server {
    /* Node's `promisify(this.close)()`: the promise fulfills at 'close',
     * at once for a server that never listened. */
    [Symbol.asyncDispose](): Promise<void>;
    /* Whether the server keeps the event loop alive (ref'd by default).
     * Both chain, Node's shape. */
    ref(): Server;
    unref(): Server;
    readonly listening: boolean;
    /* Connections past this many are closed with a 'drop' event;
     * undefined (the default) or null lifts the cap. */
    maxConnections: number | undefined;
    /* Node reads it only in cluster mode: a stored value here. */
    dropMaxConnection: boolean | undefined;
    /* cb(null, count) on the next tick. */
    getConnections(callback: (error: Error | null, count: number) => void): Server;
    /* Node answers the server itself (`return this` chaining). An
     * undefined port is an arbitrary unused one; a string is the port
     * when it reads as a number (`process.env.PORT || 3000`) and a
     * Unix-socket path otherwise. */
    listen(port?: number | string, callback?: () => void): Server;
    /* No port: an arbitrary unused one. */
    listen(callback?: () => void): Server;
    /* The positional bind address (the options form's host in argument
     * spelling); an undefined host is every interface. */
    listen(port?: number | string, host?: string, callback?: () => void): Server;
    /* A Unix-socket server; the socket file is removed when it closes. */
    listen(path: string, callback?: () => void): Server;
    /* Adopt a socket bound at construction (net.BoundSocket): the server
     * takes over the descriptor, reports its address, and the bound
     * socket answers ERR_SOCKET_HANDLE_ADOPTED from then on. Its 'listening'
     * callback fires once the server accepts. */
    listen(handle: BoundSocket, callback?: () => void): Server;
    /* The explicit-interface bind: host is an IP literal (absent or
     * undefined = the host-less dual-stack any); path names a Unix socket
     * (a leading '\0' is the abstract namespace) and is mutually exclusive
     * with the port form; ipv6Only sets IPV6_V6ONLY and reusePort requests
     * kernel connection distribution where Node supports it. Every field
     * is optional, as in Node's net.ListenOptions: the runtime answers
     * ERR_INVALID_ARG_VALUE for an option bag with neither port nor path. */
    listen(
      options: {
        port?: number | string | undefined;
        path?: string | undefined;
        host?: string | undefined;
        backlog?: number;
        ipv6Only?: boolean;
        reusePort?: boolean;
      },
      callback?: () => void,
    ): Server;
    close(callback?: () => void): Server;
    /* The bound AddressInfo (Node answers null before listen — this
     * surface answers the record with port 0 there, the serverPort
     * stance). */
    address(): import("node:dgram").AddressInfo;
    /* The demux route: hand an accepted socket to another server. */
    emit(event: "connection", socket: Socket): boolean;
    on(event: "connection", listener: (socket: Socket) => void): void;
    /* tls and https servers: the socket after its handshake */
    on(event: "secureConnection", listener: (socket: import("tls").TLSSocket) => void): void;
    /* tls and https servers: a handshake that failed */
    on(
      event: "tlsClientError",
      listener: (err: Error, tlsSocket: import("tls").TLSSocket) => void,
    ): void;
    on(event: "close" | "listening", listener: () => void): void;
    on(event: "drop", listener: (data?: DropArgument) => void): void;
    on(event: "timeout", listener: (socket: Socket) => void): void;
    on(event: "error", listener: (err: Error) => void): void;
    /* http servers: a request the parser rejects, or a connection error */
    on(event: "clientError", listener: (err: Error, socket: Socket) => void): void;
    /* The WebSocket handover: fires INSTEAD of 'request' for
     * Connection: upgrade requests, with the raw socket + head bytes;
     * 'connect' is its twin for CONNECT requests (HTTP tunneling). */
    on(
      event: "upgrade" | "connect",
      listener: (req: import("http").IncomingMessage, socket: Socket, head: Buffer) => void,
    ): void;
    /* http.createServer(handler)'s event twin (a no-parser net server
     * never fires it, like Node). */
    on(
      event: "request" | "checkContinue" | "checkExpectation",
      listener: (req: import("http").IncomingMessage, res: import("http").ServerResponse) => void,
    ): void;
    /* http servers: a request past server.maxRequestsPerSocket (the
     * server answers 503 itself). */
    on(
      event: "dropRequest",
      listener: (req: import("http").IncomingMessage, socket: Socket) => void,
    ): void;
    /* addListener IS on (Node aliases them) — the suite spells both. */
    addListener(event: "connection" | "secureConnection", listener: (socket: Socket) => void): void;
    /* tls and https servers: a handshake that failed */
    addListener(
      event: "tlsClientError",
      listener: (err: Error, tlsSocket: import("tls").TLSSocket) => void,
    ): void;
    addListener(event: "close" | "listening", listener: () => void): void;
    addListener(event: "drop", listener: (data?: DropArgument) => void): void;
    addListener(event: "timeout", listener: (socket: Socket) => void): void;
    addListener(event: "error", listener: (err: Error) => void): void;
    /* http servers: a request the parser rejects, or a connection error */
    addListener(event: "clientError", listener: (err: Error, socket: Socket) => void): void;
    addListener(
      event: "upgrade" | "connect",
      listener: (req: import("http").IncomingMessage, socket: Socket, head: Buffer) => void,
    ): void;
    addListener(
      event: "request" | "checkContinue" | "checkExpectation",
      listener: (req: import("http").IncomingMessage, res: import("http").ServerResponse) => void,
    ): void;
    addListener(
      event: "dropRequest",
      listener: (req: import("http").IncomingMessage, socket: Socket) => void,
    ): void;
    once(event: "connection", listener: (socket: Socket) => void): void;
    once(event: "secureConnection", listener: (socket: import("tls").TLSSocket) => void): void;
    /* tls and https servers: a handshake that failed */
    once(
      event: "tlsClientError",
      listener: (err: Error, tlsSocket: import("tls").TLSSocket) => void,
    ): void;
    once(event: "close" | "listening", listener: () => void): void;
    once(event: "drop", listener: (data?: DropArgument) => void): void;
    once(event: "timeout", listener: (socket: Socket) => void): void;
    once(event: "error", listener: (err: Error) => void): void;
    /* http servers: a request the parser rejects, or a connection error */
    once(event: "clientError", listener: (err: Error, socket: Socket) => void): void;
    once(
      event: "upgrade" | "connect",
      listener: (req: import("http").IncomingMessage, socket: Socket, head: Buffer) => void,
    ): void;
    once(
      event: "request" | "checkContinue" | "checkExpectation",
      listener: (req: import("http").IncomingMessage, res: import("http").ServerResponse) => void,
    ): void;
    once(
      event: "dropRequest",
      listener: (req: import("http").IncomingMessage, socket: Socket) => void,
    ): void;
    /* The EventEmitter meta event: fires with the event name before a
     * listener joins any of the server's lists. */
    on(event: "newListener", listener: (event: string) => void): void;
    addListener(event: "newListener", listener: (event: string) => void): void;
    once(event: "newListener", listener: (event: string) => void): void;
    /* off / removeListener: the LAST listener standing for the same
     * function leaves that event's list (Node's EventEmitter order). */
    off(event: "error", listener: (err: Error) => void): void;
    off(event: "close" | "listening", listener: () => void): void;
    off(event: "connection" | "secureConnection", listener: (socket: Socket) => void): void;
    off(event: "timeout", listener: (socket: Socket) => void): void;
    off(event: "drop", listener: (data?: DropArgument) => void): void;
    off(event: "newListener", listener: (event: string) => void): void;
    off(
      event: "tlsClientError",
      listener: (err: Error, tlsSocket: import("tls").TLSSocket) => void,
    ): void;
    off(event: "clientError", listener: (err: Error, socket: Socket) => void): void;
    off(
      event: "upgrade" | "connect",
      listener: (req: import("http").IncomingMessage, socket: Socket, head: Buffer) => void,
    ): void;
    off(
      event: "request" | "checkContinue" | "checkExpectation",
      listener: (req: import("http").IncomingMessage, res: import("http").ServerResponse) => void,
    ): void;
    off(
      event: "dropRequest",
      listener: (req: import("http").IncomingMessage, socket: Socket) => void,
    ): void;
    removeListener(event: "error", listener: (err: Error) => void): void;
    removeListener(event: "close" | "listening", listener: () => void): void;
    removeListener(
      event: "connection" | "secureConnection",
      listener: (socket: Socket) => void,
    ): void;
    removeListener(event: "timeout", listener: (socket: Socket) => void): void;
    removeListener(event: "drop", listener: (data?: DropArgument) => void): void;
    removeListener(event: "newListener", listener: (event: string) => void): void;
    removeListener(
      event: "tlsClientError",
      listener: (err: Error, tlsSocket: import("tls").TLSSocket) => void,
    ): void;
    removeListener(event: "clientError", listener: (err: Error, socket: Socket) => void): void;
    removeListener(
      event: "upgrade" | "connect",
      listener: (req: import("http").IncomingMessage, socket: Socket, head: Buffer) => void,
    ): void;
    removeListener(
      event: "request" | "checkContinue" | "checkExpectation",
      listener: (req: import("http").IncomingMessage, res: import("http").ServerResponse) => void,
    ): void;
    removeListener(
      event: "dropRequest",
      listener: (req: import("http").IncomingMessage, socket: Socket) => void,
    ): void;
    /* The event's listeners in registration order, each the function the
     * program registered (Node's identity semantics), typed by the event's
     * listener shape. */
    listeners(event: "error"): ((err: Error) => void)[];
    listeners(event: "close" | "listening"): (() => void)[];
    listeners(event: "connection" | "secureConnection"): ((socket: Socket) => void)[];
    listeners(event: "timeout"): ((socket: Socket) => void)[];
    listeners(event: "drop"): ((data?: DropArgument) => void)[];
    listeners(event: "newListener"): ((event: string) => void)[];
    listeners(
      event: "tlsClientError",
    ): ((err: Error, tlsSocket: import("tls").TLSSocket) => void)[];
    listeners(event: "clientError"): ((err: Error, socket: Socket) => void)[];
    listeners(
      event: "upgrade" | "connect",
    ): ((req: import("http").IncomingMessage, socket: Socket, head: Buffer) => void)[];
    listeners(
      event: "request" | "checkContinue" | "checkExpectation",
    ): ((req: import("http").IncomingMessage, res: import("http").ServerResponse) => void)[];
    listeners(
      event: "dropRequest",
    ): ((req: import("http").IncomingMessage, socket: Socket) => void)[];
  }
  /* The 'drop' payload: the turned-away connection's addresses. */
  export interface DropArgument {
    localAddress?: string;
    localPort?: number;
    localFamily?: string;
    remoteAddress?: string;
    remotePort?: number;
    remoteFamily?: string;
  }
  export type AddressInfo = import("node:dgram").AddressInfo;
  export type IPVersion = "ipv4" | "ipv6";
  export interface SocketAddressInitOptions {
    address?: string;
    family?: IPVersion;
    flowlabel?: number;
    port?: number;
  }
  /* A native handle (scr_net.c); the getters read its parsed address. */
  export class SocketAddress {
    constructor(options?: SocketAddressInitOptions);
    readonly address: string;
    readonly family: IPVersion;
    readonly port: number;
    readonly flowlabel: number;
    toJSON(): { address: string; port: number; family: IPVersion; flowlabel: number };
    /* undefined when the input is not "<ip>[:<port>]" */
    static parse(input: string): SocketAddress | undefined;
    static isSocketAddress(value: unknown): value is SocketAddress;
  }
  /* Address, range and subnet rules; check() matches IPv4 addresses
   * against IPv6 rules through their IPv4-mapped form, as Node does. */
  export class BlockList {
    constructor();
    readonly rules: readonly string[];
    readonly size: number;
    addAddress(address: string | SocketAddress, type?: IPVersion): void;
    addAddresses(addresses: readonly (string | SocketAddress)[], type?: IPVersion): void;
    addRange(start: string | SocketAddress, end: string | SocketAddress, type?: IPVersion): void;
    addSubnet(net: string | SocketAddress, prefix: number, type?: IPVersion): void;
    addCIDR(cidr: string): void;
    addCIDRs(cidrs: readonly string[]): void;
    removeAddress(address: string | SocketAddress, type?: IPVersion): void;
    removeRange(start: string | SocketAddress, end: string | SocketAddress, type?: IPVersion): void;
    removeSubnet(net: string | SocketAddress, prefix: number, type?: IPVersion): void;
    removeCIDR(cidr: string): void;
    clear(): void;
    check(address: string | SocketAddress, type?: IPVersion): boolean;
    toJSON(): string[];
    fromJSON(data: string | readonly string[]): void;
    static isBlockList(value: unknown): value is BlockList;
    static readonly PRIVATE_RANGES: readonly string[];
  }
  /* The options a BoundSocket binds with: the TCP form takes port, host,
   * ipv6Only and reusePort; path names a Unix socket (a leading '\0' is
   * the Linux abstract namespace) and is mutually exclusive with them. */
  export interface BoundSocketInitOptions {
    port?: number | string;
    /* A numeric IP address: net.BoundSocket does not resolve names. */
    host?: string | null;
    ipv6Only?: boolean;
    reusePort?: boolean;
    path?: string;
  }
  /* A socket bound at construction, adoptable by exactly one Server. The
   * handle owns its descriptor until adoption; after it, or after close(),
   * address(), fd() and close() throw ERR_SOCKET_HANDLE_ADOPTED, while
   * [Symbol.dispose]() stays a no-op. */
  export class BoundSocket {
    constructor(options?: BoundSocketInitOptions);
    /* The bound AddressInfo, or the path string for a Unix socket. */
    address(): import("node:dgram").AddressInfo | string;
    fd(): number;
    close(): void;
    readonly isPipe: boolean;
    [Symbol.dispose](): void;
  }
  /* Node's IPv4Reg and IPv6Reg tests: 4, 6, or 0 for isIP. */
  export function isIP(input: string): number;
  export function isIPv4(input: string): boolean;
  export function isIPv6(input: string): boolean;
  /* The Socket VALUE — the `x instanceof net.Socket` narrowing target
   * (the h2 compat 'connect' listener's test). Constructing bare sockets
   * has no lowering; the construct signature exists for instanceof. */
  export const Socket: abstract new () => Socket;
  export function createServer(connectionListener?: (socket: Socket) => void): Server;
  export function connect(port: number, host?: string, connectListener?: () => void): Socket;
  export function createConnection(
    port: number,
    host?: string,
    connectListener?: () => void,
  ): Socket;
  /* The caller-resolver dial (@types/node's net.LookupFunction): the
   * runtime invokes it as Node's autoSelectFamily dial does (options
   * { hints, all: true }, so the callback answers an address list) and
   * dials the answered addresses in order. */
  export type LookupFunction = (
    hostname: string,
    options: import("node:dns").LookupOptions,
    callback: (
      err: NodeJS.ErrnoException | null,
      address: string | import("node:dns").LookupAddress[],
      family?: number,
    ) => void,
  ) => void;
  export function connect(
    options: {
      port: number;
      host?: string;
      autoSelectFamily?: boolean;
      autoSelectFamilyAttemptTimeout?: number;
      lookup?: LookupFunction;
    },
    connectListener?: () => void,
  ): Socket;
  export function createConnection(
    options: {
      port: number;
      host?: string;
      autoSelectFamily?: boolean;
      autoSelectFamilyAttemptTimeout?: number;
      lookup?: LookupFunction;
    },
    connectListener?: () => void,
  ): Socket;
  /* A Unix domain socket client (Node's IpcNetConnectOpts and path
   * overloads). */
  export function connect(path: string, connectListener?: () => void): Socket;
  export function connect(options: { path: string }, connectListener?: () => void): Socket;
  export function createConnection(path: string, connectListener?: () => void): Socket;
  export function createConnection(options: { path: string }, connectListener?: () => void): Socket;
  /* The happy-eyeballs attempt budget (Node's process-wide knob; the
   * autoSelectFamily dial consults it): one runtime int, default 250ms
   * like Node's. */
  export function getDefaultAutoSelectFamilyAttemptTimeout(): number;
  export function setDefaultAutoSelectFamilyAttemptTimeout(value: number): void;
  /* The process-wide autoSelectFamily switch (true by default), which a
   * connect defaulting to it consults. */
  export function getDefaultAutoSelectFamily(): boolean;
  export function setDefaultAutoSelectFamily(value: boolean): void;
}

declare module "node:net" {
  export * from "net";
}
