// end() with a body the socket cannot take at once: the end callback and the
// 'finish' listeners wait for the body to drain, and 'close' follows them
// rather than cancelling the wait. The client reads nothing for 200 ms.
import * as http from "node:http";
import * as net from "node:net";
import type { AddressInfo } from "node:net";

const server = http.createServer((req, res) => {
  req.resume();
  req.on("end", () => {
    res.on("prefinish", () => console.log("prefinish"));
    res.on("finish", () => console.log("finish"));
    res.on("close", () => console.log("close"));
    res.end("x".repeat(1 << 20), () => console.log("end callback"));
  });
});

server.listen(0, "127.0.0.1", () => {
  const sock = net.connect((server.address() as AddressInfo).port, "127.0.0.1", () => {
    sock.write("GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n");
    sock.pause();
    setTimeout(() => sock.resume(), 200);
  });
  let seen = 0;
  sock.on("data", (chunk: Buffer) => {
    seen += chunk.length;
  });
  sock.on("end", () => console.log("client end", seen > 0));
  sock.on("close", () => {
    console.log("client close");
    server.close();
  });
  sock.on("error", () => {});
});
