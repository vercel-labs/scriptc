// undici's Pool (lib/dispatcher/pool.js, pool-base.js, pool-stats.js): a
// set of Clients for one origin, created on demand up to `connections`, with
// a queue for requests no client can take.
import { buildConnector } from "./connector.ts";
import { Client } from "./client.ts";
import { Dispatcher, DispatcherBase } from "./dispatcher.ts";
import { InvalidArgumentError } from "./errors.ts";
import { parseOrigin } from "./util.ts";
import type {
  ClientOptions,
  DispatchHandlers,
  DispatchOptions,
  PoolOptions,
  Profile,
} from "./types.ts";

interface QueuedDispatch {
  opts: DispatchOptions;
  handler: DispatchHandlers;
}

/** pool-stats.js: live counters over a pool's clients. */
export class PoolStats {
  __pool: PoolBase;

  constructor(pool: PoolBase) {
    this.__pool = pool;
  }

  get connected(): number {
    return this.__pool.__connectedCount();
  }

  get free(): number {
    return this.__pool.__freeCount();
  }

  get pending(): number {
    return this.__pool.__pendingCount();
  }

  get queued(): number {
    return this.__pool.__queuedCount();
  }

  get running(): number {
    return this.__pool.__runningCount();
  }

  get size(): number {
    return this.__pool.__sizeCount();
  }
}

export class PoolBase extends DispatcherBase {
  __clients: Dispatcher[];
  __clientNeedDrain: Map<Dispatcher, boolean>;
  __queue: QueuedDispatch[];
  __queued: number;
  __needDrain: boolean;
  __closedResolve: (() => void) | null;
  __stats: PoolStats;
  __onDrain: (origin: URL, targets: Dispatcher[]) => void;
  __onConnect: (origin: URL, targets: Dispatcher[]) => void;
  __onDisconnect: (origin: URL, targets: Dispatcher[], err: Error) => void;
  __onConnectionError: (origin: URL, targets: Dispatcher[], err: Error) => void;

  constructor(profile: Profile) {
    super(profile);
    this.__clients = [];
    this.__clientNeedDrain = new Map<Dispatcher, boolean>();
    this.__queue = [];
    this.__queued = 0;
    this.__needDrain = false;
    this.__closedResolve = null;
    this.__stats = new PoolStats(this);
    this.__onDrain = (origin: URL, targets: Dispatcher[]): void => {
      const client = targets[0]!;
      let needDrain = false;
      while (!needDrain) {
        const item = this.__queue.shift();
        if (item === undefined) break;
        this.__queued--;
        needDrain = !client.dispatch(item.opts, item.handler);
      }
      this.__clientNeedDrain.set(client, needDrain);
      if (!needDrain && this.__needDrain) {
        this.__needDrain = false;
        this.emit("drain", origin, [this as Dispatcher, ...targets]);
      }
      const closed = this.__closedResolve;
      if (closed !== null && this.__queue.length === 0) {
        Promise.all(this.__clients.map((c) => c.close())).then(() => closed());
      }
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

  get stats(): PoolStats {
    return this.__stats;
  }

  __busyFlag(): boolean {
    return this.__needDrain;
  }

  __connectedCount(): number {
    return this.__clients.filter((c) => c.__connectedFlag()).length;
  }

  __freeCount(): number {
    return this.__clients.filter((c) => c.__connectedFlag() && !this.__clientNeedDrain.get(c))
      .length;
  }

  __pendingCount(): number {
    let ret = this.__queued;
    for (const c of this.__clients) ret += c.__pendingCount();
    return ret;
  }

  __queuedCount(): number {
    return this.__queued;
  }

  __runningCount(): number {
    let ret = 0;
    for (const c of this.__clients) ret += c.__runningCount();
    return ret;
  }

  __sizeCount(): number {
    let ret = this.__queued;
    for (const c of this.__clients) ret += c.__sizeCount();
    return ret;
  }

  __close(): Promise<void> {
    if (this.__queue.length === 0) {
      return Promise.all(this.__clients.map((c) => c.close())).then(() => {});
    }
    return new Promise<void>((resolve) => {
      this.__closedResolve = resolve;
    });
  }

  __destroy(err: Error): Promise<void> {
    for (;;) {
      const item = this.__queue.shift();
      if (item === undefined) break;
      if (item.handler.onError !== undefined) item.handler.onError!(err);
    }
    return Promise.all(this.__clients.map((c) => c.destroy(err))).then(() => {});
  }

  __dispatch(opts: DispatchOptions, handler: DispatchHandlers): boolean {
    const dispatcher = this.__getDispatcher();
    if (dispatcher === null) {
      this.__needDrain = true;
      this.__queue.push({ opts, handler });
      this.__queued++;
    } else if (!dispatcher.dispatch(opts, handler)) {
      this.__clientNeedDrain.set(dispatcher, true);
      this.__needDrain = this.__getDispatcher() === null;
    }
    return !this.__needDrain;
  }

  __getDispatcher(): Dispatcher | null {
    return null;
  }

  __addClient(client: Dispatcher): void {
    client.on("drain", this.__onDrain);
    client.on("connect", this.__onConnect);
    client.on("disconnect", this.__onDisconnect);
    client.on("connectionError", this.__onConnectionError);
    this.__clients.push(client);
    this.__clientNeedDrain.set(client, false);
    if (this.__needDrain) {
      process.nextTick(() => {
        if (this.__needDrain) this.__onDrain(clientUrl(client), [client, this as Dispatcher]);
      });
    }
  }
}

function clientUrl(client: Dispatcher): URL {
  return client instanceof Client ? client.__url : new URL("http://localhost");
}

export class Pool extends PoolBase {
  __connections: number | null;
  __url: URL;
  __options: ClientOptions;
  __factory: ((origin: URL, opts: object) => Dispatcher) | null;

  constructor(origin: string | URL, options: PoolOptions | undefined, profile: Profile) {
    super(profile);
    const opts: PoolOptions = options ?? {};
    const connections = opts.connections ?? null;
    if (connections !== null && (!Number.isFinite(connections) || connections < 0)) {
      throw new InvalidArgumentError("invalid connections");
    }
    const connect = opts.connect ?? null;
    const connector =
      typeof connect === "function"
        ? connect
        : buildConnector(
            connect !== null
              ? {
                  ...connect,
                  timeout:
                    connect.timeout !== undefined ? connect.timeout : (opts.connectTimeout ?? 10e3),
                }
              : { timeout: opts.connectTimeout ?? 10e3 },
          );
    const interceptors = opts.interceptors;
    if (profile.major < 7 && interceptors !== undefined && interceptors.Pool !== undefined) {
      this.__interceptors = interceptors.Pool;
    }
    this.__connections = connections !== null && connections !== 0 ? connections : null;
    this.__url = parseOrigin(origin, profile);
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
      localAddress: opts.localAddress,
      interceptors: interceptors !== undefined ? { Client: interceptors.Client } : undefined,
      connect: connector,
    };
    const factory = opts.factory;
    this.__factory = factory !== undefined ? factory : null;
    if (profile.major >= 7) {
      // 7.x drops a client whose connection attempt failed.
      this.on("connectionError", (_origin: URL, targets: Dispatcher[], _err: Error) => {
        for (const target of targets) {
          const idx = this.__clients.indexOf(target);
          if (idx !== -1) this.__clients.splice(idx, 1);
        }
      });
    }
  }

  __getDispatcher(): Dispatcher | null {
    for (const client of this.__clients) {
      if (!this.__clientNeedDrain.get(client)) return client;
    }
    if (this.__connections === null || this.__clients.length < this.__connections) {
      const factory = this.__factory;
      const client =
        factory !== null
          ? factory(this.__url, this.__options)
          : this.__createClient(this.__url, this.__options);
      this.__addClient(client);
      return client;
    }
    return null;
  }

  /** The default factory: a Client of the same undici version. */
  __createClient(origin: URL, options: ClientOptions): Dispatcher {
    return new Client(origin, options, this.__profile);
  }
}
