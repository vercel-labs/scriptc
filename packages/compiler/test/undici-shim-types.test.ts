/* The undici shim's declarations against the real package's (5.12 and 7.30,
 * vendored by the npm fixture cases undici5/undici7).
 *
 * The shim restates the subset of undici's types it implements. Two checks
 * keep the restatement honest:
 *
 * - usage conformance: one program written against undici's API (the
 *   transport-style Agent subclass, request(), responses, errors, pool
 *   stats, buildConnector, diagnostics message types, fetch through a
 *   dispatcher) type-checks without diagnostics against the real
 *   declarations AND against the shim, so code written for the implemented
 *   subset keeps compiling when scriptc swaps the module;
 * - shape: every value the shim exports, every `errors` class, and every
 *   member of the response/stats/message records exists in the real
 *   declarations with an assignable type.
 *
 * The shim modules themselves must type-check under @types/node too (the
 * program the check builds includes them), since real projects compile
 * them with their own Node types.
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import * as ad from "../src/frontend/ts7/adapter.js";
import { createProgram, getPreEmitDiagnostics } from "../src/frontend/ts7/program-adapter.js";

const repoRoot = join(import.meta.dirname, "../../..");
const shimRoot = join(repoRoot, "packages/compiler/shims/undici");

/** undici-types 5.26.5 (vendored, see the fixture's README): what
 * @types/node 20 types the global fetch with. */
const globalTypes5 = join(repoRoot, "tests/fixtures/undici-types-5/undici-types");

/** The real package's declarations, copied to a directory that is not an
 * installed undici. The checker reads the types entry of an installed
 * undici as the shim (package-shims.ts: that is how a program's imports
 * are typed), so importing the vendored package where it lies would
 * compare the shim with itself. */
const realCopies = mkdtempSync(join(tmpdir(), "scriptc-undici-real-"));
afterAll(() => rmSync(realCopies, { recursive: true, force: true }));

function realEntry(major: number): string {
  const dir = join(realCopies, `declarations-${major}`);
  if (!existsSync(dir)) {
    const installed = join(repoRoot, `tests/fixtures/npm/cases/undici${major}/node_modules/undici`);
    mkdirSync(dir);
    cpSync(join(installed, "index.d.ts"), join(dir, "index.d.ts"));
    cpSync(join(installed, "types"), join(dir, "types"), { recursive: true });
  }
  return dir;
}

/** Drops the shim's implementation members (`__`-prefixed) at every
 * level, so instance types compare by their public API. */
const helpers = `
type Public<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends object
    ? { [K in keyof T as K extends \`__\${string}\` ? never : K]: T[K] }
    : T;
type Assert<T extends true> = T;
type ExpectNever<T extends never> = T;
type Sub<A, B> = [A] extends [B] ? true : false;
`;

function usage(major: number): string {
  return `
import type { Socket } from "node:net";
import { channel } from "node:diagnostics_channel";
import {
  Agent,
  Client,
  Headers,
  Pool,
  buildConnector,
  errors,
  fetch,
  getGlobalDispatcher,
  request,
  setGlobalDispatcher,
} from "UNDICI";
import type { DiagnosticsChannel, Dispatcher } from "UNDICI";

interface TransportOptions {
  connections?: number;
  keepAliveTimeout?: number;
  connect?: buildConnector.BuildOptions;
}

function wrap(options?: buildConnector.BuildOptions) {
  const connect = buildConnector(options ?? {}) as (
    options: buildConnector.Options,
    callback: buildConnector.Callback,
  ) => Socket;
  return (params: buildConnector.Options, callback: buildConnector.Callback) => {
    const socket = connect(params, (error, connected) => {
      if (error) callback(error, null);
      else callback(null, connected);
    });
    socket.once("connect", () => {});
    return socket;
  };
}

class Transport extends Agent {
  private readonly pools: Map<string, Pool>;
  constructor(options: TransportOptions = {}) {
    const pools = new Map<string, Pool>();
    super({
      factory(origin) {
        const pool = new Pool(origin, {
          connect: wrap(options.connect),
          connections: options.connections,
          keepAliveTimeout: options.keepAliveTimeout,
          pipelining: 1,
          interceptors: {
            Client: [
              (dispatch) => (params, handler) => {
                const opaque = (params as Dispatcher.RequestOptions).opaque;
                return opaque === undefined ? dispatch(params, handler) : dispatch(params, handler);
              },
            ],
          },
        });
        pools.set(String(origin), pool);
        return pool;
      },
    });
    this.pools = pools;
  }
  counts(origin: string): number {
    const stats = this.pools.get(origin)?.stats;
    return (stats?.connected ?? 0) + (stats?.free ?? 0) + (stats?.pending ?? 0) +
      (stats?.queued ?? 0) + (stats?.running ?? 0) + (stats?.size ?? 0);
  }
}

class Counting extends Agent {
  count = 0;
  dispatch(options: Dispatcher.DispatchOptions, handler: Dispatcher.${major === 7 ? "DispatchHandler" : "DispatchHandlers"}): boolean {
    this.count++;
    return super.dispatch(options, handler);
  }
}

export async function run(url: string, lookup: import("node:net").LookupFunction): Promise<string> {
  const transport = new Transport({ connections: 2 });
  const response: Dispatcher.ResponseData${major === 7 ? "<unknown>" : ""} = await request(url, {
    dispatcher: transport,
    opaque: { label: "x" },
    body: "payload",
    bodyTimeout: 1000,
    headers: { "x-test": "1", authorization: "Ticket t" },
    headersTimeout: 1000,
    method: "POST",
    signal: AbortSignal.timeout(1000),
  });
  const value = response.headers["content-type"];
  const header = Array.isArray(value) ? value.join(", ") : value === undefined ? null : String(value);
  const status: number = response.statusCode;
  const text: string = await response.body.text();
  const parsed = (await response.body.json()) as { ok: boolean };
  const bytes: ArrayBuffer = await response.body.arrayBuffer();
  response.body.on("error", () => {});
  response.body.destroy();
  const counting = new Counting();
  await counting.close();
  const client = new Client(url, { keepAliveTimeout: 1000, headersTimeout: 1000 });
  await client.destroy();
  const pool = new Pool(url, { connections: 4 });
  const viaPool = await pool.request({ path: "/x", method: "GET", opaque: null });
  const safe = new Agent({ connect: { lookup } });
  const fetched = await fetch(url, {
    dispatcher: safe,
    method: "GET",
    headers: { a: "b" },
    redirect: "manual",
    signal: new AbortController().signal,
  });
  const fetchedText: string = await fetched.text();
  setGlobalDispatcher(transport);
  const global = getGlobalDispatcher();
  let code = "";
  try {
    await request(url);
  } catch (err) {
    if (err instanceof errors.HeadersTimeoutError || err instanceof errors.BodyTimeoutError) code = err.code;
    if (err instanceof errors.UndiciError || err instanceof errors.SocketError) code += "?";
    if (err instanceof errors.RequestAbortedError || err instanceof errors.InvalidArgumentError) code += ".";
  }
  channel("undici:request:headers").subscribe((message) => {
    const m = message as DiagnosticsChannel.RequestHeadersMessage;
    code += m.response.statusCode;
  });
  channel("undici:client:sendHeaders").subscribe((message) => {
    const m = message as DiagnosticsChannel.ClientSendHeadersMessage;
    code += m.headers;
  });
  return [header, status, text, parsed.ok, bytes.byteLength, viaPool.statusCode, fetched.status,
    fetchedText, global === transport, code, transport.counts(url)].join("${major}");
}
`;
}

/** A dispatcher typed by undici-types (what the global fetch's types are
 * made of in a project) handed to something that names only the undici
 * package's `dispatch()`. The two signatures must be related in the
 * direction a caller uses them: the options this package's dispatch()
 * declares are options the other accepts. */
const dispatchOnly = `
import type GlobalDispatcher from "GLOBAL/dispatcher";
import type { Dispatcher } from "UNDICI";

interface Sender {
  dispatch(options: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandlers): boolean;
}

export function sender(from: GlobalDispatcher): Sender {
  return from;
}

// The options dispatch() declares, one member at a time: each takes at
// least what undici-types declare for it, so the options a caller of the
// other dispatcher passes are options this one declares.
type Declared = Dispatcher.DispatchOptions;
type Global = GlobalDispatcher.DispatchOptions;
type SharedKeys = Extract<keyof Declared, keyof Global>;
type _members = ExpectNever<{
  [K in SharedKeys]-?: Sub<Global[K], Declared[K]> extends true ? never : K;
}[SharedKeys]>;
type _options = Assert<Sub<Global, Declared>>;
`;

/** A method held as a string handed to dispatch(), directly and from a
 * subclass's override to the inherited one. undici 7 declares the method
 * as any string; 5.x names nine, and there this is a type error in the
 * package's own declarations. The shim takes any string in both entries
 * (its classes are shared), which is what a program on either release
 * needs to keep compiling. */
const stringMethod = `
import { Agent } from "UNDICI";

// The handler record is named differently in the two releases.
type Handler = Parameters<Agent["dispatch"]>[1];

class Shouting extends Agent {
  dispatch(options: Agent.DispatchOptions, handler: Handler): boolean {
    const upper: string = options.method.toUpperCase();
    return super.dispatch({ ...options, method: upper }, handler);
  }
}

export function send(handler: Handler, verb: string): boolean {
  return new Shouting().dispatch({ origin: "http://127.0.0.1:1", path: "/crate/7", method: verb }, handler);
}
`;

/** The global RequestInit as @types/node 20 declares it (undici-types
 * 5's), spread whole. */
const wholeInit = `
import type { RequestInit as GlobalInit } from "GLOBAL/fetch";
import { fetch, type Dispatcher } from "UNDICI";
import type { Dispatcher as OtherDispatcher } from "OTHER";

interface WrapperInit extends Omit<GlobalInit, "dispatcher"> {
  dispatcher?: Pick<Dispatcher, "dispatch">;
}

export function forWrapper(init: GlobalInit): WrapperInit {
  return { ...init };
}

export function forFetch(url: string, init: GlobalInit): Promise<unknown> {
  return fetch(url, { ...init });
}

export type Both = [Dispatcher, OtherDispatcher];
`;

/** Names the shim declares beyond a version's published declarations,
 * each because undici's runtime has it although its .d.ts does not (5.12's
 * declarations predate several runtime exports and options) or because the
 * shim shares one declaration between the 5.x and 7.x entries. */
const tolerated: Record<number, Record<string, string[]>> = {
  5: {
    // Exported by lib/core/errors.js 5.12, missing from types/errors.d.ts.
    errors: [
      "ConnectTimeoutError",
      "HeadersOverflowError",
      "InvalidReturnValueError",
      "ResponseContentLengthMismatchError",
      "HTTPParserError",
      "BalancedPoolMissingUpstreamError",
    ],
    // 7.x request options in the shared DispatchOptions; 5.12 ignores them.
    // The RequestOptions members ride in DispatchOptions (see core/types.ts).
    // `__framedAsNode` is the shim's own (set by its fetch, read by its client).
    dispatch: [
      "reset",
      "blocking",
      "opaque",
      "signal",
      "onInfo",
      "highWaterMark",
      "__framedAsNode",
    ],
    // Accepted by the 5.12 Client/Pool constructors, undeclared in 5.12.
    options: ["localAddress", "connectTimeout"],
    // 5.12 declares the connector's port as a number; it passes the URL's
    // port string (7.x declares string).
    connector: ["port"],
  },
  7: {
    // lib/core/errors.js 7.30 exports AbortError; types/errors.d.ts omits it.
    errors: ["AbortError"],
    dispatch: ["opaque", "signal", "onInfo", "highWaterMark", "__framedAsNode"],
    options: [],
    connector: [],
  },
};

const union = (names: string[]): string =>
  names.length === 0 ? "never" : names.map((n) => JSON.stringify(n)).join(" | ");

function shape(major: number): string {
  const t = tolerated[major]!;
  return `
import * as real from "REAL";
import * as shim from "SHIM";
import type { Dispatcher as RealDispatcher, DiagnosticsChannel as RealDC } from "REAL";
import type { Dispatcher as ShimDispatcher, DiagnosticsChannel as ShimDC } from "SHIM";

type _values = ExpectNever<Exclude<keyof typeof shim, keyof typeof real>>;
type _errors = ExpectNever<Exclude<keyof typeof shim.errors, keyof typeof real.errors | ${union(t.errors!)}>>;
type SharedErrors = Extract<keyof typeof shim.errors, keyof typeof real.errors>;
type Instance<C> = C extends abstract new (...args: never[]) => infer I ? I : never;
type ErrorFields<I> = Pick<I, Extract<keyof I, "name" | "message" | "code">>;
// The fields the real class declares (5.12 declares no UndiciError.code).
type _errorInstances = ExpectNever<{
  [K in SharedErrors]: Sub<
    ErrorFields<Instance<(typeof real.errors)[K]>>,
    Pick<Instance<(typeof shim.errors)[K]>, keyof ErrorFields<Instance<(typeof real.errors)[K]>>>
  > extends true
    ? never
    : K;
}[SharedErrors]>;

// Records the shim hands to programs: each member of the real record is
// assignable to the shim's.
type RealResponse = RealDispatcher.ResponseData;
type ShimResponse = ShimDispatcher.ResponseData;
type ResponseKeys = Exclude<keyof RealResponse, "body">;
type _responseKeys = ExpectNever<Exclude<ResponseKeys, keyof ShimResponse>>;
type _response = ExpectNever<{
  [K in Extract<ResponseKeys, keyof ShimResponse>]: Sub<RealResponse[K], ShimResponse[K]> extends true ? never : K;
}[Extract<ResponseKeys, keyof ShimResponse>]>;
// The body mixin (the Readable half is node:stream's on both sides).
type BodyApi = "text" | "json" | "arrayBuffer" | "blob" | "bodyUsed" | "dump";
type RealBody = RealResponse["body"];
type ShimBody = ShimResponse["body"];
type _bodyKeys = ExpectNever<Exclude<BodyApi, keyof ShimBody>>;
type _body = ExpectNever<{
  [K in BodyApi]: Sub<RealBody[K], ShimBody[K]> extends true ? never : K;
}[BodyApi]>;
type StatsApi = "connected" | "free" | "pending" | "queued" | "running" | "size";
type _stats = Assert<Sub<Pick<real.Pool["stats"], StatsApi>, Pick<shim.Pool["stats"], StatsApi>>>;
type _headersMessage = Assert<
  Sub<RealDC.RequestHeadersMessage["response"], ShimDC.RequestHeadersMessage["response"]>
>;
type ConnectorKeys = Exclude<keyof real.buildConnector.Options, ${union(t.connector!)}>;
type SharedConnectorKeys = Extract<ConnectorKeys, keyof shim.buildConnector.Options>;
type _connectorOptions = ExpectNever<{
  [K in SharedConnectorKeys]: Sub<real.buildConnector.Options[K], shim.buildConnector.Options[K]> extends true
    ? never
    : K;
}[SharedConnectorKeys]>;
// Option records programs pass in: the shim's accepted options are a subset.
type _dispatchKeys = ExpectNever<
  Exclude<keyof ShimDispatcher.DispatchOptions, keyof RealDispatcher.DispatchOptions | ${union(t.dispatch!)}>
>;
type _clientKeys = ExpectNever<Exclude<keyof shim.Client.Options, keyof real.Client.Options | ${union(t.options!)}>>;
type _poolKeys = ExpectNever<Exclude<keyof shim.Pool.Options, keyof real.Pool.Options | ${union(t.options!)}>>;
// Class APIs: every public member the shim declares exists on the real class.
type _agentApi = ExpectNever<Exclude<keyof Public<shim.Agent>, keyof real.Agent>>;
type _poolApi = ExpectNever<Exclude<keyof Public<shim.Pool>, keyof real.Pool>>;
type _clientApi = ExpectNever<Exclude<keyof Public<shim.Client>, keyof real.Client>>;
`;
}

/** The diagnostics of one program, checked by the TypeScript 7 checker. */
function check(name: string, text: string): string[] {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-undici-shim-types-"));
  const file = join(dir, name);
  writeFileSync(file, text);
  const program = createProgram([file], {
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    allowImportingTsExtensions: true,
    module: ad.ModuleKind.ESNext as number,
    moduleResolution: ad.ModuleResolutionKind.Bundler as number,
    target: ad.ScriptTarget.ES2022 as number,
    lib: ["lib.es2023.d.ts"],
    types: ["node"],
    typeRoots: [join(repoRoot, "node_modules/@types")],
  });
  try {
    return getPreEmitDiagnostics(program).map((d) => `${d.fileName ?? ""}:${d.pos} ${d.text}`);
  } finally {
    program.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
}

describe.each([5, 7])("undici %i.x shim types", (major) => {
  const real = realEntry(major);
  const shim = join(shimRoot, `v${major}.ts`);

  // MockAgent is declared by the package and not by the shim: the two
  // sides of every check below are different declarations.
  test("the real declarations are the package's own", () => {
    const names = 'import { MockAgent } from "UNDICI";\nexport const mock = MockAgent;\n';
    expect(check("names-real.ts", names.replace(/UNDICI/g, real))).toEqual([]);
    expect(check("names-shim.ts", names.replace(/UNDICI/g, shim))).toHaveLength(1);
  });

  test("a program written against undici type-checks against the real declarations", () => {
    expect(check("usage-real.ts", helpers + usage(major).replace(/UNDICI/g, real))).toEqual([]);
  });

  test("the same program type-checks against the shim", () => {
    expect(check("usage-shim.ts", helpers + usage(major).replace(/UNDICI/g, shim))).toEqual([]);
  });

  // undici-types 5 names nine methods and the 5.x entry declares the
  // same; 5.x is the package a project on @types/node 20 has beside
  // undici 5.
  test.runIf(major === 5)(
    "a dispatcher typed by undici-types 5 fits something that names the package's dispatch()",
    () => {
      const program = helpers + dispatchOnly.replace(/GLOBAL/g, globalTypes5);
      expect(check("dispatch-only-real.ts", program.replace(/UNDICI/g, real))).toEqual([]);
      expect(check("dispatch-only-shim.ts", program.replace(/UNDICI/g, shim))).toEqual([]);
    },
  );

  test("a method held as a string goes to dispatch()", () => {
    const onReal = check("string-method-real.ts", stringMethod.replace(/UNDICI/g, real));
    expect(check("string-method-shim.ts", stringMethod.replace(/UNDICI/g, shim))).toEqual([]);
    if (major === 7) expect(onReal).toEqual([]);
    else {
      expect(onReal).toHaveLength(2);
      for (const d of onReal) expect(d).toContain("Type 'string' is not assignable to type");
    }
  });

  // The call a project on @types/node 20 makes: the global RequestInit
  // (there, undici-types 5's) spread whole into a wrapper's init that
  // names this package's dispatch(), and into the package's fetch. Both
  // entries are in the program, as they are in a project that holds both
  // releases: neither changes what the other declares.
  test("the global RequestInit of undici-types 5 fits the package's dispatch() and fetch()", () => {
    const other = join(shimRoot, `v${major === 5 ? 7 : 5}.ts`);
    const program = wholeInit
      .replace(/GLOBAL/g, globalTypes5)
      .replace(/UNDICI/g, shim)
      .replace(/OTHER/g, other);
    expect(check("whole-init-shim.ts", program)).toEqual([]);
  });

  test("the shim's exports and records are a compatible subset", () => {
    const text = helpers + shape(major).replace(/REAL/g, real).replace(/SHIM/g, shim);
    expect(check("shape.ts", text)).toEqual([]);
  });
});
