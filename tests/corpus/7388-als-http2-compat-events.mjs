// AsyncLocalStorage contexts of the node:http2 compatibility API. The
// createServer() request handler runs in the context of the server's
// listen() call. The request's 'end' and the response's 'finish' and
// 'close' follow the server stream, which runs with no store, whatever
// context calls res.end(). A client stream's 'response', 'data' and
// 'close' run in the context of the request() call, and the client
// session's 'close' in the context of the http2.connect() call. Lines are
// sorted at the end: events on the two sides may interleave.
import { AsyncLocalStorage } from "node:async_hooks";
import http2 from "node:http2";

const store = new AsyncLocalStorage();
const lines = [];
const log = (what) => lines.push(`${what}: ${store.getStore() ?? "none"}`);

const server = store.run("create", () =>
  http2.createServer((req, res) => {
    log("request handler");
    req.resume();
    req.on("end", () => {
      log("request end");
      res.on("finish", () => log("response finish"));
      res.on("close", () => log("response close"));
      store.run("respond", () => res.end("done"));
    });
  }),
);
store.run("listen", () =>
  server.listen(0, () => {
    const client = store.run("connect", () =>
      http2.connect(`http://localhost:${server.address().port}`),
    );
    client.on("close", () => {
      log("client session close");
      server.close(() => {
        lines.sort();
        for (const line of lines) console.log(line);
      });
    });
    const req = store.run("request", () => client.request({ ":method": "POST", ":path": "/x" }));
    req.on("response", () => log("client response"));
    req.on("data", () => log("client data"));
    req.on("close", () => {
      log("client stream close");
      store.run("close", () => client.close());
    });
    store.run("write", () => req.end("body"));
  }),
);
