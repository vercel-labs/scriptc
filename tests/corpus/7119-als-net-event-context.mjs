// AsyncLocalStorage contexts of node:net events. A client socket's events
// run in the context of the net.connect() call, whatever context the
// listener was registered in, also after a destroy() from elsewhere. The
// server's 'listening', 'connection' and 'error' events run in the
// context of the listen() call. An accepted socket's own events run with
// no store. write() and end() callbacks, and 'finish', run in the context
// of their call. server.close(callback) runs in the close() call's
// context when no connection is open, and with no store when it waits for
// the last connection. Lines are sorted at the end: events on different
// sockets may interleave.
import { AsyncLocalStorage } from "node:async_hooks";
import net from "node:net";

const store = new AsyncLocalStorage();
const lines = [];
const log = (what) => lines.push(`${what}: ${store.getStore() ?? "none"}`);

/** @returns {Promise<void>} */
function echoScenario() {
  return new Promise((resolve) => {
    const server = store.run("create", () =>
      net.createServer((sock) => {
        log("server connection callback");
        sock.on("data", () => {
          log("accepted data");
          store.run("in-data", () => sock.write("pong"));
        });
        sock.on("end", () => {
          log("accepted end");
          sock.end();
        });
        sock.on("close", () => log("accepted close"));
      }),
    );
    server.on("connection", () => log("server connection event"));
    server.on("close", () => {
      log("server close event");
      resolve();
    });
    store.run("listen", () =>
      server.listen(0, () => {
        log("listen callback");
        const client = store.run("connect", () => net.connect(server.address().port));
        store.run("register", () => {
          client.on("connect", () => {
            log("client connect");
            store.run("write", () => client.write("ping", () => log("write callback")));
          });
          client.on("data", () => {
            log("client data");
            store.run("end-call", () => client.end(() => log("end callback")));
          });
          client.on("finish", () => log("client finish"));
          client.on("end", () => log("client end"));
          client.on("close", () => {
            log("client close");
            store.run("close-call", () => server.close(() => log("server close callback")));
          });
        });
      }),
    );
  });
}

/** @returns {Promise<void>} */
function destroyScenario() {
  return new Promise((resolve) => {
    const server = net.createServer((sock) => sock.on("data", () => {}));
    server.listen(0, () => {
      const client = store.run("connect-2", () => net.connect(server.address().port));
      client.on("error", () => {});
      client.on("connect", () => {
        client.on("close", () => {
          log("close after a destroy elsewhere");
          server.close(() => resolve());
        });
        setTimeout(() => store.run("destroy-call", () => client.destroy()), 10);
      });
    });
  });
}

/** @returns {Promise<void>} */
function closeScenarios() {
  return new Promise((resolve) => {
    let pending = 3;
    const done = () => {
      if (--pending === 0) resolve();
    };
    const waiting = net.createServer((sock) => {
      store.run("conn", () => waiting.close(() => {
        log("close callback that waited");
        done();
      }));
      setTimeout(() => store.run("end", () => sock.end()), 20);
    });
    store.run("listen-3", () =>
      waiting.listen(0, () => {
        const client = net.connect(waiting.address().port);
        client.on("end", () => client.end());
      }),
    );
    const idle = net.createServer();
    store.run("listen-4", () =>
      idle.listen(0, () => {
        store.run("close-now", () => idle.close(() => {
          log("close callback of an idle server");
          done();
        }));
      }),
    );
    const taken = net.createServer();
    taken.listen(0, () => {
      const clash = net.createServer();
      clash.on("error", (e) => {
        log(`listen error ${e.code}`);
        taken.close(() => done());
      });
      store.run("clash-listen", () => clash.listen(taken.address().port));
    });
  });
}

await echoScenario();
await destroyScenario();
await closeScenarios();
for (const line of lines.sort()) console.log(line);
