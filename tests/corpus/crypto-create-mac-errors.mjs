// crypto.createMac()'s validation, in Node's order: the algorithm name, the
// options object, each extended option, the key, then the digest. Mac's
// update() and final() report their own argument and finalization errors.
import {
  createMac,
  createPrivateKey,
  createSecretKey,
  generateKeyPairSync,
} from "node:crypto";

const key = Buffer.from("secret-key");
const report = (label, fn) => {
  try {
    fn();
    console.log(label, "no error");
  } catch (error) {
    console.log(label, error.name, error.code, error.message);
  }
};

// The algorithm name: a non-string, an empty string, and an unknown name.
report("algorithm-type", () => createMac(123, key, { digest: "sha256" }));
report("algorithm-empty", () => createMac("", key, { digest: "sha256" }));
report("algorithm-unknown", () => createMac("no-such-mac", key, { digest: "sha256" }));

// The options object and its digest member.
report("options-type", () => createMac("hmac", key, "sha256"));
report("options-array", () => createMac("hmac", key, []));
// null is not an object for validateObject, while a Buffer or a Date is
// accepted as the options bag and carries no digest.
report("options-null", () => createMac("hmac", key, null));
report("options-buffer", () => createMac("hmac", key, Buffer.from("x")));
report("options-date", () => createMac("hmac", key, new Date(0)));
report("digest-type", () => createMac("hmac", key, { digest: 1 }));
report("digest-empty", () => createMac("hmac", key, { digest: "" }));
report("digest-required", () => createMac("hmac", key));

// An extended option that HMAC does not take, checked before the key.
report("cipher", () => createMac("hmac", key, { digest: "sha256", cipher: "aes-128-cbc" }));
report("iv", () => createMac("hmac", key, { digest: "sha256", iv: new Uint8Array(16) }));
report("customization", () => createMac("hmac", key, { digest: "sha256", customization: new Uint8Array(8) }));
report("salt", () => createMac("hmac", key, { digest: "sha256", salt: new Uint8Array(8) }));
report("outputLength", () => createMac("hmac", key, { digest: "sha256", outputLength: -1 }));

// The key: a string, a plain object, and an asymmetric KeyObject.
report("key-string", () => createMac("hmac", "secret-key", { digest: "sha256" }));
report("key-object", () => createMac("hmac", {}, { digest: "sha256" }));
const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
report("key-private", () => createMac("hmac", privateKey, { digest: "sha256" }));

// The digest name is looked up once the key is read.
report("digest-unknown", () => createMac("hmac", key, { digest: "no-such-digest" }));
report("digest-xof", () => createMac("hmac", key, { digest: "shake128" }));

// update(): an ArrayBuffer is not a view, and an unknown encoding is
// rejected before the data is read.
const mac = createMac("hmac", createSecretKey(key), { digest: "sha256" });
report("update-arraybuffer", () => mac.update(new Uint8Array([1, 2, 3]).buffer));
report("update-encoding", () => mac.update("00", " "));
report("update-encoding-type", () => mac.update("00", 1));

// final(): an unknown encoding is rejected as a value, a non-string as a type.
report("final-encoding", () => mac.final(" "));
report("final-encoding-type", () => mac.final(1));

// An empty outputEncoding is the default UTF-8 string.
const empty = createMac("hmac", createSecretKey(key), { digest: "sha256" });
empty.update("payload");
console.log("final-empty-encoding", typeof empty.final(""));

// A rejected outputEncoding leaves the MAC open, so the next final() answers.
const retry = createMac("hmac", createSecretKey(key), { digest: "sha256" });
retry.update("payload");
report("final-encoding-retry", () => retry.final(" "));
console.log("final-after-encoding-error", retry.final("hex"));

// Once finalized, both final() and update() report it.
report("final", () => mac.final("hex"));
report("final-again", () => mac.final("hex"));
report("update-after-final", () => mac.update("more"));
