// SubtleCrypto methods read as values: Node answers the method function for
// every spelling (a computed `subtle[name]` and a static member read), and a
// detached call is refused here — the method is called on the SubtleCrypto
// object — so the corpus compares the values' name and length and a direct
// call's result.
const { subtle } = globalThis.crypto;
const names = [
  "digest",
  "importKey",
  "generateKey",
  "exportKey",
  "encrypt",
  "decrypt",
  "sign",
  "verify",
  "deriveBits",
  "deriveKey",
  "wrapKey",
  "unwrapKey",
  "getPublicKey",
  "encapsulateBits",
  "encapsulateKey",
  "decapsulateBits",
  "decapsulateKey",
];
for (const name of names) {
  const value = subtle[name];
  console.log("value", name, typeof value, value.name, value.length);
}
const staticDigest = subtle.digest;
console.log("static", typeof staticDigest, staticDigest.name, staticDigest.length);
const digest = await subtle.digest("SHA-256", new TextEncoder().encode("abc"));
console.log("digest", new Uint8Array(digest).length);
