// crypto.subtle over X25519: importKey (jwk and raw), deriveBits at the
// full 256 bits and the shorter lengths Node truncates, deriveKey to an
// AES-GCM key, the shared secret from both sides, the CryptoKey shape
// generateKey reports, spki/pkcs8/raw/jwk exports, and the errors of a key
// from another algorithm, an ECDH peer, a private raw export and an
// unsupported usage. The keys are fixed, so every derived value is fixed.
import type { webcrypto } from "node:crypto";

const hex = (bytes: ArrayBuffer): string => Buffer.from(bytes).toString("hex");

const aliceJwk: JsonWebKey = {
  kty: "OKP",
  crv: "X25519",
  x: "MKqXLdZdFxLhjsU2Dp30SqhZQBbPdPDIi2iE_Zt_7w0",
  d: "-Ize_4HLUW6z0ix4iizHNDnHidD6fISAk-sOCtRzXEc",
};
const bobPublicJwk: JsonWebKey = {
  kty: "OKP",
  crv: "X25519",
  x: "8nBhtRSVitJeLTmjEjj8RVpxl71WRx7rYDVjUPL9FT8",
};

const alice = await crypto.subtle.importKey("jwk", aliceJwk, "X25519", true, ["deriveBits", "deriveKey"]);
const bobPublic = await crypto.subtle.importKey("jwk", bobPublicJwk, "X25519", true, []);

console.log("algorithm", alice.algorithm.name, alice.type, alice.extractable, alice.usages.join(","));
console.log("public", bobPublic.type, JSON.stringify(bobPublic.usages));

for (const bits of [256, 128, 100, 1]) {
  const secret = await crypto.subtle.deriveBits({ name: "X25519", public: bobPublic }, alice, bits);
  console.log("bits", bits, secret.byteLength, hex(secret));
}

const derived = await crypto.subtle.deriveKey(
  { name: "X25519", public: bobPublic },
  alice,
  { name: "AES-GCM", length: 256 },
  true,
  ["encrypt"],
);
const derivedAlgorithm = derived.algorithm as webcrypto.AesKeyAlgorithm;
console.log("derived", derivedAlgorithm.name, derivedAlgorithm.length, derived.usages.join(","));

const raw = await crypto.subtle.exportKey("raw", bobPublic);
console.log("raw export", raw.byteLength, hex(raw));
const importedRaw = await crypto.subtle.importKey("raw", raw, "X25519", true, []);
console.log("raw import", importedRaw.type, importedRaw.algorithm.name);
const spki = await crypto.subtle.exportKey("spki", bobPublic);
const pkcs8 = await crypto.subtle.exportKey("pkcs8", alice);
console.log("der", spki.byteLength, pkcs8.byteLength);
const spkiRound = await crypto.subtle.importKey("spki", spki, "X25519", true, []);
const pkcs8Round = await crypto.subtle.importKey("pkcs8", pkcs8, "X25519", true, ["deriveBits"]);
console.log("der import", spkiRound.type, pkcs8Round.type);
const exportedJwk = await crypto.subtle.exportKey("jwk", alice);
console.log("jwk export", Object.keys(exportedJwk).sort().join(","), exportedJwk.kty, exportedJwk.crv);

const generated = await crypto.subtle.generateKey({ name: "X25519" }, true, ["deriveBits", "deriveKey"]);
console.log("generated", generated.privateKey.algorithm.name, generated.privateKey.usages.join(","), JSON.stringify(generated.publicKey.usages));
const generatedSecret = await crypto.subtle.deriveBits(
  { name: "X25519", public: generated.publicKey },
  generated.privateKey,
  256,
);
console.log("generated secret", generatedSecret.byteLength);

const rawPrivate = await crypto.subtle
  .exportKey("raw", alice)
  .then(() => "resolved", (error: Error) => `${error.name} ${error.message}`);
console.log("private raw", rawPrivate);

const ecdhPeer = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
const wrongPeer = await crypto.subtle
  .deriveBits({ name: "X25519", public: ecdhPeer.publicKey }, alice, 256)
  .then(() => "resolved", (error: Error) => `${error.name} ${error.message}`);
console.log("wrong peer", wrongPeer);

const tooLong = await crypto.subtle
  .deriveBits({ name: "X25519", public: bobPublic }, alice, 264)
  .then(() => "resolved", (error: Error) => `${error.name} ${error.message}`);
console.log("too long", tooLong);

const badUsage = await crypto.subtle
  .generateKey({ name: "X25519" }, true, ["sign"])
  .then(() => "resolved", (error: Error) => `${error.name} ${error.message}`);
console.log("bad usage", badUsage);

const emptyUsages = await crypto.subtle
  .generateKey({ name: "X25519" }, true, [])
  .then(() => "resolved", (error: Error) => `${error.name} ${error.message}`);
console.log("empty usages", emptyUsages);

const useEnc = await crypto.subtle
  .importKey("jwk", { ...aliceJwk, use: "enc" }, "X25519", true, ["deriveBits"])
  .then((key) => key.type, (error: Error) => `${error.name} ${error.message}`);
console.log("jwk use enc", useEnc);
const useSig = await crypto.subtle
  .importKey("jwk", { ...aliceJwk, use: "sig" }, "X25519", true, ["deriveBits"])
  .then(() => "resolved", (error: Error) => `${error.name} ${error.message}`);
console.log("jwk use sig", useSig);
const keyOps = await crypto.subtle
  .importKey("jwk", { ...aliceJwk, key_ops: ["sign"] }, "X25519", true, ["deriveBits"])
  .then(() => "resolved", (error: Error) => `${error.name} ${error.message}`);
console.log("jwk key_ops", keyOps);

// Node reads no "alg" member of an X25519 JWK: every value imports.
for (const alg of ["X25519", "ECDH-ES", "ECDH-ES+A128KW", "nope"]) {
  const imported = await crypto.subtle.importKey("jwk", { ...aliceJwk, alg }, "X25519", true, ["deriveBits"]);
  console.log("jwk alg", alg, imported.type, imported.algorithm.name);
}

const jwkCrv = await crypto.subtle
  .importKey("jwk", { kty: "OKP", crv: "Ed25519", x: bobPublicJwk.x }, "X25519", true, [])
  .then(() => "resolved", (error: Error) => `${error.name} ${error.message}`);
console.log("jwk crv", jwkCrv);
