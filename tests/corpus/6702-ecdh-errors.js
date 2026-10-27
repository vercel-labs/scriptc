// createECDH and ECDH errors from JavaScript: curve argument types,
// OpenSSL names that are not curves, unknown names, key argument types,
// private keys outside [1, n), points that are not on the curve or not in
// a known form, format and encoding errors, keys used before they exist,
// and members ECDH does not have.
import crypto from "node:crypto";

// Values the declared overloads reject reach the calls through an
// untyped function, as they would from other untyped code.
const loose = (value) => value;

function attempt(label, run) {
  try {
    const result = run();
    console.log(label, "ok", Buffer.isBuffer(result) ? result.toString("hex") : JSON.stringify(result));
  } catch (e) {
    console.log(label, e.name, e.code, e.message);
  }
}

attempt("curve number", () => crypto.createECDH(loose(5)));
attempt("curve missing", () => crypto.createECDH(loose(undefined)));
attempt("curve object", () => crypto.createECDH(loose({})));
attempt("curve unknown", () => crypto.createECDH("bogus"));
attempt("curve case", () => crypto.createECDH("PRIME256V1"));
attempt("curve jwk name", () => crypto.createECDH("P-256"));
attempt("curve x25519", () => crypto.createECDH("x25519"));
attempt("short name X25519", () => crypto.createECDH("X25519"));
attempt("short name RSA", () => crypto.createECDH("RSA"));
attempt("short name SHA256", () => crypto.createECDH("SHA256"));
attempt("lower sha256", () => crypto.createECDH("sha256"));

const fresh = crypto.createECDH("prime256v1");
attempt("public before keys", () => fresh.getPublicKey());
attempt("private before keys", () => fresh.getPrivateKey());
attempt("secret before keys, invalid point", () => fresh.computeSecret(Buffer.alloc(65, 4)));

const peer = crypto.createECDH("prime256v1");
peer.setPrivateKey(Buffer.from([2]));
attempt("secret before keys, valid point", () => fresh.computeSecret(peer.getPublicKey()));

const ecdh = crypto.createECDH("prime256v1");
attempt("private zero", () => ecdh.setPrivateKey(Buffer.alloc(32)));
attempt("private empty", () => ecdh.setPrivateKey(Buffer.alloc(0)));
attempt(
  "private order",
  () => ecdh.setPrivateKey("ffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551", "hex"),
);
attempt("private number", () => ecdh.setPrivateKey(loose(5)));
attempt("private null", () => ecdh.setPrivateKey(loose(null)));
attempt("private encoding", () => ecdh.setPrivateKey("abc", loose("bogus")));
attempt("private one", () => ecdh.setPrivateKey(Buffer.from([1])) === ecdh);

attempt("format bogus", () => ecdh.getPublicKey("hex", loose("bogus")));
attempt("format number", () => ecdh.getPublicKey(null, loose(5)));
attempt("format object", () => ecdh.getPublicKey("hex", loose({})));
attempt("encoding bogus", () => ecdh.getPublicKey(loose("bogus")));
attempt("encoding number", () => ecdh.getPublicKey(loose(7)));
attempt("encoding true", () => ecdh.getPublicKey(loose(true)));
attempt("encoding object", () => ecdh.getPublicKey(loose({})));
attempt("encoding empty", () => ecdh.getPublicKey(loose("")).length);
attempt("encoding buffer", () => ecdh.getPublicKey(loose("buffer")).length);
attempt("encoding BUFFER", () => ecdh.getPublicKey(loose("BUFFER")));

attempt("secret number", () => ecdh.computeSecret(loose(5)));
attempt("secret empty", () => ecdh.computeSecret(Buffer.alloc(0)));
attempt("secret wrong length", () => ecdh.computeSecret(Buffer.alloc(34, 2)));
attempt("secret prefix 05", () => ecdh.computeSecret(Buffer.concat([Buffer.from([5]), peer.getPublicKey().subarray(1)])));
attempt("secret x >= p", () => ecdh.computeSecret(Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 0xff)])));
attempt("secret off curve", () => ecdh.computeSecret(Buffer.concat([Buffer.from([2]), Buffer.alloc(31), Buffer.from([1])])));
attempt("secret infinity", () => ecdh.computeSecret(Buffer.from([0])));
attempt("secret odd hex", () => ecdh.computeSecret("abc", "hex"));
attempt("secret input encoding", () => ecdh.computeSecret("abc", loose("bogus")));
attempt("secret input buffer", () => ecdh.computeSecret("abc", loose("buffer")));
attempt("secret input BUFFER", () => ecdh.computeSecret("abc", loose("BUFFER")));
attempt("secret output encoding", () => ecdh.computeSecret(peer.getPublicKey(), loose(null), loose("bogus")));
attempt("secret other curve", () => ecdh.computeSecret(crypto.createECDH("secp384r1").generateKeys()));
const hybrid = peer.getPublicKey(null, "hybrid");
hybrid[0] ^= 1;
attempt("secret hybrid parity", () => ecdh.computeSecret(hybrid));

attempt("convert curve number", () => crypto.ECDH.convertKey(peer.getPublicKey(), loose(5)));
attempt("convert key number", () => crypto.ECDH.convertKey(loose(5), "prime256v1"));
attempt("convert unknown curve", () => crypto.ECDH.convertKey(peer.getPublicKey(), "bogus"));
attempt("convert short name", () => crypto.ECDH.convertKey(peer.getPublicKey(), "X25519"));
attempt("convert bad point", () => crypto.ECDH.convertKey(Buffer.alloc(65, 4), "prime256v1"));
attempt("convert other curve", () => crypto.ECDH.convertKey(peer.getPublicKey(), "secp384r1"));
attempt("convert bad format", () => crypto.ECDH.convertKey(peer.getPublicKey(), "prime256v1", loose(null), loose(null), loose("zip")));
attempt("convert empty, bad curve", () => crypto.ECDH.convertKey("", "bogus", undefined, loose("bogus")));
attempt("convert empty, bad format", () => crypto.ECDH.convertKey("", "prime256v1", undefined, undefined, loose("zip")));
attempt("convert infinity extra byte", () => crypto.ECDH.convertKey(Buffer.from([0, 0]), "prime256v1"));
attempt("convert prefix 01", () => crypto.ECDH.convertKey(Buffer.from([1]), "prime256v1"));

// generateKeys creates the keys before it reads the format.
const later = crypto.createECDH("secp256k1");
attempt("generate bad format", () => later.generateKeys("hex", loose("bad")));
attempt("keys after bad format", () => later.getPrivateKey().length > 0);
attempt("missing method", () => later.foo());
