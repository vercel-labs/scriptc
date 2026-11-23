// A tls.Server 'keylog' listener written as a normal function runs with
// `this` = the server, as Node's EventEmitter calls listeners; the socket's
// own keylog listener runs with `this` = the socket.
"use strict";
const tls = require("node:tls");
const { readFileSync } = require("node:fs");

const cert = readFileSync("tests/fixtures/server/certs/localhost.pem");
const key = readFileSync("tests/fixtures/server/certs/localhost-key.pem");
const ca = readFileSync("tests/fixtures/server/certs/ca.pem");

const server = tls.createServer(
  { key, cert, minVersion: "TLSv1.2", maxVersion: "TLSv1.2" },
  (sock) => {
    sock.on("error", () => {});
    sock.on("keylog", function () {
      sockThis = this === sock;
    });
  },
);
let serverThis = null;
let sockThis = null;
server.on("keylog", function () {
  serverThis = this === server;
});
server.on("secureConnection", () => {});

server.listen(0, "127.0.0.1", () => {
  const client = tls.connect({
    port: server.address().port,
    host: "127.0.0.1",
    ca,
    servername: "localhost",
    minVersion: "TLSv1.2",
    maxVersion: "TLSv1.2",
  });
  client.on("error", () => {});
  client.on("close", () => {
    setTimeout(() => {
      console.log("server this", serverThis);
      console.log("socket this", sockThis);
      server.close();
    }, 20);
  });
  setTimeout(() => client.end(), 80);
});
