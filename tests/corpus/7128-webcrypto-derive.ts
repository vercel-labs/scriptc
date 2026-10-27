// crypto.crypto.subtle.deriveBits and deriveKey with PBKDF2 and HKDF: Node's
// exact derived bytes for every SHA digest, zero-length derivations, the
// SCRAM-style PBKDF2-then-HMAC chain, and derived AES and HMAC keys that
// encrypt and sign.
const encoder = new TextEncoder();

function hex(buffer: ArrayBuffer): string {
  return Buffer.from(buffer).toString("hex");
}

const password = await crypto.subtle.importKey("raw", encoder.encode("pencil"), "PBKDF2", false, ["deriveBits", "deriveKey"]);
const ikm = await crypto.subtle.importKey("raw", encoder.encode("input keying material"), { name: "HKDF" }, false, ["deriveBits", "deriveKey"]);
const salt = encoder.encode("QSXCR+Q6sek8bf92");
const info = encoder.encode("context");

for (const hash of ["SHA-1", "SHA-256", "SHA-384", "SHA-512"]) {
  console.log("pbkdf2", hash, hex(await crypto.subtle.deriveBits({ name: "PBKDF2", hash, salt, iterations: 4096 }, password, 256)));
  console.log("hkdf", hash, hex(await crypto.subtle.deriveBits({ name: "HKDF", hash: { name: hash }, salt, info }, ikm, 256)));
}
console.log("pbkdf2 0", (await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: 1 }, password, 0)).byteLength);
console.log("hkdf 0", (await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, ikm, 0)).byteLength);
console.log("hkdf empty salt and info", hex(await crypto.subtle.deriveBits({ name: "hkdf", hash: "SHA-256", salt: new Uint8Array(0), info: new Uint8Array(0) }, ikm, 128)));
console.log("hkdf max", (await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-1", salt, info }, ikm, 255 * 20 * 8)).byteLength);

// SCRAM-SHA-256's client proof inputs, the way database drivers compute them.
const saltedPassword = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: 4096 }, password, 256);
const salted = await crypto.subtle.importKey("raw", saltedPassword, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
const clientKey = await crypto.subtle.sign("HMAC", salted, encoder.encode("Client Key"));
console.log("client key", hex(clientKey));
console.log("stored key", hex(await crypto.subtle.digest("SHA-256", clientKey)));

const aes = await crypto.subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt, iterations: 1000 }, password, { name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
console.log(JSON.stringify(aes.algorithm), aes.usages.join(","), aes.extractable);
console.log("aes key", hex(await crypto.subtle.exportKey("raw", aes)));
const iv = new Uint8Array(12);
const sealed = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, aes, encoder.encode("derived"));
console.log(hex(sealed), new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv }, aes, sealed)));

const mac = await crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt, info }, ikm, { name: "HMAC", hash: "SHA-384" }, false, ["sign", "verify"]);
console.log(JSON.stringify(mac.algorithm), mac.extractable);
console.log("mac", hex(await crypto.subtle.sign("HMAC", mac, encoder.encode("message"))));
const shortMac = await crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-1", salt, info }, ikm, { name: "HMAC", hash: "SHA-1", length: 128 }, true, ["sign"]);
console.log(JSON.stringify(shortMac.algorithm), hex(await crypto.subtle.exportKey("raw", shortMac)));
const wrap = await crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-512", salt, info }, ikm, { name: "AES-KW", length: 128 }, true, ["wrapKey"]);
console.log(JSON.stringify(wrap.algorithm), JSON.stringify(await crypto.subtle.exportKey("jwk", wrap)));
