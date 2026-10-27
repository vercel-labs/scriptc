// WebCrypto from JavaScript: keys and algorithms carried as dynamic
// values, the CryptoKey brand checks libraries use (Symbol.toStringTag,
// Object.prototype.toString and instanceof), JSON.stringify of a key, and
// rejections for missing arguments and non-key values.
const encoder = new TextEncoder();
const secret = encoder.encode("dynamic-secret");
const table = {
  HS256: { name: "HMAC", hash: "SHA-256" },
  HS512: { name: "HMAC", hash: "SHA-512" },
};

async function importFor(alg, usage) {
  const params = table[alg];
  return crypto.subtle.importKey("raw", secret, params, false, [usage]);
}

const key = await importFor("HS256", "sign");
console.log(key[Symbol.toStringTag], Object.prototype.toString.call(key), String(key));
console.log(key instanceof CryptoKey, secret instanceof CryptoKey, {} instanceof CryptoKey);
console.log(JSON.stringify(key), typeof key, key.type, key.algorithm.hash.name, key.usages.includes("sign"));
const sig = new Uint8Array(await crypto.subtle.sign(table.HS256, key, encoder.encode("a.b")));
console.log(sig.length, Buffer.from(sig).toString("base64url"));
const verifier = await importFor("HS256", "verify");
let verified = false;
try {
  verified = await crypto.subtle.verify(table.HS256, verifier, sig, encoder.encode("a.b"));
} catch {}
console.log(verified);
const other = await importFor("HS512", "verify");
console.log(await crypto.subtle.verify(table.HS512, other, sig, encoder.encode("a.b")));

async function attempt(label, run) {
  try {
    await run();
    console.log(label, "resolved");
  } catch (e) {
    console.log(label, e.name, e.code, e.message);
  }
}
await attempt("too few", () => crypto.subtle.sign("HMAC", key));
await attempt("import too few", () => crypto.subtle.importKey("raw", secret, table.HS256, false));
await attempt("verify too few", () => crypto.subtle.verify("HMAC", key, sig));
await attempt("digest too few", () => crypto.subtle.digest("SHA-256"));
const lookalike = JSON.parse('{"type":"secret","usages":["sign"]}');
await attempt("not a key", () => crypto.subtle.sign("HMAC", lookalike, secret));
await attempt("bad format", () => crypto.subtle.importKey("nope", secret, table.HS256, false, ["sign"]));
await attempt("bad usage", () => crypto.subtle.importKey("raw", secret, table.HS256, false, ["bogus"]));
await attempt("usages not a sequence", () => crypto.subtle.importKey("raw", secret, table.HS256, false, "sign"));
await attempt("algorithm without name", () => crypto.subtle.sign({ hash: "SHA-256" }, key, secret));
await attempt("hash object without name", () =>
  crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: {} }, false, ["sign"]),
);
