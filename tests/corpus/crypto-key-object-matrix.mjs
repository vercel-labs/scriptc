import * as crypto from "node:crypto";
// The KeyObject surface: createPrivateKey, createPublicKey, generateKeyPair and
// generateKeyPairSync across the key types and formats Node 24 accepts, with
// the export/import round trips, encrypted PEM, JWK, raw encodings, key-source
// shapes and the option errors.
const out = [];
const show = (label, f) => {
  try {
    const v = f();
    out.push(
      label + " OK " +
        (typeof v === "string" ? v : JSON.stringify(v, (k, x) => (typeof x === "bigint" ? x.toString() : x))),
    );
  } catch (e) {
    out.push(label + " THROW " + e.name + " " + (e.code ?? "-") + " " + String(e.message).split("\n")[0].slice(0, 100));
  }
};
const types = [
  ["rsa", { modulusLength: 1024 }],
  ["rsa-pss", { modulusLength: 1024, hashAlgorithm: "sha256" }],
  ["ec", { namedCurve: "prime256v1" }],
  ["ec", { namedCurve: "secp384r1" }],
  ["ed25519", {}],
  ["x25519", {}],
  ["x448", {}],
];
for (const [type, opts] of types) {
  const label = type + (opts.namedCurve ? ":" + opts.namedCurve : "");
  let pair;
  show("gen " + label, () => {
    pair = crypto.generateKeyPairSync(type, opts);
    return [
      pair.privateKey.asymmetricKeyType,
      pair.publicKey.asymmetricKeyType,
      JSON.stringify(pair.publicKey.asymmetricKeyDetails ?? {}, (k, x) => (typeof x === "bigint" ? x.toString() : x)),
    ];
  });
  if (!pair) continue;
  const priv = pair.privateKey, pub = pair.publicKey;
  for (const [fmt, enc] of [
    ["der", "pkcs8"], ["der", "sec1"], ["der", "pkcs1"],
  ]) {
    show(label + " priv export " + fmt + "/" + enc, () => { const d = priv.export({ format: fmt, type: enc }); return [d.length > 0, crypto.createPrivateKey({ key: d, format: fmt, type: enc }).asymmetricKeyType]; });
  }
  for (const [fmt, enc] of [["der", "spki"]]) {
    show(label + " pub export " + fmt + "/" + enc, () => { const d = pub.export({ format: fmt, type: enc }); return [d.length > 0, crypto.createPublicKey({ key: d, format: fmt, type: enc }).asymmetricKeyType]; });
  }
  show(label + " pub from priv", () => crypto.createPublicKey(priv).equals(pub));
  show(label + " jwk priv", () => { const j = priv.export({ format: "jwk" }); return [Object.keys(j).sort().join(","), crypto.createPrivateKey({ key: j, format: "jwk" }).asymmetricKeyType]; });
  show(label + " jwk pub", () => { const j = pub.export({ format: "jwk" }); return [Object.keys(j).sort().join(","), crypto.createPublicKey({ key: j, format: "jwk" }).asymmetricKeyType]; });
  show(label + " pem priv pkcs8", () => { const p = priv.export({ format: "pem", type: "pkcs8" }); return [p.split("\n")[0], crypto.createPrivateKey({ key: p, format: "pem", type: "pkcs8" }).asymmetricKeyType]; });
  show(label + " enc priv pkcs8", () => {
    const p = priv.export({ format: "pem", type: "pkcs8", cipher: "aes-256-cbc", passphrase: "pw" });
    const back = crypto.createPrivateKey({ key: p, format: "pem", type: "pkcs8", passphrase: "pw" });
    return [p.includes("ENCRYPTED"), back.asymmetricKeyType];
  });
  show(label + " enc priv sec1", () => {
    const p = priv.export({ format: "pem", type: "sec1", cipher: "aes-128-cbc", passphrase: "pw" });
    return [p.split("\n")[0], crypto.createPrivateKey({ key: p, format: "pem", type: "sec1", passphrase: "pw" }).asymmetricKeyType];
  });
  show(label + " raw pub", () => { const r = pub.export({ format: "raw-public" }); return [r.length, crypto.createPublicKey({ key: r, format: "raw-public", asymmetricKeyType: type }).asymmetricKeyType]; });
}

const t = (label, f) => { try { const v = f(); out.push(label + " OK " + (typeof v === "string" ? v : JSON.stringify(v))); } catch (e) { out.push(label + " THROW " + e.name + " " + (e.code ?? "-") + " " + String(e.message).split("\n")[0].slice(0, 110)); } };
const rsa = crypto.generateKeyPairSync("rsa", { modulusLength: 1024 });
const ec = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const ed = crypto.generateKeyPairSync("ed25519");
const rsaDer = rsa.privateKey.export({ format: "der", type: "pkcs8" });
const rsaPem = rsa.privateKey.export({ format: "pem", type: "pkcs8" });
t("createPrivateKey pem string no format", () => crypto.createPrivateKey(rsaPem).asymmetricKeyType);
t("createPrivateKey der buffer no format", () => crypto.createPrivateKey(rsaDer).asymmetricKeyType);
t("createPrivateKey der buffer with format", () => crypto.createPrivateKey({ key: rsaDer, format: "der", type: "pkcs8" }).asymmetricKeyType);
t("createPrivateKey pkcs1 from pkcs8 type", () => crypto.createPrivateKey({ key: rsaDer, format: "der", type: "pkcs1" }).asymmetricKeyType);
t("createPrivateKey sec1 of rsa", () => crypto.createPrivateKey({ key: rsaDer, format: "der", type: "sec1" }).asymmetricKeyType);
t("createPrivateKey KeyObject", () => crypto.createPrivateKey(rsa.privateKey).asymmetricKeyType);
t("createPrivateKey secret key", () => crypto.createPrivateKey(crypto.createSecretKey(Buffer.alloc(16))).asymmetricKeyType);
t("createPublicKey private der", () => crypto.createPublicKey({ key: rsaDer, format: "der", type: "pkcs8" }).asymmetricKeyType);
t("createPublicKey sec1 ec", () => crypto.createPublicKey({ key: ec.privateKey.export({ format: "der", type: "sec1" }), format: "der", type: "sec1" }).asymmetricKeyType);
t("createPublicKey spki as private", () => crypto.createPrivateKey({ key: rsa.publicKey.export({ format: "der", type: "spki" }), format: "der", type: "spki" }).asymmetricKeyType);
t("encrypted no pass", () => { const p = rsa.privateKey.export({ format: "pem", type: "pkcs8", cipher: "aes-256-cbc", passphrase: "x" }); return crypto.createPrivateKey({ key: p, format: "pem", type: "pkcs8" }); });
t("encrypted wrong pass", () => { const p = rsa.privateKey.export({ format: "pem", type: "pkcs8", cipher: "aes-256-cbc", passphrase: "x" }); return crypto.createPrivateKey({ key: p, format: "pem", type: "pkcs8", passphrase: "y" }); });
t("encrypted der pkcs8", () => { const d = rsa.privateKey.export({ format: "der", type: "pkcs8", cipher: "aes-256-cbc", passphrase: "x" }); return crypto.createPrivateKey({ key: d, format: "der", type: "pkcs8", passphrase: "x" }).asymmetricKeyType; });
t("encrypted sec1 no pass", () => { const p = ec.privateKey.export({ format: "pem", type: "sec1", cipher: "aes-128-cbc", passphrase: "x" }); return crypto.createPrivateKey({ key: p, format: "pem", type: "sec1" }); });
t("encrypted sec1 wrong pass", () => { const p = ec.privateKey.export({ format: "pem", type: "sec1", cipher: "aes-128-cbc", passphrase: "x" }); return crypto.createPrivateKey({ key: p, format: "pem", type: "sec1", passphrase: "y" }); });
t("pkcs1 encrypted", () => { const p = rsa.privateKey.export({ format: "pem", type: "pkcs1", cipher: "aes-128-cbc", passphrase: "x" }); return crypto.createPrivateKey({ key: p, format: "pem", type: "pkcs1", passphrase: "x" }).asymmetricKeyType; });
t("jwk as private of public", () => crypto.createPrivateKey({ key: rsa.publicKey.export({ format: "jwk" }), format: "jwk" }));
t("jwk bad kty", () => crypto.createPrivateKey({ key: { kty: "XYZ" }, format: "jwk" }));
t("ed25519 pkcs8 wrong type", () => crypto.createPrivateKey({ key: ed.privateKey.export({ format: "der", type: "pkcs8" }), format: "der", type: "sec1" }));
t("generateKeyPairSync invalid type", () => crypto.generateKeyPairSync("nope"));
t("generateKeyPair callback", () => { let got = null; crypto.generateKeyPair("rsa", { modulusLength: 1024 }, (e, pub, priv) => { got = e === null ? [pub.asymmetricKeyType, priv.asymmetricKeyType] : e.code; }); return "async"; });
t("pem string without type", () => { const p = rsa.privateKey.export({ format: "pem", type: "pkcs1" }); return crypto.createPrivateKey({ key: p, format: "pem" }).asymmetricKeyType; });
console.log(out.join("\n"));
