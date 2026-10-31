// RSA-PSS keys (id-RSASSA-PSS): generation with and without
// RSASSA-PSS-params, their details, SubjectPublicKeyInfo and PKCS#8 in
// OpenSSL's encoding, import of both, and the restrictions on signatures:
// PSS padding only, the key's digest and MGF1 digest, and at least its
// salt length. The deprecated hash and mgf1Hash options run in a child
// process, whose DEP0154 reports are printed with process ids normalized.
"use strict";
const { spawnSync } = require("child_process");
const c = require("crypto");
const fmt = (v) => JSON.stringify(v, (k, x) => (typeof x === "bigint" ? `${x}n` : x));
const tryIt = (label, fn) => {
  try {
    const r = fn();
    console.log(label, typeof r === "string" ? r.split("\n")[0] : Buffer.isBuffer(r) ? `buffer ${r.length > 0}` : fmt(r));
  } catch (e) {
    console.log(label, e.name, e.code, e.message);
  }
};
const algOf = (spki) => {
  // The AlgorithmIdentifier: the SEQUENCE after the outer header.
  const start = spki[1] & 0x80 ? 2 + (spki[1] & 0x7f) : 2;
  const len = spki[start + 1];
  return spki.subarray(start, start + 2 + len).toString("hex");
};
const report = (label, options) => tryIt(label, () => c.generateKeyPairSync("rsa-pss", { modulusLength: 512, ...options }).publicKey.asymmetricKeyDetails);

function main() {
  const cases = {
    none: {},
    sha256: { hashAlgorithm: "sha256" },
    full: { hashAlgorithm: "sha256", mgf1HashAlgorithm: "sha384", saltLength: 16 },
    sha1: { hashAlgorithm: "sha1" },
    salt: { saltLength: 10 },
    s512: { hashAlgorithm: "sha512", saltLength: 0 },
    mgf: { mgf1HashAlgorithm: "sha256" },
  };
  for (const [name, options] of Object.entries(cases)) {
    const { publicKey, privateKey } = c.generateKeyPairSync("rsa-pss", { modulusLength: ["full", "sha1", "salt", "mgf"].includes(name) ? 512 : 1024, ...options });
    const spki = publicKey.export({ format: "der", type: "spki" });
    const pkcs8 = privateKey.export({ format: "der", type: "pkcs8" });
    console.log(name, publicKey.asymmetricKeyType, fmt(publicKey.asymmetricKeyDetails), fmt(privateKey.asymmetricKeyDetails));
    console.log(name, "spki alg", algOf(spki), "pkcs8 alg", pkcs8.indexOf(Buffer.from(algOf(spki), "hex")) > 0);
    tryIt(`${name} pkcs1`, () => privateKey.export({ format: "pem", type: "pkcs1" }));
    tryIt(`${name} jwk`, () => publicKey.export({ format: "jwk" }));
    tryIt(`${name} pem`, () => privateKey.export({ format: "pem", type: "pkcs8" }));
    const reimported = c.createPublicKey(publicKey.export({ format: "pem", type: "spki" }));
    const fromPrivate = c.createPublicKey(privateKey.export({ format: "pem", type: "pkcs8" }));
    const privateAgain = c.createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" });
    console.log(name, reimported.equals(publicKey), fromPrivate.equals(publicKey), privateAgain.asymmetricKeyType);
    const data = Buffer.from("rsa-pss");
    const signature = c.sign(null, data, privateAgain);
    console.log(name, c.verify(null, data, publicKey, signature), c.verify(null, data, reimported, signature));
  }

  const data = Buffer.from("restricted");
  const { publicKey, privateKey } = c.generateKeyPairSync("rsa-pss", {
    modulusLength: 512,
    hashAlgorithm: "sha256",
    saltLength: 16,
  });
  tryIt("sign sha1", () => c.sign("sha1", data, privateKey));
  tryIt("sign pkcs1", () => c.sign("sha256", data, { key: privateKey, padding: c.constants.RSA_PKCS1_PADDING }));
  tryIt("sign salt 8", () => c.sign("sha256", data, { key: privateKey, saltLength: 8 }));
  tryIt("verify salt 8", () => c.verify("sha256", data, { key: publicKey, saltLength: 8 }, Buffer.alloc(64)));
  for (const saltLength of [16, 20, 30]) {
    const signature = c.sign("sha256", data, { key: privateKey, saltLength });
    console.log(
      saltLength,
      c.verify("sha256", data, publicKey, signature),
      c.verify("sha256", data, { key: publicKey, saltLength: c.constants.RSA_PSS_SALTLEN_AUTO }, signature),
    );
  }
  const signer = c.createSign("sha256").update(data);
  console.log("createVerify", c.createVerify("sha256").update(data).verify(publicKey, signer.sign(privateKey)));
  const free = c.generateKeyPairSync("rsa-pss", { modulusLength: 1024 });
  const freeSignature = c.sign("sha512", data, free.privateKey);
  console.log("free sha512", c.verify("sha512", data, free.publicKey, freeSignature));

  report("bad digest", { hashAlgorithm: "nope" });
  report("bad mgf1", { mgf1HashAlgorithm: "nope" });
  report("negative salt", { saltLength: -1 });
  report("upper", { hashAlgorithm: "SHA256" });
  report("alias", { hashAlgorithm: "RSA-SHA256" });
}

if (process.argv[2] === "deprecated") {
  report("hash", { hash: "sha256" });
  report("conflict", { hashAlgorithm: "sha256", hash: "sha1" });
  report("mgf1Hash", { hashAlgorithm: "sha256", mgf1Hash: "sha384" });
  report("hash type", { hash: 5 });
  // Node drops deprecations while noDeprecation is set when it reports
  // them, so the flag is set once the reports above are out.
  setTimeout(() => {
    process.noDeprecation = true;
    report("quiet", { hash: "sha512" });
    console.log("end of turn");
  });
} else {
  main();
  const child = spawnSync(process.execPath, [process.argv[1], "deprecated"], { encoding: "utf8" });
  console.log(`status: ${child.status}`);
  console.log(child.stdout);
  console.log(child.stderr.replace(/\(node:\d+\)/g, "(node:<pid>)"));
}
