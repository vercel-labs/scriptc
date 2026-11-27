// A streaming upload paced by 'drain': every drain handler writes the next
// chunk. Node emits 'drain' asynchronously, so a handler never re-enters the
// write that answered false — a long upload completes without growing the
// stack.
import * as http from "node:http";
import type { AddressInfo } from "node:net";

const CHUNK = "a".repeat(64 * 1024);
const CHUNKS = 512;

const server = http.createServer((req, res) => {
  let bytes = 0;
  req.on("data", (chunk: Buffer) => {
    bytes += chunk.length;
  });
  req.on("end", () => {
    console.log("received", bytes);
    res.end("ok");
  });
});

server.listen(0, "127.0.0.1", () => {
  const request = http.request(
    { port: (server.address() as AddressInfo).port, host: "127.0.0.1", method: "POST" },
    (response) => {
      response.resume();
      response.on("end", () => server.close());
    },
  );
  request.on("error", (error: NodeJS.ErrnoException) => console.log("error", error.code));
  let sent = 0;
  const pump = () => {
    while (sent < CHUNKS) {
      sent++;
      if (!request.write(CHUNK)) {
        request.once("drain", pump);
        return;
      }
    }
    request.end();
  };
  pump();
});
