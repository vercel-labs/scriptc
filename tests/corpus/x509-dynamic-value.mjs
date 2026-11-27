// A certificate crossing into an unknown slot is the dynamic handle
// Node's X509Certificate is: every field and method on the prototype (no
// own keys), its PEM as JSON, and instanceof answering true.
import * as crypto from "node:crypto";

const LEAF = `-----BEGIN CERTIFICATE-----
MIIDqjCCApKgAwIBAgICCwswDQYJKoZIhvcNAQELBQAwPjELMAkGA1UEBhMCVVMx
FDASBgNVBAoMC0V4YW1wbGUgT3JnMRkwFwYDVQQDDBBFeGFtcGxlIFJTQSBSb290
MCAXDTI2MTAyMjA5NDY0MVoYDzIxMjYwOTI4MDk0NjQxWjBfMQswCQYDVQQGEwJV
UzEUMBIGA1UECgwLRXhhbXBsZSBPcmcxGDAWBgNVBAMMD3d3dy5leGFtcGxlLmNv
bTEgMB4GCSqGSIb3DQEJARYRYWRtaW5AZXhhbXBsZS5jb20wWTATBgcqhkjOPQIB
BggqhkjOPQMBBwNCAARidSirNIIrw+YHeS112z3N+1n0+uA9HjzkQ5u3QfZsRGCe
ivCEMQSs5+cUE/nv5WWda2kQWavxPGluHFtYmS10o4IBWDCCAVQwCQYDVR0TBAIw
ADALBgNVHQ8EBAMCBaAwHQYDVR0lBBYwFAYIKwYBBQUHAwEGCCsGAQUFBwMCMHsG
A1UdEQR0MHKCDSouZXhhbXBsZS5jb22CC2V4YW1wbGUuY29tghV4bi0tYmNoZXIt
a3ZhLmV4YW1wbGWBD29wc0BleGFtcGxlLmNvbYcECgAAAYcQIAENuAAAAAAAAAAA
AAAAAYYUaHR0cHM6Ly9leGFtcGxlLmNvbS8wXgYIKwYBBQUHAQEEUjBQMCQGCCsG
AQUFBzABhhhodHRwOi8vb2NzcC5leGFtcGxlLmNvbS8wKAYIKwYBBQUHMAKGHGh0
dHA6Ly9jYS5leGFtcGxlLmNvbS9jYS5jcnQwHQYDVR0OBBYEFHyUnRTDwZxUPVwZ
RKmse3fjoeMMMB8GA1UdIwQYMBaAFAgaWVveRbA7VKqcHzjMqBPzi1/LMA0GCSqG
SIb3DQEBCwUAA4IBAQAfMTcpidoH47PXOQVxRttfrG7K9BcntyXP4+5hUAoSfMr6
Rxy7X/9ba7R0yCGlNsUCusObaBpbdvwX8v9TiTYKVL+C9rEVGrTHnh6kbgZaaCQc
L3oWbfRrYnEBYuSlFuadjVvX42aqzHV28E4ITgywCxwubu2hAbacbcUHpnRSqLDq
lV+VZSQA/6cPNct7PR6AkJU80D+5wVOk7RVi4rsfbw1wFDeksCHu+0EThs9zjzL+
S7HTCjB6AOHpbu1Sx+0d5YEKSE7EPF+dSFATNbhjTHzYQySnHK+Lm8nON8wmY1rC
7opOhvUlid1jA1d2BKO2ZxlxLir4pyIehTC1ddG2
-----END CERTIFICATE-----
`;

const describe = (cert) => {
  const out = [];
  out.push(typeof cert, cert instanceof crypto.X509Certificate);
  out.push(JSON.stringify(Object.keys(cert)), JSON.stringify(Object.getOwnPropertyNames(cert)));
  out.push(cert.subject.replace(/\n/g, "|"));
  out.push(typeof cert.fingerprint, cert.fingerprint.length);
  out.push(cert.ca, cert.serialNumber, cert.validFrom, cert.validTo);
  out.push(typeof cert.subjectAltName, typeof cert.infoAccess, cert.signatureAlgorithm);
  out.push(JSON.stringify(cert.keyUsage));
  out.push(cert.raw.length, Buffer.isBuffer(cert.raw));
  out.push(cert.validFromDate instanceof Date, cert.validToDate.toISOString());
  out.push(cert.publicKey.asymmetricKeyType, cert.publicKey.type);
  out.push(cert.checkHost("www.example.com"), cert.checkEmail("ops@example.com"), cert.checkIP("10.0.0.1"));
  out.push(cert.checkHost("nope.example.net") === undefined, cert.checkIP("10.0.0.2") === undefined);
  out.push(String(cert) === cert.toString(), cert.toJSON() === cert.toString());
  out.push(JSON.stringify(cert) === JSON.stringify(String(cert)), JSON.stringify(cert).length);
  out.push(Object.keys(cert.toLegacyObject()).length);
  out.push("subject" in cert, cert.hasOwnProperty("subject"));
  out.push(cert.issuerCertificate === undefined);
  out.push(JSON.stringify({ ...cert }));
  try {
    cert.checkHost(5);
  } catch (e) {
    out.push(e.name, e.code, e.message);
  }
  try {
    cert.nope();
  } catch (e) {
    out.push(e.name, e.message.endsWith("is not a function"));
  }
  return out.join(" ");
};

const keep = (value) => value;
const cert = new crypto.X509Certificate(LEAF);
console.log("direct", describe(keep(cert)));
console.log("again", describe(keep(new crypto.X509Certificate(LEAF))));
const firstSubject = (list) => list[0].subject.replace(/\n/g, "|");
const nested = (record) => String(record.cert).length;
console.log("array", firstSubject([cert]));
console.log("record", nested({ cert }));
