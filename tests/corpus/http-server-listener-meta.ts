// The server's EventEmitter surface: 'newListener' fires with the event
// name BEFORE a listener joins a list and a handler that throws abandons
// the add, listeners() answers the registered functions in registration
// order (Node's identity), and off/removeListener removes the most
// recently added match. The HTTP request-side events and the net server's
// own lists answer the same way.
import * as http from "node:http";
import * as net from "node:net";
import type { AddressInfo } from "node:net";

const order: string[] = [];
const base = (_req: http.IncomingMessage, res: http.ServerResponse) => res.end("create");
const server = http.createServer(base);

const seen = (event: string) => {
  order.push(event);
};
const first = (_req: http.IncomingMessage, res: http.ServerResponse) => res.end("first");
const second = (_req: http.IncomingMessage, res: http.ServerResponse) => res.end("second");

server.on("newListener", seen);
server.on("request", first);
server.on("close", () => {});
console.log("notified", order.join(","));

const before = server.listeners("request");
console.log("request listeners", before.length, before.includes(first), before.includes(second));
console.log("close listeners", server.listeners("close").length);
console.log("error listeners", server.listeners("error").length);

server.off("request", first);
const after = server.listeners("request");
console.log("after off", after.length, after.includes(first));
server.on("request", second);

// A throwing 'newListener' handler abandons the add that fired it.
const boom = () => {
  throw new Error("boom");
};
server.on("newListener", boom);
const third = (_req: http.IncomingMessage, res: http.ServerResponse) => res.end("third");
try {
  server.on("request", third);
  console.log("unexpected add");
} catch (e) {
  console.log("aborted", (e as Error).message);
}
console.log("unchanged", server.listeners("request").length);
server.off("newListener", boom);

// setTimeout(ms, callback) adds the callback to the 'timeout' list the same
// way on() does, so a throwing 'newListener' handler escapes the call and
// the add never happens. The ms value is stored before the add, as in Node.
const guard = http.createServer(() => {});
const timeoutBoom = () => {
  throw new Error("timeout boom");
};
guard.on("newListener", timeoutBoom);
try {
  guard.setTimeout(5, () => console.log("timeout fired"));
  console.log("unexpected timeout add");
} catch (e) {
  console.log("aborted timeout", (e as Error).message);
}
console.log("timeout property", guard.timeout);
console.log("timeout listeners", guard.listeners("timeout").length);
guard.off("newListener", timeoutBoom);

// listen(..., callback) adds the callback with once('listening', ...) before
// it binds, so 'newListener' fires for it, and a handler that throws escapes
// the call and the server does not listen. The port, host and path forms
// each add the callback this way. A net server has no listener of its own
// on 'listening' (an HTTP server has Node's connection tracking there).
const listenGuard = net.createServer();
const listenEvents: string[] = [];
listenGuard.on("newListener", (event: string) => listenEvents.push(event));
const listenBoom = (event: string) => {
  if (event === "listening") throw new Error("listen boom");
};
listenGuard.on("newListener", listenBoom);
try {
  listenGuard.listen(0, () => console.log("unexpected listening"));
  console.log("unexpected listen");
} catch (e) {
  console.log("aborted listen", (e as Error).message);
}
try {
  listenGuard.listen(0, "127.0.0.1", () => console.log("unexpected host listening"));
  console.log("unexpected host listen");
} catch (e) {
  console.log("aborted host listen", (e as Error).message);
}
try {
  listenGuard.listen("listen-guard-never-bound.sock", () =>
    console.log("unexpected path listening"),
  );
  console.log("unexpected path listen");
} catch (e) {
  console.log("aborted path listen", (e as Error).message);
}
console.log("listen events", listenEvents.join(","));
console.log("listen state", listenGuard.listening, listenGuard.listeners("listening").length);
listenGuard.off("newListener", listenBoom);

// once('newListener') fires for the next add only.
const onceSeen: string[] = [];
server.once("newListener", (event: string) => onceSeen.push(event));
server.on("timeout", () => {});
server.on("timeout", () => {});
console.log("once", onceSeen.join(","));

server.off("newListener", seen);
console.log("newListener listeners", server.listeners("newListener").length);
server.off("request", base);
console.log("answering", server.listeners("request").length);

server.listen(0, () => {
  const port = (server.address() as AddressInfo).port;
  http.get({ host: "127.0.0.1", port }, (res) => {
    res.setEncoding("utf8");
    res.on("data", (chunk: string) => console.log("body", chunk));
    res.on("end", () => {
      server.close(() => {
        const netServer = net.createServer();
        const netOrder: string[] = [];
        const onConnection = (socket: net.Socket) => socket.end("connected");
        netServer.on("newListener", (event: string) => netOrder.push(event));
        netServer.on("connection", onConnection);
        console.log("net notified", netOrder.join(","));
        console.log("net connection listeners", netServer.listeners("connection").length);
        netServer.off("connection", onConnection);
        netServer.on("connection", (socket: net.Socket) => socket.end("again"));
        console.log("net after off", netServer.listeners("connection").length);
        netServer.listen(0, () => {
          const netPort = (netServer.address() as AddressInfo).port;
          const client = net.connect(netPort, "127.0.0.1");
          client.setEncoding("utf8");
          client.on("data", (chunk: string) => console.log("net body", chunk));
          client.on("close", () => {
            netServer.close(() => {});
            // A 'newListener' handler that captures its own server is a
            // cycle the traceability story cannot collect: settlement must
            // drop the list so nothing outlives the close (the sanitized
            // lane's RC audit checks it).
            const cycle = http.createServer((_req: http.IncomingMessage, res: http.ServerResponse) =>
              res.end("cycle"),
            );
            const cycleStates: boolean[] = [];
            cycle.on("newListener", () => {
              cycleStates.push(cycle.listening);
            });
            cycle.listen(0, "127.0.0.1", () => {
              console.log("cycle listening");
              // The same cycle on a server whose listen fails: the failed
              // listen drops the list as well.
              const failed = http.createServer();
              const failedStates: boolean[] = [];
              failed.on("newListener", () => {
                failedStates.push(failed.listening);
              });
              failed.on("error", (err: Error) => {
                console.log("failed listen", (err as NodeJS.ErrnoException).code, failedStates.length);
                cycle.close(() => {
                  console.log("cycle closed", cycle.listening);
                });
              });
              failed.listen((cycle.address() as AddressInfo).port, "127.0.0.1");
            });
          });
        });
      });
    });
  });
});
