// crypto.diffieHellman with typed KeyObjects: ECDH on every supported
// curve, checked against createECDH, X25519, the callback form, and
// Node's errors for incompatible key types, mismatched curves and a
// small-order X25519 public key.
import * as crypto from "node:crypto";

function attempt(label: string, run: () => Buffer): void {
  try {
    const secret = run();
    console.log(label, secret.length);
  } catch (e) {
    const error = e as NodeJS.ErrnoException;
    console.log(label, "throws", error.name, error.code, error.message);
  }
}

for (const namedCurve of ["prime256v1", "secp384r1", "secp521r1", "secp256k1"]) {
  const a = crypto.generateKeyPairSync("ec", { namedCurve });
  const ecdh = crypto.createECDH(namedCurve);
  const ecdhPublic = ecdh.generateKeys();
  const peer = crypto.createPublicKey({ key: ecdhPublic, format: "raw-public", asymmetricKeyType: "ec", namedCurve } as unknown as crypto.PublicKeyInput);
  const secret = crypto.diffieHellman({ privateKey: a.privateKey, publicKey: peer });
  // The SubjectPublicKeyInfo ends with the uncompressed point.
  const spki = a.publicKey.export({ format: "der", type: "spki" });
  const own = spki.subarray(spki.length - ecdhPublic.length);
  console.log(namedCurve, secret.length, secret.equals(ecdh.computeSecret(own)));
}

const x = crypto.generateKeyPairSync("x25519");
const y = crypto.generateKeyPairSync("x25519");
const xy = crypto.diffieHellman({ privateKey: x.privateKey, publicKey: y.publicKey });
console.log("x25519", xy.length, xy.equals(crypto.diffieHellman({ privateKey: y.privateKey, publicKey: x.publicKey })));
attempt("public key given as the private key", () => crypto.diffieHellman({ privateKey: x.privateKey, publicKey: y.privateKey }));

const p256 = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
const p384 = crypto.generateKeyPairSync("ec", { namedCurve: "P-384" });
const rsa = crypto.generateKeyPairSync("rsa", { modulusLength: 1024 });
const ed = crypto.generateKeyPairSync("ed25519");
attempt("x25519 and ec", () => crypto.diffieHellman({ privateKey: x.privateKey, publicKey: p256.publicKey }));
attempt("ec and x25519", () => crypto.diffieHellman({ privateKey: p256.privateKey, publicKey: x.publicKey }));
attempt("rsa", () => crypto.diffieHellman({ privateKey: rsa.privateKey, publicKey: rsa.publicKey }));
attempt("ed25519", () => crypto.diffieHellman({ privateKey: ed.privateKey, publicKey: ed.publicKey }));
attempt("P-256 and P-384", () => crypto.diffieHellman({ privateKey: p256.privateKey, publicKey: p384.publicKey }));
attempt("public as private", () => crypto.diffieHellman({ privateKey: x.publicKey, publicKey: y.publicKey }));
const zero = crypto.createPublicKey({ key: Buffer.alloc(32), format: "raw-public", asymmetricKeyType: "x25519" } as unknown as crypto.PublicKeyInput);
attempt("small-order point", () => crypto.diffieHellman({ privateKey: x.privateKey, publicKey: zero }));

crypto.diffieHellman({ privateKey: x.privateKey, publicKey: y.publicKey }, (err, secret) => {
  console.log("callback", err, secret.equals(xy));
  crypto.diffieHellman({ privateKey: x.privateKey, publicKey: zero }, (...args: unknown[]) => {
    const error = args[0] as NodeJS.ErrnoException;
    console.log("callback error", args.length, error.code, error.message);
  });
});
console.log("returned");
