// Rotating a server's session-ticket keys: a client that captured a session
// before setTicketKeys() gets a full handshake when it offers that session,
// and the ticket issued by that handshake resumes as usual. The server
// rotates once, right after its first connection closes, and reports the
// changed material.
import * as tls from "node:tls";
import { readFileSync } from "node:fs";

const dir = "tests/fixtures/server/certs/";
const cert = readFileSync(dir + "localhost.pem");
const key = readFileSync(dir + "localhost-key.pem");

let secure = 0;
let rotated = false;
const server = tls.createServer({ cert, key, maxVersion: "TLSv1.2" }, (sock: tls.TLSSocket) => {
  secure += 1;
  console.log("secure", secure);
  sock.on("data", () => {});
  sock.on("error", () => {});
  sock.on("close", () => {
    if (rotated) return;
    rotated = true;
    const before = server.getTicketKeys();
    const next = Buffer.alloc(48, 0x5a);
    server.setTicketKeys(next);
    console.log("rotated", !before.equals(next), "installed", server.getTicketKeys().equals(next));
  });
  sock.end("ok");
});
server.listen(0, "127.0.0.1", () => {
  process.stderr.write(`PORT ${(server.address() as { port: number }).port}\n`);
  setTimeout(() => server.close(() => console.log("closed")), 6000);
});
