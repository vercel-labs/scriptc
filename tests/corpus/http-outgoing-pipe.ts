// OutgoingMessage.pipe(): an outgoing message is write-only, so Node emits
// ERR_STREAM_CANNOT_PIPE. A response takes no 'error' listener here, which
// makes the emit the throw at the call; a request's 'error' listeners get it.
import * as http from "node:http";

const server = http.createServer((req, res) => {
  try {
    res.pipe();
    console.log("res pipe accepted");
  } catch (err) {
    const e = err as { code?: string; message?: string };
    console.log("res pipe", e.code, e.message);
  }
  // Stream.pipe's destination is accepted and ignored: Node's override
  // answers the same error.
  try {
    res.pipe({ write: () => true });
    console.log("res pipe destination accepted");
  } catch (err) {
    console.log("res pipe destination", (err as { code?: string }).code);
  }
  res.end("ok");
});

server.listen(0, "127.0.0.1", () => {
  const req = http.request(
    { host: "127.0.0.1", port: server.address().port, path: "/" },
    (res) => {
      res.on("data", () => {});
      res.on("end", () => {
        console.log("response", res.statusCode);
        server.close();
      });
    },
  );
  req.on("error", (err) => console.log("req pipe", (err as { code?: string }).code, err.message));
  req.pipe();
  req.end();
});
