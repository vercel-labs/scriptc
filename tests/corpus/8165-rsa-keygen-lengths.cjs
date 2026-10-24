// RSA key generation within OpenSSL's limits: any modulus length from
// 512 bits (an odd length from 2048 bits yields one bit less, as
// OpenSSL's SP 800-56B generation does) and odd exponents up to 2^32 - 1.
"use strict";
const crypto = require("crypto");

const cases = [
  [512, 65537],
  [513, 65537],
  [1023, 3],
  [1024, 0x10001],
  [2049, 65537],
  [768, 4294967295],
  [520, 17],
];
for (const [modulusLength, publicExponent] of cases) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength, publicExponent });
  const details = privateKey.asymmetricKeyDetails;
  const data = Buffer.from("rsa key lengths");
  const signature = crypto.sign("sha256", data, privateKey);
  console.log(
    modulusLength,
    details.modulusLength,
    details.publicExponent,
    publicKey.asymmetricKeyDetails.modulusLength,
    signature.length,
    crypto.verify("sha256", data, publicKey, signature),
  );
}
for (const [modulusLength, publicExponent] of [[511, 65537], [1024, 1], [1024, 4], [1024, 0]]) {
  try {
    crypto.generateKeyPairSync("rsa", { modulusLength, publicExponent });
    console.log(modulusLength, publicExponent, "generated");
  } catch (error) {
    console.log(modulusLength, publicExponent, error.message);
  }
}
crypto.generateKeyPair("rsa", { modulusLength: 515, publicExponent: 3 }, (error, publicKey) => {
  console.log("async", error, publicKey.asymmetricKeyDetails.modulusLength);
});
