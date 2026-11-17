// The secureConnection registry: off()/listeners() address the handshake's
// own list, and a socket forwarded with server.emit('connection', socket)
// runs the server's handler and secureConnection listeners once the
// forwarded handshake completes.
import * as tls from "node:tls";
import * as net from "node:net";
import { readFileSync } from "node:fs";

const cert = readFileSync("tests/fixtures/server/certs/localhost.pem");
const key = readFileSync("tests/fixtures/server/certs/localhost-key.pem");
const ca = readFileSync("tests/fixtures/server/certs/ca.pem");

const events: string[] = [];
const server = tls.createServer({ key, cert }, (socket) => {
  events.push(`handler:${socket.encrypted}`);
  socket.on("data", () => {});
  socket.end("handled");
});
const secure = () => events.push("secure");
server.on("secureConnection", secure);
server.on("connection", () => events.push("connection"));

console.log("listeners", server.listeners("secureConnection").length);
server.off("secureConnection", secure);
console.log("after off", server.listeners("secureConnection").length);
server.on("secureConnection", secure);

const raw = net.createServer((socket) => {
  events.push("raw accept");
  server.emit("connection", socket);
});

await new Promise<void>((resolve) => raw.listen(0, "127.0.0.1", resolve));
const port = (raw.address() as net.AddressInfo).port;

await new Promise<void>((resolve) => {
  const client = tls.connect({ port, host: "127.0.0.1", ca, servername: "localhost" }, () => {
    console.log("client secure", client.authorized);
  });
  client.on("data", (chunk: Buffer) => console.log("client data", chunk.toString()));
  client.on("close", () => resolve());
  client.on("error", (err: Error) => {
    console.log("client error", (err as NodeJS.ErrnoException).code);
    resolve();
  });
});

console.log("events", events.join(","));
raw.close();
server.close();
