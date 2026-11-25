// The WebCrypto algorithm dictionaries the native runtime implements, each
// passed to the operation that takes it: AES-CBC, AES-CTR and AES-GCM
// parameters (iv, counter, counter length, additional data, tag length),
// the AES key algorithm and key-generation length, HMAC import and
// generation (hash and length), ECDSA (hash), the EC key algorithm, key
// generation and import dictionaries (namedCurve), HKDF (hash, salt, info),
// PBKDF2 (hash, salt, iterations), RSA-PSS (saltLength) and the RSA hashed
// key and key-generation dictionaries (hash, modulusLength,
// publicExponent). Names are matched case-insensitively as Node matches
// them, and a member of the wrong type takes Node's TypeError.
import type { webcrypto } from "node:crypto";

const hex = (bytes: ArrayBuffer): string => Buffer.from(bytes).toString("hex");
const data = Buffer.from("algorithm parameters");

// AES-CBC: AesCbcParams's iv and name.
const cbcKey = await crypto.subtle.importKey("raw", new Uint8Array(16), { name: "AES-CBC" }, true, ["encrypt", "decrypt"]);
const cbc: webcrypto.AesCbcParams = { name: "AES-CBC", iv: new Uint8Array(16) };
const cbcSealed = await crypto.subtle.encrypt(cbc, cbcKey, data);
const cbcAlgorithm = cbcKey.algorithm as webcrypto.AesKeyAlgorithm;
console.log("aes-cbc", cbc.name, cbc.iv.byteLength, cbcSealed.byteLength, cbcAlgorithm.name, cbcAlgorithm.length);
console.log("aes-cbc lowercase", (await crypto.subtle.decrypt({ name: "aes-cbc", iv: new Uint8Array(16) }, cbcKey, cbcSealed)).byteLength);

// AES-CTR: AesCtrParams's counter and length.
const ctrKey = await crypto.subtle.importKey("raw", new Uint8Array(32), { name: "AES-CTR" }, true, ["encrypt", "decrypt"]);
const ctr: webcrypto.AesCtrParams = { name: "AES-CTR", counter: new Uint8Array(16), length: 64 };
const ctrSealed = await crypto.subtle.encrypt(ctr, ctrKey, data);
const ctrAlgorithm = ctrKey.algorithm as webcrypto.AesKeyAlgorithm;
console.log("aes-ctr", ctr.name, ctr.counter.byteLength, ctr.length, hex(ctrSealed), ctrAlgorithm.length);

// AES-GCM: AeadParams's additionalData and tagLength.
const gcmKey = await crypto.subtle.importKey("raw", new Uint8Array(16), { name: "AES-GCM" }, true, ["encrypt", "decrypt"]);
const gcm: webcrypto.AesGcmParams = {
  name: "AES-GCM",
  iv: new Uint8Array(12),
  additionalData: Buffer.from("aad"),
  tagLength: 96,
};
const gcmSealed = await crypto.subtle.encrypt(gcm, gcmKey, data);
console.log("aes-gcm", gcm.name, gcm.iv.byteLength, gcm.additionalData!.byteLength, gcm.tagLength, gcmSealed.byteLength);

// AesKeyGenParams's length.
const generatedAes = await crypto.subtle.generateKey({ name: "AES-KW", length: 192 }, true, ["wrapKey"]);
const generatedAlgorithm = generatedAes.algorithm as webcrypto.AesKeyAlgorithm;
console.log("aes-gen", generatedAlgorithm.name, generatedAlgorithm.length);

// HMAC: HmacImportParams's hash and length, HmacKeyAlgorithm's hash and
// length, and HmacKeyGenParams's length.
const hmacKey = await crypto.subtle.importKey("raw", new Uint8Array(32), { name: "HMAC", hash: "SHA-384", length: 256 }, true, ["sign", "verify"]);
const hmacAlgorithm = hmacKey.algorithm as webcrypto.HmacKeyAlgorithm;
const hmacMac = await crypto.subtle.sign("HMAC", hmacKey, data);
console.log("hmac-import", hmacAlgorithm.name, hmacAlgorithm.hash.name, hmacAlgorithm.length, hmacMac.byteLength);
const hmacGenerated = await crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-512", length: 128 }, true, ["sign"]);
const hmacGeneratedAlgorithm = hmacGenerated.algorithm as webcrypto.HmacKeyAlgorithm;
console.log("hmac-gen", hmacGeneratedAlgorithm.hash.name, hmacGeneratedAlgorithm.length, hmacGenerated.usages.join(","));

// ECDSA: EcdsaParams's hash, EcKeyGenParams's namedCurve, EcKeyAlgorithm's
// namedCurve and EcKeyImportParams's namedCurve.
const ecdsaPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-384" }, true, ["sign", "verify"]);
const ecdsaAlgorithm = ecdsaPair.publicKey.algorithm as webcrypto.EcKeyAlgorithm;
const ecdsa: webcrypto.EcdsaParams = { name: "ECDSA", hash: "SHA-512" };
const signature = await crypto.subtle.sign(ecdsa, ecdsaPair.privateKey, data);
const rawPublic = await crypto.subtle.exportKey("raw", ecdsaPair.publicKey);
const ecdsaImported = await crypto.subtle.importKey("raw", rawPublic, { name: "ECDSA", namedCurve: "P-384" }, true, ["verify"]);
console.log("ecdsa", ecdsa.hash, ecdsa.name, ecdsaAlgorithm.namedCurve, rawPublic.byteLength, await crypto.subtle.verify(ecdsa, ecdsaImported, signature, data));

// HKDF: HkdfParams's hash, salt and info.
const hkdfBase = await crypto.subtle.importKey("raw", new Uint8Array(32), "HKDF", false, ["deriveBits"]);
const hkdf: webcrypto.HkdfParams = { name: "HKDF", hash: "SHA-384", salt: new Uint8Array(16), info: Buffer.from("info") };
const hkdfBits = await crypto.subtle.deriveBits(hkdf, hkdfBase, 256);
console.log("hkdf", hkdf.name, hkdf.hash as string, hkdf.salt!.byteLength, hkdf.info!.byteLength, hex(hkdfBits).length);

// PBKDF2: Pbkdf2Params's hash, salt and iterations.
const pbkdf2Base = await crypto.subtle.importKey("raw", new Uint8Array(16), "PBKDF2", false, ["deriveBits"]);
const pbkdf2: webcrypto.Pbkdf2Params = { name: "PBKDF2", hash: "SHA-1", salt: new Uint8Array(8), iterations: 1000 };
const pbkdf2Bits = await crypto.subtle.deriveBits(pbkdf2, pbkdf2Base, 128);
console.log("pbkdf2", pbkdf2.name, pbkdf2.hash as string, pbkdf2.salt!.byteLength, pbkdf2.iterations, hex(pbkdf2Bits).length);

// RSASSA-PKCS1-v1_5 and RSA-PSS: RsaHashedKeyGenParams's hash,
// modulusLength and publicExponent, RsaHashedKeyAlgorithm's members, and
// RsaPssParams's saltLength.
const rsaPair = await crypto.subtle.generateKey(
  {
    name: "RSASSA-PKCS1-v1_5",
    hash: "SHA-256",
    modulusLength: 1024,
    publicExponent: new Uint8Array([1, 0, 1]),
  },
  true,
  ["sign", "verify"],
);
const rsaAlgorithm = rsaPair.publicKey.algorithm as webcrypto.RsaHashedKeyAlgorithm;
const rsaSignature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", rsaPair.privateKey, data);
console.log("rsassa", rsaAlgorithm.name, rsaAlgorithm.hash.name, rsaAlgorithm.modulusLength, rsaAlgorithm.publicExponent[2], rsaSignature.byteLength);

const pssPair = await crypto.subtle.generateKey(
  { name: "RSA-PSS", hash: "SHA-384", modulusLength: 1024, publicExponent: new Uint8Array([1, 0, 1]) },
  true,
  ["sign", "verify"],
);
const pss: webcrypto.RsaPssParams = { name: "RSA-PSS", saltLength: 32 };
const pssSignature = await crypto.subtle.sign(pss, pssPair.privateKey, data);
console.log("rsa-pss", pss.name, pss.saltLength, pssSignature.byteLength, await crypto.subtle.verify(pss, pssPair.publicKey, pssSignature, data));

// Node's errors for a member of the wrong type.
for (const [label, run] of [
  ["cbc iv string", () => crypto.subtle.encrypt({ name: "AES-CBC", iv: "x" } as unknown as webcrypto.AesCbcParams, cbcKey, data)],
  ["ctr length string", () => crypto.subtle.encrypt({ name: "AES-CTR", counter: new Uint8Array(16), length: "x" } as unknown as webcrypto.AesCtrParams, ctrKey, data)],
  ["pbkdf2 iterations missing", () => crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-1", salt: new Uint8Array(8) } as unknown as webcrypto.Pbkdf2Params, pbkdf2Base, 128)],
] as const) {
  const result = await run().then(() => "resolved", (error: Error) => `${error.name} ${error.message}`);
  console.log(label, result);
}
