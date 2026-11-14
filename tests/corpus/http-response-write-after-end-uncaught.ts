// @exit: 1
// A write after end() on a response with no 'error' listener is an
// uncaught ERR_STREAM_WRITE_AFTER_END: write answers false at the call and
// the handler's synchronous tail runs, then the error is emitted on the
// next tick and the process exits 1. The program's stdout is what the
// differential harness compares; the exit code is the crash.
import { createServer, request } from "node:http";

const server = createServer((req, res) => {
  req.on("data", () => {});
  req.on("end", () => {
    res.end("first");
    const answered = res.write("second");
    console.log("write after end", answered, res.writableEnded, res.writableFinished);
    console.log("handler tail");
  });
});

server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  const outbound = request({ host: "127.0.0.1", port, method: "POST", agent: false }, (response) => {
    response.resume();
  });
  outbound.end("ping");
});
