// A client TLS socket's handshake events: 'secure' and 'secureConnect'
// (the callback), with their order, plus the module's version constants
// and the bundled CA array's identity with getCACertificates("bundled").
// The 'session' event's timing and count diverge (the tls-sessions page).
import * as tls from "node:tls";
import { readFileSync } from "node:fs";

const cert = readFileSync("tests/fixtures/server/certs/localhost.pem");
const key = readFileSync("tests/fixtures/server/certs/localhost-key.pem");
const ca = readFileSync("tests/fixtures/server/certs/ca.pem");

const order: string[] = [];
const server = tls.createServer({ key, cert }, (socket) => {
  socket.on("data", () => {});
  socket.on("error", () => {});
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as { port: number }).port;

await new Promise<void>((resolve) => {
  const client = tls.connect({ port, host: "127.0.0.1", servername: "localhost", ca }, () => {
    order.push("secureConnect");
  });
  client.on("secure", () => order.push("secure"));
  client.on("data", () => {});
  client.on("close", () => resolve());
  setTimeout(() => client.end(), 20);
});

await new Promise<void>((resolve) => setTimeout(resolve, 20));
console.log("order", order.join(","));

console.log("versions", tls.DEFAULT_MIN_VERSION, tls.DEFAULT_MAX_VERSION);
console.log("roots", tls.rootCertificates.length > 0, typeof tls.rootCertificates[0]);
console.log("bundled", tls.getCACertificates("bundled") === tls.rootCertificates);

server.close();
