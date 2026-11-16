// destroy() followed by destroy(error): the second call is ignored, so the
// teardown closes without an 'error' and with hadError false.
import * as net from "node:net";

const events: string[] = [];
const server = net.createServer((socket) => socket.on("data", () => {}));
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as { port: number }).port;

await new Promise<void>((resolve) => {
  const socket = net.connect(port, "127.0.0.1", () => {
    socket.on("error", (err: Error) => events.push(`error ${err.message}`));
    socket.on("close", (hadError: boolean) => {
      events.push(`close ${hadError}`);
      resolve();
    });
    socket.destroy();
    socket.destroy(new Error("boom"));
  });
});

console.log("events", events.join(","));
server.close();
