// A server that requires client certificates issues no session tickets: a
// resumed handshake carries no peer certificate, so a ticket would let a
// second connection stand on the first one's authentication. Two named SNI
// contexts verify client certificates against different trust anchors, and
// the server's ticket key is shared by all of them, so a ticket minted for
// one context's verdict must never be accepted by another. The driver makes
// one certificate-verified handshake and then offers its session (a) without
// a certificate and (b) to the context that trusts another ca; both are full
// handshakes that the server rejects.
import * as tls from "node:tls";
import { readFileSync } from "node:fs";

const dir = "tests/fixtures/server/certs/";
const cert = readFileSync(dir + "localhost.pem");
const key = readFileSync(dir + "localhost-key.pem");
const ca = readFileSync(dir + "ca.pem");
const ca2 = readFileSync(dir + "ca2.pem");

let seen = 0;
const server = tls.createServer(
  { cert, key, ca, requestCert: true, rejectUnauthorized: true, maxVersion: "TLSv1.3" },
  (sock: tls.TLSSocket) => {
    seen += 1;
    console.log("secure", seen, sock.servername, sock.authorized, sock.authorizationError);
    sock.on("data", () => {});
    sock.on("error", () => {});
    sock.end("ok");
  },
);
// named contexts whose ca differs: only ca-issued client certificates
// verify against the first, only ca2-issued ones against the second
server.addContext("localhost", tls.createSecureContext({ cert, key, ca }));
server.addContext("other.localhost", tls.createSecureContext({ cert, key, ca: ca2 }));
server.on("tlsClientError", (err: Error & { code?: string }) => {
  console.log("tlsClientError", err.code);
});
server.listen(0, "127.0.0.1", () => {
  process.stderr.write(`PORT ${(server.address() as { port: number }).port}\n`);
  setTimeout(() => server.close(() => console.log("closed")), 4000);
});
