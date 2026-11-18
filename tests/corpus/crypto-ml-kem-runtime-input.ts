// node:crypto ML-KEM reached only through run-time inputs: the algorithm is
// computed and the PKCS#8 encoding read at run time, so no parameter-set
// literal and no encapsulate/decapsulate call selects the units; the pki
// unit carries the ML-KEM hook with it.
import { createPrivateKey, createPublicKey, generateKeyPairSync } from "node:crypto";

const log = (...a: unknown[]) => console.log(a.map(String).join(" | "));

const algorithm = ["ml", "kem", "768"].join("-") as "ml-kem-768";
const kp = generateKeyPairSync(algorithm);
log("gen", kp.privateKey.asymmetricKeyType, kp.publicKey.asymmetricKeyType,
  kp.privateKey.export({ type: "pkcs8", format: "der" }).length,
  kp.publicKey.export({ type: "spki", format: "der" }).length);

const seed = Buffer.from("386e9c7d79136fd98439aa796bf3c36e9082416ba3363b6299ef40c5ae7c9415ad79ac7b1cacb8dcf63976aaf2a2b0e738b59afa8a29f8ca600f294e991d9d45", "hex");
const pkcs8 = Buffer.concat([Buffer.from("3054020100300b060960864801650304040204428040", "hex"), seed]);
const priv = createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" });
const pub = createPublicKey(priv);
log("import", priv.asymmetricKeyType, pub.asymmetricKeyType,
  priv.export({ type: "pkcs8", format: "der" }).equals(pkcs8),
  Buffer.from(pub.export({ type: "spki", format: "der" })).length);

const pubDer = pub.export({ type: "spki", format: "der" });
const again = createPublicKey({ key: pubDer, format: "der", type: "spki" });
log("public", again.asymmetricKeyType,
  Buffer.from(again.export({ type: "spki", format: "der" })).equals(pubDer));
