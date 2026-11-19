// socket.connect({ path }, listener) registers the listener as
// once('connect') and the Unix-socket connection invokes it.
import * as net from "node:net";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const socketPath = join(tmpdir(), "scriptc-net-socket-path-connect.sock");
rmSync(socketPath, { force: true });

const server = net.createServer((socket) => {
  socket.on("data", (chunk) => {
    console.log("server got", String(chunk));
    socket.end("pong");
  });
});
await new Promise<void>((resolve) => server.listen(socketPath, resolve));

await new Promise<void>((resolve) => {
  const client = new net.Socket();
  client.connect({ path: socketPath }, () => {
    console.log("listener fired", client.readyState);
    client.write("ping");
  });
  client.on("data", (chunk) => console.log("client got", String(chunk)));
  client.on("close", () => resolve());
});

server.close(() => {
  rmSync(socketPath, { force: true });
});
