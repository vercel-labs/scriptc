// Unpiping the last destination pauses the message: body bytes that arrive
// while nothing consumes it wait in the message, and a consumer that attaches
// later and calls resume() still reads the whole body (Node's rule). The
// destination the message was unpiped from receives nothing. Strict
// ping-pong: one exchange.
import { createServer, request } from "node:http";
import { createServer as createNetServer, connect } from "node:net";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Socket } from "node:net";

let sinkBytes = 0;
let sinkPort = 0;

const sink = createNetServer((socket: Socket) => {
  socket.on("data", (chunk: Buffer) => {
    sinkBytes += chunk.length;
  });
});

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const socket = connect({ port: sinkPort, host: "127.0.0.1" });
  req.pipe(socket);
  req.unpipe(socket);
  // Nothing consumes the body now: the bytes that arrive must wait for the
  // consumer below instead of being dropped.
  setTimeout(() => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    req.on("end", () => {
      console.log(`late consumer read: "${body}" sink bytes: ${sinkBytes}`);
      socket.end();
      res.end("done");
    });
    req.resume();
  }, 100);
});

sink.listen(0, () => {
  const sinkAddress = sink.address();
  if (sinkAddress === null || typeof sinkAddress === "string") throw new Error("no port");
  sinkPort = sinkAddress.port;
  server.listen(0, () => {
    const serverAddress = server.address();
    if (serverAddress === null || typeof serverAddress === "string") throw new Error("no port");
    const req = request(
      { port: serverAddress.port, path: "/relay", method: "POST" },
      (res: IncomingMessage) => {
        let answer = "";
        res.on("data", (chunk: Buffer) => {
          answer += chunk.toString("utf8");
        });
        res.on("end", () => {
          console.log(`client read: "${answer}"`);
          server.close(() => {
            sink.close(() => console.log("closed"));
          });
        });
      }
    );
    req.end("payload");
  });
});
