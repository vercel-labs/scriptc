// The typed server request's 'aborted' and the destroyed reads: a client
// that goes away before the response finishes aborts the request
// ('aborted', the response's 'close', the request's 'error' and 'close'),
// and a finished response leaves the request unaborted.
import * as http from "node:http";
import type { AddressInfo } from "node:net";

let round = 0;
const server = http.createServer((req, res) => {
  round++;
  const tag = `round ${round}`;
  req.on("aborted", () => console.log(tag, "req aborted", req.aborted, req.destroyed, req.complete));
  req.on("error", (e: NodeJS.ErrnoException) => console.log(tag, "req error", e.code, e.message));
  req.on("close", () => {
    console.log(tag, "req close", req.aborted, req.destroyed);
    next();
  });
  res.on("close", () => console.log(tag, "res close", res.destroyed, res.writableEnded));
  console.log(tag, "before", req.aborted, req.destroyed, res.destroyed);
  if (round === 2) {
    res.end("done");
    return;
  }
  res.write("partial");
});

// The server request's 'close' starts the next round.
function next(): void {
  if (round === 2) {
    server.close();
    return;
  }
  const port = (server.address() as AddressInfo).port;
  const req = http.get({ host: "127.0.0.1", port, agent: false }, (res) => {
    if (round < 2) res.once("data", () => req.destroy());
    else res.resume();
  });
  req.on("error", () => {});
}

server.listen(0, "127.0.0.1", next);
