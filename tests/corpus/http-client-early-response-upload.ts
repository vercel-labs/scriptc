// An early response to a request whose upload is still buffered: the request
// settles while its bytes are on the way, so the socket must not be pooled
// or handed to the next request with an upload still in its buffer, and the
// finished request's socket-owned waiters are released. The upload drains
// into the server that keeps reading, and the next request reaches the same
// connection.
import * as http from "node:http";
import * as net from "node:net";

let connections = 0;
const server = http.createServer((req: http.IncomingMessage, res: http.ServerResponse) => {
  req.resume();
  res.writeHead(200, { "content-length": "5" });
  res.end("early");
});
server.on("connection", (socket: net.Socket) => {
  connections += 1;
  socket.on("close", () => {});
});

server.listen(0, "127.0.0.1", () => {
  const port = (server.address() as net.AddressInfo).port;
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  const body = "x".repeat(1 << 20);
  let writeState = "pending";
  const first = http.request({
    port,
    host: "127.0.0.1",
    path: "/up",
    method: "POST",
    agent,
    headers: { "content-length": String(body.length) },
  });
  first.write(body, (err?: Error) => {
    writeState = (err as NodeJS.ErrnoException | undefined)?.code ?? "done";
  });
  first.end();
  first.on("error", (err: NodeJS.ErrnoException) => console.log("first error", err.code));
  first.on("response", (res: http.IncomingMessage) => {
    res.resume();
    res.on("end", () => {
      const second = http.get({ port, host: "127.0.0.1", path: "/after", agent }, (res2: http.IncomingMessage) => {
        res2.resume();
        res2.on("end", () => {
          setTimeout(() => {
            console.log(
              "first",
              res.statusCode,
              "second",
              res2.statusCode,
              "write",
              writeState,
              "connections",
              connections,
            );
            agent.destroy();
            server.close();
          }, 50);
        });
      });
      second.on("error", (err: NodeJS.ErrnoException) => console.log("second error", err.code));
    });
  });
});
