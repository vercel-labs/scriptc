// tlsSocket.getPeerCertificate from JavaScript matches Node: only a
// detailed argument that is true itself adds the issuerCertificate chain,
// and the legacy object is a plain object with a Buffer raw and arrays for
// extended key usages.
import * as tls from "node:tls";
import { readFileSync } from "node:fs";

const d = "tests/fixtures/server/certs";
const ca = readFileSync(`${d}/ca.pem`);
const cert = readFileSync(`${d}/localhost.pem`);
const key = readFileSync(`${d}/localhost-key.pem`);

const server = tls.createServer({ cert, key }, (s) => s.end("x"));
server.listen(0, () => {
  const c = tls.connect({ port: server.address().port, ca, servername: "localhost" }, () => {
    for (const arg of [true, false, 1, "yes", null, undefined, {}]) {
      const peer = c.getPeerCertificate(arg);
      console.log(String(arg), "issuerCertificate" in peer, peer.issuer.CN);
    }
    const legacy = c.getPeerCertificate();
    console.log(Object.keys(legacy).length, Buffer.isBuffer(legacy.raw), legacy.ext_key_usage, JSON.stringify(legacy.subject));
    const detailed = c.getPeerCertificate(true);
    const root = detailed.issuerCertificate;
    console.log(root.subject.CN, root.issuerCertificate === root, root.ca, Buffer.isBuffer(root.raw));
    const x509 = c.getPeerX509Certificate();
    if (x509) console.log(x509.subject, x509.checkHost("localhost"), x509.checkIssued(x509), legacy.raw.equals(x509.raw));
    console.log(c.getCertificate(), c.getX509Certificate() === undefined);
  });
  c.resume();
  c.on("end", () => {
    c.destroy();
    console.log(c.getPeerCertificate(), c.getPeerX509Certificate() === undefined, c.getCertificate());
    server.close();
  });
});
