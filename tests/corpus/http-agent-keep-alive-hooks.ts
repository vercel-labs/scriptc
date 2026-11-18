// agent.keepSocketAlive / agent.reuseSocket: the pool's keep-alive hooks keep
// Node's answers, and reading them as values still reaches the agent.
import * as http from "node:http";
import type { Socket } from "node:net";

const agent = new http.Agent({ keepAlive: true, timeout: 5000 });
const server = http.createServer((req, res) => res.end("ok"));
server.listen(0, "127.0.0.1", () => {
  const port = (server.address() as { port: number }).port;
  const req = http.request({ host: "127.0.0.1", port, path: "/", agent }, (res) => {
    res.resume();
    res.on("end", () => {
      console.log("body done");
      server.close();
      agent.destroy();
    });
  });
  req.on("socket", (socket: Socket) => {
    // a read answers a function (Node's unbound method)
    console.log("hooks", typeof agent.keepSocketAlive, typeof agent.reuseSocket);
    console.log("keep", agent.keepSocketAlive(socket));
    agent.reuseSocket(socket, req);
  });
  req.end();
});
