// Ed25519 KeyObjects in node:crypto: the RFC 8032 test 1 key through
// PKCS#8, SubjectPublicKeyInfo and JWK export and import, its deterministic
// signatures from crypto.sign and crypto.verify, generateKeyPairSync, the
// two-argument generateKeyPair callback, and Node's errors for digests,
// Sign objects and the RSA and EC key encodings.
import * as c from "node:crypto";
const t = (l, f) => { try { const v = f(); console.log(l, "=>", typeof v === "object" && v !== null && !Buffer.isBuffer(v) ? JSON.stringify(v) : Buffer.isBuffer(v) ? v.toString("hex") : String(v).slice(0, 200)); } catch (e) { console.log(l, "!!", e.name, e.code, e.message); } };
const seed = Buffer.from("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60", "hex");
const der = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]);
const k = c.createPrivateKey({ key: der, format: "der", type: "pkcs8" });
const p = c.createPublicKey(k);
t("type", () => [k.type, k.asymmetricKeyType, JSON.stringify(k.asymmetricKeyDetails), p.type].join());
t("pkcs8 pem", () => k.export({ type: "pkcs8", format: "pem" }));
t("spki pem", () => p.export({ type: "spki", format: "pem" }));
t("spki der", () => p.export({ type: "spki", format: "der" }));
t("jwk priv", () => k.export({ format: "jwk" }));
t("jwk pub", () => p.export({ format: "jwk" }));
t("sig empty", () => c.sign(null, Buffer.alloc(0), k));
t("sig abc", () => c.sign(undefined, Buffer.from("abc"), k));
t("verify", () => c.verify(null, Buffer.from("abc"), p, c.sign(null, Buffer.from("abc"), k)));
t("verify bad", () => c.verify(null, Buffer.from("abd"), p, c.sign(null, Buffer.from("abc"), k)));
t("sign sha256", () => c.sign("sha256", Buffer.from("abc"), k));
t("createSign", () => c.createSign("sha256").update("x").sign(k));
t("pkcs1 export", () => k.export({ type: "pkcs1", format: "pem" }));
t("sec1 export", () => k.export({ type: "sec1", format: "pem" }));
t("gen cb form", () => { c.generateKeyPair("ed25519", (e, pub, priv) => console.log("cb", e, pub.asymmetricKeyType, priv.type)); return "scheduled"; });
t("gen", () => { const g = c.generateKeyPairSync("ed25519"); return [g.publicKey.asymmetricKeyType, Object.keys(g).join()].join(); });
t("gen opts", () => { const g = c.generateKeyPairSync("ed25519", { publicKeyEncoding: { type: "spki", format: "der" } }); return g.publicKey.length; });
t("jwk import", () => c.createPrivateKey({ key: k.export({ format: "jwk" }), format: "jwk" }).equals(k));
t("jwk pub import", () => c.createPublicKey({ key: p.export({ format: "jwk" }), format: "jwk" }).equals(p));
t("dsaEncoding", () => c.sign(null, Buffer.from("x"), { key: k, dsaEncoding: "ieee-p1363" }).length);
t("verify short sig", () => c.verify(null, Buffer.from("x"), p, Buffer.alloc(10)));
t("pem parse", () => c.createPrivateKey(k.export({ type: "pkcs8", format: "pem" })).equals(k));
t("equals ec", () => k.equals(c.generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey));
