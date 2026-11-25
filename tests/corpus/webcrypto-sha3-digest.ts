// crypto.subtle.digest with the experimental SHA-3 digests: SHA3-256, SHA3-384 and SHA3-512, named as strings and as algorithms, over the empty input and a longer one. Each digest warns once per process, as Node does, so the program uses every one twice.
// @normalize-pid
import type { webcrypto } from "node:crypto";

const hex = (bytes: ArrayBuffer): string => Buffer.from(bytes).toString("hex");
const data = Buffer.from("abc");

for (const name of ["SHA3-256", "SHA3-384", "SHA3-512"]) {
  const digest = await crypto.subtle.digest(name, data);
  const again = await crypto.subtle.digest({ name }, new Uint8Array(0));
  console.log(name, digest.byteLength, hex(digest), again.byteLength, hex(again).slice(0, 16));
}

const lower = await crypto.subtle.digest("sha3-256", Buffer.from("The quick brown fox jumps over the lazy dog"));
console.log("sha3-256 text", hex(lower));

const missing = await crypto.subtle
  .digest({ name: "SHA3-256" } as unknown as AlgorithmIdentifier, data)
  .then((value) => value.byteLength, (error: Error) => `${error.name} ${error.message}`);
console.log("object form", missing);

const unknown = await crypto.subtle
  .digest("SHA3-224", data)
  .then(() => "resolved", (error: Error) => `${error.name} ${error.message}`);
console.log("unknown", unknown);

// SHA-3 outside digest: the signature algorithms sign and verify with a
// SHA-3 hash, and the KDFs derive from one. The signatures checked here
// were produced by Node over the embedded keys, so a wrong digest cannot
// verify itself.
const ecdsaPublic: JsonWebKey = {
  kty: "EC",
  crv: "P-256",
  x: "bwVQJQbxH0drZPdS-VU6OSiIm4GtyR0047-zMLe9aWA",
  y: "RYRZY23rwKVLLy-q-IIjqOuUCk7b-A7B-CtSxO6GhrI",
};
const ecdsaSignatureHex =
  "7c1b5e49f61ab158170e3e9ca8c238a355012b2153a5e781fd61b9e893d56bbdaebc6de8a4e85a87b351fb90b2a3e475628e1774469f94d8c2bededd53e6070a";
const ecdsaPublicKey = await crypto.subtle.importKey("jwk", ecdsaPublic, { name: "ECDSA", namedCurve: "P-256" }, true, ["verify"]);
for (const hash of ["SHA3-256", "SHA3-384", "SHA3-512"]) {
  console.log(
    "ecdsa",
    hash,
    await crypto.subtle.verify(
      { name: "ECDSA", hash },
      ecdsaPublicKey,
      Buffer.from(hash === "SHA3-256" ? ecdsaSignatureHex : "00", "hex"),
      Buffer.from("signed data"),
    ),
  );
}

const rsaSpki = Buffer.from(
  "MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDPs90Z6zHaYZ7xxoUBCnozdM9uiasvXJeWkUQXzdZNOeg1Fi/GEW80LAKH7l/CNCZIQfMDVjHJSLlxXMxj8sXuX4HQ9LZ1bpWwOWBtoT+wm1JF23TXBuYWT2uUyFqwv1vH94K5Ufb0VOQewEeMqEQQWk/e1JM5i9DWPobkcqfNrwIDAQAB",
  "base64",
);
const rsaPkcs8 = Buffer.from(
  "MIICeAIBADANBgkqhkiG9w0BAQEFAASCAmIwggJeAgEAAoGBAM+z3RnrMdphnvHGhQEKejN0z26Jqy9cl5aRRBfN1k056DUWL8YRbzQsAofuX8I0JkhB8wNWMclIuXFczGPyxe5fgdD0tnVulbA5YG2hP7CbUkXbdNcG5hZPa5TIWrC/W8f3grlR9vRU5B7AR4yoRBBaT97UkzmL0NY+huRyp82vAgMBAAECgYEAs8TWYn+Jl50Up+iN57e8ytqYSvEG5Cg838n9aKj0icTL8V6xnLosSLiqvCIaaYkfdTz3a3ToBHJYZwDNutg+bKFsuea1GCI6U36LWsBAdoPhzP57yr6H4dvwSVeRlrFWfWz9dDHqJiYunMgWZM/oQLktdCelkFrVhGDRDaXmq4kCQQD6FrouLKrz2yHSnZ90/dyDbvC95mm/y16Fak6aKYMUZyCNTXamG3UHZqCbEs/qadMay6D3aOolE1rmX+jHSSmdAkEA1Jyo+RAnJ9xLGzPKfxYR52ydRmyKgObOSJJGtYmfIiysIQOftV12ZGi7fVRFa9trOethIRpn4QCT+J2hyReIuwJBALtP1nbLIeevky+qu0nm8gjHSS0SrNXoPo1yyBiTSwg3DZyIDnvvSMIYTeaYOn36cRE6vv9P5z+JtaWi5DiPRckCQCz18BmzW8RnJo7bFfBoF2MsKdoxq9x0cp0QKdnL/5X3gnL81DJDUH0NVNC9GG0lmnhGGWUps1v2hlQl6Yef7W8CQQDXobXQrC1OnVPDR7+kvIM9PdKNzIUSk87jTN3MuZ+EZy552LJPg5wKvNYv5G81IrfN8PW0bmS5qSXckRs2fi1w",
  "base64",
);
const pssSignature = Buffer.from(
  "b4aef6775506b379f4fa2ffce6d3f735c5f671366a595d44d16967c92596194a7bd601153e6855f9b300b902c96c90e49cc86bbc8b0be23e041184a5375ce921bae7f11c350dcc1ccc941d3c0a08c99b39a6adedfc5ac16401b0b9e29bbe8a99b5207ab5e09388a84a2b6ed39afe025e7694ac78693869d816fae4a7f05ddbc8",
  "hex",
);
const rsaPssPublic = await crypto.subtle.importKey("spki", rsaSpki, { name: "RSA-PSS", hash: "SHA3-384" }, true, ["verify"]);
console.log("pss sha3-384", await crypto.subtle.verify({ name: "RSA-PSS", saltLength: 32 }, rsaPssPublic, pssSignature, Buffer.from("signed data")));
const rsaPssPrivate = await crypto.subtle.importKey("pkcs8", rsaPkcs8, { name: "RSA-PSS", hash: "SHA3-256" }, true, ["sign"]);
const freshSignature = await crypto.subtle.sign({ name: "RSA-PSS", saltLength: 32 }, rsaPssPrivate, Buffer.from("fresh"));
console.log("pss sign", freshSignature.byteLength);

const rsaV15Public = await crypto.subtle.importKey("spki", rsaSpki, { name: "RSASSA-PKCS1-v1_5", hash: "SHA3-256" }, true, ["verify"]);
const v15Signature = Buffer.from(
  "85841909cbb85c6d73903ff568af98bf046df10263197a1c2a39526b8bc2c187f73af70adb805b99d5d874922e58c540b92661c4e99287d95be25d28022366d826689f24d7c206aa6b4ff8d0a0bc2c777feca778b2feb27cf8ddb34166b5f93d4fb721a13de653332e2a9282af21ced9597fcb820c7bd3cf06c628cefb13ac9a",
  "hex",
);
console.log(
  "rsassa sha3-256",
  await crypto.subtle.verify("RSASSA-PKCS1-v1_5", rsaV15Public, v15Signature, Buffer.from("signed data")),
  await crypto.subtle.verify("RSASSA-PKCS1-v1_5", rsaV15Public, v15Signature, Buffer.from("other data")),
);

const hmacKey = await crypto.subtle.importKey("raw", Buffer.from("key"), { name: "HMAC", hash: "SHA3-256" }, false, ["sign"]);
console.log("hmac sha3", hex(await crypto.subtle.sign("HMAC", hmacKey, Buffer.from("data"))));
const hmacGenerated = await crypto.subtle
  .generateKey({ name: "HMAC", hash: "SHA3-256" }, true, ["sign"])
  .then((key) => `${key.algorithm.name} ${(key.algorithm as webcrypto.HmacKeyAlgorithm).length}`, (error: Error) => `${error.name} ${error.message}`);
console.log("hmac generate", hmacGenerated);

const hkdfKey = await crypto.subtle.importKey("raw", new Uint8Array(32).fill(1), "HKDF", false, ["deriveBits"]);
const hkdfBits = await crypto.subtle.deriveBits(
  { name: "HKDF", hash: "SHA3-256", salt: new Uint8Array(8).fill(2), info: new Uint8Array(4).fill(3) },
  hkdfKey,
  128,
);
console.log("hkdf sha3", hex(hkdfBits));
const pbkdf2Key = await crypto.subtle.importKey("raw", new Uint8Array(16).fill(1), "PBKDF2", false, ["deriveBits"]);
const pbkdf2Bits = await crypto.subtle.deriveBits(
  { name: "PBKDF2", hash: "SHA3-256", salt: new Uint8Array(8).fill(2), iterations: 10 },
  pbkdf2Key,
  128,
);
console.log("pbkdf2 sha3", hex(pbkdf2Bits));

// A SHA-3 hash needs an explicit length to derive an HMAC key, as it does
// to generate one; SHA-256 still defaults to 512 bits.
const hkdfDeriveBase = await crypto.subtle.importKey("raw", new Uint8Array(16), "HKDF", false, ["deriveKey"]);
const derivedNoLength = await crypto.subtle
  .deriveKey(
    { name: "HKDF", hash: "SHA3-256", salt: new Uint8Array(0), info: new Uint8Array(0) },
    hkdfDeriveBase,
    { name: "HMAC", hash: "SHA3-256" },
    true,
    ["sign"],
  )
  .then(() => "resolved", (error: Error) => `${error.name} ${error.message}`);
console.log("derive hmac sha3", derivedNoLength);
const derivedWithLength = await crypto.subtle.deriveKey(
  { name: "HKDF", hash: "SHA3-256", salt: new Uint8Array(0), info: new Uint8Array(0) },
  hkdfDeriveBase,
  { name: "HMAC", hash: "SHA3-256", length: 128 },
  true,
  ["sign"],
);
console.log("derive hmac length", (derivedWithLength.algorithm as webcrypto.HmacKeyAlgorithm).length);
const derivedSha256 = await crypto.subtle.deriveKey(
  { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: new Uint8Array(0) },
  hkdfDeriveBase,
  { name: "HMAC", hash: "SHA-256" },
  true,
  ["sign"],
);
console.log("derive hmac sha256", (derivedSha256.algorithm as webcrypto.HmacKeyAlgorithm).length);

// A SHA-3 RSA key exports without a JWK "alg", and Node accepts any "alg"
// when importing one; a SHA-256 key still checks the member.
const pssPairSha3 = await crypto.subtle.generateKey(
  { name: "RSA-PSS", hash: "SHA3-384", modulusLength: 1024, publicExponent: new Uint8Array([1, 0, 1]) },
  true,
  ["sign", "verify"],
);
const pssJwkSha3 = await crypto.subtle.exportKey("jwk", pssPairSha3.publicKey);
console.log("pss sha3 jwk", pssJwkSha3.alg === undefined, Object.keys(pssJwkSha3).sort().join(","));
for (const alg of ["PS384", "RS384", "nope"]) {
  const imported = await crypto.subtle
    .importKey("jwk", { ...pssJwkSha3, alg }, { name: "RSA-PSS", hash: "SHA3-384" }, true, ["verify"])
    .then(() => "resolved", (error: Error) => `${error.name} ${error.message}`);
  console.log("import sha3 alg", alg, imported);
}
const pssPairSha256 = await crypto.subtle.generateKey(
  { name: "RSA-PSS", hash: "SHA-256", modulusLength: 1024, publicExponent: new Uint8Array([1, 0, 1]) },
  true,
  ["sign", "verify"],
);
const pssJwkSha256 = await crypto.subtle.exportKey("jwk", pssPairSha256.publicKey);
console.log("pss sha256 jwk alg", pssJwkSha256.alg);
const alphaMismatch = await crypto.subtle
  .importKey("jwk", { ...pssJwkSha256, alg: "RS256" }, { name: "RSA-PSS", hash: "SHA-256" }, true, ["verify"])
  .then(() => "resolved", (error: Error) => `${error.name} ${error.message}`);
console.log("import sha256 mismatch", alphaMismatch);
