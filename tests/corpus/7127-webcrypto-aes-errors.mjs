// Rejections of crypto.crypto.subtle.encrypt and decrypt in Node's order:
// argument conversion, the AesCbcParams, AesCtrParams and AeadParams
// dictionaries, the key checks, then the cipher's own OperationErrors
// (bad tags, bad padding, IV and counter limits).

async function attempt(label, run) {
  try {
    const value = await run();
    console.log(label, "resolves", value instanceof ArrayBuffer ? `ArrayBuffer(${value.byteLength})` : value);
  } catch (e) {
    console.log(label, e.name, e.code, e.message);
  }
}

const raw = new Uint8Array(16).map((_, i) => i);
const gcm = await crypto.subtle.importKey("raw", raw, "AES-GCM", true, ["encrypt", "decrypt"]);
const cbc = await crypto.subtle.importKey("raw", raw, "AES-CBC", true, ["encrypt", "decrypt"]);
const ctr = await crypto.subtle.importKey("raw", raw, "AES-CTR", true, ["encrypt", "decrypt"]);
const encryptOnly = await crypto.subtle.importKey("raw", raw, "AES-GCM", true, ["encrypt"]);
const hmac = await crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-1" }, true, ["sign"]);
const iv12 = new Uint8Array(12);
const iv16 = new Uint8Array(16);
const data = new TextEncoder().encode("hello world");

await attempt("too few", () => crypto.subtle.encrypt({ name: "AES-GCM", iv: iv12 }, gcm));
await attempt("decrypt too few", () => crypto.subtle.decrypt({ name: "AES-GCM", iv: iv12 }));
await attempt("not a key", () => crypto.subtle.encrypt({ name: "AES-GCM", iv: iv12 }, JSON.parse("{}"), data));
await attempt("data string", () => crypto.subtle.encrypt({ name: "AES-GCM", iv: iv12 }, gcm, "hello"));
await attempt("unknown algorithm", () => crypto.subtle.encrypt({ name: "AES-XTS" }, gcm, data));
await attempt("AES-KW", () => crypto.subtle.encrypt({ name: "AES-KW" }, gcm, data));
await attempt("no name", () => crypto.subtle.encrypt({ iv: iv12 }, gcm, data));
await attempt("string algorithm", () => crypto.subtle.encrypt("AES-GCM", gcm, data));
await attempt("gcm no iv", () => crypto.subtle.encrypt({ name: "AES-GCM" }, gcm, data));
await attempt("gcm iv string", () => crypto.subtle.encrypt({ name: "AES-GCM", iv: "abc" }, gcm, data));
await attempt("gcm aad string", () => crypto.subtle.encrypt({ name: "AES-GCM", iv: iv12, additionalData: "x" }, gcm, data));
await attempt("gcm aad null", () => crypto.subtle.encrypt({ name: "AES-GCM", iv: iv12, additionalData: null }, gcm, data));
await attempt("gcm tag 100", () => crypto.subtle.encrypt({ name: "AES-GCM", iv: iv12, tagLength: 100 }, gcm, data));
await attempt("gcm tag 300", () => crypto.subtle.encrypt({ name: "AES-GCM", iv: iv12, tagLength: 300 }, gcm, data));
await attempt("gcm tag NaN", () => crypto.subtle.encrypt({ name: "AES-GCM", iv: iv12, tagLength: NaN }, gcm, data));
await attempt("gcm tag string", () => crypto.subtle.encrypt({ name: "aes-gcm", iv: iv12, tagLength: "96" }, gcm, data));
await attempt("gcm iv 11 bytes", () => crypto.subtle.encrypt({ name: "AES-GCM", iv: new Uint8Array(11) }, gcm, data));
await attempt("gcm iv 129 bytes", () => crypto.subtle.encrypt({ name: "AES-GCM", iv: new Uint8Array(129) }, gcm, data));
await attempt("gcm iv empty", () => crypto.subtle.encrypt({ name: "AES-GCM", iv: new Uint8Array(0) }, gcm, data));
const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv12 }, gcm, data));
const tampered = sealed.slice();
tampered[0] ^= 1;
await attempt("gcm tampered", () => crypto.subtle.decrypt({ name: "AES-GCM", iv: iv12 }, gcm, tampered));
await attempt("gcm wrong aad", () => crypto.subtle.decrypt({ name: "AES-GCM", iv: iv12, additionalData: data }, gcm, sealed));
await attempt("gcm wrong tag length", () => crypto.subtle.decrypt({ name: "AES-GCM", iv: iv12, tagLength: 96 }, gcm, sealed));
await attempt("gcm shorter than tag", () => crypto.subtle.decrypt({ name: "AES-GCM", iv: iv12 }, gcm, new Uint8Array(15)));
await attempt("gcm tag only", () => crypto.subtle.decrypt({ name: "AES-GCM", iv: iv12 }, gcm, new Uint8Array(16)));
await attempt("cbc no iv", () => crypto.subtle.encrypt({ name: "AES-CBC" }, cbc, data));
await attempt("cbc iv 12 bytes", () => crypto.subtle.encrypt({ name: "AES-CBC", iv: iv12 }, cbc, data));
await attempt("cbc decrypt 15 bytes", () => crypto.subtle.decrypt({ name: "AES-CBC", iv: iv16 }, cbc, new Uint8Array(15)));
await attempt("cbc decrypt empty", () => crypto.subtle.decrypt({ name: "AES-CBC", iv: iv16 }, cbc, new Uint8Array(0)));
const block = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-CBC", iv: iv16 }, cbc, data));
const badPad = block.slice();
badPad[15] ^= 0x55;
await attempt("cbc bad padding", () => crypto.subtle.decrypt({ name: "AES-CBC", iv: iv16 }, cbc, badPad));
await attempt("cbc other iv", () => crypto.subtle.decrypt({ name: "AES-CBC", iv: new Uint8Array(16).fill(1) }, cbc, block));
await attempt("ctr no counter", () => crypto.subtle.encrypt({ name: "AES-CTR", length: 64 }, ctr, data));
await attempt("ctr no length", () => crypto.subtle.encrypt({ name: "AES-CTR", counter: iv16 }, ctr, data));
await attempt("ctr length 0", () => crypto.subtle.encrypt({ name: "AES-CTR", counter: iv16, length: 0 }, ctr, data));
await attempt("ctr length 129", () => crypto.subtle.encrypt({ name: "AES-CTR", counter: iv16, length: 129 }, ctr, data));
await attempt("ctr length 300", () => crypto.subtle.encrypt({ name: "AES-CTR", counter: iv16, length: 300 }, ctr, data));
await attempt("ctr counter 8 bytes", () => crypto.subtle.encrypt({ name: "AES-CTR", counter: new Uint8Array(8), length: 64 }, ctr, data));
await attempt("ctr 1 bit, 3 blocks", () => crypto.subtle.encrypt({ name: "AES-CTR", counter: iv16, length: 1 }, ctr, new Uint8Array(48)));
await attempt("ctr empty", () => crypto.subtle.encrypt({ name: "AES-CTR", counter: iv16, length: 1 }, ctr, new Uint8Array(0)));
await attempt("algorithm mismatch", () => crypto.subtle.encrypt({ name: "AES-CBC", iv: iv16 }, gcm, data));
await attempt("hmac key", () => crypto.subtle.encrypt({ name: "AES-GCM", iv: iv12 }, hmac, data));
await attempt("missing usage", () => crypto.subtle.decrypt({ name: "AES-GCM", iv: iv12 }, encryptOnly, sealed));
