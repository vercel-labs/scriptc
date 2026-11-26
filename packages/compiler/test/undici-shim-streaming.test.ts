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
import { Client, EnvHttpProxyAgent, request } from "../shims/undici/v7.ts";

let server: Server;
let origin = "";

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const length = req.headers["content-length"];
      const encoding = req.headers["transfer-encoding"];
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
