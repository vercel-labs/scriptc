// The real jose@6.2.12 RSA-OAEP key-management paths: EncryptJWT and
// jwtDecrypt over crypto.subtle.generateKey (RSA-OAEP with SHA-256),
// subtle.encrypt and subtle.decrypt, and a decrypt with the wrong key.
// Content-encryption keys and IVs are random, so tokens are checked by
// shape and by what they decrypt to.
import { EncryptJWT } from "jose/jwt/encrypt";
import { jwtDecrypt } from "jose/jwt/decrypt";

async function roundTrip(label, alg, enc, key, decryptKey = key) {
  const token = await new EncryptJWT({ sub: "alice", scope: "read", n: 1 })
    .setProtectedHeader({ alg, enc })
    .setIssuedAt(1_799_999_000)
    .encrypt(key);
  const parts = token.split(".");
  const { payload, protectedHeader } = await jwtDecrypt(token, decryptKey, {
    keyManagementAlgorithms: [alg],
    currentDate: new Date(1_800_000_000_000),
  });
  console.log(label, parts.length, parts[1].length > 0, payload.sub, payload.scope, payload.iat);
  console.log(label, protectedHeader.alg, protectedHeader.enc);
  return token;
}

const rsa = await crypto.subtle.generateKey(
  { name: "RSA-OAEP", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
  true,
  ["encrypt", "decrypt", "wrapKey", "unwrapKey"],
);
console.log("key", rsa.publicKey.algorithm.name, rsa.publicKey.algorithm.modulusLength, rsa.privateKey.usages.join(","));
await roundTrip("rsa-oaep", "RSA-OAEP-256", "A256GCM", rsa.publicKey, rsa.privateKey);
await roundTrip("rsa-oaep cbc", "RSA-OAEP-256", "A128CBC-HS256", rsa.publicKey, rsa.privateKey);

const other = await crypto.subtle.generateKey(
  { name: "RSA-OAEP", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
  true,
  ["encrypt", "decrypt"],
);
try {
  await jwtDecrypt(await roundTrip("wrong key token", "RSA-OAEP-256", "A256GCM", rsa.publicKey, rsa.privateKey), other.privateKey, {
    keyManagementAlgorithms: ["RSA-OAEP-256"],
    currentDate: new Date(1_800_000_000_000),
  });
  console.log("wrong key", "decrypted");
} catch (error) {
  console.log("wrong key", error.name, error.code);
}
