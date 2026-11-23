// A request left in flight when the program exits: its socket is still
// counted in the global agent's totals after the exit sweep has dropped the
// agent, so the socket's close still has to return the slot to live state —
// never to a freed agent.
import * as http from "node:http";
import * as net from "node:net";

// The net unit registers its exit sweep first, so http's (registered on the
// first request) runs ahead of it: the agent's cleanup happens while the
// request's socket is still open, and net's sweep closes that socket after.
net.connect({ host: "127.0.0.1", port: 1 }).on("error", () => {});

const server = http.createServer(() => {
  // never answers: the request stays in flight
});
server.listen(0, "127.0.0.1", () => {
  const port = (server.address() as { port: number }).port;
  const req = http.get({ host: "127.0.0.1", port, path: "/" }, () => {});
  req.on("error", () => {});
  console.log("inflight", Object.keys(http.globalAgent.sockets).length);
  console.log("total", http.globalAgent.totalSocketCount);
  process.exit(0);
});
