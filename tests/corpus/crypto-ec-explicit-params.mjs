// crypto.generateKeyPairSync('ec', { paramEncoding: 'explicit' }): the
// explicit ECParameters of every supported curve in the exported
// SubjectPublicKeyInfo, PKCS#8 and SEC1 encodings, their re-import into
// ordinary EC KeyObjects, a fixed Node-generated explicit key read here,
// and Node's option errors for the value.
import * as crypto from "node:crypto";

const show = (label, f) => {
  try {
    const v = f();
    console.log(label, typeof v === "string" ? v : JSON.stringify(v));
  } catch (e) {
    console.log(label, "THROW", e.name, e.code, e.message);
  }
};

const pair = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1", paramEncoding: "explicit" });
const named = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
show("types", () => [pair.privateKey.type, pair.publicKey.asymmetricKeyType,
  JSON.stringify(pair.publicKey.asymmetricKeyDetails)]);
const spki = pair.publicKey.export({ format: "der", type: "spki" });
const pkcs8 = pair.privateKey.export({ format: "der", type: "pkcs8" });
const sec1 = pair.privateKey.export({ format: "der", type: "sec1" });
const namedSpki = named.publicKey.export({ format: "der", type: "spki" });
const namedPkcs8 = named.privateKey.export({ format: "der", type: "pkcs8" });
console.log("sizes", spki.length - namedSpki.length, pkcs8.length - namedPkcs8.length,
  sec1.length > spki.length, namedSpki.length, namedPkcs8.length);
console.log("sec1 label", pair.privateKey.export({ format: "pem", type: "sec1" }).split("\n")[0]);

const backPub = crypto.createPublicKey({ key: spki, format: "der", type: "spki" });
const backPriv = crypto.createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" });
show("reimport", () => [backPub.asymmetricKeyType, backPriv.asymmetricKeyType,
  JSON.stringify(backPub.asymmetricKeyDetails)]);
show("equals", () => [backPriv.equals(pair.privateKey), backPub.equals(pair.publicKey)]);
show("public of private", () => crypto.createPublicKey(pair.privateKey).equals(pair.publicKey));
show("reexport", () => [backPub.export({ format: "der", type: "spki" }).length,
  backPriv.export({ format: "der", type: "pkcs8" }).length,
  backPriv.export({ format: "der", type: "sec1" }).length]);
show("jwk", () => Object.keys(backPub.export({ format: "jwk" })));
show("raw", () => [Buffer.from(backPub.export({ format: "raw-public" })).length,
  Buffer.from(backPriv.export({ format: "raw-private" })).length]);
show("sec1 import", () => [
  crypto.createPrivateKey({ key: sec1, format: "der", type: "sec1" }).asymmetricKeyType,
  crypto.createPublicKey({ key: sec1, format: "der", type: "sec1" }).asymmetricKeyType]);

const message = Buffer.from("hello");
const signature = crypto.sign("sha256", message, pair.privateKey);
show("verify", () => [crypto.verify("sha256", message, pair.publicKey, signature),
  crypto.verify("sha256", message, backPub, signature),
  crypto.verify("sha256", message, backPriv, signature)]);

const curves = ["prime192v1", "secp224r1", "prime256v1", "secp384r1", "secp521r1", "secp192k1",
  "secp224k1", "secp256k1", "brainpoolP256r1", "brainpoolP384r1", "brainpoolP512r1"];
for (const curve of curves) {
  show(curve, () => {
    const p = crypto.generateKeyPairSync("ec", { namedCurve: curve, paramEncoding: "explicit" });
    const explicit = p.publicKey.export({ format: "der", type: "spki" });
    const namedSpki = crypto.generateKeyPairSync("ec", { namedCurve: curve })
      .publicKey.export({ format: "der", type: "spki" });
    const back = crypto.createPublicKey({ key: explicit, format: "der", type: "spki" });
    return [explicit.length - namedSpki.length, back.asymmetricKeyDetails.namedCurve,
      back.export({ format: "der", type: "spki" }).length === explicit.length];
  });
}

// A fixed explicit P-256 key made by Node: the same bytes both lanes read.
const FIXED_SPKI = "3082014b3082010306072a8648ce3d02013081f7020101302c06072a8648ce3d0101022100ffffffff00000001000000000000000000000000ffffffffffffffffffffffff305b0420ffffffff00000001000000000000000000000000fffffffffffffffffffffffc04205ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604b031500c49d360886e704936a6678e1139d26b7819f7e900441046b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c2964fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5022100ffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc63255102010103420004903d2b8fdcf0ac8d99c9b5243e302fe0e5251011be41395108378f23f22b84e56a40d0aa07126322f9a6d2dcf2c0897ec920391b92cef54530f950fd9a11b046";
const FIXED_PKCS8 = "308201790201003082010306072a8648ce3d02013081f7020101302c06072a8648ce3d0101022100ffffffff00000001000000000000000000000000ffffffffffffffffffffffff305b0420ffffffff00000001000000000000000000000000fffffffffffffffffffffffc04205ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604b031500c49d360886e704936a6678e1139d26b7819f7e900441046b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c2964fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5022100ffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551020101046d306b0201010420f0318475c535a9fea4273517f559a07598f4aa2117ccb4e965670f77e94c4a7fa14403420004903d2b8fdcf0ac8d99c9b5243e302fe0e5251011be41395108378f23f22b84e56a40d0aa07126322f9a6d2dcf2c0897ec920391b92cef54530f950fd9a11b046";
const FIXED_SIG = "30440220159c8491c14e953f502b3ea38f73e878dbb136af203bfa37975a1e195a5b82ee022000827edb4823c21449b32bf43f6f89b0dc9d0a51c4c77bb682bc982330fc2055";
const fixedPub = crypto.createPublicKey({ key: Buffer.from(FIXED_SPKI, "hex"), format: "der", type: "spki" });
const fixedPriv = crypto.createPrivateKey({ key: Buffer.from(FIXED_PKCS8, "hex"), format: "der", type: "pkcs8" });
show("fixed", () => [fixedPub.asymmetricKeyType, JSON.stringify(fixedPub.asymmetricKeyDetails),
  crypto.verify("sha256", Buffer.from("hello world"), fixedPub, Buffer.from(FIXED_SIG, "hex")),
  crypto.createPublicKey(fixedPriv).equals(fixedPub)]);
show("fixed reexport", () => [fixedPub.export({ format: "der", type: "spki" }).length,
  fixedPriv.export({ format: "der", type: "pkcs8" }).length,
  fixedPriv.export({ format: "der", type: "sec1" }).length,
  fixedPub.export({ format: "jwk" }).crv]);

show("bogus", () => crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1", paramEncoding: "bogus" }));
show("named_curve", () => crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1", paramEncoding: "named_curve" }));
show("named", () => crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1", paramEncoding: "named" }).publicKey.asymmetricKeyType);
show("null", () => crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1", paramEncoding: null }).publicKey.asymmetricKeyType);
show("unknown", () => crypto.generateKeyPairSync("ec", { namedCurve: "nope", paramEncoding: "explicit" }));
show("ed25519", () => crypto.generateKeyPairSync("ed25519", { paramEncoding: "explicit" }).publicKey.asymmetricKeyType);
show("x25519", () => crypto.generateKeyPairSync("x25519", { paramEncoding: "explicit" }).publicKey.asymmetricKeyType);


// The same P-256 key encoded twice: once with the curve OID (named) and
// once with its explicit ECParameters. equals() compares the key, not the
// encoding, as Node's EVP_PKEY_eq does.
const NAMED_SPKI = Buffer.from("3059301306072a8648ce3d020106082a8648ce3d0301070342000411f58064e52c4bb236827becfd998c6fbe8e10bd58d780107cc3b6a3c3c48c7e632d6889ba6ce71afae39c793d668fc10f50c337196d1dfd3687e969d7de7087", "hex");
const NAMED_PKCS8 = Buffer.from("308187020100301306072a8648ce3d020106082a8648ce3d030107046d306b020101042073882961b7c063c4b9c12587b05f4d9067c6e9bc8094bde08eb087f852934d3ba1440342000411f58064e52c4bb236827becfd998c6fbe8e10bd58d780107cc3b6a3c3c48c7e632d6889ba6ce71afae39c793d668fc10f50c337196d1dfd3687e969d7de7087", "hex");
const EXPL_SPKI = Buffer.from("3082014b3082010306072a8648ce3d02013081f7020101302c06072a8648ce3d0101022100ffffffff00000001000000000000000000000000ffffffffffffffffffffffff305b0420ffffffff00000001000000000000000000000000fffffffffffffffffffffffc04205ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604b031500c49d360886e704936a6678e1139d26b7819f7e900441046b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c2964fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5022100ffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc6325510201010342000411f58064e52c4bb236827becfd998c6fbe8e10bd58d780107cc3b6a3c3c48c7e632d6889ba6ce71afae39c793d668fc10f50c337196d1dfd3687e969d7de7087", "hex");
const EXPL_PKCS8 = Buffer.from("308201790201003082010306072a8648ce3d02013081f7020101302c06072a8648ce3d0101022100ffffffff00000001000000000000000000000000ffffffffffffffffffffffff305b0420ffffffff00000001000000000000000000000000fffffffffffffffffffffffc04205ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604b031500c49d360886e704936a6678e1139d26b7819f7e900441046b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c2964fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5022100ffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551020101046d306b020101042073882961b7c063c4b9c12587b05f4d9067c6e9bc8094bde08eb087f852934d3ba1440342000411f58064e52c4bb236827becfd998c6fbe8e10bd58d780107cc3b6a3c3c48c7e632d6889ba6ce71afae39c793d668fc10f50c337196d1dfd3687e969d7de7087", "hex");
const namedPubKey = crypto.createPublicKey({ key: NAMED_SPKI, format: "der", type: "spki" });
const explPubKey = crypto.createPublicKey({ key: EXPL_SPKI, format: "der", type: "spki" });
const namedPrivKey = crypto.createPrivateKey({ key: NAMED_PKCS8, format: "der", type: "pkcs8" });
const explPrivKey = crypto.createPrivateKey({ key: EXPL_PKCS8, format: "der", type: "pkcs8" });
show("same key details", () => [JSON.stringify(namedPubKey.asymmetricKeyDetails),
  JSON.stringify(explPubKey.asymmetricKeyDetails)]);
show("equals across encodings", () => [namedPubKey.equals(explPubKey), explPubKey.equals(namedPubKey),
  namedPrivKey.equals(explPrivKey), explPrivKey.equals(namedPrivKey)]);
show("equals across halves", () => [namedPubKey.equals(explPrivKey), explPrivKey.equals(explPubKey)]);

// An explicit key decrypts after an encrypted export, in the SEC1 PEM form
// (whose decoder needs the explicit parameters) and in PKCS#8.
const encryptedSec1 = pair.privateKey.export({
  format: "pem", type: "sec1", cipher: "aes-256-cbc", passphrase: "secret",
});
show("encrypted sec1 label", () => Buffer.from(encryptedSec1).subarray(0, 27).toString("utf8"));
show("encrypted sec1 reimport", () => {
  const k = crypto.createPrivateKey({ key: encryptedSec1, format: "pem", passphrase: "secret" });
  return [k.asymmetricKeyType, JSON.stringify(k.asymmetricKeyDetails), k.equals(pair.privateKey)];
});
show("encrypted sec1 as public", () => crypto.createPublicKey({
  key: encryptedSec1, format: "pem", passphrase: "secret",
}).equals(pair.publicKey));
show("encrypted sec1 wrong pass", () => crypto.createPrivateKey({ key: encryptedSec1, format: "pem", passphrase: "nope" }));
show("encrypted sec1 no pass", () => crypto.createPrivateKey({ key: encryptedSec1, format: "pem" }));
const encryptedPkcs8 = pair.privateKey.export({
  format: "pem", type: "pkcs8", cipher: "aes-256-cbc", passphrase: "secret",
});
show("encrypted pkcs8 reimport", () => {
  const k = crypto.createPrivateKey({ key: encryptedPkcs8, format: "pem", passphrase: "secret" });
  return [k.asymmetricKeyType, JSON.stringify(k.asymmetricKeyDetails), k.equals(pair.privateKey)];
});
show("encrypted pkcs8 as public", () => crypto.createPublicKey({
  key: encryptedPkcs8, format: "pem", passphrase: "secret",
}).equals(pair.publicKey));
