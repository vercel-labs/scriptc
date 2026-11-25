// Transfer-Encoding: gzip (not ending in chunked) with an unsupported
// Expect: Node answers 417 and then reports the deferred framing error, so
// the connection fails instead of parsing the bytes behind the head as
// another request. Both arms: a 'clientError' listener receives
// HPE_INVALID_TRANSFER_ENCODING, and without one the connection just closes.
// The two servers run one after the other so the output order is fixed.
import * as http from "node:http";
import * as net from "node:net";
import type { AddressInfo } from "node:net";

const request =
  "POST /a HTTP/1.1\r\nHost: a\r\nTransfer-Encoding: gzip\r\nExpect: 200-continue\r\n\r\n" +
  "GET /next HTTP/1.1\r\nHost: a\r\nConnection: close\r\n\r\n";

function listen(withListener: boolean): http.Server {
  const server = http.createServer((req, res) => {
    console.log("request", req.url);
    req.on("aborted", () => console.log("aborted", req.url));
    res.end("ok");
  });
  if (withListener) {
    server.on("clientError", (err: NodeJS.ErrnoException, socket: net.Socket) => {
      console.log("clientError", err.code, err.message);
      socket.end("HTTP/1.1 418 Custom\r\nConnection: close\r\n\r\n");
    });
  }
  return server;
}

function send(server: http.Server, label: string, next: () => void): void {
  const port = (server.address() as AddressInfo).port;
  const sock = net.connect(port, "127.0.0.1", () => sock.write(request));
  let reply = "";
  sock.setEncoding("utf8");
  sock.on("data", (chunk: string) => {
    reply += chunk;
  });
  sock.on("error", () => {});
  sock.on("close", () => {
    console.log(label, reply.split("\r\n")[0] ?? "");
    server.close(next);
  });
}

const withListener = listen(true);
withListener.listen(0, "127.0.0.1", () => {
  send(withListener, "reply with listener", () => {
    const withoutListener = listen(false);
    withoutListener.listen(0, "127.0.0.1", () => send(withoutListener, "reply without listener", () => {}));
  });
});
