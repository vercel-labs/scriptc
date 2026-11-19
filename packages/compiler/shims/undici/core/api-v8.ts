// HTTP/1.1 requests for an installed undici 8.x.
import { Agent as CoreAgent } from "./agent.ts";
import { request as coreRequest } from "./api.ts";
import type { TopLevelRequestOptions } from "./api.ts";
import type { ResponseData, ResponseHeaders } from "./dispatcher.ts";
import { NotSupportedError } from "./errors.ts";
import { installGlobalFetchDispatcher, undiciFetch } from "./fetch.ts";
import type { UndiciFetchInit } from "./fetch.ts";
import { Pool as CorePool } from "./pool.ts";
import type { AgentOptions, PoolOptions, Profile } from "./types.ts";

const profile: Profile = { major: 8 };

export { DispatcherV8 as Dispatcher } from "./dispatcher.ts";
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
  options: TopLevelRequestOptions<string[]> & { responseHeaders: "raw" },
): Promise<ResponseData<string[]>>;
export function request(url: string | URL, options?: TopLevelRequestOptions): Promise<ResponseData>;
export function request(
  url: string | URL,
  options?: TopLevelRequestOptions<ResponseHeaders>,
): Promise<ResponseData<ResponseHeaders>> {
  return coreRequest(url, options, () => new Agent(), profile);
}

export function fetch(input: string | URL, init?: UndiciFetchInit): Promise<Response> {
  return undiciFetch(input, init, () => new Agent(), profile);
}

installGlobalFetchDispatcher(() => new Agent(), profile);
