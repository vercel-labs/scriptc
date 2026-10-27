// WebCrypto reached through node:crypto: the webcrypto export (named and
// through the namespace), the module's own subtle export, and their
// identity with the crypto global. Each form runs the same HMAC and
// digest calls as the global.
import * as nodeCrypto from "node:crypto";
import { subtle, webcrypto } from "node:crypto";

const encoder = new TextEncoder();
const message = encoder.encode("node:crypto webcrypto");

function hex(buffer: ArrayBuffer): string {
  return Buffer.from(buffer).toString("hex");
}

console.log(webcrypto === crypto, webcrypto === globalThis.crypto, nodeCrypto.webcrypto === crypto);
console.log(hex(await webcrypto.subtle.digest("SHA-256", message)));
console.log(hex(await subtle.digest("SHA-1", message)));
console.log(hex(await nodeCrypto.subtle.digest({ name: "SHA-384" }, message)));
console.log(hex(await nodeCrypto.webcrypto.subtle.digest("SHA-512", message)));

const secret = encoder.encode("shared secret");
const params = { name: "HMAC", hash: "SHA-256" };
const signer = await webcrypto.subtle.importKey("raw", secret, params, false, ["sign"]);
const verifier = await subtle.importKey("raw", secret, params, false, ["verify"]);
const signature = await nodeCrypto.subtle.sign("HMAC", signer, message);
console.log(hex(signature));
console.log(await nodeCrypto.webcrypto.subtle.verify("HMAC", verifier, signature, message));
console.log(await subtle.verify("HMAC", verifier, signature, encoder.encode("other")));
console.log(signer instanceof CryptoKey, signer.algorithm.name, verifier.usages.join(","));

const shape = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
console.log(shape.test(webcrypto.randomUUID()), shape.test(nodeCrypto.webcrypto.randomUUID()));
console.log(webcrypto.getRandomValues(new Uint32Array(4)).length);
try {
  await subtle.digest("MD5", message);
} catch (e) {
  console.log((e as Error).name, (e as Error).message);
}
