// crypto.subtle over ECDH on P-256: generateKey and importKey (jwk, raw,
// pkcs8, spki), the CryptoKey algorithm and usages, deriveBits at the
// field size and the shorter lengths Node truncates with the low bits of
// the final byte cleared, deriveKey to an AES and an HMAC key, the shared
// secret from both sides, and the error shapes of a mismatched curve, a
// mismatched usage, a missing or non-CryptoKey public member and a public
// base key. The keys are fixed, so every derived value is fixed too.
import type { webcrypto } from "node:crypto";

const hex = (bytes: ArrayBuffer): string => Buffer.from(bytes).toString("hex");

const aliceJwk: JsonWebKey = {
  kty: "EC",
  crv: "P-256",
  x: "EOqDlhcTYVchChRDUHhnn_qDeDaLUbUdyrTTwImASTM",
  y: "evKit-VCLHUMj9s9NRX8dPOgweWQlm-35U0ACQajuzY",
  d: "iK8e568E3TXpqdE29i-ibynUFtoA6Yj1cQ4oKqqFaDU",
};
const bobPublicJwk: JsonWebKey = {
  kty: "EC",
  crv: "P-256",
  x: "fZw9I-sGeFE4EFiZ2p_1Gakrsn2cl22yvrXLQuenAYU",
  y: "Q4s51eP3g4JsaP3qtIhkp11LXZCO4AJ6GUEJlNa5iho",
};
const ecdhImport = { name: "ECDH", namedCurve: "P-256" };

const alice = await crypto.subtle.importKey("jwk", aliceJwk, ecdhImport, true, ["deriveBits", "deriveKey"]);
const bobPublic = await crypto.subtle.importKey("jwk", bobPublicJwk, ecdhImport, true, []);

const aliceAlgorithm = alice.algorithm as webcrypto.EcKeyAlgorithm;
console.log("algorithm", aliceAlgorithm.name, aliceAlgorithm.namedCurve);
console.log("key", alice.type, alice.extractable, alice.usages.join(","));
console.log("public", bobPublic.type, bobPublic.extractable, JSON.stringify(bobPublic.usages));

for (const bits of [256, 128, 100, 1, 0]) {
  const secret = await crypto.subtle.deriveBits({ name: "ECDH", public: bobPublic }, alice, bits);
  console.log("bits", bits, secret.byteLength, hex(secret));
}

const aes = await crypto.subtle.deriveKey(
  { name: "ECDH", public: bobPublic },
  alice,
  { name: "AES-GCM", length: 128 },
  true,
  ["encrypt"],
);
const aesAlgorithm = aes.algorithm as webcrypto.AesKeyAlgorithm;
console.log("derived aes", aesAlgorithm.name, aesAlgorithm.length, aes.usages.join(","));
const hmac = await crypto.subtle.deriveKey(
  { name: "ECDH", public: bobPublic },
  alice,
  { name: "HMAC", hash: "SHA-256", length: 256 },
  false,
  ["sign"],
);
const hmacAlgorithm = hmac.algorithm as webcrypto.HmacKeyAlgorithm;
console.log("derived hmac", hmacAlgorithm.name, hmacAlgorithm.length, hmacAlgorithm.hash.name, hmac.extractable);

// Both sides derive the same secret.
const bob = await crypto.subtle.importKey("raw", new Uint8Array(0), ecdhImport, true, []).catch(() => null);
console.log("raw empty public", bob === null ? "rejected" : "imported");

const rawPublic = await crypto.subtle.exportKey("raw", bobPublic);
const importedRaw = await crypto.subtle.importKey("raw", rawPublic, ecdhImport, true, []);
console.log("raw", rawPublic.byteLength, importedRaw.type, importedRaw.algorithm.name);
const spki = await crypto.subtle.exportKey("spki", bobPublic);
const pkcs8 = await crypto.subtle.exportKey("pkcs8", alice);
console.log("der", spki.byteLength, pkcs8.byteLength);
const jwkPublic = await crypto.subtle.exportKey("jwk", bobPublic);
console.log("jwk", Object.keys(jwkPublic).sort().join(","), jwkPublic.kty, jwkPublic.crv);

for (const [label, value] of [
  ["missing public", await crypto.subtle.deriveBits({ name: "ECDH" } as webcrypto.EcdhKeyDeriveParams, alice, 256).then(() => "resolved", (error: Error) => `${(error as Error).name} ${error.message}`)],
  ["plain public", await crypto.subtle.deriveBits({ name: "ECDH", public: {} } as unknown as webcrypto.EcdhKeyDeriveParams, alice, 256).then(() => "resolved", (error: Error) => `${(error as Error).name} ${error.message}`)],
  ["public base", await crypto.subtle.deriveBits({ name: "ECDH", public: bobPublic }, bobPublic, 256).then(() => "resolved", (error: Error) => `${(error as Error).name} ${error.message}`)],
  ["too long", await crypto.subtle.deriveBits({ name: "ECDH", public: bobPublic }, alice, 264).then(() => "resolved", (error: Error) => `${(error as Error).name} ${error.message}`)],
] as const) {
  console.log(label, value);
}

// P-521's shared secret is 66 bytes: an omitted length takes all 528 bits
// unmasked, and shorter lengths clear the final byte's unused bits.
const p521Import = { name: "ECDH", namedCurve: "P-521" };
const p521Alice = await crypto.subtle.importKey(
  "jwk",
  {
    kty: "EC",
    crv: "P-521",
    x: "ASGuvztm4KpTyzDltfU7XlOc3pKhqWfmFnaL2BZpGTUlxavAjLR-oQHMrNk4DDauI2DmLhaynMGoSd5CJ86NyDZs",
    y: "Ae2lkHOhDKU7bX14OjD10NUg14fgdFftH2yFEc6R1qYAGbN09lp_tgFSKQxF9siyPeDZlNTFvmo6nHXFQUnI1D5d",
    d: "AK-fZHuARFIi_zojhKZkb6bgNuCY0umiyIaHR6pALDAYmOES_moEStsj_2iFvSkIq4bpgxwjOrIimSi8qiZoR6yL",
  },
  p521Import,
  true,
  ["deriveBits"],
);
const p521Bob = await crypto.subtle.importKey(
  "jwk",
  {
    kty: "EC",
    crv: "P-521",
    x: "AZ_0UFtCFeipGMA5MxoAt0ENKVIyFD23aseauFGutB8i0RYc__rW_gx3WbNHeCV7iH7cHaqkWG1uqnOR4n3RgDWo",
    y: "APcuQvUeTS17-1HUI6Fj6hublIDoJNTnjDzX3wykIK8o9i9qk4kybEEPMiOX_0Op7RvUDwo1zg7tTfxPT0-0waWR",
  },
  p521Import,
  true,
  [],
);
for (const length of [null, 521, 522, 527, 528]) {
  const secret =
    length === null
      ? await crypto.subtle.deriveBits({ name: "ECDH", public: p521Bob }, p521Alice)
      : await crypto.subtle.deriveBits({ name: "ECDH", public: p521Bob }, p521Alice, length);
  console.log("p521", length, secret.byteLength, hex(secret));
}
const p521TooLong = await crypto.subtle
  .deriveBits({ name: "ECDH", public: p521Bob }, p521Alice, 529)
  .then(() => "resolved", (error: Error) => `${error.name} ${error.message}`);
console.log("p521 too long", p521TooLong);

const p384 = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-384" }, true, ["deriveBits"]);
const mismatch = await crypto.subtle
  .deriveBits({ name: "ECDH", public: p384.publicKey }, alice, 256)
  .then(() => "resolved", (error: Error) => `${error.name} ${error.message}`);
console.log("curve mismatch", mismatch);

const signOnly = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const wrongKey = await crypto.subtle
  .deriveBits({ name: "ECDH", public: signOnly.publicKey }, alice, 256)
  .then(() => "resolved", (error: Error) => `${error.name} ${error.message}`);
console.log("wrong key", wrongKey);

const ecdsaBase = await crypto.subtle
  .deriveBits({ name: "ECDH", public: bobPublic }, signOnly.privateKey, 256)
  .then(() => "resolved", (error: Error) => `${error.name} ${error.message}`);
console.log("ecdsa base", ecdsaBase);


const noDerive = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveKey"]);
const missingUsage = await crypto.subtle
  .deriveBits({ name: "ECDH", public: bobPublic }, noDerive.privateKey, 256)
  .then(() => "resolved", (error: Error) => `${error.name} ${error.message}`);
console.log("missing usage", missingUsage);

const useEnc = await crypto.subtle
  .importKey("jwk", { ...aliceJwk, use: "enc" }, ecdhImport, true, ["deriveBits"])
  .then((key) => key.type, (error: Error) => `${error.name} ${error.message}`);
console.log("jwk use enc", useEnc);
const useSig = await crypto.subtle
  .importKey("jwk", { ...aliceJwk, use: "sig" }, ecdhImport, true, ["deriveBits"])
  .then(() => "resolved", (error: Error) => `${error.name} ${error.message}`);
console.log("jwk use sig", useSig);

const aesBase = await crypto.subtle.generateKey({ name: "AES-GCM", length: 128 }, true, ["encrypt"]);
const secretBase = await crypto.subtle
  .deriveBits({ name: "ECDH", public: bobPublic }, aesBase, 256)
  .then(() => "resolved", (error: Error) => `${error.name} ${error.message}`);
console.log("secret base", secretBase);

const emptyUsages = await crypto.subtle
  .generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [])
  .then(() => "resolved", (error: Error) => `${error.name} ${error.message}`);
console.log("empty usages", emptyUsages);

const badUsage = await crypto.subtle
  .generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["sign"])
  .then(() => "resolved", (error: Error) => `${error.name} ${error.message}`);
console.log("bad usage", badUsage);

const unnamed = await crypto.subtle
  .generateKey("ECDH" as unknown as webcrypto.EcKeyGenParams, true, ["deriveBits"])
  .then(() => "resolved", (error: Error) => `${error.name} ${error.message}`);
console.log("bare algorithm", unnamed);
