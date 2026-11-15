// crypto.sign and crypto.verify read their options from the key argument
// before the key is decoded: padding, saltLength, dsaEncoding and context,
// with Node's type errors and its default padding. RSA PKCS#1 v1.5
// signatures are deterministic, so their bytes compare with Node's; the
// randomized PSS and ECDSA signatures are checked through verification.
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
const data = Buffer.from("signed data");

// The default padding and an explicit PKCS#1 v1.5 padding sign the same
// bytes; a negative padding is ignored, as OpenSSL's uint32 read is.
const pkcs1 = crypto.sign("sha256", data, { key: rsa, padding: crypto.constants.RSA_PKCS1_PADDING });
attempt("explicit pkcs1", () => pkcs1.toString("hex"));
attempt("padding default", () => pkcs1.equals(crypto.sign("sha256", data, rsa)));
attempt("padding zero", () => crypto.sign("sha256", data, { key: rsa, padding: 0 }).equals(pkcs1));
attempt("padding negative", () => crypto.sign("sha256", data, { key: rsa, padding: -1 }).length);
attempt("padding fraction", () => crypto.sign("sha256", data, { key: rsa, padding: 1.5 }));

// The key itself: a KeyObject, a PEM string, or anything falsy, which
// Node rejects before reading options.
attempt("keyobject", () => crypto.sign("sha256", data, rsa).equals(pkcs1));
attempt("pem", () => crypto.sign("sha256", data, RSA).equals(pkcs1));
attempt("null key", () => crypto.sign("sha256", data, null as unknown as string));
attempt("undefined key", () => crypto.sign("sha256", data, undefined as unknown as string));
attempt("empty key", () => crypto.sign("sha256", data, ""));
attempt("zero key", () => crypto.sign("sha256", data, 0 as unknown as string));

// context: Node takes a Buffer, and rejects only a non-empty one.
attempt("context unsupported", () => crypto.sign("sha256", data, { key: rsa, context: Buffer.from("ctx") }));
attempt("context empty", () => crypto.verify("sha256", data, { key: rsaPublic, context: Buffer.alloc(0) }, pkcs1));
// dsaEncoding: the ECDSA signature encoding, ignored by RSA keys.
attempt("dsa invalid", () => crypto.sign("sha256", data, { key: ec, dsaEncoding: "x" as "der" }));
attempt("dsa on rsa", () => crypto.sign("sha256", data, { key: rsa, dsaEncoding: "ieee-p1363" }).equals(pkcs1));
const p1363 = crypto.sign("sha256", data, { key: ec, dsaEncoding: "ieee-p1363" });
attempt("p1363", () =>
  [p1363.length, crypto.verify("sha256", data, { key: ecPublic, dsaEncoding: "ieee-p1363" }, p1363)].join(),
);
attempt("der default", () => crypto.verify("sha256", data, ecPublic, crypto.sign("sha256", data, ec)));

// createSign and createVerify read their options and ignore them.
const optioned = crypto.createSign("sha256", { outputLength: 16 } as unknown as import("stream").WritableOptions);
attempt("createSign options", () => optioned.update("signed data").sign(rsa).equals(pkcs1));
attempt("createSign no algorithm", () => crypto.createSign(undefined as unknown as string));
attempt("createSign null", () => crypto.createSign(null as unknown as string));
attempt("createSign number", () => crypto.createSign(5 as unknown as string));
const verifier = crypto.createVerify("sha256", { outputLength: 16 } as unknown as import("stream").WritableOptions);
attempt("createVerify options", () => verifier.update("signed data").verify(rsaPublic, pkcs1));
attempt("createVerify no algorithm", () => crypto.createVerify(undefined as unknown as string));
