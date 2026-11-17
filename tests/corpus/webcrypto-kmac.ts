// crypto.subtle KMAC128/KMAC256: raw-secret and JWK imports, generated keys,
// @normalize-pid
// the raw-secret/JWK export set, bit-truncated signatures at several output
// lengths, customization, and Node's argument errors. Each algorithm's
// experimental warning reaches stderr once.

const keyBytes = Buffer.alloc(16, 2);
const key = await crypto.subtle.importKey("raw-secret", keyBytes, "KMAC128", true, [
  "sign",
  "verify",
]);
console.log("key", JSON.stringify(key.algorithm), key.extractable, key.usages.join(","));

for (const length of [1, 7, 8, 9, 12, 16, 32, 128]) {
  const signature = Buffer.from(
    await crypto.subtle.sign({ name: "KMAC128", outputLength: length }, key, Buffer.from("abc")),
  );
  console.log("sign", length, signature.toString("hex"));
}
const custom = await crypto.subtle.sign(
  { name: "KMAC128", outputLength: 32, customization: Buffer.from("cust") },
  key,
  Buffer.from("abc"),
);
console.log("custom", Buffer.from(custom).toString("hex"));

// A key's declared bit length that is not a whole byte count keeps only its
// high bits and feeds KMAC's key encoding at that bit length.
for (const length of [121, 122, 127]) {
  const bitsKey = await crypto.subtle.importKey("raw-secret", keyBytes, { name: "KMAC128", length }, true, [
    "sign",
  ]);
  const exported = Buffer.from(await crypto.subtle.exportKey("raw-secret", bitsKey));
  const signature = Buffer.from(
    await crypto.subtle.sign({ name: "KMAC128", outputLength: 32 }, bitsKey, Buffer.from("abc")),
  );
  console.log("bits", length, exported.toString("hex"), signature.toString("hex"));
}

const jwk = await crypto.subtle.exportKey("jwk", key);
console.log("jwk", JSON.stringify(jwk));
const jwk256 = await crypto.subtle.importKey(
  "jwk",
  { kty: "oct", k: keyBytes.toString("base64url"), alg: "K256" },
  "KMAC256",
  false,
  ["sign"],
);
console.log("jwk256", JSON.stringify(jwk256.algorithm));

const generated = await crypto.subtle.generateKey({ name: "KMAC256", length: 128 }, true, ["sign"]);
console.log("generated", JSON.stringify(generated.algorithm));
const exported = await crypto.subtle.exportKey("raw-secret", generated);
console.log("exported", (exported as ArrayBuffer).byteLength);

const signature = await crypto.subtle.sign({ name: "KMAC128", outputLength: 8 }, key, Buffer.from("abc"));
console.log(
  "verify",
  await crypto.subtle.verify({ name: "KMAC128", outputLength: 8 }, key, signature, Buffer.from("abc")),
  await crypto.subtle.verify({ name: "KMAC128", outputLength: 8 }, key, signature, Buffer.from("abd")),
);

async function attempt(label: string, run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
    console.log(label, "ok");
  } catch (error) {
    const typed = error as Error;
    console.log(label, typed.name, "|", typed.message);
  }
}

await attempt("import raw", () =>
  crypto.subtle.importKey("raw", keyBytes, "KMAC128", false, ["sign"]),
);
await attempt("export raw", () => crypto.subtle.exportKey("raw", key));
await attempt("missing outputLength", () => crypto.subtle.sign("KMAC128", key, Buffer.alloc(1)));
await attempt("import length 7", () =>
  crypto.subtle.importKey("raw-secret", keyBytes, { name: "KMAC128", length: 7 }, false, ["sign"]),
);
await attempt("import bad usage", () =>
  crypto.subtle.importKey("raw-secret", keyBytes, "KMAC128", false, ["encrypt"]),
);
await attempt("verify-only key signs", async () => {
  const verifyOnly = await crypto.subtle.importKey("raw-secret", keyBytes, "KMAC128", false, ["verify"]);
  return crypto.subtle.sign({ name: "KMAC128", outputLength: 8 }, verifyOnly, Buffer.alloc(1));
});
await attempt("alg mismatch", async () =>
  crypto.subtle.sign({ name: "KMAC256", outputLength: 8 }, key, Buffer.alloc(1)),
);
await attempt("customization 513", () =>
  crypto.subtle.sign(
    { name: "KMAC128", outputLength: 32, customization: Buffer.alloc(513, 1) },
    key,
    Buffer.alloc(1),
  ),
);
await attempt("bad jwk alg", () =>
  crypto.subtle.importKey(
    "jwk",
    { kty: "oct", k: keyBytes.toString("base64url"), alg: "K128" },
    "KMAC256",
    false,
    ["sign"],
  ),
);
