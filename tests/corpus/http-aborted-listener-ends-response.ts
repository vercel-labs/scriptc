// An 'aborted' listener may end the response of a request that arrived in
// full, when the client resets the connection and when it sends FIN: the
// server keeps running and the remaining events follow in Node's order.
import * as http from "node:http";
import * as net from "node:net";

let round = 0;
let socket: net.Socket;
const server = http.createServer((req, res) => {
  const label = round === 1 ? "reset" : "fin";
  console.log(label, "request", req.method, req.url);
  req.on("aborted", () => {
    console.log(label, "aborted", req.complete, res.writableEnded);
    res.end("late");
    console.log(label, "ended in aborted", res.writableEnded);
  });
  req.on("error", (err: NodeJS.ErrnoException) => console.log(label, "req error", err.code, err.message));
  req.on("close", () => console.log(label, "req close"));
  res.on("finish", () => console.log(label, "res finish"));
  res.on("close", () => console.log(label, "res close"));
  if (round === 1) socket.destroy();
  else socket.end();
});

function connect(port: number, done: () => void): void {
  round++;
  socket = net.connect(port, "127.0.0.1", () => {
    socket.write(`GET /round${round} HTTP/1.1\r\nHost: a\r\n\r\n`);
  });
  socket.on("data", () => {});
  socket.on("error", () => {});
  socket.on("close", () => setTimeout(done, 50));
}

server.listen(0, "127.0.0.1", () => {
  const port = (server.address() as net.AddressInfo).port;
  connect(port, () => connect(port, () => server.close(() => console.log("server closed"))));
});
