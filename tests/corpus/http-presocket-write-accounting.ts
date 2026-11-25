// Writes made before a request's 'socket' event keep their own chunk and
// count toward writableLength; the accounting must stay linear in the
// number of writes, not rescan them.
import * as http from "node:http";
import * as net from "node:net";

const COUNT = 100000;

const peer = net.createServer((socket) => {
  socket.on("data", () => {});
  socket.on("error", () => {});
});

peer.listen(0, "127.0.0.1", () => {
  const port = (peer.address() as { port: number }).port;
  const req = http.request({ host: "127.0.0.1", port, method: "POST", headers: { "transfer-encoding": "chunked" } });
  req.on("error", () => {});
  const started = Date.now();
  let length = 0;
  for (let i = 0; i < COUNT; i++) {
    req.write("x");
    length = req.writableLength;
  }
  const elapsed = Date.now() - started;
  console.log("writes", COUNT);
  console.log("writableLength positive:", length > 0);
  console.log("writes under 10s:", elapsed < 10000);
  req.destroy();
  peer.close();
});
