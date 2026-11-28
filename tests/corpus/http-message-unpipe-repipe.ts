// Piping the message again after an unpipe resumes it, as Node's pipe does:
// the unpipe paused the message, and the new destination receives the whole
// body without an explicit resume(). The destination the message was
// unpiped from receives nothing. Strict ping-pong: one exchange.
import { createServer, request } from "node:http";
import { createServer as createNetServer, connect } from "node:net";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Socket } from "node:net";

let firstBytes = 0;
let secondBytes = 0;
let firstPort = 0;
let secondPort = 0;

const firstSink = createNetServer((socket: Socket) => {
  socket.on("data", (data: Buffer) => {
    firstBytes += data.length;
  });
});

const secondSink = createNetServer((socket: Socket) => {
  socket.on("data", (data: Buffer) => {
    secondBytes += data.length;
  });
});

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const first = connect({ port: firstPort, host: "127.0.0.1" });
  const second = connect({ port: secondPort, host: "127.0.0.1" });
  req.pipe(first);
  req.unpipe(first);
  // No resume(): the new pipe destination starts the flow again.
  req.pipe(second);
  req.on("end", () => {
    setTimeout(() => {
      console.log(`first bytes: ${firstBytes} second bytes: ${secondBytes}`);
      first.end();
      second.end();
      res.end("done");
    }, 100);
  });
});

firstSink.listen(0, () => {
  const firstAddress = firstSink.address() as { port: number };
  firstPort = firstAddress.port;
  secondSink.listen(0, () => {
    const secondAddress = secondSink.address() as { port: number };
    secondPort = secondAddress.port;
    server.listen(0, () => {
      const serverAddress = server.address() as { port: number };
      const client = request(
        { port: serverAddress.port, path: "/relay", method: "POST" },
        (res: IncomingMessage) => {
          let answer = "";
          res.on("data", (data: Buffer) => {
            answer += data.toString("utf8");
          });
          res.on("end", () => {
            console.log(`client read: "${answer}"`);
            server.close(() =>
              firstSink.close(() => secondSink.close(() => console.log("closed")))
            );
          });
        }
      );
      client.flushHeaders();
      // The body arrives only after the re-pipe.
      setTimeout(() => client.end("payload"), 30);
    });
  });
});
