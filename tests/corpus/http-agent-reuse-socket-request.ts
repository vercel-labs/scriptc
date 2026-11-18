// agent.reuseSocket(socket, req): the request learns its socket was reused,
// and its own timeout stays in force — the agent's timeout does not replace it.
import * as http from "node:http";
import type { Socket } from "node:net";

const agent = new http.Agent({ keepAlive: true, timeout: 5000 });
const server = http.createServer(() => {
  // never answers: only the request's own timeout can fire
});
server.listen(0, "127.0.0.1", () => {
  const port = (server.address() as { port: number }).port;
  const req = http.request({ host: "127.0.0.1", port, path: "/", agent, timeout: 50 }, () => {
    // no response
  });
  req.on("error", () => {});
  req.on("timeout", () => console.log("timeout fired"));
  req.on("socket", (socket: Socket) => {
    console.log("reused before", req.reusedSocket);
    agent.reuseSocket(socket, req);
    console.log("reused after", req.reusedSocket);
  });
  req.end();
  setTimeout(() => {
    req.destroy();
    server.close();
  }, 250);
});
