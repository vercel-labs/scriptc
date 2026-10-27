// crypto.crypto.subtle.generateKey, exportKey and importKey for secret keys:
// HMAC and AES keys generated at every length, exported as raw bytes and
// as JSON Web Keys, imported back from both forms, and PBKDF2 and HKDF
// base keys imported from raw bytes. Random key bytes are checked by
// length and round trip, not by value.
const encoder = new TextEncoder();

type Key = Awaited<ReturnType<typeof crypto.subtle.importKey>>;

function describe(key: Key): string {
  return JSON.stringify({
    type: key.type,
    extractable: key.extractable,
    algorithm: key.algorithm,
    usages: key.usages,
  });
}

function hex(buffer: ArrayBuffer): string {
  return Buffer.from(buffer).toString("hex");
}

async function show(label: string, run: () => Promise<string>): Promise<void> {
  try {
    console.log(label, await run());
  } catch (e) {
    const error = e as Error & { code?: string };
    console.log(label, "rejects", error.name, error.code, error.message);
  }
}

for (const hash of ["SHA-1", "SHA-256", "SHA-384", "SHA-512"]) {
  await show(`hmac ${hash}`, async () => {
    const key = await crypto.subtle.generateKey({ name: "HMAC", hash }, true, ["sign", "verify"]);
    const raw = await crypto.subtle.exportKey("raw", key);
    return `${describe(key)} ${raw.byteLength}`;
  });
}
await show("hmac length 100", async () => {
  const key = await crypto.subtle.generateKey({ name: "HMAC", hash: { name: "SHA-512" }, length: 100 }, true, ["sign"]);
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", key));
  return `${describe(key)} ${raw.length} ${raw[12]! & 0x0f}`;
});
for (const name of ["AES-GCM", "AES-CBC", "AES-CTR", "AES-KW"]) {
  for (const length of [128, 192, 256]) {
    await show(`${name} ${length}`, async () => {
      const usages: ("wrapKey" | "unwrapKey" | "encrypt" | "decrypt")[] =
        name === "AES-KW" ? ["wrapKey", "unwrapKey"] : ["encrypt", "decrypt"];
      const key = await crypto.subtle.generateKey({ name, length }, true, usages);
      const jwk = await crypto.subtle.exportKey("jwk", key);
      return `${describe(key)} ${jwk.alg} ${jwk.kty} ${jwk.k!.length} ${JSON.stringify(jwk.key_ops)} ${jwk.ext}`;
    });
  }
}

// Fixed key bytes: the exported forms are deterministic.
const bytes = new Uint8Array(32);
for (let i = 0; i < bytes.length; i++) bytes[i] = i * 7 + 1;
const hmac = await crypto.subtle.importKey("raw", bytes, { name: "HMAC", hash: "SHA-384" }, true, ["verify", "sign"]);
const hmacJwk = await crypto.subtle.exportKey("jwk", hmac);
console.log(JSON.stringify(hmacJwk), Object.keys(hmacJwk).join(","));
console.log(hex(await crypto.subtle.exportKey("raw", hmac)) === Buffer.from(bytes).toString("hex"));
const reimported = await crypto.subtle.importKey("jwk", hmacJwk, { name: "HMAC", hash: "SHA-384" }, true, ["sign"]);
console.log(describe(reimported));
const signature = await crypto.subtle.sign("HMAC", reimported, encoder.encode("payload"));
console.log(await crypto.subtle.verify("HMAC", hmac, signature, encoder.encode("payload")));

const short = await crypto.subtle.importKey("raw", bytes.subarray(0, 20), { name: "HMAC", hash: "SHA-1", length: 156 }, true, ["sign"]);
console.log(describe(short), JSON.stringify(await crypto.subtle.exportKey("jwk", short)));
console.log(hex(await crypto.subtle.exportKey("raw-secret", short)));

for (const length of [16, 24, 32]) {
  const key = await crypto.subtle.importKey("raw", bytes.subarray(0, length), "AES-GCM", true, ["encrypt"]);
  const jwk = await crypto.subtle.exportKey("jwk", key);
  console.log(describe(key), JSON.stringify(jwk));
  const back = await crypto.subtle.importKey("jwk", jwk, { name: "AES-GCM" }, false, ["encrypt"]);
  console.log(describe(back));
}
const cbc = await crypto.subtle.importKey("raw-secret", bytes.subarray(0, 16), "aes-cbc", true, ["decrypt", "unwrapKey"]);
console.log(describe(cbc), hex(await crypto.subtle.exportKey("raw", cbc)));
const wrap = await crypto.subtle.importKey("raw", bytes.subarray(0, 24), "AES-KW", true, ["unwrapKey", "wrapKey"]);
console.log(describe(wrap), JSON.stringify(await crypto.subtle.exportKey("jwk", wrap)));

const password = encoder.encode("correct horse battery staple");
const pbkdf2 = await crypto.subtle.importKey("raw", password, "PBKDF2", false, ["deriveBits", "deriveKey"]);
console.log(describe(pbkdf2));
const hkdf = await crypto.subtle.importKey("raw-secret", bytes, { name: "hkdf" }, false, ["deriveKey"]);
console.log(describe(hkdf));
const empty = await crypto.subtle.importKey("raw", new Uint8Array(0), "PBKDF2", false, ["deriveBits"]);
console.log(describe(empty));
console.log(hmac instanceof CryptoKey, pbkdf2 instanceof CryptoKey);
