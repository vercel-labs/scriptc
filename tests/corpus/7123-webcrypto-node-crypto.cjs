// node:crypto's WebCrypto from CommonJS: destructured webcrypto and
// subtle, the module object's members, the
// `globalThis.crypto ?? require("crypto").webcrypto` fallback libraries
// use to find a Crypto object, and crypto destructured from globalThis,
// all the same object.
const nodeCrypto = require("node:crypto");
const { webcrypto, subtle } = require("crypto");

const encoder = new TextEncoder();
const hex = (buffer) => Buffer.from(new Uint8Array(buffer)).toString("hex");

function cryptoObject() {
  return globalThis.crypto ?? nodeCrypto.webcrypto;
}

async function main() {
  console.log(webcrypto === globalThis.crypto, cryptoObject() === crypto, typeof subtle);
  console.log(hex(await webcrypto.subtle.digest("SHA-256", encoder.encode("abc"))));
  console.log(hex(await subtle.digest("SHA-1", encoder.encode("abc"))));
  console.log(hex(await nodeCrypto.subtle.digest("SHA-256", encoder.encode("abc"))));
  const key = await nodeCrypto.webcrypto.subtle.importKey("raw", encoder.encode("k"), { name: "HMAC", hash: "SHA-1" }, true, ["sign"]);
  console.log(hex(await subtle.sign("HMAC", key, encoder.encode("abc"))));
  const wc = cryptoObject();
  console.log(wc.randomUUID().length, wc.getRandomValues(new Uint8Array(8)).length);
  console.log(typeof webcrypto.randomUUID, typeof nodeCrypto.webcrypto.getRandomValues);
  const { crypto: destructured } = globalThis;
  console.log(destructured === webcrypto, destructured.randomUUID().length);
  console.log(hex(await destructured.subtle.digest("SHA-1", encoder.encode("abc"))));
}

main();
