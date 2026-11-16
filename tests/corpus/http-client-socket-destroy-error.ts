// A client request's socket destroyed with an Error: the request emits that
// Error (no uncaught 'error'), and the connection closes.
import * as http from "node:http";

const events: string[] = [];
const server = http.createServer((req, res) => res.end("ok"));
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as { port: number }).port;

await new Promise<void>((resolve) => {
  const req = http.get({ host: "127.0.0.1", port });
  req.on("error", (err: Error) => {
    events.push(`req ${err.message}`);
    resolve();
  });
  req.on("socket", (socket) => {
    events.push("socket");
    socket.destroy(new Error("boom"));
  });
});

await new Promise<void>((resolve) => setImmediate(resolve));
console.log("events", events.join(","));
server.close();
