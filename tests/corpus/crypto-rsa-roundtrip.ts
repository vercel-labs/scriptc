// The four RSA operations round-trip a fixed 1024-bit key through PEM
// strings, Buffers and KeyObjects: OAEP (default SHA-1, sha256, and sha384
// with a label), PKCS#1 v1.5 and no padding. A ciphertext is randomized,
// so only its length prints.
import * as crypto from "node:crypto";

const priv = `-----BEGIN PRIVATE KEY-----
MIICdQIBADANBgkqhkiG9w0BAQEFAASCAl8wggJbAgEAAoGBAJgQZH+E+Mi8xd6a
nEj6H62j/kx79QohEvY3+zyil/428iSnYDDFSJvj2yyGtvNfdaqTMIzG+F5uEAB/
j6l2LSoJ37EAGj/PZDo+9f2VfwAcEbqEo9doU2J4l2cySMrSeFhy7HGE7SomA8aq
o31fCNXhOwyrE1Mzs9CXFjlR+n2RAgMBAAECgYATFiunHeekOp2TfVCUkGCdiPII
Y560MMaShSBR0g7F59uo4iFevcSJXKZMBnS8Q4Ufbe4wHWFbaPE1Ps2ndZ/hb2Yv
fYz/e3q/4CU3/ECcGZH9PvIRIYugFtYgmBffGamN3s6+QT+hVdsV+QKOVDj6ZAhH
WUWswx4Ivk+tp0i8gQJBAMi3OS9rf7Pf5rnkbwNwEYw1Xyl17LZ3Qs0iv9PSFLYT
RapLu+SMIwA8MJdgzXAo3kAeOyJmCIfjQ3LhCHQNr8kCQQDB8qndnRqXjq2uHTEp
iTnOeR5Em2XCNLR5p9WLov2EQXxVlgh4bGZksV8M9SeZgDh0Jztrw9J1NDRfwor2
f5OJAkBwEiYi/SIL3Hvm1c7Km5ugrvhYnRiz9TlecwWrD0UzOOWQJcNe5IRykCkN
jSaIdrlKEdcw6Mngnhu+HDptGmtJAkBgXyki8q7FAmOw8dZ88jAkNbDhnGoK/09y
aABHe30Hm9ahXITm+c5DWJOHh8Xek4T5yojPOqW4EXG4551PcQMpAkA6a/7YzMor
LqjY5jLcv8HP8gHsxzI575e2pgq8ItyQBQeNU7Vpo8QZfXXkl5NvawJwNCSToZus
HVJSB0FQ+2sQ
-----END PRIVATE KEY-----`;

const pub = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQCYEGR/hPjIvMXempxI+h+to/5M
e/UKIRL2N/s8opf+NvIkp2AwxUib49sshrbzX3WqkzCMxvhebhAAf4+pdi0qCd+x
ABo/z2Q6PvX9lX8AHBG6hKPXaFNieJdnMkjK0nhYcuxxhO0qJgPGqqN9XwjV4TsM
qxNTM7PQlxY5Ufp9kQIDAQAB
-----END PUBLIC KEY-----`;

const message = Buffer.from("the quick brown fox jumps over the lazy dog");

const oaep = crypto.publicEncrypt(pub, message);
console.log("oaep", oaep.length, crypto.privateDecrypt(priv, oaep).toString());

const sha256 = crypto.publicEncrypt({ key: pub, oaepHash: "sha256" }, message);
console.log(
  "oaep sha256",
  sha256.length,
  crypto.privateDecrypt({ key: priv, oaepHash: "sha256" }, sha256).toString(),
);

// A 1024-bit modulus leaves OAEP with SHA-384 room for 30 message bytes.
const label = Buffer.from("context");
const tiny = Buffer.from("oaep label");
const sha384 = crypto.publicEncrypt({ key: pub, oaepHash: "sha384", oaepLabel: label }, tiny);
console.log(
  "oaep label",
  sha384.length,
  crypto
    .privateDecrypt({ key: priv, oaepHash: "sha384", oaepLabel: label }, sha384)
    .toString(),
);

const pkcs1 = crypto.publicEncrypt({ key: pub, padding: crypto.constants.RSA_PKCS1_PADDING }, message);
console.log(
  "pkcs1",
  pkcs1.length,
  crypto
    .privateDecrypt({ key: priv, padding: crypto.constants.RSA_PKCS1_PADDING }, pkcs1)
    .toString(),
);

// The signing pair: privateEncrypt pads type 1, publicDecrypt recovers it.
const signature = crypto.privateEncrypt(priv, Buffer.from("signed payload"));
console.log("privateEncrypt", signature.length, crypto.publicDecrypt(pub, signature).toString());

const raw = Buffer.alloc(128);
raw[0] = 1;
raw[127] = 42;
const block = crypto.publicEncrypt({ key: pub, padding: crypto.constants.RSA_NO_PADDING }, raw);
console.log(
  "no padding",
  block.length,
  crypto
    .privateDecrypt({ key: priv, padding: crypto.constants.RSA_NO_PADDING }, block)
    .equals(raw),
);

// KeyObjects, and a public KeyObject derived from the private one.
const privKey = crypto.createPrivateKey(priv);
const pubKey = crypto.createPublicKey(privKey);
console.log("key types", privKey.asymmetricKeyType, pubKey.asymmetricKeyType);
const objectCipher = crypto.publicEncrypt(pubKey, message);
console.log("keyobject", crypto.privateDecrypt(privKey, objectCipher).toString());
console.log(
  "options form",
  crypto
    .privateDecrypt({ key: privKey, oaepHash: "sha256" }, crypto.publicEncrypt({ key: pubKey, oaepHash: "sha256" }, message))
    .toString(),
);

// A Buffer holding PEM bytes is a key source like the string.
const pemBuffer = Buffer.from(pub);
console.log("pem buffer", crypto.privateDecrypt(priv, crypto.publicEncrypt(pemBuffer, message)).toString());
