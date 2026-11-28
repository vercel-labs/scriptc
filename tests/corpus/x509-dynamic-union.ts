// A certificate held in a union (a populated certificate lookup) answers
// instanceof crypto.X509Certificate from the arm it carries.
import { X509Certificate } from "node:crypto";

const PEM = `-----BEGIN CERTIFICATE-----
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

const cert = new X509Certificate(PEM);
const lookup = new Map<string, X509Certificate>([["leaf", cert]]);
const found: X509Certificate | undefined = lookup.get("leaf");
const missing: X509Certificate | undefined = lookup.get("nope");
console.log("found", found instanceof X509Certificate, missing instanceof X509Certificate,
  found === cert, missing === undefined);
const held: unknown = cert;
console.log("dynamic", held instanceof X509Certificate);
const value: unknown = 5;
console.log("other", value instanceof X509Certificate);
