// Assigning agent.scheduling changes which pooled socket the next request
// reuses: Node reads `this.scheduling === 'fifo'` when it takes one, so
// 'lifo' (the default) reuses the most recently freed socket and 'fifo' the
// oldest. The ports in the bodies identify the connections.
import * as http from "node:http";

let connections = 0;
const server = http.createServer((req, res) => {
  res.end(String(req.socket.remotePort));
});
server.on("connection", () => { connections += 1; });

server.listen(0, "127.0.0.1", () => {
  const port = (server.address() as { port: number }).port;
  const agent = new http.Agent({ keepAlive: true, maxSockets: 2 });
  const get = (path: string, done: (body: string) => void): void => {
    http.get({ host: "127.0.0.1", port, path, agent }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => { body += chunk; });
      res.on("end", () => done(body));
    }).on("error", (e) => { console.log("error", e.message); done("err"); });
  };
  let pending = 2;
  let ports: string[] = [];
  const both = (body: string): void => {
    ports.push(body);
    pending -= 1;
    if (pending > 0) return;
    let free = 0;
    for (const list of Object.values(agent.freeSockets)) free += list.length;
    console.log("connections", connections, "free", free);
    const newest = ports[1];
    const oldest = ports[0];
    agent.scheduling = "lifo";
    get("/lifo", (reused) => {
      console.log("lifo took newest", reused === newest);
      agent.scheduling = "fifo";
      get("/fifo", (again) => {
        console.log("fifo took oldest", again === oldest);
        server.close();
      });
    });
  };
  get("/a", both);
  get("/b", both);
});
