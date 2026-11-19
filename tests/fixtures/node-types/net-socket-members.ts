// net's client-socket surface under @types/node: new Socket().connect(),
// the connect options record, the write/end encoding forms, destroy(error)
// and the timeout property.
import * as net from "node:net";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const server = net.createServer((socket) => {
  socket.on("data", (chunk: Buffer) => {
    console.log("server", chunk.toString("hex"));
  });
  socket.on("end", () => socket.end());
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as net.AddressInfo).port;

await new Promise<void>((resolve) => {
  const socket = new net.Socket();
  console.log("timeout", socket.timeout);
  socket.connect({ port, host: "127.0.0.1", family: 4 }, () => {
    console.log("connected", socket.remoteAddress, socket.remotePort === port);
    socket.write("6869", "hex");
    socket.write("hi", "utf8", () => console.log("write flushed"));
    socket.end("bye", "utf8", () => console.log("finished"));
  });
  socket.setTimeout(20);
  console.log("timeout set", socket.timeout);
  socket.on("close", (hadError) => {
    console.log("close", hadError);
    resolve();
  });
});

await new Promise<void>((resolve) => {
  const socket = new net.Socket({ allowHalfOpen: true });
  const failure = new Error("expected");
  socket.on("error", (err) => console.log("destroy error", err.message));
  socket.on("close", (hadError) => {
    console.log("destroy close", hadError);
    resolve();
  });
  socket.connect(port, "127.0.0.1", () => {
    socket.destroy(failure);
  });
});

// server.address(): null before listen, the record while listening, and
// the socket path for a Unix-socket server — @types/node's union.
const idle = net.createServer();
console.log("address before listen", idle.address());
idle.close();

const unixPath = join(tmpdir(), "scriptc-net-socket-members.sock");
rmSync(unixPath, { force: true });
await new Promise<void>((resolve) => {
  const server = net.createServer();
  server.listen(unixPath, () => {
    console.log("unix address", server.address());
    server.close(() => resolve());
  });
});

server.close();
