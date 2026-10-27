// WebCrypto HMAC through the crypto global: importKey('raw') for SHA-1 and
// SHA-2 keys, sign and verify (a wrong or short signature answers false),
// the CryptoKey members, instanceof CryptoKey, the key sources importKey
// and sign accept, and that results settle asynchronously.
const encoder = new TextEncoder();
const secret = encoder.encode("scriptc-webcrypto-secret");
const data = encoder.encode("header.payload");

function hex(buffer: ArrayBuffer): string {
  return Buffer.from(buffer).toString("hex");
}

const key = await crypto.subtle.importKey(
  "raw",
  secret,
  { name: "HMAC", hash: "SHA-256" },
  false,
  ["sign", "verify"],
);
console.log(key.type, key.extractable, key.usages.join(","));
const algorithm = key.algorithm as HmacKeyAlgorithm;
console.log(algorithm.name, algorithm.length, algorithm.hash.name);
console.log(key instanceof CryptoKey, key.algorithm === key.algorithm, key.usages === key.usages);

const signature = await crypto.subtle.sign("HMAC", key, data);
console.log(signature.byteLength, hex(signature));
console.log(await crypto.subtle.verify("HMAC", key, signature, data));
console.log(await crypto.subtle.verify({ name: "HMAC" }, key, signature, encoder.encode("header.payloaD")));
const tampered = new Uint8Array(signature);
tampered[0] ^= 1;
console.log(await crypto.subtle.verify("HMAC", key, tampered, data));
console.log(await crypto.subtle.verify("HMAC", key, signature.slice(0, 16), data));
console.log(await crypto.subtle.verify("HMAC", key, new Uint8Array(0), data));

for (const hash of ["SHA-1", "SHA-384", "SHA-512"]) {
  const k = await crypto.subtle.importKey("raw", secret, { name: "HMAC", hash }, true, ["sign"]);
  const a = k.algorithm as HmacKeyAlgorithm;
  const mac = await crypto.subtle.sign({ name: "hmac" }, k, data);
  console.log(hash, a.hash.name, a.length, k.extractable, k.usages.join(","), mac.byteLength, hex(mac));
}

// Names normalize case-insensitively; usages come back in Node's order.
const lower = await crypto.subtle.importKey(
  "raw",
  secret,
  { name: "hmac", hash: { name: "sha-256" } },
  true,
  ["verify", "sign"],
);
const lowerAlgorithm = lower.algorithm as HmacKeyAlgorithm;
console.log(lowerAlgorithm.name, lowerAlgorithm.hash.name, lower.usages.join(","));

// An explicit length in bits must match the key bytes.
const sized = await crypto.subtle.importKey(
  "raw",
  secret,
  { name: "HMAC", hash: "SHA-256", length: secret.length * 8 },
  false,
  ["verify"],
);
console.log((sized.algorithm as HmacKeyAlgorithm).length, sized.usages.join(","));

// Key and data sources: ArrayBuffer, Buffer, DataView and subarray views.
const fromBuffer = await crypto.subtle.importKey(
  "raw",
  secret.slice().buffer,
  { name: "HMAC", hash: "SHA-256" },
  false,
  ["sign"],
);
console.log(hex(await crypto.subtle.sign("HMAC", fromBuffer, Buffer.from("header.payload"))) === hex(signature));
const padded = encoder.encode("xxheader.payloadyy");
console.log(hex(await crypto.subtle.sign("HMAC", key, padded.subarray(2, 16))) === hex(signature));
console.log(hex(await crypto.subtle.sign("HMAC", key, new DataView(data.buffer))) === hex(signature));

// The data is read when sign is called.
const mutable = encoder.encode("header.payload");
const pending = crypto.subtle.sign("HMAC", key, mutable);
mutable[0] = 0;
console.log(hex(await pending) === hex(signature));

// Results settle after the synchronous code that started them.
const order: string[] = [];
const signed = crypto.subtle.sign("HMAC", key, data).then(() => {
  order.push("sign");
});
const imported = crypto.subtle
  .importKey("raw", secret, { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
  .then(() => {
    order.push("importKey");
  });
order.push("sync");
await Promise.all([signed, imported]);
console.log(order.join(","));
