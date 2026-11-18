// ClientRequest's lifecycle reads and the head flush: the initial state, the
// maxHeadersCount dial, flushHeaders committing the head before the body, and
// the state after a completed exchange.
import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";

const server = createServer((req, res) => {
  res.end(`body ${req.headers["x-flushed"]}`);
});

server.listen(0, "127.0.0.1", () => {
  const port = (server.address() as AddressInfo).port;
  const req = request({ host: "127.0.0.1", port, path: "/", agent: false }, (res) => {
    let body = "";
    res.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });
    res.on("end", () => {
      console.log("response", res.statusCode, body);
      req.on("close", () => {
        console.log("closed", req.aborted, req.destroyed, req.reusedSocket);
        server.close(() => console.log("server closed"));
      });
    });
  });
  console.log("initial", req.aborted, req.destroyed, req.reusedSocket, req.maxHeadersCount);
  req.maxHeadersCount = 5;
  console.log("maxHeadersCount", req.maxHeadersCount);
  req.setHeader("x-flushed", "yes");
  req.flushHeaders();
  console.log("flushed", req.headersSent, req.writableEnded);
  req.end();
});
