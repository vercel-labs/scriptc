// Transfer-Encoding that does not end in chunked: the parser fails the
// request after 'request' fires. A handler that ends the response
// synchronously does not save the exchange — reap destroys the socket before
// the response's 'finish' event fires, so the request still aborts
// ('aborted', then 'error' ECONNRESET "aborted", then 'close') while the
// client still receives the 200. A later valid request on another connection
// is answered normally.
import * as http from "node:http";
import * as net from "node:net";
import type { AddressInfo } from "node:net";

const server = http.createServer((req, res) => {
  console.log("request", req.url);
  req.on("aborted", () => console.log("aborted", req.url));
  req.on("error", (e: NodeJS.ErrnoException) => console.log("error", e.code, e.message));
  req.on("close", () => console.log("close", req.url));
  res.on("finish", () => console.log("finish", req.url));
  res.on("close", () => console.log("res close", req.url));
  res.end(req.url === "/ok" ? "ok" : "bye");
});

const cases = [
  "POST /bad HTTP/1.1\r\nHost: a\r\nTransfer-Encoding: gzip\r\n\r\n",
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
