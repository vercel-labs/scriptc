/* WebCrypto secret keys under @types/node: generateKey, exportKey and
 * importKey for HMAC and AES keys, and PBKDF2 key imports, lower to the
 * same native values as under the bundled declarations. @types/node
 * names the dictionary, key and JSON Web Key types in node:crypto's
 * webcrypto namespace. */
import type { webcrypto } from "node:crypto";

async function main(): Promise<void> {
  const hmacParams: webcrypto.HmacKeyGenParams = { name: "HMAC", hash: "SHA-256", length: 256 };
  const hmac: webcrypto.CryptoKey = await crypto.subtle.generateKey(hmacParams, true, ["sign", "verify"]);
  const hmacAlgorithm = hmac.algorithm as webcrypto.HmacKeyAlgorithm;
  console.log(hmac.type, hmacAlgorithm.name, hmacAlgorithm.length, hmacAlgorithm.hash.name, hmac.usages.join(","));
  const raw: ArrayBuffer = await crypto.subtle.exportKey("raw", hmac);
  console.log(raw.byteLength);

  const aesParams: webcrypto.AesKeyGenParams = { name: "AES-GCM", length: 192 };
  const aes = await crypto.subtle.generateKey(aesParams, true, ["encrypt", "decrypt"]);
  const aesAlgorithm = aes.algorithm as webcrypto.AesKeyAlgorithm;
  console.log(aesAlgorithm.name, aesAlgorithm.length, aes.extractable);
  const jwk: webcrypto.JsonWebKey = await crypto.subtle.exportKey("jwk", aes);
  console.log(jwk.kty, jwk.alg, jwk.ext, jwk.key_ops?.join(","), jwk.k?.length);
  const back = await crypto.subtle.importKey("jwk", jwk, "AES-GCM", false, ["decrypt"]);
  console.log(back.algorithm.name, back.extractable, back.usages.join(","));

  const fixed = new Uint8Array(16).fill(9);
  const imported = await crypto.subtle.importKey("raw", fixed, { name: "AES-CBC" }, true, ["encrypt"]);
  console.log(Buffer.from(await crypto.subtle.exportKey("raw", imported)).toString("hex"));
  const password = await crypto.subtle.importKey("raw", new TextEncoder().encode("pw"), "PBKDF2", false, ["deriveBits"]);
  console.log(password.algorithm.name, password.extractable, password.usages.join(","));
}

void main();
