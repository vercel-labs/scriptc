// A keep-alive client that repeatedly makes a response wait for buffered
// output: each completed response takes its deferred-close watch back, so a
// long-lived connection never accumulates them. The connection closes at the
// end and both sides report the same events.
import * as http from "node:http";
import type { AddressInfo } from "node:net";

const ROUNDS = 8;
const BODY = 4 << 20;

let finished = 0;
let closed = 0;

const server = http.createServer((req, res) => {
  req.resume();
  req.on("end", () => {
    res.on("finish", () => {
      finished++;
    });
    res.on("close", () => {
      closed++;
    });
    res.end("x".repeat(BODY));
  });
});

server.listen(0, "127.0.0.1", () => {
  const port = (server.address() as AddressInfo).port;
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  let sent = 0;
  const next = (): void => {
    if (sent === ROUNDS) {
      console.log("requests", sent, "finished", finished, "closed", closed);
      agent.destroy();
      server.close(() => console.log("server closed"));
      return;
    }
    sent++;
    const request = http.request({ port, host: "127.0.0.1", path: "/", agent }, (response) => {
      response.pause();
      setTimeout(() => {
        response.resume();
        response.on("end", next);
      }, 20);
    });
    request.on("error", (error: NodeJS.ErrnoException) => console.log("error", error.code));
    request.end();
  };
  next();
});
