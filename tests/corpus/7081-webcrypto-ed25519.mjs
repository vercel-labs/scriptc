// WebCrypto Ed25519: the RFC 8032 test 1 key imported from pkcs8, jwk and
// raw, its deterministic signatures, verify, generateKey, every export
// format, and Node's DOMExceptions for usages, raw private export, short
// raw keys and mismatched JWK members.

const t = async (label, fn) => { try { const v = await fn(); console.log(label, "=>", v instanceof ArrayBuffer ? Buffer.from(v).toString("hex") : typeof v === "object" && v !== null ? JSON.stringify(v) : v); } catch (e) { console.log(label, "!!", e.name, e.code, e.message); } };
const seed = Buffer.from("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60", "hex");
const pkcs8 = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]);
const priv = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" }, true, ["sign"]);
await t("algorithm", () => [JSON.stringify(priv.algorithm), priv.type, priv.usages.join(), priv.extractable].join(" "));
await t("sign empty", () => crypto.subtle.sign("Ed25519", priv, new Uint8Array(0)));
await t("sign abc", () => crypto.subtle.sign({ name: "Ed25519" }, priv, new TextEncoder().encode("abc")));
await t("jwk priv", () => crypto.subtle.exportKey("jwk", priv));
await t("pkcs8 back", async () => Buffer.from(await crypto.subtle.exportKey("pkcs8", priv)).equals(pkcs8));
const jwk = await crypto.subtle.exportKey("jwk", priv);
const pubJwk = { kty: jwk.kty, crv: jwk.crv, x: jwk.x };
const pub = await crypto.subtle.importKey("jwk", pubJwk, "Ed25519", true, ["verify"]);
await t("raw pub", () => crypto.subtle.exportKey("raw", pub));
await t("spki pub", () => crypto.subtle.exportKey("spki", pub));
await t("jwk pub", () => crypto.subtle.exportKey("jwk", pub));
const sig = await crypto.subtle.sign("Ed25519", priv, new TextEncoder().encode("abc"));
await t("verify", () => crypto.subtle.verify("Ed25519", pub, sig, new TextEncoder().encode("abc")));
await t("verify bad", () => crypto.subtle.verify("Ed25519", pub, sig, new TextEncoder().encode("abd")));
await t("verify short", () => crypto.subtle.verify("Ed25519", pub, new Uint8Array(10), new TextEncoder().encode("abc")));
const rawImported = await crypto.subtle.importKey("raw", await crypto.subtle.exportKey("raw", pub), { name: "Ed25519" }, false, ["verify"]);
await t("raw import verify", () => crypto.subtle.verify("Ed25519", rawImported, sig, new TextEncoder().encode("abc")));
const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
await t("generated", async () => [pair.privateKey.usages.join(), pair.publicKey.usages.join(), pair.publicKey.extractable, (await crypto.subtle.exportKey("raw", pair.publicKey)).byteLength, await crypto.subtle.verify("Ed25519", pair.publicKey, await crypto.subtle.sign("Ed25519", pair.privateKey, new Uint8Array([1])), new Uint8Array([1]))].join(" "));
await t("raw private", () => crypto.subtle.exportKey("raw", pair.privateKey));
await t("bad usage", () => crypto.subtle.generateKey({ name: "Ed25519" }, true, ["encrypt"]));
await t("verify only", () => crypto.subtle.generateKey("Ed25519", true, ["verify"]));
await t("raw short", () => crypto.subtle.importKey("raw", new Uint8Array(31), { name: "Ed25519" }, true, ["verify"]));
await t("raw sign usage", () => crypto.subtle.importKey("raw", new Uint8Array(32), "Ed25519", true, ["sign"]));
await t("jwk alg EdDSA", async () => (await crypto.subtle.importKey("jwk", { ...pubJwk, alg: "EdDSA" }, "Ed25519", true, ["verify"])).type);
await t("jwk alg bad", () => crypto.subtle.importKey("jwk", { ...pubJwk, alg: "RS256" }, "Ed25519", true, ["verify"]));
await t("jwk crv bad", () => crypto.subtle.importKey("jwk", { ...pubJwk, crv: "Ed448" }, "Ed25519", true, ["verify"]));
await t("jwk kty bad", () => crypto.subtle.importKey("jwk", { ...pubJwk, kty: "EC" }, "Ed25519", true, ["verify"]));
await t("ecdsa key as ed", async () => { const e = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]); return crypto.subtle.importKey("spki", await crypto.subtle.exportKey("spki", e.publicKey), "Ed25519", true, ["verify"]); });
await t("sign wrong alg", () => crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, priv, new Uint8Array(1)));
