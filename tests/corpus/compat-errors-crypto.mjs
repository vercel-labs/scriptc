// The crypto error codes of Node's errors chapter, and the properties an
// OpenSSL error carries: a key no decoder takes (library, reason and the
// error stack), a signature without a key, JWK members that do not make
// a key, cipher parameters, scrypt parameters, and digests. Each case
// prints the class, name, code and message.
import crypto from "node:crypto";

const kind = (e) => (e instanceof TypeError ? "TypeError" : e instanceof RangeError ? "RangeError" : e instanceof Error ? "Error" : typeof e);
const names = (e) => Object.getOwnPropertyNames(e).filter((name) => name !== "stack").join();
const show = (label, e) => console.log(label, [kind(e), e.name, e.code, e.message].join(" | "));
function shape(label, fn) {
  try {
    fn();
    console.log(label, "no throw");
  } catch (e) {
    show(label, e);
  }
}
// An OpenSSL error: its own properties and the stack of errors behind it.
function openssl(label, fn) {
  try {
    fn();
    console.log(label, "no throw");
  } catch (e) {
    show(label, e);
    console.log(names(e), "|", e.library, "|", e.reason, "|", JSON.stringify(e.opensslErrorStack));
  }
}
const pem = (label, body) => `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----`;

// Key material no decoder takes: the error's own properties and the whole
// stack. The body "AAAA" is three zero bytes, not a SEQUENCE, so each
// decoder that runs reports a wrong tag.
openssl("private text", () => crypto.createPrivateKey("not a key"));
openssl("private empty", () => crypto.createPrivateKey(""));
openssl("private pkcs8 armor", () => crypto.createPrivateKey(pem("PRIVATE KEY", "AAAA")));
openssl("private rsa armor", () => crypto.createPrivateKey(pem("RSA PRIVATE KEY", "AAAA")));
openssl("private ec armor", () => crypto.createPrivateKey(pem("EC PRIVATE KEY", "AAAA")));
openssl("public text", () => crypto.createPublicKey("not a key"));
openssl("public from private armor", () => crypto.createPublicKey(pem("PRIVATE KEY", "AAAA")));
openssl("sign text key", () => crypto.createSign("sha256").update("x").sign("not a key"));
openssl("verify text key", () => crypto.createVerify("sha256").update("x").verify("not a key", Buffer.alloc(8)));

// An armored private key whose body is not a key: the stack lists, per
// decoder that ran (one for PKCS#8, two for the RSA and EC labels), how
// the outer DER element failed. Each body is the base64 of a few bytes.
const bodies = [
  ["zeros", "AAAA"],
  ["integer", "AgEF"],
  ["octet string", "BAKquw=="],
  ["set", "MQA="],
  ["length past the end", "AgUB"],
  ["sequence past the end", "MAMCAQ=="],
  ["truncated key", "MIGHAgEAMBM="],
  ["length of 127 bytes", "+/+/"],
  ["length of 9 bytes", "MIkBAQEBAQEBAQEA"],
  ["length bytes missing", "MIIB"],
  ["tag only", "MA=="],
];
for (const [name, body] of bodies) {
  for (const label of ["PRIVATE KEY", "RSA PRIVATE KEY", "EC PRIVATE KEY"]) {
    const text = pem(label, body);
    for (const kind of ["private", "public"]) {
      try {
        if (kind === "private") crypto.createPrivateKey(text);
        else crypto.createPublicKey(text);
        console.log(name, label, kind, "no throw");
      } catch (e) {
        const stack = e.opensslErrorStack.map((entry) => entry.split("::")[1]).join(" < ");
        console.log(name, "|", label, "|", kind, "|", e.code, "|", e.reason, "|", stack);
      }
    }
  }
}

// A cipher's final block.
openssl("final block", () => {
  const decipher = crypto.createDecipheriv("aes-128-cbc", Buffer.alloc(16), Buffer.alloc(16));
  decipher.update(Buffer.alloc(15));
  decipher.final();
});

// A signature needs a key.
shape("sign no key", () => crypto.createSign("sha256").update("x").sign());
shape("sign null key", () => crypto.createSign("sha256").update("x").sign(null));
shape("one-shot sign no key", () => crypto.sign("sha256", Buffer.from("x"), undefined));

// JWK members that do not make a key of their type.
shape("jwk rsa", () => crypto.createPublicKey({ format: "jwk", key: { kty: "RSA" } }));
shape("jwk ec", () => crypto.createPublicKey({ format: "jwk", key: { kty: "EC", crv: "P-256", x: "AA", y: "AA" } }));
shape("jwk okp", () => crypto.createPublicKey({ format: "jwk", key: { kty: "OKP", crv: "Ed25519", x: "AA" } }));
shape("jwk curve", () => crypto.createPublicKey({ format: "jwk", key: { kty: "EC", crv: "nope", x: "AA", y: "AA" } }));

// Cipher, digest and key-derivation parameters.
shape("cipher name", () => crypto.createCipheriv("nope", Buffer.alloc(16), Buffer.alloc(16)));
shape("key length", () => crypto.createCipheriv("aes-128-cbc", Buffer.alloc(5), Buffer.alloc(16)));
shape("iv length", () => crypto.createCipheriv("aes-128-cbc", Buffer.alloc(16), Buffer.alloc(5)));
shape("digest name", () => crypto.createHash("nope"));
shape("hmac digest", () => crypto.createHmac("nope", "key"));
shape("scrypt N", () => crypto.scryptSync("password", "salt", 8, { N: 3 }));
shape("pbkdf2 digest", () => crypto.pbkdf2Sync("password", "salt", 1, 8, "nope"));
shape("hash finalized", () => {
  const hash = crypto.createHash("sha256");
  hash.digest();
  hash.update("x");
});
shape("random size", () => crypto.randomBytes(-1));
shape("timingSafeEqual lengths", () => crypto.timingSafeEqual(Buffer.alloc(1), Buffer.alloc(2)));
