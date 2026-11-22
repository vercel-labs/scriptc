// agent.scheduling is read when a free socket is taken: assigning 'fifo'
// switches the pick from the newest free socket to the oldest.
import * as http from "node:http";

const ids = new Map<string, number>();
let next = 0;
const server = http.createServer((req, res) => {
  const key = String(req.socket.remotePort ?? 0);
  let id = ids.get(key);
  if (id === undefined) {
    id = ++next;
    ids.set(key, id);
  }
  console.log(req.url, "conn", id);
  res.end("ok");
});
server.listen(0, "127.0.0.1", () => {
  const port = (server.address() as { port: number }).port;
  const agent = new http.Agent({ keepAlive: true, maxSockets: 2, maxFreeSockets: 2 });
  const get = (path: string, done: () => void): void => {
    http
      .get({ host: "127.0.0.1", port, path, agent }, (res) => {
        res.resume();
        res.on("end", done);
      })
      .on("error", (e) => {
        console.log("error", path, (e as NodeJS.ErrnoException).code);
        done();
      });
  };
  let pooled = 0;
  const afterPair = (): void => {
    if (++pooled < 2) return;
    // both sockets are free now: lifo takes the newest
    setImmediate(() => {
      get("/c", () => {
        setImmediate(() => {
          agent.scheduling = "fifo";
          get("/d", () => {
            server.close();
            agent.destroy();
          });
        });
      });
    });
  };
  get("/a", afterPair);
  get("/b", afterPair);
});
