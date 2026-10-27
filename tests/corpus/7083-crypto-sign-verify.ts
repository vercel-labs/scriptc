// crypto.sign and crypto.verify, and the Sign and Verify objects: RSA
// PKCS#1 v1.5 signatures (deterministic, so they compare with Node), RSA-PSS,
// ECDSA in DER and IEEE P1363 encodings, keys given as KeyObjects, PEM and
// option objects, output and signature encodings, and Node's errors.
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

function attempt(label: string, run: () => unknown): void {
  try {
    console.log(label, run());
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    console.log(label, "throws", err.name, err.code, err.message);
  }
}

const rsa = crypto.createPrivateKey(RSA);
const rsaPublic = crypto.createPublicKey(rsa);
const ec = crypto.createPrivateKey(EC);
const ecPublic = crypto.createPublicKey(ec);
const data = Buffer.from("signed message");

for (const digest of ["sha1", "sha224", "sha256", "SHA384", "RSA-SHA512", "sha256WithRSAEncryption"]) {
  const signature = crypto.sign(digest, data, rsa);
  console.log(digest, signature.toString("base64"), crypto.verify(digest, data, rsaPublic, signature));
}
attempt("null digest", () => crypto.sign(null, data, RSA).equals(crypto.sign("sha256", data, rsa)));
attempt("private key verifies", () => crypto.verify("sha256", data, RSA, crypto.sign("sha256", data, rsa)));
attempt("wrong data", () => crypto.verify("sha256", Buffer.from("other"), rsaPublic, crypto.sign("sha256", data, rsa)));

const pss = crypto.sign("sha256", data, { key: rsa, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 });
attempt("pss", () => [pss.length, crypto.verify("sha256", data, { key: rsaPublic, padding: crypto.constants.RSA_PKCS1_PSS_PADDING }, pss)].join());
attempt("pss as pkcs1", () => crypto.verify("sha256", data, rsaPublic, pss));
attempt("pss digest salt", () =>
  crypto.verify("sha256", data, { key: rsaPublic, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST }, pss),
);

const der = crypto.sign("sha256", data, ec);
attempt("ecdsa der", () => [der[0], crypto.verify("sha256", data, ecPublic, der)].join());
const p1363 = crypto.sign("sha384", data, { key: EC, dsaEncoding: "ieee-p1363" });
attempt("ecdsa p1363", () => [p1363.length, crypto.verify("sha384", data, { key: ecPublic, dsaEncoding: "ieee-p1363" }, p1363)].join());
attempt("p1363 as der", () => crypto.verify("sha384", data, ecPublic, p1363));
attempt("truncated", () => crypto.verify("sha256", data, ecPublic, der.subarray(0, 10)));

const signer = crypto.createSign("SHA256");
signer.update("signed ");
signer.update(Buffer.from("message"));
const hex = signer.sign(rsa, "hex");
attempt("sign object", () => hex === crypto.sign("sha256", data, rsa).toString("hex"));
attempt("sign again", () => signer.sign(rsa));
attempt("update after sign", () => signer.update("more"));
const verifier = crypto.createVerify("RSA-SHA256");
verifier.update("signed message", "utf8");
attempt("verify object", () => verifier.verify(RSA, Buffer.from(hex, "hex").toString("base64"), "base64"));
attempt("verify again", () => verifier.verify(rsaPublic, hex, "hex"));
const ecSigner = crypto.createSign("sha512").update("chained");
const ecSignature = ecSigner.sign({ key: ec, dsaEncoding: "ieee-p1363" });
attempt("chained", () => crypto.createVerify("sha512").update("chained").verify({ key: ecPublic, dsaEncoding: "ieee-p1363" }, ecSignature));

attempt("invalid digest", () => crypto.sign("nope", data, rsa));
const longDigest = "unknown-digest-".repeat(40);
attempt("long digest", () => crypto.sign(longDigest, data, rsa));
attempt("long verify digest", () => crypto.verify(longDigest, data, rsaPublic, Buffer.alloc(64)));
attempt("public key signs", () => crypto.sign("sha256", data, rsaPublic));
attempt("invalid createSign", () => crypto.createSign("nope"));
attempt("invalid dsaEncoding", () => crypto.sign("sha256", data, { key: ec, dsaEncoding: "x" as "der" }));
