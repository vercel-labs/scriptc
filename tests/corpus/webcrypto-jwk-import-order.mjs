// importKey("jwk", …) checks the usages against the key's kind and its
// public/private shape before it reads the JWK, so a malformed JWK whose
// usages the key cannot take answers the usage SyntaxError first, and a
// well-formed one reports the key_ops, ext and key-data errors after it.
import * as crypto from "node:crypto";

const show = async (label, f) => {
  try {
    const v = await f();
    console.log(label, "OK", v.type, v.extractable, v.usages.join("/"));
  } catch (e) {
    console.log(label, "THROW", e.name, e.code, e.message);
  }
};
const EC = { kty: "EC", crv: "P-256", x: "AQ", y: "AQ" };
const ecdsa = { name: "ECDSA", namedCurve: "P-256" };

await show("ec sign", async () => crypto.webcrypto.subtle.importKey("jwk", EC, ecdsa, true, ["sign"]));
await show("ec verify", async () => crypto.webcrypto.subtle.importKey("jwk", EC, ecdsa, true, ["verify"]));
await show("ec bad kty sign", async () => crypto.webcrypto.subtle.importKey("jwk", { ...EC, kty: "nope" }, ecdsa, true, ["sign"]));
await show("ec bad kty verify", async () => crypto.webcrypto.subtle.importKey("jwk", { ...EC, kty: "nope" }, ecdsa, true, ["verify"]));
await show("ec bad kty empty usages", async () => crypto.webcrypto.subtle.importKey("jwk", { ...EC, kty: "nope" }, ecdsa, true, []));
await show("ec bad crv sign", async () => crypto.webcrypto.subtle.importKey("jwk", { ...EC, crv: "P-384" }, ecdsa, true, ["sign"]));
await show("ec bad crv verify", async () => crypto.webcrypto.subtle.importKey("jwk", { ...EC, crv: "P-384" }, ecdsa, true, ["verify"]));
await show("ec key_ops sign", async () => crypto.webcrypto.subtle.importKey("jwk", { ...EC, key_ops: ["sign"] }, ecdsa, true, ["verify"]));
await show("ec key_ops encrypt", async () => crypto.webcrypto.subtle.importKey("jwk", { ...EC, key_ops: ["encrypt"] }, ecdsa, true, ["verify"]));
await show("ec ext", async () => crypto.webcrypto.subtle.importKey("jwk", { ...EC, ext: true }, ecdsa, false, ["verify"]));

const rsa = crypto.generateKeyPairSync("rsa", { modulusLength: 1024 });
const rsaPub = rsa.publicKey.export({ format: "jwk" });
await show("rsa bad kty sign", async () => crypto.webcrypto.subtle.importKey("jwk", { kty: "nope", n: rsaPub.n, e: rsaPub.e }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, true, ["sign"]));
await show("rsa bad kty verify", async () => crypto.webcrypto.subtle.importKey("jwk", { kty: "nope", n: rsaPub.n, e: rsaPub.e }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, true, ["verify"]));

const oct = { kty: "oct", k: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" };
const hmac = { name: "HMAC", hash: "SHA-256" };
await show("oct sign", async () => crypto.webcrypto.subtle.importKey("jwk", oct, hmac, true, ["sign"]));
await show("oct bad kty sign", async () => crypto.webcrypto.subtle.importKey("jwk", { ...oct, kty: "nope" }, hmac, true, ["sign"]));
await show("oct bad usage", async () => crypto.webcrypto.subtle.importKey("jwk", oct, hmac, true, ["encrypt"]));
