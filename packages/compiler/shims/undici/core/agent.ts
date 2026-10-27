// undici's Agent (lib/dispatcher/agent.js): one dispatcher per origin,
// created by `factory` (default: a Pool, or a Client when connections is 1).
import { Client } from "./client.ts";
import { Dispatcher, DispatcherBase } from "./dispatcher.ts";
import { InvalidArgumentError } from "./errors.ts";
import { Pool } from "./pool.ts";
import type {
  AgentOptions,
  DispatchHandlers,
  DispatchOptions,
  PoolOptions,
  Profile,
} from "./types.ts";

interface AgentEntry {
  dispatcher: Dispatcher;
  count: number;
}

export class Agent extends DispatcherBase {
  __options: PoolOptions;
  __factory: ((origin: string | URL, opts: object) => Dispatcher) | null;
  __clients: Map<string, AgentEntry>;
  __onDrain: (origin: URL, targets: Dispatcher[]) => void;
  __onConnect: (origin: URL, targets: Dispatcher[]) => void;
  __onDisconnect: (origin: URL, targets: Dispatcher[], err: Error) => void;
  __onConnectionError: (origin: URL, targets: Dispatcher[], err: Error) => void;

  constructor(options: AgentOptions | undefined, profile: Profile) {
    super(profile);
    const opts: AgentOptions = options ?? {};
    const interceptors = opts.interceptors;
    if (profile.major < 7 && interceptors !== undefined && interceptors.Agent !== undefined) {
      this.__interceptors = interceptors.Agent;
    }
    this.__options = {
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
      connect: opts.connect,
      interceptors:
        interceptors !== undefined
          ? { Pool: interceptors.Pool, Client: interceptors.Client }
          : undefined,
    };
    const factory = opts.factory;
    this.__factory = factory !== undefined ? factory : null;
    this.__clients = new Map<string, AgentEntry>();
    this.__onDrain = (origin: URL, targets: Dispatcher[]): void => {
      this.emit("drain", origin, [this as Dispatcher, ...targets]);
    };
    this.__onConnect = (origin: URL, targets: Dispatcher[]): void => {
      this.emit("connect", origin, [this as Dispatcher, ...targets]);
    };
    this.__onDisconnect = (origin: URL, targets: Dispatcher[], err: Error): void => {
      this.emit("disconnect", origin, [this as Dispatcher, ...targets], err);
    };
    this.__onConnectionError = (origin: URL, targets: Dispatcher[], err: Error): void => {
      this.emit("connectionError", origin, [this as Dispatcher, ...targets], err);
    };
  }

  __runningCount(): number {
    let ret = 0;
    for (const entry of this.__clients.values()) ret += entry.dispatcher.__runningCount();
    return ret;
  }

  __dispatch(opts: DispatchOptions, handler: DispatchHandlers): boolean {
    const origin = opts.origin;
    if (origin === undefined || origin === "") {
      throw new InvalidArgumentError("opts.origin must be a non-empty string or URL.");
    }
    const key = typeof origin === "string" ? origin : origin.href;
    const existing = this.__clients.get(key);
    let dispatcher: Dispatcher;
    if (existing !== undefined) {
      dispatcher = existing.dispatcher;
    } else {
      const factory = this.__factory;
      dispatcher =
        factory !== null
          ? factory(origin, this.__options)
          : this.__defaultFactory(origin, this.__options);
      const entry: AgentEntry = { dispatcher, count: 0 };
      if (this.__profile.major >= 7) {
        // 7.x closes and forgets an origin's dispatcher once all of its
        // connections are gone.
        const closeIfUnused = (connected: boolean): void => {
          const current = this.__clients.get(key);
          if (current !== undefined) {
            if (connected) current.count -= 1;
            if (current.count <= 0) {
              this.__clients.delete(key);
              if (!current.dispatcher.__isDestroyed()) current.dispatcher.close();
            }
          }
        };
        dispatcher.on("drain", this.__onDrain);
        dispatcher.on("connect", (o: URL, targets: Dispatcher[]) => {
          const current = this.__clients.get(key);
          if (current !== undefined) current.count += 1;
          this.__onConnect(o, targets);
        });
        dispatcher.on("disconnect", (o: URL, targets: Dispatcher[], err: Error) => {
          closeIfUnused(true);
          this.__onDisconnect(o, targets, err);
        });
        dispatcher.on("connectionError", (o: URL, targets: Dispatcher[], err: Error) => {
          closeIfUnused(false);
          this.__onConnectionError(o, targets, err);
        });
      } else {
        dispatcher.on("drain", this.__onDrain);
        dispatcher.on("connect", this.__onConnect);
        dispatcher.on("disconnect", this.__onDisconnect);
        dispatcher.on("connectionError", this.__onConnectionError);
      }
      this.__clients.set(key, entry);
    }
    return dispatcher.dispatch(opts, handler);
  }

  /** The default factory: a Client when `connections` is 1, else a Pool, of
   * the same undici version. */
  __defaultFactory(origin: string | URL, opts: PoolOptions): Dispatcher {
    return opts.connections === 1
      ? this.__createClient(origin, opts)
      : this.__createPool(origin, opts);
  }

  __createClient(origin: string | URL, opts: PoolOptions): Dispatcher {
    return new Client(origin, opts, this.__profile);
  }

  __createPool(origin: string | URL, opts: PoolOptions): Dispatcher {
    return new Pool(origin, opts, this.__profile);
  }

  __close(): Promise<void> {
    const closing: Promise<void>[] = [];
    for (const entry of this.__clients.values()) closing.push(entry.dispatcher.close());
    if (this.__profile.major >= 7) this.__clients.clear();
    return Promise.all(closing).then(() => {});
  }

  __destroy(err: Error): Promise<void> {
    const destroying: Promise<void>[] = [];
    for (const entry of this.__clients.values()) destroying.push(entry.dispatcher.destroy(err));
    if (this.__profile.major >= 7) this.__clients.clear();
    return Promise.all(destroying).then(() => {});
  }
}
