// A request made right after agent.destroy() must open a fresh connection:
// the destroyed pooled socket leaves the free list before the pick, as Node
// drops it (`while (freeSockets[0].destroyed) freeSockets.shift()`).
import * as http from "node:http";

let connections = 0;
const server = http.createServer((req, res) => res.end("ok"));
server.on("connection", () => { connections += 1; });

server.listen(0, "127.0.0.1", () => {
  const port = (server.address() as { port: number }).port;
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  const get = (label: string, done: () => void): void => {
    http.get({ host: "127.0.0.1", port, path: "/", agent }, (res) => {
      res.resume();
      res.on("end", () => {
        console.log(label, res.statusCode);
        done();
      });
    }).on("error", (e) => { console.log(label, "error", e.message); done(); });
  };
  get("first", () => {
    agent.destroy();
    console.log("free after destroy", Object.keys(agent.freeSockets).length);
    get("second", () => {
      console.log("connections", connections);
      server.close();
    });
  });
});
