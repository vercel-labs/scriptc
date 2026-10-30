// AsyncLocalStorage contexts that follow the call rather than the resource.
// An HTTP server response ended inside another store runs its end()
// callback, 'finish' and 'close' in the end() call's context, not the
// server's listen() context. A stream.finished() callback registered with
// no store runs with no store, also when another context destroys the
// stream; one registered inside a store runs in that store.
import { AsyncLocalStorage } from "node:async_hooks";
import http from "node:http";
import { Readable, finished } from "node:stream";

const store = new AsyncLocalStorage();
const lines = [];
const log = (what) => lines.push(`${what}: ${store.getStore() ?? "none"}`);

/** @returns {Promise<void>} */
function responseScenario() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      log("request");
      res.on("finish", () => log("response finish"));
      res.on("close", () => log("response close"));
      store.run("handler-end", () => res.end("ok", () => log("response end callback")));
    });
    store.run("listen", () =>
      server.listen(0, () => {
        http.get(`http://localhost:${server.address().port}/`, (response) => {
          response.resume();
          response.on("end", () => server.close(() => resolve()));
        });
      }),
    );
  });
}
await responseScenario();

/** @returns {Promise<void>} */
function finishedScenario(registration) {
  return new Promise((resolve) => {
    const stream = new Readable({ read() {} });
    const register = () =>
      finished(stream, () => {
        log(`finished registered ${registration ?? "outside"}`);
        resolve();
      });
    if (registration === undefined) register();
    else store.run(registration, register);
    store.run("destroyer", () => stream.destroy());
  });
}
await finishedScenario(undefined);
await finishedScenario("inside");

lines.sort();
for (const line of lines) console.log(line);
