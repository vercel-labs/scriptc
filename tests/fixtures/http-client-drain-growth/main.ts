// Steady-state retention for a client request's socket-drain bridge: many
// uploads at or above the client message's 64 KiB high-water mark, all on one
// pooled keep-alive connection, while the server consumes every body promptly
// and answers. A corked write that answers false arms a one-shot socket-'drain'
// listener whose closure retains the request, and the socket it lands on is the
// one the pool hands to every later exchange. The request settles at 'close',
// which takes the bridge off the socket's list, so a pooled exchange frees its
// request, response, headers and context instead of accumulating behind the
// connection. The program prints its resident size after the last exchange;
// tests/harness/http-client-drain-growth.test.ts bounds it.
import * as http from "node:http";
import * as net from "node:net";

const exchanges = 3000;
// Each exchange's path is its own string on purpose: a retained request keeps
// the path it was given, so a run that keeps them measures the path.
const padText = "p".repeat(8 * 1024);
const body = Buffer.alloc(160 * 1024, 0x62);

const server = http.createServer((incoming, outgoing) => {
  incoming.resume();
  incoming.on("end", () => {
    outgoing.writeHead(200, { "Content-Length": "2" });
    outgoing.end("ok");
  });
});

server.listen(0, "127.0.0.1", () => {
  const { port } = server.address() as net.AddressInfo;
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  let done = 0;
  const next = (): void => {
    const request = http.request(
      { host: "127.0.0.1", port, method: "POST", agent, path: "/" + padText + String(done) },
      (response) => {
        response.resume();
        response.on("end", () => {
          done += 1;
          if (done < exchanges) {
            next();
            return;
          }
          agent.destroy();
          server.close(() => {
            const rss = process.memoryUsage.rss();
            // 3000 retained requests carry 3000 paths of 8 KiB, more than
            // 24 MiB, besides their response, headers and context; a bounded
            // run stays well under this.
            const bounded = rss < 20 * 1024 * 1024;
            console.log("exchanges", done, bounded ? "rss under 20 MiB" : "rss over");
          });
        });
      },
    );
    request.on("error", (error: Error) => {
      console.log("unexpected error", error.message);
    });
    // The write waits for the connection: the bridge then arms on the socket
    // the pool hands to the next exchange, not on this request's dial handle.
    setTimeout(() => {
      request.cork();
      request.write(body);
      request.uncork();
      request.end();
    }, 1);
  };
  next();
});
