// @hono/node-server 2.x (compiled from scriptc's built-in implementation)
// serving a fetch handler: a raw HTTP client prints each exchange's status
// line, wire-order headers (Date dropped) and body, covering buffered and
// streamed bodies, header forms, cookies, request bodies, URL handling,
// HEAD, empty statuses, handler errors, a client that disconnects during
// a streamed body, and request bodies the handler reads, leaves unread or
// rejects while the upload is still arriving.
import * as http from "node:http";
import * as net from "node:net";
import type { AddressInfo } from "node:net";
import { getRequestListener, RequestError, serve } from "@hono/node-server";

function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

function slowStream(parts: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let index = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      await delay(5);
      if (index < parts.length) controller.enqueue(encoder.encode(parts[index++]!));
      else controller.close();
    },
  });
}

function readyStream(parts: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of parts) controller.enqueue(encoder.encode(part));
      controller.close();
    },
  });
}

// A stream that produces until it is cancelled (bounded, so a missed cancel
// ends the program instead of hanging it).
let reportCancel: (reason: string) => void = () => {};
const endlessCancelled = new Promise<string>((resolve) => {
  reportCancel = resolve;
});
function endlessStream(): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let pulls = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      await delay(5);
      if (++pulls > 400) controller.close();
      else controller.enqueue(encoder.encode("tick\n"));
    },
    cancel(reason) {
      reportCancel(`cancelled with ${String(reason)}`);
    },
  });
}

async function handler(request: Request): Promise<Response> {
  const url = new URL(request.url);
  switch (url.pathname) {
    case "/echo": {
      const body = await request.text();
      const headers = new Headers({ "content-type": "application/json" });
      headers.set("x-echo", "yes");
      return new Response(
        JSON.stringify({
          method: request.method,
          url: request.url.replace(/:\d+\//, ":PORT/"),
          type: request.headers.get("content-type"),
          agent: request.headers.get("x-agent"),
          body,
        }),
        { status: 201, headers },
      );
    }
    case "/headers-object": {
      const headers = new Headers();
      headers.set("x-b", "2");
      headers.set("X-A", "1");
      headers.set("content-type", "text/html; charset=utf-8");
      return new Response("<p>hi</p>", { status: 202, headers });
    }
    case "/cookies": {
      const headers = new Headers();
      headers.append("set-cookie", "a=1; Path=/");
      headers.set("x-before", "b");
      headers.append("set-cookie", "b=2; HttpOnly");
      headers.set("content-type", "text/plain");
      return new Response("cookies", { headers });
    }
    case "/no-content":
      return new Response(null, { status: 204, headers: new Headers({ "x-empty": "1" }) });
    case "/declared-length": {
      const headers = new Headers({ "content-length": "5", "content-type": "text/plain" });
      return new Response("12345", { headers });
    }
    case "/ready-stream": {
      const headers = new Headers({ "content-type": "text/plain" });
      return new Response(readyStream(["one ", "two"]), { headers });
    }
    case "/slow-stream": {
      const headers = new Headers({ "content-type": "application/x-ndjson" });
      return new Response(slowStream(['{"n":1}\n', '{"n":2}\n', '{"n":3}\n']), { headers });
    }
    case "/chunked-stream": {
      const headers = new Headers({ "content-type": "text/event-stream", "transfer-encoding": "chunked" });
      return new Response(readyStream(["data: a\n\n", "data: b\n\n"]), { headers });
    }
    case "/bytes": {
      const headers = new Headers({ "content-type": "application/octet-stream" });
      return new Response(new Uint8Array([104, 105, 33]), { headers });
    }
    case "/null-body": {
      return new Response(null, { status: 404, headers: new Headers({ "x-missing": "yes" }) });
    }
    case "/reject":
      throw new Error("handler failed");
    case "/light-text":
      return new Response("light");
    case "/light-record":
      return new Response("rec", { status: 201, headers: { "X-Custom": "a", "Content-Type": "text/html" } });
    case "/light-json":
      return Response.json({ ok: true, n: [1, 2] });
    case "/light-json-headers":
      return Response.json({ ok: true }, { status: 201, headers: { "X-Test": "yes" } });
    case "/light-json-typed":
      return Response.json([1], { headers: { "Content-Type": "application/vnd.test+json" } });
    case "/endless":
      return new Response(endlessStream(), { headers: new Headers({ "content-type": "text/plain" }) });
    case "/light-touched": {
      const r = new Response("touched");
      r.headers.set("x-touched", "1");
      return r;
    }
    case "/light-record-touched": {
      const r = new Response("rt", { headers: { "X-Rec": "1" } });
      r.headers.append("x-more", "2");
      return r;
    }
    case "/materialized": {
      const r = new Response("m", { headers: { "X-M": "1" } });
      return new Response(r.body, r);
    }
    case "/light-stream":
      return new Response(readyStream(["s1 ", "s2"]));
    case "/light-null":
      return new Response(null, { status: 202 });
    case "/light-length":
      return new Response("abc", { headers: { "Content-Length": "3" } });
    case "/light-bytes":
      return new Response(new Uint8Array([111, 107]));
    default: {
      const headers = new Headers({ "content-type": "text/plain; charset=UTF-8" });
      return new Response(`path ${url.pathname}${url.search}`, { headers });
    }
  }
}

interface Exchange {
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: string;
}

function exchange(port: number, ex: Exchange): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const headers: Record<string, string> = { ...(ex.headers ?? {}) };
    if (ex.body !== undefined) headers["content-length"] = String(Buffer.byteLength(ex.body));
    const req = http.request(
      { host: "127.0.0.1", port, method: ex.method, path: ex.path, headers: headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => {
          chunks.push(chunk);
        });
        res.on("end", () => {
          const lines: string[] = [`HTTP/${res.httpVersion} ${res.statusCode} ${res.statusMessage}`];
          for (let i = 0; i < res.rawHeaders.length; i += 2) {
            const name = res.rawHeaders[i]!;
            if (name.toLowerCase() === "date") continue;
            lines.push(`${name}: ${res.rawHeaders[i + 1]}`);
          }
          resolve(`### ${ex.method} ${ex.path}\n${lines.join("\n")}\n\n${Buffer.concat(chunks).toString("utf8")}\n`);
        });
      },
    );
    req.on("error", reject);
    if (ex.body !== undefined) req.write(ex.body);
    req.end();
  });
}

const exchanges: Exchange[] = [
  { method: "GET", path: "/plain?q=1" },
  { method: "POST", path: "/echo", headers: { "content-type": "text/plain", "x-agent": "probe" }, body: "payload body" },
  { method: "PUT", path: "/echo", headers: { "content-type": "application/json" }, body: '{"k":[1,2]}' },
  { method: "GET", path: "/headers-object" },
  { method: "GET", path: "/cookies" },
  { method: "GET", path: "/no-content" },
  { method: "GET", path: "/declared-length" },
  { method: "GET", path: "/ready-stream" },
  { method: "GET", path: "/slow-stream" },
  { method: "GET", path: "/chunked-stream" },
  { method: "GET", path: "/bytes" },
  { method: "GET", path: "/null-body" },
  { method: "HEAD", path: "/plain" },
  { method: "GET", path: "/light-text" },
  { method: "HEAD", path: "/light-text" },
  { method: "GET", path: "/light-record" },
  { method: "HEAD", path: "/light-record" },
  { method: "GET", path: "/light-json" },
  { method: "GET", path: "/light-json-headers" },
  { method: "GET", path: "/light-json-typed" },
  { method: "GET", path: "/light-touched" },
  { method: "GET", path: "/light-record-touched" },
  { method: "GET", path: "/materialized" },
  { method: "GET", path: "/light-stream" },
  { method: "GET", path: "/light-null" },
  { method: "GET", path: "/light-length" },
  { method: "GET", path: "/light-bytes" },
  { method: "GET", path: "/reject" },
  { method: "GET", path: "/a/../b/./c?x=%20y" },
  { method: "GET", path: "/upper", headers: { host: "Example.COM:8080" } },
  { method: "GET", path: "/bad-host", headers: { host: "bad host" } },
  { method: "get", path: "/lower-method" },
];

/** Reads the first chunk of /endless, then destroys the response: the
 * server cancels the response's stream. */
function disconnectMidStream(port: number): Promise<string> {
  return new Promise<string>((resolve) => {
    const req = http.request({ host: "127.0.0.1", port, method: "GET", path: "/endless" }, (res) => {
      res.once("data", () => {
        res.destroy();
      });
    });
    req.end();
    const timeout = new Promise<string>((done) => {
      setTimeout(() => done("not cancelled"), 3000);
    });
    void Promise.race([endlessCancelled, timeout]).then((outcome) => {
      resolve(`### disconnect GET /endless\n${outcome}\n`);
    });
  });
}

const server = serve({ fetch: handler, port: 0, hostname: "127.0.0.1" }, (info: AddressInfo) => {
  console.log("listening", info.family, info.address, typeof info.port);
  void (async () => {
    for (const ex of exchanges) console.log(await exchange(info.port, ex));
    console.log(await disconnectMidStream(info.port));
    server.close(() => {
      console.log("closed");
      startSecond();
    });
  })();
});

// getRequestListener with an error handler, on a plain node:http server.
const listener = getRequestListener(
  async (request) => {
    if (request.url.endsWith("/fail")) throw new RequestError("listener failure");
    return new Response("ok", { headers: new Headers({ "content-type": "text/plain" }) });
  },
  {
    errorHandler: (err) =>
      new Response(`handled: ${err instanceof Error ? `${err.name} ${err.message}` : "?"}`, {
        status: 503,
        headers: new Headers({ "content-type": "text/plain" }),
      }),
  },
);
function startSecond(): void {
  const second = http.createServer((req, res) => {
    void listener(req, res);
  });
  second.listen(0, "127.0.0.1", () => {
    const port = (second.address() as AddressInfo).port;
    void (async () => {
      console.log(await exchange(port, { method: "GET", path: "/ok" }));
      console.log(await exchange(port, { method: "GET", path: "/fail" }));
      second.close(() => {
        console.log("second closed");
        startUploads();
      });
    })();
  });
}

// Request bodies stream to the handler. /size reads the whole body. The
// other routes leave it unread: /unread answers at once (the package's
// cached-response path) and /unread-async through a promise, and /reject
// answers 413 after 300 ms while the client keeps uploading, so the server
// must stop reading the socket.
const MiB = 1024 * 1024;

interface UploadResult {
  status: string;
  body: string;
  sentBeforeResponse: number;
}

/** A chunked POST over a raw socket: 64 KiB chunks, each written after
 * the previous write's callback, until `limit` bytes are out (then the
 * last chunk, when `finish` is set) or the response arrives. */
function chunkedUpload(port: number, path: string, limit: number, finish: boolean): Promise<UploadResult> {
  return new Promise<UploadResult>((resolve) => {
    const socket = net.connect(port, "127.0.0.1");
    const frame = Buffer.concat([Buffer.from("10000\r\n"), Buffer.alloc(65536, 97), Buffer.from("\r\n")]);
    let sent = 0;
    let sentBeforeResponse = -1;
    let response = "";
    let settled = false;
    const settle = (): void => {
      if (settled) return;
      settled = true;
      const headEnd = response.indexOf("\r\n\r\n");
      const status = response.slice(0, response.indexOf("\r\n"));
      resolve({ status, body: headEnd < 0 ? "" : response.slice(headEnd + 4), sentBeforeResponse });
      socket.destroy();
    };
    const writeNext = (): void => {
      if (sentBeforeResponse >= 0 || socket.destroyed) return;
      if (sent >= limit) {
        if (finish) socket.write("0\r\n\r\n");
        return;
      }
      sent += 65536;
      socket.write(frame, () => {
        writeNext();
      });
    };
    socket.on("connect", () => {
      socket.write(`POST ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nTransfer-Encoding: chunked\r\n\r\n`);
      writeNext();
    });
    socket.on("data", (chunk: Buffer) => {
      response += chunk.toString("latin1");
      if (sentBeforeResponse < 0 && response.includes("\r\n\r\n")) sentBeforeResponse = sent;
      const match = /content-length: (\d+)/i.exec(response);
      const headEnd = response.indexOf("\r\n\r\n");
      if (match !== null && headEnd >= 0 && response.length - headEnd - 4 >= Number(match[1])) settle();
    });
    socket.on("error", () => settle());
    socket.on("close", () => settle());
  });
}

function startUploads(): void {
  const server = serve(
    {
      fetch: (request: Request): Response | Promise<Response> => {
        const url = new URL(request.url);
        if (url.pathname === "/size")
          return request.arrayBuffer().then((body) => new Response(`size ${body.byteLength}`));
        if (url.pathname === "/reject")
          return delay(300).then(() => new Response("too large", { status: 413 }));
        if (url.pathname === "/unread-async") return Promise.resolve(new Response("unread async"));
        return new Response(`unread ${url.pathname}`);
      },
      port: 0,
      hostname: "127.0.0.1",
    },
    (info: AddressInfo) => {
      void (async () => {
        const read = await chunkedUpload(info.port, "/size", 3 * MiB, true);
        console.log(`### chunked POST /size\n${read.status}\n${read.body}\n`);
        console.log(await exchange(info.port, { method: "POST", path: "/unread", body: "x".repeat(300000) }));
        console.log(await exchange(info.port, { method: "GET", path: "/after-unread" }));
        console.log(await exchange(info.port, { method: "POST", path: "/unread-async", body: "y".repeat(300000) }));
        console.log(await exchange(info.port, { method: "GET", path: "/after-unread-async" }));
        const before = process.memoryUsage().rss;
        const rejected = await chunkedUpload(info.port, "/reject", 512 * MiB, false);
        const grown = process.memoryUsage().rss - before;
        console.log(`### chunked POST /reject\n${rejected.status}\n${rejected.body}`);
        console.log("client stopped before 32 MiB:", rejected.sentBeforeResponse >= 0 && rejected.sentBeforeResponse < 32 * MiB);
        console.log("server memory grew under 64 MiB:", grown < 64 * MiB);
        server.close(() => console.log("uploads closed"));
      })();
    },
  );
}
