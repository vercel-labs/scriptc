// A destroyed request answers what Node's destroyed stream does: a write
// issued after destroy() runs its callback (after 'close') with
// ERR_STREAM_DESTROYED, a chunk still waiting in the message's own buffer is
// dropped with its callback, and end() never answers its callback.
import * as http from "node:http";

const server = http.createServer((req, res) => {
  res.end("ok");
});
server.listen(0, "127.0.0.1", () => {
  const port = (server.address() as { port: number }).port;
  const req = http.request({ port, host: "127.0.0.1", method: "POST", path: "/" });
  req.on("error", (e) => console.log("req error", (e as NodeJS.ErrnoException).code));
  req.on("close", () => console.log("req close destroyed", req.destroyed));
  // still in the message's buffer when destroy() runs: dropped silently
  req.write("a", (err?: NodeJS.ErrnoException) => console.log("buffered write cb", err ? err.code : "ok"));
  req.destroy();
  req.write("b", (err?: NodeJS.ErrnoException) =>
    console.log("write after destroy cb", err ? err.code : "ok"),
  );
  req.end(() => console.log("end cb"));
  setTimeout(() => server.close(), 200);
});
