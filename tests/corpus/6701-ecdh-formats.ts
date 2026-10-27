// ECDH public keys in the compressed, uncompressed and hybrid forms, with
// every output encoding, and ECDH.convertKey between the forms, including
// the curves whose p ≡ 1 (mod 4) (secp224r1, secp224k1).
import { createECDH, ECDH } from "node:crypto";

const formats = ["uncompressed", "compressed", "hybrid"] as const;
const encodings = ["hex", "base64", "base64url", "binary"] as const;

for (const curve of ["prime256v1", "secp224r1", "secp224k1", "secp521r1", "brainpoolP384r1"]) {
  const ecdh = createECDH(curve);
  ecdh.setPrivateKey(Buffer.from("00c0ffee1234", "hex"));
  for (const format of formats) {
    const key: Buffer = ecdh.getPublicKey(null, format);
    console.log(curve, format, key.length, key[0], key.toString("hex").slice(-16));
    for (const encoding of encodings) {
      const text: string = ecdh.getPublicKey(encoding, format);
      console.log(" ", encoding, text.length, Buffer.from(text, encoding).equals(key));
    }
    for (const target of formats) {
      const converted = ECDH.convertKey(key, curve, undefined, "hex", target);
      console.log(" ", "to", target, converted === ecdh.getPublicKey("hex", target));
    }
  }
}

// convertKey reads a string key in its input encoding, and answers a
// Buffer without an output encoding.
const ecdh = createECDH("secp256k1");
ecdh.setPrivateKey("7", "binary");
const compressed = ecdh.getPublicKey("base64", "compressed");
const back = ECDH.convertKey(compressed, "secp256k1", "base64");
console.log(Buffer.isBuffer(back), (back as Buffer).equals(ecdh.getPublicKey()));
console.log(ECDH.convertKey(ecdh.getPublicKey("hex"), "secp256k1", "hex", "base64url", "compressed"));
// The point at infinity is one zero byte, and an empty key is the empty
// string.
console.log(ECDH.convertKey(Buffer.from([0]), "prime256v1", undefined, "hex", "compressed"));
console.log(JSON.stringify(ECDH.convertKey(Buffer.alloc(0), "prime256v1")));
// Views of other element types are their bytes.
const view = new Uint8Array(ecdh.getPublicKey());
const converted = ECDH.convertKey(new DataView(view.buffer), "secp256k1", undefined, "hex", "compressed");
console.log(converted === ecdh.getPublicKey("hex", "compressed"));
// Secrets are the same for every form of the other public key.
const other = createECDH("secp256k1");
other.setPrivateKey(Buffer.from([9]));
for (const format of formats) {
  const secret: Buffer = ecdh.computeSecret(other.getPublicKey(null, format));
  console.log(format, secret.toString("base64"));
}
for (const format of formats)
  console.log(format, ecdh.computeSecret(other.getPublicKey("base64", format), "base64", "hex"));
