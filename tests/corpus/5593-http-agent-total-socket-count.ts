// agent.totalSocketCount counts the sockets an agent created that have not
// closed: the sockets serving requests and, for a keepAlive agent, the idle
// ones in agent.freeSockets. A request that reuses a free socket keeps the
// count, a request that dials a new one raises it, and agent.destroy()
// lowers it as each socket closes. Without keepAlive, a socket counts until
// it closes after its response.
import * as http from "node:http";

const server = http.createServer((req, res) => res.end("ok"));

function freeCount(agent: http.Agent): number {
  let n = 0;
  for (const list of Object.values(agent.freeSockets)) n += list ? list.length : 0;
  return n;
}

// Logs the count when the request is created, at its response, at the
// response's end and once the socket is idle, unless `quiet` is set.
function get(agent: http.Agent, port: number, tag: string, quiet: boolean): Promise<void> {
  return new Promise<void>((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, agent }, (res) => {
      if (!quiet) console.log(tag, "response", agent.totalSocketCount);
      res.resume();
      res.on("end", () => {
        if (!quiet) console.log(tag, "end", agent.totalSocketCount);
        setImmediate(() => {
          if (!quiet) console.log(tag, "idle", agent.totalSocketCount, freeCount(agent));
          resolve();
        });
      });
    });
    console.log(tag, "created", agent.totalSocketCount, req.reusedSocket);
  });
}

server.listen(0, "127.0.0.1", async () => {
  const port = (server.address() as { port: number }).port;
  const keepAlive = new http.Agent({ keepAlive: true });
  await get(keepAlive, port, "first", false);
  await get(keepAlive, port, "reuse", false);
  // Two requests at once: one reuses the free socket, one dials a second.
  await Promise.all([get(keepAlive, port, "pair a", true), get(keepAlive, port, "pair b", true)]);
  console.log("pair idle", keepAlive.totalSocketCount, freeCount(keepAlive));
  keepAlive.destroy();
  setTimeout(() => {
    console.log("after destroy", keepAlive.totalSocketCount, freeCount(keepAlive));
    // Without keepAlive the socket closes after the response, and leaves
    // the count before the request's 'close'.
    const plain = new http.Agent();
    const req = http.get({ host: "127.0.0.1", port, agent: plain }, (res) => {
      res.resume();
      res.on("end", () => console.log("plain end", plain.totalSocketCount));
    });
    console.log("plain created", plain.totalSocketCount);
    req.on("close", () => {
      console.log("plain request close", plain.totalSocketCount);
      setTimeout(() => {
        console.log("plain closed", plain.totalSocketCount);
        server.close();
      }, 50);
    });
  }, 50);
});
