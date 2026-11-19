// The write() arguments this surface reads and drops are still evaluated:
// an encoding expression with effects and an explicit-undefined callback
// expression both run, in Node's argument order.
import * as http from "node:http";
import type { AddressInfo } from "node:net";

function encoding(): "utf8" {
  console.log("encoding expression");
  return "utf8";
}

function absent(): undefined {
  console.log("absent callback expression");
  return undefined;
}

const server = http.createServer((_req, res) => {
  res.sendDate = false;
  res.write("a", encoding());
  res.write("b", "utf8", absent());
  res.end("c");
});

server.listen(0, "127.0.0.1", () => {
  const port = (server.address() as AddressInfo).port;
  const req = http.get({ host: "127.0.0.1", port, path: "/" }, (res) => {
    let body = "";
    res.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });
    res.on("end", () => {
      console.log("body", body);
      server.close(() => console.log("closed"));
    });
  });
  req.on("error", (err: NodeJS.ErrnoException) => console.log("error", err.code));
});
