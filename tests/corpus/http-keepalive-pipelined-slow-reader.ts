// A keep-alive connection carrying several requests whose responses are read
// slowly: a settled response must not stay pinned to the connection's output
// buffer, and every exchange still completes in Node's order.
import * as http from "node:http";

const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
const server = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/plain" });
  res.end("x".repeat(64 * 1024));
});
server.listen(0, "127.0.0.1", () => {
  const port = (server.address() as { port: number }).port;
  let done = 0;
  const finish = (): void => {
    done++;
    if (done === 4) {
      console.log("done", done);
      server.close();
      agent.destroy();
    }
  };
  for (let i = 0; i < 4; i++) {
    const req = http.get({ host: "127.0.0.1", port, path: `/slow-${i}`, agent }, (res) => {
      res.pause();
      setTimeout(() => {
        res.resume();
        res.on("end", finish);
      }, 10);
    });
    req.on("error", (e) => {
      console.log("error", (e as NodeJS.ErrnoException).code);
      finish();
    });
  }
});
