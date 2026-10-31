// X509Certificate.toLegacyObject and toString match Node: the
// legacy object's members in Node's order (subject and issuer objects
// with repeated attributes as arrays, alternative names, access
// descriptions by method, the RSA modulus, exponent and SPKI or the EC
// point and curve names, the validity window, fingerprints, extended key
// usages, serial number and raw bytes), its inspect output, and the PEM
// text of toString, String() and template literals.
import { X509Certificate } from "node:crypto";

// An EC leaf with every alternative name kind, and the RSA root that signed it.
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
const ROOT = `-----BEGIN CERTIFICATE-----
MIIDPTCCAiWgAwIBAgIDChHOMA0GCSqGSIb3DQEBCwUAMD4xCzAJBgNVBAYTAlVT
MRQwEgYDVQQKDAtFeGFtcGxlIE9yZzEZMBcGA1UEAwwQRXhhbXBsZSBSU0EgUm9v
dDAgFw0yNjEwMjIwOTQ2NDFaGA8yMTI2MDkyODA5NDY0MVowPjELMAkGA1UEBhMC
VVMxFDASBgNVBAoMC0V4YW1wbGUgT3JnMRkwFwYDVQQDDBBFeGFtcGxlIFJTQSBS
b290MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAwsfidupnXQcn8PUF
XaCKRYw8XKI1GUn29U5/IUGjAnJVaRmcB6BPTmblbKt4y7gLvU4h1Hxuypx8FZSZ
30eZOS1ixyrymDthG5zUHqzXk5zAGsNvZeXjN3YxTC9vX5CpQ9Uz2i+bLOi3PJsE
qyKVZ+GGT9fpIaALG11YrWmXTUko/a0AKGot0w8O/RaMpXQpkbeyTBF6f4pHNMqx
QGy+KlpC/+yIJ9psT6qyU33HF3Wa+DOy+0txAFEQNw9m1j7adOLnU0zBpkM/bnP2
fSwxMkDB2Di2P5H6PkdqLT4zBf/BLdg7WqpxxSqqgVmaSXhEqUQ6xjf51yLR3wy/
xBWhMQIDAQABo0IwQDAPBgNVHRMBAf8EBTADAQH/MA4GA1UdDwEB/wQEAwIBBjAd
BgNVHQ4EFgQUCBpZW95FsDtUqpwfOMyoE/OLX8swDQYJKoZIhvcNAQELBQADggEB
AChUtpNi8dPPxA4sf4EpZhEcYBN53X3WUcG3KJGtSf8JbPKru9lK9O+sZtJADbph
WoMPdWh8g+fEMk5D6l8Y5pDk/OR++oWNY7XCLFNyigmUGn+4SopJynBQiDk2dYPV
b6swDPPiV85TuAHVn79l766rtFdHdYwRe5HvfEkiXax7Egonlx7NR73xxm/XgvHQ
jhKbTZN9k/DEjkQuo5rt9ldVupUMM0iMhDMKX5oWEx9nvRwHPbjESS+Shy/FA4nA
2WHWO++4IU+imO40an1B/8SmFF+X9hj3UE6qaZLynVZRUiouBZibwZCcdCpibFM3
kmB2s+NZXRvzhCjIxO97Ib4=
-----END CERTIFICATE-----
`;
// An EC leaf with access descriptions and extended key usages.
const ACCESS = `-----BEGIN CERTIFICATE-----
MIIDuzCCAqOgAwIBAgIPAPAN+s4AESIzRFVmd4iZMA0GCSqGSIb3DQEBDAUAMIGc
MQswCQYDVQQGEwJVUzETMBEGA1UECAwKQ2FsaWZvcm5pYTEWMBQGA1UEBwwNU2Fu
IEZyYW5jaXNjbzEUMBIGA1UECgwLRXhhbXBsZSBPcmcxETAPBgNVBAsMCERldiBU
ZWFtMRgwFgYDVQQDDA9FeGFtcGxlIFJvb3QgQ0ExHTAbBgkqhkiG9w0BCQEWDmNh
QGV4YW1wbGUuY29tMB4XDTI2MTAyMTE2MzM1MloXDTM2MTAxODE2MzM1MlowJzER
MA8GA1UECgwITGVhZiBPcmcxEjAQBgNVBAMMCWxvY2FsaG9zdDBZMBMGByqGSM49
AgEGCCqGSM49AwEHA0IABJVfVy9EH/VHQuRqpFFnXk0F00ncDht6APgVPDoybK8H
PlcM4T5H1yAOMHnlH29LK1jtMqU1aAOiiQRzPdCvqoujggE3MIIBMzAJBgNVHRME
AjAAMGgGA1UdEQRhMF+CCWxvY2FsaG9zdIINKi5leGFtcGxlLmNvbYcEfwAAAYcQ
AAAAAAAAAAAAAAAAAAAAAYERYWRtaW5AZXhhbXBsZS5jb22GGGh0dHBzOi8vZXhh
bXBsZS5jb20vcGF0aDBdBggrBgEFBQcBAQRRME8wIwYIKwYBBQUHMAGGF2h0dHA6
Ly9vY3NwLmV4YW1wbGUuY29tMCgGCCsGAQUFBzAChhxodHRwOi8vY2EuZXhhbXBs
ZS5jb20vY2EuY3J0MB0GA1UdJQQWMBQGCCsGAQUFBwMBBggrBgEFBQcDAjAdBgNV
HQ4EFgQUdKIx6ULFLPNP/kzwUFjSa5D19RswHwYDVR0jBBgwFoAUP+yQyItpNYEl
s26Jfv+NnciGaK8wDQYJKoZIhvcNAQEMBQADggEBABmQ8f2VsXNaMM9X1MEhi27D
LjwcOaaGEINNZq7xu/HL6UljMb1Odsuz66DkiH3Exd3MrWy6OlOpJJF0VzsqMsoD
0CRBxXF28o6Jil3vOGVwlYNmRidpkAkj4VyWDvv8FCS9VbsBtXaSHwu9wcCwePE0
cGJRfTKoZ6KJ8vQ57DBEZ/ZszuhehOZYqrTmoUdjZ123kXdxQvK+ALn4SlIXHBhN
9unhd+8i00EmkXO/REw8paMcMVVGR+ioOEjyNHqZo6vkRqgpKggn1Yq8cTTDOMnS
P1o42EQZLlbuvx0kqInBqwqjDx4nZiPaifoDc9BF6iZPBvm8dhrEfghfB1tkNk0=
-----END CERTIFICATE-----
`;
// A multi-valued RDN, an Ed25519 key and names that need escaping.
const MULTI = `-----BEGIN CERTIFICATE-----
MIICNzCCAaCgAwIBAgIBADANBgkqhkiG9w0BAQsFADA3MSgwCgYDVQQLDANyZG4w
DAYDVQQDDAVtdWx0aTAMBgNVBAoMBXRocmVlMQswCQYDVQQGEwJERTAeFw0yNjEw
MjExNjM0MDVaFw0yNjEwMzExNjM0MDVaMDcxKDAKBgNVBAsMA3JkbjAMBgNVBAMM
BW11bHRpMAwGA1UECgwFdGhyZWUxCzAJBgNVBAYTAkRFMIGfMA0GCSqGSIb3DQEB
AQUAA4GNADCBiQKBgQDdv64EOPdpcWdjVMAlEQvNzm3ZbQYXrhOwRF9yzQp25SuA
3uKvStZOt8hyTifAd30oDXIfgyYI39xKHEkHfARTV1E2Jwyiz86/pDHmFypPFJuI
v/vOjYLLeisiVi8TFfHgmoGqGvySR83fwiUnoOOWj9Bqt/5EVBQbBeWrU9qH6QID
AQABo1MwUTAdBgNVHQ4EFgQUZrGU0gkgqCkmegRtu6vQ3h7kpPUwHwYDVR0jBBgw
FoAUZrGU0gkgqCkmegRtu6vQ3h7kpPUwDwYDVR0TAQH/BAUwAwEB/zANBgkqhkiG
9w0BAQsFAAOBgQAMzFkzJElc9VJYhGx7AngO8Yve22iCTOVLO3/be8w55klb/HJX
vfESQz+EJLYVaP5Q/uChoE0I27NytkeUSpJFwmjyqoQq2j6kJWGKONqhQSnXDrms
HMPA7iik/C5hOqpwzDZ98wNU/e86TrqZxzpFkwbnZx9MSfiGr690s5BfpA==
-----END CERTIFICATE-----
`;
const ED = `-----BEGIN CERTIFICATE-----
MIICSDCCAfqgAwIBAgIB+zAFBgMrZXAwLDEVMBMGA1UEAx4MAGIAbQBwACAA6U4t
MRMwEQYDVQQKHgoAcABsAGEAaQBuMB4XDTI2MTAyMTE2NDQzM1oXDTI2MTEyMDE2
NDQzM1owLDEVMBMGA1UEAx4MAGIAbQBwACAA6U4tMRMwEQYDVQQKHgoAcABsAGEA
aQBuMCowBQYDK2VwAyEAP+2Vcp8nwu2AhFvSczYTxGs1jV/ckA76Jqvwj9QDGqij
ggE/MIIBOzCBtwYDVR0RBIGvMIGsoBsGCisGAQQBgjcUAgOgDQwLdXNlckBkb21h
aW6gEAYDKgMEoAkMB3Vua25vd26kRTBDMQswCQYDVQQGEwJVSzEZMBcGA1UECh4Q
AEQAaQByACwAIABPAHIAZzEZMBcGA1UEAx4QAGQAaQByACAAbgBhAG0AZYgEKgME
BYcQ/oAAAAAAAAAAAAAAAAEAAocQIAENuAAAAAAAAP8AAEKDKYYKaHR0cDovL3gv
cTAMBgNVHRMEBTADAQH/MAsGA1UdDwQEAwIHgDBFBggrBgEFBQcBAQQ5MDcwIAYI
KwYBBQUHMAWGFGh0dHA6Ly9yZXBvLmV4YW1wbGUvMBMGBCoDBAWCC29kZC5leGFt
cGxlMB0GA1UdDgQWBBQYMJ0fQJ1Nx0PmatIfTJusAEA9WTAFBgMrZXADQQCixubE
nuunBZYYPXF52+joQSX/a5DFkOEDmzRTuH7IIpPFWPo37rmJOSdPA/PV8v9clzYF
LP3EjM4YOAatcbsO
-----END CERTIFICATE-----
`;
const ODD = `-----BEGIN CERTIFICATE-----
MIICXzCCAeWgAwIBAgIBATAKBggqhkjOPQQDAjBvMQ0wCwYDVQQDDARhLCBiMQ4w
DAYDVQQHDAUjbGVhZDESMBAGA1UECAwJICBzcGFjZSAgMSYwJAYDVQQKDB1RdW90
ZSBxIGJhY2tcc2xhc2g7IHNlbWkgPGx0PjESMBAGA1UECwwJQ2Fmw6kg4oKsMB4X
DTI2MTAyMTE2MzM1MloXDTI3MTAyMTE2MzM1MlowbzENMAsGA1UEAwwEYSwgYjEO
MAwGA1UEBwwFI2xlYWQxEjAQBgNVBAgMCSAgc3BhY2UgIDEmMCQGA1UECgwdUXVv
dGUgcSBiYWNrXHNsYXNoOyBzZW1pIDxsdD4xEjAQBgNVBAsMCUNhZsOpIOKCrDB2
MBAGByqGSM49AgEGBSuBBAAiA2IABMLLzwDsSeezCzScnC9xTIFl35dFAX+1Uagk
0y4Y72rOOgVFA13SMIbMfv2InIyg2vXOdqn0y7RqiaaqqnAYZB2RHHL0SD7t2MVL
K3BQajy7Oi6IeDDRGK1jM4D6nk/1AKNVMFMwMgYDVR0RBCswKYILYSxiLmV4YW1w
bGWCDXBsYWluLmV4YW1wbGWBBXhAeS56hwQKAAABMB0GA1UdDgQWBBSR4U6nIpTt
5rLoIZZxfxSyx9Uc9zAKBggqhkjOPQQDAgNoADBlAjEAlznFL0Nrt1jjZrT3/GN0
yN/8gxO3SawyqoWrfP3uk1GScTh0PlrTEOrpSyuq3wl5AjBRntVI1ZoUM46pCwIw
0Vl3c3lns7OljcQFiR7o8yRhEW9ejdiR2W6PLBrjCly6U3I=
-----END CERTIFICATE-----
`;

const certs: [string, X509Certificate][] = [
  ["leaf", new X509Certificate(LEAF)],
  ["root", new X509Certificate(Buffer.from(ROOT))],
  ["access", new X509Certificate(ACCESS)],
  ["multi", new X509Certificate(MULTI)],
  ["ed", new X509Certificate(ED)],
  ["odd", new X509Certificate(ODD)],
];

for (const [name, cert] of certs) {
  const legacy = cert.toLegacyObject();
  const shown = JSON.stringify(legacy, (key: string, value: unknown) => {
    if (value === undefined) return "<undefined>";
    if (key === "raw" || key === "pubkey") return `<${(value as { data: number[] }).data.length} bytes>`;
    return value;
  });
  console.log(name, shown);
  const absent = Object.keys(legacy).filter((key) => (legacy as unknown as Record<string, unknown>)[key] === undefined);
  console.log(name, "absent", absent.join(","), Buffer.isBuffer(legacy.raw), legacy.raw.equals(cert.raw), legacy.raw === cert.raw);
  const spki: Buffer = cert.publicKey.export({ type: "spki", format: "der" });
  if (legacy.pubkey !== undefined) console.log(name, "pubkey", legacy.pubkey.equals(spki));
}

console.log(certs[0]![1].toLegacyObject());
console.log(certs[3]![1].toLegacyObject());

for (const [name, cert] of certs) {
  const pem = cert.toString();
  console.log(name, pem.length, pem === String(cert), `${cert}` === pem, new X509Certificate(pem).fingerprint256 === cert.fingerprint256);
}
console.log(certs[3]![1].toString());
