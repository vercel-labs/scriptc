// crypto.subtle.wrapKey/unwrapKey with RSA-OAEP as the wrapping algorithm:
// the wrapped key's exported bytes are encrypted with the public half and
// decrypted with the private one, then imported with the requested
// extractability and usages. Ciphertexts are random, so only their lengths
// are printed.
const secret = new Uint8Array(16);
for (let i = 0; i < secret.length; i++) secret[i] = i + 1;
const aes = await crypto.subtle.importKey("raw", secret, "AES-GCM", true, [
  "encrypt",
  "decrypt",
  "wrapKey",
  "unwrapKey",
]);
const pair = await crypto.subtle.generateKey(
  { name: "RSA-OAEP", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
  true,
  ["wrapKey", "unwrapKey"],
);
console.log(
  "key",
  pair.publicKey.type,
  pair.publicKey.usages.join(","),
  pair.privateKey.type,
  pair.privateKey.usages.join(","),
);

const label = Buffer.from("wrap label");
const wrapped = await crypto.subtle.wrapKey("raw", aes, pair.publicKey, { name: "RSA-OAEP", label });
console.log("raw wrap", wrapped.byteLength);
const back = await crypto.subtle.unwrapKey(
  "raw",
  wrapped,
  pair.privateKey,
  { name: "RSA-OAEP", label },
  { name: "AES-GCM" },
  true,
  ["encrypt"],
);
console.log(
  "raw unwrap",
  (await crypto.subtle.exportKey("raw", back)).byteLength,
  back.usages.join(","),
  back.extractable,
);
const sealedKey = await crypto.subtle.unwrapKey(
  "raw",
  wrapped,
  pair.privateKey,
  { name: "RSA-OAEP", label },
  { name: "AES-GCM" },
  false,
  ["decrypt"],
);
const sealedExport = await crypto.subtle.exportKey("raw", sealedKey).then(
  () => "exported",
  (error: Error) => error.name,
);
console.log("raw unwrap sealed", sealedExport, sealedKey.usages.join(","), sealedKey.extractable);

// A JWK's JSON bytes are encrypted as they are, with no key-wrap padding.
const wrappedJwk = await crypto.subtle.wrapKey("jwk", aes, pair.publicKey, { name: "RSA-OAEP" });
const jwkBack = await crypto.subtle.unwrapKey(
  "jwk",
  wrappedJwk,
  pair.privateKey,
  { name: "RSA-OAEP" },
  { name: "AES-GCM" },
  true,
  ["encrypt"],
);
console.log("jwk wrap", wrappedJwk.byteLength, jwkBack.usages.join(","));

// An ECDSA private key's PKCS#8 goes through the same wrapping key.
const ecdsa = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const wrappedPkcs8 = await crypto.subtle.wrapKey("pkcs8", ecdsa.privateKey, pair.publicKey, { name: "RSA-OAEP" });
const ecdsaBack = await crypto.subtle.unwrapKey(
  "pkcs8",
  wrappedPkcs8,
  pair.privateKey,
  { name: "RSA-OAEP" },
  { name: "ECDSA", namedCurve: "P-256" },
  true,
  ["sign"],
);
const message = Buffer.from("signed through a wrapped key");
const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, ecdsaBack, message);
console.log(
  "pkcs8 wrap",
  wrappedPkcs8.byteLength,
  await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, ecdsa.publicKey, signature, message),
);

// Node's own rejections: the wrapping key needs wrapKey on its public half
// and unwrapKey on its private one, the algorithm has to match, and a label
// that does not match the one used to wrap fails the decryption.
const failure = (error: Error) => `${error.name}: ${error.message}`;
const encryptOnly = await crypto.subtle.generateKey(
  { name: "RSA-OAEP", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
  true,
  ["encrypt", "decrypt"],
);
console.log(
  "no wrapKey usage",
  await crypto.subtle.wrapKey("raw", aes, encryptOnly.publicKey, { name: "RSA-OAEP" }).then(
    () => "resolved",
    failure,
  ),
);
console.log(
  "unwrap with public",
  await crypto.subtle
    .unwrapKey("raw", wrapped, pair.publicKey, { name: "RSA-OAEP", label }, { name: "AES-GCM" }, true, ["encrypt"])
    .then(() => "resolved", failure),
);
console.log(
  "wrong label",
  await crypto.subtle
    .unwrapKey(
      "raw",
      wrapped,
      pair.privateKey,
      { name: "RSA-OAEP", label: Buffer.from("other") },
      { name: "AES-GCM" },
      true,
      ["encrypt"],
    )
    .then(() => "resolved", failure),
);
const secretWrapper = await crypto.subtle.generateKey({ name: "AES-GCM", length: 128 }, false, ["wrapKey"]);
console.log(
  "secret wrapping key",
  await crypto.subtle.wrapKey("raw", aes, secretWrapper, { name: "RSA-OAEP" }).then(() => "resolved", failure),
);
