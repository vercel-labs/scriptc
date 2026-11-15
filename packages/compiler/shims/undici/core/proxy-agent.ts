// undici 5.x's ProxyAgent (lib/proxy-agent.js): every request travels
// through an HTTP CONNECT tunnel the proxy opens to the request's origin.
// An inner Agent pools one dispatcher per origin as usual; its connector
// dials the proxy, sends `CONNECT host:port`, and on a 200 answer hands
// the client the tunnel (for an https origin, a TLS session over it).
//
// What reaches the wire is what undici 5 writes: the request line, then
// `host` (the proxy's own host, as undici's CONNECT sends it), then
// `connection: close`, then the constructor's headers in the order given
// and `proxy-authorization` last. undici dials the proxy through a pooled
// Client; here every tunnel has its own connection, which a proxy cannot
// tell apart (a CONNECT request never shares a connection).
//
// The headers and the token a program gives are checked as undici's
// request checks them before anything is written: a line break in a name
// or a value fails the request with InvalidArgumentError and never
// reaches the proxy. For an https origin the certificate is checked
// against the name undici checks it against: `requestTls.servername`,
// else the origin's host.
//
// Not implemented, refused by name where it is asked for: `clientFactory`,
// a proxy URL that is neither http: nor https:, a `host`,
// `content-length` or `connection` header for the CONNECT request (undici
// frames those itself), and the members of `requestTls` and `proxyTls`
// that are not applied. Reading the proxy from the environment
// (HTTP_PROXY and its relatives) is not part of ProxyAgent in undici
// either: the program decides.
import type { Socket } from "node:net";
import * as tls from "node:tls";
import { buildConnector, serverNameOf } from "./connector.ts";
import { Dispatcher, DispatcherBase } from "./dispatcher.ts";
import {
  InvalidArgumentError,
  NotSupportedError,
  RequestAbortedError,
  SocketError,
} from "./errors.ts";
import { headerCharRegex, tokenRegExp } from "./request.ts";
import type {
  AgentOptions,
  Connector,
  ConnectorBuildOptions,
  ConnectorCallback,
  ConnectorOptions,
  DispatchHandlers,
  DispatchInterceptor,
  DispatchOptions,
  IncomingHttpHeaders,
  Profile,
} from "./types.ts";

/** undici's ProxyAgent.Options (types/proxy-agent.d.ts). */
export interface ProxyAgentOptions extends Omit<AgentOptions, "interceptors"> {
  uri: string;
  /** Deprecated in undici in favour of `token`. */
  auth?: string;
  token?: string;
  headers?: IncomingHttpHeaders;
  requestTls?: ConnectorBuildOptions;
  proxyTls?: ConnectorBuildOptions;
  clientFactory?(origin: URL, opts: object): Dispatcher;
  interceptors?: {
    ProxyAgent?: readonly DispatchInterceptor[] | undefined;
    Agent?: readonly DispatchInterceptor[] | undefined;
    Pool?: readonly DispatchInterceptor[] | undefined;
    Client?: readonly DispatchInterceptor[] | undefined;
  };
}

export class ProxyAgent extends DispatcherBase {
  __agent: Dispatcher;

  constructor(
    options: ProxyAgentOptions | string,
    profile: Profile,
    createAgent: (options: AgentOptions) => Dispatcher,
  ) {
    super(profile);
    const opts: ProxyAgentOptions = typeof options === "string" ? { uri: options } : options;
    if (!opts || !opts.uri) {
      throw new InvalidArgumentError("Proxy opts.uri is mandatory");
    }
    const interceptors = opts.interceptors;
    if (interceptors !== undefined && interceptors.ProxyAgent !== undefined) {
      this.__interceptors = interceptors.ProxyAgent;
    }
    if (opts.clientFactory !== undefined) {
      if (typeof opts.clientFactory !== "function") {
        throw new InvalidArgumentError("Proxy opts.clientFactory must be a function.");
      }
      throw new NotSupportedError(
        "scriptc's undici ProxyAgent dials the proxy itself and does not take clientFactory yet",
      );
    }
    // The proxy's request headers, in undici's order: the caller's, then
    // the credentials. A value given as a list is one line per entry.
    const proxyHeaders: [string, string[]][] = [];
    const given = opts.headers;
    if (given !== undefined) {
      for (const name of Object.keys(given)) {
        const value = given[name];
        if (value === undefined) continue;
        const lower = name.toLowerCase();
        if (lower === "host" || lower === "content-length" || lower === "connection") {
          throw new NotSupportedError(
            `scriptc's undici ProxyAgent does not take a '${name}' header for the CONNECT request (undici frames that header itself)`,
          );
        }
        proxyHeaders.push([name, typeof value === "string" ? [value] : value]);
      }
    }
    const proxy = new URL(opts.uri);
    if (opts.auth && opts.token) {
      throw new InvalidArgumentError("opts.auth cannot be used in combination with opts.token");
    } else if (opts.auth) {
      setHeader(proxyHeaders, "proxy-authorization", `Basic ${opts.auth}`);
    } else if (opts.token) {
      setHeader(proxyHeaders, "proxy-authorization", opts.token);
    } else if (proxy.username && proxy.password) {
      const credentials = `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`;
      setHeader(
        proxyHeaders,
        "proxy-authorization",
        `Basic ${Buffer.from(credentials).toString("base64")}`,
      );
    }
    if (proxy.protocol !== "http:" && proxy.protocol !== "https:") {
      throw new NotSupportedError(
        `scriptc's undici ProxyAgent tunnels through http: and https: proxies, not '${proxy.protocol}'`,
      );
    }
    appliedOnly("requestTls", opts.requestTls, ["servername", "rejectUnauthorized", "ca"]);
    appliedOnly("proxyTls", opts.proxyTls, [
      "servername",
      "rejectUnauthorized",
      "ca",
      "timeout",
      "maxCachedSessions",
      "socketPath",
      "lookup",
    ]);
    const requestTls = opts.requestTls;
    const connect = tunnelConnector(
      proxy,
      proxyHeaders,
      buildConnector(opts.proxyTls !== undefined ? { ...opts.proxyTls } : {}),
      requestTls,
    );
    this.__agent = createAgent({
      keepAliveTimeout: opts.keepAliveTimeout,
      keepAliveMaxTimeout: opts.keepAliveMaxTimeout,
      keepAliveTimeoutThreshold: opts.keepAliveTimeoutThreshold,
      pipelining: opts.pipelining,
      maxHeaderSize: opts.maxHeaderSize,
      bodyTimeout: opts.bodyTimeout,
      headersTimeout: opts.headersTimeout,
      strictContentLength: opts.strictContentLength,
      maxRequestsPerClient: opts.maxRequestsPerClient,
      maxResponseSize: opts.maxResponseSize,
      connectTimeout: opts.connectTimeout,
      localAddress: opts.localAddress,
      connections: opts.connections,
      factory: opts.factory,
      interceptors:
        interceptors !== undefined
          ? { Agent: interceptors.Agent, Pool: interceptors.Pool, Client: interceptors.Client }
          : undefined,
      connect,
    });
  }

  __runningCount(): number {
    return this.__agent.__runningCount();
  }

  __dispatch(opts: DispatchOptions, handler: DispatchHandlers): boolean {
    const origin = opts.origin;
    if (origin === undefined || origin === "") {
      throw new InvalidArgumentError("opts.origin must be a non-empty string or URL.");
    }
    const host = new URL(typeof origin === "string" ? origin : origin.href).host;
    const headers = headerRecord(opts.headers);
    for (const name of Object.keys(headers)) {
      if (name.toLowerCase() === "proxy-authorization") {
        throw new InvalidArgumentError(
          "Proxy-Authorization should be sent in ProxyAgent constructor",
        );
      }
    }
    headers["host"] = host;
    return this.__agent.dispatch({ ...opts, headers }, handler);
  }

  __close(): Promise<void> {
    return this.__agent.close();
  }

  __destroy(err: Error): Promise<void> {
    return this.__agent.destroy(err);
  }
}

/** Sets a header by exact name, keeping the position of a caller's entry
 * of that name (assigning an object key keeps its place). */
function setHeader(headers: [string, string[]][], name: string, value: string): void {
  for (const entry of headers) {
    if (entry[0] === name) {
      entry[1] = [value];
      return;
    }
  }
  headers.push([name, [value]]);
}

/** A connector option record of which only `applied` members are acted
 * on: any other member that is set is refused by name, so no option is
 * taken and then ignored. */
function appliedOnly(
  option: string,
  record: ConnectorBuildOptions | undefined,
  applied: readonly string[],
): void {
  if (record === undefined) return;
  const set: string[] = [];
  if (record.timeout !== undefined) set.push("timeout");
  if (record.maxCachedSessions !== undefined) set.push("maxCachedSessions");
  if (record.socketPath !== undefined) set.push("socketPath");
  if (record.port !== undefined) set.push("port");
  if (record.rejectUnauthorized !== undefined) set.push("rejectUnauthorized");
  if (record.ca !== undefined) set.push("ca");
  if (record.servername !== undefined) set.push("servername");
  if (record.lookup !== undefined) set.push("lookup");
  if (record.keepAlive !== undefined) set.push("keepAlive");
  if (record.keepAliveInitialDelay !== undefined) set.push("keepAliveInitialDelay");
  if (record.noDelay !== undefined) set.push("noDelay");
  if (record.autoSelectFamily !== undefined) set.push("autoSelectFamily");
  if (record.autoSelectFamilyAttemptTimeout !== undefined)
    set.push("autoSelectFamilyAttemptTimeout");
  for (const member of set) {
    if (applied.includes(member)) continue;
    throw new NotSupportedError(
      `scriptc's undici ProxyAgent does not apply '${member}' of ${option} yet (applied: ${applied.join(", ")})`,
    );
  }
}

/** What undici's request checks of a header before it writes the CONNECT
 * request (core/request.js, processHeader): the names it frames itself or
 * does not send, then the name as a token and the value's characters. A
 * line break in either fails the request here. */
function checkTunnelHeader(name: string, value: string): void {
  const lower = name.toLowerCase();
  if (lower === "transfer-encoding" || lower === "keep-alive" || lower === "upgrade") {
    throw new InvalidArgumentError(`invalid ${lower} header`);
  }
  if (lower === "expect") throw new NotSupportedError("expect header not supported");
  if (!tokenRegExp.test(name)) throw new InvalidArgumentError("invalid header key");
  if (headerCharRegex.test(value)) throw new InvalidArgumentError(`invalid ${name} header`);
}

/** proxy-agent.js's buildHeaders: fetch hands the header list over as a
 * flat [name, value, ...] array. */
function headerRecord(
  headers: DispatchOptions["headers"],
): Record<string, string | string[] | undefined> {
  const record: Record<string, string | string[] | undefined> = {};
  if (headers === undefined || headers === null) return record;
  if (Array.isArray(headers)) {
    for (let i = 0; i + 1 < headers.length; i += 2) record[headers[i]!] = headers[i + 1]!;
    return record;
  }
  for (const name of Object.keys(headers)) record[name] = headers[name];
  return record;
}

/** The connector of the inner Agent: a tunnel to the request's origin
 * through the proxy. */
function tunnelConnector(
  proxy: URL,
  proxyHeaders: readonly [string, string[]][],
  dialProxy: Connector,
  requestTls: ConnectorBuildOptions | undefined,
): Connector {
  return (params: ConnectorOptions, callback: ConnectorCallback): Socket => {
    // Before the proxy is dialed: a header undici would not send fails the
    // request, as the request undici makes for the tunnel does.
    for (const [name, values] of proxyHeaders) {
      for (const value of values) checkTunnelHeader(name, value);
    }
    let requestedHost = params.host ?? params.hostname;
    if (params.port === "") requestedHost += params.protocol === "https:" ? ":443" : ":80";
    let pending: ConnectorCallback | null = callback;
    const settle = (err: Error | null, socket: Socket | null): void => {
      const cb = pending;
      pending = null;
      if (cb !== null) cb(err, socket);
    };
    // The URL of an IPv6 literal keeps the brackets in its hostname; the
    // connector dials the address inside them, as undici's client does.
    let proxyHostname = proxy.hostname;
    if (proxyHostname.startsWith("[")) {
      proxyHostname = proxyHostname.slice(1, proxyHostname.indexOf("]"));
    }
    return dialProxy(
      { hostname: proxyHostname, host: proxy.host, protocol: proxy.protocol, port: proxy.port },
      (err: Error | null, tunnel: Socket | null): void => {
        if (err !== null || tunnel === null) {
          settle(err ?? new SocketError("proxy connect failed"), null);
          return;
        }
        let head = `CONNECT ${requestedHost} HTTP/1.1\r\nhost: ${proxy.host}\r\nconnection: close\r\n`;
        for (const [name, values] of proxyHeaders) {
          for (const value of values) head += `${name}: ${value}\r\n`;
        }
        // The listeners stay on the socket (the native socket has no way
        // to take one off) and do nothing once the answer has been read.
        let answer: Buffer = Buffer.alloc(0);
        let answered = false;
        const onData = (chunk: Buffer): void => {
          if (answered) return;
          answer = Buffer.concat([answer, chunk]);
          const end = answer.indexOf("\r\n\r\n");
          if (end === -1) return;
          answered = true;
          const statusLine = answer.subarray(0, answer.indexOf("\r\n")).toString("latin1");
          const statusCode = Number(statusLine.split(" ")[1]);
          if (statusCode !== 200) {
            tunnel.destroy();
            settle(
              new RequestAbortedError(`Proxy response (${statusCode}) !== 200 when HTTP Tunneling`),
              null,
            );
            return;
          }
          // The origin speaks only after the client does, so nothing follows
          // the answer's head; bytes that do cannot be handed to the client.
          if (answer.length > end + 4) {
            tunnel.destroy();
            settle(new SocketError("the proxy sent data before the tunnel was used"), null);
            return;
          }
          if (params.protocol !== "https:") {
            settle(null, tunnel);
            return;
          }
          // undici's name for the certificate check: requestTls's when
          // requestTls is given, else the client's; without one, the
          // origin's host (for an IP literal no name is sent and the
          // certificate is checked against the address).
          const asked = requestTls !== undefined ? requestTls.servername : params.servername;
          const servername =
            asked !== undefined && asked !== ""
              ? asked
              : serverNameOf(params.host ?? params.hostname);
          const secure = tls.connect({
            socket: tunnel,
            host: params.hostname,
            ...(servername !== undefined && servername !== "" ? { servername } : {}),
            rejectUnauthorized:
              requestTls !== undefined && requestTls.rejectUnauthorized !== undefined
                ? requestTls.rejectUnauthorized
                : true,
            ...(requestTls !== undefined && requestTls.ca !== undefined
              ? { ca: requestTls.ca }
              : {}),
          });
          secure.once("secureConnect", () => settle(null, secure));
          secure.on("error", (error: Error) => settle(error, null));
        };
        tunnel.on("data", onData);
        tunnel.on("error", (error: Error) => {
          if (!answered) settle(error, null);
        });
        tunnel.on("close", () => {
          if (!answered) settle(new SocketError("other side closed"), null);
        });
        // As undici writes a request head: one byte per character.
        tunnel.write(Buffer.from(head + "\r\n", "latin1"));
      },
    );
  };
}
