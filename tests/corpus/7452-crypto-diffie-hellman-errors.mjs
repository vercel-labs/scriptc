// crypto.diffieHellman's argument checks in Node's order, key inputs other
// than KeyObjects, and the own properties of the OpenSSL errors it and
// X25519 signatures throw.
import * as crypto from "node:crypto";

function attempt(label, run) {
  try {
    const result = run();
    console.log(label, Buffer.isBuffer(result) ? `Buffer(${result.length})` : String(result));
  } catch (e) {
    console.log(label, "throws", e.name, e.code, e.message, JSON.stringify(Object.keys(e)));
  }
}

const x = crypto.generateKeyPairSync("x25519");
const y = crypto.generateKeyPairSync("x25519");
const ec = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
const other = crypto.generateKeyPairSync("ec", { namedCurve: "P-384" });
const dh = (options, callback) => () =>
  callback === undefined ? crypto.diffieHellman(options) : crypto.diffieHellman(options, callback);

attempt("no options", dh());
attempt("number options", dh(5));
attempt("array options", dh([]));
attempt("number callback", dh({ privateKey: x.privateKey, publicKey: y.publicKey }, 5));
attempt("callback before keys", dh({}, 5));
attempt("no private key", dh({ publicKey: y.publicKey }));
attempt("no public key", dh({ privateKey: x.privateKey }));
attempt("number public key", dh({ privateKey: x.privateKey, publicKey: 2 }));
attempt("number private key", dh({ privateKey: 1, publicKey: y.publicKey }));
attempt("null private key", dh({ privateKey: null, publicKey: y.publicKey }));
attempt("public key object as private", dh({ privateKey: x.publicKey, publicKey: y.publicKey }));
attempt("types checked first", dh({ privateKey: x.privateKey, publicKey: ec.publicKey }));

// key inputs other than KeyObjects
const pkcs8 = x.privateKey.export({ format: "pem", type: "pkcs8" });
const spki = y.publicKey.export({ format: "pem", type: "spki" });
attempt("pem keys", dh({ privateKey: pkcs8, publicKey: spki }));
attempt("der key objects", dh({
  privateKey: { key: x.privateKey.export({ format: "der", type: "pkcs8" }), format: "der", type: "pkcs8" },
  publicKey: { key: y.publicKey.export({ format: "jwk" }), format: "jwk" },
}));
attempt("public key from a private pem", dh({ privateKey: x.privateKey, publicKey: pkcs8 }));
attempt("same result", () =>
  crypto.diffieHellman({ privateKey: pkcs8, publicKey: spki }).equals(crypto.diffieHellman({ privateKey: x.privateKey, publicKey: y.publicKey })),
);
attempt("mixed types from pem", dh({ privateKey: x.privateKey, publicKey: ec.publicKey.export({ format: "pem", type: "spki" }) }));
attempt("mismatched curves", dh({ privateKey: ec.privateKey, publicKey: other.publicKey }));
const zero = crypto.createPublicKey({ key: Buffer.alloc(32), format: "raw-public", asymmetricKeyType: "x25519" });
attempt("small-order point", dh({ privateKey: x.privateKey, publicKey: zero }));
attempt("sign", () => crypto.sign(null, Buffer.from("x"), x.privateKey));

// the callback form: argument errors throw, job errors arrive without
// the OpenSSL properties
attempt("callback returns", dh({ privateKey: x.privateKey, publicKey: y.publicKey }, (err, secret) => {
  console.log("callback", err, secret.length);
  crypto.diffieHellman({ privateKey: ec.privateKey, publicKey: other.publicKey }, (error) => {
    console.log("callback mismatch", error.code, error.message, JSON.stringify(Object.keys(error)));
  });
}));
attempt("callback with a bad key throws", dh({ privateKey: 1, publicKey: y.publicKey }, () => console.log("never")));
