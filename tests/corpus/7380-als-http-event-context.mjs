// AsyncLocalStorage contexts of node:http, node:https and node:tls events.
// A server's 'request' event and its requests' and responses' events run
// in the context of the server's listen() call. A client request's
// events, its response callback and its response's events run in the
// context of the http.request() call, also on a keep-alive socket that
// an earlier request used. TLS client sockets run in the tls.connect()
// call's context, and a TLS server's connections in its listen()
// context. Lines are sorted at the end: events on different sockets may
// interleave.
import { AsyncLocalStorage } from "node:async_hooks";
import * as fs from "node:fs";
import http from "node:http";
import https from "node:https";
import tls from "node:tls";

const store = new AsyncLocalStorage();
const lines = [];
const log = (what) => lines.push(`${what}: ${store.getStore() ?? "none"}`);

/** @returns {Promise<void>} */
function httpScenario() {
  return new Promise((resolve) => {
    const server = store.run("create", () =>
      http.createServer((req, res) => {
        log("request callback");
        req.on("data", () => log("request data"));
        req.on("end", () => {
          log("request end");
          res.end("ok");
        });
        res.on("finish", () => log("response finish"));
        res.on("close", () => log("response close"));
      }),
    );
    server.on("request", () => log("request event"));
    store.run("listen", () =>
      server.listen(0, () => {
        const port = server.address().port;
        const req = store.run("request-call", () =>
          http.request({ port, method: "POST" }, (res) => {
            log("response callback");
            res.on("data", () => log("client response data"));
            res.on("end", () => log("client response end"));
          }),
        );
        store.run("register", () => {
          req.on("socket", () => log("client socket"));
          req.on("finish", () => log("client finish"));
          req.on("close", () => {
            log("client close");
            server.close(() => resolve());
          });
        });
        store.run("end-call", () => req.end("body"));
      }),
    );
  });
}

/** @returns {Promise<void>} */
function keepAliveScenario() {
  return new Promise((resolve) => {
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    const server = http.createServer((req, res) => res.end("ok"));
    server.listen(0, () => {
      const port = server.address().port;
      let done = 0;
      for (const name of ["first", "second"]) {
        store.run(name, () => {
          const req = http.get({ port, agent }, (res) => {
            log(`${name} response`);
            res.on("data", () => {});
            res.on("end", () => {
              log(`${name} response end`);
              if (++done === 2) {
                agent.destroy();
                server.close(() => resolve());
              }
            });
          });
          req.on("finish", () => log(`${name} finish`));
          req.on("close", () => log(`${name} close`));
        });
      }
    });
  });
}

const key = fs.readFileSync("tests/fixtures/server/certs/localhost-key.pem");
const cert = fs.readFileSync("tests/fixtures/server/certs/localhost.pem");
const ca = fs.readFileSync("tests/fixtures/server/certs/ca.pem", "utf8");

/** @returns {Promise<void>} */
function httpsScenario() {
  return new Promise((resolve) => {
    const server = https.createServer({ key, cert }, (req, res) => {
      log("https request");
      req.resume();
      res.on("finish", () => log("https response finish"));
      res.end("ok");
    });
    store.run("https-listen", () =>
      server.listen(0, () => {
        const port = server.address().port;
        store.run("https-get", () =>
          https
            .get({ port, host: "localhost", ca }, (res) => {
              log("https response");
              res.on("data", () => {});
              res.on("end", () => log("https response end"));
            })
            .on("close", () => {
              log("https client close");
              server.close(() => resolve());
            }),
        );
      }),
    );
  });
}

/** @returns {Promise<void>} */
function tlsScenario() {
  return new Promise((resolve) => {
    const server = tls.createServer({ key, cert }, (sock) => {
      log("tls secureConnection");
      sock.on("data", () => {
        log("tls server data");
        sock.end("bye");
      });
    });
    store.run("tls-listen", () =>
      server.listen(0, () => {
        const client = store.run("tls-connect", () =>
          tls.connect({ port: server.address().port, host: "localhost", ca }, () => {
            log("tls secureConnect");
            client.write("hi");
          }),
        );
        client.on("data", () => log("tls client data"));
        client.on("end", () => log("tls client end"));
        client.on("close", () => {
          log("tls client close");
          server.close(() => resolve());
        });
      }),
    );
  });
}

await httpScenario();
await keepAliveScenario();
await httpsScenario();
await tlsScenario();
for (const line of lines.sort()) console.log(line);
