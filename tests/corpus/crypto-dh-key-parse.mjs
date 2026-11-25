// crypto.createPrivateKey/createPublicKey over DH keys: the PKCS#8 private
// key and SubjectPublicKeyInfo public key this runtime exports, in PEM and
// DER, the public half derived from a private key, an encrypted PKCS#8
// private key, and Node's decoder errors for the wrong half and encoding.
import * as crypto from "node:crypto";

const failure = (error) => `${error.name}: ${error.message}`;
const pair = crypto.generateKeyPairSync("dh", { group: "modp5" });
const privatePem = String(pair.privateKey.export({ type: "pkcs8", format: "pem" }));
const publicPem = String(pair.publicKey.export({ type: "spki", format: "pem" }));
const privateDer = pair.privateKey.export({ type: "pkcs8", format: "der" });
const publicDer = pair.publicKey.export({ type: "spki", format: "der" });

const parsedPrivate = crypto.createPrivateKey(privatePem);
const parsedPublic = crypto.createPublicKey(publicPem);
console.log(
  "types",
  parsedPrivate.type,
  parsedPrivate.asymmetricKeyType,
  parsedPublic.type,
  parsedPublic.asymmetricKeyType,
);
console.log(
  "details",
  JSON.stringify(parsedPrivate.asymmetricKeyDetails),
  JSON.stringify(parsedPublic.asymmetricKeyDetails),
);
console.log("equals", parsedPrivate.equals(pair.privateKey), parsedPublic.equals(pair.publicKey), parsedPrivate.equals(parsedPublic));

const derPrivate = crypto.createPrivateKey({ key: privateDer, format: "der", type: "pkcs8" });
const derPublic = crypto.createPublicKey({ key: publicDer, format: "der", type: "spki" });
console.log("der", derPrivate.asymmetricKeyType, derPublic.asymmetricKeyType, derPrivate.equals(parsedPrivate));
console.log(
  "pkcs1 option",
  crypto.createPrivateKey({ key: privateDer, format: "der", type: "pkcs1" }).asymmetricKeyType,
);

const derived = crypto.createPublicKey(privatePem);
console.log("derived", derived.type, derived.asymmetricKeyType, derived.equals(pair.publicKey));

const encrypted = String(
  pair.privateKey.export({ type: "pkcs8", format: "pem", cipher: "aes-256-cbc", passphrase: "secret" }),
);
const decrypted = crypto.createPrivateKey({ key: encrypted, passphrase: "secret" });
console.log("encrypted", decrypted.asymmetricKeyType, decrypted.equals(pair.privateKey));

const attempt = (label, run) => {
  try {
    run();
    console.log(label, "resolved");
  } catch (error) {
    console.log(label, failure(error));
  }
};
attempt("private from public", () => crypto.createPrivateKey(publicPem));
attempt("pem from der", () => crypto.createPrivateKey({ key: privateDer, format: "pem" }));
attempt("wrong passphrase", () => crypto.createPrivateKey({ key: encrypted, passphrase: "nope" }));
