// The TypeScript twin of compat-x509-keyobject.mjs: X509Certificate
// properties and the KeyObject type fields from a typed source, read
// from the repository's test certificate. The CA flag, the three
// fingerprints, the subject and issuer, the alternative names, the serial
// number, the raw DER bytes, the validity strings and dates, and the
// signature algorithm.
import * as crypto from "node:crypto";
import { readFileSync } from "node:fs";

const certificate = new crypto.X509Certificate(readFileSync("tests/fixtures/server/certs/localhost.pem"));
console.log(certificate.ca);
console.log(certificate.fingerprint.length, certificate.fingerprint256.length, certificate.fingerprint512.length);
console.log(certificate.fingerprint256.replaceAll(":", "").toLowerCase() === crypto.createHash("sha256").update(certificate.raw).digest("hex"));
console.log(JSON.stringify(certificate.subject), JSON.stringify(certificate.issuer));
console.log(certificate.subjectAltName);
console.log(typeof certificate.serialNumber, /^[0-9A-F]+$/.test(certificate.serialNumber));
console.log(Buffer.isBuffer(certificate.raw), certificate.raw[0]);
console.log(typeof certificate.validFrom, typeof certificate.validTo);
console.log(certificate.validFromDate instanceof Date, certificate.validToDate.getTime() > certificate.validFromDate.getTime());
console.log(new Date(certificate.validFrom).getTime() === certificate.validFromDate.getTime());
console.log(certificate.signatureAlgorithm, certificate.signatureAlgorithmOid);

const secret = crypto.createSecretKey(Buffer.alloc(16));
const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
console.log(secret.type, secret.symmetricKeySize, publicKey.type, publicKey.symmetricKeySize, privateKey.type);
