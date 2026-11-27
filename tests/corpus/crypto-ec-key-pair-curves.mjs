// node:crypto generates EC key pairs on the Koblitz and brainpool curves
// as well as the NIST ones: the details report the OpenSSL curve name, the
// DER encodings are the curve's sizes and re-import, a JWK export answers
// Node's unsupported-curve error (these curves have no JWK name), a JWK
// import is refused, and the keys sign and verify.
import * as crypto from "node:crypto";

const curves = [
  "secp192k1",
  "secp224k1",
  "secp256k1",
  "brainpoolP256r1",
  "brainpoolP384r1",
  "brainpoolP512r1",
];

for (const namedCurve of curves) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve });
  console.log(namedCurve, publicKey.asymmetricKeyType, JSON.stringify(publicKey.asymmetricKeyDetails),
    JSON.stringify(privateKey.asymmetricKeyDetails));
  const spki = publicKey.export({ format: "der", type: "spki" });
  const pkcs8 = privateKey.export({ format: "der", type: "pkcs8" });
  console.log(namedCurve, "der", spki.length, pkcs8.length);
  const again = crypto.createPublicKey({ key: spki, format: "der", type: "spki" });
  const back = crypto.createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" });
  console.log(namedCurve, "reimport", JSON.stringify(again.asymmetricKeyDetails),
    JSON.stringify(back.asymmetricKeyDetails), again.equals(publicKey), back.equals(privateKey));
  try {
    publicKey.export({ format: "jwk" });
    console.log(namedCurve, "jwk exported");
  } catch (e) {
    console.log(namedCurve, "jwk", e.name, e.code, e.message);
  }
  try {
    crypto.createPublicKey({ key: { kty: "EC", crv: namedCurve, x: "AQ", y: "AQ" }, format: "jwk" });
    console.log(namedCurve, "jwk import accepted");
  } catch (e) {
    console.log(namedCurve, "jwk import", e.name, e.code, e.message);
  }
  const message = Buffer.from("payload");
  const signature = crypto.sign("sha256", message, privateKey);
  console.log(namedCurve, "sign", crypto.verify("sha256", message, publicKey, signature),
    crypto.verify("sha256", Buffer.from("other"), publicKey, signature));
}
