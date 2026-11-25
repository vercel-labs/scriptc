// KeyObject.from: a CryptoKey's key material as a node:crypto KeyObject.
// Secret keys keep their bytes and size; asymmetric CryptoKeys give the
// matching public or private KeyObject, whose export and signing agree with
// the CryptoKey they came from. Node's error for a value that is not a
// CryptoKey is preserved.
import { KeyObject, sign as signBytes, verify as verifyBytes } from "node:crypto";
import type { webcrypto } from "node:crypto";

const secretKey = await crypto.subtle.importKey("raw", Buffer.alloc(16, 3), { name: "AES-GCM" }, true, ["encrypt"]);
const secretObject = KeyObject.from(secretKey);
const secretBytes = secretObject.export();
console.log("secret", secretObject.type, secretObject.symmetricKeySize, Buffer.isBuffer(secretBytes), Buffer.from(secretBytes as Buffer).toString("hex"));

const ecPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const ecPublic = KeyObject.from(ecPair.publicKey);
const ecPrivate = KeyObject.from(ecPair.privateKey);
console.log("ecdsa", ecPublic.type, ecPrivate.type, ecPublic.asymmetricKeyType, JSON.stringify(ecPrivate.asymmetricKeyDetails));
console.log("ecdsa export", ecPublic.export({ format: "pem", type: "spki" }).toString().split("\n")[0]);
const nodeSignature = signBytes("sha256", Buffer.from("signed"), ecPrivate);
console.log("ecdsa node verify", verifyBytes("sha256", Buffer.from("signed"), ecPublic, nodeSignature));


const edPair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
const edPrivate = KeyObject.from(edPair.privateKey);
console.log("ed25519", edPrivate.type, edPrivate.asymmetricKeyType, edPrivate.export({ format: "jwk" }).crv);
console.log("ed25519 verify", await crypto.subtle.verify("Ed25519", KeyObject.from(edPair.publicKey).toCryptoKey("Ed25519", true, ["verify"]), signBytes(null as unknown as string, Buffer.from("signed"), edPrivate), Buffer.from("signed")));

const rsaPair = await crypto.subtle.generateKey(
  { name: "RSA-PSS", modulusLength: 1024, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
  true,
  ["sign", "verify"],
);
const rsaPrivate = KeyObject.from(rsaPair.privateKey);
const rsaPublic = KeyObject.from(rsaPair.publicKey);
console.log("rsa", rsaPrivate.asymmetricKeyType, rsaPublic.asymmetricKeyType, (rsaPrivate.asymmetricKeyDetails as { modulusLength: number }).modulusLength);
console.log("rsa verify", verifyBytes("sha256", Buffer.from("signed"), rsaPublic, signBytes("sha256", Buffer.from("signed"), rsaPrivate)));

const ecdhPair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
console.log("ecdh", KeyObject.from(ecdhPair.privateKey).asymmetricKeyType, KeyObject.from(ecdhPair.publicKey).type);
const xPair = await crypto.subtle.generateKey({ name: "X25519" }, true, ["deriveBits"]);
console.log("x25519", KeyObject.from(xPair.privateKey).asymmetricKeyType, KeyObject.from(xPair.publicKey).type);

// toCryptoKey and from round-trip through a KeyObject.
const back = KeyObject.from(ecPrivate.toCryptoKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]));
console.log("round trip", back.type, back.asymmetricKeyType, back.equals(ecPrivate));

for (const [label, run] of [
  ["not a key", () => KeyObject.from({} as unknown as webcrypto.CryptoKey)],
] as const) {
  let result: string;
  try {
    run();
    result = "resolved";
  } catch (error) {
    result = `${(error as Error).name} ${(error as Error).message}`;
  }
  console.log(label, result);
}
