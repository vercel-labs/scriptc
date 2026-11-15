// The WebCrypto algorithm dictionaries Node documents as "Algorithm
// parameters", each passed to the crypto.subtle method that takes it:
// AES-GCM (AeadParams, AesKeyGenParams, AesKeyAlgorithm), AES-CBC and
// AES-CTR, ECDSA (EcKeyGenParams, EcKeyAlgorithm, EcdsaParams,
// EcKeyImportParams), HMAC (import, generate, key algorithm), HKDF,
// PBKDF2 with an AES derived key, RSA-PSS, and the CryptoKeyPair a key
// generation returns. Outputs are fixed-key results, lengths and round
// trips; signatures that use fresh randomness print their length only.
const hex = (bytes) => Buffer.from(bytes).toString("hex");
const text = (bytes) => Buffer.from(bytes).toString();
const data = Buffer.from("hello");

// AES-GCM: a generated key reports its algorithm; a fixed key gives a
// fixed ciphertext with the tag appended.
const gcmGenerated = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
console.log(gcmGenerated.type, gcmGenerated.algorithm.name, gcmGenerated.algorithm.length, gcmGenerated.usages.join(","));
const gcmKey = await crypto.subtle.importKey("raw", new Uint8Array(32), { name: "AES-GCM" }, true, ["encrypt", "decrypt"]);
const aead = { name: "AES-GCM", iv: new Uint8Array(12), additionalData: Buffer.from("aad"), tagLength: 128 };
const sealed = await crypto.subtle.encrypt(aead, gcmKey, data);
console.log(sealed.byteLength, hex(sealed), text(await crypto.subtle.decrypt(aead, gcmKey, sealed)));
const short = await crypto.subtle.encrypt({ name: "AES-GCM", iv: new Uint8Array(12), tagLength: 96 }, gcmKey, data);
console.log(short.byteLength);
const tampered = new Uint8Array(sealed);
tampered[0] ^= 1;
try {
  await crypto.subtle.decrypt(aead, gcmKey, tampered);
} catch (error) {
  console.log(error.name);
}

// AES-CBC and AES-CTR with fixed keys.
const cbcKey = await crypto.subtle.importKey("raw", new Uint8Array(16), { name: "AES-CBC" }, false, ["encrypt", "decrypt"]);
const cbc = { name: "AES-CBC", iv: new Uint8Array(16) };
const cbcSealed = await crypto.subtle.encrypt(cbc, cbcKey, data);
console.log(hex(cbcSealed), text(await crypto.subtle.decrypt(cbc, cbcKey, cbcSealed)), cbcKey.extractable);
const ctrKey = await crypto.subtle.importKey("raw", new Uint8Array(16), { name: "AES-CTR" }, false, ["encrypt", "decrypt"]);
const ctr = { name: "AES-CTR", counter: new Uint8Array(16), length: 64 };
const ctrSealed = await crypto.subtle.encrypt(ctr, ctrKey, data);
console.log(hex(ctrSealed), text(await crypto.subtle.decrypt(ctr, ctrKey, ctrSealed)));

// ECDSA: the key pair, its key algorithm, a signature and a raw import.
const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
console.log(pair.privateKey.type, pair.publicKey.type, pair.publicKey.algorithm.name, pair.publicKey.algorithm.namedCurve);
const ecdsa = { name: "ECDSA", hash: "SHA-256" };
const signature = await crypto.subtle.sign(ecdsa, pair.privateKey, data);
const rawPublic = await crypto.subtle.exportKey("raw", pair.publicKey);
const imported = await crypto.subtle.importKey("raw", rawPublic, { name: "ECDSA", namedCurve: "P-256" }, true, ["verify"]);
console.log(signature.byteLength, rawPublic.byteLength, await crypto.subtle.verify(ecdsa, imported, signature, data));
console.log(await crypto.subtle.verify(ecdsa, imported, signature, Buffer.from("other")));

// HMAC: an imported key with a bit length, a generated key, a fixed MAC.
const hmacKey = await crypto.subtle.importKey("raw", Buffer.from("key"), { name: "HMAC", hash: "SHA-256", length: 24 }, true, ["sign", "verify"]);
const hmacGenerated = await crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-512", length: 128 }, true, ["sign"]);
const mac = await crypto.subtle.sign("HMAC", hmacKey, data);
console.log(hex(mac), hmacKey.algorithm.name, hmacKey.algorithm.length, hmacKey.algorithm.hash.name, hmacGenerated.algorithm.length);
console.log(await crypto.subtle.verify("HMAC", hmacKey, mac, data));

// HKDF and PBKDF2: derived bits, and an AES key derived with its own
// dictionary (AesDerivedKeyParams).
const hkdfBase = await crypto.subtle.importKey("raw", Buffer.from("secret"), "HKDF", false, ["deriveBits"]);
console.log(hex(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(8), info: Buffer.from("info") }, hkdfBase, 128)));
const pbkdfBase = await crypto.subtle.importKey("raw", Buffer.from("password"), "PBKDF2", false, ["deriveKey", "deriveBits"]);
const pbkdf = { name: "PBKDF2", hash: "SHA-256", salt: new Uint8Array(8), iterations: 10 };
const derived = await crypto.subtle.deriveKey(pbkdf, pbkdfBase, { name: "AES-GCM", length: 128 }, true, ["encrypt"]);
console.log(derived.algorithm.name, derived.algorithm.length, hex(await crypto.subtle.exportKey("raw", derived)));

// RSA-PSS: generation parameters, the hashed key algorithm, a signature.
const rsa = await crypto.subtle.generateKey(
  { name: "RSA-PSS", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
  true,
  ["sign", "verify"],
);
const pss = { name: "RSA-PSS", saltLength: 32 };
const rsaSignature = await crypto.subtle.sign(pss, rsa.privateKey, data);
console.log(rsaSignature.byteLength, await crypto.subtle.verify(pss, rsa.publicKey, rsaSignature, data));
console.log(rsa.publicKey.algorithm.name, rsa.publicKey.algorithm.modulusLength, hex(rsa.publicKey.algorithm.publicExponent), rsa.publicKey.algorithm.hash.name);

// A buffer source is an ArrayBuffer, a typed array of any width, or a DataView.
const bytes = new Uint8Array([1, 2, 3, 4]);
console.log(
  hex(await crypto.subtle.digest("SHA-256", bytes)) === hex(await crypto.subtle.digest("SHA-256", new DataView(bytes.buffer))),
  hex(await crypto.subtle.digest("SHA-256", bytes.buffer)) === hex(await crypto.subtle.digest("SHA-256", new Uint16Array(bytes.buffer))),
);
