// `new X509Certificate(data)` where the argument's type is not known
// statically (a function parameter, an `unknown` slot): Node validates the
// argument first — a string or Buffer parses, anything else throws
// ERR_INVALID_ARG_TYPE naming "buffer" — and then parses it as the static
// forms do, so a dynamic PEM or Buffer certificate behaves like a literal
// one.
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

const attempt = (label, f) => {
  try {
    f();
  } catch (e) {
    console.log(label, "THROW", e.name, e.code, e.message);
  }
};
const fingerprintOf = (data) => new crypto.X509Certificate(data).fingerprint;
const hostOf = (data) => new crypto.X509Certificate(data).checkHost("www.example.com");

console.log("pem", fingerprintOf(LEAF));
console.log("buffer", fingerprintOf(Buffer.from(LEAF)));
console.log("u8", fingerprintOf(new Uint8Array(Buffer.from(LEAF))));
// A view over an ArrayBuffer holding exactly the PEM bytes (typed arrays
// are not pooled, so the view covers nothing else).
const pemBytes = Buffer.from(LEAF);
const exactPem = pemBytes.buffer.slice(pemBytes.byteOffset, pemBytes.byteOffset + pemBytes.byteLength);
console.log("u16", fingerprintOf(new Uint16Array(exactPem)));
console.log("data view", fingerprintOf(new DataView(exactPem)));
console.log("host", hostOf(LEAF), hostOf(Buffer.from(LEAF)));

attempt("junk string", () => { fingerprintOf("junk"); });
attempt("junk buffer", () => { fingerprintOf(Buffer.from("junk")); });
attempt("junk data view", () => { fingerprintOf(new DataView(new ArrayBuffer(3))); });
attempt("array buffer", () => { fingerprintOf(exactPem); });
attempt("number", () => { fingerprintOf(5); });
attempt("null", () => { fingerprintOf(null); });
attempt("undefined", () => { fingerprintOf(undefined); });
attempt("boolean", () => { fingerprintOf(true); });
attempt("object", () => { fingerprintOf({}); });
attempt("array", () => { fingerprintOf([1, 2]); });
attempt("no argument", () => { new crypto.X509Certificate(); });
