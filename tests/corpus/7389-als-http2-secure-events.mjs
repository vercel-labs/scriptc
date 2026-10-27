// AsyncLocalStorage contexts of node:http2 events over TLS
// (http2.createSecureServer and an https: authority). They follow corpus
// 7387's rules, with one difference that comes from the transport: a TLS
// server's connections run in the context of its listen() call, so a
// server.close() callback that waits for the sessions runs there too.
// Lines are sorted at the end: events on the two sides may interleave.
import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import http2 from "node:http2";

const key = fs.readFileSync("tests/fixtures/server/certs/localhost-key.pem");
const cert = fs.readFileSync("tests/fixtures/server/certs/localhost.pem");
const ca = fs.readFileSync("tests/fixtures/server/certs/ca.pem", "utf8");

const store = new AsyncLocalStorage();
const lines = [];
const log = (what) => lines.push(`${what}: ${store.getStore() ?? "none"}`);

/** @returns {Promise<void>} */
function requestScenario() {
  return new Promise((resolve) => {
    const server = store.run("create", () => http2.createSecureServer({ key, cert }));
    server.on("session", () => log("server session"));
    server.on("stream", (stream) => {
      log("server stream");
      stream.on("data", () => log("server stream data"));
      stream.on("end", () => {
        log("server stream end");
        store.run("respond", () => {
          stream.respond({ ":status": 200 });
          stream.end("ok");
        });
      });
    });
    store.run("listen", () =>
      server.listen(0, () => {
        log("listening");
        const client = store.run("connect", () =>
          http2.connect(`https://localhost:${server.address().port}`, { ca }),
        );
        client.on("connect", () => log("client connect"));
        client.on("close", () => log("client session close"));
        const req = store.run("request", () => client.request({ ":method": "POST", ":path": "/" }));
        req.on("response", () => log("client response"));
        req.on("data", () => log("client data"));
        req.on("end", () => {
          log("client end");
          store.run("close", () => {
            client.close();
            server.close(() => {
              log("server close callback");
              resolve();
            });
          });
        });
        store.run("write", () => {
          req.write("x");
          req.end();
        });
      }),
    );
  });
}

/** @returns {Promise<void>} */
function resetScenario() {
  return new Promise((resolve) => {
    const server = store.run("reset-create", () => http2.createSecureServer({ key, cert }));
    server.on("stream", (stream) => {
      log("reset server stream");
      stream.on("close", () => log("reset server stream close"));
      store.run("reset", () => stream.close(http2.constants.NGHTTP2_CANCEL));
    });
    store.run("reset-listen", () =>
      server.listen(0, () => {
        const client = store.run("reset-connect", () =>
          http2.connect(`https://localhost:${server.address().port}`, { ca }),
        );
        const req = store.run("reset-request", () => client.request({ ":path": "/" }));
        req.on("close", () => {
          log("reset client close");
          client.close();
          server.close(() => resolve());
        });
        req.end();
      }),
    );
  });
}

await requestScenario();
await resetScenario();
lines.sort();
for (const line of lines) console.log(line);
