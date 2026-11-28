// IncomingMessage.unpipe(dest): the destination leaves the body forward and
// receives nothing more, while the message itself keeps reading its body.
// Unpiping a destination that is not piped changes nothing, and the same
// destination unpiped twice changes nothing the second time. The proxy
// shape portless uses: pipe the body to a destination, unpipe it in the same
// tick, then resume() and read the body here. Strict ping-pong.
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
  let body = "";
  req.on("data", (chunk: Buffer) => {
    body += chunk.toString("utf8");
  });
  req.on("end", () => {
    console.log(`server read: "${body}" sink bytes: ${sinkBytes}`);
    socket.end();
    res.end("done");
  });
  req.pipe(socket);
  req.unpipe(socket);
  req.unpipe(socket);
  req.unpipe(res);
  // Node leaves a stream paused after its last pipe leaves; resume() reads
  // the body here.
  req.resume();
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
