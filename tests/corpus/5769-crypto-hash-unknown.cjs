// Hash and Hmac values passed through untyped JavaScript code: function
// parameters, object fields, arrays and Map values. update() answers the
// same value, digest() and copy() follow Node, and Hmac has no copy().
const crypto = require("node:crypto");

function code(run) {
  try {
    const value = run();
    return typeof value === "string" ? `ok ${value.slice(0, 16)}` : `ok ${typeof value}`;
  } catch (error) {
    return `${error.name} ${error.code || ""} ${error.message}`;
  }
}

function digestAll(items, encoding) {
  return items.map((item) => item.update("payload").digest(encoding));
}

console.log(digestAll([crypto.createHash("sha256"), crypto.createHmac("sha1", "k")], "hex"));

const box = { hash: crypto.createHash("md5"), mac: crypto.createHmac("sha256", Buffer.from("key")) };
box.hash.update("a").update("b");
console.log("field", box.hash.digest("hex"), box.mac.update("c").digest("base64url"));

const byName = new Map();
byName.set("sha512", crypto.createHash("sha512"));
byName.set("hmac", crypto.createHmac("md5", "x"));
for (const [name, value] of byName) {
  const same = value.update(name);
  console.log("map", name, same === value, value.digest("hex").slice(0, 20));
}

function copyTwice(h) {
  const a = h.copy();
  const b = h.copy();
  a.update("1");
  b.update("2");
  return [a.digest("hex").slice(0, 12), b.digest("hex").slice(0, 12), h.digest("hex").slice(0, 12)];
}
console.log("copies", copyTwice(crypto.createHash("sha256").update("base")));

function describe(value) {
  return [typeof value, String(value), Object.prototype.toString.call(value), value.notAMember];
}
console.log("hash", describe(crypto.createHash("sha256")));
console.log("hmac", describe(crypto.createHmac("sha256", "k")));
const plainMac = [crypto.createHmac("sha256", "k")][0];
console.log("hmac copy read", typeof plainMac.copy, plainMac.copy === undefined);

const mac = crypto.createHmac("sha256", "k");
const viaObject = { mac };
console.log("hmac copy", code(() => viaObject.mac.copy()));
console.log("digest", viaObject.mac.digest("hex").slice(0, 16), JSON.stringify(viaObject.mac.digest("hex")));
console.log("update after digest", code(() => viaObject.mac.update("x")));

const used = [crypto.createHash("sha1")];
used[0].digest();
console.log("digest twice", code(() => used[0].digest("hex")));
console.log("copy after digest", code(() => used[0].copy()));
console.log("update bad", code(() => [crypto.createHash("sha1")][0].update(null)));

function methods(h, m) {
  return [h.update === m.update, h.digest === m.digest, typeof h.copy, typeof m.copy,
    h.update.name, h.update.length, h.digest.name, h.digest.length, h.copy.length];
}
console.log("methods", methods(crypto.createHash("sha256"), crypto.createHmac("sha1", "k")));
function viaCall(h) {
  const update = h.update;
  const digest = h.digest;
  return [update.call(h, "abc") === h, digest.call(h, "hex").slice(0, 16)];
}
console.log("call", viaCall(crypto.createHash("sha256")), viaCall(crypto.createHmac("sha256", "k")));
function sharedUpdate(h, m) {
  h.update.call(m, "shared");
  return m.digest("hex").slice(0, 16);
}
console.log("shared update", sharedUpdate(crypto.createHash("md5"), crypto.createHmac("md5", "k")));
