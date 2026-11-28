import * as crypto from "node:crypto";
// The KeyObject surface: createPrivateKey, createPublicKey, generateKeyPair and
// generateKeyPairSync across the key types and formats Node 24 accepts, with
// the export/import round trips, encrypted PEM, JWK, raw encodings, key-source
// shapes and the option errors.
// Fixed pre-encrypted keys: a wrong passphrase over a fixed ciphertext fails
// the padding every time, so the error it reports is deterministic.
const FIXED_ENCRYPTED_PKCS8 = `-----BEGIN ENCRYPTED PRIVATE KEY-----
MIIC5TBfBgkqhkiG9w0BBQ0wUjAxBgkqhkiG9w0BBQwwJAQQjX6uXTbSKXaRvhBA
sU+ZsgICCAAwDAYIKoZIhvcNAgkFADAdBglghkgBZQMEASoEEDwnW0hnJbC9dSxS
/svI3IoEggKAr6dEcI0l0sfiiLDmokhoTMuAk1Qm2YCCtBokqFvvB9syOINUj3tO
LQeD87CWDqOE0+CT7v5lt3BVg8SeZm3pneDZpIo2S3eovuGVT9Okn8FFXE8fURHT
AG50jcu92otc61s6P49dMjQzmyJ/2t0Lmcab0MVTeUCAmoEVZvcqOyrWGNACZnUg
GFk/H4UYOIbyUf9linxDk2j9BkDrW9A/myHwdDfdkeWhUd/E+x+e8x1FUmagwT1e
zoxKEbxT+Ugy0+E/8lzDCDcN93WjMmkM96AidY7AHBx4IHocr+YJvO5G009pd3nR
aY11qqe7sZMhKsOPrIipZTL/U2sIEJhnFp0c3DDcSRN9HjB8+RGTOm8Ymf4Z5d6l
VwnoerruVQvKIt+cgbpIXYZHomjN9belQYlaxyoE7yQHEYsNkeBW3RfMS67pKrlz
SLXCKRo25XV0LgFqIVqltul6q+mqyLYgFyrzebDWm6WGPoKTPe6Ono3r67dlJwa6
pIVelpSvO46gmRaqvIDWignkAPrG2gYQV7Ahvr8efgSZ2zbREEQr6aLeVNEF3KF+
PofDJjsv5GboH8JQhcF5KlUa+cSU/+Di4b5cpMVp4fNVD7zqQN6MOEof5jrnCDa6
+/LV9RwxHnQ5K8qj7lN01gIyeOGdqwIOo51VHo+D43rX3je/4CTzCQHg3u/F+G5A
b8Mguh6AhzbRqqX/EgrmQUSilZMQCwQ1egtZc+G2LJtDwJ+VpY2nB7IlJc8wmthL
sQ+j2yxWn+3LDN6VJiltcjWBMeqZuG/3orDvFCEJn/Rn8EgtgsvuW70tmrpVUMG1
TmgWJxBKdqhJJokZ3I+sVCKUPQ/ANqJLzg==
-----END ENCRYPTED PRIVATE KEY-----`;

const FIXED_ENCRYPTED_SEC1 = `-----BEGIN EC PRIVATE KEY-----
Proc-Type: 4,ENCRYPTED
DEK-Info: AES-128-CBC,1AF07BF18C97889152D50CA99BDF1778

oopdyUpr6y8FKhVIM9QuP4im08z1ezHD9u7gYuSZv2kZLU7JRkAGySiCGdrEef5+
L75/+DTI5NpFTQ3VQDTsO4aKvBxIX0ehKGkutEVq3WQBxA3+OE6UbmCJnq3DYd8C
3TeQhI+Plju6w0Qb6yvIX7fEF4U+Q0q7Ln9MMQDpE1U=
-----END EC PRIVATE KEY-----`;

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
t("fixed encrypted right pass", () => crypto.createPrivateKey({ key: FIXED_ENCRYPTED_PKCS8, format: "pem", type: "pkcs8", passphrase: "pw" }).asymmetricKeyType);
t("fixed encrypted wrong pass", () => crypto.createPrivateKey({ key: FIXED_ENCRYPTED_PKCS8, format: "pem", type: "pkcs8", passphrase: "nope" }));
t("encrypted der pkcs8", () => { const d = rsa.privateKey.export({ format: "der", type: "pkcs8", cipher: "aes-256-cbc", passphrase: "x" }); return crypto.createPrivateKey({ key: d, format: "der", type: "pkcs8", passphrase: "x" }).asymmetricKeyType; });
t("encrypted sec1 no pass", () => { const p = ec.privateKey.export({ format: "pem", type: "sec1", cipher: "aes-128-cbc", passphrase: "x" }); return crypto.createPrivateKey({ key: p, format: "pem", type: "sec1" }); });
t("fixed sec1 right pass", () => crypto.createPrivateKey({ key: FIXED_ENCRYPTED_SEC1, format: "pem", type: "sec1", passphrase: "pw" }).asymmetricKeyType);
t("fixed sec1 wrong pass", () => crypto.createPrivateKey({ key: FIXED_ENCRYPTED_SEC1, format: "pem", type: "sec1", passphrase: "nope" }));
t("pkcs1 encrypted", () => { const p = rsa.privateKey.export({ format: "pem", type: "pkcs1", cipher: "aes-128-cbc", passphrase: "x" }); return crypto.createPrivateKey({ key: p, format: "pem", type: "pkcs1", passphrase: "x" }).asymmetricKeyType; });
t("jwk as private of public", () => crypto.createPrivateKey({ key: rsa.publicKey.export({ format: "jwk" }), format: "jwk" }));
t("jwk bad kty", () => crypto.createPrivateKey({ key: { kty: "XYZ" }, format: "jwk" }));
t("ed25519 pkcs8 wrong type", () => crypto.createPrivateKey({ key: ed.privateKey.export({ format: "der", type: "pkcs8" }), format: "der", type: "sec1" }));
t("generateKeyPairSync invalid type", () => crypto.generateKeyPairSync("nope"));
t("generateKeyPair callback", () => { let got = null; crypto.generateKeyPair("rsa", { modulusLength: 1024 }, (e, pub, priv) => { got = e === null ? [pub.asymmetricKeyType, priv.asymmetricKeyType] : e.code; }); return "async"; });
t("pem string without type", () => { const p = rsa.privateKey.export({ format: "pem", type: "pkcs1" }); return crypto.createPrivateKey({ key: p, format: "pem" }).asymmetricKeyType; });
console.log(out.join("\n"));
