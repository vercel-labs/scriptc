// A response that buffered its body completes normally on a keep-alive
// connection; the deferred close's socket watch must be inert once the close
// has run. The client reads the response and only then closes the
// connection — the later socket close must not reach a cleared box.
import * as http from "node:http";
import * as net from "node:net";
import type { AddressInfo } from "node:net";

const server = http.createServer((req, res) => {
  req.resume();
  req.on("end", () => {
    res.on("finish", () => console.log("finish"));
    res.on("close", () => console.log("close"));
    res.end("x".repeat(1 << 20), () => console.log("end callback"));
  });
});

server.listen(0, "127.0.0.1", () => {
  const sock = net.connect((server.address() as AddressInfo).port, "127.0.0.1", () => {
    sock.write("GET / HTTP/1.1\r\nHost: x\r\n\r\n");
    sock.pause();
    setTimeout(() => sock.resume(), 200);
  });
  let seen = 0;
  sock.on("data", (chunk: Buffer) => {
    seen += chunk.length;
  });
  setTimeout(() => {
    console.log("client close", seen > (1 << 20));
    sock.destroy();
  }, 600);
  sock.on("close", () => {
    setTimeout(() => {
      console.log("closed");
      server.close();
    }, 100);
  });
  sock.on("error", () => {});
});
