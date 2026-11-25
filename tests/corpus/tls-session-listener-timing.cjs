// The checked-dynamic lane of the 'session' event: it is not replayed to a
// listener added after the handshake, in either call shape.
"use strict";
const tls = require("node:tls");
const { readFileSync } = require("node:fs");

const cert = readFileSync("tests/fixtures/server/certs/localhost.pem");
const key = readFileSync("tests/fixtures/server/certs/localhost-key.pem");
const ca = readFileSync("tests/fixtures/server/certs/ca.pem");

function phase(name, attach) {
  return new Promise((resolve) => {
    let count = 0;
    let client;
    const server = tls.createServer(
      { key, cert, minVersion: "TLSv1.2", maxVersion: "TLSv1.2" },
      (sock) => sock.on("error", () => {}),
    );
    server.listen(0, "127.0.0.1", () => {
      const seen = () => {
        count += 1;
      };
      client = tls.connect(
        {
          port: server.address().port,
          host: "127.0.0.1",
          ca,
          servername: "localhost",
          minVersion: "TLSv1.2",
          maxVersion: "TLSv1.2",
        },
        () => {
          if (attach === "secureConnect") client.on("session", seen);
          if (attach === "late") setTimeout(() => client.on("session", seen), 50);
        },
      );
      if (attach === "early") client.on("session", seen);
      client.on("error", () => {});
      client.on("close", () => {
        console.log(name, "session count", count);
        server.close();
        resolve();
      });
      setTimeout(() => client.end(), 200);
    });
  });
}

(async () => {
  await phase("early", "early");
  await phase("secureConnect", "secureConnect");
  await phase("late", "late");
})();
