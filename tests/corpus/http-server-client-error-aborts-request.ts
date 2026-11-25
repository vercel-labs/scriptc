// A body the parser rejects reaches 'clientError' with the request still
// attached: closing the socket in the listener destroys that request, so
// 'aborted', 'error' ECONNRESET "aborted" and 'close' all fire on it, and the
// response closes before the request's error. A later valid request on
// another connection is answered, so the failure did not take the server
// down.
import * as http from "node:http";
import * as net from "node:net";
import type { AddressInfo } from "node:net";

const server = http.createServer((req, res) => {
  console.log("request", req.url);
  req.on("aborted", () => console.log("aborted", req.url));
  req.on("error", (e: NodeJS.ErrnoException) => console.log("error", e.code, e.message));
  req.on("close", () => console.log("close", req.url));
  req.on("data", () => {});
  res.on("finish", () => console.log("finish", req.url));
  res.on("close", () => console.log("res close", req.url));
  if (req.url === "/ok") res.end("ok");
});
server.on("clientError", (err: NodeJS.ErrnoException, socket: net.Socket) => {
  console.log("clientError", err.code, err.message);
  socket.destroy();
});

const cases = [
  "POST /bad HTTP/1.1\r\nHost: a\r\nTransfer-Encoding: chunked\r\n\r\nzz\r\n",
  "GET /ok HTTP/1.1\r\nHost: a\r\nConnection: close\r\n\r\n",
];

function send(port: number, index: number): void {
  if (index === cases.length) {
    server.close();
    return;
  }
  const sock = net.connect(port, "127.0.0.1", () => sock.write(cases[index]!));
  let reply = "";
  sock.setEncoding("utf8");
  sock.on("data", (chunk: string) => {
    reply += chunk;
  });
  sock.on("error", () => {});
  sock.on("close", () => {
    console.log("reply", reply.split("\r\n")[0] ?? "");
    send(port, index + 1);
  });
}

server.listen(0, "127.0.0.1", () => send((server.address() as AddressInfo).port, 0));
