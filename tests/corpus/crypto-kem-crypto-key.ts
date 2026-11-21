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

/* A secret CryptoKey (AES/HMAC) has no KEM usage: the key adapter must
 * report Node's invalid-key error instead of reading its bytes through a
 * missing output slot. */
const secret = (await crypto.subtle.generateKey({ name: "AES-GCM", length: 128 }, true, [
  "encrypt",
])) as CryptoKey;
try {
  encapsulate(secret as unknown as KeyObject);
  console.log("secret encapsulate ok");
} catch (e) {
  const x = e as Error & { code?: string };
  console.log("secret encapsulate", x.name, x.code, JSON.stringify(x.message));
}
try {
  decapsulate(secret as unknown as KeyObject, Buffer.from([1, 2]));
  console.log("secret decapsulate ok");
} catch (e) {
  const x = e as Error & { code?: string };
  console.log("secret decapsulate", x.name, x.code, JSON.stringify(x.message));
}

const publicObject = KeyObject.from(pair.publicKey);
const privateObject = KeyObject.from(pair.privateKey);
console.log("from", publicObject.asymmetricKeyType, privateObject.asymmetricKeyType);
console.log("key object", decapsulate(privateObject, enc.ciphertext).equals(enc.sharedKey));
