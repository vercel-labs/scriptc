// crypto.encapsulate/decapsulate over DHKEM (RFC 9180) for the EC curves,
// X25519 and X448: fixed Node-produced keys and ciphertexts that must
// decapsulate to Node's shared secret (cross-implementation), fresh
// encapsulations that round-trip, the PEM form, and the key types and
// ciphertexts the KEM API refuses.
import { createPrivateKey, createPublicKey, decapsulate, encapsulate, generateKeyPairSync } from "node:crypto";

const log = (...a: unknown[]) => console.log(a.map(String).join(" | "));
const attempt = (label: string, run: () => unknown): void => {
  try { const r = run(); log(label, "ok", r === undefined ? "undefined" : typeof r); }
  catch (error) { const x = error as Error & { code?: string }; log(label, x.name, x.code, "|", x.message); }
};

// RFC 9180 A.1.1: DHKEM(X25519, HKDF-SHA256) with skRm and pkEm from the
// test vector decapsulates to the RFC's shared_secret.
const rfcPriv = createPrivateKey({
  key: Buffer.concat([
    Buffer.from("302e020100300506032b656e04220420", "hex"),
    Buffer.from("4612c550263fc8ad58375df3f557aac531d26850903e55a9f23f21d8534e8ac8", "hex"),
  ]),
  format: "der",
  type: "pkcs8",
});
log("RFC 9180 X25519",
  decapsulate(rfcPriv, Buffer.from("37fda3567bdbd628e88668c3c8d7e97d1d1253b6d4ea6d44c150f741f1bf4431", "hex")).toString("hex"));

{
  const priv = createPrivateKey({ key: Buffer.from("MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgkvD+RQ/JqQ5JvaRAxBaowIJ6qpCyPRssjr3hkQDGyruhRANCAARZSOI3P7phT6d+Vk11XlszJSXZ+i2gJcJRQNGGqL/Wb5uvutzvtze9GsvIBrXQB9qf4f7GUkgV4mGsy0L4+MA9", "base64"), format: "der", type: "pkcs8" });
  const pub = createPublicKey({ key: Buffer.from("MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEWUjiNz+6YU+nflZNdV5bMyUl2fotoCXCUUDRhqi/1m+br7rc77c3vRrLyAa10Afan+H+xlJIFeJhrMtC+PjAPQ==", "base64"), format: "der", type: "spki" });
  const nodeCt = Buffer.from("BDTUWXmKZZUnNNkyFDuSJCMdFAI/FSH/0fQ8fXPVTPDITTPAwcXsUAwrReK76aoWUKNKb7sv58T0baCgmpUM35E=", "base64");
  const nodeShared = Buffer.from("qTEGg7Q03WAMefJNCLtmNYqXgjD8eJ8dnAyrUqS7PxQ=", "base64");
  const pem = priv.export({ type: "pkcs8", format: "pem" });
  log("P-256", priv.asymmetricKeyType, nodeCt.length, decapsulate(priv, nodeCt).equals(nodeShared));
  log("P-256 pem", decapsulate(pem, nodeCt).equals(nodeShared));
  log("P-256 arraybuffer", decapsulate(priv, new Uint8Array(nodeCt).buffer).equals(nodeShared));
  const enc = encapsulate(pub);
  log("P-256 encaps", enc.ciphertext.length, enc.sharedKey.length, decapsulate(priv, enc.ciphertext).equals(enc.sharedKey));
  attempt("P-256 decaps public", () => decapsulate(pub, nodeCt));
  attempt("P-256 short ciphertext", () => decapsulate(priv, nodeCt.subarray(0, 3)));
  attempt("P-256 zeros", () => decapsulate(priv, Buffer.alloc(65)));
}

{
  const priv = createPrivateKey({ key: Buffer.from("MIG2AgEAMBAGByqGSM49AgEGBSuBBAAiBIGeMIGbAgEBBDBUFmQpalzgtgb8uw8TQJmTftpmLmQ4DCZuk/qhlhqhmgInpNK5V3XWqiLkjOScE/yhZANiAARnVLNuo+QLQdpBLWg67UHd/io1ZxY52ftmU9q3EbspYVcoJnJv8c5nezbOtPMrD/2EB28m0V8uE4+D7A+WoHCgtysVyci2c8s03Krk6XD5uIm6Y0YQpguen4VTBJ+YhjA=", "base64"), format: "der", type: "pkcs8" });
  const pub = createPublicKey({ key: Buffer.from("MHYwEAYHKoZIzj0CAQYFK4EEACIDYgAEZ1SzbqPkC0HaQS1oOu1B3f4qNWcWOdn7ZlPatxG7KWFXKCZyb/HOZ3s2zrTzKw/9hAdvJtFfLhOPg+wPlqBwoLcrFcnItnPLNNyq5Olw+biJumNGEKYLnp+FUwSfmIYw", "base64"), format: "der", type: "spki" });
  const nodeCt = Buffer.from("BMrtByJVMzET9561ObupnA8AAGXmpvNn/I9I3n8STxop0YtUp4q3bYXb+f1zsjT+wRK0pVGXygZmRNFfsMPtZOsP54/wRgs97IAWu1d6RTbYJeD0OCHmQ28JPmXhdFN7dw==", "base64");
  const nodeShared = Buffer.from("HLEYM1uSAylX8XVY8S7dVg4wu86zMq+i7KX2nOERIS58SrYWQ6FyukIJPf1M/UDr", "base64");
  const pem = priv.export({ type: "pkcs8", format: "pem" });
  log("P-384", priv.asymmetricKeyType, nodeCt.length, decapsulate(priv, nodeCt).equals(nodeShared));
  log("P-384 pem", decapsulate(pem, nodeCt).equals(nodeShared));
  const enc = encapsulate(pub);
  log("P-384 encaps", enc.ciphertext.length, enc.sharedKey.length, decapsulate(priv, enc.ciphertext).equals(enc.sharedKey));
  attempt("P-384 decaps public", () => decapsulate(pub, nodeCt));
  attempt("P-384 short ciphertext", () => decapsulate(priv, nodeCt.subarray(0, 3)));
  attempt("P-384 zeros", () => decapsulate(priv, Buffer.alloc(97)));
}

{
  const priv = createPrivateKey({ key: Buffer.from("MIHuAgEAMBAGByqGSM49AgEGBSuBBAAjBIHWMIHTAgEBBEIBck2FELNe3zx3+UpvN9pJckh+kqNfAeqCwrV1PoRuTCBWnlli99qhMwjWzOQXNou+jgqgA7aPx1R1zamYqw/pjuOhgYkDgYYABAGhPvfk483nsAuPXy7MRFE3Rgpa44cHkse25mo7XbFloUlVwY3265SOn7kZ3Mbe3+WBJqqHpHk7ucogYjGJe8CbSQBq56kpNo2bGPpoXq+tSrvPKMucqB6tHAM72EKjKqIFO3CSuA96QS4JVYm5HnXYFxb3CpzPYv6CTMZBdgL557Z+MQ==", "base64"), format: "der", type: "pkcs8" });
  const pub = createPublicKey({ key: Buffer.from("MIGbMBAGByqGSM49AgEGBSuBBAAjA4GGAAQBoT735OPN57ALj18uzERRN0YKWuOHB5LHtuZqO12xZaFJVcGN9uuUjp+5GdzG3t/lgSaqh6R5O7nKIGIxiXvAm0kAauepKTaNmxj6aF6vrUq7zyjLnKgerRwDO9hCoyqiBTtwkrgPekEuCVWJuR512BcW9wqcz2L+gkzGQXYC+ee2fjE=", "base64"), format: "der", type: "spki" });
  const nodeCt = Buffer.from("BAG9Oas0WZPDMGBMdRq7MEmnioCDA9XBEhh2epWsX0ruB2f9q8neKhFxhJDdbZm3exVGiDIVRcuVZkikbBwF6BYW4QBHQoTlUBrGicOzpaZXON826EfrG7d2V1J7wSS2q5cDHp17leAEtP+pIqv8TZan+oas06MWOyrNez1R0p4PAVPuwA==", "base64");
  const nodeShared = Buffer.from("w6a1zwRkV12iT2x+ZUbThwVEPfd/rbiQaRfe0HpcXuPphEoJUvVq1TJNDHp8HpKnHH8PSK9CkPSZZubEIm14og==", "base64");
  const pem = priv.export({ type: "pkcs8", format: "pem" });
  log("P-521", priv.asymmetricKeyType, nodeCt.length, decapsulate(priv, nodeCt).equals(nodeShared));
  log("P-521 pem", decapsulate(pem, nodeCt).equals(nodeShared));
  const enc = encapsulate(pub);
  log("P-521 encaps", enc.ciphertext.length, enc.sharedKey.length, decapsulate(priv, enc.ciphertext).equals(enc.sharedKey));
  attempt("P-521 decaps public", () => decapsulate(pub, nodeCt));
  attempt("P-521 short ciphertext", () => decapsulate(priv, nodeCt.subarray(0, 3)));
  attempt("P-521 zeros", () => decapsulate(priv, Buffer.alloc(133)));
}

{
  const priv = createPrivateKey({ key: Buffer.from("MC4CAQAwBQYDK2VuBCIEIAgoe+pjkW2xlhnZGli0A6JctaFOvLCQu6Q4bsj2ddhP", "base64"), format: "der", type: "pkcs8" });
  const pub = createPublicKey({ key: Buffer.from("MCowBQYDK2VuAyEAiHPRyfnsbAYB6ks6tbJ/6R0Qx5gfB8cX5RTDBdMUpko=", "base64"), format: "der", type: "spki" });
  const nodeCt = Buffer.from("6lyuFEQE+qyKUDraw7QD3v5N9XmmoW1MMU4BjBbkKmY=", "base64");
  const nodeShared = Buffer.from("akGqKWXa8/hwIJnN3CoEPg4rJfi/gzPvrKljLIqntPs=", "base64");
  const pem = priv.export({ type: "pkcs8", format: "pem" });
  log("X25519", priv.asymmetricKeyType, nodeCt.length, decapsulate(priv, nodeCt).equals(nodeShared));
  log("X25519 pem", decapsulate(pem, nodeCt).equals(nodeShared));
  const enc = encapsulate(pub);
  log("X25519 encaps", enc.ciphertext.length, enc.sharedKey.length, decapsulate(priv, enc.ciphertext).equals(enc.sharedKey));
  attempt("X25519 decaps public", () => decapsulate(pub, nodeCt));
  attempt("X25519 short ciphertext", () => decapsulate(priv, nodeCt.subarray(0, 3)));
  attempt("X25519 zeros", () => decapsulate(priv, Buffer.alloc(32)));
}

{
  const priv = createPrivateKey({ key: Buffer.from("MEYCAQAwBQYDK2VvBDoEOPzMHAYj0tt/nJc6Ta1hvC6tg3jYSYqWq1iZfC+mp5Gvn4yRM16USZavXOZNx6RyBnFs8HTMHoez", "base64"), format: "der", type: "pkcs8" });
  const pub = createPublicKey({ key: Buffer.from("MEIwBQYDK2VvAzkAoSe34+BQuPFz0VsfS/sGg3I7Xz72HjWtwdj+npyr3MT+6gv641txE/vFZ1A1IahGmqEmjHnvGjs=", "base64"), format: "der", type: "spki" });
  const nodeCt = Buffer.from("ucdhrfdHJFIwZzgmkGHzzOWlIfSE+DO8ntW2Vs05Sog0OiraApWFy5DyC42yXezTpRcnhg9pFAs=", "base64");
  const nodeShared = Buffer.from("8mWjp1HcmU/l+z2OYlLJ9u5V7yTtq1zTziNrLB+QvT++7Ic7dbtqkQorAwT4OCemY+xR77ZwjYfNHnEdikoXCw==", "base64");
  const pem = priv.export({ type: "pkcs8", format: "pem" });
  log("X448", priv.asymmetricKeyType, nodeCt.length, decapsulate(priv, nodeCt).equals(nodeShared));
  log("X448 pem", decapsulate(pem, nodeCt).equals(nodeShared));
  const enc = encapsulate(pub);
  log("X448 encaps", enc.ciphertext.length, enc.sharedKey.length, decapsulate(priv, enc.ciphertext).equals(enc.sharedKey));
  attempt("X448 decaps public", () => decapsulate(pub, nodeCt));
  attempt("X448 short ciphertext", () => decapsulate(priv, nodeCt.subarray(0, 3)));
  attempt("X448 zeros", () => decapsulate(priv, Buffer.alloc(56)));
}

const k1 = generateKeyPairSync("ec", { namedCurve: "secp256k1" });
attempt("secp256k1 encapsulate", () => encapsulate(k1.publicKey));
const ed = generateKeyPairSync("ed25519");
attempt("ed25519 decapsulate", () => decapsulate(ed.privateKey, Buffer.alloc(32)));
