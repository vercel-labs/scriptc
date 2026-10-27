// scriptc's built-in implementation of the `hot-shots` package, 8.x API:
// a typed port of hot-shots 8.5's StatsD client with the same datagrams,
// callbacks, error messages and child-client sharing, over node:dgram
// (udp), node:net (tcp) and a native Unix datagram socket (uds). The
// entry modules (v8.ts, v8-unix-dgram.ts) say whether the optional
// unix-dgram addon that hot-shots' uds protocol loads is installed.
import * as dgram from "node:dgram";
import * as dns from "node:dns";
import * as net from "node:net";
import * as os from "node:os";

export type Tags = { [key: string]: string } | string[];

export interface ClientOptions {
  bufferFlushInterval?: number;
  bufferHolder?: { buffer: string };
  cacheDns?: boolean;
  cacheDnsTtl?: number;
  errorHandler?: (err: Error) => void;
  globalTags?: Tags;
  globalize?: boolean;
  host?: string;
  isChild?: boolean;
  maxBufferSize?: number;
  mock?: boolean;
  path?: string;
  port?: number;
  prefix?: string;
  protocol?: "tcp" | "udp" | "uds";
  sampleRate?: number;
  suffix?: string;
  telegraf?: boolean;
  useDefaultRoute?: boolean;
  tagPrefix?: string;
  tagSeparator?: string;
  udsGracefulErrorHandling?: boolean;
  udsGracefulRestartRateLimit?: number;
  closingFlushInterval?: number;
}

export interface ChildClientOptions {
  globalTags?: Tags;
  prefix?: string;
  suffix?: string;
  errorHandler?: (err: Error) => void;
}

export interface CheckOptions {
  /** A Unix timestamp; hot-shots also takes a Date, which this shim's
   * option records cannot hold yet. */
  date_happened?: number;
  hostname?: string;
  message?: string;
}

export interface DatadogChecks {
  OK: 0;
  WARNING: 1;
  CRITICAL: 2;
  UNKNOWN: 3;
}

export type DatadogChecksValues = 0 | 1 | 2 | 3;

export interface EventOptions {
  aggregation_key?: string;
  alert_type?: "info" | "warning" | "success" | "error";
  /** A Unix timestamp; hot-shots also takes a Date, which this shim's
   * option records cannot hold yet. */
  date_happened?: number;
  hostname?: string;
  priority?: "low" | "normal";
  source_type_name?: string;
}

/** A send's completion: hot-shots passes `null` on success. */
export type StatsCb = (error: Error | null | undefined, bytes?: any) => void;

type SampleArg = number | Tags | StatsCb | undefined;
type TagsArg = Tags | StatsCb | undefined;

const PROTOCOL_TCP = "tcp";
const PROTOCOL_UDS = "uds";
const PROTOCOL_UDP = "udp";
const UDS_DEFAULT_GRACEFUL_RESTART_LIMIT = 1000;
const CACHE_DNS_TTL_DEFAULT = 60000;

function udsErrorCodes(): number[] {
  if (process.platform === "linux") {
    return [os.constants.errno.ENOTCONN, os.constants.errno.ECONNREFUSED];
  }
  if (process.platform === "darwin") {
    return [os.constants.errno.EDESTADDRREQ, os.constants.errno.ECONNRESET];
  }
  return [];
}
const UDS_ERROR_CODES = udsErrorCodes();

// ── helpers ──────────────────────────────────────────────────────────────

function sanitizeTags(value: string, telegraf: boolean): string {
  const blacklist = telegraf ? /:|\||,/g : /:|\||@|,/g;
  return String(value).replace(blacklist, "_");
}

function formatTags(tags: Tags, telegraf: boolean): string[] {
  if (Array.isArray(tags)) return tags;
  const out: string[] = [];
  for (const key of Object.keys(tags)) {
    out.push(`${sanitizeTags(key, telegraf)}:${sanitizeTags(tags[key]!, telegraf)}`);
  }
  return out;
}

function isArrayIndexKey(key: string): boolean {
  return /^(0|[1-9]\d*)$/.test(key) && Number(key) < 4294967295;
}

function overrideTags(parent: string[], child: Tags, telegraf: boolean): string[] {
  const childKeys: string[] = [];
  const childValues = new Map<string, string[]>();
  const toAppend: string[] = [];
  for (const tag of formatTags(child, telegraf)) {
    const idx = tag.indexOf(":");
    if (idx < 1) {
      toAppend.push(tag);
    } else {
      const key = tag.substring(0, idx);
      const value = tag.substring(idx + 1);
      let values = childValues.get(key);
      if (values === undefined) {
        values = [];
        childValues.set(key, values);
        childKeys.push(key);
      }
      values.push(value);
    }
  }
  const result = parent.filter((tag) => {
    const idx = tag.indexOf(":");
    if (idx < 1) return true;
    return !childValues.has(tag.substring(0, idx));
  });
  // hot-shots walks an object's keys: array-index keys ascending first,
  // then the rest in insertion order.
  const indexKeys = childKeys.filter(isArrayIndexKey).sort((a, b) => Number(a) - Number(b));
  const ordered = indexKeys.concat(childKeys.filter((key) => !isArrayIndexKey(key)));
  for (const key of ordered) {
    for (const value of childValues.get(key)!) result.push(`${key}:${value}`);
  }
  return result.concat(toAppend);
}

function formatDate(date: number): number {
  return Math.round(date);
}

/** console.error of an arbitrary value, as hot-shots logs errors. The
 * value crosses as unknown: the typed Error path has no inspect lowering
 * in programs whose Error subclasses define accessors. */
function logError(value: unknown): void {
  console.error(value);
}

function errorWithCode(message: string, code: string | undefined): Error {
  const error: NodeJS.ErrnoException = new Error(message);
  error.code = code;
  return error;
}

// ── transports ───────────────────────────────────────────────────────────

type SendCallback = (err: Error | null, bytes?: number) => void;

/** The socket a client sends through (hot-shots' transport interface). */
interface Transport {
  createdAt: number;
  send(buf: Buffer, callback: SendCallback): void;
  close(): void;
  onError(listener: (err: Error) => void): void;
  offError(listener: (err: Error) => void): void;
  /** Emits 'error' on the socket, as hot-shots' `socket.emit('error')`. */
  emitError(err: Error): void;
  onClose(listener: () => void): void;
}

/** A socket's 'error' listeners, kept by the transport (the typed
 * sockets have no removeListener): one socket listener dispatches to a
 * snapshot, and an error nobody listens for throws, as an unhandled
 * 'error' event does. */
class ErrorListeners {
  private listeners: ((err: Error) => void)[] = [];
  add(listener: (err: Error) => void): void {
    this.listeners.push(listener);
  }
  remove(listener: (err: Error) => void): void {
    const index = this.listeners.indexOf(listener);
    if (index !== -1) this.listeners.splice(index, 1);
  }
  emit(err: Error): void {
    const snapshot = this.listeners.slice();
    if (snapshot.length === 0) throw err;
    for (const listener of snapshot) listener(err);
  }
}

function addEol(buf: Buffer): string {
  let msg = buf.toString();
  if (msg.length > 0 && msg[msg.length - 1] !== "\n") msg += "\n";
  return msg;
}

class UdpTransport implements Transport {
  createdAt = 0;
  private readonly socket: dgram.Socket;
  private readonly errors = new ErrorListeners();
  private resolvedAddress: string | undefined = undefined;
  private resolvedAt = 0;
  private readonly host: string | undefined;
  private readonly port: number;
  private readonly cacheDns: boolean;
  private readonly cacheDnsTtl: number;
  constructor(host: string | undefined, port: number, cacheDns: boolean, cacheDnsTtl: number) {
    this.host = host;
    this.port = port;
    this.cacheDns = cacheDns;
    this.cacheDnsTtl = cacheDnsTtl;
    this.socket = dgram.createSocket("udp4");
    this.socket.unref();
    // The listener captures the list, not the transport: a socket that is
    // never closed keeps its listener, and a capture of `this` would make
    // a cycle the reference counts cannot free at exit.
    const errors = this.errors;
    this.socket.on("error", (err) => errors.emit(err));
  }
  send(buf: Buffer, callback: SendCallback): void {
    if (!this.cacheDns) {
      this.socket.send(buf, this.port, this.host || "127.0.0.1", callback);
      return;
    }
    const now = Date.now();
    const cached = this.resolvedAddress;
    if (cached === undefined || now - this.resolvedAt > this.cacheDnsTtl) {
      dns.lookup(this.host ?? "localhost", (error, address) => {
        if (error) {
          callback(error);
          return;
        }
        this.resolvedAddress = address;
        this.resolvedAt = now;
        this.socket.send(buf, this.port, address, callback);
      });
    } else {
      this.socket.send(buf, this.port, cached, callback);
    }
  }
  close(): void {
    this.socket.close();
  }
  onError(listener: (err: Error) => void): void {
    this.errors.add(listener);
  }
  offError(listener: (err: Error) => void): void {
    this.errors.remove(listener);
  }
  emitError(err: Error): void {
    this.errors.emit(err);
  }
  onClose(listener: () => void): void {
    this.socket.on("close", listener);
  }
}

class TcpTransport implements Transport {
  createdAt = 0;
  private readonly socket: net.Socket;
  private readonly errors = new ErrorListeners();
  constructor(host: string | undefined, port: number) {
    this.socket = net.connect(port, host ?? "localhost");
    this.socket.setKeepAlive(true);
    this.socket.unref();
    // The listener captures the list, not the transport: a socket that is
    // never closed keeps its listener, and a capture of `this` would make
    // a cycle the reference counts cannot free at exit.
    const errors = this.errors;
    this.socket.on("error", (err) => errors.emit(err));
  }
  send(buf: Buffer, callback: SendCallback): void {
    // hot-shots writes the line with the 'ascii' encoding, which encodes
    // strings as 'latin1' does. The callback runs once the data is written,
    // so a message held back by a full socket buffer stays in flight.
    this.socket.write(Buffer.from(addEol(buf), "latin1"), (err) => callback(err ?? null));
  }
  close(): void {
    this.socket.destroy();
  }
  onError(listener: (err: Error) => void): void {
    this.errors.add(listener);
  }
  offError(listener: (err: Error) => void): void {
    this.errors.remove(listener);
  }
  emitError(err: Error): void {
    this.errors.emit(err);
  }
  onClose(listener: () => void): void {
    this.socket.on("close", () => listener());
  }
}

// The runtime's AF_UNIX datagram calls (the unix-dgram addon's binding):
// results >= 0, or a negative errno; send answers 1 when it would block.
declare function scriptcUnixDgramSocket(): number;
declare function scriptcUnixDgramConnect(fd: number, path: string): number;
declare function scriptcUnixDgramSend(fd: number, data: Buffer): number;
declare function scriptcUnixDgramClose(fd: number): number;

let unixDgramInstalled = false;

/** Whether the unix-dgram addon is installed beside hot-shots (set by the
 * entry module). */
export function configureUnixDgram(installed: boolean): void {
  unixDgramInstalled = installed;
}

const UDS_PATH_DEFAULT = "/var/run/datadog/dsd.socket";

/** unix-dgram's errnoException: "<syscall> <errno>" (the code is the
 * negative errno; this Error's code field holds its decimal string). */
function errnoException(errorno: number, syscall: string): Error {
  const error: NodeJS.ErrnoException = new Error(`${syscall} ${errorno}`);
  error.errno = errorno;
  error.code = String(errorno);
  error.syscall = syscall;
  return error;
}

/** hot-shots' uds transport over unix-dgram: a connected, non-blocking
 * AF_UNIX datagram socket. Sends complete synchronously, as the addon's
 * do. The addon polls the socket for reads, which holds the event loop
 * until close; a ref'd timer stands in for that poll. */
class UdsTransport implements Transport {
  createdAt = 0;
  private fd: number;
  private readonly errors = new ErrorListeners();
  private readonly closeListeners: (() => void)[] = [];
  private readonly stopHold: () => void;
  constructor(path: string) {
    const fd = scriptcUnixDgramSocket();
    if (fd < 0) throw errnoException(fd, "socket");
    this.fd = fd;
    const hold = setInterval(() => {}, 2147483647);
    this.stopHold = () => clearInterval(hold);
    const err = scriptcUnixDgramConnect(fd, path);
    if (err < 0) {
      // The addon emits the connect failure as 'error' before anyone
      // listens, which throws; hot-shots closes the socket and rethrows.
      this.close();
      throw errnoException(err, "connect");
    }
  }
  send(buf: Buffer, callback: SendCallback): void {
    const result = scriptcUnixDgramSend(this.fd, buf);
    if (result < 0) {
      callback(errnoException(result, "send"));
    } else if (result === 1) {
      const congestion: NodeJS.ErrnoException = new Error("congestion");
      congestion.code = "1";
      callback(congestion);
    } else {
      callback(null);
    }
  }
  close(): void {
    const result = scriptcUnixDgramClose(this.fd);
    if (result < 0) throw errnoException(result, "close");
    this.fd = -1;
    this.stopHold();
    for (const listener of this.closeListeners.slice()) listener();
  }
  onError(listener: (err: Error) => void): void {
    this.errors.add(listener);
  }
  offError(listener: (err: Error) => void): void {
    this.errors.remove(listener);
  }
  emitError(err: Error): void {
    this.errors.emit(err);
  }
  onClose(listener: () => void): void {
    this.closeListeners.push(listener);
  }
}

/** hot-shots' createUdsTransport: without the unix-dgram addon the
 * protocol reports it missing. */
function createUdsTransport(path: string | undefined): Transport {
  if (!unixDgramInstalled) {
    throw new Error(
      "The library `unix_dgram`, needed for the uds protocol to work, is not installed. " +
        "You need to pick another protocol to use hot-shots. " +
        "See the hot-shots README for additional details.",
    );
  }
  return new UdsTransport(path ? path : UDS_PATH_DEFAULT);
}

function createTransport(client: StatsD): Transport | null {
  let transport: Transport | null = null;
  const protocol = client.protocol;
  try {
    if (protocol === PROTOCOL_TCP) {
      transport = new TcpTransport(client.host, client.port);
    } else if (protocol === PROTOCOL_UDS) {
      transport = createUdsTransport(client.path);
    } else if (protocol === PROTOCOL_UDP) {
      transport = new UdpTransport(client.host, client.port, client.cacheDns, client.cacheDnsTtl);
    } else {
      throw new Error(`Unsupported protocol '${protocol}'`);
    }
    transport.createdAt = Date.now();
  } catch (e) {
    const handler = client.errorHandler;
    if (handler) {
      handler(e as Error);
    } else {
      console.error(e);
    }
  }
  return transport;
}

// ── the client ───────────────────────────────────────────────────────────

class BufferHolder {
  buffer = "";
}

/** What a child client inherits from its parent. */
class ChildInit {
  socket: Transport | null;
  bufferHolder: BufferHolder;
  dnsError: Error | undefined;
  constructor(socket: Transport | null, bufferHolder: BufferHolder, dnsError: Error | undefined) {
    this.socket = socket;
    this.bufferHolder = bufferHolder;
    this.dnsError = dnsError;
  }
}

export class StatsD {
  protocol: string;
  cacheDns: boolean;
  cacheDnsTtl: number;
  host: string | undefined;
  port: number;
  path: string | undefined;
  prefix: string;
  suffix: string;
  tagPrefix: string;
  tagSeparator: string;
  mock: boolean;
  globalTags: string[];
  telegraf: boolean;
  maxBufferSize: number;
  sampleRate: number;
  bufferFlushInterval: number;
  errorHandler: ((err: Error) => void) | undefined;
  udsGracefulErrorHandling: boolean;
  udsGracefulRestartRateLimit: number;
  isChild: boolean;
  closingFlushInterval: number;
  mockBuffer: string[] | undefined = undefined;
  messagesInFlight = 0;
  CHECKS: DatadogChecks = { OK: 0, WARNING: 1, CRITICAL: 2, UNKNOWN: 3 };
  private bufferHolder: BufferHolder;
  private transport: Transport | null = null;
  private dnsError: Error | undefined = undefined;
  private stopFlushInterval: (() => void) | undefined = undefined;

  constructor(options?: ClientOptions, child?: ChildInit) {
    const o: ClientOptions = options ?? {};
    const protocol = o.protocol ? o.protocol.toLowerCase() : "";
    this.protocol = protocol ? protocol : PROTOCOL_UDP;
    this.cacheDns = o.cacheDns === true;
    this.cacheDnsTtl = o.cacheDnsTtl || CACHE_DNS_TTL_DEFAULT;
    this.host = o.host || process.env["DD_AGENT_HOST"];
    this.port = o.port || parseInt(process.env["DD_DOGSTATSD_PORT"] ?? "", 10) || 8125;
    this.path = o.path;
    this.prefix = o.prefix || "";
    this.suffix = o.suffix || "";
    this.tagPrefix = o.tagPrefix || "#";
    this.tagSeparator = o.tagSeparator || ",";
    this.mock = o.mock === true;
    this.telegraf = o.telegraf || false;
    const globalTags = o.globalTags;
    this.globalTags = globalTags !== undefined ? formatTags(globalTags, this.telegraf) : [];
    const entityId = process.env["DD_ENTITY_ID"];
    if (entityId) {
      this.globalTags = this.globalTags.filter(
        (item) => item.indexOf("dd.internal.entity_id:") !== 0,
      );
      this.globalTags.push("dd.internal.entity_id:".concat(sanitizeTags(entityId, false)));
    }
    this.maxBufferSize = o.maxBufferSize || 0;
    this.sampleRate = o.sampleRate || 1;
    this.bufferFlushInterval = o.bufferFlushInterval || 1000;
    this.bufferHolder = child !== undefined ? child.bufferHolder : new BufferHolder();
    this.errorHandler = o.errorHandler;
    const graceful = o.udsGracefulErrorHandling;
    this.udsGracefulErrorHandling = graceful === undefined ? true : graceful;
    this.udsGracefulRestartRateLimit =
      o.udsGracefulRestartRateLimit || UDS_DEFAULT_GRACEFUL_RESTART_LIMIT;
    this.isChild = child !== undefined;
    this.closingFlushInterval = o.closingFlushInterval || 50;
    if (this.mock) this.mockBuffer = [];
    if (child === undefined && this.maxBufferSize > 0) {
      const handle = setInterval(() => this.onBufferFlushInterval(), this.bufferFlushInterval);
      handle.unref();
      this.stopFlushInterval = () => clearInterval(handle);
    }
    if (child !== undefined) {
      if (child.dnsError) this.dnsError = child.dnsError;
      this.transport = child.socket;
    }
    if (!this.transport) this.transport = createTransport(this);
    const handler = o.errorHandler;
    const transport = this.transport;
    if (transport !== null && child === undefined && handler) transport.onError(handler);
    if (transport !== null && o.protocol === PROTOCOL_UDS) this.maybeAddUDSErrorHandler();
  }

  private maybeAddUDSErrorHandler(): void {
    if (this.isChild || !this.udsGracefulErrorHandling) return;
    const transport = this.transport;
    if (transport !== null) transport.onError((err) => this.udsErrorHandler(err));
  }

  private udsErrorHandler(err: Error): void {
    const code = Number((err as NodeJS.ErrnoException).code);
    if (!UDS_ERROR_CODES.includes(-code)) return;
    const socket = this.transport;
    if (socket === null) return;
    if (!socket.createdAt || Date.now() - socket.createdAt < this.udsGracefulRestartRateLimit) {
      return;
    }
    const handler = this.errorHandler;
    if (handler) socket.offError(handler);
    const newSocket = createTransport(this);
    if (newSocket === null) {
      const errorMessage = "Could not replace UDS connection with new socket";
      if (handler) {
        handler(new Error(errorMessage));
      } else {
        console.error(errorMessage);
      }
      return;
    }
    socket.close();
    this.transport = newSocket;
    this.maybeAddUDSErrorHandler();
    if (handler) {
      newSocket.onError(handler);
    } else {
      newSocket.onError((error) => console.error(`hot-shots UDS error: ${String(error)}`));
    }
  }

  // ── stats functions ──

  timing(
    stat: string | string[],
    time: number,
    sampleRate?: number,
    tags?: Tags,
    callback?: StatsCb,
  ): void;
  timing(stat: string | string[], time: number, tags?: Tags, callback?: StatsCb): void;
  timing(stat: string | string[], time: number, callback?: StatsCb): void;
  timing(stat: string | string[], time: number, sampleRate?: number, callback?: StatsCb): void;
  timing(
    stat: string | string[],
    time: number,
    sampleRate?: SampleArg,
    tags?: TagsArg,
    callback?: StatsCb,
  ): void {
    this.sendAll(stat, time, "ms", sampleRate, tags, callback);
  }

  increment(stat: string, tags?: Tags): void;
  increment(
    stat: string | string[],
    value: number,
    sampleRate?: number,
    tags?: Tags,
    callback?: StatsCb,
  ): void;
  increment(stat: string | string[], value: number, tags?: Tags, callback?: StatsCb): void;
  increment(stat: string | string[], value: number, callback?: StatsCb): void;
  increment(stat: string | string[], value: number, sampleRate?: number, callback?: StatsCb): void;
  increment(
    stat: string | string[],
    value?: number | Tags,
    sampleRate?: SampleArg,
    tags?: TagsArg,
    callback?: StatsCb,
  ): void {
    // A non-number second argument of a two-argument call is the tags.
    let amount = 1;
    let tagArg: TagsArg = tags;
    if (typeof value === "number") {
      amount = value;
    } else if (sampleRate === undefined && tags === undefined && callback === undefined) {
      tagArg = value;
    }
    this.sendAll(stat, amount, "c", sampleRate, tagArg, callback);
  }

  decrement(stat: string, tags?: Tags): void;
  decrement(
    stat: string | string[],
    value: number,
    sampleRate?: number,
    tags?: Tags,
    callback?: StatsCb,
  ): void;
  decrement(stat: string | string[], value: number, tags?: Tags, callback?: StatsCb): void;
  decrement(stat: string | string[], value: number, callback?: StatsCb): void;
  decrement(stat: string | string[], value: number, sampleRate?: number, callback?: StatsCb): void;
  decrement(
    stat: string | string[],
    value?: number | Tags,
    sampleRate?: SampleArg,
    tags?: TagsArg,
    callback?: StatsCb,
  ): void {
    let amount = 1;
    let tagArg: TagsArg = tags;
    if (typeof value === "number") {
      amount = value;
    } else if (sampleRate === undefined && tags === undefined && callback === undefined) {
      tagArg = value;
    }
    this.sendAll(stat, -amount, "c", sampleRate, tagArg, callback);
  }

  histogram(
    stat: string | string[],
    value: number,
    sampleRate?: number,
    tags?: Tags,
    callback?: StatsCb,
  ): void;
  histogram(stat: string | string[], value: number, tags?: Tags, callback?: StatsCb): void;
  histogram(stat: string | string[], value: number, callback?: StatsCb): void;
  histogram(stat: string | string[], value: number, sampleRate?: number, callback?: StatsCb): void;
  histogram(
    stat: string | string[],
    value: number,
    sampleRate?: SampleArg,
    tags?: TagsArg,
    callback?: StatsCb,
  ): void {
    this.sendAll(stat, value, "h", sampleRate, tags, callback);
  }

  distribution(
    stat: string | string[],
    value: number,
    sampleRate?: number,
    tags?: Tags,
    callback?: StatsCb,
  ): void;
  distribution(stat: string | string[], value: number, tags?: Tags, callback?: StatsCb): void;
  distribution(stat: string | string[], value: number, callback?: StatsCb): void;
  distribution(
    stat: string | string[],
    value: number,
    sampleRate?: number,
    callback?: StatsCb,
  ): void;
  distribution(
    stat: string | string[],
    value: number,
    sampleRate?: SampleArg,
    tags?: TagsArg,
    callback?: StatsCb,
  ): void {
    this.sendAll(stat, value, "d", sampleRate, tags, callback);
  }

  gauge(
    stat: string | string[],
    value: number,
    sampleRate?: number,
    tags?: Tags,
    callback?: StatsCb,
  ): void;
  gauge(stat: string | string[], value: number, tags?: Tags, callback?: StatsCb): void;
  gauge(stat: string | string[], value: number, callback?: StatsCb): void;
  gauge(stat: string | string[], value: number, sampleRate?: number, callback?: StatsCb): void;
  gauge(
    stat: string | string[],
    value: number,
    sampleRate?: SampleArg,
    tags?: TagsArg,
    callback?: StatsCb,
  ): void {
    this.sendAll(stat, value, "g", sampleRate, tags, callback);
  }

  set(
    stat: string | string[],
    value: number | string,
    sampleRate?: number,
    tags?: Tags,
    callback?: StatsCb,
  ): void;
  set(stat: string | string[], value: number | string, tags?: Tags, callback?: StatsCb): void;
  set(stat: string | string[], value: number | string, callback?: StatsCb): void;
  set(
    stat: string | string[],
    value: number | string,
    sampleRate?: number,
    callback?: StatsCb,
  ): void;
  set(
    stat: string | string[],
    value: number | string,
    sampleRate?: SampleArg,
    tags?: TagsArg,
    callback?: StatsCb,
  ): void {
    this.sendAll(stat, value, "s", sampleRate, tags, callback);
  }

  unique(
    stat: string | string[],
    value: number | string,
    sampleRate?: number,
    tags?: Tags,
    callback?: StatsCb,
  ): void;
  unique(stat: string | string[], value: number | string, tags?: Tags, callback?: StatsCb): void;
  unique(stat: string | string[], value: number | string, callback?: StatsCb): void;
  unique(
    stat: string | string[],
    value: number | string,
    sampleRate?: number,
    callback?: StatsCb,
  ): void;
  unique(
    stat: string | string[],
    value: number | string,
    sampleRate?: SampleArg,
    tags?: TagsArg,
    callback?: StatsCb,
  ): void {
    this.sendAll(stat, value, "s", sampleRate, tags, callback);
  }

  check(
    name: string,
    status: DatadogChecksValues,
    options?: CheckOptions,
    tags?: Tags | StatsCb,
    callback?: StatsCb,
  ): void {
    if (this.telegraf) {
      const err = new Error("Not supported by Telegraf / InfluxDB");
      if (callback) return callback(err);
      const handler = this.errorHandler;
      if (handler) return handler(err);
      throw err;
    }
    const check: string[] = ["_sc", this.prefix + name + this.suffix, String(status)];
    const metadata: CheckOptions = options ?? {};
    const happened = metadata.date_happened;
    if (happened) {
      const timestamp = formatDate(happened);
      if (timestamp) check.push(`d:${timestamp}`);
    }
    if (metadata.hostname) check.push(`h:${metadata.hostname}`);
    let mergedTags = this.globalTags;
    if (tags !== undefined && typeof tags !== "function") {
      mergedTags = overrideTags(mergedTags, tags, this.telegraf);
    }
    if (mergedTags.length > 0) check.push(`#${mergedTags.join(",")}`);
    if (metadata.message) check.push(`m:${metadata.message}`);
    let cb = callback;
    if (typeof tags === "function" && callback === undefined) cb = tags;
    this.sendRaw(check.join("|"), cb);
  }

  event(
    title: string,
    text?: string,
    options?: EventOptions,
    tags?: Tags | StatsCb,
    callback?: StatsCb,
  ): void {
    if (this.telegraf) {
      const err = new Error("Not supported by Telegraf / InfluxDB");
      if (callback) return callback(err);
      const handler = this.errorHandler;
      if (handler) return handler(err);
      throw err;
    }
    const msgTitle = String(title ? title : "");
    let msgText = String(text ? text : msgTitle);
    msgText = msgText.replace(/\n/g, "\\n");
    let message = `_e{${msgTitle.length},${msgText.length}}:${msgTitle}|${msgText}`;
    if (options) {
      const happened = options.date_happened;
      if (happened) {
        const timestamp = formatDate(happened);
        if (timestamp) message += `|d:${timestamp}`;
      }
      if (options.hostname) message += `|h:${options.hostname}`;
      if (options.aggregation_key) message += `|k:${options.aggregation_key}`;
      if (options.priority) message += `|p:${options.priority}`;
      if (options.source_type_name) message += `|s:${options.source_type_name}`;
      if (options.alert_type) message += `|t:${options.alert_type}`;
    }
    let cb = callback;
    let tagList: Tags | undefined = undefined;
    if (typeof tags === "function") {
      if (callback === undefined) cb = tags;
    } else {
      tagList = tags;
    }
    this.send(message, tagList, cb);
  }

  // ── sending ──

  private sendAll(
    stat: string | string[],
    value: number | string,
    type: string,
    sampleRateArg: SampleArg,
    tagsArg: TagsArg,
    callbackArg: StatsCb | undefined,
  ): void {
    let sampleRate: number | undefined = undefined;
    let tags: Tags | undefined = undefined;
    let callback: StatsCb | undefined = callbackArg;
    if (typeof sampleRateArg === "number") {
      sampleRate = sampleRateArg;
      if (typeof tagsArg === "function") {
        callback = tagsArg;
      } else {
        tags = tagsArg;
      }
    } else if (sampleRateArg !== undefined) {
      // A non-number sample rate shifts into the tags, and the tags
      // argument into the callback.
      if (typeof sampleRateArg === "function") {
        callback = sampleRateArg;
      } else {
        tags = sampleRateArg;
        callback = typeof tagsArg === "function" ? tagsArg : undefined;
      }
    } else if (typeof tagsArg === "function") {
      callback = tagsArg;
    } else {
      tags = tagsArg;
    }

    if (!Array.isArray(stat)) {
      this.sendStat(stat, value, type, sampleRate, tags, callback);
      return;
    }
    let completed = 0;
    let calledback = false;
    let sentBytes = 0;
    const count = stat.length;
    const onSend: StatsCb = (error, bytes) => {
      completed += 1;
      if (calledback) return;
      if (error) {
        if (callback !== undefined) {
          calledback = true;
          callback(error);
        } else {
          const handler = this.errorHandler;
          if (handler) {
            calledback = true;
            handler(error);
          }
        }
        return;
      }
      if (bytes) sentBytes += bytes as number;
      if (completed === count && callback !== undefined) callback(null, sentBytes);
    };
    for (const item of stat) this.sendStat(item, value, type, sampleRate, tags, onSend);
  }

  private sendStat(
    stat: string,
    value: number | string,
    type: string,
    sampleRateArg: number | undefined,
    tags: Tags | undefined,
    callback: StatsCb | undefined,
  ): void {
    let message = `${this.prefix + stat + this.suffix}:${value}|${type}`;
    const sampleRate = sampleRateArg || this.sampleRate;
    if (sampleRate && sampleRate < 1) {
      if (Math.random() < sampleRate) {
        message += `|@${sampleRate}`;
      } else {
        if (callback) callback(undefined);
        return;
      }
    }
    this.send(message, tags, callback);
  }

  private send(message: string, tags: Tags | undefined, callback: StatsCb | undefined): void {
    let mergedTags = this.globalTags;
    if (tags !== undefined) mergedTags = overrideTags(mergedTags, tags, this.telegraf);
    if (mergedTags.length > 0) {
      if (this.telegraf) {
        const parts = message.split(":");
        message = `${parts[0]!},${mergedTags.join(",").replace(/:/g, "=")}:${parts.slice(1).join(":")}`;
      } else {
        message += `|${this.tagPrefix}${mergedTags.join(this.tagSeparator)}`;
      }
    }
    this.sendRaw(message, callback);
  }

  /** hot-shots' `_send`: the message with its tags. */
  private sendRaw(message: string, callback: StatsCb | undefined): void {
    const dnsError = this.dnsError;
    if (dnsError) {
      if (callback) return callback(dnsError);
      const handler = this.errorHandler;
      if (handler) return handler(dnsError);
      throw dnsError;
    }
    if (!this.mock) {
      if (this.maxBufferSize === 0) {
        this.sendMessage(message, callback);
      } else {
        this.enqueue(message, callback);
      }
    } else {
      const buffer = this.mockBuffer;
      if (buffer !== undefined) buffer.push(message);
      if (callback) callback(null, 0);
    }
  }

  private enqueue(message: string, callback: StatsCb | undefined): void {
    message += "\n";
    if (this.bufferHolder.buffer.length + message.length > this.maxBufferSize) {
      this.flushQueue(callback);
      this.bufferHolder.buffer += message;
    } else {
      this.bufferHolder.buffer += message;
      if (callback) callback(null);
    }
  }

  private flushQueue(callback?: StatsCb): void {
    this.sendMessage(this.bufferHolder.buffer, callback);
    this.bufferHolder.buffer = "";
  }

  private sendMessage(message: string, callback: StatsCb | undefined): void {
    if (message === "") {
      if (callback) callback(null);
      return;
    }
    const socketWasMissing = this.transport === null;
    if (socketWasMissing && this.protocol === PROTOCOL_UDS) {
      this.transport = createTransport(this);
      if (this.transport !== null) this.maybeAddUDSErrorHandler();
    }
    const socket = this.transport;
    if (socketWasMissing || socket === null) {
      const error = new Error("Socket not created properly. Check previous errors for details.");
      if (callback) return callback(error);
      const handler = this.errorHandler;
      if (handler) return handler(error);
      console.error(String(error));
      return;
    }
    const handleCallback = (err: Error | null, bytes?: number): void => {
      this.messagesInFlight--;
      let errFormatted: Error | null = null;
      if (err) {
        errFormatted = errorWithCode(
          `Error sending hot-shots message: ${String(err)}`,
          (err as NodeJS.ErrnoException).code,
        );
        if (this.protocol === PROTOCOL_UDS && (callback || this.errorHandler)) {
          this.udsErrorHandler(err);
        }
      }
      if (callback) {
        callback(errFormatted, bytes);
      } else if (errFormatted) {
        const handler = this.errorHandler;
        if (handler) {
          handler(errFormatted);
        } else {
          console.error(String(errFormatted));
          // hot-shots also emits the error on the current socket, where the
          // uds reconnection handler listens; with no listener it throws.
          const current = this.transport;
          if (current !== null) current.emitError(errFormatted);
        }
      }
    };
    try {
      this.messagesInFlight++;
      socket.send(Buffer.from(message), handleCallback);
    } catch (err) {
      handleCallback(err as Error);
    }
  }

  private onBufferFlushInterval(): void {
    this.flushQueue();
  }

  close(callback?: (error?: Error) => void): void {
    const stop = this.stopFlushInterval;
    if (stop !== undefined) stop();
    this.flushQueue((err) => {
      if (err) {
        if (callback) return callback(err);
        logError(err);
        return;
      }
      let intervalAttempts = 0;
      const waitForMessages = setInterval(() => {
        intervalAttempts++;
        if (intervalAttempts > 10) {
          console.log("hot-shots could not clear out messages in flight but closing anyways");
          this.messagesInFlight = 0;
        }
        if (this.messagesInFlight <= 0) {
          clearInterval(waitForMessages);
          this.closeSocket(callback);
        }
      }, this.closingFlushInterval);
    });
  }

  private closeSocket(callback: ((error?: Error) => void) | undefined): void {
    let handledError = false;
    const handleErr = (err: unknown): void => {
      const errMessage = `Error closing hot-shots socket: ${String(err)}`;
      if (handledError) {
        console.error(errMessage);
      } else {
        handledError = true;
        if (callback) {
          callback(new Error(errMessage));
        } else {
          const handler = this.errorHandler;
          if (handler) {
            handler(new Error(errMessage));
          } else {
            console.error(errMessage);
          }
        }
      }
    };
    const socket = this.transport;
    if (socket === null) {
      handleErr(new TypeError("Cannot read properties of null (reading 'removeListener')"));
      return;
    }
    const handler = this.errorHandler;
    if (handler) socket.offError(handler);
    socket.onError(handleErr);
    if (callback) {
      socket.onClose(() => {
        if (!handledError) callback(undefined);
      });
    }
    try {
      socket.close();
    } catch (err) {
      handleErr(err);
    }
  }

  childClient(options?: ChildClientOptions): StatsD {
    const o: ChildClientOptions = options ?? {};
    const childTags = o.globalTags;
    return new StatsD(
      {
        isChild: true,
        errorHandler: o.errorHandler || this.errorHandler,
        host: this.host,
        port: this.port,
        tagPrefix: this.tagPrefix,
        tagSeparator: this.tagSeparator,
        prefix: (o.prefix || "") + this.prefix,
        suffix: this.suffix + (o.suffix || ""),
        globalize: false,
        mock: this.mock,
        globalTags:
          childTags !== undefined
            ? overrideTags(this.globalTags, childTags, this.telegraf)
            : this.globalTags,
        maxBufferSize: this.maxBufferSize,
        bufferFlushInterval: this.bufferFlushInterval,
        telegraf: this.telegraf,
        protocol: this.protocol === "tcp" ? "tcp" : this.protocol === "uds" ? "uds" : "udp",
        closingFlushInterval: this.closingFlushInterval,
      },
      new ChildInit(this.transport, this.bufferHolder, this.dnsError),
    );
  }
}

export default StatsD;
