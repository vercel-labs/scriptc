// A certificate's raw Buffer is the same object at every read, and writing
// into it changes neither the certificate's fields, checks and PEM nor its
// public key, as in Node: the methods read the certificate itself.
import { X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";

const cert = new X509Certificate(readFileSync("tests/fixtures/server/certs/localhost.pem"));
const ca = new X509Certificate(readFileSync("tests/fixtures/server/certs/ca.pem"));
const raw = cert.raw;
console.log("same Buffer", raw === cert.raw);
const report = (): string =>
  `${cert.fingerprint256}\n${cert.subject}\n${cert.checkHost("localhost")}\n` +
  `${cert.checkIssued(ca)} ${ca.checkIssued(cert)} ${cert.verify(ca.publicKey)}\n` +
  `${cert.toString()}\n${cert.publicKey.export({ format: "pem", type: "spki" })}`;
const before = report();
raw.fill(0);
console.log("unchanged", report() === before);
console.log("raw now", cert.raw.every((b) => b === 0), cert.raw.length);
const other = new X509Certificate(readFileSync("tests/fixtures/server/certs/localhost.pem"));
console.log("fresh certificate raw", other.raw[0], other.raw.equals(cert.raw));
