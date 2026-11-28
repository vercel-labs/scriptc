// WebCrypto hash parameter shapes: a hash named by string or object in HMAC
// import, RSA key generation and ECDSA sign/verify, with the unsupported
// names' NotSupportedError.
import * as crypto from "node:crypto";

const s = crypto.subtle;
const key = Buffer.alloc(32, 1);
for (const hash of ["SHA-256", { name: "SHA-256" }, "SHA-1", { name: "SHA-384" }, "SHA-512"]) {
  const k = await s.importKey("raw", key, { name: "HMAC", hash }, false, ["sign"]);
  console.log("hmac", JSON.stringify(hash), k.algorithm.hash.name);
}
for (const hash of ["sha256", { name: "sha256" }, "SHA-999"]) {
  try {
    await s.importKey("raw", key, { name: "HMAC", hash }, false, ["sign"]);
  } catch (e) {
    console.log("hmac bad", JSON.stringify(hash), e.name, e.constructor.name);
  }
}
for (const hash of ["SHA-256", { name: "SHA-256" }]) {
  const k = await s.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 1024, publicExponent: new Uint8Array([1, 0, 1]), hash },
    true,
    ["sign", "verify"],
  );
  console.log(
    "rsa",
    JSON.stringify(hash),
    k.privateKey.algorithm.hash.name,
    k.privateKey.algorithm.modulusLength,
    k.privateKey.algorithm.publicExponent.byteLength,
  );
}
const ec = await s.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
for (const hash of ["SHA-256", { name: "SHA-256" }]) {
  const sig = await s.sign({ name: "ECDSA", hash }, ec.privateKey, Buffer.from("x"));
  console.log("ecdsa", JSON.stringify(hash), sig.byteLength, await s.verify({ name: "ECDSA", hash }, ec.publicKey, sig, Buffer.from("x")));
}
