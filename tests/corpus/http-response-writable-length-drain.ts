// ServerResponse backpressure: write() answers the Writable boolean (false
// once the buffered body crosses writableHighWaterMark), writableLength
// counts the unsent body, and 'drain' fires once the buffer empties.
import * as http from "node:http";

const server = http.createServer((_req, res) => {
  console.log("fresh", res.writableLength, res.writableHighWaterMark);
  res.cork();
  const a = res.write("a".repeat(30000));
  console.log("a", a, res.writableLength >= 30000, res.writableLength < res.writableHighWaterMark);
  const b = res.write("b".repeat(30000));
  console.log("b", b, res.writableLength >= 60000, res.writableLength < res.writableHighWaterMark);
  const c = res.write("c".repeat(30000));
  console.log("c", c, res.writableLength > 90000, res.writableLength > res.writableHighWaterMark);
  res.on("drain", () => {
    console.log("drain", res.writableLength === 0, res.writableLength);
    res.end();
  });
  res.uncork();
  // Still buffered right after the uncork call: the socket has not flushed.
  console.log("after uncork", res.headersSent, res.writableLength > 0);
});

server.listen(0, "127.0.0.1", () => {
  const { port } = server.address() as { port: number };
  const req = http.get({ hostname: "127.0.0.1", port, path: "/" }, (res) => {
    let length = 0;
    res.on("data", (chunk: Uint8Array) => {
      length += chunk.byteLength;
    });
    res.on("end", () => {
      console.log("body", length, res.statusCode);
      server.close(() => console.log("closed"));
    });
  });
  req.on("error", (error) => console.log("client error", error.message));
});
