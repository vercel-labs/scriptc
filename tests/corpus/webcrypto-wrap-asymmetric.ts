// crypto.subtle.wrapKey/unwrapKey of asymmetric CryptoKeys: the exported
// encoding (pkcs8, spki, raw or a JWK's JSON) is wrapped with AES-KW or an
// AES cipher and imported again, matching Node's exportKey-then-encrypt
// composition.
const encoder = new TextEncoder();

function hex(value: ArrayBuffer): string {
  return Buffer.from(value).toString("hex");
}

async function describe(key: CryptoKey): Promise<string> {
  return JSON.stringify({ algorithm: key.algorithm, usages: key.usages, extractable: key.extractable });
}

async function exported(key: CryptoKey, format: "spki" | "pkcs8"): Promise<string> {
  return hex(await crypto.subtle.exportKey(format, key));
}

const kekBytes = new Uint8Array(32);
for (let i = 0; i < kekBytes.length; i++) kekBytes[i] = i;
const kwKek = await crypto.subtle.importKey("raw", kekBytes, "AES-KW", true, ["wrapKey", "unwrapKey"]);
const gcmKek = await crypto.subtle.importKey("raw", kekBytes, "AES-GCM", true, ["wrapKey", "unwrapKey"]);
const iv = new Uint8Array(12);
for (let i = 0; i < iv.length; i++) iv[i] = i * 3;

// An ECDSA private key wrapped as PKCS#8 with AES-GCM (its DER length is not
// a multiple of the 8 bytes AES-KW requires).
const ecdsa = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const ecdsaPkcs8 = await exported(ecdsa.privateKey, "pkcs8");
const wrappedEcdsa = await crypto.subtle.wrapKey("pkcs8", ecdsa.privateKey, gcmKek, { name: "AES-GCM", iv });
const ecdsaBack = await crypto.subtle.unwrapKey(
  "pkcs8",
  wrappedEcdsa,
  gcmKek,
  { name: "AES-GCM", iv },
  { name: "ECDSA", namedCurve: "P-256" },
  true,
  ["sign"],
);
console.log("ecdsa pkcs8", wrappedEcdsa.byteLength, (await exported(ecdsaBack, "pkcs8")) === ecdsaPkcs8);
console.log("ecdsa key", await describe(ecdsaBack));
const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, ecdsaBack, encoder.encode("scriptc"));
console.log(
  "ecdsa verify",
  await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, ecdsa.publicKey, signature, encoder.encode("scriptc")),
);

// The public key as SubjectPublicKeyInfo with AES-GCM, and as its raw point.
const wrappedSpki = await crypto.subtle.wrapKey("spki", ecdsa.publicKey, gcmKek, { name: "AES-GCM", iv });
const spkiBack = await crypto.subtle.unwrapKey(
  "spki",
  wrappedSpki,
  gcmKek,
  { name: "AES-GCM", iv },
  { name: "ECDSA", namedCurve: "P-256" },
  true,
  ["verify"],
);
console.log("ecdsa spki", wrappedSpki.byteLength, (await exported(spkiBack, "spki")) === (await exported(ecdsa.publicKey, "spki")));
console.log("ecdsa verify back", await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, spkiBack, signature, encoder.encode("scriptc")));
const wrappedRaw = await crypto.subtle.wrapKey("raw", ecdsa.publicKey, gcmKek, { name: "AES-GCM", iv });
const rawBack = await crypto.subtle.unwrapKey(
  "raw",
  wrappedRaw,
  gcmKek,
  { name: "AES-GCM", iv },
  { name: "ECDSA", namedCurve: "P-256" },
  true,
  ["verify"],
);
console.log("ecdsa raw", hex(await crypto.subtle.exportKey("raw", rawBack)) === hex(await crypto.subtle.exportKey("raw", ecdsa.publicKey)));

// Ed25519 private key through AES-KW.
const ed = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
const edPkcs8 = await exported(ed.privateKey, "pkcs8");
const wrappedEd = await crypto.subtle.wrapKey("pkcs8", ed.privateKey, kwKek, "AES-KW");
const edBack = await crypto.subtle.unwrapKey("pkcs8", wrappedEd, kwKek, "AES-KW", { name: "Ed25519" }, true, ["sign"]);
const edSignature = await crypto.subtle.sign({ name: "Ed25519" }, edBack, encoder.encode("ed"));
console.log("ed25519", (await exported(edBack, "pkcs8")) === edPkcs8, await crypto.subtle.verify({ name: "Ed25519" }, ed.publicKey, edSignature, encoder.encode("ed")));

// RSA-OAEP private key (not a multiple of 8 bytes) through AES-GCM.
const rsa = await crypto.subtle.generateKey(
  { name: "RSA-OAEP", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
  true,
  ["encrypt", "decrypt"],
);
const rsaCiphertext = await crypto.subtle.encrypt({ name: "RSA-OAEP" }, rsa.publicKey, encoder.encode("secret"));
const wrappedRsa = await crypto.subtle.wrapKey("pkcs8", rsa.privateKey, gcmKek, { name: "AES-GCM", iv });
const rsaBack = await crypto.subtle.unwrapKey(
  "pkcs8",
  wrappedRsa,
  gcmKek,
  { name: "AES-GCM", iv },
  { name: "RSA-OAEP", hash: "SHA-256" },
  false,
  ["decrypt"],
);
const decrypted = await crypto.subtle.decrypt({ name: "RSA-OAEP" }, rsaBack, rsaCiphertext);
console.log("rsa-oaep", new TextDecoder().decode(decrypted), await describe(rsaBack));

// An ECDH private key as a JWK: AES-KW pads the JSON to a multiple of 8.
const ecdh = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
const ecdhJwk = JSON.stringify(await crypto.subtle.exportKey("jwk", ecdh.privateKey));
const wrappedJwk = await crypto.subtle.wrapKey("jwk", ecdh.privateKey, kwKek, "AES-KW");
const jwkBack = await crypto.subtle.unwrapKey(
  "jwk",
  wrappedJwk,
  kwKek,
  "AES-KW",
  { name: "ECDH", namedCurve: "P-256" },
  true,
  ["deriveBits"],
);
const peer = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
const derive = (key: CryptoKey) => crypto.subtle.deriveBits({ name: "ECDH", public: peer.publicKey }, key, 256);
console.log("ecdh jwk", wrappedJwk.byteLength % 8, JSON.stringify(await crypto.subtle.exportKey("jwk", jwkBack)) === ecdhJwk);
console.log("ecdh derive", hex(await derive(jwkBack)) === hex(await derive(ecdh.privateKey)), await describe(jwkBack));

// X25519 private keys wrap like the other asymmetric types.
const x25519 = await crypto.subtle.generateKey({ name: "X25519" }, true, ["deriveBits"]);
const wrappedX = await crypto.subtle.wrapKey("pkcs8", x25519.privateKey, kwKek, "AES-KW");
const xBack = await crypto.subtle.unwrapKey("pkcs8", wrappedX, kwKek, "AES-KW", { name: "X25519" }, true, ["deriveBits"]);
console.log("x25519", (await exported(xBack, "pkcs8")) === (await exported(x25519.privateKey, "pkcs8")));

// A non-extractable key never leaves the subtle object.
const nonExtractable = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
async function attempt(label: string, call: () => Promise<unknown>): Promise<void> {
  try {
    await call();
    console.log(label, "ok");
  } catch (error) {
    const failure = error as Error;
    console.log(label, failure.name, failure.message);
  }
}
await attempt("not extractable", () => crypto.subtle.wrapKey("pkcs8", nonExtractable.privateKey, gcmKek, { name: "AES-GCM", iv }));
await attempt("algorithm mismatch", () => crypto.subtle.wrapKey("pkcs8", ecdsa.privateKey, kwKek, { name: "AES-GCM", iv }));
await attempt("unwrap algorithm mismatch", () =>
  crypto.subtle.unwrapKey("pkcs8", wrappedEd, kwKek, { name: "AES-GCM", iv }, { name: "Ed25519" }, true, ["sign"]),
);
// AES-KW takes only a multiple of 8 bytes, so a P-256 SPKI (91 bytes) and
// 24 unwrapped bytes that are not a valid SPKI both fail like Node.
await attempt("kw spki", () => crypto.subtle.wrapKey("spki", ecdsa.publicKey, kwKek, "AES-KW"));
await attempt("kw unwrap spki", () =>
  crypto.subtle.unwrapKey("spki", new Uint8Array(24), kwKek, "AES-KW", { name: "ECDSA", namedCurve: "P-256" }, true, [
    "verify",
  ]),
);
