// Rejections of crypto.crypto.subtle.deriveBits and deriveKey in Node's order:
// argument conversion, the Pbkdf2Params and HkdfParams dictionaries, the
// base key's usages and algorithm, the length rules, and for deriveKey
// the derived key type's normalization and import.
const encoder = new TextEncoder();

async function attempt(label, run) {
  try {
    const value = await run();
    const shown = value instanceof ArrayBuffer ? `ArrayBuffer(${value.byteLength})` : value instanceof CryptoKey ? JSON.stringify(value.algorithm) : value;
    console.log(label, "resolves", shown);
  } catch (e) {
    console.log(label, e.name, e.code, e.message);
  }
}

const password = await crypto.subtle.importKey("raw", encoder.encode("password"), "PBKDF2", false, ["deriveBits", "deriveKey"]);
const ikm = await crypto.subtle.importKey("raw", encoder.encode("input key"), "HKDF", false, ["deriveBits", "deriveKey"]);
const bitsOnly = await crypto.subtle.importKey("raw", encoder.encode("x"), "PBKDF2", false, ["deriveBits"]);
const keyOnly = await crypto.subtle.importKey("raw", encoder.encode("x"), "PBKDF2", false, ["deriveKey"]);
const hmac = await crypto.subtle.importKey("raw", encoder.encode("x"), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
const salt = encoder.encode("salt");
const pbkdf2 = (extra = {}) => ({ name: "PBKDF2", hash: "SHA-256", salt, iterations: 1000, ...extra });
const hkdf = (extra = {}) => ({ name: "HKDF", hash: "SHA-256", salt, info: encoder.encode("info"), ...extra });

await attempt("bits too few", () => crypto.subtle.deriveBits(pbkdf2()));
await attempt("bits not a key", () => crypto.subtle.deriveBits(pbkdf2(), JSON.parse("{}"), 64));
await attempt("bits length null", () => crypto.subtle.deriveBits(pbkdf2(), password, null));
await attempt("bits length undefined", () => crypto.subtle.deriveBits(pbkdf2(), password, undefined));
await attempt("bits length absent", () => crypto.subtle.deriveBits(pbkdf2(), password));
await attempt("bits length 12", () => crypto.subtle.deriveBits(pbkdf2(), password, 12));
await attempt("bits length -1", () => crypto.subtle.deriveBits(pbkdf2(), password, -1));
await attempt("bits length NaN", () => crypto.subtle.deriveBits(pbkdf2(), password, NaN));
await attempt("bits length string", () => crypto.subtle.deriveBits(pbkdf2(), password, "64"));
await attempt("bits unknown", () => crypto.subtle.deriveBits({ name: "SCRYPT" }, password, 64));
await attempt("bits no name", () => crypto.subtle.deriveBits({ hash: "SHA-1" }, password, 64));
await attempt("pbkdf2 iterations 0", () => crypto.subtle.deriveBits(pbkdf2({ iterations: 0 }), password, 64));
await attempt("pbkdf2 iterations 2^31", () => crypto.subtle.deriveBits(pbkdf2({ iterations: 2 ** 31 }), password, 64));
await attempt("pbkdf2 iterations -1", () => crypto.subtle.deriveBits(pbkdf2({ iterations: -1 }), password, 64));
await attempt("pbkdf2 no iterations", () => crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt }, password, 64));
await attempt("pbkdf2 no salt", () => crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", iterations: 1 }, password, 64));
await attempt("pbkdf2 no hash", () => crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: 1 }, password, 64));
await attempt("pbkdf2 string", () => crypto.subtle.deriveBits("PBKDF2", password, 64));
await attempt("pbkdf2 md5", () => crypto.subtle.deriveBits(pbkdf2({ hash: "MD5" }), password, 64));
await attempt("pbkdf2 bogus sha", () => crypto.subtle.deriveBits(pbkdf2({ hash: "SHA-999" }), password, 64));
await attempt("pbkdf2 salt string", () => crypto.subtle.deriveBits(pbkdf2({ salt: "salt" }), password, 64));
await attempt("pbkdf2 hkdf key", () => crypto.subtle.deriveBits(pbkdf2(), ikm, 64));
await attempt("pbkdf2 hmac key", () => crypto.subtle.deriveBits(pbkdf2(), hmac, 64));
await attempt("pbkdf2 no deriveBits usage", () => crypto.subtle.deriveBits(pbkdf2(), keyOnly, 64));
await attempt("hkdf no info", () => crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt }, ikm, 64));
await attempt("hkdf no salt", () => crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", info: salt }, ikm, 64));
await attempt("hkdf info 1025 bytes", () => crypto.subtle.deriveBits(hkdf({ info: new Uint8Array(1025) }), ikm, 64));
await attempt("hkdf over maximum", () => crypto.subtle.deriveBits(hkdf({ hash: "SHA-1" }), ikm, 255 * 20 * 8 + 8));
await attempt("hkdf length 4", () => crypto.subtle.deriveBits(hkdf(), ikm, 4));
await attempt("hkdf null", () => crypto.subtle.deriveBits(hkdf(), ikm, null));

const aes = { name: "AES-GCM", length: 128 };
await attempt("key too few", () => crypto.subtle.deriveKey(pbkdf2(), password, aes, true));
await attempt("key not a key", () => crypto.subtle.deriveKey(pbkdf2(), "key", aes, true, ["encrypt"]));
await attempt("key no deriveKey usage", () => crypto.subtle.deriveKey(pbkdf2(), bitsOnly, aes, true, ["encrypt"]));
await attempt("key mismatch", () => crypto.subtle.deriveKey(hkdf(), password, aes, true, ["encrypt"]));
await attempt("key aes no length", () => crypto.subtle.deriveKey(pbkdf2(), password, { name: "AES-GCM" }, true, ["encrypt"]));
await attempt("key aes length 100", () => crypto.subtle.deriveKey(pbkdf2(), password, { name: "AES-CBC", length: 100 }, true, ["encrypt"]));
await attempt("key aes sign usage", () => crypto.subtle.deriveKey(pbkdf2(), password, aes, true, ["sign"]));
await attempt("key aes no usages", () => crypto.subtle.deriveKey(pbkdf2(), password, aes, true, []));
await attempt("key hmac no hash", () => crypto.subtle.deriveKey(pbkdf2(), password, { name: "HMAC" }, true, ["sign"]));
await attempt("key hmac length 0", () => crypto.subtle.deriveKey(pbkdf2(), password, { name: "HMAC", hash: "SHA-1", length: 0 }, true, ["sign"]));
await attempt("key hmac length 100", () => crypto.subtle.deriveKey(pbkdf2(), password, { name: "HMAC", hash: "SHA-1", length: 100 }, true, ["sign"]));
await attempt("key hkdf type", () => crypto.subtle.deriveKey(pbkdf2(), password, "HKDF", false, ["deriveBits"]));
await attempt("key unknown type", () => crypto.subtle.deriveKey(pbkdf2(), password, { name: "TWOFISH" }, true, ["encrypt"]));
await attempt("key pbkdf2 type", () => crypto.subtle.deriveKey(hkdf(), ikm, { name: "PBKDF2" }, false, ["deriveKey"]));
await attempt("key ok", () => crypto.subtle.deriveKey(pbkdf2(), password, aes, false, ["encrypt"]));
