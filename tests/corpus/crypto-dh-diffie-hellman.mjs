// crypto.diffieHellman over DH KeyObjects: a shared secret at the modulus
// width from KeyObjects and from PEM inputs, both sides agreeing, the
// callback form, and Node's errors for mismatched domain parameters, mixed
// key types and a public key in the private slot.
import * as crypto from "node:crypto";

const failure = (error) => `${error.name}: ${error.message}`;
const a = crypto.generateKeyPairSync("dh", { group: "modp5" });
const b = crypto.generateKeyPairSync("dh", { group: "modp5" });
const sharedA = crypto.diffieHellman({ privateKey: a.privateKey, publicKey: b.publicKey });
const sharedB = crypto.diffieHellman({ privateKey: b.privateKey, publicKey: a.publicKey });
console.log("shared", Buffer.isBuffer(sharedA), sharedA.length, sharedA.equals(sharedB));

const aPrivatePem = String(a.privateKey.export({ type: "pkcs8", format: "pem" }));
const aPublicPem = String(a.publicKey.export({ type: "spki", format: "pem" }));
const bPrivatePem = String(b.privateKey.export({ type: "pkcs8", format: "pem" }));
const bPublicPem = String(b.publicKey.export({ type: "spki", format: "pem" }));
const pemA = crypto.diffieHellman({ privateKey: aPrivatePem, publicKey: bPublicPem });
const pemB = crypto.diffieHellman({ privateKey: bPrivatePem, publicKey: aPublicPem });
console.log("pem", pemA.length, pemA.equals(pemB), pemA.equals(sharedA));

const big = crypto.generateKeyPairSync("dh", { group: "modp14" });
const ec = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
const attempt = (label, run) => {
  try {
    run();
    console.log(label, "resolved");
  } catch (error) {
    console.log(label, failure(error));
  }
};
attempt("mismatched groups", () => crypto.diffieHellman({ privateKey: a.privateKey, publicKey: big.publicKey }));
attempt("dh private ec public", () => crypto.diffieHellman({ privateKey: a.privateKey, publicKey: ec.publicKey }));
attempt("ec private dh public", () => crypto.diffieHellman({ privateKey: ec.privateKey, publicKey: a.publicKey }));
attempt("public as private", () => crypto.diffieHellman({ privateKey: a.publicKey, publicKey: b.publicKey }));

const [error, shared] = await new Promise((resolve) => {
  crypto.diffieHellman({ privateKey: a.privateKey, publicKey: b.publicKey }, (failure, secret) =>
    resolve([failure, secret]),
  );
});
console.log("callback", error, Buffer.isBuffer(shared), shared.length, shared.equals(sharedA));
