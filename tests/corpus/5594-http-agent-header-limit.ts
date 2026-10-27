// A request's maxHeaderSize bounds its own response head, also when the
// request runs on a socket an earlier request used. Through a keepAlive
// agent with maxSockets 1, a queued request receives the freed socket and
// a later request takes the free one (reusedSocket). In both cases a
// smaller limit fails the response with HPE_HEADER_OVERFLOW, and a larger
// limit, or the default one, accepts a head the earlier request's limit
// would reject.
import * as http from "node:http";
import * as net from "node:net";

// Answers each request with an X-Big header of the size in its path, on a
// connection that stays open.
const upstream = net.createServer((s) => {
  s.on("error", () => {});
  let pending = "";
  s.on("data", (chunk: Buffer) => {
    pending += chunk.toString("latin1");
    let end = pending.indexOf("\r\n\r\n");
    while (end >= 0) {
      const head = pending.slice(0, end);
      pending = pending.slice(end + 4);
      const size = Number(head.split(" ")[1]!.slice(1));
      s.write(`HTTP/1.1 200 OK\r\nX-Big: ${"y".repeat(size)}\r\nContent-Length: 2\r\n\r\nok`);
      end = pending.indexOf("\r\n\r\n");
    }
  });
});

function get(agent: http.Agent, port: number, label: string, size: number, limit?: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const onResponse = (res: http.IncomingMessage) => {
      res.resume();
      res.on("end", () => {
        console.log(label, "status", res.statusCode, "reused", req.reusedSocket);
        resolve();
      });
    };
    const path = `/${size}`;
    const req =
      limit === undefined
        ? http.get({ host: "127.0.0.1", port, path, agent }, onResponse)
        : http.get({ host: "127.0.0.1", port, path, agent, maxHeaderSize: limit }, onResponse);
    req.on("error", (err: NodeJS.ErrnoException) => {
      console.log(label, "error", err.code, err.message, "reused", req.reusedSocket);
      resolve();
    });
  });
}

upstream.listen(0, "127.0.0.1", async () => {
  const port = (upstream.address() as { port: number }).port;

  // Queued: the second request waits for the slot and receives the socket.
  const queued = new http.Agent({ keepAlive: true, maxSockets: 1 });
  await Promise.all([get(queued, port, "queued first", 100, 1000), get(queued, port, "queued smaller", 100, 50)]);
  await Promise.all([get(queued, port, "queued first", 10, 100), get(queued, port, "queued larger", 17000, 20000)]);
  await Promise.all([get(queued, port, "queued first", 10, 100), get(queued, port, "queued default", 1000)]);
  queued.destroy();

  // Free: each later request starts after the earlier one finished.
  const free = new http.Agent({ keepAlive: true, maxSockets: 1 });
  await get(free, port, "free first", 100, 1000);
  await get(free, port, "free smaller", 100, 50);
  await get(free, port, "free first", 10, 100);
  await get(free, port, "free larger", 17000, 20000);
  await get(free, port, "free first", 10, 100);
  await get(free, port, "free default", 1000);
  free.destroy();
  upstream.close();
});
