// tls.connect's port forms — connect(port, host, options, listener),
// connect(port, options, listener) and connect(port, host, listener) — and
// createSecureContext with no options.
import * as tls from "node:tls";
import { readFileSync } from "node:fs";

const cert = readFileSync("tests/fixtures/server/certs/localhost.pem");
const key = readFileSync("tests/fixtures/server/certs/localhost-key.pem");
const ca = readFileSync("tests/fixtures/server/certs/ca.pem");

console.log("context", tls.createSecureContext() !== undefined);

const server = tls.createServer({ key, cert }, (socket) => {
  socket.on("data", () => {});
  socket.on("error", () => {});
  socket.end();
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as { port: number }).port;

await new Promise<void>((resolve) => {
  const client = tls.connect(port, "127.0.0.1", { servername: "localhost", ca }, () => {
    console.log("port host options listener", client.authorized);
  });
  client.on("data", () => {});
  client.on("close", () => resolve());
});

await new Promise<void>((resolve) => {
  const client = tls.connect(port, { servername: "localhost", ca }, () => {
    console.log("port options listener", client.authorized);
  });
  client.on("data", () => {});
  client.on("close", () => resolve());
});

// No options: the default trust store rejects the local CA, so the
// handshake fails and the listener never fires (Node's answer too).
await new Promise<void>((resolve) => {
  const client = tls.connect(port, "127.0.0.1", () => {
    console.log("host only listener");
  });
  client.on("error", (e) => console.log("host only error", typeof (e as NodeJS.ErrnoException).code));
  client.on("close", () => resolve());
  client.on("data", () => {});
});

server.close();
