// crypto.createECDH on every implemented curve: generated key pairs agree
// on one shared secret of the field's size, and fixed private keys give
// the same public keys and secrets as Node.
import { createECDH, ECDH } from "node:crypto";

const curves = [
  "prime192v1",
  "secp224r1",
  "prime256v1",
  "secp384r1",
  "secp521r1",
  "secp192k1",
  "secp224k1",
  "secp256k1",
  "brainpoolP256r1",
  "brainpoolP384r1",
  "brainpoolP512r1",
];

function pair(curve: string): [ECDH, ECDH] {
  const alice = createECDH(curve);
  const bob = createECDH(curve);
  alice.generateKeys();
  bob.generateKeys();
  return [alice, bob];
}

for (const curve of curves) {
  const [alice, bob] = pair(curve);
  const a: Buffer = alice.computeSecret(bob.getPublicKey());
  const b: Buffer = bob.computeSecret(alice.getPublicKey());
  console.log(
    curve,
    alice.getPublicKey().length,
    alice.getPublicKey(null, "compressed").length,
    a.length,
    a.equals(b),
    alice.getPrivateKey().length <= a.length + 1,
  );
}

// Fixed keys: the public points and the secret are the curve's arithmetic.
for (const curve of curves) {
  const alice = createECDH(curve);
  const bob = createECDH(curve);
  alice.setPrivateKey("1f2e3d4c5b6a79881726354453627180", "hex");
  bob.setPrivateKey(Buffer.from("0123456789abcdeffedcba9876543210", "hex"));
  const secret: string = alice.computeSecret(bob.getPublicKey("hex"), "hex", "hex");
  console.log(curve, alice.getPublicKey("hex").slice(0, 34), bob.getPublicKey("base64", "compressed"));
  console.log(curve, secret, secret === bob.computeSecret(alice.getPublicKey("hex"), "hex", "hex"));
}

// The generated keys round-trip through setPrivateKey.
const generated = createECDH("prime256v1");
const publicKey: string = generated.generateKeys("hex");
const copy = createECDH("prime256v1");
copy.setPrivateKey(generated.getPrivateKey());
console.log(copy.getPublicKey("hex") === publicKey);
