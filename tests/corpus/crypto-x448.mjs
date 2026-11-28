// X448 KeyObjects: generation, the raw-public and raw-private KeyObject
// encodings, the raw encodings of generateKeyPairSync, DER and JWK round
// trips, the diffieHellman agreement from raw and DER keys, and the errors
// for raw-seed and for a raw key of the wrong type.
import * as crypto from "node:crypto";

const show = (label, f) => {
  try {
    const v = f();
    console.log(label, "OK", typeof v === "string" ? v : JSON.stringify(v));
  } catch (e) {
    console.log(label, "THROW", e.name, e.code, e.message);
  }
};

const pair = crypto.generateKeyPairSync("x448");
const rawPriv = pair.privateKey.export({ format: "raw-private" });
const rawPub = pair.publicKey.export({ format: "raw-public" });
show("lens", () => [rawPriv.length, rawPub.length,
  pair.privateKey.export({ format: "der", type: "pkcs8" }).length,
  pair.publicKey.export({ format: "der", type: "spki" }).length]);
show("types", () => [pair.privateKey.type, pair.privateKey.asymmetricKeyType,
  pair.publicKey.asymmetricKeyType]);

const fromRaw = crypto.createPrivateKey({ key: rawPriv, format: "raw-private", asymmetricKeyType: "x448" });
const pubFromRaw = crypto.createPublicKey({ key: rawPub, format: "raw-public", asymmetricKeyType: "x448" });
show("raw reimport", () => [fromRaw.asymmetricKeyType, pubFromRaw.asymmetricKeyType,
  Buffer.from(crypto.createPublicKey(fromRaw).export({ format: "raw-public" })).equals(rawPub),
  fromRaw.export({ format: "raw-private" }).equals(rawPriv)]);
show("der reimport", () => [
  crypto.createPrivateKey({ key: pair.privateKey.export({ format: "der", type: "pkcs8" }), format: "der", type: "pkcs8" }).asymmetricKeyType,
  crypto.createPublicKey({ key: pair.publicKey.export({ format: "der", type: "spki" }), format: "der", type: "spki" }).asymmetricKeyType]);
show("jwk", () => {
  const j = pair.privateKey.export({ format: "jwk" });
  return [Object.keys(j), crypto.createPrivateKey({ key: j, format: "jwk" }).asymmetricKeyType];
});
show("raw-seed export", () => pair.privateKey.export({ format: "raw-seed" }));
show("raw-seed import", () => crypto.createPrivateKey({ key: rawPriv, format: "raw-seed", asymmetricKeyType: "x448" }));
show("short raw", () => crypto.createPublicKey({ key: rawPub.subarray(1), format: "raw-public", asymmetricKeyType: "x448" }));
show("raw as private", () => crypto.createPrivateKey({ key: rawPub, format: "raw-public", asymmetricKeyType: "x448" }));
show("wrong type", () => crypto.createPublicKey({ key: rawPub, format: "raw-public", asymmetricKeyType: "x25519" }));

show("raw encodings", () => {
  const p = crypto.generateKeyPairSync("x448", {
    publicKeyEncoding: { format: "raw-public" },
    privateKeyEncoding: { format: "raw-private" },
  });
  const back = crypto.createPublicKey({ key: p.privateKey, format: "raw-private", asymmetricKeyType: "x448" });
  return [p.publicKey.length, p.privateKey.length,
    Buffer.from(back.export({ format: "raw-public" })).equals(p.publicKey)];
});
show("dh", () => {
  const other = crypto.generateKeyPairSync("x448");
  const a = crypto.diffieHellman({ privateKey: fromRaw, publicKey: other.publicKey });
  const b = crypto.diffieHellman({ privateKey: other.privateKey, publicKey: pubFromRaw });
  return [a.length, a.equals(b)];
});
show("dh raw", () => {
  const other = crypto.generateKeyPairSync("x448");
  return crypto.diffieHellman({
    privateKey: { key: rawPriv, format: "raw-private", asymmetricKeyType: "x448" },
    publicKey: other.publicKey,
  }).length;
});
