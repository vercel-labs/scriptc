// https.Server takes the same timeout dials as http.Server: the optional
// milliseconds, the callback-only form of setTimeout, the chainable answer,
// and the forced and idle connection closes over TLS.
import { readFileSync } from "node:fs";
import * as https from "node:https";
import * as net from "node:net";

const ca = readFileSync("tests/fixtures/server/certs/ca.pem");
const cert = readFileSync("tests/fixtures/server/certs/localhost.pem");
const key = readFileSync("tests/fixtures/server/certs/localhost-key.pem");

const server = https.createServer({ cert, key }, (request, response) => {
  console.log("request", request.url);
  response.end("ok");
});

console.log("no args", server.setTimeout() === server);
console.log("undefined msecs", server.setTimeout(undefined, () => console.log("unused")) === server);
console.log("callback only", server.setTimeout(() => console.log("idle")) === server);
console.log("plain msecs", server.setTimeout(50) === server);

server.listen(0, "127.0.0.1", () => {
  const port = (server.address() as net.AddressInfo).port;
  const client = https.request({ host: "127.0.0.1", port, path: "/ok", ca, agent: false }, (response) => {
    response.resume();
    response.on("end", () => {
      console.log("client done", response.statusCode);
      server.closeIdleConnections();
      server.closeAllConnections();
      server.close(() => console.log("closed"));
    });
  });
  client.on("error", () => console.log("client error"));
  client.end();
});
