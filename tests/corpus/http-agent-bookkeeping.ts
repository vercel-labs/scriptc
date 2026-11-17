// http.Agent bookkeeping: a maxSockets of one queues the second request,
// the sockets/requests/freeSockets maps count the connection in each phase,
// the free socket the keep-alive exchange leaves behind is destroyed with
// the agent, and globalAgent reports the process-wide defaults.
import * as http from "node:http";

const keys = (map: { [key: string]: unknown }): number => Object.keys(map).length;

const server = http.createServer((_req, res) => {
  setTimeout(() => res.end("ok"), 20);
});

server.listen(0, "127.0.0.1", () => {
  const port = (server.address() as { port: number }).port;
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1, maxFreeSockets: 1 });
  const state = (label: string): void => {
    console.log(
      label,
      "sockets",
      keys(agent.sockets),
      "requests",
      keys(agent.requests),
      "free",
      keys(agent.freeSockets),
      "total",
      agent.totalSocketCount,
    );
  };

  const run = (path: string): Promise<void> =>
    new Promise((resolve, reject) => {
      const req = http.get({ host: "127.0.0.1", port, path, agent }, (res) => {
        res.resume();
        res.on("end", () => resolve());
      });
      req.on("error", reject);
    });

  const first = run("/one");
  state("after first start");
  const second = run("/two");
  state("after second start");
  setTimeout(() => state("while first in flight"), 5);

  void Promise.all([first, second]).then(() => {
    state("both done");
    console.log(
      "globalAgent",
      http.globalAgent.keepAlive,
      http.globalAgent.maxSockets !== undefined,
      http.globalAgent.protocol,
      http.globalAgent === http.globalAgent,
    );
    agent.destroy();
    state("after destroy");
    server.close(() => {
      console.log("closed");
      setTimeout(() => {
        state("free sockets reaped");
      }, 50);
    });
  });
});
