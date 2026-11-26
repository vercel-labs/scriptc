// crypto.generateKeyPairSync('dh'): KeyObjects of type 'dh' from a named
// group, an explicit prime, and a generated primeLength, with Node's
// PKCS#8 private and SubjectPublicKeyInfo public exports, its PEM labels,
// its single-format rule for each half, its unsupported JWK, and its
// option errors. The generated key material is random, so only the stable
// DER prefix (the parameters) and length ranges are printed.
import * as crypto from "node:crypto";

const failure = (error) => `${error.name}: ${error.message}`;

const dhPair = (options) => crypto.generateKeyPairSync("dh", options);

const pair = dhPair({ group: "modp5" });
console.log(
  "types",
  pair.privateKey.type,
  pair.privateKey.asymmetricKeyType,
  pair.publicKey.type,
  pair.publicKey.asymmetricKeyType,
);
console.log(
  "details",
  JSON.stringify(pair.privateKey.asymmetricKeyDetails),
  JSON.stringify(pair.publicKey.asymmetricKeyDetails),
);
const privateDer = pair.privateKey.export({ type: "pkcs8", format: "der" });
const publicDer = pair.publicKey.export({ type: "spki", format: "der" });
console.log(
  "private der",
  privateDer.length >= 251 && privateDer.length <= 252,
  privateDer.subarray(3, 23).toString("hex"),
);
console.log(
  "public der",
  publicDer.length >= 419 && publicDer.length <= 421,
  publicDer.subarray(4, 24).toString("hex"),
);
console.log(
  "labels",
  String(pair.privateKey.export({ type: "pkcs8", format: "pem" })).split("\n")[0],
  String(pair.publicKey.export({ type: "spki", format: "pem" })).split("\n")[0],
);
console.log("equals", pair.privateKey.equals(pair.privateKey), pair.privateKey.equals(pair.publicKey));

// An explicit prime and generator, and a generated prime.
const dh = crypto.getDiffieHellman("modp5");
const explicit = dhPair({ prime: dh.getPrime(), generator: 2 });
console.log("explicit", explicit.privateKey.asymmetricKeyType, explicit.publicKey.asymmetricKeyType);
const generated = dhPair({ primeLength: 512, generator: 2 });
console.log("generated", generated.privateKey.asymmetricKeyType, generated.publicKey.asymmetricKeyType);

// A generated prime takes any generator above 1, as OpenSSL's parameter
// search does; an explicit prime takes 0 and 1 too, and the degenerate
// public value they make is a one-byte INTEGER, so its DER is stable.
const generatedThree = dhPair({ primeLength: 512, generator: 3 });
console.log("generated generator three", generatedThree.publicKey.asymmetricKeyType);
for (const generator of [0, 1]) {
  const degenerate = dhPair({ prime: dh.getPrime(), generator });
  const spki = degenerate.publicKey.export({ type: "spki", format: "der" });
  console.log("prime generator " + generator, spki.length, spki.subarray(-6).toString("hex"));
}

// Node's export rules: each half has exactly one type, and JWK is not a DH
// format.
const attempt = (label, run) => {
  try {
    run();
    console.log(label, "resolved");
  } catch (error) {
    console.log(label, failure(error));
  }
};
attempt("private spki", () => pair.privateKey.export({ type: "spki", format: "der" }));
attempt("public pkcs8", () => pair.publicKey.export({ type: "pkcs8", format: "der" }));
attempt("private jwk", () => pair.privateKey.export({ format: "jwk" }));
attempt("public jwk", () => pair.publicKey.export({ format: "jwk" }));
attempt("pkcs1 private", () => pair.privateKey.export({ type: "pkcs1", format: "der" }));

// Node's option checks.
attempt("no options", () => crypto.generateKeyPairSync("dh", undefined));
attempt("empty options", () => dhPair({}));
attempt("unknown group", () => dhPair({ group: "ffdhe2048" }));
attempt("group and prime", () => dhPair({ group: "modp5", prime: dh.getPrime() }));
attempt("group and generator", () => dhPair({ group: "modp5", generator: 2 }));
attempt("group and primeLength", () => dhPair({ group: "modp5", primeLength: 512 }));
attempt("prime and primeLength", () => dhPair({ prime: dh.getPrime(), primeLength: 512 }));
attempt("generator out of range", () => dhPair({ prime: dh.getPrime(), generator: 2147483648 }));
attempt("prime too small", () => dhPair({ prime: Buffer.from([0x17]), generator: 2 }));
attempt("bad generator", () => dhPair({ primeLength: 512, generator: 0 }));
attempt("primeLength too small", () => dhPair({ primeLength: 511, generator: 2 }));
attempt("generator not integer", () => dhPair({ prime: dh.getPrime(), generator: 2.5 }),
);
