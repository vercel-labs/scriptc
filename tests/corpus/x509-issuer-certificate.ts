// X509Certificate.issuerCertificate is Node's TLS layer's issuer chain; a
// certificate the program builds from PEM or DER carries none, so the getter
// answers undefined, however it is read: through the property type, a held
// union, a helper, a truthiness test, a narrowed branch, equality, `typeof`
// and `??`, and as a prototype member for `in` and Object.hasOwn.
import * as crypto from "node:crypto";

const CA = `-----BEGIN CERTIFICATE-----
MIIEITCCAwmgAwIBAgIIASNFZ4mrze8wDQYJKoZIhvcNAQELBQAwgZwxCzAJBgNV
BAYTAlVTMRMwEQYDVQQIDApDYWxpZm9ybmlhMRYwFAYDVQQHDA1TYW4gRnJhbmNp
c2NvMRQwEgYDVQQKDAtFeGFtcGxlIE9yZzERMA8GA1UECwwIRGV2IFRlYW0xGDAW
BgNVBAMMD0V4YW1wbGUgUm9vdCBDQTEdMBsGCSqGSIb3DQEJARYOY2FAZXhhbXBs
ZS5jb20wIBcNMjYxMDIxMTYzMzUyWhgPMjEyNjA5MjcxNjMzNTJaMIGcMQswCQYD
VQQGEwJVUzETMBEGA1UECAwKQ2FsaWZvcm5pYTEWMBQGA1UEBwwNU2FuIEZyYW5j
aXNjbzEUMBIGA1UECgwLRXhhbXBsZSBPcmcxETAPBgNVBAsMCERldiBUZWFtMRgw
FgYDVQQDDA9FeGFtcGxlIFJvb3QgQ0ExHTAbBgkqhkiG9w0BCQEWDmNhQGV4YW1w
bGUuY29tMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA0YGcCr0pxR8d
6qDdLuILcoT7vhtAjyHwfkoChnH6N3TLWzDUugnBp9NbDb7gDLqbRT4uTDoNb6zS
tEJZ4Q7/hhd0jDvoPmOy0Y3Kyj9uNsdf25GdbvwwEnlddELJCZprTZ4OhEg6w2s0
Yy4SlviLzDXLmsggTypxeS+K8JHT9onMipi5L4GFu8n1QZbzXvSS4BkRgMXEyrtr
FOE9qSo2qkubFyd/WNKRTRIpTSc5/GGsqJ0FKDDJnN5adotcUucbJFn4noNnFUWh
M8mhBEj7ENDdJsD2EVFsI6H958jA2SbNNu4ngzAOs2AKNBYBfQK02ZQAdRNOSL3K
5FkfbII5LwIDAQABo2MwYTAdBgNVHQ4EFgQUP+yQyItpNYEls26Jfv+NnciGaK8w
HwYDVR0jBBgwFoAUP+yQyItpNYEls26Jfv+NnciGaK8wDwYDVR0TAQH/BAUwAwEB
/zAOBgNVHQ8BAf8EBAMCAQYwDQYJKoZIhvcNAQELBQADggEBABDw3Va/C+RFc/Hs
TJnHtQJtxFL0ZhnHUqg4DcDA3m+JDdIDNL8sNpLEbtn/pr0VeEWgG+MImWAQlrUW
IAZkLj9/Zg1wSO0oZ86ZyZJZmp54lUYXgG17CNl4g+F7VHt3bBwUJHTbWye/FKM6
5OVZetCYKVj7Z+5BYuf7cumzvRqcn32fXidB/kjRX14SJ4JDPn2yFZWCr2ygIqWQ
SOuEmWbNAbYGaVZkQr2Ma8U28DWY2jb0f6nP8jLt49t9o6N/e6Fwd6I5t/mx9Mfj
0403omkxmr9vqN2kBamzVnun+2mDkRZcKPCr72Q4sfbvmDi/W5Nf1Iu2cQW8VfDO
SqpyT54=
-----END CERTIFICATE-----
`;

const LEAF = `-----BEGIN CERTIFICATE-----
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

function describe(ic: crypto.X509Certificate | undefined): string {
  return ic === undefined ? "no issuer" : `issuer ${ic.subject}`;
}

function probe(label: string, cert: crypto.X509Certificate): void {
  console.log(
    label,
    "direct",
    cert.issuerCertificate === undefined,
    typeof cert.issuerCertificate,
    cert.issuerCertificate === cert.issuerCertificate,
  );
  console.log(label, "fn", describe(cert.issuerCertificate));
  const held: crypto.X509Certificate | undefined = cert.issuerCertificate;
  console.log(
    label,
    "held",
    held === undefined,
    describe(held),
    cert.issuerCertificate === undefined ? "fallback" : "present",
  );
  if (cert.issuerCertificate) console.log(label, "truthy", cert.issuerCertificate.subject);
  else console.log(label, "falsy");
  if (cert.issuerCertificate !== undefined) console.log(label, "narrowed", cert.issuerCertificate.subject);
  else console.log(label, "narrowed-else", cert.subject.length > 0);
  console.log(
    label,
    "shape",
    "issuerCertificate" in cert,
    "checkHost" in cert,
    "verify" in cert,
    "toString" in cert,
    "nope" in cert,
    Object.hasOwn(cert, "issuerCertificate"),
    Object.hasOwn(cert, "subject"),
    Object.hasOwn(cert, "raw"),
    Object.hasOwn(cert, "checkHost"),
  );
}

const ca = new crypto.X509Certificate(CA);
const leafPem = new crypto.X509Certificate(LEAF);
probe("pem", leafPem);
probe("buffer", new crypto.X509Certificate(Buffer.from(CA)));
probe("der", new crypto.X509Certificate(leafPem.raw));
probe("string-der", new crypto.X509Certificate(Buffer.from(LEAF)));
console.log(
  "ca",
  ca.issuerCertificate === undefined,
  describe(ca.issuerCertificate),
  ca.subject === ca.issuer,
);
console.log(
  "paired",
  leafPem.issuerCertificate === ca.issuerCertificate,
  describe(leafPem.issuerCertificate),
  describe(ca.issuerCertificate),
);
