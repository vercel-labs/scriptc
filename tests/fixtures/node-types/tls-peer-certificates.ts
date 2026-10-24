// Under @types/node: a TLS client reads the server's certificate as the
// legacy object, its detailed issuer chain and an X509Certificate, and the
// server reads the certificate it serves.
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import * as tls from "node:tls";

const certs = "tests/fixtures/server/certs";
const ca = readFileSync(`${certs}/ca.pem`);
const cert = readFileSync(`${certs}/localhost.pem`);
const key = readFileSync(`${certs}/localhost-key.pem`);

// The server's line prints once the client has its reply, so the output
// order does not depend on which side's callback runs first.
let serverLine = "";
const server = tls.createServer({ cert, key }, (socket: tls.TLSSocket) => {
  const own = socket.getCertificate() as tls.PeerCertificate;
  serverLine = `server ${own.subject.CN} ${socket.getX509Certificate()?.subject} ${Object.keys(socket.getPeerCertificate()).length}`;
  socket.end("done");
});
server.listen(0, "127.0.0.1", () => {
  const port = (server.address() as AddressInfo).port;
  const client = tls.connect({ port, host: "127.0.0.1", ca, servername: "localhost" }, () => {
    const peer: tls.PeerCertificate = client.getPeerCertificate();
    const detailed: tls.DetailedPeerCertificate = client.getPeerCertificate(true);
    console.log("client", peer.subject.CN, peer.subjectaltname, peer.bits, detailed.issuerCertificate.subject.CN);
    console.log("root", detailed.issuerCertificate.issuerCertificate === detailed.issuerCertificate);
    const x509 = client.getPeerX509Certificate();
    if (x509 !== undefined) console.log("x509", x509.subject, x509.checkIP("127.0.0.1"), x509.fingerprint256 === peer.fingerprint256);
  });
  client.resume();
  client.on("end", () => {
    console.log(serverLine);
    client.destroy();
    server.close();
  });
});
