// A keep-alive agent whose free list holds one destroyed socket and one live
// one, with requests queued behind the origin's socket limit: the settle's
// queue pass prunes the dead entry and hands over the live socket, and a wake
// raised inside that pass must not dequeue a waiter twice — the requests
// behind it have to run.
import * as http from "node:http";
import type { Socket } from "node:net";

const agent = new http.Agent({ keepAlive: true, maxSockets: 2, maxFreeSockets: 2 });
const server = http.createServer((req, res) => {
  res.end("ok");
});
server.listen(0, "127.0.0.1", () => {
  const port = (server.address() as { port: number }).port;
  let pooledSocket: Socket | null = null;
  let endHook: (() => void) | null = null;
  const get = (path: string, done: () => void, capture = false, hook: (() => void) | null = null): void => {
    const req = http.get({ host: "127.0.0.1", port, path, agent }, (res) => {
      res.resume();
      res.on("end", () => {
        if (hook !== null) hook();
        done();
      });
    });
    if (capture) req.on("socket", (socket) => (pooledSocket = socket));
    req.on("error", (e) => {
      console.log("error", (e as NodeJS.ErrnoException).code);
      done();
    });
  };
  // two sockets for the origin, both pooled
  let pooled = 0;
  const afterPool = (): void => {
    if (++pooled < 2) return;
    agent.maxSockets = 1;
    let done = 0;
    const finish = (): void => {
      done++;
      if (done === 3) {
        console.log("done", done);
        server.close();
        agent.destroy();
      }
    };
    // R1 takes the live pooled socket; at its response end the other pooled
    // socket is destroyed, so the pass that runs right after the pooling finds
    // a dead entry and a live one together
    endHook = () => pooledSocket?.destroy();
    get("/r1", finish, false, endHook);
    get("/r2", finish);
    get("/r3", finish);
  };
  get("/a", afterPool, true);
  get("/b", afterPool);
});
