// The KeyObject property getters across every key type: type,
// asymmetricKeyType, asymmetricKeyDetails (the fields each key carries, and
// the fresh ordinary object every read answers), and symmetricKeySize,
// which only a secret key has.
import { createPrivateKey, createSecretKey, generateKeyPairSync, type KeyObject } from "node:crypto";

/** asymmetricKeyDetails holds BigInts for the RSA fields; print them with
 * an `n` suffix so the output stays deterministic. */
function details(key: KeyObject): string {
  const value = key.asymmetricKeyDetails;
  if (value === undefined) return "undefined";
  return JSON.stringify(value, (_name, item: unknown) =>
    typeof item === "bigint" ? `${item}n` : item,
  );
}

function report(label: string, key: KeyObject): void {
  const first = key.asymmetricKeyDetails;
  const second = key.asymmetricKeyDetails;
  console.log(
    label,
    "|",
    key.type,
    "|",
    key.asymmetricKeyType ?? "-",
    "|",
    key.symmetricKeySize ?? "-",
    "|",
    details(key),
    "|",
    first === second,
    first !== undefined && Object.getPrototypeOf(first) === Object.prototype,
    first !== undefined && Object.isFrozen(first),
  );
}

const rsa = generateKeyPairSync("rsa", { modulusLength: 1024, publicExponent: 3 });
report("rsa private", rsa.privateKey);
report("rsa public", rsa.publicKey);

const pss = generateKeyPairSync("rsa-pss", {
  modulusLength: 1024,
  hashAlgorithm: "sha384",
  mgf1HashAlgorithm: "sha256",
  saltLength: 20,
});
report("rsa-pss private", pss.privateKey);
report("rsa-pss public", pss.publicKey);
report("rsa-pss default", generateKeyPairSync("rsa-pss", { modulusLength: 1024 }).privateKey);

report("ec p256", generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey);
report("ec p384 public", generateKeyPairSync("ec", { namedCurve: "P-384" }).publicKey);
report("ec p521", generateKeyPairSync("ec", { namedCurve: "P-521" }).privateKey);
report("ed25519", generateKeyPairSync("ed25519").privateKey);
report("ed25519 public", generateKeyPairSync("ed25519").publicKey);
report("x25519", generateKeyPairSync("x25519").privateKey);

for (const size of [0, 1, 16, 32, 64]) {
  report(`secret ${size}`, createSecretKey(Buffer.alloc(size)));
}

// A key's details survive export and reimport.
const exported = rsa.privateKey.export({ type: "pkcs8", format: "der" });
const reimportedKey = createPrivateKey({ key: exported, format: "der", type: "pkcs8" });
console.log("private details", details(rsa.privateKey));
console.log("reimported details", details(reimportedKey));
