// crypto.subtle TurboSHAKE128/TurboSHAKE256: RFC 9861 output for several bit
// @normalize-pid
// lengths and domain separation bytes, with Node's parameter errors.
const out: string[] = [];
const t = async (l: string, f: () => Promise<unknown>) => { try { const v = await f(); out.push([l, "OK", v instanceof ArrayBuffer ? Buffer.from(v).toString("hex") : String(v)].join(" | ")); } catch (e) { const x = e as Error; out.push([l, "ERR", x.name, x.message].join(" | ")); } };
const d = Buffer.from("abc");
await t("t128", () => crypto.subtle.digest({ name: "TurboSHAKE128", outputLength: 256 }, d));
await t("t256", () => crypto.subtle.digest({ name: "TurboSHAKE256", outputLength: 512 }, d));
await t("ds1f", () => crypto.subtle.digest({ name: "TurboSHAKE128", outputLength: 256, domainSeparation: 0x1f }, d));
await t("ds1", () => crypto.subtle.digest({ name: "TurboSHAKE128", outputLength: 64, domainSeparation: 1 }, d));
await t("ds7f", () => crypto.subtle.digest({ name: "TurboSHAKE128", outputLength: 64, domainSeparation: 0x7f }, d));
await t("ds0", () => crypto.subtle.digest({ name: "TurboSHAKE128", outputLength: 64, domainSeparation: 0 }, d));
await t("ds128", () => crypto.subtle.digest({ name: "TurboSHAKE128", outputLength: 64, domainSeparation: 128 }, d));
await t("ds256", () => crypto.subtle.digest({ name: "TurboSHAKE128", outputLength: 64, domainSeparation: 256 }, d));
await t("L0", () => crypto.subtle.digest({ name: "TurboSHAKE128", outputLength: 0 }, d));
await t("L100", () => crypto.subtle.digest({ name: "TurboSHAKE128", outputLength: 100 }, d));
await t("L8", () => crypto.subtle.digest({ name: "TurboSHAKE128", outputLength: 8 }, d));
await t("L264", () => crypto.subtle.digest({ name: "TurboSHAKE256", outputLength: 264 }, d));
await t("missing", () => crypto.subtle.digest("TurboSHAKE128", d));
await t("lower", () => crypto.subtle.digest({ name: "turboshake128", outputLength: 64 }, d));
for (const row of out) console.log(row);
