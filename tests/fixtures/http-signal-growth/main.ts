// Steady-state retention for a message's signal listeners: many requests
// over one keep-alive connection, each with an 'abort' listener that captures
// the message and a 1 MiB buffer. A message settles at 'close', which drops
// the signal's listeners, so the captured state is freed per exchange instead
// of accumulating behind the connection. The program prints its resident size
// after the last exchange; tests/harness/http-message-signal-leaks.test.ts
// bounds it.
import * as http from "node:http";
import * as net from "node:net";

const exchanges = 500;

const server = http.createServer((incoming, outgoing) => {
  const payload = Buffer.alloc(1024 * 1024, 1);
  incoming.signal.addEventListener("abort", () => {
    console.log("unexpected abort", incoming.url.length, payload.length);
  });
  outgoing.end("ok");
});

server.listen(0, "127.0.0.1", () => {
  const { port } = server.address() as net.AddressInfo;
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  let done = 0;
  const next = (): void => {
    http.get({ host: "127.0.0.1", port, agent }, (response) => {
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
          // 500 captured 1 MiB buffers are 500 MiB if the settle does not
          // free them; a bounded run stays well under this.
          const bounded = rss < 200 * 1024 * 1024;
          console.log("exchanges", done, bounded ? "rss under 200 MiB" : "rss over");
        });
      });
    });
  };
  next();
});
