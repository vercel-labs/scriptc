import { type KeyObject, createPublicKey, diffieHellman, generateKeyPair, generateKeyPairSync } from "node:crypto";

const alice = generateKeyPairSync("x25519");
const bob = generateKeyPairSync("x25519");
const secret: Buffer = diffieHellman({ privateKey: alice.privateKey, publicKey: bob.publicKey });
console.log(alice.publicKey.asymmetricKeyType, secret.length, secret.equals(diffieHellman({ privateKey: bob.privateKey, publicKey: alice.publicKey })));
const exported = alice.publicKey.export({ type: "spki", format: "pem" });
const pem = typeof exported === "string" ? exported : exported.toString();
const reread: KeyObject = createPublicKey(pem);
console.log(reread.equals(alice.publicKey), pem.split("\n")[0]);
const ec = generateKeyPairSync("ec", { namedCurve: "P-384" });
const peer = generateKeyPairSync("ec", { namedCurve: "P-384" });
console.log("ecdh", diffieHellman({ privateKey: ec.privateKey, publicKey: peer.publicKey }).length);
generateKeyPair("x25519", undefined, (err, publicKey, privateKey) => {
  console.log("generated", err, publicKey.type, privateKey.asymmetricKeyType);
  diffieHellman({ privateKey, publicKey: bob.publicKey }, (error, shared) => {
    console.log("callback", error, shared.length);
  });
});
