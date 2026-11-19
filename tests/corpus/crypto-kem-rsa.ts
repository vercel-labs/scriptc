// crypto.encapsulate/decapsulate over raw RSA (the shared secret is a
// modulus-sized random value encrypted with the public key): fixed
// Node-produced keys and ciphertexts, the private-key and PEM forms, the
// key types the KEM API refuses, and wrong-length ciphertexts.
// @normalize-pid
import { createPrivateKey, createPublicKey, createSecretKey, decapsulate, encapsulate, generateKeyPairSync } from "node:crypto";

const log = (...a: unknown[]) => console.log(a.map(String).join(" | "));
const attempt = (label: string, run: () => unknown): void => {
  try { const r = run(); log(label, "ok", r === undefined ? "undefined" : typeof r); }
  catch (error) { const x = error as Error & { code?: string }; log(label, x.name, x.code, "|", x.message); }
};

const key = "-----BEGIN PRIVATE KEY-----\n" + "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDoZxnk2QCzlHvaVQ1dqxLVlpVKutXn3FYAL5PiF0LoF1YQH+V74dKl+MJdZ67pO41F9dbp3p7/KM8UZFhcrhFm6FruegGnjAoROL0f8/+W6vshIZV04gLu4bAJTcX9GEwldFZDuCNQGKicnS+s+0lGKFNOAAyeKARHKJWpyVbt2O6y+3l09Jdr+4DdKyY0hiigXyhiR4r7KHSxW78D2QR7pbsfXOIX0DKMqDcoVZ4jXEe3fu1AlwTF59slYN+PI3nMgJr3cYJK/+X8RlToxa2IreaWt5mufDvrqKdRL5srghpN/Sp1O0ukqIEcFHtsZj6wfr62mqYG90Gv7Fhh5yjvAgMBAAECggEAahkzpZn6K4HkvyroJLSmrxMFii3c3PLm4kPWSDglZ+7LcCYXruRMNlBob5sXq8vvtZpD6NYlEUkwrNcYzgr7z9bROKFDoxmYOP+FvBI5Q814I8qAwHE0NJmdM8opUuAmV00S2uy0VmtDguhx7Q91hs1/JpN4LzYGqfPZy78q6/8oUCXw6PgsyoYc9V+KX9ERRLl7+Z7pzOpRWBhQdgCSmD7+9b3Ezkd8vF0U0ysD3OQ6+oHGMmLYCxHmom3uQVbcbgSdCqhEt0tulpWw5d0fhtNxzzstI5Ex5lOVdeRuRfpBdfJafNN5FmrO2D8sjujJQkdDX1OOFfq4KUQ3o7hEwQKBgQD3982/BtM0W/qyI56f/RaLCJquDTxljTyEpoMCezzK18fvi0l+egH2J8jmJT8qNu2jUf9YFMUO5yrA9oKdaFnIUCcUcyRKwUiXo0lNSwRWiZNAKKb/RfvIvMe0P2a8F2XMqlOvjKfQM4Eb0Hipv+26OzPf8mLAeksz9gvSV7MGwQKBgQDv7jpCKNCuiS62UW6Czt67LZGjkX+9PJFjc0ztGLB7OcNn5l0qVOYym15xuZPjR71ogkrbaaXH1oQ9XATqBg8d5Aaj4BqNTBESNI2l+tsntNB4XZpImFqv4IMDA6rud8P0r7Tj9yS+PNZbVvISicsfaX4+wj4SH4riSklzQUtLrwKBgGMdtivpOnrvWSHjgwBIVb51Tf7MY5vj/JC5Thyrzfz2i4CAmHvpoOcXuAHmWX0yP4LMv9ghVTNDy58d6c+palnbUAOokpUe9TlHl4FBvxYoH6fBmB7phl8StnCh9xqv740DeDfvbRSXwb+wcMrJYOjTyUR2ympNd8npS4hkbbcBAoGBAKp1pRxV5RTrT62mIw56LNHs6Ri9iXSHsH9oblHQham2eza4+p3VnYp8ydegUgpacJ3sW4SRBX/5zw/M7YzaaykAVRteX17dmQ9HGQ/ALq2CD85EKhXDcEKeDlY459ruaeDQaILBlnA1xtEz713uWcpiZ5fs5q53jHOC9bYVwInvAoGAE2MoxfjHsylhp/GnJBXqe2xZz0UhAJo4KaYHkG7oWV8absIXQHHIUe2mh+WAQPyiizN0YRBPPxUD2FA9eJ6Na95l3XWET/sFp0yWFQhLIRUzfj90LDYEZMT6yG411u/lZDooDVAwX9M2CqySbxzT6XwZRyYCaQfoJEyXhMAkkDA=" + "\n-----END PRIVATE KEY-----\n";
const priv = createPrivateKey(key);
const pub = createPublicKey(priv);
const nodeCt = Buffer.from("SOXed9CuQIMwJECTNwyZTiP1+oLQVUoqw5EZfjYqL0PAa8e5iPdzcMFGrjXJ02P5fLS/KP/pThOZI9kDGiaM1Xoa4+ddEuvsW4+yoxH6ywdvRzKjlSB2qLpS59uA5SBKQB0qJ4zPAHFRqCjoEhvpF2DfB44w0PKRqZ+uVtUqhMIJ3eVSvK2z0sCgah6wv3mvLMSEi+dyp7hD3rz0HznO3BQid3sxkjjNuUm8eDQk4u8LQnw4uZV5flle6hDUYHiYqQeWuSeVdf7yLMZ1pjAF8k2Sv8hpWJyFzzqU6O/tVGiqkR1UWf+uhsitMYBIXmZHz8p7fMLjx/pIr5he55s5OQ==", "base64");
const nodeShared = Buffer.from("maEzSGscFtlqUh+WU2bh1NhIdHwNHYdbxYI4XAgJ9IDCYrutzbv5EWLYRWTDzI3eCk8TOehqZ52pQqMxFgYSc439e1xt4AipmJqbU2Z4P3hnlMSxxPepF7xc8ylI54vBPBNUM4EvvkQzeDsGvJGpa9G/tBLVA5UCHJ56Og7iUW/Z9PH02tzpILl7EanqrYDqxm7ELcIy0n0JAteZrXozQyUZLJHoB1cZosfC/vE1k7zGc+nyGhxN1mrhYmHoBlSLwboC/vuPwJRLT5S2rbntsFPKcj0GRY6H1r9Cus+HrDDqmkkaNn128KzMWFv4uZ5LoVr5fzH1+3f9F5SdONmy0g==", "base64");
log("key", priv.asymmetricKeyType, pub.asymmetricKeyType);
log("decaps node", decapsulate(priv, nodeCt).equals(nodeShared));
log("pem", decapsulate(key, nodeCt).equals(nodeShared));
const enc = encapsulate(pub);
log("encaps", enc.ciphertext.length, enc.sharedKey.length, decapsulate(priv, enc.ciphertext).equals(enc.sharedKey));
const fromPrivate = encapsulate(priv);
log("encaps private", fromPrivate.ciphertext.length, decapsulate(priv, fromPrivate.ciphertext).equals(fromPrivate.sharedKey));
attempt("decaps public", () => decapsulate(pub, nodeCt));
attempt("short ciphertext", () => decapsulate(priv, nodeCt.subarray(0, 10)));
attempt("wrong length", () => decapsulate(priv, Buffer.alloc(255)));
attempt("other key ciphertext", () => decapsulate(priv, Buffer.alloc(256)));
const secret = createSecretKey(Buffer.alloc(32));
attempt("secret encapsulate", () => encapsulate(secret));
attempt("secret decapsulate", () => decapsulate(secret, nodeCt));
const pss = generateKeyPairSync("rsa-pss", { modulusLength: 2048 });
attempt("rsa-pss encapsulate", () => encapsulate(pss.publicKey));
attempt("rsa-pss decapsulate", () => decapsulate(pss.privateKey, nodeCt));
const pubJwk = pub.export({ format: "jwk" });
const privJwk = priv.export({ format: "jwk" });
const fromJwk = encapsulate({ key: pubJwk, format: "jwk" });
log("jwk", decapsulate({ key: privJwk, format: "jwk" }, fromJwk.ciphertext).equals(fromJwk.sharedKey));
// createPublicKey also reads a private key's PKCS#8 DER (the types list
// only the public encodings).
const fromDerPrivate = encapsulate({ key: priv.export({ type: "pkcs8", format: "der" }), format: "der", type: "pkcs8" } as unknown as { key: Buffer; format: "der"; type: "spki" });
log("der private input", decapsulate(priv, fromDerPrivate.ciphertext).equals(fromDerPrivate.sharedKey));
const bigger = generateKeyPairSync("rsa", { modulusLength: 3072 });
const biggerEnc = encapsulate(bigger.publicKey);
log("rsa-3072", biggerEnc.ciphertext.length, biggerEnc.sharedKey.length, decapsulate(bigger.privateKey, biggerEnc.ciphertext).equals(biggerEnc.sharedKey));
