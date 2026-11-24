// node:crypto elliptic-curve keys on prime192v1 and secp224r1: import,
// curve reports, signing, raw and DER exports, JWK imports by the OpenSSL
// name and the NIST alias, and the unsupported-curve JWK export error.
import { createECDH, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";

const log = (...a: unknown[]) => console.log(a.map(String).join(" | "));
const attempt = (label: string, run: () => unknown): void => {
  try { run(); log(label, "ok"); }
  catch (e) { const x = e as Error & { code?: string }; log(label, "|", x.name, x.code, "|", x.message); }
};
const b64url = (b: Buffer) => Buffer.from(b).toString("base64url");

const check = (name: string, pem: string, crv: string, alias: string, coord: number): void => {
  const priv = createPrivateKey(pem);
  const pub = createPublicKey(priv);
  const details = priv.asymmetricKeyDetails as { namedCurve?: string };
  log(name, priv.asymmetricKeyType, details.namedCurve, pub.asymmetricKeyType);
  log(name, "der", pub.export({ type: "spki", format: "der" }).length,
    priv.export({ type: "pkcs8", format: "der" }).length);
  const message = Buffer.from("payload");
  const signature = sign("sha256", message, priv);
  log(name, "sign", verify("sha256", message, pub, signature));
  const raw = pub.export({ format: "raw-public" } as never) as Buffer;
  log(name, "raw", Buffer.from(raw).length);
  const x = b64url(Buffer.from(raw).subarray(1, 1 + coord));
  const y = b64url(Buffer.from(raw).subarray(1 + coord));
  for (const label of [crv, alias]) {
    const imported = createPublicKey({ key: { kty: "EC", crv: label, x, y }, format: "jwk" } as never);
    const importedDetails = imported.asymmetricKeyDetails as { namedCurve?: string };
    log(name, "jwk", label, importedDetails.namedCurve);
  }
  attempt(name + " jwk export", () => pub.export({ format: "jwk" }));
};

for (const curve of ["prime192v1", "secp224r1"]) {
  attempt("generate " + curve, () => {
    const pair = generateKeyPairSync("ec", { namedCurve: curve });
    const details = pair.privateKey.asymmetricKeyDetails as { namedCurve?: string };
    log("generate " + curve, pair.privateKey.asymmetricKeyType, details.namedCurve);
  });
}

const p192 = `-----BEGIN PRIVATE KEY-----
MG8CAQAwEwYHKoZIzj0CAQYIKoZIzj0DAQEEVTBTAgEBBBiWe0Fb3erCalVl9GsN
/VdPJZozKZh/zuGhNAMyAASd0nwKxhbjzNdID0VEKRxxClwsGrZaV7MBeCWMuhbk
I5GmdpJ0qpbzk7R5erYhv+8=
-----END PRIVATE KEY-----\n`;
const p224 = `-----BEGIN PRIVATE KEY-----
MHgCAQAwEAYHKoZIzj0CAQYFK4EEACEEYTBfAgEBBBzUYRh4YkzwKkDkr1Ov4aTF
BMGY8Mnrip3xsCFuoTwDOgAEEm5ap3pi6BlKdJNcOyylMlCvqStU9OxERG2bSrWt
L/Zf5TzD+hg02nGc2cJJieFHt8xBxtQzzgs=
-----END PRIVATE KEY-----\n`;
check("p192", p192, "prime192v1", "P-192", 24);
check("p224", p224, "secp224r1", "P-224", 28);

const a = createECDH("prime192v1");
const b = createECDH("prime192v1");
const aPub = a.generateKeys();
const bPub = b.generateKeys();
log("ecdh", aPub.length, a.computeSecret(bPub).equals(b.computeSecret(aPub)));
