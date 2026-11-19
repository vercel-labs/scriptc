// A message's abort listener that captures the message must not keep it
// alive once the message settles: the message owns the signal, the signal
// owns the listener, and the listener closes over the message — a cycle
// nothing in the program can reach. A settled message never aborts, so its
// listeners go with it; Node's collector reclaims the same cycle.
import * as http from "node:http";

const COUNT = 48;
const MiB = 1024 * 1024;
const PAYLOAD = 4 * MiB;
let phase = 0;

const server = http.createServer((req, res) => {
  if (phase === 0) {
    // the same allocation without the cycle: the listener captures the
    // buffer alone, so the message still frees it
    const scratch = "z".repeat(PAYLOAD);
    req.signal.addEventListener("abort", () => {
      console.log("warm aborted", scratch.length);
    });
  } else {
    // the listener closes over the message: request, signal and listener
    // form a cycle the program cannot reach into
    const held = "z".repeat(PAYLOAD);
    req.signal.addEventListener("abort", () => {
      console.log("request aborted", req.url, held.length);
    });
  }
  req.resume();
  req.on("end", () => res.end("ok"));
});

server.listen(0, "127.0.0.1", () => {
  const port = (server.address() as { port: number }).port;
  let done = 0;
  let baseline = 0;
  const next = (): void => {
    if (done === COUNT * 2) {
      const grown = process.memoryUsage().rss - baseline;
      console.log("memory grew under 128 MiB:", grown < 128 * MiB);
      server.close();
      return;
    }
    if (done === COUNT) {
      phase = 1;
      baseline = process.memoryUsage().rss;
    }
    done += 1;
    http.get({ host: "127.0.0.1", port, path: "/" + done }, (res) => {
      res.signal.addEventListener("abort", () => {
        console.log("response aborted", res.statusCode);
      });
      res.resume();
      res.on("end", next);
    }).on("error", next);
  };
  next();
});
