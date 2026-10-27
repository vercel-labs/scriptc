// AsyncLocalStorage contexts of node:http2 events. A client session's
// 'connect' and 'close' run in the context of the http2.connect() call,
// and a client stream's 'response', 'data', 'end' and 'close' in the
// context of the request() call. A server's 'session' and 'stream' events
// run in the context of its listen() call; a server stream's own 'data',
// 'end' and 'close' events run with no store, as does a server.close()
// callback that waits for the sessions. Lines are sorted at the end:
// events on the two sides may interleave.
import { AsyncLocalStorage } from "node:async_hooks";
import http2 from "node:http2";

const store = new AsyncLocalStorage();
const lines = [];
const log = (what) => lines.push(`${what}: ${store.getStore() ?? "none"}`);

/** @returns {Promise<void>} */
function requestScenario() {
  return new Promise((resolve) => {
    const server = store.run("create", () => http2.createServer());
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
          http2.connect(`http://localhost:${server.address().port}`),
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
    const server = store.run("reset-create", () => http2.createServer());
    server.on("stream", (stream) => {
      log("reset server stream");
      stream.on("close", () => log("reset server stream close"));
      store.run("reset", () => stream.close(http2.constants.NGHTTP2_CANCEL));
    });
    store.run("reset-listen", () =>
      server.listen(0, () => {
        const client = store.run("reset-connect", () =>
          http2.connect(`http://localhost:${server.address().port}`),
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
