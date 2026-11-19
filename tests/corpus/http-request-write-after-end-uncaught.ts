// @exit: 1
// A write after end() on a request whose socket is still attached is the
// same uncaught ERR_STREAM_WRITE_AFTER_END as the response's: write answers
// false, the synchronous tail runs, and the error emitted on the next tick
// exits the process with 1. (A request the exchange already destroyed only
// hands the error to the write's callback — see http-write-chunk-errors.)
import { createServer, request } from "node:http";

const server = createServer((req, res) => {
  req.on("data", () => {});
  req.on("end", () => {
    res.end("ok");
  });
});

server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  const outbound = request({ host: "127.0.0.1", port, method: "POST", agent: false }, (response) => {
    response.resume();
  });
  outbound.end("ping");
  const answered = outbound.write("late");
  console.log("write after end", answered, outbound.writableEnded, outbound.destroyed);
  console.log("handler tail");
});
