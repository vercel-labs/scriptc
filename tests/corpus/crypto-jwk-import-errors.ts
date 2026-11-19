// node:crypto's JWK key import: Node's ERR_CRYPTO_INVALID_JWK messages for
// key types, malformed members, curves and missing private material, the
// OpenSSL curve names the EC import resolves, and the valid round trips
// around them.
import { KeyObject, createPrivateKey, createPublicKey, generateKeyPairSync } from "node:crypto";

const log = (...a: unknown[]) => console.log(a.map(String).join(" | "));
const attempt = (label: string, run: () => KeyObject): void => {
  try { log(label, "ok", run().asymmetricKeyType); }
  catch (e) { const x = e as Error & { code?: string }; log(label, "|", x.name, x.code, "|", x.message); }
};
// The member shapes include non-standard values (a number kty or crv), so
// the JWK travels as a value of any type.
const privateInput = (jwk: unknown) =>
  ({ key: jwk, format: "jwk" }) as unknown as Parameters<typeof createPrivateKey>[0];
const publicInput = (jwk: unknown) =>
  ({ key: jwk, format: "jwk" }) as unknown as Parameters<typeof createPublicKey>[0];

attempt("oct", () => createPrivateKey(privateInput({ kty: "oct", k: "AAAA" })));
attempt("unknown kty", () => createPrivateKey(privateInput({ kty: "XYZ" })));
attempt("empty object", () => createPrivateKey(privateInput({})));
attempt("number kty", () => createPrivateKey(privateInput({ kty: 5 })));
attempt("EC no members", () => createPrivateKey(privateInput({ kty: "EC" })));
attempt("OKP bad curve", () => createPublicKey(publicInput({ kty: "OKP", crv: "Ed448", x: "AA" })));
attempt("RSA without members", () => createPublicKey(publicInput({ kty: "RSA", n: "AQAB" })));

const x = generateKeyPairSync("x25519");
const xPub = x.publicKey.export({ format: "jwk" });
const xPriv = x.privateKey.export({ format: "jwk" });
attempt("X25519 public", () => createPublicKey(publicInput(xPub)));
attempt("X25519 private", () => createPrivateKey(privateInput(xPriv)));
attempt("X25519 no d", () => createPrivateKey(privateInput({ kty: "OKP", crv: "X25519", x: xPub.x })));

const p256 = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const p256Pub = p256.publicKey.export({ format: "jwk" });
attempt("EC no d", () => createPrivateKey(privateInput({ kty: "EC", crv: "P-256", x: p256Pub.x, y: p256Pub.y })));
attempt("EC openssl name", () => createPublicKey(publicInput({ kty: "EC", crv: "prime256v1", x: p256Pub.x, y: p256Pub.y })));
attempt("EC other curve name", () => createPublicKey(publicInput({ kty: "EC", crv: "secp384r1", x: p256Pub.x, y: p256Pub.y })));
attempt("EC unknown curve", () => createPublicKey(publicInput({ kty: "EC", crv: "nope", x: p256Pub.x, y: p256Pub.y })));
attempt("EC number curve", () => createPublicKey(publicInput({ kty: "EC", crv: 5, x: p256Pub.x, y: p256Pub.y })));
const k1 = generateKeyPairSync("ec", { namedCurve: "secp256k1" });
attempt("secp256k1 roundtrip", () => createPublicKey(publicInput(k1.publicKey.export({ format: "jwk" }))));

const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
const rsaPub = rsa.publicKey.export({ format: "jwk" });
attempt("RSA no d", () => createPrivateKey(privateInput({ kty: "RSA", n: rsaPub.n, e: rsaPub.e })));
const rsaPriv = rsa.privateKey.export({ format: "jwk" });
attempt("RSA no p", () => createPrivateKey(privateInput({ kty: "RSA", n: rsaPriv.n, e: rsaPriv.e, d: rsaPriv.d, q: rsaPriv.q })));
