// Node 24's modern WebCrypto algorithm dictionaries: the type checker accepts
// each documented shape (webcrypto.Argon2Params and friends), and the
// dictionaries are plain objects that read back their members. The algorithms
// that consume them (Argon2, KMAC, ECDH derivation, RSA-OAEP) are not
// implemented by this runtime, so no subtle method takes them yet;
// RsaHashedImportParams is also used for real by the RSA-PSS import in
// 7085-webcrypto-ecdsa-rsa.ts.
import type { webcrypto } from "node:crypto";

const hex = (bytes: ArrayBuffer | ArrayBufferView): string =>
  ArrayBuffer.isView(bytes)
    ? Buffer.from(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength).toString("hex")
    : Buffer.from(bytes).toString("hex");

// Argon2Params: the required work factors plus the optional associated data,
// secret value and version.
const argon2: webcrypto.Argon2Params = {
  name: "Argon2id",
  nonce: new Uint8Array(16),
  memory: 1024,
  passes: 2,
  parallelism: 1,
  associatedData: Buffer.from("ad"),
  secretValue: new Uint8Array(8),
  version: 0x13,
};
console.log(
  argon2.name,
  argon2.memory,
  argon2.passes,
  argon2.parallelism,
  argon2.version,
  hex(argon2.nonce),
  hex(argon2.associatedData!),
  hex(argon2.secretValue!),
);

// EcdhKeyDeriveParams: the peer's public CryptoKey.
const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const ecdh: webcrypto.EcdhKeyDeriveParams = { name: "ECDH", public: pair.publicKey };
console.log(ecdh.name, ecdh.public.type, ecdh.public.algorithm.name);

// RsaOaepParams: the optional label, with and without it.
const oaep: webcrypto.RsaOaepParams = { name: "RSA-OAEP", label: new Uint8Array(5) };
const bareOaep: webcrypto.RsaOaepParams = { name: "RSA-OAEP" };
console.log(oaep.name, hex(oaep.label!), bareOaep.name, bareOaep.label === undefined);

// RsaHashedImportParams: the hash that travels with an RSA key import.
const rsaHashed: webcrypto.RsaHashedImportParams = { name: "RSA-PSS", hash: "SHA-256" };
console.log(rsaHashed.name, rsaHashed.hash);

// KmacParams: the MAC algorithm name, output length and customization.
const kmac: webcrypto.KmacParams = {
  name: "KMAC128",
  algorithm: "KMAC128",
  outputLength: 256,
  customization: Buffer.from("custom"),
};
console.log(kmac.name, kmac.algorithm, kmac.outputLength, hex(kmac.customization!));

// KmacImportParams, KmacKeyGenParams and KmacKeyAlgorithm: the length is
// optional when generating, required on the resulting key algorithm.
const kmacImport: webcrypto.KmacImportParams = { name: "KMAC128", length: 256 };
const kmacGen: webcrypto.KmacKeyGenParams = { name: "KMAC256" };
const kmacAlgorithm: webcrypto.KmacKeyAlgorithm = { name: "KMAC128", length: 256 };
console.log(kmacImport.name, kmacImport.length, kmacGen.name, kmacGen.length === undefined, kmacAlgorithm.name, kmacAlgorithm.length);
