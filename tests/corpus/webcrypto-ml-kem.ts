// crypto.subtle's ML-KEM (FIPS 203) surface: generateKey with the
// @normalize-pid
// encapsulate/decapsulate usages, raw-public/raw-seed/spki/pkcs8/jwk
// import and export, encapsulateBits/decapsulateBits returning the shared
// secret as an ArrayBuffer, the *Key forms importing it as the requested
// key type, and Node's rejections. Shared secrets and ciphertexts are
// random, so only their lengths and equalities are printed.
const failure = (error: Error) => `${error.name}: ${error.message}`;
const hex = (value: ArrayBuffer) => Buffer.from(new Uint8Array(value)).toString("hex");

const pair = await crypto.subtle.generateKey({ name: "ML-KEM-768" }, true, [
  "encapsulateBits",
  "encapsulateKey",
  "decapsulateBits",
  "decapsulateKey",
]);
console.log(
  "pair",
  pair.publicKey.type,
  pair.publicKey.usages.join(","),
  pair.privateKey.type,
  pair.privateKey.usages.join(","),
  pair.publicKey.algorithm.name,
);
const rawPublic = await crypto.subtle.exportKey("raw-public", pair.publicKey);
const rawSeed = await crypto.subtle.exportKey("raw-seed", pair.privateKey);
const spki = await crypto.subtle.exportKey("spki", pair.publicKey);
const pkcs8 = await crypto.subtle.exportKey("pkcs8", pair.privateKey);
console.log("sizes", rawPublic.byteLength, rawSeed.byteLength, spki.byteLength, pkcs8.byteLength);
const jwkPublic = await crypto.subtle.exportKey("jwk", pair.publicKey);
const jwkPrivate = await crypto.subtle.exportKey("jwk", pair.privateKey);
console.log(
  "jwk",
  Object.keys(jwkPublic).sort().join(","),
  jwkPublic.kty,
  jwkPublic.alg,
  Object.keys(jwkPrivate).sort().join(","),
);

// encapsulateBits and decapsulateBits agree on the shared secret.
const encapsulation = await crypto.subtle.encapsulateBits({ name: "ML-KEM-768" }, pair.publicKey);
console.log(
  "encapsulateBits",
  encapsulation.sharedKey.byteLength,
  encapsulation.ciphertext.byteLength,
);
const shared = await crypto.subtle.decapsulateBits(
  { name: "ML-KEM-768" },
  pair.privateKey,
  encapsulation.ciphertext,
);
console.log("decapsulateBits", shared.byteLength, hex(shared) === hex(encapsulation.sharedKey));

// The *Key forms import the shared secret as the requested key type.
const encapsulationKey = await crypto.subtle.encapsulateKey(
  { name: "ML-KEM-768" },
  pair.publicKey,
  { name: "AES-GCM" },
  true,
  ["encrypt", "decrypt"],
);
console.log(
  "encapsulateKey",
  encapsulationKey.sharedKey.type,
  encapsulationKey.sharedKey.algorithm.name,
  encapsulationKey.sharedKey.usages.join(","),
  encapsulationKey.sharedKey.extractable,
  encapsulationKey.ciphertext.byteLength,
);
const decapsulationKey = await crypto.subtle.decapsulateKey(
  { name: "ML-KEM-768" },
  pair.privateKey,
  encapsulationKey.ciphertext,
  { name: "AES-GCM" },
  false,
  ["decrypt"],
);
console.log(
  "decapsulateKey",
  decapsulationKey.type,
  decapsulationKey.algorithm.name,
  decapsulationKey.usages.join(","),
  decapsulationKey.extractable,
);

// A key re-imported from each encoding works with keys from the other ones.
const importedPublic = await crypto.subtle.importKey(
  "raw-public",
  rawPublic,
  { name: "ML-KEM-768" },
  false,
  ["encapsulateBits"],
);
const importedSeed = await crypto.subtle.importKey(
  "raw-seed",
  rawSeed,
  { name: "ML-KEM-768" },
  true,
  ["decapsulateBits"],
);
const importedSpki = await crypto.subtle.importKey("spki", spki, { name: "ML-KEM-768" }, true, [
  "encapsulateKey",
  "encapsulateBits",
]);
const importedPkcs8 = await crypto.subtle.importKey(
  "pkcs8",
  pkcs8,
  { name: "ML-KEM-768" },
  true,
  ["decapsulateKey"],
);
const importedJwk = await crypto.subtle.importKey("jwk", jwkPrivate, { name: "ML-KEM-768" }, true, [
  "decapsulateBits",
]);
console.log(
  "import",
  importedPublic.type,
  importedPublic.extractable,
  importedPublic.usages.join(","),
  importedSeed.type,
  importedSpki.type,
  importedPkcs8.type,
  importedJwk.type,
);
const crossed = await crypto.subtle.encapsulateBits({ name: "ML-KEM-768" }, importedSpki);
const crossedShared = await crypto.subtle.decapsulateBits(
  { name: "ML-KEM-768" },
  importedJwk,
  crossed.ciphertext,
);
console.log("crossed", hex(crossedShared) === hex(crossed.sharedKey));

// Node's rejections.
console.log(
  "encapsulate private",
  await crypto.subtle
    .encapsulateBits({ name: "ML-KEM-768" }, pair.privateKey)
    .then(() => "resolved", failure),
);
console.log(
  "wrong level",
  await crypto.subtle
    .encapsulateBits({ name: "ML-KEM-512" }, pair.publicKey)
    .then(() => "resolved", failure),
);
console.log(
  "short ciphertext",
  await crypto.subtle
    .decapsulateBits({ name: "ML-KEM-768" }, pair.privateKey, new Uint8Array(4))
    .then(() => "resolved", failure),
);
const bitsOnly = await crypto.subtle.generateKey({ name: "ML-KEM-768" }, true, [
  "encapsulateBits",
  "decapsulateBits",
]);
console.log(
  "other method usage",
  await crypto.subtle
    .encapsulateKey({ name: "ML-KEM-768" }, bitsOnly.publicKey, { name: "AES-GCM" }, true, ["encrypt"])
    .then(() => "resolved", failure),
);
console.log(
  "export spki of private",
  await crypto.subtle.exportKey("spki", pair.privateKey).then(() => "resolved", failure),
);
console.log(
  "export raw-seed of public",
  await crypto.subtle.exportKey("raw-seed", pair.publicKey).then(() => "resolved", failure),
);
console.log(
  "import short raw",
  await crypto.subtle
    .importKey("raw-public", new Uint8Array(10), { name: "ML-KEM-768" }, true, ["encapsulateBits"])
    .then(() => "resolved", failure),
);
console.log(
  "import wrong usage",
  await crypto.subtle
    .importKey("raw-public", rawPublic, { name: "ML-KEM-768" }, true, ["decapsulateBits"])
    .then(() => "resolved", failure),
);
console.log(
  "wrap with ML-KEM",
  await crypto.subtle
    .wrapKey("raw", pair.publicKey, pair.publicKey, { name: "ML-KEM-768" })
    .then(() => "resolved", failure),
);
console.log(
  "generate one half",
  await crypto.subtle
    .generateKey({ name: "ML-KEM-768" }, true, ["encapsulateBits"])
    .then(() => "resolved", failure),
);
console.log(
  "bad key algorithm",
  await crypto.subtle
    .encapsulateKey({ name: "ML-KEM-768" }, pair.publicKey, { name: "BOGUS" }, true, ["encrypt"])
    .then(() => "resolved", failure),
);

// getPublicKey derives the encapsulating public half, which takes the
// encapsulation usages and never verify; a private key imports only with
// at least one decapsulating usage, while a public key may carry none.
const derived = await crypto.subtle.getPublicKey(pair.privateKey, [
  "encapsulateKey",
  "encapsulateBits",
]);
console.log("getPublicKey", derived.type, derived.usages.join(","), derived.extractable);
console.log(
  "getPublicKey verify",
  await crypto.subtle
    .getPublicKey(pair.privateKey, ["verify"])
    .then(() => "resolved", failure),
);
console.log(
  "import private empty",
  await crypto.subtle
    .importKey("raw-seed", rawSeed, { name: "ML-KEM-768" }, true, [])
    .then(() => "resolved", failure),
);
console.log(
  "import public empty",
  await crypto.subtle
    .importKey("raw-public", rawPublic, { name: "ML-KEM-768" }, true, [])
    .then((key) => `${key.type},${key.usages.length}`, failure),
);
