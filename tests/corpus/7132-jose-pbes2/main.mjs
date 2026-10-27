// The real jose@6.2.12 PBES2 and AES key-wrap paths: EncryptJWT and
// jwtDecrypt from jose's public jose/jwt/encrypt, jose/jwt/decrypt and
// jose/errors entry points, over crypto.subtle importKey, deriveBits,
// wrapKey, unwrapKey, exportKey, encrypt and decrypt. node_modules/jose
// vendors the dist/webapi files those entry points load and their
// declarations, unmodified (MIT, LICENSE.md), with a package.json that
// exports only those entry points. Content keys and IVs are random, so
// tokens are checked by shape and by what they decrypt to.
import { EncryptJWT } from "jose/jwt/encrypt";
import { jwtDecrypt } from "jose/jwt/decrypt";
import * as errors from "jose/errors";

const encoder = new TextEncoder();
const password = encoder.encode("correct horse battery staple");
const kek = new Uint8Array(32);
for (let i = 0; i < kek.length; i++) kek[i] = i * 13 + 5;

async function roundTrip(label, alg, enc, key, header = {}) {
  const token = await new EncryptJWT({ sub: "alice", scope: "read", n: 1 })
    .setProtectedHeader({ alg, enc, ...header })
    .setIssuedAt(1_799_999_000)
    .encrypt(key);
  const parts = token.split(".");
  const { payload, protectedHeader } = await jwtDecrypt(token, key, {
    keyManagementAlgorithms: [alg],
    currentDate: new Date(1_800_000_000_000),
  });
  console.log(label, parts.length, parts[1].length > 0, payload.sub, payload.scope, payload.iat);
  console.log(label, protectedHeader.alg, protectedHeader.enc, protectedHeader.p2c ?? "-");
  return token;
}

const pbes = await roundTrip("pbes2 256", "PBES2-HS256+A128KW", "A256GCM", password);
await roundTrip("pbes2 384", "PBES2-HS384+A192KW", "A128CBC-HS256", password);
await roundTrip("pbes2 512", "PBES2-HS512+A256KW", "A256CBC-HS512", password);
await roundTrip("a128kw", "A128KW", "A128GCM", kek.subarray(0, 16));
await roundTrip("a256kw", "A256KW", "A256CBC-HS512", kek);

try {
  await jwtDecrypt(pbes, encoder.encode("wrong password"), { keyManagementAlgorithms: ["PBES2-HS256+A128KW"] });
  console.log("wrong password accepted");
} catch (e) {
  console.log("wrong password", e instanceof errors.JWEDecryptionFailed, e.code);
}
try {
  await jwtDecrypt(pbes, password);
  console.log("unlisted algorithm accepted");
} catch (e) {
  console.log("unlisted algorithm", e instanceof errors.JOSEAlgNotAllowed, e.code);
}
