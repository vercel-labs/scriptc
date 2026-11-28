// Unpiping the last destination pauses the message even while a 'data'
// listener is attached: Node's flowing state goes false, and only resume()
// starts it again. Body bytes that arrive in between wait in the message, so
// a listener removed before a replacement attaches loses nothing. The
// destination the message was unpiped from receives nothing. Strict
// ping-pong: one exchange.
import { createServer, request } from "node:http";
import { createServer as createNetServer, connect } from "node:net";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Socket } from "node:net";

let sinkBytes = 0;
let sinkPort = 0;

const sink = createNetServer((socket: Socket) => {
  socket.on("data", (data: Buffer) => {
    sinkBytes += data.length;
  });
});

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const destination = connect({ port: sinkPort, host: "127.0.0.1" });
  req.pipe(destination);
  let earlyBytes = 0;
  const earlyListener = (data: Buffer): void => {
    earlyBytes += data.length;
  };
  req.on("data", earlyListener);
  // A 'data' listener does not keep the message flowing past the last
  // destination: Node pauses here.
  req.unpipe(destination);
  setTimeout(() => {
    req.removeListener("data", earlyListener);
    console.log(`early bytes: ${earlyBytes}`);
    let body = "";
    req.on("data", (data: Buffer) => {
      body += data.toString("utf8");
    });
    req.on("end", () => {
      console.log(`late read: "${body}" sink bytes: ${sinkBytes}`);
      destination.end();
      res.end("done");
    });
    req.resume();
  }, 100);
});

sink.listen(0, () => {
  const sinkAddress = sink.address() as { port: number };
  sinkPort = sinkAddress.port;
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
          server.close(() => sink.close(() => console.log("closed")));
        });
      }
    );
    client.flushHeaders();
    // The body arrives only after the handler unpiped.
    setTimeout(() => client.end("payload"), 30);
  });
});
