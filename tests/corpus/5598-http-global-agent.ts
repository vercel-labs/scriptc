// Requests without an agent option go through http.globalAgent, which in
// Node 24 has keepAlive: true, so sequential requests share one
// connection, and the process still exits with the idle socket open.
import * as http from "node:http";
import * as https from "node:https";

let connections = 0;
const server = http.createServer((req, res) => res.end(`ok ${req.url}`));
server.on("connection", () => connections++);

function get(port: number, path: string): Promise<string> {
  return new Promise<string>((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path }, (res) => {
      let body = "";
      res.on("data", (c: Buffer) => (body += c.toString()));
      res.on("end", () => resolve(`${body} reused=${req.reusedSocket}`));
    });
  });
}

console.log("global", http.globalAgent.keepAlive, http.globalAgent.maxSockets, https.globalAgent.keepAlive);
server.listen(0, "127.0.0.1", async () => {
  const port = (server.address() as { port: number }).port;
  console.log(await get(port, "/1"));
  console.log(await get(port, "/2"));
  console.log(await get(port, "/3"));
  console.log("connections", connections, "free", Object.keys(http.globalAgent.freeSockets).length);
  server.close(() => console.log("server closed"));
});
process.on("exit", () => console.log("exit"));
