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
 * backpressure boolean; end returns void here (Node returns the socket);
 * on/once return void (chaining is fenced). connect's host is a numeric IP or "localhost" (pinned to
 * 127.0.0.1 — SEMANTICS.md); every failure is the async 'error' event,
 * and an 'error' with no listener exits 1 like an unhandled EventEmitter
 * 'error'. */
declare module "net" {
  export interface Socket {
    /* Whether the socket keeps the event loop alive (ref'd by default). */
    ref(): void;
    unref(): void;
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
    /* write's callback runs once the data is flushed, with null; end's
     * once the socket finishes. */
    /* false when the bytes this write left unsent reach the 65536-byte
     * high-water mark, as in Node; 'drain' fires when they are all sent. */
    write(data: string | Uint8Array, callback?: (err?: Error | null) => void): boolean;
    /* the bytes written and not yet sent */
    readonly writableLength: number;
    /* a write answered false and 'drain' has not fired yet */
    readonly writableNeedDrain: boolean;
    end(callback?: () => void): void;
    end(data: string | Uint8Array, callback?: () => void): void;
    destroy(): void;
    /* Flow control: pause holds reads off (kernel/TCP backpressure is
     * the buffer); resume flows — and discards without listeners, so
     * 'end' stays reachable. Both chain, Node's shape. */
    pause(): Socket;
    resume(): Socket;
    /* TCP_NODELAY on the live fd; missing means true. Chains. */
    setNoDelay(noDelay?: boolean): Socket;
    /* SO_KEEPALIVE with the initial delay in ms. Chains. */
    setKeepAlive(enable?: boolean, initialDelay?: number): Socket;
    /* end() now, destroy once the FIN actually flushed. */
    destroySoon(): void;
    /* An RST instead of a FIN; a connecting socket resets once it
     * connects. Throws ERR_INVALID_HANDLE_TYPE on a TLS socket. */
    resetAndDestroy(): Socket;
    /* The local address, or {} while connecting and once destroyed. */
    address(): AddressInfo | {};
    /* setEncoding('utf8'): 'data' delivers strings — the IncomingMessage
     * twin's contract. */
    setEncoding(encoding: string): void;
    /* socket→socket, and socket→response (the extended-CONNECT bridge
     * leg: raw chunks become response body writes; EOF ends it). */
    pipe(
      destination: Socket | import("http").ServerResponse | import("http2").Http2ServerResponse,
    ): void;
    /* The callback is a once('timeout') listener (removed again by 0). */
    setTimeout(ms: number, callback?: () => void): void;
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
  }
  export interface Server {
    /* Whether the server keeps the event loop alive (ref'd by default). */
    ref(): void;
    unref(): void;
    readonly listening: boolean;
    /* Connections past this many are closed with a 'drop' event;
     * undefined (the default) or null lifts the cap. */
    maxConnections: number | undefined;
    /* Node reads it only in cluster mode: a stored value here. */
    dropMaxConnection: boolean | undefined;
    /* cb(null, count) on the next tick. */
    getConnections(callback: (error: Error | null, count: number) => void): Server;
    /* Node answers the server itself (`return this` chaining). */
    listen(port: number, callback?: () => void): Server;
    /* The positional bind address (the options form's host in argument
     * spelling). */
    listen(port: number, host: string, callback?: () => void): Server;
    /* A Unix-socket server; the socket file is removed when it closes. */
    listen(path: string, callback?: () => void): Server;
    /* The explicit-interface bind: host is an IP literal (absent = the
     * host-less dual-stack any); ipv6Only sets IPV6_V6ONLY and reusePort
     * requests kernel connection distribution where Node supports it. */
    listen(
      options: { port: number; host?: string; ipv6Only?: boolean; reusePort?: boolean },
      callback?: () => void,
    ): Server;
    close(callback?: () => void): void;
    /* The bound AddressInfo (Node answers null before listen — this
     * surface answers the record with port 0 there, the serverPort
     * stance). */
    address(): import("node:dgram").AddressInfo;
    /* The demux route: hand an accepted socket to another server. */
    emit(event: "connection", socket: Socket): boolean;
    on(event: "connection" | "secureConnection", listener: (socket: Socket) => void): void;
    /* tls and https servers: a handshake that failed */
    on(
      event: "tlsClientError",
      listener: (err: Error, tlsSocket: import("tls").TLSSocket) => void,
    ): void;
    on(event: "close" | "listening", listener: () => void): void;
    on(event: "drop", listener: (data?: DropArgument) => void): void;
    on(event: "timeout", listener: (socket: Socket) => void): void;
    on(event: "error", listener: (err: Error) => void): void;
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
    addListener(
      event: "upgrade" | "connect",
      listener: (req: import("http").IncomingMessage, socket: Socket, head: Buffer) => void,
    ): void;
    addListener(
      event: "request" | "checkContinue" | "checkExpectation",
      listener: (req: import("http").IncomingMessage, res: import("http").ServerResponse) => void,
    ): void;
    once(event: "connection" | "secureConnection", listener: (socket: Socket) => void): void;
    /* tls and https servers: a handshake that failed */
    once(
      event: "tlsClientError",
      listener: (err: Error, tlsSocket: import("tls").TLSSocket) => void,
    ): void;
    once(event: "close" | "listening", listener: () => void): void;
    once(event: "drop", listener: (data?: DropArgument) => void): void;
    once(event: "timeout", listener: (socket: Socket) => void): void;
    once(event: "error", listener: (err: Error) => void): void;
    once(
      event: "upgrade" | "connect",
      listener: (req: import("http").IncomingMessage, socket: Socket, head: Buffer) => void,
    ): void;
    once(
      event: "request" | "checkContinue" | "checkExpectation",
      listener: (req: import("http").IncomingMessage, res: import("http").ServerResponse) => void,
    ): void;
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
      lookup?: LookupFunction;
    },
    connectListener?: () => void,
  ): Socket;
  export function createConnection(
    options: {
      port: number;
      host?: string;
      autoSelectFamily?: boolean;
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
}

declare module "node:net" {
  export * from "net";
}
