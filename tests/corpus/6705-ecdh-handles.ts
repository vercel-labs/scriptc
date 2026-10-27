// ECDH handles held in arrays, maps, class fields and closures, passed to
// and returned from functions, keep their keys; results flow into typed
// locals as Buffers and strings.
import * as crypto from "node:crypto";

class Party {
  readonly name: string;
  readonly ecdh: crypto.ECDH;
  constructor(name: string, curve: string, seed: number) {
    this.name = name;
    this.ecdh = crypto.createECDH(curve);
    this.ecdh.setPrivateKey(Buffer.from([seed, seed + 1, seed + 2]));
  }
  publicKey(): Buffer {
    return this.ecdh.getPublicKey();
  }
  agree(other: Party): string {
    return this.ecdh.computeSecret(other.publicKey()).toString("hex");
  }
}

const parties = [new Party("alice", "secp256k1", 1), new Party("bob", "secp256k1", 7), new Party("carol", "secp256k1", 9)];
for (const a of parties)
  for (const b of parties)
    if (a !== b) console.log(a.name, b.name, a.agree(b).slice(0, 16), a.agree(b) === b.agree(a));

const byCurve = new Map<string, crypto.ECDH>();
for (const curve of ["prime256v1", "secp384r1"]) {
  const ecdh = crypto.createECDH(curve);
  ecdh.setPrivateKey(Buffer.from([5]));
  byCurve.set(curve, ecdh);
}
for (const [curve, ecdh] of byCurve) console.log(curve, ecdh.getPublicKey("base64url", "compressed"));

function make(curve: string): () => string {
  const ecdh = crypto.createECDH(curve);
  ecdh.setPrivateKey(Buffer.from([11]));
  return () => ecdh.getPublicKey("hex", "compressed");
}
const keyOf = make("brainpoolP256r1");
console.log(keyOf() === keyOf(), keyOf().slice(0, 12));

function exchange(curve: string): [Buffer, Buffer] {
  const x = crypto.createECDH(curve);
  const y = crypto.createECDH(curve);
  x.generateKeys();
  y.generateKeys();
  return [x.computeSecret(y.getPublicKey()), y.computeSecret(x.getPublicKey())];
}
const [left, right] = exchange("prime192v1");
console.log(left.length, left.equals(right), crypto.timingSafeEqual(left, right));

const fromConvert = crypto.ECDH.convertKey(parties[0]!.publicKey(), "secp256k1", undefined, "hex", "compressed");
const text: string = typeof fromConvert === "string" ? fromConvert : fromConvert.toString("hex");
console.log(text);
