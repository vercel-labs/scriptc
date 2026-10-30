// An untyped argument can match any overload of a call at run time. The
// result follows the overload the value selects, through bindings,
// destructuring and function returns.
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ecPair = (options) => crypto.generateKeyPairSync("ec", options);
const objects = ecPair({ namedCurve: "P-256" });
console.log(typeof objects.privateKey, objects.privateKey.type, objects.publicKey.asymmetricKeyType);
const pem = ecPair({
  namedCurve: "P-256",
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
console.log(typeof pem.privateKey, pem.publicKey.split("\n")[0]);

function privateKeyKind(options) {
  const pair = crypto.generateKeyPairSync("ec", options);
  return typeof pair.privateKey;
}
console.log(privateKeyKind({ namedCurve: "P-384" }));

function spread(options) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", {
    namedCurve: "P-256",
    ...options,
  });
  return [typeof privateKey, Buffer.isBuffer(publicKey)];
}
console.log(spread({}), spread({ publicKeyEncoding: { type: "spki", format: "der" } }));

const digest = (encoding) => crypto.createHash("sha256").update("x").digest(encoding);
console.log(typeof digest("hex"), Buffer.isBuffer(digest(undefined)), digest(undefined).length);
const hmac = (encoding) => crypto.createHmac("sha256", "k").update("v").digest(encoding);
console.log(hmac("base64"), Buffer.isBuffer(hmac()));
function digestLength(encoding) {
  let value = crypto.createHash("sha1").update("y").digest(encoding);
  return Buffer.isBuffer(value) ? `buffer ${value.length}` : `string ${value.length}`;
}
console.log(digestLength(undefined), digestLength("hex"));
async function digestLater(encoding) {
  return crypto.createHash("md5").update("z").digest(encoding);
}

const key = crypto.generateKeyPairSync("ed25519").publicKey;
const exported = (options) => key.export(options);
console.log(
  Buffer.isBuffer(exported({ format: "der", type: "spki" })),
  typeof exported({ format: "pem", type: "spki" }),
  exported({ format: "jwk" }).kty,
);

const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "overloads-")), "text.txt");
fs.writeFileSync(file, "hello");
const read = (options) => fs.readFileSync(file, options);
const text = read("utf8");
const bytes = read(undefined);
const latin1 = read({ encoding: "latin1" });
console.log(text, Buffer.isBuffer(bytes), bytes.length, latin1);
console.log(read("utf8"), read({ encoding: "hex" }));

/**
 * @overload
 * @param {string} value
 * @returns {string}
 */
/**
 * @overload
 * @param {number} value
 * @returns {number}
 */
/** @param {string | number} value */
function same(value) {
  return value;
}
const viaSame = (value) => same(value);
console.log(typeof viaSame("s"), typeof viaSame(3), viaSame(3) + 1);

(async () => {
  const later = await digestLater(undefined);
  console.log(Buffer.isBuffer(later), typeof (await digestLater("hex")));
  fs.rmSync(path.dirname(file), { recursive: true });
})();
