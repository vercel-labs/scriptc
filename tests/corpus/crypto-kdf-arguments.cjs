// hkdf, hkdfSync, scrypt and scryptSync called with arguments of any type:
// Node's argument checks, in its order, replace compile-time refusals, and
// the derivations themselves answer the same bytes, Buffers and
// ArrayBuffers as the typed lanes. Also pins the result shapes: hkdf's
// ArrayBuffers, scrypt's Buffers including the zero-length one, and the
// callbacks' value types.
const crypto = require("crypto");

function attempt(label, run) {
  try {
    const value = run();
    const shape = Buffer.isBuffer(value)
      ? `buffer(${value.length})`
      : value instanceof ArrayBuffer
        ? `arraybuffer(${value.byteLength})`
        : String(value);
    console.log(label, "ok", shape);
  } catch (error) {
    console.log(label, "error", error.name, error.code ?? "-", error.message);
  }
}

// hkdfSync's argument checks.
attempt("digest null", () => crypto.hkdfSync(null, "k", "s", "i", 16));
attempt("digest number", () => crypto.hkdfSync(5, "k", "s", "i", 16));
attempt("digest object", () => crypto.hkdfSync({}, "k", "s", "i", 16));
attempt("ikm null", () => crypto.hkdfSync("sha256", null, "s", "i", 16));
attempt("ikm number", () => crypto.hkdfSync("sha256", 5, "s", "i", 16));
attempt("ikm object", () => crypto.hkdfSync("sha256", {}, "s", "i", 16));
attempt("salt null", () => crypto.hkdfSync("sha256", "k", null, "i", 16));
attempt("salt undefined", () => crypto.hkdfSync("sha256", "k", undefined, "i", 16));
attempt("info null", () => crypto.hkdfSync("sha256", "k", "s", null, 16));
attempt("length null", () => crypto.hkdfSync("sha256", "k", "s", "i", null));
attempt("length string", () => crypto.hkdfSync("sha256", "k", "s", "i", "16"));
attempt("length boolean", () => crypto.hkdfSync("sha256", "k", "s", "i", true));
attempt("no arguments", () => crypto.hkdfSync());
attempt("missing info and length", () => crypto.hkdfSync("sha256", "k", "s"));
attempt("surplus argument", () => crypto.hkdfSync("sha256", "k", "s", "i", 16, "ignored"));
attempt("bad digest with bad length", () => crypto.hkdfSync(5, "k", "s", "i", "16"));
attempt("xof digest", () => crypto.hkdfSync("shake128", "k", "s", "i", 16));
attempt("zero length", () => crypto.hkdfSync("sha256", "k", "s", "i", 0));
attempt("length over the digest limit", () => crypto.hkdfSync("sha256", "k", "s", "i", 8161));

// hkdfSync over dynamic but valid arguments.
const digest = "sha384";
const keylen = 41;
console.log("dynamic result", Buffer.from(crypto.hkdfSync(digest, "key", "salt", "info", keylen)).toString("hex"));
console.log("dynamic arraybuffer", crypto.hkdfSync(digest, "key", "salt", "info", 16) instanceof ArrayBuffer);

// hkdf's keys: a secret KeyObject supplies its bytes; private and public
// keys are the wrong kind.
const secret = crypto.createSecretKey(Buffer.from("secret"));
console.log("secret key", Buffer.from(crypto.hkdfSync("sha256", secret, "s", "i", 16)).toString("hex"));
const pair = crypto.generateKeyPairSync("ed25519");
attempt("private key", () => crypto.hkdfSync("sha256", pair.privateKey, "s", "i", 16));
attempt("public key", () => crypto.hkdfSync("sha256", pair.publicKey, "s", "i", 16));

// scryptSync's argument checks and option-bag checks.
attempt("password null", () => crypto.scryptSync(null, "s", 8));
attempt("password number", () => crypto.scryptSync(5, "s", 8));
attempt("salt null", () => crypto.scryptSync("p", null, 8));
attempt("keylen string", () => crypto.scryptSync("p", "s", "8"));
attempt("keylen null", () => crypto.scryptSync("p", "s", null));
attempt("keylen negative", () => crypto.scryptSync("p", "s", -1));
attempt("missing keylen", () => crypto.scryptSync("p", "s"));
attempt("surplus argument", () => crypto.scryptSync("p", "s", 8, {}, "ignored"));
attempt("options number", () => crypto.scryptSync("p", "s", 8, 5));
attempt("options boolean", () => crypto.scryptSync("p", "s", 8, true));
attempt("options function", () => crypto.scryptSync("p", "s", 8, () => undefined));
attempt("options array", () => crypto.scryptSync("p", "s", 8, []));
attempt("options N string", () => crypto.scryptSync("p", "s", 8, { N: "16" }));
attempt("options maxmem string", () => crypto.scryptSync("p", "s", 8, { maxmem: "1" }));
attempt("options N negative", () => crypto.scryptSync("p", "s", 8, { N: -1 }));
attempt("options bad N with keylen string", () => crypto.scryptSync("p", "s", "8", { N: -1 }));
attempt("password KeyObject", () => crypto.scryptSync(secret, "s", 8));
attempt("scrypt params", () => crypto.scryptSync("p", "s", 8, { N: 3 }));

// scryptSync over dynamic but valid arguments, and the zero-length result's
// Buffer.
const length = 8;
console.log("dynamic result", crypto.scryptSync("p", "s", length, { N: 16, r: 1, p: 1 }).toString("hex"));
for (const size of [0, 1, 32]) {
  const derived = crypto.scryptSync("p", "s", size);
  console.log("buffer", size, Buffer.isBuffer(derived), derived.length, derived instanceof Uint8Array);
}

// The callback forms: argument checks throw synchronously, and the results
// arrive in later macrotasks.
attempt("hkdf callback null", () => crypto.hkdf("sha256", "k", "s", "i", 16, null));
attempt("hkdf callback string", () => crypto.hkdf("sha256", "k", "s", "i", 16, "x"));
attempt("hkdf digest null", () => crypto.hkdf(null, "k", "s", "i", 16, () => undefined));
attempt("hkdf length string", () => crypto.hkdf("sha256", "k", "s", "i", "16", () => undefined));
attempt("hkdf five arguments", () => crypto.hkdf("sha256", "k", "s", "i", () => undefined));
attempt("hkdf length before callback", () => crypto.hkdf("sha256", "k", "s", "i", "16", null));
attempt("scrypt callback null", () => crypto.scrypt("p", "s", 8, null));
attempt("scrypt missing callback", () => crypto.scrypt("p", "s", 8));
attempt("scrypt password null", () => crypto.scrypt(null, "s", 8, () => undefined));
attempt("scrypt keylen string", () => crypto.scrypt("p", "s", "8", () => undefined));
attempt("scrypt options before callback", () => crypto.scrypt("p", "s", 8, { N: -1 }, null));

let sync = true;
crypto.hkdf("sha256", "key", "salt", "info", 17, (error, key, extra) => {
  console.log("hkdf callback", sync, error, key instanceof ArrayBuffer, key.byteLength, extra);
  console.log("hkdf bytes", Buffer.from(key).toString("hex"));
  crypto.scrypt("password", "salt", 16, { N: 16, r: 1 }, (failure, derived) => {
    console.log("scrypt callback", failure, Buffer.isBuffer(derived), derived.length);
    crypto.scrypt("p", "s", 0, (lastError, empty) => {
      console.log("scrypt zero callback", lastError, Buffer.isBuffer(empty), empty.length);
      crypto.hkdf("shake128", "k", "s", "i", 16, (xofError, xof) => {
        console.log("xof callback", sync, xofError instanceof Error, xofError.code ?? "-", xofError.message, xof);
        crypto.scrypt("p", "s", 8, () => undefined);
        console.log("scrypt four-argument form", "accepted");
        crypto.hkdf("sha256", "k", "s", "i", 16, (surplusError, surplusKey, ignored) => {
          console.log("hkdf surplus argument", surplusError, surplusKey.byteLength, ignored);
        }, "ignored");
      });
    });
  });
});
console.log("synchronous end", sync);
sync = false;
