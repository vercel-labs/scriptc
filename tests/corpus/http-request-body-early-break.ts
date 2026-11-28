// Breaking out of a for-await loop over a server request body destroys the
// request, as Node's stream iterator does: the request reports destroyed and
// aborted, the socket closes, and the client sees the response. A watchdog
// reports a request left undestroyed.
import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";

const watchdog = setTimeout(() => {
  console.log("watchdog");
  process.exit(2);
}, 1000);

const server = createServer((req, res) => {
  void (async () => {
    for await (const chunk of req) {
      console.log(`server chunk ${chunk.length}`);
      break;
    }
    console.log(`server destroyed ${req.destroyed} aborted ${req.aborted}`);
    try {
      res.end("x");
      console.log("response ended");
    } catch {
      console.log("response gone");
    }
    clearTimeout(watchdog);
    server.close();
  })();
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address() as AddressInfo;

await new Promise<void>((resolve) => {
  const req = request({ host: "127.0.0.1", port, method: "POST", path: "/", agent: false }, (res) => {
    console.log(`client response ${res.statusCode}`);
    res.resume();
  });
  req.on("error", (error: NodeJS.ErrnoException) => {
    console.log(`client error ${error.code}`);
    resolve();
  });
  req.on("close", () => {
    console.log("client close");
    resolve();
  });
  req.write(Buffer.alloc(100));
  setTimeout(() => {
    try {
      req.write(Buffer.alloc(100));
    } catch {
      // the socket is gone
    }
  }, 20);
});
