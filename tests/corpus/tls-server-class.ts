// tls.Server is a constructor: new tls.Server(options, handler) builds the
// server createServer does, and instanceof tls.Server answers for a TLS
// server and not for a plain net server.
import * as tls from "node:tls";
import * as net from "node:net";
import { readFileSync } from "node:fs";

const cert = readFileSync("tests/fixtures/server/certs/localhost.pem");
const key = readFileSync("tests/fixtures/server/certs/localhost-key.pem");
const ca = readFileSync("tests/fixtures/server/certs/ca.pem");

const events: string[] = [];
const server = new tls.Server({ key, cert }, (socket) => {
  events.push("secure");
  socket.on("data", () => {});
  socket.end("ok");
});
server.on("listening", () => events.push("listening"));
console.log("instances", server instanceof tls.Server);
const plain = net.createServer();
console.log("plain", plain instanceof tls.Server);
plain.close();

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as { port: number }).port;
await new Promise<void>((resolve) => {
  const client = tls.connect({ port, host: "127.0.0.1", ca, servername: "localhost" }, () => {
    console.log("client", client.authorized);
  });
  client.on("data", () => {});
  client.on("close", () => resolve());
  client.on("error", (err: Error) => {
    console.log("client error", (err as NodeJS.ErrnoException).code);
    resolve();
  });
});
console.log("events", events.join(","));
server.close();
