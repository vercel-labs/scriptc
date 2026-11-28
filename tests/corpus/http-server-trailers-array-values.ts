// An array-valued trailer in the addTrailers object: Node sends one wire
// line per element; the client's trailersDistinct keeps them.
import * as http from "node:http";
import type { AddressInfo } from "node:net";

const server = http.createServer((req, res) => {
  req.resume();
  req.on("end", () => {
    res.writeHead(200, { "transfer-encoding": "chunked" });
    res.write("a");
    res.addTrailers({ "x-t": ["1", "2"], "x-u": "u" });
    res.end("b");
  });
});

server.listen(0, "127.0.0.1", () => {
  http.get({ port: (server.address() as AddressInfo).port, host: "127.0.0.1" }, (res) => {
    let body = "";
    res.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    res.on("end", () => {
      const t = res.trailersDistinct["x-t"];
      const u = res.trailersDistinct["x-u"];
      console.log(
        "trailers",
        body,
        res.complete,
        t === undefined ? "none" : t.join(","),
        u === undefined ? "none" : u.join(","),
      );
      server.close();
    });
  });
});
