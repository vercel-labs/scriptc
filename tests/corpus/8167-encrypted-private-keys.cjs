// Encrypted private keys: PKCS#8 as PBES2 and PKCS#1 and SEC1 as
// traditional PEM with the CBC and ECB ciphers, import with a passphrase,
// generateKeyPair with a cipher, and OpenSSL's errors for missing and
// wrong passphrases, unknown ciphers, and ciphers a form refuses.
"use strict";
const c = require("crypto");
const show = (e) =>
  `${e.name} ${e.code} ${e.message}${e.library ? ` [${e.library}: ${e.reason}]` : ""}${
    e.opensslErrorStack ? ` ${JSON.stringify(e.opensslErrorStack)}` : ""
  }`;
const tryIt = (label, fn) => {
  try {
    console.log(label, fn());
  } catch (e) {
    console.log(label, show(e));
  }
};
// The PEM label and headers, without the random IV.
const head = (pem) =>
  pem
    .split("\n")
    .filter((l) => l.startsWith("-----BEGIN") || l.includes(":"))
    .map((l) => l.replace(/,[0-9A-F]+$/, ""))
    .join(" | ");

const ec = c.generateKeyPairSync("ec", { namedCurve: "P-256" });
const rsa = c.generateKeyPairSync("rsa", { modulusLength: 1024 });
const same = (key, pair) => c.createPublicKey(key).equals(pair.publicKey);

for (const cipher of ["aes-128-cbc", "aes-192-cbc", "aes-256-cbc", "aes-128-ecb", "aes-256-ecb", "des-ede3-cbc", "aes256", "AES-128-CBC", "2.16.840.1.101.3.4.1.42"]) {
  for (const format of ["pem", "der"]) {
    tryIt(`pkcs8 ${format} ${cipher}`, () => {
      const out = ec.privateKey.export({ type: "pkcs8", format, cipher, passphrase: "top secret" });
      const key = c.createPrivateKey({ key: out, format, type: format === "der" ? "pkcs8" : undefined, passphrase: "top secret" });
      return `${format === "pem" ? head(out) : Buffer.isBuffer(out)} ${key.asymmetricKeyType} ${same(key, ec)}`;
    });
  }
}
for (const cipher of ["aes-128-cbc", "aes-256-cbc", "des-ede3-cbc", "des3"]) {
  tryIt(`sec1 ${cipher}`, () => {
    const out = ec.privateKey.export({ type: "sec1", format: "pem", cipher, passphrase: Buffer.from("pw") });
    return `${head(out)} ${same(c.createPrivateKey({ key: out, passphrase: "pw" }), ec)}`;
  });
  tryIt(`pkcs1 ${cipher}`, () => {
    const out = rsa.privateKey.export({ type: "pkcs1", format: "pem", cipher, passphrase: "pw" });
    return `${head(out)} ${same(c.createPrivateKey({ key: out, passphrase: Buffer.from("pw") }), rsa)}`;
  });
}
tryIt("empty passphrase", () => {
  const out = rsa.privateKey.export({ type: "pkcs8", format: "pem", cipher: "aes-128-cbc", passphrase: "" });
  return same(c.createPrivateKey({ key: out, passphrase: "" }), rsa);
});

// Reading encrypted keys.
const p8pem = ec.privateKey.export({ type: "pkcs8", format: "pem", cipher: "aes-256-cbc", passphrase: "pw" });
const p8der = ec.privateKey.export({ type: "pkcs8", format: "der", cipher: "aes-256-cbc", passphrase: "pw" });
const sec1 = String(ec.privateKey.export({ type: "sec1", format: "pem", cipher: "aes-128-cbc", passphrase: "pw" }));
tryIt("public from encrypted", () => c.createPublicKey({ key: p8pem, passphrase: "pw" }).equals(ec.publicKey));
tryIt("public from traditional", () => c.createPublicKey({ key: sec1, passphrase: "pw" }).type);
tryIt("pkcs8 pem no passphrase", () => c.createPrivateKey(p8pem));
tryIt("pkcs8 der no passphrase", () => c.createPrivateKey({ key: p8der, format: "der", type: "pkcs8" }));
tryIt("sec1 no passphrase", () => c.createPrivateKey(sec1));
tryIt("public no passphrase", () => c.createPublicKey(p8pem));
tryIt("pkcs8 pem wrong", () => c.createPrivateKey({ key: p8pem, passphrase: "nope" }));
tryIt("pkcs8 der wrong", () => c.createPrivateKey({ key: p8der, format: "der", type: "pkcs8", passphrase: "nope" }));
tryIt("sec1 wrong", () => c.createPrivateKey({ key: sec1, passphrase: "nope" }));
tryIt("passphrase type", () => c.createPrivateKey({ key: p8pem, passphrase: 5 }));
tryIt("dek unknown", () => c.createPrivateKey({ key: sec1.replace(/DEK-Info: AES-128-CBC/, "DEK-Info: NOPE-CBC"), passphrase: "pw" }));
tryIt("dek legacy", () =>
  c.createPrivateKey({ key: sec1.replace(/DEK-Info: AES-128-CBC,([0-9A-F]{16})[0-9A-F]+/, "DEK-Info: DES-CBC,$1"), passphrase: "pw" }),
);
tryIt("dek legacy no passphrase", () =>
  c.createPrivateKey(sec1.replace(/DEK-Info: AES-128-CBC,([0-9A-F]{16})[0-9A-F]+/, "DEK-Info: DES-CBC,$1")),
);

// Export options.
const opts = (extra) => ({ type: "pkcs8", format: "pem", ...extra });
tryIt("unknown cipher", () => ec.privateKey.export(opts({ cipher: "nope", passphrase: "x" })));
tryIt("cipher without passphrase", () => ec.privateKey.export(opts({ cipher: "aes-128-cbc" })));
tryIt("passphrase without cipher", () => ec.privateKey.export(opts({ passphrase: "x" })));
tryIt("cipher type", () => ec.privateKey.export(opts({ cipher: 5, passphrase: "x" })));
tryIt("sec1 der", () => ec.privateKey.export({ type: "sec1", format: "der", cipher: "aes-128-cbc", passphrase: "x" }));
tryIt("pkcs1 der", () => rsa.privateKey.export({ type: "pkcs1", format: "der", cipher: "aes-128-cbc", passphrase: "x" }));
// OpenSSL refuses these ciphers for PKCS#8, and the last ones for
// traditional PEM too (the P-256 key's PKCS#8 and SEC1 lengths are not
// multiples of 8, which key wrap needs).
for (const cipher of ["aes-128-gcm", "aes-256-ccm", "aes-128-ctr", "chacha20-poly1305", "aes-128-xts", "des-ede3-cfb", "2.16.840.1.101.3.4.1.6"])
  tryIt(`refused pkcs8 ${cipher}`, () => ec.privateKey.export(opts({ cipher, passphrase: "x" })).length > 0);
for (const cipher of ["aes-128-wrap", "id-aes256-wrap", "des-cbc", "rc4"]) {
  tryIt(`refused pkcs8 ${cipher}`, () => ec.privateKey.export(opts({ cipher, passphrase: "x" })).length > 0);
  tryIt(`refused sec1 ${cipher}`, () => ec.privateKey.export({ type: "sec1", format: "pem", cipher, passphrase: "x" }));
}
for (const cipher of ["aes-128-ecb", "aes-256-ecb", "des-ede3"])
  tryIt(`refused sec1 ${cipher}`, () => ec.privateKey.export({ type: "sec1", format: "pem", cipher, passphrase: "x" }));

// generateKeyPair with a cipher.
const encoding = (cipher, type = "pkcs8") => ({
  namedCurve: "P-256",
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type, format: "pem", cipher, passphrase: "gen" },
});
tryIt("keygen sync", () => {
  const { publicKey, privateKey } = c.generateKeyPairSync("ec", encoding("aes-256-cbc"));
  return `${head(privateKey)} ${c.createPublicKey({ key: privateKey, passphrase: "gen" }).equals(c.createPublicKey(publicKey))}`;
});
tryIt("keygen unknown", () => c.generateKeyPairSync("ec", encoding("nope")));
tryIt("keygen gcm", () => c.generateKeyPairSync("ec", encoding("aes-128-gcm")));
tryIt("keygen sec1 ecb", () => c.generateKeyPairSync("ec", encoding("aes-128-ecb", "sec1")));
// One job at a time: Node's jobs finish in either order.
c.generateKeyPair("ec", encoding("des-ede3-cbc", "sec1"), (err, publicKey, privateKey) => {
  console.log("keygen async", err, head(privateKey));
  console.log("keygen async key", c.createPublicKey({ key: privateKey, passphrase: "gen" }).equals(c.createPublicKey(publicKey)));
  c.generateKeyPair("ec", encoding("aes-128-ccm"), (err) => console.log("keygen async ccm", show(err)));
});
