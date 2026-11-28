// A client response whose body arrived while nothing read it: the server
// sends Connection: close, the response closes, and only then does the
// program start iterating. Node yields the buffered chunks; the iterator
// must read the held body rather than report an empty end.
import { createServer, request } from "node:http";
import type { IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

const server = createServer((_req, res) => {
  res.setHeader("connection", "close");
  res.end("hello buffered body");
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address() as AddressInfo;

const response = await new Promise<IncomingMessage>((resolve, reject) => {
  const req = request({ host: "127.0.0.1", port, method: "GET", path: "/", agent: false }, resolve);
  req.on("error", reject);
  req.end();
});

response.once("close", () => console.log("close"));
setTimeout(() => {
  void (async () => {
    const parts: string[] = [];
    for await (const chunk of response) parts.push(String(chunk));
    console.log(`after close: ${JSON.stringify(parts.join(""))} destroyed ${response.destroyed}`);
    server.close();
  })();
}, 200);
