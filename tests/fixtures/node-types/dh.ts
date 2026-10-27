import {
  type DiffieHellman,
  type DiffieHellmanGroup,
  createDiffieHellman,
  createDiffieHellmanGroup,
  getDiffieHellman,
} from "node:crypto";

const group: DiffieHellmanGroup = getDiffieHellman("modp2");
const alice: DiffieHellman = createDiffieHellman(group.getPrime(), group.getGenerator());
const bob: DiffieHellman = createDiffieHellman(group.getPrime("hex"), "hex", 2);
alice.setPrivateKey(Buffer.from("0a0b0c", "hex"));
bob.setPrivateKey("0d0e0f", "hex");
const alicePublic: Buffer = alice.generateKeys();
const bobPublic: string = bob.generateKeys("base64");
const fromAlice: string = alice.computeSecret(bobPublic, "base64", "hex");
const fromBob: Buffer = bob.computeSecret(alicePublic);
console.log(fromAlice === fromBob.toString("hex"), fromAlice.slice(0, 16), alice.verifyError);
const named: DiffieHellmanGroup = createDiffieHellmanGroup("modp5");
console.log(named.getPrime().length, named.getGenerator("hex"), bob.getPrivateKey("hex"));
const generated: string = named.generateKeys("hex");
console.log(generated.length <= 384, named.getPublicKey("hex") === generated);
