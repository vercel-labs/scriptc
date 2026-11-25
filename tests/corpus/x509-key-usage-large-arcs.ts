// X509Certificate.keyUsage renders each extended key usage OID in full.
// An arc wider than 64 bits keeps its own value instead of wrapping: a
// distinct purpose must never print as a standard one such as
// serverAuth (1.3.6.1.5.5.7.3.1). The certificates are otherwise valid
// structures; their signatures are not checked on construction.
import * as crypto from "node:crypto";

// 1.3.6.1.5.5.7.3.18446744073709551617 beside serverAuth. Its last arc
// is 2^64 + 1, which a 64-bit accumulator would truncate to 1.
const MULTI = `-----BEGIN CERTIFICATE-----
MIIBbzCCARWgAwIBAgIUQzfK18SDdjhuZqmMiwAOryg+bC0wCgYIKoZIzj0EAwIw
EjEQMA4GA1UEAwwHYW55LWVrdTAeFw0yNjExMTEyMDU4MzlaFw0zNjExMDgyMDU4
MzlaMBIxEDAOBgNVBAMMB2FueS1la3UwWTATBgcqhkjOPQIBBggqhkjOPQMBBwNC
AAR6PwfhBEAigHOMP3j6cBpvJe3JdixngVOYlVAipAJpczK6ecJ2GSZZGYYmuRj3
d65PgndiHhWY5uPYxPk8LP2io0kwRzAmBgNVHSUEHzAdBggrBgEFBQcDAQYRKwYB
BQUHA4KAgICAgICAgAEwHQYDVR0OBBYEFPjN89tKh3S6pfqrXhshF5xu6zFwMAoG
CCqGSM49BAMCA0gAMEUCIQCkU4Q7kgUUSufqhFoEYZQ/ZdTF8Lr/eVPSXLA0GQl6
JQIgCvLMjfmB39+xqFoxrkvZLZFShi+Knjnp9zjsqUQFZhM=
-----END CERTIFICATE-----`;

// 2.18446744073709551617.5: the first subidentifier carries the first
// two arcs, and here its second arc alone exceeds 64 bits.
const FIRST = `-----BEGIN CERTIFICATE-----
MIIBXzCCAQWgAwIBAgIUQzfK18SDdjhuZqmMiwAOryg+bC0wCgYIKoZIzj0EAwIw
EjEQMA4GA1UEAwwHYW55LWVrdTAeFw0yNjExMTEyMDU4MzlaFw0zNjExMDgyMDU4
MzlaMBIxEDAOBgNVBAMMB2FueS1la3UwWTATBgcqhkjOPQIBBggqhkjOPQMBBwNC
AAR6PwfhBEAigHOMP3j6cBpvJe3JdixngVOYlVAipAJpczK6ecJ2GSZZGYYmuRj3
d65PgndiHhWY5uPYxPk8LP2iozkwNzAWBgNVHSUEDzANBguCgICAgICAgIBRBTAd
BgNVHQ4EFgQU+M3z20qHdLql+qteGyEXnG7rMXAwCgYIKoZIzj0EAwIDSAAwRQIh
AKRThDuSBRRK5+qEWgRhlD9l1MXwuv95U9JcsDQZCXolAiAK8syN+YHf37GoWjGu
S9ktkVKGL4qeOen3OOypRAVmEw==
-----END CERTIFICATE-----`;

for (const [label, pem] of [
  ["multi", MULTI],
  ["first", FIRST],
] as [string, string][]) {
  const cert = new crypto.X509Certificate(pem);
  const usage: string[] | undefined = cert.keyUsage;
  console.log(label, usage === undefined ? "absent" : usage.join(" "));
  const legacy = cert.toLegacyObject().ext_key_usage;
  console.log(label, "legacy", legacy === undefined ? "absent" : legacy.join(" "));
}

// The oversized purpose is not serverAuth, so a purpose check passes only
// for the standard entry the certificate really carries.
const cert = new crypto.X509Certificate(MULTI);
const usage = cert.keyUsage ?? [];
console.log("server-auth", usage.indexOf("1.3.6.1.5.5.7.3.1"), usage.length);
