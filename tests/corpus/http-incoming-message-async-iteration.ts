// for await (...) over an http.IncomingMessage: a server request body and a
// client response body, in byte mode and with setEncoding('utf8'). The
// iteration also runs when the body has not arrived yet and when it is empty.
// Chunks are joined before printing, so read() chunk boundaries never show.
import { createServer, request } from "node:http";
import type { IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

async function collect(message: IncomingMessage): Promise<{ text: string; kinds: string[] }> {
  const parts: string[] = [];
  const kinds: string[] = [];
  for await (const chunk of message) {
    kinds.push(typeof chunk);
    parts.push(String(chunk));
  }
  return { text: parts.join(""), kinds: [...new Set(kinds)].sort() };
}

const server = createServer((req, res) => {
  void (async () => {
    if (req.url === "/encoded") req.setEncoding("utf8");
    const body = await collect(req);
    res.setHeader("content-type", "text/plain");
    res.end(`path ${req.url ?? ""} kinds ${body.kinds.join(",")} length ${body.text.length} text ${body.text}`);
  })();
});

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address() as AddressInfo;

async function send(path: string, body: string): Promise<void> {
  const response = await new Promise<IncomingMessage>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method: "POST", path }, (res) => resolve(res));
    req.on("error", reject);
    req.end(body);
  });
  const collected = await collect(response);
  console.log(`response kinds ${collected.kinds.join(",")} ${collected.text}`);
}

await send("/echo", "hello world");
await send("/encoded", "héllo wörld");
await send("/empty", "");

server.close();
