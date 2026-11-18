// X448 KeyObjects: PKCS#8/SPKI DER and PEM import/export, OKP JWK round trips,
// @normalize-pid
// asymmetricKeyType/details, generation shapes, createPublicKey from a private key
// and KeyObject.equals, against fixed Node-generated material.
import { KeyObject, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync } from "node:crypto";
const out: string[] = [];
const log = (...a: unknown[]) => out.push(a.map(String).join(" | "));
const seed = Buffer.from("20257b522fc46815e853aa8918751545bfe563580d7a28d014c55305e56e29edac03f6725bbb8e395c620b12aca09342aafd113738828bc9", "hex");
const pub = Buffer.from("28e530001e37d4329470054a0bb560b2d76edacd6e25e40c429f03e87e90d07c687e88750720cbd9c958eeeebacc287cd0eeff24ebd775ed", "hex");
const pkcs8 = Buffer.concat([Buffer.from("3046020100300506032b656f043a0438", "hex"), seed]);
const spki = Buffer.concat([Buffer.from("3042300506032b656f033900", "hex"), pub]);
const priv = createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" });
const pubk = createPublicKey({ key: spki, format: "der", type: "spki" });
log("priv", priv.type, priv.asymmetricKeyType, JSON.stringify(priv.asymmetricKeyDetails));
log("pub", pubk.type, pubk.asymmetricKeyType, JSON.stringify(pubk.asymmetricKeyDetails));
log("spki", Buffer.from(pubk.export({ type: "spki", format: "der" })).toString("hex"));
log("pkcs8", Buffer.from(priv.export({ type: "pkcs8", format: "der" })).toString("hex"));
log("jwkpub", JSON.stringify(pubk.export({ format: "jwk" })));
log("jwkpriv", JSON.stringify(priv.export({ format: "jwk" })));
const fromJwk = createPublicKey({ key: pubk.export({ format: "jwk" }), format: "jwk" });
log("jwk roundtrip", Buffer.from(fromJwk.export({ type: "spki", format: "der" })).toString("hex"));
const gen = generateKeyPairSync("x448");
log("gen", gen.publicKey.asymmetricKeyType, gen.privateKey.asymmetricKeyType, JSON.stringify(gen.publicKey.asymmetricKeyDetails), gen.publicKey.export({ type: "spki", format: "der" }).length, gen.privateKey.export({ type: "pkcs8", format: "der" }).length);
log("equals", priv.equals(createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" })), priv.equals(pubk));
const seedB = Buffer.from("0cb72c8c774f1644cf8202184cbf5ae67518dfae7dbaa5e1895186e8ec27e34f88d3cbcb23fc753dfc6283fb7546c0ddaa0586e4fcc0f8a8", "hex");
const pubB = Buffer.from("4ba3b19d0a2acb9f8c0b9c8afb2543e12d582c4ef4dabffeefdde99345f0f725a8d22586ba20d9d538570f2b8ea4ce699f56fdcd50023b91", "hex");
const privB = createPrivateKey({ key: Buffer.concat([Buffer.from("3046020100300506032b656f043a0438", "hex"), seedB]), format: "der", type: "pkcs8" });
const pubBk = createPublicKey({ key: Buffer.concat([Buffer.from("3042300506032b656f033900", "hex"), pubB]), format: "der", type: "spki" });
log("dh", diffieHellman({ privateKey: priv, publicKey: pubBk }).toString("hex"));
log("dh other", diffieHellman({ privateKey: privB, publicKey: pubk }).toString("hex"));
const ck = priv.toCryptoKey("X448", true, ["deriveBits", "deriveKey"]);
log("toCryptoKey", ck.type, ck.extractable, ck.usages.join(","), JSON.stringify(ck.algorithm));
const back = KeyObject.from(ck);
log("from", back.type, back.asymmetricKeyType, back.export({ type: "pkcs8", format: "der" }).length);
const pubCk = pubk.toCryptoKey("X448", true, []);
log("pub toCryptoKey", pubCk.type, pubCk.usages.length);
for (const row of out) console.log(row);

{
const kp = generateKeyPairSync("x448");
const pemPub = kp.publicKey.export({ type: "spki", format: "pem" }) as string;
const pemPriv = kp.privateKey.export({ type: "pkcs8", format: "pem" }) as string;
const pubFromPriv = createPublicKey(kp.privateKey);
console.log("pubfrompriv", pubFromPriv.type, pubFromPriv.asymmetricKeyType, pubFromPriv.export({ type: "spki", format: "der" }).length);
const priv = createPrivateKey({ key: pemPriv, format: "pem", type: "pkcs8" });
console.log("pempriv", priv.type, priv.asymmetricKeyType, priv.export({ type: "pkcs8", format: "der" }).length);
const pub2 = createPublicKey({ key: pemPub, format: "pem", type: "spki" });
console.log("pempub", pub2.type, pub2.asymmetricKeyType, pub2.export({ type: "spki", format: "der" }).length);
const jwk = priv.export({ format: "jwk" }) as { d?: string };
const back = createPrivateKey({ key: { kty: "OKP", crv: "X448", d: jwk.d, x: (priv.export({ format: "jwk" }) as { x?: string }).x }, format: "jwk" });
console.log("jwkpriv", back.type, back.export({ type: "pkcs8", format: "der" }).length);
}
