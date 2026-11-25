// An untyped options value leaves an overloaded call's resolved overload a
// guess, so the checker types every member of its result from that overload:
// `generateKeyPairSync("rsa-pss", options)` resolves to the PEM overload, and
// `.publicKey` is its `string` although the call answers the KeyObject pair.
// The reads keep the value the call answered, inline and through a binding,
// and the same members still read the encoded strings the PEM overload names.
const crypto = require("crypto");

const report = (label, options) => {
  const pair = crypto.generateKeyPairSync("rsa-pss", { modulusLength: 512, ...options });
  const pub = pair.publicKey;
  const details = pub.asymmetricKeyDetails;
  console.log(
    label,
    "kinds",
    typeof pair.publicKey,
    typeof pub,
    typeof pair.privateKey,
    typeof details,
  );
  console.log(
    label,
    "key",
    pub.type,
    pub.asymmetricKeyType,
    details === undefined ? "no details" : details.modulusLength,
  );
  console.log(
    label,
    "text",
    typeof pub === "string" ? pub.split("\n")[0] : "KeyObject",
  );
  console.log(
    label,
    "inline",
    typeof pair.publicKey.asymmetricKeyDetails,
    pair.publicKey.asymmetricKeyDetails === undefined ? "no details" : "details",
  );
};

report("keyobjects", { hashAlgorithm: "sha256" });
report("pem", {
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
