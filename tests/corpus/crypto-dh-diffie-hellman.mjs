// crypto.diffieHellman over DH KeyObjects: a shared secret at the modulus
// width from KeyObjects and from PEM inputs, both sides agreeing, the
// callback form, and Node's errors for mismatched domain parameters, mixed
// key types and a public key in the private slot.
import * as crypto from "node:crypto";

const failure = (error) => `${error.name}: ${error.message}`;
const a = crypto.generateKeyPairSync("dh", { group: "modp5" });
const b = crypto.generateKeyPairSync("dh", { group: "modp5" });
const sharedA = crypto.diffieHellman({ privateKey: a.privateKey, publicKey: b.publicKey });
const sharedB = crypto.diffieHellman({ privateKey: b.privateKey, publicKey: a.publicKey });
console.log("shared", Buffer.isBuffer(sharedA), sharedA.length, sharedA.equals(sharedB));

const aPrivatePem = String(a.privateKey.export({ type: "pkcs8", format: "pem" }));
const aPublicPem = String(a.publicKey.export({ type: "spki", format: "pem" }));
const bPrivatePem = String(b.privateKey.export({ type: "pkcs8", format: "pem" }));
const bPublicPem = String(b.publicKey.export({ type: "spki", format: "pem" }));
const pemA = crypto.diffieHellman({ privateKey: aPrivatePem, publicKey: bPublicPem });
const pemB = crypto.diffieHellman({ privateKey: bPrivatePem, publicKey: aPublicPem });
console.log("pem", pemA.length, pemA.equals(pemB), pemA.equals(sharedA));

const big = crypto.generateKeyPairSync("dh", { group: "modp14" });
const ec = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
const attempt = (label, run) => {
  try {
    run();
    console.log(label, "resolved");
  } catch (error) {
    console.log(label, failure(error));
  }
};
attempt("mismatched groups", () => crypto.diffieHellman({ privateKey: a.privateKey, publicKey: big.publicKey }));
attempt("dh private ec public", () => crypto.diffieHellman({ privateKey: a.privateKey, publicKey: ec.publicKey }));
attempt("ec private dh public", () => crypto.diffieHellman({ privateKey: ec.privateKey, publicKey: a.publicKey }));
attempt("public as private", () => crypto.diffieHellman({ privateKey: a.publicKey, publicKey: b.publicKey }));

const [error, shared] = await new Promise((resolve) => {
  crypto.diffieHellman({ privateKey: a.privateKey, publicKey: b.publicKey }, (failure, secret) =>
    resolve([failure, secret]),
  );
});
console.log("callback", error, Buffer.isBuffer(shared), shared.length, shared.equals(sharedA));

// Node's provider rejects a zero private value and a peer public value
// outside 2..p-2 before it derives. The DER below reuses the modp5
// parameters with a chosen private or public integer.
const derLength = (n) => {
  if (n < 128) return Buffer.from([n]);
  const bytes = [];
  let value = n;
  while (value > 0) {
    bytes.unshift(value & 0xff);
    value >>= 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
};
const tlv = (tag, content) => Buffer.concat([Buffer.from([tag]), derLength(content.length), content]);
const derInt = (bytes) => {
  let start = 0;
  while (start < bytes.length - 1 && bytes[start] === 0) start++;
  let value = bytes.subarray(start);
  if (value[0] & 0x80) value = Buffer.concat([Buffer.from([0]), value]);
  return tlv(0x02, value);
};
const prime = crypto.getDiffieHellman("modp5").getPrime();
const params = tlv(0x30, Buffer.concat([derInt(prime), derInt(Buffer.from([2]))]));
const algorithm = tlv(0x30, Buffer.concat([Buffer.from("06092a864886f70d010301", "hex"), params]));
const publicKeyWith = (y) => tlv(0x30, Buffer.concat([algorithm, tlv(0x03, Buffer.concat([Buffer.from([0]), derInt(y)]))]));
const privateKeyWith = (x) => tlv(0x30, Buffer.concat([tlv(0x02, Buffer.from([0])), algorithm, tlv(0x04, derInt(x))]));
const belowOne = Buffer.from(prime);
belowOne[belowOne.length - 1] -= 1;
for (const [label, y] of [
  ["zero", Buffer.from([0])],
  ["one", Buffer.from([1])],
  ["p-1", belowOne],
]) {
  const peer = crypto.createPublicKey({ key: publicKeyWith(y), format: "der", type: "spki" });
  attempt(`peer ${label}`, () => crypto.diffieHellman({ privateKey: a.privateKey, publicKey: peer }));
}
const zeroSecret = crypto.createPrivateKey({ key: privateKeyWith(Buffer.from([0])), format: "der", type: "pkcs8" });
attempt("private zero", () => crypto.diffieHellman({ privateKey: zeroSecret, publicKey: b.publicKey }));
