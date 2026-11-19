// After an upgrade the socket is the program's raw socket: destroying it
// with an Error fires its own 'error' listeners and leaves the server's
// 'clientError' out of it.
import * as http from "node:http";
import * as net from "node:net";

const events: string[] = [];
const server = http.createServer((req, res) => res.end());
server.on("upgrade", (req, socket: net.Socket) => {
  events.push("upgrade");
  socket.on("error", (err: Error) => events.push(`socket ${err.message}`));
  socket.destroy(new Error("boom"));
});
server.on("clientError", (err: Error) => events.push(`clientError ${err.message}`));

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as { port: number }).port;

const raw = net.connect(port, "127.0.0.1");
await new Promise<void>((connected) => raw.on("connect", connected));
raw.on("error", () => {});
await new Promise<void>((resolve) => {
  raw.on("close", () => resolve());
  raw.write("GET / HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n");
});

await new Promise<void>((resolve) => setImmediate(resolve));
console.log("events", events.join(","));
server.close();
