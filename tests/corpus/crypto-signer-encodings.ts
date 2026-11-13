// The encoding parameters of a Sign and a Verify: update() decodes string
// chunks with the named encoding before hashing, sign() encodes its
// signature as text, and Verify.verify decodes the signature string. RSA
// PKCS#1 v1.5 signatures are deterministic, so the encoded values compare
// with Node's.
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
const data = Buffer.from("signed data");
const expected = crypto.sign("sha256", data, rsa);

// update() decodes each string chunk with its encoding.
for (const encoding of ["utf8", "hex", "base64", "base64url", "latin1", "binary", "ascii", "utf16le", "ucs2"]) {
  const chunk = Buffer.from("signed data");
  const text = chunk.toString(encoding as BufferEncoding);
  const signer = crypto.createSign("sha256");
  signer.update(text, encoding as BufferEncoding);
  attempt(`update ${encoding}`, () => signer.sign(rsa).equals(expected));
}
attempt("update odd hex", () => crypto.createSign("sha256").update("abc", "hex"));
attempt("update upper hex", () => {
  const signer = crypto.createSign("sha256");
  signer.update(Buffer.from("signed data").toString("hex").toUpperCase(), "HEX" as BufferEncoding);
  return signer.sign(rsa).equals(expected);
});

// sign() encodes the signature with the requested textual encoding.
for (const encoding of ["hex", "base64", "base64url", "latin1"] as const) {
  const signer = crypto.createSign("sha256");
  signer.update("signed data");
  const text = signer.sign(rsa, encoding);
  attempt(`sign ${encoding}`, () => text === expected.toString(encoding as BufferEncoding));
}
attempt("sign unknown encoding", () => crypto.createSign("sha256").update("x").sign(rsa, "nope" as "hex"));

// verify() decodes the signature string with its encoding; the wrong
// encoding decodes other bytes and answers false.
for (const encoding of ["hex", "base64", "base64url", "latin1"] as const) {
  const text = expected.toString(encoding);
  const verifier = crypto.createVerify("sha256");
  verifier.update("signed data");
  attempt(`verify ${encoding}`, () => verifier.verify(rsaPublic, text, encoding));
}
attempt("verify hex as base64", () => {
  const verifier = crypto.createVerify("sha256");
  verifier.update("signed data");
  return verifier.verify(rsaPublic, expected.toString("hex"), "base64");
});
attempt("verify unknown encoding", () => {
  const verifier = crypto.createVerify("sha256");
  verifier.update("x");
  return verifier.verify(rsaPublic, "00", "nope" as "hex");
});
attempt("verify empty signature", () => {
  const verifier = crypto.createVerify("sha256");
  verifier.update("signed data");
  return verifier.verify(rsaPublic, "", "hex");
});
