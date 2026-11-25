// http.Server's meta listener APIs over HTTP event names: 'newListener'
// fires with the event name BEFORE a listener joins its list (so a handler
// that removes itself or another listener during the notification sees the
// lists it expects), off removes the matching HTTP listener, and listeners
// answers those functions by identity — the synchronous handoff T3's
// response guard uses.
import * as http from "node:http";

const server = http.createServer();
const rejectRequest = (_req: http.IncomingMessage, res: http.ServerResponse) => {
  res.writeHead(503).end();
};
server.on("request", rejectRequest);
server.on("newListener", function onNewListener(event: string) {
  console.log("newListener", String(event), "request listeners", server.listeners("request").length);
  if (event === "request") server.off("request", rejectRequest);
  if (!server.listeners("request").includes(rejectRequest)) {
    server.listeners("newListener");
    server.off("newListener", onNewListener);
  }
});
const serving = (_req: http.IncomingMessage, res: http.ServerResponse) => {
  res.end("second");
};
server.on("request", serving);
console.log("after add", server.listeners("request").length, server.listeners("request")[0] === serving);
// removing a listener that already left changes nothing
server.off("request", rejectRequest);
console.log("off twice", server.listeners("request").length);
server.listen(0, "127.0.0.1", () => {
  console.log("bound");
  const port = (server.address() as { port: number }).port;
  http.get({ host: "127.0.0.1", port, path: "/" }, (res) => {
    let body = "";
    res.setEncoding("utf8");
    res.on("data", (chunk) => {
      body += chunk;
    });
    res.on("end", () => {
      console.log("reply", res.statusCode, body);
      server.close();
    });
  });
});
