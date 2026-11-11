// The TypeScript twin of compat-http-server-tail.mjs: http and https
// server members the header and agent programs do not reach, from a typed
// source. The 'checkExpectation' event for an Expect header that is not
// 100-continue, an outgoing message's connection alias and setTimeout(),
// and an https.Server's setTimeout(), closeIdleConnections() and
// closeAllConnections().
import * as http from "node:http";
import * as https from "node:https";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";

await new Promise<void>((resolve) => {
  const server = http.createServer((_request, response) => {
    response.end("plain");
  });
  server.on("checkExpectation", (request, response) => {
    console.log("checkExpectation", request.headers.expect);
    response.statusCode = 417;
    response.end();
  });
  server.listen(0, "127.0.0.1", () => {
    http
      .request({ port: (server.address() as AddressInfo).port, host: "127.0.0.1", headers: { Expect: "weird" }, agent: false }, (response) => {
        console.log(response.statusCode);
        response.resume();
        response.on("end", () => {
          server.close(() => resolve());
        });
      })
      .end();
  });
});

await new Promise<void>((resolve) => {
  const server = http.createServer((_request, response) => {
    console.log(response.connection === response.socket, response.setTimeout(1000, () => {}) === response);
    response.end("ok");
  });
  server.listen(0, "127.0.0.1", () => {
    http.get({ port: (server.address() as AddressInfo).port, host: "127.0.0.1", agent: false }, (response) => {
      response.resume();
      response.on("end", () => {
        server.close(() => resolve());
      });
    });
  });
});

await new Promise<void>((resolve) => {
  const server = https.createServer(
    { key: readFileSync("tests/fixtures/server/certs/localhost-key.pem"), cert: readFileSync("tests/fixtures/server/certs/localhost.pem") },
    (_request, response) => {
      response.end("secure");
    },
  );
  console.log(server.setTimeout(1000) === server, server.timeout);
  server.listen(0, "127.0.0.1", () => {
    https.get(
      { port: (server.address() as AddressInfo).port, host: "127.0.0.1", servername: "localhost", ca: readFileSync("tests/fixtures/server/certs/ca.pem"), agent: false },
      (response) => {
        console.log(response.statusCode);
        response.resume();
        response.on("end", () => {
          server.closeIdleConnections();
          server.closeAllConnections();
          server.close(() => {
            console.log("closed");
            resolve();
          });
        });
      },
    );
  });
});
