// DiffieHellman string inputs and outputs from CommonJS: primes and
// generators as strings in every binary encoding, the keyEncoding slot
// read as the generator, keys set in every Buffer encoding and read in the
// declared ones, and computeSecret's input and output encodings.
const crypto = require("node:crypto");

// Values the declared overloads do not cover reach the calls through an
// untyped function, as they would from other untyped code.
const loose = (value) => value;

const prime = crypto.getDiffieHellman("modp2").getPrime();
const encodings = ["hex", "base64", "base64url", "latin1", "binary", "HEX", "Base64"];

for (const encoding of encodings) {
  const text = prime.toString(encoding.toLowerCase());
  const dh = crypto.createDiffieHellman(text, encoding, "05", "hex");
  console.log(encoding, dh.getPrime().equals(prime), dh.getGenerator("hex"));
}
console.log(crypto.createDiffieHellman(prime.toString("hex"), "hex", "05", "hex").verifyError);

// A truthy keyEncoding that names no encoding is the generator, and the
// generator slot its encoding.
console.log(crypto.createDiffieHellman(prime, 7).getGenerator("hex"));
console.log(crypto.createDiffieHellman(prime, "\x05").getGenerator("hex"));
console.log(crypto.createDiffieHellman(prime, Buffer.from([3])).getGenerator("hex"));
console.log(crypto.createDiffieHellman(prime, "buffer", 11).getGenerator("hex"));
console.log(crypto.createDiffieHellman(prime, "0d", "hex").getGenerator("hex"));
console.log(crypto.createDiffieHellman(prime, "base64", "Ew==", "base64").getGenerator("hex"));
console.log(crypto.createDiffieHellman(prime, "", 0, "").getGenerator("hex"));

// Keys in and out of every encoding.
const alice = crypto.createDiffieHellman(prime);
const bob = crypto.createDiffieHellman(prime);
alice.setPrivateKey("q83vEjRWeJA=", "base64");
bob.setPrivateKey(Buffer.from("10325476", "hex"));
alice.generateKeys();
bob.generateKeys();
function report(encoding, key, secret) {
  const bytes = Buffer.isBuffer(secret) ? secret : Buffer.from(secret, encoding);
  console.log(encoding, typeof key, key.length, bytes.toString("hex").slice(0, 24));
}
const hex = alice.getPublicKey("hex");
report("hex", hex, bob.computeSecret(hex, "hex", "hex"));
const base64 = alice.getPublicKey("base64");
report("base64", base64, bob.computeSecret(base64, "base64", "base64"));
const base64url = alice.getPublicKey("base64url");
report("base64url", base64url, bob.computeSecret(base64url, "base64url", "base64url"));
const binary = alice.getPublicKey("binary");
report("binary", binary, bob.computeSecret(binary, "binary", "binary"));
const view = alice.getPublicKey();
report("undefined", view, bob.computeSecret(view, undefined, undefined));
report("null", view, bob.computeSecret(view, null, null));
// Encodings @types/node does not declare for these methods reach them
// through an untyped receiver.
const untypedBob = loose(bob);
console.log(alice.getPrivateKey("hex"), alice.getPrivateKey("base64url"), untypedBob.getPrivateKey("latin1").length);
console.log(untypedBob.getPublicKey("utf16le").length, untypedBob.getPrime("ucs2").length, untypedBob.getGenerator("buffer"));
console.log(untypedBob.computeSecret(loose(alice).getPublicKey("latin1"), "latin1", "base64").slice(0, 16));

// setPublicKey and setPrivateKey read strings through their encoding;
// 'buffer' and a missing encoding read utf8.
const keys = crypto.createDiffieHellman(prime);
keys.setPublicKey("ffee", "hex");
loose(keys).setPrivateKey("zz", "buffer");
console.log(keys.getPublicKey("hex"), keys.getPrivateKey("hex"));
keys.setPublicKey("é");
console.log(keys.getPublicKey("hex"));
keys.setPublicKey("é", "latin1");
console.log(keys.getPublicKey("hex"));
keys.setPrivateKey(new Uint16Array([0x0102, 0x0304]));
console.log(keys.getPrivateKey("hex"));
keys.setPrivateKey(new DataView(new Uint8Array([9, 8, 7]).buffer));
console.log(keys.getPrivateKey("hex"));
