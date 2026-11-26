/* The undici shim's stream and proxy surface, run as ordinary TypeScript
 * under Node (the shim is the program the compiler would build): an
 * async-iterable request body is written with chunked framing, a response
 * body is async-iterable, and EnvHttpProxyAgent keeps a NO_PROXY host off
 * the proxy. The native build is covered by the npm differential cases;
 * these are the checks that need no toolchain. */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { afterAll, beforeAll, expect, test } from "vitest";
import { ProxyAgent as CoreProxyAgent } from "../shims/undici/core/proxy-agent.ts";
import { BodyReadable } from "../shims/undici/core/readable.ts";
import { Client, EnvHttpProxyAgent, request } from "../shims/undici/v7.ts";

let server: Server;
let origin = "";
/** How many request heads the server has read; a content-length mismatch
 * must destroy the connection rather than send a second request. */
let requests = 0;

beforeAll(async () => {
  server = createServer((req, res) => {
    requests += 1;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const length = req.headers["content-length"];
      const encoding = req.headers["transfer-encoding"];
      if (req.url === "/early") {
        // Answer before the upload finishes, and keep draining the body so
        // the connection stays usable from the server's side: a client that
        // reused it would write the next request into the unfinished body.
        req.resume();
        res.writeHead(413, { "content-type": "text/plain" });
        res.end("too big");
        return;
      }
      if (req.url === "/chunks") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.write("one,");
        setTimeout(() => res.end("two"), 10);
        return;
      }
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(`${req.method} ${String(encoding ?? "-")} ${String(length ?? "-")} ${body}`);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function* chunks(): Generator<string> {
  yield "ab";
  yield "cd";
}

test("an async-iterable body is written with chunked framing", async () => {
  const client = new Client(origin);
  const res = await client.request({
    path: "/echo",
    method: "POST",
    body: Readable.from(chunks()),
  });
  expect(await res.body.text()).toBe("POST chunked - abcd");
  await client.close();
});

test("a declared content length frames the streamed body without chunking", async () => {
  const client = new Client(origin);
  const res = await client.request({
    path: "/echo",
    method: "POST",
    headers: { "content-length": "4" },
    body: Readable.from(chunks()),
  });
  expect(await res.body.text()).toBe("POST - 4 abcd");
  await client.close();
});

test("a response body iterates chunk by chunk", async () => {
  const client = new Client(origin);
  const res = await client.request({ path: "/chunks", method: "GET" });
  const seen: string[] = [];
  for await (const chunk of res.body) seen.push(chunk.toString("utf8"));
  expect(seen.join("")).toBe("one,two");
  expect(seen.length).toBeGreaterThan(0);
  await client.close();
});

test("leaving the loop early destroys the body", async () => {
  const client = new Client(origin);
  const res = await client.request({ path: "/chunks", method: "GET" });
  for await (const chunk of res.body) {
    expect(chunk.length).toBeGreaterThan(0);
    break;
  }
  expect(res.body.destroyed).toBe(true);
  await client.close();
});

test("EnvHttpProxyAgent keeps a NO_PROXY host off the proxy", async () => {
  const dispatcher = new EnvHttpProxyAgent({
    httpProxy: "http://127.0.0.1:1",
    noProxy: "127.0.0.1",
  });
  expect(dispatcher.__agentForURL(new URL(origin))).toBe(dispatcher.__noProxyAgent);
  // The dead proxy would refuse the request; the bypass reaches the server.
  const res = await request(`${origin}/hello`, { method: "GET", dispatcher });
  expect(await res.body.text()).toBe("GET - - ");
  await dispatcher.close();
});

test("EnvHttpProxyAgent routes everything else through the proxy", () => {
  const dispatcher = new EnvHttpProxyAgent({ httpProxy: "http://127.0.0.1:1" });
  expect(dispatcher.__agentForURL(new URL(origin))).not.toBe(dispatcher.__noProxyAgent);
  const wildcard = new EnvHttpProxyAgent({
    httpProxy: "http://127.0.0.1:1",
    noProxy: "*",
  });
  expect(wildcard.__agentForURL(new URL(origin))).toBe(wildcard.__noProxyAgent);
});

test("an iterator created after the body ended completes instead of hanging", async () => {
  const body = new BodyReadable(
    () => {},
    () => {},
    "text/plain",
    { major: 7 },
  );
  body.push(Buffer.from("done"));
  body.push(null);
  // Consume the body so its 'end' fires (the shape of a body a program
  // already read with text()/json() before starting to iterate it).
  await body.text();
  const iterator = body[Symbol.asyncIterator]();
  await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
});

test("a slow consumer pauses the body at the high-water mark", async () => {
  const body = new BodyReadable(
    () => {},
    () => {},
    "text/plain",
    { major: 7 },
  );
  const iterator = body[Symbol.asyncIterator]();
  const first = iterator.next(); // demand: resumes the body
  const chunk = Buffer.alloc(1024, 1);
  for (let i = 0; i < 200; i++) body.push(chunk);
  body.push(null);
  // The flow pass runs on a tick: let it fill the iterator's queue and hit
  // the high-water mark, then check the body is paused with the rest still
  // in its own bounded buffer.
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(body.readableFlowing).toBe(false);
  let total = (await first).value?.length ?? 0;
  for (;;) {
    const result = await iterator.next();
    if (result.done) break;
    total += result.value.length;
  }
  expect(total).toBe(200 * 1024);
});

test("a streamed body longer than its declared content-length fails the request", async () => {
  const client = new Client(origin);
  const before = requests;
  await expect(
    client.request({
      path: "/echo",
      method: "POST",
      headers: { "content-length": "3" },
      body: Readable.from([Buffer.from("abcd")]),
    }),
  ).rejects.toMatchObject({ code: "UND_ERR_REQ_CONTENT_LENGTH_MISMATCH" });
  // The connection is destroyed, so the excess bytes never frame a second
  // request on it.
  expect(requests - before).toBeLessThanOrEqual(1);
  await client.close();
});

test("a streamed body shorter than its declared content-length fails the request", async () => {
  const client = new Client(origin);
  const before = requests;
  await expect(
    client.request({
      path: "/echo",
      method: "POST",
      headers: { "content-length": "3" },
      body: Readable.from([Buffer.from("a")]),
    }),
  ).rejects.toMatchObject({ code: "UND_ERR_REQ_CONTENT_LENGTH_MISMATCH" });
  expect(requests - before).toBeLessThanOrEqual(1);
  await client.close();
});

test("EnvHttpProxyAgent forwards ProxyAgent TLS options to its child agents", () => {
  const dispatcher = new EnvHttpProxyAgent({
    httpProxy: "http://127.0.0.1:1",
    httpsProxy: "http://127.0.0.1:2",
    requestTls: { servername: "origin.example", rejectUnauthorized: true },
    proxyTls: { rejectUnauthorized: false },
  });
  const httpAgent = dispatcher.__httpProxyAgent as CoreProxyAgent;
  const httpsAgent = dispatcher.__httpsProxyAgent as CoreProxyAgent;
  expect(httpAgent).toBeInstanceOf(CoreProxyAgent);
  expect(httpsAgent).toBeInstanceOf(CoreProxyAgent);
  expect(httpAgent.__requestTls?.servername).toBe("origin.example");
  expect(httpAgent.__proxyTls?.rejectUnauthorized).toBe(false);
  expect(httpsAgent.__requestTls?.servername).toBe("origin.example");
  expect(httpsAgent.__proxyTls?.rejectUnauthorized).toBe(false);
});

test("an early response destroys the connection instead of reusing it mid-upload", async () => {
  const client = new Client(origin);
  const before = requests;
  async function* slow(): AsyncGenerator<Uint8Array> {
    for (let i = 0; i < 50; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      yield new Uint8Array(1024);
    }
  }
  // The upload is still writing when the 413 arrives; the next request must
  // go over a fresh connection, not into that body.
  const upload = client
    .request({ path: "/early", method: "POST", body: Readable.from(slow()) })
    .catch(() => null);
  const second = await client.request({ path: "/echo", method: "GET" });
  expect(await second.body.text()).toBe("GET - - ");
  await upload;
  expect(requests - before).toBe(2);
  await client.close();
});
