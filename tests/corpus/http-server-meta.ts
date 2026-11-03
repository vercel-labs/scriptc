// HTTP Server EventEmitter meta: newListener fires BEFORE the add,
// off/removeListener drop the last matching HTTP listener, and
// listeners() answers those functions by identity — the
// httpResponseErrorGuard handoff (minus res.on("error")).
import * as http from "node:http";

const server = http.createServer();
const rejectRequest = (_req: http.IncomingMessage, res: http.ServerResponse) => {
  res.writeHead(503, { connection: "close" }).end("reject");
};
const rejectUpgrade = (_req: http.IncomingMessage, socket: import("net").Socket) => {
  socket.end("upgrade-reject");
};
const serveRequest = (_req: http.IncomingMessage, res: http.ServerResponse) => {
  res.end("ok");
};

server.on("request", rejectRequest);
server.on("upgrade", rejectUpgrade);
console.log(
  "before",
  server.listeners("request").includes(rejectRequest),
  server.listeners("upgrade").includes(rejectUpgrade),
  server.listeners("request").length,
);

server.on("newListener", function onNewListener(event) {
  console.log("new", event, server.listeners("request").includes(rejectRequest));
  if (event === "request") server.off("request", rejectRequest);
  if (event === "upgrade") server.off("upgrade", rejectUpgrade);
  if (
    !server.listeners("request").includes(rejectRequest) &&
    !server.listeners("upgrade").includes(rejectUpgrade)
  ) {
    server.off("newListener", onNewListener);
    console.log("handoff");
  }
});

server.on("request", serveRequest);
console.log(
  "after request",
  server.listeners("request").includes(rejectRequest),
  server.listeners("request").includes(serveRequest),
  server.listeners("upgrade").includes(rejectUpgrade),
);

server.on("upgrade", (_req: http.IncomingMessage, socket: import("net").Socket) => {
  socket.end("upgrade-ok");
});
console.log(
  "after upgrade",
  server.listeners("upgrade").includes(rejectUpgrade),
  server.listeners("newListener").length,
);

server.listen(0, "127.0.0.1", () => {
  const port = server.address().port;
  const req = http.request({ host: "127.0.0.1", port, path: "/" }, (incoming) => {
    console.log("status", incoming.statusCode);
    incoming.on("data", (chunk: Buffer) => console.log("body", chunk.toString()));
    incoming.on("end", () => server.close());
  });
  req.end();
});
