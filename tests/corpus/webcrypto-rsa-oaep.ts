// crypto.subtle RSA-OAEP: importKey from a fixed PKCS#8 private key and
// its SubjectPublicKeyInfo (DER), the CryptoKey algorithm and usages, encrypt
// and decrypt at SHA-256 and SHA-512 (labels included), the longest
// message each hash allows, the rejection of a longer one and of a
// tampered ciphertext, spki/pkcs8/jwk exports, and the errors of a key
// from another algorithm and of the wrong key half. Ciphertexts are
// random, so only their lengths are printed.
import type { webcrypto } from "node:crypto";

const privateDer = Buffer.from(
`MIICdwIBADANBgkqhkiG9w0BAQEFAASCAmEwggJdAgEAAoGBAK7lAD2cigYx8B+iBe91UevvJIjk
n4wmWcdVlrMT9/qwACHC3HB3ekZH6NraNVvx1uoFpKZFlELqrzodnK4rcOkoiTQXyQXR071DkGu4
4hERDDIwMgXC6HYPqx1ow/UHFHhgoTWVxPvxqjQSZGh1GliOFeRcyz5tzfkv6q6gnYo5AgMBAAEC
gYAWxi8v1rCKefpAxEJtmiNey7dANDUqdNv//v8utoz2EfESdGNsKcK8YCTMStnj7SwFMVLta+YQ
iKrksHJ0o6eCHepEDKFxenMXVE7GgDSy1U6zH/CIqjr5GyQGhUkJjAVa98+kSbOB721nHT4siq3n
69S89MFCE2+9beGEkPxK4QJBANmICU3rgRyfUNk4AaUIoPFc8j2pc6lnh5SUjQ8xfy6uCzLX7qzq
rV9xu8xRVzCPdJ4N0FEGLfgtLaSA24T7OH0CQQDN0rtZsHVpiJqChTTkasaET4tXosVAsQH50wTx
A3du9hXpIiCIRDWlI5NAk4Yc7qUCq5oXOPNH6s2n4ftZhgFtAkEAjgGHiW2HUMcUQWmVcUYrwsUZ
gnV/gwSJ9s3vNA7s5u1JdDyQnCNrYNZfcadcEuBjkdaUuoAdPFlJ5Y0VQT+7BQJBALO4A0FgdFVP
I2M+fx3IIklbz5cZGNXQ+aGz4Ye1eC8aj60+0FtL+++TbbugVSWkN89qGaWXY85zN1oVV80m1s0C
QHWquWMUPNUHT5Msp886s5Ud9J+UQCZEovsP4blio51ZggS1dl8gIMDPv5uUrfVdfljHHfmEgWLM
TJMNbsqixxA=`,
"base64",
);
const publicDer = Buffer.from(
`MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQCu5QA9nIoGMfAfogXvdVHr7ySI5J+MJlnHVZaz
E/f6sAAhwtxwd3pGR+ja2jVb8dbqBaSmRZRC6q86HZyuK3DpKIk0F8kF0dO9Q5BruOIREQwyMDIF
wuh2D6sdaMP1BxR4YKE1lcT78ao0EmRodRpYjhXkXMs+bc35L+quoJ2KOQIDAQAB`,
"base64",
);

const oaep256 = { name: "RSA-OAEP", hash: "SHA-256" };
const oaep512 = { name: "RSA-OAEP", hash: "SHA-512" };
const privateKey = await crypto.subtle.importKey("pkcs8", privateDer, oaep256, true, ["decrypt"]);
const publicKey = await crypto.subtle.importKey("spki", publicDer, oaep256, true, ["encrypt"]);
const private512 = await crypto.subtle.importKey("pkcs8", privateDer, oaep512, true, ["decrypt"]);
const public512 = await crypto.subtle.importKey("spki", publicDer, oaep512, true, ["encrypt"]);

const publicAlgorithm = publicKey.algorithm as webcrypto.RsaHashedKeyAlgorithm;
console.log(
  "algorithm",
  publicAlgorithm.name,
  publicAlgorithm.modulusLength,
  publicAlgorithm.hash.name,
  publicAlgorithm.publicExponent[2],
);
console.log("public key", publicKey.type, publicKey.extractable, publicKey.usages.join(","));
console.log("private key", privateKey.type, privateKey.usages.join(","));

const plaintext = Buffer.from("hello oaep");
const sealed = await crypto.subtle.encrypt({ name: "RSA-OAEP" }, publicKey, plaintext);
const opened = await crypto.subtle.decrypt({ name: "RSA-OAEP" }, privateKey, sealed);
console.log("round trip", sealed.byteLength, Buffer.from(opened).toString());

const label = Buffer.from("label");
const labelled = await crypto.subtle.encrypt({ name: "RSA-OAEP", label }, publicKey, plaintext);
console.log("label", (await crypto.subtle.decrypt({ name: "RSA-OAEP", label }, privateKey, labelled)).byteLength);

// SHA-512 leaves no room for a message under a 1024-bit modulus.
const sealed512 = await crypto.subtle
  .encrypt({ name: "RSA-OAEP" }, public512, Buffer.from("x"))
  .then(() => "resolved", (error: Error) => `${error.name} ${error.message}`);
console.log("sha512", (private512.algorithm as webcrypto.RsaHashedKeyAlgorithm).hash.name, sealed512);

// The longest message SHA-256 holds under a 1024-bit modulus is 62 bytes.
const atLimit = await crypto.subtle.encrypt({ name: "RSA-OAEP" }, publicKey, new Uint8Array(62));
console.log("at limit", atLimit.byteLength, (await crypto.subtle.decrypt({ name: "RSA-OAEP" }, privateKey, atLimit)).byteLength);
const tooLong = await crypto.subtle
  .encrypt({ name: "RSA-OAEP" }, publicKey, new Uint8Array(63))
  .then(() => "resolved", (error: Error) => `${error.name} ${error.message}`);
console.log("too long", tooLong);

const tampered = new Uint8Array(sealed);
tampered[0] = (tampered[0] ?? 0) ^ 1;
const tamperedResult = await crypto.subtle
  .decrypt({ name: "RSA-OAEP" }, privateKey, tampered)
  .then(() => "resolved", (error: Error) => `${error.name} ${error.message}`);
console.log("tampered", tamperedResult);
const wrongLabel = await crypto.subtle
  .decrypt({ name: "RSA-OAEP", label: Buffer.from("other") }, privateKey, labelled)
  .then(() => "resolved", (error: Error) => `${error.name} ${error.message}`);
console.log("wrong label", wrongLabel);

const jwk = await crypto.subtle.exportKey("jwk", privateKey);
const spki = await crypto.subtle.exportKey("spki", publicKey);
const pkcs8 = await crypto.subtle.exportKey("pkcs8", privateKey);
console.log("export", Object.keys(jwk).sort().join(","), jwk.alg, spki.byteLength, pkcs8.byteLength);
const jwkRound = await crypto.subtle.importKey("jwk", jwk, oaep256, true, ["decrypt"]);
console.log("jwk import", jwkRound.type, jwkRound.algorithm.name);
const useEnc = await crypto.subtle
  .importKey("jwk", { ...jwk, use: "enc" }, oaep256, true, ["decrypt"])
  .then((key) => key.type, (error: Error) => `${error.name} ${error.message}`);
console.log("jwk use enc", useEnc);
const useSig = await crypto.subtle
  .importKey("jwk", { ...jwk, use: "sig" }, oaep256, true, ["decrypt"])
  .then(() => "resolved", (error: Error) => `${error.name} ${error.message}`);
console.log("jwk use sig", useSig);

const encryptWithPrivate = await crypto.subtle
  .encrypt({ name: "RSA-OAEP" }, privateKey, plaintext)
  .then(() => "resolved", (error: Error) => `${error.name} ${error.message}`);
console.log("encrypt with private", encryptWithPrivate);
const decryptWithPublic = await crypto.subtle
  .decrypt({ name: "RSA-OAEP" }, publicKey, sealed)
  .then(() => "resolved", (error: Error) => `${error.name} ${error.message}`);
console.log("decrypt with public", decryptWithPublic);

const pss = await crypto.subtle.generateKey(
  { name: "RSA-PSS", modulusLength: 1024, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
  true,
  ["sign", "verify"],
);
const wrongKey = await crypto.subtle
  .encrypt({ name: "RSA-OAEP" }, pss.publicKey, plaintext)
  .then(() => "resolved", (error: Error) => `${error.name} ${error.message}`);
console.log("wrong key", wrongKey);

const badUsage = await crypto.subtle
  .generateKey(
    { name: "RSA-OAEP", modulusLength: 1024, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign"],
  )
  .then(() => "resolved", (error: Error) => `${error.name} ${error.message}`);
console.log("bad usage", badUsage);

const generated = await crypto.subtle.generateKey(
  { name: "RSA-OAEP", modulusLength: 1024, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
  true,
  ["encrypt", "decrypt", "wrapKey", "unwrapKey"],
);
console.log("generated", generated.publicKey.usages.join(","), generated.privateKey.usages.join(","));
const generatedSealed = await crypto.subtle.encrypt({ name: "RSA-OAEP" }, generated.publicKey, plaintext);
console.log("generated round trip", (await crypto.subtle.decrypt({ name: "RSA-OAEP" }, generated.privateKey, generatedSealed)).byteLength);
