// IncomingMessage.signal's abort listeners usually capture the request (and
// the response). Once a request settles its listeners are released, so a
// long run of completed requests does not accumulate them. Argv: the number
// of requests; stdout: the resident-set growth in bytes.
import * as http from "node:http";
import type { AddressInfo } from "node:net";

const requests = Number(process.argv[2]);

const server = http.createServer((req, res) => {
  req.signal.addEventListener("abort", () => {
    // the listener captures the request and the response
    console.log("aborted", req.url, req.signal.aborted, res.writableEnded);
  });
  res.end("ok");
});

async function main(): Promise<void> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const agent = new http.Agent({ keepAlive: true });
  const once = (): Promise<void> =>
    new Promise<void>((resolve) => {
      const req = http.get({ host: "127.0.0.1", port, path: "/", agent }, (res) => {
        res.resume();
        res.on("end", () => resolve());
      });
      req.on("error", () => resolve());
    });
  for (let i = 0; i < 500; i++) await once();
  const before = process.memoryUsage().rss;
  for (let i = 0; i < requests; i++) await once();
  console.log("requests", requests);
  console.log("grown", process.memoryUsage().rss - before);
  agent.destroy();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  console.log("closed");
}

void main();
