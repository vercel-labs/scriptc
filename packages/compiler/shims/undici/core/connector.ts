// undici's buildConnector (lib/core/connect.js) over node:net and node:tls.
import * as net from "node:net";
import * as tls from "node:tls";
import { ConnectTimeoutError, InvalidArgumentError, NotSupportedError } from "./errors.ts";
import type {
  Connector,
  ConnectorBuildOptions,
  ConnectorCallback,
  ConnectorOptions,
  LookupAddress,
} from "./types.ts";

export function buildConnector(options: ConnectorBuildOptions): Connector {
  const maxCachedSessions = options.maxCachedSessions;
  if (
    maxCachedSessions !== undefined &&
    maxCachedSessions !== null &&
    (!Number.isInteger(maxCachedSessions) || maxCachedSessions < 0)
  ) {
    throw new InvalidArgumentError("maxCachedSessions must be a positive integer or zero");
  }
  if (options.socketPath !== undefined && options.socketPath !== null) {
    throw new NotSupportedError("scriptc's undici connector does not dial socketPath yet");
  }
  const timeout =
    options.timeout === undefined || options.timeout === null ? 10e3 : options.timeout;
  const lookup = options.lookup;
  // The plain-TCP dial, with the caller's resolver when one is configured.
  let dialTcp: (port: number, host: string) => net.Socket;
  if (lookup !== undefined) {
    // net.connect's lowered resolver answers every address at once; adapt a
    // resolver that answers a single address string.
    const userLookup: (
      hostname: string,
      options: unknown,
      callback: (
        err: NodeJS.ErrnoException | null,
        address: string | LookupAddress[],
        family?: number,
      ) => void,
    ) => void = lookup;
    const resolver = (
      hostname: string,
      lookupOptions: unknown,
      callback: (err: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void,
    ): void => {
      userLookup(hostname, lookupOptions, (err, address, family) => {
        if (err !== null) callback(err, []);
        else if (typeof address === "string") {
          callback(null, [{ address, family: family ?? (net.isIPv6(address) ? 6 : 4) }]);
        } else callback(null, address);
      });
    };
    dialTcp = (port: number, host: string): net.Socket =>
      net.connect({ port, host, autoSelectFamily: true, lookup: resolver });
  } else {
    dialTcp = (port: number, host: string): net.Socket => net.connect({ port, host });
  }
  const rejectUnauthorized = options.rejectUnauthorized;
  const ca = options.ca;
  const defaultServername = options.servername;

  return (params: ConnectorOptions, callback: ConnectorCallback): net.Socket => {
    let pending: ConnectorCallback | null = callback;
    const https = params.protocol === "https:";
    const port = params.port !== "" ? Number(params.port) : https ? 443 : 80;
    let socket: net.Socket;
    if (https) {
      if (lookup !== undefined) {
        throw new NotSupportedError(
          "scriptc's undici connector does not apply a custom lookup to TLS connections yet",
        );
      }
      const servername =
        params.servername !== undefined && params.servername !== ""
          ? params.servername
          : defaultServername !== undefined
            ? defaultServername
            : serverNameOf(params.host ?? params.hostname);
      socket = tls.connect({
        port,
        host: params.hostname,
        servername,
        rejectUnauthorized: rejectUnauthorized ?? true,
        ...(ca !== undefined ? { ca } : {}),
      });
    } else {
      socket = dialTcp(port, params.hostname);
    }

    let cancelTimer: (() => void) | null = null;
    if (timeout !== 0) {
      const timer = setTimeout(() => {
        cancelTimer = null;
        setImmediate(() => {
          const err = new ConnectTimeoutError();
          socket.destroy();
          if (pending !== null) {
            const cb = pending;
            pending = null;
            cb(err, null);
          }
        });
      }, timeout);
      cancelTimer = () => clearTimeout(timer);
    }
    const cancelTimeout = (): void => {
      const cancel = cancelTimer;
      cancelTimer = null;
      if (cancel !== null) cancel();
    };

    socket.setNoDelay(true);
    const onConnected = (): void => {
      cancelTimeout();
      if (pending !== null) {
        const cb = pending;
        pending = null;
        cb(null, socket);
      }
    };
    if (https) socket.once("secureConnect", onConnected);
    else socket.once("connect", onConnected);
    socket.on("error", (err: Error) => {
      cancelTimeout();
      if (pending !== null) {
        const cb = pending;
        pending = null;
        cb(err, null);
      }
    });
    return socket;
  };
}

/** undici's util.getServerName: the host without its port, or null for an
 * IP literal (no SNI). */
function serverNameOf(host: string): string | undefined {
  if (host === "") return undefined;
  let servername = host;
  if (servername.startsWith("[")) {
    const idx = servername.indexOf("]");
    servername = idx === -1 ? servername : servername.slice(1, idx);
  } else {
    const idx = servername.indexOf(":");
    if (idx !== -1) servername = servername.slice(0, idx);
  }
  return net.isIP(servername) !== 0 ? undefined : servername;
}

/** The `buildConnector.*` type namespace of undici's types/connector.d.ts. */
export declare namespace buildConnector {
  type BuildOptions = ConnectorBuildOptions;
  type Options = ConnectorOptions;
  type Callback = ConnectorCallback;
  type connector = Connector;
}
