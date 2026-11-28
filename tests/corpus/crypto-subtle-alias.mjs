// The JavaScript lane of the SubtleCrypto alias: a const binding of
// crypto.subtle, of crypto.webcrypto and of globalThis.crypto.subtle.
import * as crypto from "node:crypto";

const s = crypto.subtle;
console.log("digest", new Uint8Array(await s.digest("SHA-256", Buffer.from("x"))).byteLength);
const wc = crypto.webcrypto;
console.log("wc", new Uint8Array(await wc.subtle.digest("SHA-512", Buffer.from("x"))).byteLength);
const gs = globalThis.crypto.subtle;
console.log("global", new Uint8Array(await gs.digest("SHA-1", Buffer.from("x"))).byteLength);
const key = await s.importKey("raw", Buffer.alloc(32, 2), { name: "HMAC", hash: "SHA-256" }, false, [
  "sign",
  "verify",
]);
const sig = await s.sign("HMAC", key, Buffer.from("m"));
console.log("hmac", sig.byteLength, await s.verify("HMAC", key, sig, Buffer.from("m")));
