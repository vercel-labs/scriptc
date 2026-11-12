// Under @types/node: X509Certificate's issuerCertificate is declared
// X509Certificate | undefined, and a certificate read from a PEM file has no
// issuer chain, so every read answers undefined — through the property type,
// a held union, a helper, truthiness, equality and `typeof`, while the member
// stays on the prototype for `in` and Object.hasOwn.
import { X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";

const certs = "tests/fixtures/server/certs";
const ca = new X509Certificate(readFileSync(`${certs}/ca.pem`));
const leaf = new X509Certificate(readFileSync(`${certs}/localhost.pem`));

function describe(ic: X509Certificate | undefined): string {
  return ic === undefined ? "no issuer" : `issuer ${ic.subject}`;
}

function probe(label: string, cert: X509Certificate): void {
  console.log(label, "direct", cert.issuerCertificate === undefined, typeof cert.issuerCertificate);
  const held: X509Certificate | undefined = cert.issuerCertificate;
  console.log(label, "held", held === undefined, describe(held), describe(cert.issuerCertificate));
  console.log(label, "same", cert.issuerCertificate === cert.issuerCertificate);
  if (cert.issuerCertificate) console.log(label, "truthy", cert.issuerCertificate.subject);
  else console.log(label, "falsy");
  if (cert.issuerCertificate !== undefined) console.log(label, "narrowed", cert.issuerCertificate.issuer);
  else console.log(label, "narrowed-else", cert.subject.length > 0);
  console.log(
    label,
    "in",
    "issuerCertificate" in cert,
    "checkHost" in cert,
    "nope" in cert,
    Object.hasOwn(cert, "issuerCertificate"),
    Object.hasOwn(cert, "subject"),
    Object.hasOwn(cert, "checkHost"),
  );
}

probe("leaf", leaf);
probe("ca", ca);
probe("der", new X509Certificate(leaf.raw));
console.log("paired", leaf.issuerCertificate === ca.issuerCertificate, describe(ca.issuerCertificate));
