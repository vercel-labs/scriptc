// A client response body iterated with for-await when the connection dies
// mid-body: Node destroys the response with "aborted" (ECONNRESET), so the
// iterator rejects rather than reaching a clean end. The teardown is started
// in the loop body after the first chunk, so the rejection cannot race the
// first delivery.
import { createServer, request } from "node:http";
import type { IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

const watchdog = setTimeout(() => {
  console.log("pending");
  process.exit(2);
}, 1000);

const server = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/plain" });
  res.write("part1");
});

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address() as AddressInfo;

const response = await new Promise<IncomingMessage>((resolve) => {
  const req = request({ host: "127.0.0.1", port, method: "GET", path: "/", agent: false }, resolve);
  req.on("error", () => {});
  req.end();
});

try {
  for await (const chunk of response) {
    console.log(`chunk ${chunk.length > 0}`);
    response.socket?.destroy();
  }
  console.log("end");
} catch (error) {
  const err = error as Error & { code?: string };
  console.log(`error ${JSON.stringify(err.message)} ${err.code}`);
}
console.log(`after destroyed ${response.destroyed} aborted ${response.aborted} complete ${response.complete}`);
clearTimeout(watchdog);
server.close();
