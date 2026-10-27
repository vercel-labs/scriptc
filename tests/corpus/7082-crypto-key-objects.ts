// Private and public KeyObjects: createPrivateKey and createPublicKey from
// PEM, DER, JWK, a private KeyObject and a certificate; the type,
// asymmetricKeyType and asymmetricKeyDetails getters; export() as PKCS#1,
// SEC1, PKCS#8, SubjectPublicKeyInfo, DER and JWK; equals(); instanceof;
// and Node's errors for invalid options and inputs, including a private or
// public key passed to createHmac.
import * as crypto from "node:crypto";

const RSA = `-----BEGIN RSA PRIVATE KEY-----
MIICWwIBAAKBgQDWei4BREJm+4C6u/+F4NI7kTOQ9gf/a+Ecd2SZxfpXRtXT0QVN
MAI1uQNmB4abYzvd1G2V2XKsTJFJcJWibjAz56UxtxxggTpSAalFZYoPm6HfabwJ
b/YWh0K0OrNFvdkeXLLMiHQsxmIQ2lrFoycQEpZ4/yxjLe6LQF+L79k2ywIDAQAB
AoGAMWS/9ZC3zim7ssWbCkUFhaxh+M+AdgVtOXYRmAxtI+5vTjHEC8uzppWuP7Aa
Au0um17RwgHrE90qVIR2IYtI1C9K9RLUNlKKVPqnSSmr0qkXR246R/Zd8eho1XSS
MX6KmnbmRijUx9Rw1AbD2ZmYCrXsPf2HsCdH+SGQ1ZTunnECQQD090dTA21Jyu/b
ADglqgixJCPIoc6qpxst+W1LreIo4UvkSmgnRYvsKDlM7FNI+6f7igI625KXIAnl
xVlmGLXDAkEA4CNVeP07fmQUBs1aPQ9LCOvN42SV6S8Fjbf4XHIYG5Kp48/98oJj
1pFsXNa8nn8fmN9zFw8yM/yd22iZdueCWQJAWMja//po/OrhniVpNDV5awKnOYtz
xSRF1JbnhxthseFeSUKylzE8sn4trnSlBvm2+5MclcqJSd7h13Z8nWVtUwJAZ0SA
Ve0+ov4TKAsnH2jTZnnWc4VdeIFcqq3vdRBwQQvy0G59D2W6ABsidSfO4auqcDHL
gf1TYRZr2LI5usnxiQJAGt3e0QC0q0WN4p49YhyXXVuHccx79RFgfN7V1lkAyYuL
2bPV41mEtD/AbSrObtqqvOaWZjwSr8JCyPdPZZAIMw==
-----END RSA PRIVATE KEY-----
`;
const EC = `-----BEGIN EC PRIVATE KEY-----
MHcCAQEEILpVcXOEZQXpH/q3ec3AsLg4x4Bld6uZLqDC56OYKQK4oAoGCCqGSM49
AwEHoUQDQgAE0gwi0a/4kuVxjsO3vw79rT3QSxnPY7sooVlI+ENq35D7meWZv/dp
FTGFte7Bd8lFxaZ10dMo0tl++AOtt7umPg==
-----END EC PRIVATE KEY-----
`;
const EC384 = `-----BEGIN EC PRIVATE KEY-----
MIGkAgEBBDDer7W8pQD96zdS8UWxg34nMTxqREszwP6niYYOdw75LHPmHFKWeMKW
dmG6d3n4bRugBwYFK4EEACKhZANiAATIQKDRVJ501CTQtbK2IslxdO8Oma2ZU4ee
GRuQFg6ajhKXa0iCU5o9rpdObfCecyiYApdtVpahD2SwPua5CZyq/0jUn9frwKtB
uEeB/3T/yYRCD4zGUc7TtUDh8c7Gt5c=
-----END EC PRIVATE KEY-----
`;
const CERT = `-----BEGIN CERTIFICATE-----
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

function attempt(label: string, run: () => unknown): void {
  try {
    const value = run();
    console.log(label, typeof value === "string" ? JSON.stringify(value) : value);
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    console.log(label, "throws", err.name, err.code, err.message);
  }
}

const rsa = crypto.createPrivateKey(RSA);
const ec = crypto.createPrivateKey(Buffer.from(EC));
const ec384 = crypto.createPrivateKey({ key: EC384, format: "pem" });
const rsaPublic = crypto.createPublicKey(rsa);
const ecPublic = crypto.createPublicKey(EC);
const certPublic = crypto.createPublicKey(CERT);
const keys: [string, crypto.KeyObject][] = [
  ["rsa", rsa],
  ["ec", ec],
  ["ec384", ec384],
  ["rsaPublic", rsaPublic],
  ["ecPublic", ecPublic],
  ["certPublic", certPublic],
];
for (const [label, key] of keys) {
  console.log(label, key.type, key.asymmetricKeyType, key.asymmetricKeyDetails, key instanceof crypto.KeyObject);
}

attempt("pkcs1", () => rsa.export({ type: "pkcs1", format: "pem" }) === RSA + "\n");
attempt("sec1", () => ec.export({ type: "sec1", format: "pem" }) === EC + "\n");
attempt("rsa pkcs8", () => rsa.export({ type: "pkcs8", format: "pem" }));
attempt("ec pkcs8", () => ec.export({ type: "pkcs8", format: "pem" }));
attempt("rsa spki", () => rsaPublic.export({ type: "spki", format: "pem" }));
attempt("rsa public pkcs1", () => rsaPublic.export({ type: "pkcs1", format: "pem" }));
attempt("ec spki", () => ecPublic.export({ type: "spki", format: "pem" }));
attempt("cert spki", () => certPublic.export({ type: "spki", format: "pem" }));
attempt("der", () => (rsa.export({ type: "pkcs8", format: "der" }) as Buffer).toString("base64"));
attempt("ec jwk", () => JSON.stringify(ec.export({ format: "jwk" })));
attempt("ec384 public jwk", () => JSON.stringify(crypto.createPublicKey(ec384).export({ format: "jwk" })));
attempt("rsa jwk", () => JSON.stringify(rsa.export({ format: "jwk" })));
attempt("rsa public jwk", () => JSON.stringify(rsaPublic.export({ format: "jwk" })));

// Round trips through DER and JWK.
const der = rsa.export({ type: "pkcs1", format: "der" }) as Buffer;
attempt("from der", () => crypto.createPrivateKey({ key: der, format: "der", type: "pkcs1" }).equals(rsa));
const spki = ecPublic.export({ type: "spki", format: "der" }) as Buffer;
attempt("public from der", () => crypto.createPublicKey({ key: spki, format: "der", type: "spki" }).equals(ecPublic));
attempt("from jwk", () => crypto.createPrivateKey({ key: ec.export({ format: "jwk" }), format: "jwk" }).equals(ec));
attempt("rsa from jwk", () => crypto.createPrivateKey({ key: rsa.export({ format: "jwk" }), format: "jwk" }).equals(rsa));
attempt("public from jwk", () => crypto.createPublicKey({ key: rsaPublic.export({ format: "jwk" }), format: "jwk" }).equals(rsaPublic));
attempt("pkcs8 parse", () => crypto.createPrivateKey(ec.export({ type: "pkcs8", format: "pem" })).equals(ec));
attempt("equals", () => [rsaPublic.equals(crypto.createPublicKey(RSA)), ec.equals(ecPublic), ec.equals(ec384)].join());
attempt("tag", () => Object.prototype.toString.call(rsa));

// Errors.
attempt("export no options", () => rsa.export());
attempt("export no format", () => rsa.export({} as crypto.AsymmetricKeyExportOptions<"pem">));
attempt("export no type", () => rsa.export({ format: "pem" } as crypto.AsymmetricKeyExportOptions<"pem">));
attempt("export spki private", () => rsa.export({ type: "spki", format: "pem" }));
attempt("export sec1 rsa", () => rsa.export({ type: "sec1", format: "pem" }));
attempt("export pkcs1 ec", () => ec.export({ type: "pkcs1", format: "der" }));
attempt("export pkcs8 public", () => ecPublic.export({ type: "pkcs8", format: "pem" }));
attempt("private from public pem", () => crypto.createPrivateKey(ecPublic.export({ type: "spki", format: "pem" }) as string));
attempt("private from garbage", () => crypto.createPrivateKey("not a key"));
attempt("public from public", () => crypto.createPublicKey(ecPublic));
attempt("der without type", () => crypto.createPrivateKey({ key: der, format: "der" } as crypto.PrivateKeyInput));
attempt("hmac private key", () => crypto.createHmac("sha256", rsa));
attempt("hmac public key", () => crypto.createHmac("sha256", ecPublic));
// Last: OpenSSL keeps an error queued after comparing keys of different
// types, which a later call in Node can report.
attempt("equals other type", () => rsa.equals(ec));
