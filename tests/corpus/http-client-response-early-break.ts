// Breaking out of a for-await loop over a client response body destroys the
// response and its socket, as Node's stream iterator does. Twenty runs check
// that every socket closes and nothing stays alive; a watchdog reports a
// response left undestroyed.
import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";

const iterations = 20;
let closed = 0;

const server = createServer((_req, res) => {
  // The response stays open: only the iterator's early return closes it.
  res.write(Buffer.alloc(10, 1));
});
server.on("connection", (socket) => socket.on("close", () => closed++));
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address() as AddressInfo;

const watchdog = setTimeout(() => {
  console.log(`watchdog closed ${closed}/${iterations}`);
  server.close();
  process.exit(2);
}, 3000);

for (let i = 0; i < iterations; i++) {
  await new Promise<void>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method: "GET", path: "/", agent: false }, (res) => {
      void (async () => {
        for await (const chunk of res) {
          void chunk;
          break;
        }
        resolve();
      })();
    });
    req.on("error", reject);
    req.end();
  });
}

const deadline = Date.now() + 2000;
while (closed < iterations && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
clearTimeout(watchdog);
console.log(`iterations ${iterations} closed ${closed}`);
server.close();
// Only the failing case leaves sockets open: end it so the mismatch is
// reported instead of the harness timing out.
if (closed < iterations) setTimeout(() => process.exit(2), 100);
