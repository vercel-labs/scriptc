// Pruning a destroyed pooled socket frees its slot in the agent's totals: a
// request right after agent.destroy() dials fresh, the total-socket count
// does not keep counting the dead socket, and a request queued behind the
// total cap starts once that capacity is released.
import * as http from "node:http";

const server = http.createServer((req, res) => res.end("ok"));
server.listen(0, "127.0.0.1", () => {
  const port = (server.address() as { port: number }).port;
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1, maxTotalSockets: 1 });
  const get = (path: string, done: () => void): void => {
    http.get({ host: "127.0.0.1", port, path, agent }, (res) => {
      res.resume();
      res.on("end", done);
    }).on("error", (e) => {
      console.log("error", e.message);
      done();
    });
  };
  get("/first", () => {
    console.log("total after first", agent.totalSocketCount);
    agent.destroy();
    console.log("total after destroy", agent.totalSocketCount);
    get("/second", () => {
      console.log("total after second", agent.totalSocketCount);
      server.close();
    });
  });
});
