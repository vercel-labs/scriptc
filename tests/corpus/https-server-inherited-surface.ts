// The https.Server rows it inherits from http/net: the timeout dial, the
// connection-closing calls before and after listen, close's callback, and
// listen's callback, all over a TLS server.
import { readFileSync } from "node:fs";
import * as https from "node:https";
import * as net from "node:net";

const cert = readFileSync("tests/fixtures/server/certs/localhost.pem");
const key = readFileSync("tests/fixtures/server/certs/localhost-key.pem");

const server = https.createServer({ cert, key }, (_req, res) => res.end("ok"));
console.log("timeout0", server.timeout);
const returned = server.setTimeout(1234);
console.log("setTimeout returns server", returned === server, server.timeout);
server.setTimeout(0);
console.log("timeout reset", server.timeout);
server.closeAllConnections();
server.closeIdleConnections();
console.log("closed idle connections before listen");
server.listen(0, "127.0.0.1", () => {
  const address = server.address() as net.AddressInfo;
  console.log("listening", server.listening, typeof address.port);
  server.closeIdleConnections();
  server.closeAllConnections();
  server.close(() => {
    console.log("closed", server.listening);
  });
});
