// crypto.createPrivateKey/createPublicKey over DH keys: the PKCS#8 private
// key and SubjectPublicKeyInfo public key this runtime exports, in PEM and
// DER, the public half derived from a private key, an encrypted PKCS#8
// private key, and Node's decoder errors for the wrong half and encoding.
import * as crypto from "node:crypto";

const failure = (error) => `${error.name}: ${error.message}`;
const pair = crypto.generateKeyPairSync("dh", { group: "modp5" });
const privatePem = String(pair.privateKey.export({ type: "pkcs8", format: "pem" }));
const publicPem = String(pair.publicKey.export({ type: "spki", format: "pem" }));
const privateDer = pair.privateKey.export({ type: "pkcs8", format: "der" });
const publicDer = pair.publicKey.export({ type: "spki", format: "der" });

const parsedPrivate = crypto.createPrivateKey(privatePem);
const parsedPublic = crypto.createPublicKey(publicPem);
console.log(
  "types",
  parsedPrivate.type,
  parsedPrivate.asymmetricKeyType,
  parsedPublic.type,
  parsedPublic.asymmetricKeyType,
);
console.log(
  "details",
  JSON.stringify(parsedPrivate.asymmetricKeyDetails),
  JSON.stringify(parsedPublic.asymmetricKeyDetails),
);
console.log("equals", parsedPrivate.equals(pair.privateKey), parsedPublic.equals(pair.publicKey), parsedPrivate.equals(parsedPublic));

const derPrivate = crypto.createPrivateKey({ key: privateDer, format: "der", type: "pkcs8" });
const derPublic = crypto.createPublicKey({ key: publicDer, format: "der", type: "spki" });
console.log("der", derPrivate.asymmetricKeyType, derPublic.asymmetricKeyType, derPrivate.equals(parsedPrivate));
console.log(
  "pkcs1 option",
  crypto.createPrivateKey({ key: privateDer, format: "der", type: "pkcs1" }).asymmetricKeyType,
);

const derived = crypto.createPublicKey(privatePem);
console.log("derived", derived.type, derived.asymmetricKeyType, derived.equals(pair.publicKey));

const encrypted = String(
  pair.privateKey.export({ type: "pkcs8", format: "pem", cipher: "aes-256-cbc", passphrase: "secret" }),
);
const decrypted = crypto.createPrivateKey({ key: encrypted, passphrase: "secret" });
console.log("encrypted", decrypted.asymmetricKeyType, decrypted.equals(pair.privateKey));

const attempt = (label, run) => {
  try {
    run();
    console.log(label, "resolved");
  } catch (error) {
    console.log(label, failure(error));
  }
};
attempt("private from public", () => crypto.createPrivateKey(publicPem));
attempt("pem from der", () => crypto.createPrivateKey({ key: privateDer, format: "pem" }));
attempt("wrong passphrase", () => crypto.createPrivateKey({ key: encrypted, passphrase: "nope" }));

// Non-minimal INTEGER encodings: OpenSSL rejects a padded private exponent
// and a padded public value, while it accepts padded parameters; this
// runtime trims parameters before sizing its arithmetic and rejects the
// private and public ones.
const derLength = (n) => {
  if (n < 128) return Buffer.from([n]);
  const bytes = [];
  let value = n;
  while (value > 0) {
    bytes.unshift(value & 0xff);
    value >>= 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
};
const tlv = (tag, content) => Buffer.concat([Buffer.from([tag]), derLength(content.length), content]);
const intMinimal = (bytes) => {
  let start = 0;
  while (start < bytes.length - 1 && bytes[start] === 0) start++;
  let value = bytes.subarray(start);
  if (value[0] & 0x80) value = Buffer.concat([Buffer.from([0]), value]);
  return tlv(0x02, value);
};
const intPadded = (bytes, extra) => {
  let start = 0;
  while (start < bytes.length - 1 && bytes[start] === 0) start++;
  return tlv(0x02, Buffer.concat([Buffer.alloc(extra), bytes.subarray(start)]));
};
const prime = Buffer.from(crypto.getDiffieHellman("modp5").getPrime());
const generator = Buffer.from([2]);
const smallX = Buffer.concat([Buffer.from([1]), Buffer.alloc(15, 7)]);
const paddedY = Buffer.concat([Buffer.from([1]), Buffer.alloc(191, 9)]);
const algorithm = (p, g) =>
  tlv(0x30, Buffer.concat([Buffer.from("06092a864886f70d010301", "hex"), tlv(0x30, Buffer.concat([p, g]))]));
const pkcs8 = (p, g, x) =>
  tlv(0x30, Buffer.concat([tlv(0x02, Buffer.from([0])), algorithm(p, g), tlv(0x04, x)]));
const spki = (p, g, y) =>
  tlv(0x30, Buffer.concat([algorithm(p, g), tlv(0x03, Buffer.concat([Buffer.from([0]), y]))]));
const pInt = intMinimal(prime);
const gInt = intMinimal(generator);
const minimalPrivate = crypto.createPrivateKey({
  key: pkcs8(pInt, gInt, intMinimal(smallX)),
  format: "der",
  type: "pkcs8",
});
console.log("minimal private", minimalPrivate.asymmetricKeyType);
console.log("lazy public", crypto.createPublicKey(minimalPrivate).type);
attempt("padded private", () =>
  crypto.createPrivateKey({ key: pkcs8(pInt, gInt, intPadded(smallX, 1)), format: "der", type: "pkcs8" }),
);
attempt("padded parameters", () =>
  crypto.createPrivateKey({
    key: pkcs8(intPadded(prime, 4), intPadded(generator, 2), intMinimal(smallX)),
    format: "der",
    type: "pkcs8",
  }),
);
attempt("padded public", () =>
  crypto.createPublicKey({ key: spki(pInt, gInt, intPadded(paddedY, 1)), format: "der", type: "spki" }),
);

// PKCS#3's optional privateValueLength: a value that fits an int imports,
// and one that does not — the q of X9.42 parameters, say — makes the whole
// key unreadable, which is what OpenSSL's decoder reports for both halves.
const algorithmWith = (p, g, extra) =>
  tlv(
    0x30,
    Buffer.concat([
      Buffer.from("06092a864886f70d010301", "hex"),
      tlv(0x30, Buffer.concat([p, g, ...extra])),
    ]),
  );
const lengthInt = (value) => {
  let hex = value.toString(16);
  if (hex.length % 2 === 1) hex = "0" + hex;
  return intMinimal(Buffer.from(hex, "hex"));
};
const pkcs8With = (p, g, extra, x) =>
  tlv(
    0x30,
    Buffer.concat([
      tlv(0x02, Buffer.from([0])),
      algorithmWith(p, g, extra),
      tlv(0x04, x),
    ]),
  );
const spkiWith = (p, g, extra, y) =>
  tlv(
    0x30,
    Buffer.concat([algorithmWith(p, g, extra), tlv(0x03, Buffer.concat([Buffer.from([0]), y]))]),
  );
const primeValue = BigInt("0x" + prime.toString("hex"));
const hugeLength = lengthInt((primeValue - 1n) / 2n);
const withLength = crypto.createPrivateKey({
  key: pkcs8With(pInt, gInt, [lengthInt(300n)], intMinimal(smallX)),
  format: "der",
  type: "pkcs8",
});
console.log("private length", withLength.asymmetricKeyType);
attempt("huge private length", () =>
  crypto.createPrivateKey({
    key: pkcs8With(pInt, gInt, [hugeLength], intMinimal(smallX)),
    format: "der",
    type: "pkcs8",
  }),
);
attempt("huge public length", () =>
  crypto.createPublicKey({
    key: spkiWith(pInt, gInt, [hugeLength], intMinimal(generator)),
    format: "der",
    type: "spki",
  }),
);
