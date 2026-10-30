// fetch() reuses keep-alive connections as Node's fetch does: sequential
// requests share connections, and every response is the same with reuse:
// concurrent requests, `connection: close` responses and requests,
// redirects, request bodies, an aborted response followed by another
// request, and a request after the server closed its idle connections. The
// program exits while idle connections remain open.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

let connections = 0;
const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const url = req.url ?? "/";
  if (url === "/close") {
    res.writeHead(200, { connection: "close" });
    res.end("closing");
    return;
  }
  if (url === "/redirect") {
    res.writeHead(302, { location: "/hello" });
    res.end();
    return;
  }
  if (url === "/echo") {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      body += chunk;
    });
    req.on("end", () => res.end(`echo:${body}`));
    return;
  }
  if (url === "/slow") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.write("first ");
    setTimeout(() => res.end("rest"), 200);
    return;
  }
  res.end(`hello ${url}`);
});
server.on("connection", () => {
  connections++;
});

async function text(port: number, path: string, init?: RequestInit): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, init);
  return `${res.status} ${await res.text()}`;
}

async function main(port: number): Promise<void> {
  const seen: string[] = [];
  for (let i = 0; i < 5; i++) seen.push(await text(port, `/seq${i}`));
  console.log("sequential", connections < 5, seen.join(" | "));

  const parallel = await Promise.all([1, 2, 3].map((i) => text(port, `/par${i}`)));
  for (let i = 0; i < 3; i++) parallel.push(await text(port, `/after${i}`));
  console.log("concurrent", parallel.join(" | "));

  console.log(await text(port, "/close"), await text(port, "/close"));
  console.log(await text(port, "/a", { headers: { connection: "close" } }), await text(port, "/b"));

  const res = await fetch(`http://127.0.0.1:${port}/redirect`);
  console.log("redirect", res.redirected, res.url.endsWith("/hello"), await res.text());

  const bodies = [];
  for (let i = 0; i < 3; i++) bodies.push(await text(port, "/echo", { method: "POST", body: `n${i}` }));
  console.log("post", bodies.join(" | "));

  const controller = new AbortController();
  const slow = await fetch(`http://127.0.0.1:${port}/slow`, { signal: controller.signal });
  controller.abort();
  try {
    await slow.text();
  } catch (e) {
    console.log("aborted", (e as Error).name);
  }
  console.log(await text(port, "/after-abort"));

  // A server that closes idle connections after 50 ms: the next request
  // after a pause dials again.
  const brief = createServer((req: IncomingMessage, res: ServerResponse) => res.end(`brief ${req.url}`));
  brief.keepAliveTimeout = 50;
  await new Promise<void>((resolve) => brief.listen(0, "127.0.0.1", () => resolve()));
  const briefPort = (brief.address() as AddressInfo).port;
  console.log(await text(briefPort, "/1"), await text(briefPort, "/2"));
  await new Promise<void>((resolve) => setTimeout(resolve, 200));
  console.log(await text(briefPort, "/3"));

  brief.close();
  server.close();
  console.log("done");
}

server.listen(0, "127.0.0.1", () => {
  void main((server.address() as AddressInfo).port);
});
