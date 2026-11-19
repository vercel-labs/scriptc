// crypto.subtle Argon2d/i/id: raw-secret imports, deriveBits and deriveKey across
// @normalize-pid
// variants and parameters, the version rule, and Node's argument and range errors.
const out: string[] = [];
const t = async (l: string, f: () => Promise<unknown>) => { try { const v = await f(); out.push([l, "OK", typeof v === "string" ? v : JSON.stringify(v)].join(" | ")); } catch (e) { const x = e as Error; out.push([l, "ERR", x.name, x.message].join(" | ")); } };
const params = (extra: Record<string, unknown> = {}) => ({ name: "Argon2id", nonce: Buffer.alloc(16, 1), memory: 1024, passes: 2, parallelism: 1, ...extra });
const key = await crypto.subtle.importKey("raw-secret", Buffer.from("password"), "Argon2id", false, ["deriveBits", "deriveKey"]);
out.push("alg " + JSON.stringify(key.algorithm));
await t("derive 256", async () => Buffer.from(await crypto.subtle.deriveBits(params(), key, 256)).toString("hex"));
await t("derive 32", async () => Buffer.from(await crypto.subtle.deriveBits(params(), key, 32)).toString("hex"));
for (const L of [0, 24, 100, null]) await t("len " + L, () => crypto.subtle.deriveBits(params(), key, L ?? undefined));
await t("deriveKey aes", async () => { const k = await crypto.subtle.deriveKey(params(), key, { name: "AES-GCM", length: 128 }, true, ["encrypt"]); return [JSON.stringify(k.algorithm), k.usages.join(",")].join(" "); });
await t("version 16", () => crypto.subtle.deriveBits(params({ version: 0x10 }), key, 64));
await t("version 19", () => crypto.subtle.deriveBits(params({ version: 19 }), key, 64).then((b) => b.byteLength));
await t("missing nonce", () => crypto.subtle.deriveBits({ name: "Argon2id", memory: 64, passes: 1, parallelism: 1 } as unknown as Argon2Params, key, 64));
await t("nonce 4", () => crypto.subtle.deriveBits(params({ nonce: Buffer.alloc(4) }), key, 64));
await t("memory 7", () => crypto.subtle.deriveBits(params({ memory: 7 }), key, 64));
await t("secretValue", async () => Buffer.from(await crypto.subtle.deriveBits(params({ secretValue: Buffer.alloc(4, 3), associatedData: Buffer.alloc(4, 4) }), key, 64)).toString("hex"));
await t("secretValue num", () => crypto.subtle.deriveBits(params({ secretValue: 5 }), key, 64));
await t("import raw", () => crypto.subtle.importKey("raw", Buffer.from("p"), "Argon2id", false, ["deriveBits"]));
await t("import ext", () => crypto.subtle.importKey("raw-secret", Buffer.from("p"), "Argon2id", true, ["deriveBits"]));
await t("import sign", () => crypto.subtle.importKey("raw-secret", Buffer.from("p"), "Argon2id", false, ["sign"]));
await t("export", async () => { const k = await crypto.subtle.importKey("raw-secret", Buffer.from("p"), "Argon2id", false, ["deriveBits"]); return crypto.subtle.exportKey("raw-secret", k); });
await t("deriveKey argon2", () => crypto.subtle.deriveKey(params(), key, { name: "Argon2id" }, true, ["deriveBits"]));
await t("pbkdf2 key", async () => { const k = await crypto.subtle.importKey("raw", Buffer.from("p"), "PBKDF2", false, ["deriveBits"]); return crypto.subtle.deriveBits(params(), k, 64); });
for (const row of out) console.log(row);

