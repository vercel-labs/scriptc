/* WebCrypto's HMAC slice under @types/node: the crypto global's subtle
 * methods and CryptoKey members lower to the same native values as under
 * the bundled declarations. @types/node names the dictionary and key
 * types in node:crypto's webcrypto namespace. */
import type { webcrypto } from "node:crypto";

async function main(): Promise<void> {
  const encoder = new TextEncoder();
  const params: webcrypto.HmacImportParams = { name: "HMAC", hash: "SHA-512" };
  const key: webcrypto.CryptoKey = await crypto.subtle.importKey("raw", encoder.encode("node-types"), params, true, [
    "verify",
    "sign",
  ]);
  const algorithm = key.algorithm as webcrypto.HmacKeyAlgorithm;
  console.log(key.type, key.extractable, key.usages.join(","), algorithm.name, algorithm.length, algorithm.hash.name);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode("message"));
  console.log(signature.byteLength, Buffer.from(signature).toString("base64"));
  console.log(await crypto.subtle.verify("HMAC", key, signature, encoder.encode("message")));
  console.log(await crypto.subtle.verify("HMAC", key, signature, encoder.encode("massage")));
  const digest = await crypto.subtle.digest("SHA-384", encoder.encode("message"));
  console.log(Buffer.from(digest).toString("hex"));
  console.log(key instanceof CryptoKey);
}

void main();
