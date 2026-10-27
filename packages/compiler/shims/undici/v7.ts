// scriptc's built-in implementation of the `undici` package, 7.x API.
//
// Programs whose installed undici is 7.x compile this module in its place
// (see packages/compiler/src/frontend/package-shims.ts). It implements the
// HTTP/1.1 client subset over node:net / node:tls: Dispatcher, Client, Pool,
// Agent, request(), buildConnector, errors, the global dispatcher, fetch and
// the diagnostics_channel publications. Anything else undici exports is not
// declared here, so using it is a compile-time error.
import { Agent as CoreAgent } from "./core/agent.ts";
import {
  getGlobalDispatcher as coreGetGlobalDispatcher,
  request as coreRequest,
  setGlobalDispatcher as coreSetGlobalDispatcher,
} from "./core/api.ts";
import type { TopLevelRequestOptions } from "./core/api.ts";
import { Client as CoreClient } from "./core/client.ts";
import { buildConnector as coreBuildConnector } from "./core/connector.ts";
import { Dispatcher } from "./core/dispatcher.ts";
import type { ResponseData } from "./core/dispatcher.ts";
import { undiciFetch } from "./core/fetch.ts";
import type { UndiciRequestInit } from "./core/fetch.ts";
import { Pool as CorePool, PoolStats as CorePoolStats } from "./core/pool.ts";
import type {
  AgentOptions,
  ClientOptions,
  Connector,
  ConnectorBuildOptions,
  ConnectorCallback,
  ConnectorOptions,
  DispatchOptions,
  PoolOptions,
  Profile,
} from "./core/types.ts";
import type { SocketInfo as CoreSocketInfo } from "./core/errors.ts";

const profile: Profile = { major: 7 };

export { Dispatcher };
export type { DiagnosticsChannel } from "./core/diagnostics-types.ts";
export * as errors from "./core/errors-v7.ts";

export class Client extends CoreClient {
  constructor(url: string | URL, options?: Client.Options) {
    super(url, options, profile);
  }
}

export declare namespace Client {
  type Options = ClientOptions;
  type SocketInfo = CoreSocketInfo;
}

export class Pool extends CorePool {
  constructor(url: string | URL, options?: Pool.Options) {
    super(url, options, profile);
  }

  __createClient(origin: URL, options: ClientOptions): Dispatcher {
    return new Client(origin, options);
  }
}

export declare namespace Pool {
  type Options = PoolOptions;
  type PoolStats = CorePoolStats;
}

export class Agent extends CoreAgent {
  constructor(options?: Agent.Options) {
    super(options, profile);
  }

  __createClient(origin: string | URL, options: PoolOptions): Dispatcher {
    return new Client(origin, options);
  }

  __createPool(origin: string | URL, options: PoolOptions): Dispatcher {
    return new Pool(origin, options);
  }
}

export declare namespace Agent {
  type Options = AgentOptions;
  type DispatchOptions = import("./core/types.ts").DispatchOptions;
}

export function buildConnector(options?: buildConnector.BuildOptions): buildConnector.connector {
  return coreBuildConnector(options ?? {});
}

export declare namespace buildConnector {
  type BuildOptions = ConnectorBuildOptions;
  type Options = ConnectorOptions;
  type Callback = ConnectorCallback;
  type connector = Connector;
}

export function setGlobalDispatcher(dispatcher: Dispatcher): void {
  coreSetGlobalDispatcher(dispatcher);
}

export function getGlobalDispatcher(): Dispatcher {
  return coreGetGlobalDispatcher(() => new Agent());
}

export function request(
  url: string | URL,
  options?: TopLevelRequestOptions,
): Promise<ResponseData> {
  return coreRequest(url, options, () => new Agent(), profile);
}

export function fetch(input: string | URL, init?: UndiciRequestInit): Promise<Response> {
  return undiciFetch(input, init, () => new Agent(), profile);
}

// undici's Headers is the WHATWG class the runtime implements natively.
export import Headers = globalThis.Headers;
export type { DispatchOptions };
