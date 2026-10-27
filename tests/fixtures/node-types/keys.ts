import {
  type KeyObject,
  createPrivateKey,
  createPublicKey,
  createSign,
  createVerify,
  generateKeyPair,
  generateKeyPairSync,
  sign,
  verify,
} from "node:crypto";

const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const data = Buffer.from("typed keys");
const signature: Buffer = sign("sha256", data, privateKey);
console.log(publicKey.type, privateKey.asymmetricKeyType, verify("sha256", data, publicKey, signature));
const pem = privateKey.export({ type: "pkcs8", format: "pem" });
const parsed: KeyObject = createPrivateKey(pem);
console.log(parsed.equals(privateKey), createPublicKey(parsed).equals(publicKey));
const pems = generateKeyPairSync("rsa", {
  modulusLength: 1024,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
const signer = createSign("SHA256");
signer.update("typed");
const hex: string = signer.sign(pems.privateKey, "hex");
const verifier = createVerify("SHA256");
verifier.update("typed");
console.log(pems.publicKey.split("\n")[0], verifier.verify(pems.publicKey, hex, "hex"));
const ed = generateKeyPairSync("ed25519");
const edSignature: Buffer = sign(null, data, ed.privateKey);
console.log(ed.publicKey.asymmetricKeyType, edSignature.length, verify(null, data, ed.publicKey, edSignature));
const edJwk = ed.publicKey.export({ format: "jwk" });
console.log(edJwk.kty, edJwk.crv, createPublicKey({ key: edJwk, format: "jwk" }).equals(ed.publicKey));
const edDer = generateKeyPairSync("ed25519", {
  publicKeyEncoding: { type: "spki", format: "der" },
  privateKeyEncoding: { type: "pkcs8", format: "der" },
});
console.log(edDer.publicKey.length, edDer.privateKey.length);
generateKeyPair("rsa", { modulusLength: 1024 }, (err, rsaPublic, rsaPrivate) => {
  console.log(err, rsaPublic.asymmetricKeyDetails?.modulusLength, rsaPrivate.type);
});
