// A paused client response stops reading its socket at the readable
// high-water mark instead of buffering the whole body, and resume() then
// delivers every held byte. Unpiping the last pipe destination is what
// pauses the message; the destination receives nothing after it leaves.
// Strict ping-pong: one exchange.
import { createServer, request } from "node:http";
import { createServer as createNetServer, connect } from "node:net";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Socket } from "node:net";

const BODY_BYTES = 16 * 1024 * 1024;
const CHUNK_BYTES = 64 * 1024;
const chunk = Buffer.alloc(CHUNK_BYTES, 0x61);

let sinkBytes = 0;
let sinkPort = 0;

const sink = createNetServer((socket: Socket) => {
  socket.on("data", (data: Buffer) => {
    sinkBytes += data.length;
  });
});

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  res.writeHead(200, { "content-length": String(BODY_BYTES) });
  let sent = 0;
  const pump = (): void => {
    while (sent < BODY_BYTES) {
      sent += CHUNK_BYTES;
      if (!res.write(chunk)) {
        res.once("drain", pump);
        return;
      }
    }
    res.end();
  };
  pump();
});

sink.listen(0, () => {
  const sinkAddress = sink.address() as { port: number };
  sinkPort = sinkAddress.port;
  server.listen(0, () => {
    const serverAddress = server.address() as { port: number };
    const req = request(
      { port: serverAddress.port, path: "/big", agent: false },
      (res: IncomingMessage) => {
        const destination = connect({ port: sinkPort, host: "127.0.0.1" });
        res.pipe(destination);
        res.unpipe(destination);
        setTimeout(() => {
          // The socket stopped at the buffer bound: the body is far larger.
          console.log(`bounded: ${res.socket.bytesRead < BODY_BYTES}`);
          let total = 0;
          res.on("data", (data: Buffer) => {
            total += data.length;
          });
          res.on("end", () => {
            console.log(`whole: ${total === BODY_BYTES} sink bytes: ${sinkBytes}`);
            destination.end();
            server.close(() => sink.close(() => console.log("closed")));
          });
          res.resume();
        }, 200);
      }
    );
    req.on("error", (err: Error) => console.log(`client error: ${err.message}`));
    req.end();
  });
});
