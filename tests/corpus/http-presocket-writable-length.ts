// writableLength before a request's 'socket' event counts each buffered
// write once: the writes wait in the message (Node's outputData), head and
// chunk framing included, and reach the socket only when it is assigned.
import * as http from "node:http";
import * as net from "node:net";

const peer = net.createServer((socket) => {
  socket.on("data", () => {});
  socket.on("error", () => {});
});

peer.listen(0, "127.0.0.1", () => {
  const port = (peer.address() as { port: number }).port;
  const req = http.request({ host: "127.0.0.1", port, method: "POST", headers: { "transfer-encoding": "chunked" } });
  req.on("error", () => {});
  console.log("write answer", req.write("x".repeat(100000)) === false);
  console.log("writableLength", req.writableLength);
  console.log("needDrain", req.writableNeedDrain);
  req.on("socket", () => {
    req.destroy();
    peer.close();
  });
});
