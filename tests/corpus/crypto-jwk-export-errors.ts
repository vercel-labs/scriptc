// keyObject.export({ format: "jwk" }): the key types Node refuses with
// ERR_CRYPTO_JWK_UNSUPPORTED_KEY_TYPE and the ones each kty/crv exports.
import { KeyObject, createSecretKey, generateKeyPairSync } from "node:crypto";

const log = (...a: unknown[]) => console.log(a.map(String).join(" | "));
const attempt = (label: string, key: KeyObject): void => {
  try { const jwk = key.export({ format: "jwk" }); log(label, "ok", String(jwk.kty), jwk.crv === undefined ? "-" : jwk.crv); }
  catch (e) { const x = e as Error & { code?: string }; log(label, "|", x.name, x.code, "|", x.message); }
};

attempt("rsa-pss public", generateKeyPairSync("rsa-pss", { modulusLength: 2048 }).publicKey);
attempt("rsa-pss private", generateKeyPairSync("rsa-pss", { modulusLength: 2048 }).privateKey);
attempt("rsa public", generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey);
attempt("p-256", generateKeyPairSync("ec", { namedCurve: "prime256v1" }).publicKey);
attempt("p-384", generateKeyPairSync("ec", { namedCurve: "secp384r1" }).publicKey);
attempt("p-521", generateKeyPairSync("ec", { namedCurve: "secp521r1" }).publicKey);
attempt("secp256k1", generateKeyPairSync("ec", { namedCurve: "secp256k1" }).publicKey);
attempt("x25519", generateKeyPairSync("x25519").publicKey);
attempt("x448", generateKeyPairSync("x448").publicKey);
attempt("ed25519", generateKeyPairSync("ed25519").publicKey);
attempt("ml-kem-768", generateKeyPairSync("ml-kem-768").publicKey);
attempt("secret", createSecretKey(Buffer.alloc(32)));
