// A client that aborts while the response body still sits in the socket
// buffer: Node never emits 'finish' for it, but 'close' runs — the close is
// not held back behind a flush that the dead socket will never deliver.
import * as http from "node:http";
import * as net from "node:net";
import type { AddressInfo } from "node:net";

const server = http.createServer((req, res) => {
  req.resume();
  req.on("end", () => {
    res.on("finish", () => console.log("finish"));
    res.on("close", () => console.log("close"));
    res.end("x".repeat(8 << 20));
  });
});

server.listen(0, "127.0.0.1", () => {
  const sock = net.connect((server.address() as AddressInfo).port, "127.0.0.1", () => {
    sock.write("GET / HTTP/1.1\r\nHost: x\r\n\r\n");
    setTimeout(() => {
      console.log("client destroy");
      sock.destroy();
    }, 100);
  });
  sock.on("error", () => {});
  sock.on("close", () => setTimeout(() => server.close(), 100));
});
