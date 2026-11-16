// crypto.subtle ChaCha20-Poly1305 over a generated key: round trips with a 12-byte nonce and associated data, the name-only algorithm, the C20P JWK form and its import, refused raw formats, nonce/tag errors, tamper rejection and a derived key; each use warns once per process.
// @normalize-pid
import type { webcrypto } from "node:crypto";

const key = await crypto.subtle.generateKey({ name: "ChaCha20-Poly1305" }, true, ["encrypt", "decrypt"]);
console.log("key", key.algorithm.name, JSON.stringify(Object.keys(key.algorithm)), key.usages.join(","), key.extractable);

const iv = new Uint8Array(12);
const sealed = await crypto.subtle.encrypt(
  { name: "ChaCha20-Poly1305", iv, additionalData: Buffer.from("aad") },
  key,
  Buffer.from("hello world"),
);
const opened = await crypto.subtle.decrypt(
  { name: "ChaCha20-Poly1305", iv, additionalData: Buffer.from("aad") },
  key,
  sealed,
);
console.log("round trip", sealed.byteLength, Buffer.from(opened).toString());

const rawSecret = await crypto.subtle.exportKey("raw-secret", key);
const reimported = await crypto.subtle.importKey("raw-secret", rawSecret, { name: "ChaCha20-Poly1305" }, true, ["encrypt", "decrypt"]);
const reSealedRaw = await crypto.subtle.encrypt({ name: "ChaCha20-Poly1305", iv }, reimported, Buffer.from("hello world"));
console.log("raw-secret", rawSecret.byteLength, Buffer.from(await crypto.subtle.decrypt({ name: "ChaCha20-Poly1305", iv }, key, reSealedRaw)).toString());

const jwk = await crypto.subtle.exportKey("jwk", key);
console.log("jwk", jwk.kty, jwk.alg, jwk.ext);
const imported = await crypto.subtle.importKey("jwk", jwk, { name: "ChaCha20-Poly1305" }, true, ["encrypt"]);
console.log("jwk import", imported.algorithm.name, imported.usages.join(","));
const reSealed = await crypto.subtle.encrypt({ name: "ChaCha20-Poly1305", iv }, imported, Buffer.from("hello"));
console.log("jwk round trip", Buffer.from(await crypto.subtle.decrypt({ name: "ChaCha20-Poly1305", iv }, key, reSealed)).toString());

for (const [label, run] of [
  ["tag 96", () => crypto.subtle.encrypt({ name: "ChaCha20-Poly1305", iv, tagLength: 96 }, key, Buffer.from("x"))],
  ["iv 8", () => crypto.subtle.encrypt({ name: "ChaCha20-Poly1305", iv: new Uint8Array(8) }, key, Buffer.from("x"))],
  ["iv 16", () => crypto.subtle.encrypt({ name: "ChaCha20-Poly1305", iv: new Uint8Array(16) }, key, Buffer.from("x"))],
  ["raw import", () => crypto.subtle.importKey("raw", new Uint8Array(32), { name: "ChaCha20-Poly1305" }, true, ["encrypt"])],
  ["raw export", () => crypto.subtle.exportKey("raw", key)],
] as const) {
  const result = await run().then(() => "resolved", (error: Error) => `${error.name} ${error.message}`);
  console.log(label, result);
}

const tampered = new Uint8Array(sealed);
tampered[0] = (tampered[0] ?? 0) ^ 1;
const rejected = await crypto.subtle
  .decrypt({ name: "ChaCha20-Poly1305", iv, additionalData: Buffer.from("aad") }, key, tampered)
  .then(() => "resolved", (error: Error) => `${error.name} ${error.message}`);
console.log("tampered", rejected);

const hkdf = await crypto.subtle.importKey("raw", new Uint8Array(16), "HKDF", false, ["deriveKey"]);
const derived = await crypto.subtle.deriveKey(
  { name: "HKDF", hash: "SHA-384", salt: new Uint8Array(0), info: new Uint8Array(0) },
  hkdf,
  { name: "ChaCha20-Poly1305" },
  true,
  ["encrypt"],
);
console.log("derived", derived.algorithm.name, JSON.stringify(Object.keys(derived.algorithm)));
console.log("derived round trip", (await crypto.subtle.encrypt({ name: "ChaCha20-Poly1305", iv }, derived, Buffer.from("secret"))).byteLength);
