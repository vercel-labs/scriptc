// @normalize-pid
// createCipheriv/createDecipheriv key and IV arguments from JavaScript:
// strings in every Buffer encoding, Buffer, typed-array, DataView and
// ArrayBuffer keys and IVs, secret KeyObjects, private and public
// KeyObjects (Node's ERR_CRYPTO_INVALID_KEY_OBJECT_TYPE), WebCrypto
// CryptoKeys (a secret key supplies its bytes and reports DEP0203 once per
// process, an asymmetric one is refused), and the key, IV and encoding
// errors around them.
const crypto = require("node:crypto");

function attempt(label, run) {
  try {
    const result = run();
    console.log(label, "ok", typeof result === "string" ? result : String(result));
  } catch (e) {
    console.log(label, "threw", e.name, e.code, "|", e.message);
  }
}

const raw16 = Buffer.alloc(16, 1);
const iv16 = Buffer.alloc(16, 2);

function cbcSeal(key, options) {
  const cipher = crypto.createCipheriv("aes-128-cbc", key, iv16, options);
  return Buffer.concat([cipher.update("plaintext"), cipher.final()]).toString("hex");
}

function sealWithIv(iv) {
  const cipher = crypto.createCipheriv("aes-128-cbc", raw16, iv);
  return Buffer.concat([cipher.update("plaintext"), cipher.final()]).toString("hex");
}

const reference = cbcSeal(raw16);
console.log("buffer key", reference);
console.log("string utf8 key", cbcSeal(raw16.toString("utf8")) === reference);
console.log("string hex key", cbcSeal(raw16.toString("hex"), { encoding: "hex" }) === reference);
console.log("string base64 key", cbcSeal(raw16.toString("base64"), { encoding: "base64" }) === reference);
console.log("string base64url key", cbcSeal(raw16.toString("base64url"), { encoding: "base64url" }) === reference);
console.log("string latin1 key", cbcSeal(raw16.toString("latin1"), { encoding: "latin1" }) === reference);
console.log("string ascii key", cbcSeal(raw16.toString("latin1"), { encoding: "ascii" }) === reference);
console.log("string utf16le key", cbcSeal(raw16.toString("utf16le"), { encoding: "utf16le" }) === reference);
console.log("string binary key", cbcSeal(raw16.toString("latin1"), { encoding: "binary" }) === reference);
console.log("string buffer key", cbcSeal(raw16.toString("utf8"), { encoding: "buffer" }) === reference);
console.log("string uppercase hex", cbcSeal(raw16.toString("hex"), { encoding: "HEX" }) === reference);

const u16 = new Uint16Array(8).fill(0x0101);
const backing = new Uint8Array(20).fill(1);
console.log("uint16 key", cbcSeal(u16) === reference);
console.log("uint8 subarray key", cbcSeal(backing.subarray(2, 18)) === reference);
console.log("arraybuffer key", cbcSeal(backing.slice(2, 18).buffer) === reference);
console.log("dataview key", cbcSeal(new DataView(backing.buffer, 2, 16)) === reference);

attempt("short string key", () => cbcSeal("0123456789abcde"));
attempt("string key unknown encoding", () => cbcSeal(raw16.toString("hex"), { encoding: "nope" }));
attempt("string key number encoding", () => cbcSeal(raw16.toString("hex"), { encoding: 5 }));
attempt("key number", () => cbcSeal(5));
attempt("key null", () => cbcSeal(null));
attempt("key undefined", () => cbcSeal(undefined));
attempt("key boolean", () => cbcSeal(true));
attempt("key object", () => cbcSeal({ length: 16 }));
attempt("key array", () => cbcSeal([1, 2, 3]));
attempt("key function", () => cbcSeal(() => {}));

const ivReference = sealWithIv(iv16);
console.log("iv buffer", ivReference);
console.log("iv string", sealWithIv(iv16.toString("utf8")) === ivReference);
console.log("iv unicode string", sealWithIv("é".repeat(8)) !== ivReference);
console.log("iv uint16", sealWithIv(new Uint16Array(8).fill(0x0202)) === ivReference);
console.log("iv arraybuffer", sealWithIv(new Uint8Array(16).fill(2).buffer) === ivReference);
console.log("iv dataview", sealWithIv(new DataView(new Uint8Array(20).fill(2).buffer, 2, 16)) === ivReference);
attempt("iv short string", () => sealWithIv("short"));
attempt("iv hex-looking string", () => sealWithIv("00112233445566778899aabbccddeeff"));
attempt("iv number", () => sealWithIv(5));
attempt("iv null", () => sealWithIv(null));
attempt("iv boolean", () => sealWithIv(false));
attempt("iv secret keyobject", () => sealWithIv(crypto.createSecretKey(iv16)));

const secret = crypto.createSecretKey(raw16);
const secret32 = crypto.createSecretKey(Buffer.alloc(32, 1));
console.log("secret keyobject", cbcSeal(secret) === reference);
console.log("secret keyobject utf8", cbcSeal(crypto.createSecretKey(raw16.toString("utf8"))) === reference);
console.log(
  "secret keyobject aes-256",
  (() => {
    const cipher = crypto.createCipheriv("aes-256-cbc", secret32, iv16);
    return Buffer.concat([cipher.update("plaintext"), cipher.final()]).toString("hex");
  })(),
);
attempt("secret keyobject 32 for aes-128", () => cbcSeal(secret32));
attempt("secret keyobject empty", () => cbcSeal(crypto.createSecretKey(Buffer.alloc(0))));
attempt("secret keyobject as aad", () =>
  crypto.createCipheriv("aes-128-gcm", secret, Buffer.alloc(12, 3)).setAAD(/** @type {any} */ (secret)),
);

const rsa = crypto.generateKeyPairSync("rsa", { modulusLength: 1024 });
attempt("public keyobject", () => cbcSeal(rsa.publicKey));
attempt("private keyobject", () => cbcSeal(rsa.privateKey));
attempt("public keyobject decipher", () => crypto.createDecipheriv("aes-128-cbc", rsa.publicKey, iv16));
attempt("private keyobject decipher", () => crypto.createDecipheriv("aes-128-cbc", rsa.privateKey, iv16));
attempt("private keyobject gcm", () =>
  crypto.createCipheriv("aes-128-gcm", rsa.privateKey, Buffer.alloc(12, 3)),
);
attempt("secret keyobject hmac", () => crypto.createHmac("sha256", secret).update("x").digest("hex"));

async function main() {
  const cbcKey = await crypto.subtle.importKey("raw", raw16, "AES-CBC", true, ["encrypt", "decrypt"]);
  const cbcKeyOpaque = await crypto.subtle.importKey("raw", raw16, { name: "AES-CBC" }, false, ["encrypt"]);
  const gcmKey = await crypto.subtle.importKey("raw", raw16, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
  const hmacKey = await crypto.subtle.importKey("raw", Buffer.from("hmac bytes"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);

  console.log("cryptokey cbc", cbcSeal(cbcKey) === reference);
  console.log("cryptokey nonextractable", cbcSeal(cbcKeyOpaque) === reference);
  console.log("cryptokey gcm bytes in cbc", cbcSeal(gcmKey) === reference);
  console.log(
    "cryptokey gcm",
    (() => {
      const cipher = crypto.createCipheriv("aes-128-gcm", gcmKey, Buffer.alloc(12, 3));
      const body = Buffer.concat([cipher.update("plaintext"), cipher.final()]);
      return `${body.toString("hex")}:${cipher.getAuthTag().toString("hex")}`;
    })(),
  );
  console.log("cryptokey hmac", crypto.createHmac("sha256", hmacKey).update("x").digest("hex"));

  const longKey = await crypto.subtle.importKey("raw", Buffer.alloc(32, 1), { name: "AES-CBC" }, false, ["encrypt"]);
  attempt("cryptokey 32 bytes as aes-128", () => cbcSeal(longKey));
  attempt("cryptokey as aad", () =>
    crypto.createCipheriv("aes-128-gcm", raw16, Buffer.alloc(12, 3)).setAAD(/** @type {any} */ (cbcKey)),
  );

  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 1024, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  attempt("public cryptokey cipher", () => cbcSeal(pair.publicKey));
  attempt("private cryptokey cipher", () => cbcSeal(pair.privateKey));
  attempt("public cryptokey decipher", () => crypto.createDecipheriv("aes-128-cbc", pair.publicKey, iv16));
  attempt("private cryptokey decipher", () => crypto.createDecipheriv("aes-128-cbc", pair.privateKey, iv16));
  attempt("private cryptokey hmac", () => crypto.createHmac("sha256", pair.privateKey).update("x").digest("hex"));
}

main();
