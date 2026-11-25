// crypto.subtle KangarooTwelve KT128/KT256: RFC 9861 output for several bit
// @normalize-pid
// lengths, the customization input, chunk-boundary messages (8192/8193/20000
// bytes) and Node's parameter errors.
const out: string[] = [];
const t = async (l: string, f: () => Promise<unknown>) => { try { const v = await f(); out.push([l, "OK", v instanceof ArrayBuffer ? Buffer.from(v).toString("hex") : String(v)].join(" | ")); } catch (e) { const x = e as Error; out.push([l, "ERR", x.name, x.message].join(" | ")); } };
const d = Buffer.from("abc");
for (const L of [0, 8, 16, 100, 256, 1000]) await t("L" + L, () => crypto.subtle.digest({ name: "KT128", outputLength: L }, d));
await t("kt256", () => crypto.subtle.digest({ name: "KT256", outputLength: 512 }, d));
await t("custom", () => crypto.subtle.digest({ name: "KT128", outputLength: 256, customization: Buffer.from("cust") }, d));
await t("custom empty", () => crypto.subtle.digest({ name: "KT128", outputLength: 256, customization: Buffer.alloc(0) }, d));
await t("custom str", () => crypto.subtle.digest({ name: "KT128", outputLength: 256, customization: "c" as unknown as BufferSource }, d));
await t("missing", () => crypto.subtle.digest("KT128", d));
await t("lower", () => crypto.subtle.digest({ name: "kt128", outputLength: 64 }, d));
await t("8192", () => crypto.subtle.digest({ name: "KT128", outputLength: 256 }, Buffer.alloc(8192, 3)));
await t("8193", () => crypto.subtle.digest({ name: "KT128", outputLength: 256 }, Buffer.alloc(8193, 3)));
await t("big128", () => crypto.subtle.digest({ name: "KT128", outputLength: 256 }, Buffer.alloc(20000, 7)));
await t("big256", () => crypto.subtle.digest({ name: "KT256", outputLength: 512 }, Buffer.alloc(20000, 7)));
await t("custom512", () =>
  crypto.subtle.digest({ name: "KT128", outputLength: 256, customization: Buffer.alloc(512, 1) }, d),
);
await t("custom513", () =>
  crypto.subtle.digest({ name: "KT128", outputLength: 256, customization: Buffer.alloc(513, 1) }, d),
);
await t("custom precedence", () =>
  crypto.subtle.digest({ name: "KT128", outputLength: 100, customization: Buffer.alloc(513) }, d),
);
for (const row of out) console.log(row);
