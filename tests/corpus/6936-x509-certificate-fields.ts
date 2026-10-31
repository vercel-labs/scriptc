// X509Certificate fields match Node: subject and issuer (one attribute
// per line, RFC 2253 escaping), subjectAltName and infoAccess (undefined
// without the extension), serialNumber, the SHA-1/256/512 fingerprints, ca,
// the signature algorithm, the validity window as strings and Dates, and
// raw, over PEM Buffer, PEM string and DER input.
import * as crypto from "node:crypto";

// An RSA CA with a multi-attribute subject.
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

// An EC leaf with alternative names, access descriptions and extended key usage, signed by CA.
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

// Escaped subject characters, UTF-8 and a comma in a DNS name.
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

// A multi-valued RDN and serial number 0.
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

// An Ed25519 certificate with otherName, directoryName, registeredID and IPv6 names, a BMPString subject, a negative serial and keyUsage without keyCertSign.
const NAMES = `-----BEGIN CERTIFICATE-----
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

// An RSA-PSS signature and a control character in the subject.
const PSS = `-----BEGIN CERTIFICATE-----
MIIDdTCCAiigAwIBAgICAIAwQgYJKoZIhvcNAQEKMDWgDzANBglghkgBZQMEAgEF
AKEcMBoGCSqGSIb3DQEBCDANBglghkgBZQMEAgEFAKIEAgIA3jAeMQwwCgYDVQQD
DANwc3MxDjAMBgNVBAoMBWN0bAF4MB4XDTI2MTAyMTE2NDQzM1oXDTI2MTEyMDE2
NDQzM1owHjEMMAoGA1UEAwwDcHNzMQ4wDAYDVQQKDAVjdGwBeDCCASIwDQYJKoZI
hvcNAQEBBQADggEPADCCAQoCggEBAL2pno8Ybwihdv3hnMhWPPt85SXQmFAJpFoS
E+sT9H6FbwFCIyPkY+SWk8H7y8V+D+388tNvJZmGjX3uvWpK2Wx6anSB3/WMpkUR
2ExP4cpSxZNr9EFzC/cdqLvsxJcHMHkc/uJuFbtjsuiH1ygOe3nyhWSNiPwGdwHE
cKkBFkzW3j2C/4Jkgt4k+sMe3gy5litKtMi4zZB8ixCm5oGhveGhUZy0Kb01twgZ
RP4FEd32sSRqq3NCx4cB0kyreTuzmk6U7BkxcdPzaj6DifjRznTQmjMdoCNZQRCj
G3KBOMHHyvmV2B4lNGDuMlcSap/TpYq7n32AH5sDvELrUnPwVzsCAwEAAaNTMFEw
HQYDVR0OBBYEFC/QJvAQsbQ25sErc1To2G1VuNZ0MB8GA1UdIwQYMBaAFC/QJvAQ
sbQ25sErc1To2G1VuNZ0MA8GA1UdEwEB/wQFMAMBAf8wQgYJKoZIhvcNAQEKMDWg
DzANBglghkgBZQMEAgEFAKEcMBoGCSqGSIb3DQEBCDANBglghkgBZQMEAgEFAKIE
AgIA3gOCAQEAu3lP2Q3Bb5fWUQtgFr/82Oke1ZRW/GRbj03mZ30izADHC7yk0OYm
02f7B5sub04Jk6yuRVmEBjJHSPNwAo0RJWtwvD77KLhG8aObr7Z3+pkfFvpGzqeS
MQ4FtK2MPps3kA1a5D4XLwkwDJtHWZVuVyXpPgxkptfLzZgrieKrpNyOKR8Pz/PO
Wlwv6bF7SXvAV8Vrd7KDvTqwQ5iq9UFhP6GeMDWezYtzLdjlvje7MhmZ96zgSY6m
qumNWOPHmiN4eoOE4M69B+0fa3WyMzubW0nVGM/sDhtS0k5zHs6Y4RLn11HolhXH
LvbvDgqtl/m5i0uHxEld+Z1uhzJscqFQRg==
-----END CERTIFICATE-----
`;

// A version 1 certificate without extensions.
const V1 = `-----BEGIN CERTIFICATE-----
MIIBSTCB7wIUI3kYI5NpR07YqZe6RwOx22je9IowCgYIKoZIzj0EAwIwJzERMA8G
A1UECgwITGVhZiBPcmcxEjAQBgNVBAMMCWxvY2FsaG9zdDAeFw0yNjEwMjExNjMz
NTJaFw0yNjExMjAxNjMzNTJaMCcxETAPBgNVBAoMCExlYWYgT3JnMRIwEAYDVQQD
DAlsb2NhbGhvc3QwWTATBgcqhkjOPQIBBggqhkjOPQMBBwNCAASVX1cvRB/1R0Lk
aqRRZ15NBdNJ3A4begD4FTw6MmyvBz5XDOE+R9cgDjB55R9vSytY7TKlNWgDookE
cz3Qr6qLMAoGCCqGSM49BAMCA0kAMEYCIQCFfFOw9qzzfSOQO1zRnT0sOXibjLWl
hHDyqecxhY7gtQIhAPMgqg+p1JXV5bgGpqgDfP3sE53luxMGlnAC39uhwBUh
-----END CERTIFICATE-----
`;


function show(label: string, cert: crypto.X509Certificate): void {
  console.log(label, "subject", JSON.stringify(cert.subject));
  console.log(label, "issuer", JSON.stringify(cert.issuer));
  console.log(label, "subjectAltName", JSON.stringify(cert.subjectAltName), typeof cert.subjectAltName);
  console.log(label, "infoAccess", JSON.stringify(cert.infoAccess), cert.infoAccess === undefined);
  console.log(label, "serialNumber", cert.serialNumber);
  console.log(label, "fingerprints", cert.fingerprint, cert.fingerprint256);
  console.log(label, "fingerprint512", cert.fingerprint512);
  console.log(label, "ca", cert.ca);
  console.log(label, "signature", cert.signatureAlgorithm, cert.signatureAlgorithmOid);
  console.log(label, "validity", cert.validFrom, "|", cert.validTo);
  console.log(label, "dates", cert.validFromDate.toISOString(), cert.validToDate.getTime());
  console.log(label, "raw", cert.raw.length, Buffer.isBuffer(cert.raw), cert.raw.subarray(0, 4).toString("hex"));
}

const pems: [string, string][] = [
  ["ca", CA],
  ["leaf", LEAF],
  ["odd", ODD],
  ["multi", MULTI],
  ["names", NAMES],
  ["pss", PSS],
  ["v1", V1],
];
for (const [label, pem] of pems) show(label, new crypto.X509Certificate(Buffer.from(pem)));

// A PEM string, and the DER bytes of raw.
const fromString = new crypto.X509Certificate(LEAF);
show("string", fromString);
const fromDer = new crypto.X509Certificate(fromString.raw);
console.log("der", fromDer.subject === fromString.subject, fromDer.fingerprint256 === fromString.fingerprint256);
console.log("der raw copy", fromDer.raw !== fromString.raw, fromDer.raw.equals(fromString.raw));

try {
  new crypto.X509Certificate(Buffer.from("not a certificate"));
} catch (e) {
  const err = e as NodeJS.ErrnoException;
  console.log("garbage", err.name, err.code);
}
