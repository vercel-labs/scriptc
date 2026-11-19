// destroy(error) on a server socket with its own 'error' listener: the
// program's listener and the server's 'clientError' both see the Error.
import * as http from "node:http";

const events: string[] = [];
const server = http.createServer((req) => {
  req.socket.on("error", (err: Error) => events.push(`socket ${err.message}`));
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
  const req = http.request({ host: "127.0.0.1", port });
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
