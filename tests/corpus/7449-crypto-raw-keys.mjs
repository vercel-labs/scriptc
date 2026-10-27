// The raw-public, raw-private and raw-seed key formats: generateKeyPair
// encodings, KeyObject.export and createPublicKey/createPrivateKey with
// asymmetricKeyType and namedCurve, for EC keys (uncompressed and
// compressed points, scalars at the curve's size) and Ed25519 keys, and
// Node's errors for the other key types and formats.
import * as crypto from "node:crypto";

function describe(value) {
  if (Buffer.isBuffer(value)) return `Buffer(${value.length})`;
  if (value instanceof crypto.KeyObject) return `${value.type} ${value.asymmetricKeyType} ${JSON.stringify(value.asymmetricKeyDetails)}`;
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

// generateKeyPair encodings
for (const namedCurve of ["P-256", "P-384", "P-521", "secp256k1"]) {
  attempt(`ec ${namedCurve} raw-public`, () => crypto.generateKeyPairSync("ec", { namedCurve, publicKeyEncoding: { format: "raw-public" } }));
  attempt(`ec ${namedCurve} compressed`, () => crypto.generateKeyPairSync("ec", { namedCurve, publicKeyEncoding: { format: "raw-public", type: "compressed" } }));
  attempt(`ec ${namedCurve} raw-private`, () => crypto.generateKeyPairSync("ec", { namedCurve, privateKeyEncoding: { format: "raw-private" } }));
}
attempt("ec raw-seed", () => crypto.generateKeyPairSync("ec", { namedCurve: "P-256", privateKeyEncoding: { format: "raw-seed" } }));
attempt("ed25519 raw", () =>
  crypto.generateKeyPairSync("ed25519", { publicKeyEncoding: { format: "raw-public" }, privateKeyEncoding: { format: "raw-private" } }),
);
attempt("ed25519 raw-seed", () => crypto.generateKeyPairSync("ed25519", { privateKeyEncoding: { format: "raw-seed" } }));
attempt("rsa raw-public", () => crypto.generateKeyPairSync("rsa", { modulusLength: 1024, publicKeyEncoding: { format: "raw-public" } }));

// export
const ec = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
const ed = crypto.generateKeyPairSync("ed25519");
const rsa = crypto.generateKeyPairSync("rsa", { modulusLength: 1024 });
const point = Buffer.from(ec.publicKey.export({ format: "raw-public" }));
const compressed = Buffer.from(ec.publicKey.export({ format: "raw-public", type: "compressed" }));
const scalar = Buffer.from(ec.privateKey.export({ format: "raw-private" }));
const jwk = ec.privateKey.export({ format: "jwk" });
console.log("ec point", point.length, point[0], point.subarray(1, 33).toString("base64url") === jwk.x, point.subarray(33).toString("base64url") === jwk.y);
console.log("ec compressed", compressed.length, compressed[0] === 2 + (point[64] & 1), compressed.subarray(1).equals(point.subarray(1, 33)));
console.log("ec scalar", scalar.length, scalar.toString("base64url") === jwk.d);
console.log("ec uncompressed", Buffer.from(ec.publicKey.export({ format: "raw-public", type: "uncompressed" })).equals(point));
const edPublic = Buffer.from(ed.publicKey.export({ format: "raw-public" }));
const edSeed = Buffer.from(ed.privateKey.export({ format: "raw-private" }));
const edJwk = ed.privateKey.export({ format: "jwk" });
console.log("ed25519", edPublic.toString("base64url") === edJwk.x, edSeed.toString("base64url") === edJwk.d);
attempt("ed25519 raw-public with a type", () => ed.publicKey.export({ format: "raw-public", type: "x" }));
attempt("ec bad point type", () => ec.publicKey.export({ format: "raw-public", type: "x" }));
attempt("ec null point type", () => ec.publicKey.export({ format: "raw-public", type: null }));
attempt("private raw-public", () => ec.privateKey.export({ format: "raw-public" }));
attempt("public raw-private", () => ec.publicKey.export({ format: "raw-private" }));
attempt("ec raw-seed", () => ec.privateKey.export({ format: "raw-seed" }));
attempt("ed25519 raw-seed", () => ed.privateKey.export({ format: "raw-seed" }));
attempt("rsa raw-public", () => rsa.publicKey.export({ format: "raw-public" }));
attempt("rsa raw-private", () => rsa.privateKey.export({ format: "raw-private" }));
for (const format of [undefined, 5, "jwk", "raw-private", "raw-seed"])
  attempt(`passphrase with ${format}`, () => ec.privateKey.export({ format, passphrase: "x" }));

// import
const pub = (key) => () => crypto.createPublicKey(key);
const priv = (key) => () => crypto.createPrivateKey(key);
attempt("ec point", pub({ key: point, format: "raw-public", asymmetricKeyType: "ec", namedCurve: "P-256" }));
attempt("ec compressed point", pub({ key: compressed, format: "raw-public", asymmetricKeyType: "ec", namedCurve: "prime256v1" }));
attempt("ec scalar", priv({ key: scalar, format: "raw-private", asymmetricKeyType: "ec", namedCurve: "P-256" }));
attempt("ec scalar as public", pub({ key: scalar, format: "raw-private", asymmetricKeyType: "ec", namedCurve: "P-256" }));
const reread = crypto.createPublicKey({ key: compressed, format: "raw-public", asymmetricKeyType: "ec", namedCurve: "P-256" });
console.log("ec reread", reread.equals(ec.publicKey), Buffer.from(reread.export({ format: "raw-public" })).equals(point));
const rereadPrivate = crypto.createPrivateKey({ key: scalar, format: "raw-private", asymmetricKeyType: "ec", namedCurve: "P-256" });
console.log("ec private reread", crypto.createPublicKey(rereadPrivate).equals(ec.publicKey));
attempt("ed25519 public", pub({ key: edPublic, format: "raw-public", asymmetricKeyType: "ed25519" }));
attempt("ed25519 seed", priv({ key: edSeed, format: "raw-private", asymmetricKeyType: "ed25519" }));
console.log("ed25519 reread", crypto.createPublicKey({ key: edSeed, format: "raw-private", asymmetricKeyType: "ed25519" }).equals(ed.publicKey));

// fixed keys: the EC scalar 1 is the generator, and an Ed25519 seed of
// zeros has a known public key
const one = Buffer.concat([Buffer.alloc(31), Buffer.from([1])]);
const generator = crypto.createPrivateKey({ key: one, format: "raw-private", asymmetricKeyType: "ec", namedCurve: "P-256" });
console.log("generator", Buffer.from(crypto.createPublicKey(generator).export({ format: "raw-public", type: "compressed" })).toString("hex"));
const zeros = crypto.createPrivateKey({ key: Buffer.alloc(32), format: "raw-private", asymmetricKeyType: "ed25519" });
console.log("zero seed", Buffer.from(crypto.createPublicKey(zeros).export({ format: "raw-public" })).toString("hex"));
const message = Buffer.from("raw keys");
console.log("zero seed signature", crypto.sign(null, message, zeros).toString("hex").slice(0, 32));

// import errors
attempt("raw-public to createPrivateKey", priv({ key: point, format: "raw-public", asymmetricKeyType: "ec", namedCurve: "P-256" }));
attempt("string data", pub({ key: "abc", format: "raw-public", asymmetricKeyType: "ec", namedCurve: "P-256" }));
attempt("no asymmetricKeyType", pub({ key: point, format: "raw-public" }));
attempt("number asymmetricKeyType", pub({ key: point, format: "raw-public", asymmetricKeyType: 5 }));
attempt("no namedCurve", pub({ key: point, format: "raw-public", asymmetricKeyType: "ec" }));
attempt("unknown asymmetricKeyType", pub({ key: point, format: "raw-public", asymmetricKeyType: "nope" }));
attempt("Ed25519 spelling", pub({ key: edPublic, format: "raw-public", asymmetricKeyType: "Ed25519" }));
attempt("unknown curve", pub({ key: point, format: "raw-public", asymmetricKeyType: "ec", namedCurve: "nope" }));
attempt("lower-case NIST curve", pub({ key: point, format: "raw-public", asymmetricKeyType: "ec", namedCurve: "p-256" }));
attempt("other curve", pub({ key: point, format: "raw-public", asymmetricKeyType: "ec", namedCurve: "P-384" }));
attempt("short point", pub({ key: point.subarray(0, 64), format: "raw-public", asymmetricKeyType: "ec", namedCurve: "P-256" }));
attempt("off-curve point", pub({ key: Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 1)]), format: "raw-public", asymmetricKeyType: "ec", namedCurve: "P-256" }));
attempt("bad compressed x", pub({ key: Buffer.concat([Buffer.from([2]), Buffer.alloc(32, 0xff)]), format: "raw-public", asymmetricKeyType: "ec", namedCurve: "P-256" }));
attempt("short scalar", priv({ key: scalar.subarray(0, 31), format: "raw-private", asymmetricKeyType: "ec", namedCurve: "P-256" }));
attempt("long scalar", priv({ key: Buffer.concat([Buffer.alloc(1), scalar]), format: "raw-private", asymmetricKeyType: "ec", namedCurve: "P-256" }));
attempt("ec raw-seed", priv({ key: scalar, format: "raw-seed", asymmetricKeyType: "ec", namedCurve: "nope" }));
attempt("ed25519 raw-seed", priv({ key: edSeed, format: "raw-seed", asymmetricKeyType: "ed25519" }));
attempt("short ed25519 key", pub({ key: edPublic.subarray(0, 31), format: "raw-public", asymmetricKeyType: "ed25519" }));
attempt("short ed25519 seed", priv({ key: edSeed.subarray(0, 31), format: "raw-private", asymmetricKeyType: "ed25519" }));
for (const asymmetricKeyType of ["rsa", "rsa-pss", "dsa", "dh"])
  attempt(`${asymmetricKeyType} raw`, pub({ key: edPublic, format: "raw-public", asymmetricKeyType }));

// generateKeyPair passes an encoding the key type has no form for to its
// callback
crypto.generateKeyPair("ed25519", { privateKeyEncoding: { format: "raw-seed" } }, (...args) => {
  console.log("async raw-seed", args.length, args[0].code);
  crypto.generateKeyPair("ec", { namedCurve: "P-384", publicKeyEncoding: { format: "raw-public", type: "compressed" } }, (err, publicKey, privateKey) => {
    console.log("async raw-public", err, describe(publicKey), describe(privateKey));
  });
});
console.log("returned");
