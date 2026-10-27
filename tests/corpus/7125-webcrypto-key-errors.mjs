// Rejections of crypto.crypto.subtle.generateKey, exportKey and importKey for
// secret keys, in Node's order: argument conversion, algorithm
// normalization, usages, then the per-algorithm checks, and the JSON Web
// Key validation of oct keys.

async function attempt(label, run) {
  try {
    const value = await run();
    const shown = value instanceof ArrayBuffer ? `ArrayBuffer(${value.byteLength})` : value instanceof CryptoKey ? JSON.stringify(value.algorithm) : JSON.stringify(value);
    console.log(label, "resolves", shown);
  } catch (e) {
    console.log(label, e.name, e.code, e.message);
  }
}

await attempt("generate too few", () => crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-1" }, true));
await attempt("generate unknown", () => crypto.subtle.generateKey({ name: "FOO" }, true, ["sign"]));
await attempt("generate PBKDF2", () => crypto.subtle.generateKey({ name: "PBKDF2" }, false, ["deriveBits"]));
await attempt("generate no name", () => crypto.subtle.generateKey({ hash: "SHA-1" }, true, ["sign"]));
await attempt("generate hmac string", () => crypto.subtle.generateKey("HMAC", true, ["sign"]));
await attempt("generate hmac no hash", () => crypto.subtle.generateKey({ name: "HMAC" }, true, ["sign"]));
await attempt("generate hmac md5", () => crypto.subtle.generateKey({ name: "HMAC", hash: "MD5" }, true, ["sign"]));
await attempt("generate hmac bogus hash", () => crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-999" }, true, ["sign"]));
await attempt("generate hmac length 0", () => crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-1", length: 0 }, true, ["sign"]));
await attempt("generate hmac length NaN", () => crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-1", length: NaN }, true, ["sign"]));
await attempt("generate hmac length -1", () => crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-1", length: -1 }, true, ["sign"]));
await attempt("generate hmac encrypt", () => crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-1" }, true, ["encrypt"]));
await attempt("generate hmac no usages", () => crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-1" }, true, []));
await attempt("generate bad usage", () => crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-1" }, true, ["fly"]));
await attempt("generate usages string", () => crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-1" }, true, "sign"));
await attempt("generate aes no length", () => crypto.subtle.generateKey({ name: "AES-GCM" }, true, ["encrypt"]));
await attempt("generate aes length 100", () => crypto.subtle.generateKey({ name: "AES-GCM", length: 100 }, true, ["encrypt"]));
await attempt("generate aes length 70000", () => crypto.subtle.generateKey({ name: "AES-CBC", length: 70000 }, true, ["encrypt"]));
await attempt("generate aes sign", () => crypto.subtle.generateKey({ name: "AES-CTR", length: 128 }, true, ["sign"]));
await attempt("generate aes-kw encrypt", () => crypto.subtle.generateKey({ name: "AES-KW", length: 128 }, true, ["encrypt"]));
await attempt("generate aes no usages", () => crypto.subtle.generateKey({ name: "AES-GCM", length: 128 }, true, []));
await attempt("generate aes string length", async () => (await crypto.subtle.generateKey({ name: "aes-gcm", length: "256" }, true, ["encrypt"])).algorithm);

const hmac = await crypto.subtle.importKey("raw", new Uint8Array(20), { name: "HMAC", hash: "SHA-256" }, true, ["sign"]);
const locked = await crypto.subtle.importKey("raw", new Uint8Array(16), "AES-GCM", false, ["encrypt"]);
const pbkdf2 = await crypto.subtle.importKey("raw", new Uint8Array(4), "PBKDF2", false, ["deriveBits"]);
await attempt("export too few", () => crypto.subtle.exportKey("raw"));
await attempt("export bad format", () => crypto.subtle.exportKey("pem", hmac));
await attempt("export not a key", () => crypto.subtle.exportKey("raw", { type: "secret" }));
await attempt("export spki", () => crypto.subtle.exportKey("spki", hmac));
await attempt("export pkcs8", () => crypto.subtle.exportKey("pkcs8", hmac));
await attempt("export raw-public", () => crypto.subtle.exportKey("raw-public", hmac));
await attempt("export non-extractable", () => crypto.subtle.exportKey("raw", locked));
await attempt("export pbkdf2", () => crypto.subtle.exportKey("raw", pbkdf2));
await attempt("export pbkdf2 jwk", () => crypto.subtle.exportKey("jwk", pbkdf2));

const sixteen = new Uint8Array(16);
await attempt("import aes 15 bytes", () => crypto.subtle.importKey("raw", new Uint8Array(15), "AES-GCM", true, ["encrypt"]));
await attempt("import aes sign", () => crypto.subtle.importKey("raw", sixteen, "AES-GCM", true, ["sign"]));
await attempt("import aes-kw encrypt", () => crypto.subtle.importKey("raw", sixteen, "AES-KW", true, ["encrypt"]));
await attempt("import aes no usages", () => crypto.subtle.importKey("raw", sixteen, "AES-CBC", true, []));
await attempt("import aes spki", () => crypto.subtle.importKey("spki", sixteen, "AES-CBC", true, ["encrypt"]));
await attempt("import aes length ignored", () => crypto.subtle.importKey("raw", sixteen, { name: "AES-CTR", length: 256 }, true, ["encrypt"]));
await attempt("import pbkdf2 extractable", () => crypto.subtle.importKey("raw", sixteen, "PBKDF2", true, ["deriveBits"]));
await attempt("import pbkdf2 sign", () => crypto.subtle.importKey("raw", sixteen, "PBKDF2", false, ["sign"]));
await attempt("import pbkdf2 no usages", () => crypto.subtle.importKey("raw", sixteen, "PBKDF2", false, []));
await attempt("import hkdf jwk", () => crypto.subtle.importKey("jwk", { kty: "oct", k: "AAAA" }, "HKDF", false, ["deriveKey"]));
await attempt("import hkdf pkcs8", () => crypto.subtle.importKey("pkcs8", sixteen, "HKDF", false, ["deriveKey"]));
await attempt("sign with aes key", () => crypto.subtle.sign("HMAC", locked, sixteen));

const hs256 = { name: "HMAC", hash: "SHA-256" };
const jwk = (data, alg = hs256, extractable = true, usages = ["sign"]) => crypto.subtle.importKey("jwk", data, alg, extractable, usages);
await attempt("jwk ok", () => jwk({ kty: "oct", k: "AAECAwQFBgc" }));
await attempt("jwk alg match", () => jwk({ kty: "oct", k: "AAECAwQFBgc", alg: "HS256" }));
await attempt("jwk alg mismatch", () => jwk({ kty: "oct", k: "AAECAwQFBgc", alg: "HS512" }));
await attempt("jwk no kty", () => jwk({ k: "AAECAwQFBgc" }));
await attempt("jwk kty RSA", () => jwk({ kty: "RSA", k: "AAECAwQFBgc" }));
await attempt("jwk no k", () => jwk({ kty: "oct" }));
await attempt("jwk k number", () => jwk({ kty: "oct", k: 5 }));
await attempt("jwk k empty", () => jwk({ kty: "oct", k: "" }));
await attempt("jwk k standard alphabet", () => jwk({ kty: "oct", k: "AA+/AA==" }));
await attempt("jwk k junk", () => jwk({ kty: "oct", k: "!!!!" }));
await attempt("jwk use enc", () => jwk({ kty: "oct", k: "AAECAwQFBgc", use: "enc" }));
await attempt("jwk use sig", () => jwk({ kty: "oct", k: "AAECAwQFBgc", use: "sig" }));
await attempt("jwk key_ops superset", () => jwk({ kty: "oct", k: "AAECAwQFBgc", key_ops: ["sign", "verify", "fly"] }));
await attempt("jwk key_ops missing", () => jwk({ kty: "oct", k: "AAECAwQFBgc", key_ops: ["verify"] }));
await attempt("jwk key_ops duplicate", () => jwk({ kty: "oct", k: "AAECAwQFBgc", key_ops: ["sign", "sign"] }));
await attempt("jwk key_ops string", () => jwk({ kty: "oct", k: "AAECAwQFBgc", key_ops: "sign" }));
await attempt("jwk ext false", () => jwk({ kty: "oct", k: "AAECAwQFBgc", ext: false }));
await attempt("jwk ext false locked", () => jwk({ kty: "oct", k: "AAECAwQFBgc", ext: false }, hs256, false));
await attempt("jwk not an object", () => jwk("key"));
await attempt("jwk null", () => jwk(null));
await attempt("jwk kty symbol", () => jwk({ kty: Symbol("oct"), k: "AA" }));
await attempt("jwk hmac length", () => jwk({ kty: "oct", k: "AAECAwQFBgc" }, { name: "HMAC", hash: "SHA-1", length: 60 }));
await attempt("jwk hmac length mismatch", () => jwk({ kty: "oct", k: "AAECAwQFBgc" }, { name: "HMAC", hash: "SHA-1", length: 128 }));
await attempt("jwk no usages", () => jwk({ kty: "oct", k: "AAECAwQFBgc" }, hs256, true, []));
await attempt("jwk aes", () => jwk({ kty: "oct", k: "AAECAwQFBgcICQoLDA0ODw", alg: "A128GCM" }, "AES-GCM", true, ["encrypt"]));
await attempt("jwk aes alg mismatch", () => jwk({ kty: "oct", k: "AAECAwQFBgcICQoLDA0ODw", alg: "A256GCM" }, "AES-GCM", true, ["encrypt"]));
await attempt("jwk aes use sig", () => jwk({ kty: "oct", k: "AAECAwQFBgcICQoLDA0ODw", use: "sig" }, "AES-GCM", true, ["encrypt"]));
await attempt("jwk aes length", () => jwk({ kty: "oct", k: "AAECAwQFBgc" }, "AES-CBC", true, ["encrypt"]));
