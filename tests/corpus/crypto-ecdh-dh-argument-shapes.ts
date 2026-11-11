// ECDH and DiffieHellman read every encoding argument the way Node does: a
// falsy encoding and the string "buffer" answer the key bytes themselves as
// a Buffer, every other spelling answers Buffer.toString(encoding), and an
// encoding whose type is a union answers whichever of the two its value
// selects. computeSecret reads its second argument as the key's input
// encoding, so a view key with only that argument still answers a Buffer.
import * as crypto from "node:crypto";
import { type Encoding } from "node:crypto";

function shape(value: Buffer | string): string {
  if (Buffer.isBuffer(value)) return `buffer:${value.length}:${value.toString("hex").slice(0, 16)}`;
  return `string:${value.length}:${value.slice(0, 8)}`;
}

// A union-typed result read as bytes: the encoding names the string branch's
// bytes, which the "buffer" and "" calls never take.
function asBuffer(value: Buffer | string, encoding: BufferEncoding): Buffer {
  return Buffer.isBuffer(value) ? value : Buffer.from(value, encoding);
}

// The bytes a union-typed result stands for, read back through the encoding
// its value selected.
function rendered(value: string, encoding: Encoding | null): Buffer {
  return Buffer.from(value, (encoding ?? "utf8") as BufferEncoding);
}

// A encoding whose static type is the union, so each member's union form is
// what a program holding an encoding in a variable reaches.
function encodingOf(name: string): Encoding | null {
  return name === "none" ? null : (name as Encoding);
}

// ── ECDH on prime256v1 with the fixed private keys 1 and 3 ──────────────
const alice = crypto.createECDH("prime256v1");
const bob = crypto.createECDH("prime256v1");
alice.setPrivateKey(Buffer.from([1]));
bob.setPrivateKey(Buffer.from([3]));
const alicePublic: Buffer = alice.getPublicKey();
const bobPublic: Buffer = bob.getPublicKey();
console.log("public", alicePublic.length, bobPublic.length, alicePublic[0], bobPublic[0]);

// generateKeys reads its encoding and format the same way; it replaces the
// private key, so the throwaway handle keeps alice's keys.
const generator = crypto.createECDH("prime256v1");
const genNull: Buffer = generator.generateKeys(null, "compressed");
const genUndefined: Buffer = generator.generateKeys(undefined, "uncompressed");
const genBuffer: Buffer = generator.generateKeys("buffer", "compressed");
const genEmpty: Buffer = generator.generateKeys("", "uncompressed");
const genHex: string = generator.generateKeys("hex", "compressed");
const genBase64url: string = generator.generateKeys("base64url", "hybrid");
console.log("generateKeys", genNull.length, genUndefined.length, genBuffer.length, genEmpty.length, genHex.length, genBase64url.length);

const pubNone: Buffer = alice.getPublicKey();
const pubNull: Buffer = alice.getPublicKey(null);
const pubUndefined: Buffer = alice.getPublicKey(undefined, "compressed");
const pubBuffer: Buffer = alice.getPublicKey("buffer", "uncompressed");
const pubEmpty: Buffer = alice.getPublicKey("", "compressed");
const pubHex: string = alice.getPublicKey("hex", "compressed");
const pubLatin1: string = alice.getPublicKey("latin1", "hybrid");
console.log("getPublicKey", shape(pubNone), shape(pubNull), shape(pubUndefined), shape(pubBuffer), shape(pubEmpty), shape(pubHex), shape(pubLatin1));

const privNone: Buffer = alice.getPrivateKey();
const privNull: Buffer = alice.getPrivateKey(null);
const privBuffer: Buffer = alice.getPrivateKey("buffer");
const privEmpty: Buffer = alice.getPrivateKey("");
const privHex: string = alice.getPrivateKey("hex");
const privUtf16le: string = alice.getPrivateKey("utf16le");
const privBinary: string = alice.getPrivateKey("binary");
console.log("getPrivateKey", shape(privNone), shape(privNull), shape(privBuffer), shape(privEmpty), shape(privHex), shape(privUtf16le), shape(privBinary));

// computeSecret: a view key ignores the input encoding it is given.
const secretView: Buffer = alice.computeSecret(bobPublic);
const secretViewNull: Buffer = alice.computeSecret(bobPublic, null);
const secretViewUndefined: Buffer = alice.computeSecret(bobPublic, undefined);
const secretViewInputHex: Buffer = alice.computeSecret(bobPublic, "hex");
const secretOutHex: string = alice.computeSecret(bobPublic, undefined, "hex");
const secretOutNullHex: string = alice.computeSecret(bobPublic, null, "hex");
const secretOutUtf8: string = alice.computeSecret(bobPublic, null, "utf8");
const secretOutBuffer: Buffer | string = alice.computeSecret(bobPublic, undefined, "buffer");
const secretOutEmpty: Buffer | string = alice.computeSecret(bobPublic, "", "");
const secretStringView: Buffer = alice.computeSecret(bobPublic.toString("base64"), "base64");
const secretStringOut: string = alice.computeSecret(bobPublic.toString("hex"), "hex", "base64url");
const secretStringNullOut: string = alice.computeSecret(bobPublic.toString("latin1"), "latin1", "hex");
console.log(
  "computeSecret",
  shape(secretView),
  secretViewNull.equals(secretView),
  secretViewUndefined.equals(secretView),
  secretViewInputHex.equals(secretView),
  Buffer.from(secretOutHex, "hex").equals(secretView),
  Buffer.from(secretOutNullHex, "hex").equals(secretView),
  asBuffer(secretOutBuffer, "hex").equals(secretView),
  asBuffer(secretOutEmpty, "hex").equals(secretView),
  secretStringView.equals(secretView),
  Buffer.from(secretStringOut, "base64url").equals(secretView),
  Buffer.from(secretStringNullOut, "hex").equals(secretView),
  shape(secretOutUtf8),
);

// The same calls with the encoding held in a variable of the union type.
for (const name of ["hex", "buffer", "", "none", "base64url", "utf16le"]) {
  const encoding = encodingOf(name);
  console.log("union", name, shape(alice.getPublicKey(encoding, "compressed")), shape(alice.computeSecret(bobPublic, encoding, encoding)));
}

// convertKey reads its input and output encodings the same way.
const convertNone = crypto.ECDH.convertKey(alicePublic, "prime256v1", null, null, "compressed");
const convertUndefined = crypto.ECDH.convertKey(alicePublic, "prime256v1", undefined, undefined);
const convertOutHex = crypto.ECDH.convertKey(alicePublic, "prime256v1", undefined, "hex", "compressed");
const convertFromHex = crypto.ECDH.convertKey(alicePublic.toString("hex"), "prime256v1", "hex");
const convertBuffer = crypto.ECDH.convertKey(alicePublic, "prime256v1", "", "buffer", "compressed");
const convertNullOutput = crypto.ECDH.convertKey(bobPublic.toString("hex"), "prime256v1", "hex", null, "hybrid");
console.log("convertKey", shape(convertNone), shape(convertUndefined), shape(convertOutHex), shape(convertFromHex), shape(convertBuffer), shape(convertNullOutput));

// setPrivateKey reads a string through its encoding, and utf8 by default.
const fresh = crypto.createECDH("prime256v1");
fresh.setPrivateKey("03", "hex");
console.log("setPrivateKey hex", fresh.getPublicKey("hex", "compressed"));
fresh.setPrivateKey("\x05");
console.log("setPrivateKey utf8", fresh.getPublicKey("hex", "compressed"));
fresh.setPrivateKey("\x07", null);
console.log("setPrivateKey null", fresh.getPublicKey("hex", "compressed"));

// ── DiffieHellman on the modp2 group ───────────────────────────────────
// generateKeys replaces the private key, so the group's own keys are the
// fixed prime and generator; key material is reported by length, by the
// bytes each encoding round-trips to, and by the secrets two parties agree
// on.
const prime = crypto.getDiffieHellman("modp2").getPrime();
const da = crypto.createDiffieHellman(prime, 2);
const db = crypto.createDiffieHellman(prime, 2);
da.generateKeys();
db.generateKeys();
const daPublic: Buffer = da.getPublicKey();
const dbPublic: Buffer = db.getPublicKey();
const daPrivate: Buffer = da.getPrivateKey();
const secret: Buffer = da.computeSecret(dbPublic);
console.log("dh", daPublic.length, dbPublic.length, daPrivate.length, secret.length, db.computeSecret(daPublic).equals(secret));

const primeNone: Buffer = da.getPrime();
const primeNull: Buffer = da.getPrime(null);
const primeBuffer: Buffer = da.getPrime("buffer");
const primeEmpty: Buffer = da.getPrime("");
const primeHex: string = da.getPrime("hex");
const primeUtf8: string = da.getPrime("utf8");
const primeUcs2: string = da.getPrime("ucs2");
console.log(
  "getPrime",
  shape(primeNone),
  primeNull.equals(primeNone),
  primeBuffer.equals(primeNone),
  primeEmpty.equals(primeNone),
  Buffer.from(primeHex, "hex").equals(primeNone),
  primeUtf8 === primeNone.toString("utf8"),
  primeUcs2 === primeNone.toString("ucs2"),
);

const generatorNone: Buffer = da.getGenerator();
const generatorNull: Buffer = da.getGenerator(null);
const generatorBuffer: Buffer = da.getGenerator("buffer");
const generatorHex: string = da.getGenerator("hex");
console.log(
  "getGenerator",
  shape(generatorNone),
  generatorNull.equals(generatorNone),
  generatorBuffer.equals(generatorNone),
  Buffer.from(generatorHex, "hex").equals(generatorNone),
);

const dhPrivNone: Buffer = da.getPrivateKey();
const dhPrivNull: Buffer = da.getPrivateKey(null);
const dhPrivEmpty: Buffer = da.getPrivateKey("");
const dhPrivHex: string = da.getPrivateKey("hex");
console.log(
  "dh getPrivateKey",
  dhPrivNone.equals(daPrivate),
  dhPrivNull.equals(daPrivate),
  dhPrivEmpty.equals(daPrivate),
  Buffer.from(dhPrivHex, "hex").equals(daPrivate),
  da.getPrivateKey("buffer").equals(daPrivate),
  da.getPrivateKey("base64url").length > 0,
);

const dhPubNone: Buffer = da.getPublicKey();
console.log(
  "dh getPublicKey",
  dhPubNone.equals(daPublic),
  da.getPublicKey("buffer").equals(daPublic),
  da.getPublicKey(null).equals(daPublic),
  da.getPublicKey("").equals(daPublic),
  Buffer.from(da.getPublicKey("hex"), "hex").equals(daPublic),
  da.getPublicKey("latin1") === daPublic.toString("latin1"),
  da.getPublicKey("base64url") === daPublic.toString("base64url"),
);

const dhSecretNull: Buffer = da.computeSecret(dbPublic, null);
const dhSecretUndefined: Buffer = da.computeSecret(dbPublic, undefined);
const dhSecretInputHex: Buffer = da.computeSecret(dbPublic, "hex");
const dhSecretOutHex: string = da.computeSecret(dbPublic, undefined, "hex");
const dhSecretNullOutHex: string = da.computeSecret(dbPublic, null, "hex");
const dhSecretOutBuffer: Buffer | string = da.computeSecret(dbPublic, "hex", "buffer");
const dhSecretOutEmpty: Buffer | string = da.computeSecret(dbPublic, undefined, "");
const dhSecretOutUtf8: string = da.computeSecret(dbPublic, "utf8", "utf8");
const dhSecretString: Buffer = da.computeSecret(dbPublic.toString("hex"), "hex");
const dhSecretStringOut: string = da.computeSecret(dbPublic.toString("base64"), "base64", "base64url");
const dhSecretStringLatin1: string = da.computeSecret(dbPublic.toString("latin1"), "latin1", "hex");
console.log(
  "dh computeSecret",
  dhSecretNull.equals(secret),
  dhSecretUndefined.equals(secret),
  dhSecretInputHex.equals(secret),
  Buffer.from(dhSecretOutHex, "hex").equals(secret),
  Buffer.from(dhSecretNullOutHex, "hex").equals(secret),
  asBuffer(dhSecretOutBuffer, "hex").equals(secret),
  asBuffer(dhSecretOutEmpty, "hex").equals(secret),
  dhSecretOutUtf8 === secret.toString("utf8"),
  dhSecretString.equals(secret),
  Buffer.from(dhSecretStringOut, "base64url").equals(secret),
  Buffer.from(dhSecretStringLatin1, "hex").equals(secret),
);

// generateKeys replaces the key, so a throwaway handle answers it.
const throwaway = crypto.createDiffieHellman(prime, 2);
const dhGenNull: Buffer = throwaway.generateKeys(null);
const dhGenBuffer: Buffer = throwaway.generateKeys("buffer");
const dhGenEmpty: Buffer = throwaway.generateKeys("");
const dhGenHex: string = throwaway.generateKeys("hex");
const dhGenUtf16le: string = throwaway.generateKeys("utf16le");
console.log("dh generateKeys", dhGenNull.length, dhGenBuffer.length, dhGenEmpty.length, dhGenHex.length, dhGenUtf16le.length);

for (const name of ["hex", "buffer", "", "none", "base64url"]) {
  const encoding = encodingOf(name);
  const publicKey = da.getPublicKey(encoding);
  const shared = da.computeSecret(dbPublic, encoding, encoding);
  const publicBytes = Buffer.isBuffer(publicKey) ? publicKey : rendered(publicKey, encoding);
  const sharedBytes = Buffer.isBuffer(shared) ? shared : rendered(shared, encoding);
  console.log(
    "dh union",
    name,
    Buffer.isBuffer(publicKey) ? "buffer" : "string",
    Buffer.isBuffer(shared) ? "buffer" : "string",
    publicBytes.equals(daPublic),
    sharedBytes.equals(secret),
  );
}

// setPublicKey and setPrivateKey read strings through their encoding too.
const keys = crypto.createDiffieHellman(prime, 2);
keys.setPublicKey(daPublic.toString("hex"), "hex");
keys.setPrivateKey("0b", "hex");
console.log("dh setters", keys.getPublicKey().equals(daPublic), keys.getPrivateKey("hex"));
keys.setPublicKey(daPublic.toString("latin1"), "latin1");
keys.setPrivateKey("\x0d");
console.log("dh setters latin1", keys.getPublicKey().equals(daPublic), keys.getPrivateKey("hex"));
