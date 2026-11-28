// A server request body iterated with for-await when the client tears the
// connection down mid-body: Node destroys the IncomingMessage with "aborted"
// (ECONNRESET), so the iterator rejects after the chunks it already read
// instead of reporting a clean end. The client tears down only once the
// response head arrives, which happens after the first body chunk was read,
// so the abort always lands while the iterator is waiting for more.
import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";

const watchdog = setTimeout(() => {
  console.log("pending");
  process.exit(2);
}, 1000);

const server = createServer((req, res) => {
  void (async () => {
    try {
      for await (const chunk of req) {
        console.log(`server chunk ${chunk.length}`);
        res.writeHead(200, { "content-type": "text/plain" });
        res.flushHeaders();
        console.log("server response started");
      }
      console.log("server end");
    } catch (error) {
      const err = error as Error & { code?: string };
      console.log(`server error ${JSON.stringify(err.message)} ${err.code}`);
    }
    console.log(`server after destroyed ${req.destroyed} aborted ${req.aborted} complete ${req.complete}`);
    clearTimeout(watchdog);
    server.close();
  })();
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address() as AddressInfo;

const req = request({
  host: "127.0.0.1",
  port,
  method: "POST",
  path: "/",
  agent: false,
  headers: { "content-length": "1000" },
});
req.on("response", (response) => {
  console.log(`client response ${response.statusCode}`);
  response.on("error", () => {});
  req.destroy();
});
req.on("error", () => {});
req.on("close", () => console.log("client close"));
req.write(Buffer.alloc(100, 65));

await new Promise<void>((resolve) => setTimeout(resolve, 300));
console.log("done");
