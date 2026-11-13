// crypto.sign's options accept only numbers: padding, saltLength and
// dsaEncoding read through V8's int32 conversion, and context as a buffer
// view. Values a typed program cannot pass (null, bigints, objects) reach
// them from an untyped program, and each one throws Node's error with the
// value rendered as util.inspect renders it.
import crypto from "node:crypto";

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

function attempt(label, run) {
  try {
    console.log(label, run());
  } catch (e) {
    console.log(label, "throws", e.name, e.code, e.message);
  }
}

const rsa = crypto.createPrivateKey(RSA);
const ec = crypto.createPrivateKey(
  crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ format: "pem", type: "pkcs8" }),
);
const data = Buffer.from("option types");

for (const [name, value] of [
  ["string", "1"],
  ["bigint", 1n],
  ["null", null],
  ["true", true],
  ["nan", NaN],
  ["infinity", Infinity],
]) {
  attempt(`padding ${name}`, () => crypto.sign("sha256", data, { key: rsa, padding: value }).length);
}
for (const [name, value] of [
  ["null", null],
  ["number", 5],
  ["true", true],
]) {
  attempt(`dsaEncoding ${name}`, () => crypto.sign("sha256", data, { key: ec, dsaEncoding: value }).length);
}
for (const [name, value] of [
  ["string", "ctx"],
  ["number", 5],
  ["object", {}],
]) {
  attempt(`context ${name}`, () => crypto.sign("sha256", data, { key: rsa, context: value }).length);
}
attempt("saltLength string", () => crypto.sign("sha256", data, { key: rsa, padding: 6, saltLength: "32" }).length);

// The key member of an options object, and its absence.
attempt("key object member", () => crypto.sign("sha256", data, { key: {} }));
attempt("key missing", () => crypto.sign("sha256", data, { padding: 1 }));
