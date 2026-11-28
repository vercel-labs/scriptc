// destroy(error) on the http message types: IncomingMessage.destroy(err)
// returns first, then the message's own 'error' listeners see that error and
// 'close' follows; a message with no 'error' listener reports nothing (the
// request below has one; the response case proves the other shape).
// ServerResponse.destroy(err) closes the response and never fires its
// 'error' listeners, as Node does. Strict ping-pong: one phase at a time.
import { createServer, request } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";

let serverPort = 0;

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  if (req.url === "/req") {
    req.on("data", () => {});
    req.on("error", (err: Error) => console.log(`req error: ${err.message}`));
    req.on("close", () => console.log("req close"));
    console.log("req destroy before");
    req.destroy(new Error("reqboom"));
    console.log("req destroy after");
    return;
  }
  if (req.url === "/res") {
    res.on("close", () => console.log("res close"));
    res.writeHead(200);
    res.write("partial");
    console.log("res destroy before");
    res.destroy(new Error("resboom"));
    console.log("res destroy after");
    return;
  }
  res.writeHead(200).end("ok");
});

const startPhase = (path: string, method: string, done: () => void): void => {
  const req = request({ port: serverPort, path, method }, (res: IncomingMessage) => {
    res.resume();
  });
  req.on("error", () => {});
  req.on("close", () => setTimeout(done, 50));
  req.end("payload");
};

server.listen(0, () => {
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  serverPort = address.port;
  startPhase("/req", "POST", () => {
    startPhase("/res", "GET", () => {
      server.close(() => console.log("closed"));
    });
  });
});
