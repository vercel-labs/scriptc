// A write with no bytes still completes: its callback runs once the bytes
// already queued have reached the socket.
import * as http from "node:http";

const server = http.createServer((req, res) => {
  res.flushHeaders();
  console.log("res empty string:", res.write("", () => console.log("res empty string callback")));
  console.log("res empty buffer:", res.write(Buffer.alloc(0), () => console.log("res empty buffer callback")));
  setTimeout(() => res.end("ok"), 100);
});

server.listen(0, "127.0.0.1", () => {
  const port = (server.address() as { port: number }).port;
  const req = http.request({ host: "127.0.0.1", port, method: "POST" }, (res) => {
    res.resume();
    res.on("end", () => {
      console.log("client end", res.statusCode);
      server.close();
    });
  });
  req.on("socket", () => {
    console.log("req empty:", req.write("", () => console.log("req empty callback")));
    req.end("x");
  });
});
