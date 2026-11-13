// X509Certificate.keyUsage is the extended key usage extension: undefined
// when the certificate carries no extended key usage, the dotted OID of
// each purpose when it does, and an empty array when the extension holds
// no purposes. The key usage bits extension (2.5.29.15) is a different
// extension and leaves the member undefined. Each read answers the
// certificate's own array (so a push is visible on the next read), while
// toLegacyObject's ext_key_usage re-decodes the certificate.
import * as crypto from "node:crypto";

// A version 1 certificate without extensions.
const NO_EXT = `-----BEGIN CERTIFICATE-----
MIIBSTCB7wIUI3kYI5NpR07YqZe6RwOx22je9IowCgYIKoZIzj0EAwIwJzERMA8G
A1UECgwITGVhZiBPcmcxEjAQBgNVBAMMCWxvY2FsaG9zdDAeFw0yNjEwMjExNjMz
NTJaFw0yNjExMjAxNjMzNTJaMCcxETAPBgNVBAoMCExlYWYgT3JnMRIwEAYDVQQD
DAlsb2NhbGhvc3QwWTATBgcqhkjOPQIBBggqhkjOPQMBBwNCAASVX1cvRB/1R0Lk
aqRRZ15NBdNJ3A4begD4FTw6MmyvBz5XDOE+R9cgDjB55R9vSytY7TKlNWgDookE
cz3Qr6qLMAoGCCqGSM49BAMCA0kAMEYCIQCFfFOw9qzzfSOQO1zRnT0sOXibjLWl
hHDyqecxhY7gtQIhAPMgqg+p1JXV5bgGpqgDfP3sE53luxMGlnAC39uhwBUh
-----END CERTIFICATE-----
`;

// Key usage bits (keyCertSign, cRLSign) and no extended key usage.
const BITS = `-----BEGIN CERTIFICATE-----
MIIBcDCCARagAwIBAgIUUQMDYY3+WrZHiQmPN4TA0OkTIpswCgYIKoZIzj0EAwIw
FjEUMBIGA1UEAwwLYml0cy1uby1la3UwHhcNMjYxMTExMjEwMDQ5WhcNMzYxMTA4
MjEwMDQ5WjAWMRQwEgYDVQQDDAtiaXRzLW5vLWVrdTBZMBMGByqGSM49AgEGCCqG
SM49AwEHA0IABHo/B+EEQCKAc4w/ePpwGm8l7cl2LGeBU5iVUCKkAmlzMrp5wnYZ
JlkZhia5GPd3rk+Cd2IeFZjm49jE+Tws/aKjQjBAMA8GA1UdEwEB/wQFMAMBAf8w
DgYDVR0PAQH/BAQDAgEGMB0GA1UdDgQWBBT4zfPbSod0uqX6q14bIRecbusxcDAK
BggqhkjOPQQDAgNIADBFAiAlf7yqkoDoX037s5/YXnEV9z7vRqilIUMaWEoLGmHR
cAIhALhhni3F9BTEouQoHRsMDX8t6cWlw2JuLHEbsoa+3BUO
-----END CERTIFICATE-----
`;

// anyExtendedKeyUsage and serverAuth.
const ANY_SERVER = `-----BEGIN CERTIFICATE-----
MIIBYjCCAQigAwIBAgIUQzfK18SDdjhuZqmMiwAOryg+bC0wCgYIKoZIzj0EAwIw
EjEQMA4GA1UEAwwHYW55LWVrdTAeFw0yNjExMTEyMDU4MzlaFw0zNjExMDgyMDU4
MzlaMBIxEDAOBgNVBAMMB2FueS1la3UwWTATBgcqhkjOPQIBBggqhkjOPQMBBwNC
AAR6PwfhBEAigHOMP3j6cBpvJe3JdixngVOYlVAipAJpczK6ecJ2GSZZGYYmuRj3
d65PgndiHhWY5uPYxPk8LP2iozwwOjAZBgNVHSUEEjAQBgRVHSUABggrBgEFBQcD
ATAdBgNVHQ4EFgQU+M3z20qHdLql+qteGyEXnG7rMXAwCgYIKoZIzj0EAwIDSAAw
RQIhAKRThDuSBRRK5+qEWgRhlD9l1MXwuv95U9JcsDQZCXolAiAK8syN+YHf37Go
WjGuS9ktkVKGL4qeOen3OOypRAVmEw==
-----END CERTIFICATE-----
`;

// A critical extension naming clientAuth alone.
const CRITICAL = `-----BEGIN CERTIFICATE-----
MIIBXzCCAQegAwIBAgIUHjaQUo4WxzwTh07g4agomuLSSbwwCgYIKoZIzj0EAwIw
EzERMA8GA1UEAwwIY3JpdC1la3UwHhcNMjYxMTExMjEwMDQxWhcNMzYxMTA4MjEw
MDQxWjATMREwDwYDVQQDDAhjcml0LWVrdTBZMBMGByqGSM49AgEGCCqGSM49AwEH
A0IABHo/B+EEQCKAc4w/ePpwGm8l7cl2LGeBU5iVUCKkAmlzMrp5wnYZJlkZhia5
GPd3rk+Cd2IeFZjm49jE+Tws/aKjOTA3MBYGA1UdJQEB/wQMMAoGCCsGAQUFBwMC
MB0GA1UdDgQWBBT4zfPbSod0uqX6q14bIRecbusxcDAKBggqhkjOPQQDAgNGADBD
Ah9/tJvLQhCCBJfwNoWKmh+ue8fgju9MZbbUfNXUIJcsAiA09A9mKx8aKRsI8xJa
EIZ2T5I5vNY0fF35bEEoAbAE4Q==
-----END CERTIFICATE-----
`;

// A purpose OpenSSL has no short name for: 1.2.3.4.5.
const UNKNOWN = `-----BEGIN CERTIFICATE-----
MIIBVzCB/qADAgECAhR1zM+HZ2LvV1dcn2IqgXlKsXrg/TAKBggqhkjOPQQDAjAS
MRAwDgYDVQQDDAdvaWQtZWt1MB4XDTI2MTExMTIwNTgzOVoXDTM2MTEwODIwNTgz
OVowEjEQMA4GA1UEAwwHb2lkLWVrdTBZMBMGByqGSM49AgEGCCqGSM49AwEHA0IA
BHo/B+EEQCKAc4w/ePpwGm8l7cl2LGeBU5iVUCKkAmlzMrp5wnYZJlkZhia5GPd3
rk+Cd2IeFZjm49jE+Tws/aKjMjAwMA8GA1UdJQQIMAYGBCoDBAUwHQYDVR0OBBYE
FPjN89tKh3S6pfqrXhshF5xu6zFwMAoGCCqGSM49BAMCA0gAMEUCIQDF0UphOXVn
OENBB+VMP3ArLVjuQycCscg7qZBvNWwkYwIgD9bL5HngZ7Aysw2VtHUacQfOo/Ml
9uOoor3WgF0GO5Y=
-----END CERTIFICATE-----
`;

// The same certificate with its extended key usage replaced by an empty
// sequence (the signature is untouched and not verified on construction).
const EMPTY = `-----BEGIN CERTIFICATE-----
MIIBUTCB+KADAgECAhR1zM+HZ2LvV1dcn2IqgXlKsXrg/TAKBggqhkjOPQQDAjAS
MRAwDgYDVQQDDAdvaWQtZWt1MB4XDTI2MTExMTIwNTgzOVoXDTM2MTEwODIwNTgz
OVowEjEQMA4GA1UEAwwHb2lkLWVrdTBZMBMGByqGSM49AgEGCCqGSM49AwEHA0IA
BHo/B+EEQCKAc4w/ePpwGm8l7cl2LGeBU5iVUCKkAmlzMrp5wnYZJlkZhia5GPd3
rk+Cd2IeFZjm49jE+Tws/aKjLDAqMAkGA1UdJQQCMAAwHQYDVR0OBBYEFPjN89tK
h3S6pfqrXhshF5xu6zFwMAoGCCqGSM49BAMCA0gAMEUCIQDF0UphOXVnOENBB+VM
P3ArLVjuQycCscg7qZBvNWwkYwIgD9bL5HngZ7Aysw2VtHUacQfOo/Ml9uOoor3W
gF0GO5Y=
-----END CERTIFICATE-----
`;

function describe(label: string, cert: crypto.X509Certificate): void {
  const usage: string[] | undefined = cert.keyUsage;
  if (usage === undefined) {
    console.log(label, "absent", cert.keyUsage === undefined);
  } else {
    console.log(label, "present", usage.length, usage.join(" "), Array.isArray(usage));
  }
}

const pems: [string, string][] = [
  ["no-ext", NO_EXT],
  ["bits", BITS],
  ["any", ANY_SERVER],
  ["critical", CRITICAL],
  ["unknown", UNKNOWN],
  ["empty", EMPTY],
];
for (const [label, pem] of pems) describe(label, new crypto.X509Certificate(pem));

// A PEM string and the DER of raw build the same member as the Buffer.
const stringCert = new crypto.X509Certificate(ANY_SERVER);
const derCert = new crypto.X509Certificate(stringCert.raw);
console.log("input", stringCert.keyUsage?.join(","), derCert.keyUsage?.join(","));

// Each read answers the certificate's own array: the same instance, whose
// pushes later reads see. toLegacyObject decodes the certificate again.
const usage = stringCert.keyUsage;
if (usage !== undefined) {
  console.log(
    "identity",
    usage === stringCert.keyUsage,
    usage[0],
    usage[usage.length - 1],
    usage.indexOf("1.3.6.1.5.5.7.3.1"),
  );
  usage.push("1.2.3.4.5");
  const again = stringCert.keyUsage;
  console.log("pushed", again === undefined ? "absent" : again.join(","));
}
const legacy = stringCert.toLegacyObject().ext_key_usage;
console.log("legacy", legacy === undefined ? "absent" : legacy.join(","));
