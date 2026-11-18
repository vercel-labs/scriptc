// The tls.Server surface: listen/address/close, setSecureContext, and the
// 'listening', 'connection', 'secureConnection' and 'tlsClientError'
// events.
import * as tls from "node:tls";
import * as net from "node:net";
import { readFileSync } from "node:fs";

const cert = readFileSync("tests/fixtures/server/certs/localhost.pem");
const key = readFileSync("tests/fixtures/server/certs/localhost-key.pem");
const ca = readFileSync("tests/fixtures/server/certs/ca.pem");

const events: string[] = [];
const server = tls.createServer({ key, cert }, (socket) => {
  events.push("secureConnection");
  socket.end("ok");
});
server.on("listening", () => events.push("listening"));
server.on("connection", () => events.push("connection"));
server.on("tlsClientError", () => events.push("tlsClientError"));

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address() as net.AddressInfo;
console.log("listening", server.listening, address.address, address.family, address.port > 0);

// A plain TCP client on the TLS port is a handshake failure.
await new Promise<void>((resolve) => {
  const plain = net.connect(address.port, "127.0.0.1", () => plain.write("GET / HTTP/1.1\r\n\r\n"));
  plain.on("error", () => {});
  plain.on("close", () => resolve());
  setTimeout(() => plain.destroy(), 50);
});

server.setSecureContext({ key, cert });

await new Promise<void>((resolve) => {
  const client = tls.connect(
    { port: address.port, host: "127.0.0.1", servername: "localhost", ca },
    () => {
      client.on("data", () => {});
      client.on("close", () => resolve());
    },
  );
});

setTimeout(() => {
  console.log("events", events.join(","));
  server.close(() => console.log("closed", server.listening));
}, 20);
