// end() flushes every cork level, including the chunked message's single
// corked write. The callbacks of the writes that went into that batch must
// still run: they belong to bytes that left the socket with the flush.
import * as http from "node:http";
import type { AddressInfo } from "node:net";

const server = http.createServer((req, res) => {
  req.resume();
  req.on("end", () => {
    res.write("a", () => console.log("write a"));
    res.cork();
    res.write("b", () => console.log("write b"));
    res.end("c", () => console.log("end callback"));
    res.on("finish", () => console.log("finish"));
  });
});

server.listen(0, "127.0.0.1", () => {
  http.get({ port: (server.address() as AddressInfo).port, host: "127.0.0.1" }, (response) => {
    let body = "";
    response.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    response.on("end", () => {
      console.log("client body", body);
      server.close();
    });
  });
});
