// The TLSSocket member audit: the address fields, encrypted, the verify
// split (authorized / authorizationError), the certificate reads, the
// negotiation reads, and the X509Certificate pair.
import * as tls from "node:tls";
import { readFileSync } from "node:fs";

const cert = readFileSync("tests/fixtures/server/certs/localhost.pem");
const key = readFileSync("tests/fixtures/server/certs/localhost-key.pem");
const ca = readFileSync("tests/fixtures/server/certs/ca.pem");

const server = tls.createServer({ key, cert }, (socket) => {
  socket.on("data", () => {});
  socket.on("error", () => {});
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as { port: number }).port;

await new Promise<void>((resolve) => {
  const client = tls.connect(
    { port, host: "127.0.0.1", servername: "localhost", ca },
    () => {
      const local = client.address() as { address: string; family: string; port: number };
      console.log("address", local.address, local.family, typeof local.port);
      console.log(
        "flow",
        client.encrypted,
        client.localAddress === "127.0.0.1",
        typeof client.localPort,
        client.remoteAddress,
        client.remoteFamily,
        client.remotePort === port,
      );
      console.log("verify", client.authorized, client.authorizationError);
      console.log("protocol", client.getProtocol(), client.alpnProtocol);
      const cipher = client.getCipher();
      console.log("cipher", typeof cipher.name, cipher.standardName.startsWith("TLS_"), cipher.version);
      console.log("reused", client.isSessionReused());
      const peer = client.getPeerCertificate();
      console.log("peer", peer.subject["CN"], peer.issuer["CN"] === peer.subject["CN"], peer.ca);
      const detailed = client.getPeerCertificate(true);
      console.log(
        "detailed",
        detailed.issuerCertificate.subject["CN"],
        detailed.issuerCertificate.fingerprint === peer.fingerprint,
      );
      const own = client.getCertificate();
      console.log("own", own === null ? "null" : Object.keys(own as object).length);
      const peerX509 = client.getPeerX509Certificate();
      const ownX509 = client.getX509Certificate();
      console.log(
        "x509",
        peerX509 !== undefined && peerX509.subject === `CN=${String(peer.subject["CN"])}`,
        ownX509 === undefined,
      );
      client.on("close", () => resolve());
      client.end();
    },
  );
});

// rejectUnauthorized: false keeps the handshake and reports the verify
// failure in the authorization fields.
await new Promise<void>((resolve) => {
  const untrusted = tls.connect(
    { port, host: "127.0.0.1", servername: "localhost", rejectUnauthorized: false },
    () => {
      console.log(
        "untrusted",
        untrusted.authorized,
        typeof untrusted.authorizationError,
        untrusted.getPeerCertificate().subject["CN"],
      );
      untrusted.on("close", () => resolve());
      untrusted.end();
    },
  );
});

server.close();
