// A compressed fetch() response whose whole body arrived before it was read:
// the decoded body is larger than one read, so decoded output is still
// buffered when the response ends, and every later read drains it. Reads
// after a pause (the end was processed meanwhile) return the rest of the
// body, as in Node, for gzip and deflate, through a reader and through
// text(), and the next request on the same connection works.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { deflateSync, gzipSync } from "node:zlib";

const body = Array.from({ length: 20000 }, (_, i) => `line ${i % 97} of the body\n`).join("");
const gzipped = gzipSync(body);
const deflated = deflateSync(body);

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const url = req.url ?? "/";
  if (url === "/gzip" || url === "/gzip-text") {
    res.writeHead(200, { "content-encoding": "gzip", "content-length": gzipped.length });
    res.end(gzipped);
    return;
  }
  if (url === "/deflate") {
    res.writeHead(200, { "content-encoding": "deflate", "content-length": deflated.length });
    res.end(deflated);
    return;
  }
  res.end(`plain ${url}`);
});

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function readSlowly(port: number, path: string): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let reads = 0;
  for (;;) {
    // Let the response end before most reads.
    await pause(reads < 3 ? 30 : 0);
    const { done, value } = await reader.read();
    if (done) break;
    reads++;
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  return `${path} ${res.status} ${text.length} ${text === body}`;
}

async function main(port: number): Promise<void> {
  console.log(await readSlowly(port, "/gzip"));
  console.log(await readSlowly(port, "/deflate"));
  const res = await fetch(`http://127.0.0.1:${port}/gzip-text`);
  await pause(50);
  const text = await res.text();
  console.log("text after end", text.length, text === body);
  const plain = await fetch(`http://127.0.0.1:${port}/after`);
  console.log(await plain.text());
}

server.listen(0, "127.0.0.1", () => {
  const { port } = server.address() as AddressInfo;
  main(port)
    .catch((error: unknown) => console.log("failed", String(error)))
    .finally(() => server.close());
});
