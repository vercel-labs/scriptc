// crypto.subtle.getPublicKey derives the public CryptoKey of a private asymmetric key with the usages the caller asks for, from fixed JWK and PKCS#8 keys; Node reports the method as experimental once per process before checking arguments.
// @normalize-pid
import type { webcrypto } from "node:crypto";

const hex = (bytes: ArrayBuffer): string => Buffer.from(bytes).toString("hex");

const ecdsaPrivate: JsonWebKey = {
  kty: "EC",
  crv: "P-256",
  x: "EOqDlhcTYVchChRDUHhnn_qDeDaLUbUdyrTTwImASTM",
  y: "evKit-VCLHUMj9s9NRX8dPOgweWQlm-35U0ACQajuzY",
  d: "iK8e568E3TXpqdE29i-ibynUFtoA6Yj1cQ4oKqqFaDU",
};
const ecdsa = await crypto.subtle.importKey("jwk", ecdsaPrivate, { name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]);
const ecdsaPublic = await crypto.subtle.getPublicKey(ecdsa, ["verify"]);
const ecdsaAlgorithm = ecdsaPublic.algorithm as webcrypto.EcKeyAlgorithm;
console.log("ecdsa", ecdsaPublic.type, ecdsaPublic.extractable, ecdsaPublic.usages.join(","), ecdsaAlgorithm.name, ecdsaAlgorithm.namedCurve);
const raw = await crypto.subtle.exportKey("raw", ecdsaPublic);
console.log("ecdsa raw", raw.byteLength, hex(raw));
const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, ecdsa, Buffer.from("signed"));
console.log("ecdsa verify", await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, ecdsaPublic, signature, Buffer.from("signed")));
const noUsages = await crypto.subtle.getPublicKey(ecdsa, []);
console.log("ecdsa empty usages", JSON.stringify(noUsages.usages), noUsages.extractable);

const edPrivate: JsonWebKey = {
  kty: "OKP",
  crv: "Ed25519",
  x: "exIy8jg5pHJJFq3ph0fBYjzJwZpMQaiIyAcdQ0NU7Ao",
  d: "PNDczy8K0Bx27v5IsTP5vcrNwD615Smc8W1z-uZRJpc",
};
const ed = await crypto.subtle.importKey("jwk", edPrivate, "Ed25519", true, ["sign"]);
const edPublic = await crypto.subtle.getPublicKey(ed, ["verify"]);
console.log("ed25519", edPublic.type, edPublic.extractable, edPublic.usages.join(","), edPublic.algorithm.name);
const edRaw = await crypto.subtle.exportKey("raw", edPublic);
console.log("ed25519 raw", edRaw.byteLength, hex(edRaw));
const edSignature = await crypto.subtle.sign("Ed25519", ed, Buffer.from("signed"));
console.log("ed25519 verify", await crypto.subtle.verify("Ed25519", edPublic, edSignature, Buffer.from("signed")));

const privateDer = Buffer.from(
`MIICdwIBADANBgkqhkiG9w0BAQEFAASCAmEwggJdAgEAAoGBAK7lAD2cigYx8B+iBe91UevvJIjkn4wmWcdVlrMT9/qwACHC3HB3ekZH6NraNVvx1uoFpKZFlELqrzodnK4rcOkoiTQXyQXR071DkGu44hERDDIwMgXC6HYPqx1ow/UHFHhgoTWVxPvxqjQSZGh1GliOFeRcyz5tzfkv6q6gnYo5AgMBAAECgYAWxi8v1rCKefpAxEJtmiNey7dANDUqdNv//v8utoz2EfESdGNsKcK8YCTMStnj7SwFMVLta+YQiKrksHJ0o6eCHepEDKFxenMXVE7GgDSy1U6zH/CIqjr5GyQGhUkJjAVa98+kSbOB721nHT4siq3n69S89MFCE2+9beGEkPxK4QJBANmICU3rgRyfUNk4AaUIoPFc8j2pc6lnh5SUjQ8xfy6uCzLX7qzqrV9xu8xRVzCPdJ4N0FEGLfgtLaSA24T7OH0CQQDN0rtZsHVpiJqChTTkasaET4tXosVAsQH50wTxA3du9hXpIiCIRDWlI5NAk4Yc7qUCq5oXOPNH6s2n4ftZhgFtAkEAjgGHiW2HUMcUQWmVcUYrwsUZgnV/gwSJ9s3vNA7s5u1JdDyQnCNrYNZfcadcEuBjkdaUuoAdPFlJ5Y0VQT+7BQJBALO4A0FgdFVPI2M+fx3IIklbz5cZGNXQ+aGz4Ye1eC8aj60+0FtL+++TbbugVSWkN89qGaWXY85zN1oVV80m1s0CQHWquWMUPNUHT5Msp886s5Ud9J+UQCZEovsP4blio51ZggS1dl8gIMDPv5uUrfVdfljHHfmEgWLMTJMNbsqixxA=`,
  "base64",
);
const rsa = await crypto.subtle.importKey("pkcs8", privateDer, { name: "RSA-PSS", hash: "SHA-256" }, true, ["sign"]);
const rsaPublic = await crypto.subtle.getPublicKey(rsa, ["verify"]);
const rsaAlgorithm = rsaPublic.algorithm as webcrypto.RsaHashedKeyAlgorithm;
console.log("rsa", rsaPublic.type, rsaPublic.extractable, rsaPublic.usages.join(","), rsaAlgorithm.name, rsaAlgorithm.modulusLength, rsaAlgorithm.hash.name);
const rsaSignature = await crypto.subtle.sign({ name: "RSA-PSS", saltLength: 32 }, rsa, Buffer.from("signed"));
console.log("rsa verify", await crypto.subtle.verify({ name: "RSA-PSS", saltLength: 32 }, rsaPublic, rsaSignature, Buffer.from("signed")));

const ecdh = await crypto.subtle.importKey(
  "jwk",
  {
    kty: "EC",
    crv: "P-256",
    x: "EOqDlhcTYVchChRDUHhnn_qDeDaLUbUdyrTTwImASTM",
    y: "evKit-VCLHUMj9s9NRX8dPOgweWQlm-35U0ACQajuzY",
    d: "iK8e568E3TXpqdE29i-ibynUFtoA6Yj1cQ4oKqqFaDU",
  },
  { name: "ECDH", namedCurve: "P-256" },
  true,
  ["deriveBits"],
);
const ecdhPublic = await crypto.subtle.getPublicKey(ecdh, []);
console.log("ecdh", ecdhPublic.type, ecdhPublic.extractable, JSON.stringify(ecdhPublic.usages), ecdhPublic.algorithm.name);
console.log("ecdh raw", hex(await crypto.subtle.exportKey("raw", ecdhPublic)));

const x25519 = await crypto.subtle.importKey(
  "jwk",
  {
    kty: "OKP",
    crv: "X25519",
    x: "MKqXLdZdFxLhjsU2Dp30SqhZQBbPdPDIi2iE_Zt_7w0",
    d: "-Ize_4HLUW6z0ix4iizHNDnHidD6fISAk-sOCtRzXEc",
  },
  "X25519",
  true,
  ["deriveBits"],
);
const x25519Public = await crypto.subtle.getPublicKey(x25519, []);
console.log("x25519", x25519Public.type, x25519Public.extractable, JSON.stringify(x25519Public.usages), x25519Public.algorithm.name);
console.log("x25519 raw", hex(await crypto.subtle.exportKey("raw", x25519Public)));

const oaep = await crypto.subtle.importKey("pkcs8", privateDer, { name: "RSA-OAEP", hash: "SHA-256" }, true, ["decrypt"]);
const oaepPublic = await crypto.subtle.getPublicKey(oaep, ["encrypt", "wrapKey"]);
console.log("rsa-oaep", oaepPublic.type, oaepPublic.usages.join(","), oaepPublic.algorithm.name);
const sealed = await crypto.subtle.encrypt({ name: "RSA-OAEP" }, oaepPublic, Buffer.from("plaintext"));
console.log("rsa-oaep round trip", sealed.byteLength, Buffer.from(await crypto.subtle.decrypt({ name: "RSA-OAEP" }, oaep, sealed)).toString());

for (const [label, run] of [
  ["public key", () => crypto.subtle.getPublicKey(ecdsaPublic, ["verify"])],
  ["secret key", async () => crypto.subtle.getPublicKey(await crypto.subtle.generateKey({ name: "AES-GCM", length: 128 }, true, ["encrypt"]), [])],
  ["bad usage", () => crypto.subtle.getPublicKey(ecdsa, ["sign"])],
  ["not a key", () => crypto.subtle.getPublicKey({} as unknown as CryptoKey, [])],
] as const) {
  const result = await run().then(() => "resolved", (error: Error) => `${error.name} ${error.message}`);
  console.log(label, result);
}

// Node answers an already-fulfilled promise: the key wins a race with an
// immediately resolved promise, and both a success and the key-half error
// settle with the reactions queued after them.
const raced = await Promise.race([crypto.subtle.getPublicKey(ecdsa, ["verify"]), Promise.resolve("micro")]);
console.log("race success", typeof raced === "string" ? raced : "key");
const successOrder: string[] = [];
crypto.subtle.getPublicKey(ecdsa, ["verify"]).then(() => successOrder.push("key"));
Promise.resolve().then(() => successOrder.push("micro"));
const errorOrder: string[] = [];
crypto.subtle.getPublicKey(ecdsaPublic, ["verify"]).then(
  () => errorOrder.push("resolved"),
  () => errorOrder.push("error"),
);
Promise.resolve().then(() => errorOrder.push("micro"));
await new Promise((resolve) => setTimeout(resolve, 0));
console.log("order", successOrder.join(","), errorOrder.join(","));
