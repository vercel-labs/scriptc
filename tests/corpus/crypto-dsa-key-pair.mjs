// crypto.generateKeyPairSync('dsa'): DSA KeyObjects from generated FIPS
// 186-4 parameters, their details, DER and PEM exports, the unsupported
// JWK, re-import and equality, the public half, DER and IEEE P1363
// signatures over several digests, and Node's option and parameter errors.
import * as crypto from "node:crypto";

const show = (label, f) => {
  try {
    const v = f();
    console.log(label, typeof v === "string" ? v : JSON.stringify(v));
  } catch (e) {
    console.log(label, "THROW", e.name, e.code, e.message);
  }
};

const pair = crypto.generateKeyPairSync("dsa", { modulusLength: 1024, divisorLength: 160 });
show("types", () => [pair.privateKey.type, pair.privateKey.asymmetricKeyType, pair.publicKey.type]);
show("details", () => JSON.stringify(pair.privateKey.asymmetricKeyDetails));
show("public details", () => JSON.stringify(pair.publicKey.asymmetricKeyDetails));
const pkcs8 = pair.privateKey.export({ format: "der", type: "pkcs8" });
const spki = pair.publicKey.export({ format: "der", type: "spki" });
console.log("der", spki.length >= 440 && spki.length <= 444, pkcs8.length >= 330 && pkcs8.length <= 340);
console.log("labels", pair.privateKey.export({ format: "pem", type: "pkcs8" }).split("\n")[0],
  pair.publicKey.export({ format: "pem", type: "spki" }).split("\n")[0]);
show("jwk", () => pair.publicKey.export({ format: "jwk" }));

const backPriv = crypto.createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" });
const backPub = crypto.createPublicKey({ key: spki, format: "der", type: "spki" });
show("reimport", () => [backPriv.asymmetricKeyType, backPub.asymmetricKeyType,
  JSON.stringify(backPub.asymmetricKeyDetails)]);
show("equals", () => [backPriv.equals(pair.privateKey), backPub.equals(pair.publicKey)]);
show("public of private", () => [crypto.createPublicKey(pair.privateKey).equals(pair.publicKey)]);
show("verify with imported private key",
  () => crypto.verify("sha256", Buffer.from("hello"), backPriv, crypto.sign("sha256", Buffer.from("hello"), backPriv)));
show("raw public", () => pair.publicKey.export({ format: "raw-public" }));
show("raw private", () => pair.privateKey.export({ format: "raw-private" }));
show("raw seed", () => pair.privateKey.export({ format: "raw-seed" }));

const message = Buffer.from("hello");
for (const digest of ["sha1", "sha256", "sha512"]) {
  const signature = crypto.sign(digest, message, pair.privateKey);
  show(digest, () => [signature.length >= 40 && signature.length <= 50,
    crypto.verify(digest, message, pair.publicKey, signature),
    crypto.verify(digest, Buffer.from("other"), pair.publicKey, signature)]);
  const raw = crypto.sign(digest, message, { key: pair.privateKey, dsaEncoding: "ieee-p1363" });
  show(digest + " p1363", () => [raw.length,
    crypto.verify(digest, message, { key: pair.publicKey, dsaEncoding: "ieee-p1363" }, raw)]);
}

show("no options", () => crypto.generateKeyPairSync("dsa"));
show("bad divisor", () => crypto.generateKeyPairSync("dsa", { modulusLength: 1024, divisorLength: 300 }));
show("short modulus", () => crypto.generateKeyPairSync("dsa", { modulusLength: 512 }));
show("string modulus", () => crypto.generateKeyPairSync("dsa", { modulusLength: "1024" }));
show("negative divisor", () => crypto.generateKeyPairSync("dsa", { modulusLength: 1024, divisorLength: -1 }));
