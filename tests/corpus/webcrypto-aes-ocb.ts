// crypto.subtle AES-OCB over a fixed JWK key: fixed ciphertexts at 128-, 96- and 64-bit tags and 1- to 15-byte nonces, JWK round trips with the A128OCB label, refused raw formats, nonce/tag errors, tamper rejection and a derived key; each use warns once per process.
// @normalize-pid
import type { webcrypto } from "node:crypto";

const hex = (bytes: ArrayBuffer): string => Buffer.from(bytes).toString("hex");
const keyJwk: JsonWebKey = { kty: "oct", k: Buffer.alloc(16, 0x11).toString("base64url"), alg: "A128OCB" };
const key = await crypto.subtle.importKey("jwk", keyJwk, { name: "AES-OCB" }, true, ["encrypt", "decrypt"]);
const algorithm = key.algorithm as webcrypto.AesKeyAlgorithm;
console.log("key", algorithm.name, algorithm.length, key.usages.join(","));

for (const tagLength of [128, 96, 64]) {
  const iv = new Uint8Array(12);
  const sealed = await crypto.subtle.encrypt(
    { name: "AES-OCB", iv, tagLength, additionalData: Buffer.from("aad") },
    key,
    Buffer.from("hello world"),
  );
  const opened = await crypto.subtle.decrypt(
    { name: "AES-OCB", iv, tagLength, additionalData: Buffer.from("aad") },
    key,
    sealed,
  );
  console.log("ocb", tagLength, sealed.byteLength, hex(sealed), Buffer.from(opened).toString());
}
for (const length of [1, 7, 15]) {
  console.log("ocb iv", length, hex(await crypto.subtle.encrypt({ name: "AES-OCB", iv: new Uint8Array(length) }, key, Buffer.from("x"))));
}

// A message with whole blocks and nonces whose low six bits are not zero
// exercise the inverse cipher's key schedule and the nonce stretch.
for (const last of [1, 42, 255]) {
  const iv = new Uint8Array(12);
  iv[11] = last;
  console.log("ocb nonce", last, hex(await crypto.subtle.encrypt({ name: "AES-OCB", iv }, key, Buffer.from("0123456789abcdef0123"))));
}
const rawSecret = await crypto.subtle.exportKey("raw-secret", key);
const reimported = await crypto.subtle.importKey("raw-secret", rawSecret, { name: "AES-OCB" }, true, ["encrypt", "decrypt"]);
const reSealed = await crypto.subtle.encrypt({ name: "AES-OCB", iv: new Uint8Array(12) }, reimported, Buffer.from("0123456789abcdef0123"));
console.log("raw-secret", rawSecret.byteLength, Buffer.from(await crypto.subtle.decrypt({ name: "AES-OCB", iv: new Uint8Array(12) }, key, reSealed)).toString());

const generated = await crypto.subtle.generateKey({ name: "AES-OCB", length: 256 }, true, ["encrypt"]);
const generatedJwk = await crypto.subtle.exportKey("jwk", generated);
console.log("generated", generated.algorithm.name, (generated.algorithm as webcrypto.AesKeyAlgorithm).length, generatedJwk.alg);
const importedJwk = await crypto.subtle.importKey("jwk", generatedJwk, { name: "AES-OCB" }, true, ["encrypt"]);
console.log("jwk round trip", importedJwk.algorithm.name, (importedJwk.algorithm as webcrypto.AesKeyAlgorithm).length);

for (const [label, run] of [
  ["iv 16", () => crypto.subtle.encrypt({ name: "AES-OCB", iv: new Uint8Array(16) }, key, Buffer.from("x"))],
  ["iv 0", () => crypto.subtle.encrypt({ name: "AES-OCB", iv: new Uint8Array(0) }, key, Buffer.from("x"))],
  ["tag 120", () => crypto.subtle.encrypt({ name: "AES-OCB", iv: new Uint8Array(12), tagLength: 120 }, key, Buffer.from("x"))],
  ["raw import", () => crypto.subtle.importKey("raw", new Uint8Array(16), { name: "AES-OCB" }, true, ["encrypt"])],
  ["raw export", () => crypto.subtle.exportKey("raw", key)],
] as const) {
  const result = await run().then(() => "resolved", (error: Error) => `${error.name} ${error.message}`);
  console.log(label, result);
}

const tampered = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-OCB", iv: new Uint8Array(12) }, key, Buffer.from("data")));
tampered[0] = (tampered[0] ?? 0) ^ 1;
const rejected = await crypto.subtle
  .decrypt({ name: "AES-OCB", iv: new Uint8Array(12) }, key, tampered)
  .then(() => "resolved", (error: Error) => `${error.name} ${error.message}`);
console.log("tampered", rejected);

const hkdf = await crypto.subtle.importKey("raw", new Uint8Array(16), "HKDF", false, ["deriveKey"]);
const derived = await crypto.subtle.deriveKey(
  { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: new Uint8Array(0) },
  hkdf,
  { name: "AES-OCB", length: 192 },
  true,
  ["encrypt"],
);
console.log("derived", derived.algorithm.name, (derived.algorithm as webcrypto.AesKeyAlgorithm).length);
