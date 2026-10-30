// A peer certificate whose extension carries another certificate's PEM as
// text: getPeerX509Certificate() and getX509Certificate() give the
// certificate the handshake delivered, and its fields, not the embedded
// one. new X509Certificate() of the same DER reads the PEM inside it first,
// as Node's PEM-before-DER parse does.
import { X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import * as tls from "node:tls";

const D = "tests/fixtures/server/certs";
const cert = readFileSync(`${D}/embedded.pem`), key = readFileSync(`${D}/embedded-key.pem`);
const pem = new X509Certificate(cert);

function describe(label: string, x: X509Certificate | undefined): void {
  if (!x) return console.log(label, "undefined");
  console.log(label, x.subject, x.serialNumber, x.fingerprint256 === pem.fingerprint256, x.fingerprint === pem.fingerprint, x.validTo, x.raw.length);
}

// raw is the certificate SEQUENCE, without bytes after it, and PEM armor
// counts only at the start of a line
const trailing = new X509Certificate(Buffer.concat([pem.raw, Buffer.from([1, 2, 3])]));
console.log("trailing bytes", trailing.raw.length === pem.raw.length, trailing.fingerprint256 === pem.fingerprint256, trailing.fingerprint === pem.fingerprint, trailing.validFrom === pem.validFrom);
for (const [label, input] of [["after a line", Buffer.concat([Buffer.from("text\n"), cert])], ["inside a line", Buffer.concat([Buffer.from("text"), cert])]] as const) {
  try {
    console.log(label, new X509Certificate(input).subject);
  } catch (e) {
    console.log(label, (e as NodeJS.ErrnoException).code);
  }
}

const server = tls.createServer({ cert, key }, (s) => {
  describe("server own", s.getX509Certificate());
  s.end();
});
server.listen(0, "127.0.0.1", () => {
  const c = tls.connect({ port: (server.address() as AddressInfo).port, host: "127.0.0.1", rejectUnauthorized: false }, () => {
    const peer = c.getPeerX509Certificate();
    describe("client peer", peer);
    const legacy = c.getPeerCertificate();
    console.log("legacy", legacy.subject.CN, legacy.fingerprint256 === pem.fingerprint256);
    if (peer) describe("rebuilt from raw", new X509Certificate(peer.raw));
  });
  c.resume();
  c.on("close", () => server.close());
});
