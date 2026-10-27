// crypto.subtle.wrapKey and unwrapKey: AES-KW wrapping matches RFC 3394's
// test vectors, raw and JSON Web Key payloads round-trip (AES-KW pads the
// JWK's JSON with spaces to a multiple of 8 bytes), and AES-GCM, AES-CBC
// and AES-CTR wrap keys the way encrypt does. jose's A128KW and
// PBES2-HS256+A128KW content-key wrapping is the shape used here.
const encoder = new TextEncoder();

function hex(buffer: ArrayBuffer): string {
  return Buffer.from(buffer).toString("hex");
}

type Key = Awaited<ReturnType<typeof crypto.subtle.importKey>>;

function describe(key: Key): string {
  return JSON.stringify({ algorithm: key.algorithm, usages: key.usages, extractable: key.extractable });
}

// RFC 3394 section 4: 128-, 192- and 256-bit key data under each KEK size.
const vectors: [string, string, string][] = [
  ["000102030405060708090A0B0C0D0E0F", "00112233445566778899AABBCCDDEEFF", "1fa68b0a8112b447aef34bd8fb5a7b829d3e862371d2cfe5"],
  ["000102030405060708090A0B0C0D0E0F1011121314151617", "00112233445566778899AABBCCDDEEFF", "96778b25ae6ca435f92b5b97c050aed2468ab8a17ad84e5d"],
  ["000102030405060708090A0B0C0D0E0F101112131415161718191A1B1C1D1E1F", "00112233445566778899AABBCCDDEEFF", "64e8c3f9ce0f5ba263e9777905818a2a93c8191e7d6e8ae7"],
  ["000102030405060708090A0B0C0D0E0F1011121314151617", "00112233445566778899AABBCCDDEEFF0001020304050607", "031d33264e15d33268f24ec260743edce1c6c7ddee725a936ba814915c6762d2"],
  ["000102030405060708090A0B0C0D0E0F101112131415161718191A1B1C1D1E1F", "00112233445566778899AABBCCDDEEFF000102030405060708090A0B0C0D0E0F", "28c9f404c4b810f4cbccb35cfb87f8263f5786e2d80ed326cbc7f0e71a99f43bfb988b9b7a02dd21"],
];
for (const [kekHex, dataHex, expected] of vectors) {
  const kek = await crypto.subtle.importKey("raw", Buffer.from(kekHex, "hex"), "AES-KW", false, ["wrapKey", "unwrapKey"]);
  const data = await crypto.subtle.importKey("raw", Buffer.from(dataHex, "hex"), "AES-CBC", true, ["encrypt"]);
  const wrapped = await crypto.subtle.wrapKey("raw", data, kek, "AES-KW");
  console.log(hex(wrapped) === expected, hex(wrapped));
  const unwrapped = await crypto.subtle.unwrapKey("raw", wrapped, kek, { name: "aes-kw" }, "AES-CBC", true, ["decrypt"]);
  console.log(describe(unwrapped), hex(await crypto.subtle.exportKey("raw", unwrapped)));
}

// jose's content-key wrap: an HMAC key wrapped raw, then unwrapped and exported.
const kek = await crypto.subtle.importKey("raw", new Uint8Array(16).fill(7), "AES-KW", true, ["wrapKey", "unwrapKey"]);
const cek = await crypto.subtle.importKey("raw", new Uint8Array(32).fill(9), { name: "HMAC", hash: "SHA-256" }, true, ["sign"]);
const wrappedCek = await crypto.subtle.wrapKey("raw", cek, kek, "AES-KW");
console.log(hex(wrappedCek));
const back = await crypto.subtle.unwrapKey("raw", wrappedCek, kek, "AES-KW", { hash: "SHA-256", name: "HMAC" }, true, ["sign"]);
console.log(describe(back), hex(await crypto.subtle.exportKey("raw", back)));

// JSON Web Key payloads, padded for AES-KW.
const wrappedJwk = await crypto.subtle.wrapKey("jwk", cek, kek, "AES-KW");
console.log(wrappedJwk.byteLength, hex(wrappedJwk));
const fromJwk = await crypto.subtle.unwrapKey("jwk", wrappedJwk, kek, "AES-KW", { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
console.log(describe(fromJwk));
const asRaw = await crypto.subtle.unwrapKey("raw", wrappedJwk, kek, "AES-KW", { name: "HMAC", hash: "SHA-256" }, true, ["sign"]);
const padded = new TextDecoder().decode(await crypto.subtle.exportKey("raw", asRaw));
console.log(JSON.stringify(padded), padded.length);

// The AES ciphers as wrapping algorithms.
const gcmKey = await crypto.subtle.importKey("raw", new Uint8Array(16).fill(3), "AES-GCM", false, ["wrapKey", "unwrapKey"]);
const iv = new Uint8Array(12).fill(1);
const gcmWrapped = await crypto.subtle.wrapKey("jwk", cek, gcmKey, { name: "AES-GCM", iv });
console.log(gcmWrapped.byteLength, hex(gcmWrapped).slice(0, 64));
console.log(describe(await crypto.subtle.unwrapKey("jwk", gcmWrapped, gcmKey, { name: "AES-GCM", iv }, { name: "HMAC", hash: "SHA-256" }, true, ["sign"])));
const cbcKey = await crypto.subtle.importKey("raw", new Uint8Array(32).fill(4), "AES-CBC", false, ["wrapKey", "unwrapKey"]);
const cbcWrapped = await crypto.subtle.wrapKey("raw", cek, cbcKey, { name: "AES-CBC", iv: new Uint8Array(16) });
console.log(hex(cbcWrapped));
console.log(describe(await crypto.subtle.unwrapKey("raw", cbcWrapped, cbcKey, { name: "AES-CBC", iv: new Uint8Array(16) }, "AES-GCM", false, ["encrypt"])));
const ctrKey = await crypto.subtle.importKey("raw", new Uint8Array(24).fill(5), "AES-CTR", false, ["wrapKey", "unwrapKey"]);
const ctr = { name: "AES-CTR", counter: new Uint8Array(16), length: 64 };
const ctrWrapped = await crypto.subtle.wrapKey("raw", cek, ctrKey, ctr);
console.log(hex(ctrWrapped));
const fromCtr = await crypto.subtle.unwrapKey("raw", ctrWrapped, ctrKey, ctr, { name: "HMAC", hash: "SHA-1" }, true, ["verify"]);
console.log(describe(fromCtr));
const signature = await crypto.subtle.sign("HMAC", back, encoder.encode("message"));
console.log(hex(signature).slice(0, 32));
