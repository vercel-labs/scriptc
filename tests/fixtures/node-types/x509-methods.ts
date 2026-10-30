// Under @types/node: X509Certificate's methods over the test certificates:
// the issuer, the signature, the host and IP names, the private key, the
// legacy object and the PEM text.
import { X509Certificate, createPrivateKey } from "node:crypto";
import { readFileSync } from "node:fs";
import type { PeerCertificate } from "node:tls";

const certs = "tests/fixtures/server/certs";
const ca = new X509Certificate(readFileSync(`${certs}/ca.pem`));
const leaf = new X509Certificate(readFileSync(`${certs}/localhost.pem`));
const key = createPrivateKey(readFileSync(`${certs}/localhost-key.pem`));

console.log(leaf.checkIssued(ca), leaf.verify(ca.publicKey), ca.verify(leaf.publicKey));
const host: string | undefined = leaf.checkHost("localhost");
console.log(host, leaf.checkHost("example.com"), leaf.checkIP("127.0.0.1"), leaf.checkIP("::1"));
console.log(leaf.checkEmail("root@localhost", { subject: "always" }), leaf.checkPrivateKey(key));
const legacy: PeerCertificate = leaf.toLegacyObject();
console.log(legacy.subject.CN, legacy.subjectaltname, legacy.bits, legacy.exponent, legacy.raw.equals(leaf.raw));
console.log(leaf.publicKey.asymmetricKeyType, leaf.publicKey === leaf.publicKey);
console.log(leaf.toString() === readFileSync(`${certs}/localhost.pem`, "latin1"), String(ca).split("\n")[0]);
