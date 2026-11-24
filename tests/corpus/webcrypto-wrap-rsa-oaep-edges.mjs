// crypto.subtle.wrapKey/unwrapKey with RSA-OAEP, from untyped JavaScript:
// the wrapped key's exportability, the label's BufferSource conversion at
// normalization time, a wrapped value longer than the modulus, and a
// wrapping key imported with only the wrapKey usage.
const raw = new Uint8Array(16);
const aesExt = await crypto.subtle.importKey("raw", raw, "AES-GCM", true, ["encrypt", "wrapKey"]);
const aesNoExt = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "wrapKey"]);
const pair = await crypto.subtle.generateKey(
  { name: "RSA-OAEP", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
  true,
  ["wrapKey", "unwrapKey"],
);
async function attempt(label, run) {
  try {
    const value = await run();
    console.log(label, "resolved", value instanceof ArrayBuffer ? value.byteLength : "");
  } catch (error) {
    console.log(label, error.name, error.code, error.message);
  }
}
await attempt("non-extractable", () => crypto.subtle.wrapKey("raw", aesNoExt, pair.publicKey, { name: "RSA-OAEP" }));
await attempt("label string", () => crypto.subtle.wrapKey("jwk", aesExt, pair.publicKey, { name: "RSA-OAEP", label: "x" }));
await attempt("huge wrapped", () =>
  crypto.subtle.unwrapKey("raw", new Uint8Array(4096), pair.privateKey, { name: "RSA-OAEP" }, { name: "AES-GCM" }, true, [
    "encrypt",
  ]),
);
const spki = await crypto.subtle.exportKey("spki", pair.publicKey);
const pubWrap = await crypto.subtle.importKey("spki", spki, { name: "RSA-OAEP", hash: "SHA-256" }, true, ["wrapKey"]);
await attempt("imported wrapKey usage", () => crypto.subtle.wrapKey("raw", aesExt, pubWrap, { name: "RSA-OAEP" }));
