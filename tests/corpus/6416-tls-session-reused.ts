// TLSSocket.isSessionReused() on both ends of a fresh TLS connection,
// before and after the handshake: a first handshake never resumes a
// session, so every answer is false.
import * as tls from "node:tls";
import { readFileSync } from "node:fs";

const cert = readFileSync("tests/fixtures/server/certs/localhost.pem");
const key = readFileSync("tests/fixtures/server/certs/localhost-key.pem");
const ca = readFileSync("tests/fixtures/server/certs/ca.pem");

let serverLine: string | null = null;
let clientLine: string | null = null;
function both(): void {
  if (serverLine === null || clientLine === null) return;
  console.log(serverLine);
  console.log(clientLine);
}

const server = tls.createServer({ key, cert }, (socket) => {
  serverLine = `server reused ${socket.isSessionReused()}`;
  both();
  socket.end("hi");
});
server.listen(0, "127.0.0.1", () => {
  const port = (server.address() as { port: number }).port;
  const client = tls.connect({ port, host: "127.0.0.1", servername: "localhost", ca }, () => {
    clientLine = `client reused ${client.isSessionReused()}`;
    both();
  });
  console.log("before handshake", client.isSessionReused());
  client.on("data", (d: Buffer) => console.log("data", d.toString()));
  client.on("close", () => server.close());
});
