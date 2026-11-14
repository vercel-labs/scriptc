// The shape the security review named: request-triggered temporary servers.
// Every request builds a short-lived net server whose persistent 'close'
// listener captures the server itself and an 8 KiB payload, serves one
// connection, closes, and is dropped. A settled server keeps its 'close'
// listeners only for the sweep that emits its 'close', so the listener and
// everything it captured are released before the next turn and repeated
// requests cannot accumulate servers. This program prints its resident size
// after the last request; tests/harness/net-close-listener-request-cycles.test.ts
// bounds it.
import * as http from "node:http";
import * as net from "node:net";

const rounds = 400;
let done = 0;

function report(): void {
  const rss = process.memoryUsage.rss();
  const bounded = rss < 40 * 1024 * 1024;
  console.log("rounds", done, bounded ? "rss under 40 MiB" : "rss over");
}

const outer = http.createServer((req, res) => {
  const payload = "p".repeat(8 * 1024);
  const temporary = net.createServer((socket) => {
    socket.end("ok");
  });
  // The capture: the listener reads its own server back, and keeps the
  // request's payload alive with it.
  temporary.on("close", () => {
    if (temporary.listening) console.log("still listening");
    if (payload.length === 0) console.log("empty payload");
  });
  temporary.listen(0, "127.0.0.1", () => {
    const port = (temporary.address() as net.AddressInfo).port;
    const socket = net.connect(port, "127.0.0.1", () => {
      socket.end();
    });
    socket.resume();
    socket.on("close", () => {
      temporary.close(() => {
        done += 1;
        if (done === rounds) {
          report();
          res.end("done");
          outer.close();
          return;
        }
        res.end("ok");
      });
    });
  });
});

outer.listen(0, "127.0.0.1", () => {
  const port = (outer.address() as net.AddressInfo).port;
  let sent = 0;
  const next = (): void => {
    if (sent === rounds) return;
    sent += 1;
    http.get({ host: "127.0.0.1", port, path: "/" }, (response) => {
      response.resume();
      response.on("end", next);
    });
  };
  next();
});
