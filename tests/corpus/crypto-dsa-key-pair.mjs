// crypto.generateKeyPairSync('dsa'): DSA KeyObjects from generated FIPS
// 186-4 parameters, their details, DER and PEM exports, the unsupported
// JWK, re-import and equality, the public half, DER and IEEE P1363
// signatures over several digests, and Node's option and parameter errors.
import * as crypto from "node:crypto";

const show = (label, f) => {
  try {
    const v = f();
    console.log(label, typeof v === "string" ? v : JSON.stringify(v));
  } catch (e) {
    console.log(label, "THROW", e.name, e.code, e.message);
  }
};

const pair = crypto.generateKeyPairSync("dsa", { modulusLength: 1024, divisorLength: 160 });
show("types", () => [pair.privateKey.type, pair.privateKey.asymmetricKeyType, pair.publicKey.type]);
show("details", () => JSON.stringify(pair.privateKey.asymmetricKeyDetails));
show("public details", () => JSON.stringify(pair.publicKey.asymmetricKeyDetails));
const pkcs8 = pair.privateKey.export({ format: "der", type: "pkcs8" });
const spki = pair.publicKey.export({ format: "der", type: "spki" });
console.log("der", spki.length >= 440 && spki.length <= 444, pkcs8.length >= 330 && pkcs8.length <= 340);
console.log("labels", pair.privateKey.export({ format: "pem", type: "pkcs8" }).split("\n")[0],
  pair.publicKey.export({ format: "pem", type: "spki" }).split("\n")[0]);
show("jwk", () => pair.publicKey.export({ format: "jwk" }));

const backPriv = crypto.createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" });
const backPub = crypto.createPublicKey({ key: spki, format: "der", type: "spki" });
show("reimport", () => [backPriv.asymmetricKeyType, backPub.asymmetricKeyType,
  JSON.stringify(backPub.asymmetricKeyDetails)]);
show("equals", () => [backPriv.equals(pair.privateKey), backPub.equals(pair.publicKey)]);
show("public of private", () => [crypto.createPublicKey(pair.privateKey).equals(pair.publicKey)]);
show("verify with imported private key",
  () => crypto.verify("sha256", Buffer.from("hello"), backPriv, crypto.sign("sha256", Buffer.from("hello"), backPriv)));
show("raw public", () => pair.publicKey.export({ format: "raw-public" }));
show("raw private", () => pair.privateKey.export({ format: "raw-private" }));
show("raw seed", () => pair.privateKey.export({ format: "raw-seed" }));

const message = Buffer.from("hello");
for (const digest of ["sha1", "sha256", "sha512"]) {
  const signature = crypto.sign(digest, message, pair.privateKey);
  show(digest, () => [signature.length >= 40 && signature.length <= 50,
    crypto.verify(digest, message, pair.publicKey, signature),
    crypto.verify(digest, Buffer.from("other"), pair.publicKey, signature)]);
  const raw = crypto.sign(digest, message, { key: pair.privateKey, dsaEncoding: "ieee-p1363" });
  show(digest + " p1363", () => [raw.length,
    crypto.verify(digest, message, { key: pair.publicKey, dsaEncoding: "ieee-p1363" }, raw)]);
}

show("no options", () => crypto.generateKeyPairSync("dsa"));
show("bad divisor", () => crypto.generateKeyPairSync("dsa", { modulusLength: 1024, divisorLength: 300 }));
show("short modulus", () => crypto.generateKeyPairSync("dsa", { modulusLength: 512 }));
show("string modulus", () => crypto.generateKeyPairSync("dsa", { modulusLength: "1024" }));
show("negative divisor", () => crypto.generateKeyPairSync("dsa", { modulusLength: 1024, divisorLength: -1 }));


// Padding: Node's decoder tolerates padded Dss-Parms, refuses a padded
// scalar or public value with the decoder's errors, and a padded signature
// component verifies false. The fixed key and signature are one Node made.
const FP = Buffer.from("d1eed29c118a64188d2813ffcb1bc458bc85e2b53a795399fcc27cc5a7585bf9293f6b92da9497c8e3fa362dd2fa6fb7cf65d16c1045eb7b8603fe91a78ebd97368afd80630bdbe37a6aedcf8e41ab1df33fd78ed8d718b2f48ab4bd7a3bfe1f0b1f90842df9f245e1c5d0223f8cd827b71c575429fca8d2d8688af9393d753f", "hex");
const FQ = Buffer.from("806acbec3859ec75d98f24ab3bf30855d0022ddd", "hex");
const FG = Buffer.from("6dc44ebbf0aec70cf50ff406370e2b3f8ac0f9a3f90deba4ed028a78ef31add5ae9e750f0a84dfa868c69c06129222938591c7dbd3368733dbe9160b02acfe52d3721f8499a157f1af32f67cf8bc829f7fe1c4348824db8375de357ba7171710f9c3f17572746e72974a5a630759a969e1139c2beb67af241ad15caa594d2478", "hex");
const FX = Buffer.from("76b31c7ea502397c1e4b36ca9d734011c03970d7", "hex");
const FY = Buffer.from("26548d5690f127b573172816cee25e8825adbc235360da08853a9e98c65d6c85a9f1d8f081cfb4909dc24c18bfeb273ce3c79ff3b4992aa5262d6debc211a5653b84495ce49a1fd684d7e09997a2d7e9310c882837be59b6a020625cfdb7a842a4e3632764367635010fa5bfef7b4621156800cc93d21466214598e0557cf50f", "hex");
const FR = Buffer.from("7a9e156eba095d3fcc9b7fb336a9049aacf0058d", "hex");
const FS = Buffer.from("37b522e02d141c2c27df244d2c474163bbc7033a", "hex");
const FSIG = "302c02147a9e156eba095d3fcc9b7fb336a9049aacf0058d021437b522e02d141c2c27df244d2c474163bbc7033a";
const fixedMsg = Buffer.from("hello world");
const derLen = (n) => n < 0x80 ? Buffer.from([n])
  : n < 0x100 ? Buffer.from([0x81, n]) : Buffer.from([0x82, (n >> 8) & 0xff, n & 0xff]);
const tlv = (tag, body) => Buffer.concat([Buffer.from([tag]), derLen(body.length), body]);
const dsaInt = (v, pad) => {
  let body = v[0] & 0x80 ? Buffer.concat([Buffer.from([0]), v]) : v;
  if (pad > 0) body = Buffer.concat([Buffer.alloc(pad), body]);
  return tlv(0x02, body);
};
const dsaSeq = (...xs) => tlv(0x30, Buffer.concat(xs));
const dsaOid = Buffer.from([0x2a, 0x86, 0x48, 0xce, 0x38, 0x04, 0x01]);
const dsaAlg = (pad) =>
  dsaSeq(tlv(0x06, dsaOid), dsaSeq(dsaInt(FP, pad), dsaInt(FQ, pad), dsaInt(FG, pad)));
const dsaPkcs8 = (padP, padX) =>
  dsaSeq(dsaInt(Buffer.from([0]), 0), dsaAlg(padP), tlv(0x04, dsaInt(FX, padX)));
const dsaSpki = (padY) =>
  dsaSeq(dsaAlg(0), tlv(0x03, Buffer.concat([Buffer.from([0]), dsaInt(FY, padY)])));
const dsaSig = (padR) => dsaSeq(dsaInt(FR, padR), dsaInt(FS, 0));

const fixedPriv = crypto.createPrivateKey({ key: dsaPkcs8(0, 0), format: "der", type: "pkcs8" });
show("fixed key", () => [JSON.stringify(fixedPriv.asymmetricKeyDetails),
  crypto.verify("sha256", fixedMsg, crypto.createPublicKey(fixedPriv), Buffer.from(FSIG, "hex"))]);
show("padded params", () => {
  const k = crypto.createPrivateKey({ key: dsaPkcs8(40, 0), format: "der", type: "pkcs8" });
  const msg = Buffer.from("padded");
  const sig = crypto.sign("sha256", msg, k);
  return [JSON.stringify(k.asymmetricKeyDetails),
    crypto.verify("sha256", msg, crypto.createPublicKey(k), sig)];
});
show("padded scalar", () => crypto.createPrivateKey({ key: dsaPkcs8(0, 1), format: "der", type: "pkcs8" }));
show("padded public value", () => crypto.createPublicKey({ key: dsaSpki(1), format: "der", type: "spki" }));
show("padded signature",
  () => crypto.verify("sha256", fixedMsg, crypto.createPublicKey(fixedPriv), dsaSig(1)));
