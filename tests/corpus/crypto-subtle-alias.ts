// The SubtleCrypto and Crypto objects through const aliases: method calls on
// the binding lower like crypto.subtle's own.
import * as crypto from "node:crypto";

const s = crypto.subtle;
const digest = new Uint8Array(await s.digest("SHA-256", Buffer.from("hello")));
console.log("digest", digest.byteLength);
const key = await s.importKey("raw", Buffer.alloc(16, 1), { name: "HMAC", hash: "SHA-256" }, false, [
  "sign",
  "verify",
]);
const sig = await s.sign("HMAC", key, Buffer.from("msg"));
console.log("hmac", sig.byteLength, await s.verify("HMAC", key, sig, Buffer.from("msg")));
const aes = await s.generateKey({ name: "AES-GCM", length: 128 }, true, ["encrypt", "decrypt"]);
const iv = new Uint8Array(12);
const ct = await s.encrypt({ name: "AES-GCM", iv }, aes, Buffer.from("secret"));
const pt = await s.decrypt({ name: "AES-GCM", iv }, aes, ct);
console.log("gcm", Buffer.from(pt).toString());
const wc = crypto.webcrypto;
const d2 = new Uint8Array(await wc.subtle.digest("SHA-384", Buffer.from("hello")));
console.log("webcrypto", d2.byteLength);
const raw = await s.exportKey("raw", aes);
console.log("export", raw.byteLength);
