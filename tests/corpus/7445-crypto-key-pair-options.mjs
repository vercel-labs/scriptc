// generateKeyPairSync and generateKeyPair check their arguments in Node's
// order: the callback, the type, the options object, the public and then
// the private key encoding, and then the options of the key type. The
// encodings follow Node's parseKeyEncoding rules for formats, types,
// ciphers and passphrases.
import * as crypto from "node:crypto";

function attempt(label, run) {
  try {
    const result = run();
    console.log(label, result === undefined ? "returned" : Object.keys(result));
  } catch (e) {
    console.log(label, "throws", e.name, e.code, e.message);
  }
}

const ec = (options) => () => crypto.generateKeyPairSync("ec", { namedCurve: "P-256", ...options });
const rsa = (options) => () => crypto.generateKeyPairSync("rsa", { modulusLength: 1024, ...options });

// The type, then the options object, then the encodings, then the rest.
attempt("number type", () => crypto.generateKeyPairSync(5, 7));
attempt("unknown type, bad encoding", () => crypto.generateKeyPairSync("foo", { publicKeyEncoding: 5 }));
attempt("unknown type, number options", () => crypto.generateKeyPairSync("foo", 5));
attempt("unknown type, null options", () => crypto.generateKeyPairSync("foo", null));
attempt("unknown type, array options", () => crypto.generateKeyPairSync("foo", []));
attempt("unknown type", () => crypto.generateKeyPairSync("foo"));
attempt("upper-case types", () => crypto.generateKeyPairSync("RSA", {}));
attempt("upper-case Ed25519", () => crypto.generateKeyPairSync("Ed25519"));
attempt("upper-case ML-DSA", () => crypto.generateKeyPairSync("ML-DSA-44"));
attempt("unknown type, pkcs1", () => crypto.generateKeyPairSync("foo", { publicKeyEncoding: { format: "pem", type: "pkcs1" } }));
attempt("rsa, bad modulusLength and encoding", () => crypto.generateKeyPairSync("rsa", { modulusLength: "x", publicKeyEncoding: 5 }));
attempt("rsa, bad modulusLength and private encoding", () => crypto.generateKeyPairSync("rsa", { modulusLength: "x", privateKeyEncoding: 5 }));
attempt("rsa, negative modulusLength and format", () => crypto.generateKeyPairSync("rsa", { modulusLength: -1, publicKeyEncoding: { format: "x" } }));
attempt("rsa, bad exponent and encoding", () => crypto.generateKeyPairSync("rsa", { modulusLength: 1024, publicExponent: "x", publicKeyEncoding: 5 }));
attempt("rsa-pss, bad encoding", () => crypto.generateKeyPairSync("rsa-pss", { publicKeyEncoding: 5 }));
attempt("rsa-pss, bad modulusLength", () => crypto.generateKeyPairSync("rsa-pss", { modulusLength: "x" }));
attempt("dsa, bad encoding", () => crypto.generateKeyPairSync("dsa", { publicKeyEncoding: 5 }));
attempt("dsa, no options", () => crypto.generateKeyPairSync("dsa"));
attempt("dh, number options", () => crypto.generateKeyPairSync("dh", 5));
attempt("ec, no curve and bad encoding", () => crypto.generateKeyPairSync("ec", { publicKeyEncoding: 5 }));
attempt("ec, unknown curve and bad encoding", () => crypto.generateKeyPairSync("ec", { namedCurve: "nope", publicKeyEncoding: 5 }));
attempt("ec, number curve", () => crypto.generateKeyPairSync("ec", { namedCurve: 5 }));
attempt("ec, lower-case NIST name", () => crypto.generateKeyPairSync("ec", { namedCurve: "p-256" }));
attempt("ec, unknown curve and paramEncoding", () => crypto.generateKeyPairSync("ec", { namedCurve: "nope", paramEncoding: "bogus" }));
attempt("ec, paramEncoding bogus", ec({ paramEncoding: "bogus" }));
attempt("ec, paramEncoding named", () => crypto.generateKeyPairSync("ec", { namedCurve: "P-256", paramEncoding: "named" }));
attempt("ec, paramEncoding null", () => crypto.generateKeyPairSync("ec", { namedCurve: "P-256", paramEncoding: null }));
attempt("ed25519, no options", () => crypto.generateKeyPairSync("ed25519"));
attempt("ed25519, null options", () => crypto.generateKeyPairSync("ed25519", null));
attempt("ed25519, number options", () => crypto.generateKeyPairSync("ed25519", 5));
attempt("ed25519, bad encoding", () => crypto.generateKeyPairSync("ed25519", { publicKeyEncoding: 5 }));

// Encodings.
attempt("both encodings invalid", rsa({ publicKeyEncoding: { format: "x" }, privateKeyEncoding: 5 }));
attempt("array encoding", rsa({ publicKeyEncoding: [] }));
attempt("null encodings", () => crypto.generateKeyPairSync("ec", { namedCurve: "P-256", publicKeyEncoding: null, privateKeyEncoding: null }));
attempt("der without type", rsa({ publicKeyEncoding: { format: "der" } }));
attempt("pem without type", rsa({ privateKeyEncoding: { format: "pem" } }));
attempt("jwk without type", () => crypto.generateKeyPairSync("ec", { namedCurve: "P-256", publicKeyEncoding: { format: "jwk" }, privateKeyEncoding: { format: "jwk" } }));
attempt("jwk with bad type", rsa({ publicKeyEncoding: { format: "jwk", type: "bogus" } }));
attempt("jwk with pkcs1 for ec", ec({ publicKeyEncoding: { format: "jwk", type: "pkcs1" } }));
attempt("public sec1", rsa({ publicKeyEncoding: { format: "pem", type: "sec1" } }));
attempt("public pkcs8", rsa({ publicKeyEncoding: { format: "pem", type: "pkcs8" } }));
attempt("private spki", rsa({ privateKeyEncoding: { format: "pem", type: "spki" } }));
attempt("private sec1 for rsa", rsa({ privateKeyEncoding: { format: "pem", type: "sec1" } }));
attempt("public pkcs1 for ec", ec({ publicKeyEncoding: { format: "pem", type: "pkcs1" } }));
attempt("private pkcs1 for ec", ec({ privateKeyEncoding: { format: "der", type: "pkcs1" } }));
attempt("public pkcs1 for ed25519", () => crypto.generateKeyPairSync("ed25519", { publicKeyEncoding: { format: "pem", type: "pkcs1" } }));
attempt("private sec1 for ed25519", () => crypto.generateKeyPairSync("ed25519", { privateKeyEncoding: { format: "pem", type: "sec1" } }));
attempt("raw-public as private", ec({ privateKeyEncoding: { format: "raw-public" } }));
attempt("raw-private as public", ec({ publicKeyEncoding: { format: "raw-private" } }));
attempt("raw-seed as public", ec({ publicKeyEncoding: { format: "raw-seed" } }));
attempt("raw-public with bad type", ec({ publicKeyEncoding: { format: "raw-public", type: "x" } }));
attempt("raw-private with a type", ec({ privateKeyEncoding: { format: "raw-private", type: "pkcs8" } }));
attempt("raw-private with a passphrase", ec({ privateKeyEncoding: { format: "raw-private", passphrase: "x" } }));
attempt("raw-seed with a cipher", ec({ privateKeyEncoding: { format: "raw-seed", cipher: "aes-128-cbc" } }));
attempt("number cipher", rsa({ privateKeyEncoding: { format: "pem", type: "pkcs8", cipher: 5 } }));
attempt("passphrase without cipher", rsa({ privateKeyEncoding: { format: "pem", type: "pkcs8", passphrase: "x" } }));
attempt("passphrase with null cipher", rsa({ privateKeyEncoding: { format: "pem", type: "pkcs8", cipher: null, passphrase: "x" } }));
attempt("der pkcs1 with a cipher", rsa({ privateKeyEncoding: { format: "der", type: "pkcs1", cipher: "aes-128-cbc", passphrase: "x" } }));
attempt("der sec1 with a cipher", ec({ privateKeyEncoding: { format: "der", type: "sec1", cipher: "aes-128-cbc", passphrase: "x" } }));
attempt("number passphrase", rsa({ privateKeyEncoding: { format: "pem", type: "pkcs8", cipher: "aes-128-cbc", passphrase: 5 } }));
attempt("missing passphrase", rsa({ privateKeyEncoding: { format: "pem", type: "pkcs8", cipher: "aes-128-cbc" } }));
attempt("encoding errors before the modulusLength", () => crypto.generateKeyPairSync("rsa", { modulusLength: 1.5, privateKeyEncoding: { format: "pem", type: "pkcs8", passphrase: "x" } }));

// generateKeyPair checks its callback first, reads a function in the
// options position as the callback, and throws argument errors.
attempt("async, options as the callback", () => crypto.generateKeyPair("rsa", { modulusLength: 1024 }));
attempt("async, undefined callback", () => crypto.generateKeyPair("rsa", { modulusLength: 1024 }, undefined));
attempt("async, number callback", () => crypto.generateKeyPair("rsa", { modulusLength: 1024 }, 5));
attempt("async, number type without callback", () => crypto.generateKeyPair(5, {}));
attempt("async, unknown type", () => crypto.generateKeyPair("foo", undefined, () => console.log("never")));
attempt("async, ec without options", () => crypto.generateKeyPair("ec", () => console.log("never")));
attempt("async, bad encoding", () => crypto.generateKeyPair("ec", { namedCurve: "P-256", publicKeyEncoding: { format: "pem", type: "pkcs1" } }, () => console.log("never")));
attempt("async, shifted callback", () =>
  crypto.generateKeyPair("ed25519", (err, publicKey, privateKey) => {
    console.log("shifted callback", err, publicKey.asymmetricKeyType, privateKey.type);
    crypto.generateKeyPair(
      "ed25519",
      (err2, publicKey2) => {
        console.log("options callback", err2, publicKey2.type);
        // A callable Proxy is a function, in either position.
        const proxied = new Proxy(
          (err3, publicKey3) => {
            console.log("proxy callback", err3, publicKey3.type);
            crypto.generateKeyPair("ed25519", proxiedOptions);
          },
          {},
        );
        const proxiedOptions = new Proxy((err4, publicKey4) => console.log("proxy options callback", err4, publicKey4.type), {});
        crypto.generateKeyPair("ed25519", {}, proxied);
      },
      () => console.log("never"),
    );
  }),
);
console.log("returned");
