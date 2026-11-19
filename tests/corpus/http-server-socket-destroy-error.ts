// A server request's socket destroyed with an Error: the server's
// 'clientError' listeners receive that Error, the request tears down with
// "aborted", and the client sees the reset — no uncaught 'error'.
import * as http from "node:http";

const events: string[] = [];

const server = http.createServer((req, res) => {
  req.on("error", (err: Error) => events.push(`req ${err.message}`));
  events.push("destroying");
  req.socket.destroy(new Error("boom"));
});
server.on("clientError", (err: Error, socket) => {
  events.push(`clientError ${err.message}`);
  socket.destroy();
});

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as { port: number }).port;

let clientCode = "none";
await new Promise<void>((resolve) => {
  const req = http.request({ host: "127.0.0.1", port }, (res) => {
    res.resume();
    res.on("end", () => resolve());
  });
  req.on("error", (err: Error) => {
    clientCode = (err as NodeJS.ErrnoException).code ?? err.message;
    resolve();
  });
  req.end();
});

await new Promise<void>((resolve) => setImmediate(resolve));
console.log("client", clientCode);
console.log("events", events.join(","));
server.close();
