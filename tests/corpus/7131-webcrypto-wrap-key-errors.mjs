// Rejections of crypto.crypto.subtle.wrapKey and unwrapKey in Node's order:
// argument conversion, wrap algorithm normalization (AES-KW, then the
// encrypt registry), the wrapping key's algorithm and usages, the export
// or import of the wrapped key, and the cipher's OperationErrors (AES-KW's
// length rules and integrity check), which reject on a later turn.

async function attempt(label, run) {
  try {
    const value = await run();
    const shown = value instanceof ArrayBuffer ? `ArrayBuffer(${value.byteLength})` : value instanceof CryptoKey ? JSON.stringify([value.algorithm, value.usages]) : value;
    console.log(label, "resolves", shown);
  } catch (e) {
    console.log(label, e.name, e.code, e.message);
  }
}

const kek = await crypto.subtle.importKey("raw", new Uint8Array(16).fill(1), "AES-KW", true, ["wrapKey", "unwrapKey"]);
const unwrapOnly = await crypto.subtle.importKey("raw", new Uint8Array(16).fill(1), "AES-KW", true, ["unwrapKey"]);
const gcm = await crypto.subtle.importKey("raw", new Uint8Array(16), "AES-GCM", true, ["wrapKey", "unwrapKey"]);
const hmac20 = await crypto.subtle.importKey("raw", new Uint8Array(20).fill(2), { name: "HMAC", hash: "SHA-256" }, true, ["sign"]);
const hmac32 = await crypto.subtle.importKey("raw", new Uint8Array(32).fill(2), { name: "HMAC", hash: "SHA-256" }, true, ["sign"]);
const locked = await crypto.subtle.importKey("raw", new Uint8Array(16), "AES-CBC", false, ["encrypt"]);
const password = await crypto.subtle.importKey("raw", new Uint8Array(4), "PBKDF2", false, ["deriveBits"]);
const hs256 = { name: "HMAC", hash: "SHA-256" };

await attempt("wrap too few", () => crypto.subtle.wrapKey("raw", hmac32, kek));
await attempt("wrap bad format", () => crypto.subtle.wrapKey("pem", hmac32, kek, "AES-KW"));
await attempt("wrap key not a key", () => crypto.subtle.wrapKey("raw", JSON.parse("{}"), kek, "AES-KW"));
await attempt("wrap wrapping key not a key", () => crypto.subtle.wrapKey("raw", hmac32, JSON.parse("{}"), "AES-KW"));
await attempt("wrap unknown algorithm", () => crypto.subtle.wrapKey("raw", hmac32, kek, "AES-XTS"));
await attempt("wrap no name", () => crypto.subtle.wrapKey("raw", hmac32, kek, {}));
await attempt("wrap gcm without iv", () => crypto.subtle.wrapKey("raw", hmac32, gcm, "AES-GCM"));
await attempt("wrap mismatch", () => crypto.subtle.wrapKey("raw", hmac32, gcm, "AES-KW"));
await attempt("wrap ctr on gcm key", () => crypto.subtle.wrapKey("raw", hmac32, gcm, { name: "AES-CTR", counter: new Uint8Array(16), length: 64 }));
await attempt("wrap missing usage", () => crypto.subtle.wrapKey("raw", hmac32, unwrapOnly, "AES-KW"));
await attempt("wrap pbkdf2 key", () => crypto.subtle.wrapKey("raw", password, kek, "AES-KW"));
await attempt("wrap non-extractable", () => crypto.subtle.wrapKey("raw", locked, kek, "AES-KW"));
await attempt("wrap spki", () => crypto.subtle.wrapKey("spki", hmac32, kek, "AES-KW"));
await attempt("wrap 20 bytes with AES-KW", () => crypto.subtle.wrapKey("raw", hmac20, kek, "AES-KW"));
await attempt("wrap 20 bytes with AES-GCM", () => crypto.subtle.wrapKey("raw", hmac20, gcm, { name: "AES-GCM", iv: new Uint8Array(12) }));

const wrapped = new Uint8Array(await crypto.subtle.wrapKey("raw", hmac32, kek, "AES-KW"));
const tampered = wrapped.slice();
tampered[3] ^= 1;
const notJson = await crypto.subtle.wrapKey("raw", hmac32, kek, "AES-KW");
await attempt("unwrap too few", () => crypto.subtle.unwrapKey("raw", wrapped, kek, "AES-KW", hs256, true));
await attempt("unwrap data string", () => crypto.subtle.unwrapKey("raw", "x", kek, "AES-KW", hs256, true, ["sign"]));
await attempt("unwrap not a key", () => crypto.subtle.unwrapKey("raw", wrapped, JSON.parse("{}"), "AES-KW", hs256, true, ["sign"]));
await attempt("unwrap bad usage name", () => crypto.subtle.unwrapKey("raw", wrapped, kek, "AES-KW", hs256, true, ["fly"]));
await attempt("unwrap hmac without hash", () => crypto.subtle.unwrapKey("raw", wrapped, kek, "AES-KW", { name: "HMAC" }, true, ["sign"]));
await attempt("unwrap unknown key algorithm", () => crypto.subtle.unwrapKey("raw", wrapped, kek, "AES-KW", "TWOFISH", true, ["sign"]));
await attempt("unwrap mismatch", () => crypto.subtle.unwrapKey("raw", wrapped, gcm, "AES-KW", hs256, true, ["sign"]));
await attempt("unwrap missing usage", async () => crypto.subtle.unwrapKey("raw", wrapped, await crypto.subtle.importKey("raw", new Uint8Array(16).fill(1), "AES-KW", true, ["wrapKey"]), "AES-KW", hs256, true, ["sign"]));
await attempt("unwrap tampered", () => crypto.subtle.unwrapKey("raw", tampered, kek, "AES-KW", hs256, true, ["sign"]));
await attempt("unwrap 16 bytes", () => crypto.subtle.unwrapKey("raw", new Uint8Array(16), kek, "AES-KW", hs256, true, ["sign"]));
await attempt("unwrap 28 bytes", () => crypto.subtle.unwrapKey("raw", new Uint8Array(28), kek, "AES-KW", hs256, true, ["sign"]));
await attempt("unwrap bad key usage", () => crypto.subtle.unwrapKey("raw", wrapped, kek, "AES-KW", hs256, true, ["encrypt"]));
await attempt("unwrap empty usages", () => crypto.subtle.unwrapKey("raw", wrapped, kek, "AES-KW", hs256, true, []));
await attempt("unwrap as pbkdf2", () => crypto.subtle.unwrapKey("raw", wrapped, kek, "AES-KW", "PBKDF2", false, ["deriveBits"]));
await attempt("unwrap as extractable pbkdf2", () => crypto.subtle.unwrapKey("raw", wrapped, kek, "AES-KW", "PBKDF2", true, ["deriveBits"]));
await attempt("unwrap raw bytes as jwk", () => crypto.subtle.unwrapKey("jwk", notJson, kek, "AES-KW", hs256, true, ["sign"]));
const jwkWrapped = await crypto.subtle.wrapKey("jwk", hmac32, kek, "AES-KW");
await attempt("unwrap jwk with other usages", () => crypto.subtle.unwrapKey("jwk", jwkWrapped, kek, "AES-KW", hs256, true, ["sign", "verify"]));
await attempt("unwrap jwk as AES", () => crypto.subtle.unwrapKey("jwk", jwkWrapped, kek, "AES-KW", "AES-GCM", true, ["encrypt"]));
await attempt("unwrap jwk ok", () => crypto.subtle.unwrapKey("jwk", jwkWrapped, kek, "AES-KW", hs256, false, ["sign"]));
