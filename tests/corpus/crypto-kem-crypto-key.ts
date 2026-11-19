// @normalize-pid
// A WebCrypto CryptoKey handed to crypto.encapsulate/decapsulate: the key
// it wraps runs the KEM, reports the DEP0203 deprecation warning once, and
// KeyObject.from of the same keys agrees with it.
import { KeyObject, decapsulate, encapsulate } from "node:crypto";

const pair = (await crypto.subtle.generateKey({ name: "X25519" }, true, [
  "deriveBits",
  "deriveKey",
])) as CryptoKeyPair;

const publicKey = pair.publicKey as unknown as KeyObject;
const privateKey = pair.privateKey as unknown as KeyObject;

const enc = encapsulate(publicKey);
console.log("encapsulate", enc.ciphertext.length, enc.sharedKey.length);
const shared = decapsulate(privateKey, enc.ciphertext);
console.log("decapsulate", shared.equals(enc.sharedKey));

const publicObject = KeyObject.from(pair.publicKey);
const privateObject = KeyObject.from(pair.privateKey);
console.log("from", publicObject.asymmetricKeyType, privateObject.asymmetricKeyType);
console.log("key object", decapsulate(privateObject, enc.ciphertext).equals(enc.sharedKey));
