// The client's 'upgrade' listener: a 101 response hands the response, the
// socket and the buffered head to the listener instead of emitting 'response'.
import * as http from "node:http";

const server = http.createServer((req, res) => {
  res.end("plain");
});
server.on("upgrade", (req, socket, head) => {
  console.log("server upgrade", req.url, head.length);
  socket.write("HTTP/1.1 101 Switching Protocols\r\nconnection: Upgrade\r\nupgrade: test\r\n\r\n");
  socket.end("hello");
});
server.listen(0, "127.0.0.1", () => {
  const port = (server.address() as { port: number }).port;
  const req = http.request({
    host: "127.0.0.1",
    port,
    path: "/up",
    headers: { connection: "Upgrade", upgrade: "test" },
  });
  req.on("upgrade", (res, socket, head) => {
    console.log("client upgrade", res.statusCode, JSON.stringify(head.toString("utf8")));
    socket.end();
    server.close();
  });
  req.on("response", (res) => {
    console.log("client response", res.statusCode);
    res.resume();
  });
  req.on("error", (e) => {
    console.log("error", (e as NodeJS.ErrnoException).code);
    server.close();
  });
  req.end();
});
