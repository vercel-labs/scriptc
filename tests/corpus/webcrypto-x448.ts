// crypto.subtle X448: PKCS#8/raw/JWK imports and exports, shared secrets at 448 and
// @normalize-pid
// 256 bits, deriveKey, generation and the algorithm's errors, against fixed
// Node-generated X448 keys.
const out: string[] = [];
const t = async (l: string, f: () => Promise<unknown>) => { try { const v = await f(); out.push([l, "OK", v instanceof ArrayBuffer ? Buffer.from(v).toString("hex") : String(v)].join(" | ")); } catch (e) { const x = e as Error; out.push([l, "ERR", x.name, x.message].join(" | ")); } };
const seedA = Buffer.from("20257b522fc46815e853aa8918751545bfe563580d7a28d014c55305e56e29edac03f6725bbb8e395c620b12aca09342aafd113738828bc9", "hex");
const pubA = Buffer.from("28e530001e37d4329470054a0bb560b2d76edacd6e25e40c429f03e87e90d07c687e88750720cbd9c958eeeebacc287cd0eeff24ebd775ed", "hex");
const seedB = Buffer.from("0cb72c8c774f1644cf8202184cbf5ae67518dfae7dbaa5e1895186e8ec27e34f88d3cbcb23fc753dfc6283fb7546c0ddaa0586e4fcc0f8a8", "hex");
const pubB = Buffer.from("4ba3b19d0a2acb9f8c0b9c8afb2543e12d582c4ef4dabffeefdde99345f0f725a8d22586ba20d9d538570f2b8ea4ce699f56fdcd50023b91", "hex");
const pkcs8 = (s: Buffer) => Buffer.concat([Buffer.from("3046020100300506032b656f043a0438", "hex"), s]);
const spki = (p: Buffer) => Buffer.concat([Buffer.from("3042300506032b656f033900", "hex"), p]);
const privA = await crypto.subtle.importKey("pkcs8", pkcs8(seedA), "X448", true, ["deriveBits", "deriveKey"]);
const privB = await crypto.subtle.importKey("pkcs8", pkcs8(seedB), "X448", true, ["deriveBits"]);
const pubBk = await crypto.subtle.importKey("raw", pubB, "X448", true, []);
out.push("privA " + JSON.stringify(privA.algorithm) + " " + privA.usages.join(","));
out.push("pubB " + JSON.stringify(pubBk.algorithm) + " " + pubBk.type + " " + pubBk.extractable);
await t("spki export", () => crypto.subtle.exportKey("spki", pubBk));
await t("jwk pub", () => crypto.subtle.exportKey("jwk", pubBk).then((j) => JSON.stringify(j)));
await t("jwk priv", () => crypto.subtle.exportKey("jwk", privA).then((j) => JSON.stringify(j)));
await t("raw export", () => crypto.subtle.exportKey("raw", pubBk));
await t("derive 448", () => crypto.subtle.deriveBits({ name: "X448", public: pubBk }, privA, 448));
await t("derive 256", () => crypto.subtle.deriveBits({ name: "X448", public: pubBk }, privA, 256));
await t("deriveKey", async () => ((await crypto.subtle.deriveKey({ name: "X448", public: pubBk }, privA, { name: "AES-GCM", length: 128 }, true, ["encrypt"])).algorithm as AesKeyAlgorithm).length);
await t("import raw pub", () => crypto.subtle.importKey("raw", pubA, "X448", false, []).then((k) => k.type));
await t("import jwk priv", () => crypto.subtle.exportKey("jwk", privA).then((j) => crypto.subtle.importKey("jwk", j, "X448", true, ["deriveBits"]).then((k) => k.usages.join(","))));
await t("bad raw len", () => crypto.subtle.importKey("raw", Buffer.alloc(32), "X448", false, []));
await t("usage sign", () => crypto.subtle.importKey("raw", pubA, "X448", false, ["sign" as never]));
await t("gen", async () => { const kp = await crypto.subtle.generateKey({ name: "X448" }, true, ["deriveBits"]); return [kp.publicKey.algorithm.name, kp.publicKey.type, kp.privateKey.usages.join(","), kp.publicKey.usages.length].join(" "); });
for (const row of out) console.log(row);
