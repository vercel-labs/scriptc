// WebCrypto Argon2 values from the JavaScript lane: version coercion with its
// @normalize-pid
// normalization TypeErrors, and SharedArrayBuffer-backed inputs refused with Node's
// TypeError for views.
const out = [];
const t = async (l, f) => { try { const v = await f(); out.push([l, "OK", String(v)].join(" | ")); } catch (e) { out.push([l, "ERR", e.name, e.message].join(" | ")); } };
const key = await crypto.subtle.importKey("raw-secret", Buffer.from("p"), "Argon2id", false, ["deriveBits"]);
const base = () => ({ name: "Argon2id", nonce: Buffer.alloc(16, 1), memory: 64, passes: 1, parallelism: 1 });
for (const v of [-1, 2 ** 32 - 1, 2 ** 32, Number.NaN, Number.POSITIVE_INFINITY, "abc", null]) {
  await t("version " + String(v), () => crypto.subtle.deriveBits({ ...base(), version: v }, key, 64));
}
const sab = new SharedArrayBuffer(16);
await t("nonce sab view", () => crypto.subtle.deriveBits({ ...base(), nonce: new Uint8Array(sab) }, key, 64));
await t("secret sab view", () => crypto.subtle.deriveBits({ ...base(), secretValue: new DataView(sab) }, key, 64));
await t("assoc sab view", () => crypto.subtle.deriveBits({ ...base(), associatedData: new Uint8Array(sab) }, key, 64));
await t("nonce bare sab", () => crypto.subtle.deriveBits({ ...base(), nonce: sab }, key, 64));
for (const row of out) console.log(row);

