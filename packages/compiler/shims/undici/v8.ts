// HTTP/1.1 requests for an installed undici 8.x.
import { Agent as CoreAgent } from "./core/agent.ts";
import { request as coreRequest } from "./core/api.ts";
import type { TopLevelRequestOptions } from "./core/api.ts";
import type { ResponseData } from "./core/dispatcher.ts";
import { NotSupportedError } from "./core/errors.ts";
import { installGlobalFetchDispatcher, undiciFetch } from "./core/fetch.ts";
import type { UndiciFetchInit } from "./core/fetch.ts";
import { Pool as CorePool } from "./core/pool.ts";
import type { AgentOptions, PoolOptions, Profile } from "./core/types.ts";

const profile: Profile = { major: 8 };

export { Dispatcher } from "./core/dispatcher.ts";
export import Headers = globalThis.Headers;

function requireHttp1(options: { allowH2?: boolean } | undefined): void {
  if (options?.allowH2 === true) {
    throw new NotSupportedError("scriptc's native undici 8 client supports HTTP/1.1");
  }
}

export class Agent extends CoreAgent {
  constructor(options?: Agent.Options) {
    super(options, profile);
    requireHttp1(options);
    if (options?.allowH2 === false) this.__options.allowH2 = false;
  }

  __createPool(origin: string | URL, options: PoolOptions): CorePool {
    return new Pool(origin, options);
  }
}

export declare namespace Agent {
  interface Options extends AgentOptions {
    allowH2?: false;
  }
}

export class Pool extends CorePool {
  constructor(origin: string | URL, options?: Pool.Options) {
    super(origin, options, profile);
    requireHttp1(options);
    if (options?.allowH2 === false) this.__options.allowH2 = false;
  }
}

export declare namespace Pool {
  interface Options extends PoolOptions {
    allowH2?: false;
  }
}

export function request(
  url: string | URL,
  options?: TopLevelRequestOptions,
): Promise<ResponseData> {
  return coreRequest(url, options, () => new Agent(), profile);
}

export function fetch(input: string | URL, init?: UndiciFetchInit): Promise<Response> {
  return undiciFetch(input, init, () => new Agent(), profile);
}

installGlobalFetchDispatcher(() => new Agent(), profile);
