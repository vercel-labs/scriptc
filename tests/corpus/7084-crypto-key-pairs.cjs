// generateKeyPairSync and generateKeyPair for RSA and EC keys: KeyObject
// results, PEM and DER encodings, curve names and NIST aliases, the
// callback's later macrotask, and Node's errors for invalid types and
// options.
const crypto = require("node:crypto");

function attempt(label, run) {
  try {
    console.log(label, run());
  } catch (e) {
    console.log(label, "throws", e.name, e.code, e.message);
  }
}

const data = Buffer.from("key pair");
for (const curve of ["prime256v1", "P-256", "secp384r1", "P-384", "secp521r1", "P-521", "secp256k1"]) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: curve });
  const signature = crypto.sign("sha256", data, privateKey);
  console.log(curve, privateKey.type, publicKey.type, privateKey.asymmetricKeyDetails, crypto.verify("sha256", data, publicKey, signature));
}
const rsa = crypto.generateKeyPairSync("rsa", { modulusLength: 1024 });
console.log("rsa", rsa.privateKey.asymmetricKeyDetails, Object.keys(rsa));
const exponent = crypto.generateKeyPairSync("rsa", { modulusLength: 1024, publicExponent: 3 });
console.log("exponent", exponent.publicKey.asymmetricKeyDetails);
const encoded = crypto.generateKeyPairSync("ec", {
  namedCurve: "P-256",
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "sec1", format: "der" },
});
console.log("encoded", typeof encoded.publicKey, encoded.publicKey.split("\n")[0], Buffer.isBuffer(encoded.privateKey));
const reparsed = crypto.createPrivateKey({ key: encoded.privateKey, format: "der", type: "sec1" });
console.log("reparsed", crypto.createPublicKey(reparsed).export({ type: "spki", format: "pem" }) === encoded.publicKey);
const rsaPem = crypto.generateKeyPairSync("rsa", {
  modulusLength: 1024,
  publicKeyEncoding: { type: "pkcs1", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
console.log("rsa pem", rsaPem.publicKey.split("\n")[0], rsaPem.privateKey.split("\n")[0]);
const jwk = crypto.generateKeyPairSync("ec", { namedCurve: "secp256k1", publicKeyEncoding: { format: "jwk" } });
console.log("jwk", Object.keys(jwk.publicKey), jwk.publicKey.crv);

attempt("no options", () => crypto.generateKeyPairSync("rsa"));
attempt("no modulusLength", () => crypto.generateKeyPairSync("rsa", {}));
attempt("string modulusLength", () => crypto.generateKeyPairSync("rsa", { modulusLength: "2048" }));
attempt("negative modulusLength", () => crypto.generateKeyPairSync("rsa", { modulusLength: -1 }));
attempt("unknown type", () => crypto.generateKeyPairSync("foo", {}));
attempt("number type", () => crypto.generateKeyPairSync(5, {}));
attempt("no curve", () => crypto.generateKeyPairSync("ec", {}));
attempt("unknown curve", () => crypto.generateKeyPairSync("ec", { namedCurve: "nope" }));
attempt("bad encoding format", () => crypto.generateKeyPairSync("ec", { namedCurve: "P-256", publicKeyEncoding: { type: "spki", format: "xml" } }));
attempt("bad encoding type", () => crypto.generateKeyPairSync("ec", { namedCurve: "P-256", privateKeyEncoding: { type: "spki", format: "pem" } }));
attempt("encoding not object", () => crypto.generateKeyPairSync("ec", { namedCurve: "P-256", publicKeyEncoding: "pem" }));
// Error messages hold the whole text at any length, and received values
// render as Node's validators print them.
attempt("long type", () => crypto.generateKeyPairSync("unknown-type-".repeat(20), {}));
attempt("long encoding type", () => crypto.generateKeyPairSync("ec", { namedCurve: "P-256", publicKeyEncoding: { type: "z".repeat(300), format: "pem" } }));
attempt("quoted encoding type", () => crypto.generateKeyPairSync("ec", { namedCurve: "P-256", publicKeyEncoding: { type: "it's\n", format: "pem" } }));
attempt("huge modulusLength", () => crypto.generateKeyPairSync("rsa", { modulusLength: 2 ** 40 }));
attempt("fractional modulusLength", () => crypto.generateKeyPairSync("rsa", { modulusLength: 1.5 }));
attempt("NaN modulusLength", () => crypto.generateKeyPairSync("rsa", { modulusLength: NaN }));
const key = rsa.privateKey;
attempt("long method", () => key.aMethodNameLongEnoughThatTheWholeMessageRunsPastOneHundredAndSixtyBytesOnceTheReceiverTextAndTheSuffixAreIncluded());
attempt("getter", () => {
  "use strict";
  key.asymmetricKeyType = "ec";
});

let returned = false;
crypto.generateKeyPair("ec", { namedCurve: "P-384" }, (err, publicKey, privateKey) => {
  console.log("callback", returned, err, publicKey.type, privateKey.asymmetricKeyDetails);
  crypto.generateKeyPair("rsa", { modulusLength: 1024 }, (err2, publicKey2) => {
    console.log("rsa callback", err2, publicKey2.asymmetricKeyDetails.modulusLength);
  });
});
process.nextTick(() => console.log("tick"));
attempt("callback errors throw", () => crypto.generateKeyPair("ec", {}, () => console.log("never")));
returned = true;
console.log("returned");
