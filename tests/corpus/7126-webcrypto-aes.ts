// crypto.crypto.subtle.encrypt and decrypt with AES-GCM, AES-CBC and AES-CTR:
// fixed keys, IVs and inputs give Node's exact ciphertexts, every key
// length and GCM tag length round-trips, and CTR counters wrap within
// their low `length` bits.
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function hex(buffer: ArrayBuffer): string {
  return Buffer.from(buffer).toString("hex");
}

function bytes(length: number, seed: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) out[i] = (i * 31 + seed) & 0xff;
  return out;
}

const plaintext = encoder.encode("The quick brown fox jumps over the lazy dog");
for (const length of [16, 24, 32]) {
  const raw = bytes(length, length);
  const gcm = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
  const cbc = await crypto.subtle.importKey("raw", raw, "AES-CBC", false, ["encrypt", "decrypt"]);
  const ctr = await crypto.subtle.importKey("raw", raw, "AES-CTR", false, ["encrypt", "decrypt"]);
  const iv = bytes(12, 7);
  const sealed = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, gcm, plaintext);
  console.log("gcm", length, sealed.byteLength, hex(sealed));
  console.log(decoder.decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv }, gcm, sealed)));
  const aad = encoder.encode("header");
  const tagged = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad, tagLength: 96 }, gcm, plaintext);
  console.log("gcm aad", length, hex(tagged));
  console.log(decoder.decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: aad, tagLength: 96 }, gcm, tagged)));
  const cbcIv = bytes(16, 3);
  const padded = await crypto.subtle.encrypt({ name: "AES-CBC", iv: cbcIv }, cbc, plaintext);
  console.log("cbc", length, padded.byteLength, hex(padded));
  console.log(decoder.decode(await crypto.subtle.decrypt({ name: "AES-CBC", iv: cbcIv }, cbc, padded)));
  const counter = bytes(16, 9);
  const streamed = await crypto.subtle.encrypt({ name: "AES-CTR", counter, length: 64 }, ctr, plaintext);
  console.log("ctr", length, hex(streamed));
  console.log(decoder.decode(await crypto.subtle.decrypt({ name: "AES-CTR", counter, length: 64 }, ctr, streamed)));
}

const key = await crypto.subtle.importKey("raw", bytes(16, 1), "AES-GCM", true, ["encrypt", "decrypt"]);
for (const tagLength of [32, 64, 96, 104, 112, 120, 128]) {
  const iv = bytes(16, tagLength);
  const sealed = await crypto.subtle.encrypt({ name: "AES-GCM", iv, tagLength }, key, plaintext.subarray(0, 5));
  const opened = await crypto.subtle.decrypt({ name: "AES-GCM", iv, tagLength }, key, sealed);
  console.log("tag", tagLength, sealed.byteLength, hex(sealed), decoder.decode(opened));
}
console.log("gcm empty", hex(await crypto.subtle.encrypt({ name: "AES-GCM", iv: new Uint8Array(12) }, key, new Uint8Array(0))));
console.log("gcm long iv", hex(await crypto.subtle.encrypt({ name: "AES-GCM", iv: bytes(128, 5) }, key, plaintext.subarray(0, 3))));

const cbcKey = await crypto.subtle.importKey("raw", bytes(16, 2), "AES-CBC", false, ["encrypt", "decrypt"]);
for (const length of [0, 1, 15, 16, 17, 32]) {
  const sealed = await crypto.subtle.encrypt({ name: "AES-CBC", iv: new Uint8Array(16) }, cbcKey, bytes(length, 4));
  const opened = await crypto.subtle.decrypt({ name: "AES-CBC", iv: new Uint8Array(16) }, cbcKey, sealed);
  console.log("cbc length", length, sealed.byteLength, opened.byteLength, hex(opened) === hex(bytes(length, 4).buffer as ArrayBuffer));
}

const ctrKey = await crypto.subtle.importKey("raw", new Uint8Array(16), "AES-CTR", false, ["encrypt"]);
const allOnes = new Uint8Array(16).fill(0xff);
const zeros = new Uint8Array(64);
console.log("ctr wrap 4", hex(await crypto.subtle.encrypt({ name: "AES-CTR", counter: allOnes, length: 4 }, ctrKey, zeros)));
console.log("ctr wrap 128", hex(await crypto.subtle.encrypt({ name: "AES-CTR", counter: allOnes, length: 128 }, ctrKey, zeros)));
console.log("ctr wrap 2", hex(await crypto.subtle.encrypt({ name: "AES-CTR", counter: allOnes, length: 2 }, ctrKey, zeros)));
console.log("ctr 1 bit, 2 blocks", hex(await crypto.subtle.encrypt({ name: "AES-CTR", counter: new Uint8Array(16), length: 1 }, ctrKey, zeros.subarray(0, 32))));
console.log("ctr partial", hex(await crypto.subtle.encrypt({ name: "AES-CTR", counter: bytes(16, 6), length: 128 }, ctrKey, zeros.subarray(0, 21))));

const generated = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
const iv = crypto.getRandomValues(new Uint8Array(12));
const message = encoder.encode("generated key round trip");
const sealed = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, generated, message);
console.log(sealed.byteLength, decoder.decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv }, generated, sealed)));
const exported = await crypto.subtle.exportKey("jwk", generated);
const reimported = await crypto.subtle.importKey("jwk", exported, "AES-GCM", false, ["decrypt"]);
console.log(decoder.decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv }, reimported, sealed)));
console.log(decoder.decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv }, generated, new DataView(sealed))));
console.log(decoder.decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: iv.buffer as ArrayBuffer }, generated, Buffer.from(sealed))));
