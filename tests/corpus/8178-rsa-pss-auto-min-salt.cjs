// Verifying with RSA_PSS_SALTLEN_AUTO against an RSA-PSS key whose
// parameters set a minimum salt length still enforces that minimum, as in
// Node: a valid signature with a shorter salt does not verify. The keys use
// an MGF1 digest equal to the message digest and a different one. The
// stricter public key is the generated one with its minimum salt length
// raised from 16 to 32 in its DER.
const c = require("node:crypto");

const data = Buffer.from("restricted salt");

function raiseMinimumSalt(publicKey) {
  const der = publicKey.export({ format: "der", type: "spki" });
  const from = Buffer.from([0xa2, 0x03, 0x02, 0x01, 0x10]);
  const at = der.indexOf(from);
  if (at < 0) throw new Error("no saltLength field");
  der[at + 4] = 0x20;
  return c.createPublicKey({ key: der, format: "der", type: "spki" });
}

function attempt(label, fn) {
  try {
    console.log(label, fn());
  } catch (e) {
    console.log(label, "throws", e.code, e.message);
  }
}

for (const mgf1HashAlgorithm of ["sha256", "sha384"]) {
  const { privateKey, publicKey } = c.generateKeyPairSync("rsa-pss", {
    modulusLength: 1024,
    hashAlgorithm: "sha256",
    mgf1HashAlgorithm,
    saltLength: 16,
  });
  const strict = raiseMinimumSalt(publicKey);
  const { mgf1HashAlgorithm: mgf1, saltLength: minimum } = strict.asymmetricKeyDetails;
  console.log(mgf1HashAlgorithm, "strict key", mgf1, minimum);
  for (const saltLength of [16, 20, 32, 40]) {
    const signature = c.sign("sha256", data, { key: privateKey, saltLength });
    const label = `${mgf1HashAlgorithm} salt ${saltLength}`;
    attempt(`${label} auto, key minimum 16:`, () =>
      c.verify("sha256", data, { key: publicKey, saltLength: c.constants.RSA_PSS_SALTLEN_AUTO }, signature),
    );
    attempt(`${label} auto, key minimum 32:`, () =>
      c.verify("sha256", data, { key: strict, saltLength: c.constants.RSA_PSS_SALTLEN_AUTO }, signature),
    );
    attempt(`${label} default, key minimum 32:`, () => c.verify("sha256", data, strict, signature));
    attempt(`${label} digest length, key minimum 32:`, () =>
      c.verify("sha256", data, { key: strict, saltLength: c.constants.RSA_PSS_SALTLEN_DIGEST }, signature),
    );
    const v = c.createVerify("sha256");
    v.update(data);
    attempt(`${label} createVerify auto, key minimum 32:`, () =>
      v.verify({ key: strict, saltLength: c.constants.RSA_PSS_SALTLEN_AUTO }, signature),
    );
  }
}
