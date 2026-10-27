// An Agent with keepAlive: true keeps each finished connection in its free
// list and hands it to the next request for the same host and port
// (req.reusedSocket is true), including requests that waited for a
// maxSockets slot. A response with Connection: close is not reused, and
// agent.destroy() closes the idle sockets. scheduling: 'lifo' (the
// default) reuses the most recently freed socket and 'fifo' the oldest;
// any other value throws.
import * as http from "node:http";
import * as net from "node:net";

let connections = 0;
const server = http.createServer((req, res) => {
  if (req.url === "/close") res.setHeader("Connection", "close");
  res.end(`${req.url} ${req.headers.connection}`);
});
server.on("connection", () => connections++);

function get(agent: http.Agent, path: string): Promise<string> {
  return new Promise<string>((resolve) => {
    const port = (server.address() as { port: number }).port;
    const req = http.request(
      { host: "127.0.0.1", port, path, agent: agent },
      (res) => {
        let body = "";
        res.on("data", (c: Buffer) => (body += c.toString()));
        res.on("end", () => resolve(`${body} reused=${req.reusedSocket}`));
      },
    );
    req.end();
  });
}

function tryScheduling(scheduling: any): void {
  try {
    new http.Agent({ scheduling });
    console.log("scheduling", JSON.stringify(scheduling));
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    console.log(e.name, e.code, e.message);
  }
}

function track(
  agent: http.Agent,
  freed: number[],
  id: number,
): Promise<net.Socket> {
  return new Promise<net.Socket>((resolve) => {
    const port = (server.address() as { port: number }).port;
    const req = http.request(
      { host: "127.0.0.1", port, path: "/s", agent: agent },
      (res) => {
        res.resume();
        res.on("end", () => {
          freed.push(id);
          resolve(req.socket);
        });
      },
    );
    req.end();
  });
}

server.listen(0, "127.0.0.1", async () => {
  const keep = new http.Agent({ keepAlive: true });
  console.log(await get(keep, "/a"));
  console.log(await get(keep, "/b"));
  await new Promise<void>((r) => setTimeout(r, 10));
  console.log(
    "free",
    Object.keys(keep.freeSockets).length,
    "connections",
    connections,
  );
  console.log(await get(keep, "/close"));
  await new Promise<void>((r) => setTimeout(r, 10));
  console.log(await get(keep, "/after-close"));
  console.log("connections", connections);
  const one = new http.Agent({ keepAlive: true, maxSockets: 1 });
  const pending: Promise<string>[] = [
    get(one, "/q1"),
    get(one, "/q2"),
    get(one, "/q3"),
  ];
  const results: string[] = await Promise.all(pending);
  console.log(results.join(" | "));
  console.log("connections", connections);
  for (const scheduling of ["lifo", "fifo", undefined] as const) {
    // the requests in the order their sockets were freed, then which of
    // those sockets the next request reuses
    const agent = new http.Agent({ keepAlive: true, scheduling });
    const freed: number[] = [];
    const p0 = track(agent, freed, 0);
    const p1 = track(agent, freed, 1);
    const p2 = track(agent, freed, 2);
    const s0 = await p0;
    const s1 = await p1;
    const s2 = await p2;
    await new Promise<void>((r) => setTimeout(r, 10));
    const next = await track(agent, [], 3);
    const id = next === s0 ? 0 : next === s1 ? 1 : next === s2 ? 2 : -1;
    console.log(scheduling, freed.indexOf(id));
    agent.destroy();
  }
  for (const scheduling of ["LIFO", "", 1]) tryScheduling(scheduling);
  keep.destroy();
  one.destroy();
  server.close(() => console.log("closed"));
});
