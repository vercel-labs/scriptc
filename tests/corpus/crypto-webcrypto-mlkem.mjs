// @normalize-pid
// The experimental ML-KEM WebCrypto surface: key generation, bits and key
// encapsulation and decapsulation, the context parameter, spki and jwk
// export and import, and the bad-ciphertext and bad-algorithm errors.
import * as crypto from "node:crypto";

const s = crypto.subtle;
const pair = await s.generateKey({ name: "ML-KEM-768" }, true, ["encapsulateBits", "decapsulateBits"]);
console.log("types", pair.publicKey.type, pair.privateKey.type, pair.publicKey.algorithm.name);
const keyPair = await s.generateKey({ name: "ML-KEM-768" }, true, ["encapsulateKey", "decapsulateKey"]);
const enc = await s.encapsulateBits({ name: "ML-KEM-768" }, pair.publicKey);
console.log("enc", Object.keys(enc).sort().join(","), enc.ciphertext.byteLength, enc.sharedKey.byteLength);
const dec = await s.decapsulateBits({ name: "ML-KEM-768" }, pair.privateKey, enc.ciphertext);
console.log("dec", Buffer.from(dec).equals(Buffer.from(enc.sharedKey)));
const ctx = new Uint8Array([1, 2, 3]);
const encCtx = await s.encapsulateBits({ name: "ML-KEM-768", context: ctx }, pair.publicKey);
const decCtx = await s.decapsulateBits({ name: "ML-KEM-768", context: ctx }, pair.privateKey, encCtx.ciphertext);
const decNoCtx = await s.decapsulateBits({ name: "ML-KEM-768" }, pair.privateKey, encCtx.ciphertext);
console.log("ctx", Buffer.from(decCtx).equals(Buffer.from(encCtx.sharedKey)), Buffer.from(decNoCtx).equals(Buffer.from(encCtx.sharedKey)));
console.log(
  "export",
  (await s.exportKey("spki", pair.publicKey)).byteLength,
  Object.keys(await s.exportKey("jwk", pair.privateKey)).sort().join(","),
);
const imported = await s.importKey(
  "spki",
  await s.exportKey("spki", pair.publicKey),
  { name: "ML-KEM-768" },
  true,
  ["encapsulateBits"],
);
console.log("import", imported.type, imported.algorithm.name);
const ek = await s.encapsulateKey({ name: "ML-KEM-768" }, keyPair.publicKey, { name: "AES-GCM", length: 128 }, true, [
  "encrypt",
]);
console.log("enckey", Object.keys(ek).sort().join(","), ek.sharedKey.type, ek.sharedKey.algorithm.name,
  ek.sharedKey.algorithm.length);
const dk = await s.decapsulateKey(
  { name: "ML-KEM-768" },
  keyPair.privateKey,
  ek.ciphertext,
  { name: "AES-GCM", length: 128 },
  true,
  ["encrypt"],
);
console.log("deckey", dk.type, dk.algorithm.name, dk.algorithm.length);
try {
  await s.decapsulateBits({ name: "ML-KEM-768" }, pair.privateKey, new Uint8Array(3));
} catch (e) {
  console.log("badct", e.name, e.constructor.name, String(e.message).slice(0, 60));
}
try {
  await s.encapsulateBits({ name: "nope" }, pair.publicKey);
} catch (e) {
  console.log("badalg", e.name, e.constructor.name, String(e.message).slice(0, 60));
}
