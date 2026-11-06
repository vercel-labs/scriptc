// A request whose Transfer-Encoding does not end in chunked reaches the
// handler as Node reports it once the head is parsed: 'request' fires, the
// request is aborted, and the connection is answered 400 because the
// handler wrote nothing. A Transfer-Encoding that fails the header check
// (a coding after chunked, chunked with Content-Length) is answered 400
// without 'request'. A later valid request is answered by the handler.
import * as http from "node:http";
import * as net from "node:net";
import type { AddressInfo } from "node:net";

const server = http.createServer((req, res) => {
  console.log("request", req.method, req.url);
  req.on("aborted", () => console.log("aborted", req.url));
  if (req.url === "/ok") res.end("ok");
});

const cases: [string, string][] = [
  ["te not chunked", "POST /a HTTP/1.1\r\nHost: a\r\nTransfer-Encoding: gzip\r\n\r\n"],
  ["te chunked then gzip", "POST /b HTTP/1.1\r\nHost: a\r\nTransfer-Encoding: chunked, gzip\r\n\r\n"],
  ["te and cl", "POST /c HTTP/1.1\r\nHost: a\r\nTransfer-Encoding: chunked\r\nContent-Length: 2\r\n\r\n"],
  ["valid", "GET /ok HTTP/1.1\r\nHost: a\r\nConnection: close\r\n\r\n"],
];

function send(port: number, index: number): void {
  if (index === cases.length) {
    server.close();
    return;
  }
  const [name, raw] = cases[index]!;
  const sock = net.connect(port, "127.0.0.1", () => sock.write(Buffer.from(raw, "latin1")));
  let reply = "";
  let done = false;
  const finish = (): void => {
    if (done) return;
    done = true;
    console.log(`${name}: ${reply.split("\r\n")[0] ?? ""}`);
    sock.destroy();
    send(port, index + 1);
  };
  sock.setEncoding("utf8");
  sock.on("data", (chunk: string) => {
    reply += chunk;
  });
  sock.on("error", () => {});
  sock.on("close", finish);
}

server.listen(0, "127.0.0.1", () => send((server.address() as AddressInfo).port, 0));
