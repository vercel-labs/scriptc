// WebCrypto ECDSA and RSA errors: Node's TypeErrors for missing algorithm
// members, and its DOMExceptions for curves, usages, key types, formats,
// extractability and JWK members, from generateKey, importKey, exportKey,
// sign and verify.

const t = async (label, fn) => { try { const v = await fn(); console.log(label, "=>", v instanceof ArrayBuffer ? "AB" + v.byteLength : typeof v === "object" && v !== null ? JSON.stringify(v) : v); } catch (e) { console.log(label, "!!", e.name, e.code, e.message); } };
const e3 = new Uint8Array([1, 0, 1]);
await t("rsa no hash", () => crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 1024, publicExponent: e3 }, true, ["sign"]));
await t("rsa no len", () => crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", publicExponent: e3, hash: "SHA-256" }, true, ["sign"]));
await t("rsa no exp", () => crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 1024, hash: "SHA-256" }, true, ["sign"]));
await t("rsa bad usage", () => crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 1024, publicExponent: e3, hash: "SHA-256" }, true, ["encrypt"]));
await t("pss bad usage", () => crypto.subtle.generateKey({ name: "RSA-PSS", modulusLength: 1024, publicExponent: e3, hash: "SHA-256" }, true, ["encrypt"]));
await t("rsa bad hash", () => crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 1024, publicExponent: e3, hash: "MD5" }, true, ["sign"]));
await t("rsa exp 3", async () => (await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 1024, publicExponent: new Uint8Array([3]), hash: "SHA-256" }, true, ["sign"])).publicKey.algorithm.publicExponent.length);
await t("rsa exp 4", () => crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 1024, publicExponent: new Uint8Array([4]), hash: "SHA-256" }, true, ["sign"]));
await t("rsa small", () => crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 256, publicExponent: e3, hash: "SHA-256" }, true, ["sign"]));
await t("ecdsa no curve", () => crypto.subtle.generateKey({ name: "ECDSA" }, true, ["sign"]));
await t("unknown alg", () => crypto.subtle.generateKey({ name: "FOO" }, true, ["sign"]));
const ec = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
await t("export bad format", () => crypto.subtle.exportKey("foo", ec.publicKey));
await t("export not key", () => crypto.subtle.exportKey("spki", {}));
await t("export spki private", () => crypto.subtle.exportKey("spki", ec.privateKey));
await t("export pkcs8 public", () => crypto.subtle.exportKey("pkcs8", ec.publicKey));
await t("import raw private", () => crypto.subtle.importKey("raw", new Uint8Array(32), { name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]));
await t("import pkcs8 verify", async () => crypto.subtle.importKey("pkcs8", await crypto.subtle.exportKey("pkcs8", ec.privateKey), { name: "ECDSA", namedCurve: "P-256" }, true, ["verify"]));
await t("import pkcs8 empty", async () => crypto.subtle.importKey("pkcs8", await crypto.subtle.exportKey("pkcs8", ec.privateKey), { name: "ECDSA", namedCurve: "P-256" }, true, []));
await t("import spki empty", async () => (await crypto.subtle.importKey("spki", await crypto.subtle.exportKey("spki", ec.publicKey), { name: "ECDSA", namedCurve: "P-256" }, true, [])).usages);
await t("import no curve", async () => crypto.subtle.importKey("spki", await crypto.subtle.exportKey("spki", ec.publicKey), { name: "ECDSA" }, true, ["verify"]));
await t("import rsa no hash", async () => crypto.subtle.importKey("spki", await crypto.subtle.exportKey("spki", ec.publicKey), { name: "RSASSA-PKCS1-v1_5" }, true, ["verify"]));
await t("import ec as rsa", async () => crypto.subtle.importKey("spki", await crypto.subtle.exportKey("spki", ec.publicKey), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, true, ["verify"]));
await t("import jwk bad", () => crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", x: "AA", y: "AA" }, { name: "ECDSA", namedCurve: "P-256" }, true, ["verify"]));
await t("import jwk crv mismatch", async () => crypto.subtle.importKey("jwk", await crypto.subtle.exportKey("jwk", ec.publicKey), { name: "ECDSA", namedCurve: "P-384" }, true, ["verify"]));
await t("import jwk kty", async () => crypto.subtle.importKey("jwk", { ...(await crypto.subtle.exportKey("jwk", ec.publicKey)), kty: "RSA" }, { name: "ECDSA", namedCurve: "P-256" }, true, ["verify"]));
await t("jwk ext false", async () => crypto.subtle.importKey("jwk", { ...(await crypto.subtle.exportKey("jwk", ec.publicKey)), ext: false }, { name: "ECDSA", namedCurve: "P-256" }, true, ["verify"]));
await t("jwk key_ops", async () => crypto.subtle.importKey("jwk", { ...(await crypto.subtle.exportKey("jwk", ec.publicKey)), key_ops: ["sign"] }, { name: "ECDSA", namedCurve: "P-256" }, true, ["verify"]));
const data = new Uint8Array([1, 2, 3]);
const spki = await crypto.subtle.exportKey("spki", ec.publicKey);
const rsa = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 1024, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, false, ["sign", "verify"]);
const pss = await crypto.subtle.generateKey({ name: "RSA-PSS", modulusLength: 1024, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-384" }, true, ["sign", "verify"]);
await t("export nonextractable", () => crypto.subtle.exportKey("pkcs8", rsa.privateKey));
await t("export raw private", () => crypto.subtle.exportKey("raw", ec.privateKey));
await t("sign with public", () => crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, ec.publicKey, data));
await t("sign wrong alg", () => crypto.subtle.sign("RSASSA-PKCS1-v1_5", ec.privateKey, data));
await t("ecdsa no hash", () => crypto.subtle.sign({ name: "ECDSA" }, ec.privateKey, data));
await t("bad curve", () => crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-999" }, true, ["sign"]));
await t("bad usage", () => crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["encrypt"]));
await t("empty usages", () => crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, []));
await t("verify usage only", async () => { const k = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-384" }, true, ["verify"]); return k.privateKey.usages + "|" + k.publicKey.usages; });
await t("import wrong curve", () => crypto.subtle.importKey("spki", spki, { name: "ECDSA", namedCurve: "P-384" }, true, ["verify"]));
await t("import sign usage public", () => crypto.subtle.importKey("spki", spki, { name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]));
await t("import garbage", () => crypto.subtle.importKey("spki", new Uint8Array([1, 2, 3]), { name: "ECDSA", namedCurve: "P-256" }, true, ["verify"]));
await t("pss no salt", () => crypto.subtle.sign({ name: "RSA-PSS" }, pss.privateKey, data));
await t("verify bad sig len", () => crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, ec.publicKey, new Uint8Array(10), data));
await t("verify with private", () => crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, ec.privateKey, new Uint8Array(64), data));
await t("sign hmac with ec", () => crypto.subtle.sign("HMAC", ec.privateKey, data));
await t("sign ec hash obj", async () => (await crypto.subtle.sign({ name: "ECDSA", hash: { name: "SHA-512" } }, ec.privateKey, data)).byteLength);
await t("p521", async () => (await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-521" }, false, ["sign"])).privateKey, data)).byteLength);
await t("raw export p384", async () => (await crypto.subtle.exportKey("raw", (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-384" }, true, ["sign","verify"])).publicKey)).byteLength);
