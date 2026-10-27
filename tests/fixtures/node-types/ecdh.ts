import { type ECDH, createECDH, ECDH as ECDHClass, getCurves } from "node:crypto";

const alice: ECDH = createECDH("prime256v1");
const bob: ECDH = createECDH("prime256v1");
alice.setPrivateKey(Buffer.from("0a0b0c", "hex"));
bob.setPrivateKey("0d0e0f", "hex");
const alicePublic: Buffer = alice.getPublicKey();
const bobPublic: string = bob.getPublicKey("hex", "compressed");
const fromAlice: Buffer = bob.computeSecret(alicePublic);
const fromBob: string = alice.computeSecret(bobPublic, "hex", "base64");
console.log(fromAlice.toString("base64") === fromBob, fromBob);
const converted = ECDHClass.convertKey(bobPublic, "prime256v1", "hex", "hex", "hybrid");
console.log(typeof converted === "string" ? converted.slice(0, 4) : "buffer");
const generated: string = createECDH("secp384r1").generateKeys("base64url", "compressed");
const privateKey: Buffer = alice.getPrivateKey();
console.log(generated.length, privateKey.toString("hex"), getCurves().includes("prime256v1"));
