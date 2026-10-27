// crypto.getDiffieHellman and createDiffieHellmanGroup on every modp
// group: the RFC primes and generator, verifyError, case-insensitive names,
// private keys of the group's width, and key pairs that agree on one
// secret of the prime's length.
import { createDiffieHellmanGroup, getDiffieHellman, type DiffieHellmanGroup } from "node:crypto";

const groups = ["modp1", "modp2", "modp5", "modp14", "modp15", "modp16", "modp17", "modp18"];

function bitLength(bytes: Buffer): number {
  if (bytes.length === 0) return 0;
  return (bytes.length - 1) * 8 + bytes[0]!.toString(2).length;
}

for (const name of groups) {
  const group: DiffieHellmanGroup = getDiffieHellman(name);
  const prime: Buffer = group.getPrime();
  console.log(
    name,
    group.verifyError,
    bitLength(prime),
    prime.toString("hex").slice(0, 24),
    prime.toString("hex").slice(-16),
    group.getGenerator("hex"),
  );
}

// Key exchange on the groups whose exponentiations stay quick.
for (const name of ["modp1", "modp2", "modp5", "modp14"]) {
  const alice = getDiffieHellman(name);
  const bob = createDiffieHellmanGroup(name.toUpperCase());
  const alicePublic: Buffer = alice.generateKeys();
  const bobPublic: string = bob.generateKeys("base64");
  const fromAlice: Buffer = alice.computeSecret(bobPublic, "base64");
  const fromBob: string = bob.computeSecret(alicePublic, null, "hex");
  const width = bitLength(alice.getPrivateKey());
  console.log(
    name,
    fromAlice.length,
    fromAlice.toString("hex") === fromBob,
    alicePublic.length <= fromAlice.length,
    name === "modp1" || name === "modp2" ? width <= bitLength(alice.getPrime()) : width,
  );
  // generateKeys keeps the key pair it has.
  console.log(alice.generateKeys("hex") === alicePublic.toString("hex"), alice.getPublicKey().equals(alicePublic));
}

// The prime and generator in every encoding.
const modp5 = getDiffieHellman("Modp5");
for (const encoding of ["hex", "base64", "base64url", "latin1", "binary"] as const) {
  const prime: string = modp5.getPrime(encoding as "hex");
  console.log(encoding, prime.length, JSON.stringify(modp5.getGenerator(encoding as "hex")));
}
