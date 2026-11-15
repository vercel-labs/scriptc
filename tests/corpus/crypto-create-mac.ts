// crypto.createMac(): Node's MAC factory. HMAC is the algorithm the native
// runtime computes (other MAC names are rejected by the lowering), and the
// Mac handle answers the same bytes as createHmac. The handle validates its
// arguments in Node's order and marks itself finalized once, so a second
// final() or a later update() throws.
import { createHmac, createMac, createSecretKey, getMacs } from "node:crypto";

const key = Buffer.from("secret-key");
const message = Buffer.from("hello world");

// The digest of incremental string, Uint8Array and Buffer updates matches
// createHmac for the same key and data.
const mac = createMac("hmac", key, { digest: "sha256" });
mac.update("hello ");
mac.update(new Uint8Array([0x77, 0x6f, 0x72, 0x6c, 0x64]));
const digest = mac.final("hex");
console.log(digest.length, digest === createHmac("sha256", key).update(message).digest("hex"));

// final() with no argument answers a Buffer, and an encoding names the
// answer's encoding.
const bufferMac = createMac("hmac", key, { digest: "sha256" });
bufferMac.update("hello world");
const buffer = bufferMac.final();
console.log(Buffer.isBuffer(buffer), buffer.length, buffer.toString("hex") === digest);
const utf8Mac = createMac("hmac", key, { digest: "sha256" });
utf8Mac.update("hello world");
console.log(typeof utf8Mac.final("utf8") === "string");
const base64Mac = createMac("hmac", key, { digest: "sha256" });
base64Mac.update("hello world");
console.log(base64Mac.final("base64") === createHmac("sha256", key).update("hello world").digest("base64"));

// The algorithm name and digest name are matched case-insensitively, and a
// secret KeyObject is a valid key.
console.log(createMac("HMAC", key, { digest: "SHA256" }).update("hello world").final("hex") === digest);
const keyObject = createSecretKey(key);
console.log(createMac("hmac", keyObject, { digest: "sha256" }).update("hello world").final("hex") === digest);

// Every BufferSource form is a valid key: ArrayBuffer, Uint8Array, DataView.
const bytes = new Uint8Array(Buffer.from("secret-key"));
console.log(
  createMac("hmac", bytes.buffer as ArrayBuffer, { digest: "sha256" }).update("hello world").final("hex") === digest,
  createMac("hmac", new DataView(bytes.buffer), { digest: "sha256" }).update("hello world").final("hex") === digest,
);

// update() accepts a string with an encoding, and a final without an
// encoding answers the same bytes as a hex digest.
const encoded = createMac("hmac", key, { digest: "sha256" });
encoded.update("68656c6c6f20776f726c64", "hex");
console.log(encoded.final("hex") === digest);
const chained = createMac("hmac", key, { digest: "sha256" });
console.log(chained.update("hello ").update(Buffer.from("world")).final("hex") === digest);

// crypto.getMacs() lists the MAC names the runtime answers.
const macs = getMacs();
console.log(macs.includes("hmac"), macs.includes("cmac"), macs.includes("no-such-mac"), Array.isArray(macs));
