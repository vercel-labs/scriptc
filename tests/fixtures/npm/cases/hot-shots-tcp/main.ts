// The hot-shots StatsD client over tcp (compiled from scriptc's built-in
// shim): a send completes once the socket has written its line, so close()
// waits for lines that a full socket buffer holds back, and the receiver
// gets every line before the connection ends.
import * as net from "node:net";
import { StatsD } from "hot-shots";

const LINES = 20000;
const name = "m".repeat(1000);
let bytes = 0;
let ended: () => void = () => {};
const serverDone = new Promise<void>((resolve) => {
  ended = resolve;
});
const server = net.createServer((socket) => {
  socket.pause();
  setTimeout(() => socket.resume(), 150);
  socket.on("data", (chunk: Buffer) => {
    bytes += chunk.length;
  });
  socket.on("end", () => ended());
});

server.listen(0, "127.0.0.1", () => {
  const port = (server.address() as net.AddressInfo).port;
  const client = new StatsD({ host: "127.0.0.1", port, protocol: "tcp" });
  for (let i = 0; i < LINES; i++) client.increment(name);
  const closed = new Promise<void>((resolve) => client.close(() => resolve()));
  void Promise.all([closed, serverDone]).then(() => {
    console.log("closed; received", bytes, "of", LINES * (name.length + 5), "bytes");
    server.close(() => console.log("server closed"));
  });
});
