// createPrivateKey and createPublicKey across every source form: PEM
// strings and buffers, DER with each type, SEC1, JWK, a certificate's key,
// and KeyObjects of both kinds; the two functions' different rules for a
// KeyObject, and the argument and decoder errors. The literal "ed25519"
// appears because the program uses that key type.
"use strict";
const crypto = require("node:crypto");

const RSA = "-----BEGIN PRIVATE KEY-----\nMIICdQIBADANBgkqhkiG9w0BAQEFAASCAl8wggJbAgEAAoGBAJgQZH+E+Mi8xd6a\nnEj6H62j/kx79QohEvY3+zyil/428iSnYDDFSJvj2yyGtvNfdaqTMIzG+F5uEAB/\nj6l2LSoJ37EAGj/PZDo+9f2VfwAcEbqEo9doU2J4l2cySMrSeFhy7HGE7SomA8aq\no31fCNXhOwyrE1Mzs9CXFjlR+n2RAgMBAAECgYATFiunHeekOp2TfVCUkGCdiPII\nY560MMaShSBR0g7F59uo4iFevcSJXKZMBnS8Q4Ufbe4wHWFbaPE1Ps2ndZ/hb2Yv\nfYz/e3q/4CU3/ECcGZH9PvIRIYugFtYgmBffGamN3s6+QT+hVdsV+QKOVDj6ZAhH\nWUWswx4Ivk+tp0i8gQJBAMi3OS9rf7Pf5rnkbwNwEYw1Xyl17LZ3Qs0iv9PSFLYT\nRapLu+SMIwA8MJdgzXAo3kAeOyJmCIfjQ3LhCHQNr8kCQQDB8qndnRqXjq2uHTEp\niTnOeR5Em2XCNLR5p9WLov2EQXxVlgh4bGZksV8M9SeZgDh0Jztrw9J1NDRfwor2\nf5OJAkBwEiYi/SIL3Hvm1c7Km5ugrvhYnRiz9TlecwWrD0UzOOWQJcNe5IRykCkN\njSaIdrlKEdcw6Mngnhu+HDptGmtJAkBgXyki8q7FAmOw8dZ88jAkNbDhnGoK/09y\naABHe30Hm9ahXITm+c5DWJOHh8Xek4T5yojPOqW4EXG4551PcQMpAkA6a/7YzMor\nLqjY5jLcv8HP8gHsxzI575e2pgq8ItyQBQeNU7Vpo8QZfXXkl5NvawJwNCSToZus\nHVJSB0FQ+2sQ\n-----END PRIVATE KEY-----";
const EC = "-----BEGIN PRIVATE KEY-----\nMIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgL5gAUyQZh5WwLhP0\ndkv1awsEIQ/3NFthj3jqLaMqvhKhRANCAASxkSIlKwmr1TZFIKgibuW55timJPfe\ne707vOl742DFTo6pNk5/RllBUEZoTk4TzJviLBOihNcFjc4BMf/7DRV6\n-----END PRIVATE KEY-----\n";
const ECPUB = "-----BEGIN PUBLIC KEY-----\nMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEsZEiJSsJq9U2RSCoIm7luebYpiT3\n3nu9O7zpe+NgxU6OqTZOf0ZZQVBGaE5OE8yb4iwTooTXBY3OATH/+w0Veg==\n-----END PUBLIC KEY-----\n";
const ED = "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIF19f6yL7Ej7r4ExE/8x/6VqucgVByt6gQUp017gSw+l\n-----END PRIVATE KEY-----\n";
const EDPUB = "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAnpEUq9NV6VCbIbdcVfWX11LKOAQkhwxSyAs+sSQBq3M=\n-----END PUBLIC KEY-----\n";
const SEC1 = Buffer.from("MHcCAQEEIC+YAFMkGYeVsC4T9HZL9WsLBCEP9zRbYY946i2jKr4SoAoGCCqGSM49AwEHoUQDQgAEsZEiJSsJq9U2RSCoIm7luebYpiT33nu9O7zpe+NgxU6OqTZOf0ZZQVBGaE5OE8yb4iwTooTXBY3OATH/+w0Veg==", "base64");
const JWK = {"kty":"EC","x":"sZEiJSsJq9U2RSCoIm7luebYpiT33nu9O7zpe-NgxU4","y":"jqk2Tn9GWUFQRmhOThPMm-IsE6KE1wWNzgEx__sNFXo","crv":"P-256","d":"L5gAUyQZh5WwLhP0dkv1awsEIQ_3NFthj3jqLaMqvhI"};
const EDNAME = "ed25519";

function attempt(label, run) {
  try { console.log(label, "| ok", run()); }
  catch (e) { console.log(label, "| error", e.name, e.code ?? "-", e.library ?? "-", e.reason ?? "-", e.message); }
}

const der = (pem) => Buffer.from(pem.split("\n").filter((l) => !l.startsWith("-----")).join(""), "base64");
const rsaPkcs8 = der(RSA);
const ecPkcs8 = der(EC);
const ecSpki = der(ECPUB);
const edPkcs8 = der(ED);
const edSpki = der(EDPUB);

attempt("priv pem", () => crypto.createPrivateKey(RSA).asymmetricKeyType);
attempt("priv ec pem", () => crypto.createPrivateKey(EC).asymmetricKeyType);
attempt("priv ed pem", () => crypto.createPrivateKey(ED).asymmetricKeyType);
attempt("priv pem buffer", () => crypto.createPrivateKey(Buffer.from(RSA)).asymmetricKeyType);
attempt("priv key only", () => crypto.createPrivateKey({ key: EC }).asymmetricKeyType);
attempt("priv pem explicit", () => crypto.createPrivateKey({ key: EC, format: "pem" }).asymmetricKeyType);
attempt("priv der pkcs8", () => crypto.createPrivateKey({ key: ecPkcs8, format: "der", type: "pkcs8" }).equals(crypto.createPrivateKey(EC)));
attempt("priv der rsa pkcs8", () => crypto.createPrivateKey({ key: rsaPkcs8, format: "der", type: "pkcs8" }).asymmetricKeyType);
attempt("priv der sec1", () => crypto.createPrivateKey({ key: SEC1, format: "der", type: "sec1" }).equals(crypto.createPrivateKey(EC)));
attempt("priv jwk", () => crypto.createPrivateKey({ key: JWK, format: "jwk" }).equals(crypto.createPrivateKey(EC)));
attempt("priv keyobject", () => crypto.createPrivateKey(crypto.createPrivateKey(RSA)).asymmetricKeyType);
attempt("priv keyobject option", () => crypto.createPrivateKey({ key: crypto.createPrivateKey(ED) }).asymmetricKeyType);

attempt("pub from priv pem", () => crypto.createPublicKey(RSA).asymmetricKeyType);
attempt("pub from ec pem", () => crypto.createPublicKey(EC).equals(crypto.createPublicKey(ECPUB)));
attempt("pub from ed priv", () => crypto.createPublicKey(ED).equals(crypto.createPublicKey(EDPUB)));
attempt("pub pem spki", () => crypto.createPublicKey(ECPUB).asymmetricKeyType);
attempt("pub keyobject priv", () => crypto.createPublicKey(crypto.createPrivateKey(EC)).equals(crypto.createPublicKey(ECPUB)));
attempt("pub der spki", () => crypto.createPublicKey({ key: ecSpki, format: "der", type: "spki" }).equals(crypto.createPublicKey(ECPUB)));
attempt("pub der pkcs8 derive", () => crypto.createPublicKey({ key: ecPkcs8, format: "der", type: "pkcs8" }).equals(crypto.createPublicKey(ECPUB)));
attempt("pub der ed pkcs8", () => crypto.createPublicKey({ key: edPkcs8, format: "der", type: "pkcs8" }).equals(crypto.createPublicKey(EDPUB)));
attempt("pub der ed spki", () => crypto.createPublicKey({ key: edSpki, format: "der", type: "spki" }).equals(crypto.createPublicKey(EDPUB)));
attempt("pub jwk priv", () => crypto.createPublicKey({ key: JWK, format: "jwk" }).equals(crypto.createPublicKey(ECPUB)));
attempt("pub keyobject option", () => crypto.createPublicKey({ key: crypto.createPublicKey(EDPUB) }).asymmetricKeyType);

attempt("details rsa", () => JSON.stringify(crypto.createPrivateKey(RSA).asymmetricKeyDetails, (_, v) => (typeof v === "bigint" ? v.toString() : v)));
attempt("details ec", () => JSON.stringify(crypto.createPrivateKey(EC).asymmetricKeyDetails));
attempt("details ed", () => JSON.stringify(crypto.createPrivateKey(ED).asymmetricKeyDetails));
attempt("details pub rsa", () => JSON.stringify(crypto.createPublicKey(RSA).asymmetricKeyDetails, (_, v) => (typeof v === "bigint" ? v.toString() : v)));
attempt("asymmetricKeyType pub", () => crypto.createPublicKey(EDPUB).asymmetricKeyType);

attempt("priv null", () => crypto.createPrivateKey(null));
attempt("priv number", () => crypto.createPrivateKey(5));
attempt("priv object empty", () => crypto.createPrivateKey({}));
attempt("priv key number", () => crypto.createPrivateKey({ key: 5 }));
attempt("priv bad format", () => crypto.createPrivateKey({ key: EC, format: "bad" }));
attempt("priv der no type", () => crypto.createPrivateKey({ key: ecPkcs8, format: "der" }));
attempt("priv der spki type", () => crypto.createPrivateKey({ key: ecSpki, format: "der", type: "spki" }));
attempt("priv public pem", () => crypto.createPrivateKey(ECPUB));
attempt("priv garbage", () => crypto.createPrivateKey("not a key"));
attempt("priv garbage buffer", () => crypto.createPrivateKey(Buffer.from("not a key")));
attempt("pub public keyobject", () => crypto.createPublicKey(crypto.createPublicKey(ECPUB)).asymmetricKeyType);
attempt("pub null", () => crypto.createPublicKey(null));
attempt("pub object empty", () => crypto.createPublicKey({}));
attempt("pub der sec1", () => crypto.createPublicKey({ key: SEC1, format: "der", type: "sec1" }));
attempt("pub passphrase nonstr", () => crypto.createPrivateKey({ key: EC, passphrase: 5 }));
attempt("priv encoding", () => crypto.createPrivateKey({ key: ECPUB, encoding: "hex" }));

console.log("name", EDNAME, crypto.createPrivateKey(ED).asymmetricKeyType);
