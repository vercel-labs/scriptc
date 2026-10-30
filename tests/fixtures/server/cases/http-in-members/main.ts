// `in` tests on native Node handles answer from Node's declared members.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

const server = createServer((req, res) => {
  console.log("request", "method" in req, "setHeader" in res, "writeHead" in res);
  res.end("ok");
});
console.log("closeAllConnections" in server, "closeIdleConnections" in server, "listen" in server);
server.listen(0, "127.0.0.1", () => {
  process.stderr.write(`PORT ${(server.address() as AddressInfo).port}\n`);
});
server.on("request", () => {
  setTimeout(() => {
    if ("closeAllConnections" in server) server.closeAllConnections();
    server.close(() => console.log("closed"));
  }, 10);
});
