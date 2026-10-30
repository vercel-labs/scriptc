// Response.clone() and Request.clone() on typed values: the clone keeps the
// status, status text, URL and a copy of the headers, its body is one
// branch of the original's tee, a used or locked body refuses with Node's
// TypeError, and a Request clone keeps the method, URL, headers and body.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

const describe = (e: unknown): string => `${(e as Error).name}: ${(e as Error).message}`;

async function responses(): Promise<void> {
  const original = new Response("hello", { status: 201, statusText: "Made", headers: { "x-a": "1" } });
  const copy = original.clone();
  console.log("meta", copy.status, copy.statusText, copy.ok, copy.headers.get("x-a"), copy.bodyUsed, copy.body === original.body);
  copy.headers.set("x-a", "changed");
  console.log("headers", original.headers.get("x-a"), copy.headers.get("x-a"));
  console.log("bodies", await copy.text(), await original.text(), original.bodyUsed, copy.bodyUsed);
  try {
    original.clone();
  } catch (e) {
    console.log("used", describe(e));
  }

  const chained = new Response("chain").clone().clone();
  console.log("chained", await chained.text());

  const twice = new Response("twice");
  const first = twice.clone();
  const second = twice.clone();
  console.log("twice", await second.text(), await first.text(), await twice.text());

  const locked = new Response("locked");
  locked.body!.getReader();
  try {
    locked.clone();
  } catch (e) {
    console.log("locked", describe(e));
  }

  const empty = new Response(null, { status: 204 });
  const emptyCopy = empty.clone();
  console.log("null body", emptyCopy.status, emptyCopy.body === null, await emptyCopy.text() === "");

  const json = Response.json({ n: 1 });
  const jsonCopy = json.clone();
  console.log("json", JSON.stringify(await jsonCopy.json()), jsonCopy.headers.get("content-type"));
}

async function requests(): Promise<void> {
  const request = new Request("http://example.com/path?q=1", { method: "PUT", body: "payload", headers: { "x-b": "2" } });
  const copy = request.clone();
  console.log("request", copy.method, copy.url, copy.headers.get("x-b"), copy.bodyUsed);
  console.log("request bodies", await copy.text(), await request.text());
  try {
    request.clone();
  } catch (e) {
    console.log("request used", describe(e));
  }
  const get = new Request("http://example.com/");
  const getCopy = get.clone();
  console.log("get", getCopy.method, getCopy.body === null, getCopy.redirect);
}

async function fetched(): Promise<void> {
  const server = createServer((_req: IncomingMessage, res: ServerResponse) => {
    res.setHeader("x-served", "yes");
    res.write("part one;");
    setTimeout(() => res.end("part two"), 5);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as AddressInfo;
  const response = await fetch(`http://127.0.0.1:${port}/`);
  const copy = response.clone();
  console.log("fetched", copy.status, copy.headers.get("x-served"), copy.url === response.url);
  console.log("fetched bodies", await copy.text(), await response.text());
  server.close();
}

await responses();
await requests();
await fetched();
