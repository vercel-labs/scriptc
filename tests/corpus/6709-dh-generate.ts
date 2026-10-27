// crypto.createDiffieHellman(primeLength, generator) generates a safe
// prime of the requested length: p ≡ 23 (mod 24) for the generator 2,
// p ≡ 59 (mod 60) for 5 and p ≡ 11 (mod 12) otherwise. A second party built
// from the first one's prime and generator agrees on the secret.
import { createDiffieHellman } from "node:crypto";

function bitLength(bytes: Buffer): number {
  if (bytes.length === 0) return 0;
  return (bytes.length - 1) * 8 + bytes[0]!.toString(2).length;
}

function mod(bytes: Buffer, m: number): number {
  let r = 0;
  for (const byte of bytes) r = (r * 256 + byte) % m;
  return r;
}

for (const generator of [undefined, 2, 5, 3, 7]) {
  const alice = generator === undefined ? createDiffieHellman(512) : createDiffieHellman(512, generator);
  const prime = alice.getPrime();
  console.log(
    generator,
    bitLength(prime),
    alice.getGenerator("hex"),
    alice.verifyError,
    generator === undefined || generator === 2
      ? mod(prime, 24)
      : generator === 5
        ? mod(prime, 60)
        : mod(prime, 12),
  );
  const bob = createDiffieHellman(alice.getPrime(), alice.getGenerator());
  const alicePublic = alice.generateKeys();
  const bobPublic = bob.generateKeys("hex");
  const secret = alice.computeSecret(bobPublic, "hex");
  console.log(
    bob.verifyError,
    bitLength(alice.getPrivateKey()),
    secret.length,
    secret.equals(bob.computeSecret(alicePublic)),
  );
}

// A string prime with its encoding, and the generator as a string.
const shared = createDiffieHellman(512);
const copy = createDiffieHellman(shared.getPrime("base64"), "base64", shared.getGenerator("hex"), "hex");
console.log(copy.getPrime().equals(shared.getPrime()), copy.getGenerator("hex"), copy.verifyError);
