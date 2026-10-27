// undici 7.x through scriptc's built-in implementation: the native build
// compiles the package's shim in place of the vendored undici the Node side
// loads. Covers request(), Agent/Pool/Client, a transport-style Agent
// subclass (per-origin pool factory, wrapped connector, client
// interceptors, pool stats), dispatch overrides, keep-alive reuse, error
// classes and codes, and the diagnostics_channel request lifecycle.
import { channel } from "node:diagnostics_channel";
import * as http from "node:http";
import type { Socket } from "node:net";
import {
  Agent,
  Client,
  Pool,
  Headers,
  buildConnector,
  errors,
  fetch,
  getGlobalDispatcher,
  request,
  setGlobalDispatcher,
} from "undici";
import type { Dispatcher } from "undici";
import { checkPeers } from "./peers.ts";

const server = http.createServer((req, res) => {
  const url = req.url ?? "/";
  if (url === "/json") {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, n: 3 }));
  } else if (url === "/cookies") {
    res.setHeader("set-cookie", ["a=1", "b=2"]);
    res.end("cookies");
  } else if (url === "/slow") {
    setTimeout(() => res.end("late"), 1500);
  } else if (url === "/stall-body") {
    // Part of a body that never ends.
    res.writeHead(200, { "content-type": "text/plain" });
    res.write("part");
  } else if (url === "/trace") {
    res.end(`x-trace ${req.headers["x-trace"] ?? "-"}`);
  } else if (url === "/missing") {
    res.statusCode = 404;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: "not found" }));
  } else if (url === "/chunked") {
    res.write("part1,");
    setTimeout(() => res.end("part2"), 10);
  } else if (url === "/redirect") {
    res.statusCode = 302;
    res.setHeader("location", "/hello");
    res.end();
  } else if (url === "/echo") {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on("end", () => {
      const test = req.headers["x-test"];
      const length = req.headers["content-length"];
      const shown = (v: string | string[] | undefined): string => (typeof v === "string" ? v : "-");
      res.end(`${req.method} ${shown(test)} ${shown(length)} ${body}`);
    });
  } else {
    res.end(`hello ${req.method} ${url}`);
  }
});

const turn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

interface Telemetry {
  label: string;
  dispatched: number;
}

let current: Telemetry | null = null;
const byRequest = new WeakMap<object, Telemetry>();

channel("undici:request:create").subscribe((message) => {
  const { request } = message as { request: object };
  if (current !== null) byRequest.set(request, current);
  // Read as an untyped value, as a JavaScript instrumentation reads it.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const traced: any = request;
  if (traced.path === "/trace") {
    // A tracing instrumentation's header injection.
    console.log(`  [diag] create completed ${traced.completed}, ${typeof traced.addHeader}`);
    console.log(`  [diag] addHeader returns the request: ${traced.addHeader("x-trace", "span-1") === request}`);
    console.log(`  [diag] headers ${JSON.stringify(traced.headers)}`);
    try {
      traced.addHeader("x-bad", "a\r\nb");
    } catch (err) {
      console.log(`  [diag] invalid header: ${describe(err)}`);
    }
    tracedRequests.add(request);
  }
});
const tracedRequests = new Set<object>();
channel("undici:request:trailers").subscribe((message) => {
  const { request } = message as { request: object };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const traced: any = request;
  if (tracedRequests.has(request)) console.log(`  [diag] trailers completed ${traced.completed}`);
});
channel("undici:request:headers").subscribe((message) => {
  const { request, response } = message as {
    request: object;
    response: { statusCode: number };
  };
  const t = byRequest.get(request);
  if (t !== undefined) console.log(`  [diag] ${t.label} headers ${response.statusCode}`);
});
channel("undici:request:trailers").subscribe((message) => {
  const { request } = message as { request: object };
  const t = byRequest.get(request);
  if (t !== undefined) console.log(`  [diag] ${t.label} done after ${t.dispatched} dispatch`);
});

// A transport's connection registry: sockets the wrapped connector dialed,
// keyed weakly, and the client diagnostics messages that carry them.
const dialed = new WeakMap<Socket, number>();
const clientDiag = { beforeConnect: 0, connector: 0, connected: 0, sendHeaders: 0, known: 0, unknown: 0 };
const noteSocket = (socket: Socket): void => {
  const n = dialed.get(socket);
  if (n === undefined) clientDiag.unknown++;
  else clientDiag.known++;
};
channel("undici:client:beforeConnect").subscribe((message) => {
  const { connector } = message as { connector: unknown };
  clientDiag.beforeConnect++;
  if (typeof connector === "function") clientDiag.connector++;
});
channel("undici:client:connected").subscribe((message) => {
  const { socket, connectParams } = message as {
    socket: Socket;
    connectParams: { protocol: string; hostname: string };
  };
  clientDiag.connected++;
  if (connectParams.protocol === "http:" && connectParams.hostname === "127.0.0.1") noteSocket(socket);
});
channel("undici:client:sendHeaders").subscribe((message) => {
  const { socket, headers } = message as { socket: Socket; headers: string };
  clientDiag.sendHeaders++;
  if (headers.length > 0) noteSocket(socket);
});

/** A transport-style Agent: one Pool per origin built by the factory, a
 * wrapped connector, and a Client interceptor that marks dispatches. */
class TracingAgent extends Agent {
  readonly origins: Map<string, Pool>;
  connections = 0;

  constructor(maxConnections: number) {
    const origins = new Map<string, Pool>();
    const connect = buildConnector({}) as (
      options: buildConnector.Options,
      callback: buildConnector.Callback,
    ) => Socket;
    let opened = 0;
    super({
      factory(origin) {
        const pool = new Pool(origin, {
          connections: maxConnections,
          keepAliveTimeout: 10_000,
          pipelining: 1,
          connect(options, callback) {
            opened++;
            const socket = connect(options, callback);
            dialed.set(socket, opened);
            return socket;
          },
          interceptors: {
            Client: [
              (dispatch) => (params, handler) => {
                const t = (params as Dispatcher.RequestOptions).opaque;
                if (t !== null && typeof t === "object") {
                  const tel = t as Telemetry;
                  tel.dispatched++;
                  const previous = current;
                  current = tel;
                  try {
                    return dispatch(params, handler);
                  } finally {
                    current = previous;
                  }
                }
                return dispatch(params, handler);
              },
            ],
          },
        });
        origins.set(String(origin), pool);
        return pool;
      },
    });
    this.origins = origins;
    this.on("connect", () => {
      this.connections = opened;
    });
  }

  statsFor(origin: string): string {
    const pool = this.origins.get(origin);
    if (pool === undefined) return "no pool";
    const s = pool.stats;
    return `connected=${s.connected} free=${s.free} pending=${s.pending} queued=${s.queued} running=${s.running} size=${s.size}`;
  }
}

/** A subclass that overrides dispatch and forwards to the base Agent. */
class CountingAgent extends Agent {
  count = 0;
  paths: string[] = [];
  dispatch(options: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandlers): boolean {
    this.count++;
    this.paths.push(`${options.method} ${options.path}`);
    return super.dispatch(options, handler);
  }
}

function describe(err: unknown): string {
  if (err instanceof errors.UndiciError) return `${err.name} ${err.code} ${err.message}`;
  if (err instanceof DOMException) return `${err.name} ${err.message}`;
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code ?? "";
    return `${err.name} ${code} ${err.message}`;
  }
  return String(err);
}

server.listen(0, "127.0.0.1", async () => {
  const address = server.address();
  const port = address !== null && typeof address === "object" ? address.port : 0;
  const origin = `http://127.0.0.1:${port}`;

  console.log("== request() through a TracingAgent");
  const agent = new TracingAgent(2);
  const tel: Telemetry = { label: "hello", dispatched: 0 };
  const res = await request(`${origin}/hello`, { dispatcher: agent, opaque: tel });
  console.log(res.statusCode, res.statusText, res.headers["content-length"], await res.body.text());
  console.log("opaque passthrough:", res.opaque === tel);
  const json = await request(`${origin}/json`, { dispatcher: agent });
  const data = (await json.body.json()) as { ok: boolean; n: number };
  console.log("json:", data.ok, data.n, json.headers["content-type"]);
  const cookies = await request(`${origin}/cookies`, { dispatcher: agent });
  const setCookie = cookies.headers["set-cookie"];
  console.log("set-cookie:", Array.isArray(setCookie) ? setCookie.join("|") : setCookie);
  await cookies.body.text();
  const chunked = await request(`${origin}/chunked`, { dispatcher: agent });
  console.log("chunked:", chunked.headers["transfer-encoding"], await chunked.body.text());
  const echo = await request(`${origin}/echo`, {
    dispatcher: agent,
    body: "payload",
    headers: { "x-test": "yes" },
  });
  console.log("default method with a body:", await echo.body.text());
  const ab = await request(`${origin}/hello`, { dispatcher: agent, method: "POST" });
  console.log("arrayBuffer bytes:", (await ab.body.arrayBuffer()).byteLength);

  console.log("== keep-alive reuse");
  for (let i = 0; i < 4; i++) {
    const r = await request(`${origin}/r${i}`, { dispatcher: agent });
    await r.body.text();
  }
  console.log("connections opened:", agent.connections);
  console.log(
    `client diagnostics: ${clientDiag.beforeConnect} before connect (${clientDiag.connector} with a connector), ${clientDiag.connected} connected, ${clientDiag.sendHeaders} send headers; ${clientDiag.known} carry a dialed socket, ${clientDiag.unknown} another`,
  );
  console.log("stats:", agent.statsFor(origin));

  console.log("== Pool with a connection limit");
  const pool = new Pool(origin, { connections: 2 });
  const inflight: Promise<string>[] = [];
  for (let i = 0; i < 4; i++) {
    inflight.push(
      pool.request({ path: `/p${i}`, method: "GET" }).then((r) => r.body.text()),
    );
  }
  console.log("queued while busy:", pool.stats.queued, "size:", pool.stats.size);
  console.log((await Promise.all(inflight)).join(", "));
  await pool.close();
  console.log("pool closed:", pool.closed, pool.destroyed);

  console.log("== Client");
  const client = new Client(origin);
  const cr = await client.request({ path: "/client", method: "GET" });
  console.log(cr.statusCode, await cr.body.text());
  await client.close();

  console.log("== connect.lookup");
  const looked: string[] = [];
  const pinned = new Agent({
    connect: {
      lookup(hostname, _options, callback) {
        looked.push(hostname);
        callback(null, [{ address: "127.0.0.1", family: 4 }]);
      },
    },
  });
  const viaLookup = await request(`http://pinned.invalid:${port}/lookup`, { dispatcher: pinned });
  console.log(viaLookup.statusCode, await viaLookup.body.text(), looked.join(","));
  await pinned.close();

  console.log("== dispatch override");
  const counting = new CountingAgent();
  for (const path of ["/a", "/b"]) {
    const r = await request(`${origin}${path}`, { dispatcher: counting });
    await r.body.text();
  }
  console.log("dispatched:", counting.count, counting.paths.join(", "));
  await counting.close();

  console.log("== diagnostics channel lifecycle");
  const traced: Telemetry = { label: "traced", dispatched: 0 };
  const tr = await request(`${origin}/traced`, { dispatcher: agent, opaque: traced });
  await tr.body.text();

  console.log("== errors");
  try {
    await request("http://127.0.0.1:1/refused", {});
  } catch (err) {
    console.log("refused:", describe(err));
  }
  try {
    await request(`${origin}/slow`, { dispatcher: agent, headersTimeout: 100 });
  } catch (err) {
    console.log("headers timeout:", describe(err));
  }
  const controller = new AbortController();
  const pending = request(`${origin}/slow`, { dispatcher: agent, signal: controller.signal });
  setTimeout(() => controller.abort(), 50);
  try {
    await pending;
  } catch (err) {
    console.log("abort:", describe(err));
  }
  try {
    await request(`${origin}/missing`, { dispatcher: agent, throwOnError: true });
  } catch (err) {
    console.log("throwOnError:", describe(err));
  }
  const notFound = await request(`${origin}/missing`, { dispatcher: agent });
  console.log("404 without throwOnError:", notFound.statusCode, await notFound.body.text());
  try {
    await request("ftp://127.0.0.1/x", {});
  } catch (err) {
    console.log("protocol:", describe(err));
  }
  const hostAgent = new Agent();
  try {
    await request(`${origin}/hello`, { dispatcher: hostAgent, headers: { host: "a\r\nx-injected: 1" } });
  } catch (err) {
    console.log("host header:", describe(err));
  }
  await hostAgent.close();
  const early = await request(`${origin}/hello`, { dispatcher: agent });
  early.body.on("error", (err: Error) => console.log("destroyed body:", describe(err)));
  early.body.destroy();
  await turn();
  console.log("instanceof:", new errors.HeadersTimeoutError() instanceof errors.UndiciError);

  console.log("== controller-API handler");
  await new Promise<void>((resolve) => {
    agent.dispatch(
      { origin, path: "/controller", method: "GET" },
      {
        onRequestStart(controller) {
          console.log("start, aborted:", controller.aborted);
        },
        onResponseStart(_controller, statusCode, headers) {
          console.log("response", statusCode, headers["content-length"]);
        },
        onResponseData(_controller, chunk) {
          console.log("data", chunk.toString());
        },
        onResponseEnd() {
          console.log("end");
          resolve();
        },
        onResponseError(_controller, err) {
          console.log("error", describe(err));
          resolve();
        },
      },
    );
  });

  console.log("== diagnostics request headers");
  const trace = await request(`${origin}/trace`, { dispatcher: agent });
  console.log("traced body:", await trace.body.text());

  console.log("== body timeout after a pause");
  const stallAgent = new Agent();
  await new Promise<void>((resolve) => {
    stallAgent.dispatch(
      { origin, path: "/stall-body", method: "GET", bodyTimeout: 100 },
      {
        onRequestStart() {},
        onResponseStart(controller, statusCode) {
          // Paused past bodyTimeout, then resumed: the timeout applies again.
          console.log("paused response", statusCode);
          controller.pause();
          setTimeout(() => controller.resume(), 1500);
        },
        onResponseData() {},
        onResponseEnd() {
          console.log("stalled body ended");
          resolve();
        },
        onResponseError(_controller, err) {
          console.log("stalled body:", describe(err));
          resolve();
        },
      },
    );
  });
  await stallAgent.close();

  console.log("== fetch");
  const viaAgent = await fetch(`${origin}/json`, { dispatcher: agent });
  console.log("through agent:", viaAgent.status, viaAgent.statusText, viaAgent.headers.get("content-type"), await viaAgent.text());
  const echoed = await fetch(`${origin}/echo`, {
    dispatcher: agent,
    method: "POST",
    body: "fetched",
    headers: new Headers({ "x-test": "fetch" }),
  });
  console.log("post through agent:", await echoed.text());
  const direct = await fetch(`${origin}/hello`);
  console.log("without dispatcher:", direct.status, await direct.text());
  const manual = await fetch(`${origin}/redirect`, { dispatcher: agent, redirect: "manual" });
  console.log("manual redirect:", manual.status, manual.headers.get("location"));
  await manual.text();
  const followed = await fetch(`${origin}/redirect`, { dispatcher: agent });
  console.log("followed redirect:", followed.status, await followed.text());
  try {
    await fetch("http://127.0.0.1:1/refused", { dispatcher: agent });
  } catch (err) {
    const cause = (err as Error).cause;
    console.log("fetch refused:", describe(err), "cause:", describe(cause));
  }
  const fetchAbort = new AbortController();
  const slowFetch = fetch(`${origin}/slow`, { dispatcher: agent, signal: fetchAbort.signal });
  setTimeout(() => fetchAbort.abort(), 50);
  try {
    await slowFetch;
  } catch (err) {
    console.log("fetch abort:", describe(err));
  }
  const h = new Headers([["a", "1"]]);
  h.append("A", "2");
  console.log("Headers:", h.get("a"));

  console.log("== global dispatcher");
  setGlobalDispatcher(counting);
  console.log("global is counting:", getGlobalDispatcher() === counting);

  await agent.close();
  server.close();
  await checkPeers();
  console.log("done");
});
