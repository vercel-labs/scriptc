// crypto.subtle cSHAKE128/cSHAKE256 digests: SP 800-185 output for several bit
// @normalize-pid
// lengths, the functionName/customization inputs, and Node's parameter errors.
const out: string[] = [];
const t = async (l: string, f: () => Promise<unknown>) => { try { const v = await f(); out.push([l, "OK", v instanceof ArrayBuffer ? Buffer.from(v).toString("hex") : String(v)].join(" | ")); } catch (e) { const x = e as Error; out.push([l, "ERR", x.name, x.message].join(" | ")); } };
const d = Buffer.from("abc");
await t("L256", () => crypto.subtle.digest({ name: "cSHAKE128", outputLength: 256 }, d));
await t("L64", () => crypto.subtle.digest({ name: "cSHAKE128", outputLength: 64 }, d));
await t("L100", () => crypto.subtle.digest({ name: "cSHAKE128", outputLength: 100 }, d));
await t("L0", () => crypto.subtle.digest({ name: "cSHAKE128", outputLength: 0 }, d));
await t("256 L512", () => crypto.subtle.digest({ name: "cSHAKE256", outputLength: 512 }, d));
await t("fn", () => crypto.subtle.digest({ name: "cSHAKE128", outputLength: 256, functionName: Buffer.from("KMAC") }, d));
await t("custom", () => crypto.subtle.digest({ name: "cSHAKE128", outputLength: 256, customization: Buffer.from("cust") }, d));
await t("fn+custom", () => crypto.subtle.digest({ name: "cSHAKE256", outputLength: 512, functionName: Buffer.from("KMAC"), customization: Buffer.from("My Tagged Application") }, d));
await t("lower", () => crypto.subtle.digest({ name: "cshake128", outputLength: 64 }, d));
await t("missing L", () => crypto.subtle.digest("cSHAKE128", d));
await t("L -1", () => crypto.subtle.digest({ name: "cSHAKE128", outputLength: -1 }, d));
await t("L max", () => crypto.subtle.digest({ name: "cSHAKE128", outputLength: 4294967295 }, d));
await t("fn bad", () => crypto.subtle.digest({ name: "cSHAKE128", outputLength: 64, functionName: Buffer.from("Email") }, d));
await t("fn str", () => crypto.subtle.digest({ name: "cSHAKE128", outputLength: 64, functionName: "KMAC" as unknown as BufferSource }, d));
await t("custom512", () =>
  crypto.subtle.digest({ name: "cSHAKE128", outputLength: 256, customization: Buffer.alloc(512, 1) }, d),
);
await t("custom513", () =>
  crypto.subtle.digest({ name: "cSHAKE128", outputLength: 256, customization: Buffer.alloc(513, 1) }, d),
);
await t("tuplehash", () =>
  crypto.subtle.digest(
    { name: "cSHAKE256", outputLength: 256, functionName: Buffer.from("TupleHash"), customization: Buffer.from("S") },
    d,
  ),
);
await t("parallelhash", () =>
  crypto.subtle.digest(
    { name: "cSHAKE128", outputLength: 256, functionName: Buffer.from("ParallelHash") },
    d,
  ),
);
await t("fn precedence", () =>
  crypto.subtle.digest(
    { name: "cSHAKE128", outputLength: 64, functionName: Buffer.from("X"), customization: Buffer.alloc(513) },
    d,
  ),
);
for (const row of out) console.log(row);
