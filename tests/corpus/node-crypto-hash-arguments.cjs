// createHash, Hash.update/digest/copy, createHmac, Hmac.update/digest,
// crypto.hash and pbkdf2/pbkdf2Sync argument errors from JavaScript: the
// argument names and order Node validates them in, every wrong type
// (undefined, null, numbers, objects, arrays, booleans), encodings,
// algorithms, keys, options fields, the pbkdf2 ranges, and the values the
// valid forms answer.
const crypto = require("node:crypto");

function attempt(label, run) {
  try {
    const result = run();
    console.log(label, "ok", Buffer.isBuffer(result) ? `buf:${result.toString("hex")}` : String(result));
  } catch (e) {
    console.log(label, "threw", e.name, e.code, "|", e.message);
  }
}

attempt("createHash()", () => crypto.createHash());
attempt("createHash(undefined)", () => crypto.createHash(undefined));
attempt("createHash(null)", () => crypto.createHash(null));
attempt("createHash(5)", () => crypto.createHash(5));
attempt("createHash({})", () => crypto.createHash({}));
attempt("createHash(true)", () => crypto.createHash(true));
attempt("createHash(bogus)", () => crypto.createHash("bogus"));
attempt("createHash(empty)", () => crypto.createHash(""));
attempt("createHash(opts 5)", () => crypto.createHash("sha256", 5));
attempt("createHash(opts null)", () => crypto.createHash("sha256", null));
attempt("createHash(opts array)", () => crypto.createHash("sha256", []));
attempt("createHash(opts string)", () => crypto.createHash("sha256", "hex"));
attempt("createHash(outputLength string)", () => crypto.createHash("shake128", { outputLength: "8" }));
attempt("createHash(outputLength null)", () => crypto.createHash("shake128", { outputLength: null }));
attempt("createHash(outputLength 1.5)", () => crypto.createHash("shake128", { outputLength: 1.5 }));
attempt("createHash(outputLength -1)", () => crypto.createHash("shake128", { outputLength: -1 }));
attempt("createHash(outputLength big)", () => crypto.createHash("shake128", { outputLength: 4294967296 }));
attempt("createHash(extra args)", () => crypto.createHash("sha256", {}, 7, 8).update("x").digest("hex"));

attempt("update()", () => crypto.createHash("sha256").update());
attempt("update(undefined)", () => crypto.createHash("sha256").update(undefined));
attempt("update(null)", () => crypto.createHash("sha256").update(null));
attempt("update(5)", () => crypto.createHash("sha256").update(5));
attempt("update({})", () => crypto.createHash("sha256").update({}));
attempt("update([])", () => crypto.createHash("sha256").update([]));
attempt("update(true)", () => crypto.createHash("sha256").update(true));
attempt("update(enc 5)", () => crypto.createHash("sha256").update("x", 5).digest("hex"));
attempt("update(enc null)", () => crypto.createHash("sha256").update("x", null).digest("hex"));
attempt("update(enc {})", () => crypto.createHash("sha256").update("x", {}).digest("hex"));
attempt("update(enc bogus)", () => crypto.createHash("sha256").update("x", "bogus").digest("hex"));
attempt("update(buffer enc hex)", () => crypto.createHash("sha256").update(Buffer.from("x"), "hex").digest("hex"));
attempt("update(arraybuffer)", () =>
  crypto.createHash("sha256").update(new ArrayBuffer(2)).digest("hex"),
);
attempt("update(uint16)", () =>
  crypto.createHash("sha256").update(new Uint16Array([0x6869])).digest("hex"),
);
attempt("update(extra)", () => crypto.createHash("sha256").update("x", "utf8", 9).digest("hex"));

attempt("digest(5)", () => crypto.createHash("sha256").update("x").digest(5));
attempt("digest({})", () => crypto.createHash("sha256").update("x").digest({}));
attempt("digest(null)", () => crypto.createHash("sha256").update("x").digest(null));
attempt("digest(true)", () => crypto.createHash("sha256").update("x").digest(true));
attempt("digest(bogus)", () => crypto.createHash("sha256").update("x").digest("bogus"));
attempt("digest(empty)", () => crypto.createHash("sha256").update("x").digest(""));
attempt("digest(extra)", () => crypto.createHash("sha256").update("x").digest("hex", 1));

attempt("copy(5)", () => crypto.createHash("sha256").update("x").copy(5).digest("hex"));
attempt("copy(null)", () => crypto.createHash("sha256").update("x").copy(null).digest("hex"));
attempt("copy([])", () => crypto.createHash("sha256").update("x").copy([]).digest("hex"));
attempt("copy(extra)", () => crypto.createHash("sha256").update("x").copy({}, 1).digest("hex"));

attempt("createHmac()", () => crypto.createHmac());
attempt("createHmac(sha256)", () => crypto.createHmac("sha256"));
attempt("createHmac(5, k)", () => crypto.createHmac(5, "k"));
attempt("createHmac(null, k)", () => crypto.createHmac(null, "k"));
attempt("createHmac(bogus, k)", () => crypto.createHmac("bogus", "k"));
attempt("createHmac(shake128, k)", () => crypto.createHmac("shake128", "k"));
attempt("createHmac(key 5)", () => crypto.createHmac("sha256", 5));
attempt("createHmac(key {})", () => crypto.createHmac("sha256", {}));
attempt("createHmac(key [])", () => crypto.createHmac("sha256", []));
attempt("createHmac(key true)", () => crypto.createHmac("sha256", true));
attempt("createHmac(opts 5)", () => crypto.createHmac("sha256", "k", 5));
attempt("createHmac(opts null)", () => crypto.createHmac("sha256", "k", null));
attempt("createHmac(encoding 5)", () => crypto.createHmac("sha256", "k", { encoding: 5 }));
attempt("createHmac(encoding bogus)", () => crypto.createHmac("sha256", "k", { encoding: "bogus" }));
attempt("createHmac(key hex)", () =>
  crypto.createHmac("sha256", "6b6579", { encoding: "hex" }).update("x").digest("hex"),
);
attempt("createHmac(extra)", () => crypto.createHmac("sha256", "k", {}, 7).update("x").digest("hex"));

attempt("hmac update()", () => crypto.createHmac("sha256", "k").update());
attempt("hmac update(5)", () => crypto.createHmac("sha256", "k").update(5));
attempt("hmac update(enc bogus)", () =>
  crypto.createHmac("sha256", "k").update("x", "bogus").digest("hex"),
);
attempt("hmac digest(5)", () => crypto.createHmac("sha256", "k").update("x").digest(5));
attempt("hmac digest twice", () => {
  const h = crypto.createHmac("sha256", "k").update("x");
  h.digest("hex");
  return h.digest("hex");
});
attempt("hmac copy", () => crypto.createHmac("sha256", "k").copy());

attempt("hash()", () => crypto.hash());
attempt("hash(sha256)", () => crypto.hash("sha256"));
attempt("hash(5)", () => crypto.hash(5));
attempt("hash(5, x)", () => crypto.hash(5, "x"));
attempt("hash(null, x)", () => crypto.hash(null, "x"));
attempt("hash(sha256, 5)", () => crypto.hash("sha256", 5));
attempt("hash(sha256, null)", () => crypto.hash("sha256", null));
attempt("hash(sha256, {})", () => crypto.hash("sha256", {}));
attempt("hash(bogus, x)", () => crypto.hash("bogus", "x"));
attempt("hash(sha256, x, 5)", () => crypto.hash("sha256", "x", 5));
attempt("hash(sha256, x, null)", () => crypto.hash("sha256", "x", null));
attempt("hash(sha256, x, [])", () => crypto.hash("sha256", "x", []));
attempt("hash(sha256, x, bogus)", () => crypto.hash("sha256", "x", "bogus"));
attempt("hash(sha256, x, empty)", () => crypto.hash("sha256", "x", ""));
attempt("hash(sha256, x, {oenc 5})", () => crypto.hash("sha256", "x", { outputEncoding: 5 }));
attempt("hash(sha256, x, {olen 8})", () => crypto.hash("sha256", "x", { outputLength: 8 }));
attempt("hash(sha256, x, extra)", () => crypto.hash("sha256", "x", "hex", 9));
attempt("hash(sha256, uint16)", () => crypto.hash("sha256", new Uint16Array([0x6869]), "hex"));
attempt("hash(sha256, arraybuffer)", () => crypto.hash("sha256", new ArrayBuffer(2), "hex"));

attempt("pbkdf2Sync()", () => crypto.pbkdf2Sync());
attempt("pbkdf2Sync(p)", () => crypto.pbkdf2Sync("p"));
attempt("pbkdf2Sync(p, s)", () => crypto.pbkdf2Sync("p", "s"));
attempt("pbkdf2Sync(p, s, 1)", () => crypto.pbkdf2Sync("p", "s", 1));
attempt("pbkdf2Sync(p, s, 1, 16)", () => crypto.pbkdf2Sync("p", "s", 1, 16));
attempt("pbkdf2Sync(5, s, 1, 16, sha256)", () => crypto.pbkdf2Sync(5, "s", 1, 16, "sha256"));
attempt("pbkdf2Sync(p, 5, 1, 16, sha256)", () => crypto.pbkdf2Sync("p", 5, 1, 16, "sha256"));
attempt("pbkdf2Sync(iter str)", () => crypto.pbkdf2Sync("p", "s", "1", 16, "sha256"));
attempt("pbkdf2Sync(iter null)", () => crypto.pbkdf2Sync("p", "s", null, 16, "sha256"));
attempt("pbkdf2Sync(iter 0)", () => crypto.pbkdf2Sync("p", "s", 0, 16, "sha256"));
attempt("pbkdf2Sync(iter -1)", () => crypto.pbkdf2Sync("p", "s", -1, 16, "sha256"));
attempt("pbkdf2Sync(iter 1.5)", () => crypto.pbkdf2Sync("p", "s", 1.5, 16, "sha256"));
attempt("pbkdf2Sync(iter NaN)", () => crypto.pbkdf2Sync("p", "s", NaN, 16, "sha256"));
attempt("pbkdf2Sync(iter Infinity)", () => crypto.pbkdf2Sync("p", "s", Infinity, 16, "sha256"));
attempt("pbkdf2Sync(keylen str)", () => crypto.pbkdf2Sync("p", "s", 1, "16", "sha256"));
attempt("pbkdf2Sync(keylen -1)", () => crypto.pbkdf2Sync("p", "s", 1, -1, "sha256"));
attempt("pbkdf2Sync(keylen 0)", () => crypto.pbkdf2Sync("p", "s", 1, 0, "sha256"));
attempt("pbkdf2Sync(digest 5)", () => crypto.pbkdf2Sync("p", "s", 1, 16, 5));
attempt("pbkdf2Sync(digest bogus)", () => crypto.pbkdf2Sync("p", "s", 1, 16, "bogus"));
attempt("pbkdf2Sync(digest shake)", () => crypto.pbkdf2Sync("p", "s", 1, 16, "shake128"));
attempt("pbkdf2Sync(extra)", () => crypto.pbkdf2Sync("p", "s", 1, 16, "sha256", 7, 8));
attempt("pbkdf2Sync(sha3)", () => crypto.pbkdf2Sync("p", "s", 1, 16, "sha3-256").toString("hex"));
attempt("pbkdf2Sync(blake2b)", () => crypto.pbkdf2Sync("p", "s", 1, 16, "blake2b512").toString("hex"));
attempt("pbkdf2Sync(bytes)", () =>
  crypto.pbkdf2Sync(Buffer.from("p"), new Uint8Array([115]), 2, 24, "sha1").toString("hex"),
);

function report(label, error, key) {
  console.log(
    "pbkdf2",
    label,
    error === null ? "null" : String(error),
    key === undefined ? "undefined" : key.toString("hex"),
  );
}
attempt("pbkdf2 5 args", () => crypto.pbkdf2("p", "s", 1, 16, () => {}));
attempt("pbkdf2 cb 5", () => crypto.pbkdf2("p", "s", 1, 16, "sha256", 5));
attempt("pbkdf2 no cb", () => crypto.pbkdf2("p", "s", 1, 16, "sha256"));
attempt("pbkdf2 bad digest", () => crypto.pbkdf2("p", "s", 1, 16, "bogus", () => {}));
// The asynchronous completions run in call order: a success, a success whose
// surplus argument is dropped, then the jobs that fail while deriving. Each
// completion starts the next call, so the thread pool's own completion order
// does not decide the output.
crypto.pbkdf2("p", "s", 2, 24, "sha256", (error, key) => {
  report("ok", error, key);
  crypto.pbkdf2("p", "s", 1, 16, "sha256", (inner, innerKey) => {
    report("extra", inner, innerKey);
    crypto.pbkdf2("p", "s", 1, 0, "sha256", (failed) => {
      console.log("keylen 0", String(failed));
      crypto.pbkdf2("p", "s", 1, 16, "shake128", (xof) => {
        console.log("xof", String(xof));
      });
    });
  }, 7);
});
