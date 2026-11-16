// KeyObject.toCryptoKey: a secret KeyObject becomes an HMAC, AES or KDF
// CryptoKey whose length is the key's bits, and an asymmetric KeyObject
// becomes the CryptoKey of the algorithm its type names, with the usages
// the caller asks for. The conversions keep Node's errors for a mismatched
// key type, curve or usage and for an empty private-key usage list.
import { createSecretKey, generateKeyPairSync, sign as signBytes, verify as verifyBytes } from "node:crypto";
import type { webcrypto } from "node:crypto";

const hex = (bytes: ArrayBuffer): string => Buffer.from(bytes).toString("hex");

// Secret keys: HMAC and AES lengths come from the bytes; a KDF key cannot
// be extractable.
const secret = createSecretKey(Buffer.alloc(16, 7));
const hmac = secret.toCryptoKey({ name: "HMAC", hash: "SHA-256" }, true, ["sign", "verify"]);
const hmacAlgorithm = hmac.algorithm as webcrypto.HmacKeyAlgorithm;
console.log("hmac", hmac.type, hmac.extractable, hmacAlgorithm.name, hmacAlgorithm.length, hmacAlgorithm.hash.name);
const mac = await crypto.subtle.sign("HMAC", hmac, Buffer.from("data"));
console.log("hmac sign", mac.byteLength, await crypto.subtle.verify("HMAC", hmac, mac, Buffer.from("data")));
const aes = secret.toCryptoKey({ name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
const aesAlgorithm = aes.algorithm as webcrypto.AesKeyAlgorithm;
console.log("aes", aesAlgorithm.name, aesAlgorithm.length, aes.extractable, aes.usages.join(","));
const hkdf = secret.toCryptoKey("HKDF", false, ["deriveBits"]);
console.log("hkdf", hkdf.algorithm.name, JSON.stringify(hkdf.usages));

for (const [label, run] of [
  ["hkdf extractable", () => secret.toCryptoKey("HKDF", true, ["deriveBits"])],
  ["hmac length mismatch", () => secret.toCryptoKey({ name: "HMAC", hash: "SHA-256", length: 64 }, true, ["sign"])],
  ["aes length", () => createSecretKey(Buffer.alloc(20, 1)).toCryptoKey({ name: "AES-GCM" }, true, ["encrypt"])],
  ["empty usages", () => secret.toCryptoKey({ name: "AES-GCM" }, true, [])],
  ["unsupported usage", () => secret.toCryptoKey({ name: "AES-GCM" }, true, ["sign"])],
  ["asymmetric algorithm", () => secret.toCryptoKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"])],
] as const) {
  let result: string;
  try {
    run();
    result = "resolved";
  } catch (error) {
    result = `${(error as Error).name} ${(error as Error).message}`;
  }
  console.log(label, result);
}

// Asymmetric keys: ECDSA, Ed25519 and RSA convert, sign, and verify with
// the matching CryptoKey.
const ec = generateKeyPairSync("ec", { namedCurve: "P-256" });
const ecdsaPrivate = ec.privateKey.toCryptoKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]);
const ecdsaPublic = ec.publicKey.toCryptoKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["verify"]);
const ecdsaAlgorithm = ecdsaPrivate.algorithm as webcrypto.EcKeyAlgorithm;
console.log("ecdsa", ecdsaPrivate.type, ecdsaPublic.type, ecdsaAlgorithm.name, ecdsaAlgorithm.namedCurve, ecdsaPrivate.usages.join(","));
const ecdsaSignature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, ecdsaPrivate, Buffer.from("data"));
console.log("ecdsa verify", await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, ecdsaPublic, ecdsaSignature, Buffer.from("data")));

const ed = generateKeyPairSync("ed25519");
const edPrivate = ed.privateKey.toCryptoKey("Ed25519", true, ["sign"]);
const edPublic = ed.publicKey.toCryptoKey("Ed25519", true, ["verify"]);
const edSignature = await crypto.subtle.sign("Ed25519", edPrivate, Buffer.from("data"));
console.log("ed25519", edPrivate.type, edPrivate.algorithm.name, await crypto.subtle.verify("Ed25519", edPublic, edSignature, Buffer.from("data")));

const rsa = generateKeyPairSync("rsa", { modulusLength: 1024 });
const pssPrivate = rsa.privateKey.toCryptoKey({ name: "RSA-PSS", hash: "SHA-256" }, true, ["sign"]);
const pssPublic = rsa.publicKey.toCryptoKey({ name: "RSA-PSS", hash: "SHA-256" }, true, ["verify"]);
const pssAlgorithm = pssPublic.algorithm as webcrypto.RsaHashedKeyAlgorithm;
console.log("rsa-pss", pssAlgorithm.modulusLength, pssAlgorithm.hash.name, pssPrivate.usages.join(","));
const pssSignature = await crypto.subtle.sign({ name: "RSA-PSS", saltLength: 32 }, pssPrivate, Buffer.from("data"));
console.log("rsa-pss verify", await crypto.subtle.verify({ name: "RSA-PSS", saltLength: 32 }, pssPublic, pssSignature, Buffer.from("data")));
const oaepPublic = rsa.publicKey.toCryptoKey({ name: "RSA-OAEP", hash: "SHA-256" }, true, ["encrypt"]);
const sealed = await crypto.subtle.encrypt({ name: "RSA-OAEP" }, oaepPublic, Buffer.from("hello"));
console.log("rsa-oaep", sealed.byteLength, await crypto.subtle.decrypt({ name: "RSA-OAEP" }, rsa.privateKey.toCryptoKey({ name: "RSA-OAEP", hash: "SHA-256" }, true, ["decrypt"]), sealed).then((plain) => Buffer.from(plain).toString()));

// An RSA-PSS key is not a plain RSA key or an EC key: asking for an ECDSA
// or ECDH CryptoKey answers Node's key-type error, never a crash on its
// absent curve name.
const pssOnly = generateKeyPairSync("rsa-pss", { modulusLength: 1024 });
for (const [label, algorithm] of [
  ["pss to ecdsa", { name: "ECDSA", namedCurve: "P-256" }],
  ["pss to ecdh", { name: "ECDH", namedCurve: "P-256" }],
] as const) {
  let result: string;
  try {
    pssOnly.privateKey.toCryptoKey(algorithm, true, ["sign"]);
    result = "resolved";
  } catch (error) {
    result = `${(error as Error).name} ${(error as Error).message}`;
  }
  console.log(label, result);
}

// Key agreement keys keep their derive usages on the private half only.
const ecdh = generateKeyPairSync("ec", { namedCurve: "P-256" });
const ecdhPrivate = ecdh.privateKey.toCryptoKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
const ecdhPublic = ecdh.publicKey.toCryptoKey({ name: "ECDH", namedCurve: "P-256" }, true, []);
console.log("ecdh", ecdhPrivate.usages.join(","), JSON.stringify(ecdhPublic.usages), ecdhPrivate.algorithm.name);
const peer = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
const derived = await crypto.subtle.deriveBits({ name: "ECDH", public: peer.publicKey }, ecdhPrivate, 128);
console.log("ecdh derive", derived.byteLength, hex(derived).length);

const x = generateKeyPairSync("x25519");
const xPrivate = x.privateKey.toCryptoKey("X25519", true, ["deriveBits"]);
const xPeer = await crypto.subtle.generateKey({ name: "X25519" }, true, ["deriveBits"]);
console.log("x25519", xPrivate.algorithm.name, xPrivate.usages.join(","), (await crypto.subtle.deriveBits({ name: "X25519", public: xPeer.publicKey }, xPrivate, 256)).byteLength);

for (const [label, run] of [
  ["wrong key type", () => ec.privateKey.toCryptoKey({ name: "RSA-PSS", hash: "SHA-256" }, true, ["sign"])],
  ["wrong curve", () => ec.privateKey.toCryptoKey({ name: "ECDSA", namedCurve: "P-384" }, true, ["sign"])],
  ["public sign", () => ec.publicKey.toCryptoKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"])],
  ["empty private usages", () => ec.privateKey.toCryptoKey({ name: "ECDSA", namedCurve: "P-256" }, true, [])],
  ["missing curve", () => ec.privateKey.toCryptoKey("ECDSA" as unknown as webcrypto.EcKeyImportParams, true, ["sign"])],
] as const) {
  let result: string;
  try {
    run();
    result = "resolved";
  } catch (error) {
    result = `${(error as Error).name} ${(error as Error).message}`;
  }
  console.log(label, result);
}

// An untyped KeyObject selects the WebCrypto unit through the same hook:
// the call runs without any other crypto.subtle operation in the program.
const untypedKey: any = createSecretKey(Buffer.alloc(16, 9));
const untypedCryptoKey = untypedKey.toCryptoKey({ name: "AES-GCM" }, true, ["encrypt"]);
console.log("untyped", untypedCryptoKey.algorithm.name, untypedCryptoKey.algorithm.length);

// A KeyObject also signs through node:crypto with the material the derived
// CryptoKey holds.
const keyObjectSignature = signBytes("sha256", Buffer.from("raw"), ec.privateKey);
console.log("node sign", verifyBytes("sha256", Buffer.from("raw"), ec.publicKey, keyObjectSignature));
