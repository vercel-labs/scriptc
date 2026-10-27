/* WebCrypto ECDSA, Ed25519 and RSA under @types/node: generateKey, exportKey,
 * importKey, sign and verify lower to the same native values as under the
 * bundled declarations. */
import type { webcrypto } from "node:crypto";

async function main(): Promise<void> {
  const data = new TextEncoder().encode("node-types");
  const params: webcrypto.EcKeyGenParams = { name: "ECDSA", namedCurve: "P-384" };
  const pair: webcrypto.CryptoKeyPair = await crypto.subtle.generateKey(params, true, ["sign", "verify"]);
  const ecdsa: webcrypto.EcdsaParams = { name: "ECDSA", hash: "SHA-384" };
  const signature = await crypto.subtle.sign(ecdsa, pair.privateKey, data);
  console.log(pair.privateKey.type, signature.byteLength, await crypto.subtle.verify(ecdsa, pair.publicKey, signature, data));
  const spki = await crypto.subtle.exportKey("spki", pair.publicKey);
  const imported = await crypto.subtle.importKey("spki", spki, { name: "ECDSA", namedCurve: "P-384" }, false, ["verify"]);
  const algorithm = imported.algorithm as webcrypto.EcKeyAlgorithm;
  console.log(algorithm.name, algorithm.namedCurve, await crypto.subtle.verify(ecdsa, imported, signature, data));
  const jwk: webcrypto.JsonWebKey = await crypto.subtle.exportKey("jwk", pair.privateKey);
  console.log(jwk.kty, jwk.crv, jwk.key_ops?.join(","));
  const rsa = await crypto.subtle.generateKey(
    { name: "RSA-PSS", modulusLength: 1024, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
  const pss: webcrypto.RsaPssParams = { name: "RSA-PSS", saltLength: 32 };
  const rsaSignature = await crypto.subtle.sign(pss, rsa.privateKey, data);
  console.log(rsaSignature.byteLength, await crypto.subtle.verify(pss, rsa.publicKey, rsaSignature, data));
  const ed = (await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])) as webcrypto.CryptoKeyPair;
  const edSignature = await crypto.subtle.sign("Ed25519", ed.privateKey, data);
  const raw = await crypto.subtle.exportKey("raw", ed.publicKey);
  const edPublic = await crypto.subtle.importKey("raw", raw, "Ed25519", true, ["verify"]);
  console.log(edPublic.algorithm.name, raw.byteLength, edSignature.byteLength, await crypto.subtle.verify("Ed25519", edPublic, edSignature, data));
}

void main();
