// An informational writer's callback fires once its response is written, even
// when the connection already has more than the socket's high-water mark
// buffered from an earlier pipelined response: backpressure is not a failure.
import * as http from "node:http";
import * as net from "node:net";
import type { AddressInfo } from "node:net";

let first = true;
const server = http.createServer((req, res) => {
  if (first) {
    first = false;
    res.end("x".repeat(8 * 1024 * 1024));
    return;
  }
  res.writeEarlyHints({ link: "</a.css>; rel=preload" }, () => console.log("hints callback"));
  res.writeInformation(102, { "x-a": "1" }, () => console.log("info callback"));
  res.end("ok");
});
server.listen(0, "127.0.0.1", () => {
  const port = (server.address() as AddressInfo).port;
  const sock = net.connect(port, "127.0.0.1");
  let wire = "";
  sock.on("connect", () => {
    sock.write("GET /1 HTTP/1.1\r\nHost: x\r\n\r\nGET /2 HTTP/1.1\r\nHost: x\r\n\r\n");
    // read only later, so the second response's informational write happens
    // while the first response's bytes are still buffered
    setTimeout(() => {
      sock.on("data", (c: Buffer) => { wire += c.toString("latin1"); });
    }, 100);
  });
  sock.on("error", () => {});
  setTimeout(() => {
    console.log("info seen", wire.includes("102"), "written", wire.length > 8 * 1024 * 1024);
    sock.destroy();
    server.close();
  }, 400);
});
