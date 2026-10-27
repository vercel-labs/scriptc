// X25519 KeyObjects: generateKeyPair, PKCS#8, SubjectPublicKeyInfo, JWK
// and raw keys, RFC 7748's test vectors through crypto.diffieHellman, and
// Node's errors for signatures and incompatible encodings.
import * as crypto from "node:crypto";

function describe(value) {
  if (Buffer.isBuffer(value)) return `Buffer(${value.length})`;
  if (value instanceof crypto.KeyObject) return `${value.type} ${value.asymmetricKeyType} ${JSON.stringify(value.asymmetricKeyDetails)}`;
  if (typeof value === "string") return value.split("\n")[0];
  if (value && typeof value === "object") return Object.entries(value).map(([key, field]) => `${key}=${describe(field)}`).join(" ");
  return String(value);
}

function attempt(label, run) {
  try {
    console.log(label, describe(run()));
  } catch (e) {
    console.log(label, "throws", e.name, e.code, e.message);
  }
}

// RFC 7748, section 6.1
const alicePrivate = Buffer.from("77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a", "hex");
const alicePublic = "8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a";
const bobPrivate = Buffer.from("5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb", "hex");
const bobPublic = "de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f";
const alice = crypto.createPrivateKey({ key: alicePrivate, format: "raw-private", asymmetricKeyType: "x25519" });
const bob = crypto.createPrivateKey({ key: bobPrivate, format: "raw-private", asymmetricKeyType: "x25519" });
console.log("alice public", Buffer.from(crypto.createPublicKey(alice).export({ format: "raw-public" })).toString("hex") === alicePublic);
console.log("bob public", Buffer.from(crypto.createPublicKey(bob).export({ format: "raw-public" })).toString("hex") === bobPublic);
const shared = crypto.diffieHellman({ privateKey: alice, publicKey: crypto.createPublicKey(bob) });
console.log("shared", shared.toString("hex"));
console.log("both ways", crypto.diffieHellman({ privateKey: bob, publicKey: crypto.createPublicKey(alice) }).equals(shared));
console.log("raw-private kept as given", Buffer.from(alice.export({ format: "raw-private" })).equals(alicePrivate));

// encodings
console.log("details", describe(alice), describe(crypto.createPublicKey(alice)));
const spki = alice.export({ format: "der", type: "pkcs8" });
console.log("pkcs8", spki.length, spki.subarray(0, 16).toString("hex"));
const pub = crypto.createPublicKey(alice);
const spkiDer = pub.export({ format: "der", type: "spki" });
console.log("spki", spkiDer.length, spkiDer.subarray(0, 12).toString("hex"));
console.log("pem", describe(alice.export({ format: "pem", type: "pkcs8" })), describe(pub.export({ format: "pem", type: "spki" })));
const jwk = alice.export({ format: "jwk" });
console.log("jwk", Object.keys(jwk).join(), jwk.kty, jwk.crv, jwk.x === Buffer.from(alicePublic, "hex").toString("base64url"), jwk.d === alicePrivate.toString("base64url"));
console.log("public jwk", JSON.stringify(pub.export({ format: "jwk" })));
const fromPem = crypto.createPrivateKey(alice.export({ format: "pem", type: "pkcs8" }));
console.log("pem round trip", fromPem.equals(alice), crypto.createPublicKey(pub.export({ format: "pem", type: "spki" })).equals(pub));
console.log("jwk round trip", crypto.createPrivateKey({ key: jwk, format: "jwk" }).equals(alice), crypto.createPublicKey({ key: pub.export({ format: "jwk" }), format: "jwk" }).equals(pub));
console.log("public of pkcs8", crypto.createPublicKey({ key: spki, format: "der", type: "pkcs8" }).equals(pub));
console.log("not ed25519", alice.equals(crypto.generateKeyPairSync("ed25519").privateKey));

// generateKeyPair
const pair = crypto.generateKeyPairSync("x25519");
console.log("generated", describe(pair));
const clamped = Buffer.from(pair.privateKey.export({ format: "raw-private" }));
console.log("generated clamped", (clamped[0] & 7) === 0, (clamped[31] & 0xc0) === 0x40);
attempt("pem pair", () =>
  crypto.generateKeyPairSync("x25519", {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "der" },
  }),
);
attempt("raw pair", () =>
  crypto.generateKeyPairSync("x25519", { publicKeyEncoding: { format: "raw-public" }, privateKeyEncoding: { format: "raw-private" } }),
);
attempt("pkcs1", () => crypto.generateKeyPairSync("x25519", { publicKeyEncoding: { type: "pkcs1", format: "pem" } }));
attempt("sec1", () => crypto.generateKeyPairSync("x25519", { privateKeyEncoding: { type: "sec1", format: "pem" } }));
attempt("raw-seed", () => crypto.generateKeyPairSync("x25519", { privateKeyEncoding: { format: "raw-seed" } }));
attempt("X25519 spelling", () => crypto.generateKeyPairSync("X25519"));

// what X25519 keys cannot do
const data = Buffer.from("x25519");
attempt("sign", () => crypto.sign(null, data, alice));
attempt("sign sha256", () => crypto.sign("sha256", data, alice));
attempt("verify", () => crypto.verify(null, data, pub, Buffer.alloc(64)));
attempt("createSign", () => crypto.createSign("sha256").update(data).sign(alice));
attempt("createVerify", () => crypto.createVerify("sha256").update(data).verify(pub, Buffer.alloc(64)));
attempt("hmac", () => crypto.createHmac("sha256", alice));
attempt("export pkcs1", () => pub.export({ format: "pem", type: "pkcs1" }));
attempt("export raw-seed", () => alice.export({ format: "raw-seed" }));
attempt("short raw key", () => crypto.createPublicKey({ key: Buffer.alloc(31), format: "raw-public", asymmetricKeyType: "x25519" }));

crypto.generateKeyPair("x25519", (err, publicKey, privateKey) => {
  console.log("async", err, describe(publicKey), describe(privateKey));
  crypto.diffieHellman({ privateKey, publicKey: crypto.createPublicKey(bob) }, (err2, secret) => {
    console.log("async secret", err2, describe(secret));
  });
});
console.log("returned");
