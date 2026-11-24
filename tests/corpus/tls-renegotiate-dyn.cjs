// The checked-dynamic lane of tlsSocket.renegotiate: a TLS 1.3 connection
// answers false and hands the engine's wrong-version error to the
// completion, and a missing options object throws as Node's does.
"use strict";
const tls = require("node:tls");
const { readFileSync } = require("node:fs");

const cert = readFileSync("tests/fixtures/server/certs/localhost.pem");
const key = readFileSync("tests/fixtures/server/certs/localhost-key.pem");
const ca = readFileSync("tests/fixtures/server/certs/ca.pem");

const phase = (version) =>
  new Promise((resolve) => {
    const server = tls.createServer(
      { key, cert, minVersion: version, maxVersion: version },
      (sock) => {
        sock.on("error", () => {});
        sock.on("data", () => {});
      },
    );
    server.listen(0, "127.0.0.1", () => {
      const client = tls.connect({
        port: server.address().port,
        host: "127.0.0.1",
        ca,
        servername: "localhost",
        minVersion: version,
        maxVersion: version,
      });
      client.on("secure", () => {
        try {
          client.renegotiate();
          console.log(version, "no throw");
        } catch (error) {
          console.log(version, "threw", error.code, error.message);
        }
        const started = client.renegotiate({}, (error) => {
          console.log(version, "refused", error === null, error && error.code);
          client.end();
        });
        console.log(version, "started", started);
      });
      client.on("error", () => {});
      client.on("close", () => {
        server.close();
        resolve();
      });
    });
  });

(async () => {
  await phase("TLSv1.3");
})();
